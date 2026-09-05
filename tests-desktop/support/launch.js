/**
 * Launching the app in Electron, with the filesystem harness in ahead of it.
 *
 * The one difficulty the desktop suite has that the web suites do not: `addInitScript` must
 * run before the app's own scripts, and an Electron window starts loading the moment it is
 * created -- before a test has any way to reach it. Two ways out were considered. The main
 * process could hold `loadURL` behind a `--test` flag and wait to be told, which puts test
 * scaffolding into shipped code. Or the harness can install and then reload, which is what
 * this does: the first load is thrown away, the init scripts survive into the second, and
 * `desktop/main.js` stays a file with nothing in it for the benefit of tests.
 *
 * Verified rather than assumed -- the spike checked `window.__harnessRanFirst` after the
 * reload and the app had not run yet. The first load is harmless because nothing at startup
 * touches a folder: it reads an empty idb-keyval and then stops on the spoiler warning.
 *
 * Every test gets a fresh `--user-data-dir`, which is where localStorage, IndexedDB and OPFS
 * live. Without it the desktop suite would be the one suite whose tests could see each
 * other's leftovers, since a browser context is thrown away at the end of a test and an
 * Electron profile on disk is not.
 */
import { test as base, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installFsHarness } from '../../test-support/harness.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Must match desktop/main.js. The origin is what folder handles are remembered against. */
export const APP_ORIGIN = 'app://modmaker';

/**
 * Go to a flow the way the web suites' `gotoFlow` does.
 *
 * Its own rather than the harness's, because that one takes a path relative to a `baseURL`
 * and there is no base URL here -- Electron serves the app itself, from a fixed origin that
 * no config supplies.
 */
export async function gotoFlow(page, query = '') {
    await page.goto(`${APP_ORIGIN}/index.html${query}`);
    await page.locator('html[data-flow-ready]').waitFor();
}

/**
 * Get the startup folder prompt out of the way.
 *
 * It opens on every load until the folders it wants are connected, and it is a `<dialog>`,
 * so it swallows clicks aimed at anything behind it -- which is how a test about something
 * else in the chrome fails with "intercepts pointer events" rather than with its own
 * assertion. `connectFolders` in the shared harness ends by closing it the same way; this is
 * for the tests that have no folders to connect.
 */
export async function dismissFolderPrompt(page) {
    const modal = page.locator('#folders-modal[open]');

    await modal.waitFor();
    await page.locator('#folders-continue').click();
    await expect(modal).toHaveCount(0);
}

export const test = base.extend({
    /** The Electron app, for tests that need to reach into the main process. */
    electronApp: async ({}, use) => {
        const userData = await mkdtemp(join(tmpdir(), 'modmaker-desktop-'));

        const app = await electron.launch({
            args: ['.', `--user-data-dir=${userData}`],
            cwd: ROOT,
        });

        await use(app);

        await app.close();
        await rm(userData, { recursive: true, force: true });
    },

    /**
     * The app's window, harnessed and reloaded.
     *
     * Overriding Playwright's own `page` rather than adding a fixture beside it. Fixtures
     * are built on demand, so replacing this one means the browser fixture is never asked
     * for and no Chromium is launched next to the Electron that already is one.
     */
    page: async ({ electronApp }, use) => {
        const page = await electronApp.firstWindow();

        await installFsHarness(page);
        // The shell blocks on this before activating a flow. Same line as every web spec.
        await page.addInitScript(() =>
            localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));

        await page.reload();

        await use(page);
    },
});

export { expect };
