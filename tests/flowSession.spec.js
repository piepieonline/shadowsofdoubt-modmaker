import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, connectFolders, selectContent, gotoFlow } from './support/harness.js';
import { caseWithDdsReference, ddsFixtureWithContent, TREE_GUID } from './support/fixtures.js';

/**
 * What is open survives a trip to the other editor.
 *
 * Switching unmounts a flow's markup, so without this every switch dropped you back
 * at an empty workspace -- which makes going to look something up and coming back
 * cost more than it should.
 */

const openWindows = (page) => page.evaluate(() =>
    [...document.querySelectorAll('#trees .file-window')].map((el) => el.getAttribute('path')));

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

test('the DDS drill-down comes back as it was', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsFixtureWithContent);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestMod', 'Content');

    await page.evaluate((g) => { document.getElementById('path-to-read').value = g; }, TREE_GUID);
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await page.locator('#file-window-2 .jsontree_child-nodes').first().waitFor();
    const before = await openWindows(page);

    await page.selectOption('#flow-picker', 'scriptableObject');
    await page.locator('html[data-flow-ready="scriptableObject"]').waitFor();

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    // All three levels, not just the tree rebuilt from its first message and block.
    await expect.poll(() => openWindows(page)).toEqual(before);
    // The fixture patches this tree's name, so the restored document is the patched
    // one rather than raw vanilla -- the mod's own edits are still applied.
    await expect(page.locator('#file-window-0')).toContainText('Tree: Patched');
});

test('a deeper level chosen by hand is restored, not the default cascade', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsFixtureWithContent);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestMod', 'Content');

    await page.evaluate((g) => { document.getElementById('path-to-read').value = g; }, TREE_GUID);
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await page.locator('#file-window-2 .jsontree_child-nodes').first().waitFor();

    // The tree has two messages; loading it opens the first. Pick the second, so the
    // drill-down is no longer what the cascade would rebuild.
    // A msgID is an input now, so what opens it is the ➥ beside it rather than the
    // text itself. Messages render in array order, so the second one is the second ➥.
    await page.locator('#file-window-0 .link-element[title="Open this message"]').nth(1).click();
    await expect(page.locator('#file-window-1')).toContainText('SecondMessage');
    const before = await openWindows(page);

    await page.selectOption('#flow-picker', 'scriptableObject');
    await page.locator('html[data-flow-ready="scriptableObject"]').waitFor();
    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    await expect.poll(() => openWindows(page)).toEqual(before);
    await expect(page.locator('#file-window-1')).toContainText('SecondMessage');
});

test('applying the content folder happens once per switch', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, caseWithDdsReference);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    // Count it rather than watching for the symptom. Applying is destructive for this
    // flow -- it closes every open document and reloads the manifest -- so a second,
    // later call destroys whatever was restored in between. Timing decides whether
    // that is visible, which is why the window-count assertions could not catch it.
    await page.evaluate(() => {
        window.__applied = 0;
        const flow = window.activeFlow;
        const original = flow.onModSelected.bind(flow);
        flow.onModSelected = async (selection) => {
            window.__applied += 1;
            return original(selection);
        };
    });

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();
    await page.selectOption('#flow-picker', 'scriptableObject');
    await page.locator('html[data-flow-ready="scriptableObject"]').waitFor();
    await page.waitForTimeout(300);

    expect(await page.evaluate(() => window.__applied)).toBe(1);
});

test('open case files come back', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, caseWithDdsReference);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await page.locator('#manifest_panel .files-order ul button').click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();
    await page.selectOption('#flow-picker', 'scriptableObject');
    await page.locator('html[data-flow-ready="scriptableObject"]').waitFor();

    await expect.poll(() => openWindows(page)).toEqual(['testcase.sodso.json']);

    // And stays. expect.poll passes on the first match, so on its own it cannot tell
    // "restored" from "restored, then destroyed a moment later".
    await page.waitForTimeout(400);
    expect(await openWindows(page)).toEqual(['testcase.sodso.json']);
});

test('changing the content folder while away discards what was open', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, {
        ...caseWithDdsReference,
        'Mods/OtherCase/murdermanifest.sodso.json':
            JSON.stringify({ enabled: true, fileOrder: [], loadBefore: '', version: 1 }),
        // Same file name as the one open in the other folder: without keying the
        // session to the folder, this would be reopened as if it were the same work.
        'Mods/OtherCase/testcase.sodso.json':
            JSON.stringify({ fileType: 'MurderMO', name: 'different' }),
    });
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await page.locator('#manifest_panel .files-order ul button').click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    // Work on something else, then come back.
    await selectContent(page, 'OtherCase', '');
    await page.selectOption('#flow-picker', 'scriptableObject');
    await page.locator('html[data-flow-ready="scriptableObject"]').waitFor();

    // Those documents belong to a folder we are no longer in.
    await expect.poll(() => openWindows(page)).toEqual([]);
});
