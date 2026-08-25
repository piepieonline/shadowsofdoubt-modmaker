import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, connectFolders, selectContent, gotoFlow } from './support/harness.js';
import { soFolderContent } from './support/fixtures.js';

/**
 * The case flow's file panel, grouped by ScriptableObject type.
 *
 * The manifest panel beside it lists only what the manifest references. This lists
 * what is actually in the folder, which is routinely more: files not yet added to the
 * manifest, and patches of base game assets the manifest does not mention.
 */

const section = (page, type) => page.locator(`.file-panel-category[data-category="${type}"]`);

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFolderContent);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');
});

test('groups files by their fileType', async ({ page }) => {
    await expect(page.locator('#so-file-list .file-panel-category summary')).toHaveText([
        'AddressPreset (1)', 'EvidencePreset (1)', 'InteractablePreset (1)', 'MurderMO (3)',
        'Invalid (2)',
    ]);
});

test('lists files the manifest does not reference', async ({ page }) => {
    // The manifest only names testcase; the folder holds more.
    await expect(page.locator('#manifest_panel .files-order ul button')).toHaveText(['testcase']);

    await expect(section(page, 'MurderMO')).toContainText('AnotherMurder');
    await expect(section(page, 'InteractablePreset')).toContainText('IP_Note');
});

test('recovers the type of a patched base game asset', async ({ page }) => {
    // A patch written by hand holds only the fields it overrides, so it carries no type
    // of its own and the type comes from looking the asset name up in the reference
    // data. ExCopSniper is a MurderMO and nothing else, so that answers it.
    const patched = section(page, 'MurderMO').locator('.file-panel-entry[data-id="ExCopSniper"]');
    await expect(patched).toHaveAttribute('data-kind', 'patch');
});

test('a patch is grouped by the type it states, not by what its name could be', async ({ page }) => {
    // Bar is an AddressPreset, a RoomTypeFilter and four other things. The name lookup
    // takes whichever type the reference data lists first, which put an AddressPreset
    // patch under RoomTypeFilter; the file says which it is, so the file wins.
    await expect(section(page, 'AddressPreset').locator('.file-panel-entry[data-id="Bar"]'))
        .toHaveAttribute('data-kind', 'patch');
    await expect(section(page, 'RoomTypeFilter')).toHaveCount(0);
});

test('files that name no type the game has are set apart as invalid', async ({ page }) => {
    // Neither can be grouped: one claims a type that does not exist, the other is a
    // patch of nothing, with no type inside it and a name no asset answers to. Filing
    // either under a type would be a guess dressed up as a fact.
    const invalid = section(page, 'Invalid');
    await expect(invalid.locator('.file-panel-entry')).toHaveText(['Nonsense', 'NotAnAsset']);

    // And there is nothing to open them as, so they are listed rather than linked.
    await expect(invalid.locator('button')).toHaveCount(0);
});

test('invalid files are listed after the types, not among them', async ({ page }) => {
    // Sorting it alphabetically would bury it between EvidencePreset and MurderMO.
    const summaries = page.locator('#so-file-list .file-panel-category summary');
    await expect(summaries.last()).toContainText('Invalid');
});

test('opening a patch loads the patch file, not the asset it overrides', async ({ page }) => {
    // Both names are the same in the list; only the extension tells them apart.
    await section(page, 'MurderMO').getByRole('button', { name: 'ExCopSniper' }).click();

    const window_ = page.locator('#trees .file-window');
    await expect(window_).toHaveCount(1);
    await expect(window_).toHaveAttribute('path', 'ExCopSniper.sodso_patch.json');
});

test('opening an entry loads that file', async ({ page }) => {
    await section(page, 'InteractablePreset').getByRole('button', { name: 'IP_Note' }).click();

    const window_ = page.locator('#trees .file-window');
    await expect(window_).toHaveCount(1);
    await expect(window_).toHaveAttribute('path', 'IP_Note.sodso.json');
});

test('the manifest itself is not listed as an asset', async ({ page }) => {
    // It describes the mod rather than being content of its own.
    await expect(page.locator('#so-file-list')).not.toContainText('murdermanifest');
});
