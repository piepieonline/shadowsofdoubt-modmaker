import { test, expect } from '@playwright/test';
import { installFsHarness, gotoFlow } from './support/harness.js';

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
    await expect(page.locator('#flow-root #path-to-read')).toHaveCount(1);
    // The other flow's markup stays in its template, out of the document.
    await expect(page.locator('#flow-root #manifest_panel')).toHaveCount(0);

    await gotoFlow(page, '?flow=scriptableObject');
    expect(await activeId(page)).toBe('scriptableObject');
    await expect(page.locator('#flow-root #manifest_panel')).toHaveCount(1);
    await expect(page.locator('#flow-root #path-to-read')).toHaveCount(0);
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

test('a DDS deep link selects the DDS flow without naming it', async ({ page }) => {
    // The old DDS Viewer was a separate site and the modding wiki links to it, so
    // its parameters have to keep working.
    await gotoFlow(page, '?documentId=74da6230-45ef-4bb4-8f2e-8f6840e56927&documentType=tree&caseEditorLink=true');

    expect(await activeId(page)).toBe('dds');
    await expect(page.locator('#path-to-read')).toHaveValue('74da6230-45ef-4bb4-8f2e-8f6840e56927');
    await expect(page.locator('#select-guid-type')).toHaveValue('tree');
});

test('the picker lists every flow and switching navigates', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');

    const picker = page.locator('#flow-picker');
    await expect(picker.locator('option')).toHaveText(['DDS Text Content', 'Cases & ScriptableObjects']);
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
    await page.goto('/flows/dds/?documentId=abc');
    await page.locator('html[data-flow-ready]').waitFor();

    const url = new URL(page.url());
    expect(url.pathname).toBe('/index.html');
    expect(url.searchParams.get('flow')).toBe('dds');
    expect(url.searchParams.get('documentId')).toBe('abc');
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
