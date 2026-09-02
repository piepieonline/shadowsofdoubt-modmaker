import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, queuePicks, connectFolders, selectContent, gotoFlow,
    openDdsDocument,
} from '../test-support/harness.js';
import {
    ddsFixture, ddsFixtureWithContent, soFixture, pluginsFixture, ddsManifestFixture,
    soFolderContent, streamingAssets, ddsModDir, FLAT_MOD, TREE_GUID, MSG_GUID,
} from '../test-support/fixtures.js';

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

test('changing an already-connected folder asks for a different one', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, { ...soFixture, ...pluginsFixture });
    await connectFolders(page, { modDir: 'Mods' });

    await page.getByRole('button', { name: 'Folders' }).click();

    // Change has to reach the file dialog. A connected folder is one we already hold a
    // granted permission for, and asking for that permission again is answered straight
    // away -- so a shortcut past the picker hands back the folder already connected and
    // the button looks like it does nothing.
    await queuePicks(page, ['Plugins']);
    await page.locator('[data-select-folder="modDir"]').click();

    const row = page.locator('.folder-row[data-folder="modDir"]');
    await expect(row).toHaveAttribute('data-state', 'connected');
    await expect(row).toContainText('Plugins');

    expect(await page.evaluate(() => window.dirHandleModDir?.name ?? null)).toBe('Plugins');
    // And the new one is what a later visit reconnects to, not the one it replaced.
    await expect.poll(() => modDirName(page)).toBe('Plugins');
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

    // The sidebar itself, which the two flows used to lay out by different means -- a
    // flex item here, a grid track there -- and so had drifted 40px apart. Both are the
    // same .file-panel now; see the test below for the rest of that frame.
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

/**
 * The frame a document editor is laid out in: the panel, the box that scrolls the row of
 * open documents, and the row inside it.
 *
 * Read as computed style rather than as a screenshot, because what is being asked is
 * whether one stylesheet is laying both flows out -- see core/documentFlow.css. The two
 * used to build this from unrelated markup, a grid in one flow and a flex row in the
 * other, and every rule about it was written twice and drifted.
 */
const workspaceFrame = (page) => page.evaluate(() => {
    const root = document.getElementById('flow-root');
    const panel = root.querySelector('.file-panel');
    const scroll = root.querySelector('.tree-scroll');
    const row = root.querySelector('.tree-row');
    const window_ = row.querySelector('.file-window');

    const style = (el, ...props) =>
        Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]]));

    return {
        panelWidth: panel.getBoundingClientRect().width,
        // Where the row starts, so a difference in the gutter or in the article's padding
        // shows up rather than cancelling out against a difference in the panel.
        panelLeft: panel.getBoundingClientRect().left,
        gapToScroller: scroll.getBoundingClientRect().left - panel.getBoundingClientRect().right,

        scroller: style(scroll, 'overflowX', 'overflowY'),

        /*
         * The row is positioned and the scrolling belongs to the box around it. That is
         * what puts a dropdown opened from a control in a window on the control at any
         * scroll offset -- see .tree-scroll in core/documentFlow.css -- and both flows
         * parent their dropdowns into this element, so both depend on it.
         */
        rowIsInsideScroller: row.parentElement === scroll,
        rowPosition: getComputedStyle(row).position,
        rowScrolls: getComputedStyle(row).overflowX,

        // A window is as tall as the row and no narrower than this, whichever flow it is
        // a document of.
        windowMinWidth: getComputedStyle(window_).minWidth,
        windowFillsRow: Math.abs(window_.getBoundingClientRect().height
            - row.getBoundingClientRect().height) < 1,
    };
});

test('both flows lay their workspace out the same way', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, { ...ddsFixtureWithContent, ...soFolderContent });
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await page.locator('.file-panel-category[data-category="MurderMO"]')
        .getByRole('button', { name: 'testcase' }).click();
    await page.locator('#flow-root .tree-row .file-window').first().waitFor();

    const so = await workspaceFrame(page);

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();
    await selectContent(page, 'TestMod', 'Content');
    await openDdsDocument(page, TREE_GUID);
    await page.locator('#flow-root .tree-row .file-window').first().waitFor();

    const dds = await workspaceFrame(page);

    expect(dds).toEqual(so);

    // Stated as well as compared: two flows agreeing on the wrong thing is still wrong,
    // and the row not being the scrolling element is the whole point of the split.
    expect(so.rowIsInsideScroller).toBe(true);
    expect(so.rowPosition).toBe('relative');
    expect(so.rowScrolls).toBe('visible');
    expect(so.scroller.overflowX).toBe('auto');
    expect(so.windowFillsRow).toBe(true);
    expect(so.panelWidth).toBe(300);
});

/**
 * The workspace is a light surface whatever the system theme is, and the words on it are
 * dark. Read as luminance rather than as an exact colour: what matters is that the text
 * can be read against what is behind it.
 */
const panelContrast = (page) => page.evaluate(() => {
    const luminance = (colour) => {
        const [r, g, b] = colour.match(/\d+(\.\d+)?/g).map(Number);
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    };

    const panel = document.querySelector('#flow-root .file-panel');
    const heading = panel.querySelector('.manifest-section header strong');

    return {
        prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
        background: luminance(getComputedStyle(panel).backgroundColor),
        heading: luminance(getComputedStyle(heading).color),
        headingText: heading.textContent,
    };
});

test.describe('under a dark system theme', () => {
    test.use({ colorScheme: 'dark' });

    /*
     * The card the workspace sits on carries `data-theme="light"`, because libs/jsonTree
     * hardcodes dark text colours and the trees have to be a light surface for them.
     *
     * A nested `data-theme` only redefines Pico's variables, though: `color` itself is
     * declared once, on `body`, so plain text inside went on inheriting the dark theme's
     * near-white and only buttons and headings -- which name the variable again for
     * themselves -- picked the light value up. That left the words over the file list,
     * "Mod content" and "Manifest", in pale grey on white. See `.editor > article` in
     * core/documentFlow.css.
     */
    test('the workspace keeps its own palette, words included', async ({ page }) => {
        await gotoFlow(page, '?flow=scriptableObject');
        await seedFs(page, { ...ddsManifestFixture, ...soFolderContent });
        await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
        await selectContent(page, 'TestCase', '');
        await page.locator('#manifest_panel .files-order button').first().waitFor();

        const so = await panelContrast(page);

        await page.selectOption('#flow-picker', 'dds');
        await page.locator('html[data-flow-ready="dds"]').waitFor();
        await selectContent(page, FLAT_MOD.mod, FLAT_MOD.content);
        await page.locator('#dds-manifest-panel .files-order button').first().waitFor();

        const dds = await panelContrast(page);

        // The premise: without this the two colours below are the same either way.
        expect(so.prefersDark).toBe(true);
        expect(dds.prefersDark).toBe(true);

        for (const flow of [so, dds]) {
            expect(flow.headingText).toBe('Manifest');
            expect(flow.background).toBeGreaterThan(0.8);
            expect(flow.heading).toBeLessThan(0.4);
        }

        // And the same in both, since one stylesheet is what says so.
        expect(dds.heading).toBeCloseTo(so.heading, 3);
        expect(dds.background).toBeCloseTo(so.background, 3);
    });
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

    // A building mod, marked by a manifest naming a BuildingPreset and nothing else.
    await page.selectOption('#select-mod', 'TallTower');
    await expect(page.locator('#select-content option')).toHaveText([
        'Choose a folder…', '(mod root) — case + building',
    ]);

    // A loader with nothing editable says so rather than looking broken.
    await page.selectOption('#select-mod', 'UnityExplorer');
    await expect(page.locator('#select-content option')).toHaveText(['Nothing editable in this mod']);
});

/**
 * Keeping the author's place through an edit, which is core/document.js's job for both
 * flows.
 *
 * Editing anything rebuilds the whole tree, and a rebuilt tree arrives collapsed. The
 * reopening used to happen after the save, so for as long as the write took, the document
 * on screen was a couple of hundred pixels of collapsed keys -- and a scroll position
 * measured against the full document does not survive that. The author was thrown to the
 * top of the file on every dropdown change.
 *
 * Which document showed it was a matter of shape rather than of flow, which is why this
 * is one test over both. A DDS tree's height is `messages` expanded, so it lost almost
 * all of it; a case file's is top-level keys, which survive a collapse -- so the case
 * flow looked fine until a case file was given an array and the array was opened. Both
 * documents below are built to the same shape: a dropdown near the top, and every bit of
 * height in one array under it.
 */

/** A tree that is only tall because `messages` is open, and an enum above it to change. */
const scrollTestTree = {
    ...streamingAssets,
    ...ddsModDir,
    [`StreamingAssets/DDS/Trees/${TREE_GUID}.tree`]: JSON.stringify({
        id: TREE_GUID,
        name: 'ScrollTree',
        treeType: 1,
        messages: Array.from({ length: 40 }, (_, i) => ({
            msgID: MSG_GUID, instanceID: `instance-${i}`, order: i,
        })),
    }, null, 2),
};

/** The same shape as a case file: `disabled` is a Boolean, which this flow renders as one. */
const scrollTestCase = {
    ...soFolderContent,
    'Mods/TestCase/testcase.sodso.json': JSON.stringify({
        fileType: 'MurderMO',
        name: 'testcase',
        disabled: false,
        murdererTraitModifiers: Array.from({ length: 40 }, (_, i) => ({
            name: `rule ${i}`, modifier: i,
        })),
    }, null, 2),
};

/**
 * Make saving take a frame, as writing to a folder on disk does.
 *
 * OPFS answers fast enough that the collapsed document is often never painted, and the
 * fault then hides behind the browser's scroll anchoring putting the position back by
 * luck. What is being tested is that the editor does not depend on that luck.
 */
async function slowSaves(page) {
    await page.addInitScript(() => {
        const original = FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable = async function (...args) {
            await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
            return original.apply(this, args);
        };
    });
}

/** Scroll a document to the bottom and report where that was. */
async function scrollToBottom(page, selector) {
    return page.locator(selector).evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return el.scrollTop;
    });
}

test('a dropdown change keeps the DDS flow where the author was', async ({ page }) => {
    await slowSaves(page);
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, scrollTestTree);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'TestMod', 'Content');
    await openDdsDocument(page, TREE_GUID);

    const scroller = '#file-window-0 .jsontree-container';
    await page.locator(`${scroller} .jsontree_child-nodes`).first().waitFor();

    // `messages` opens with the document, so there is nothing to expand by hand here.
    const before = await scrollToBottom(page, scroller);
    expect(before).toBeGreaterThan(0);

    await page.locator(`#file-window-0 li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"treeType"')) select`)
        .first().selectOption({ index: 2 });

    await expect.poll(() => page.locator(scroller).evaluate((el) => el.scrollTop)).toBe(before);
});

test('a dropdown change keeps the case flow where the author was', async ({ page }) => {
    await slowSaves(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, scrollTestCase);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    const window_ = '.file-window[path="testcase.sodso.json"]';
    const scroller = `${window_} .jsontree-container`;
    await page.locator('.file-panel-category[data-category="MurderMO"]')
        .getByRole('button', { name: 'testcase' }).click();
    await page.locator(scroller).waitFor();

    // Opened by hand: this flow opens `fileOrder` with a document, which a MurderMO
    // has not got. What the author left open is what the rebuild has to put back.
    await page.locator(`${window_} li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"murdererTraitModifiers"')) .jsontree_expand-button`)
        .first().click();

    const before = await scrollToBottom(page, scroller);
    expect(before).toBeGreaterThan(0);

    await page.locator(`${window_} li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"disabled"')) select`)
        .first().selectOption({ index: 1 });

    await expect.poll(() => page.locator(scroller).evaluate((el) => el.scrollTop)).toBe(before);

    // And the array is still open, which is what that position was measured against.
    await expect(page.locator(`${window_} li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"murdererTraitModifiers"'))`)
        .first()).toHaveClass(/jsontree_node_expanded/);
});
