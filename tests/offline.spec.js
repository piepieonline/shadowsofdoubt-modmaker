import { test, expect } from '@playwright/test';
import {
    installFsHarness, blockExternalRequests, collectPageErrors, gotoFlow, seedFs,
    connectFolders, selectContent,
} from '../test-support/harness.js';
import { soFolderContent } from '../test-support/fixtures.js';

/**
 * The app reaches no origin but its own.
 *
 * Every dependency is bundled from node_modules rather than fetched from a CDN. Three
 * things rest on that and none of them are visible on a developer machine with a network:
 * the app works offline, it survives being mounted under a GitHub Pages project subpath,
 * and the desktop build can run under `default-src 'self' app:`. That CSP is what bounds
 * the filesystem access Electron grants the renderer, so a dependency drifting back to a
 * remote origin is a security regression, not only an offline one.
 *
 * Every other spec here would pass with the CDNs restored. These are the ones that would
 * not.
 *
 * The order matters: the guard is installed before the page is ever navigated, because
 * the tags in index.html are fetched during the first load and would otherwise be
 * through before any route existed.
 */

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

test('the shell loads with nothing fetched from another origin', async ({ page }) => {
    const blocked = blockExternalRequests(page);
    const errors = collectPageErrors(page);

    await gotoFlow(page, '');

    // jQuery and select2 are classic scripts publishing globals, and idb-keyval a UMD
    // bundle doing the same. A blocked one leaves the global undefined rather than
    // failing the navigation, so the absence has to be asserted directly.
    const globals = await page.evaluate(() => ({
        jquery: typeof window.jQuery,
        select2: typeof window.jQuery?.fn?.select2,
        idbKeyval: typeof window.idbKeyval,
        jsonpatch: typeof window.jsonpatch,
        jsonTree: typeof window.jsonTree,
    }));

    expect(globals).toEqual({
        jquery: 'function',
        select2: 'function',
        idbKeyval: 'object',
        jsonpatch: 'object',
        jsonTree: 'object',
    });

    // Pico is a stylesheet rather than a global, so it needs a signal of its own. A
    // custom property it defines on :root is a direct one: unset means the sheet is not
    // there, and it does not depend on any particular rule winning the cascade.
    const picoFont = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--pico-font-family-sans-serif'));

    expect(picoFont).toContain('system-ui');
    expect(blocked).toEqual([]);
    expect(errors).toEqual([]);
});

test('the floorplan view renders its tile labels without a network', async ({ page }) => {
    const blocked = blockExternalRequests(page);
    const errors = collectPageErrors(page);

    await gotoFlow(page, '?flow=dds');

    // The labels are the reason the font is vendored. troika resolves a font per
    // codepoint range from a CDN unless `defaultFontURL` is set, and it fails softly:
    // the scene builds, the floor draws, and the labels are simply never there. So this
    // asserts on laid-out glyphs rather than on the scene existing.
    const glyphs = await page.evaluate(async () => {
        const sceneModule = await import('/flows/building/scripts/scene.js');
        const { parseFloor } = await import('/flows/building/scripts/floorModel.js');

        const container = document.createElement('div');
        container.style.cssText = 'width: 640px; height: 480px; position: absolute; top: 0; left: 0;';
        document.body.appendChild(container);

        const floor = parseFloor(await (await fetch(
            '/refs/floors/blueprints/Hotel_GroundFloor.json')).json());

        const scene = await sceneModule.createScene(container);
        scene.setModel(floor);
        scene.draw();

        // `textRenderInfo` is what troika leaves behind once a label has a font, an atlas
        // and laid-out glyphs -- so counting those is the difference between "a Text
        // object exists" and "there is something on screen".
        const laidOut = () => scene._internals.tileLabels.children
            .filter((label) => label.textRenderInfo).length;

        // Laying out text is asynchronous -- a font to read and an atlas to build -- so
        // the first frame is drawn without it. Wait for the glyphs rather than a timer.
        const deadline = Date.now() + 15_000;
        let count = 0;

        while (Date.now() < deadline) {
            count = laidOut();
            if (count > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const markers = sceneModule.tileMarkers(floor).length;
        const rendered = scene._internals.tileLabels.children
            .filter((label) => label.textRenderInfo)
            .map((label) => label.text);

        scene.dispose();
        container.remove();

        return { count, markers, rendered };
    });

    // Asserted before the glyph count, because a leaked request is the cause and a
    // missing label only the symptom -- reading the failure the other way round sends
    // you looking at the scene.
    expect(blocked).toEqual([]);

    // The fixture floor has tiles worth labelling, so a zero here would mean the check
    // passed by having nothing to draw.
    expect(glyphs.markers).toBeGreaterThan(0);
    expect(glyphs.count).toBeGreaterThan(0);

    // The degree sign is the only non-ASCII character the labels ever carry, and the one
    // character a Latin subset could plausibly be missing. Rendering it is what says the
    // vendored subset really does cover the vocabulary.
    expect(glyphs.rendered.join('\n')).toContain('°');
    expect(errors).toEqual([]);
});

test('a walkthrough starts without a network', async ({ page }) => {
    const blocked = blockExternalRequests(page);
    const errors = collectPageErrors(page);

    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFolderContent);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    // driver.js is dynamic-imported the first time a walkthrough runs, so nothing before
    // this point would have touched it.
    await page.getByRole('button', { name: 'Tutorials' }).click();
    await page.getByRole('button', { name: 'Theft Gone Wrong' }).click();

    await expect(page.locator('.driver-popover')).toBeVisible();

    expect(blocked).toEqual([]);

    // The stylesheet is vendored beside the module and loaded by href, which is a
    // separate request that could fail on its own -- the popover would still appear,
    // unstyled. `static` is what it falls back to with no stylesheet; driver.css makes
    // it `fixed`.
    const positioned = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.driver-popover')).position);

    expect(positioned).not.toBe('static');
    expect(errors).toEqual([]);
});
