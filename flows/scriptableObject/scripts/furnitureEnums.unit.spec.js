/**
 * The two index-addressed enums the furniture pane reads and writes.
 *
 * The game serialises these as integers, so the order *is* the meaning and a table one
 * member out of step produces files that are entirely well-formed and wrong. There is no
 * way to notice that downstream, which is why it is checked here and at the source --
 * `buildFurnitureChain.unit.spec.js` pins the same two for the reference data.
 */
import { describe, test, expect } from 'vitest';

import {
    ownerOf, ownerIndex, controllerOf, controllerIndex, INTERACTABLE_ID, NO_CONTROLLER,
} from './furnitureEnums.js';


describe('who a sub-object belongs to', () => {
    test('reads the first two members by name', () => {
        expect(ownerOf(0)).toBe('nobody');
        expect(ownerOf(1)).toBe('everybody');
    });

    /** Index 2 is `person0`, not `person2`, which is the off-by-two worth pinning. */
    test('reads the rest as a person index counted from two', () => {
        expect(ownerOf(2)).toBe('person0');
        expect(ownerOf(3)).toBe('person1');
        expect(ownerOf(31)).toBe('person29');
    });

    test('leaves a name that is already a name alone', () => {
        expect(ownerOf('person0')).toBe('person0');
    });

    test('treats a missing value as nobody, which owns nothing', () => {
        expect(ownerOf(undefined)).toBe('nobody');
        expect(ownerOf(null)).toBe('nobody');
    });

    /**
     * Written as the integer, because every shipped asset and every hand-authored file in
     * the bank example mod holds one.
     */
    test('writes back the index it was read from', () => {
        for (const index of [0, 1, 2, 3, 31]) expect(ownerIndex(ownerOf(index))).toBe(index);
    });

    test('writes an unrecognised owner as nobody rather than as an unknown index', () => {
        expect(ownerIndex('person30')).toBe(0);
        expect(ownerIndex('somebody')).toBe(0);
        expect(ownerIndex(undefined)).toBe(0);
    });

    test('leaves an index alone where it is handed one', () => {
        expect(ownerIndex(7)).toBe(7);
    });
});


/**
 * `HOW-IT-WORKS.md` prints these ids for four shipped presets, which is the one place the
 * table can be checked against prose rather than against itself.
 */
describe('which controller an interactable is paired to', () => {
    test('reads the letters, and the two that interrupt them', () => {
        expect(controllerOf(0)).toBe('A');
        expect(controllerOf(1)).toBe('B');
        expect(controllerOf(10)).toBe('hidingPlace');
        expect(controllerOf(11)).toBe('none');
    });

    /** `K` resumes at 12 because `hidingPlace` and `none` were added at 10 and 11. */
    test('resumes the letters after the two that interrupt them', () => {
        expect(controllerOf(12)).toBe('K');
        expect(INTERACTABLE_ID).toHaveLength(32);
    });

    test('leaves a name alone, and reads nothing as none', () => {
        expect(controllerOf('hidingPlace')).toBe('hidingPlace');
        expect(controllerOf(undefined)).toBe('none');
    });

    /**
     * Every member, not a handful. The whole risk in this table is a member out of step, and
     * a round trip over all 32 is the only check that catches one in the middle.
     */
    test('writes back the index every name was read from', () => {
        INTERACTABLE_ID.forEach((name, index) => {
            expect(controllerIndex(controllerOf(index))).toBe(index);
            expect(controllerIndex(name)).toBe(index);
        });
    });

    /**
     * `none` rather than zero, which is the one place this differs from `ownerIndex` and the
     * reason it is a lookup. Zero here is `A` -- a real controller, and in most prefabs the
     * first one -- so an unreadable id would come out paired to whatever the model happens
     * to have rather than to nothing.
     */
    test('writes an unrecognised controller as none rather than as the enum’s zero', () => {
        expect(NO_CONTROLLER).toBe(11);
        expect(controllerIndex('Handle')).toBe(NO_CONTROLLER);
        expect(controllerIndex(undefined)).toBe(NO_CONTROLLER);
        expect(controllerIndex(null)).toBe(NO_CONTROLLER);
    });

    test('leaves an index alone where it is handed one', () => {
        expect(controllerIndex(3)).toBe(3);
    });
});
