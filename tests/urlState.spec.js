import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, connectFolders, selectContent, gotoFlow, openDdsDocument, alerts } from '../test-support/harness.js';
import { caseWithDdsReference, ddsFixtureWithContent, TREE_GUID } from '../test-support/fixtures.js';

/**
 * The URL as the record of what you are working on.
 *
 * Refreshing is cheap to trigger by accident, and used to cost you everything you had
 * set up: the editor, the mod and content folder, and every open document. All of it
 * lived in memory, so the page came back at the least useful state the app has.
 *
 * Everything here reloads for real rather than switching flows -- tests/flowSession.spec.js
 * covers the switch. A reload drops the directory handles from memory, so what is being
 * proved includes the app reconnecting to the folders and only then putting the rest back.
 */

const json = (value) => JSON.stringify(value, null, 2);

const openWindows = (page) => page.evaluate(() =>
    [...document.querySelectorAll('#trees .file-window')].map((el) => el.getAttribute('path')));

const param = (page, name) => new URL(page.url()).searchParams.get(name);

/** Reload and wait for the flow to be usable again. */
async function reload(page) {
    await page.reload();
    await page.locator('html[data-flow-ready]').waitFor();
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});


/* -------------------------------------------------------------------------- */
/* The selection                                                               */
/* -------------------------------------------------------------------------- */

test('the mod and content folder are in the URL, and come back', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, caseWithDdsReference);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await expect.poll(() => param(page, 'mod')).toBe('TestCase');
    // A content folder at the mod root has an empty path, which is a selection rather
    // than the absence of one -- so the parameter is present and empty.
    expect(param(page, 'content')).toBe('');

    await reload(page);

    await page.waitForFunction(() => window.selectedMod?.modName === 'TestCase');
    await expect(page.locator('#select-mod')).toHaveValue('TestCase');
    await expect(page.locator('#select-content')).toHaveValue('');
});

test('the editor you were in is the one that comes back', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, ddsFixtureWithContent);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    await reload(page);

    await expect(page.locator('html')).toHaveAttribute('data-flow-ready', 'dds');
    await expect(page.locator('#flow-picker')).toHaveValue('dds');
});


/* -------------------------------------------------------------------------- */
/* What each editor had open                                                   */
/* -------------------------------------------------------------------------- */

test('the DDS drill-down comes back, every level of it', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsFixtureWithContent);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestMod', 'Content');

    await openDdsDocument(page, TREE_GUID);
    await page.locator('#file-window-2 .jsontree_child-nodes').first().waitFor();
    const before = await openWindows(page);
    expect(before).toHaveLength(3);

    await expect.poll(() => param(page, 'open')).toContain(TREE_GUID);

    await reload(page);

    // All three, not just the tree rebuilt from its first message and block.
    await expect.poll(() => openWindows(page)).toEqual(before);
    // And read through the mod again: the fixture patches this tree's name, so the
    // restored document showing the patch is what says the selection came back too.
    await expect(page.locator('#file-window-0')).toContainText('Tree: Patched');
});

test('an open case file comes back', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, caseWithDdsReference);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await page.locator('#manifest_panel .files-order ul button').click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    // The mod's own file, said as such: the same path could be a base game asset.
    await expect.poll(() => param(page, 'open')).toBe('["mod:testcase.sodso.json"]');

    await reload(page);

    await expect.poll(() => openWindows(page)).toEqual(['testcase.sodso.json']);

    // And stays. expect.poll passes on the first match, so on its own it cannot tell
    // "restored" from "restored, then destroyed a moment later".
    await page.waitForTimeout(400);
    expect(await openWindows(page)).toEqual(['testcase.sodso.json']);
});

test('closing a document takes it out of the URL', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, caseWithDdsReference);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await page.locator('#manifest_panel .files-order ul button').click();
    await expect.poll(() => param(page, 'open')).toContain('testcase');

    await page.locator('#trees .file-window button', { hasText: 'Close' }).click();
    await expect(page.locator('#trees .file-window')).toHaveCount(0);

    // Otherwise a refresh would reopen what you had just closed.
    await expect.poll(() => param(page, 'open')).toBe(null);
});

test('an open floor comes back, with the tool that was in hand', async ({ page }) => {
    await gotoFlow(page, '?flow=building');
    await seedFs(page, {
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
    });
    await connectFolders(page, { modDir: 'Plugins' });
    await selectContent(page, 'MyTower', '');

    await page.evaluate(async () => {
        const { openFloor } = await import('/flows/building/scripts/ui.js');
        await openFloor({ building: 'MyTower', blueprint: 'MyTower_Ground', slot: null });
    });
    await page.locator('#building-tools .tool-bar button[data-tool="wall"]').click();

    // Polled on the tool rather than the floor: the floor is written when it opens, so
    // waiting for that can be satisfied by the write from before the tool was chosen.
    await expect.poll(() => param(page, 'tool')).toBe('wall');
    expect(param(page, 'blueprint')).toBe('MyTower_Ground');
    expect(param(page, 'building')).toBe('MyTower');

    await reload(page);

    // The floor itself, rather than the panel that lists floors: coming back to the
    // browser would be coming back to nothing open.
    await expect.poll(() => page.evaluate(async () => {
        const { openFloorName } = await import('/flows/building/scripts/ui.js');
        return openFloorName();
    })).toEqual({ building: 'MyTower', blueprint: 'MyTower_Ground' });

    await expect(page.locator('#building-tools .tool-bar button[data-tool="wall"].active'))
        .toBeAttached();
});


/* -------------------------------------------------------------------------- */
/* Base game content, with no mod selected                                     */
/* -------------------------------------------------------------------------- */

test('a base game asset opened with no mod at all comes back', async ({ page }) => {
    // Nothing is connected and nothing is selected: these assets ship with the tool, and
    // reading one is a thing you can do before you have a mod to put anything in.
    await gotoFlow(page,
        '?flow=scriptableObject&open=' + encodeURIComponent('["asset:MurderMO/ExCopSniper.json"]'));

    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    await reload(page);

    await expect(page.locator('#trees .file-window')).toHaveCount(1);
    await expect.poll(() => openWindows(page)).toEqual(['MurderMO/ExCopSniper.json']);
    expect(await page.evaluate(() => window.selectedMod)).toBe(null);
});

test('a link to open files is the URL itself, marked as one to read', async ({ page }) => {
    await gotoFlow(page,
        '?flow=scriptableObject&open=' + encodeURIComponent('["asset:MurderMO/ExCopSniper.json"]'));
    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    await page.evaluate(() => window.shareOpen());

    const copied = new URL(await page.evaluate(() => window.__clipboard));
    expect(copied.searchParams.get('flow')).toBe('scriptableObject');
    expect(copied.searchParams.get('open')).toBe('["asset:MurderMO/ExCopSniper.json"]');
    // What makes it a link to read rather than to edit in.
    expect(copied.searchParams.get('viewOnly')).toBe('true');
});

test('a shared link stays a shared link when it is refreshed', async ({ page }) => {
    // With a mod folder connected, so that view-only is doing something: editing mode
    // otherwise follows whether there is a folder to write into.
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, caseWithDdsReference);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

    await page.goto('?flow=scriptableObject&viewOnly=true&open='
        + encodeURIComponent('["asset:MurderMO/ExCopSniper.json"]'));
    await page.locator('html[data-flow-ready]').waitFor();

    await expect(page.locator('#trees .file-window')).toHaveCount(1);
    await expect(page.locator('#manifest_panel')).toHaveClass(/hidden/);

    await reload(page);

    await expect(page.locator('#trees .file-window')).toHaveCount(1);
    await expect(page.locator('#manifest_panel')).toHaveClass(/hidden/);
});


/* -------------------------------------------------------------------------- */
/* State that no longer describes anything                                     */
/* -------------------------------------------------------------------------- */

test('a mod that is not there leaves you with nothing selected, and says nothing', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, caseWithDdsReference);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

    // A link from a machine with a mod this one does not have, or one deleted since.
    await page.goto('?flow=scriptableObject&mod=NoSuchMod&content=&open='
        + encodeURIComponent('["mod:missing.sodso.json"]'));
    await page.locator('html[data-flow-ready]').waitFor();

    await expect(page.locator('#trees .file-window')).toHaveCount(0);
    expect(await page.evaluate(() => window.selectedMod)).toBe(null);

    // Arriving at an alert about a mod you did not ask for is worse than arriving at
    // nothing, and there is nothing here the reader can do about it.
    expect(await alerts(page)).toEqual([]);

    // And the URL stops describing what is not there, rather than carrying it forever.
    await expect.poll(() => param(page, 'mod')).toBe(null);
    expect(param(page, 'open')).toBe(null);
});

test('a document deleted since is left out, and the rest still opens', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, caseWithDdsReference);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

    await page.goto('?flow=scriptableObject&mod=TestCase&content=&open='
        + encodeURIComponent('["mod:testcase.sodso.json","mod:deleted.sodso.json"]'));
    await page.locator('html[data-flow-ready]').waitFor();

    await expect.poll(() => openWindows(page)).toEqual(['testcase.sodso.json']);
    expect(await alerts(page)).toEqual([]);

    // Corrected from what actually came back, so the next refresh does not try again.
    await expect.poll(() => param(page, 'open')).toBe('["mod:testcase.sodso.json"]');
});

test('changing editor while a restore is still waiting gives up on it', async ({ page }) => {
    // Nothing is connected, so what this link names cannot be put back yet. The
    // parameters are held meanwhile -- a link whose state is erased while its own folder
    // prompt is on screen is a link that only works if answered quickly.
    await gotoFlow(page, '?flow=dds&mod=TestMod&content=Content&open='
        + encodeURIComponent(`["DDS/Trees/${TREE_GUID}.tree"]`));
    expect(param(page, 'open')).toContain(TREE_GUID);

    await page.selectOption('#flow-picker', 'scriptableObject');
    await page.locator('html[data-flow-ready="scriptableObject"]').waitFor();

    // Those documents belong to an editor that has been left, so the wait is over and
    // the URL describes where you actually are.
    await expect.poll(() => param(page, 'flow')).toBe('scriptableObject');
    expect(param(page, 'open')).toBe(null);
});
