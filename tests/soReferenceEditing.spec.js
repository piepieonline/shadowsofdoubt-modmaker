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
};

const WINDOW = '.file-window[path="testcase.sodso.json"]';
const SCROLLER = `${WINDOW} .jsontree-container`;

/** The label of a top-level key, which is what the tree hangs its controls off. */
const keyLabel = (page, key) => page.locator(
    `${WINDOW} li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"${key}"'))`);

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
    await keyLabel(page, 'compatibleWith').locator('> .jsontree_label-wrapper > .jsontree_label')
        .first().click({ button: 'right' });
    await keyLabel(page, 'compatibleWith').locator('.jsontree_expand-button').first().click();

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
