import { getFile, tryGetFolder, writeFile } from '../../../core/fs.js';
import { createFileIfMissing, deepClone } from '../../../core/files.js';
import { makeCSVSafe, makeNameFieldSafe } from '../../../core/strings.js';
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

/**
 * A new document of `type`, written into the mod, returning its GUID.
 *
 * @param templateData an existing document to copy; omitted for a fresh one
 */
export async function createNewFile(type, templateData) {
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
                    newContent.messages[0].msgID = await createNewFile('message');
                    newContent.messages[0].instanceID = crypto.randomUUID();
                    newContent.name = makeNameFieldSafe(window.selectedMod.modName + "-" + 'DefaultTree');
                    newContent.startingMessage = newContent.messages[0].instanceID;
                } else {
                    newContent.name += " (Clone)";
                }
            });
        case 'message':
            return createNewFileImpl('message', async newContent => {
                if (fromTemplate) {
                    newContent.blocks.push(cloneTemplate('messageBlock'));
                    newContent.blocks[0].blockID = await createNewFile('block');
                    newContent.blocks[0].instanceID = crypto.randomUUID();
                    // Said 'DefaultBlock' while nothing could reach it, which would now
                    // name every new message after the wrong kind of document.
                    newContent.name = makeNameFieldSafe(window.selectedMod.modName + "-" + 'DefaultMessage');
                } else {
                    newContent.name += " (Clone)";
                }
            });
        case 'block':
            return createNewFileImpl('block', async newContent => {
                // Dismissing the prompt means an empty line, not a crash: this is now
                // reached partway through creating a tree, and throwing there would
                // leave the tree and its message half-written.
                let line = JSON.parse(makeCSVSafe(prompt(`English Line`) ?? ''));
                newContent.name = makeNameFieldSafe(window.selectedMod.modName + "-" + line.substring(0, 20));

                await addOrModifyStrings(newContent.id, line);
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
 */
export async function addOrModifyStrings(id, content) {
    let d = new Date();
    let datestring = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + " " + ("0" + d.getDate()).slice(-2) + "/" + ("0" + (d.getMonth() + 1)).slice(-2) + "/" + d.getFullYear();

    const ddsFolder = await ddsContentFolder(window.selectedMod.baseFolder, true);
    const manifest = await readManifest(ddsFolder);

    const { real, addEntry } = placeStringsFile(manifest, DDS_BLOCKS_VIRTUAL);

    let csvHandle = await stringsFileHandle(ddsFolder, real, true);
    let stringsFileContent = (await (await csvHandle.getFile()).text());

    if(stringsFileContent.includes(id)) {
        // If we have the content, overwrite it
        stringsFileContent = stringsFileContent.split('\n').map(val => (val.startsWith(id) ? `${id},,${content},,,,${datestring}` : val)).join('\n');
        await writeFile(csvHandle, stringsFileContent, false);
    } else {
        // Otherwise, just append the new content
        await writeFile(csvHandle, `\n${id},,${content},,,,${datestring}`, true);
    }

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
