/**
 * What an override of a base game building may say, and what it refuses to say.
 *
 * Two properties matter more than any individual operation here, and both are about a file
 * that has to go on meaning the same thing after a game update:
 *
 * - the outer array never changes length, so every index in the patch still names the
 *   storey it named when it was written;
 * - the operations within one storey apply in an order that leaves each other's indices
 *   alone, which is what lets a save state several changes to one storey at once.
 *
 * The second is checked by applying the operations rather than by reading them, because
 * "these ops are in the right order" is only true of the document they land on.
 */
import { test, expect } from 'vitest';
import * as jsonpatch from 'fast-json-patch';

import { buildingOps, floorOps, generatedOps, isBuildingOp } from './buildingPatch.js';

/** A building as the base game ships it: settings, each holding the layouts of one storey. */
const building = (floors = [], basements = []) => ({
    presetName: 'Hotel',
    prefab: { m_FileID: 66256, m_PathID: 0 },
    floorLayouts: floors.map((blueprints) => ({
        floorsWithThisSetting: 1,
        blueprints: [...blueprints],
        controlRoomVariants: [],
    })),
    basementLayouts: basements.map((blueprints) => ({
        floorsWithThisSetting: 1,
        blueprints: [...blueprints],
        controlRoomVariants: [],
    })),
});

/** What the game ends up with once the mod's operations have been applied to its own copy. */
const applied = (base, ops) => {
    const document = structuredClone(base);
    for (const op of ops) jsonpatch.applyOperation(document, structuredClone(op), true);
    return document;
};

const floorsOf = (preset) => preset.floorLayouts.map((layout) => layout.blueprints);


/* -------------------------------------------------------------------------- */
/* What a patch says                                                           */
/* -------------------------------------------------------------------------- */

test('a floor taken over by the mod is a replace at its own slot', () => {
    const base = building([['Hotel_Ground'], ['Hotel_Upper']]);
    const working = building([['Hotel_Ground'], ['FLOOR:Floors/Hotel_Upper']]);

    expect(floorOps(base, working)).toEqual([
        { op: 'replace', path: '/floorLayouts/1/blueprints/0', value: 'FLOOR:Floors/Hotel_Upper' },
    ]);
});

test('a floor the mod has not touched says nothing at all', () => {
    const base = building([['Hotel_Ground'], ['Hotel_Upper']]);

    expect(floorOps(base, structuredClone(base))).toEqual([]);
});

test('basements are patched in their own list, as the game keeps them', () => {
    const base = building([['Hotel_Ground']], [['Hotel_Basement1']]);
    const working = building([['Hotel_Ground']], [['FLOOR:Floors/Hotel_Basement1']]);

    expect(floorOps(base, working)).toEqual([
        {
            op: 'replace',
            path: '/basementLayouts/0/blueprints/0',
            value: 'FLOOR:Floors/Hotel_Basement1',
        },
    ]);
});

test('a control room variant is a list of its own beside the ordinary layouts', () => {
    const base = building([['Hotel_Ground']]);
    base.floorLayouts[0].controlRoomVariants = ['Hotel_Ground_Control'];

    const working = structuredClone(base);
    working.floorLayouts[0].controlRoomVariants = ['FLOOR:Floors/Hotel_Ground_Control'];

    expect(floorOps(base, working)).toEqual([
        {
            op: 'replace',
            path: '/floorLayouts/0/controlRoomVariants/0',
            value: 'FLOOR:Floors/Hotel_Ground_Control',
        },
    ]);
});

/**
 * A layout is an alternative of a storey the building already has, which is the one thing
 * an override may add: it lengthens a list *inside* a storey and leaves the storey list
 * exactly as long as it was.
 */
test('a layout added to a storey appends, so it lands after whatever else is there', () => {
    const base = building([['Hotel_Ground'], ['Hotel_Upper']]);
    const working = building([['Hotel_Ground'], ['Hotel_Upper', 'FLOOR:Floors/Hotel_Upper_v1']]);

    const ops = floorOps(base, working);

    expect(ops).toEqual([
        { op: 'add', path: '/floorLayouts/1/blueprints/-', value: 'FLOOR:Floors/Hotel_Upper_v1' },
    ]);
    expect(floorsOf(applied(base, ops))).toEqual([
        ['Hotel_Ground'], ['Hotel_Upper', 'FLOOR:Floors/Hotel_Upper_v1'],
    ]);
});

test('a layout removed from a storey comes out, leaving the storey there', () => {
    const base = building([['Hotel_Ground'], ['Hotel_Upper', 'Hotel_Upper2']]);
    const working = building([['Hotel_Ground'], ['Hotel_Upper']]);

    const ops = floorOps(base, working);

    expect(ops).toEqual([{ op: 'remove', path: '/floorLayouts/1/blueprints/1' }]);
    expect(floorsOf(applied(base, ops))).toEqual([['Hotel_Ground'], ['Hotel_Upper']]);
});


/* -------------------------------------------------------------------------- */
/* The order the operations apply in                                           */
/* -------------------------------------------------------------------------- */

/**
 * Removals go from the back. Taken front first, removing index 1 would renumber index 2
 * to 1 and the next operation would take out the wrong layout -- which is the failure that
 * cannot be seen by reading the file, only by applying it.
 */
test('several layouts removed from one storey take out the ones they name', () => {
    const base = building([['a', 'b', 'c', 'd']]);
    const working = building([['a']]);

    const ops = floorOps(base, working);

    expect(ops.map((op) => op.path)).toEqual([
        '/floorLayouts/0/blueprints/3',
        '/floorLayouts/0/blueprints/2',
        '/floorLayouts/0/blueprints/1',
    ]);
    expect(floorsOf(applied(base, ops))).toEqual([['a']]);
});

test('a storey shortened and replaced at once ends up as the mod says', () => {
    const base = building([['a', 'b', 'c']]);
    const working = building([['FLOOR:Floors/x', 'b']]);

    expect(floorsOf(applied(base, floorOps(base, working)))).toEqual([['FLOOR:Floors/x', 'b']]);
});

test('a storey lengthened and replaced at once ends up as the mod says', () => {
    const base = building([['a']]);
    const working = building([['FLOOR:Floors/x', 'FLOOR:Floors/y', 'z']]);

    expect(floorsOf(applied(base, floorOps(base, working))))
        .toEqual([['FLOOR:Floors/x', 'FLOOR:Floors/y', 'z']]);
});

test('every storey of a building can be changed in one patch', () => {
    const base = building([['a'], ['b'], ['c']], [['d']]);
    const working = building(
        [['FLOOR:Floors/a'], ['b'], ['FLOOR:Floors/c']], [['FLOOR:Floors/d']]);

    const document = applied(base, floorOps(base, working));

    expect(floorsOf(document)).toEqual([['FLOOR:Floors/a'], ['b'], ['FLOOR:Floors/c']]);
    expect(document.basementLayouts[0].blueprints).toEqual(['FLOOR:Floors/d']);
});


/* -------------------------------------------------------------------------- */
/* What it refuses                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The storey list is the one thing that must not move. Every path in the file is a
 * position in it, this mod's and any the author added by hand, so a patch that inserted a
 * storey would silently redirect all of them.
 */
test('adding a storey is refused rather than written', () => {
    const base = building([['a']]);
    const working = building([['a'], ['b']]);

    expect(() => floorOps(base, working)).toThrow(/storey/i);
});

test('removing a storey is refused rather than written', () => {
    const base = building([['a'], ['b']]);
    const working = building([['a']]);

    expect(() => floorOps(base, working)).toThrow(/storey/i);
});

test('adding a basement is refused, as adding a floor is', () => {
    const base = building([['a']], []);
    const working = building([['a']], [['b']]);

    expect(() => floorOps(base, working)).toThrow(/storey/i);
});

/**
 * A preset the mod wrote drops lists that are still at their default, so a building with no
 * basements has no `basementLayouts` at all. A missing list and an empty one are the same
 * building, and reading one as a storey removed would refuse every save.
 */
test('a list that is absent and a list that is empty are the same building', () => {
    const base = building([['a']], []);
    const working = building([['a']], []);
    delete working.basementLayouts;

    expect(floorOps(base, working)).toEqual([]);
});


/* -------------------------------------------------------------------------- */
/* Fields the caller decided                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `add` rather than `replace`, because two of the fields a mesh writes are this editor's
 * own bookkeeping and are not on the game's object at all -- a `replace` at a path that is
 * not there is required to fail, and would take the whole patch down with it.
 */
test('a generated field is stated, not diffed against the dump', () => {
    const preset = {
        prefab: 'REF:Prefab|HotelCopy',
        sortedWindows: [],
        modMakerFloorHash: 'abc123',
    };

    expect(generatedOps(preset, ['prefab', 'sortedWindows', 'modMakerFloorHash'])).toEqual([
        { op: 'add', path: '/prefab', value: 'REF:Prefab|HotelCopy' },
        { op: 'add', path: '/sortedWindows', value: [] },
        { op: 'add', path: '/modMakerFloorHash', value: 'abc123' },
    ]);
});

test('a field the caller has no value for is not stated at all', () => {
    expect(generatedOps({ prefab: 'REF:Prefab|X' }, ['prefab', 'sortedWindows'])).toEqual([
        { op: 'add', path: '/prefab', value: 'REF:Prefab|X' },
    ]);
});

/**
 * A generated field applies to a dump whose `prefab` is a Unity reference. `add` on an
 * object member is an upsert, so the one operation is right whether the field is there or
 * not -- which is the reason it is `add` and not `replace`.
 */
test('a generated field lands on the dump whether the game has that field or not', () => {
    const base = building([['a']]);
    const ops = generatedOps({ prefab: 'REF:Prefab|X', modMakerBuildRoof: false },
        ['prefab', 'modMakerBuildRoof']);

    const document = applied(base, ops);

    expect(document.prefab).toBe('REF:Prefab|X');
    expect(document.modMakerBuildRoof).toBe(false);
});

test('an ordinary floor save states no generated fields', () => {
    const base = building([['a']]);
    const working = building([['FLOOR:Floors/a']]);

    expect(buildingOps(base, working)).toEqual([
        { op: 'replace', path: '/floorLayouts/0/blueprints/0', value: 'FLOOR:Floors/a' },
    ]);
});


/* -------------------------------------------------------------------------- */
/* Which operations are this flow's                                            */
/* -------------------------------------------------------------------------- */

/**
 * A patch is a file an author may have added to by hand, and another flow may write to it
 * as well. What a save replaces is what it says; everything else stays where it is.
 */
test('the floor lists are this flow’s and nothing else is', () => {
    expect(isBuildingOp({ path: '/floorLayouts/0/blueprints/0' })).toBe(true);
    expect(isBuildingOp({ path: '/basementLayouts/1/controlRoomVariants/-' })).toBe(true);

    expect(isBuildingOp({ path: '/buildingHeight' })).toBe(false);
    expect(isBuildingOp({ path: '/lobbyPreset' })).toBe(false);
    expect(isBuildingOp({})).toBe(false);
});
