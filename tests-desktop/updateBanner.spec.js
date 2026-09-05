import { test, expect, gotoFlow, dismissFolderPrompt } from './support/launch.js';

/**
 * The update banner, driven from the main process rather than from GitHub.
 *
 * Deliberately not the real fetch. A test that asked api.github.com would depend on the
 * network, on an unauthenticated rate limit of sixty an hour, and on a release existing that
 * is newer than whatever package.json currently says -- three ways to fail that have nothing
 * to do with this code. Whether a tag is newer is decided by `isNewer`, which is a pure
 * function with unit tests of its own in desktop/version.unit.spec.js; what is left, and
 * what is here, is that an answer reaches the renderer and turns into something on screen.
 */

/** Stand in for the check having succeeded, from where the check's result comes from. */
const announce = (electronApp, release) => electronApp.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0].webContents.send('update-available', payload);
}, release);

const NEWER = { version: 'v9.9.9', url: 'https://github.com/piepieonline/shadowsofdoubt-modmaker/releases/latest' };

test('nothing is shown until there is something to say', async ({ page }) => {
    await gotoFlow(page);

    // The real check against a version no release will ever beat, plus every failure --
    // offline, rate-limited, an unreadable tag -- all end here, and silence is the designed
    // answer to all of them.
    await expect(page.locator('#update-banner')).toBeHidden();
});

test('a newer release names itself and links to the releases page', async ({ page, electronApp }) => {
    await gotoFlow(page);
    await announce(electronApp, NEWER);

    await expect(page.locator('#update-banner')).toBeVisible();
    await expect(page.locator('#update-banner')).toContainText('does not update itself');
    await expect(page.locator('#update-banner-link')).toHaveText('v9.9.9');
    await expect(page.locator('#update-banner-link')).toHaveAttribute('href', NEWER.url);
});

/**
 * Dismissing it means this version, not this session.
 *
 * The check runs once per launch, so a session-scoped dismissal would put the same banner
 * back on every start until the user updated. Dismissing 1.4.0 says nothing about 1.5.0,
 * which is the behaviour worth having in a tool people leave installed.
 */
test('dismissing it keeps it dismissed for that version, and only that version', async ({ page, electronApp }) => {
    await gotoFlow(page);
    await dismissFolderPrompt(page);
    await announce(electronApp, NEWER);

    await page.locator('#update-banner-dismiss').click();
    await expect(page.locator('#update-banner')).toBeHidden();

    await gotoFlow(page);
    await dismissFolderPrompt(page);
    await announce(electronApp, NEWER);
    await expect(page.locator('#update-banner')).toBeHidden();

    // A different release is different news.
    await announce(electronApp, { ...NEWER, version: 'v10.0.0' });
    await expect(page.locator('#update-banner')).toBeVisible();
    await expect(page.locator('#update-banner-link')).toHaveText('v10.0.0');
});

/**
 * The link opens the user's browser, and does not take the app with it.
 *
 * Without the handler in desktop/main.js this navigates the window itself to github.com --
 * the shell, the connected folders and any unsaved edits replaced by a web page, with no way
 * back but restarting the app. There is no back button here to notice it with.
 */
test('following the link leaves the app where it was', async ({ page, electronApp }) => {
    await gotoFlow(page, '?flow=dds');
    await dismissFolderPrompt(page);
    await announce(electronApp, NEWER);

    // Intercepted before it can reach a browser: what is being checked is that the *app*
    // does not go anywhere, and opening someone's browser mid-suite is rude.
    await electronApp.evaluate(({ shell }) => {
        globalThis.__openedExternally = [];
        shell.openExternal = async (url) => { globalThis.__openedExternally.push(url); };
    });

    await page.locator('#update-banner-link').click();

    expect(await electronApp.evaluate(() => globalThis.__openedExternally)).toEqual([NEWER.url]);
    expect(page.url()).toContain('app://modmaker/index.html');
    expect(await page.evaluate(() => window.activeFlow?.id)).toBe('dds');
});
