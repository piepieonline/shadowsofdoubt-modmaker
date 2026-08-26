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
 * A row as its fields, with quoted fields kept whole.
 *
 * A quote in these files is load bearing: a field holding a comma is quoted precisely
 * so that the comma is not a separator. Splitting on every comma tears such a row into
 * pieces, and rejoining the pieces is not the row it came from.
 *
 * The quotes are kept in the field text, so that fields.join(',') gives back the line
 * exactly -- what a rewrite does not touch, it must not alter.
 */
function splitRow(line) {
    const fields = [];
    let field = '';
    let quoted = false;

    for (const char of line) {
        if (char === '"') {
            quoted = !quoted;
            field += char;
        } else if (char === ',' && !quoted) {
            fields.push(field);
            field = '';
        } else {
            field += char;
        }
    }

    fields.push(field);
    return fields;
}

/**
 * The GUID a row is keyed by: its first field, however it is written.
 *
 * The game's own CSVs quote their fields, so a mod that began as a copy of one has rows
 * reading `"guid",,"text",...`. Reading already allowed for that -- loadI18n strips the
 * quotes off the GUID, and so does reverse search -- but writing did not: a row was
 * found with `startsWith(id)`, which a quoted row never satisfies.
 *
 * That was not a failure to find it. The file was tested with `includes(id)`, which a
 * quoted row does satisfy, so the write took the overwrite path, matched no line, and
 * wrote the file back exactly as it was. Every edit to such a file did nothing at all,
 * silently: no new row, no changed row, no error.
 */
const rowId = (line) => splitRow(line)[0].replaceAll('"', '').trim();

/** The columns this app has a view on. A row holds more, and they are not ours. */
const TEXT_FIELD = 2;
const EDITED_FIELD = 6;

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
 */
export async function addOrModifyStrings(id, content) {
    let d = new Date();
    let datestring = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + " " + ("0" + d.getDate()).slice(-2) + "/" + ("0" + (d.getMonth() + 1)).slice(-2) + "/" + d.getFullYear();

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
    const existing = lines.findIndex((line) => rowId(line) === id);

    if (existing !== -1) {
        // Only the two columns this app knows the meaning of. A row can carry more --
        // the game's own files do -- and rewriting the whole line threw that away along
        // with whatever quoting its author had a reason for.
        const fields = splitRow(lines[existing]);
        while (fields.length <= EDITED_FIELD) fields.push('');

        fields[TEXT_FIELD] = content;
        fields[EDITED_FIELD] = datestring;

        lines[existing] = fields.join(',');
        await writeFile(csvHandle, lines.join('\n'), false);
    } else {
        await writeFile(csvHandle, `\n${id},,${content},,,,${datestring}`, true);
    }

    // This file may be open as text, in which case it is now a row behind. The handle
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
