import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, selectContent, queuePrompts,
    readFile, listDir, alerts, gotoFlow, editField, fieldInput,
} from './support/harness.js';
import { ddsFixture, ddsBareFixture, pluginsFixture, TREE_GUID } from './support/fixtures.js';

/**
 * The controls in the shell header that used to be per-flow: Autosaving, and creating
 * a content folder.
 *
 * Both were duplicated, and the duplicates disagreed. The case flow remembered the
 * autosave setting while the DDS flow forced it back on at every start, so switching
 * editors silently changed whether edits were being written. New content meant a case
 * in one flow and a DDS folder in the other, each guessing where to put it.
 */

const AUTOSAVE = '#autosave-switch';

/** The folders modal opens over the header on a cold start, with nothing connected. */
const dismissFolders = (page) => page.locator('#folders-continue').click();

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

test('autosaving is on by default and remembered across a reload', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await dismissFolders(page);
    await expect(page.locator(AUTOSAVE)).toBeChecked();

    await page.locator(AUTOSAVE).uncheck();

    await gotoFlow(page, '?flow=scriptableObject');
    await expect(page.locator(AUTOSAVE)).not.toBeChecked();
});

test('a preference set under the old case editor key is kept', async ({ page }) => {
    // The case flow's key. Its users have a setting already, and moving the control
    // into the shell is not a reason to reset it.
    await page.addInitScript(() => localStorage.setItem('SOD_MurderCaseBuilder_Autosave', 'false'));

    await gotoFlow(page, '?flow=dds');
    await expect(page.locator(AUTOSAVE)).not.toBeChecked();
});

test('turning autosaving off holds for the other editor too', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await dismissFolders(page);
    await page.locator(AUTOSAVE).uncheck();

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    // The DDS flow used to switch it back on as it started, so the same switch meant
    // one thing in one editor and the opposite in the other.
    await expect(page.locator(AUTOSAVE)).not.toBeChecked();
    expect(await page.evaluate(() => document.querySelector('#autosave-switch').checked)).toBe(false);
});

test('with autosaving off an edit writes nothing until Save is pressed', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await page.locator(AUTOSAVE).uncheck();

    await page.evaluate((g) => { document.getElementById('path-to-read').value = g; }, TREE_GUID);
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await page.locator('#file-window-2 .jsontree_child-nodes').first().waitFor();
    await selectContent(page, 'TestMod', 'Content');

    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;

    await editField(page, '#file-window-0', 'name', 'RenamedTree');
    // The edit is in the document either way; what is under test is the writing.
    await expect(fieldInput(page, '#file-window-0', 'name')).toHaveValue('RenamedTree');
    expect(await readFile(page, patchPath)).toBeNull();

    // Explicit Save always writes, whatever the switch says.
    await page.locator('#file-window-0').getByRole('button', { name: 'Save' }).click();
    // `||` rather than `??`: the file is created before it is written, so there is a
    // moment where it is empty rather than absent, and JSON.parse('') would throw out
    // of the poll instead of being retried.
    await expect.poll(async () => JSON.parse((await readFile(page, patchPath)) || '[]'))
        .toContainEqual({ op: 'replace', path: '/name', value: 'RenamedTree' });
});

test('new content lands beside the folder being worked in', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, pluginsFixture);
    // This fixture is a plugins folder alone; the vanilla content is not needed here.
    await connectFolders(page, { modDir: 'Plugins' });

    // This mod keeps its content deeper than the BepInEx convention alone would say.
    await selectContent(page, 'WhiteCollarSideJobs', 'plugins/Cases/test');

    await queuePrompts(page, ['SecondJob']);
    await page.getByRole('button', { name: 'New content' }).click();

    await expect.poll(() => listDir(page, 'Plugins/WhiteCollarSideJobs/plugins/Cases')).toContain('SecondJob');
    expect(await listDir(page, 'Plugins/WhiteCollarSideJobs/plugins/SecondJob')).toBeNull();
});

test('a folder with nothing in it yet is still the one being edited', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsBareFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'BareMod', 'Content');

    await queuePrompts(page, ['Extra']);
    await page.getByRole('button', { name: 'New content' }).click();

    // A content folder is recognised by what is in it, and this one holds nothing, so
    // it is listed from what the app knows rather than from a search.
    await expect(page.locator('#select-content')).toHaveValue('Extra');
    await expect(page.locator('#select-content option[value="Extra"]')).toHaveText('Extra — new');
    await expect.poll(() => page.evaluate(() => window.selectedMod?.contentPath)).toBe('Extra');

    // Empty, and the DDS flow asked for nothing to be put in it.
    expect(await listDir(page, 'Mods/BareMod/Extra')).toEqual([]);

    // Then the first document it holds goes into it, not into the folder it came from.
    await queuePrompts(page, ['A line for the new block']);
    await page.getByRole('button', { name: 'Add new tree' }).click();

    await expect.poll(() => listDir(page, 'Mods/BareMod/Extra/DDSContent/DDS'))
        .toEqual(['Blocks', 'Messages', 'Trees']);
    expect(await listDir(page, 'Mods/BareMod/Content/DDSContent/DDS')).toBeNull();
    expect(await alerts(page)).toEqual([]);
});

test('creating content is not offered until there is a mod to put it in', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsBareFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

    // The placeholder option is a value like any other, so this used to be clickable
    // with nothing chosen, reach the filesystem with the placeholder, and throw.
    const newContent = page.getByRole('button', { name: 'New content' });
    await expect(newContent).toBeDisabled();
    expect(await listDir(page, 'Mods/Nowhere')).toBeNull();

    // A mod is all it needs, though: the folder goes in the mod, not in whichever
    // content folder happens to be open.
    await page.selectOption('#select-mod', 'BareMod');
    await expect(newContent).toBeEnabled();

    await queuePrompts(page, ['Nowhere']);
    await newContent.click();

    await expect.poll(() => listDir(page, 'Mods/BareMod/Nowhere')).toEqual([]);
    expect(await alerts(page)).toEqual([]);
});
