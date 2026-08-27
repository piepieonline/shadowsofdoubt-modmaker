import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, connectFolders, selectContent, gotoFlow } from './support/harness.js';
import { caseWithDdsReference, TREE_GUID } from './support/fixtures.js';

/**
 * Following a DDS reference out of a case file.
 *
 * These used to be separate sites, so the case editor opened the DDS viewer in a new
 * tab and handed the GUID over in the URL. One app now, and the same content folder
 * either side, so it is a change of view rather than a handoff.
 */

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, caseWithDdsReference);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    // Open the case file that carries the reference.
    await page.locator('#manifest_panel .files-order ul button').click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);
});

test('following a DDS reference switches to the DDS flow and opens it', async ({ page }) => {
    await page.locator('#trees .link-element').first().click();

    await page.locator('html[data-flow-ready="dds"]').waitFor();
    expect(await page.evaluate(() => window.activeFlow?.id)).toBe('dds');

    // And it actually loaded the referenced tree, rather than just switching.
    await expect(page.locator('#file-window-0')).toContainText('TestTree');
    await expect(page.locator('#file-window-0'))
        .toHaveAttribute('path', `DDS/Trees/${TREE_GUID}.tree`);
});

test('the content folder stays selected across the handoff', async ({ page }) => {
    await page.locator('#trees .link-element').first().click();
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    // A case's files and its DDS text live in the same folder, so following a
    // reference between them must not change what is being worked on.
    expect(await page.evaluate(() => window.selectedMod?.modName ?? null)).toBe('TestCase');
    await expect(page.locator('#select-mod')).toHaveValue('TestCase');
});

test('the flow picker follows the switch', async ({ page }) => {
    await page.locator('#trees .link-element').first().click();
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    await expect(page.locator('#flow-picker')).toHaveValue('dds');
    expect(new URL(page.url()).searchParams.get('flow')).toBe('dds');
});

test('it opens in the same tab, not a new window', async ({ page, context }) => {
    // The old behaviour was window.open to a separate site.
    const before = context.pages().length;
    await page.locator('#trees .link-element').first().click();
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    expect(context.pages().length).toBe(before);
});
