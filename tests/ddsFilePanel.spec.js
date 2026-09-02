import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, selectContent, gotoFlow, alerts, openDdsDocument,
    confirms, queueConfirms, listDir, readFile,
} from '../test-support/harness.js';
import {
    ddsFixtureWithContent, ddsLinkedContent, TREE_GUID, MSG_GUID,
    MOD_TREE_GUID, MOD_MSG_GUID, MOD_BLOCK_GUID,
} from '../test-support/fixtures.js';

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
    await expect(section(page, 'strings').locator('.file-panel-open')).toHaveText([
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
    // A mod's own block, which is in no reference data: the panel knows what it is,
    // and opening it as anything else would read from the wrong folder.
    await expect(page.locator('#file-window-0'))
        .toHaveAttribute('path', 'DDS/Blocks/cccccccc-3333-4333-8333-333333333333.block');
});

test('a strings file opens as text, not as a document', async ({ page }) => {
    await openMod(page);

    await section(page, 'strings').getByRole('button', { name: 'dds.blocks' }).click();

    // Its own window: a CSV is not a level of the tree -> message -> block drill-down,
    // and nothing here is mistaken for a GUID and complained about.
    await expect(page.locator('#strings-window')).toContainText('Strings: dds.blocks.csv');
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

    // The patched tree in the fixture is already listed; open an unpatched one. The
    // type comes with it: this GUID is the fixture's, so nothing can look it up.
    await openDdsDocument(page, MSG_GUID, 'message');
    await expect(page.locator('#file-window-0')).toContainText('TestMessage');

    await expect(section(page, 'messages').locator(`.file-panel-entry[data-id="${MSG_GUID}"]`)).toHaveCount(0);

    await page.locator('#file-window-0').getByRole('button', { name: 'Save' }).click();

    // Saving base game content writes a patch, which is now part of the mod.
    const patched = section(page, 'messages').locator(`.file-panel-entry[data-id="${MSG_GUID}"]`);
    await expect(patched).toHaveAttribute('data-kind', 'patch');
    await expect(section(page, 'messages').locator('summary')).toHaveText('Messages (2)');
});


/**
 * Deleting a file from the mod.
 *
 * DDS content nests -- a tree holds messages, a message holds blocks, a block resolves to
 * a row of text -- and every one of those links is a GUID buried inside another file. None
 * of it is visible from the panel, so what is pinned here is that the app goes and reads
 * it before the file is gone rather than after.
 */

const deleteButton = (page, id, entry) =>
    section(page, id).locator(`.file-panel-entry[data-id="${entry}"] .file-panel-danger`);

/**
 * The box the app put up. Waited for rather than read: a click returns once the event is
 * dispatched, and the question is built by reading every file in the folder first.
 */
async function lastConfirm(page) {
    await expect.poll(async () => (await confirms(page)).length).toBeGreaterThan(0);
    return (await confirms(page)).at(-1);
}

async function openLinkedMod(page) {
    await seedFs(page, ddsLinkedContent);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestMod', 'Content');
}

test('every entry offers a delete button, strings included', async ({ page }) => {
    await openMod(page);

    // The panel lists this mod's own DDSContent and nothing else, so all of it is the
    // author's: two trees, a message, a block, and three CSVs.
    await expect(page.locator('#dds-file-list .file-panel-danger')).toHaveCount(7);
});

test('deleting a message names the tree that holds it', async ({ page }) => {
    await openLinkedMod(page);

    await deleteButton(page, 'messages', MOD_MSG_GUID).click();

    const asked = await lastConfirm(page);

    // By its name, which is what the panel shows -- a GUID identifies the file and tells
    // an author nothing about which one it is.
    expect(asked).toContain('Delete "ModMessage" from this mod?');
    expect(asked).toContain('Referenced by 1 file:');
    expect(asked).toContain('ModTree');
});

test('deleting a block names the message and the file its text is in', async ({ page }) => {
    await openLinkedMod(page);

    await deleteButton(page, 'blocks', MOD_BLOCK_GUID).click();

    const asked = await lastConfirm(page);

    expect(asked).toContain('Referenced by 2 files:');
    expect(asked).toContain('ModMessage');
    // A block's English line is a CSV row keyed by its GUID, which is the leftover an
    // author would otherwise never think to go and clear up.
    expect(asked).toContain('Strings/English/DDS/dds.blocks.csv');
});

test('a document nothing holds says so', async ({ page }) => {
    await openMod(page);

    // In the unwired fixture the tree's message list is empty, so nothing points at it.
    await deleteButton(page, 'messages', MOD_MSG_GUID).click();

    expect(await lastConfirm(page)).toContain('Nothing else in this mod refers to it.');
});

test('confirming removes the file and takes it out of the panel', async ({ page }) => {
    await openLinkedMod(page);

    await deleteButton(page, 'messages', MOD_MSG_GUID).click();

    await expect(section(page, 'messages').locator('summary')).toHaveText('Messages (0)');
    expect(await listDir(page, 'Mods/TestMod/Content/DDSContent/DDS/Messages'))
        .not.toContain(`${MOD_MSG_GUID}.msg`);

    // Listed and nothing more: the tree still names it, for its author to deal with.
    const tree = JSON.parse(await readFile(
        page, `Mods/TestMod/Content/DDSContent/DDS/Trees/${MOD_TREE_GUID}.tree`));
    expect(tree.messages[0].msgID).toBe(MOD_MSG_GUID);
});

test('saying no changes nothing at all', async ({ page }) => {
    await openLinkedMod(page);
    await queueConfirms(page, [false]);

    await deleteButton(page, 'messages', MOD_MSG_GUID).click();

    expect(await lastConfirm(page)).toContain('Delete "ModMessage"');
    await expect(section(page, 'messages').locator('summary')).toHaveText('Messages (1)');
    expect(await listDir(page, 'Mods/TestMod/Content/DDSContent/DDS/Messages'))
        .toContain(`${MOD_MSG_GUID}.msg`);
});

test('deleting a patch removes the patch and leaves the base game file alone', async ({ page }) => {
    await openMod(page);

    // Which is how a mod stops overriding a piece of base game content. The patch and a
    // mod's own document differ only by extension, so the delete has to remove the one
    // the entry actually stands for.
    await deleteButton(page, 'trees', TREE_GUID).click();

    await expect(section(page, 'trees').locator('summary')).toHaveText('Trees (1)');
    expect(await listDir(page, 'Mods/TestMod/Content/DDSContent/DDS/Trees'))
        .not.toContain(`${TREE_GUID}.tree_patch`);

    // The tree it was written against is the game's, and was never this mod's to touch.
    expect(JSON.parse(await readFile(page, `StreamingAssets/DDS/Trees/${TREE_GUID}.tree`)).name)
        .toBe('TestTree');
});

test('deleting a strings file removes it', async ({ page }) => {
    await openMod(page);

    await deleteButton(page, 'strings', 'Strings/English/names.rooms.csv').click();

    // Room names are keyed by preset name rather than by GUID, so no document in the mod
    // loses a line by this going.
    expect(await lastConfirm(page)).toContain('Delete "names.rooms" from this mod?');
    await expect(section(page, 'strings').locator('summary')).toHaveText('Strings (2)');
    expect(await listDir(page, 'Mods/TestMod/Content/DDSContent/Strings/English'))
        .not.toContain('names.rooms.csv');
});

test('deleting a block text file names the blocks that lose their line', async ({ page }) => {
    await openMod(page);

    // Nothing points at a CSV by name -- the only thing that could is the manifest entry
    // placing it, and that goes with the file. What breaks is on the other side of the
    // link: this file holds the English text of the mod's own block, keyed by its GUID,
    // and deleting it silently leaves that block with nothing to say.
    await deleteButton(page, 'strings', 'Strings/English/DDS/dds.blocks.csv').click();

    const asked = await lastConfirm(page);
    expect(asked).toContain('Referenced by 1 file:');
    expect(asked).toContain('ModBlock');
});

test('the window showing a deleted document is closed with it', async ({ page }) => {
    await openLinkedMod(page);

    await section(page, 'messages').getByRole('button', { name: 'ModMessage' }).click();
    await expect(page.locator('#file-window-0')).toContainText('ModMessage');

    await deleteButton(page, 'messages', MOD_MSG_GUID).click();

    // A window left open over a deleted file is one save away from writing it back out,
    // with nothing to say that had happened.
    await expect(page.locator('#file-window-0')).toHaveCount(0);
});
