/**
 * The base game's ScriptableObjects, read rather than opened.
 *
 * Two flows need these and neither needs a window showing one. The ScriptableObject
 * editor reads an asset to diff a patch against it; the building editor reads one to work
 * out what a patch does to the furniture chain. Both want the same document from the same
 * two places in the same order, and a second copy of that would be a second answer to
 * "which version of the game is this".
 *
 * ## Where an asset comes from
 *
 * The author's own export first, when they have connected one: it is the game they are
 * modding at the version they are running, and it holds every type. What ships with this
 * tool under `refs/assets/` is what there is otherwise, and it is a subset -- nine types
 * of the game's hundreds. So a type is reachable here only if the author connected a
 * folder or it is one of those nine, and `reason` says which of the two failed.
 */
import { readFileContent, tryGetFile, tryGetFolder } from './fs.js';
import { parseJSON } from './jsonNumbers.js';
import { resolveReferences } from './soReferences.js';

/**
 * The base game assets shipped with this tool.
 *
 * Fetched rather than imported -- 12 MB across 1500 files, and one is read at a time.
 *
 * Built from the base the app was compiled for. A page-absolute path would assume the app
 * is mounted at the server root, which a GitHub Pages project site is not; resolving
 * against `import.meta.url` reads correctly and breaks anyway, because the bundler leaves
 * the expression alone and it then resolves against the built chunk in `assets/` rather
 * than against this file. That failure appears only in the build, never in dev.
 */
export const ASSET_DATA = `${import.meta.env.BASE_URL}refs/assets/`;

/**
 * The base game's asset, with Unity's references named.
 *
 * @returns `{ document }`, or `{ reason }` saying what an author can do about it
 */
export async function readBaseAsset(type, name) {
    if (!type || !name) return { reason: 'the file does not say which asset it patches' };

    const path = `${type}/${name}.json`;
    let text = null;

    if (window.dirHandleExportedSOPath) {
        // A read that fails is not an export that lacks the asset, and the two would
        // otherwise be told apart by nothing: falling through to the shipped copy would
        // quietly diff a patch against a different build of the game than the author
        // connected. Reported as a reason, which is what this function answers with.
        try {
            const handle = await tryGetFile(window.dirHandleExportedSOPath, path.split('/'));
            if (handle) text = await readFileContent(handle);
        } catch (error) {
            console.error('Could not read the exported ScriptableObject', error);
            return { reason: `${path} could not be read from your exported ScriptableObjects: ${error.message}` };
        }
    }

    if (text == null) {
        const response = await fetch(`${ASSET_DATA}${path}`);
        if (response.ok) text = await response.text();
    }

    if (text == null) {
        return {
            reason: window.dirHandleExportedSOPath
                ? `neither your exported ScriptableObjects nor this tool has a ${type} called ${name}`
                : `${type} is not one of the types this tool ships assets for. Load your `
                    + 'exported ScriptableObjects folder to patch it',
        };
    }

    try {
        // Through core/jsonNumbers.js, which reads Unity's bare `Infinity`. Five shipped
        // assets hold one and were unpatchable for exactly this reason; `NaN` is the
        // remaining token no reader here accepts, and it is what this now catches.
        return { document: resolveReferences(parseJSON(text), await pathIdMap()) };
    } catch {
        // An unreadable base is an unpatchable asset.
        return { reason: `${path} is not valid JSON, so there is nothing to compare against` };
    }
}

/**
 * Every asset name of one type.
 *
 * The export folder itself where there is one, listed rather than looked up. That is the
 * difference worth having: `soAssetsByType.json` is generated from whichever build of the
 * game was dumped, so an asset a newer version added is in the author's export and absent
 * from the list -- present on disk, invisible in every picker.
 *
 * Falls back to the generated list, which is what there is with no export folder connected
 * and is still the right answer then: it names what this tool ships assets for.
 *
 * Sorted, because a directory hands names back in whatever order it holds them and the
 * order a picker lists them in should not depend on the file system.
 */
export async function listBaseAssets(type) {
    const listed = window.typeMap?.[type] ?? [];
    if (!window.dirHandleExportedSOPath) return listed;

    const names = [];

    try {
        const folder = await tryGetFolder(window.dirHandleExportedSOPath, [type]);

        // An export that has no folder for this type is an export that does not hold it,
        // and the generated list is a better answer than none. So is a folder that could
        // not be walked -- this fills a picker and nothing is written on the answer, which
        // is what makes degrading to the shipped list safe here and not in readBaseAsset.
        if (!folder) return listed;

        for await (const entry of folder.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.json')) {
                names.push(entry.name.slice(0, -'.json'.length));
            }
        }
    } catch {
        return listed;
    }

    return names.sort();
}

/**
 * Unity's file ids, mapped to `Type|Name`.
 *
 * The ScriptableObject flow publishes this on activation and every read there goes through
 * the global, which is left alone: it is 1.6 MB of generated JSON and that flow pays for it
 * on load because every document it opens needs it.
 *
 * The building flow does not, and should not start: it reads an asset only when a mod holds
 * a patch of a furniture type, which most do not. So this imports the file on the first
 * read that has no global to use, and holds it thereafter. Skipping it is not an option --
 * an unresolved reference is an `{ m_FileID }` object where a name should be, which reads
 * downstream as a list with nothing in it.
 *
 * Exported for the one caller that has a single id to name rather than a document to
 * resolve: a dumped BuildingPreset points at its stairwell this way, and naming it through
 * a second copy of this map would be a second answer to the same question.
 */
let lazyMap = null;

export async function pathIdMap() {
    if (window.pathIdMap) return window.pathIdMap;

    // The same derivation the ScriptableObject flow's loadRefs.js makes: an id maps to a
    // list of names, of which the first is the asset.
    lazyMap ??= import('../refs/generated/soPathIds.json', { with: { type: 'json' } })
        .then(({ default: ids }) =>
            Object.fromEntries(Object.entries(ids).map(([id, names]) => [id, names[0]])))
        .catch(() => ({}));

    return lazyMap;
}
