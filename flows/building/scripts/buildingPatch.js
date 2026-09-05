/**
 * What a building's patch says, and the two rules that keep it sayable.
 *
 * An override is a `.sodso_patch.json` naming a base game building: the game places its own
 * building, and these operations put this mod's floors into the slots they name. The file
 * that used to be written instead was a whole preset carrying `copyFrom` and the game's own
 * name -- neither a copy nor a patch, winning or losing by load order, and unable to express
 * a floor being taken *out* of a building at all.
 *
 * ## Only the floor lists, and only by hand
 *
 * The operations here are constructed rather than diffed, and that is a correctness rule
 * rather than a preference. The app's copy of a base game building is a **dump** -- Unity
 * asset references as `{m_FileID, m_PathID}`, enums as integers, every field present at its
 * serialised value -- and it is not the shape the loader holds in memory. `diffToPatches`
 * over the whole of it would emit an operation for every one of those differences and call
 * the result a patch.
 *
 * `floorLayouts` and `basementLayouts` are the exception the whole flow rests on: they are
 * plain data in both shapes, which is why a slot list can be read off either. So they are
 * the only fields compared, and everything else a patch carries is written from a value the
 * caller computed -- see `generatedOps`.
 *
 * ## The outer array never changes length
 *
 * A storey is a *setting* -- "the next four floors look like this" -- and an element of
 * `floorLayouts`. Adding or removing one shifts every storey after it, which would leave
 * this patch's own later operations addressing the wrong floors, and would do the same to
 * any operation an author added by hand.
 *
 * A slot has no `name`, `presetName`, `id`, `itemTag` or `occupation` -- see
 * `IDENTIFYING_FIELDS` in core/patchFormat.js -- so there is no `[field=value]` selector to
 * be had and every path here is an index. That is survivable exactly as long as the indices
 * mean the same thing they did when they were written, so:
 *
 *   inside a storey  layouts may be replaced, appended and removed. The game picks between
 *                    the layouts of one storey, so this is the list a mod has business in.
 *   the storey list  never touched. Adding a floor to a base game building is not offered,
 *                    and this refuses rather than trusting that.
 *
 * What is left is a patch whose only way of going wrong is a game update that renumbers the
 * storeys -- which no mod can do anything about, and which is said plainly where the choice
 * is offered rather than discovered in play.
 */

/** The two lists a building's storeys live in, and the game keeps them apart. */
const LAYOUT_LISTS = ['floorLayouts', 'basementLayouts'];

/**
 * The two lists of blueprints inside one storey: the layouts the game picks between, and
 * the same layouts again with a control room in them.
 */
const SLOT_LISTS = ['blueprints', 'controlRoomVariants'];

const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * The operations that put `working`'s floors into `base`'s storeys.
 *
 * Both are presets as they would be written: blueprint entries already spelled the way the
 * file holds them, so a floor the mod has taken over reads `FLOOR:Floors/<name>` here and
 * differs from the bare name the game ships. That is the difference this exists to state.
 *
 * Within one storey the operations are ordered replace, then remove from the end backwards,
 * then append. Each is applied to the document the one before it left, so removing from the
 * back means no later index has moved by the time it is used, and appending last means `-`
 * lands after everything that survived.
 *
 * @throws when the two disagree about how many storeys the building has
 */
export function floorOps(base, working) {
    const ops = [];

    for (const listName of LAYOUT_LISTS) {
        const baseLayouts = listOf(base?.[listName]);
        const workingLayouts = listOf(working?.[listName]);

        // Not a diff that came out awkward: it is a change this cannot express, and one
        // that would silently misdirect every operation after it. See the header.
        if (baseLayouts.length !== workingLayouts.length) {
            throw new Error(
                `Adding or removing a storey is not something a patch over a base game `
                + `building can say (${listName}: the game has ${baseLayouts.length}, this `
                + `has ${workingLayouts.length}). Clone the building instead.`);
        }

        baseLayouts.forEach((baseLayout, layoutIndex) => {
            for (const slotList of SLOT_LISTS) {
                ops.push(...slotOps(
                    `/${listName}/${layoutIndex}/${slotList}`,
                    listOf(baseLayout?.[slotList]),
                    listOf(workingLayouts[layoutIndex]?.[slotList])));
            }
        });
    }

    return ops;
}

/** One storey's list of layouts, as the difference between two of them. */
function slotOps(path, base, working) {
    const ops = [];

    const shared = Math.min(base.length, working.length);

    for (let index = 0; index < shared; index++) {
        if (same(base[index], working[index])) continue;
        ops.push({ op: 'replace', path: `${path}/${index}`, value: working[index] });
    }

    // Backwards, so that each index still means what it meant when this was written: a
    // removal from the front renumbers everything behind it, and the next operation in
    // this list would then take out the wrong layout.
    for (let index = base.length - 1; index >= working.length; index--) {
        ops.push({ op: 'remove', path: `${path}/${index}` });
    }

    for (let index = base.length; index < working.length; index++) {
        ops.push({ op: 'add', path: `${path}/-`, value: working[index] });
    }

    return ops;
}

const same = (a, b) => String(a ?? '') === String(b ?? '');

/**
 * Fields the caller has decided, as operations that state them.
 *
 * `add` rather than `replace`, and for two reasons that both matter. Two of the fields a
 * generated mesh writes are not the game's at all -- the floor hash and the roof flag are
 * this editor's bookkeeping -- so there is nothing at their path to replace and `replace`
 * is required to fail. And on an object member `add` is an upsert in RFC 6902, so the one
 * operation is right whether the field is there or not.
 *
 * Never diffed against the dump, for the reason in the header: `prefab` in the base game's
 * copy is `{m_FileID: 66256}`, and a patch built by comparison would carry that difference
 * out into every mod that ever regenerated a mesh.
 */
export function generatedOps(preset, fields) {
    return fields
        .filter((field) => preset?.[field] !== undefined)
        .map((field) => ({ op: 'add', path: `/${field}`, value: preset[field] }));
}

/**
 * Everything a save writes into the patch: the floors, plus whatever the caller decided.
 *
 * `alsoWritten` is the mesh's, and empty for an ordinary floor save. It is stated by the
 * caller rather than found here because a generated field at the game's own default is
 * still a field this building has decided -- `sortedWindows: []` on a building with no
 * windows is an answer, and leaving it out would leave the game's own window data in place.
 */
export function buildingOps(base, working, { alsoWritten = [] } = {}) {
    return [...floorOps(base, working), ...generatedOps(working, alsoWritten)];
}

/**
 * Whether an operation is one of these -- for taking this flow's own back out of a patch a
 * mod may hold other things in.
 *
 * By path rather than by value: the question is which operations describe this building's
 * floors, not which ones this app happened to write last time.
 */
export function isBuildingOp(op) {
    const path = op?.path ?? '';
    return LAYOUT_LISTS.some((listName) => path.startsWith(`/${listName}/`));
}
