import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, gotoFlow, connectFolders, selectContent,
    readFile, listDir,
} from '../test-support/harness.js';

/**
 * Generating a building's model, wired into the flow.
 *
 * The arithmetic is tested on its own, against the base game's own window data, in
 * flows/building/scripts/meshExport.unit.spec.js -- that is where the assertions about
 * what a block is and where a wall goes live. What this covers is the part that needs a
 * page and a file system: pressing the button writes seven files and a preset that points
 * at them, and editing a floor afterwards makes the flow say the model has gone out of
 * date.
 */

const json = (value) => JSON.stringify(value, null, 2);

/**
 * A floor of the mod's own, which is what makes the folder building content at all.
 *
 * `core/modFolders.js` marks a folder as holding buildings by its Floors directory, and
 * the harness seeds files rather than empty directories -- so the folder needs one floor
 * in it before the shell will offer it. This one is in no building's slot list, so it
 * takes no part in anything generated below.
 */
const spareFloor = JSON.stringify({
    floorName: 'MyTower_Spare',
    size: { x: 1, y: 1 },
    defaultFloorHeight: 0,
    defaultCeilingHeight: 42,
    a_d: [{
        p_n: 'Outside',
        e_c: { r: 1, g: 0, b: 0.4, a: 1 },
        vs: [{
            r_d: [{
                id: 1,
                l: 'Null',
                n_d: [{ f_c: { x: 5, y: 5 }, f_h: 0, f_t: 0, f_r: '', w_d: [] }],
            }],
        }],
    }],
    t_d: [],
});

/**
 * A mod building whose floors are the base game's.
 *
 * Which is the ordinary case for a building being given a model of its own: it has been
 * assembled out of existing floors and now needs something for the city to draw. Three
 * storeys, so that trimming the ground floor still leaves a body to build.
 */
const modWithBuilding = {
    // The manifest naming the preset is what makes the shell offer this folder at all.
    // See core/modFolders.js.
    'Plugins/MyTower/murdermanifest.sodso.json': json({
        enabled: true, fileOrder: ['REF:MyTower'], loadBefore: '', version: 1,
    }),

    'Plugins/MyTower/MyTower.sodso.json': json({
        name: 'MyTower',
        presetName: 'MyTower',
        type: 'BuildingPreset',
        fileType: 'BuildingPreset',
        copyFrom: null,
        floorLayouts: [
            { floorsWithThisSetting: 1, blueprints: ['Tenement_GroundFloor1'], controlRoomVariants: [] },
            { floorsWithThisSetting: 2, blueprints: ['Tenement_MainFloor1'], controlRoomVariants: [] },
        ],
    }),
    'Plugins/MyTower/Floors/MyTower_Spare.json': spareFloor,
};

const UPPER_SLOT = { isBasement: false, isControlVariant: false, layoutIndex: 1, blueprintIndex: 0 };

async function openBuildingFlow(page, files = modWithBuilding) {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=building');
    await seedFs(page, files);
    await connectFolders(page, { modDir: 'Plugins' });
    await selectContent(page, 'MyTower', '');
}

const open = (page, building, blueprint, slot) => page.evaluate(async (request) => {
    const { openFloor } = await import('/flows/building/scripts/ui.js');
    await openFloor(request);
}, { building, blueprint, slot });

const generateButton = (page) => page.locator('#building-floor button', { hasText: 'Generate mesh' });
const meshNote = (page) => page.locator('#building-floor .mesh-note');
const roofBox = (page) => page.locator('#building-floor .mesh-roof input');
const sealBox = (page) => page.locator('#building-floor .mesh-seal input');

/**
 * Press Generate mesh and wait for it to finish.
 *
 * Not just for the note to appear: the note shows up the moment the button is pressed,
 * saying the floors are being read, and waiting on that would run every assertion below
 * against a half-written folder.
 */
async function generate(page) {
    await generateButton(page).click();
    await expect(meshNote(page)).not.toContainText('Reading the floors');
}

const preset = async (page) => JSON.parse(await readFile(page, 'Plugins/MyTower/MyTower.sodso.json'));

/** The first bytes of a file, which is how a PNG is recognised without decoding it. */
const firstBytes = (page, path, count) => page.evaluate(async ([p, n]) => {
    const parts = p.split('/');
    const name = parts.pop();
    const dir = await window.__opfsDir(parts.join('/'), false);
    const file = await (await dir.getFileHandle(name)).getFile();

    return [...new Uint8Array(await file.slice(0, n).arrayBuffer())];
}, [path, count]);


/* -------------------------------------------------------------------------- */

test('generating writes the model, its textures and its prefab', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'Tenement_MainFloor1', UPPER_SLOT);

    await generate(page);

    expect(await listDir(page, 'Plugins/MyTower/MyTowerPrefab')).toEqual([
        'MyTower.obj',
        'MyTower.sodprefab.json',
        'MyTower_black.png',
        'MyTower_diffuse.png',
        'MyTower_emissive.png',
        'MyTower_mask.png',
        'MyTower_normal.png',
    ]);
});

test('the textures are PNGs a decoder would accept', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'Tenement_MainFloor1', UPPER_SLOT);
    await generate(page);

    // Worth checking through the file system rather than in the encoder's own tests: the
    // path a Uint8Array takes through createWritable is the one place these bytes could
    // be turned into text without anything saying so.
    for (const name of ['diffuse', 'emissive', 'black', 'mask', 'normal']) {
        expect(await firstBytes(page, `Plugins/MyTower/MyTowerPrefab/MyTower_${name}.png`, 8),
            name).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    }
});

test('the preset points at what was written, and carries its window data', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'Tenement_MainFloor1', UPPER_SLOT);
    await generate(page);

    const written = await preset(page);

    expect(written.prefab).toBe('PREFAB:MyTowerPrefab/MyTower');
    expect(written.emissionMapLit).toBe('TEXTURE:MyTowerPrefab/MyTower_emissive');
    expect(written.emissionMapUnlit).toBe('TEXTURE:MyTowerPrefab/MyTower_black');

    // Two window rows: three storeys, less the ground floor the street frontage draws.
    expect(written.floorCount).toBe(2);
    expect(written.sortedWindows).toHaveLength(2);
    expect(written.sortedWindows[0].front.length).toBeGreaterThan(0);
});

test('the prefab names the mesh and the three maps beside it', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'Tenement_MainFloor1', UPPER_SLOT);
    await generate(page);

    const prefab = JSON.parse(
        await readFile(page, 'Plugins/MyTower/MyTowerPrefab/MyTower.sodprefab.json'));

    expect(prefab.prefabType).toBe('building');
    expect(prefab.children[0].components[0].mesh).toBe('MyTower.obj');

    const obj = await readFile(page, 'Plugins/MyTower/MyTowerPrefab/MyTower.obj');
    expect(obj.split('\n')[0]).toBe('o MyTower');
    expect(obj).toMatch(/^f \d+\/\d+\/\d+ /m);
});

test('the panel says what was built', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'Tenement_MainFloor1', UPPER_SLOT);
    await generate(page);

    // The ground floor being left out is deliberate and surprising, so it is said rather
    // than left to the reader to notice the building is a storey shorter than it is.
    await expect(meshNote(page)).toContainText('2 window rows');
    await expect(meshNote(page)).toContainText('Not modelled: Tenement_GroundFloor1');
});

test('editing a floor afterwards says the model has gone out of date', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'Tenement_MainFloor1', UPPER_SLOT);
    await generate(page);

    await expect(meshNote(page)).not.toContainText('changed since');

    // A wall is the strongest case: a window painted onto an exterior wall changes which
    // rectangles the window data should describe, and nothing about the preset would look
    // wrong afterwards.
    await page.evaluate(async () => {
        const { saveNow, openFloorModel } = await import('/flows/building/scripts/ui.js');
        const model = await import('/flows/building/scripts/floorModel.js');

        model.setWall(openFloorModel(), 9, 9, model.AXIS_X, '16');
        await saveNow();
    });

    await expect(meshNote(page)).toContainText('generate again');
});

test('generating again clears it', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'Tenement_MainFloor1', UPPER_SLOT);
    await generate(page);

    await page.evaluate(async () => {
        const { saveNow, openFloorModel } = await import('/flows/building/scripts/ui.js');
        const model = await import('/flows/building/scripts/floorModel.js');

        model.setWall(openFloorModel(), 9, 9, model.AXIS_X, '16');
        await saveNow();
    });
    await expect(meshNote(page)).toContainText('generate again');

    await generate(page);
    await expect(meshNote(page)).not.toContainText('generate again');
});

/**
 * Generating writes seven files and a building to point at them, so it is one of the two
 * ways a base game building would be taken over -- and it asks the same question the first
 * edit to a floor does, rather than deciding for itself. See scripts/ownership.js.
 */
test('generating against a base game building asks before it writes anything', async ({ page }) => {
    await openBuildingFlow(page);

    await open(page, 'Townhouse', 'Tenement_MainFloor1', {
        isBasement: false, isControlVariant: false, layoutIndex: 1, blueprintIndex: 0,
    });

    // The button, not the `generate` helper: that waits for the progress note, and the
    // whole point here is that no generation starts at all.
    await generateButton(page).click();

    await expect(page.locator('#building-ownership-modal[open]')).toHaveCount(1);

    // Nothing at all: not the model, not a preset, not a patch.
    expect(await readFile(page, 'Plugins/MyTower/Townhouse.BuildingPreset.sodso.json')).toBeNull();
    expect(await readFile(page, 'Plugins/MyTower/Townhouse.sodso_patch.json')).toBeNull();
});

test('overriding a base game building puts its generated model in the patch', async ({ page }) => {
    await openBuildingFlow(page);

    // Townhouse ships with the app and is not a file this app has a handle on, so
    // generating against it writes operations over the game's own building.
    await open(page, 'Townhouse', 'Tenement_MainFloor1', {
        isBasement: false, isControlVariant: false, layoutIndex: 1, blueprintIndex: 0,
    });

    await page.evaluate(async () => {
        const { chooseOverride } = await import('/flows/building/scripts/ui.js');
        chooseOverride();
    });

    await generate(page);

    const patch = JSON.parse(await readFile(page, 'Plugins/MyTower/Townhouse.sodso_patch.json'));
    const stated = Object.fromEntries(patch.patches.map((op) => [op.path, op.value]));

    // Stated rather than diffed. The app's copy of a base game building is a dump, whose
    // prefab is a Unity `{m_FileID}` reference -- a patch built by comparison would carry
    // every one of those differences out into the mod.
    expect(stated['/prefab']).toBe('PREFAB:TownhousePrefab/Townhouse');
    expect(stated['/sortedWindows']).toHaveLength(5);
    expect(patch.patches.every((op) => op.op === 'add' || op.path.startsWith('/floorLayouts/')))
        .toBe(true);

    // And no preset. The game places its own Townhouse, drawn with this model.
    expect(await readFile(page, 'Plugins/MyTower/Townhouse.BuildingPreset.sodso.json')).toBeNull();

    // Written into the mod's manifest, or the loader never reads it.
    const manifest = JSON.parse(await readFile(page, 'Plugins/MyTower/murdermanifest.sodso.json'));
    expect(JSON.stringify(manifest)).toContain('Townhouse');
});

test('a floor no building refers to has nothing to generate', async ({ page }) => {
    await openBuildingFlow(page);

    // The spare floor no building's slot list names. There is no building to be the model
    // of, so there is nothing the button could generate.
    await open(page, null, 'MyTower_Spare', null);

    await expect(generateButton(page)).toBeDisabled();
});

test('a building with nothing above its ground floor says so rather than writing half of one',
    async ({ page }) => {
        await openBuildingFlow(page, {
            'Plugins/MyTower/murdermanifest.sodso.json': json({
                enabled: true, fileOrder: ['REF:MyTower'], loadBefore: '', version: 1,
            }),
            'Plugins/MyTower/MyTower.sodso.json': json({
                name: 'MyTower',
                presetName: 'MyTower',
                type: 'BuildingPreset',
                fileType: 'BuildingPreset',
                copyFrom: null,
                floorLayouts: [
                    { floorsWithThisSetting: 1, blueprints: ['Tenement_GroundFloor1'] },
                ],
            }),
            'Plugins/MyTower/Floors/MyTower_Spare.json': spareFloor,
        });

        await open(page, 'MyTower', 'Tenement_GroundFloor1', {
            isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0,
        });

        await generate(page);

        await expect(meshNote(page)).toContainText('no floors above its ground floor');
        expect(await listDir(page, 'Plugins/MyTower/MyTowerPrefab')).toBeNull();
    });

/**
 * The roof checkbox.
 *
 * Whether the model gets a top is the one thing about generating that is the author's to
 * say rather than the blueprint's, so it is the one thing here that has to survive being
 * put down and picked up again. What the geometry it produces looks like is asserted in
 * the unit suite; what these cover is that the answer reaches the generator and comes
 * back out of the preset.
 */
test('leaving the roof off writes a model with a rim in place of a top', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'Tenement_MainFloor1', UPPER_SLOT);

    await generate(page);
    const capped = await readFile(page, 'Plugins/MyTower/MyTowerPrefab/MyTower.obj');

    await roofBox(page).uncheck();
    await generate(page);
    const open_ = await readFile(page, 'Plugins/MyTower/MyTowerPrefab/MyTower.obj');

    const upward = (obj) => obj.split('\n').filter((line) => line === 'vn 0 1 0').length;

    // Not none: the 10 cm rim round the open top faces up as well. What goes is the roof
    // it rims. Which faces survive, and that they meet without overlapping, is asserted
    // on the mesh itself in meshExport.unit.spec.js.
    expect(upward(open_)).toBeGreaterThan(0);
    expect(upward(open_)).toBeLessThan(upward(capped));

    // The walls are still there: this leaves the top off, not the building.
    expect(open_).toMatch(/^f \d+\/\d+\/\d+ /m);
    expect((await preset(page)).modMakerBuildRoof).toBe(false);
});

test('a building built without a roof opens with the box still unticked', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'Tenement_MainFloor1', UPPER_SLOT);

    await roofBox(page).uncheck();
    await generate(page);

    // Opened again from scratch, which is where the answer has to come off the preset --
    // otherwise the next generation quietly puts the roof back on.
    await open(page, 'MyTower', 'Tenement_MainFloor1', UPPER_SLOT);
    await expect(roofBox(page)).not.toBeChecked();
});

/**
 * The seal checkbox, which is the roof box's other half: whether the model is closed up
 * on the faces inside it. Same question, so the same two things are covered -- the answer
 * reaches the generator, and it survives the building being put down and picked up. Which
 * walls it adds is asserted on the mesh in meshExport.unit.spec.js.
 */
test('sealing the model is remembered on the preset', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'Tenement_MainFloor1', UPPER_SLOT);

    // The silhouette is what a building is generated as until it is asked otherwise.
    await expect(sealBox(page)).not.toBeChecked();

    await sealBox(page).check();
    await generate(page);

    expect((await preset(page)).modMakerSealInterior).toBe(true);

    // Opened again from scratch, where the answer has to come off the preset -- otherwise
    // the next generation quietly opens the model back up.
    await open(page, 'MyTower', 'Tenement_MainFloor1', UPPER_SLOT);
    await expect(sealBox(page)).toBeChecked();
});

test('saving a floor does not tick the box back on', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'Tenement_MainFloor1', UPPER_SLOT);
    await generate(page);

    // Unticked but not yet generated, so the preset on disk still says the mesh has a
    // roof. Saving re-reads it to ask whether the model has gone stale, and the answer to
    // that question is not an answer to this one.
    await roofBox(page).uncheck();

    await page.evaluate(async () => {
        const { saveNow, openFloorModel } = await import('/flows/building/scripts/ui.js');
        const model = await import('/flows/building/scripts/floorModel.js');

        model.setWall(openFloorModel(), 9, 9, model.AXIS_X, '16');
        await saveNow();
    });

    await expect(meshNote(page)).toContainText('generate again');
    await expect(roofBox(page)).not.toBeChecked();
});

test('with no content folder chosen there is nowhere to generate into', async ({ page }) => {
    // A base game building can be opened and looked at with no content folder, which is
    // worth being able to do. Nothing can be written, so nothing offers to.
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=building');
    await seedFs(page, modWithBuilding);
    await connectFolders(page, { modDir: 'Plugins' });

    await open(page, 'Townhouse', 'Tenement_MainFloor1', {
        isBasement: false, isControlVariant: false, layoutIndex: 1, blueprintIndex: 0,
    });

    await expect(generateButton(page)).toBeDisabled();
});
