import { test, expect } from '@playwright/test';
import {
    installFsHarness, collectPageErrors, gotoFlow, seedFs, connectFolders,
} from '../test-support/harness.js';
import { furnitureExport, furnitureTypeMap } from '../test-support/fixtures.js';

/**
 * The furniture creator pane, driven through the browser.
 *
 * It reads whole assets out of the author's own exported ScriptableObjects folder, one at a
 * time as something asks for them -- there is no derived copy of these in the repo. So
 * every one of these seeds an export and connects it, which is what the pane needs and all
 * it needs: no mod folder, because reading what a piece of furniture is made of should not
 * require having decided to write one.
 *
 * What the joins decide is `furnitureModel.unit.spec.js`, and what the 3D pane draws is
 * `furnitureView.spec.js`, which builds one directly the way the floorplan's scene tests
 * do. This is the pane: reachable, drawing all three levels, and honest about the parts of
 * the model it cannot see.
 */

const SPOILER_KEY = 'SOD_MurderCaseBuilder_SpoilerWarningDismissed';

const expectDialogOpen = (page, selector, open) =>
    expect.poll(() => page.locator(selector).evaluate((e) => e.open)).toBe(open);

async function openPane(page) {
    await page.addInitScript((k) => window.localStorage.setItem(k, 'true'), SPOILER_KEY);
    await gotoFlow(page, '?flow=scriptableObject');

    await seedFs(page, furnitureExport);
    await connectFolders(page, { exportedSOs: 'ExportedSOs' });

    // The pickers offer what `typeMap` lists, which is the real game's 310 presets and 399
    // clusters. Narrowed to the fixture so a test reads one folder rather than four
    // hundred, and so a name in a list is one that can actually be opened.
    await page.evaluate((map) => Object.assign(window.typeMap, map), furnitureTypeMap);

    await page.getByRole('link', { name: 'Furniture Creator' }).click();
    await expectDialogOpen(page, '#furniture-creator-modal', true);

    // The list is drawn after two fetches, so wait for it rather than for the dialog.
    await expect(page.locator('#furniture-creator-presets li').first()).toBeVisible();
}

/** Choose a preset by name, through the search box so the list is short enough to click. */
async function choose(page, name) {
    // The picker is the first step's. Said here rather than at every call: choosing a
    // preset is what the rest of a test is about, not a step it happens to be on.
    await openSection(page, 'Source');
    await page.locator('#furniture-creator-search').fill(name);
    await page.locator('#furniture-creator-presets')
        .getByRole('button', { name, exact: true }).click();
}

/**
 * Show one of the dialog's steps, by the label in the rail.
 *
 * Pressed through the DOM rather than with a click at a point. The rail button carries the
 * step's label and, under it, whatever the pane last worked out about it -- so a
 * `getByText` would match the hint as readily as the label, and the hint is a count that
 * moves as these tests edit the preset. The same helper `roomCreator.spec.js` needs, for
 * the same reason.
 */
const openSection = (page, label) => page.evaluate((text) => {
    const step = [...document.querySelectorAll('#furniture-creator-modal .creator-step')]
        .find((node) => node.querySelector('.creator-step-label')?.textContent === text);
    step?.click();
}, label);

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
});

test('opens from the flow bar with no folder connected', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openPane(page);

    // Every preset the export folder holds, listed from the folder itself -- no asset is
    // read until one is chosen, which is what keeps opening the pane free.
    await expect(page.locator('#furniture-creator-presets li')).toHaveCount(5);

    expect(errors).toEqual([]);
});

/**
 * The names come from the export folder rather than from `soAssetsByType.json`, which is
 * generated from whichever build was dumped. Furniture a newer game added is on the
 * author's disk, and a picker reading the generated table would leave it invisible.
 */
test('offers furniture the export holds that the generated table has never heard of', async ({ page }) => {
    await openPane(page);

    // Absent from the typeMap this test narrows to, present in the export folder.
    await expect(page.locator('#furniture-creator-presets')).toContainText('NewInThisPatch');

    await choose(page, 'NewInThisPatch');
    await expect(page.locator('#furniture-creator-summary')).toContainText('1x1BookcaseLarge');
});

test('names the model, the slot it fills and what it carries', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openPane(page);
    await choose(page, 'HotelDesk');

    const summary = page.locator('#furniture-creator-summary');

    // The model is not named after the preset, which is the only way to tell that two
    // presets draw the same thing.
    await expect(summary).toContainText('HotelFrontDesk');
    await expect(summary).toContainText('not named after it');
    await expect(summary).toContainText('3x1LobbyDesk');
    await expect(summary).toContainText('3×1 nodes');

    // Stage 5: what the object can be used for, and the ids the model already carries. Its
    // own section rather than a line in the summary, because it is a list to be edited.
    await openSection(page, 'What is built into it');

    const built = page.locator('#furniture-creator-interactables');
    await expect(built.locator('li')).toHaveCount(2);
    await expect(built.locator('li').first()).toContainText('HotelDesk');
    await expect(built.locator('li').first()).toContainText('at A');
    await expect(built.locator('li').nth(1)).toContainText('at B');

    expect(errors).toEqual([]);
});

test('lists what sits on it, with the position the game states', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');

    const first = page.locator('#furniture-creator-subobjects li').first();

    await expect(first).toContainText('Computer');
    await expect(first).toContainText('-1.02, 1.00, 0.27');
    await expect(first).toContainText('195° about y');

    // Two it can place; the third hangs off a transform and is in the other list.
    await expect(page.locator('#furniture-creator-subobjects li')).toHaveCount(2);
});

/**
 * The decision the plan is most explicit about. A sub-object parented to a transform
 * inside the model is somewhere this app cannot work out, so it is listed with the
 * transform it hangs off rather than drawn, and the toggle that draws it anyway says what
 * it is doing rather than reading as a neutral display option.
 */
test('lists the sub-objects it cannot place, with the transform they hang off', async ({ page }) => {
    await openPane(page);
    await choose(page, 'BrownSofaSmall');

    await expect(page.locator('#furniture-creator-parented-count'))
        .toContainText('1 sub-object hangs off a transform inside the model');

    await expect(page.locator('#furniture-creator-parented-list')).toContainText('SmallSofaSideTable1');
    await expect(page.locator('#furniture-creator-parented-list li')).toHaveCount(1);

    // Every one of this preset's sub-objects is parented, so the list of placed ones says
    // so rather than being empty and ambiguous.
    await expect(page.locator('#furniture-creator-subobjects')).toContainText('Nothing sits on this one');

    // Off until asked for, and labelled with what turning it on actually does.
    await expect(page.locator('#furniture-creator-parented')).not.toBeChecked();
    await expect(page.locator('#furniture-creator-modal')).toContainText('somewhere they are not');
});

test('marks a sub-object when its row is clicked, and unmarks it when clicked again', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');

    await openSection(page, 'What sits on it');
    // The row's own button, not the cross beside it: a row carries both now.
    const row = page.locator('#furniture-creator-subobjects li').first()
        .locator('.furniture-creator-subobject');

    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'true');

    await row.click();
    await expect(row).not.toHaveAttribute('aria-current', 'true');
});

/*
 * The rail: six steps, one showing, and what each of them has come to.
 *
 * The hint under a label is what makes the rail worth its width -- how many sub-objects,
 * whether the clusters have been read, how many files a write would come to -- so that the
 * shape of the preset is readable without stepping through it.
 */
test('shows one step at a time, and reports each in the rail', async ({ page }) => {
    await openPane(page);

    const pane = (step) => page.locator(`#furniture-creator-modal .creator-pane[data-step="${step}"]`);
    const hint = (step) => page.locator(
        `#furniture-creator-modal .creator-step:nth-child(${step}) .creator-step-hint`);

    await expect(pane('source')).toBeVisible();
    await expect(pane('write')).toBeHidden();
    await expect(page.locator('#furniture-creator-modal .creator-back')).toBeDisabled();
    await expect(hint(1)).toHaveText('nothing open');

    await choose(page, 'HotelDesk');

    await expect(hint(1)).toHaveText('HotelDesk');
    await expect(hint(3)).toHaveText('2 objects');

    // The one step whose hint a press rather than a keystroke changes: reading 399 clusters
    // is asked for, because nothing in the files points this way round.
    await expect(hint(5)).toHaveText('not read yet');

    await page.locator('#furniture-creator-modal .creator-next').click();
    await expect(pane('placement')).toBeVisible();
    await expect(pane('source')).toBeHidden();

    await openSection(page, 'What will be written');
    await expect(page.locator('#furniture-creator-modal .creator-next')).toBeDisabled();
});

/**
 * The hop nothing in the files states: a preset names classes, a cluster names classes,
 * and no file points from one to the other.
 */
test('says which arrangements it appears in, and draws one as a plan', async ({ page }) => {
    await openPane(page);
    await choose(page, 'OfficeCubicle');
    await openSection(page, 'Where it appears');

    const clusters = page.locator('#furniture-creator-clusters');

    // The one question here that is not about a single asset, so it is asked for rather
    // than assumed: a preset names classes, a cluster names classes, and the answer is
    // "none of them" exactly when every cluster has been read.
    await clusters.getByRole('button', { name: /Find where it appears/ }).click();
    await expect(clusters).toContainText('OfficeCubicleX1');

    await clusters.getByRole('button', { name: /^OfficeCubicleX1/ }).click();

    // The plan, and the slot this preset is the reason for reading it.
    await expect(clusters).toContainText('0, 0 — 1x1OfficeCubicle, facing down');

    // The trap HOW-IT-WORKS.md names, in the cluster it names it in.
    await expect(clusters).toContainText('share the tile at 0, 0');
    await expect(clusters).toContainText('swapping what fills the first slot');
});

test('says when a preset is in no arrangement at all', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await openSection(page, 'Where it appears');

    await page.locator('#furniture-creator-clusters')
        .getByRole('button', { name: /Find where it appears/ }).click();

    // FrontDesk is the only cluster with a 3x1LobbyDesk slot, so the section is a list of
    // one rather than the empty state -- which is the case this checks is distinguished.
    await expect(page.locator('#furniture-creator-clusters')).toContainText('FrontDesk');
    await expect(page.locator('#furniture-creator-clusters'))
        .not.toContainText('No cluster in the game has a slot this fills');
});
