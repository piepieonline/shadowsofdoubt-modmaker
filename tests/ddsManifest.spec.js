import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, connectFolders, selectContent, readFile, listDir, alerts, collectPageErrors, gotoFlow, fieldInput, openDdsDocument, addDdsContent } from '../test-support/harness.js';
import {
    ddsManifestFixture, ddsManifestNoBlocksFixture, ddsManifestMixedFixture,
    ddsManifestBrokenFixture, ddsBareFixture, ddsFixture,
    FLAT_MOD, TREE_GUID, BLOCK_GUID,
} from '../test-support/fixtures.js';

/**
 * A mod whose ddsmanifest gives its files the paths the game reads them from.
 *
 * Such a mod keeps its CSVs flat, so every path the app builds from the game's folder
 * tree misses them: block text reads as missing, the panel lists nothing, and an edit
 * would write a file the game never loads. These pin that the app follows the manifest
 * instead -- and, just as importantly, that it does not force the layout back on a mod
 * that chose not to have it.
 */

const FLAT = 'Mods/FlatMod/plugins/BookcaseOffice/DDSContent';

const section = (page, id) => page.locator(`.file-panel-category[data-category="${id}"]`);

async function openFlatMod(page, fixture = ddsManifestFixture) {
    await seedFs(page, fixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, FLAT_MOD.mod, FLAT_MOD.content);
}

/** Load the vanilla tree, which cascades down to the block the mod has text for. */
async function loadBlock(page) {
    await openDdsDocument(page, TREE_GUID);
    await page.locator('#file-window-2 .jsontree_child-nodes').first().waitFor();
}

/** The block's English line, rendered as the editor for its value. */
const blockText = (page) => fieldInput(page, '#file-window-2', '_ENG Localisation_');

/** Rewrite the block's English line, which is what sends text to a strings CSV. */
async function editBlockText(page, text) {
    await blockText(page).fill(text);
    await blockText(page).blur();
}

const manifestFiles = async (page) =>
    JSON.parse(await readFile(page, `${FLAT}/ddsmanifest.json`)).files;

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
});

test('block text is read through the manifest', async ({ page }) => {
    await openFlatMod(page);
    await loadBlock(page);

    // The mod's own text, found at DDSContent/dds.blocks.csv because the manifest says
    // that is where Strings/English/DDS/dds.blocks.csv lives.
    await expect(blockText(page)).toHaveValue('Text from the flat mod');
    await expect(blockText(page)).not.toHaveValue(/MISSING GUID/);
});

test('selecting a manifest mod creates no strings folders inside it', async ({ page }) => {
    await openFlatMod(page);
    await expect(section(page, 'strings').locator('.file-panel-entry').first()).toBeVisible();

    // The whole point of a flat mod. Merely looking at one used to plant the layout it
    // exists to avoid.
    expect(await listDir(page, `${FLAT}/Strings`)).toBeNull();
});

test('a mod with nothing scaffolded gets its layout only as it is written', async ({ page }) => {
    await seedFs(page, ddsBareFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'BareMod', 'Content');

    // Nothing at all until there is something to put in it. (The fixture's .keep is
    // only there to make the empty folder something OPFS can hold.)
    expect(await listDir(page, 'Mods/BareMod/Content/DDSContent')).toEqual(['.keep']);

    // A new block carries an English line, which is what reaches a strings file.
    await addDdsContent(page, {
        type: 'block', name: 'FirstBlock', line: 'The first line this mod has',
    });

    // The mod has no manifest, so both go where the game reads them from.
    await expect.poll(() => listDir(page, 'Mods/BareMod/Content/DDSContent'))
        .toEqual(['.keep', 'DDS', 'Strings']);
    await expect
        .poll(() => readFile(page, 'Mods/BareMod/Content/DDSContent/Strings/English/DDS/dds.blocks.csv'))
        .toContain('The first line this mod has');

    // Only the folder the block itself needed.
    expect(await listDir(page, 'Mods/BareMod/Content/DDSContent/DDS')).toEqual(['Blocks']);
});

test('lists a mapped CSV once, by the path the game reads it from', async ({ page }) => {
    await openFlatMod(page);

    // Once per file on disk, never once per mapping as well. In the order the game
    // sees them: Citizens before DDS.
    await expect(section(page, 'strings').locator('.file-panel-name'))
        .toHaveText(['jobs', 'dds.blocks']);

    const jobs = section(page, 'strings').locator('.file-panel-entry[data-id="jobs.csv"]');
    await expect(jobs).toHaveAttribute('data-kind', 'mapped');
    await expect(jobs.locator('.file-panel-name'))
        .toHaveAttribute('title', 'Strings/English/Citizens/jobs.csv (really jobs.csv)');
});

test('editing block text writes to the mapped CSV', async ({ page }) => {
    await openFlatMod(page);
    await loadBlock(page);

    await editBlockText(page, 'Rewritten by test');

    await expect.poll(() => readFile(page, `${FLAT}/dds.blocks.csv`)).toContain('Rewritten by test');

    // Not into the folder the game reads it from, which the mod does not have.
    expect(await listDir(page, `${FLAT}/Strings`)).toBeNull();
    expect(await alerts(page)).toEqual([]);
});

test('a mod that keeps its CSVs together gets its new one there, and says so', async ({ page }) => {
    await openFlatMod(page, ddsManifestNoBlocksFixture);
    await loadBlock(page);

    // Nothing maps dds.blocks.csv yet, but every entry this mod has agrees on the
    // content root, so that is where the file joins them.
    await editBlockText(page, 'First line of block text');

    await expect.poll(() => readFile(page, `${FLAT}/dds.blocks.csv`)).toContain('First line of block text');
    expect(await listDir(page, `${FLAT}/Strings`)).toBeNull();

    // Written there, it is invisible to the loader without an entry to declare it.
    await expect.poll(() => manifestFiles(page)).toEqual({
        'jobs.csv': 'Strings/English/Citizens',
        'dds.blocks.csv': 'Strings/English/DDS',
    });
});

test('a mod whose entries disagree gets the plain layout and no new entry', async ({ page }) => {
    await openFlatMod(page, ddsManifestMixedFixture);
    await loadBlock(page);

    await editBlockText(page, 'Text with nowhere obvious to go');

    // csv/ and other/ give no convention to follow, so the file goes where the game
    // reads it from and the manifest is left as its author wrote it.
    await expect.poll(() => readFile(page, `${FLAT}/Strings/English/DDS/dds.blocks.csv`))
        .toContain('Text with nowhere obvious to go');
    expect(await manifestFiles(page)).toEqual({
        'csv/jobs.csv': 'Strings/English/Citizens',
        'other/names.rooms.csv': 'Strings/English',
    });
});

test('a mod with no manifest never gains one', async ({ page }) => {
    await seedFs(page, ddsFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestMod', 'Content');
    await loadBlock(page);

    await editBlockText(page, 'Ordinary mod, ordinary layout');

    const csv = 'Mods/TestMod/Content/DDSContent/Strings/English/DDS/dds.blocks.csv';
    await expect.poll(() => readFile(page, csv)).toContain('Ordinary mod, ordinary layout');
    expect(await readFile(page, 'Mods/TestMod/Content/DDSContent/ddsmanifest.json')).toBeNull();
});

test('a manifest that cannot be parsed is never written to', async ({ page }) => {
    await openFlatMod(page, ddsManifestBrokenFixture);
    await loadBlock(page);

    await editBlockText(page, 'Text beside a broken manifest');

    // The layout falls back to what the game reads, and the file its author still has
    // to fix is left exactly as it was.
    await expect.poll(() => readFile(page, `${FLAT}/Strings/English/DDS/dds.blocks.csv`))
        .toContain('Text beside a broken manifest');
    expect(await readFile(page, `${FLAT}/ddsmanifest.json`)).toBe('{ "enabled": true, "files"');
});

test('a manifest that cannot be parsed leaves the mod editable', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openFlatMod(page, ddsManifestBrokenFixture);

    // Nothing resolves through it, so the mod behaves as if it had no manifest: the
    // files are listed where they physically are, and nothing interrupts the user.
    await expect(section(page, 'strings').locator('.file-panel-name'))
        .toHaveText(['dds.blocks', 'jobs']);
    await expect(section(page, 'strings').locator('.file-panel-entry[data-kind]')).toHaveCount(0);

    expect(await alerts(page)).toEqual([]);
    expect(errors.filter((e) => !e.includes(BLOCK_GUID))).toEqual([]);
});
