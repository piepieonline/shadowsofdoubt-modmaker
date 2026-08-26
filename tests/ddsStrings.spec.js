import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, selectContent, readFile, listDir, alerts,
    collectPageErrors, gotoFlow, fieldInput,
} from './support/harness.js';
import {
    ddsFixtureWithContent, ddsBareFixture, ddsManifestFixture, ddsManifestMissingFileFixture,
    ddsManifestBlocksDeclaredFixture, ddsQuotedStringsFixture,
    FLAT_MOD, TREE_GUID, BLOCK_GUID, BLOCK_TEXT,
} from './support/fixtures.js';

/**
 * A mod's strings CSV, edited as text.
 *
 * The app used to write these a row at a time and only ever through a block's English
 * line, so a file it had not written -- room names, job titles -- or a row that was
 * already wrong could not be touched at all. These pin that the file is editable as
 * what it is, and that the text the app caches from it keeps up.
 */

const FLAT = 'Mods/FlatMod/plugins/BookcaseOffice/DDSContent';
const MOD_CSV = 'Mods/TestMod/Content/DDSContent/Strings/English/DDS/dds.blocks.csv';

const section = (page, id) => page.locator(`.file-panel-category[data-category="${id}"]`);
const editor = (page) => page.locator('#strings-window textarea');

/** The block's English line, resolved from a CSV rather than held in the document. */
const blockText = (page) => fieldInput(page, '#file-window-2', '_ENG Localisation_');

async function openMod(page, fixture = ddsFixtureWithContent, mod = 'TestMod', content = 'Content') {
    await seedFs(page, fixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, mod, content);
}

/** Load the vanilla tree, which cascades down to a block with text of its own. */
async function loadBlock(page) {
    await page.evaluate((g) => { document.getElementById('path-to-read').value = g; }, TREE_GUID);
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await page.locator('#file-window-2 .jsontree_child-nodes').first().waitFor();
}

/** Not an exact match: a mapped file's button carries its tag as well as its name. */
async function openStrings(page, name) {
    await section(page, 'strings').getByRole('button', { name }).click();
    await editor(page).waitFor();
}

/** Type into the editor and leave it, which is what autosave writes on. */
async function type(page, text) {
    await editor(page).fill(text);
    await editor(page).blur();
}

/** Add a row for a block, the way an author correcting a file by hand would. */
async function appendRow(page, guid, text) {
    const current = await editor(page).inputValue();
    await type(page, `${current}\n${guid},,${text},,,,09:00 01/01/2024`);
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
});

test('opens the file as it is on disk, named by where the game reads it', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openMod(page);
    await openStrings(page, 'dds.blocks');

    // Every row, headers included -- this is the file, not a view of the rows the app
    // knows how to write.
    await expect(editor(page)).toHaveValue(await readFile(page, MOD_CSV));
    await expect(page.locator('#strings-window')).toContainText('Strings/English/DDS/dds.blocks.csv');

    expect(await alerts(page)).toEqual([]);
    expect(errors).toEqual([]);
});

test('the text fills the window rather than the window fitting the text', async ({ page }) => {
    await openMod(page);
    await openStrings(page, 'dds.blocks');

    const box = await page.locator('#strings-window').boundingBox();
    const text = await editor(page).boundingBox();

    // A CSV is as long as it is: a box that grew with it would push the controls off
    // the bottom of the screen, and one sized to a default would waste the window.
    expect(text.height).toBeGreaterThan(box.height / 2);
    expect(text.y + text.height).toBeLessThanOrEqual(box.y + box.height);
    expect(text.width).toBeGreaterThan(400);
});

test('writes back exactly what was typed', async ({ page }) => {
    await openMod(page);
    await openStrings(page, 'names.rooms');

    // Nothing the app would ever write itself: a row it did not author, edited in a way
    // it has no opinion about.
    const edited = 'ModRoom,,A renamed room,,,,09:00 01/01/2024\nAnotherRoom,,Added by hand,,,,10:00 02/01/2024';
    await type(page, edited);

    await expect
        .poll(() => readFile(page, 'Mods/TestMod/Content/DDSContent/Strings/English/names.rooms.csv'))
        .toBe(edited);
});

test('opening a strings file leaves the drill-down alone', async ({ page }) => {
    await openMod(page);
    await loadBlock(page);
    await openStrings(page, 'dds.blocks');

    // A CSV is not a level of the cascade. The reason to have one open is usually the
    // block in the window beside it. (The tree reads as Patched: this mod overrides it.)
    await expect(page.locator('#file-window-0')).toContainText('Tree: Patched');
    await expect(page.locator('#file-window-2')).toContainText('Block: TestBlock');
});

test('saving block text reseeds what open documents resolve against', async ({ page }) => {
    await openMod(page);
    await loadBlock(page);

    // The block's line comes from the base game file: the mod has no row for it.
    await expect(blockText(page)).toHaveValue(BLOCK_TEXT);

    await openStrings(page, 'dds.blocks');
    await appendRow(page, BLOCK_GUID, 'Given to the block by hand');

    // Cached at load and resolved into the document as it rendered, so both the map and
    // the open window have to be put back.
    await expect(blockText(page)).toHaveValue('Given to the block by hand');
    expect(await alerts(page)).toEqual([]);

    // Reloading a document appends its window, which would otherwise leave the file
    // that caused the reload sitting in front of the drill-down.
    const strings = await page.locator('#strings-window').boundingBox();
    const block = await page.locator('#file-window-2').boundingBox();
    expect(strings.x).toBeGreaterThan(block.x);
});

test('saving a file nothing caches leaves the documents as they are', async ({ page }) => {
    await openMod(page);
    await loadBlock(page);
    await openStrings(page, 'evidence.names');

    await type(page, 'ModEvidence,,A renamed evidence name,,,,09:00 01/01/2024');

    await expect
        .poll(() => readFile(page, 'Mods/TestMod/Content/DDSContent/Strings/English/Evidence/evidence.names.csv'))
        .toContain('A renamed evidence name');

    // Evidence names are not block text: nothing here holds them, so there is nothing
    // to reseed and no reason to reload anything.
    await expect(blockText(page)).toHaveValue(BLOCK_TEXT);
});

test('reseeds through the manifest, not by where the file sits', async ({ page }) => {
    await openMod(page, ddsManifestFixture, FLAT_MOD.mod, FLAT_MOD.content);
    await loadBlock(page);

    await expect(blockText(page)).toHaveValue('Text from the flat mod');

    // DDSContent/dds.blocks.csv, which is block text only because the manifest says the
    // game reads it as Strings/English/DDS/dds.blocks.csv.
    await openStrings(page, 'dds.blocks');
    await appendRow(page, BLOCK_GUID, 'Rewritten in the flat mod');

    await expect(blockText(page)).toHaveValue('Rewritten in the flat mod');
    // Written where it was opened from, and no layout invented around it.
    await expect.poll(() => readFile(page, `${FLAT}/dds.blocks.csv`)).toContain('Rewritten in the flat mod');
    expect(await listDir(page, `${FLAT}/Strings`)).toBeNull();
});

test('a file the manifest declares but the mod has not written opens empty', async ({ page }) => {
    await openMod(page, ddsManifestMissingFileFixture, FLAT_MOD.mod, FLAT_MOD.content);

    // Only the manifest knows about it: the file list is built from what is on disk.
    await expect(section(page, 'strings').locator('.file-panel-name')).toHaveText(['jobs', 'dds.blocks']);

    await page.locator('#dds-manifest-panel').getByRole('button', { name: 'names.rooms.csv' }).click();
    await expect(editor(page)).toHaveValue('');

    // Written the first time there is something to put in it, as everything else in
    // this flow is.
    expect(await readFile(page, `${FLAT}/names.rooms.csv`)).toBeNull();
    await type(page, 'FlatRoom,,The first room this mod names,,,,09:00 01/01/2024');

    await expect.poll(() => readFile(page, `${FLAT}/names.rooms.csv`))
        .toBe('FlatRoom,,The first room this mod names,,,,09:00 01/01/2024');
});

test('with autosave off, only Save writes', async ({ page }) => {
    await openMod(page);
    await openStrings(page, 'names.rooms');

    await page.locator('#autosave-switch').uncheck();

    const before = await readFile(page, 'Mods/TestMod/Content/DDSContent/Strings/English/names.rooms.csv');
    await type(page, 'ModRoom,,Typed with autosave off,,,,09:00 01/01/2024');

    // Leaving the field is not a decision to write, any more than it is in a tree.
    expect(await readFile(page, 'Mods/TestMod/Content/DDSContent/Strings/English/names.rooms.csv')).toBe(before);
    await expect(page.locator('#strings-window')).toHaveAttribute('data-dirty', '');

    await page.locator('#strings-window').getByRole('button', { name: 'Save' }).click();

    await expect
        .poll(() => readFile(page, 'Mods/TestMod/Content/DDSContent/Strings/English/names.rooms.csv'))
        .toBe('ModRoom,,Typed with autosave off,,,,09:00 01/01/2024');
    await expect(page.locator('#strings-window')).not.toHaveAttribute('data-dirty', '');
});

test('an open file shows a row written from a block', async ({ page }) => {
    await openMod(page);
    await loadBlock(page);
    await openStrings(page, 'dds.blocks');

    // Editing a block's English line writes a row straight to disk, so the window is
    // otherwise left looking at what the file was a moment ago.
    await blockText(page).fill('Sent from the block');
    await blockText(page).blur();

    // Its value, not its text: a textarea's contents are what was put in it.
    await expect.poll(() => editor(page).inputValue()).toContain(`${BLOCK_GUID},,Sent from the block`);
});

test('a file the block edit creates is shown in the window already open on it', async ({ page }) => {
    await openMod(page, ddsManifestBlocksDeclaredFixture, FLAT_MOD.mod, FLAT_MOD.content);

    // Declared, never written: there is no file for the window to be holding.
    await page.locator('#dds-manifest-panel').getByRole('button', { name: 'dds.blocks.csv' }).click();
    await expect(editor(page)).toHaveValue('');

    await loadBlock(page);
    await blockText(page).fill('The first line this mod has');
    await blockText(page).blur();

    // A file that does not exist cannot be identified by handle, so this is the one
    // case that rests on both sides naming it the same way -- which they do, because
    // both take the name from the manifest.
    await expect.poll(() => editor(page).inputValue()).toContain('The first line this mod has');
});

test('a row written from a block does not overwrite unsaved text', async ({ page }) => {
    await openMod(page);
    await loadBlock(page);
    await openStrings(page, 'dds.blocks');

    await page.locator('#autosave-switch').uncheck();
    await editor(page).fill('HEADER 1,,,,,,\nUnsaved work in progress,,,,,,');

    await blockText(page).fill('Sent from the block');
    await blockText(page).blur();

    // Re-reading would throw away work that has not been written. The window says so
    // instead.
    await expect(editor(page)).toHaveValue('HEADER 1,,,,,,\nUnsaved work in progress,,,,,,');
    await expect(page.locator('#strings-window')).toHaveAttribute('data-dirty', '');
});

test('a row quoted the way the game writes them is rewritten in place', async ({ page }) => {
    await openMod(page, ddsQuotedStringsFixture);
    await loadBlock(page);

    // The mod's own line, read through the quotes as the game's loader reads them.
    await expect(blockText(page)).toHaveValue('An existing quoted line');

    await blockText(page).fill('Rewritten over the quoted row');
    await blockText(page).blur();

    await expect.poll(() => readFile(page, MOD_CSV)).toContain('Rewritten over the quoted row');

    const csv = await readFile(page, MOD_CSV);
    // One row for the block. The old text left behind beside a new row would be a file
    // whose meaning depends on which of the two the loader reaches first.
    expect(csv.split('\n').filter((line) => line.includes(BLOCK_GUID))).toHaveLength(1);
    expect(csv).not.toContain('An existing quoted line');
});

test('rewriting a row leaves the rest of the file, and the row, as it was', async ({ page }) => {
    await openMod(page, ddsQuotedStringsFixture);
    await loadBlock(page);

    const before = (await readFile(page, MOD_CSV)).split('\n');

    await blockText(page).fill('Rewritten over the quoted row');
    await blockText(page).blur();

    await expect.poll(() => readFile(page, MOD_CSV)).toContain('Rewritten over the quoted row');
    const after = (await readFile(page, MOD_CSV)).split('\n');

    // A column this app has no view on. Rewriting the whole row blanked it.
    expect(after[1]).toContain('KEEP-ME');

    // Untouched rows are untouched -- including one whose quotes are what keep its
    // comma from being a column boundary.
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after).toHaveLength(before.length);
});

test('a line that cannot be stored says so and puts the value back', async ({ page }) => {
    await seedFs(page, ddsFixtureWithContent);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await loadBlock(page);

    // No mod is selected, so there is nowhere to write the line to. The write happens
    // inside a jsonTree callback that does not await it, so this used to fail as an
    // unhandled rejection: nothing written, the typed text still sitting there looking
    // stored, and nothing said.
    await blockText(page).fill('Nowhere to put this');
    await blockText(page).blur();

    expect(await alerts(page)).toContain('Please select a mod to save in first');
    await expect(blockText(page)).toHaveValue(BLOCK_TEXT);
});

test('closing puts the window away, and choosing another mod does it for you', async ({ page }) => {
    // Two mods, so there is somewhere else to go.
    await openMod(page, { ...ddsFixtureWithContent, ...ddsBareFixture });
    await openStrings(page, 'dds.blocks');

    await page.locator('#strings-window').getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#strings-window')).toHaveCount(0);

    await openStrings(page, 'dds.blocks');

    // A path below one mod's content folder means nothing under another's, and saving
    // after the switch would write into the wrong one.
    await selectContent(page, 'BareMod', 'Content');
    await expect(page.locator('#strings-window')).toHaveCount(0);
});
