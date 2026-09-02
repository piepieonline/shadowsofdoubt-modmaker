import { getFile, tryGetFolder, writeFile } from '../../../core/fs.js';
import { createFileIfMissing, deepClone } from '../../../core/files.js';
import { makeCSVSafe, makeNameFieldSafe } from '../../../core/strings.js';
import { DDS_BLOCKS_VIRTUAL, DDS_CONTENT_ROOT } from '../../../core/ddsManifest.js';
import { writeStringsRow } from '../../../core/modStrings.js';
import { applyTreeKind } from './treeKinds.js';
import { loadI18n } from '../index.js';

/**
 * This flow's files live under <content folder>/DDSContent, but `baseFolder` is the
 * content folder itself so that it means the same thing here as in the case flow.
 * Paths handed to it are prefixed with the content root instead -- which is core's, not
 * this flow's, because it is where any flow's strings go. See core/ddsManifest.js.
 */

/** Split a content-relative path into segments below the content folder. */
export function modPath(path) {
    return `${DDS_CONTENT_ROOT}/${path}`.split('/');
}

/** Where each kind of document lives, below DDSContent/DDS. */
const SUBFOLDER = { tree: 'Trees', message: 'Messages', block: 'Blocks' };

/**
 * The folder a document of `type` is written to, created if it is not there.
 *
 * Made at the moment something is written, never on merely selecting a folder. A
 * content folder may hold only a case manifest and never gain DDS content at all, and
 * planting empty DDS/Trees, DDS/Messages and DDS/Blocks directories in one says it
 * holds DDS text when it does not.
 *
 * Strings folders are the same story for the same reason: where a mod's CSVs belong is
 * the manifest's business, so they are made when a line of text is written. See
 * addOrModifyStrings.
 */
export function ddsFolderFor(type, contentFolder = window.selectedMod.baseFolder) {
    return tryGetFolder(contentFolder, [DDS_CONTENT_ROOT, 'DDS', SUBFOLDER[type]], true);
}

export function cloneTemplate(template) {
    return cloneFile(window.templates[template]);
}

export function cloneFile(file) {
    return deepClone(file);
}

/** A document's name field: the author's name for it, behind the mod's. */
const documentName = (name) => makeNameFieldSafe(`${window.selectedMod.modName}-${name}`);

/**
 * The name of a rung below the document that was asked for.
 *
 * The author's name is carried down whole and the rung's own kind put on the end here,
 * rather than each level appending to what it was handed -- which named a new tree's
 * block <name>-Message-Block, after the rung between them.
 */
const rungName = (name, rung) => (rung ? `${name}-${rung}` : name);

/**
 * A new document of `type`, written into the mod, returning its GUID.
 *
 * A tree carries a message and a message carries a block, so creating one creates the
 * levels below it -- which is why the name and the line are carried down rather than
 * asked for again. The author named the thing they asked for; the rungs below it are
 * named after it, so a mod's panel reads as documents rather than as Default-anything.
 *
 * @param templateData an existing document to copy; omitted for a fresh one
 * @param name         the author's name for it, without the mod's name in front
 * @param line         the English line the block at the bottom of it says
 * @param rung         what this level is, when it is one of the levels below the
 *                     document that was actually asked for
 * @param treeType     which of the six kinds of tree to make. Only for a fresh tree: a
 *                     copy is the kind of the thing it was copied from, and a message or
 *                     a block has no kind at all.
 */
export async function createNewFile(type, templateData, { name, line, rung, treeType } = {}) {
    /**
     * Fresh, or a copy of something that already exists.
     *
     * Each callback below needs to know which, and used to ask by testing the
     * template's DEFAULT_GUID placeholder -- but the new GUID is stamped over that
     * before the callback ever runs, so the answer was always "a copy". Every new tree
     * arrived named "DEFAULT-NAME-Clone" with none of the message and block it is
     * supposed to start with. The caller knows, so it says so.
     */
    const fromTemplate = templateData == null;

    async function createNewFileImpl(type, callback) {
        let guid = crypto.randomUUID();
        let newHandle = await getFile(await ddsFolderFor(type), [guid + "." + (type == 'message' ? 'msg' : type)], true);

        let newContent = fromTemplate ? cloneTemplate(type) : cloneFile(templateData);

        newContent.id = guid;

        await callback(newContent);

        await writeFile(newHandle, JSON.stringify(newContent));

        return guid;
    }

    switch (type) {
        case 'tree':
            return createNewFileImpl('tree', async newContent => {
                if (fromTemplate) {
                    newContent.messages.push(cloneTemplate('treeMessage'));

                    // What kind of tree this is, and the values that kind needs to be a
                    // tree the game will run. Applied before the GUIDs below, so those
                    // are the last word: the template is the shape of a `DDSTreeSave` and
                    // this is which of the six it is. See scripts/treeKinds.js.
                    applyTreeKind(newContent, treeType);

                    // Named after the tree it belongs to: it is a rung of this document
                    // rather than a document anyone went looking for.
                    newContent.messages[0].msgID = await createNewFile('message', undefined, {
                        name, line, rung: 'Message',
                    });
                    newContent.messages[0].instanceID = crypto.randomUUID();
                    newContent.name = documentName(name ?? 'DefaultTree');
                    newContent.startingMessage = newContent.messages[0].instanceID;
                } else {
                    newContent.name += " (Clone)";
                }
            });
        case 'message':
            return createNewFileImpl('message', async newContent => {
                if (fromTemplate) {
                    newContent.blocks.push(cloneTemplate('messageBlock'));
                    newContent.blocks[0].blockID = await createNewFile('block', undefined, {
                        name, line, rung: 'Block',
                    });
                    newContent.blocks[0].instanceID = crypto.randomUUID();
                    // Said 'DefaultBlock' while nothing could reach it, which would now
                    // name every new message after the wrong kind of document.
                    newContent.name = documentName(name ? rungName(name, rung) : 'DefaultMessage');
                } else {
                    newContent.name += " (Clone)";
                }
            });
        case 'block':
            return createNewFileImpl('block', async newContent => {
                // Quoted as the CSV needs it, which is also what goes in the document's
                // name when there is nothing else to name it after. No line is an empty
                // row rather than no row: the block is keyed by GUID, and a block with
                // nothing to resolve to reads in the game as a missing string.
                const text = JSON.parse(makeCSVSafe(line ?? ''));
                newContent.name = documentName(name ? rungName(name, rung) : text.substring(0, 20));

                await addOrModifyStrings(newContent.id, text);
            });
    }
}

export async function createFileIfNotExisting(type, guid) {
    if (type !== 'newspaper') throw 'Not implemented';

    // Companion file for a message under a newspaper tree.
    return createFileIfMissing(
        await ddsFolderFor('message'), [`${guid}.newspaper`], () => cloneTemplate('newspaper')
    );
}

/**
 * Write a line of block text into the mod's strings CSV.
 *
 * The row itself is core's business -- see core/modStrings.js, and note that which file
 * it lands in comes from the manifest rather than from the path the game reads. What is
 * left here is what only this editor cares about: the two views that are now a row
 * behind, and the text cache the documents resolve their lines through.
 */
export async function addOrModifyStrings(id, content) {
    const { real, handle, declared } = await writeStringsRow(
        window.selectedMod.baseFolder, DDS_BLOCKS_VIRTUAL, id, content);

    // This file may be open in the strings editor, which is now a row behind. The handle
    // goes with the path because it is the file itself, which is the only thing that
    // says whether it is the one on screen.
    const { refreshOpenStringsFile } = await import('./stringsEditor.js');
    await refreshOpenStringsFile(real, handle);

    // Declaring a file is the one thing the app changes a manifest for, and the panel is
    // built from it, so it would otherwise sit there contradicting disk.
    if (declared) {
        const { refreshManifestPanel } = await import('./manifestPanel.js');
        await refreshManifestPanel();
    }

    await loadI18n();
}
