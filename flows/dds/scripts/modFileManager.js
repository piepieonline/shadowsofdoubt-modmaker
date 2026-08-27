import { getFile, tryGetFolder, writeFile } from '../../../core/fs.js';
import { createFileIfMissing, deepClone } from '../../../core/files.js';
import { makeCSVSafe, makeNameFieldSafe } from '../../../core/strings.js';
import {
    EDITED_FIELD, KEY_FIELD, TEXT_FIELD, editedStamp, quote, rowKey, splitRow, unquoteText,
} from '../../../core/stringsCsv.js';
import { DDS_BLOCKS_VIRTUAL, placeStringsFile, readManifest, stringsFileHandle, withMapping, writeManifest } from './ddsManifest.js';
import { loadI18n } from '../index.js';

/**
 * This flow's files live under <content folder>/DDSContent, but `baseFolder` is the
 * content folder itself so that it means the same thing here as in the case flow.
 * Paths handed to it are prefixed with the content root instead.
 */
export const CONTENT_ROOT = 'DDSContent';

/** Split a content-relative path into segments below the content folder. */
export function modPath(path) {
    return `${CONTENT_ROOT}/${path}`.split('/');
}

/** The mod's DDSContent folder, which everything in this flow hangs below. */
export function ddsContentFolder(contentFolder, create) {
    return tryGetFolder(contentFolder, [CONTENT_ROOT], create);
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
    return tryGetFolder(contentFolder, [CONTENT_ROOT, 'DDS', SUBFOLDER[type]], true);
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
 */
export async function createNewFile(type, templateData, { name, line, rung } = {}) {
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
 * Which file that is comes from the manifest: a mod that maps dds.blocks.csv somewhere
 * of its own gets its text there, one that keeps its other CSVs together gets it
 * beside them, and one with no manifest is written the ordinary way.
 *
 * One question decides how it is written -- is there already a row for this GUID? --
 * so it is asked once, of the rows themselves, rather than once of the file's text and
 * again of each line in a way that could disagree with it.
 *
 * The key and the line are quoted whichever way the row is written, which is the shape
 * the game's own CSVs are in and the shape the strings editor writes. `content` arrives
 * quoted already when it holds a comma (see makeCSVSafe), so it is unquoted first --
 * quoting it twice would put the quotes in the string the player reads.
 */
export async function addOrModifyStrings(id, content) {
    const datestring = editedStamp();
    const line = quote(unquoteText(content));

    const ddsFolder = await ddsContentFolder(window.selectedMod.baseFolder, true);
    const manifest = await readManifest(ddsFolder);

    const { real, addEntry } = placeStringsFile(manifest, DDS_BLOCKS_VIRTUAL);

    let csvHandle = await stringsFileHandle(ddsFolder, real, true);

    // Creating the file is allowed to fail -- a folder that cannot be written, a name
    // taken by a directory -- and the next line would make that a TypeError on null,
    // thrown out of a blur handler where nobody would ever see it.
    if (!csvHandle) throw new Error(`Could not open ${real} in this mod to write the line to.`);

    const stringsFileContent = (await (await csvHandle.getFile()).text());

    const lines = stringsFileContent.split('\n');
    const existing = lines.findIndex((row) => rowKey(row) === id);

    if (existing !== -1) {
        // Only the columns this app knows the meaning of. A row can carry more -- the
        // game's own files do -- and rewriting the whole line threw that away.
        const fields = splitRow(lines[existing]);
        while (fields.length <= EDITED_FIELD) fields.push('');

        fields[KEY_FIELD] = quote(id);
        fields[TEXT_FIELD] = line;
        fields[EDITED_FIELD] = datestring;

        lines[existing] = fields.join(',');
        await writeFile(csvHandle, lines.join('\n'), false);
    } else {
        await writeFile(csvHandle, `\n${quote(id)},,${line},,,,${datestring}`, true);
    }

    // This file may be open in the strings editor, which is now a row behind. The handle
    // goes with the path because it is the file itself, which is the only thing that
    // says whether it is the one on screen.
    const { refreshOpenStringsFile } = await import('./stringsEditor.js');
    await refreshOpenStringsFile(real, csvHandle);

    // The file went where the mod keeps its CSVs, which is not where the game looks
    // for it -- so say so, or the text is written and never read.
    if (addEntry) {
        await writeManifest(ddsFolder, withMapping(manifest, addEntry));

        // Declaring a file is the one thing the app changes a manifest for, and the
        // panel is built from it, so it would otherwise sit there contradicting disk.
        const { refreshManifestPanel } = await import('./manifestPanel.js');
        await refreshManifestPanel();
    }

    await loadI18n();
}
