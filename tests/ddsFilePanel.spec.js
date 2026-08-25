import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, connectFolders, selectContent, gotoFlow, alerts } from './support/harness.js';
import { ddsFixtureWithContent, TREE_GUID, MSG_GUID } from './support/fixtures.js';

/**
 * The left-hand panel listing what a mod contains.
 *
 * The case flow gets this from its manifest. DDS has no manifest -- content is found
 * by GUID -- so without this there is no way to see what a mod holds, or to open
 * anything without knowing its GUID already.
 */

const section = (page, id) => page.locator(`.file-panel-category[data-category="${id}"]`);

async function openMod(page) {
    await seedFs(page, ddsFixtureWithContent);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestMod', 'Content');
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
});

test('lists the four kinds of DDS content', async ({ page }) => {
    await openMod(page);

    // Trees hold messages, messages hold blocks, blocks resolve to strings.
    await expect(page.locator('.file-panel-category summary')).toHaveText([
        'Trees (2)', 'Messages (1)', 'Blocks (1)', 'Strings (3)',
    ]);
});

test('shows a mod\'s own files by name rather than GUID', async ({ page }) => {
    await openMod(page);

    await expect(section(page, 'trees')).toContainText('ModTree');
    await expect(section(page, 'messages')).toContainText('ModMessage');
    await expect(section(page, 'blocks')).toContainText('ModBlock');
});

test('marks base game content the mod overrides', async ({ page }) => {
    await openMod(page);

    // A _patch file is a diff against vanilla, which nothing else in the app surfaces.
    const patched = section(page, 'trees').locator(`.file-panel-entry[data-id="${TREE_GUID}"]`);
    await expect(patched).toHaveAttribute('data-kind', 'patch');
    await expect(patched).toContainText('patch');

    // The mod's own file is not marked.
    await expect(section(page, 'trees').locator('.file-panel-entry:not([data-kind])')).toHaveCount(1);
});

test('lists strings as the files they live in, wherever they are nested', async ({ page }) => {
    await openMod(page);

    // Two under a folder for what they name, one directly under the language.
    await expect(section(page, 'strings').locator('.file-panel-entry')).toHaveText([
        'dds.blocks', 'evidence.names', 'names.rooms',
    ]);

    // The path is what tells apart two languages' files of the same name.
    await expect(section(page, 'strings').locator('.file-panel-name').first())
        .toHaveAttribute('title', 'Strings/English/DDS/dds.blocks.csv');
});

test('opening an entry loads it, without needing to know its GUID', async ({ page }) => {
    await openMod(page);

    await section(page, 'blocks').getByRole('button', { name: 'ModBlock' }).click();

    // Opened directly, so it is the top window rather than the end of a drill-down.
    await expect(page.locator('#file-window-0')).toContainText('ModBlock');
    await expect(page.locator('#path-to-read'))
        .toHaveValue('cccccccc-3333-4333-8333-333333333333');
});

test('a strings file is a button, and clicking it does nothing yet', async ({ page }) => {
    await openMod(page);

    await section(page, 'strings').getByRole('button', { name: 'dds.blocks' }).click();

    // No editor for strings files yet: nothing opens, and nothing is mistaken for a
    // GUID and complained about.
    await expect(page.locator('#file-window-0')).toHaveCount(0);
    expect(await alerts(page)).toEqual([]);
});

test('prompts to choose a mod before anything is selected', async ({ page }) => {
    await seedFs(page, ddsFixtureWithContent);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

    await expect(page.locator('#dds-file-list')).toContainText('Choose a mod');
    await expect(page.locator('.file-panel-category')).toHaveCount(0);
});

test('editing base game content adds its patch to the panel', async ({ page }) => {
    await openMod(page);

    // The patched tree in the fixture is already listed; open an unpatched one.
    await page.evaluate((g) => { document.getElementById('path-to-read').value = g; }, MSG_GUID);
    await page.selectOption('#select-guid-type', 'message');
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await expect(page.locator('#file-window-0')).toContainText('TestMessage');

    await expect(section(page, 'messages').locator(`.file-panel-entry[data-id="${MSG_GUID}"]`)).toHaveCount(0);

    await page.locator('#file-window-0').getByRole('button', { name: 'Save' }).click();

    // Saving base game content writes a patch, which is now part of the mod.
    const patched = section(page, 'messages').locator(`.file-panel-entry[data-id="${MSG_GUID}"]`);
    await expect(patched).toHaveAttribute('data-kind', 'patch');
    await expect(section(page, 'messages').locator('summary')).toHaveText('Messages (2)');
});
