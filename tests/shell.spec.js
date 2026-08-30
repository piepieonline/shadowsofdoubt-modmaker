import { test, expect } from '@playwright/test';
import { installFsHarness, gotoFlow, seedFs, connectFolders } from './support/harness.js';
import { ddsFixture, TREE_GUID } from './support/fixtures.js';

/**
 * The shell: one page hosting every flow, chosen by URL.
 *
 * Only the requested flow is mounted. The two share element ids (#trees, #help-modal),
 * so both being present at once would break getElementById for whichever came second.
 */

const activeId = (page) => page.evaluate(() => window.activeFlow?.id ?? null);

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

test('?flow= selects which flow is mounted', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    expect(await activeId(page)).toBe('dds');
    await expect(page.locator('#flow-root #dds-file-panel')).toHaveCount(1);
    // The other flow's markup stays in its template, out of the document.
    await expect(page.locator('#flow-root #manifest_panel')).toHaveCount(0);

    await gotoFlow(page, '?flow=scriptableObject');
    expect(await activeId(page)).toBe('scriptableObject');
    await expect(page.locator('#flow-root #manifest_panel')).toHaveCount(1);
    await expect(page.locator('#flow-root #dds-file-panel')).toHaveCount(0);
});

test('only one flow is ever in the document, so shared ids resolve', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');

    const duplicates = await page.evaluate(() => {
        const seen = new Set();
        const dupes = [];
        for (const el of document.querySelectorAll('[id]')) {
            if (seen.has(el.id)) dupes.push(el.id);
            seen.add(el.id);
        }
        return dupes;
    });

    expect(duplicates).toEqual([]);
    // #trees is one of the four ids both flows use.
    expect(await page.evaluate(() => document.querySelectorAll('#trees').length)).toBe(1);
});

test('an unknown or missing flow falls back rather than failing', async ({ page }) => {
    await gotoFlow(page, '?flow=does-not-exist');
    expect(await activeId(page)).toBe('scriptableObject');

    await gotoFlow(page, './');
    expect(await activeId(page)).toBe('scriptableObject');
});

test('a link naming a document by GUID opens it, with no mod selected', async ({ page }) => {
    // A GUID says which document without saying which of the three kinds it is, which
    // is all a link to one can reasonably know -- the modding wiki's links say only
    // this, and so does a reference followed out of a case file. The kind is worked out
    // from the reference data.
    await gotoFlow(page, `?flow=dds&open=${encodeURIComponent(`["${TREE_GUID}"]`)}`);
    expect(await activeId(page)).toBe('dds');

    // Nothing can be opened until the game folder is connected, since that is where the
    // document is read from. The link waits rather than giving up.
    await seedFs(page, ddsFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

    await expect(page.locator('#file-window-0'))
        .toHaveAttribute('path', `DDS/Trees/${TREE_GUID}.tree`);

    // And the URL now names the file rather than the GUID: the same state, said the way
    // everything else says it.
    await expect.poll(() => new URL(page.url()).searchParams.get('open'))
        .toContain(`DDS/Trees/${TREE_GUID}.tree`);
});

test('the picker lists every flow and switching navigates', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');

    const picker = page.locator('#flow-picker');
    await expect(picker.locator('option')).toHaveText([
        'DDS Text Content', 'Cases & ScriptableObjects', 'Building Floorplans',
    ]);
    await expect(picker).toHaveValue('dds');

    await picker.selectOption('scriptableObject');
    await page.locator('html[data-flow-ready="scriptableObject"]').waitFor();

    expect(new URL(page.url()).searchParams.get('flow')).toBe('scriptableObject');
    expect(await activeId(page)).toBe('scriptableObject');
});

test('each flow gets only its own stylesheets', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    let styles = await page.evaluate(() =>
        [...document.querySelectorAll('link[data-flow-style]')].map((l) => l.getAttribute('href')));
    expect(styles.join()).toContain('flows/dds/');
    expect(styles.join()).not.toContain('scriptableObject');

    await gotoFlow(page, '?flow=scriptableObject');
    styles = await page.evaluate(() =>
        [...document.querySelectorAll('link[data-flow-style]')].map((l) => l.getAttribute('href')));
    expect(styles.join()).toContain('flows/scriptableObject/');
    expect(styles.join()).not.toContain('flows/dds/');
});

test('the old per-flow URLs redirect and keep their parameters', async ({ page }) => {
    await page.goto('/flows/dds/?strings=Strings/english.csv');
    await page.locator('html[data-flow-ready]').waitFor();

    const url = new URL(page.url());
    expect(url.pathname).toBe('/index.html');
    expect(url.searchParams.get('flow')).toBe('dds');
    expect(url.searchParams.get('strings')).toBe('Strings/english.csv');
    expect(await activeId(page)).toBe('dds');
});

test('the flow area is marked busy until the flow is ready', async ({ page }) => {
    // Reference data loads on activation, so there is a window where the page is
    // up but the flow is not usable.
    await page.goto('?flow=dds');
    await page.locator('html[data-flow-ready]').waitFor();
    await expect(page.locator('#flow-root')).not.toHaveAttribute('aria-busy', 'true');
});

test('the shell nav fits the viewport', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');

    // Pico gives nav's last <ul> a negative right margin to offset li padding,
    // which pushed the picker off screen.
    const { right, viewport } = await page.evaluate(() => ({
        right: document.querySelector('#flow-picker').getBoundingClientRect().right,
        viewport: window.innerWidth,
    }));
    expect(right).toBeLessThanOrEqual(viewport);
});

/**
 * The case flow used to hide its full width behind an expand button, and the DDS flow
 * ran edge to edge. Both now sit in the shared .flow-container gutter, so the frame
 * does not move when you switch between them.
 */
test('both flows sit in the same gutter, at full width', async ({ page }) => {
    const edges = async (path) => {
        await gotoFlow(page, path);
        return page.evaluate(() => {
            const r = document.querySelector('#flow-root > .flow-container').getBoundingClientRect();
            return { left: r.left, right: r.right, viewport: window.innerWidth };
        });
    };

    const dds = await edges('?flow=dds');
    const so = await edges('?flow=scriptableObject');

    expect(dds).toEqual(so);
    // Inset on both sides, and using everything the gutter leaves. The case flow's
    // collapsed width was ~1200px of a 1280px viewport, so a regression to a Pico
    // breakpoint container would still be inset but much narrower.
    expect(dds.left).toBe(50);
    expect(dds.right).toBe(dds.viewport - 50);
});

/**
 * The per-flow bar, which both flows now build the same way: links into that flow's
 * own modals on the left, whatever it loads documents with in the centre, Help on the
 * right, and no title -- the shell nav above already names the app and the editor.
 *
 * The case flow's bar was a two-line hgroup with the links stacked under a heading,
 * and the DDS flow's was a heading plus two button groups, so this is what stops
 * either drifting back.
 */
const barLayout = (page) => page.evaluate(() => {
    const bar = document.querySelector('#flow-root .flow-bar');
    const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, middle: (r.top + r.bottom) / 2, centre: (r.left + r.right) / 2 };
    };

    const [left, centre, right] = [...bar.children].map(box);
    return {
        bar: box(bar),
        left, centre, right,
        // Anything hidden by the mode toggles is not on this line at all.
        rows: [...bar.querySelectorAll('li')].filter(li => li.offsetParent !== null).map(li => box(li).middle),
        headings: bar.querySelectorAll('h1, h2, hgroup, strong').length,
        leftLinks: [...bar.querySelectorAll('ul:first-child a')].map(a => a.textContent.trim()),
        rightLinks: [...bar.querySelectorAll('ul:last-child a')].map(a => a.textContent.trim()),
    };
});

for (const [flow, links] of [
    ['dds', ['Browse...', 'Reverse Search']],
    ['scriptableObject', ['Asset Explorer']],
]) {
    test(`the ${flow} header is one line: links left, controls centred, help right`, async ({ page }) => {
        await gotoFlow(page, `?flow=${flow}`);
        const bar = await barLayout(page);

        expect(bar.headings).toBe(0);
        expect(bar.leftLinks).toEqual(links);
        expect(bar.rightLinks).toEqual(['Help']);

        // One line: everything on the bar shares its vertical centre. Anything that
        // wrapped would sit above or below it.
        for (const middle of bar.rows) {
            expect(Math.abs(middle - bar.bar.middle)).toBeLessThanOrEqual(1);
        }

        // Centred against the bar itself, not merely between its neighbours: with
        // Pico's space-between the middle group lands wherever the two sides leave it.
        expect(Math.abs(bar.centre.centre - bar.bar.centre)).toBeLessThanOrEqual(1);

        expect(Math.abs(bar.left.left - bar.bar.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(bar.right.right - bar.bar.right)).toBeLessThanOrEqual(1);
    });
}

test('the tree area fits below the chrome rather than overflowing it', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');

    // Sizes against its container. A viewport-height calculation here would be
    // wrong, since the shell nav sits above the flow.
    const { bottom, viewport } = await page.evaluate(() => ({
        bottom: document.querySelector('#trees').getBoundingClientRect().bottom,
        viewport: window.innerHeight,
    }));
    expect(bottom).toBeLessThanOrEqual(viewport + 1);
});
