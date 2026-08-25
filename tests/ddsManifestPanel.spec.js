import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, connectFolders, selectContent, readFile, alerts, gotoFlow, fieldInput } from './support/harness.js';
import {
    ddsManifestFixture, ddsManifestNoBlocksFixture, ddsManifestBrokenFixture,
    ddsFixtureWithContent, FLAT_MOD, TREE_GUID,
} from './support/fixtures.js';

/**
 * The panel showing what a mod's ddsmanifest declares.
 *
 * The file panel below it lists what is on disk; this lists what the loader is told
 * about it. Both are needed: a mapping is the only thing explaining why a file the
 * game reads as Strings/English/Citizens/jobs.csv is sitting at the content root.
 */

const FLAT = 'Mods/FlatMod/plugins/BookcaseOffice/DDSContent';

const panel = (page) => page.locator('#dds-manifest-panel');

async function openFlatMod(page, fixture = ddsManifestFixture) {
    await seedFs(page, fixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, FLAT_MOD.mod, FLAT_MOD.content);
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
});

test('appears only for a mod that has a manifest', async ({ page }) => {
    await seedFs(page, ddsFixtureWithContent);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestMod', 'Content');

    // Offering an editor here would invite a mod into a structure its author has not
    // chosen, and the app never creates a manifest by itself.
    await expect(panel(page)).toBeHidden();
});

test('lists an entry per mapping, titled with the path the game reads', async ({ page }) => {
    await openFlatMod(page);

    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator('.files-order button'))
        .toHaveText(['jobs.csv', 'dds.blocks.csv']);

    await expect(panel(page).locator('.files-order button').first())
        .toHaveAttribute('title', 'Read by the game as Strings/English/Citizens/jobs.csv');
});

test('the full manifest is behind the switch', async ({ page }) => {
    await openFlatMod(page);

    await expect(panel(page).locator('.manifest-source')).toBeHidden();

    await panel(page).getByRole('switch').click();

    await expect(panel(page).locator('.manifest-source')).toBeVisible();
    await expect(panel(page).locator('.files-order')).toBeHidden();
    await expect(panel(page).locator('.manifest-source')).toContainText('Strings/English/Citizens');
});

test('the panel follows the manifest the app writes for itself', async ({ page }) => {
    await openFlatMod(page, ddsManifestNoBlocksFixture);

    // One mapping to begin with, and the panel says so.
    await expect(panel(page).locator('.files-order button')).toHaveText(['jobs.csv']);

    // Writing the first line of block text declares the file it created. Nothing else
    // in the app rewrites a manifest, so this is what the panel has to keep up with.
    await page.evaluate((g) => { document.getElementById('path-to-read').value = g; }, TREE_GUID);
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await page.locator('#file-window-2 .jsontree_child-nodes').first().waitFor();

    const line = fieldInput(page, '#file-window-2', '_ENG Localisation_');
    await line.fill('First line of block text');
    await line.blur();

    // toHaveProperty would read the dots in the filename as a path into the object.
    await expect.poll(async () =>
        Object.keys(JSON.parse(await readFile(page, `${FLAT}/ddsmanifest.json`)).files))
        .toContain('dds.blocks.csv');

    // And the panel says so, rather than describing the manifest as it was found.
    await expect(panel(page).locator('.files-order button'))
        .toHaveText(['jobs.csv', 'dds.blocks.csv']);
    expect(await alerts(page)).toEqual([]);
});

test('a manifest that cannot be parsed is shown as its text, and marked', async ({ page }) => {
    await openFlatMod(page, ddsManifestBrokenFixture);

    // Nothing can be listed from it, so without the mark an empty list would be the
    // only sign that anything is wrong.
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator('.files-order button')).toHaveCount(0);

    await panel(page).getByRole('switch').click();

    // The text is what its author has to repair, so it is what they are shown.
    await expect(panel(page).locator('.manifest-broken')).toHaveText('{ "enabled": true, "files"');
});
