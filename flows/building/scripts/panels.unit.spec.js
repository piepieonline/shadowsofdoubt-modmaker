import { test, expect, beforeAll, afterAll } from 'vitest';
import { floorDescription, wallPresetName, tileDescription, toHex, fromHex } from './panels.js';

/**
 * What the panels say about a value, apart from how they draw it.
 *
 * Each of these is exported because the label over the canvas needs it too, and the
 * point of exporting them is that the two places a floor, a wall or a tile is described
 * cannot describe it differently. Rendering the panels themselves needs a document and
 * stays in tests/buildingPanels.spec.js.
 *
 * `floorDescription` and `wallPresetName` read their name lists off `window`, which is
 * where the flow registry installs reference data -- so `window` here is that data and
 * nothing else. There is no DOM in this file and none of these functions reaches for one.
 */

beforeAll(() => {
    globalThis.window = {
        floorTileTypes: ['none', 'floorAndCeiling', 'floorOnly'],
        wallPresets: [{ id: '0', name: 'Solid', kind: 'wall' }, { id: '16', name: 'Window', kind: 'window' }],
    };
});

afterAll(() => { delete globalThis.window; });

test('a floor type is named, and its extra height only when it has one', () => {
    expect(floorDescription(1, 0)).toBe('floorAndCeiling');
    expect(floorDescription(1, 3)).toBe('floorAndCeiling +3');
});

test('a floor type the table has no name for is shown as its number', () => {
    // A floor naming a type the reference data does not have still has to open.
    expect(floorDescription(9, 0)).toBe('Type 9');
});

test('a wall preset is named, and an unknown id keeps the id', () => {
    expect(wallPresetName('16')).toBe('Window');

    // Ids 28 to 30 exist in the game's table with no asset behind them. A floor
    // referring to one still reads and writes; it just cannot be picked from a list.
    expect(wallPresetName('28')).toBe('Unnamed preset 28');
});

test('a tile is described by what it carries, and by nothing when it carries none', () => {
    expect(tileDescription(null)).toBe('Nothing');
    expect(tileDescription({ isStairwell: false, isEntrance: false, isMainEntrance: false }))
        .toBe('Nothing');

    expect(tileDescription({ isStairwell: true, isInverted: false, stairwellRotation: 90 }))
        .toBe('Stairs 90°');
    expect(tileDescription({ isStairwell: true, isInverted: true, stairwellRotation: 0 }))
        .toBe('Elevator 0°');
});

test('a main entrance is said to be one rather than both', () => {
    // isMainEntrance implies isEntrance in the model, and saying both would read as
    // two things on one tile.
    expect(tileDescription({ isEntrance: true, isMainEntrance: true })).toBe('Main entrance');
    expect(tileDescription({ isEntrance: true, isMainEntrance: false })).toBe('Entrance');

    expect(tileDescription({
        isStairwell: true, isInverted: false, stairwellRotation: 180,
        isEntrance: true, isMainEntrance: true,
    })).toBe('Stairs 180° · Main entrance');
});

test('a colour survives a round trip through the picker, and keeps its alpha out of it', () => {
    expect(toHex({ r: 1, g: 0, b: 0.4, a: 1 })).toBe('#ff0066');

    // Three channels only, so assigning this over a stored colour leaves the alpha
    // alone -- a colour picker has no say in it, and the floor stores one.
    expect(fromHex('#ff0066')).toEqual({ r: 1, g: 0, b: 0.4 });

    // Out of range and absent channels both become a byte rather than NaN.
    expect(toHex({ r: 2, g: -1, b: undefined })).toBe('#ff0000');
    expect(toHex(null)).toBe('#000000');
});
