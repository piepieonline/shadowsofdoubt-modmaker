/**
 * What a case's content folder contains, grouped by the type of ScriptableObject.
 *
 * The manifest panel only shows what the manifest references. A folder routinely
 * holds more than that -- files not yet added to the manifest, and patches, which
 * are listed or not depending on how they were made.
 *
 * Two kinds of file, as in the DDS flow:
 *   <name>.sodso.json         an asset the mod adds; its type is inside it
 *   <name>.sodso_patch.json   an override of a base game asset
 *
 * A patch is a partial file which gets applied over the existing object, so its type is recovered by
 * looking the asset's name up in the generated reference data.
 *
 * A file that answers neither question -- no name, or no type the game has -- cannot be
 * grouped or opened, so it is listed on its own under Invalid rather than filed
 * somewhere it does not belong.
 */
import { readFileContent } from '../../../core/fs.js';

export const NEW_SUFFIX = '.sodso.json';
export const PATCH_SUFFIX = '.sodso_patch.json';

/** The manifest describes the mod rather than being an asset of its own. */
const MANIFEST = 'murdermanifest';

/** Where files that answer neither question go. */
const INVALID = 'Invalid';

/**
 * name -> type, built from the type map on demand. The map is large and keyed the
 * other way, so this is worth doing once per listing rather than per file.
 *
 * Hundreds of asset names belong to more than one type -- Bar is an AddressPreset, a
 * RoomTypeFilter and four other things besides -- so a name on its own does not always
 * answer the question. Those are recorded as ambiguous rather than resolved to
 * whichever type the map happens to list first, which is how an AddressPreset patch
 * came to be filed under RoomTypeFilter.
 */
function buildAssetTypeIndex() {
    const index = new Map();
    for (const [type, names] of Object.entries(window.typeMap ?? {})) {
        for (const name of names ?? []) index.set(name, index.has(name) ? null : type);
    }
    return index;
}

/**
 * A file says what it is, and a patch says so too when it was made here. Only a patch
 * written by hand can be silent about it, and then the asset's name is the one clue
 * left -- good enough when the name belongs to a single type, a guess otherwise.
 */
async function typeOf(entry, name, isPatch, assetTypes) {
    let stated = null;
    try {
        stated = JSON.parse(await readFileContent(entry))?.fileType ?? null;
    } catch {
        stated = null;
    }

    // A type the game does not have is no better than none: it names no template to
    // edit against and no group to file the asset under.
    if (stated && !(stated in (window.typeMap ?? {}))) stated = null;

    return stated ?? (isPatch ? assetTypes.get(name) : null) ?? null;
}

/**
 * Everything in the content folder, grouped by type, in the shape
 * core/filePanel.js renders.
 */
export async function listContent(contentFolder) {
    if (!contentFolder) return null;

    const assetTypes = buildAssetTypeIndex();
    const byType = new Map();

    for await (const entry of contentFolder.values()) {
        if (entry.kind !== 'file') continue;

        const isPatch = entry.name.endsWith(PATCH_SUFFIX);
        const isNew = !isPatch && entry.name.endsWith(NEW_SUFFIX);
        if (!isPatch && !isNew) continue;

        const name = entry.name.slice(0, -(isPatch ? PATCH_SUFFIX : NEW_SUFFIX).length);
        if (name === MANIFEST) continue;

        const type = await typeOf(entry, name, isPatch, assetTypes);

        // A file the app cannot name or type is degenerate: there is no template to
        // edit it against and no group it belongs in. Kept in sight, since something
        // in the folder is not what it should be, but off on its own.
        const group = name && type ? type : INVALID;

        if (!byType.has(group)) byType.set(group, []);
        byType.get(group).push({
            id: name || entry.name,
            label: name || entry.name,
            tag: isPatch ? 'patch' : null,
            // Which file the name belongs to: the two live side by side in the folder
            // and differ only by extension.
            suffix: isPatch ? PATCH_SUFFIX : NEW_SUFFIX,
            // A patch holds a document of its own, so it opens like any other file.
            // Its type is not always inside it, which is why it is passed along here.
            openAs: group === INVALID ? null : type,
        });
    }

    const groups = [...byType.entries()]
        .filter(([group]) => group !== INVALID)
        .sort(([a], [b]) => a.localeCompare(b));

    // Last: it is the exception, and nothing is found by looking for it.
    if (byType.has(INVALID)) groups.push([INVALID, byType.get(INVALID)]);

    return groups
        .map(([type, entries]) => ({
            id: type,
            label: type,
            entries: entries.sort((a, b) => a.label.localeCompare(b.label)),
        }));
}
