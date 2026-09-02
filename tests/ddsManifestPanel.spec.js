import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, selectContent, readFile, alerts, gotoFlow,
    fieldInput, openDdsDocument, confirms,
} from '../test-support/harness.js';
import {
    ddsManifestFixture, ddsManifestNoBlocksFixture, ddsManifestBrokenFixture,
    ddsFixtureWithContent, FLAT_MOD, TREE_GUID,
} from '../test-support/fixtures.js';

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
    await openDdsDocument(page, TREE_GUID);
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

test('deleting a mapped CSV takes its entry out of the manifest with it', async ({ page }) => {
    await openFlatMod(page);

    // BookcaseOffice keeps its CSVs flat and declares where the game reads them from, so
    // this file exists only because an entry places it. An entry left naming a file that
    // has gone is a loader going looking for something it cannot find.
    await page.locator('.file-panel-category[data-category="strings"] '
        + '.file-panel-entry[data-id="jobs.csv"] .file-panel-danger').click();

    await expect.poll(async () => (await confirms(page)).length).toBeGreaterThan(0);

    // The entry goes with the file, so it is not among the references the author is
    // warned about -- the list is what will be left pointing at nothing. jobs.csv holds
    // job titles rather than block text, so nothing in the mod loses a line either.
    const asked = (await confirms(page)).at(-1);
    expect(asked).toContain('Delete "jobs" from this mod?');
    expect(asked).not.toContain('ddsmanifest.json');

    await expect(panel(page).locator('.files-order button')).toHaveText(['dds.blocks.csv']);

    const manifest = JSON.parse(await readFile(page, `${FLAT}/ddsmanifest.json`));
    expect(manifest.files).toEqual({ 'dds.blocks.csv': 'Strings/English/DDS' });
    // Everything the app has no view on survives the rewrite.
    expect(manifest.enabled).toBe(true);
});

test('deleting an unmapped CSV leaves the manifest untouched', async ({ page }) => {
    await openFlatMod(page, ddsManifestNoBlocksFixture);

    // Only jobs.csv is declared here. A file sitting where the game already reads it from
    // needs no entry, so there is nothing about it to rewrite -- and a delete that
    // rewrote the author's manifest anyway would be reformatting it for no reason.
    const before = await readFile(page, `${FLAT}/ddsmanifest.json`);

    await page.locator('.file-panel-category[data-category="strings"] '
        + '.file-panel-entry[data-id="jobs.csv"] .file-panel-danger').click();

    await expect(panel(page).locator('.files-order button')).toHaveCount(0);

    const after = JSON.parse(await readFile(page, `${FLAT}/ddsmanifest.json`));
    expect(after.files).toEqual({});
    expect(before).toContain('jobs.csv');
});
