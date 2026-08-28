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
// The file name is modFolders.js's because finding one is what marks a folder as a
// mod's content. One constant, so the two cannot disagree about what to look for.
import { MANIFEST_FILE } from './modFolders.js';
import { writeWholeFile } from './persistence.js';

export { MANIFEST_FILE };

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
