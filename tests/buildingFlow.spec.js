import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, gotoFlow, connectFolders, selectContent,
    readFile, listDir, queuePrompts, alerts, writeFixture,
} from '../test-support/harness.js';

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
    // What makes this folder a building folder: the manifest names the preset. Without
    // it the loader would not read the preset and the shell would not offer the folder
    // -- see core/modFolders.js.
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

/** Click a square, which in None selects it and fills the column from it. */
const selectSquare = (page, x, y) => page.evaluate(async ([cellX, cellY]) => {
    const { projectCell } = await import('/flows/building/scripts/ui.js');
    const canvas = document.querySelector('#building-canvas canvas');
    const at = projectCell(cellX, cellY);

    const send = (type, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, button: 0, buttons, bubbles: true, clientX: at.left, clientY: at.top,
    }));

    send('pointermove', 0);
    send('pointerdown', 1);
    send('pointerup', 0);
}, [x, y]);

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

    // Help is reached through Tools, the menu on the right of the bar that every flow
    // carries. Picking from it shuts it, so the modal is not read through an open menu.
    await page.click('#tools-menu > summary');
    await page.locator('#tools-menu .browse-menu-item', { hasText: 'Help/Summary' }).click();
    await expect(help).toHaveAttribute('open', '');
    await expect(page.locator('#tools-menu')).not.toHaveAttribute('open', '');

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
    await expect(tools).toContainText('Left click to select a square');
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

/*
 * The mod's own furniture, in the answers.
 *
 * Without the overlay every answer here is the base game's, which for a mod is not merely
 * incomplete but wrong: a mod's own cluster makes furniture placeable that the walk would
 * call impossible. This is the shape of the bookcase office from HOW-IT-WORKS.md -- a
 * class, a preset that fills it, and a cluster that puts the slot down -- and none of the
 * three exists in the reference data.
 */

/** MyTower, plus the three assets an office bookcase needs, plus one the manifest omits. */
const modWithFurniture = {
    ...modWithBuilding,

    'Plugins/MyTower/murdermanifest.sodso.json': json({
        enabled: true,
        fileOrder: [
            'REF:MyTower', 'REF:My1x1OfficeBookcase', 'REF:MyOfficeBookcase',
            'REF:MyBookcaseIsland',
        ],
        loadBefore: '',
        version: 1,
    }),

    // A slot class shaped like a cubicle, so it can stand free in the middle of a floor
    // rather than needing a wall the way every real bookcase class does.
    'Plugins/MyTower/My1x1OfficeBookcase.sodso.json': json({
        presetName: 'My1x1OfficeBookcase',
        fileType: 'FurnitureClass',
        copyFrom: 'REF:FurnitureClass|1x1OfficeCubicle',
    }),

    // The model, redirected at that class and given the room filters and design style it
    // needs to reach an office. Cloning LargeBookcase brings neither.
    'Plugins/MyTower/MyOfficeBookcase.sodso.json': json({
        presetName: 'MyOfficeBookcase',
        fileType: 'FurniturePreset',
        copyFrom: 'REF:FurniturePreset|LargeBookcase',
        classes: ['REF:FurnitureClass|My1x1OfficeBookcase'],
        universalDesignStyle: true,
        allowedRoomFilters: ['REF:RoomTypeFilter|OfficeSpace'],
    }),

    // And the arrangement that puts the slot down. Without this the preset has nowhere
    // to go however well it suits the room.
    'Plugins/MyTower/MyBookcaseIsland.sodso.json': json({
        presetName: 'MyBookcaseIsland',
        fileType: 'FurnitureCluster',
        allowedRoomFilters: ['REF:RoomTypeFilter|OfficeSpace'],
        minimumRoomSize: 6,
        clusterElements: [
            { furnitureClass: 'REF:FurnitureClass|My1x1OfficeBookcase', importantToCluster: true },
        ],
    }),

    // In the folder and not in the manifest, so the game never reads it.
    'Plugins/MyTower/MyForgottenSofa.sodso.json': json({
        presetName: 'MyForgottenSofa',
        fileType: 'FurniturePreset',
        copyFrom: 'REF:FurniturePreset|LargeBookcase',
    }),
};

test('the mod\'s own furniture is in the answers, and the manifest decides', async ({ page }) => {
    await openBuildingFlow(page, modWithFurniture);

    // An OfficeSpace square in the middle of the floor: no walls, so the base game offers
    // it four presets and every wall piece is out.
    await open(page, 'EdenTower', 'Eden_OfficeFloor01');
    await selectSquare(page, 4, 12);

    const selected = page.locator('#building-status .status-block').first();

    // Three assets reached the chain. The fourth is in the folder and not in fileOrder,
    // which is the failure that otherwise shows up as content missing from the city.
    await expect(selected.locator('.furniture-source'))
        .toHaveText("Including this mod's own assets: 3 added.");
    await expect(selected.locator('.furniture-unlisted'))
        .toHaveText('1 file in this mod is not named in murdermanifest.sodso.json, so the '
            + 'game never loads it and nothing below counts it.');

    // Asked through the control rather than by writing to the `<select>` behind it: one
    // of the two names below is deliberately not an option, and inventing it is the
    // control's job.
    const ask = async (name) => {
        await selected.locator('.select2-selection').click();

        // Typed rather than filled. select2 searches on the keystrokes, so setting the
        // field's value outright leaves the list unfiltered -- and Enter then takes
        // whatever was already highlighted instead of what was asked for.
        await page.locator('.select2-search__field').pressSequentially(name);
        await page.locator('.select2-results__option--highlighted').click();
    };

    // The mod's own are offered first, under a heading of their own. Two of the three
    // assets that reached the chain are furniture presets; the third is a slot class.
    await selected.locator('.select2-selection').click();
    await expect(page.locator('.furniture-check-dropdown .select2-results__group').first())
        .toHaveText('Modded');
    await expect(page.locator(
        '.furniture-check-dropdown .select2-results__group:text-is("Modded") + * > *'))
        .toHaveText(['MyOfficeBookcase']);
    await page.locator('.select2-search__field').press('Escape');

    // The verdict the whole overlay exists for. Against the base game alone this is
    // "The base game has no furniture preset called MyOfficeBookcase."
    await ask('MyOfficeBookcase');

    const office = selected.locator('.verdict').first();
    await expect(office.locator('.verdict-address')).toHaveText('HighriseOffice');
    await expect(office.locator('.verdict-answer')).toHaveText('Possible');

    // And it is in the list above, under the mod's own slot class -- the same walk, so
    // the two cannot disagree.
    await selected.locator('.furniture-group summary').first().click();
    await expect(selected.locator('.furniture-class', { hasText: 'My1x1OfficeBookcase' }))
        .toHaveCount(1);

    // The unlisted one is answerable and is not in the chain, which is the honest
    // reading: the game would not load it either. It is not on the list for the same
    // reason, so this is also what proves a name nobody offered can still be asked about.
    await ask('MyForgottenSofa');
    await expect(selected.locator('.verdict-reason').first())
        .toHaveText('The base game has no furniture preset called MyForgottenSofa.');
});

/**
 * The page does not scroll, and opening a dropdown does not make it.
 *
 * The workspace sizes itself to the window and the columns scroll inside it, so there is
 * never anything below the fold to reach -- a scrolled page here is the layout coming
 * apart, and it did: select2 leaves the `<select>` it took over in the document as an
 * absolutely positioned one-pixel box for screen readers, and moves focus to it on open.
 * Unless the column it is in is positioned, that box keeps the place the column's
 * unscrolled flow gave it, and the browser scrolls the page down to wherever it landed.
 *
 * Asserted on the document rather than on the dropdown, because what went wrong was the
 * page and not the control: the columns and the canvas went up with it. See the note on
 * `#building-left` in the flow's stylesheet.
 *
 * The status column is scrolled to its foot first, which is both where the checker is and
 * what makes the stranding as bad as it gets -- an unscrolled column cannot show this.
 */
test('opening the checker does not scroll the page', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'EdenTower', 'Eden_OfficeFloor01');
    await selectSquare(page, 4, 12);

    const column = page.locator('#building-left');
    await expect(page.locator('.furniture-check .select2-selection')).toBeVisible();
    await column.evaluate((el) => { el.scrollTop = el.scrollHeight; });

    // Nothing to scroll to before the dropdown is opened, either: the hidden `<select>`s
    // of every control already in the columns are what would make the page taller.
    const fits = () => page.evaluate(() => {
        const page_ = document.documentElement;
        return { overflow: page_.scrollHeight - page_.clientHeight, scrolled: window.scrollY };
    });
    expect(await fits()).toEqual({ overflow: 0, scrolled: 0 });

    await page.locator('.furniture-check .select2-selection').click();
    await expect(page.locator('.furniture-check-dropdown')).toBeVisible();
    expect(await fits()).toEqual({ overflow: 0, scrolled: 0 });

    // And the dropdown is under the control it was opened from, which is the thing the
    // page scrolling used to take away: it went up with the page and the control did not.
    const [control, dropdown] = await Promise.all([
        page.locator('.furniture-check .select2-selection').boundingBox(),
        page.locator('.furniture-check-dropdown').boundingBox(),
    ]);
    expect(Math.abs(dropdown.y - (control.y + control.height))).toBeLessThan(2);

    // Typing re-renders the list and repositions the dropdown, which is the other moment
    // the page moved.
    await page.locator('.select2-search__field').pressSequentially('Large');
    await expect(page.locator('.furniture-check-dropdown .select2-results__option').first())
        .toBeVisible();
    expect(await fits()).toEqual({ overflow: 0, scrolled: 0 });
});

/**
 * A save does not take an open dropdown away.
 *
 * Every edit starts a 600ms autosave, and a save ends in `refreshPanel`, which redraws
 * every panel in the right column -- and a redraw has to shut the controls in it before
 * it detaches them, or the column loses its scrolling for good. So a list opened in the
 * second after any edit was closed under the pointer, for a write that changed nothing
 * the list shows. The redraw waits for the list instead; see pendingPanels in panels.js.
 *
 * `saveFloor(true)` rather than an edit and a wait: it is the same call the timer makes,
 * without a second of the test spent proving that setTimeout works.
 */
test('a save under an open dropdown leaves it open', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'EdenTower', 'Eden_OfficeFloor01');

    const control = page.locator('#building-rooms .select2-selection').first();
    await expect(control).toBeVisible();
    await control.click();
    await expect(page.locator('#building-rooms .select2-container--open')).toHaveCount(1);

    /*
     * Whether the rows standing in the panel are the ones that were there before.
     *
     * A redraw builds new ones, so a mark put on the old ones says which happened: still
     * there and the redraw was held, gone and it has run. Nothing the panel displays
     * would answer this -- a save changes what is on disk, and the point of the fix is
     * that it changes nothing the room list shows.
     */
    const mark = () => page.locator('#building-rooms .room-row').first()
        .evaluate((row) => { row.dataset.beforeSave = 'yes'; });
    const marked = () => page.locator('#building-rooms .room-row[data-before-save]').count();

    await mark();

    const save = () => page.evaluate(async () => {
        const { saveFloor } = await import('/flows/building/scripts/ui.js');
        await saveFloor(true);
    });

    await save();
    await expect(page.locator('#building-rooms .select2-container--open')).toHaveCount(1);
    expect(await marked()).toBe(1);

    // Held, not dropped: shutting the list runs it, and the rows it left are new ones.
    await page.locator('.select2-search__field').press('Escape');
    await expect(page.locator('#building-rooms .select2-container--open')).toHaveCount(0);
    await expect.poll(marked).toBe(0);

    // And the column still scrolls, which is the thing closing before a redraw protects:
    // a control detached while its dropdown was open leaves select2's scroll handlers
    // bound to this column for the life of the page.
    const column = page.locator('#building-panels');
    await column.evaluate((el) => { el.scrollTop = 40; });
    expect(await column.evaluate((el) => el.scrollTop)).toBe(40);

    // The held redraw ran once and left the panel usable rather than half-built.
    await expect(page.locator('#building-rooms .select2-selection')).toHaveCount(
        await page.locator('#building-rooms .room-row').count());
});

/**
 * A category heading sits on the items under it, and does so the same way in every list.
 *
 * Three kinds of list are on this screen at once -- the checker's dropdown, headed by
 * `<optgroup>`; the furniture list, headed by a `<summary>`; and the Browse menu, headed
 * by two levels of them -- and they had drifted a long way apart, mostly by each undoing
 * as much of Pico's `details[open] > summary { margin-bottom: 1rem }` as somebody had
 * noticed at the time. The furniture list still had all of it.
 *
 * Asserted as relationships rather than as pixel counts, because what is worth keeping is
 * that they agree: the numbers are set in `em` against lists at three different sizes.
 * See --list-heading-gap in core/chrome.css.
 */
test('a category heading sits on its items, the same way in every list', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'EdenTower', 'Eden_OfficeFloor01');
    await selectSquare(page, 4, 12);

    /** The space between a heading's box and the first item's, which should be none. */
    const gapUnder = (heading, item) => page.evaluate(([headSel, itemSel]) => {
        const head = document.querySelector(headSel);
        const first = document.querySelector(itemSel);
        return Math.round(
            (first.getBoundingClientRect().top - head.getBoundingClientRect().bottom) * 10) / 10;
    }, [heading, item]);

    // The dropdown, which is the one the others are modelled on.
    await page.locator('.furniture-check .select2-selection').click();
    await expect(page.locator('.furniture-check-dropdown')).toBeVisible();
    expect(await gapUnder(
        '.furniture-check-dropdown .select2-results__group',
        '.furniture-check-dropdown .select2-results__group + * > *')).toBe(0);
    await page.locator('.select2-search__field').press('Escape');

    // The furniture list, where Pico's whole 1rem used to stand between an address preset
    // and the first thing that could spawn under it.
    await page.locator('#building-status .furniture-group summary').first().click();
    expect(await gapUnder(
        '#building-status .furniture-group[open] > summary',
        '#building-status .furniture-group[open] .furniture-row')).toBe(0);

    // And the Browse menu's two levels, which have to agree with each other: a building's
    // first floor stands off its name as far as a floor's first layout stands off the
    // floor's, and no further.
    await page.locator('#building-browse > summary').click();
    await page.evaluate(() => {
        for (const details of document.querySelectorAll('.browse-menu details')) details.open = true;
    });

    const levels = await page.evaluate(() => {
        const under = (details) => {
            const summary = details.querySelector(':scope > summary');
            const next = summary.nextElementSibling;
            const first = next.matches('ul') ? next.firstElementChild : next;
            return Math.round(
                (first.getBoundingClientRect().top - summary.getBoundingClientRect().bottom) * 10) / 10;
        };
        return {
            category: under(document.querySelector('.browse-menu .file-panel-category')),
            subcategory: under(document.querySelector('.browse-menu .file-panel-subcategory')),
        };
    });
    expect(levels.category).toBe(levels.subcategory);
});

/**
 * The problems block, which is about the mod rather than about a square.
 *
 * `MyBookcaseIsland` is gated only by `allowedRoomFilters: OfficeSpace`, and the preset
 * filling its slot sets neither `allowedInAddressesOfType` nor `allowedInBuildings` -- so
 * it is offered to every office in the city rather than to this mod's tower. Nothing at
 * run time reports that.
 *
 * Checked before any square is selected on purpose. That is the whole reason it is not a
 * note inside the furniture section, which returns early with nothing selected.
 */
test('a mod whose cluster reaches the whole city is told so before anything is clicked',
    async ({ page }) => {
        await openBuildingFlow(page, modWithFurniture);
        await open(page, 'EdenTower', 'Eden_OfficeFloor01');

        const problems = page.locator('#building-status .mod-problems');

        await expect(problems.locator('header')).toHaveText('A problem in this mod');
        await expect(problems.locator('.mod-problem')).toHaveCount(1);
        await expect(problems.locator('.mod-problem')).toHaveClass(/degrades/);

        const text = problems.locator('.mod-problem');
        await expect(text).toContainText('MyBookcaseIsland is gated only by room filters');
        await expect(text).toContainText('OfficeSpace');
        await expect(text).toContainText('MyOfficeBookcase');

        // Still there once a square is selected, and still above the selection.
        await selectSquare(page, 4, 12);
        await expect(problems.locator('.mod-problem')).toHaveCount(1);
    });

test('a mod with nothing wrong with it gets no problems block', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'EdenTower', 'Eden_OfficeFloor01');
    await selectSquare(page, 4, 12);

    await expect(page.locator('#building-status .mod-problems')).toHaveCount(0);
});

test('choosing a mod with no furniture of its own says nothing about one', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'EdenTower', 'Eden_OfficeFloor01');
    await selectSquare(page, 4, 12);

    const selected = page.locator('#building-status .status-block').first();

    // The ordinary case, and no line for it.
    await expect(selected.locator('.furniture-source')).toHaveCount(0);
    await expect(selected.locator('.furniture-unlisted')).toHaveCount(0);
});

/**
 * Clicking a square selects it, and the whole column follows.
 *
 * What each part says is covered where it lives -- the pick in tools.unit.spec.js, the
 * chain in furnitureChain.unit.spec.js, the blocks in buildingPanels.spec.js. What only
 * this can check is that a real click on the canvas joins them up: a floor opens in None,
 * so the click reads rather than writes, and one click has to fill all five rows and put
 * the furniture under them. The mark it puts on the floor is the scene's, and is checked
 * in buildingScene.spec.js where the scene can be driven directly.
 */
test('a click in none selects the square, and the column follows it', async ({ page }) => {
    await openBuildingFlow(page);

    // A CorporateLobby, which two address presets compete for -- so the grouping is
    // exercised rather than merely the heading.
    await open(page, 'EdenTower', 'Eden_OfficeFloor01');

    await page.evaluate(async () => {
        const { projectCell } = await import('/flows/building/scripts/ui.js');
        const canvas = document.querySelector('#building-canvas canvas');
        const at = projectCell(10, 10);

        const send = (type, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
            pointerId: 1, button: 0, buttons, bubbles: true,
            clientX: at.left, clientY: at.top,
        }));

        send('pointermove', 0);
        send('pointerdown', 1);
        send('pointerup', 0);
    });

    // The top block is the square that was clicked, not a brush.
    const selected = page.locator('#building-status .status-block').first();
    await expect(selected.locator('header:not(.furniture-header) strong'))
        .toHaveText('Selected square');
    await expect(selected.locator('.status-note').first()).toHaveText('Node 10, 10');

    // All five rows filled from that one click, whichever tool is active -- a floor
    // opens with the address tool, which used to be the only value a pick took.
    for (const type of ['address', 'room', 'floorType', 'tile']) {
        await expect(selected.locator(`.status-row[data-type="${type}"] .status-value`))
            .not.toHaveText('—');
    }

    // And the furniture, under the selection. The fetch it needs is not awaited by
    // openFloor, so this appearing is it resolving and redrawing the column by itself.
    await expect(selected.locator('.furniture-header')).toHaveText('Furniture');
    await expect(selected.locator('.furniture-group')).toHaveCount(2);

    // Collapsed, and opened by the summary rather than by anything else on the column.
    // The rows are absent rather than merely hidden: a closed `<details>` keeps its
    // contents, and this column is rebuilt on every pointer move.
    const group = selected.locator('.furniture-group').first();
    await expect(group.locator('.furniture-row')).toHaveCount(0);
    await group.locator('summary').click();
    expect(await group.locator('.furniture-row').count()).toBeGreaterThan(0);
});

/**
 * A selection belongs to the floor it was made on.
 *
 * Node 10,10 exists on every blueprint and is a different room in a different address on
 * each, so a selection carried across is a coordinate being passed off as a place. The
 * view has to be told as well as the tool state -- `setModel` re-places the mark rather
 * than clearing it, because a layout variation switch rebuilds the grid under a selection
 * that should survive that.
 */
test('opening another floor clears the selection', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'EdenTower', 'Eden_OfficeFloor01');

    await page.evaluate(async () => {
        const { projectCell } = await import('/flows/building/scripts/ui.js');
        const canvas = document.querySelector('#building-canvas canvas');
        const at = projectCell(10, 10);

        const send = (type, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
            pointerId: 1, button: 0, buttons, bubbles: true,
            clientX: at.left, clientY: at.top,
        }));

        send('pointermove', 0);
        send('pointerdown', 1);
        send('pointerup', 0);
    });

    const marked = () => page.evaluate(async () => {
        const { markedSquare } = await import('/flows/building/scripts/ui.js');
        return markedSquare();
    });

    const selected = page.locator('#building-status .status-block').first();
    await expect(selected.locator('.status-note').first()).toHaveText('Node 10, 10');
    await expect(selected.locator('.furniture-group')).toHaveCount(2);
    expect(await marked()).toEqual({ x: 10, y: 10 });

    // Another floor of the same building, through the same view -- which is the case
    // that broke: ensureView keeps the scene, and setModel re-places the mark rather
    // than clearing it, so the mark stayed on the new floor at the old coordinates
    // while the panel said nothing was selected.
    await open(page, 'EdenTower', 'Eden_OfficeFloor02');

    expect(await marked()).toBeNull();

    await expect(selected.locator('header:not(.furniture-header) strong'))
        .toHaveText('Selected square');
    await expect(selected.locator('.status-note').first())
        .toHaveText('Click a square to select it');

    // The five rows go back to dashes, and the furniture goes with them: it hung off a
    // square of the floor that was open.
    await expect(selected.locator('.status-row[data-type="address"] .status-value'))
        .toHaveText('—');
    await expect(selected.locator('.furniture-group')).toHaveCount(0);
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
    const stub = JSON.parse(await readFile(page, 'Plugins/MyTower/Hotel.BuildingPreset.sodso.json'));
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
/* A building that is not there                                                */
/* -------------------------------------------------------------------------- */

/**
 * A floor is saved against the building that names it, and the building is found by name.
 * A name with nothing behind it therefore has to stop the save reaching a preset at all --
 * because the alternative, once, was writing one: a stub copying from its own name, with
 * the slot being saved as its only floor, over whatever file the name landed on.
 *
 * Two moments to refuse at, and both are needed. The name can be wrong when the floor is
 * opened, which is where a restored session's is checked, and the file can go bad while the
 * floor is open, which no check at opening can see.
 */

/** Paint one wall and write, which is what puts a floor and its building on disk. */
const paintAndSave = (page) => page.evaluate(async () => {
    const { saveNow, openFloorModel } = await import('/flows/building/scripts/ui.js');
    const model = await import('/flows/building/scripts/floorModel.js');

    model.setWall(openFloorModel(), 9, 9, model.AXIS_X, '16');
    await saveNow();
});

const GROUND_SLOT = { isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0 };

test('a floor opened against a building that is not there is opened on its own', async ({ page }) => {
    await openBuildingFlow(page);

    // A name nothing answers to, which is what a restored session hands over when the
    // content folder that came back is not the one its URL named.
    await open(page, 'GhostTower', 'MyTower_Ground', GROUND_SLOT);

    expect(await alerts(page)).toContain(
        'Could not find a building called "GhostTower", so "MyTower_Ground" has been opened '
        + 'on its own. Saving it will not change any building.');

    await paintAndSave(page);

    // The floor is written. It is a file in its own right and the drawing is not lost.
    const floor = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Ground.json'));
    expect(floor.a_d.length).toBeGreaterThan(0);

    // No building was invented for the name, and the real one is untouched by it.
    expect(await readFile(page, 'Plugins/MyTower/GhostTower.BuildingPreset.sodso.json')).toBeNull();
    expect(JSON.parse(await readFile(page, 'Plugins/MyTower/MyTower.sodso.json')).copyFrom).toBeNull();
});

test('a building whose preset will not parse is not opened against either', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/BrokenTower.sodso.json': '{ this is not json',
    });

    await open(page, 'BrokenTower', 'MyTower_Ground', GROUND_SLOT);
    await paintAndSave(page);

    // Byte for byte. The text is the author's and may be one comma away from working;
    // replacing it with a stub is how a bad file becomes a lost building.
    expect(await readFile(page, 'Plugins/MyTower/BrokenTower.sodso.json')).toBe('{ this is not json');
});

test('a preset that goes bad while its floor is open is not written over', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'MyTower_Ground', GROUND_SLOT);

    // Behind the editor's back, which is how it happens: a sync conflict or a half-written
    // file landing in the folder while the floor it belongs to is on screen. Opening
    // checked the name and the name was good.
    await writeFixture(page, 'Plugins/MyTower/MyTower.sodso.json', '{ this is not json');

    await paintAndSave(page);

    expect(await readFile(page, 'Plugins/MyTower/MyTower.sodso.json')).toBe('{ this is not json');

    // The floor reached disk before the building was reached for, so the drawing survives
    // and the author is told which half did not.
    const floor = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Ground.json'));
    expect(floor.a_d.length).toBeGreaterThan(0);

    expect((await alerts(page)).join('\n')).toContain('could not be pointed at MyTower');
});

test('a mod floor that will not read does not open the base game\'s copy over it', async ({ page }) => {
    await openBuildingFlow(page);

    // A floor of the mod's named after a base game one, which is exactly what editing a
    // base game floor produces. The mod's copy is the one being worked on; the base game
    // still ships its own under that name.
    await writeFixture(page, 'Plugins/MyTower/Floors/Hotel_GroundFloor.json', '{ this is not json');

    await open(page, 'Hotel', 'Hotel_GroundFloor', GROUND_SLOT);

    // Falling through to the base game's copy would open a floor that looks right, and the
    // first stroke would autosave it over the author's.
    await expect(page.locator('#building-open-name')).toHaveText('No floor open');
    expect((await alerts(page)).join('\n')).toContain('Hotel_GroundFloor');

    expect(await readFile(page, 'Plugins/MyTower/Floors/Hotel_GroundFloor.json'))
        .toBe('{ this is not json');
});

/** Redraw the Browse menu from the folder, as every write ends by doing. */
const refreshBrowse = (page) => page.evaluate(async () => {
    const { refreshPanel } = await import('/flows/building/scripts/ui.js');
    await refreshPanel();
});

test('a preset repaired after a refused save takes its floor back, edits and all', async ({ page }) => {
    await openBuildingFlow(page);
    await open(page, 'MyTower', 'MyTower_Ground', GROUND_SLOT);

    const good = await readFile(page, 'Plugins/MyTower/MyTower.sodso.json');
    await writeFixture(page, 'Plugins/MyTower/MyTower.sodso.json', '{ this is not json');

    await paintAndSave(page);

    // Letting go of the building is an editor's answer to what it can reach, not an edit.
    // While the file will not parse the building is not listed at all, so its floor shows
    // as one no building uses -- which is what the folder says at that moment.
    await refreshBrowse(page);
    await expandBuilding(page, 'unused-floors');
    await expect(page.locator('[data-category="unused-floors"] .file-panel-name'))
        .toHaveText(['MyTower_Ground']);

    // Repairing the file is the whole of the recovery. The slot was never taken out of it,
    // because the save that could not read it never wrote to it either.
    await writeFixture(page, 'Plugins/MyTower/MyTower.sodso.json', good);
    await refreshBrowse(page);

    // expandBuilding opens the menu on its way in, so it has to be shut first.
    await page.click('#building-browse summary');
    await expandBuilding(page, 'MyTower');
    await expect(page.locator('[data-category="MyTower"] .file-panel-entry .file-panel-name'))
        .toHaveText(['MyTower_Ground']);

    // And opening it through the building gives back the context, with the stroke that was
    // painted while the building was unreachable still in the floor.
    await open(page, 'MyTower', 'MyTower_Ground', GROUND_SLOT);
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Ground.*MyTower/);

    const floor = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Ground.json'));
    const nodes = floor.a_d.flatMap((a) => a.vs).flatMap((v) => v.r_d).flatMap((r) => r.n_d);
    expect(nodes.find((n) => n.f_c.x === 9 && n.f_c.y === 9).w_d).toHaveLength(1);
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
    // storey immediately below it. Basement 1, not 0: the floor in that place is Floor 0.
    await down(page).click();
    await down(page).click();
    await expect(storey(page)).toHaveText('Basement 1');
    await expect(floorName(page)).toHaveText('Hotel_Basement1');

    // Nothing below the deepest basement to go to.
    await expect(down(page)).toBeDisabled();
    await expect(up(page)).toBeEnabled();
});

test('a floor setting covering several floors says which floors they are', async ({ page }) => {
    await openBuildingFlow(page);

    // Hotel's floorsWithThisSetting reads [1, 1, 1, 1, 1, 4, 1, 2], so its sixth setting
    // is four floors of the building and the two above it are the tenth and the top two.
    await open(page, 'Hotel', 'Hotel_TopFloors', slotAt(5));
    await expect(storey(page)).toHaveText('Floors 5–8');

    // Stepping up is one setting, which here is four floors of the building. The setting
    // list would have called this Floor 6.
    await up(page).click();
    await expect(storey(page)).toHaveText('Floor 9');
    await expect(floorName(page)).toHaveText('Hotel_RooftopBar');

    await up(page).click();
    await expect(storey(page)).toHaveText('Floors 10–11');
    await expect(up(page)).toBeDisabled();
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

    // The eighth setting, and the top two floors of a twelve storey building.
    await expect(storey(page)).toHaveText('Floors 10–11');
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
    await expect(storey(page)).toHaveText('Floors 5–8');
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

/** The dialog asking what a new storey starts as, and the answers it offers. */
const startDialog = (page) => page.locator('#add-storey-modal');
const startOption = (page, value) =>
    startDialog(page).locator(`input[name="storey-start"][value="${value}"]`);

/**
 * Answer that dialog.
 *
 * Passing nothing takes what it came up with, which is what an author who agrees with it
 * does -- and the only thing that can be done on a building with nothing to copy from,
 * where every other answer is disabled.
 */
async function chooseStoreyStart(page, start = null) {
    await expect(startDialog(page)).toHaveAttribute('open', '');
    if (start) await startOption(page, start).check();
    await page.click('#add-storey-submit');
}

/**
 * Press Add floor or Add basement, which are at the foot of the building's section and
 * so need the menu and the section open.
 *
 * Opened only where they are shut, rather than clicked at: adding closes the menu and
 * relists the buildings collapsed, but dismissing the dialog leaves both as they were --
 * and a click on an open section closes it, taking the button out of reach.
 */
async function openStoreyDialog(page, building, action) {
    const menu = page.locator('#building-browse');
    if (!await menu.evaluate((details) => details.open)) await page.click('#building-browse summary');

    const category = page.locator(`[data-category="${building}"]`);
    if (!await category.evaluate((details) => details.open)) {
        await category.locator('> summary').click();
    }

    await page.click(`[data-category="${building}"] > .file-panel-footer [data-action="${action}"]`);
}

/** Add a floor to the top of a building, saying what it starts as. */
async function addFloor(page, building, start = null) {
    await openStoreyDialog(page, building, 'add-floor');
    await chooseStoreyStart(page, start);
}

/** And a basement under the bottom of it. */
async function addBasement(page, building, start = null) {
    await openStoreyDialog(page, building, 'add-basement');
    await chooseStoreyStart(page, start);
}

/** And Add layout, at the foot of one storey's section inside it. It asks nothing. */
async function addLayout(page, building, storey) {
    await expandBuilding(page, building);
    await page.click(
        `[data-subcategory="${building}/${storey}"] > .file-panel-footer .file-panel-action`);
}

test('a building the mod owns can be given a floor', async ({ page }) => {
    await openBuildingFlow(page);

    await addFloor(page, 'MyTower');

    // The floor is opened last of all, so waiting for it is waiting for both files. Also
    // the point of the button: there is nothing else to do with a floor just made.
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor1/);

    // Named after the building, because a floor's name is what the building refers to
    // it by rather than anything a player sees.
    await expect.poll(() => listDir(page, 'Plugins/MyTower/Floors'))
        .toEqual(['MyTower_Floor1.json', 'MyTower_Ground.json']);

    // A setting of its own: blueprints sharing one setting are variants of the same
    // storey, which is not what another floor is.
    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/MyTower.sodso.json'));
    expect(preset.floorLayouts).toHaveLength(2);
    expect(preset.floorLayouts[1].blueprints).toEqual(['FLOOR:Floors/MyTower_Floor1']);
});

test('the first floor of a building is a lobby that can be painted straight away', async ({ page }) => {
    // A building with no floors at all: nothing under this one to take a shape from, so
    // it starts as the whole lot.
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/BareTower.sodso.json': json({
            name: 'BareTower',
            presetName: 'BareTower',
            type: 'BuildingPreset',
            fileType: 'BuildingPreset',
            copyFrom: null,
        }),
    });

    // There is nothing to copy from, so the dialog offers the one answer it can. Said
    // and dimmed rather than hidden: what the button offers is worth reading even where
    // most of it cannot be had yet.
    await expandBuilding(page, 'BareTower');
    await page.click('[data-category="BareTower"] > .file-panel-footer [data-action="add-floor"]');

    await expect(page.locator('#add-storey-source')).toHaveText(/no storeys yet/);
    for (const start of ['whole', 'fittings', 'outline']) {
        await expect(startOption(page, start)).toBeDisabled();
    }
    await expect(startOption(page, 'empty')).toBeChecked();
    await expect(startOption(page, 'empty')).toBeEnabled();

    await page.click('#add-storey-submit');
    await expect(page.locator('#building-open-name')).toHaveText(/BareTower_Floor1/);

    // No gaps, no overlaps, no half-built walls -- the three things the editor reports
    // on a floor it has opened.
    await expect(page.locator('#building-open-issues')).toHaveClass(/hidden/);

    const floor = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/BareTower_Floor1.json'));
    expect(floor.a_d.map((address) => address.p_n)).toEqual(['Outside', 'Lobby']);

    // The margin the city leaves, and the lot inside it.
    const [outside, lobby] = floor.a_d.map((address) => address.vs[0].r_d[0].n_d.length);
    expect(outside).toBe(21 * 21 - 15 * 15);
    expect(lobby).toBe(15 * 15);
});

/**
 * A ground floor smaller than its lot: nine squares of lobby, walled along one side.
 *
 * Everything it does not list backfills to Outside, so this is a whole floor in eleven
 * lines -- and a shape a floor added above it has to follow rather than invent.
 */
const smallGroundFloor = () => {
    const nodes = [];
    for (let x = 10; x <= 12; x++) {
        for (let y = 10; y <= 12; y++) {
            nodes.push({
                f_c: { x, y },
                f_h: 2,
                f_t: 1,
                f_r: '',
                // The half on this side. The square opposite is backfilled, which mirrors
                // the other half onto it -- so the pair is matched without listing it.
                w_d: x === 10 ? [{ w_o: { x: -0.5, y: 0 }, p_n: '0' }] : [],
            });
        }
    }

    return JSON.stringify({
        floorName: 'MyTower_Ground',
        size: { x: 1, y: 1 },
        defaultFloorHeight: 0,
        defaultCeilingHeight: 51,
        a_d: [
            {
                p_n: 'Outside',
                e_c: { r: 1, g: 0, b: 0.4, a: 1 },
                vs: [{ r_d: [{ id: 1, n_d: [], l: 'Null' }] }],
            },
            {
                p_n: 'Lobby',
                e_c: { r: 0, g: 1, b: 0, a: 1 },
                vs: [{ r_d: [{ id: 2, n_d: nodes, l: 'Office' }] }],
            },
        ],
        t_d: [{ f_c: { x: 3, y: 3 }, i_e: true, m_e: true, s_t: true, s_r: 0, e_l: false, e_r: 0 }],
    });
};

/** The squares one address of a written floor holds, as `x,y` keys. */
const squaresOf = (floor, addressIndex) => floor.a_d[addressIndex].vs[0].r_d
    .flatMap((room) => room.n_d)
    .map((node) => `${node.f_c.x},${node.f_c.y}`)
    .sort();

test('a floor added above another is laid out like it', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/Floors/MyTower_Ground.json': smallGroundFloor(),
    });

    await addFloor(page, 'MyTower');
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor1/);
    await expect(page.locator('#building-open-issues')).toHaveClass(/hidden/);

    const floor = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Floor1.json'));

    // The same footprint, so the building is one shape all the way up rather than a
    // storey of nine squares under a storey covering the whole lot.
    expect(squaresOf(floor, 1)).toEqual([
        '10,10', '10,11', '10,12', '11,10', '11,11', '11,12', '12,10', '12,11', '12,12',
    ]);
    expect(squaresOf(floor, 0)).toHaveLength(21 * 21 - 9);

    // And the same wall, both halves of it.
    const wallAt = (x, y) => floor.a_d.flatMap((address) => address.vs[0].r_d)
        .flatMap((room) => room.n_d)
        .find((node) => node.f_c.x === x && node.f_c.y === y).w_d;
    expect(wallAt(10, 10)).toEqual([{ w_o: { x: -0.5, y: 0 }, p_n: '0' }]);
    expect(wallAt(9, 10)).toEqual([{ w_o: { x: 0.5, y: 0 }, p_n: '0' }]);

    // The walls, and the tiles holding the storey below's stairwell and main entrance:
    // a stairwell has to sit in the same tile on every storey it passes through. What is
    // inside the walls is a storey's own, so the offices and their raised floor do not
    // come with it.
    expect(floor.a_d.map((address) => address.p_n)).toEqual(['Outside', 'Lobby']);
    expect(floor.a_d[1].vs[0].r_d.map((room) => room.l)).toEqual(['Lobby']);
    expect(floor.a_d[1].vs[0].r_d[0].n_d.every((node) => node.f_h === 0)).toBe(true);
    expect(floor.t_d.filter((tile) => tile.s_t || tile.i_e || tile.m_e))
        .toEqual([{ f_c: { x: 3, y: 3 }, i_e: true, m_e: true, s_t: true, s_r: 0, e_l: false, e_r: 0 }]);

    // The lot size and the heights describe the building, not the storey.
    expect(floor.size).toEqual({ x: 1, y: 1 });
    expect(floor.defaultCeilingHeight).toBe(51);
});

test('a building the mod owns can be given a basement', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/Floors/MyTower_Ground.json': smallGroundFloor(),
    });

    await addBasement(page, 'MyTower');

    // Named for where it is. The two lists are separate in the preset, and a basement
    // called Floor is a file whose name says where it is and is wrong about it.
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Basement1/);
    await expect.poll(() => listDir(page, 'Plugins/MyTower/Floors'))
        .toEqual(['MyTower_Basement1.json', 'MyTower_Ground.json']);

    // basementLayouts, not floorLayouts: the game counts one up from the ground floor
    // and the other down from it, so which list a storey is in is where it is.
    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/MyTower.sodso.json'));
    expect(preset.basementLayouts).toHaveLength(1);
    expect(preset.basementLayouts[0].blueprints).toEqual(['FLOOR:Floors/MyTower_Basement1']);
    expect(preset.floorLayouts).toHaveLength(1);

    // And laid out like the storey it hangs under, which is the ground floor.
    const floor = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Basement1.json'));
    expect(squaresOf(floor, 1)).toEqual([
        '10,10', '10,11', '10,12', '11,10', '11,11', '11,12', '12,10', '12,11', '12,12',
    ]);
});

test('the dialog says which storey a new one is copying from', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/Floors/MyTower_Ground.json': smallGroundFloor(),
    });

    // Which storey, rather than "the floor below": on a building whose menu is out of
    // date that would be wrong, and it is not something an author can check.
    await openStoreyDialog(page, 'MyTower', 'add-floor');

    await expect(startDialog(page)).toHaveAttribute('open', '');
    await expect(page.locator('#add-storey-title')).toHaveText('Add floor to MyTower');
    await expect(page.locator('#add-storey-source')).toHaveText(/Floor 0.*sit on/);
    await expect(startOption(page, 'fittings')).toBeChecked();

    // Dismissing writes nothing. The building is asked about before anything is
    // created, so backing out leaves the mod as it was.
    await page.click('#add-storey-modal .close-button');
    await expect(startDialog(page)).not.toHaveAttribute('open', '');
    await expect.poll(() => listDir(page, 'Plugins/MyTower/Floors'))
        .toEqual(['MyTower_Ground.json']);

    // A basement is the same question the other way up: it hangs under the deepest
    // storey there is, which here is that same floor.
    await openStoreyDialog(page, 'MyTower', 'add-basement');

    await expect(page.locator('#add-storey-title')).toHaveText('Add basement to MyTower');
    await expect(page.locator('#add-storey-source')).toHaveText(/Floor 0.*sit under/);
    await expect(page.locator('#add-storey-submit')).toHaveText('Add basement');
});

test('a new storey can start as the whole of the one it sits against', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/Floors/MyTower_Ground.json': smallGroundFloor(),
    });

    await addFloor(page, 'MyTower', 'whole');
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor1/);

    const floor = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Floor1.json'));
    const source = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Ground.json'));

    // Everything, as another layout of one storey gets: the rooms with their names, the
    // raised floor, the stairwell. Its name is the whole of the difference.
    expect({ ...floor, floorName: source.floorName }).toEqual(source);
});

test('a new storey can start as the outline of the one it sits against', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/Floors/MyTower_Ground.json': smallGroundFloor(),
    });

    await addFloor(page, 'MyTower', 'outline');
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor1/);
    await expect(page.locator('#building-open-issues')).toHaveClass(/hidden/);

    const floor = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Floor1.json'));

    // The same footprint and the wall around it, both halves.
    expect(squaresOf(floor, 1)).toEqual([
        '10,10', '10,11', '10,12', '11,10', '11,11', '11,12', '12,10', '12,11', '12,12',
    ]);
    const wallAt = (x, y) => floor.a_d.flatMap((address) => address.vs[0].r_d)
        .flatMap((room) => room.n_d)
        .find((node) => node.f_c.x === x && node.f_c.y === y).w_d;
    expect(wallAt(10, 10)).toEqual([{ w_o: { x: -0.5, y: 0 }, p_n: '0' }]);
    expect(wallAt(9, 10)).toEqual([{ w_o: { x: 0.5, y: 0 }, p_n: '0' }]);

    // And nothing drawn inside it -- which is what separates this from the answer above
    // it in the dialog: the storey below's stairwell and entrance stay behind too.
    expect(floor.a_d[1].vs[0].r_d.map((room) => room.l)).toEqual(['Lobby']);
    expect(floor.t_d.filter((tile) => tile.s_t || tile.i_e || tile.m_e)).toEqual([]);
});

test('a new floor can be the roof over the one below it', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/Floors/MyTower_Ground.json': smallGroundFloor(),
    });

    await addFloor(page, 'MyTower', 'roof');
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor1/);
    await expect(page.locator('#building-open-issues')).toHaveClass(/hidden/);

    const floor = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Floor1.json'));

    // Rooftop where the storey below is indoors, open air everywhere else. What the
    // derivation is exactly is roofGenerator.unit.spec.js; what this pins is that the
    // answer in the dialog reaches it.
    expect(floor.a_d.map((address) => address.p_n)).toEqual(['Outside', 'VentedRooftop']);
    expect(squaresOf(floor, 1)).toEqual([
        '10,10', '10,11', '10,12', '11,10', '11,11', '11,12', '12,10', '12,11', '12,12',
    ]);

    const roofNodes = floor.a_d[1].vs[0].r_d.flatMap((room) => room.n_d);
    expect(floor.a_d[1].vs[0].r_d.map((room) => room.l)).toEqual(['Rooftop']);
    expect(roofNodes.every((node) => node.f_t === 2)).toBe(true);
    expect(roofNodes.every((node) => node.w_d.every((wall) => wall.p_n === '11'))).toBe(true);
});

test('a basement is not offered a roof', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/Floors/MyTower_Ground.json': smallGroundFloor(),
    });

    // A roof goes on the top of a building. Under the bottom of one it is not an answer
    // that cannot be had yet, it is not an answer -- so it is gone rather than dimmed.
    await openStoreyDialog(page, 'MyTower', 'add-basement');
    await expect(startOption(page, 'roof')).toBeHidden();
    await expect(startOption(page, 'whole')).toBeVisible();

    await page.click('#add-storey-modal .close-button');
    await openStoreyDialog(page, 'MyTower', 'add-floor');
    await expect(startOption(page, 'roof')).toBeVisible();
});

test('a new storey can start empty, on a building that has floors already', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/Floors/MyTower_Ground.json': smallGroundFloor(),
    });

    await addFloor(page, 'MyTower', 'empty');
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor1/);
    await expect(page.locator('#building-open-issues')).toHaveClass(/hidden/);

    // The whole lot, not the nine squares below it: nothing of the storey underneath,
    // which is the answer for a storey that is not the same shape as what it sits on.
    const floor = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Floor1.json'));
    expect(floor.a_d[1].vs[0].r_d[0].n_d).toHaveLength(15 * 15);
});

test('a floor added straight after a stroke is laid out like what was just drawn', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/Floors/MyTower_Ground.json': smallGroundFloor(),
    });

    await open(page, 'MyTower', 'MyTower_Ground', {
        isBasement: false, isControlVariant: false, layoutIndex: 0, blueprintIndex: 0,
    });

    // Painted through the canvas, so the save behind it is the debounced one -- which is
    // the point of the test. Address 0 is Outside, so this takes a square off the
    // building's footprint.
    //
    // Add floor is pressed in the same breath, from inside the page: a click driven from
    // here is several round trips and would land after the 600ms autosave, which is the
    // race not happening rather than the race being won.
    await page.evaluate(async () => {
        const { projectCell, currentToolState } = await import('/flows/building/scripts/ui.js');
        const { Tool, PaintMode } = await import('/flows/building/scripts/tools.js');

        Object.assign(currentToolState(), {
            tool: Tool.ADDRESS, mode: PaintMode.PAINT, addressIndex: 0,
        });

        const canvas = document.querySelector('#building-canvas canvas');
        const at = projectCell(10, 10);
        const send = (type, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
            pointerId: 1, button: 0, buttons, bubbles: true,
            clientX: at.left, clientY: at.top,
        }));

        send('pointermove', 0);
        send('pointerdown', 1);
        send('pointerup', 0);

        document.querySelector(
            '[data-category="MyTower"] > .file-panel-footer [data-action="add-floor"]').click();
    });

    // The dialog is answered from here, which is after the race has already been won or
    // lost: what it asks about was read when it opened.
    await chooseStoreyStart(page);

    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor1/);

    const floor = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Floor1.json'));
    expect(squaresOf(floor, 1)).toEqual([
        '10,11', '10,12', '11,10', '11,11', '11,12', '12,10', '12,11', '12,12',
    ]);
});

test('another layout of a floor is a copy of the floor it is a layout of', async ({ page }) => {
    await openBuildingFlow(page, {
        ...modWithBuilding,
        'Plugins/MyTower/Floors/MyTower_Ground.json': smallGroundFloor(),
    });

    // The alternatives the game picks between for one storey are alternative layouts of
    // the same storey, so a new one starts as that storey copied whole -- to be altered,
    // rather than laid out again from its walls.
    await addLayout(page, 'MyTower', 'f0');
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor0_v1/);

    const floor = JSON.parse(
        await readFile(page, 'Plugins/MyTower/Floors/MyTower_Floor0_v1.json'));
    const source = JSON.parse(await readFile(page, 'Plugins/MyTower/Floors/MyTower_Ground.json'));

    expect(squaresOf(floor, 1)).toEqual([
        '10,10', '10,11', '10,12', '11,10', '11,11', '11,12', '12,10', '12,11', '12,12',
    ]);

    // The interior as well as the footprint: the addresses with their layouts and
    // colours, the rooms in them, the raised floor, and the storey's stairwell and main
    // entrance. Where a floor added above drops each of these, a second layout of one
    // storey is the same storey and keeps them.
    expect(floor.a_d.map((address) => address.p_n)).toEqual(['Outside', 'Lobby']);
    expect(floor.a_d[1].e_c).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(floor.a_d[1].vs[0].r_d.map((room) => room.l)).toEqual(['Office']);
    expect(floor.a_d[1].vs[0].r_d[0].n_d.every((node) => node.f_h === 2)).toBe(true);
    expect(floor.t_d).toEqual(source.t_d);

    // Its name and nothing else. Two files naming one floor is one of them shadowing the
    // other, so that is the one field a copy may not share.
    expect({ ...floor, floorName: source.floorName }).toEqual(source);
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

    // Opened, like any other floor that has just been made -- and the last of what the
    // button does, so the files below are on disk by the time this is true.
    await expect(page.locator('#building-open-name')).toHaveText(/MyTower_Floor0_v1/);

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

    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/GrandHotel.BuildingPreset.sodso.json'));
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
    // in game is a building that is simply not in the city. Appended rather than
    // replacing: the order is the author's -- see core/murderManifest.js.
    await expect.poll(async () => {
        const raw = await readFile(page, 'Plugins/MyTower/murdermanifest.sodso.json');
        return raw ? JSON.parse(raw).fileOrder : null;
    }).toEqual(['REF:MyTower', 'REF:GrandHotel.BuildingPreset']);
});

test('a folder with no manifest gets one when a building is added to it', async ({ page }) => {
    // The other way into the flow: a folder that is content because of its DDS text, not
    // because of a manifest. It is the one case left where adding a building writes the
    // mod's first manifest -- a folder that already holds a building necessarily has one,
    // because that is what makes it a building folder. See core/modFolders.js.
    // Set up by hand rather than through openBuildingFlow, which selects MyTower.
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=building');
    await seedFs(page, { 'Plugins/DdsOnly/DDSContent/DDS/Blocks/.keep': '' });
    await connectFolders(page, { modDir: 'Plugins' });
    await selectContent(page, 'DdsOnly', '');

    await openAddBuilding(page);
    await page.fill('#new-building-title', 'Grand Hotel');
    await submitAddBuilding(page, 'GrandHotel');

    await expect.poll(async () => {
        const raw = await readFile(page, 'Plugins/DdsOnly/murdermanifest.sodso.json');
        return raw ? JSON.parse(raw).fileOrder : null;
    }).toEqual(['REF:GrandHotel.BuildingPreset']);
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

    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/Thing.BuildingPreset.sodso.json'));
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

    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/MyMod_GrandHotel.BuildingPreset.sodso.json'));
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
        'Plugins/MyTower/Tower/murdermanifest.sodso.json': json({
            enabled: true, fileOrder: ['REF:MyTower'], loadBefore: '', version: 1,
        }),
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
    expect(files.sort()).toEqual(['Floors', 'SecondTower.BuildingPreset.sodso.json', 'murdermanifest.sodso.json']);

    const preset = JSON.parse(await readFile(page, 'Plugins/MyTower/SecondTower/SecondTower.BuildingPreset.sodso.json'));
    expect(preset.fileType).toBe('BuildingPreset');
    expect(preset.name).toBe('SecondTower');

    // The manifest is what makes the loader read the preset at all, so the folder is
    // not laid out without one.
    const manifest = JSON.parse(
        await readFile(page, 'Plugins/MyTower/SecondTower/murdermanifest.sodso.json'));
    expect(manifest.fileOrder).toEqual(['REF:SecondTower.BuildingPreset']);

    // The Floors directory exists from the start rather than appearing with the first
    // floor, so there is somewhere to save one into.
    const described = await page.evaluate(async () => {
        const { findContentFolders, describeContentFolder } = await import('/core/modFolders.js');
        const plugins = await window.__opfsDir('Plugins', false);
        const mod = await plugins.getDirectoryHandle('MyTower');
        return (await findContentFolders(mod)).map(describeContentFolder);
    });

    // "case" is what a manifest reads as, and a building mod written here has one --
    // see core/murderManifest.js. The "building" half is that same manifest naming a
    // preset that says BuildingPreset, so laying out one without the other would leave
    // a folder this flow could not reopen.
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
        'Plugins/OtherMod/murdermanifest.sodso.json': json({
            enabled: true, fileOrder: ['REF:Other'], loadBefore: '', version: 1,
        }),
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
