import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, gotoFlow } from './support/harness.js';
import { pluginsFixture } from './support/fixtures.js';

/**
 * Finding editable content inside a BepInEx plugins folder.
 *
 * The fixture mirrors a real install: content folders sit at the mod root, one level
 * down, under plugins/, and deeper again, and plenty of mods hold none at all.
 */

const discover = (page, mod) => page.evaluate(async (name) => {
    const { listMods, findContentFolders } = await import('/core/modFolders.js');
    const plugins = await window.__opfsDir('Plugins', false);

    if (!name) return (await listMods(plugins)).map((m) => m.name);

    const modHandle = await plugins.getDirectoryHandle(name);
    return (await findContentFolders(modHandle)).map((f) => ({
        path: f.path, hasManifest: f.hasManifest, hasDdsContent: f.hasDdsContent,
    }));
}, mod);

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, pluginsFixture);
});

test('lists every mod, including ones with nothing to edit', async ({ page }) => {
    // Utility mods still appear: you may want to add content to one.
    expect(await discover(page)).toEqual([
        'AdditionalEvidence', 'DartTowerTest', 'DialogAdditions', 'UnityExplorer', 'WhiteCollarSideJobs',
    ]);
});

test('finds a content folder at the mod root', async ({ page }) => {
    expect(await discover(page, 'DartTowerTest')).toEqual([
        { path: '', hasManifest: true, hasDdsContent: true },
    ]);
});

test('finds several content folders one level down', async ({ page }) => {
    expect(await discover(page, 'AdditionalEvidence')).toEqual([
        { path: 'BinPasscodes', hasManifest: true, hasDdsContent: false },
        { path: 'GroupFlyers', hasManifest: true, hasDdsContent: true },
    ]);
});

test('finds content under the plugins/ convention', async ({ page }) => {
    expect(await discover(page, 'DialogAdditions')).toEqual([
        { path: 'plugins/TalkToPartner', hasManifest: false, hasDdsContent: true },
        { path: 'plugins/WhatIsYourPasscode', hasManifest: true, hasDdsContent: true },
    ]);
});

test('finds content nested deeper than one subfolder', async ({ page }) => {
    // This is the case a "pick a subfolder" dropdown would miss entirely.
    expect(await discover(page, 'WhiteCollarSideJobs')).toEqual([
        { path: 'plugins/Cases/test', hasManifest: true, hasDdsContent: false },
    ]);
});

test('reports nothing for a mod with no editable content', async ({ page }) => {
    expect(await discover(page, 'UnityExplorer')).toEqual([]);
});

test('stops searching below a content folder', async ({ page }) => {
    // What bounds the walk: once a folder qualifies, nothing under it is offered.
    // The fixture puts a second manifest inside DartTowerTest to prove it.
    expect(await discover(page, 'DartTowerTest')).toEqual([
        { path: '', hasManifest: true, hasDdsContent: true },
    ]);
});
