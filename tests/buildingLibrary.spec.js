import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, gotoFlow, readFile } from './support/harness.js';

/**
 * Buildings and their floor slots.
 *
 * A floor is only ever loaded through a building that names it, so the two are edited
 * together: opening a floor means finding the building that refers to it, and saving one
 * means writing that building back. The base game's 15 buildings are read-only, and
 * saving against one produces a stub in the mod instead.
 *
 * What is here is everything that reaches the mod's folder through a directory handle.
 * Reading a preset's slots and pointing one at a blueprint take JSON and return JSON,
 * and are covered beside the module in flows/building/scripts/buildingLibrary.unit.spec.js.
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

test('a building\'s readable title is not what identifies it', async ({ page }) => {
    const preset = await withLibrary(page, async (library, contentFolder) => (
        (await library.createCustomBuilding(
            contentFolder, 'MyHotel', { title: 'My Lovely Hotel' })).preset
    ));

    // The preset name is the file, the REF and the strings key, so it is the one that
    // has to stay identifier-safe. The title is text, and only the CSV row uses it.
    expect(preset.presetName).toBe('MyHotel');
    expect(preset.name).toBe('My Lovely Hotel');

    expect(await readFile(page, 'Plugins/TallTower/MyHotel.sodso.json')).not.toBeNull();
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

    // Pointed at the mod's copy, which is what the floor in the fixture is. See the
    // FLOOR: tests at the bottom of this file.
    expect(stub.floorLayouts[0].blueprints).toEqual(['FLOOR:Floors/Hotel_GroundFloor']);
});


/* -------------------------------------------------------------------------- */
/* The manifest                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A preset the manifest does not name is a preset the loader never reads, so writing one
 * means listing it. What that entry looks like and where it goes is covered beside the
 * module in core/murderManifest.unit.spec.js; what is here is the file appearing in the
 * mod, through each path that puts a building there.
 */

const MANIFEST = 'Plugins/TallTower/murdermanifest.sodso.json';

const manifestIn = async (page) => JSON.parse(await readFile(page, MANIFEST));

test('a new building is named in a manifest written for the mod that had none', async ({ page }) => {
    await withLibrary(page, async (library, contentFolder) => (
        library.createCustomBuilding(contentFolder, 'BrandNew')
    ));

    expect(await manifestIn(page))
        .toEqual({ enabled: true, fileOrder: ['REF:BrandNew'], loadBefore: '', version: 1 });
});

test('a building joins the load order a mod already has, and is named once', async ({ page }) => {
    await seedFs(page, {
        ...buildingMod,
        [MANIFEST]: json({
            enabled: true,
            fileOrder: ['REF:SomeWeapon', 'REF:TallTower'],
            loadBefore: 'SomeOtherMod',
            version: 1,
        }),
    });

    await withLibrary(page, async (library, contentFolder) => {
        await library.createCustomBuilding(contentFolder, 'BrandNew');

        // Saving a floor against it writes the preset again, which must not name it a
        // second time -- every autosave comes through here.
        const { preset } = await library.presetForSaving(contentFolder, 'BrandNew');
        await library.writeCustomPreset(contentFolder, 'BrandNew', preset);
    });

    const manifest = await manifestIn(page);

    // Last, and the entries the author already had are where they were.
    expect(manifest.fileOrder).toEqual(['REF:SomeWeapon', 'REF:TallTower', 'REF:BrandNew']);
    expect(manifest.loadBefore).toBe('SomeOtherMod');
});

test('the stub written for a base game building is named too', async ({ page }) => {
    await withLibrary(page, async (library, contentFolder) => {
        const { preset } = await library.presetForSaving(contentFolder, 'Hotel');
        await library.writeCustomPreset(contentFolder, 'Hotel', preset);
    });

    // The stub is a file in the mod like any other: unlisted, it is a floor edited into
    // a building the game goes on building the base game's way.
    expect((await manifestIn(page)).fileOrder).toEqual(['REF:Hotel']);
});

test('a building already named in lowercase is not named again', async ({ page }) => {
    await seedFs(page, {
        ...buildingMod,
        [MANIFEST]: json({ enabled: true, fileOrder: ['REF:talltower'], loadBefore: '', version: 1 }),
    });

    await withLibrary(page, async (library, contentFolder) => {
        const { preset } = await library.presetForSaving(contentFolder, 'TallTower');
        await library.writeCustomPreset(contentFolder, 'TallTower', preset);
    });

    // Left exactly as its author wrote it, rather than gaining a second entry for the
    // same file.
    expect((await manifestIn(page)).fileOrder).toEqual(['REF:talltower']);
});

test('a manifest that will not parse is left alone, and the building is still written', async ({ page }) => {
    await seedFs(page, { ...buildingMod, [MANIFEST]: '{ this is not json' });

    await withLibrary(page, async (library, contentFolder) => (
        library.createCustomBuilding(contentFolder, 'BrandNew')
    ));

    // The text is the author's and may be one comma away from working. Overwriting it
    // would throw away the rest of the mod's load order to add one line.
    expect(await readFile(page, MANIFEST)).toBe('{ this is not json');

    // The building is the thing that was asked for, and it is on disk to be listed by
    // hand.
    expect(await readFile(page, 'Plugins/TallTower/BrandNew.sodso.json')).not.toBeNull();
});


/* -------------------------------------------------------------------------- */
/* How a written preset points at its floors                                   */
/* -------------------------------------------------------------------------- */

/**
 * A floor the mod holds is written as `FLOOR:Floors/<name>` -- the prefix, the path, then
 * the name. One the game ships stays a bare name so the game resolves its own copy.
 *
 * Which of the two an entry is cannot be settled where a slot is filled in: the answer
 * depends on what is in the mod's Floors folder at the moment the preset is written, and
 * that changes as floors are added and deleted. So it is settled here, for every slot
 * rather than the one being edited.
 *
 * Reading normalises both forms back to a name, and is covered beside the module.
 */
const presetIn = async (page, name) =>
    JSON.parse(await readFile(page, `Plugins/TallTower/${name}.sodso.json`));

test('a floor the mod holds is written as a reference to the mod\'s copy', async ({ page }) => {
    await withLibrary(page, async (library, contentFolder) => {
        const { preset } = await library.presetForSaving(contentFolder, 'TallTower');
        await library.writeCustomPreset(contentFolder, 'TallTower', preset);
    });

    // TallTower_Ground is in the mod's Floors folder; the two upper layouts are not.
    const written = await presetIn(page, 'TallTower');
    expect(written.floorLayouts[0].blueprints).toEqual(['FLOOR:Floors/TallTower_Ground']);
    expect(written.floorLayouts[1].blueprints).toEqual(['TallTower_Upper', 'TallTower_Upper2']);
});

test('a floor named after a base game one points at the mod\'s copy', async ({ page }) => {
    // The whole of editing a base game floor. The mod's copy does not shadow the original
    // by sharing its name -- the building has to point at it.
    await withLibrary(page, async (library, contentFolder) => {
        const { preset } = await library.presetForSaving(contentFolder, 'Hotel');
        library.setBlueprint(
            preset,
            { isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0 },
            'Hotel_GroundFloor');
        await library.writeCustomPreset(contentFolder, 'Hotel', preset);
    });

    const written = await presetIn(page, 'Hotel');
    expect(written.floorLayouts[0].blueprints[0]).toBe('FLOOR:Floors/Hotel_GroundFloor');

    // Every other slot of the stub is still the base game's to resolve.
    const rest = written.floorLayouts.slice(1).flatMap((layout) => layout.blueprints ?? []);
    expect(rest.every((entry) => !entry.startsWith('FLOOR:'))).toBe(true);
});

test('control room variants are pointed at the same way', async ({ page }) => {
    await seedFs(page, {
        ...buildingMod,
        'Plugins/TallTower/Floors/TallTower_Ground_Control.json':
            json({ floorName: 'TallTower_Ground_Control', a_d: [], t_d: [] }),
    });

    await withLibrary(page, async (library, contentFolder) => {
        const { preset } = await library.presetForSaving(contentFolder, 'TallTower');
        library.setBlueprint(
            preset,
            { isBasement: false, isControlVariant: true, layoutIndex: 0, blueprintIndex: 0 },
            'TallTower_Ground_Control');
        await library.writeCustomPreset(contentFolder, 'TallTower', preset);
    });

    expect((await presetIn(page, 'TallTower')).floorLayouts[0].controlRoomVariants)
        .toEqual(['FLOOR:Floors/TallTower_Ground_Control']);
});

test('writing twice does not point at a reference to a reference', async ({ page }) => {
    await withLibrary(page, async (library, contentFolder) => {
        for (let n = 0; n < 3; n++) {
            const { preset } = await library.presetForSaving(contentFolder, 'TallTower');
            await library.writeCustomPreset(contentFolder, 'TallTower', preset);
        }
    });

    expect((await presetIn(page, 'TallTower')).floorLayouts[0].blueprints)
        .toEqual(['FLOOR:Floors/TallTower_Ground']);
});

test('a floor deleted from the mod uncovers the base game\'s again', async ({ page }) => {
    await withLibrary(page, async (library, contentFolder) => {
        const { preset } = await library.presetForSaving(contentFolder, 'Hotel');
        library.setBlueprint(
            preset,
            { isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0 },
            'Hotel_GroundFloor');
        await library.writeCustomPreset(contentFolder, 'Hotel', preset);

        // Stop overriding it, which is what deleting a floor named after a base game one
        // means. The building must stop pointing at a file that is no longer there.
        await library.deleteCustomBlueprint(contentFolder, 'Hotel_GroundFloor');

        const reread = await library.readCustomPreset(contentFolder, 'Hotel');
        await library.writeCustomPreset(contentFolder, 'Hotel', reread);
    });

    expect((await presetIn(page, 'Hotel')).floorLayouts[0].blueprints[0]).toBe('Hotel_GroundFloor');
});

test('the slots read back are the floors, whichever way they are written', async ({ page }) => {
    const slots = await withLibrary(page, async (library, contentFolder) => {
        const { preset } = await library.presetForSaving(contentFolder, 'TallTower');
        await library.writeCustomPreset(contentFolder, 'TallTower', preset);

        const reread = await library.readCustomPreset(contentFolder, 'TallTower');
        return library.enumerateSlots(reread).map((slot) => slot.blueprint);
    });

    expect(slots).toEqual(['TallTower_Ground', 'TallTower_Upper', 'TallTower_Upper2']);
});
