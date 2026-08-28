/**
 * Finding editable content inside a BepInEx plugins folder.
 *
 * The folder you point at is BepInEx/plugins: one subfolder per installed mod. What
 * we can edit is not the mod folder itself but a *content folder* -- one holding a
 * murdermanifest.sodso.json, a DDSContent directory, a Floors directory, or any
 * combination.
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
 * A building mod is a <Building>.sodso.json next to a Floors directory holding that
 * building's floor blueprints. The preset is named after the building, so there is no
 * fixed filename to look for -- the directory is the marker, exactly as DDSContent is.
 *
 * A manifest naming the preset is not the marker even though this app writes one for
 * every building it creates (see core/murderManifest.js): plenty of building mods in the
 * wild predate that, and a manifest on its own says nothing about floors.
 */
export const FLOORS_DIR = 'Floors';

/**
 * How far below a mod to look. The deepest real example is three
 * (plugins/Cases/test), so four leaves headroom without walking whole asset trees.
 */
const MAX_DEPTH = 4;

/**
 * Directories never worth descending into. DDSContent and Floors are themselves
 * markers -- what is inside them is DDS/Trees and floor blueprints, not further
 * content folders.
 */
const SKIP = new Set([DDS_CONTENT_DIR, FLOORS_DIR, 'Strings', '.git', 'node_modules']);

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
    let hasFloors = false;

    for await (const entry of handle.values()) {
        if (entry.kind === 'file' && entry.name === MANIFEST_FILE) hasManifest = true;
        if (entry.kind === 'directory' && entry.name === DDS_CONTENT_DIR) hasDdsContent = true;
        if (entry.kind === 'directory' && entry.name === FLOORS_DIR) hasFloors = true;
    }

    return { hasManifest, hasDdsContent, hasFloors };
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
        const { hasManifest, hasDdsContent, hasFloors } = await describe(handle);

        if (hasManifest || hasDdsContent || hasFloors) {
            found.push({ path, handle, hasManifest, hasDdsContent, hasFloors });
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
export function describeContentFolder({ path, hasManifest, hasDdsContent, hasFloors }) {
    const kinds = [hasManifest && 'case', hasDdsContent && 'DDS', hasFloors && 'building']
        .filter(Boolean);
    // A folder that was just created holds none of them yet.
    return `${path || '(mod root)'} — ${kinds.join(' + ') || 'new'}`;
}
