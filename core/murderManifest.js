/**
 * A mod's murder manifest: the list of ScriptableObject files the loader loads, and the
 * order it loads them in.
 *
 *   { "enabled": true, "fileOrder": ["REF:GrandHotel"], "loadBefore": "", "version": 1 }
 *
 * A `.sodso.json` sitting in a content folder is not loaded because it is there. It is
 * loaded because `fileOrder` names it -- so a file this app writes into a mod and does
 * not list is a file the game never reads, which shows up as a building that simply is
 * not in the city and nothing anywhere saying why.
 *
 * In core rather than in the ScriptableObject flow for the same reason
 * core/ddsManifest.js is: the manifest is the mod loader's, not one editor's. Any flow
 * that puts a new asset in a mod has to list it, and the building flow does.
 *
 * An entry is `REF:<file name without .sodso.json>`, which is what the ScriptableObject
 * flow writes for a file made there. Names are compared case-insensitively when deciding
 * whether a file is listed already: mods in the wild lowercase them (the case scaffolder
 * does), and listing one file twice is worse than matching an entry loosely.
 *
 * A manifest that cannot be read is left exactly as it is, as in core/ddsManifest.js.
 * The text is the author's and may be one comma away from working; overwriting it with a
 * fresh manifest would throw away the rest of the mod's load order to add one line.
 */
import { readFileContent, tryGetFile } from './fs.js';
import { writeWholeFile } from './persistence.js';

/**
 * The file's name, owned here rather than in modFolders.js.
 *
 * It sat there while finding one was all modFolders.js did with it. Now that finding a
 * building means *reading* the manifest, modFolders.js imports this module -- so the
 * name has to live on the side that does not import back, or the two form a cycle.
 */
export const MANIFEST_FILE = 'murdermanifest.sodso.json';

/** What a mod that had no manifest gets. The ScriptableObject flow's template. */
export const blankManifest = () => ({ enabled: true, fileOrder: [], loadBefore: '', version: 1 });

/** How `fileOrder` names a file. */
export const refFor = (fileName) => `REF:${fileName}`;

/** The file an entry names, as it compares: no `REF:`, no case, no surrounding space. */
const entryName = (entry) => String(entry).trim().replace(/^REF:/i, '').trim().toLowerCase();

/**
 * Whether `fileOrder` already names the file.
 *
 * A manifest with no `fileOrder` at all, or one that is not a list, names nothing --
 * which is the honest answer, and leaves what to do about it to the caller.
 */
export function isListed(manifest, fileName) {
    if (!Array.isArray(manifest?.fileOrder)) return false;

    const wanted = entryName(fileName);
    return manifest.fileOrder.some((entry) => typeof entry === 'string' && entryName(entry) === wanted);
}

/**
 * The manifest with the file named last, or the same object back when it is named
 * already.
 *
 * Appended rather than inserted: the order is the author's, and where an entry sits in
 * it is a statement about what has to load before what. The end is the one position that
 * says nothing about the entries already there.
 *
 * Every other key is carried through untouched -- `loadBefore`, `enabled`, and anything
 * this app has never heard of.
 */
export function withListing(manifest, fileName) {
    if (isListed(manifest, fileName)) return manifest;

    const fileOrder = Array.isArray(manifest?.fileOrder) ? manifest.fileOrder : [];
    return { ...manifest, fileOrder: [...fileOrder, refFor(fileName)] };
}

/**
 * The manifest with whatever entry names `oldName` now naming `newName`, or the same
 * object back when nothing names it.
 *
 * Rewritten where it sits rather than dropped and re-added at the end: the position of
 * an entry in `fileOrder` is a statement about what loads before what, and renaming a
 * file does not change what it has to load after.
 *
 * The replacement is written in this app's own form, `REF:<name>`. An author's spacing,
 * casing or missing prefix is not carried across, because the name is the whole of what
 * the entry says and the rest is punctuation.
 */
export function withRenamed(manifest, oldName, newName) {
    if (!isListed(manifest, oldName)) return manifest;

    const wanted = entryName(oldName);
    return {
        ...manifest,
        fileOrder: manifest.fileOrder.map((entry) => (
            typeof entry === 'string' && entryName(entry) === wanted ? refFor(newName) : entry
        )),
    };
}

/**
 * The manifest with every entry naming the file taken out, or the same object back when
 * nothing names it.
 *
 * Every entry, not the first: a hand-written load order can name one file twice, and
 * leaving the second behind would leave the loader looking for a file that has gone.
 * Everything else keeps its position, so what has to load before what is unchanged.
 */
export function withoutListing(manifest, fileName) {
    if (!isListed(manifest, fileName)) return manifest;

    const wanted = entryName(fileName);
    return {
        ...manifest,
        fileOrder: manifest.fileOrder.filter((entry) => (
            !(typeof entry === 'string' && entryName(entry) === wanted)
        )),
    };
}

/** A manifest whose `fileOrder` is something other than a list is not ours to rewrite. */
const canList = (manifest) => manifest.fileOrder === undefined || Array.isArray(manifest.fileOrder);

/** A mod with no manifest, and the shape every caller can read against. */
const ABSENT = { present: false, malformed: false, data: null };

/**
 * A content folder's manifest.
 *
 * Unreadable is not the same as absent, and the difference is what may be written: a mod
 * without a manifest gets one, a mod whose manifest will not parse keeps the text its
 * author can still repair.
 */
export async function readManifest(contentFolder) {
    if (!contentFolder) return ABSENT;

    const handle = await tryGetFile(contentFolder, [MANIFEST_FILE]);
    if (!handle) return ABSENT;

    let parsed = null;
    try {
        parsed = JSON.parse(await readFileContent(handle));
    } catch {
        // Reported by the caller, along with the shapes that parse but are not a manifest.
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !canList(parsed)) {
        return { present: true, malformed: true, data: null };
    }

    return { present: true, malformed: false, data: parsed };
}

/**
 * Make sure the loader will load a file: list it in the mod's manifest, writing a
 * manifest first if the mod has none.
 *
 * @param contentFolder the mod's content folder, which is where the manifest sits
 * @param fileName      the file, without its `.sodso.json`
 * @returns what it did -- `created`, `added`, `listed` for a file already named, or
 *          `unreadable` for a manifest that was left alone
 */
export async function ensureListed(contentFolder, fileName) {
    if (!contentFolder || !fileName) return 'unreadable';

    const { present, malformed, data } = await readManifest(contentFolder);

    if (malformed) {
        console.warn(
            `${MANIFEST_FILE} could not be read, so it has been left as it is. `
            + `"${fileName}" will not be loaded until it is listed there by hand.`);
        return 'unreadable';
    }

    const manifest = present ? data : blankManifest();
    const updated = withListing(manifest, fileName);

    // Same object back means it was named already, and a mod's file is not rewritten to
    // say what it says.
    if (present && updated === manifest) return 'listed';

    await writeWholeFile(contentFolder, [MANIFEST_FILE], `${JSON.stringify(updated, null, 2)}\n`);
    return present ? 'added' : 'created';
}

/**
 * Follow a renamed file in the mod's load order.
 *
 * A file the manifest names by its old name is a file the loader goes looking for and
 * does not find, so renaming one without this is how an asset silently stops being part
 * of the mod. A file no entry names is left that way: it was not loaded before the
 * rename and listing it now would be a decision this did not make.
 *
 * A manifest that will not parse is left alone for the same reason `ensureListed` leaves
 * it alone -- the text is the author's, and it may be one comma from working.
 *
 * @param contentFolder the mod's content folder
 * @param oldName       the file's previous name, without its `.sodso.json`
 * @param newName       what it is called now
 * @returns `renamed`, `unlisted` for a file no entry named, or `unreadable`
 */
export async function renameListing(contentFolder, oldName, newName) {
    if (!contentFolder || !oldName || !newName) return 'unreadable';

    const { present, malformed, data } = await readManifest(contentFolder);

    if (!present || malformed) {
        console.warn(
            `${MANIFEST_FILE} could not be read, so it has been left as it is. `
            + `It may still name "${oldName}", which is now "${newName}".`);
        return 'unreadable';
    }

    const updated = withRenamed(data, oldName, newName);

    // Same object back means no entry named it, and a mod's file is not rewritten to say
    // what it already says.
    if (updated === data) return 'unlisted';

    await writeWholeFile(contentFolder, [MANIFEST_FILE], `${JSON.stringify(updated, null, 2)}\n`);
    return 'renamed';
}

/**
 * Take a deleted file out of the mod's load order.
 *
 * The counterpart of `ensureListed`, and it exists for the same reason: `fileOrder` is
 * what makes a file part of the mod, so a deleted file that is still named there is a
 * loader going looking for something that is not on disk. Every mod loads that entry as an
 * error rather than as a missing asset, which is a worse thing to leave behind than the
 * file was.
 *
 * A manifest that will not parse is left alone, as everywhere else here: the text is the
 * author's, and it may be one comma from working.
 *
 * @param contentFolder the mod's content folder
 * @param fileName      the file, without its `.sodso.json`
 * @returns `removed`, `unlisted` for a file no entry named, or `unreadable`
 */
export async function removeListing(contentFolder, fileName) {
    if (!contentFolder || !fileName) return 'unreadable';

    const { present, malformed, data } = await readManifest(contentFolder);

    if (!present || malformed) {
        // Only worth saying when there was a manifest to fail on. A mod without one never
        // listed the file, so there is nothing left pointing at it.
        if (present) {
            console.warn(
                `${MANIFEST_FILE} could not be read, so it has been left as it is. `
                + `It may still name "${fileName}", which has been deleted.`);
        }
        return 'unreadable';
    }

    const updated = withoutListing(data, fileName);
    if (updated === data) return 'unlisted';

    await writeWholeFile(contentFolder, [MANIFEST_FILE], `${JSON.stringify(updated, null, 2)}\n`);
    return 'removed';
}
