import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, selectContent, readFile, listDir, alerts,
    collectPageErrors, gotoFlow, fieldInput, openDdsDocument,
} from '../test-support/harness.js';
import {
    ddsFixtureWithContent, ddsBareFixture, ddsManifestFixture, ddsManifestMissingFileFixture,
    ddsManifestBlocksDeclaredFixture, ddsQuotedStringsFixture,
    FLAT_MOD, TREE_GUID, BLOCK_GUID, BLOCK_TEXT,
} from '../test-support/fixtures.js';

/**
 * A mod's strings CSV, edited as the list of strings it is.
 *
 * The app used to write these a row at a time and only ever through a block's English
 * line, so a file it had not written -- room names, job titles -- or a row that was
 * already wrong could not be touched at all. These pin that every row is editable, that
 * the columns the app has no view on survive the trip, and that the text the app caches
 * from these files keeps up.
 */

const FLAT = 'Mods/FlatMod/plugins/BookcaseOffice/DDSContent';
const MOD_CSV = 'Mods/TestMod/Content/DDSContent/Strings/English/DDS/dds.blocks.csv';
const ROOMS_CSV = 'Mods/TestMod/Content/DDSContent/Strings/English/names.rooms.csv';

const section = (page, id) => page.locator(`.file-panel-category[data-category="${id}"]`);

/** The editable rows, headers excluded -- those are not strings and are not listed. */
const rows = (page) => page.locator('#strings-window tbody.strings-rows tr');

/** The base game's rows, listed under the mod's own and never edited here. */
const vanillaRows = (page) => page.locator('#strings-window .strings-vanilla-row');
const vanillaHeading = (page) => page.locator('#strings-window .strings-vanilla-heading');

const showVanilla = (page) =>
    page.locator('#strings-window').getByRole('button', { name: /vanilla/ }).click();
const row = (page, index) => rows(page).nth(index);
const keyBox = (page, index) => row(page, index).getByLabel('Key');
const textBox = (page, index) => row(page, index).getByLabel('Text');

/** The block's English line, resolved from a CSV rather than held in the document. */
const blockText = (page) => fieldInput(page, '#file-window-2', '_ENG Localisation_');

/** Every row as the pair this app has a view on. */
const listed = async (page) => {
    const count = await rows(page).count();
    const pairs = [];

    for (let index = 0; index < count; index++) {
        pairs.push([await keyBox(page, index).inputValue(), await textBox(page, index).inputValue()]);
    }

    return pairs;
};

async function openMod(page, fixture = ddsFixtureWithContent, mod = 'TestMod', content = 'Content') {
    await seedFs(page, fixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, mod, content);
}

/** Load the vanilla tree, which cascades down to a block with text of its own. */
async function loadBlock(page) {
    await openDdsDocument(page, TREE_GUID);
    await page.locator('#file-window-2 .jsontree_child-nodes').first().waitFor();
}

/** Not an exact match: a mapped file's button carries its tag as well as its name. */
async function openStrings(page, name) {
    await section(page, 'strings').getByRole('button', { name }).click();
    await page.locator('#strings-window .strings-table').waitFor();
}

/** Type into a box and leave it, which is what autosave writes on. */
async function type(box, text) {
    await box.fill(text);
    await box.blur();
}

/** Add a row the way an author would: the button, then the two boxes. */
async function addRow(page, key, text) {
    await page.locator('#strings-window .strings-add').click();

    const index = (await rows(page).count()) - 1;
    await keyBox(page, index).fill(key);
    await type(textBox(page, index), text);
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
});

test('shows the file as a row of key and text per string', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openMod(page);
    await openStrings(page, 'dds.blocks');

    expect(await listed(page)).toEqual([
        ['cccccccc-3333-4333-8333-333333333333', 'Text for the mod block'],
        ['dddddddd-4444-4444-8444-444444444444', 'A replacement string'],
    ]);

    // The three header lines are not strings, so they are not offered as ones to edit.
    // They are still in the file, and the window says so rather than hiding them.
    await expect(page.locator('#strings-window .strings-headers'))
        .toHaveText('3 header lines at the top of this file, kept as they are.');

    await expect(page.locator('#strings-window')).toContainText('Strings/English/DDS/dds.blocks.csv');
    expect(await alerts(page)).toEqual([]);
    expect(errors).toEqual([]);
});

test('reads a row quoted the way the game writes them, quotes and all off', async ({ page }) => {
    await openMod(page, ddsQuotedStringsFixture);
    await openStrings(page, 'dds.blocks');

    // The quotes are the format's, not the author's: what is in the box is the string
    // a player reads. The second row's quotes are what keep its comma from being a
    // column boundary, and it is still one string rather than two.
    expect(await listed(page)).toEqual([
        [BLOCK_GUID, 'An existing quoted line'],
        ['dddddddd-4444-4444-8444-444444444444', 'Wait, listen to me'],
    ]);
});

test('the list fills the window rather than the window fitting the list', async ({ page }) => {
    await openMod(page);
    await openStrings(page, 'dds.blocks');

    const box = await page.locator('#strings-window').boundingBox();
    const list = await page.locator('#strings-window .strings-scroll').boundingBox();

    // A CSV is as long as it is: a box that grew with it would push the controls off
    // the bottom of the screen, and one sized to a default would waste the window.
    expect(list.height).toBeGreaterThan(box.height / 2);
    expect(list.y + list.height).toBeLessThanOrEqual(box.y + box.height);
    expect(list.width).toBeGreaterThan(400);

    // Adding a row must not push the button that adds them off the bottom.
    const add = await page.locator('#strings-window .strings-add').boundingBox();
    expect(add.y + add.height).toBeLessThanOrEqual(box.y + box.height + 1);
});

test('editing a row writes it back quoted, and leaves the rest of the file alone', async ({ page }) => {
    await openMod(page);
    await openStrings(page, 'names.rooms');

    await type(textBox(page, 0), 'A renamed room');

    // Quoted the way the game writes them, and stamped, because this row was edited.
    await expect.poll(() => readFile(page, ROOMS_CSV))
        .toMatch(/^"ModRoom",,"A renamed room",,,,\d\d:\d\d \d\d\/\d\d\/\d{4}$/);
});

test('a row can be added and a row can be dropped', async ({ page }) => {
    await openMod(page);
    await openStrings(page, 'names.rooms');

    await addRow(page, 'AnotherRoom', 'Added by hand');
    await expect(rows(page)).toHaveCount(2);

    await expect.poll(() => readFile(page, ROOMS_CSV)).toContain('"AnotherRoom",,"Added by hand"');

    // Named by what it removes: there is one of these per row.
    await page.locator('#strings-window').getByRole('button', { name: 'Remove ModRoom' }).click();
    await expect(rows(page)).toHaveCount(1);

    await expect.poll(() => readFile(page, ROOMS_CSV)).not.toContain('ModRoom');
});

test('an added row nobody typed in is not a line in the file', async ({ page }) => {
    await openMod(page);
    await openStrings(page, 'names.rooms');

    await page.locator('#strings-window .strings-add').click();
    await keyBox(page, 1).blur();
    await expect(rows(page)).toHaveCount(2);

    // `"",,"",,,,` is a line the game reads as nothing named by nothing. The row is on
    // screen waiting to be typed in; that is all it is.
    await page.locator('#strings-window').getByRole('button', { name: 'Save' }).click();

    // The row it already had, requoted -- and no second line. Its timestamp is intact
    // too: requoting is not editing, so nothing here counts as a change.
    await expect.poll(() => readFile(page, ROOMS_CSV))
        .toBe('"ModRoom",,"A mod room name",,,,09:00 01/01/2024');
});

test('typing on through a row does not lose what was typed after the write began', async ({ page }) => {
    await openMod(page);
    await openStrings(page, 'names.rooms');

    await page.locator('#strings-window .strings-add').click();

    // A row is two boxes, so filling one and moving to the other blurs the first: with
    // autosave on, a write is already in flight while the rest of the row is being
    // typed. That write used to mark the row saved on the way out, which threw away the
    // flag the text had just set -- so the key reached disk and the text never did.
    await keyBox(page, 1).fill('AnotherRoom');
    await keyBox(page, 1).press('Tab');
    await type(textBox(page, 1), 'Typed after the write started');

    await expect.poll(() => readFile(page, ROOMS_CSV))
        .toContain('"AnotherRoom",,"Typed after the write started"');
    await expect(page.locator('#strings-window')).not.toHaveAttribute('data-dirty', '');
});

test('the columns this app has no view on come back out of the row', async ({ page }) => {
    await openMod(page, ddsQuotedStringsFixture);
    await openStrings(page, 'dds.blocks');

    await type(textBox(page, 0), 'Edited in the list');

    await expect.poll(() => readFile(page, MOD_CSV)).toContain('Edited in the list');
    const after = (await readFile(page, MOD_CSV)).split('\n');

    // A column this app has no meaning for, in the row it edited. Rewriting the whole
    // row would blank it.
    expect(after[1]).toContain('KEEP-ME');
    // And the header line above it, which is not a string and was never in the list.
    expect(after[0]).toBe('"HEADER 1",,,,,,');
});

test('saving stamps the rows that changed and only those', async ({ page }) => {
    await openMod(page);
    await openStrings(page, 'dds.blocks');

    await type(textBox(page, 0), 'Edited just now');

    await expect.poll(() => readFile(page, MOD_CSV)).toContain('Edited just now');
    const after = (await readFile(page, MOD_CSV)).split('\n');

    // The one piece of history these files keep. Stamping every row on every save
    // would throw it away over a save that changed nothing.
    expect(after[3]).not.toContain('09:00 01/01/2024');
    expect(after[3]).toMatch(/,\d\d:\d\d \d\d\/\d\d\/\d{4}$/);
    expect(after[4]).toContain('09:00 01/01/2024');
});

test('a duplicate key and a line with no key are called out', async ({ page }) => {
    await openMod(page);
    await openStrings(page, 'dds.blocks');

    await type(keyBox(page, 1), 'cccccccc-3333-4333-8333-333333333333');

    // Two rows for one key is a file whose meaning depends on which the loader reaches
    // first, so both rows say so -- neither is the wrong one.
    await expect(row(page, 0).locator('.strings-issue')).toHaveText(/Duplicate key/);
    await expect(row(page, 1).locator('.strings-issue')).toHaveText(/Duplicate key/);
    await expect(keyBox(page, 1)).toHaveAttribute('aria-invalid', 'true');

    await type(keyBox(page, 1), '');
    await expect(row(page, 0).locator('.strings-issue')).toBeHidden();
    // Text with nothing to look it up by. Written, because it is the author's file --
    // but not silently.
    await expect(row(page, 1).locator('.strings-issue')).toHaveText(/No key/);
});

test('nothing is flagged about a key that is not a GUID', async ({ page }) => {
    await openMod(page);
    // Room names are keyed by name. A key that is not a GUID is not a mistake here.
    await openStrings(page, 'names.rooms');

    await expect(row(page, 0).locator('.strings-issue')).toBeHidden();
    await expect(keyBox(page, 0)).not.toHaveAttribute('aria-invalid');
});

test('the base game\'s rows can be read under the mod\'s own', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openMod(page);
    await openStrings(page, 'dds.blocks');

    // Off until asked for: what an author opens this file to do is edit their own rows.
    await expect(vanillaRows(page)).toHaveCount(0);

    await showVanilla(page);

    await expect(vanillaHeading(page)).toHaveText('Base game — 1 string, read only.');
    expect(await vanillaRows(page).first().locator('td').allInnerTexts())
        // The key, the text, and the cell the mod's rows keep their remove button in.
        .toEqual([BLOCK_GUID, BLOCK_TEXT, '']);

    // Under the mod's rows, which are still the only ones that can be typed in.
    const modded = await row(page, 1).boundingBox();
    const vanilla = await vanillaRows(page).first().boundingBox();
    expect(vanilla.y).toBeGreaterThan(modded.y);

    expect(await listed(page)).toEqual([
        ['cccccccc-3333-4333-8333-333333333333', 'Text for the mod block'],
        ['dddddddd-4444-4444-8444-444444444444', 'A replacement string'],
    ]);

    // Read only: no box to type in and no button to drop the row.
    await expect(vanillaRows(page).locator('input')).toHaveCount(0);
    await expect(vanillaRows(page).locator('button')).toHaveCount(0);

    await page.locator('#strings-window').getByRole('button', { name: 'Hide vanilla' }).click();
    await expect(vanillaRows(page)).toHaveCount(0);
    await expect(vanillaHeading(page)).toHaveCount(0);

    expect(errors).toEqual([]);
});

test('a file the base game has no counterpart for says so', async ({ page }) => {
    await openMod(page);
    await openStrings(page, 'dds.blocks');
    await showVanilla(page);
    await expect(vanillaRows(page)).toHaveCount(1);

    // The switch is how these files are read, not something about the one that is open,
    // so it carries to the next one -- which the base game names nothing in.
    await openStrings(page, 'names.rooms');

    await expect(vanillaHeading(page))
        .toHaveText('The base game has no Strings/English/names.rooms.csv.');
    await expect(vanillaRows(page)).toHaveCount(0);
});

test('the base game file is found through the manifest, not by where the mod keeps its own', async ({ page }) => {
    await openMod(page, ddsManifestFixture, FLAT_MOD.mod, FLAT_MOD.content);

    // DDSContent/dds.blocks.csv, which stands in for the game's Strings/English/DDS copy
    // only because the manifest says that is where the loader reads it from.
    await openStrings(page, 'dds.blocks');
    await showVanilla(page);

    await expect(vanillaHeading(page)).toHaveText('Base game — 1 string, read only.');
    await expect(vanillaRows(page).first()).toContainText(BLOCK_TEXT);
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
    await addRow(page, BLOCK_GUID, 'Given to the block by hand');

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

    await type(textBox(page, 0), 'A renamed evidence name');

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
    await addRow(page, BLOCK_GUID, 'Rewritten in the flat mod');

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
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator('#strings-window .strings-headers')).toBeHidden();

    // Written the first time there is something to put in it, as everything else in
    // this flow is.
    expect(await readFile(page, `${FLAT}/names.rooms.csv`)).toBeNull();
    await addRow(page, 'FlatRoom', 'The first room this mod names');

    await expect.poll(() => readFile(page, `${FLAT}/names.rooms.csv`))
        .toMatch(/^"FlatRoom",,"The first room this mod names",,,,\d\d:\d\d/);
});

test('with autosave off, only Save writes', async ({ page }) => {
    await openMod(page);
    await openStrings(page, 'names.rooms');

    await page.locator('#autosave-switch').uncheck();

    const before = await readFile(page, ROOMS_CSV);
    await type(textBox(page, 0), 'Typed with autosave off');

    // Leaving the box is not a decision to write, any more than it is in a tree.
    expect(await readFile(page, ROOMS_CSV)).toBe(before);
    await expect(page.locator('#strings-window')).toHaveAttribute('data-dirty', '');

    await page.locator('#strings-window').getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => readFile(page, ROOMS_CSV)).toContain('"Typed with autosave off"');
    await expect(page.locator('#strings-window')).not.toHaveAttribute('data-dirty', '');
});

test('with autosave off, dropping a row waits for Save too', async ({ page }) => {
    await openMod(page);
    await openStrings(page, 'names.rooms');

    await page.locator('#autosave-switch').uncheck();
    const before = await readFile(page, ROOMS_CSV);

    await page.locator('#strings-window').getByRole('button', { name: 'Remove ModRoom' }).click();

    // Removing a row is a decision, but it is the same kind of decision as retyping
    // one, and the switch is what says whether a decision reaches disk on its own.
    await expect(rows(page)).toHaveCount(0);
    expect(await readFile(page, ROOMS_CSV)).toBe(before);

    await page.locator('#strings-window').getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => readFile(page, ROOMS_CSV)).toBe('');
});

test('an open file shows a row written from a block', async ({ page }) => {
    await openMod(page);
    await loadBlock(page);
    await openStrings(page, 'dds.blocks');

    // Editing a block's English line writes a row straight to disk, so the window is
    // otherwise left looking at what the file was a moment ago.
    await blockText(page).fill('Sent from the block');
    await blockText(page).blur();

    await expect.poll(() => listed(page))
        .toContainEqual([BLOCK_GUID, 'Sent from the block']);
});

test('a file the block edit creates is shown in the window already open on it', async ({ page }) => {
    await openMod(page, ddsManifestBlocksDeclaredFixture, FLAT_MOD.mod, FLAT_MOD.content);

    // Declared, never written: there is no file for the window to be holding.
    await page.locator('#dds-manifest-panel').getByRole('button', { name: 'dds.blocks.csv' }).click();
    await expect(rows(page)).toHaveCount(0);

    await loadBlock(page);
    await blockText(page).fill('The first line this mod has');
    await blockText(page).blur();

    // A file that does not exist cannot be identified by handle, so this is the one
    // case that rests on both sides naming it the same way -- which they do, because
    // both take the name from the manifest.
    await expect.poll(() => listed(page))
        .toContainEqual([BLOCK_GUID, 'The first line this mod has']);
});

test('a row written from a block does not overwrite unsaved rows', async ({ page }) => {
    await openMod(page);
    await loadBlock(page);
    await openStrings(page, 'dds.blocks');

    await page.locator('#autosave-switch').uncheck();
    await keyBox(page, 0).fill('Unsaved work in progress');

    await blockText(page).fill('Sent from the block');
    await blockText(page).blur();

    // Re-reading would throw away work that has not been written. The window says so
    // instead.
    await expect(keyBox(page, 0)).toHaveValue('Unsaved work in progress');
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

test('a line written from a block is quoted, as the strings editor writes them', async ({ page }) => {
    await openMod(page);
    await loadBlock(page);

    await blockText(page).fill('Sent from the block');
    await blockText(page).blur();

    // One shape per file, rather than a shape per writer: a file half quoted and half
    // not is one whose rows read differently depending on which part of the app last
    // touched them.
    await expect.poll(() => readFile(page, MOD_CSV))
        .toContain(`"${BLOCK_GUID}",,"Sent from the block"`);
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

test('two lines written at the same moment both land', async ({ page }) => {
    // Writing a row is read-modify-write on the whole file, so two at once used to lose
    // one: the second read missed the first row and the second write put the file back
    // without it. It took two hands to do until the + on an array stopped asking
    // questions -- now one click creates a message, the block under it and a row for
    // each, while the line just typed is still committing on blur.
    const errors = collectPageErrors(page);
    await openMod(page);

    await page.evaluate(async () => {
        const { writeStringsRow } = await import('/core/modStrings.js');
        const folder = window.selectedMod.baseFolder;
        const file = 'Strings/English/DDS/dds.blocks.csv';

        // Started together, deliberately: awaiting each in turn is the case that always
        // worked.
        await Promise.all([
            writeStringsRow(folder, file, 'at-once-one', 'The first line'),
            writeStringsRow(folder, file, 'at-once-two', 'The second line'),
            writeStringsRow(folder, file, 'at-once-three', 'The third line'),
        ]);
    });

    const csv = await readFile(page, MOD_CSV);
    expect(csv).toContain('The first line');
    expect(csv).toContain('The second line');
    expect(csv).toContain('The third line');

    // And nothing that was already there was written over.
    expect(csv).toContain('Text for the mod block');
    expect(errors).toEqual([]);
});
