/**
 * A mod's DDS manifest: the virtual structure the loader reads its files through.
 *
 * `ddsmanifest.json`, in a mod's DDSContent, gives a file a path other than the one it
 * sits at:
 *
 *   { "enabled": true, "files": { "jobs.csv": "Strings/English/Citizens" } }
 *
 * The key is where the file really is, relative to DDSContent; the value is the folder
 * the game reads it from. So DDSContent/jobs.csv loads as
 * Strings/English/Citizens/jobs.csv, and a mod can keep its content flat instead of
 * mirroring the game's folder tree.
 *
 * Only strings CSVs are placed this way. Trees, messages and blocks are always at
 * DDS/Trees, DDS/Messages and DDS/Blocks.
 *
 * A mod without a manifest is the ordinary case and stays exactly as it was: every
 * function here resolves to the path it was handed, so callers need no branch of their
 * own. The app never creates a manifest for a mod that has none.
 *
 * `enabled` is carried through a write untouched. The loader does not act on it, so
 * neither does this.
 */
import { getFile, getFolder, readFileContent, tryGetFile, tryGetFolder } from '../../../core/fs.js';
import { writeWholeFile } from '../../../core/persistence.js';

export const MANIFEST_FILE = 'ddsmanifest.json';

/** Where DDS block text lives when nothing says otherwise. */
export const DDS_BLOCKS_VIRTUAL = 'Strings/English/DDS/dds.blocks.csv';

/** A mod with no manifest, and the shape every caller can resolve against. */
const ABSENT = { present: false, malformed: false, files: [], extra: {}, raw: null };

/** '\' to '/', with no leading, trailing or doubled separator. */
const clean = (path) => String(path).replaceAll('\\', '/').split('/').filter(Boolean).join('/');

const basename = (path) => path.split('/').at(-1);
const dirname = (path) => path.split('/').slice(0, -1).join('/');
const join = (dir, name) => (dir ? `${dir}/${name}` : name);

/** A path that climbs out of the content folder is not ours to resolve. */
const escapes = (path) => path.split('/').includes('..') || /^[a-z]:/i.test(path);

/** Where the loader reads a mapped file from. */
export const virtualPathOf = (mapping) => join(mapping.virtualDir, basename(mapping.real));

/** Mappings apply only when there is a manifest and it could be read. */
export const isActive = (manifest) => manifest.present && !manifest.malformed;

/**
 * The `files` object as an ordered list.
 *
 * Order is kept because it is what decides ties: two entries can claim one virtual
 * path, and resolving to the same one of them every time matters more than guessing
 * which was meant.
 */
function mappingsFrom(files) {
    if (!files || typeof files !== 'object' || Array.isArray(files)) return [];

    const mappings = [];

    for (const [key, value] of Object.entries(files)) {
        if (typeof value !== 'string') continue;

        const real = clean(key);
        const virtualDir = clean(value);

        if (!real || escapes(real) || escapes(virtualDir)) {
            console.warn(`Ignoring ${MANIFEST_FILE} entry, path leaves the content folder: ${key}`);
            continue;
        }

        mappings.push({ real, virtualDir });
    }

    return mappings;
}

/** @param ddsFolder the mod's DDSContent folder, or null */
export async function readManifest(ddsFolder) {
    if (!ddsFolder) return ABSENT;

    const handle = await tryGetFile(ddsFolder, [MANIFEST_FILE]);
    if (!handle) return ABSENT;

    const raw = await readFileContent(handle);

    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Reported below, along with the shapes that parse but are not a manifest.
    }

    // Unreadable is not the same as absent. The mod meant to have a manifest, so
    // nothing here may overwrite it -- but nothing can be resolved through it either,
    // and falling back to physical paths is what the mod looked like anyway.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn(`${MANIFEST_FILE} is not readable JSON; treating every file as unmapped`);
        return { present: true, malformed: true, files: [], extra: {}, raw };
    }

    // Everything but `files` is kept as it was found, so a key this app does not know
    // about survives a write.
    const { files, ...extra } = parsed;

    return { present: true, malformed: false, files: mappingsFrom(files), extra, raw };
}

/** Where the loader reads a real path from. Identity when it is not mapped. */
export function toVirtual(manifest, realPath) {
    if (!isActive(manifest)) return realPath;

    const mapping = manifest.files.find((entry) => entry.real === realPath);
    return mapping ? virtualPathOf(mapping) : realPath;
}

/** Where a virtual path really lives. Identity when nothing claims it. */
export function toReal(manifest, virtualPath) {
    if (!isActive(manifest)) return virtualPath;

    const mapping = manifest.files.find((entry) => virtualPathOf(entry) === virtualPath);
    return mapping ? mapping.real : virtualPath;
}

/**
 * Where a strings file the app is about to write belongs, and the manifest entry the
 * loader would need in order to find it there.
 *
 * A mod that has said where its CSVs go has said it for the next one too: when every
 * entry agrees on a folder, new content joins them there and gains an entry of its
 * own. When they disagree, or there are none to go by, the file is written where the
 * game reads it from and the manifest is left alone -- inventing a layout for a mod
 * that has not settled on one is worse than using the plain one.
 */
export function placeStringsFile(manifest, virtualPath) {
    if (!isActive(manifest)) return { real: virtualPath, addEntry: null };

    const mapped = manifest.files.find((entry) => virtualPathOf(entry) === virtualPath);
    if (mapped) return { real: mapped.real, addEntry: null };

    const folders = [...new Set(manifest.files.map((entry) => dirname(entry.real)))];
    const virtualDir = dirname(virtualPath);
    const realDir = folders.length === 1 ? folders[0] : virtualDir;

    const real = join(realDir, basename(virtualPath));

    // Where the file already sits at the path the game reads, there is nothing to
    // declare.
    return { real, addEntry: realDir === virtualDir ? null : { real, virtualDir } };
}

/** One more mapping, appended so the order the author chose is left as it was. */
export const withMapping = (manifest, mapping) =>
    ({ ...manifest, files: [...manifest.files, mapping] });

/**
 * Rewrite ddsmanifest.json, keeping every key this app does not know about.
 *
 * Refuses when there is nothing to rewrite: a mod without a manifest never gains one
 * as a side effect of an edit, and one whose manifest cannot be parsed keeps the text
 * its author can still repair.
 */
export async function writeManifest(ddsFolder, manifest) {
    if (!ddsFolder || !isActive(manifest)) return false;

    const files = Object.fromEntries(manifest.files.map(({ real, virtualDir }) => [real, virtualDir]));
    await writeWholeFile(ddsFolder, [MANIFEST_FILE], JSON.stringify({ ...manifest.extra, files }, null, 2));

    return true;
}

/**
 * A handle for a real path below DDSContent.
 *
 * core/fs.js getFile creates the file but not the folders above it, so a write has to
 * make its own way down. Nothing creates strings folders in advance any more: a mod
 * that keeps its CSVs flat should not find Strings/English/DDS inside it merely
 * because the app went looking.
 */
export async function stringsFileHandle(ddsFolder, realPath, create) {
    if (!ddsFolder) return null;

    const segments = realPath.split('/');
    const name = segments.pop();

    // getFolder consumes the array it is given, so each call gets its own copy.
    const folder = segments.length === 0
        ? ddsFolder
        : create
            ? await getFolder(ddsFolder, [...segments], true)
            : await tryGetFolder(ddsFolder, [...segments]);

    if (!folder) return null;

    return create ? getFile(folder, [name], true) : tryGetFile(folder, [name]);
}
