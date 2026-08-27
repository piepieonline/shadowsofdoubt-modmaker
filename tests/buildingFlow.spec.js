import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, gotoFlow, connectFolders, selectContent,
    readFile, listDir, queuePrompts, alerts,
} from './support/harness.js';

/**
 * The building flow, wired into the shell.
 *
 * The thing worth proving here is the one the whole flow exists for: open a floor the
 * base game ships, change it, and have it end up in the mod as a floor the game will
 * load -- with the building that names it rewritten to a stub the mod owns, because
 * base game presets are never written to.
 *
 * The pieces underneath are tested on their own. What this covers is that they are
 * connected to each other and to the shell.
 */

const json = (value) => JSON.stringify(value, null, 2);

/** A mod with a building of its own, so both kinds are listed side by side. */
const modWithBuilding = {
    'Plugins/MyTower/MyTower.sodso.json': json({
        name: 'MyTower',
        presetName: 'MyTower',
        type: 'BuildingPreset',
        fileType: 'BuildingPreset',
        copyFrom: null,
        floorLayouts: [
            { floorsWithThisSetting: 1, blueprints: ['MyTower_Ground'], controlRoomVariants: [] },
        ],
    }),
    'Plugins/MyTower/Floors/MyTower_Ground.json': JSON.stringify({
        floorName: 'MyTower_Ground',
        size: { x: 1, y: 1 },
        defaultFloorHeight: 0,
        defaultCeilingHeight: 42,
        a_d: [{
            p_n: 'Outside',
            e_c: { r: 1, g: 0, b: 0.4, a: 1 },
            vs: [{ r_d: [{ id: 1, n_d: [{ f_c: { x: 5, y: 5 }, f_h: 0, f_t: 0, f_r: '', w_d: [] }], l: 'Null' }] }],
        }],
        t_d: [],
    }),
};

async function openBuildingFlow(page, files = modWithBuilding) {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=building');
    await seedFs(page, files);
    await connectFolders(page, { modDir: 'Plugins' });
    await selectContent(page, 'MyTower', '');
}

/** Open a floor by calling the flow directly, rather than hunting for its button. */
const open = (page, building, blueprint, slot = null) => page.evaluate(async (request) => {
    const { openFloor } = await import('/flows/building/scripts/ui.js');
    await openFloor(request);
}, { building, blueprint, slot });


/* -------------------------------------------------------------------------- */
/* Mounting                                                                    */
/* -------------------------------------------------------------------------- */

test('the flow mounts its own markup and nothing else', async ({ page }) => {
    await openBuildingFlow(page);

    await expect(page.locator('#building-canvas')).toBeAttached();
    await expect(page.locator('#building-file-panel')).toBeAttached();
    await expect(page.locator('#building-panels')).toBeAttached();

    // The other flows' markup shares ids with this one's, so only one may be mounted.
    await expect(page.locator('#dds-file-panel')).toHaveCount(0);
    await expect(page.locator('#main-container')).toHaveCount(0);

    const styles = await page.evaluate(() =>
        [...document.querySelectorAll('link[data-flow-style]')].map((l) => l.getAttribute('href')));
    expect(styles.join()).toContain('flows/building/');
    expect(styles.join()).not.toContain('flows/dds/');
});

test('the flow asks for the mod folder and not the game folder', async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=building');

    const required = await page.evaluate(() => window.activeFlow.requiredFolders);

    // Floor blueprints are TextAssets inside asset bundles, so a browser could not read
    // them from an install even with the game folder connected. They ship with the app.
    expect(required).toEqual(['modDir']);
});


/* -------------------------------------------------------------------------- */
/* The panel                                                                   */
/* -------------------------------------------------------------------------- */

test('the panel lists the mod\'s buildings and the base game\'s', async ({ page }) => {
    await openBuildingFlow(page);

    const categories = page.locator('#building-file-list .file-panel-category');
    await expect(categories.first()).toHaveAttribute('data-category', 'MyTower');

    // The mod's own building is marked, because a base game one behaves differently
    // when saved against: it becomes a stub.
    await expect(categories.first().locator('summary')).toHaveText('MyTower (this mod) (1)');

    // The base game's are listed so a base game floor can be opened at all.
    await expect(page.locator('[data-category="Hotel"]')).toBeAttached();
    await expect(page.locator('[data-category="CityHall"]')).toBeAttached();

    // 15 base game buildings plus the mod's one.
    await expect(categories).toHaveCount(16);
});

test('a floor the mod has edited is marked as such', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        // A floor named after a base game one: the mod's copy shadows it.
        'Plugins/MyTower/Floors/Hotel_GroundFloor.json': JSON.stringify({
            floorName: 'Hotel_GroundFloor', a_d: [], t_d: [],
        }),
    });

    const hotel = page.locator('[data-category="Hotel"]');
    const edited = hotel.locator('.file-panel-entry[data-id="Hotel/Hotel_GroundFloor"]');

    await expect(edited).toHaveAttribute('data-kind', 'edited');
    await expect(hotel.locator('.file-panel-entry[data-id="Hotel/Hotel_FirstFloor"]'))
        .not.toHaveAttribute('data-kind', 'edited');
});

test('a floor no building refers to is still reachable', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/Floors/Stranded.json': JSON.stringify({
            floorName: 'Stranded', a_d: [], t_d: [],
        }),
    });

    // Renaming a floor, or taking it out of a slot, leaves one behind. Listing it is
    // what stops it becoming a file only the filesystem knows about.
    const orphans = page.locator('.file-panel-category[data-category="unused-floors"]');
    await expect(orphans.locator('summary')).toHaveText('Floors no building uses (1)');
    await expect(orphans.locator('.file-panel-entry')).toHaveText(/Stranded/);
});

test('with no content folder chosen the panel says what to do', async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=building');
    await seedFs(page, modWithBuilding);
    await connectFolders(page, { modDir: 'Plugins' });

    await expect(page.locator('#building-file-list .file-panel-empty'))
        .toHaveText('Choose a mod and content folder to see the buildings in it.');
});


/* -------------------------------------------------------------------------- */
/* Opening                                                                     */
/* -------------------------------------------------------------------------- */

test('opening a floor draws it and fills the panels', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'Hotel', 'Hotel_GroundFloor');

    await expect(page.locator('#building-open-name')).toHaveText('Hotel_GroundFloor — Hotel');

    // The canvas is live and the floor is on it.
    const drawn = await page.evaluate(() => {
        const canvas = document.querySelector('#building-canvas canvas');
        return { present: !!canvas, width: canvas?.clientWidth ?? 0 };
    });
    expect(drawn.present).toBe(true);
    expect(drawn.width).toBeGreaterThan(0);

    // The panels follow the floor that was opened.
    await expect(page.locator('#building-tools button')).toHaveCount(5);
    await expect(page.locator('#building-addresses .address-row').first()).toBeAttached();
    await expect(page.locator('#building-walls select')).toBeAttached();
});

test('clicking the floor labels the cell and fills the selection panel', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'Hotel', 'Hotel_GroundFloor');

    // Click where a known cell actually is, rather than at a guessed screen position.
    await page.evaluate(async () => {
        const { projectCell } = await import('/flows/building/scripts/ui.js');
        const canvas = document.querySelector('#building-canvas canvas');

        // Ask the view where the cell landed rather than guessing a screen position.
        const at = projectCell(10, 10);
        for (const type of ['pointerdown', 'pointerup']) {
            canvas.dispatchEvent(new PointerEvent(type, {
                pointerId: 1, button: 0, buttons: type === 'pointerdown' ? 1 : 0,
                bubbles: true, clientX: at.left, clientY: at.top,
            }));
        }
    });

    await expect(page.locator('#building-labels .cell-label.selected')).toHaveCount(1);
    await expect(page.locator('#building-labels .cell-label')).toContainText('10, 10');
    await expect(page.locator('#building-selection .selected-node h4')).toHaveText('Node 10, 10');
});

test('a label never swallows the click that put it there', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'Hotel', 'Hotel_GroundFloor');

    const pointerEvents = await page.evaluate(() => {
        const host = document.querySelector('#building-labels');
        return getComputedStyle(host).pointerEvents;
    });

    // A label sits exactly where you are about to click next, so one that could be hit
    // would make the cell under it unpaintable.
    expect(pointerEvents).toBe('none');
});

test('opening a floor the mod holds reads the mod\'s copy', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'MyTower_Ground');

    const name = await page.evaluate(() => document.querySelector('#building-open-name').textContent);
    expect(name).toBe('MyTower_Ground — MyTower');
});

test('opening a floor that is not there says so rather than failing quietly', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'NoSuchFloor');

    expect(await alerts(page)).toContain('Could not find a floor called "NoSuchFloor".');
    await expect(page.locator('#building-open-name')).toHaveText('No floor open');
});


/* -------------------------------------------------------------------------- */
/* Saving -- what the flow exists for                                          */
/* -------------------------------------------------------------------------- */

test('editing a base game floor writes it into the mod and stubs its building', async ({ page }) => {
    await openBuildingFlow(page);

    // The base game's Hotel, ground floor, in the slot the building lists it in.
    await open(page, 'Hotel', 'Hotel_GroundFloor', {
        isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0,
    });

    // Paint something, then save explicitly.
    await page.evaluate(async () => {
        const { saveNow } = await import('/flows/building/scripts/ui.js');
        const model = await import('/flows/building/scripts/floorModel.js');

        const { openFloorModel } = await import('/flows/building/scripts/ui.js');
        model.setWall(openFloorModel(), 9, 9, model.AXIS_X, '16');
        await saveNow();
    });

    // The floor is in the mod, under the name the building already refers to.
    const floors = await listDir(page, 'Plugins/MyTower/Floors');
    expect(floors).toContain('Hotel_GroundFloor.json');

    const written = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/Hotel_GroundFloor.json'));
    expect(written.floorName).toBe('Hotel_GroundFloor');
    expect(written.a_d.length).toBeGreaterThan(0);

    // And the base game's Hotel has become a stub the mod owns, which copies everything
    // it does not say from the original -- prefab, mesh, window data.
    const stub = JSON.parse(await readFile(page, 'Plugins/MyTower/Hotel.sodso.json'));
    expect(stub.copyFrom).toBe('REF:BuildingPreset|Hotel');
    expect(stub.fileType).toBe('BuildingPreset');
    expect(stub.floorLayouts[0].blueprints).toEqual(['Hotel_GroundFloor']);
    expect(stub.prefab).toBeUndefined();
});

test('both halves of a painted wall reach the file', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'MyTower_Ground', {
        isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0,
    });

    await page.evaluate(async () => {
        const { saveNow, openFloorModel } = await import('/flows/building/scripts/ui.js');
        const model = await import('/flows/building/scripts/floorModel.js');
        model.setWall(openFloorModel(), 9, 9, model.AXIS_X, '16');
        await saveNow();
    });

    const written = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Ground.json'));
    const nodes = written.a_d.flatMap((a) => a.vs).flatMap((v) => v.r_d).flatMap((r) => r.n_d);
    const at = (x, y) => nodes.find((n) => n.f_c.x === x && n.f_c.y === y);

    // A wall recorded on one node and not the other is the failure that only shows up
    // once the game renders the floor.
    expect(at(9, 9).w_d).toEqual([{ w_o: { x: 0.5, y: 0 }, p_n: '16' }]);
    expect(at(10, 9).w_d).toEqual([{ w_o: { x: -0.5, y: 0 }, p_n: '16' }]);
});

test('saving a floor the mod already has does not make a second building', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'MyTower_Ground', {
        isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0,
    });

    await page.evaluate(async () => {
        const { saveNow } = await import('/flows/building/scripts/ui.js');
        await saveNow();
    });

    const files = await listDir(page, 'Plugins/MyTower');
    expect(files.filter((name) => name.endsWith('.sodso.json'))).toEqual(['MyTower.sodso.json']);

    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/MyTower.sodso.json'));
    expect(preset.floorLayouts[0].blueprints).toEqual(['MyTower_Ground']);
});

test('nothing is written before there is anything to write', async ({ page }) => {
    await openBuildingFlow(page);

    await page.evaluate(async () => {
        const { saveNow } = await import('/flows/building/scripts/ui.js');
        await saveNow();
    });

    // No floor open, so saving is a no-op rather than an empty file or an error.
    const files = await listDir(page, 'Plugins/MyTower/Floors');
    expect(files).toEqual(['MyTower_Ground.json']);
    expect(await alerts(page)).toEqual([]);
});


/* -------------------------------------------------------------------------- */
/* Adding a building                                                           */
/* -------------------------------------------------------------------------- */

test('a new building can copy from a base game one', async ({ page }) => {
    await openBuildingFlow(page);
    await queuePrompts(page, ['GrandHotel', 'Hotel']);

    await page.evaluate(async () => {
        const { addBuilding } = await import('/flows/building/scripts/ui.js');
        await addBuilding();
    });

    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/GrandHotel.sodso.json'));
    expect(preset.name).toBe('GrandHotel');
    expect(preset.copyFrom).toBe('REF:BuildingPreset|Hotel');

    // It takes the Hotel's floor list, so its slots are there to be edited into.
    expect(preset.floorLayouts).toHaveLength(8);

    await expect(page.locator('[data-category="GrandHotel"] summary'))
        .toHaveText('GrandHotel (this mod) (12)');
});

test('a building copied from something the base game does not have is refused', async ({ page }) => {
    await openBuildingFlow(page);
    await queuePrompts(page, ['Thing', 'NotABuilding']);

    await page.evaluate(async () => {
        const { addBuilding } = await import('/flows/building/scripts/ui.js');
        await addBuilding();
    });

    expect(await alerts(page)).toContain('"NotABuilding" is not a base game building.');
    expect(await listDir(page, 'Plugins/MyTower')).not.toContain('Thing.sodso.json');
});

test('a building with a name the mod already uses is refused', async ({ page }) => {
    await openBuildingFlow(page);
    await queuePrompts(page, ['MyTower']);

    await page.evaluate(async () => {
        const { addBuilding } = await import('/flows/building/scripts/ui.js');
        await addBuilding();
    });

    expect(await alerts(page)).toContain('This mod already has a building called "MyTower".');
});


/* -------------------------------------------------------------------------- */
/* New content folder                                                          */
/* -------------------------------------------------------------------------- */

test('New content lays out a folder that reads back as a building mod', async ({ page }) => {
    // The building sits one level down rather than at the mod root. A content folder
    // stops the search below it -- see core/modFolders.js -- so a mod whose root is
    // itself content has nowhere to put a second one.
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=building');
    await seedFs(page, {
        'Plugins/MyTower/Tower/MyTower.sodso.json': json({
            name: 'MyTower', presetName: 'MyTower', type: 'BuildingPreset',
            fileType: 'BuildingPreset', copyFrom: null, floorLayouts: [],
        }),
        'Plugins/MyTower/Tower/Floors/.keep': '',
    });
    await connectFolders(page, { modDir: 'Plugins' });
    await selectContent(page, 'MyTower', 'Tower');

    await queuePrompts(page, ['SecondTower']);

    await page.click('#new-content');
    await expect(page.locator('#select-content')).toHaveValue('SecondTower');

    const files = await listDir(page, 'Plugins/MyTower/SecondTower');
    expect(files.sort()).toEqual(['Floors', 'SecondTower.sodso.json']);

    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/SecondTower/SecondTower.sodso.json'));
    expect(preset.fileType).toBe('BuildingPreset');
    expect(preset.name).toBe('SecondTower');

    // The Floors directory is what marks the folder as holding buildings, so it exists
    // from the start rather than appearing with the first floor.
    const described = await page.evaluate(async () => {
        const { findContentFolders, describeContentFolder } = await import('/core/modFolders.js');
        const plugins = await window.__opfsDir('Plugins', false);
        const mod = await plugins.getDirectoryHandle('MyTower');
        return (await findContentFolders(mod)).map(describeContentFolder);
    });

    expect(described).toContain('SecondTower — building');
});


/* -------------------------------------------------------------------------- */
/* Switching away and back                                                     */
/* -------------------------------------------------------------------------- */

test('switching editors and coming back reopens the floor and its layouts', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        // Two addresses, the second with two layout variations, so the selection has
        // something to lose.
        'Plugins/MyTower/Floors/Twin.json': JSON.stringify({
            floorName: 'Twin',
            size: { x: 1, y: 1 },
            defaultCeilingHeight: 42,
            a_d: [
                {
                    p_n: 'Outside', e_c: { r: 1, g: 0, b: 0.4, a: 1 },
                    vs: [{ r_d: [{ id: 1, n_d: [{ f_c: { x: 4, y: 4 }, f_h: 0, f_t: 0, f_r: '', w_d: [] }], l: 'Null' }] }],
                },
                {
                    p_n: 'Lobby', e_c: { r: 1, g: 0.66, b: 0, a: 1 },
                    vs: [
                        { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
                        { r_d: [{ id: 3, n_d: [{ f_c: { x: 11, y: 11 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Ballroom' }] },
                    ],
                },
            ],
            t_d: [],
        }),
    });

    await open(page, 'MyTower', 'Twin');

    // Show the second layout of the second address, and pick a different tool.
    await page.evaluate(async () => {
        const model = await import('/flows/building/scripts/floorModel.js');
        const { openFloorModel, currentToolState } = await import('/flows/building/scripts/ui.js');
        const { Tool } = await import('/flows/building/scripts/tools.js');
        model.selectVariation(openFloorModel(), 1, 1);
        currentToolState().tool = Tool.WALL;
    });

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    await page.selectOption('#flow-picker', 'building');
    await page.locator('html[data-flow-ready="building"]').waitFor();

    await expect(page.locator('#building-open-name')).toHaveText('Twin — MyTower');

    const restored = await page.evaluate(async () => {
        const { openFloorModel, currentToolState } = await import('/flows/building/scripts/ui.js');
        return {
            selections: openFloorModel().addresses.map((a) => a.selectedVariation),
            tool: currentToolState().tool,
        };
    });

    // Without this the second address would come back on layout 0, and an edit made
    // there would be written over the layout that was actually being worked on.
    expect(restored.selections).toEqual([0, 1]);
    expect(restored.tool).toBe('wall');
});

test('leaving the flow gives back the WebGL context', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'MyTower_Ground');

    const before = await page.evaluate(() => !!document.querySelector('#building-canvas canvas'));
    expect(before).toBe(true);

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    // A browser drops the oldest context once about sixteen are alive, so a flow that
    // leaked one per visit would eventually take the floorplan down with it.
    const released = await page.evaluate(async () => {
        const { viewIsLive } = await import('/flows/building/scripts/ui.js');
        return viewIsLive();
    });
    expect(released).toBe(false);
});

test('changing content folder closes what was open', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/OtherMod/Other.sodso.json': json({
            name: 'Other', fileType: 'BuildingPreset', type: 'BuildingPreset', copyFrom: null,
        }),
        'Plugins/OtherMod/Floors/.keep': '',
    });

    await open(page, 'MyTower', 'MyTower_Ground');
    await expect(page.locator('#building-open-name')).toHaveText('MyTower_Ground — MyTower');

    await selectContent(page, 'OtherMod', '');

    // A floor is identified by a name another mod can have a file of its own at, so
    // keeping it open would mean saving it into the wrong folder.
    await expect(page.locator('#building-open-name')).toHaveText('No floor open');
});
