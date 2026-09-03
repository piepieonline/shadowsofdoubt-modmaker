/**
 * Taking a DDS file out of a mod, and finding what pointed at it first.
 *
 * DDS content nests: a tree holds messages, a message holds blocks, and a block resolves
 * to a row of text in a CSV. Every one of those links is a GUID written inside another
 * file, and the panel shows none of them -- so deleting a message an author no longer
 * wants leaves a tree pointing into nothing, with no sign of it anywhere until the line
 * fails to appear in the game.
 *
 * A GUID is the whole of how one of these files names another, and it is unique. So the
 * search is a substring search over the mod's own DDS files and its strings CSVs, and it
 * does not have to know which field it is looking in -- which is the point, since a block
 * names its replacements somewhere quite different from where a tree names its messages.
 *
 * Only the mod's own content is searched. Base game files are not editable and cannot
 * point at a GUID the mod invented; a mod's *patch* of a base game file is one of the
 * files walked here, because that is a file in this folder like any other.
 *
 * A strings CSV is the exception, and the question has to be turned round for it. Nothing
 * names one except the mod's ddsmanifest, and that entry is taken out along with the file
 * -- so asked the usual way it would always answer "nothing refers to it", while quietly
 * deleting the English text of every block in the mod. What breaks is on the other side of
 * the link: the documents whose lines were in it. Those are what get listed.
 */
import { readFileContent, removeFile, tryGetFolder } from '../../../core/fs.js';
import { parseJSON } from '../../../core/jsonNumbers.js';
import { confirmDelete } from '../../../core/deletion.js';
import {
    DDS_CONTENT_ROOT, ddsContentFolder, isActive, readManifest, stringsFileHandle,
    withoutMapping, writeManifest,
} from '../../../core/ddsManifest.js';

/** Where each kind of document lives below DDSContent/DDS. Mirrors modFileManager.js. */
const SUBFOLDER = { tree: 'Trees', message: 'Messages', block: 'Blocks' };

/**
 * A GUID wherever it sits in a line, rather than anchored as core/guid.js has it: a CSV row
 * is a key followed by the text it stands for, and the key is what is being read out of it.
 */
const GUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

/**
 * A message under a newspaper tree has one of these beside it, named after the message.
 * Its name is its only link to the message, so a text search would never find it.
 */
const COMPANION = '.newspaper';

/**
 * Trees, messages and blocks are in three known folders, so the CSV walk has no reason to
 * go into DDS/ -- and every reason not to, since a large mod keeps thousands of files
 * there. The same bound `contentList.js` puts on the same walk.
 */
const NOT_STRINGS = new Set(['DDS']);

/** Vanilla content has a name in the generated reference data; a mod's own does not. */
const vanillaName = (id) => window.ddsMap?.idNameMap?.[id] ?? null;

/**
 * What a file is called in the list of references.
 *
 * The document's own name, which is what the panel shows it as. A patch holds only a diff
 * and states no name, so the base game's is used -- and a file that is neither is named by
 * the file, which is at least something to go and look at.
 */
function labelFor(fileName, text) {
    let named = null;
    try {
        named = parseJSON(text)?.name ?? null;
    } catch {
        named = null;
    }

    return named || vanillaName(fileName.split('.')[0]) || fileName;
}

/** Every tree, message and block the mod holds, with the text of each. */
async function* documents(ddsFolder) {
    for (const dir of Object.values(SUBFOLDER)) {
        const folder = await tryGetFolder(ddsFolder, ['DDS', dir]);
        if (!folder) continue;

        for await (const handle of folder.values()) {
            if (handle.kind !== 'file') continue;
            yield { name: handle.name, text: await readFileContent(handle) };
        }
    }
}

/**
 * Every strings CSV the mod holds, with the text of each.
 *
 * Walked from the content root rather than from Strings/, because a manifest-using mod
 * keeps its CSVs wherever it likes and declares where the game reads them from.
 */
async function* stringsFiles(folder, trail = [], skip = NOT_STRINGS) {
    for await (const handle of folder.values()) {
        if (handle.kind === 'directory') {
            if (skip?.has(handle.name)) continue;
            yield* stringsFiles(handle, [...trail, handle.name], null);
            continue;
        }

        if (!handle.name.toLowerCase().endsWith('.csv')) continue;
        yield { name: [...trail, handle.name].join('/'), text: await readFileContent(handle) };
    }
}

/**
 * Everything in the mod that names this GUID.
 *
 * @param target `{ id, file, type }` -- the GUID, the file it is stored in, and which of
 *               the three kinds of document it is
 */
export async function referencesToDocument(contentFolder, target) {
    const ddsFolder = await ddsContentFolder(contentFolder);
    if (!ddsFolder) return [];

    const needle = String(target.id).toLowerCase();
    const found = [];

    for await (const { name, text } of documents(ddsFolder)) {
        if (name === target.file) continue;

        // The companion is named after the message rather than naming it inside, and
        // holds an article whose own text mentions no GUID at all.
        if (name === `${target.id}${COMPANION}`) {
            found.push(name);
            continue;
        }

        if ((text ?? '').toLowerCase().includes(needle)) found.push(labelFor(name, text));
    }

    // A block's English text is a row keyed by the block's GUID, so a CSV is a real
    // reference to it -- and the one an author would otherwise never think to clean up.
    for await (const { name, text } of stringsFiles(ddsFolder)) {
        if ((text ?? '').toLowerCase().includes(needle)) found.push(name);
    }

    return found;
}

/**
 * The mod's own documents whose text is in this CSV.
 *
 * A row is keyed by the GUID of the thing it is the text of, so the file is read for the
 * GUIDs it holds and those are matched against the documents in the folder. Rows keyed by
 * base game GUIDs are the mod's overrides of shipped text and are not listed: there is no
 * file of the mod's that stops working, and the game falls back to its own line.
 */
export async function referencesToStringsFile(contentFolder, realPath) {
    const ddsFolder = await ddsContentFolder(contentFolder);
    if (!ddsFolder) return [];

    const handle = await stringsFileHandle(ddsFolder, realPath, false);
    if (!handle) return [];

    const keyed = new Set(
        ((await readFileContent(handle)) ?? '').match(GUID_ANYWHERE)?.map((id) => id.toLowerCase()) ?? []);
    if (!keyed.size) return [];

    const found = [];

    for await (const { name, text } of documents(ddsFolder)) {
        if (keyed.has(name.split('.')[0].toLowerCase())) found.push(labelFor(name, text));
    }

    return found;
}

/**
 * Ask, and then delete a tree, a message or a block.
 *
 * @returns whether anything was deleted -- false when the author said no
 */
export async function deleteDocument(contentFolder, target) {
    if (!contentFolder) return false;

    const references = await referencesToDocument(contentFolder, target);
    if (!confirmDelete(target.label, references)) return false;

    await removeFile(contentFolder, [DDS_CONTENT_ROOT, 'DDS', SUBFOLDER[target.type], target.file]);
    return true;
}

/**
 * Ask, and then delete a strings CSV, along with the manifest entry that placed it.
 *
 * The file first, then the manifest, for the reason the case flow deletes in that order:
 * a manifest that has forgotten a file still sitting in the folder is the worse of the two
 * halves to be left holding.
 *
 * `writeManifest` refuses a mod that has no manifest or an unreadable one, which is
 * exactly right here -- neither placed the file, and neither is ours to rewrite.
 */
export async function deleteStringsFile(contentFolder, target) {
    if (!contentFolder) return false;

    const references = await referencesToStringsFile(contentFolder, target.id);
    if (!confirmDelete(target.label, references)) return false;

    const ddsFolder = await ddsContentFolder(contentFolder);
    if (!ddsFolder) return false;

    await removeFile(ddsFolder, target.id.split('/'));

    const manifest = await readManifest(ddsFolder);
    const without = isActive(manifest) ? withoutMapping(manifest, target.id) : manifest;

    // A mod's manifest is not rewritten to say what it already says: this file may sit
    // where the game reads it from and have needed no entry at all.
    if (isActive(manifest) && without.files.length !== manifest.files.length) {
        await writeManifest(ddsFolder, without);
    }

    return true;
}
