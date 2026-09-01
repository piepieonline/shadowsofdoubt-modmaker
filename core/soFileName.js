/**
 * What a ScriptableObject file in a mod is called: `<presetName>.<fileType>.sodso.json`.
 *
 * The type is in the file name because a name on its own does not identify an asset.
 * Hundreds of them belong to more than one type -- `Bar` is an AddressPreset, a
 * RoomTypeFilter and four other things besides -- so a mod defining two of them had two
 * files fighting over one name, and whichever was written second won.
 *
 * The stem is the *file's* name and nothing else's. What an asset calls itself is
 * `presetName`: that is what a `REF:` resolves against, what the file panel labels it
 * with, and what every reference dropdown offers, and the type appears in none of them.
 * The one place the two meet is murdermanifest.sodso.json, which lists files rather than
 * assets -- see core/murderManifest.js -- and so lists the stem.
 *
 * Taking the type off again needs to be told what it is, rather than working it out from
 * the shape of the name. Two things make a guess wrong:
 *
 *   Foo.sodso.json           written before this convention, and still perfectly loadable
 *   Something.Else.sodso.json   a preset whose name has a dot in it
 *
 * Matching against the type the file itself declares answers both, because nothing is
 * taken off a stem that does not end in it.
 */

/** What a ScriptableObject file the mod loader reads is called. */
export const PRESET_SUFFIX = '.sodso.json';

/**
 * An override: a partial file applied over a base game asset.
 *
 * Which asset is settled by the `name` and `fileType` **inside** the file, not by what the
 * file is called -- so the name is free, and is ordinarily the bare asset name because
 * that is the shortest thing that says what the file is for.
 *
 * Ordinarily, not always. One name belongs to assets of more than one type all through the
 * game's data -- `SecurityDoorDouble` is a `FurnitureCluster` and a `FurniturePreset`,
 * `BreakerBox` is those and a `RoomTypeFilter` -- and a patch carries one `fileType`, so
 * overriding two of them takes two files and the bare name only fits one. The type goes in
 * the name of both when that happens: see `patchFileNameFor`. `assetNameOf` takes it off
 * again, which is the same thing it does for an asset's own file name.
 */
export const PATCH_SUFFIX = '.sodso_patch.json';

/**
 * The file name, without its suffix, that an asset of this type is stored under.
 *
 * Both arguments are required: a file with no type is not a typed asset -- the manifest
 * is the only one -- and does not belong here.
 */
export function stemFor(name, type) {
    if (!name || !type) throw new Error('A ScriptableObject file is named by an asset name and a type');
    return `${name}.${type}`;
}

/** The whole file name, which is the stem plus what marks it as one of these. */
export const fileNameFor = (name, type) => `${stemFor(name, type)}${PRESET_SUFFIX}`;

/**
 * The file name an override of a base game asset is stored under.
 *
 * `shared` says that this name belongs to assets of more than one type, so the bare name
 * cannot stand for the one being patched -- only the caller knows, because it takes
 * knowing every type the game has a `<name>` of. When it does, the stem carries the type
 * exactly as an asset's own file name does.
 *
 * Only then. A type on every patch would rename files that have never been ambiguous, and
 * the copy already in an author's folder would be left beside the new one, still loaded
 * and still admitting whatever it admits.
 */
export const patchFileNameFor = (name, type, shared = false) =>
    `${shared ? stemFor(name, type) : name}${PATCH_SUFFIX}`;

/**
 * The asset a stem names, which is the stem with its type taken off.
 *
 * A stem that does not end in the type comes back exactly as it is -- an older file
 * named before this convention, or one written by another tool. Neither is wrong, and
 * both are still the file the manifest names.
 */
export function assetNameOf(stem, type) {
    if (!stem || !type) return stem ?? '';

    const ending = `.${type}`;
    return stem.endsWith(ending) ? stem.slice(0, -ending.length) : stem;
}

/**
 * The asset a file *path* names, whichever of the three forms the path takes:
 *
 *   Bar.AddressPreset.sodso.json   a preset the mod defines
 *   Bar.sodso_patch.json           an override, which carries no type
 *   AddressPreset/Bar.json         the base game asset, as this tool ships it
 *
 * The last of those is not a file in a mod at all, and is here because the editor opens
 * all three and titles them the same way. Its folder is the type, so the name is the
 * whole of the file: nothing is taken off a stem that does not end in the type.
 */
export function assetOfPath(path, type) {
    const file = String(path ?? '').split('/').pop();

    const suffix = [PATCH_SUFFIX, PRESET_SUFFIX, '.json'].find((end) => file.endsWith(end)) ?? '';
    const stem = suffix ? file.slice(0, -suffix.length) : file;

    return assetNameOf(stem, type);
}

/**
 * How a document is titled: what it is, then what it is called -- `AddressPreset/Bar`.
 *
 * The base game's assets read this way because that is how they are stored, one folder
 * per type, and it turned out to be what an author needs from a title: a name on its own
 * does not identify an asset, and a window called `Bar` says nothing about which of the
 * six `Bar`s is being edited. A mod's files carry the same two halves in the other order,
 * so they are titled the same rather than differently.
 *
 * A file with no type -- one that will not parse, an override of nothing -- is titled by
 * its name alone. There is no type to claim, and `undefined/Bar` would be a claim.
 */
export function titleFor(path, type) {
    const asset = assetOfPath(path, type);
    return type ? `${type}/${asset}` : asset;
}
