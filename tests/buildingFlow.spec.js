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
    await expect(page.locator('#building-browse')).toBeAttached();
    await expect(page.locator('#building-status')).toBeAttached();
    await expect(page.locator('#building-panels')).toBeAttached();

    // The other flows' markup shares ids with this one's, so only one may be mounted.
    await expect(page.locator('#dds-file-panel')).toHaveCount(0);
    await expect(page.locator('#main-container')).toHaveCount(0);

    const styles = await page.evaluate(() =>
        [...document.querySelectorAll('link[data-flow-style]')].map((l) => l.getAttribute('href')));
    expect(styles.join()).toContain('flows/building/');
    expect(styles.join()).not.toContain('flows/dds/');
});

test('Help opens, says how a building is put together, and closes again', async ({ page }) => {
    await openBuildingFlow(page);

    const help = page.locator('#help-modal');
    await expect(help).not.toHaveAttribute('open', '');

    await page.locator('.flow-bar a', { hasText: 'Help' }).click();
    await expect(help).toHaveAttribute('open', '');

    // The chain a floor is reached through, which is the thing the summary is for: a
    // floor is never opened on its own, so knowing what contains it is how any of the
    // rest makes sense.
    for (const level of ['Building:', 'Storey:', 'Blueprint:', 'Address:', 'Room:', 'Node:', 'Wall:', 'Tile:']) {
        await expect(help).toContainText(level);
    }

    // And the controls, which moved here out of the tool bar.
    await expect(help).toContainText('Alt+drag');
    await expect(help).toContainText('shift+arrows');

    await help.locator('.close-button').click();
    await expect(help).not.toHaveAttribute('open', '');
});

test('the tool bar says what a click does, and leaves the reference to Help', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'Hotel', 'Hotel_GroundFloor');

    // What changes with the mode stays on screen; what never changes does not. The left
    // column is narrow, and the panel under this one is what says where the pointer is.
    // A floor opens in None, so this is what None says a click does.
    const tools = page.locator('#building-tools');
    await expect(tools).toContainText('Left click to select and pick');
    await expect(tools).not.toContainText('orbit');
    await expect(tools).not.toContainText('zoom');
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

    // The count is everything under the building, which is now a floor deeper than the
    // heading it is on: one storey holding one layout.
    await expect(page.locator('[data-category="MyTower"] > summary .file-panel-summary-name'))
        .toHaveText('MyTower (1)');

    // Twelve buildings of a dozen floors each is a scroll rather than a list, so the
    // menu opens as a list of names.
    await expect(categories.first()).not.toHaveAttribute('open', '');
    await expect(page.locator('#building-file-list .file-panel-entry').first()).toBeHidden();

    // Which of the two a building is, said once as a heading rather than on each line:
    // the mod's own come first, then the base game's, which behave differently when
    // saved against because they become stubs.
    await expect(page.locator('#building-file-list .file-panel-group'))
        .toHaveText(['Custom', 'Vanilla']);

    // The base game's are listed so a base game floor can be opened at all.
    await expect(page.locator('[data-category="Hotel"]')).toBeAttached();
    await expect(page.locator('[data-category="CityHall"]')).toBeAttached();

    // 15 base game buildings less the three boundary ones, plus the mod's own.
    await expect(categories).toHaveCount(13);

    // The scenery along the edge of the city: nonEnterable, with no floors in them, so
    // there is nothing a category for one could offer to open.
    for (const name of ['BoundaryCoastal01', 'BoundaryCoastal02', 'BoundaryCorner01']) {
        await expect(page.locator(`[data-category="${name}"]`)).toHaveCount(0);
    }
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
    await expect(orphans.locator('.file-panel-summary-name'))
        .toHaveText('Floors no building uses (1)');
    await expect(orphans.locator('.file-panel-entry')).toHaveText(/Stranded/);
});

test('the Browse menu runs down to where the columns end', async ({ page }) => {
    await openBuildingFlow(page);
    await page.click('#building-browse summary');

    // A cap rather than a height: a menu with little in it is short. What matters is
    // where the cap is -- a dozen buildings of a dozen floors, each holding its layouts,
    // is taller than the page, and the part of a menu below the workspace is off the
    // bottom of it with no way to scroll to it.
    await expect.poll(() => page.evaluate(() => {
        const menu = document.querySelector('#building-browse .browse-menu');
        const column = document.querySelector('#building-left');
        const available = column.getBoundingClientRect().bottom
            - menu.getBoundingClientRect().top;
        return Math.round(parseFloat(menu.style.maxHeight) - available);
    })).toBe(0);
});

/**
 * With no content folder, the base game's half of the panel is still worth having: a
 * floor can be opened and looked at without anywhere to save it to. What a folder buys
 * is the mod's own buildings and the ability to write, and both are absent rather than
 * offered and then refused.
 */
test('with no content folder chosen the base game\'s buildings are still listed', async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=building');
    await seedFs(page, modWithBuilding);
    await connectFolders(page, { modDir: 'Plugins' });

    // No Custom heading: there is no content folder for a building of the mod's to be in.
    await expect(page.locator('#building-file-list .file-panel-group')).toHaveText(['Vanilla']);
    await expect(page.locator('[data-category="Hotel"]')).toBeAttached();
    await expect(page.locator('[data-category="MyTower"]')).toHaveCount(0);

    // Nothing can be written without one, so adding a building is not offered.
    await expect(page.locator('#new-building-button')).toBeDisabled();
});

test('a panel that cannot list the base game\'s buildings says so', async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));

    // The base game's buildings are fetched rather than read from disk, so no network --
    // or reference data not deployed beside the app -- leaves the panel with nothing to
    // list. It used to be an empty box, which reads as a mod with nothing in it.
    //
    // Routed before the flow loads: the index is fetched once per page.
    await page.route('**/refs/floors/index.json', (route) => route.abort());

    await gotoFlow(page, '?flow=building');
    await seedFs(page, modWithBuilding);
    await connectFolders(page, { modDir: 'Plugins' });
    await selectContent(page, 'MyTower', '');

    await expect(page.locator('#building-file-list .file-panel-empty'))
        .toHaveText('Buildings failed to load');
    await expect(page.locator('#building-file-list .file-panel-category')).toHaveCount(0);

    // The failure stops at the panel: the flow is still mounted and the rest of it drew.
    await expect(page.locator('#building-open-name')).toHaveText('No floor open');
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
    await expect(page.locator('#building-tools .mode-bar button')).toHaveCount(3);
    await expect(page.locator('#building-tools .tool-bar button')).toHaveCount(5);
    await expect(page.locator('#building-addresses .address-row').first()).toBeAttached();
    await expect(page.locator('#building-walls select')).toBeAttached();

    // The floor type tool's own setting. Every other tool has one, and without this the
    // only way to choose a floor type is to find a square that already has it.
    await expect(page.locator('#building-floor-type select.floor-type')).toBeAttached();
    await expect(page.locator('#building-floor-type input.floor-height')).toBeAttached();
});

test('the pointer labels a cell, and a click picks what is under it', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'Hotel', 'Hotel_GroundFloor');

    // Move over, then click, where a known cell actually is, rather than at a guessed
    // screen position. A floor opens in None, so this click is a pick and edits nothing.
    await page.evaluate(async () => {
        const { projectCell } = await import('/flows/building/scripts/ui.js');
        const canvas = document.querySelector('#building-canvas canvas');

        // Ask the view where the cell landed rather than guessing a screen position.
        //
        // A cell with a wall on the seam below it has that wall between the camera and
        // its middle, so a ray aimed there meets the wall first and the hover is of the
        // wall -- which is what a pointer at that spot is genuinely over. 10,11 is an
        // open cell of the Hotel's ground floor, so the pick is of the cell itself.
        const at = projectCell(10, 11);
        const send = (type, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
            pointerId: 1, button: 0, buttons, bubbles: true,
            clientX: at.left, clientY: at.top,
        }));

        send('pointermove', 0);
        send('pointerdown', 1);
        send('pointerup', 0);
    });

    // One label, for the hover. The selected cell has no label of its own.
    await expect(page.locator('#building-labels .cell-label')).toHaveCount(1);

    // A pick copies what is under the pointer into what would be painted, so the two
    // halves of the status column have to agree about the cell that was clicked. Read
    // rather than asserted against a fixture name: what matters is that they match.
    //
    // The address row, because a floor opens with the address tool and a pick copies
    // what that tool paints with -- picking an address does not also take the room, for
    // the same reason painting one does not.
    const rows = page.locator('#building-status .status-block');
    const address = await rows.nth(1)
        .locator('.status-row[data-type="address"] .status-value').textContent();
    await expect(rows.nth(0).locator('.status-row[data-type="address"] .status-value'))
        .toHaveText(address);

    // The label describes the same cell the column does, so the room it names is the
    // room the column names.
    const room = await rows.nth(1)
        .locator('.status-row[data-type="room"] .status-value').textContent();
    await expect(page.locator('#building-labels .cell-label')).toContainText(room);
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
    expect(stub.prefab).toBeUndefined();

    // The slot points at the mod's copy. A floor the mod holds does not shadow the base
    // game's by sharing its name -- the building has to name the path to it.
    expect(stub.floorLayouts[0].blueprints).toEqual(['FLOOR:Floors/Hotel_GroundFloor']);

    // Every other slot is still a name the game resolves out of its own assets.
    expect(stub.floorLayouts[1].blueprints.every((entry) => !entry.startsWith('FLOOR:'))).toBe(true);
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

    // The manifest is a .sodso.json too, and is not a building -- see
    // core/murderManifest.js. What must not appear is a second preset.
    const files = await listDir(page, 'Plugins/MyTower');
    expect(files.filter((name) => name.endsWith('.sodso.json') && name !== 'murdermanifest.sodso.json'))
        .toEqual(['MyTower.sodso.json']);

    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/MyTower.sodso.json'));
    expect(preset.floorLayouts[0].blueprints).toEqual(['FLOOR:Floors/MyTower_Ground']);

    // Saving the building writes it, and a building the manifest does not name is one
    // the loader never reads -- so a mod that had no manifest gains one here too.
    const manifest = JSON.parse(await readFile(page, 'Plugins/MyTower/murdermanifest.sodso.json'));
    expect(manifest.fileOrder).toEqual(['REF:MyTower']);
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
/* The Floor section                                                           */
/* -------------------------------------------------------------------------- */

/** A floor slot, in the shape the panel and the building preset both use. */
const slotAt = (layoutIndex, blueprintIndex = 0, isBasement = false) =>
    ({ isBasement, isControlVariant: false, layoutIndex, blueprintIndex });

const storey = (page) => page.locator('#building-floor .floor-storey');
const floorName = (page) => page.locator('#building-floor .floor-name');
const up = (page) => page.locator('#building-floor button[title="Open the floor above"]');
const down = (page) => page.locator('#building-floor button[title="Open the floor below"]');
const layouts = (page) => page.locator('#building-floor select');

test('the Floor section says where in the building the open floor is', async ({ page }) => {
    await openBuildingFlow(page);
    await expect(storey(page)).toHaveCount(0);

    await open(page, 'Hotel', 'Hotel_GroundFloor', slotAt(0));

    await expect(storey(page)).toHaveText('Floor 0');
    await expect(floorName(page)).toHaveText('Hotel_GroundFloor');
});

test('the arrows move a storey at a time', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'Hotel', 'Hotel_GroundFloor', slotAt(0));

    await up(page).click();
    await expect(storey(page)).toHaveText('Floor 1');
    await expect(floorName(page)).toHaveText('Hotel_FirstFloor');

    // Down from the ground floor is the basement, because basementLayouts[0] is the
    // storey immediately below it.
    await down(page).click();
    await down(page).click();
    await expect(storey(page)).toHaveText('Basement 0');
    await expect(floorName(page)).toHaveText('Hotel_Basement1');

    // Nothing below the deepest basement to go to.
    await expect(down(page)).toBeDisabled();
    await expect(up(page)).toBeEnabled();
});

test('opening another floor paints with that floor’s address and room', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'Hotel', 'Hotel_GroundFloor', slotAt(0));

    // Something well down both lists, as an author working on a floor would have.
    await page.evaluate(async () => {
        const { currentToolState } = await import('/flows/building/scripts/ui.js');
        Object.assign(currentToolState(), { addressIndex: 4, roomIndex: 2 });
    });

    await up(page).click();
    await expect(floorName(page)).toHaveText('Hotel_FirstFloor');

    const painting = await page.evaluate(async () => {
        const { currentToolState, openFloorModel } = await import('/flows/building/scripts/ui.js');
        const model = await import('/flows/building/scripts/floorModel.js');
        const state = currentToolState();

        return {
            addressIndex: state.addressIndex,
            roomIndex: state.roomIndex,
            room: model.roomAt(openFloorModel(), state.addressIndex, state.roomIndex)?.preset,
        };
    });

    // Both are positions in a floor rather than choices about painting: address 4 is a
    // different dwelling in every floor, and slot 2 within it is not even the same kind
    // of room. Carried across, they would have the room list pointing at something the
    // author never chose.
    expect(painting).toEqual({ addressIndex: 0, roomIndex: 0, room: 'Null' });
});

test('the top floor has nowhere further up', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'Hotel', 'Hotel_Penthouse', slotAt(7));

    await expect(storey(page)).toHaveText('Floor 7');
    await expect(up(page)).toBeDisabled();
});

test('a storey with more than one layout can be switched between them', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'Hotel', 'Hotel_TopFloors', slotAt(5));

    // Three blueprints in one setting: alternatives the game picks between for this
    // storey, which is what the select is for and what the arrows deliberately skip.
    await expect(layouts(page).locator('option'))
        .toHaveText(['Hotel_TopFloors', 'Hotel_TopFloors2', 'Hotel_TopFloors3']);
    await expect(layouts(page)).toHaveValue('0');

    await layouts(page).selectOption('1');
    await expect(floorName(page)).toHaveText('Hotel_TopFloors2');

    // Still the same storey: switching layouts is not moving through the building.
    await expect(storey(page)).toHaveText('Floor 5');
});

test('a storey with one layout says so rather than offering nothing', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'Hotel', 'Hotel_GroundFloor', slotAt(0));

    await expect(layouts(page).locator('option')).toHaveText(['Hotel_GroundFloor']);
    await expect(layouts(page)).toBeDisabled();
});

test('a floor no building uses has no storey to be on', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/Floors/Stranded.json': JSON.stringify({
            floorName: 'Stranded', a_d: [], t_d: [],
        }),
    });

    await open(page, null, 'Stranded', null);

    await expect(floorName(page)).toHaveText('Stranded');
    await expect(storey(page)).toHaveText('No building');
    await expect(up(page)).toBeDisabled();
    await expect(down(page)).toBeDisabled();
    await expect(layouts(page)).toHaveCount(0);
});


/* -------------------------------------------------------------------------- */
/* Adding and deleting floors                                                  */
/* -------------------------------------------------------------------------- */

/** Open the Browse menu and expand one building's section. */
async function expandBuilding(page, building) {
    await page.click('#building-browse summary');
    await page.click(`[data-category="${building}"] > summary`);
}

/**
 * Press Add floor, which is at the foot of the building's section and so needs it open.
 *
 * Adding closes the menu and relists the buildings, and a building is listed collapsed,
 * so each of these starts from the menu being shut.
 */
async function addFloor(page, building) {
    await expandBuilding(page, building);
    await page.click(`[data-category="${building}"] > .file-panel-footer .file-panel-action`);
}

/** And Add layout, at the foot of one storey's section inside it. */
async function addLayout(page, building, storey) {
    await expandBuilding(page, building);
    await page.click(
        `[data-subcategory="${building}/${storey}"] > .file-panel-footer .file-panel-action`);
}

test('a building the mod owns can be given a floor', async ({ page }) => {
    await openBuildingFlow(page);

    await addFloor(page, 'MyTower');

    // Named after the building, because a floor's name is what the building refers to
    // it by rather than anything a player sees.
    await expect.poll(() => listDir(page, 'Plugins/MyTower/Floors'))
        .toEqual(['MyTower_Floor1.json', 'MyTower_Ground.json']);

    // A setting of its own: blueprints sharing one setting are variants of the same
    // storey, which is not what another floor is.
    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/MyTower.sodso.json'));
    expect(preset.floorLayouts).toHaveLength(2);
    expect(preset.floorLayouts[1].blueprints).toEqual(['FLOOR:Floors/MyTower_Floor1']);

    // And it is opened, because there is nothing else to do with a floor that has just
    // been made.
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor1/);
});

test('a new floor is a lobby that can be painted straight away', async ({ page }) => {
    await openBuildingFlow(page);

    await addFloor(page, 'MyTower');
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor1/);

    // No gaps, no overlaps, no half-built walls -- the three things the editor reports
    // on a floor it has opened.
    await expect(page.locator('#building-open-issues')).toHaveClass(/hidden/);

    const floor = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Floor1.json'));
    expect(floor.a_d.map((address) => address.p_n)).toEqual(['Outside', 'Lobby']);

    // The margin the city leaves, and the lot inside it.
    const [outside, lobby] = floor.a_d.map((address) => address.vs[0].r_d[0].n_d.length);
    expect(outside).toBe(21 * 21 - 15 * 15);
    expect(lobby).toBe(15 * 15);
});

test('a second floor does not take the first one\'s name', async ({ page }) => {
    await openBuildingFlow(page);

    await addFloor(page, 'MyTower');
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor1/);

    await addFloor(page, 'MyTower');
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor2/);

    await expect.poll(() => listDir(page, 'Plugins/MyTower/Floors'))
        .toEqual(['MyTower_Floor1.json', 'MyTower_Floor2.json', 'MyTower_Ground.json']);
});

test('a floor can be given another layout of itself', async ({ page }) => {
    await openBuildingFlow(page);

    // The mod's building has one storey, holding one layout: floorLayouts[0].
    await addLayout(page, 'MyTower', 'f0');

    // Into the setting that was already there rather than a new one. Blueprints in one
    // setting are the layouts the game picks between for that storey, which is what
    // another layout of a floor means.
    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/MyTower.sodso.json'));
    expect(preset.floorLayouts).toHaveLength(1);
    expect(preset.floorLayouts[0].blueprints)
        .toEqual(['FLOOR:Floors/MyTower_Ground', 'FLOOR:Floors/MyTower_Floor0_v1']);

    // Named after the storey it is a layout of. The next free floor number would name a
    // floor the building does not have.
    await expect.poll(() => listDir(page, 'Plugins/MyTower/Floors'))
        .toEqual(['MyTower_Floor0_v1.json', 'MyTower_Ground.json']);

    // And opened, like any other floor that has just been made.
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor0_v1/);
});

test('the menu lists a building as its floors, and each floor as its layouts', async ({ page }) => {
    await openBuildingFlow(page);
    await addLayout(page, 'MyTower', 'f0');
    await expandBuilding(page, 'MyTower');

    const storey = page.locator('[data-subcategory="MyTower/f0"]');

    // One storey, holding both layouts of it -- rather than two floors, which is what a
    // flat list of every blueprint said the building had.
    await expect(page.locator('[data-category="MyTower"] .file-panel-subcategory'))
        .toHaveCount(1);
    await expect(storey.locator('> summary .file-panel-summary-name'))
        .toHaveText('Floor 0 (2)');

    // Named by the blueprint alone: which storey it belongs to is the section it is in.
    await expect(storey.locator('.file-panel-entry .file-panel-name'))
        .toHaveText(['MyTower_Ground', 'MyTower_Floor0_v1']);

    // Open, unlike the buildings above them: the floors of the building you have just
    // opened are what you opened it to see.
    await expect(storey).toHaveAttribute('open', '');
});

test('a floor can be deleted from the building that names it', async ({ page }) => {
    await openBuildingFlow(page);
    await expandBuilding(page, 'MyTower');

    await page.click('[data-category="MyTower"] .file-panel-entry .file-panel-action');

    // Both halves: the file, and the reference to it. Either left on its own is a
    // building naming a floor that is not there, or a file nothing loads.
    await expect.poll(() => listDir(page, 'Plugins/MyTower/Floors')).toEqual([]);

    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/MyTower.sodso.json'));

    // The setting went with its last blueprint: floorsWithThisSetting means "the next N
    // floors look like this", so an empty one is not a floor with nothing in it.
    expect(preset.floorLayouts ?? []).toEqual([]);
});

test('deleting the open floor closes it', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'MyTower_Ground');
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Ground/);

    await expandBuilding(page, 'MyTower');
    await page.click('[data-category="MyTower"] .file-panel-entry .file-panel-action');

    // Left open, the debounced save would write the floor back out moments after the
    // file was removed.
    await expect(page.locator('#building-open-name')).toHaveText('No floor open');
    await expect.poll(() => readFile(page, 'Plugins/MyTower/Floors/MyTower_Ground.json'))
        .toBeNull();
});

test('a floor no building uses can be deleted on its own', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/Floors/Stranded.json': JSON.stringify({
            floorName: 'Stranded', a_d: [], t_d: [],
        }),
    });

    await expandBuilding(page, 'unused-floors');
    await page.click('[data-category="unused-floors"] .file-panel-action');

    await expect.poll(() => listDir(page, 'Plugins/MyTower/Floors'))
        .toEqual(['MyTower_Ground.json']);
});

test('the base game\'s buildings offer neither', async ({ page }) => {
    await openBuildingFlow(page);
    await expandBuilding(page, 'Hotel');

    // A base game building has to become a stub in the mod before its floor list is
    // anything this app can write, and doing that from a delete button would be a mod
    // gaining a building it never asked for.
    await expect(page.locator('[data-category="Hotel"] .file-panel-action')).toHaveCount(0);
});


/* -------------------------------------------------------------------------- */
/* Adding a building                                                           */
/* -------------------------------------------------------------------------- */

/** Open the Add building dialog the way the button does. */
async function openAddBuilding(page) {
    await page.click('#building-browse summary');
    await page.click('#new-building-button');
    await expect(page.locator('#new-building-modal')).toHaveAttribute('open', '');
}

/**
 * Submit the dialog, and wait for the building to reach the panel.
 *
 * The click returns as soon as the handler yields, which is well before the two files
 * are written -- and the dialog closes before them too, so its going away says nothing
 * about whether anything is on disk. Listing the building is the last thing the flow
 * does, so it is the point at which what was asked for has actually happened.
 */
async function submitAddBuilding(page, presetName) {
    await page.click('#new-building-submit');
    await expect(page.locator(`[data-category="${presetName}"]`)).toBeAttached();
}

/** The mod's room names CSV, which is the one place a building's title is used. */
const ROOM_NAMES = 'Plugins/MyTower/DDSContent/Strings/English/names.rooms.csv';

test('a new building can copy from a base game one', async ({ page }) => {
    await openBuildingFlow(page);
    await openAddBuilding(page);

    await page.fill('#new-building-title', 'Grand Hotel');
    await page.selectOption('#new-building-copy-from', 'Hotel');

    // The preset name is what a file name and a REF both allow, so it follows the title
    // with what neither of them would take stripped out.
    await expect(page.locator('#new-building-preset-name')).toHaveValue('GrandHotel');

    await submitAddBuilding(page, 'GrandHotel');

    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/GrandHotel.sodso.json'));
    expect(preset.presetName).toBe('GrandHotel');
    expect(preset.name).toBe('Grand Hotel');
    expect(preset.copyFrom).toBe('REF:BuildingPreset|Hotel');

    // It takes the Hotel's floor list, so its slots are there to be edited into.
    expect(preset.floorLayouts).toHaveLength(8);

    await expect(page.locator('[data-category="GrandHotel"] > summary .file-panel-summary-name'))
        .toHaveText('GrandHotel (12)');

    // Under Custom, which is what says it is the mod's rather than the Hotel it copied.
    await expect(page.locator('#building-file-list > *').nth(1))
        .toHaveAttribute('data-category', 'GrandHotel');
});

test('a new building is named in the mod\'s manifest', async ({ page }) => {
    await openBuildingFlow(page);
    await openAddBuilding(page);

    await page.fill('#new-building-title', 'Grand Hotel');
    await submitAddBuilding(page, 'GrandHotel');

    // Without this the preset sits in the folder and the loader never reads it, which
    // in game is a building that is simply not in the city. The mod had no manifest, so
    // one is written for it -- see core/murderManifest.js.
    await expect.poll(async () => {
        const raw = await readFile(page, 'Plugins/MyTower/murdermanifest.sodso.json');
        return raw ? JSON.parse(raw).fileOrder : null;
    }).toEqual(['REF:GrandHotel']);
});

test('a new building\'s title is written where the game reads it from', async ({ page }) => {
    await openBuildingFlow(page);
    await openAddBuilding(page);

    await page.fill('#new-building-title', 'Grand Hotel');
    await submitAddBuilding(page, 'GrandHotel');

    // Keyed by the preset name, because that is what the game has in hand when it wants
    // a building's readable name. Without this row it shows the preset name instead.
    expect(await readFile(page, ROOM_NAMES)).toContain('"GrandHotel",,"Grand Hotel",');
});

test('a building of its own copies from nothing', async ({ page }) => {
    await openBuildingFlow(page);
    await openAddBuilding(page);

    // None is the default, so this is the answer given by not answering.
    await expect(page.locator('#new-building-copy-from')).toHaveValue('');

    await page.fill('#new-building-title', 'Thing');
    await submitAddBuilding(page, 'Thing');

    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/Thing.sodso.json'));
    expect(preset.copyFrom).toBe(null);
});

test('the preset name can differ from the title', async ({ page }) => {
    await openBuildingFlow(page);
    await openAddBuilding(page);

    await page.fill('#new-building-title', 'Grand Hotel');
    await page.fill('#new-building-preset-name', 'MyMod_GrandHotel');

    // Typed into, so it stops following the title from here on.
    await page.fill('#new-building-title', 'Grander Hotel');
    await expect(page.locator('#new-building-preset-name')).toHaveValue('MyMod_GrandHotel');

    await submitAddBuilding(page, 'MyMod_GrandHotel');

    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/MyMod_GrandHotel.sodso.json'));
    expect(preset.presetName).toBe('MyMod_GrandHotel');
    expect(preset.name).toBe('Grander Hotel');

    expect(await readFile(page, ROOM_NAMES)).toContain('"MyMod_GrandHotel",,"Grander Hotel",');
});

test('a preset name that would not work as a file name cannot be submitted', async ({ page }) => {
    await openBuildingFlow(page);
    await openAddBuilding(page);

    await page.fill('#new-building-title', 'Grand Hotel');
    await page.fill('#new-building-preset-name', 'Grand Hotel');
    await page.click('#new-building-submit');

    // Refused by the field rather than by an alert, so the dialog stays put with the
    // answer in it to be corrected. Nothing is written.
    const valid = await page.locator('#new-building-preset-name')
        .evaluate((input) => input.checkValidity());
    expect(valid).toBe(false);

    await expect(page.locator('#new-building-modal')).toHaveAttribute('open', '');
    expect(await listDir(page, 'Plugins/MyTower')).not.toContain('Grand Hotel.sodso.json');
});

test('a building with a name the mod already uses is refused', async ({ page }) => {
    await openBuildingFlow(page);
    await openAddBuilding(page);

    await page.fill('#new-building-title', 'MyTower');
    await page.click('#new-building-submit');

    // Polled, because the name is checked against what is on disk: the click returns
    // while that listing is still being read, and the alert comes after it.
    await expect.poll(() => alerts(page))
        .toContain('This mod already has a building called "MyTower".');

    // Still open, with what was typed still in it: the answer needs changing, not
    // giving again.
    await expect(page.locator('#new-building-modal')).toHaveAttribute('open', '');
    await expect(page.locator('#new-building-title')).toHaveValue('MyTower');
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
    expect(files.sort()).toEqual(['Floors', 'SecondTower.sodso.json', 'murdermanifest.sodso.json']);

    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/SecondTower/SecondTower.sodso.json'));
    expect(preset.fileType).toBe('BuildingPreset');
    expect(preset.name).toBe('SecondTower');

    // The manifest is what makes the loader read the preset at all, so the folder is
    // not laid out without one.
    const manifest = JSON.parse(
        await readFile(page, 'Plugins/MyTower/SecondTower/murdermanifest.sodso.json'));
    expect(manifest.fileOrder).toEqual(['REF:SecondTower']);

    // The Floors directory is what marks the folder as holding buildings, so it exists
    // from the start rather than appearing with the first floor.
    const described = await page.evaluate(async () => {
        const { findContentFolders, describeContentFolder } = await import('/core/modFolders.js');
        const plugins = await window.__opfsDir('Plugins', false);
        const mod = await plugins.getDirectoryHandle('MyTower');
        return (await findContentFolders(mod)).map(describeContentFolder);
    });

    // "case" is what a manifest reads as, and a building mod written here has one --
    // see core/murderManifest.js. What matters to this flow is the "building" half,
    // which is the Floors directory.
    expect(described).toContain('SecondTower — case + building');
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

    // `data-flow-ready` is set when the flow's markup, styles and reference data are in
    // place, which is before the session is put back: reopening the floor reads it again
    // and builds a view for it, and only then is there a name to show. Longer than the
    // default because that is seconds of work under a full parallel run, and waiting for
    // it is the point of this test rather than an incidental delay in it.
    await expect(page.locator('#building-open-name'))
        .toHaveText('Twin — MyTower', { timeout: 20_000 });

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
