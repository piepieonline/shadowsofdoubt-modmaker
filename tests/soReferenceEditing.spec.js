import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, connectFolders, selectContent, gotoFlow, alerts } from './support/harness.js';
import { soFolderContent } from './support/fixtures.js';

/**
 * Editing a reference field in the case editor.
 *
 * These are the `REF:Type|Name` values, and they are the one place the flow hands a
 * control to select2 rather than rendering its own. That has consequences the rest of
 * the editor does not have to think about -- see the scrolling test below.
 */

/**
 * A case with an empty reference array to fill, and enough after it that the document
 * has to scroll. compatibleWith comes first so its control is on screen without
 * scrolling to it.
 */
const caseWithRefArray = {
    ...soFolderContent,
    'Mods/TestCase/testcase.sodso.json': JSON.stringify(
        Object.fromEntries([
            ['fileType', 'MurderMO'], ['name', 'testcase'], ['compatibleWith', []],
            ...Array.from({ length: 40 }, (_, i) => [`field${i}`, `value ${i}`]),
        ]), null, 2),

    // A second one to fill, for the test that needs a control in a window other than the
    // first -- the row of documents is what it scrolls, so the one it asks about has to
    // be the one still on screen at the end of it.
    'Mods/TestCase/AnotherMurder.sodso.json': JSON.stringify(
        { fileType: 'MurderMO', name: 'AnotherMurder', compatibleWith: [] }, null, 2),
};

const WINDOW = '.file-window[path="testcase.sodso.json"]';
const SCROLLER = `${WINDOW} .jsontree-container`;

/** The label of a top-level key, which is what the tree hangs its controls off. */
const keyLabel = (page, key, window = WINDOW) => page.locator(
    `${window} li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"${key}"'))`);

/** Add an element to an empty array field, and open it, leaving its control on screen. */
async function addRefElement(page, key, window = WINDOW) {
    await keyLabel(page, key, window).locator('> .jsontree_label-wrapper > .jsontree_label')
        .first().click({ button: 'right' });
    await keyLabel(page, key, window).locator('.jsontree_expand-button').first().click();
}

/** Scroll the open document and report where it ended up. */
async function scrollBy(page, amount) {
    await page.evaluate((s) => { document.querySelector(s).scrollTop = 0; }, SCROLLER);

    const box = await page.locator(SCROLLER).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, amount);

    // Settled rather than immediate: a handler that fights the scroll does so on the
    // scroll event, so reading too early would see the value before it was put back.
    await page.waitForTimeout(400);
    return page.evaluate((s) => document.querySelector(s).scrollTop, SCROLLER);
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, caseWithRefArray);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');
    await page.locator('.file-panel-category[data-category="MurderMO"]')
        .getByRole('button', { name: 'testcase' }).click();
    await page.locator(SCROLLER).waitFor();
});

test('the document still scrolls after picking a reference', async ({ page }) => {
    expect(await scrollBy(page, 400)).toBe(400);

    // Right-click adds an array element; the tree rebuilds around it.
    await keyLabel(page, 'compatibleWith').locator('> .jsontree_label-wrapper > .jsontree_label')
        .first().click({ button: 'right' });
    await expect(page.locator(`${WINDOW} .select2`)).toHaveCount(1);

    await keyLabel(page, 'compatibleWith').locator('.jsontree_expand-button').first().click();
    expect(await scrollBy(page, 400)).toBe(400);

    // Choosing an option is what used to break it. While its dropdown is open select2
    // binds a scroll handler to each scrollable ancestor that puts the scroll position
    // back, and unbinds them on close. The change rebuilds the tree, taking the
    // <select> away before select2 closes, so the handler was left bound to the
    // container -- which is not rebuilt. Scrolling snapped back for as long as the file
    // stayed open, and closing nothing recovered it.
    await page.locator(`${WINDOW} .select2-selection`).first().click();
    await page.locator('.select2-results__option').nth(3).click();
    await expect(page.locator(`${WINDOW} .select2`)).toHaveCount(1);

    expect(await scrollBy(page, 400)).toBe(400);

    // And nothing is left bound to the container to do it later.
    const leaked = await page.evaluate((s) => {
        const events = window.jQuery?._data(document.querySelector(s), 'events');
        return (events?.scroll ?? []).map((handler) => handler.namespace);
    }, SCROLLER);
    expect(leaked).toEqual([]);

    expect(await alerts(page)).toEqual([]);
});

test('picking a reference writes it to the file', async ({ page }) => {
    await addRefElement(page, 'compatibleWith');

    await page.locator(`${WINDOW} .select2-selection`).first().click();
    const chosen = await page.locator('.select2-results__option').nth(3).textContent();
    await page.locator('.select2-results__option').nth(3).click();

    // Closing select2 early must not cost the edit itself.
    await expect.poll(async () => page.evaluate(async () => {
        const handle = await window.selectedMod.baseFolder.getFileHandle('testcase.sodso.json');
        return JSON.parse(await (await handle.getFile()).text()).compatibleWith;
    })).toEqual([`REF:MurderPreset|${chosen.trim()}`]);

    expect(await alerts(page)).toEqual([]);
});

/**
 * The dropdown opens where its control is, however far along the row of documents that
 * control has been scrolled.
 *
 * select2 places the dropdown by taking the control's document position and subtracting
 * the offset parent's, and never adds that parent's own scroll back on -- so when the
 * offset parent is the element doing the scrolling, the scroll comes off twice: once
 * because the control has moved, and once again in the subtraction. The row of documents
 * carries a `position` of its own to keep that from happening, and the scrolling is a box
 * around it; see `.tree-scroll` in core/documentFlow.css.
 *
 * Only reachable with enough documents open to fill the row, which is why this test
 * opens four.
 */
test('a dropdown opens against its control with the documents scrolled', async ({ page }) => {
    const others = ['IP_Note', 'EP_Flyer', 'AnotherMurder'];
    for (const name of others) {
        await page.locator('#so-file-list').getByRole('button', { name, exact: true })
            .first().click();
        await page.locator(`.file-window[path*="${name}"]`).waitFor();
    }

    // The last one opened, so it is the one on screen once the row is at its end.
    const last = '.file-window[path="AnotherMurder.sodso.json"]';
    await addRefElement(page, 'compatibleWith', last);

    const scrolled = await page.evaluate(() => {
        const scroller = document.querySelector('.tree-scroll');
        scroller.scrollLeft = scroller.scrollWidth;
        return scroller.scrollLeft;
    });

    // The premise: four documents overflow the panel. Without that there is no scroll to
    // be counted twice, and the assertion below would hold whatever select2 did.
    expect(scrolled).toBeGreaterThan(0);

    const control = page.locator(`${last} .select2-selection`).first();
    await control.click();

    const controlBox = await control.boundingBox();
    const dropdownBox = await page.locator('.select2-dropdown').boundingBox();

    // Still where it was put: clicking scrolls the control into view first, and a control
    // brought back to the left would make the numbers below agree for the wrong reason.
    expect(await page.evaluate(() => document.querySelector('.tree-scroll').scrollLeft))
        .toBe(scrolled);

    expect(dropdownBox.x).toBeCloseTo(controlBox.x, 0);

    expect(await alerts(page)).toEqual([]);
});
