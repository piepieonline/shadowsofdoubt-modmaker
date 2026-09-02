import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, selectContent, gotoFlow, alerts,
    readFile, listDir, addDdsContent,
} from '../test-support/harness.js';
import {
    ddsBareFixture, ddsManifestFixture, ddsManifestNoBlocksFixture, FLAT_MOD,
} from '../test-support/fixtures.js';

/**
 * Add new..., the one place this flow creates content.
 *
 * What kind of thing was a dropdown in the nav bar, three feet from the button that
 * read it, and the line a block says was a browser prompt raised after the document
 * had already been written. Both are questions asked before anything is created now,
 * so what is on screen is what will be made and cancelling makes nothing.
 */

const BARE = 'Mods/BareMod/Content/DDSContent';
const FLAT = 'Mods/FlatMod/plugins/BookcaseOffice/DDSContent';

const modal = (page) => page.locator('#new-dds-file-modal');
const section = (page, id) => page.locator(`.file-panel-category[data-category="${id}"]`);
const rows = (page) => page.locator('#strings-window tbody.strings-rows tr');

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
});

/** A mod with a content folder and nothing in it. */
async function openBareMod(page) {
    await seedFs(page, ddsBareFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'BareMod', 'Content');
}

test('the button opens the dialog rather than making anything', async ({ page }) => {
    await openBareMod(page);

    await expect(page.locator('#new-file-button')).toHaveText('Add new...');
    await page.locator('#new-file-button').click();

    await expect(modal(page)).toHaveAttribute('open', '');
    // Nothing on disk until the dialog is answered: what a tree needs is several
    // files, and asking afterwards left half of them written.
    expect(await listDir(page, `${BARE}/DDS`)).toBeNull();
});

test('closing the dialog leaves nothing behind', async ({ page }) => {
    await openBareMod(page);

    await page.locator('#new-file-button').click();
    await page.locator('#new-dds-file-modal [rel="prev"]').click();

    await expect(modal(page)).not.toHaveAttribute('open', '');
    expect(await listDir(page, `${BARE}/DDS`)).toBeNull();
    expect(await alerts(page)).toEqual([]);
});

test('a document is asked for a name, a strings file for which file', async ({ page }) => {
    await openBareMod(page);
    await page.locator('#new-file-button').click();

    const name = page.locator('#new-dds-file-name-field');
    const line = page.locator('#new-dds-file-line-field');
    const file = page.locator('#new-dds-file-strings-field');

    // A tree, a message and a block each end in a block with a line of text, so all
    // three are named and all three are asked what it says.
    for (const type of ['tree:0', 'message', 'block']) {
        await page.selectOption('#new-dds-file-type', type);
        await expect(name).toBeVisible();
        await expect(line).toBeVisible();
        await expect(file).toBeHidden();
    }

    // A strings file is not named: the game reads these from paths it decides.
    await page.selectOption('#new-dds-file-type', 'strings');
    await expect(name).toBeHidden();
    await expect(line).toBeHidden();
    await expect(file).toBeVisible();
});

test('a tree is offered as the six things the game does with one', async ({ page }) => {
    await openBareMod(page);
    await page.locator('#new-file-button').click();

    // "Tree" was one option, and the tree it made was a v-mail -- the template's own
    // treeType, and the wrong answer five times out of six. What the game has is six
    // formats sharing a struct, so that is what is asked for.
    const kinds = page.locator('#new-dds-file-tree-kinds option');
    await expect(kinds).toHaveText([
        'Conversation', 'V-mail', 'Document', 'Newspaper article', 'Message library',
        'Interaction dialog',
    ]);

    // The first of them is what the dialog opens on, with its line under the dropdown.
    await expect(page.locator('#new-dds-file-type')).toHaveValue('tree:0');
    await expect(page.locator('#new-dds-file-type-blurb'))
        .toHaveText('Two citizens talking out loud in the world');

    // A message, a block and a strings file have no kind, so nothing is said about them.
    await page.selectOption('#new-dds-file-type', 'message');
    await expect(page.locator('#new-dds-file-type-blurb')).toHaveText('');
});

test('a new tree is the kind that was asked for, and one the game will run', async ({ page }) => {
    await openBareMod(page);

    // Each kind's trigger point is the one the dispatching code looks for: a conversation
    // registered under vmail(3) is considered by nothing, and a newspaper left at
    // never(5) is filtered out of every article query. Both fail silently in game, which
    // is why they are checked on what lands on disk rather than on what is on screen.
    const kinds = [
        { kind: 0, name: 'Chat', treeType: 0, triggerPoint: 0 },
        { kind: 1, name: 'Mail', treeType: 1, triggerPoint: 3 },
        { kind: 2, name: 'Note', treeType: 2, triggerPoint: 0 },
        { kind: 3, name: 'Story', treeType: 3, triggerPoint: 6 },
        { kind: 4, name: 'Library', treeType: 4, triggerPoint: 5 },
        { kind: 5, name: 'Dialog', treeType: 5, triggerPoint: 7 },
    ];

    for (const { kind, name } of kinds) {
        await addDdsContent(page, { type: 'tree', kind, name, line: `${name} line` });
        await expect.poll(() => listDir(page, `${BARE}/DDS/Trees`)).toHaveLength(kind + 1);
    }

    const files = await listDir(page, `${BARE}/DDS/Trees`);
    const trees = Object.fromEntries(await Promise.all(files.map(async (file) => {
        const tree = JSON.parse(await readFile(page, `${BARE}/DDS/Trees/${file}`));
        return [tree.name, tree];
    })));

    for (const { name, treeType, triggerPoint } of kinds) {
        expect(trees[`BareMod-${name}`], name)
            .toMatchObject({ treeType, triggerPoint });
    }

    // And the values each kind needs beyond those two. A document with no background on
    // a 0x0 page opens blank; an interaction dialog at limitation 0 is added to nobody.
    expect(trees['BareMod-Chat'].participantA).toMatchObject({
        required: true, triggers: [0, 4],
    });
    expect(trees['BareMod-Note'].document)
        .toMatchObject({ background: 'Paper', fill: 1, size: { x: 342, y: 482 } });
    expect(trees['BareMod-Note'].messages[0].usePages).toBe(true);
    expect(trees['BareMod-Dialog'].interactionCitizenLimitation).toBe(20);

    expect(await alerts(page)).toEqual([]);
});

test('a document will not be created without a name', async ({ page }) => {
    await openBareMod(page);

    await page.locator('#new-file-button').click();
    await page.locator('#new-dds-file-submit').click();

    // Still open, and nothing written: a document named after the mod alone is one
    // more <Mod>- in a list of them.
    await expect(modal(page)).toHaveAttribute('open', '');
    expect(await listDir(page, `${BARE}/DDS`)).toBeNull();
});

test('a message names its own block, not the rung above it', async ({ page }) => {
    await openBareMod(page);

    await addDdsContent(page, {
        type: 'message', name: 'MonkierTheftGoneWrong', line: 'The Robbery Reaper',
    });

    await expect.poll(() => listDir(page, `${BARE}/DDS`)).toEqual(['Blocks', 'Messages']);

    const read = async (folder) => {
        const files = await listDir(page, `${BARE}/DDS/${folder}`);
        return JSON.parse(await readFile(page, `${BARE}/DDS/${folder}/${files[0]}`));
    };

    const [message, block] = [await read('Messages'), await read('Blocks')];

    expect(message.name).toBe('BareMod-MonkierTheftGoneWrong');
    expect(block.name).toBe('BareMod-MonkierTheftGoneWrong-Block');
    expect(message.blocks[0].blockID).toBe(block.id);

    await expect
        .poll(() => readFile(page, `${BARE}/Strings/English/DDS/dds.blocks.csv`))
        .toContain(`"${block.id}",,"The Robbery Reaper"`);
    expect(await alerts(page)).toEqual([]);
});

test('a strings file is created where the game reads it, and opened', async ({ page }) => {
    await openBareMod(page);

    await addDdsContent(page, { type: 'strings', strings: 'DDS/dds.blocks' });

    // Only the folders that file needs: a mod that has no DDS documents does not gain
    // DDS/Trees for having a CSV.
    await expect.poll(() => listDir(page, `${BARE}/Strings/English/DDS`))
        .toEqual(['dds.blocks.csv']);
    expect(await listDir(page, `${BARE}/DDS`)).toBeNull();

    // Open in its own window, with nothing in it yet, and listed in the panel.
    await expect(page.locator('#strings-window')).toContainText('Strings: dds.blocks.csv');
    await expect(rows(page)).toHaveCount(0);
    await expect(section(page, 'strings').getByRole('button', { name: 'dds.blocks' }))
        .toHaveCount(1);
    expect(await alerts(page)).toEqual([]);
});

test('a strings file the game reads elsewhere is created too', async ({ page }) => {
    await openBareMod(page);

    // DDS text is not all a mod's text: room names, job titles and evidence names sit
    // in files of their own, which nothing here could create before.
    await addDdsContent(page, { type: 'strings', strings: 'Evidence/evidence.names' });

    await expect.poll(() => listDir(page, `${BARE}/Strings/English/Evidence`))
        .toEqual(['evidence.names.csv']);
    await expect(page.locator('#strings-window')).toContainText('Strings: evidence.names.csv');
});

test('a strings file joins the ones a manifest mod already keeps', async ({ page }) => {
    await seedFs(page, ddsManifestNoBlocksFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, FLAT_MOD.mod, FLAT_MOD.content);

    // This mod keeps its CSVs flat and says where they are read from. A new one goes
    // beside them and is declared, rather than being written into a Strings tree the
    // mod does not use.
    await addDdsContent(page, { type: 'strings', strings: 'DDS/dds.blocks' });

    await expect.poll(() => listDir(page, FLAT))
        .toEqual(['DDS', 'dds.blocks.csv', 'ddsmanifest.json', 'jobs.csv']);
    expect(await listDir(page, `${FLAT}/Strings`)).toBeNull();

    await expect.poll(async () => JSON.parse(await readFile(page, `${FLAT}/ddsmanifest.json`)))
        .toEqual({
            enabled: true,
            files: {
                'jobs.csv': 'Strings/English/Citizens',
                'dds.blocks.csv': 'Strings/English/DDS',
            },
        });

    // Named by where the game reads it from, which is not where it is.
    await expect(page.locator('#strings-window'))
        .toContainText('Strings/English/DDS/dds.blocks.csv (really dds.blocks.csv)');
    expect(await alerts(page)).toEqual([]);
});

test('adding a strings file the mod already has opens it, keeping its rows', async ({ page }) => {
    await seedFs(page, ddsManifestFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, FLAT_MOD.mod, FLAT_MOD.content);

    const before = await readFile(page, `${FLAT}/dds.blocks.csv`);
    await addDdsContent(page, { type: 'strings', strings: 'DDS/dds.blocks' });

    // The file is found through the manifest, so "new" here is the file the mod
    // already has -- which is opened as it is. Writing an empty one over it would
    // throw away every line of text in the mod.
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first().getByLabel('Text')).toHaveValue('Text from the flat mod');
    // Opening is not editing: nothing is written until something is changed, so not
    // even the requoting a save would do has happened here.
    expect(await readFile(page, `${FLAT}/dds.blocks.csv`)).toBe(before);
    expect(await alerts(page)).toEqual([]);
});
