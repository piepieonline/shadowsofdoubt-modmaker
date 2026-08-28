import { test, expect } from '@playwright/test';
import { installFsHarness, gotoFlow, readFile, listDir, alerts, editField, fieldInput, openDdsDocument } from './support/harness.js';
import { DEMO_SELECTION, DEMO_TREE_GUID, DEMO_MOD_TREE_GUID } from '../core/demo/fixtures.js';

/**
 * Demo mode: the whole app, against content that is not on anyone's disk.
 *
 * Two promises to keep, and they are what most of this is about. Nothing is read from a
 * game install or a mod folder, and nothing is written outside the demo tree -- including
 * the remembered handles, which a demo that displaced them would break for real use on
 * the next visit.
 *
 * The rest is that it works at all: every flow reaches populated content, with no picker
 * and no folder modal in the way.
 */

/** Everything demo mode seeds lives under this one directory in OPFS. */
const DEMO_ROOT = 'demo-mode';

const CONTENT_ROOT =
    `${DEMO_ROOT}/Plugins/${DEMO_SELECTION.modName}/${DEMO_SELECTION.contentPath}`;

/** Wait for the content folder demo mode chooses, which is applied after the flow starts. */
const demoReady = (page) => page.waitForFunction(() => window.selectedMod != null);

/**
 * Get past the spoiler warning, which blocks activation on an ordinary visit.
 *
 * Only where a test navigates without the parameter: demo mode does not raise it, and one
 * test below is about exactly that, so this cannot go in beforeEach.
 */
const allowNonDemo = (page) => page.addInitScript(
    () => localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));

test.beforeEach(async ({ page }) => {
    // For window.__pickerCalls and the OPFS readers. The picker stub also turns a picker
    // call this should never make into a recorded call rather than a hang.
    await installFsHarness(page);
});

test('?demo connects folders without ever opening the picker', async ({ page }) => {
    await gotoFlow(page, '?demo');
    await demoReady(page);

    expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);

    const connected = await page.evaluate(() => ({
        streamingAssets: window.dirHandleStreamingAssets?.name ?? null,
        modDir: window.dirHandleModDir?.name ?? null,
    }));
    expect(connected).toEqual({ streamingAssets: 'StreamingAssets', modDir: 'Plugins' });

    // Nothing missing, so the startup modal has no reason to open over the editor.
    await expect(page.locator('#folders-modal')).not.toHaveAttribute('open');
    expect(await alerts(page)).toEqual([]);
});

test('demo mode says so, and an ordinary visit does not', async ({ page }) => {
    await gotoFlow(page, '?demo');
    await expect(page.locator('#demo-banner')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-demo', '');

    await allowNonDemo(page);
    await gotoFlow(page, './');
    await expect(page.locator('#demo-banner')).toBeHidden();
    await expect(page.locator('html')).not.toHaveAttribute('data-demo', '');
});

test('an ordinary visit connects nothing and seeds nothing', async ({ page }) => {
    await allowNonDemo(page);
    await gotoFlow(page, './');

    // The point of the parameter: without it, none of the above happens.
    expect(await page.evaluate(() => window.dirHandleModDir ?? null)).toBeNull();
    expect(await page.evaluate(() => window.selectedMod ?? null)).toBeNull();
    expect(await listDir(page, DEMO_ROOT)).toBeNull();
});

test('demo=0 is off, so a URL can be corrected rather than edited down', async ({ page }) => {
    // A flow switch rewrites the query string, so the parameter is sticky once it is set.
    await allowNonDemo(page);
    await gotoFlow(page, '?demo=0');

    await expect(page.locator('#demo-banner')).toBeHidden();
    expect(await page.evaluate(() => window.dirHandleModDir ?? null)).toBeNull();
});

/**
 * The remembered folders belong to real use. Demo mode never calls selectFolder, so
 * nothing is written to idb-keyval -- and it does not call restoreFolders either, so a
 * remembered handle is not even read, let alone connected.
 */
test('the folders you picked for real use are left exactly as they were', async ({ page }) => {
    await allowNonDemo(page);
    await page.goto('./');

    await page.evaluate(async () => {
        const dir = await window.__opfsDir('PretendRealModFolder');
        await idbKeyval.set('ModPath', dir);
        await idbKeyval.set('StreamingAssetsPath', dir);
    });

    await gotoFlow(page, '?demo');
    await demoReady(page);

    const remembered = await page.evaluate(async () => ({
        modPath: (await idbKeyval.get('ModPath'))?.name ?? null,
        streamingAssetsPath: (await idbKeyval.get('StreamingAssetsPath'))?.name ?? null,
        connected: window.dirHandleModDir?.name ?? null,
    }));

    expect(remembered.modPath).toBe('PretendRealModFolder');
    expect(remembered.streamingAssetsPath).toBe('PretendRealModFolder');
    // Connected to the demo tree rather than to what was remembered.
    expect(remembered.connected).toBe('Plugins');
});

test('folders cannot be swapped for real ones from inside demo mode', async ({ page }) => {
    await gotoFlow(page, '?demo');
    await demoReady(page);

    await page.locator('#folders-open').click();
    await expect(page.locator('#folders-modal')).toHaveAttribute('open');
    await expect(page.locator('#folders-missing')).toContainText('Demo mode');

    // Disabled so the state is visible, and refused underneath, because a picked folder
    // would be both read from and remembered.
    await expect(page.locator('[data-select-folder="modDir"]')).toBeDisabled();

    const refused = await page.evaluate(async () => {
        const { selectFolder } = await import('/core/folders.js');
        return selectFolder('modDir');
    });

    expect(refused).toBeNull();
    expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
    expect((await alerts(page)).join()).toContain('demo mode');
});

test('the spoiler warning is not raised, and its preference is not set', async ({ page }) => {
    await gotoFlow(page, '?demo');
    await demoReady(page);

    // The warning is about what the game's own content spoils, and demo mode holds none
    // of it. Dismissing it here would also decide it for real use.
    await expect(page.locator('#spoiler-warning-modal')).not.toHaveAttribute('open');
    expect(await page.evaluate(
        () => localStorage.getItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed'))).toBeNull();
});

test('it lands in a populated content folder rather than an empty editor', async ({ page }) => {
    await gotoFlow(page, '?flow=dds&demo');
    await demoReady(page);

    await expect(page.locator('#select-mod')).toHaveValue(DEMO_SELECTION.modName);
    await expect(page.locator('#select-content')).toHaveValue(DEMO_SELECTION.contentPath);

    // Every marker in one folder, which is what lets a flow switch keep the selection.
    await expect(page.locator('#select-content option:checked'))
        .toHaveText(/case \+ DDS \+ building/);

    // The mod's own content, and the base game content it overrides.
    const panel = page.locator('#dds-file-list');
    await expect(panel.locator('[data-category="trees"] .file-panel-entry')).toHaveCount(2);
    await expect(panel.locator('[data-category="trees"] [data-kind="patch"]')).toHaveCount(1);
});

/**
 * Every flow, from the same selection. The building flow is the one that would notice a
 * missing Floors directory and the case flow the one that would notice a missing
 * manifest, so this is what pins that the demo folder carries all three markers.
 */
for (const [flow, panel, content] of [
    ['dds', '#dds-file-list', 'NeonNoir_Doorman'],
    ['scriptableObject', '#so-file-list', 'NeonNoirMurder'],
    ['building', '#building-file-list', 'NeonNoirTower'],
]) {
    test(`the ${flow} flow opens on demo content`, async ({ page }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));

        await gotoFlow(page, `?flow=${flow}&demo`);
        await demoReady(page);

        await expect(page.locator(panel)).toContainText(content);
        expect(await alerts(page)).toEqual([]);
        expect(errors).toEqual([]);
    });
}

test('switching flows keeps the demo selection and the demo badge', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject&demo');
    await demoReady(page);

    await page.locator('#flow-picker').selectOption('dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    // switchFlow rewrites the query string; the parameter has to survive that, or a
    // reload after switching would come up with no folders at all.
    expect(new URL(page.url()).searchParams.has('demo')).toBe(true);
    await expect(page.locator('#demo-banner')).toBeVisible();
    await expect(page.locator('#select-content')).toHaveValue(DEMO_SELECTION.contentPath);
});

/**
 * Saving genuinely writes, into the demo tree. That is what makes demo mode worth having
 * over one that swallows writes: an edit can be saved, reopened and seen again, which a
 * save that quietly did nothing could not show.
 */
test('an edit is saved into the demo tree, and nowhere else', async ({ page }) => {
    await gotoFlow(page, '?flow=dds&demo');
    await demoReady(page);

    await openDdsDocument(page, DEMO_TREE_GUID);

    // The seeded patch already raises this from 3, so the document shows the patched
    // value and editing it rewrites a patch that was read rather than writing the first.
    await expect(fieldInput(page, '#file-window-0', 'priority')).toHaveValue('7');
    await editField(page, '#file-window-0', 'priority', '9');

    const patchPath = `${CONTENT_ROOT}/DDSContent/DDS/Trees/${DEMO_TREE_GUID}.tree_patch`;
    await expect.poll(async () => JSON.parse((await readFile(page, patchPath)) ?? '[]'))
        .toContainEqual({ op: 'replace', path: '/priority', value: 9 });

    // The demo subtree is the only thing in the origin's storage. Wiping the OPFS root
    // would take the test harness's own tree with it, so demo mode owns one directory
    // and nothing above it.
    expect(await listDir(page, '')).toEqual([DEMO_ROOT]);
    expect(await alerts(page)).toEqual([]);
});

test('every visit starts from the same content, whatever the last one did', async ({ page }) => {
    await gotoFlow(page, '?flow=dds&demo');
    await demoReady(page);

    await openDdsDocument(page, DEMO_MOD_TREE_GUID, 'tree');
    await editField(page, '#file-window-0', 'name', 'Edited in the last visit');

    const treePath = `${CONTENT_ROOT}/DDSContent/DDS/Trees/${DEMO_MOD_TREE_GUID}.tree`;
    await expect.poll(async () => JSON.parse(await readFile(page, treePath)).name)
        .toBe('Edited in the last visit');

    // Reseeded on load, so nothing accumulates across visits and the demo cannot be left
    // in a state that makes it useless to whoever opens it next.
    await gotoFlow(page, '?flow=dds&demo');
    await demoReady(page);

    expect(JSON.parse(await readFile(page, treePath)).name).toBe('NeonNoir_Doorman');
});
