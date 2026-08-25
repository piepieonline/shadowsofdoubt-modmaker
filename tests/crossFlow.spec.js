import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, queuePicks, connectFolders, selectContent, gotoFlow } from './support/harness.js';
import { ddsFixture, soFixture, pluginsFixture } from './support/fixtures.js';

/**
 * The point of the merge: both flows share one persisted mod folder.
 *
 * Before this, the DDS Viewer stored the handle under 'DDSModPath' and the Case
 * Editor under 'ModPath', so a folder opened in one was invisible to the other --
 * the "No way to pass this from one app to the other :(" comment in the DDS flow's
 * fileManager.js.
 */

const modDirName = (page) =>
    page.evaluate(async () => (await idbKeyval.get('ModPath'))?.name ?? null);

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

test('a mod folder opened in the DDS flow is remembered for the case flow', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, { ...ddsFixture, ...soFixture });
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

    await expect.poll(() => modDirName(page)).toBe('Mods');

    // Same origin, so the other flow sees the same idb-keyval entry.
    await gotoFlow(page, '?flow=scriptableObject');
    expect(await modDirName(page)).toBe('Mods');
});

test('a mod folder opened in the case flow is remembered for the DDS flow', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, { ...ddsFixture, ...soFixture });
    await connectFolders(page, { modDir: 'Mods' });

    await expect.poll(() => modDirName(page)).toBe('Mods');

    await gotoFlow(page, '?flow=dds');
    expect(await modDirName(page)).toBe('Mods');
});

test('a folder remembered under the old DDS Viewer key is adopted', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsFixture);

    // A user of the old DDS Viewer, whose handle is under the legacy key.
    await page.evaluate(async () => {
        const mods = await window.__opfsDir('Mods', false);
        await idbKeyval.set('DDSModPath', mods);
        await idbKeyval.del('ModPath');
    });

    await page.locator('[data-select-folder="modDir"]').click();
    await page.locator('.folder-row[data-folder="modDir"][data-state="connected"]').waitFor();

    // No file dialog: the remembered handle was still usable, so it is adopted
    // directly rather than making the user find the folder again.
    expect(await page.evaluate(() => window.__pickerCalls.length)).toBe(0);
    // And written forward to the shared key, so the other flow sees it too.
    await expect.poll(() => modDirName(page)).toBe('Mods');
});

test('a remembered folder reconnects on load without asking', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFixture);
    await page.evaluate(async () => {
        await idbKeyval.set('ModPath', await window.__opfsDir('Mods', false));
    });

    await gotoFlow(page, '?flow=scriptableObject');

    // Already connected, so the modal does not interrupt and the mod list is there.
    await expect(page.locator('#folders-modal')).toBeHidden();
    await expect(page.locator('#select-mod option')).toHaveText(['Choose a mod…', 'TestCase']);
    expect(await page.evaluate(() => window.__pickerCalls.length)).toBe(0);
});

test('switching flows keeps the folders connected', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, { ...ddsFixture, ...soFixture });
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

    await page.selectOption('#flow-picker', 'scriptableObject');
    await page.locator('html[data-flow-ready="scriptableObject"]').waitFor();

    // Nothing was asked for again. __pickerCalls is page state, so its surviving
    // also proves the switch happened in place rather than by reloading.
    expect(await page.evaluate(() => window.__pickerCalls.length)).toBe(2);
    expect(await page.evaluate(() => window.dirHandleModDir?.name ?? null)).toBe('Mods');
    expect(await page.evaluate(() => window.dirHandleStreamingAssets?.name ?? null)).toBe('StreamingAssets');

    // The new flow is usable straight away, not sitting behind the folder modal.
    // Both fixtures are seeded, so both mod folders are listed.
    await expect(page.locator('#folders-modal')).toBeHidden();
    await expect(page.locator('#select-mod option')).toHaveText(['Choose a mod…', 'TestCase', 'TestMod']);

    // And back again.
    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();
    expect(await page.evaluate(() => window.__pickerCalls.length)).toBe(2);
    await expect(page.locator('#folders-modal')).toBeHidden();
});

test('the folders modal can be reopened to change a folder later', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFixture);
    await connectFolders(page, { modDir: 'Mods' });
    await expect(page.locator('#folders-modal')).toBeHidden();

    await page.getByRole('button', { name: 'Folders' }).click();
    await expect(page.locator('#folders-modal')).toBeVisible();

    // Already-connected folders are shown as such, with the option to change them.
    const row = page.locator('.folder-row[data-folder="modDir"]');
    await expect(row).toHaveAttribute('data-state', 'connected');
    await expect(row).toContainText('Mods');
    await expect(row.getByRole('button')).toHaveText('Change');
});

test('switching flows never reopens the folder modal, even when one is missing', async ({ page }) => {
    // The case flow needs only the mod folder; the DDS flow also needs the game
    // folder. Switching to it therefore has an unmet requirement.
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, { ...ddsFixture, ...soFixture });
    await connectFolders(page, { modDir: 'Mods' });
    await expect(page.locator('#folders-modal')).toBeHidden();

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    // Not in the way -- but the header says something is outstanding.
    await expect(page.locator('#folders-modal')).toBeHidden();
    await expect(page.locator('#folders-open')).toHaveAttribute('data-folders-missing', '');

    // And it is still reachable on demand.
    await page.getByRole('button', { name: 'Folders' }).click();
    await expect(page.locator('#folders-modal')).toBeVisible();
    await expect(page.locator('.folder-row[data-folder="streamingAssets"]'))
        .toHaveAttribute('data-state', 'missing');
});

test('the folders button stops flagging once the requirement is met', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsFixture);
    await expect(page.locator('#folders-open')).toHaveAttribute('data-folders-missing', '');

    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await expect(page.locator('#folders-open')).not.toHaveAttribute('data-folders-missing', '');
});

test('the chosen content folder survives switching flows', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, pluginsFixture);
    await connectFolders(page, { modDir: 'Plugins' });

    // A folder holding both a case manifest and DDS content -- the reason the choice
    // belongs to the shell rather than to one flow.
    await selectContent(page, 'DialogAdditions', 'plugins/WhatIsYourPasscode');

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    expect(await page.evaluate(() => window.selectedMod?.modName ?? null)).toBe('DialogAdditions');
    expect(await page.evaluate(() => window.selectedMod?.contentPath ?? null))
        .toBe('plugins/WhatIsYourPasscode');
    await expect(page.locator('#select-mod')).toHaveValue('DialogAdditions');
    await expect(page.locator('#select-content')).toHaveValue('plugins/WhatIsYourPasscode');
});

test('both flows offer adding content the same way', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, pluginsFixture);
    await connectFolders(page, { modDir: 'Plugins' });
    await selectContent(page, 'DialogAdditions', 'plugins/WhatIsYourPasscode');

    const caseButton = page.locator('#manifest_add_item_button');
    await expect(caseButton).toHaveText('Add new file');
    const caseBox = await caseButton.boundingBox();

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    // Same wording, naming what this flow makes rather than "file".
    const ddsButton = page.locator('#new-file-button');
    await expect(ddsButton).toHaveText('Add new tree');
    await page.selectOption('#select-guid-type', 'block');
    await expect(ddsButton).toHaveText('Add new block');

    // And the same button: the DDS one used to be a secondary at Pico's full padding,
    // towering over the file list it sits above.
    const ddsBox = await ddsButton.boundingBox();
    expect(Math.abs(ddsBox.height - caseBox.height)).toBeLessThan(2);
    await expect(ddsButton).not.toHaveClass(/secondary/);
});

test('mods are listed with what each of their folders holds', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, pluginsFixture);
    await connectFolders(page, { modDir: 'Plugins' });

    // A mod whose content sits at its own root.
    await page.selectOption('#select-mod', 'DartTowerTest');
    await expect(page.locator('#select-content option')).toHaveText([
        'Choose a folder…', '(mod root) — case + DDS',
    ]);

    // A mod with several, one of which has no DDS content.
    await page.selectOption('#select-mod', 'AdditionalEvidence');
    await expect(page.locator('#select-content option')).toHaveText([
        'Choose a folder…', 'BinPasscodes — case', 'GroupFlyers — case + DDS',
    ]);

    // A loader with nothing editable says so rather than looking broken.
    await page.selectOption('#select-mod', 'UnityExplorer');
    await expect(page.locator('#select-content option')).toHaveText(['Nothing editable in this mod']);
});
