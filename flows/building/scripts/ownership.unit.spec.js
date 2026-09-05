/**
 * The gate in front of writing to a base game building, and the rename that makes a copy
 * a copy.
 *
 * Two decisions, and both of them used to be taken silently by the autosave: whether this
 * mod takes a building over at all, and whether a floor written for a copy lands on the
 * original's file. The first is the whole reason this module exists; the second is the one
 * that is easy to get wrong quietly, because a copy that shares its donor's blueprint names
 * looks right until the original building changes too.
 */
import { test, expect } from 'vitest';

import {
    BuildingForm, Ownership, needsAnswer, needsFloorRename, ownershipFor,
} from './ownership.js';


/* -------------------------------------------------------------------------- */
/* What the folder already answers                                             */
/* -------------------------------------------------------------------------- */

/**
 * The answer is not stored anywhere: it is what the files say. A mod that patches a
 * building has answered "override", and one that declares a building has answered "copy" --
 * or wrote a building of its own, which arrives at the same place from the other end.
 */
test('a building the mod declares is the mod’s own to write', () => {
    expect(ownershipFor(BuildingForm.OWN)).toBe(Ownership.MINE);
});

test('a building the mod patches is one it overrides', () => {
    expect(ownershipFor(BuildingForm.PATCH)).toBe(Ownership.OVERRIDE);
});

test('a building the mod has said nothing about is unasked', () => {
    expect(ownershipFor(BuildingForm.VANILLA)).toBe(Ownership.UNASKED);
});

test('a building whose form is unknown is unasked rather than assumed', () => {
    expect(ownershipFor(null)).toBe(Ownership.UNASKED);
    expect(ownershipFor(undefined)).toBe(Ownership.UNASKED);
});


/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

test('an edit to a base game building has to be answered for', () => {
    expect(needsAnswer({ building: 'Hotel', ownership: Ownership.UNASKED })).toBe(true);
});

test('an edit to a building already answered for goes straight through', () => {
    expect(needsAnswer({ building: 'Hotel', ownership: Ownership.OVERRIDE })).toBe(false);
    expect(needsAnswer({ building: 'HotelCopy', ownership: Ownership.MINE })).toBe(false);
});

/**
 * A floor no building refers to is outside all of this: there is nothing to copy and
 * nothing to patch, so there is no question to ask. It is written into the mod under its
 * own name, as it always was.
 */
test('a floor with no building behind it is not asked about', () => {
    expect(needsAnswer({ building: null, ownership: Ownership.UNASKED })).toBe(false);
    expect(needsAnswer({})).toBe(false);
    expect(needsAnswer()).toBe(false);
});


/* -------------------------------------------------------------------------- */
/* The rename that keeps a copy off its donor's floors                         */
/* -------------------------------------------------------------------------- */

const base = new Set(['Hotel_Ground', 'Hotel_Upper']);

const rename = (over) => needsFloorRename({
    ownership: Ownership.MINE,
    floorIsCustom: false,
    floorName: 'Hotel_Upper',
    baseBlueprints: base,
    ...over,
});

/**
 * The case the whole thing exists for. A blueprint is resolved by its bare name for every
 * building that names it, so saving `Hotel_Upper` while editing a copy of the Hotel would
 * override that floor in the real Hotel as well.
 */
test('a floor a copy inherited from its donor is renamed before it is written', () => {
    expect(rename()).toBe(true);
});

/**
 * An override *means* to shadow the game's floor by name. That is what the author chose,
 * and renaming would quietly do the opposite of it.
 */
test('a floor of a building the mod overrides keeps the game’s name', () => {
    expect(rename({ ownership: Ownership.OVERRIDE })).toBe(false);
});

test('nothing is renamed for a building nobody has answered for', () => {
    expect(rename({ ownership: Ownership.UNASKED })).toBe(false);
});

/**
 * Once. After the first save the floor is the mod's own, so the second save leaves the
 * name the first one gave it -- and an author who renames a floor by hand afterwards keeps
 * that name too.
 */
test('a floor already in the mod is left under the name it has', () => {
    expect(rename({ floorIsCustom: true })).toBe(false);
});

/**
 * A floor of the copy's own -- one added to it, or one already renamed -- is not the
 * donor's and has nothing to collide with.
 */
test('a floor the base game does not have is not renamed', () => {
    expect(rename({ floorName: 'HotelCopy_Floor1_v1' })).toBe(false);
});

test('a floor with no name at all is not renamed', () => {
    expect(rename({ floorName: '' })).toBe(false);
});

/**
 * Without the index there is no way to tell an inherited name from an author's own, and
 * renaming on a guess would rename floors that never needed it.
 */
test('nothing is renamed when the base game’s names are not known', () => {
    expect(rename({ baseBlueprints: null })).toBe(false);
    expect(needsFloorRename()).toBe(false);
});
