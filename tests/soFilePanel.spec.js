import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, selectContent, gotoFlow, confirms, queueConfirms,
    listDir, readFile,
} from './support/harness.js';
import { soFolderContent, caseWithCustomReference } from './support/fixtures.js';

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

test('an entry is labelled with the asset and opens the file', async ({ page }) => {
    // EP_Flyer is stored as EP_Flyer.EvidencePreset.sodso.json. The type is in the file
    // name so that two assets of one name can be two files -- it is not part of what the
    // asset is called, and the panel is where an author reads that name.
    const entry = section(page, 'EvidencePreset').locator('.file-panel-entry');
    await expect(entry).toHaveAttribute('data-id', 'EP_Flyer.EvidencePreset');
    await expect(entry.locator('.file-panel-open')).toHaveText('EP_Flyer');

    // The id is what opens it, so the window is the file. Its heading is the asset and
    // the type it is, which is how the base game's own files are named and read -- a
    // window called `Bar` says nothing about which of the six Bars is being edited.
    await entry.locator('.file-panel-open').click();
    await expect(page.locator('#trees .file-window'))
        .toHaveAttribute('path', 'EP_Flyer.EvidencePreset.sodso.json');
    await expect(page.locator('#trees .file-window .doc-title h5'))
        .toHaveText('EvidencePreset/EP_Flyer');

    // And the file itself is still readable, since that is what the manifest lists.
    await expect(page.locator('#trees .file-window .doc-title h5'))
        .toHaveAttribute('title', 'EP_Flyer.EvidencePreset.sodso.json');
});

test('an override is titled by the type the panel worked out for it', async ({ page }) => {
    // ExCopSniper.sodso_patch.json carries no type of its own -- a patch is named after
    // what it overrides and nothing else -- so the title would have nothing to say if it
    // read the file alone. The panel already knows, from the asset's name.
    await section(page, 'MurderMO').locator('.file-panel-entry[data-id="ExCopSniper"] .file-panel-open').click();

    await expect(page.locator('#trees .file-window .doc-title h5')).toHaveText('MurderMO/ExCopSniper');
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
    await expect(invalid.locator('.file-panel-name')).toHaveText(['Nonsense', 'NotAnAsset']);

    // And there is nothing to open them as, so they are listed rather than linked.
    await expect(invalid.locator('.file-panel-open')).toHaveCount(0);

    // They are still the mod's own files, so they can still be taken out of it -- and a
    // file the app cannot make sense of is the one most likely to want removing.
    await expect(invalid.locator('.file-panel-danger')).toHaveCount(2);
});

test('invalid files are listed after the types, not among them', async ({ page }) => {
    // Sorting it alphabetically would bury it between EvidencePreset and MurderMO.
    const summaries = page.locator('#so-file-list .file-panel-category summary');
    await expect(summaries.last()).toContainText('Invalid');
});

/**
 * Searching the panel. What a query leaves is decided in core/filePanel.unit.spec.js;
 * what is worth a page is that the box is wired to the panel and survives it being
 * rebuilt.
 */

const search = (page) => page.locator('#so-file-search');
const categories = (page) => page.locator('#so-file-list .file-panel-category summary');
// The open button rather than the row, which also holds the button that deletes it.
const entries = (page) => page.locator('#so-file-list .file-panel-open');

test('searching narrows the panel to the files that match', async ({ page }) => {
    await search(page).fill('murd');

    // testcase is a MurderMO and stays: the type it is filed under is part of what is
    // being searched. AnotherMurder matches by name as well.
    await expect(categories(page)).toHaveText(['MurderMO (3)']);
    await expect(entries(page)).toHaveText(['AnotherMurder', 'ExCopSniperpatch', 'testcase']);

    // And clearing it puts the whole folder back.
    await search(page).fill('');
    await expect(categories(page)).toHaveCount(5);
});

test('a search that matches nothing says so', async ({ page }) => {
    await search(page).fill('nosuchfile');

    // Rather than a panel that has gone blank, which reads as a folder that has emptied.
    await expect(entries(page)).toHaveCount(0);
    await expect(page.locator('#so-file-list .file-panel-empty')).toContainText('nosuchfile');
});

test('a search outlives the panel being rebuilt', async ({ page }) => {
    await search(page).fill('IP_');
    await expect(entries(page)).toHaveText(['IP_Note']);

    // Renaming a preset relists the folder. The author is part-way through finding
    // something, and the list they were narrowing should not go back to all of it.
    await page.locator('#so-file-list .file-panel-entry[data-id="IP_Note"] .file-panel-open').click();
    const presetName = page.locator(
        `#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"presetName"')) input`
    ).first();
    await presetName.fill('IP_Renamed');
    await presetName.blur();

    await expect(entries(page)).toHaveText(['IP_Renamed']);
});

test('choosing another mod clears the search', async ({ page }) => {
    await search(page).fill('IP_');
    await expect(entries(page)).toHaveText(['IP_Note']);

    // A query from the last mod would narrow this one to nothing, and read as a folder
    // with nothing in it.
    await selectContent(page, 'TestCase', '');

    await expect(search(page)).toHaveValue('');
    await expect(entries(page).first()).toBeVisible();
});

/**
 * The window a click on an entry opened.
 *
 * Counted as a change rather than as a total. This flow stacks windows rather than
 * replacing them, so asserting that exactly one exists says only that the test arrived
 * at a blank page -- it says nothing about the click. What is worth pinning is that one
 * click opens one window, whatever was already open.
 */
async function opened(page, body) {
    const windows = page.locator('#trees .file-window');
    const before = await windows.count();
    await body();

    await expect(windows).toHaveCount(before + 1);
    return windows.last();
}

test('opening a patch loads the patch file, not the asset it overrides', async ({ page }) => {
    // Both names are the same in the list; only the extension tells them apart.
    const window_ = await opened(page, () =>
        section(page, 'MurderMO').getByRole('button', { name: 'ExCopSniper' }).click());

    await expect(window_).toHaveAttribute('path', 'ExCopSniper.sodso_patch.json');
});

test('opening an entry loads that file', async ({ page }) => {
    const window_ = await opened(page, () =>
        section(page, 'InteractablePreset').getByRole('button', { name: 'IP_Note' }).click());

    await expect(window_).toHaveAttribute('path', 'IP_Note.sodso.json');
});

test('the manifest itself is not listed as an asset', async ({ page }) => {
    // It describes the mod rather than being content of its own.
    await expect(page.locator('#so-file-list')).not.toContainText('murdermanifest');
});


/**
 * Deleting a file from the case.
 *
 * The only thing this panel does that cannot be undone from inside the app: there is no
 * history, and the folder is the author's real folder on disk. So what is pinned here is
 * the asking as much as the deleting -- a case folder is a web of `REF:` strings, and the
 * question is where the app says what confirming will break.
 */

const deleteButton = (page, type, id) =>
    section(page, type).locator(`.file-panel-entry[data-id="${id}"] .file-panel-danger`);

/**
 * The box the app put up, which is the whole of the warning.
 *
 * Waited for rather than read: a click returns once the event is dispatched, and the
 * references in the question are gathered by reading every file in the folder first.
 */
async function lastConfirm(page) {
    await expect.poll(async () => (await confirms(page)).length).toBeGreaterThan(0);
    return (await confirms(page)).at(-1);
}

test('every entry offers a delete button, sized against the button beside it', async ({ page }) => {
    // Everything listed is a file in the mod's own folder, so all of it is the author's.
    await expect(page.locator('#so-file-list .file-panel-danger')).toHaveCount(8);

    const entry = section(page, 'InteractablePreset').locator('.file-panel-entry');
    const open = await entry.locator('.file-panel-open').boundingBox();
    const remove = await entry.locator('.file-panel-danger').boundingBox();

    // A square at the end of the row, as tall as the file button and no taller. The
    // file button is what takes the space left over.
    expect(Math.round(remove.height)).toBe(Math.round(open.height));
    expect(Math.round(remove.width)).toBe(Math.round(remove.height));
    expect(open.width).toBeGreaterThan(remove.width * 3);
});

test('deleting names the file by what the author reads in the panel', async ({ page }) => {
    await deleteButton(page, 'MurderMO', 'testcase').click();

    // By the name in the panel, not by the file it is stored in.
    expect(await lastConfirm(page)).toContain('Delete "testcase" from this mod?');
});

test('the load order naming the file is not a reference to it', async ({ page }) => {
    // testcase is the mod's one manifest entry and nothing else in the folder points at
    // it. The entry goes when the file does, so listing it would warn an author about a
    // link this same click repairs -- and would make an unreferenced file look referenced.
    await deleteButton(page, 'MurderMO', 'testcase').click();

    const asked = await lastConfirm(page);
    expect(asked).toContain('Nothing else in this mod refers to it.');
    expect(asked).not.toContain('murdermanifest');
});

test('a file nothing points at says so', async ({ page }) => {
    // AnotherMurder is in the folder and in no manifest entry and no other document.
    await deleteButton(page, 'MurderMO', 'AnotherMurder').click();

    expect(await lastConfirm(page)).toContain('Nothing else in this mod refers to it.');
});

test('confirming removes the file and takes it out of the load order', async ({ page }) => {
    await deleteButton(page, 'MurderMO', 'testcase').click();

    // Gone from the folder...
    await expect(section(page, 'MurderMO').locator('.file-panel-entry[data-id="testcase"]'))
        .toHaveCount(0);
    expect(await listDir(page, 'Mods/TestCase')).not.toContain('testcase.sodso.json');

    // ...and out of the load order with it. An entry naming a file that is not there is
    // a loader going looking for something it cannot find.
    expect(JSON.parse(await readFile(page, 'Mods/TestCase/murdermanifest.sodso.json')).fileOrder)
        .toEqual([]);

    // And the manifest panel beside the list is showing what the manifest now says.
    await expect(page.locator('#manifest_panel .files-order ul button')).toHaveCount(0);
});

test('saying no changes nothing at all', async ({ page }) => {
    await queueConfirms(page, [false]);

    await deleteButton(page, 'MurderMO', 'testcase').click();

    // The question was put, and answering it was the end of the matter.
    expect(await lastConfirm(page)).toContain('Delete "testcase"');
    await expect(section(page, 'MurderMO').locator('.file-panel-entry[data-id="testcase"]'))
        .toHaveCount(1);
    expect(await listDir(page, 'Mods/TestCase')).toContain('testcase.sodso.json');
    expect(JSON.parse(await readFile(page, 'Mods/TestCase/murdermanifest.sodso.json')).fileOrder)
        .toEqual(['REF:testcase']);
});

test('deleting a patch removes only the patch', async ({ page }) => {
    // Which is how a mod stops overriding a piece of base game content. The two forms
    // live side by side in the folder and differ only by extension, so the delete has to
    // remove the one the entry stands for.
    await deleteButton(page, 'MurderMO', 'ExCopSniper').click();

    const held = await listDir(page, 'Mods/TestCase');
    expect(held).not.toContain('ExCopSniper.sodso_patch.json');
    expect(held).toContain('AnotherMurder.sodso.json');
});

test('the window showing a deleted file is closed with it', async ({ page }) => {
    await section(page, 'InteractablePreset').locator('.file-panel-open').click();
    await expect(page.locator('#trees .file-window')).toHaveAttribute('path', 'IP_Note.sodso.json');

    await deleteButton(page, 'InteractablePreset', 'IP_Note').click();

    // A document left open over a deleted file is one autosave away from writing it back
    // out, with nothing to say that had happened.
    await expect(page.locator('#trees .file-window')).toHaveCount(0);
});

test('a window over another file is left open', async ({ page }) => {
    await section(page, 'InteractablePreset').locator('.file-panel-open').click();

    await deleteButton(page, 'MurderMO', 'AnotherMurder').click();

    await expect(page.locator('#trees .file-window')).toHaveAttribute('path', 'IP_Note.sodso.json');
});

test('a file another document points at is named before it goes', async ({ page }) => {
    await seedFs(page, caseWithCustomReference);
    await selectContent(page, 'TestCase', '');

    // testcase holds `denStyleOverride: ["REF:DesignStylePreset|HouseStyle"]`, which
    // nothing in the panel shows and which following by hand means opening every other
    // file in the folder.
    await deleteButton(page, 'DesignStylePreset', 'HouseStyle').click();

    const asked = await lastConfirm(page);
    expect(asked).toContain('Referenced by 1 file:');
    expect(asked).toContain('testcase');

    // Listed and nothing more: the reference is still there for its author to deal with.
    expect(JSON.parse(await readFile(page, 'Mods/TestCase/testcase.sodso.json')).denStyleOverride)
        .toEqual(['REF:DesignStylePreset|HouseStyle']);
});
