import { test, expect } from '@playwright/test';
import {
    installFsHarness, collectPageErrors, gotoFlow, seedFs, connectFolders, selectContent,
    listDir, readFile, writeFixture,
} from '../test-support/harness.js';
import { soFixture } from '../test-support/fixtures.js';

/**
 * The room creator pane, driven through the browser.
 *
 * It reads the two derived reference files and nothing else, so every one of these runs
 * without a mod folder -- which is the point of the read-only half: an author can find out
 * what a room would admit before they have decided to write one.
 *
 * What the gates themselves decide is `core/spawnRules.unit.spec.js`. This is about the
 * pane being reachable, redrawing as the controls change, and saying what it left open.
 */

const SPOILER_KEY = 'SOD_MurderCaseBuilder_SpoilerWarningDismissed';

const expectDialogOpen = (page, selector, open) =>
    expect.poll(() => page.locator(selector).evaluate((e) => e.open)).toBe(open);

async function openPane(page) {
    await page.addInitScript((k) => window.localStorage.setItem(k, 'true'), SPOILER_KEY);
    await gotoFlow(page, '?flow=scriptableObject');

    // Dismissed rather than answered. Leaving it without connecting anything is the state
    // these run in: no mod, no export, nothing but the reference data.
    await page.locator('#folders-continue').click();
    await expectDialogOpen(page, '#folders-modal', false);

    await page.getByRole('link', { name: 'Room Creator' }).click();
    await expectDialogOpen(page, '#room-creator-modal', true);

    // The verdict is drawn after two fetches, so wait for it rather than for the dialog.
    await expect(page.locator('#room-creator-verdict')).toContainText('furniture clusters suit this room');
}


/**
 * Show one of the dialog's steps, by the label in the rail.
 *
 * Pressed through the DOM rather than with a click at a point. The rail button carries the
 * step's label and, under it, whatever the pane last worked out about that step -- so a
 * `getByText` would match the hint as readily as the label, and the hint is a count that
 * changes as these tests type into the room.
 */
const openSection = (page, label) => page.evaluate((text) => {
    const step = [...document.querySelectorAll('#room-creator-modal .creator-step')]
        .find((node) => node.querySelector('.creator-step-label')?.textContent === text);
    step?.click();
}, label);

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
});

test('opens from the flow bar with no folder connected, and counts the whole catalogue', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openPane(page);

    // Nothing has been stated, so no gate can refuse: all 399 clusters stand.
    await expect(page.locator('#room-creator-verdict')).toContainText('399 of 399 furniture clusters');

    expect(errors).toEqual([]);
});

/*
 * The rail: one step showing, the rest a click or a Next away.
 *
 * The panes carry `hidden` rather than a class, which takes the one that is not showing out
 * of the tab order as well as off the screen. That matters more here than it looks: between
 * them these four hold most of the controls in the dialog, and tabbing into a step nobody
 * can see is worse than the long column this replaced.
 */
test('shows one step at a time, and walks through them from the footer', async ({ page }) => {
    await openPane(page);

    const pane = (step) => page.locator(`#room-creator-modal .creator-pane[data-step="${step}"]`);
    const back = page.locator('#room-creator-modal .creator-back');
    const next = page.locator('#room-creator-modal .creator-next');

    await expect(pane('identity')).toBeVisible();
    await expect(pane('write')).toBeHidden();
    await expect(back).toBeDisabled();

    await next.click();
    await expect(pane('where')).toBeVisible();
    await expect(pane('identity')).toBeHidden();
    await expect(back).toBeEnabled();

    // Straight to the last one, where there is nowhere further to go.
    await openSection(page, 'What will be written');
    await expect(pane('write')).toBeVisible();
    await expect(next).toBeDisabled();

    await back.click();
    await expect(pane('contents')).toBeVisible();
});

/*
 * The rail reports on the room rather than listing its parts.
 *
 * The hint under each label is the reason the rail is worth its width -- what has been said
 * about this room so far, without stepping through it to find out. Drawn from the same
 * `summarise` and `planRoom` the panes are, so it cannot disagree with them.
 */
test('the rail says what each step has come to, and follows the room', async ({ page }) => {
    await openPane(page);

    const hint = (step) => page.locator(
        `#room-creator-modal .creator-step:nth-child(${step}) .creator-step-hint`);

    await expect(hint(1)).toHaveText('not named yet');
    await expect(hint(2)).toHaveText('nothing set');
    await expect(hint(3)).toHaveText('0 clusters');

    await page.locator('#room-creator-name').fill('PicnicArea');
    await expect(hint(1)).toHaveText('PicnicArea');

    await openSection(page, 'Where the room sits');
    await page.locator('#room-creator-floor').fill('3');
    await expect(hint(2)).toHaveText('1 of 7 stated');

    // The footer carries the note for whichever step is showing, so what the author is
    // being told sits beside the button that acts on it.
    await expect(page.locator('#room-creator-modal .creator-foot-note'))
        .toContainText('left open rather than guessed');
});

/*
 * What is ticked, gathered.
 *
 * The picker beside these lists what the gates allow, capped at forty rows and sorted with
 * the refused ones last, so a cluster ticked before a floor was stated can be off the
 * bottom of it -- and then the pane showing the room could not say what is in it.
 */
test('gathers the admitted clusters as chips, which take them back out', async ({ page }) => {
    await openPane(page);
    await openSection(page, 'What goes in it');

    const chosen = page.locator('#room-creator-chosen');
    await expect(chosen).toContainText('Nothing yet');

    await page.locator('#room-creator-search').fill('PicnicTable');
    await page.locator('#room-creator-clusters > li').first()
        .locator('> label input[type="checkbox"]').check();

    await expect(chosen).toContainText('In this room · 1 cluster');
    await expect(chosen.locator('.room-creator-chip')).toHaveText('PicnicTable✕');

    // And the chip is the way back out, which is what a list of names could not be.
    await chosen.locator('.room-creator-chip').click();
    await expect(chosen).toContainText('Nothing yet');
    await expect(page.locator('#room-creator-clusters > li').first()
        .locator('> label input[type="checkbox"]')).not.toBeChecked();
});

/*
 * What the gates did is read beside the gates, not beside the name.
 *
 * The two sit on different steps now, and deliberately: the headline count answers "what
 * did copying that room get me", which is the identity step's question, and what a gate
 * refused answers a keystroke in the field next to it. Both are drawn from one `summarise`,
 * so these are two views of the same read rather than two reads.
 */
test('says which gates were left open rather than guessing them', async ({ page }) => {
    await openPane(page);

    await openSection(page, 'Where the room sits');

    const gates = page.locator('#room-creator-gates');
    await expect(gates).toContainText('Nothing has been said about');
    await expect(gates).toContainText('left open rather than guessed');
});

test('narrows the list as the room is placed, and names the gate that refused', async ({ page }) => {
    await openPane(page);

    await openSection(page, 'Where the room sits');
    await page.locator('#room-creator-floor').fill('3');

    const gates = page.locator('#room-creator-gates');
    await expect(gates).toContainText('refused, by 1 gate');
    await expect(gates).toContainText('142 refused');

    // The bars beside the fields move with them. This is the reading the gates step exists
    // for -- a sentence one step back cannot be watched while a floor is typed.
    await expect(page.locator('#room-creator-reach')).toContainText('257 / 399');

    // One worked reason per gate, not 142 near-identical sentences. Which cluster stands
    // as the example is alphabetical rather than chosen, so this asserts the sentence
    // rather than the name -- what a gate's reason reads like is the thing worth pinning.
    await gates.getByText('refused, by 1 gate').click();
    await expect(gates).toContainText('It is limited to floor 0, and this room is on 3.');
    await expect(gates).toContainText('and 141 more');

    // And the floor is no longer among the gates it says nothing about.
    await expect(gates).not.toContainText('Nothing has been said about floor');
});

test('warns that a donor no lighting preset names leaves the room dark', async ({ page }) => {
    await openPane(page);

    // Ballroom is one of the 14 shipped configurations no RoomLightingPreset accepts, so
    // there is nothing to preselect and nothing to copy.
    await page.locator('#room-creator-donor').selectOption('Ballroom');
    await expect(page.locator('#room-creator-verdict')).toContainText('gets no ceiling light');

    const ticked = () => page.evaluate(() =>
        [...document.querySelectorAll('#room-creator-lights input')].filter((box) => box.checked).length);

    await openSection(page, 'What goes in it');
    expect(await ticked()).toBe(0);

    // A lit donor brings its own lights with it, ticked. Nothing lights a brand new
    // configuration, so an empty list is never the useful default.
    await openSection(page, 'Identity');
    await page.locator('#room-creator-donor').selectOption('Atrium');
    await expect(page.locator('#room-creator-verdict')).not.toContainText('gets no ceiling light');
    expect(await ticked()).toBe(7);

    // And they can be taken off again, which is what a note listing them could not do.
    await openSection(page, 'What goes in it');
    await page.locator('#room-creator-lights').getByText('AtriumLight').click();
    expect(await ticked()).toBe(6);
});

test('copies the donor’s furniture in one press, and says how much it took', async ({ page }) => {
    await openPane(page);

    // Nothing to copy until there is something to copy from.
    const button = page.locator('#room-creator-copy-furniture');
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', 'Choose a room to copy from first');

    // The count is on the button, because it is what decides whether to press it: ten
    // clusters and seventy-seven are both answers a donor can give. The donor's name is
    // not, because it is being read in the select this shares a row with.
    await page.locator('#room-creator-donor').selectOption('CorporateCorridoor');
    await expect(button).toBeEnabled();
    await expect(button).toHaveText('Copy 10 clusters');
    await expect(button).toHaveAttribute('title', 'Tick the 10 furniture clusters CorporateCorridoor holds');

    const ticked = () => page.evaluate(() => document.querySelectorAll(
        '#room-creator-clusters > li > label input[type="checkbox"]:checked').length);
    expect(await ticked()).toBe(0);

    await button.click();
    expect(await ticked()).toBe(10);
    await expect(page.locator('#room-creator-copied'))
        .toContainText('Copied 10 of CorporateCorridoor’s furniture clusters');

    // The copied ones sort to the top, with the furniture each brought.
    await openSection(page, 'What goes in it');
    const row = page.locator('#room-creator-clusters > li').first();
    await expect(row).toContainText('AlarmSiren');
    await expect(row.locator('.room-creator-contents input[type="checkbox"]')).not.toHaveCount(0);

    // Ten clusters, their eight presets and the donor's three lights, on top of the four
    // the room itself is.
    await openSection(page, 'What will be written');
    await expect(page.locator('#room-creator-plan')).toContainText('25 new files');
    await expect(page.locator('#room-creator-plan')).toContainText('SecurityCamera.sodso_patch.json');
});

test('a copy is a one-off, so what it ticked survives the donor moving', async ({ page }) => {
    await openPane(page);
    await page.locator('#room-creator-donor').selectOption('CorporateCorridoor');
    await page.locator('#room-creator-copy-furniture').click();

    // Counted through the DOM rather than by looking, so the donor and the copy button --
    // which are on the identity step -- stay pressable throughout.
    const ticked = () => page.evaluate(() => document.querySelectorAll(
        '#room-creator-clusters > li > label input[type="checkbox"]:checked').length);
    expect(await ticked()).toBe(10);

    // The clusters are the author's from here, so a new donor leaves them where they are.
    // The note goes, because it named the donor it came from.
    await page.locator('#room-creator-donor').selectOption('BuildingBathroomFemale');
    expect(await ticked()).toBe(10);
    await expect(page.locator('#room-creator-copied')).not.toContainText('Copied');

    // And pressing again adds to them rather than replacing them. Nineteen, not twenty:
    // LeaningPoint is in both donors, and a cluster admitted twice is admitted once.
    await page.locator('#room-creator-copy-furniture').click();
    expect(await ticked()).toBe(19);
});

test('a donor no cluster names disables the copy, and says why rather than doing nothing', async ({ page }) => {
    await openPane(page);

    // Atrium is one of three shipped configurations in no cluster's filters at all -- the
    // generator furnishes an atrium with nothing, and it is the donor the worked example
    // uses. A button that appeared to do nothing would read as broken.
    await page.locator('#room-creator-donor').selectOption('Atrium');

    const button = page.locator('#room-creator-copy-furniture');
    await expect(button).toBeDisabled();

    // The reason is in the note rather than on the button, which has no room for it and
    // is disabled anyway -- so its `title` would never be hovered into view.
    await expect(page.locator('#room-creator-copied'))
        .toContainText('Atrium has no furniture to copy: no cluster in the game names its room class');
});

test('furniture the room’s place refuses is copied, patched and said out loud', async ({ page }) => {
    await openPane(page);

    await page.locator('#room-creator-donor').selectOption('StreetFrontage');
    await openSection(page, 'Where the room sits');
    await page.locator('#room-creator-floor').fill('3');
    await openSection(page, 'Identity');

    // 14 of StreetFrontage's 19 are refused three floors up. They come across anyway -- a
    // copy minus what this floor rules out would quietly not be a copy -- each as the same
    // additive patch as any other, which does nothing until the gate is relaxed.
    await page.locator('#room-creator-copy-furniture').click();
    await expect(page.locator('#room-creator-copied'))
        .toContainText('Copied 19 of StreetFrontage’s furniture clusters, 14 of which are refused');

    await openSection(page, 'What goes in it');
    await page.locator('#room-creator-search').fill('2_ShantyShack');
    const row = page.locator('#room-creator-clusters > li').first();

    await expect(row).toContainText('2_ShantyShack');
    await expect(row).toContainText(', refused here');
    await expect(row.locator('> label input[type="checkbox"]')).toBeChecked();

    // The reason stays on an admitted row, because it is what the author has to relax --
    // in a copy of their own, which is the one thing this tool will not do for them.
    await row.locator('.room-creator-why').click();
    await expect(row.locator('.room-creator-reason')).toContainText('this room is on 3');
    await expect(row.locator('.room-creator-reason'))
        .toContainText('To place 2_ShantyShack in this room, copy it into your mod');

    // A patch of the shipped cluster, and no file of the mod's own anywhere in the plan.
    await openSection(page, 'What will be written');
    const written = page.locator('#room-creator-plan');
    await expect(written).toContainText('2_ShantyShack.sodso_patch.json');
    await expect(written).not.toContainText('_2_ShantyShack.FurnitureCluster.sodso.json');
    await expect(written).toContainText('2_ShantyShack is admitted, but where this room sits it is refused');

    await openSection(page, 'What goes in it');
    await row.locator('> label input[type="checkbox"]').uncheck();
    await expect(written).not.toContainText('2_ShantyShack.sodso_patch.json');
});

/** The same pane, but with a mod to write into. */
async function openPaneWithMod(page) {
    await page.addInitScript((k) => window.localStorage.setItem(k, 'true'), SPOILER_KEY);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFixture);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await page.getByRole('link', { name: 'Room Creator' }).click();
    await expect(page.locator('#room-creator-verdict')).toContainText('furniture clusters suit this room');
}

/** Fill in the export server's worked example, on the ground floor so nothing is cloned. */
async function fillPicnicArea(page, { floor = '0' } = {}) {
    await page.locator('#room-creator-name').fill('PicnicArea');
    await page.locator('#room-creator-donor').selectOption('Atrium');
    await openSection(page, 'Where the room sits');
    await page.locator('#room-creator-floor').fill(floor);

    await openSection(page, 'What goes in it');
    await page.locator('#room-creator-search').fill('PicnicTable');
    await page.locator('#room-creator-clusters input[type="checkbox"]').first().check();

    // The materials are on the write step: a brand new room class is in no material filter
    // at all, and leaving all three alone is a perfectly ordinary answer.
    await openSection(page, 'What will be written');
    await page.locator('#room-creator-surface-walls').selectOption('PlainWall');
    await page.locator('#room-creator-surface-floor').selectOption('WoodenFlooring');
    await page.locator('#room-creator-surface-ceiling').selectOption('PlasterCeiling');

    // Atrium's seven lights arrive already ticked -- nothing lights a new configuration,
    // so the donor's own is the only useful default. Left as they are.
}

test('says which clusters the room’s place refuses, and lets them be admitted anyway', async ({ page }) => {
    await openPane(page);

    await openSection(page, 'Where the room sits');
    await page.locator('#room-creator-floor').fill('3');
    await openSection(page, 'What goes in it');
    await page.locator('#room-creator-search').fill('PicnicTable');

    // Refused at floor 3, listed and marked as such. Hiding it would answer "why can I not
    // put a picnic table here" with silence; disabling it would refuse on the strength of a
    // floor the author is free to change and which no file records.
    const row = page.locator('#room-creator-clusters > li').first();
    await expect(row).toContainText('PicnicTable — 1 preset, refused here');
    await expect(row.locator('input[type="checkbox"]')).toBeEnabled();

    // The reason is one click away rather than on the row, where at this floor it would be
    // the same sentence a hundred and forty times.
    await expect(row.locator('.room-creator-reason')).toBeHidden();
    await row.locator('.room-creator-why').click();
    await expect(row.locator('.room-creator-reason'))
        .toContainText('It is limited to floors -1 to 0, and this room is on 3.');

    // On the ground floor nothing refuses it and the marking goes.
    await openSection(page, 'Where the room sits');
    await page.locator('#room-creator-floor').fill('0');
    await openSection(page, 'What goes in it');
    await expect(row).toContainText('PicnicTable — 1 preset');
    await expect(row).not.toContainText('refused here');
    await expect(row.locator('.room-creator-why')).toHaveCount(0);
});

test('admitting a cluster shows its furniture, and lets some of it be left out', async ({ page }) => {
    await openPane(page);
    await openSection(page, 'What goes in it');
    await page.locator('#room-creator-search').fill('4_LoungeSetSmall_A');

    const row = page.locator('#room-creator-clusters > li').first();
    await row.locator('> label input[type="checkbox"]').check();

    // Its contents arrive with it, all ticked -- that is what admitting a cluster means.
    const contents = row.locator('.room-creator-contents input[type="checkbox"]');
    const count = await contents.count();
    expect(count).toBeGreaterThan(3);
    await expect(row).toContainText('LivingRoomRug');

    // With every sofa admitted, no single one is holding the cluster up, so nothing is
    // marked -- a marker on all nine would say nothing.
    await expect(row).not.toContainText('the only one filling');

    await openSection(page, 'What will be written');
    const plan = page.locator('#room-creator-plan');
    await expect(plan).toContainText('LivingRoomRug.sodso_patch.json');

    // Leaving one out drops its patch, and the count on the cluster row says so. The plan
    // is read after stepping back to the list, which is where the unticking happens -- it
    // is redrawn on every change whichever step is showing.
    await openSection(page, 'What goes in it');
    await row.locator('.room-creator-contents input[type="checkbox"]').first().uncheck();
    await expect(row).toContainText(`${count - 1} of ${count}`);
    await expect(plan).not.toContainText('70sSofa.sodso_patch.json');
});

test('warns when the furniture left out would abandon the cluster', async ({ page }) => {
    await openPane(page);
    await openSection(page, 'What goes in it');
    await page.locator('#room-creator-search').fill('PicnicTable');

    const row = page.locator('#room-creator-clusters > li').first();
    await row.locator('> label input[type="checkbox"]').check();

    // PicnicTable resolves to one bench, and that bench fills the element it cannot do
    // without -- so unticking it loses the whole cluster, silently, in game.
    await row.locator('.room-creator-contents input[type="checkbox"]').first().uncheck();

    await expect(row).toContainText('Nothing admitted fills 1x1PicnicBench');
    await expect(row).toContainText('abandoned whole');

    await openSection(page, 'What will be written');
    await expect(page.locator('#room-creator-plan'))
        .toContainText('Admit one of PicnicBench');
});

test('a material filter that would also bring its furniture is shown, and cannot be picked', async ({ page }) => {
    await openPane(page);
    await openSection(page, 'What will be written');

    const option = page.locator('#room-creator-surface-walls option', { hasText: 'CorporateLobby' });
    await expect(option).toHaveAttribute('disabled', '');
    await expect(option).toContainText('also admits its furniture');
});

test('lists the files before writing them, and will not write without a mod', async ({ page }) => {
    await openPane(page);
    await fillPicnicArea(page);

    await openSection(page, 'What will be written');
    const plan = page.locator('#room-creator-plan');

    await expect(plan).toContainText('16 new files, plus the manifest');
    await expect(plan).toContainText('PicnicAreaRCP.RoomClassPreset.sodso.json');
    await expect(plan).toContainText('PicnicBench.sodso_patch.json');

    // No folder connected in this one, so there is nowhere to write.
    await expect(page.locator('#room-creator-write')).toBeDisabled();
    await expect(page.locator('#room-creator-write')).toContainText('Choose a mod');
});

test('names what would leave the room empty, without refusing to write it', async ({ page }) => {
    await openPane(page);

    await page.locator('#room-creator-name').fill('Bare');
    await page.locator('#room-creator-donor').selectOption('Ballroom');
    await openSection(page, 'What will be written');

    const plan = page.locator('#room-creator-plan');
    await expect(plan).toContainText('Nothing furnishes this room, so it will be empty.');
    await expect(plan).toContainText('No lighting preset accepts this room');

    // Four files and a manifest is still a valid thing to write.
    await expect(plan).toContainText('4 new files, plus the manifest');
});

test('writes the room into the mod, in dependency order', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openPaneWithMod(page);
    await fillPicnicArea(page);

    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('16 files written');

    const written = await listDir(page, 'Mods/TestCase');
    expect(written).toEqual(expect.arrayContaining([
        'PicnicAreaRCP.RoomClassPreset.sodso.json',
        'PicnicAreaRTF.RoomTypeFilter.sodso.json',
        'PicnicArea.RoomTypePreset.sodso.json',
        'PicnicAreaRC.RoomConfiguration.sodso.json',
        'PicnicTable.sodso_patch.json',
        'PicnicBench.sodso_patch.json',
        'AtriumLight.sodso_patch.json',
    ]));

    // The four assets load in the order they reference each other, and everything that
    // references them comes after.
    const manifest = JSON.parse(await readFile(page, 'Mods/TestCase/murdermanifest.sodso.json'));
    const ours = manifest.fileOrder.filter((entry) => !entry.includes('testcase'));

    expect(ours.slice(0, 4)).toEqual([
        'REF:PicnicAreaRCP.RoomClassPreset',
        'REF:PicnicAreaRTF.RoomTypeFilter',
        'REF:PicnicArea.RoomTypePreset',
        'REF:PicnicAreaRC.RoomConfiguration',
    ]);
    expect(ours).toContain('REF:PicnicBench');

    // The room type must not force a configuration: the configuration points back at it,
    // and a linear fileOrder cannot express the ring.
    const roomType = JSON.parse(await readFile(page, 'Mods/TestCase/PicnicArea.RoomTypePreset.sodso.json'));
    expect(roomType.forceConfiguration).toBeNull();
    expect(roomType.overrideFloorHeight).toBe(false);

    expect(errors).toEqual([]);
});

test('writes a room furnished from its donor, patch per cluster and per preset', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openPaneWithMod(page);

    // Park is one of only four shipped configurations whose furniture carries no name
    // collision, so it is the one that copies and writes without anything being unticked
    // first. Twenty-three clusters and their sixteen presets.
    await page.locator('#room-creator-name').fill('Gardens');
    await page.locator('#room-creator-donor').selectOption('Park');
    await page.locator('#room-creator-copy-furniture').click();

    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('files written');

    const written = await listDir(page, 'Mods/TestCase');
    expect(written).toEqual(expect.arrayContaining([
        'GardensRCP.RoomClassPreset.sodso.json',
        '2_ParkBench.sodso_patch.json',
        'ParkBench.FurniturePreset.sodso_patch.json',
    ]));

    // Every cluster is a patch adding this room's filter, not a clone: nothing about where
    // the room sits was stated, so no gate refused any of them.
    const cluster = JSON.parse(await readFile(page, 'Mods/TestCase/2_ParkBench.sodso_patch.json'));
    expect(cluster.fileType).toBe('FurnitureCluster');
    expect(cluster.patches).toEqual([
        { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|GardensRTF' },
    ]);

    // And the preset that fills its slot is admitted separately, because the game
    // re-filters furniture on the room class after the cluster has been offered.
    //
    // Typed, though this room patches no cluster called ParkBench: one exists in the game
    // and the naming turns on whether the *name* is ambiguous rather than on what this
    // room happens to admit. A rule that changed with the room would rename a file as
    // furniture was ticked beside it.
    const preset = JSON.parse(await readFile(page, 'Mods/TestCase/ParkBench.FurniturePreset.sodso_patch.json'));
    expect(preset.fileType).toBe('FurniturePreset');

    expect(errors).toEqual([]);
});

test('an asset that is a cluster and a preset gets a file for each, not one for both', async ({ page }) => {
    await openPaneWithMod(page);

    // SecurityDoorDouble is a FurnitureCluster and a FurniturePreset, and this room admits
    // both -- the preset is what fills the cluster's own most important slot. The loader
    // matches a patch by the name and type inside it, so the two can coexist; what they
    // cannot share is a file name. Five of CorporateCorridoor's ten clusters are like this.
    await page.locator('#room-creator-name').fill('Corridor');
    await page.locator('#room-creator-donor').selectOption('CorporateCorridoor');
    await page.locator('#room-creator-copy-furniture').click();

    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('files written');

    const written = await listDir(page, 'Mods/TestCase');
    expect(written).toContain('SecurityDoorDouble.FurnitureCluster.sodso_patch.json');
    expect(written).toContain('SecurityDoorDouble.FurniturePreset.sodso_patch.json');

    // The bare name is not used at all where it would be ambiguous.
    expect(written).not.toContain('SecurityDoorDouble.sodso_patch.json');

    // Each is a patch of its own asset. Before the type went into the name, both were
    // written to one file and the room silently lost whichever landed first.
    const cluster = JSON.parse(await readFile(page, 'Mods/TestCase/SecurityDoorDouble.FurnitureCluster.sodso_patch.json'));
    expect(cluster.name).toBe('SecurityDoorDouble');
    expect(cluster.fileType).toBe('FurnitureCluster');
    expect(cluster.patches).toEqual([
        { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|CorridorRTF' },
    ]);

    const preset = JSON.parse(await readFile(page, 'Mods/TestCase/SecurityDoorDouble.FurniturePreset.sodso_patch.json'));
    expect(preset.fileType).toBe('FurniturePreset');

    // And a name that was never ambiguous keeps the bare file it has always had.
    expect(written).toContain('SecurityCameraLeftCorner.sodso_patch.json');

    // The load order names the files as written, or the loader goes looking for ones that
    // are not there.
    const manifest = JSON.parse(await readFile(page, 'Mods/TestCase/murdermanifest.sodso.json'));
    expect(manifest.fileOrder).toContain('REF:SecurityDoorDouble.FurnitureCluster');
    expect(manifest.fileOrder).toContain('REF:SecurityDoorDouble.FurniturePreset');
    expect(manifest.fileOrder).toContain('REF:SecurityCameraLeftCorner');
});

test('a room with a shared-name cluster reopens, and unticking it takes both files back', async ({ page }) => {
    await openPaneWithMod(page);

    await page.locator('#room-creator-name').fill('Corridor');
    await page.locator('#room-creator-donor').selectOption('CorporateCorridoor');
    await page.locator('#room-creator-copy-furniture').click();
    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('files written');

    // Reopen it. The scanner reads a patch's target from inside the file, so the type in
    // the name changes nothing about what comes back.
    await page.locator('#room-creator-modal button[rel="prev"]').click();
    await page.getByRole('link', { name: 'Room Creator' }).click();
    await openSection(page, 'Identity');
    await page.locator('#room-creator-open').selectOption('CorridorRC');
    await expect(page.locator('#room-creator-write')).toContainText('Save Corridor');

    await openSection(page, 'What goes in it');
    await page.locator('#room-creator-search').fill('SecurityDoorDouble');
    await page.locator('#room-creator-clusters > li').first()
        .locator('> label input[type="checkbox"]').uncheck();

    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('listed in murdermanifest');

    // Both halves go, and the load order stops naming either. A file left named and not
    // there is what the loader trips over.
    const after = await listDir(page, 'Mods/TestCase');
    expect(after).not.toContain('SecurityDoorDouble.FurnitureCluster.sodso_patch.json');
    expect(after).not.toContain('SecurityDoorDouble.FurniturePreset.sodso_patch.json');
    expect(after).toContain('SecurityDoorTriple.FurnitureCluster.sodso_patch.json');

    const manifest = JSON.parse(await readFile(page, 'Mods/TestCase/murdermanifest.sodso.json'));
    expect(manifest.fileOrder).not.toContain('REF:SecurityDoorDouble.FurnitureCluster');
    expect(manifest.fileOrder).not.toContain('REF:SecurityDoorDouble.FurniturePreset');
});

test('a copied cluster that can never resolve furniture is named before it is written', async ({ page }) => {
    await openPane(page);

    // SentryGunRightCorner is one of the six shipped clusters whose important element no
    // furniture in the game carries. Copying a donor brings it in with the rest, and the
    // failure it causes in game is silent -- one debug line and an unfurnished room.
    await page.locator('#room-creator-donor').selectOption('CorporateCorridoor');
    await page.locator('#room-creator-copy-furniture').click();

    await openSection(page, 'What will be written');
    await expect(page.locator('#room-creator-plan'))
        .toContainText('SentryGunRightCorner needs 1x1SentryGunRightCorner');
    await expect(page.locator('#room-creator-plan')).toContainText('no furniture in the game carries');
});

test('adds a second room to a patch the first already wrote', async ({ page }) => {
    await openPaneWithMod(page);
    await fillPicnicArea(page);
    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('16 files written');

    // A second room admitting the same cluster wants the same patch files. Replacing them
    // would silently un-admit the first room's furniture.
    // One cluster, one closure preset, three surfaces and seven lights are all shared.
    await openSection(page, 'Identity');
    await page.locator('#room-creator-name').fill('PicnicAreaTwo');
    await expect(page.locator('#room-creator-plan')).toContainText('added to');
    await expect(page.locator('#room-creator-write')).toContainText('add to 12');

    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('4 files written and 12 existing patches added to');

    // Both rooms reach the bench.
    const patch = JSON.parse(await readFile(page, 'Mods/TestCase/PicnicBench.sodso_patch.json'));
    expect(patch.patches.map((operation) => operation.value)).toEqual([
        'REF:RoomTypeFilter|PicnicAreaRTF',
        'REF:RoomTypeFilter|PicnicAreaTwoRTF',
    ]);

    // And both rooms are found afterwards.
    await page.locator('#room-creator-modal button[rel="prev"]').click();
    await page.getByRole('link', { name: 'Room Creator' }).click();
    await expect(page.locator('#room-creator-open')).toContainText('2 rooms in this mod');
});

test('will not overwrite another room’s assets, and says which name to change', async ({ page }) => {
    await openPaneWithMod(page);
    await fillPicnicArea(page);
    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('16 files written');

    // The same name again: the four assets are that room's identity, not a shared list.
    await openSection(page, 'Identity');
    await page.locator('#room-creator-name').fill('PicnicAreaX');
    await page.locator('#room-creator-name').fill('PicnicArea');

    await expect(page.locator('#room-creator-plan')).toContainText('belong to another room');
    await expect(page.locator('#room-creator-write')).toBeDisabled();
    await expect(page.locator('#room-creator-write')).toContainText('Change the name to write');
});

test('a written room reads back as already here, and its patches carry one entry each', async ({ page }) => {
    await openPaneWithMod(page);
    await fillPicnicArea(page);
    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('16 files written');

    // A write is not a double-append: one room admitting one cluster is one operation.
    const after = JSON.parse(await readFile(page, 'Mods/TestCase/PicnicBench.sodso_patch.json'));
    expect(after.patches).toHaveLength(1);

    // The plan redraws against the folder as it now is, rather than the one it opened on.
    await expect(page.locator('#room-creator-plan')).toContainText('already here');
});

test('finds a room it wrote, and loads its choices back', async ({ page }) => {
    await openPaneWithMod(page);
    await fillPicnicArea(page);
    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('16 files written');

    // Reopen the pane so the folder is scanned again.
    await page.locator('#room-creator-modal button[rel="prev"]').click();
    await page.getByRole('link', { name: 'Room Creator' }).click();
    await openSection(page, 'Identity');

    const picker = page.locator('#room-creator-open');
    await expect(picker).toContainText('1 room in this mod');
    await picker.selectOption('PicnicAreaRC');

    await expect(page.locator('#room-creator-name')).toHaveValue('PicnicArea');
    await expect(page.locator('#room-creator-donor')).toHaveValue('Atrium');
    await expect(page.locator('#room-creator-opened')).toContainText('Read back: 1 clusters');
    await expect(page.locator('#room-creator-opened')).toContainText('Nothing here is overwritten');

    // The surfaces and the light came back too.
    await expect(page.locator('#room-creator-surface-walls')).toHaveValue('PlainWall');
    await expect(page.locator('#room-creator-surface-ceiling')).toHaveValue('PlasterCeiling');
});

test('reopening a room, changing its furniture and saving updates it in place', async ({ page }) => {
    await openPaneWithMod(page);

    // A cluster with several presets, so there is something to take back later.
    await page.locator('#room-creator-name').fill('Den');
    await page.locator('#room-creator-donor').selectOption('Atrium');
    await openSection(page, 'What goes in it');
    await page.locator('#room-creator-search').fill('4_LoungeSetSmall_A');
    await page.locator('#room-creator-clusters > li').first()
        .locator('> label input[type="checkbox"]').check();

    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('files written');

    const before = await listDir(page, 'Mods/TestCase');
    expect(before).toContain('LivingRoomRug.sodso_patch.json');

    // Reopen it, and the button offers to save rather than to write a second room.
    await page.locator('#room-creator-modal button[rel="prev"]').click();
    await page.getByRole('link', { name: 'Room Creator' }).click();
    await openSection(page, 'Identity');
    await page.locator('#room-creator-open').selectOption('DenRC');
    await expect(page.locator('#room-creator-write')).toContainText('Save Den');

    // Take one piece of furniture back.
    await openSection(page, 'What goes in it');
    await page.locator('#room-creator-search').fill('4_LoungeSetSmall_A');
    const row = page.locator('#room-creator-clusters > li').first();
    await row.locator('.room-creator-contents label', { hasText: 'LivingRoomRug' })
        .locator('input[type="checkbox"]').uncheck();

    await openSection(page, 'What will be written');
    await expect(page.locator('#room-creator-plan')).toContainText('1 taken back');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('listed in murdermanifest');

    // The patch held nothing but this room, so it has gone -- from the folder and from the
    // load order, which would otherwise name a file that is not there.
    const after = await listDir(page, 'Mods/TestCase');
    expect(after).not.toContain('LivingRoomRug.sodso_patch.json');
    expect(after).toContain('70sSofa.sodso_patch.json');

    const manifest = JSON.parse(await readFile(page, 'Mods/TestCase/murdermanifest.sodso.json'));
    expect(manifest.fileOrder).not.toContain('REF:LivingRoomRug');
    expect(manifest.fileOrder).toContain('REF:70sSofa');
});

test('taking a room back out of a patch leaves another room’s changes alone', async ({ page }) => {
    await openPaneWithMod(page);
    await fillPicnicArea(page);
    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('files written');

    // A second room admitting the same bench, so the patch carries two entries.
    await openSection(page, 'Identity');
    await page.locator('#room-creator-name').fill('PicnicAreaTwo');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('added to');

    // Reopen the first and drop the bench.
    await page.locator('#room-creator-modal button[rel="prev"]').click();
    await page.getByRole('link', { name: 'Room Creator' }).click();
    await openSection(page, 'Identity');
    await page.locator('#room-creator-open').selectOption('PicnicAreaRC');

    await openSection(page, 'What goes in it');
    await page.locator('#room-creator-search').fill('PicnicTable');
    await page.locator('#room-creator-clusters > li').first()
        .locator('.room-creator-contents input[type="checkbox"]').first().uncheck();

    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('listed in murdermanifest');

    // The file stays, carrying only the other room.
    const patch = JSON.parse(await readFile(page, 'Mods/TestCase/PicnicBench.sodso_patch.json'));
    expect(patch.patches.map((operation) => operation.value))
        .toEqual(['REF:RoomTypeFilter|PicnicAreaTwoRTF']);
});

/**
 * A file this tool wrote once is not a file it owns for ever.
 *
 * The pane's own note tells the author to go and edit what it wrote, and a save used to
 * rebuild each of the four assets from the plan -- throwing away every field the pane has no
 * control for, which on a `RoomConfiguration` is most of them.
 */
test('saving a room again keeps what was hand-added to its own assets', async ({ page }) => {
    await openPaneWithMod(page);
    await fillPicnicArea(page);
    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('16 files written');

    // Edited by hand, the way the pane invites: a field it writes, one it does not, and one
    // nothing in this app has heard of.
    const written = JSON.parse(await readFile(page, 'Mods/TestCase/PicnicAreaRC.RoomConfiguration.sodso.json'));
    await writeFixture(page, 'Mods/TestCase/PicnicAreaRC.RoomConfiguration.sodso.json', JSON.stringify({
        ...written, securityDoors: 2, useOwnership: true, somethingThisToolHasNeverHeardOf: 42,
    }));

    await page.locator('#room-creator-modal button[rel="prev"]').click();
    await page.getByRole('link', { name: 'Room Creator' }).click();
    await openSection(page, 'Identity');
    await page.locator('#room-creator-open').selectOption('PicnicAreaRC');

    await openSection(page, 'What will be written');
    await expect(page.locator('#room-creator-plan')).toContainText('rewritten');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('listed in murdermanifest');

    const after = JSON.parse(await readFile(page, 'Mods/TestCase/PicnicAreaRC.RoomConfiguration.sodso.json'));

    expect(after.securityDoors).toBe(2);
    expect(after.useOwnership).toBe(true);
    expect(after.somethingThisToolHasNeverHeardOf).toBe(42);

    // And it still states what it does own.
    expect(after.roomClass).toBe('REF:RoomClassPreset|PicnicAreaRCP');
    expect(after.roomType).toBe('REF:RoomTypePreset|PicnicArea');
});

/**
 * A cluster of the author's own, which is what they are told to make when a gate refuses a
 * shipped one.
 *
 * Two things must not happen to it, and both used to. It must not be patched -- whether a
 * patch over a file the mod declares applies at all is a question of load order -- and the
 * furniture it places must not be withdrawn because nothing here can say what that is.
 */
test('a cluster of the mod’s own is left alone, and keeps the furniture it admits', async ({ page }) => {
    const mine = {
        'Mods/Mine/murdermanifest.sodso.json': JSON.stringify({
            enabled: true,
            fileOrder: [
                'REF:Alcove.RoomClassPreset', 'REF:AlcoveThings.RoomTypeFilter',
                'REF:NookRoom.RoomTypePreset', 'REF:Nook.RoomConfiguration',
                'REF:MyPicnicTable.FurnitureCluster', 'REF:PicnicBench',
            ],
            loadBefore: '',
            version: 1,
        }),
        'Mods/Mine/Nook.RoomConfiguration.sodso.json': JSON.stringify({
            presetName: 'Nook', name: 'Nook', fileType: 'RoomConfiguration',
            copyFrom: 'REF:RoomConfiguration|Atrium',
            roomType: 'REF:RoomTypePreset|NookRoom',
            roomClass: 'REF:RoomClassPreset|Alcove',
        }),
        'Mods/Mine/Alcove.RoomClassPreset.sodso.json': JSON.stringify({
            presetName: 'Alcove', name: 'Alcove', fileType: 'RoomClassPreset',
        }),
        'Mods/Mine/NookRoom.RoomTypePreset.sodso.json': JSON.stringify({
            presetName: 'NookRoom', name: 'NookRoom', fileType: 'RoomTypePreset',
            copyFrom: 'REF:RoomTypePreset|Atrium',
        }),
        'Mods/Mine/AlcoveThings.RoomTypeFilter.sodso.json': JSON.stringify({
            presetName: 'AlcoveThings', name: 'AlcoveThings', fileType: 'RoomTypeFilter',
            roomClasses: ['REF:RoomClassPreset|Alcove'],
        }),

        // The author's own copy of PicnicTable, with the floor gate relaxed on the copy.
        'Mods/Mine/MyPicnicTable.FurnitureCluster.sodso.json': JSON.stringify({
            presetName: 'MyPicnicTable', name: 'MyPicnicTable', fileType: 'FurnitureCluster',
            copyFrom: 'REF:FurnitureCluster|PicnicTable',
            allowedRoomFilters: ['REF:RoomTypeFilter|AlcoveThings'],
            limitToFloorRange: false,
        }),

        // Which puts down a bench, admitted to the room the ordinary way.
        'Mods/Mine/PicnicBench.sodso_patch.json': JSON.stringify({
            name: 'PicnicBench', fileType: 'FurniturePreset',
            patches: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|AlcoveThings' }],
        }),
    };

    await page.addInitScript((k) => window.localStorage.setItem(k, 'true'), SPOILER_KEY);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, mine);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'Mine', '');

    await page.getByRole('link', { name: 'Room Creator' }).click();
    await expect(page.locator('#room-creator-verdict')).toContainText('furniture clusters suit this room');

    await page.locator('#room-creator-open').selectOption('Nook');
    await expect(page.locator('#room-creator-opened'))
        .toContainText('MyPicnicTable is a cluster of your own naming this room’s filter');

    await openSection(page, 'What will be written');
    await page.locator('#room-creator-write').click();
    await expect(page.locator('#room-creator-plan')).toContainText('listed in murdermanifest');

    // No patch aimed at the mod's own file, and the file itself untouched.
    const after = await listDir(page, 'Mods/Mine');
    expect(after).not.toContain('MyPicnicTable.sodso_patch.json');
    expect(after).not.toContain('MyPicnicTable.FurnitureCluster.sodso_patch.json');

    const cluster = JSON.parse(await readFile(page, 'Mods/Mine/MyPicnicTable.FurnitureCluster.sodso.json'));
    expect(cluster.limitToFloorRange).toBe(false);
    expect(cluster.allowedRoomFilters).toEqual(['REF:RoomTypeFilter|AlcoveThings']);

    // And the bench it places is still admitted. Saving used to withdraw it, because no
    // cluster this tool can read accounts for it.
    expect(after).toContain('PicnicBench.sodso_patch.json');
    const bench = JSON.parse(await readFile(page, 'Mods/Mine/PicnicBench.sodso_patch.json'));
    expect(bench.patches.map((operation) => operation.value))
        .toContain('REF:RoomTypeFilter|AlcoveThings');
});

test('finds a room assembled by hand, whose files follow no naming convention', async ({ page }) => {
    // Named nothing like what this tool writes: the configuration is `Nook`, the class
    // `Alcove`. Found only by following references.
    const handWritten = {
        'Mods/HandMade/murdermanifest.sodso.json': JSON.stringify({
            enabled: true, fileOrder: ['REF:Nook.RoomConfiguration'], loadBefore: '', version: 1,
        }),
        'Mods/HandMade/Nook.RoomConfiguration.sodso.json': JSON.stringify({
            presetName: 'Nook', name: 'Nook', type: 'RoomConfiguration', fileType: 'RoomConfiguration',
            copyFrom: 'REF:RoomConfiguration|Atrium',
            roomType: 'REF:RoomTypePreset|NookRoom',
            roomClass: 'REF:RoomClassPreset|Alcove',
        }),
        'Mods/HandMade/Alcove.RoomClassPreset.sodso.json': JSON.stringify({
            presetName: 'Alcove', name: 'Alcove', type: 'RoomClassPreset', fileType: 'RoomClassPreset',
        }),
        'Mods/HandMade/AlcoveThings.RoomTypeFilter.sodso.json': JSON.stringify({
            presetName: 'AlcoveThings', name: 'AlcoveThings', type: 'RoomTypeFilter',
            fileType: 'RoomTypeFilter', roomClasses: ['REF:RoomClassPreset|Alcove'],
        }),
        'Mods/HandMade/PicnicTable.sodso_patch.json': JSON.stringify({
            name: 'PicnicTable', fileType: 'FurnitureCluster',
            patches: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|AlcoveThings' }],
        }),
    };

    await page.addInitScript((k) => window.localStorage.setItem(k, 'true'), SPOILER_KEY);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, handWritten);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'HandMade', '');

    await page.getByRole('link', { name: 'Room Creator' }).click();
    await expect(page.locator('#room-creator-verdict')).toContainText('furniture clusters suit this room');

    await page.locator('#room-creator-open').selectOption('Nook');

    // The room type's name, not the configuration's, because that is what the author knows.
    await expect(page.locator('#room-creator-name')).toHaveValue('NookRoom');
    await expect(page.locator('#room-creator-donor')).toHaveValue('Atrium');
    await expect(page.locator('#room-creator-opened')).toContainText('Read back: 1 clusters');
});

test('says what it could not read rather than showing an empty room', async ({ page }) => {
    // A room whose furniture is admitted by a patch in the format this app replaced.
    const older = {
        'Mods/Older/murdermanifest.sodso.json': JSON.stringify({ enabled: true, fileOrder: [], loadBefore: '', version: 1 }),
        'Mods/Older/Nook.RoomConfiguration.sodso.json': JSON.stringify({
            presetName: 'Nook', fileType: 'RoomConfiguration', type: 'RoomConfiguration',
            roomType: 'REF:RoomTypePreset|NookRoom', roomClass: 'REF:RoomClassPreset|Alcove',
        }),
        'Mods/Older/Alcove.RoomClassPreset.sodso.json': JSON.stringify({
            presetName: 'Alcove', fileType: 'RoomClassPreset', type: 'RoomClassPreset',
        }),
        'Mods/Older/AlcoveThings.RoomTypeFilter.sodso.json': JSON.stringify({
            presetName: 'AlcoveThings', fileType: 'RoomTypeFilter', type: 'RoomTypeFilter',
            roomClasses: ['REF:RoomClassPreset|Alcove'],
        }),
        // No `patches` list, so this is the older whole-field format.
        'Mods/Older/PicnicTable.sodso_patch.json': JSON.stringify({
            name: 'PicnicTable', fileType: 'FurnitureCluster',
            allowedRoomFilters: ['REF:RoomTypeFilter|AlcoveThings'],
        }),
    };

    await page.addInitScript((k) => window.localStorage.setItem(k, 'true'), SPOILER_KEY);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, older);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'Older', '');

    await page.getByRole('link', { name: 'Room Creator' }).click();
    await expect(page.locator('#room-creator-verdict')).toContainText('furniture clusters suit this room');

    await page.locator('#room-creator-open').selectOption('Nook');
    await expect(page.locator('#room-creator-opened')).toContainText('older whole-field format');
});

test('closes, and reopens holding what was typed', async ({ page }) => {
    await openPane(page);

    await page.locator('#room-creator-name').fill('PicnicArea');
    await openSection(page, 'Where the room sits');
    await page.locator('#room-creator-floor').fill('3');

    await page.locator('#room-creator-modal button[rel="prev"]').click();
    await expectDialogOpen(page, '#room-creator-modal', false);

    await page.getByRole('link', { name: 'Room Creator' }).click();
    await expectDialogOpen(page, '#room-creator-modal', true);

    // And on the step it was left on, holding what was typed into it.
    await expect(page.locator('#room-creator-name')).toHaveValue('PicnicArea');
    await expect(page.locator('#room-creator-gates')).toContainText('refused, by 1 gate');
});
