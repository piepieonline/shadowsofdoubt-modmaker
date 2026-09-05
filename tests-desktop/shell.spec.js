import { test, expect, gotoFlow, APP_ORIGIN } from './support/launch.js';
import { alerts, collectPageErrors, queueDismissedPick, queuePicks, seedFs } from '../test-support/harness.js';
import { pluginsFixture } from '../test-support/fixtures.js';

/**
 * The seam between the app and the Electron shell around it.
 *
 * Not the app's behaviour, which tests/ owns and which is the same Chromium either way. What
 * is different here is everything the bundle is served *by*: a custom scheme instead of a
 * web server, a preload script instead of nothing, and a set of privileges the app cannot
 * work without and cannot check for itself.
 */

test('the window opens on the built bundle, served over app://', async ({ page }) => {
    const errors = collectPageErrors(page);

    await gotoFlow(page, '?flow=scriptableObject');

    expect(page.url()).toBe(`${APP_ORIGIN}/index.html?flow=scriptableObject`);
    expect(await page.title()).toBe('SoD Mod Maker');
    expect(errors).toEqual([]);
});

/**
 * The three privileges the scheme is registered with, checked by their consequences rather
 * than by reading the registration back.
 *
 * Each one is load-bearing and each fails in a way that does not name itself. Without
 * `secure`, `showDirectoryPicker` is simply not defined and every folder prompt does
 * nothing. Without `standard` the origin is opaque, which means no durable storage, which
 * means core/folders.js can remember nothing and every launch starts with no folders. And
 * `supportFetchAPI` is how every file under refs/ is read.
 */
test('the page is a secure context with the filesystem API and a real origin', async ({ page }) => {
    await gotoFlow(page);

    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    expect(await page.evaluate(() => typeof window.showDirectoryPicker)).toBe('function');
    expect(await page.evaluate(() => window.location.origin)).toBe(APP_ORIGIN);

    // Durable storage, which an opaque origin does not get. Written and read back rather
    // than asserted from the origin string, because it is the storage that matters.
    expect(await page.evaluate(async () => {
        await idbKeyval.set('desktop-probe', { kept: true });
        return (await idbKeyval.get('desktop-probe'))?.kept ?? null;
    })).toBe(true);
});

test('the preload publishes what it says it does, and nothing else', async ({ page }) => {
    await gotoFlow(page);

    expect(await page.evaluate(() => Object.keys(window.__desktop).sort()))
        .toEqual(['appVersion', 'isDesktop', 'onUpdateAvailable']);

    // No filesystem bridge. The renderer reaches the disk through the File System Access
    // API, exactly as the web build does; that is what makes this shell cheap to keep.
    expect(await page.evaluate(() =>
        Object.keys(window).some((k) => /require|electron|ipc|fs$/i.test(k)))).toBe(false);

    const { isDesktop, appVersion } = await page.evaluate(() => ({ ...window.__desktop }));
    expect(isDesktop).toBe(true);
    expect(appVersion).toMatch(/^\d+\.\d+\.\d+/);
});

/**
 * core/platform.js, checked by what it changes rather than by importing it.
 *
 * The web suites can `import('/core/platform.js')` because they run against the dev server,
 * which serves source at its real paths. Here the module is inside a Rollup chunk and there
 * is no such path -- so the thing to assert is the behaviour that depends on it.
 *
 * A pick that comes back with nothing is that behaviour. On the web it raises a message
 * about `Program Files`, because Chromium refuses those folders and reports the refusal as a
 * cancel. Here the blocklist is lifted, a rejection really is a cancel, and saying otherwise
 * would be telling the user to go and get the build they are already running.
 */
test('a dismissed folder pick says nothing, because here it really was dismissed', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, pluginsFixture);

    await queueDismissedPick(page);
    await page.locator('[data-select-folder="modDir"]').click();
    await expect(page.locator('.folder-row[data-folder="modDir"][data-state="missing"]')).toBeVisible();

    // A pick that succeeds afterwards, so there is a point at which the dismissed one is
    // certainly finished. `click()` returns when the click is dispatched, not when the
    // handler it started has run, and an absence asserted before then asserts nothing.
    await queuePicks(page, ['Plugins']);
    await page.locator('[data-select-folder="modDir"]').click();
    await expect(page.locator('.folder-row[data-folder="modDir"][data-state="connected"]')).toBeVisible();

    expect(await alerts(page)).toEqual([]);
});

/**
 * A file that is not there answers 404, and does not answer with index.html.
 *
 * `readBaseAsset` reads a failed fetch of `refs/assets/<Type>/<Name>.json` as "the base game
 * asset is not shipped", which is how the app knows to ask for an exported ScriptableObjects
 * folder. Serve a page of HTML instead and that becomes a JSON parse error standing in for a
 * missing file -- the bug vite.config.js turns off the single-page fallback to avoid, made
 * again in the protocol handler.
 */
test('a missing file is a 404, not the index page', async ({ page }) => {
    await gotoFlow(page);

    expect(await page.evaluate(async () => {
        const response = await fetch('./refs/assets/NoSuchType/NoSuchName.json');
        return { status: response.status, body: (await response.text()).slice(0, 20) };
    })).toEqual({ status: 404, body: 'Not found' });
});

/**
 * Nothing above the bundle is reachable, however the path is written.
 *
 * Two things have to be true and only one of them is ours. Chromium normalises `..` out of a
 * standard scheme's URL before the request is made -- including the percent-encoded spelling
 * -- so by the time `serve` sees it the path is already inside. The guard in the handler is
 * the second layer, for anything that reaches `protocol.handle` without going through the
 * renderer's URL parser.
 *
 * So this asserts the property rather than a status code: the repo above `dist-desktop/` is
 * not served. It was written against 403 first, which passed for the wrong reason -- the
 * request never got out of the URL parser and answered 404.
 */
test('nothing above the bundle is served, however the path is spelled', async ({ page }) => {
    await gotoFlow(page);

    expect(await page.evaluate(async () => {
        const tries = ['./%2e%2e/package.json', './../package.json', './../../etc/hosts'];

        return Promise.all(tries.map(async (path) => {
            const response = await fetch(path);
            return { path, ok: response.ok, body: (await response.text()).slice(0, 40) };
        }));
    })).toEqual([
        { path: './%2e%2e/package.json', ok: false, body: 'Not found' },
        { path: './../package.json', ok: false, body: 'Not found' },
        { path: './../../etc/hosts', ok: false, body: 'Not found' },
    ]);
});

/**
 * No remote origin may be reached, which is what bounds the blocklist grant.
 *
 * Allowing every path the browser would refuse is a wide thing to do, and it is only
 * defensible while the renderer cannot be made to run somebody else's code. tests/ and
 * tests-build/ both assert the bundle does not *try* to; this asserts it would not be
 * allowed to if it did.
 */
test('the policy served with the page forbids every remote origin', async ({ page }) => {
    await gotoFlow(page);

    const csp = await page.evaluate(async () =>
        (await fetch('./index.html')).headers.get('content-security-policy'));

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/https?:/);

    // And enforced, not merely declared.
    expect(await page.evaluate(() =>
        fetch('https://example.com/').then(() => 'allowed', () => 'blocked'))).toBe('blocked');
});

/**
 * The policy still permits what the floorplan view's text is built out of.
 *
 * troika-worker-utils ships its worker by stringifying functions and rebuilding them on the
 * other side with `new Function`. The first version of this CSP had no `'unsafe-eval'`, so
 * that threw inside the worker, the module never initialised, and every piece of text in the
 * 3D view vanished -- the tile labels and the mark on the selected square both. Nothing said
 * so: the floor drew correctly, in the right colours, with the words simply absent.
 *
 * Asserted here as a capability rather than by reading the header back, because the header is
 * not the thing that broke -- what broke was something the header made impossible. In a worker
 * specifically: that is where troika does it, and a main-thread check would not have caught
 * this, since Playwright's own `evaluate` is not subject to the page's policy.
 */
test('the policy permits the eval that troika rebuilds its worker with', async ({ page }) => {
    await gotoFlow(page);

    expect(await page.evaluate(async () => {
        const code = `self.onmessage = () => {
            try { self.postMessage(new Function('return 41 + 1')()); }
            catch (e) { self.postMessage(String(e)); }
        };`;

        const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));

        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve('timed out'), 10_000);
            worker.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
            worker.onerror = (e) => { clearTimeout(timer); resolve(`worker error: ${e.message}`); };
            worker.postMessage(1);
        });
    })).toBe(42);
});

/**
 * The footer carries the release as well as the commit, which is the desktop half.
 *
 * A downloaded binary needs both and the web build needs neither. The version is what a user
 * can tell you -- it is what they clicked to download and what the update banner compares
 * against -- and the commit is what is actually inside it, which a re-tagged or rebuilt
 * release does not change. `tests-build/buildStamp.spec.js` covers the commit end to end
 * against a controlled build; this covers the part that only exists here.
 */
test('the footer names the release, not just the commit', async ({ page }) => {
    await gotoFlow(page);

    const footer = page.locator('#build-version');
    const version = await page.evaluate(() => window.__desktop.appVersion);

    await expect(footer).toContainText(`v${version}`);
    await expect(footer).not.toContainText('{{');

    // The commit sits after it when the build knew one, separated rather than run together.
    // This suite's bundle is built without GITHUB_SHA and outside a repository, so `unknown`
    // is the expected answer here and a hash would be just as valid.
    expect(await footer.textContent()).toMatch(
        new RegExp(`^v${version.replace(/\./g, '\\.')}(?: · [0-9a-f]{7})?$`));
});

/**
 * The flow registry, over app://.
 *
 * Switching flows swaps markup in place rather than navigating, and the shell's own
 * `?flow=` deep link does navigate -- so this is the one part of the app's behaviour worth
 * repeating here, because both halves of it depend on the origin being what the app thinks
 * it is.
 */
test('every flow is offered and switching between them works', async ({ page }) => {
    await gotoFlow(page);

    expect(await page.locator('#flow-picker option').allTextContents())
        .toEqual(['DDS Text Content', 'Cases & ScriptableObjects', 'Building Floorplans']);

    await gotoFlow(page, '?flow=dds');
    expect(await page.evaluate(() => window.activeFlow?.id)).toBe('dds');

    await page.selectOption('#flow-picker', 'building');
    await page.locator('html[data-flow-ready]').waitFor();
    expect(await page.evaluate(() => window.activeFlow?.id)).toBe('building');

    // Still the app's own origin: a flow switch must not have navigated anywhere.
    expect(await page.evaluate(() => window.location.origin)).toBe(APP_ORIGIN);
});
