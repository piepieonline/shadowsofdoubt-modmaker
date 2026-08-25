/**
 * Finding editable content inside a BepInEx plugins folder.
 *
 * The folder you point at is BepInEx/plugins: one subfolder per installed mod. What
 * we can edit is not the mod folder itself but a *content folder* -- one holding a
 * murdermanifest.sodso.json, a DDSContent directory, or both.
 *
 * Where that sits varies, and all of these occur in a real plugins folder:
 *
 *   DartTowerTest                                        the mod root itself
 *   AdditionalEvidence/BinPasscodes                       a direct subfolder
 *   DialogAdditions/plugins/TalkToPartner                 under the BepInEx plugins/ convention
 *   WhiteCollarSideJobs/plugins/Cases/test                deeper again
 *
 * So the second choice cannot be "the mod's subfolders" -- it has to be a search.
 * One mod often holds several, and many mods hold none at all (loaders, utilities).
 */

export const MANIFEST_FILE = 'murdermanifest.sodso.json';
export const DDS_CONTENT_DIR = 'DDSContent';

/**
 * How far below a mod to look. The deepest real example is three
 * (plugins/Cases/test), so four leaves headroom without walking whole asset trees.
 */
const MAX_DEPTH = 4;

/**
 * Directories never worth descending into. DDSContent is itself a marker -- what is
 * inside it is DDS/Trees and friends, not further content folders.
 */
const SKIP = new Set([DDS_CONTENT_DIR, 'Strings', '.git', 'node_modules']);

async function subdirectories(handle) {
    const dirs = [];
    for await (const entry of handle.values()) {
        if (entry.kind === 'directory' && !SKIP.has(entry.name)) dirs.push(entry);
    }
    return dirs.sort((a, b) => a.name.localeCompare(b.name));
}

async function describe(handle) {
    let hasManifest = false;
    let hasDdsContent = false;

    for await (const entry of handle.values()) {
        if (entry.kind === 'file' && entry.name === MANIFEST_FILE) hasManifest = true;
        if (entry.kind === 'directory' && entry.name === DDS_CONTENT_DIR) hasDdsContent = true;
    }

    return { hasManifest, hasDdsContent };
}

/** The mods installed in a plugins folder, whether or not they hold content. */
export async function listMods(pluginsHandle) {
    const mods = [];
    for await (const entry of pluginsHandle.values()) {
        if (entry.kind === 'directory' && !entry.name.startsWith('.')) mods.push(entry);
    }
    return mods.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every content folder within a mod, as paths relative to the mod root. The mod root
 * itself is included when it qualifies, described as ''.
 *
 * Content folders are not nested in practice, so a match stops the search below it.
 */
export async function findContentFolders(modHandle) {
    const found = [];

    async function walk(handle, path, depth) {
        const { hasManifest, hasDdsContent } = await describe(handle);

        if (hasManifest || hasDdsContent) {
            found.push({ path, handle, hasManifest, hasDdsContent });
            return;
        }

        if (depth >= MAX_DEPTH) return;

        for (const entry of await subdirectories(handle)) {
            await walk(entry, path ? `${path}/${entry.name}` : entry.name, depth + 1);
        }
    }

    await walk(modHandle, '', 0);
    return found;
}

/** How a content folder should read in a dropdown. */
export function describeContentFolder({ path, hasManifest, hasDdsContent }) {
    const kinds = [hasManifest && 'case', hasDdsContent && 'DDS'].filter(Boolean);
    // A folder that was just created holds neither yet.
    return `${path || '(mod root)'} — ${kinds.join(' + ') || 'new'}`;
}
