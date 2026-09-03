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

import { readFileContent } from './fs.js';
import { MANIFEST_FILE, isListed, readManifest } from './murderManifest.js';
import { PRESET_SUFFIX } from './soFileName.js';
import { parseJSON } from './jsonNumbers.js';

export { MANIFEST_FILE };
export const DDS_CONTENT_DIR = 'DDSContent';

/**
 * A building mod is one whose murdermanifest.sodso.json names a `.sodso.json` sitting in
 * the same folder that says `fileType: "BuildingPreset"`.
 *
 * Both halves are load-bearing. The preset is named after the building, so there is no
 * fixed filename to look for and the file has to be opened to know what it is. And a
 * preset the manifest does not name is a file the mod loader never reads -- see
 * core/murderManifest.js -- so a folder holding one unlisted has no building in the game
 * and none worth offering to edit.
 *
 * The Floors directory is deliberately not the marker. It says a mod holds floor
 * blueprints, not that anything reaches them: a blueprint is only ever loaded through a
 * building that names it, and a building only through the manifest. What that costs is a
 * building mod whose preset is unlisted, which stops being offered here -- but that is a
 * mod the game is not loading either, and listing the preset is the same fix in both
 * places.
 */
export const BUILDING_TYPE = 'BuildingPreset';

/** Where a mod keeps its floor blueprints. Not a marker; see BUILDING_TYPE. */
export const FLOORS_DIR = 'Floors';

/**
 * How far below a mod to look. The deepest real example is three
 * (plugins/Cases/test), so four leaves headroom without walking whole asset trees.
 */
const MAX_DEPTH = 4;

/**
 * Directories never worth descending into. What is inside them is DDS/Trees and floor
 * blueprints, not further content folders.
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

    // Collected while the entries are in hand, keyed as a manifest entry compares --
    // mods in the wild lowercase the names they list, so `REF:talltower` has to find
    // TallTower.sodso.json. The manifest itself ends in the same suffix, hence the
    // else-if rather than three independent tests.
    const presets = new Map();

    for await (const entry of handle.values()) {
        if (entry.kind === 'file' && entry.name === MANIFEST_FILE) {
            hasManifest = true;
        } else if (entry.kind === 'directory' && entry.name === DDS_CONTENT_DIR) {
            hasDdsContent = true;
        } else if (entry.kind === 'file' && entry.name.endsWith(PRESET_SUFFIX)) {
            presets.set(entry.name.slice(0, -PRESET_SUFFIX.length).toLowerCase(), entry);
        }
    }

    return {
        hasManifest,
        hasDdsContent,
        // Nothing is opened unless there is both a manifest and something for it to
        // name, so the folders this walks past cost a directory listing and no more.
        hasBuildings: hasManifest && presets.size > 0 && await namesABuilding(handle, presets),
    };
}

/**
 * Whether the folder's manifest names one of its presets as a building.
 *
 * Driven from the files rather than from `fileOrder` so that only presets actually
 * present are opened, and so the loose matching of an entry to a name stays in
 * core/murderManifest.js where the rest of it is. A manifest that will not parse names
 * nothing, which is the same answer `isListed` gives -- an unreadable manifest is not a
 * building we can offer to edit.
 */
async function namesABuilding(handle, presets) {
    const { data } = await readManifest(handle);

    for (const [name, file] of presets) {
        if (!isListed(data, name)) continue;

        try {
            const preset = parseJSON(await readFileContent(file));
            if (preset?.fileType === BUILDING_TYPE) return true;
        } catch {
            // A file that will not parse is not a building. One bad file does not stop
            // the folder being described by the rest.
        }
    }

    return false;
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
        const { hasManifest, hasDdsContent, hasBuildings } = await describe(handle);

        // Two tests rather than three: a building is a manifest entry, so a folder
        // holding one is already a folder holding a manifest.
        if (hasManifest || hasDdsContent) {
            found.push({ path, handle, hasManifest, hasDdsContent, hasBuildings });
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
export function describeContentFolder({ path, hasManifest, hasDdsContent, hasBuildings }) {
    const kinds = [hasManifest && 'case', hasDdsContent && 'DDS', hasBuildings && 'building']
        .filter(Boolean);
    // A folder that was just created holds none of them yet.
    return `${path || '(mod root)'} — ${kinds.join(' + ') || 'new'}`;
}
