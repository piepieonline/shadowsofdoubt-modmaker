import { test, expect } from '@playwright/test';
import { installFsHarness, gotoFlow, alerts, queueDismissedPick, queuePicks, seedFs } from '../test-support/harness.js';
import { pluginsFixture } from '../test-support/fixtures.js';

/**
 * What a folder pick that produces nothing is told.
 *
 * Chromium will not open a directory under `Program Files`, which is where a default Steam
 * install puts both the game and the BepInEx `plugins` folder. It refuses by rejecting
 * `showDirectoryPicker` with `AbortError` -- byte for byte what it does when the user
 * presses Cancel -- so the app cannot tell a refusal from a cancellation and neither can
 * the person in front of it, who sees a dialog close and nothing happen.
 *
 * The desktop build lifts that blocklist in the main process, so there the rejection really
 * is a cancellation and there is nothing to explain.
 */

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

/**
 * Pretend the preload script ran, which is the only thing that sets this.
 *
 * The whole surface, not just the part this file reads. A stub with `appVersion` alone was
 * enough until the shell started subscribing to update notices, and then it took the app
 * down at startup -- a test double that is a partial lie fails somewhere other than where
 * the lie is. Keep this matching desktop/preload.cjs.
 */
const asDesktop = (page) => page.addInitScript(() => {
    window.__desktop = { isDesktop: true, appVersion: '9.9.9', onUpdateAvailable: () => {} };
});

const dismissPick = async (page, folder = 'modDir') => {
    await queueDismissedPick(page);
    await page.locator(`[data-select-folder="${folder}"]`).click();
};

/**
 * Connect a folder for real, and wait for it.
 *
 * Used after a dismissed pick as the settling point for the assertions about it. `click()`
 * resolves when the click is dispatched, not when the handler it started has finished, so
 * reading `__alerts` straight afterwards is a race -- one this suite lost in both directions
 * before the waits went in, passing or failing depending on which spec it was run beside.
 * A pick that ends in a visible state change is something to actually wait on.
 */
async function connectFor(page, folder = 'modDir', path = 'Plugins') {
    await queuePicks(page, [path]);
    await page.locator(`[data-select-folder="${folder}"]`).click();
    await expect(page.locator(`.folder-row[data-folder="${folder}"][data-state="connected"]`)).toBeVisible();
}

test('a pick that comes back with nothing says the browser may be the reason', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await dismissPick(page);

    // Both readings have to work: information for someone who cancelled on purpose, and
    // an explanation for someone whose folder was refused and who was told nothing.
    await expect.poll(() => alerts(page).then((said) => said.join('\n')))
        .toContain('No folder was selected');

    const said = (await alerts(page)).join('\n');
    expect(said).toContain('Program Files');
    expect(said).toContain('desktop build');
});

test('the desktop build says nothing, because there the pick really was cancelled', async ({ page }) => {
    await asDesktop(page);
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, pluginsFixture);

    expect(await page.evaluate(async () =>
        (await import('/core/platform.js')).isDesktop)).toBe(true);

    await dismissPick(page);

    // A second pick that succeeds, so there is a moment at which the first one is certainly
    // over. Asserting an absence needs one; polling for nothing would pass immediately.
    await connectFor(page);

    expect(await alerts(page)).toEqual([]);
});

test('a dismissed pick leaves the folder unconnected and the modal still usable', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, pluginsFixture);

    await dismissPick(page);

    // Not connected, and no half-applied state: the row still offers to select it.
    await expect(page.locator('.folder-row[data-folder="modDir"][data-state="missing"]')).toBeVisible();
    expect(await page.evaluate(() => window.dirHandleModDir ?? null)).toBeNull();

    // And the next attempt works, so the rejection was handled rather than left in flight.
    await connectFor(page);
});
