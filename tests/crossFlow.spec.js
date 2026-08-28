import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, queuePicks, connectFolders, selectContent, gotoFlow } from './support/harness.js';
import {
    ddsFixture, soFixture, pluginsFixture, ddsManifestFixture, soFolderContent, FLAT_MOD,
} from './support/fixtures.js';

/**
 * The point of the merge: both flows share one persisted mod folder.
 *
 * Before this, the DDS Viewer stored the handle under 'DDSModPath' and the Case
 * Editor under 'ModPath', so a folder opened in one was invisible to the other --
 * the "No way to pass this from one app to the other :(" comment in the DDS flow's
 * fileManager.js.
 */

const modDirName = (page) =>
    page.evaluate(async () => (await idbKeyval.get('ModPath'))?.name ?? null);

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

test('a mod folder opened in the DDS flow is remembered for the case flow', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, { ...ddsFixture, ...soFixture });
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

    await expect.poll(() => modDirName(page)).toBe('Mods');

    // Same origin, so the other flow sees the same idb-keyval entry.
    await gotoFlow(page, '?flow=scriptableObject');
    expect(await modDirName(page)).toBe('Mods');
});

test('a mod folder opened in the case flow is remembered for the DDS flow', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, { ...ddsFixture, ...soFixture });
    await connectFolders(page, { modDir: 'Mods' });

    await expect.poll(() => modDirName(page)).toBe('Mods');

    await gotoFlow(page, '?flow=dds');
    expect(await modDirName(page)).toBe('Mods');
});

test('a folder remembered under the old DDS Viewer key is adopted', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsFixture);

    // A user of the old DDS Viewer, whose handle is under the legacy key.
    await page.evaluate(async () => {
        const mods = await window.__opfsDir('Mods', false);
        await idbKeyval.set('DDSModPath', mods);
        await idbKeyval.del('ModPath');
    });

    await page.locator('[data-select-folder="modDir"]').click();
    await page.locator('.folder-row[data-folder="modDir"][data-state="connected"]').waitFor();

    // No file dialog: the remembered handle was still usable, so it is adopted
    // directly rather than making the user find the folder again.
    expect(await page.evaluate(() => window.__pickerCalls.length)).toBe(0);
    // And written forward to the shared key, so the other flow sees it too.
    await expect.poll(() => modDirName(page)).toBe('Mods');
});

test('a remembered folder reconnects on load without asking', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFixture);
    await page.evaluate(async () => {
        await idbKeyval.set('ModPath', await window.__opfsDir('Mods', false));
    });

    await gotoFlow(page, '?flow=scriptableObject');

    // Already connected, so the modal does not interrupt and the mod list is there.
    await expect(page.locator('#folders-modal')).toBeHidden();
    await expect(page.locator('#select-mod option')).toHaveText(['Choose a mod…', 'TestCase']);
    expect(await page.evaluate(() => window.__pickerCalls.length)).toBe(0);
});

test('switching flows keeps the folders connected', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, { ...ddsFixture, ...soFixture });
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

    await page.selectOption('#flow-picker', 'scriptableObject');
    await page.locator('html[data-flow-ready="scriptableObject"]').waitFor();

    // Nothing was asked for again. __pickerCalls is page state, so its surviving
    // also proves the switch happened in place rather than by reloading.
    expect(await page.evaluate(() => window.__pickerCalls.length)).toBe(2);
    expect(await page.evaluate(() => window.dirHandleModDir?.name ?? null)).toBe('Mods');
    expect(await page.evaluate(() => window.dirHandleStreamingAssets?.name ?? null)).toBe('StreamingAssets');

    // The new flow is usable straight away, not sitting behind the folder modal.
    // Both fixtures are seeded, so both mod folders are listed.
    await expect(page.locator('#folders-modal')).toBeHidden();
    await expect(page.locator('#select-mod option')).toHaveText(['Choose a mod…', 'TestCase', 'TestMod']);

    // And back again.
    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();
    expect(await page.evaluate(() => window.__pickerCalls.length)).toBe(2);
    await expect(page.locator('#folders-modal')).toBeHidden();
});

test('the folders modal can be reopened to change a folder later', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFixture);
    await connectFolders(page, { modDir: 'Mods' });
    await expect(page.locator('#folders-modal')).toBeHidden();

    await page.getByRole('button', { name: 'Folders' }).click();
    await expect(page.locator('#folders-modal')).toBeVisible();

    // Already-connected folders are shown as such, with the option to change them.
    const row = page.locator('.folder-row[data-folder="modDir"]');
    await expect(row).toHaveAttribute('data-state', 'connected');
    await expect(row).toContainText('Mods');
    await expect(row.getByRole('button')).toHaveText('Change');
});

test('switching flows never reopens the folder modal, even when one is missing', async ({ page }) => {
    // The case flow needs only the mod folder; the DDS flow also needs the game
    // folder. Switching to it therefore has an unmet requirement.
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, { ...ddsFixture, ...soFixture });
    await connectFolders(page, { modDir: 'Mods' });
    await expect(page.locator('#folders-modal')).toBeHidden();

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    // Not in the way -- but the header says something is outstanding.
    await expect(page.locator('#folders-modal')).toBeHidden();
    await expect(page.locator('#folders-open')).toHaveAttribute('data-folders-missing', '');

    // And it is still reachable on demand.
    await page.getByRole('button', { name: 'Folders' }).click();
    await expect(page.locator('#folders-modal')).toBeVisible();
    await expect(page.locator('.folder-row[data-folder="streamingAssets"]'))
        .toHaveAttribute('data-state', 'missing');
});

test('the folders button stops flagging once the requirement is met', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsFixture);
    await expect(page.locator('#folders-open')).toHaveAttribute('data-folders-missing', '');

    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await expect(page.locator('#folders-open')).not.toHaveAttribute('data-folders-missing', '');
});

test('the chosen content folder survives switching flows', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, pluginsFixture);
    await connectFolders(page, { modDir: 'Plugins' });

    // A folder holding both a case manifest and DDS content -- the reason the choice
    // belongs to the shell rather than to one flow.
    await selectContent(page, 'DialogAdditions', 'plugins/WhatIsYourPasscode');

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    expect(await page.evaluate(() => window.selectedMod?.modName ?? null)).toBe('DialogAdditions');
    expect(await page.evaluate(() => window.selectedMod?.contentPath ?? null))
        .toBe('plugins/WhatIsYourPasscode');
    await expect(page.locator('#select-mod')).toHaveValue('DialogAdditions');
    await expect(page.locator('#select-content')).toHaveValue('plugins/WhatIsYourPasscode');
});

test('a mod chosen before the list is rebuilt is not thrown away', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, pluginsFixture);
    await connectFolders(page, { modDir: 'Plugins' });

    // A mod with no content folder chosen yet. Choosing one *clears* window.selectedMod,
    // which is only set once there is a folder to edit -- so this is the state a refresh
    // used to find when it landed on a choice made a moment earlier, and reading the
    // choice from there found nothing to keep.
    await page.selectOption('#select-mod', 'DialogAdditions');
    expect(await page.evaluate(() => window.selectedMod)).toBe(null);

    // Connecting a folder starts one of these that nothing waits for -- notifyChanged
    // calls its listeners without awaiting them -- so it lands whenever the disk reply
    // does, which can be after the next thing the user does. Called directly and awaited
    // here, because the point is what the refresh does rather than when it happens.
    await page.evaluate(async () => {
        const { refreshMods } = await import('/core/modSelection.js');
        await refreshMods();
    });

    // The mod used to unchoose itself here, with nothing on screen to say it had.
    await expect(page.locator('#select-mod')).toHaveValue('DialogAdditions');
    await expect(page.locator('#select-content option').first()).toHaveText('Choose a folder…');
});

test('both flows offer adding content the same way', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, pluginsFixture);
    await connectFolders(page, { modDir: 'Plugins' });
    await selectContent(page, 'DialogAdditions', 'plugins/WhatIsYourPasscode');

    const caseButton = page.locator('#manifest_add_item_button');
    await expect(caseButton).toHaveText('Add new file');
    const caseBox = await caseButton.boundingBox();

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();

    // Same wording: what kind of thing is asked in the dialog either way, so neither
    // button names one.
    const ddsButton = page.locator('#new-file-button');
    await expect(ddsButton).toHaveText('Add new...');

    // And the same button: the DDS one used to be a secondary at Pico's full padding,
    // towering over the file list it sits above.
    const ddsBox = await ddsButton.boundingBox();
    expect(Math.abs(ddsBox.height - caseBox.height)).toBeLessThan(2);
    await expect(ddsButton).not.toHaveClass(/secondary/);
});

/**
 * The foot of both sidebars: a title, the switch that swaps the friendly list for the
 * document, and an entry per file the manifest names.
 *
 * The case flow's had no title at all and carried a switch at Pico's full size, and
 * both flows' entries were full-height buttons with centred body text sitting under a
 * list of small ones. Compared rather than asserted flow by flow, because what went
 * wrong was the two drifting apart.
 */
const manifestSection = (page) => page.evaluate(() => {
    const section = document.querySelector('#flow-root .manifest-section');
    const style = (el, ...props) =>
        Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]]));

    const entry = section.querySelector('.files-order button');
    // The list above it, which the manifest's entries are meant to match.
    const listed = document.querySelector('.file-panel-entry button');

    return {
        title: section.querySelector('header > strong')?.textContent ?? null,
        switchLabel: section.querySelector('header label').textContent.trim(),
        switchSize: style(section.querySelector('header label'), 'fontSize'),

        entry: {
            ...style(entry, 'fontSize', 'padding', 'textAlign', 'textOverflow', 'whiteSpace'),
            height: entry.getBoundingClientRect().height,
        },
        // Same font and same height as an entry in the file panel above.
        listed: {
            ...style(listed, 'fontSize'),
            height: listed.getBoundingClientRect().height,
        },
    };
});

/** The sidebar of whichever flow is mounted, and how wide it is. */
const sidebarWidth = (page) => page.evaluate(() =>
    document.querySelector('#dds-file-panel, #manifest_panel').getBoundingClientRect().width);

test('both flows show the manifest the same way', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, { ...ddsManifestFixture, ...soFolderContent });
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');
    await page.locator('#manifest_panel .files-order button').first().waitFor();

    const so = await manifestSection(page);
    const soWidth = await sidebarWidth(page);

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();
    // A mod with a ddsmanifest: without one the flow offers no panel at all, since it
    // never invites a mod into a structure its author has not chosen.
    await selectContent(page, FLAT_MOD.mod, FLAT_MOD.content);
    await page.locator('#dds-manifest-panel .files-order button').first().waitFor();

    const dds = await manifestSection(page);

    // The sidebar itself, which the two flows lay out by different means -- a flex
    // item here, a grid track there -- and so had drifted 40px apart.
    expect(await sidebarWidth(page)).toBe(soWidth);
    expect(soWidth).toBe(300);

    expect(dds).toEqual(so);
    expect(dds.title).toBe('Manifest');
    expect(dds.switchLabel).toBe('Show full manifest');

    // Sized against the list above rather than against Pico's default button.
    expect(dds.entry.fontSize).toBe(dds.listed.fontSize);
    expect(dds.entry.height).toBeCloseTo(dds.listed.height, 1);
    // A path too long for the panel is cut off, not wrapped over three lines.
    expect(dds.entry.textOverflow).toBe('ellipsis');
    expect(dds.entry.whiteSpace).toBe('nowrap');
    expect(dds.entry.textAlign).toBe('left');
});

test('mods are listed with what each of their folders holds', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, pluginsFixture);
    await connectFolders(page, { modDir: 'Plugins' });

    // A mod whose content sits at its own root.
    await page.selectOption('#select-mod', 'DartTowerTest');
    await expect(page.locator('#select-content option')).toHaveText([
        'Choose a folder…', '(mod root) — case + DDS',
    ]);

    // A mod with several, one of which has no DDS content and one of which holds
    // every kind at once.
    await page.selectOption('#select-mod', 'AdditionalEvidence');
    await expect(page.locator('#select-content option')).toHaveText([
        'Choose a folder…', 'BinPasscodes — case', 'GroupFlyers — case + DDS + building',
    ]);

    // A building mod, which is marked by a Floors folder and nothing else.
    await page.selectOption('#select-mod', 'TallTower');
    await expect(page.locator('#select-content option')).toHaveText([
        'Choose a folder…', '(mod root) — building',
    ]);

    // A loader with nothing editable says so rather than looking broken.
    await page.selectOption('#select-mod', 'UnityExplorer');
    await expect(page.locator('#select-content option')).toHaveText(['Nothing editable in this mod']);
});
