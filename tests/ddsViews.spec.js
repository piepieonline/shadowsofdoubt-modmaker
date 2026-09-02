import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, selectContent, readFile, collectPageErrors,
    gotoFlow, openDdsDocument, fieldInput,
} from '../test-support/harness.js';
import { ddsFixture, TREE_GUID, MSG_GUID, NEWS_TREE_GUID } from '../test-support/fixtures.js';

/**
 * Views: showing a tree the fields its own kind is read for.
 *
 * The six kinds of DDS tree barely share a format. A document is a page with elements
 * placed on it; a conversation is two citizens and a branch graph; a misc tree is a bag of
 * messages other systems pull by ID. They are one C# class, so the editor showed one set
 * of 23 fields for all of them -- and an author writing a note on a scrap of paper was
 * asked which citizen says it and how likely it is to fire.
 *
 * What is checked here is the two halves of that: the right rows come off the screen, and
 * nothing about the file changes when they do. The table itself is covered by
 * flows/dds/scripts/treeViews.unit.spec.js, which checks every entry in it against the
 * game's type layout.
 */

/** The fixture tree is a vmail (treeType 1). */
async function openVmail(page) {
    await seedFs(page, ddsFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await openDdsDocument(page, TREE_GUID);
    await page.locator('#file-window-2 .jsontree_child-nodes').first().waitFor();
}

const selectMod = (page) => selectContent(page, 'TestMod', 'Content');

/** One row of a document, by the key it is labelled with. */
const row = (page, window, name) => page.locator(
    `${window} li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"${name}"'))`
).first();

const dropdown = (page, window, name) => row(page, window, name).locator('select').first();

const showAll = (page, on = true) =>
    page.locator('#dds-show-all-fields').setChecked(on);

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

test('a tree arrives showing what its own kind reads', async ({ page }) => {
    const errors = collectPageErrors(page);
    await gotoFlow(page, '?flow=dds');
    await openVmail(page);

    // A vmail is a thread on a computer. It has no paper to draw on, it does not hold
    // anybody still while it plays, and nothing consults a city-wide repeat lock for it.
    await expect(row(page, '#file-window-0', 'document')).toBeHidden();
    await expect(row(page, '#file-window-0', 'stopMovement')).toBeHidden();

    // What it does read stays put.
    await expect(row(page, '#file-window-0', 'participantA')).toBeVisible();
    await expect(row(page, '#file-window-0', 'startingMessage')).toBeVisible();
    await expect(row(page, '#file-window-0', 'treeType')).toBeVisible();
    // Shown but rarely the point: still a field, still on screen.
    await expect(row(page, '#file-window-0', 'priority')).toBeVisible();

    expect(errors).toEqual([]);
});

test('the switch puts every field back, and takes them away again', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openVmail(page);

    await showAll(page);
    await expect(row(page, '#file-window-0', 'document')).toBeVisible();
    await expect(row(page, '#file-window-0', 'stopMovement')).toBeVisible();

    await showAll(page, false);
    await expect(row(page, '#file-window-0', 'document')).toBeHidden();
});

test('a field is hidden whatever value it holds', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openVmail(page);

    // The point of the feature, and the thing the shipped data argues against: 386 of 472
    // conversation messages carry an `order`, and nothing sorts by it outside a document.
    // A number in a field the game never reads looks like a setting and is not one, so it
    // goes -- the fixture's messages have one and it is still hidden.
    await expect(row(page, '#file-window-0', 'order')).toBeHidden();

    await showAll(page);
    await expect(fieldInput(page, '#file-window-0', 'order')).toHaveValue('0');
});

test('hiding a field changes nothing about the file', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openVmail(page);
    await selectMod(page);

    // The whole safety property. A view is CSS classes over a rendered tree: it never
    // patches the document, and a hidden field is written back out exactly as it was read
    // in. Editing one visible field is what makes the patch exist to be looked at.
    await fieldInput(page, '#file-window-0', 'name').fill('RenamedUnderAView');
    await fieldInput(page, '#file-window-0', 'name').blur();

    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;
    await expect.poll(async () => JSON.parse((await readFile(page, patchPath)) ?? '[]'))
        .toEqual([{ op: 'replace', path: '/name', value: 'RenamedUnderAView' }]);

    // Nothing about `document`, `stopMovement` or any message's `order`, all of which
    // were off the screen for the whole edit.
});

test('changing the kind of tree changes the view', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openVmail(page);
    await selectMod(page);

    await expect(row(page, '#file-window-0', 'document')).toBeHidden();
    await expect(row(page, '#file-window-0', 'participantA')).toBeVisible();

    // treeType is a dropdown in this very tree, and editing anything rebuilds the whole
    // tree -- so the view is re-decided on the way back rather than fixed when the
    // document was opened. 2 is `document`.
    await dropdown(page, '#file-window-0', 'treeType').selectOption('2');

    // A note does not have a speaker, and it is not said to anybody.
    await expect(row(page, '#file-window-0', 'participantA')).toBeHidden();
    await expect(row(page, '#file-window-0', 'startingMessage')).toBeHidden();
    // It does have a page.
    await expect(row(page, '#file-window-0', 'document')).toBeVisible();
    await expect(row(page, '#file-window-0', 'order')).toBeVisible();
});

test('a message takes its view from the tree it was drilled into', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openVmail(page);

    // baseSuccessChance and events become part of a dialog option, which only an
    // interactionDialog tree generates. The message document below a vmail has no use for
    // either -- and a message is a document of its own, so it can only learn that from
    // the tree above it.
    await expect(row(page, '#file-window-1', 'events')).toHaveCount(0);

    // The window is a message, not the tree: this is the level the assertion is about.
    await expect(page.locator('#file-window-1')).toContainText('TestMessage');
});

test('a message opened on its own shows everything', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

    // No tree above it to take a kind from. Not knowing what a document is for has never
    // been a reason to take fields off the screen.
    await openDdsDocument(page, MSG_GUID, 'message');
    await expect(page.locator('#file-window-0')).toContainText('TestMessage');

    await expect(row(page, '#file-window-0', 'blocks')).toBeVisible();
});

test('trigger points are the ones this kind of tree can have', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openVmail(page);
    await selectMod(page);

    const triggerPoint = dropdown(page, '#file-window-0', 'triggerPoint');

    // §2: treeType and triggerPoint are coupled, and a vmail is dispatched by `vmail`(3)
    // or is dormant at `never`(5). The other six are other subsystems, none of which will
    // ever look at a vmail.
    //
    // The fixture holds `newspaperArticle`(6), which is not one of them -- and is offered
    // anyway, because a control that could not show its own file's value would sit there
    // displaying a different one.
    await expect(triggerPoint).toHaveValue('6');
    await expect(triggerPoint.locator('option')).toHaveText(
        ['vmail', 'never', 'newspaperArticle']);

    // Moving to a valid one drops the invalid entry, since nothing holds it any more.
    await triggerPoint.selectOption('3');
    await expect(dropdown(page, '#file-window-0', 'triggerPoint').locator('option'))
        .toHaveText(['vmail', 'never']);
});

test('the trigger points follow the kind of tree', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openVmail(page);
    await selectMod(page);

    // 0 is `conversation`: registered at spawn and fired when the AI hits a trigger point,
    // so four of the eight mean something. `telephone`(4) is among them even though
    // nothing dispatches it -- six shipped trees use it, and §2 lists it as a valid pair.
    await dropdown(page, '#file-window-0', 'treeType').selectOption('0');
    await expect(dropdown(page, '#file-window-0', 'triggerPoint').locator('option'))
        .toHaveText(['onNewTrackTarget', 'whileTickOnTrackTarget', 'telephone', 'never',
            'newspaperArticle']);

    // 4 is `misc`: a message library, not something that runs. `never` is the only
    // honest answer.
    await dropdown(page, '#file-window-0', 'treeType').selectOption('4');
    await expect(dropdown(page, '#file-window-0', 'triggerPoint').locator('option'))
        .toHaveText(['never', 'newspaperArticle']);
});

test('the newspaper fields are lists rather than bare numbers', async ({ page }) => {
    const errors = collectPageErrors(page);
    await gotoFlow(page, '?flow=dds');
    await openVmail(page);
    await selectMod(page);

    await openDdsDocument(page, NEWS_TREE_GUID);

    // Both are Int32 in the layout with no enum behind them, so they were a box wanting a
    // number that nothing on screen explained. The fixture is category 1, context 5.
    const category = dropdown(page, '#file-window-0', 'newspaperCategory');
    await expect(category).toHaveValue('1');
    await expect(category.locator('option:checked')).toContainText('Classified ad');
    // Nine slots, not the five of the `Category` enum that belongs to a different field.
    await expect(category.locator('option')).toHaveCount(9);

    const context = dropdown(page, '#file-window-0', 'newspaperContext');
    await expect(context).toHaveValue('5');
    await expect(context.locator('option:checked')).toHaveText('randomGroup');

    expect(errors).toEqual([]);
});

test('a newspaper field stores the number the game reads', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openVmail(page);
    await selectMod(page);
    await openDdsDocument(page, NEWS_TREE_GUID);

    // The list is a way of naming values, not a change of type: what lands in the file is
    // the integer NewspaperController compares.
    await dropdown(page, '#file-window-0', 'newspaperCategory').selectOption('6');

    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Trees/${NEWS_TREE_GUID}.tree_patch`;
    await expect.poll(async () => JSON.parse((await readFile(page, patchPath)) ?? '[]'))
        .toContainEqual({ op: 'replace', path: '/newspaperCategory', value: 6 });
});

test('the newspaper fields are only on a newspaper', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openVmail(page);
    await selectMod(page);

    // The tree that has the fields. A view decides what to show of what a document holds,
    // so a tree without them has nothing to hide either way -- this has to be asked of a
    // file that carries them.
    await openDdsDocument(page, NEWS_TREE_GUID);
    await expect(row(page, '#file-window-0', 'newspaperCategory')).toBeVisible();

    // 149 of 218 shipped documents carry a non-zero newspaperCategory. Nothing outside
    // GenerateNewspaper ever looks at it, so on a document it is noise. 2 is `document`.
    await dropdown(page, '#file-window-0', 'treeType').selectOption('2');
    await expect(row(page, '#file-window-0', 'newspaperCategory')).toBeHidden();
    await expect(row(page, '#file-window-0', 'newspaperContext')).toBeHidden();

    await dropdown(page, '#file-window-0', 'treeType').selectOption('3');
    await expect(row(page, '#file-window-0', 'newspaperCategory')).toBeVisible();
});
