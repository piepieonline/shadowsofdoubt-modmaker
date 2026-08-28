import { test, expect } from 'vitest';
import * as library from './buildingLibrary.js';

/**
 * What a building preset says about its floors, and what is written back into one.
 *
 * A floor is only ever loaded through a building that names it, so reading a preset's
 * slots and pointing one at a blueprint is the whole of how the two are kept in step.
 * Neither needs a filesystem: a preset is JSON, and everything here takes one and
 * returns one. Listing, reading and writing a mod's folder go through directory handles
 * and stay in tests/buildingLibrary.spec.js.
 *
 * The base game's own 15 presets are fetched from refs/, exactly as the app fetches
 * them.
 */

/**
 * The mod building the Playwright suite seeds on disk, as a literal.
 *
 * A fresh copy per call, because setBlueprint edits the preset it is handed.
 */
const tallTower = () => ({
    name: 'TallTower',
    presetName: 'TallTower',
    type: 'BuildingPreset',
    fileType: 'BuildingPreset',
    copyFrom: null,
    floorLayouts: [
        { floorsWithThisSetting: 1, blueprints: ['TallTower_Ground'], controlRoomVariants: [] },
        { floorsWithThisSetting: 6, blueprints: ['TallTower_Upper', 'TallTower_Upper2'], controlRoomVariants: [] },
    ],
    basementLayouts: [],
});


/* -------------------------------------------------------------------------- */
/* Slots                                                                       */
/* -------------------------------------------------------------------------- */

test('every base game building enumerates its slots', async () => {
    const index = await library.loadFloorIndex();
    const summary = [];

    for (const name of index.buildings) {
        const preset = await library.loadVanillaPreset(name);
        const slots = library.enumerateSlots(preset);

        summary.push({
            name,
            slots: slots.length,
            // Every slot must name a blueprint and carry a complete coordinate.
            wellFormed: slots.every((option) => (
                typeof option.blueprint === 'string' && option.blueprint.length > 0
                && typeof option.label === 'string'
                && Number.isInteger(option.slot.layoutIndex)
                && Number.isInteger(option.slot.blueprintIndex)
                && typeof option.slot.isBasement === 'boolean'
                && typeof option.slot.isControlVariant === 'boolean'
            )),
        });
    }

    expect(summary).toHaveLength(15);

    for (const building of summary) {
        expect(building.wellFormed, `${building.name}`).toBe(true);
    }

    // Three of the fifteen have no floors at all, and that is the data rather than a
    // fault: the boundary buildings are the scenery at the edge of the city, marked
    // nonEnterable with a floorCount of 0. They are listed anyway, because a building
    // with no interior is still a building, but nothing can be opened in one.
    const withoutFloors = summary.filter((building) => building.slots === 0).map((b) => b.name);
    expect(withoutFloors).toEqual(['BoundaryCoastal01', 'BoundaryCoastal02', 'BoundaryCorner01']);

    for (const building of summary.filter((b) => !withoutFloors.includes(b.name))) {
        expect(building.slots, `${building.name} has no floors`).toBeGreaterThan(0);
    }
});

test('a slot list covers basements and control room variants', async () => {
    const preset = await library.loadVanillaPreset('Hotel');
    const slots = library.enumerateSlots(preset).map((option) => [option.label, option.blueprint]);

    // Hotel has one setting whose three blueprints the game picks between, and a
    // basement setting with two. Both have to be reachable, or a floor becomes
    // uneditable because nothing offers its slot.
    expect(slots).toContainEqual(['Floor 5 v0', 'Hotel_TopFloors']);
    expect(slots).toContainEqual(['Floor 5 v2', 'Hotel_TopFloors3']);
    expect(slots).toContainEqual(['Basement 0 v0', 'Hotel_Basement1']);
    expect(slots).toContainEqual(['Basement 0 v1', 'Hotel_Basement2']);
});

test('a control room variant is offered as its own slot', async () => {
    const preset = await library.loadVanillaPreset('CityHall');
    const slots = library.enumerateSlots(preset).map((option) => [option.label, option.blueprint]);

    expect(slots).toContainEqual(['Floor 0', 'CityHall_GroundFloor']);
    expect(slots).toContainEqual(['Floor 0 (control)', 'CityHall_GroundFloor_Control']);
});

test('a building with no floor list at all is not a failure', async () => {
    // The shipped dumps always write an empty list rather than omitting it, but a mod
    // preset is hand-written and a stub drops any list left at its default -- so a
    // missing floorLayouts is a shape the library has to survive, not a broken file.
    const result = {
        cityHallBasements: library.enumerateSlots(await library.loadVanillaPreset('CityHall'))
            .filter((option) => option.slot.isBasement).length,
        absent: library.enumerateSlots({ presetName: 'Bare' }),
        nulled: library.enumerateSlots({ floorLayouts: null, basementLayouts: null }),
        nothing: library.enumerateSlots(null),
    };

    expect(result.cityHallBasements).toBe(0);
    expect(result.absent).toEqual([]);
    expect(result.nulled).toEqual([]);
    expect(result.nothing).toEqual([]);
});


/* -------------------------------------------------------------------------- */
/* What a stub carries                                                         */
/* -------------------------------------------------------------------------- */

test('a field left at the game\'s default is not written', () => {
    const stub = library.stubFor('Thing', { floorLayouts: [], basementLayouts: [] });

    // enableAlleywayWalls defaults to true and echelonFloorStart to 10, so neither
    // belongs in the file; changing one puts it back.
    stub.enableAlleywayWalls = true;
    stub.echelonFloorStart = 10;
    stub.buildingHeight = 4;

    const kept = Object.keys(library.withoutDefaults(stub));

    // Under copyFrom, writing a default is not a no-op -- it overwrites the copied
    // building's value with nothing. So only what actually differs is written, plus
    // the five fields that identify the file.
    expect(kept.sort()).toEqual(
        ['buildingHeight', 'copyFrom', 'fileType', 'name', 'presetName', 'type'].sort());
});

test('the fields identifying a stub are written even at their defaults', () => {
    const stub = library.stubFor('Thing', null, { copyFrom: null });
    const written = library.withoutDefaults(stub);

    // presetName's default is the empty string and copyFrom's is absent from the game's
    // table entirely. Dropping either leaves the loader an asset it cannot place.
    expect(written.name).toBe('Thing');
    expect(written.presetName).toBe('Thing');
    expect(written.copyFrom).toBeNull();
    expect(written.fileType).toBe('BuildingPreset');
});


/* -------------------------------------------------------------------------- */
/* Changing a building's floors                                                */
/* -------------------------------------------------------------------------- */

test('pointing a slot at a floor replaces what was there', () => {
    const preset = tallTower();
    const resolved = library.setBlueprint(
        preset, { isBasement: false, isControlVariant: false, layoutIndex: 1, blueprintIndex: 1 },
        'TallTower_Replacement');

    const result = { resolved, blueprints: preset.floorLayouts[1].blueprints };

    expect(result.blueprints).toEqual(['TallTower_Upper', 'TallTower_Replacement']);
    expect(result.resolved.blueprintIndex).toBe(1);
});

test('a slot past the end of a list appends rather than leaving a hole', () => {
    const preset = tallTower();
    const resolved = library.setBlueprint(
        preset, { isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 9 },
        'TallTower_Second');

    const result = { resolved, blueprints: preset.floorLayouts[0].blueprints };

    expect(result.blueprints).toEqual(['TallTower_Ground', 'TallTower_Second']);
    expect(result.resolved.blueprintIndex).toBe(1);
});

test('a new floor setting is added when the slot names none', () => {
    const preset = tallTower();
    const resolved = library.setBlueprint(
        preset, { isBasement: true, isControlVariant: false, layoutIndex: -1, blueprintIndex: 0 },
        'TallTower_Basement');

    const result = { resolved, basements: preset.basementLayouts };

    expect(result.resolved).toEqual({
        isBasement: true, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0,
    });
    expect(result.basements).toHaveLength(1);
    expect(result.basements[0].blueprints).toEqual(['TallTower_Basement']);
    expect(result.basements[0].floorsWithThisSetting).toBe(1);
});

test('a control room variant is set without disturbing the ordinary blueprint', () => {
    const preset = tallTower();
    library.setBlueprint(
        preset, { isBasement: false, isControlVariant: true, layoutIndex: 0, blueprintIndex: 0 },
        'TallTower_Ground_Control');

    const layout = preset.floorLayouts[0];

    expect(layout.blueprints).toEqual(['TallTower_Ground']);
    expect(layout.controlRoomVariants).toEqual(['TallTower_Ground_Control']);
});


/* -------------------------------------------------------------------------- */
/* Storeys, and telling one slot from another                                  */
/* -------------------------------------------------------------------------- */

const slot = (isBasement, layoutIndex, blueprintIndex = 0, isControlVariant = false) =>
    ({ blueprint: 'X', label: 'X', slot: { isBasement, layoutIndex, blueprintIndex, isControlVariant } });

test('storeys are ordered as they sit in the building', () => {
    const storeys = library.storeysOf([
        slot(false, 1), slot(true, 0), slot(false, 0), slot(true, 1),
    ]);

    // Basement 0 is one below floor 0, and each basement after it is further down --
    // which is what up and down have to mean for the arrows that step through them.
    expect(storeys.map((storey) => storey.label)).toEqual([
        'Basement 1', 'Basement 0', 'Floor 0', 'Floor 1',
    ]);
});

test('the blueprints of one storey are gathered under it', () => {
    const storeys = library.storeysOf([
        slot(false, 0, 0), slot(false, 0, 1), slot(false, 0, 0, true),
    ]);

    // One storey the game picks a layout for at random, plus its control variant.
    expect(storeys).toHaveLength(1);
    expect(storeys[0].options).toHaveLength(3);
    expect(storeys[0].isBasement).toBe(false);
});

test('a building with no slots has no storeys', () => {
    expect(library.storeysOf([])).toEqual([]);
    expect(library.storeysOf(null)).toEqual([]);
});

test('two slots are the same place only when every part of them agrees', () => {
    const place = { isBasement: false, isControlVariant: false, layoutIndex: 1, blueprintIndex: 2 };

    expect(library.sameSlot(place, { ...place })).toBe(true);

    // Compared field by field rather than by the blueprint in them, because nothing
    // stops a building listing one blueprint in two slots.
    expect(library.sameSlot(place, { ...place, blueprintIndex: 3 })).toBe(false);
    expect(library.sameSlot(place, { ...place, layoutIndex: 0 })).toBe(false);
    expect(library.sameSlot(place, { ...place, isBasement: true })).toBe(false);
    expect(library.sameSlot(place, { ...place, isControlVariant: true })).toBe(false);

    // Nothing is not the same place as anything, including nothing.
    expect(library.sameSlot(null, place)).toBe(false);
    expect(library.sameSlot(place, null)).toBe(false);
    expect(library.sameSlot(null, null)).toBe(false);
});


/* -------------------------------------------------------------------------- */
/* How a preset points at a floor                                              */
/* -------------------------------------------------------------------------- */

/**
 * A floor the mod holds is named `FLOOR:Floors/<name>` -- the prefix, the path, then the
 * name -- and one the game ships is named plainly. A mod floor written the plain way is
 * one the game never reads, including a floor named after a base game one: the mod's copy
 * does not shadow the original by sharing its name.
 *
 * Reading normalises both forms to a name, so nothing above this file deals in anything
 * else. Writing puts the form back, which is `pointAtModFloors` and is covered against a
 * real folder in tests/buildingLibrary.spec.js.
 */
test('a floor reference is read as the floor it names', () => {
    expect(library.blueprintName('FLOOR:Floors/GrandHotel_Lobby')).toBe('GrandHotel_Lobby');
    expect(library.blueprintName('Tenement_MainFloor1')).toBe('Tenement_MainFloor1');
});

test('the path is taken off however deep it is', () => {
    expect(library.blueprintName('FLOOR:Some/Deeper/Path/Floor1')).toBe('Floor1');
    expect(library.blueprintName('FLOOR:Floor1')).toBe('Floor1');
});

test('an entry in some other shape is left as it is', () => {
    // A preset may have been written by another tool. A reference form nothing here knows
    // about is passed through, looked for under that name, and fails to open saying so --
    // rather than being normalised into a name nobody wrote.
    expect(library.blueprintName('SOMETHING:Else/Floor1')).toBe('SOMETHING:Else/Floor1');
    expect(library.blueprintName('')).toBe('');
    expect(library.blueprintName(null)).toBe('');
});

test('a slot is labelled and opened by the floor it names, not by how it is spelled', () => {
    const slots = library.enumerateSlots({
        floorLayouts: [{
            floorsWithThisSetting: 1,
            blueprints: ['FLOOR:Floors/MyTower_Ground'],
            controlRoomVariants: ['FLOOR:Floors/MyTower_Ground_Control'],
        }],
    });

    expect(slots.map((slot) => slot.blueprint))
        .toEqual(['MyTower_Ground', 'MyTower_Ground_Control']);
});

test('a floor put in a slot is stored as a name, and spelled out when written', () => {
    // setBlueprint stays in bare names: which floors the mod holds is not something a
    // slot knows, and it is not something that stays true either.
    const preset = tallTower();
    library.setBlueprint(
        preset, { isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0 },
        'TallTower_NewGround');

    expect(preset.floorLayouts[0].blueprints).toEqual(['TallTower_NewGround']);
});
