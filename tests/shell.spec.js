import { test, expect } from '@playwright/test';
import { installFsHarness, gotoFlow, seedFs, connectFolders, contrastGap } from '../test-support/harness.js';
import { ddsFixture, TREE_GUID } from '../test-support/fixtures.js';

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
 * own modals on the left, whatever it loads documents with in the centre, the Tools menu
 * on the right, and no title -- the shell nav above already names the app and the editor.
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
        // A menu rather than a link, so what is read here is the control that opens it.
        rightMenus: [...bar.querySelectorAll('ul:last-child details.browse > summary')]
            .map(summary => summary.textContent.trim()),
    };
});

for (const [flow, links] of [
    ['dds', ['Browse...', 'Reverse Search']],
    ['scriptableObject', ['Asset Explorer', 'Room Creator', 'Furniture Creator']],
]) {
    test(`the ${flow} header is one line: links left, controls centred, tools right`, async ({ page }) => {
        await gotoFlow(page, `?flow=${flow}`);
        const bar = await barLayout(page);

        expect(bar.headings).toBe(0);
        expect(bar.leftLinks).toEqual(links);
        expect(bar.rightMenus).toEqual(['Tools']);

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

/**
 * Tools, as one menu the whole app carries.
 *
 * Help was a link straight into each flow's help modal, said three different ways in the
 * markup. It is now Help/Summary inside the same control as the building flow's Browse
 * menu, in the same slot in every bar -- so there is somewhere for the next thing worth
 * reaching for to go.
 *
 * The closing is the shell's, not a flow's: a `<details>` stays open when the click goes
 * elsewhere, and one listener does that for every menu on the page. See core/barMenu.js.
 */
/**
 * Out of the way of the bar. A flow that needs a folder it has not been given opens this
 * over the page, and nothing here is about the folders -- the menu is reachable with none
 * of them connected, which is the point of it being the shell's.
 */
async function dismissFolders(page) {
    const modal = page.locator('#folders-modal');
    if (await modal.evaluate((dialog) => dialog.hasAttribute('open'))) {
        await page.locator('#folders-continue').click();
    }
    await expect(modal).not.toHaveAttribute('open', '');
}

test('Tools is one menu in every flow, and shuts when the click goes elsewhere', async ({ page }) => {
    for (const flow of ['dds', 'scriptableObject', 'building']) {
        await gotoFlow(page, `?flow=${flow}`);
        await dismissFolders(page);

        const menu = page.locator('#flow-root .flow-bar #tools-menu');
        const summary = menu.locator('> summary');
        const help = page.locator('#help-modal');

        await expect(summary).toHaveText('Tools');
        await expect(help).not.toHaveAttribute('open', '');

        // Opened and then left alone, which is the case a `<details>` gets wrong.
        await summary.click();
        await expect(menu).toHaveAttribute('open', '');
        await page.locator('#build-version').click();
        await expect(menu).not.toHaveAttribute('open', '');

        // And what it is for: the one item, which opens this flow's own help and takes
        // the menu with it.
        await summary.click();
        await menu.locator('.browse-menu-item', { hasText: 'Help/Summary' }).click();
        await expect(help).toHaveAttribute('open', '');
        await expect(menu).not.toHaveAttribute('open', '');

        await help.locator('.close-button').click();
        await expect(help).not.toHaveAttribute('open', '');
    }
});

/**
 * What is in the menu reads against the menu.
 *
 * Pico sets --pico-color to --pico-primary-inverse inside every button, because a button
 * is normally filled and its text sits on that fill. An item styled from it is therefore
 * white on the white a menu is drawn on -- which is what this caught, and why the item
 * inherits its colour from the page instead.
 */
test('the Tools menu item is readable against the menu', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await dismissFolders(page);
    await page.click('#tools-menu > summary');

    expect(await contrastGap(page, '#tools-menu .browse-menu-item', '#tools-menu .browse-menu'))
        .toBeGreaterThan(100);
});

/**
 * The menu opens back over the page rather than off the edge of it.
 *
 * It hangs off the right-hand end of the bar, which is a few pixels from the right of
 * the window: dropped straight down from its left edge -- which is what a menu on the
 * left of the bar does -- it would be almost entirely off screen.
 */
test('the Tools menu opens inside the window', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await dismissFolders(page);
    await page.click('#tools-menu > summary');

    const box = await page.locator('#tools-menu .browse-menu').boundingBox();
    const width = await page.evaluate(() => window.innerWidth);

    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
});

/**
 * The build number, at the foot of the page rather than of a flow.
 *
 * It was a footer inside each document flow's card, which said it twice and left the
 * building flow with nowhere to say it. Being the shell's, it is one line in one place
 * and the same line whichever editor is open.
 */
test('the build number is the last line of the page, in every flow', async ({ page }) => {
    let seen = null;

    for (const flow of ['dds', 'scriptableObject', 'building']) {
        await gotoFlow(page, `?flow=${flow}`);

        const measured = await page.evaluate(() => {
            const footer = document.querySelector('#build-version');
            const box = footer.getBoundingClientRect();
            const flowBox = document.getElementById('flow-root').getBoundingClientRect();

            // The line itself rather than the box around it: what the spacing below is
            // being compared against is the words, which is what anyone looking at the
            // page sees.
            const range = document.createRange();
            range.selectNodeContents(footer);
            const line = range.getBoundingClientRect();

            return {
                text: footer.textContent.trim(),
                // Under the flow, and the last thing laid out before the bottom of the
                // window -- not pushed off it by a workspace that took the whole height.
                belowTheFlow: box.top >= flowBox.bottom - 1,
                onScreen: box.bottom <= window.innerHeight + 1,
                // Smaller than the page it sits under, whatever size that is: Pico
                // scales its type with the viewport, so this is a ratio rather than a
                // number of pixels.
                relativeSize: parseFloat(getComputedStyle(footer).fontSize)
                    / parseFloat(getComputedStyle(document.body).fontSize),
                // One line. A flow's own footer was a centred block inside the card.
                lines: range.getClientRects().length,

                // The strip the line sits in, above and below it. The flow used to stop
                // short of the page by a whole block of Pico's spacing, and then a second
                // one inside it, so the line sat 45px under the workspace and 6px off the
                // bottom -- a band of empty page the workspace had a use for.
                above: line.top - flowBox.bottom,
                below: window.innerHeight - line.bottom,
            };
        });

        expect(measured.belowTheFlow, flow).toBe(true);
        expect(measured.onScreen, flow).toBe(true);
        expect(measured.relativeSize, flow).toBeLessThan(0.75);
        expect(measured.lines, flow).toBe(1);

        // Centred in that strip. Within a couple of pixels rather than exactly: the
        // padding either side of it is equal, and what is left over is where the glyphs
        // fall inside their own line box.
        expect(Math.abs(measured.above - measured.below), flow).toBeLessThanOrEqual(2);

        // The same answer in each, which is the point of it being the shell's.
        seen ??= measured;
        expect(measured, flow).toEqual(seen);
    }

    // This used to assert `{{ site.github.build_revision }}` -- the Jekyll template, on the
    // grounds that seeing it unsubstituted was proof the element was still wired to the
    // build. It stopped being proof of anything when Pages started deploying a prebuilt Vite
    // artifact instead of running Jekyll: nothing substituted it any more, and every visitor
    // read the template text. The test went on passing, because the template was what it
    // asked for. So the assertion is now on the shape of an answer rather than on a literal.
    expect(seen.text).not.toContain('{{');
    expect(seen.text).toMatch(/^(?:[0-9a-f]{7}|unknown)$/);
});

/**
 * The footer says which build this is, and links to it.
 *
 * Both outcomes are legitimate and which one appears is a property of where the build was
 * made, not of the app: a commit when `GITHUB_SHA` is set or git can be asked, and `unknown`
 * from a tarball or a worktree with no repository behind it. So this pins the two shapes and
 * the link, and leaves proving that a commit actually reaches the page to `tests-build/`,
 * which can set the environment it builds in and assert on an exact value.
 *
 * On the web the commit is the whole identity -- the site is whatever was deployed last and
 * has no version to give. tests-desktop/shell.spec.js covers the half that adds the release.
 */
test('the footer names the build, and a commit is a link to itself', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');

    const footer = page.locator('#build-version');
    const link = footer.locator('a');

    if (await link.count() === 0) {
        await expect(footer).toHaveText('unknown');
        return;
    }

    const href = await link.getAttribute('href');
    const shown = (await link.textContent()).trim();

    expect(href).toMatch(/^https:\/\/github\.com\/piepieonline\/shadowsofdoubt-modmaker\/commit\/[0-9a-f]{7,40}$/);

    // Shown short, linked long. An abbreviation is a display decision and has no business in
    // a URL that has to keep resolving as the repository grows past seven characters of
    // uniqueness.
    expect(shown).toMatch(/^[0-9a-f]{7}$/);
    expect(href).toContain(shown);

    // On desktop this would replace the app, its connected folders and any unsaved edits
    // with a web page if desktop/main.js did not intercept it. Marked the way an outside
    // link should be either way.
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noreferrer');
});

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
