import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, gotoFlow, readFile } from './support/harness.js';

/**
 * Buildings and their floor slots.
 *
 * A floor is only ever loaded through a building that names it, so the two are edited
 * together: opening a floor means finding the building that refers to it, and saving one
 * means writing that building back. The base game's 15 buildings are read-only, and
 * saving against one produces a stub in the mod instead.
 */

const json = (value) => JSON.stringify(value, null, 2);

/**
 * A mod with a building of its own and a floor to go in it, plus a preset that is not a
 * building -- so listing has something to reject.
 */
const buildingMod = {
    'Plugins/TallTower/TallTower.sodso.json': json({
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
    }),
    'Plugins/TallTower/Floors/TallTower_Ground.json': json({ floorName: 'TallTower_Ground', a_d: [], t_d: [] }),

    // A floor of the mod's named after a base game one. Editing a base game floor
    // produces exactly this, and it must shadow the original.
    'Plugins/TallTower/Floors/Hotel_GroundFloor.json': json({ floorName: 'Hotel_GroundFloor', a_d: [], t_d: [] }),

    // Not a building, and must not be listed as one.
    'Plugins/TallTower/SomeWeapon.sodso.json': json({ name: 'SomeWeapon', fileType: 'MurderWeaponPreset' }),

    // Not valid JSON at all. One bad file must not take the folder down with it.
    'Plugins/TallTower/Broken.sodso.json': '{ this is not json',
};

/** Run a body against the library, with the mod's content folder already resolved. */
async function withLibrary(page, body, arg) {
    return page.evaluate(async ({ source, arg: passed }) => {
        const library = await import('/flows/building/scripts/buildingLibrary.js');
        const plugins = await window.__opfsDir('Plugins', false);
        const contentFolder = await plugins.getDirectoryHandle('TallTower');

        // eslint-disable-next-line no-new-func
        return new Function('library', 'contentFolder', 'arg',
            `return (${source})(library, contentFolder, arg)`)(library, contentFolder, passed);
    }, { source: body.toString(), arg });
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, buildingMod);
});


/* -------------------------------------------------------------------------- */
/* Slots                                                                       */
/* -------------------------------------------------------------------------- */

test('every base game building enumerates its slots', async ({ page }) => {
    const summary = await withLibrary(page, async (library) => {
        const index = await library.loadFloorIndex();
        const buildings = [];

        for (const name of index.buildings) {
            const preset = await library.loadVanillaPreset(name);
            const slots = library.enumerateSlots(preset);

            buildings.push({
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

        return buildings;
    });

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

test('a slot list covers basements and control room variants', async ({ page }) => {
    const slots = await withLibrary(page, async (library) => {
        const preset = await library.loadVanillaPreset('Hotel');
        return library.enumerateSlots(preset).map((option) => [option.label, option.blueprint]);
    });

    // Hotel has one setting whose three blueprints the game picks between, and a
    // basement setting with two. Both have to be reachable, or a floor becomes
    // uneditable because nothing offers its slot.
    expect(slots).toContainEqual(['Floor 5 v0', 'Hotel_TopFloors']);
    expect(slots).toContainEqual(['Floor 5 v2', 'Hotel_TopFloors3']);
    expect(slots).toContainEqual(['Basement 0 v0', 'Hotel_Basement1']);
    expect(slots).toContainEqual(['Basement 0 v1', 'Hotel_Basement2']);
});

test('a control room variant is offered as its own slot', async ({ page }) => {
    const slots = await withLibrary(page, async (library) => {
        const preset = await library.loadVanillaPreset('CityHall');
        return library.enumerateSlots(preset).map((option) => [option.label, option.blueprint]);
    });

    expect(slots).toContainEqual(['Floor 0', 'CityHall_GroundFloor']);
    expect(slots).toContainEqual(['Floor 0 (control)', 'CityHall_GroundFloor_Control']);
});

test('a building with no floor list at all is not a failure', async ({ page }) => {
    // The shipped dumps always write an empty list rather than omitting it, but a mod
    // preset is hand-written and a stub drops any list left at its default -- so a
    // missing floorLayouts is a shape the library has to survive, not a broken file.
    const result = await withLibrary(page, async (library) => ({
        cityHallBasements: library.enumerateSlots(await library.loadVanillaPreset('CityHall'))
            .filter((option) => option.slot.isBasement).length,
        absent: library.enumerateSlots({ presetName: 'Bare' }),
        nulled: library.enumerateSlots({ floorLayouts: null, basementLayouts: null }),
        nothing: library.enumerateSlots(null),
    }));

    expect(result.cityHallBasements).toBe(0);
    expect(result.absent).toEqual([]);
    expect(result.nulled).toEqual([]);
    expect(result.nothing).toEqual([]);
});


/* -------------------------------------------------------------------------- */
/* Listing                                                                     */
/* -------------------------------------------------------------------------- */

test('a mod building is listed, and other presets in the folder are not', async ({ page }) => {
    const names = await withLibrary(page, async (library, contentFolder) => (
        (await library.listCustomBuildings(contentFolder)).map((entry) => entry.name)
    ));

    // SomeWeapon is a preset but not a building; Broken.sodso.json will not parse.
    expect(names).toEqual(['TallTower']);
});

test('the mod\'s buildings come before the base game\'s, and shadow them by name', async ({ page }) => {
    const listed = await withLibrary(page, async (library, contentFolder) => {
        const all = await library.listBuildings(contentFolder);
        return {
            first: all[0],
            count: all.length,
            hotelEntries: all.filter((entry) => entry.name === 'Hotel').length,
        };
    });

    expect(listed.first.name).toBe('TallTower');
    expect(listed.first.isCustom).toBe(true);

    // 15 base game buildings plus the mod's one.
    expect(listed.count).toBe(16);
    expect(listed.hotelEntries).toBe(1);
});


/* -------------------------------------------------------------------------- */
/* Resolving a blueprint                                                       */
/* -------------------------------------------------------------------------- */

test('a floor the mod holds is read in preference to the base game\'s', async ({ page }) => {
    const resolved = await withLibrary(page, async (library, contentFolder) => ({
        shadowed: await library.resolveBlueprint(contentFolder, 'Hotel_GroundFloor'),
        vanillaOnly: (await library.resolveBlueprint(contentFolder, 'Hotel_FirstFloor')).isCustom,
        modOnly: (await library.resolveBlueprint(contentFolder, 'TallTower_Ground')).isCustom,
        missing: await library.resolveBlueprint(contentFolder, 'NoSuchFloor'),
    }));

    // This is what makes editing a base game floor work: the mod's copy keeps the name
    // the building already refers to, so the building needs no change at all.
    expect(resolved.shadowed.isCustom).toBe(true);
    expect(resolved.shadowed.data.a_d).toEqual([]);

    expect(resolved.vanillaOnly).toBe(false);
    expect(resolved.modOnly).toBe(true);
    expect(resolved.missing).toBeNull();
});


/* -------------------------------------------------------------------------- */
/* Stubs                                                                       */
/* -------------------------------------------------------------------------- */

test('saving against a base game building produces a stub that copies from it', async ({ page }) => {
    const result = await withLibrary(page, async (library, contentFolder) => {
        const { preset, created } = await library.presetForSaving(contentFolder, 'Hotel');
        await library.writeCustomPreset(contentFolder, 'Hotel', preset);
        return { created, preset };
    });

    expect(result.created).toBe(true);

    const written = JSON.parse(await readFile(page, 'Plugins/TallTower/Hotel.sodso.json'));

    expect(written.name).toBe('Hotel');
    expect(written.presetName).toBe('Hotel');
    expect(written.fileType).toBe('BuildingPreset');
    expect(written.copyFrom).toBe('REF:BuildingPreset|Hotel');

    // The floors transfer; nothing else from the base game's dump does.
    expect(written.floorLayouts).toHaveLength(8);
    expect(written.prefab).toBeUndefined();
    expect(written.sortedWindows).toBeUndefined();
    expect(written.exteriorKey).toBeUndefined();
});

test('a stub written from a base game building enumerates the same slots', async ({ page }) => {
    const compared = await withLibrary(page, async (library, contentFolder) => {
        const source = await library.loadVanillaPreset('Hotel');
        const before = library.enumerateSlots(source);

        const { preset } = await library.presetForSaving(contentFolder, 'Hotel');
        await library.writeCustomPreset(contentFolder, 'Hotel', preset);

        // Read back off disk rather than reusing the object, so the round trip through
        // default elision is what is being checked.
        const reread = await library.readCustomPreset(contentFolder, 'Hotel');
        const after = library.enumerateSlots(reread);

        return { before, after };
    });

    expect(compared.after).toEqual(compared.before);
    expect(compared.after.length).toBeGreaterThan(0);
});

test('a field left at the game\'s default is not written', async ({ page }) => {
    const kept = await withLibrary(page, async (library) => {
        const stub = library.stubFor('Thing', { floorLayouts: [], basementLayouts: [] });

        // enableAlleywayWalls defaults to true and echelonFloorStart to 10, so neither
        // belongs in the file; changing one puts it back.
        stub.enableAlleywayWalls = true;
        stub.echelonFloorStart = 10;
        stub.buildingHeight = 4;

        return Object.keys(library.withoutDefaults(stub));
    });

    // Under copyFrom, writing a default is not a no-op -- it overwrites the copied
    // building's value with nothing. So only what actually differs is written, plus
    // the five fields that identify the file.
    expect(kept.sort()).toEqual(
        ['buildingHeight', 'copyFrom', 'fileType', 'name', 'presetName', 'type'].sort());
});

test('the fields identifying a stub are written even at their defaults', async ({ page }) => {
    const written = await withLibrary(page, async (library) => {
        const stub = library.stubFor('Thing', null, { copyFrom: null });
        return library.withoutDefaults(stub);
    });

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

test('pointing a slot at a floor replaces what was there', async ({ page }) => {
    const result = await withLibrary(page, async (library, contentFolder) => {
        const preset = await library.readCustomPreset(contentFolder, 'TallTower');
        const resolved = library.setBlueprint(
            preset, { isBasement: false, isControlVariant: false, layoutIndex: 1, blueprintIndex: 1 },
            'TallTower_Replacement');

        return { resolved, blueprints: preset.floorLayouts[1].blueprints };
    });

    expect(result.blueprints).toEqual(['TallTower_Upper', 'TallTower_Replacement']);
    expect(result.resolved.blueprintIndex).toBe(1);
});

test('a slot past the end of a list appends rather than leaving a hole', async ({ page }) => {
    const result = await withLibrary(page, async (library, contentFolder) => {
        const preset = await library.readCustomPreset(contentFolder, 'TallTower');
        const resolved = library.setBlueprint(
            preset, { isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 9 },
            'TallTower_Second');

        return { resolved, blueprints: preset.floorLayouts[0].blueprints };
    });

    expect(result.blueprints).toEqual(['TallTower_Ground', 'TallTower_Second']);
    expect(result.resolved.blueprintIndex).toBe(1);
});

test('a new floor setting is added when the slot names none', async ({ page }) => {
    const result = await withLibrary(page, async (library, contentFolder) => {
        const preset = await library.readCustomPreset(contentFolder, 'TallTower');
        const resolved = library.setBlueprint(
            preset, { isBasement: true, isControlVariant: false, layoutIndex: -1, blueprintIndex: 0 },
            'TallTower_Basement');

        return { resolved, basements: preset.basementLayouts };
    });

    expect(result.resolved).toEqual({
        isBasement: true, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0,
    });
    expect(result.basements).toHaveLength(1);
    expect(result.basements[0].blueprints).toEqual(['TallTower_Basement']);
    expect(result.basements[0].floorsWithThisSetting).toBe(1);
});

test('a control room variant is set without disturbing the ordinary blueprint', async ({ page }) => {
    const layout = await withLibrary(page, async (library, contentFolder) => {
        const preset = await library.readCustomPreset(contentFolder, 'TallTower');
        library.setBlueprint(
            preset, { isBasement: false, isControlVariant: true, layoutIndex: 0, blueprintIndex: 0 },
            'TallTower_Ground_Control');

        return preset.floorLayouts[0];
    });

    expect(layout.blueprints).toEqual(['TallTower_Ground']);
    expect(layout.controlRoomVariants).toEqual(['TallTower_Ground_Control']);
});


/* -------------------------------------------------------------------------- */
/* Creating and saving                                                         */
/* -------------------------------------------------------------------------- */

test('a new building of its own gets a preset and a Floors folder', async ({ page }) => {
    await withLibrary(page, async (library, contentFolder) => (
        library.createCustomBuilding(contentFolder, 'BrandNew')
    ));

    const written = JSON.parse(await readFile(page, 'Plugins/TallTower/BrandNew.sodso.json'));
    expect(written.name).toBe('BrandNew');
    expect(written.copyFrom).toBeNull();

    // The folder is what marks the mod as holding buildings, so it exists from the
    // start rather than appearing with the first floor.
    const listed = await withLibrary(page, async (library, contentFolder) => (
        library.listCustomBlueprints(contentFolder)
    ));
    expect(listed).toContain('TallTower_Ground');
});

test('a new building copied from a base game one takes its floors and its name', async ({ page }) => {
    const preset = await withLibrary(page, async (library, contentFolder) => (
        (await library.createCustomBuilding(contentFolder, 'MyHotel', { copyFrom: 'Hotel' })).preset
    ));

    expect(preset.copyFrom).toBe('REF:BuildingPreset|Hotel');
    expect(preset.name).toBe('MyHotel');
    expect(preset.floorLayouts).toHaveLength(8);
});

test('a floor saved into the mod is readable back through the building', async ({ page }) => {
    const round = await withLibrary(page, async (library, contentFolder) => {
        await library.writeCustomBlueprint(
            contentFolder, 'TallTower_Upper', { floorName: 'TallTower_Upper', a_d: [], t_d: [] });

        const resolved = await library.resolveBlueprint(contentFolder, 'TallTower_Upper');
        return { isCustom: resolved.isCustom, name: resolved.data.floorName };
    });

    expect(round).toEqual({ isCustom: true, name: 'TallTower_Upper' });
});

test('a base game preset is never written to when a floor is saved against it', async ({ page }) => {
    const result = await withLibrary(page, async (library, contentFolder) => {
        const { preset, created } = await library.presetForSaving(contentFolder, 'Hotel');

        const slot = library.setBlueprint(
            preset, { isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0 },
            'Hotel_GroundFloor');

        await library.writeCustomPreset(contentFolder, 'Hotel', preset);
        await library.writeCustomBlueprint(
            contentFolder, 'Hotel_GroundFloor', { floorName: 'Hotel_GroundFloor', a_d: [], t_d: [] });

        // Saving a second time finds the stub rather than making another.
        const second = await library.presetForSaving(contentFolder, 'Hotel');

        return { created, slot, secondCreated: second.created };
    });

    expect(result.created).toBe(true);
    expect(result.secondCreated).toBe(false);
    expect(result.slot.layoutIndex).toBe(0);

    // The shipped copy is a fetched URL, not a file handle -- there is nothing to write
    // to. What ends up in the mod is the stub and the floor.
    const stub = JSON.parse(await readFile(page, 'Plugins/TallTower/Hotel.sodso.json'));
    expect(stub.copyFrom).toBe('REF:BuildingPreset|Hotel');
    expect(stub.floorLayouts[0].blueprints).toEqual(['Hotel_GroundFloor']);
});
