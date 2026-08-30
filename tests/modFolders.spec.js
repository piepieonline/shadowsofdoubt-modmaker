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
        path: f.path,
        hasManifest: f.hasManifest,
        hasDdsContent: f.hasDdsContent,
        hasBuildings: f.hasBuildings,
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
        'AdditionalEvidence', 'DartTowerTest', 'DialogAdditions', 'TallTower', 'UnityExplorer',
        'UnlistedTower', 'WhiteCollarSideJobs',
    ]);
});

test('finds a content folder at the mod root', async ({ page }) => {
    // Its manifest names a MurderMO, not a building, so a listed preset is not enough
    // on its own -- the file has to be opened to know what it is.
    expect(await discover(page, 'DartTowerTest')).toEqual([
        { path: '', hasManifest: true, hasDdsContent: true, hasBuildings: false },
    ]);
});

test('finds several content folders one level down', async ({ page }) => {
    expect(await discover(page, 'AdditionalEvidence')).toEqual([
        { path: 'BinPasscodes', hasManifest: true, hasDdsContent: false, hasBuildings: false },
        { path: 'GroupFlyers', hasManifest: true, hasDdsContent: true, hasBuildings: true },
    ]);
});

test('finds content under the plugins/ convention', async ({ page }) => {
    expect(await discover(page, 'DialogAdditions')).toEqual([
        { path: 'plugins/TalkToPartner', hasManifest: false, hasDdsContent: true, hasBuildings: false },
        { path: 'plugins/WhatIsYourPasscode', hasManifest: true, hasDdsContent: true, hasBuildings: false },
    ]);
});

test('finds content nested deeper than one subfolder', async ({ page }) => {
    // This is the case a "pick a subfolder" dropdown would miss entirely.
    expect(await discover(page, 'WhiteCollarSideJobs')).toEqual([
        { path: 'plugins/Cases/test', hasManifest: true, hasDdsContent: false, hasBuildings: false },
    ]);
});

test('reports nothing for a mod with no editable content', async ({ page }) => {
    expect(await discover(page, 'UnityExplorer')).toEqual([]);
});

test('finds a building mod, which has no DDSContent', async ({ page }) => {
    // The manifest naming a preset that says BuildingPreset is the whole marker, and it
    // finds the file through an entry that does not match its case.
    expect(await discover(page, 'TallTower')).toEqual([
        { path: '', hasManifest: true, hasDdsContent: false, hasBuildings: true },
    ]);
});

test('a building preset the manifest does not name is not a building', async ({ page }) => {
    // WhiteCollarSideJobs holds one; the folder above comes back as a case only.
    // Unlisted means the mod loader never reads it, so there is no building in the game.
    const [test] = await discover(page, 'WhiteCollarSideJobs');
    expect(test.hasBuildings).toBe(false);
});

test('a Floors folder is not a building mod on its own', async ({ page }) => {
    // The behaviour this deliberately gave up: a preset and its floors, with no manifest
    // naming the preset, is not offered. The game is not loading that mod either, and
    // listing the preset is the same fix in both places.
    expect(await discover(page, 'UnlistedTower')).toEqual([]);
});

test('describes what a content folder holds, including several kinds at once', async ({ page }) => {
    const described = await page.evaluate(async () => {
        const { findContentFolders, describeContentFolder } = await import('/core/modFolders.js');
        const plugins = await window.__opfsDir('Plugins', false);

        const describeMod = async (name) => {
            const handle = await plugins.getDirectoryHandle(name);
            return (await findContentFolders(handle)).map(describeContentFolder);
        };

        return {
            building: await describeMod('TallTower'),
            mixed: await describeMod('AdditionalEvidence'),
        };
    });

    expect(described.building).toEqual(['(mod root) — case + building']);
    expect(described.mixed).toEqual([
        'BinPasscodes — case',
        'GroupFlyers — case + DDS + building',
    ]);
});

test('stops searching below a content folder', async ({ page }) => {
    // What bounds the walk: once a folder qualifies, nothing under it is offered.
    // The fixture puts a second manifest inside DartTowerTest to prove it.
    expect(await discover(page, 'DartTowerTest')).toEqual([
        { path: '', hasManifest: true, hasDdsContent: true, hasBuildings: false },
    ]);
});
