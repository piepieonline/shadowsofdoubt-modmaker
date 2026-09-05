import { test, expect, gotoFlow, APP_ORIGIN } from './support/launch.js';
import { seedFs, connectFolders, selectContent, listDir, readFile, alerts } from '../test-support/harness.js';
import { pluginsFixture, ddsFixtureWithContent, MOD_MSG_GUID } from '../test-support/fixtures.js';

/**
 * Folders, which is the whole reason the desktop build exists.
 *
 * The harness hands the app real OPFS-backed `FileSystemDirectoryHandle` objects rather than
 * a mock, so what runs here is the browser's own implementation of the API -- the same one
 * that reads a real mod folder. It is origin-agnostic by construction, which is what lets
 * the desktop suite reuse it unchanged.
 *
 * What this cannot cover is the part that needs a native picker returning a real blocked
 * path: no test can make Chromium refuse an OPFS handle. The blocklist handler in
 * desktop/main.js is a manual check, and the note at the bottom of DESKTOP-PLAN.md phase 5
 * says so rather than pretending otherwise.
 */

/**
 * Walking a directory, which is what electron#45225 broke.
 *
 * `FileSystemDirectoryHandle.values()` hung indefinitely on macOS in Electron 34.0.0. The
 * app has seventeen `for await (... of handle.values())` sites, one under every flow, and a
 * regression there is silent -- an empty mod list reads as "this folder has no mods in it".
 * The Electron version is pinned well past the fix; this is what would notice if a bump ever
 * went backwards, on whichever platform it went backwards on.
 *
 * At the API directly here, and through the app in the test below it. The hang was in the
 * iterator itself, so the narrower check is the one that would name the fault.
 */
test('a directory can be walked, which is what a mod list is', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, pluginsFixture);

    expect(await page.evaluate(async () => {
        const plugins = await window.__opfsDir('Plugins', false);

        const names = [];
        for await (const [name, handle] of plugins.entries()) {
            if (handle.kind === 'directory') names.push(name);
        }

        return names.sort();
    })).toEqual([
        'AdditionalEvidence', 'DartTowerTest', 'DialogAdditions', 'TallTower', 'UnityExplorer',
        'UnlistedTower', 'WhiteCollarSideJobs',
    ]);
});

/**
 * The same walk, made by the app rather than by the test.
 *
 * The mod dropdown is populated by reading the connected plugins folder an entry at a time,
 * so a list with the right names in it is the app's own `for await` having completed.
 */
test('connecting a mod folder fills the mod list from what is in it', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, pluginsFixture);

    await connectFolders(page, { modDir: 'Plugins' });

    await expect(page.locator('#select-mod option')).toHaveText([
        'Choose a mod…',
        'AdditionalEvidence', 'DartTowerTest', 'DialogAdditions', 'TallTower', 'UnityExplorer',
        'UnlistedTower', 'WhiteCollarSideJobs',
    ]);
    expect(await alerts(page)).toEqual([]);
});

/**
 * A folder picked once is still there next launch.
 *
 * This is what the `standard: true` privilege buys, and the failure without it is quiet and
 * total: an opaque origin gets no durable storage, so `idbKeyval.set` succeeds, the handle
 * goes nowhere, and every launch opens with the folder modal and no memory of anything. A
 * reload stands in for a relaunch -- the storage is keyed by origin, and the origin is fixed.
 */
test('a connected folder is remembered against the app:// origin', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, pluginsFixture);
    await connectFolders(page, { modDir: 'Plugins' });

    expect(await page.evaluate(async () => (await idbKeyval.get('ModPath'))?.name ?? null))
        .toBe('Plugins');

    await gotoFlow(page, '?flow=dds');

    // Reconnected without asking: OPFS answers queryPermission with 'granted', which is
    // what a picked folder answers once its permission is held.
    expect(await page.evaluate(() => window.dirHandleModDir?.name ?? null)).toBe('Plugins');
    expect(await page.evaluate(() => window.location.origin)).toBe(APP_ORIGIN);
});

/**
 * One flow, opened and written to, over app://.
 *
 * Not a second copy of what tests/ covers -- the DDS flow's behaviour is asserted there
 * against the dev server. What is being checked is that a whole path through the app works
 * when the origin is a custom scheme and the code is a Rollup chunk rather than a file:
 * reference data fetched, folders connected, a document read out of one, an edit made, and
 * the result written back to disk.
 */
test('a document can be opened, edited and written back', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsFixtureWithContent);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestMod', 'Content');

    // A base game message, so saving writes a patch into the mod rather than over anything.
    await page.evaluate((guid) => window.setIdAndLoad(guid, 'message'), MOD_MSG_GUID);
    await expect(page.locator('#file-window-0')).toContainText('ModMessage');

    await page.locator('#file-window-0').getByRole('button', { name: 'Save' }).click();

    // The write reached the filesystem, through the same API the web build uses.
    await expect
        .poll(() => listDir(page, 'Mods/TestMod/Content/DDSContent/DDS/Messages'))
        .toContain(`${MOD_MSG_GUID}.msg`);

    expect(JSON.parse(await readFile(page,
        `Mods/TestMod/Content/DDSContent/DDS/Messages/${MOD_MSG_GUID}.msg`)).id)
        .toBe(MOD_MSG_GUID);

    expect(await alerts(page)).toEqual([]);
});
