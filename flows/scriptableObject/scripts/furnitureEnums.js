/**
 * The two enums a piece of furniture is written in, and the reader and writer for them.
 *
 * The building flow has `furnitureRules.js` for exactly this reason and this is its
 * counterpart: the game serialises these fields as integers, so the order *is* the
 * meaning, and an index read against the wrong table produces a file that is well-formed
 * and wrong.
 *
 * Transcribed from `enums.json` at the root of the ScriptableObject dump, keyed on
 * `fullName` and in declaration order. **Not** from `refs/generated/soEnums.json**, for the
 * reason `furnitureRules.js` sets out at length: that file keys on bare enum names, and
 * where the game declares one name on two types only one survives. Both of these happen to
 * be correct there today, which is not a property anything checks or preserves.
 *
 * `buildFurnitureChain.js` carries the same two tables, and the duplication is deliberate:
 * that one runs in node against a dump and resolves the reference data once, this one runs
 * in the browser against a mod's own files. Neither can import the other -- the tool is a
 * script with top-level `await` and `node:fs` imports -- and a table of 32 strings behind a
 * shared module would be more indirection than it removes. What keeps them honest is that
 * both cite the same source, and the unit suites pin both.
 *
 * ## Which way round a value is written
 *
 * Read: a full asset from the dump holds the integer, and the derived reference data holds
 * the name -- so a reader has to take either. Write: **the integer**, which is what every
 * shipped asset holds and what the bank example mod's hand-authored files hold. A .NET JSON
 * reader would take the name as well, but a file that is spelled differently from every
 * other file of its type is a file whose next reader has to wonder why.
 */

/**
 * `FurniturePreset.SubObjectOwnership` (FurniturePreset.cs:327).
 *
 * Written as a rule past the first two rather than a list of 32: every member from index 2
 * is `person` and its offset, and a table would be thirty lines saying so.
 */
export const ownerOf = (value) => {
    if (typeof value === 'string') return value;
    if (value === 0 || value == null) return 'nobody';
    if (value === 1) return 'everybody';
    return value >= 2 && value <= 31 ? `person${value - 2}` : value;
};

/** The way back, for writing. Anything unrecognised is `nobody`, which places no ownership. */
export const ownerIndex = (name) => {
    if (typeof name === 'number') return name;
    if (name === 'everybody') return 1;

    const person = /^person(\d+)$/.exec(name ?? '');
    if (!person) return 0;

    const index = Number(person[1]);
    return index >= 0 && index <= 29 ? index + 2 : 0;
};

/**
 * `InteractableController.InteractableID` (InteractableController.cs:2027).
 *
 * The order is not alphabetical and is not a mistake: `hidingPlace` and `none` were added
 * at 10 and 11, so `K` onwards resumes at 12. `HOW-IT-WORKS.md` prints the ids for four
 * shipped presets, which is the one place this can be checked against prose.
 */
export const INTERACTABLE_ID = [
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'hidingPlace', 'none',
    'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    'AA', 'BB', 'CC', 'DD',
];

/** Where `none` sits, which is not the enum's zero -- see the note on the order above. */
export const NO_CONTROLLER = INTERACTABLE_ID.indexOf('none');

/** A controller id as a name, from either spelling. */
export const controllerOf = (value) =>
    (typeof value === 'string' ? value : INTERACTABLE_ID[value] ?? value ?? 'none');

/**
 * The way back, for writing.
 *
 * Anything unrecognised is `none`, and `none` is 11 rather than 0 -- which is the whole
 * reason this is a lookup rather than the two-line function `ownerIndex` is. Falling back
 * to zero here would write `A`: a real controller, in most prefabs the *first* one, so an
 * id this could not read would come out paired to whatever happens to be on the model.
 * `none` is the game's own way of saying "skip this entry", which is the honest answer to a
 * name nothing recognises.
 */
export const controllerIndex = (name) => {
    if (typeof name === 'number') return name;

    const index = INTERACTABLE_ID.indexOf(name);
    return index >= 0 ? index : NO_CONTROLLER;
};
