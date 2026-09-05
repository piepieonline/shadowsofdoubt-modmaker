/**
 * Whether this mod may write over a base game building, and which way it does it.
 *
 * A floor is never edited on its own: it is edited *in* a building, and the game only
 * loads one through a building that names it. So the first edit to a floor of a base game
 * building is a decision about that building -- and it used to be taken silently, 600ms
 * after a click that may have been a `+` on an address panel. The mod gained a building it
 * never asked for, under the game's own name, and the author found out from the file panel.
 *
 * Three answers, and the author gives them:
 *
 *   override  patch the game's building. The mod holds a `.sodso_patch.json` naming it,
 *             and the game's own building is what the city places -- with this mod's
 *             floors in the slots the patch names.
 *   clone     a building of the mod's own, copying the game's through `copyFrom`. The
 *             original is untouched and the clone is placed *beside* it -- a preset
 *             carries its own `allowedInDistricts`, `desiredRatio` and the rest, so a
 *             copy competes with its donor for the same city slots.
 *   nothing   the edit is thrown away and the floor is read again from disk.
 *
 * ## Why there is no fourth state
 *
 * Answering "nothing" leaves the building `UNASKED`, which is where it started. There is
 * no read-only mode to enter and none to explain: the caller puts painting away, which is
 * what opening any floor already does, and a discarded floor is then indistinguishable
 * from one that was just opened. Picking a tool up again and drawing is a deliberate act,
 * and it asks again.
 *
 * The alternative -- a sticky read-only state with a button to change the answer -- is a
 * state, a heading and a control, all to save an author who is only looking from a
 * question they can dismiss with one click.
 *
 * ## What this module is not
 *
 * A floor opened with no building at all -- one no building refers to -- is outside all of
 * this. There is nothing to clone and nothing to patch, so there is no question to ask;
 * the floor is written into the mod under its own name, as it always was. Reaching one of
 * those with a base game blueprint takes a hand-edited URL, since the panel lists a floor
 * under the building that names it.
 */

/**
 * What the mod holds for a building, which is what the answer above is recorded as.
 *
 * Read off the folder rather than remembered: `own` and `patch` are files, and a building
 * that is neither is one the mod has said nothing about yet.
 */
export const BuildingForm = {
    /** The mod declares this building: a whole preset file it wrote. */
    OWN: 'own',
    /** The mod patches the game's building of this name. */
    PATCH: 'patch',
    /** The game's, and this mod has not touched it. */
    VANILLA: 'vanilla',
};

/**
 * What the next write to a building does.
 *
 * `MINE` and `OVERRIDE` are the two ways a building can be written; `UNASKED` is the state
 * in which nothing may be written at all.
 */
export const Ownership = {
    /** Nothing has been decided, and nothing may be written until it is. */
    UNASKED: 'unasked',
    /** The mod's own building, written whole. A clone is one of these. */
    MINE: 'mine',
    /** The game's building, written as a patch over it. */
    OVERRIDE: 'override',
};

/**
 * What a building's ownership is, given what the mod already holds for it.
 *
 * The decision is not stored anywhere: a folder holding a patch has been answered
 * "override" and a folder declaring the building has been answered "clone" -- or holds a
 * building of the mod's own, which is the same answer arrived at from the other end. So a
 * session that comes back to a building it took over last week asks nothing, and a folder
 * edited by hand between sessions is read as it now stands rather than as it was left.
 */
export function ownershipFor(form) {
    if (form === BuildingForm.OWN) return Ownership.MINE;
    if (form === BuildingForm.PATCH) return Ownership.OVERRIDE;

    return Ownership.UNASKED;
}

/**
 * Whether an edit has to be answered for before anything reaches disk.
 *
 * The one gate. A floor with no building behind it answers false: see the note at the top
 * about what this module is not.
 */
export function needsAnswer({ building = null, ownership = Ownership.UNASKED } = {}) {
    return !!building && ownership === Ownership.UNASKED;
}

/**
 * Whether the floor being saved has to be renamed first, and what makes that the case.
 *
 * This is the other half of cloning, and without it a clone is not a copy of a building
 * but a second name for it. A blueprint is resolved by its bare name for *every* building
 * that refers to it -- see resolveBlueprint -- so a clone of the Hotel that kept
 * `Hotel_FirstFloor` in its floor list would, on the first save, write `Hotel_FirstFloor`
 * into the mod's Floors folder and override that floor in the real Hotel as well. The
 * clone would have changed the building it was made to leave alone.
 *
 * So a floor inherited from the donor is renamed the first time it is edited, and only
 * that one slot is repointed. The floors that are never touched keep the donor's names and
 * cost the mod no files at all, which is the whole reason the blueprints are not copied
 * when the clone is made.
 *
 * Three things have to hold, and each of them rules out a case that is not this one:
 *
 *   the building is the mod's own    an override *means* to shadow the game's floor by
 *                                    name. That is what the author chose.
 *   the floor came from the base     a floor already in the mod is one the author has been
 *   game                             editing, under whatever name they gave it.
 *   the name is the base game's      an author who deliberately typed a base game name
 *                                    into the floor's own name field is not doing this,
 *                                    and having it renamed back under them would be.
 *
 * The second is what stops this firing twice: after the first save the floor is the mod's,
 * so a second save renames nothing.
 *
 * @param baseBlueprints the names the base game ships, from the floor index
 */
export function needsFloorRename({
    ownership = Ownership.UNASKED,
    floorIsCustom = false,
    floorName = '',
    baseBlueprints = null,
} = {}) {
    if (ownership !== Ownership.MINE) return false;
    if (floorIsCustom) return false;

    return !!floorName && !!baseBlueprints?.has?.(floorName);
}
