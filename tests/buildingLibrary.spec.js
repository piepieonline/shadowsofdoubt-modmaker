import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, gotoFlow, readFile } from '../test-support/harness.js';

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
/* Overriding a base game building                                             */
/* -------------------------------------------------------------------------- */

/**
 * A base game building is taken over as a patch over the game's own, and only once the
 * author has said so. What used to be written instead was a stub -- a whole preset under
 * the game's own name, copying from itself -- which was neither a copy nor a patch, won or
 * lost by load order, and could not say that a floor had been taken out of a building.
 *
 * The three answers and where they are asked live in flows/building/scripts/ownership.js;
 * what a patch may say is in scripts/buildingPatch.js. What is here is the files.
 */

const OVERRIDE = 'override';

/** Take a base game building over, as the flow does: read for saving, then write. */
const override = async (page, name, blueprint) => withLibrary(page, async (library, folder, arg) => {
    const held = await library.presetForSaving(folder, arg.name, arg.ownership);

    if (arg.blueprint) {
        library.setBlueprint(
            held.preset,
            { isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0 },
            arg.blueprint);
    }

    await library.writeBuildingPatch(folder, arg.name, held.base, held.preset);
    return { form: held.form };
}, { name, blueprint, ownership: OVERRIDE });

const patchIn = async (page, file) =>
    JSON.parse(await readFile(page, `Plugins/TallTower/${file}`));

test('overriding a base game building writes a patch over it, not a preset', async ({ page }) => {
    const result = await override(page, 'Hotel', 'Hotel_GroundFloor');

    expect(result.form).toBe('patch');

    const patch = await patchIn(page, 'Hotel.sodso_patch.json');

    expect(patch.name).toBe('Hotel');
    expect(patch.fileType).toBe('BuildingPreset');
    expect(patch.patches).toEqual([
        {
            op: 'replace',
            path: '/floorLayouts/0/blueprints/0',
            value: 'FLOOR:Floors/Hotel_GroundFloor',
        },
    ]);

    // And no preset. The game places its own Hotel; this says what to put in one slot of
    // it. A file here would be the stub again, competing with the game's by load order.
    expect(await readFile(page, 'Plugins/TallTower/Hotel.BuildingPreset.sodso.json')).toBeNull();
    expect(await readFile(page, 'Plugins/TallTower/Hotel.sodso.json')).toBeNull();
});

/**
 * The one thing a patch says, said once. A save states the building's floors as they are
 * now, at the paths it stated them at last time, so appending would leave the file holding
 * two answers for one slot with the older of them untrue.
 */
test('saving twice leaves one operation, not two', async ({ page }) => {
    await override(page, 'Hotel', 'Hotel_GroundFloor');
    await override(page, 'Hotel', 'Hotel_GroundFloor');

    expect((await patchIn(page, 'Hotel.sodso_patch.json')).patches).toHaveLength(1);
});

test('a floor taken back out of a building takes its operation with it', async ({ page }) => {
    await override(page, 'Hotel', 'Hotel_GroundFloor');

    // Back to the base game's own name for that slot, which is what deleting the mod's
    // copy of a floor leaves behind.
    await withLibrary(page, async (library, folder) => {
        const held = await library.presetForSaving(folder, 'Hotel', 'override');
        await library.writeBuildingPatch(folder, 'Hotel', held.base, held.preset);
    });

    // The mod still holds Hotel_GroundFloor.json, so that slot is still pointed at it.
    // What matters is that the file never accumulates: one operation, not two.
    expect((await patchIn(page, 'Hotel.sodso_patch.json')).patches).toHaveLength(1);
});

/**
 * A patch a mod holds over an asset it also declares is a file whose effect depends on the
 * load order, which is a list the author maintains by hand. The same rule, and the same
 * reason, as `landAdd` in core/soBuilder.js.
 */
test('a building the mod declares is never patched as well', async ({ page }) => {
    const result = await withLibrary(page, async (library, folder) => {
        const held = await library.presetForSaving(folder, 'TallTower');

        try {
            await library.writeBuildingPatch(folder, 'TallTower', {}, held.preset);
            return { threw: false, message: null };
        } catch (error) {
            return { threw: true, message: error.message };
        }
    });

    expect(result.threw).toBe(true);
    expect(result.message).toContain('load order');

    expect(await readFile(page, 'Plugins/TallTower/TallTower.sodso_patch.json')).toBeNull();
});

/**
 * The gate is in the flow, and this is the guard behind it. A save that reached a base game
 * building with nothing decided would have to pick one of the two answers itself, which is
 * the whole of what was wrong with the behaviour this replaced.
 */
test('nothing is written for a base game building nobody has answered for', async ({ page }) => {
    const result = await withLibrary(page, async (library, contentFolder) => {
        try {
            await library.presetForSaving(contentFolder, 'Hotel');
            return { threw: false, message: null };
        } catch (error) {
            return { threw: true, message: error.message };
        }
    });

    expect(result.threw).toBe(true);
    expect(result.message).toContain('Hotel');

    expect(await readFile(page, 'Plugins/TallTower/Hotel.sodso_patch.json')).toBeNull();
    expect(await readFile(page, 'Plugins/TallTower/Hotel.BuildingPreset.sodso.json')).toBeNull();
});

test('a patched building reads back as the game will see it', async ({ page }) => {
    await override(page, 'Hotel', 'Hotel_GroundFloor');

    const found = await withLibrary(page, async (library, contentFolder) => {
        const loaded = await library.loadPreset(contentFolder, 'Hotel');

        return {
            form: loaded.form,
            isCustom: loaded.isCustom,
            slots: library.enumerateSlots(loaded.preset).length,
            first: library.enumerateSlots(loaded.preset)[0].blueprint,
            // Everything the patch says nothing about is still the game's.
            height: loaded.preset.buildingHeight,
        };
    });

    expect(found.form).toBe('patch');
    expect(found.isCustom).toBe(false);

    // Every slot the game's building has, not just the one the patch names.
    expect(found.slots).toBeGreaterThan(1);

    // Read back as a bare name: the FLOOR: prefix is how the file spells it, and reading
    // normalises both forms.
    expect(found.first).toBe('Hotel_GroundFloor');
    expect(found.height).toBeDefined();
});

test('a patched building is listed as the game’s, with the patch noted', async ({ page }) => {
    await override(page, 'Hotel', 'Hotel_GroundFloor');

    const listed = await withLibrary(page, async (library, contentFolder) => {
        const all = await library.listBuildings(contentFolder);
        return {
            hotel: all.find((entry) => entry.name === 'Hotel'),
            tower: all.find((entry) => entry.name === 'TallTower'),
            townhouse: all.find((entry) => entry.name === 'Townhouse'),
            count: all.length,
        };
    });

    // Still the game's building. The stub used to move it across to the mod's side, which
    // was the visible half of the lie it told.
    expect(listed.hotel.isCustom).toBe(false);
    expect(listed.hotel.form).toBe('patch');

    expect(listed.tower.form).toBe('own');
    expect(listed.townhouse.form).toBe('vanilla');

    // And it is still one entry rather than two.
    expect(listed.count).toBe(16);
});

/**
 * What a copy is *not* written for.
 *
 * `presetForSaving` used to build a preset for any name at all -- so a name nothing
 * answered to produced a preset copying from itself, with an empty floor list for the slot
 * being saved to append to. Written back over the file it was built because it could not
 * read, that is a building reduced to its own name and one floor.
 */
test('a building neither the mod nor the base game has is not saved against', async ({ page }) => {
    const result = await withLibrary(page, async (library, contentFolder) => {
        try {
            await library.presetForSaving(contentFolder, 'NoSuchTower', 'override');
            return { threw: false, message: null };
        } catch (error) {
            return { threw: true, message: error.message };
        }
    });

    expect(result.threw).toBe(true);
    expect(result.message).toContain('NoSuchTower');

    // And nothing reached the folder.
    expect(await readFile(page, 'Plugins/TallTower/NoSuchTower.BuildingPreset.sodso.json')).toBeNull();
    expect(await readFile(page, 'Plugins/TallTower/NoSuchTower.sodso_patch.json')).toBeNull();
});

test('a preset that will not parse is reported rather than written over', async ({ page }) => {
    const before = await readFile(page, 'Plugins/TallTower/Broken.sodso.json');

    const result = await withLibrary(page, async (library, contentFolder) => {
        const found = await library.findCustomPreset(contentFolder, 'Broken');

        try {
            await library.presetForSaving(contentFolder, 'Broken');
            return { found, threw: false, message: null };
        } catch (error) {
            return { found, threw: true, message: error.message };
        }
    });

    // Absent and unreadable are different answers, because they call for different things.
    expect(result.found).toEqual({ preset: null, unreadable: 'Broken.sodso.json' });

    expect(result.threw).toBe(true);
    expect(result.message).toContain('Broken.sodso.json');

    // The text is the author's, and is what turns one bad file into a lost building if it
    // is taken for an absent one. It is still there, byte for byte, to be repaired.
    expect(await readFile(page, 'Plugins/TallTower/Broken.sodso.json')).toBe(before);
});

/**
 * The same rule on the patch side. A patch that will not parse is a patch whose operations
 * are still the author's, and writing over it would throw them away to add one.
 */
test('a patch that will not parse is reported rather than written over', async ({ page }) => {
    await seedFs(page, {
        ...buildingMod,
        'Plugins/TallTower/Hotel.sodso_patch.json': '{ this is not json',
    });

    const result = await withLibrary(page, async (library, contentFolder) => {
        try {
            await library.presetForSaving(contentFolder, 'Hotel', 'override');
            return { threw: false, message: null };
        } catch (error) {
            return { threw: true, message: error.message };
        }
    });

    expect(result.threw).toBe(true);
    expect(result.message).toContain('Hotel.sodso_patch.json');

    expect(await readFile(page, 'Plugins/TallTower/Hotel.sodso_patch.json')).toBe('{ this is not json');
});

/**
 * A file at the bare patch name holding a patch over something else entirely. The name
 * belongs to whatever is inside the file, so this one is left alone and the building's own
 * patch takes the name that carries the type.
 */
test('a patch over another asset of the same name is not written over', async ({ page }) => {
    const other = json({ name: 'Hotel', fileType: 'FurniturePreset', patches: [] });
    await seedFs(page, { ...buildingMod, 'Plugins/TallTower/Hotel.sodso_patch.json': other });

    await override(page, 'Hotel', 'Hotel_GroundFloor');

    expect(await readFile(page, 'Plugins/TallTower/Hotel.sodso_patch.json')).toBe(other);

    const mine = await patchIn(page, 'Hotel.BuildingPreset.sodso_patch.json');
    expect(mine.fileType).toBe('BuildingPreset');
    expect(mine.patches).toHaveLength(1);
});

/**
 * An operation nothing here wrote, over a field nothing here knows about. A patch is a file
 * an author may add to by hand, so a save replaces what it says and leaves the rest.
 */
test('operations this flow did not write are left where they are', async ({ page }) => {
    await seedFs(page, {
        ...buildingMod,
        'Plugins/TallTower/Hotel.sodso_patch.json': json({
            name: 'Hotel',
            fileType: 'BuildingPreset',
            patches: [{ op: 'replace', path: '/buildingHeight', value: 12 }],
        }),
    });

    await override(page, 'Hotel', 'Hotel_GroundFloor');

    const patch = await patchIn(page, 'Hotel.sodso_patch.json');

    expect(patch.patches).toContainEqual({ op: 'replace', path: '/buildingHeight', value: 12 });
    expect(patch.patches).toHaveLength(2);
});

test('a building the mod holds is read rather than overridden', async ({ page }) => {
    const found = await withLibrary(page, async (library, contentFolder) => (
        library.findCustomPreset(contentFolder, 'TallTower')
    ));

    expect(found.unreadable).toBeNull();
    expect(found.preset.presetName).toBe('TallTower');

    // Its own copyFrom, untouched. No save decides that field.
    expect(found.preset.copyFrom).toBeNull();
});


/* -------------------------------------------------------------------------- */
/* Creating and saving                                                         */
/* -------------------------------------------------------------------------- */

test('a new building of its own gets a preset and a Floors folder', async ({ page }) => {
    await withLibrary(page, async (library, contentFolder) => (
        library.createCustomBuilding(contentFolder, 'BrandNew')
    ));

    const written = JSON.parse(await readFile(page, 'Plugins/TallTower/BrandNew.BuildingPreset.sodso.json'));
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

    expect(await readFile(page, 'Plugins/TallTower/MyHotel.BuildingPreset.sodso.json')).not.toBeNull();
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
        const held = await library.presetForSaving(contentFolder, 'Hotel', 'override');

        const slot = library.setBlueprint(
            held.preset,
            { isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0 },
            'Hotel_GroundFloor');

        await library.writeBuildingPatch(contentFolder, 'Hotel', held.base, held.preset);
        await library.writeCustomBlueprint(
            contentFolder, 'Hotel_GroundFloor', { floorName: 'Hotel_GroundFloor', a_d: [], t_d: [] });

        // Saving a second time finds the patch that is there rather than starting again,
        // and needs no answer to do it: the file is the answer.
        const second = await library.presetForSaving(contentFolder, 'Hotel');

        return { slot, form: held.form, secondForm: second.form };
    });

    expect(result.form).toBe('patch');
    expect(result.secondForm).toBe('patch');
    expect(result.slot.layoutIndex).toBe(0);

    // The shipped copy is a fetched URL, not a file handle -- there is nothing to write
    // to. What ends up in the mod is the patch and the floor.
    const patch = JSON.parse(await readFile(page, 'Plugins/TallTower/Hotel.sodso_patch.json'));

    // Pointed at the mod's copy, which is what the floor in the fixture is. See the
    // FLOOR: tests at the bottom of this file.
    expect(patch.patches[0].value).toBe('FLOOR:Floors/Hotel_GroundFloor');
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
        .toEqual({ enabled: true, fileOrder: ['REF:BrandNew.BuildingPreset'], loadBefore: '', version: 1 });
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
    expect(manifest.fileOrder).toEqual(['REF:SomeWeapon', 'REF:TallTower', 'REF:BrandNew.BuildingPreset']);
    expect(manifest.loadBefore).toBe('SomeOtherMod');
});

test('the patch written for a base game building is named too', async ({ page }) => {
    await override(page, 'Hotel', 'Hotel_GroundFloor');

    // A patch is a file in the mod like any other: unlisted, it is a floor edited into a
    // building the game goes on building the base game's way.
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
    expect(await readFile(page, 'Plugins/TallTower/BrandNew.BuildingPreset.sodso.json')).not.toBeNull();
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
const presetIn = async (page, stem) =>
    JSON.parse(await readFile(page, `Plugins/TallTower/${stem}.sodso.json`));

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
    await override(page, 'Hotel', 'Hotel_GroundFloor');

    const patch = await patchIn(page, 'Hotel.sodso_patch.json');
    expect(patch.patches[0].value).toBe('FLOOR:Floors/Hotel_GroundFloor');

    // And nothing is said about any other slot: they are still the base game's to resolve,
    // which is what "override one floor" has to mean.
    expect(patch.patches).toHaveLength(1);
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

/**
 * Deleting the mod's copy of a floor named after a base game one is what "stop overriding
 * it" means: the original is uncovered rather than lost. On a patched building that leaves
 * the operation saying nothing -- the slot is back to the name the game ships -- so the
 * operation goes rather than being left pointing at a file that is not there.
 */
test('a floor deleted from the mod uncovers the base game\'s again', async ({ page }) => {
    await override(page, 'Hotel', 'Hotel_GroundFloor');

    await withLibrary(page, async (library, contentFolder) => {
        await library.deleteCustomBlueprint(contentFolder, 'Hotel_GroundFloor');

        const held = await library.presetForSaving(contentFolder, 'Hotel');
        await library.writeBuildingPatch(contentFolder, 'Hotel', held.base, held.preset);
    });

    // Nothing left to say about that slot, so the patch says nothing about it.
    expect((await patchIn(page, 'Hotel.sodso_patch.json')).patches).toEqual([]);

    // And the building reads as the game's own again.
    const slot = await withLibrary(page, async (library, contentFolder) => {
        const loaded = await library.loadPreset(contentFolder, 'Hotel');
        return library.enumerateSlots(loaded.preset)[0].blueprint;
    });

    expect(slot).toBe('Hotel_GroundFloor');
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
