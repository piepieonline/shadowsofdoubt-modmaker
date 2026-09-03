/**
 * What a case's content folder contains, grouped by the type of ScriptableObject.
 *
 * The manifest panel only shows what the manifest references. A folder routinely
 * holds more than that -- files not yet added to the manifest, and patches, which
 * are listed or not depending on how they were made.
 *
 * Two kinds of file, as in the DDS flow:
 *   <name>.<type>.sodso.json  an asset the mod adds; its type is inside it too
 *   <name>.sodso_patch.json   an override of a base game asset
 *
 * A patch is a partial file which gets applied over the existing object, so its type is recovered by
 * looking the asset's name up in the generated reference data.
 *
 * A file that answers neither question -- no name, or no type the game has -- cannot be
 * grouped or opened, so it is listed on its own under Invalid rather than filed
 * somewhere it does not belong.
 *
 * An entry's `id` is the file and its `label` is the asset, which are two different
 * strings now that a file name carries the type -- see core/soFileName.js. The panel
 * opens what `id` names and shows what `label` says.
 */
import { readFileContent } from '../../../core/fs.js';
import { readManifest, isListed } from '../../../core/murderManifest.js';
import { assetNameOf, PATCH_SUFFIX, PRESET_SUFFIX } from '../../../core/soFileName.js';
import { permissionOnly } from './roomPermissions.js';
import { parseJSON } from '../../../core/jsonNumbers.js';

export const NEW_SUFFIX = PRESET_SUFFIX;
export { PATCH_SUFFIX };

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
 * What a file is, and what it calls itself.
 *
 * A file says what it is, and a patch says so too when it was made here. Only a patch
 * written by hand can be silent about it, and then the asset's name is the one clue
 * left -- good enough when the name belongs to a single type, a guess otherwise.
 *
 * The asset's own name is read from the same parse rather than assumed to be the file
 * name. This app keeps the two together -- renaming a preset renames its file -- but a
 * hand-written mod need not, and it is `presetName` the game resolves a `REF:` against.
 * The file name is what the panel opens; this is what a reference to it has to say.
 * A patch states the base game asset it overrides in `name`, which is the right answer
 * there for the same reason.
 *
 * `permission` is set on the patches that say nothing but "this room may use me", which
 * the panel offers to leave out -- see `roomPermissions.js`. Read from the same parse, so
 * it costs no second pass over the folder. Only a patch is asked: an asset of the mod's
 * own states its whole self and is not a permission, however its author uses it.
 */
async function identify(entry, name, isPatch, assetTypes) {
    let parsed = null;
    try {
        parsed = parseJSON(await readFileContent(entry));
    } catch {
        parsed = null;
    }

    let stated = parsed?.fileType ?? null;

    // A type the game does not have is no better than none: it names no template to
    // edit against and no group to file the asset under.
    if (stated && !(stated in (window.typeMap ?? {}))) stated = null;

    const type = stated ?? (isPatch ? assetTypes.get(name) : null) ?? null;

    // Falling back to the file name means falling back to the *asset's* half of it. A
    // patch's name carries no type to take off, so the one expression serves both.
    return {
        type,
        assetName: parsed?.presetName ?? parsed?.name ?? assetNameOf(name, type),
        permission: isPatch ? permissionOnly(parsed, type) : null,
    };
}

/**
 * Everything in the content folder, grouped by type, in the shape
 * core/filePanel.js renders.
 */
export async function listContent(contentFolder) {
    // Forgotten rather than left behind: deselecting a mod has to take its assets out of
    // the reference fields too, or they go on offering the last mod's files.
    if (!contentFolder) { remember([]); return null; }

    const assetTypes = buildAssetTypeIndex();
    const byType = new Map();

    // Read once for the folder rather than per file. What it decides is not what the panel
    // shows -- everything in the folder is shown, listed or not, because a file the
    // manifest has forgotten is exactly the one an author needs to see -- but whether the
    // file is offered elsewhere as something to point at. See `moddedNamesOfType`.
    const manifest = (await readManifest(contentFolder)).data;

    for await (const entry of contentFolder.values()) {
        if (entry.kind !== 'file') continue;

        const isPatch = entry.name.endsWith(PATCH_SUFFIX);
        const isNew = !isPatch && entry.name.endsWith(NEW_SUFFIX);
        if (!isPatch && !isNew) continue;

        const name = entry.name.slice(0, -(isPatch ? PATCH_SUFFIX : NEW_SUFFIX).length);
        if (name === MANIFEST) continue;

        const { type, assetName, permission } = await identify(entry, name, isPatch, assetTypes);

        // A file the app cannot name or type is degenerate: there is no template to
        // edit it against and no group it belongs in. Kept in sight, since something
        // in the folder is not what it should be, but off on its own.
        const group = name && type ? type : INVALID;

        if (!byType.has(group)) byType.set(group, []);
        byType.get(group).push({
            // The file, which is what opens it and what the manifest lists.
            id: name || entry.name,
            // The asset, which is what an author calls it. A file with no type to take
            // off reads the same either way; one under Invalid has no type to take off
            // and is shown exactly as it sits in the folder.
            label: group === INVALID ? (name || entry.name) : assetNameOf(name, type),
            tag: isPatch ? 'patch' : null,
            // Which file the name belongs to: the two live side by side in the folder
            // and differ only by extension.
            suffix: isPatch ? PATCH_SUFFIX : NEW_SUFFIX,
            // A patch holds a document of its own, so it opens like any other file.
            // Its type is not always inside it, which is why it is passed along here.
            openAs: group === INVALID ? null : type,
            // Whether the game would load it at all. The panel does not act on this; the
            // reference dropdowns do.
            listed: isListed(manifest, name),
            // What a `REF:` to it says, which is not always what the file is called.
            assetName,
            // Null unless the file does nothing but admit something to a room, in which
            // case which kind of admission it is. What the panel's filter acts on.
            permission,
        });
    }

    const groups = [...byType.entries()]
        .filter(([group]) => group !== INVALID)
        .sort(([a], [b]) => a.localeCompare(b));

    // Last: it is the exception, and nothing is found by looking for it.
    if (byType.has(INVALID)) groups.push([INVALID, byType.get(INVALID)]);

    const listing = groups
        .map(([type, entries]) => ({
            id: type,
            label: type,
            entries: entries.sort((a, b) => a.label.localeCompare(b.label)),
        }));

    remember(listing);
    return listing;
}


/* -------------------------------------------------------------------------- */
/* What the mod defines, for the reference fields                              */
/* -------------------------------------------------------------------------- */

/**
 * The last listing, by type.
 *
 * A reference field asks what the mod has of its type while the tree is being rendered,
 * which is synchronous and cannot go near a folder. So the answer is whatever the last
 * walk found -- and that walk is the one the file panel already does, on the same folder,
 * at every point this could go stale: choosing a mod or a content folder, creating a
 * file, renaming a preset, deleting one. `refreshPanel` is the single path through all of
 * those, so there is no separate thing to remember to invalidate.
 *
 * Null when there is no folder, which is not the same as a folder holding nothing: with
 * no mod selected the fields fall back to the base game's list alone.
 */
let byTypeIndex = null;

function remember(listing) {
    byTypeIndex = new Map(listing.map((group) => [group.id, group.entries]));
}

/**
 * What the mod defines of one type, for a field that points at that type.
 *
 * Only what the game would load. A file the manifest does not name is not offered as
 * something to point at -- writing a reference to it produces a mod that resolves for the
 * author and not for anyone else, which is worse than not offering it.
 *
 * Patches are included, and a patch of a base game asset is deliberately **not** removed
 * from the base game's list: it is the mod's, and it is still the shipped asset of that
 * name, and both of those are true at once. The name appears under each heading.
 *
 * `exclude` is the document doing the asking, so that a file is not offered as something
 * to point at from inside itself. It is a name *and* a type because neither settles it
 * alone: hundreds of asset names belong to more than one type -- `Bar` is six things --
 * so a MurderMO called `Bar` must still be able to point at the `AddressPreset` of that
 * name. Only the file that is both is left out.
 */
export function moddedNamesOfType(type, exclude = null) {
    if (!byTypeIndex || !type) return [];

    const self = exclude?.type === type ? exclude.name : null;

    return (byTypeIndex.get(type) ?? [])
        .filter((entry) => entry.listed && entry.assetName !== self)
        .map((entry) => entry.assetName);
}

/**
 * The file one of the mod's assets is stored as, for opening what a reference names.
 *
 * A `REF:` carries an asset name and a type, and neither the name nor the two together
 * are the file: an asset is stored as `<name>.<type>.sodso.json`, a patch as
 * `<name>.sodso_patch.json`, and a mod written by hand may call the file anything at all
 * -- a `REF:` resolves against `presetName`, not against what the file is named. So this
 * answers from the folder listing rather than by building a name and hoping.
 *
 * Both halves are needed. `Bar` is six of the game's types, so a name on its own picks
 * whichever file happened to be walked first, which is how a reference to one asset came
 * to open another of the same name.
 *
 * Unlisted files are included, unlike `moddedNamesOfType`: that decides what may be
 * *offered* as something to point at, and this opens what a document already points at.
 * A reference to a file the manifest has forgotten is exactly the one worth being able to
 * go and look at.
 */
export function modFileOfAsset(type, assetName) {
    if (!byTypeIndex || !type || !assetName) return null;

    return (byTypeIndex.get(type) ?? []).find((entry) => entry.assetName === assetName) ?? null;
}

/**
 * The file a load order entry names, for opening what the manifest lists.
 *
 * `fileOrder` names files rather than assets -- see core/murderManifest.js -- so the entry
 * is the file's name already, bar the part that says which kind of file it is. That part
 * is the whole problem: an asset is `<stem>.sodso.json` and an override is
 * `<stem>.sodso_patch.json`, and taking every entry for the first is why an override in a
 * load order opened as a file that is not there. The type is missing from an entry too,
 * and a patch does not always carry one inside it, so the listing answers both at once.
 *
 * An asset is preferred to an override of the same stem. Both can sit in a folder -- a
 * preset named before file names carried a type, beside an override of the asset it
 * shares a name with -- and the asset is the one an entry has always opened.
 *
 * Matched exactly first and then without case, as `isListed` compares: mods in the wild
 * lowercase what they list, and such an entry still names the file.
 */
export function modFileOfStem(stem) {
    if (!byTypeIndex || !stem) return null;

    const files = [...byTypeIndex.values()].flat();
    const wanted = String(stem).toLowerCase();

    const best = (matches) => files.find((entry) => matches(entry) && entry.suffix === NEW_SUFFIX)
        ?? files.find(matches)
        ?? null;

    return best((entry) => entry.id === stem) ?? best((entry) => entry.id.toLowerCase() === wanted);
}
