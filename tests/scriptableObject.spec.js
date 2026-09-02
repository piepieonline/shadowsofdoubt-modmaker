import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, queuePicks, connectFolders, selectContent, queuePrompts, prompts, confirms, queueConfirms, listDir, alerts, collectPageErrors, topLevelLabels, readFile, writeFixture, gotoFlow } from '../test-support/harness.js';
import { soFixture, soFixtureWithAssets, soFolderContent, caseWithCustomReference } from '../test-support/fixtures.js';

const CASE_FILE = 'Mods/TestCase/testcase.sodso.json';

/**
 * Baseline smoke tests for the ScriptableObject (case editing) flow, recorded against
 * the app as it behaves today. See the note at the top of dds.spec.js.
 */

const SPOILER_KEY = 'SOD_MurderCaseBuilder_SpoilerWarningDismissed';

/**
 * Assert a <dialog>'s open state via the DOM property rather than the attribute.
 * Semantically what we care about, and robust to how the flow opens the dialog.
 */
const expectDialogOpen = (page, selector, open) =>
    expect.poll(() => page.locator(selector).evaluate((e) => e.open)).toBe(open);

/** Skip the spoiler gate, which is covered by its own test. */
async function skipSpoilerWarning(page) {
    await page.addInitScript((k) => window.localStorage.setItem(k, 'true'), SPOILER_KEY);
}

/** Drive the app from a cold start through to a mod being selected. */
async function openMod(page, modName = 'TestCase') {
    await seedFs(page, soFixture);
    await connectFolders(page, { modDir: 'Mods' });
    // The case fixture keeps its content at the mod root.
    await selectContent(page, modName, '');
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
});

test('boots and populates the type system from loadRefs.js', async ({ page }) => {
    const errors = collectPageErrors(page);
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    const refs = await page.evaluate(() => ({
        typeMapCount: Object.keys(window.typeMap ?? {}).length,
        typeLayoutCount: Object.keys(window.typeLayout ?? {}).length,
        templateCount: Object.keys(window.templates ?? {}).length,
        enumCount: Object.keys(window.enums ?? {}).length,
        pathIdMapCount: Object.keys(window.pathIdMap ?? {}).length,
        onlineTypes: window.onlineTypes ?? [],
        hasManifestLayout: !!window.typeLayout?.Manifest,
        hasBasicTypes: !!window.typeLayout?.Vector2 && !!window.typeLayout?.Color,
    }));

    expect(refs.typeMapCount).toBeGreaterThan(0);
    expect(refs.typeLayoutCount).toBeGreaterThan(0);
    expect(refs.templateCount).toBeGreaterThan(0);
    expect(refs.enumCount).toBeGreaterThan(0);
    expect(refs.pathIdMapCount).toBeGreaterThan(0);
    expect(refs.hasManifestLayout).toBe(true);
    expect(refs.hasBasicTypes).toBe(true);
    expect(refs.onlineTypes).toEqual(expect.arrayContaining(['MurderMO', 'EvidencePreset']));
    expect(errors).toEqual([]);
});

test('spoiler warning gates the folder modal until dismissed', async ({ page }) => {
    // Applies to the whole tool, so it lives in the shell rather than in one flow.
    await page.goto('?flow=scriptableObject');

    await expectDialogOpen(page, '#spoiler-warning-modal', true);
    await expectDialogOpen(page, '#folders-modal', false);

    await page.getByRole('button', { name: 'I accept the risk of spoilers' }).click();

    await expectDialogOpen(page, '#spoiler-warning-modal', false);
    await expectDialogOpen(page, '#folders-modal', true);
    expect(await page.evaluate((k) => localStorage.getItem(k), SPOILER_KEY)).toBe('true');
});

test('opens a mod folder and renders the manifest', async ({ page }) => {
    const errors = collectPageErrors(page);
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);

    // Editing mode replaces the read-only controls. The panel being there is the whole
    // of what the layout does about it -- the workspace is a flex row, so hiding it is
    // all viewing mode has to do. See toggleEditMode.
    await expect(page.locator('#manifest_panel')).not.toHaveClass(/hidden/);
    await expect(page.locator('#manifest_panel')).toBeVisible();

    // The manifest renders into its own panel rather than the main tree area.
    await expect(page.locator('#manifest_content_tree .file-window')).toHaveCount(1);
    expect(await alerts(page)).toEqual([]);
    expect(errors).toEqual([]);
});

test('manifest fileOrder entries become links that open the referenced file', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);

    // fileOrder holds 'REF:testcase'; the manifest panel turns each into a button.
    const fileLink = page.locator('#manifest_panel .files-order ul button');
    await expect(fileLink).toHaveCount(1);
    await expect(fileLink).toHaveText('testcase');

    await fileLink.click();

    // Referenced files open in the main tree area.
    const window_ = page.locator('#trees .file-window');
    await expect(window_).toHaveCount(1);
    await expect(window_).toHaveAttribute('path', 'testcase.sodso.json');

    // fileType renders as a disabled input rather than text, so assert its value.
    await expect(page.locator('#trees input').first()).toHaveValue('MurderMO');

    // The strongest signal that the type system resolved: copyFrom is typed as
    // MurderMO, so its dropdown is populated with real MurderMO asset names. Named
    // rather than "the select in this tree" -- booleans get a dropdown here too.
    await expect(page.locator(
        "#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"copyFrom\"')) select"
    ).first()).toContainText('ExCopSniper');
    expect(await alerts(page)).toEqual([]);
});

/**
 * A load order entry names a file with the part saying which kind of file it is left off,
 * and there are two kinds: `<stem>.sodso.json` for an asset the mod defines and
 * `<stem>.sodso_patch.json` for an override of a base game one. Every entry used to be
 * opened as the first, so an override in a load order -- which is what the New File
 * dialog's Override mode writes, and what it lists -- opened as a file that is not there.
 */
test('a manifest entry naming an override opens the override', async ({ page }) => {
    const errors = collectPageErrors(page);
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFixtureWithAssets);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    // `REF:ExCopSniper` in fileOrder; ExCopSniper.sodso_patch.json in the folder.
    await page.locator('#manifest_panel .files-order ul button')
        .filter({ hasText: 'ExCopSniper' }).click();

    const window_ = page.locator('#trees .file-window');
    await expect(window_).toHaveCount(1);
    await expect(window_).toHaveAttribute('path', 'ExCopSniper.sodso_patch.json');

    // Titled by the type the folder listing worked out for it, which is the other half of
    // what the entry does not say: a patch is a diff and need not state its own type.
    await expect(window_.locator('.doc-title h5')).toHaveText('MurderMO/ExCopSniper');

    expect(await alerts(page)).toEqual([]);
    expect(errors).toEqual([]);
});

/** A hand-written load order, and the one the case scaffolder used to write. */
const caseWithLowercasedOrder = {
    'Mods/TestCase/murdermanifest.sodso.json': JSON.stringify({
        enabled: true,
        fileOrder: ['REF:excopsniper'],
        loadBefore: '',
        version: 1,
    }, null, 2),
    'Mods/TestCase/ExCopSniper.sodso_patch.json': JSON.stringify({
        name: 'ExCopSniper', fileType: 'MurderMO',
    }, null, 2),
};

test('a manifest entry finds its file whatever case it is written in', async ({ page }) => {
    const errors = collectPageErrors(page);
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, caseWithLowercasedOrder);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    // Mods in the wild lowercase what they list, and the loader reads such an entry as
    // naming the file -- so `isListed` compares that way, and so does opening one.
    await page.locator('#manifest_panel .files-order ul button').click();

    await expect(page.locator('#trees .file-window'))
        .toHaveAttribute('path', 'ExCopSniper.sodso_patch.json');

    expect(await alerts(page)).toEqual([]);
    expect(errors).toEqual([]);
});

test('a manifest entry naming nothing in the folder says so', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, {
        ...soFixture,
        'Mods/TestCase/murdermanifest.sodso.json': JSON.stringify({
            enabled: true,
            fileOrder: ['REF:testcase', 'REF:Missing'],
            loadBefore: '',
            version: 1,
        }, null, 2),
    });
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await page.locator('#manifest_panel .files-order ul button')
        .filter({ hasText: 'Missing' }).click();

    // The load order names a file the mod does not have, which is worth saying rather
    // than opening nothing in silence.
    expect(await alerts(page)).toEqual([
        "Missing.sodso.json doesn't exist or is a vanilla asset - create it in the manifest first",
    ]);
    await expect(page.locator('#trees .file-window')).toHaveCount(0);
});

/**
 * The dropdown's search box leaves room for the icon Pico paints on it.
 *
 * select2 writes that box as `<input type="search">`, and Pico gives every one of those a
 * magnifier plus the `padding-inline-start` that keeps text clear of it. Two rules in this
 * flow's stylesheet used to overrule that with a `padding` shorthand, and a shorthand sets
 * all four sides: the inset went with it and every character typed ran under the icon.
 *
 * The second of those is the subtle one and the reason this is pinned rather than left to
 * review. These dropdowns are parented into `#trees`, so their search box is a `#trees
 * input` like any other, and `#trees input` out-specifies `[type=search]`. Anything added
 * to that rule later lands on this box too.
 */
test('the reference dropdown\'s search box starts after the search icon', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFixtureWithAssets);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');
    await page.locator('#manifest_panel .files-order ul button').first().click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    // Through compatibleWith, which is an array: its entries are a level down and are not
    // auto-expanded, so this covers the dropdown in the place it is hardest to reach.
    const reference = page.locator(
        "#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"compatibleWith\"'))"
    ).first();
    await reference.locator('.jsontree_expand-button').first().click();
    await reference.locator('.select2-selection').first().click();

    const box = await page.locator('#trees .select2-dropdown .select2-search__field').evaluate((field) => {
        const style = getComputedStyle(field);
        return { start: parseFloat(style.paddingInlineStart), icon: style.backgroundImage };
    });

    // Only meaningful if there is an icon to clear in the first place.
    expect(box.icon).toContain('svg');

    // Pico insets by the horizontal spacing plus 1.75rem; the icon is 1rem wide, 0.125rem
    // in. Anything at or below the icon's right edge puts text underneath it.
    expect(box.start).toBeGreaterThan(18);
});

/**
 * And so does every other search box this flow puts on screen.
 *
 * The rule above is one this app keeps breaking: Pico paints a magnifier onto
 * `[type=search]` and keeps typed text clear of it with `padding-inline-start`, and any
 * rule that sizes an input with a `padding` shorthand takes that inset with it. It has
 * happened to select2's box, to the room creator's and to the field summary's -- three
 * stylesheets, one mistake -- so this walks the boxes rather than pinning one of them.
 *
 * The fix each time is to size through Pico's own spacing variables, which leave the
 * start alone.
 */
const iconClearance = (page, selector) => page.locator(selector).evaluate((field) => {
    const style = getComputedStyle(field);

    return {
        hasIcon: style.backgroundImage.includes('svg'),
        // Where the text begins, and where the icon ends. Pico places the icon from the
        // left edge, so its far side is the offset plus its width.
        start: parseFloat(style.paddingInlineStart),
        iconEnds: parseFloat(style.backgroundPosition) + parseFloat(style.backgroundSize),
    };
});

test('every search box starts after the icon painted on it', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFixtureWithAssets);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    // The field summary's, which is drawn only once a field has been picked.
    await page.locator('#so-file-list .file-panel-entry[data-id="testcase"] .file-panel-open').click();
    await page.click('#tools-menu > summary');
    await page.locator('#tools-menu .browse-menu-item', { hasText: 'Summarise' }).click();
    await page.locator('#trees .jsontree_label[data-summary-path="presetName"]').click();
    await expect(page.locator('#field-summary-cancel')).toBeHidden();

    // Then the room creator's, and the file panel's, which is always there.
    await page.locator('#field-summary-modal .close-button').click();
    await page.getByRole('link', { name: 'Room Creator' }).click();
    await page.locator('#room-creator-modal .creator-step-label', { hasText: 'What goes in it' }).click();

    for (const selector of ['#so-file-search', '#field-summary-search', '#room-creator-search']) {
        const box = await iconClearance(page, selector);

        // Only meaningful where there is an icon to clear in the first place.
        expect(box.hasIcon, selector).toBe(true);
        expect(box.start, selector).toBeGreaterThan(box.iconEnds);
    }
});

/**
 * A reference field offers what the mod has of that type, before the base game's.
 *
 * `copyFrom` is typed as the document's own type, so on a MurderMO it points at another
 * MurderMO -- which makes it the one field that exercises every case at once. Until now
 * the only way to name your own asset here was "Custom…" and typing it, against a list of
 * every shipped MurderMO, none of which was the one you wanted.
 *
 * Read from the DOM rather than opened, since what the list holds is the whole of what is
 * being asked. The list is built the same for every reference field -- `compatibleWith`
 * below goes through it too -- and this is the only field whose type is the document's
 * own, which is what makes the document's exclusion of itself reachable at all.
 */
test('a reference field offers the mod\'s own assets of the same type first', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFixtureWithAssets);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await page.locator('#manifest_panel .files-order ul button').first().click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    const copyFrom = page.locator(
        "#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"copyFrom\"')) select"
    ).first();

    const shown = await copyFrom.evaluate((select) => ({
        sections: [...select.querySelectorAll('optgroup')].map((group) => group.label),
        modded: [...select.querySelectorAll('optgroup[label="Modded"] option')]
            .map((option) => option.text),
        vanilla: [...select.querySelectorAll('optgroup[label="Vanilla"] option')]
            .map((option) => option.text),
        // The entries that mean something other than an asset stay out of both.
        ungrouped: [...select.children].filter((child) => child.tagName === 'OPTION')
            .map((option) => option.text),
    }));

    expect(shown.sections).toEqual(['Modded', 'Vanilla']);

    // Not the document being edited: a file pointing at itself through copyFrom is a
    // cycle, and it is only in the list at all because the list comes from the folder
    // the file is in.
    expect(shown.modded).toEqual(['ExCopSniper', 'MyOtherMO']);
    expect(shown.modded).not.toContain('testcase');

    // Not in fileOrder, so the game never loads it and nothing offers it.
    expect(shown.modded).not.toContain('ForgottenMO');
    expect(shown.vanilla).not.toContain('ForgottenMO');

    // The patched one is in both. The name is the base game's and the values behind it
    // are the mod's, and showing it once under each is what says so.
    expect(shown.vanilla).toContain('ExCopSniper');

    expect(shown.ungrouped).toEqual(['Custom...', 'Nothing (null)']);

    // A field of a different type, on the same document. `SameName` is a MurderPreset
    // that calls itself `testcase` -- the same name as this document -- so it is offered
    // here and kept out of copyFrom above. Exclusion is by name and type together,
    // because a name on its own belongs to as many as six of the game's types.
    //
    // It is also offered as `testcase` rather than as `SameName`: a reference resolves
    // against the asset's `presetName`, not against what its file is called.
    const compatible = page.locator(
        "#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"compatibleWith\"')) select"
    ).first();

    expect(await compatible.evaluate((select) => [
        ...select.querySelectorAll('optgroup[label="Modded"] option'),
    ].map((option) => option.text))).toEqual(['testcase']);
});

test('picking one of the mod\'s own assets writes it as a reference', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFixtureWithAssets);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await page.locator('#manifest_panel .files-order ul button').first().click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    // Through compatibleWith, which holds MurderPresets, and whose mod-owned one is
    // `testcase` -- the one in SameName.sodso.json. Its entries are a level down, and
    // arrays of these are not auto-expanded, so this is the harder of the two paths to
    // the same control; copyFrom is picked from in its own test below.
    const row = page.locator(
        "#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"compatibleWith\"'))"
    ).first();

    await row.locator('.jsontree_expand-button').first().click();
    await row.locator('.select2-selection').first().click();
    await page.locator('.select2-search__field').pressSequentially('testcase');
    await page.locator('.select2-results__option--highlighted').click();

    // The mod's own assets carry a name rather than a position in the base game's list,
    // and this is what proves the two are told apart on the way to the file.
    await expect.poll(async () => JSON.parse(
        await readFile(page, CASE_FILE)).compatibleWith).toEqual(['REF:MurderPreset|testcase']);

    // And it comes back as that option rather than as "Custom: testcase", which is what
    // a name the base game's list does not have used to fall through to.
    await expect(row.locator('.select2-selection').first()).toHaveText('testcase');
});

/**
 * The baseline a file copies from, on the file itself.
 *
 * The New File dialog asks for it once, and for a while that was the only place it could be
 * answered: the row was hidden on the grounds that the question had been settled. It has
 * not been. Which asset the fields a file does not state for itself come from is a thing an
 * author changes their mind about, and a mod's own assets are mostly written after the file
 * that would want to copy from them.
 */

/** The mod's case, opened, with three more MurderMOs in the folder to point at. */
async function openCaseAmongAssets(page, extraFiles = {}) {
    await seedFs(page, { ...soFixtureWithAssets, ...extraFiles });
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');
    await page.locator('#manifest_panel .files-order ul button').first().click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);
}

/** The document's own copyFrom row, which is at the top level rather than in an array. */
const copyFromRow = (page) => page.locator(
    "#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"copyFrom\"'))"
).first();

test('the baseline a file copies from is re-pointed on the document', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseAmongAssets(page);

    const row = copyFromRow(page);
    await expect(row).toBeVisible();

    // Nothing to open yet, so nothing offers to: this fixture copies from nothing.
    const openBase = page.locator('#trees .jsontree-editor-bar-open-base-button');
    await expect(openBase).toBeHidden();

    await row.locator('.select2-selection').first().click();
    await page.locator('.select2-search__field').pressSequentially('MyOtherMO');
    await page.locator('.select2-results__option--highlighted').click();

    await expect
        .poll(async () => JSON.parse(await readFile(page, CASE_FILE)).copyFrom)
        .toBe('REF:MurderMO|MyOtherMO');

    // The editor bar is built once, when the file is opened, and used to go on describing
    // the document as it was then -- so a file that copied from nothing had no way to
    // reach the baseline it had just been given.
    await expect(openBase).toBeVisible();
    await openBase.click();

    // MyOtherMO.sodso.json, not MyOtherMO.MurderMO.sodso.json: a mod need not name its
    // files the way this app does, and the button used to look for the name it writes and
    // fall through to the base game's assets when the folder did not hold it.
    await expect(page.locator('#trees .file-window')).toHaveCount(2);
    await expect(page.locator('#trees .file-window').nth(1)).toHaveAttribute('path', 'MyOtherMO.sodso.json');

    expect(await alerts(page)).toEqual([]);
});

test('a file cannot be pointed at a baseline that copies from it', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    // MyOtherMO already copies from the document about to point at it, so the pair would
    // be a ring: two files each waiting on the other for the fields neither states.
    await openCaseAmongAssets(page, {
        'Mods/TestCase/MyOtherMO.sodso.json': JSON.stringify({
            fileType: 'MurderMO', name: 'MyOtherMO', presetName: 'MyOtherMO',
            copyFrom: 'REF:MurderMO|testcase',
        }),
    });

    const row = copyFromRow(page);
    await row.locator('.select2-selection').first().click();
    await page.locator('.select2-search__field').pressSequentially('MyOtherMO');
    await page.locator('.select2-results__option--highlighted').click();

    await expect
        .poll(async () => (await alerts(page)).length)
        .toBeGreaterThan(0);

    // Named the whole way round rather than just refused: which file closes the ring is
    // the only thing the author needs in order to fix it.
    expect((await alerts(page))[0]).toContain('testcase -> MyOtherMO -> testcase');

    // Refused rather than half-applied, and the control goes back to saying so.
    expect(JSON.parse(await readFile(page, CASE_FILE)).copyFrom).toBeNull();
    await expect(row.locator('.select2-selection').first()).toHaveText('Nothing (null)');
});

test('an override does not offer the base game asset\'s own baseline', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFixtureWithAssets);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await openOverride(page, 'ExCopSniper');

    // The document here is the base game's asset with the override applied, so copyFrom is
    // the shipped asset's rather than the mod's. What an override applies to is settled by
    // its file name -- see core/soFileName.js -- so a row here would be offering a decision
    // the loader does not read.
    await expect(copyFromRow(page)).toBeHidden();

    // Open Base still answers on a patch, where it opens what is being overridden.
    await expect(page.locator('#trees .jsontree-editor-bar-open-base-button')).toBeVisible();
});

test('renders object keys in file order, not sorted', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);
    await page.locator('#manifest_panel .files-order ul button').click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    // libs/jsonTree is shared with the DDS flow, which sorts keys. Fields here must
    // stay in the game's serialisation order. This pins jsonTree.configure options.
    const labels = await topLevelLabels(page, '#trees .file-window');

    expect(labels).toEqual(['fileType', 'name', 'presetName', 'notes', 'copyFrom', 'nested', 'MOleads']);
    expect(labels).not.toEqual([...labels].sort());

    // This flow separates values with '&nbsp;'; the DDS flow uses a literal comma.
    expect(await page.locator('#trees .file-window').innerHTML()).not.toContain('</span>,');
});

test('field labels carry their description, however deep the field is', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);
    await page.locator('#manifest_panel .files-order ul button').click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    const label = (name) => page.locator(
        `#trees .file-window .jsontree_label:text-is('"${name}"')`
    ).first();

    // Two levels: what we wrote about it, from refs/authored/fieldDescriptions.json.
    await expect(label('MOleads')).toHaveAttribute('title', /spawn with the murderer/);

    // Four levels -- MOleads[0].traitModifiers[0].mustPassForApplication. The lookup
    // this replaces resolved exactly one level of the path, threw on anything deeper,
    // and swallowed it: the field had no tooltip and nothing said why.
    await expect(label('mustPassForApplication'))
        .toHaveAttribute('title', /^Official description: If this isn't true/);

    // A field the game does not have gets no tooltip rather than an error.
    await expect(label('nested')).toHaveAttribute('title', '');
    expect(await alerts(page)).toEqual([]);
});

test('asset explorer lists ScriptableObject types', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    // The typeahead is select2 over a real <select>, and the options are on the element.
    // Two sections: what this tool ships assets for, then the types that need the author's
    // own export -- which is what the second is named after.
    const groups = page.locator('#asset-model-type-list optgroup');
    await expect(groups).toHaveCount(2);
    await expect(groups.first()).toHaveAttribute('label', 'Included');
    await expect(groups.last()).toHaveAttribute('label', 'Exported');

    const shipped = groups.first().locator('option');
    expect(await shipped.count()).toBeGreaterThan(1);
    expect(await page.evaluate(() => window.onlineTypes))
        .toContain(await shipped.first().textContent());

    // The New File dialog offers the same types. It used to hold a copy of this list's
    // markup, taken at startup; both are filled from the type map now.
    await expect(page.locator('#new-file-modal-file-type option'))
        .toHaveCount(await page.locator('#asset-model-type-list optgroup option').count());
});

test('with no type chosen the asset list searches every type by name', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    // Browsing needs no folder, and the folder dialog is over the menu until dismissed.
    await page.locator('#folders-continue').click();
    await page.getByRole('link', { name: 'Asset Explorer' }).click();
    await page.locator('#asset-explorer-modal .select2-selection').nth(1).click();

    // Nothing until enough has been typed. The list is over five thousand rows and
    // select2 renders every match at once, so the empty search it opens on matches none.
    await expect(page.locator('.select2-results__message')).toContainText('2 or more');
    await expect(page.locator('.select2-results__option[role="option"]')).toHaveCount(0);

    await page.locator('.select2-search__field').pressSequentially('Hitman');

    // Under a heading naming the type it belongs to, which is the only thing saying which
    // asset a row is: six hundred of these names are carried by more than one type.
    await expect(page.locator('.select2-results__group:text-is("MurderMO")')).toBeVisible();

    await page.locator('.select2-results__option:text-is("Hitman")').first().click();

    // Opened as that type's, without the type ever having been named.
    await expect(page.locator('#trees .file-window .doc-title h5')).toHaveText('MurderMO/Hitman');
});

test('an asset this tool does not ship says what would open it', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    await page.locator('#folders-continue').click();
    await page.getByRole('link', { name: 'Asset Explorer' }).click();

    // Nine of the game's seventy-nine types ship with this tool and every one of them is
    // named, so most of what the every-type list offers needs the author's own export.
    // RoomClassPreset is one of the seventy.
    await page.locator('#asset-explorer-modal .select2-selection').nth(1).click();
    await page.locator('.select2-search__field').pressSequentially('AsianEatery');
    await page.locator('.select2-results__group:text-is("RoomClassPreset")')
        .locator('~ ul .select2-results__option').first().click();

    // Said in the dialog, naming the folder that fixes it. It used to be attempted anyway:
    // a fetch that 404ed, and an alert to dismiss for a row already known not to open.
    await expect(page.locator('#asset-explorer-note'))
        .toHaveText('Connect your exported ScriptableObjects folder under Folders');
    await expect(page.locator('#trees .file-window')).toHaveCount(0);
    expect(await alerts(page)).toEqual([]);

    // And it goes away again when something does open.
    await pickInAssetExplorer(page, 0, 'MurderMO');
    await pickInAssetExplorer(page, 1, 'Hitman');

    await expect(page.locator('#asset-explorer-note')).toBeHidden();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);
});

test('clearing the type goes back to searching every type', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    await page.locator('#folders-continue').click();
    await page.getByRole('link', { name: 'Asset Explorer' }).click();
    await pickInAssetExplorer(page, 0, 'MurderMO');

    // One type's assets are listed whole, with no minimum to type first.
    await page.locator('#asset-explorer-modal .select2-selection').nth(1).click();
    await expect(page.locator('.select2-results__option:text-is("Hitman")')).toBeVisible();
    await page.locator('.select2-search__field').press('Escape');

    // The `×` is the only way back to no type at all, and without it searching every
    // type would be reachable only on the dialog's first open.
    await page.locator('#asset-model-type-list ~ .select2-container .select2-selection__clear').click();

    // And it stops there. select2 reopens the list it just emptied, which would land on
    // top of the picker the clearing was done to reach.
    await expect(page.locator('.select2-container--open')).toHaveCount(0);

    await page.locator('#asset-explorer-modal .select2-selection').nth(1).click();
    await expect(page.locator('.select2-results__message')).toContainText('2 or more');
});

test('assets can be browsed with no folders connected', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    // Browsing reads from the online asset data, so it must not require a folder.
    await page.locator('#folders-continue').click();
    await page.getByRole('link', { name: 'Asset Explorer' }).click();

    await expect(page.locator('#asset-explorer-modal')).toBeVisible();

    await pickInAssetExplorer(page, 0, 'MurderMO');

    // And the assets of that type are there to search, with nothing connected.
    await page.locator('#asset-explorer-modal .select2-selection').nth(1).click();
    await expect(page.locator('.select2-results__option:text-is("Hitman")')).toBeVisible();
    await page.locator('.select2-search__field').press('Escape');

    expect(await page.evaluate(() => window.dirHandleModDir ?? null)).toBeNull();
});

test('connecting the export from the folders modal opens the rest of the types', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, { 'ExportedSOs/.keep': '' });

    await page.locator('#folders-continue').click();
    await page.getByRole('link', { name: 'Asset Explorer' }).click();

    // Two halves with nothing connected: the nine types this tool ships assets for open,
    // and the other seventy are there to read by name.
    await page.locator('#asset-explorer-modal .select2-selection').first().click();
    await expect(page.locator('.select2-results__group:text-is("Exported")')).toBeVisible();
    await page.locator('.select2-search__field').press('Escape');

    // Nothing in this dialog connects that folder any more -- only the close button is left.
    await expect(page.locator('#asset-explorer-modal button')).toHaveCount(1);

    await page.locator('#asset-explorer-modal').getByLabel('Close').click();

    await page.locator('#folders-open').click();
    await connectFolders(page, { exportedSOs: 'ExportedSOs' });

    // The export holds every type, so the split it was divided by is gone and each of the
    // seventy is now a type that opens. Without the dialog having been asked to catch up.
    await page.getByRole('link', { name: 'Asset Explorer' }).click();
    await page.locator('#asset-explorer-modal .select2-selection').first().click();
    await page.locator('.select2-search__field').pressSequentially('RoomClassPreset');
    await expect(page.locator('.select2-results__group')).toHaveCount(0);
    await expect(page.locator('.select2-results__option:text-is("RoomClassPreset")')).toBeVisible();
});

/** Open the mod and the case file it references. */
async function openCaseFile(page) {
    await openMod(page);
    await page.locator('#manifest_panel .files-order ul button').click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);
}

/** The <input> rendered for a given top-level field. */
const fieldInput = (page, label) =>
    page.locator(`#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"${label}"')) input`).first();

/** The box typed into to search, which lives in the open dropdown rather than the control. */
const dropdownSearch = (page, within = '#trees') =>
    page.locator(`${within} .select2-search__field`);

test('opening a reference dropdown puts the cursor in its search box', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    await fieldRow(page, 'copyFrom').locator('.select2-selection').click();

    // Typed without clicking into the box first, which is the whole of what is being
    // asserted: opening the list is what should have put the cursor there. select2 tries
    // to do this itself and cannot -- the jQuery this app pins breaks its way of asking --
    // so every character went nowhere and searching took a second click into a box that
    // already looked ready. See searchSelect.
    await page.keyboard.type('Hit');

    await expect(dropdownSearch(page)).toHaveValue('Hit');
    await expect(page.locator('#trees .select2-results__option:text-is("Hitman")')).toBeVisible();
});

test('reopening a reference dropdown keeps the term it was searched with', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    const control = fieldRow(page, 'copyFrom').locator('.select2-selection');
    const search = dropdownSearch(page);

    await control.click();
    await page.keyboard.type('Hit');
    await search.press('Escape');

    await control.click();
    await expect(search).toHaveValue('Hit');

    // Filtered, not merely written back: the list has to be the one the term describes,
    // or the box says one thing and the rows below it another.
    await expect(page.locator('#trees .select2-results__option:text-is("Hitman")')).toBeVisible();

    // And selected, so starting again costs one keystroke rather than three backspaces.
    expect(await search.evaluate((box) => [box.selectionStart, box.selectionEnd])).toEqual([0, 3]);

    await page.keyboard.type('Cop');
    await expect(search).toHaveValue('Cop');
});

test('a reference dropdown keeps its term across the rebuild an edit causes', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    const control = () => fieldRow(page, 'copyFrom').locator('.select2-selection');
    const search = dropdownSearch(page);

    await control().click();
    await page.keyboard.type('Hit');
    await search.press('Escape');

    // Editing anything reloads the whole document -- see core/document.js -- so every
    // control in it is thrown away and built again, this one included. A term held on
    // the control would survive closing the list and be lost by an edit to an unrelated
    // field, which is the same gesture giving two answers.
    await fieldInput(page, 'notes').fill('edited by test');
    await fieldInput(page, 'notes').blur();
    await expect.poll(async () => JSON.parse(await readFile(page, CASE_FILE)).notes)
        .toBe('edited by test');

    await control().click();
    await expect(search).toHaveValue('Hit');
});

test('each list in the asset explorer remembers its own term', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    await page.locator('#folders-continue').click();
    await page.getByRole('link', { name: 'Asset Explorer' }).click();

    const picker = (index) => page.locator('#asset-explorer-modal .select2-selection').nth(index);
    const search = dropdownSearch(page, '#asset-explorer-modal');

    await picker(0).click();
    await page.keyboard.type('Murder');
    await search.press('Escape');

    // The assets below are a different question from the types above, so the term asked
    // of one is not put to the other.
    await picker(1).click();
    await expect(search).toHaveValue('');

    await page.keyboard.type('Hitman');
    await search.press('Escape');

    await picker(0).click();
    await expect(search).toHaveValue('Murder');
    await search.press('Escape');

    await picker(1).click();
    await expect(search).toHaveValue('Hitman');
    await search.press('Escape');

    // Choosing a type rebuilds the list below it, and a type's assets are not the list
    // that was searched: 'Hitman' was asked of every type at once. Carried over, it would
    // open a freshly chosen type already filtered to nothing.
    await pickInAssetExplorer(page, 0, 'MurderMO');
    await picker(1).click();
    await expect(search).toHaveValue('');
});

test('editing a value writes the whole file back', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    // Values are committed on blur, not on keystroke.
    await fieldInput(page, 'notes').fill('edited by test');
    await fieldInput(page, 'notes').blur();

    await expect.poll(async () => JSON.parse(await readFile(page, CASE_FILE)).notes)
        .toBe('edited by test');

    // This flow saves whole files, so everything else must survive round-tripping.
    const saved = JSON.parse(await readFile(page, CASE_FILE));
    expect(saved.fileType).toBe('MurderMO');
    expect(saved.nested).toEqual({ alpha: 'a', beta: 'b' });
    expect(await alerts(page)).toEqual([]);
});

test('a value that will not parse comes back to be corrected', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    // A quotation mark inside a line is enough: values are stored as JSON, and the
    // quoting on the way in does not escape one. This used to throw out of the blur
    // handler, losing the edit without saying so.
    await queuePrompts(page, ['he said hi']);
    await fieldInput(page, 'notes').fill('he said "hi"');
    await fieldInput(page, 'notes').blur();

    await expect.poll(async () => JSON.parse(await readFile(page, CASE_FILE)).notes)
        .toBe('he said hi');

    const [asked] = await prompts(page);
    expect(asked.defaultValue).toBe('he said "hi"');
    expect(await alerts(page)).toEqual([]);
});

test('cancelling the correction leaves the field as it was', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    // Nothing queued, so the prompt is cancelled.
    await fieldInput(page, 'notes').fill('he said "hi"');
    await fieldInput(page, 'notes').blur();

    await expect(fieldInput(page, 'notes')).toHaveValue('fixture');
    expect(JSON.parse(await readFile(page, CASE_FILE)).notes).toBe('fixture');
});

/**
 * An asset states its identity three times over: `presetName` is what it is called,
 * `name` repeats it, and its file is named after it too. `presetName` is the one that is
 * edited; the other two follow it, and nothing else is allowed to move them apart.
 */

const MANIFEST_FILE = 'Mods/TestCase/murdermanifest.sodso.json';
const RENAMED_FILE = 'Mods/TestCase/Renamed.MurderMO.sodso.json';

/** The row a top-level field is rendered in, shown or not. */
const fieldRow = (page, label) =>
    page.locator(`#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"${label}"'))`).first();

test('a preset shows no name field, and it follows presetName', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    // Still written to the file -- it is one of the places the game reads the asset's
    // name from -- but it says nothing presetName does not, so there is nothing in it
    // to show and nothing to decide.
    await expect(fieldRow(page, 'name')).toBeAttached();
    await expect(fieldRow(page, 'name')).not.toBeVisible();
    await expect(fieldRow(page, 'presetName')).toBeVisible();

    await fieldInput(page, 'presetName').fill('Renamed');
    await fieldInput(page, 'presetName').blur();

    await expect.poll(async () => JSON.parse(await readFile(page, RENAMED_FILE))?.name).toBe('Renamed');
    expect(JSON.parse(await readFile(page, RENAMED_FILE)).presetName).toBe('Renamed');
    expect(await alerts(page)).toEqual([]);
});

test('renaming a preset renames its file and the manifest entry with it', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    await fieldInput(page, 'presetName').fill('Renamed');
    await fieldInput(page, 'presetName').blur();

    await expect.poll(() => readFile(page, RENAMED_FILE)).not.toBeNull();

    // The old file goes: two files claiming to be the same preset is a mod with a
    // duplicate in it, and nothing saying which one the loader takes.
    expect(await readFile(page, CASE_FILE)).toBeNull();

    // A file the manifest still names by its old name is one the loader goes looking
    // for and does not find, which is a case that is simply not in the game.
    expect(JSON.parse(await readFile(page, MANIFEST_FILE)).fileOrder).toEqual(['REF:Renamed.MurderMO']);

    // Everything naming the file comes with it, rather than being left pointing at a
    // file that is gone: the window it is open in, and both panels.
    await expect(page.locator('#trees .file-window')).toHaveAttribute('path', 'Renamed.MurderMO.sodso.json');
    await expect(page.locator('#manifest_panel .files-order ul button')).toHaveText(['Renamed.MurderMO']);
    await expect(page.locator('#so-file-list')).toContainText('Renamed');
    expect(await alerts(page)).toEqual([]);
});

test('a renamed preset can still be closed', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    await fieldInput(page, 'presetName').fill('Renamed');
    await fieldInput(page, 'presetName').blur();

    await expect(page.locator('#trees .file-window')).toHaveAttribute('path', 'Renamed.MurderMO.sodso.json');

    // The window is renamed along with the file, so Close cannot go looking for the
    // one the document was opened as: that window answers to a different name now,
    // and a document that will not close is one the author is stuck with.
    await page.locator('#trees .file-window').getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#trees .file-window')).toHaveCount(0);
    expect(await alerts(page)).toEqual([]);
});

test('a preset name no file could be called is refused', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    // Not quietly corrected to "MyCase": the name is about to become a file name and an
    // entry in the load order, and editing it behind the author's back would leave them
    // reading one name while the mod uses another.
    await fieldInput(page, 'presetName').fill('My Case!');
    await fieldInput(page, 'presetName').blur();

    await expect(fieldInput(page, 'presetName')).toHaveValue('testcase');
    expect(await alerts(page)).toHaveLength(1);

    expect(JSON.parse(await readFile(page, CASE_FILE)).presetName).toBe('testcase');
    expect(JSON.parse(await readFile(page, CASE_FILE)).name).toBe('testcase');
    expect(await listDir(page, 'Mods/TestCase')).toContain('testcase.sodso.json');
});

/**
 * Renaming an asset something else in the mod points at.
 *
 * A `REF:` resolves against `presetName`, and a rename follows that name through the file
 * and through the load order and through nothing else. The other documents are left naming
 * an asset that has gone, which is the same break deleting the file would cause -- and the
 * panel has warned about that one all along.
 */

const STYLE_FILE = 'Mods/TestCase/HouseStyle.sodso.json';
const RENAMED_STYLE_FILE = 'Mods/TestCase/TowerStyle.DesignStylePreset.sodso.json';

/** Open HouseStyle, which the case points at through `denStyleOverride`. */
async function openReferencedAsset(page) {
    await seedFs(page, caseWithCustomReference);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await page.locator('#so-file-list .file-panel-entry[data-id="HouseStyle"] .file-panel-open').click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);
}

test('renaming an asset another file points at says what will be left behind', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openReferencedAsset(page);

    await fieldInput(page, 'presetName').fill('TowerStyle');
    await fieldInput(page, 'presetName').blur();

    await expect.poll(async () => (await confirms(page)).length).toBeGreaterThan(0);
    const asked = (await confirms(page)).at(-1);

    expect(asked).toContain('Rename "HouseStyle" to "TowerStyle"?');
    expect(asked).toContain('Referenced by 1 file:');
    expect(asked).toContain('testcase');

    // And says which half of the job it is about to do, because it does do half of it.
    expect(asked).toContain("This mod's load order will follow the new name");

    // The harness answers yes, so the rename goes ahead: the file moves, and the reference
    // is left exactly as its author wrote it for them to deal with.
    await expect.poll(() => readFile(page, RENAMED_STYLE_FILE)).not.toBeNull();
    expect(JSON.parse(await readFile(page, 'Mods/TestCase/testcase.sodso.json')).denStyleOverride)
        .toEqual(['REF:DesignStylePreset|HouseStyle']);
    expect(await alerts(page)).toEqual([]);
});

test('saying no leaves the name, the file and the reference alone', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openReferencedAsset(page);

    await queueConfirms(page, [false]);

    await fieldInput(page, 'presetName').fill('TowerStyle');
    await fieldInput(page, 'presetName').blur();

    // The field goes back to what it said. A rename that was declined should not leave the
    // author reading a name their mod does not use.
    await expect(fieldInput(page, 'presetName')).toHaveValue('HouseStyle');

    expect(JSON.parse(await readFile(page, STYLE_FILE)).presetName).toBe('HouseStyle');
    expect(await listDir(page, 'Mods/TestCase')).not.toContain('TowerStyle.DesignStylePreset.sodso.json');
    expect(JSON.parse(await readFile(page, 'Mods/TestCase/testcase.sodso.json')).denStyleOverride)
        .toEqual(['REF:DesignStylePreset|HouseStyle']);
});

test('an asset nothing points at is renamed without a question', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    // Unlike a deletion, which asks either way. Renaming is ordinary editing and it undoes
    // itself, so a box with an empty list in it is a click that carries no information.
    await fieldInput(page, 'presetName').fill('Renamed');
    await fieldInput(page, 'presetName').blur();

    await expect.poll(() => readFile(page, RENAMED_FILE)).not.toBeNull();
    expect(await confirms(page)).toEqual([]);
});

/**
 * A rename lands on a name rather than on a file, and a name can be spelled two ways:
 * `Taken.MurderMO.sodso.json` is what this app writes, `Taken.sodso.json` is what a mod
 * written before the type joined the file name holds. Either one is another asset of that
 * name, and neither is a file this may land on top of.
 */
for (const [spelling, file] of [
    ['already', 'Mods/TestCase/Taken.MurderMO.sodso.json'],
    ['under the older file name', 'Mods/TestCase/Taken.sodso.json'],
]) {
    test(`renaming onto a name the mod uses ${spelling} keeps both files`, async ({ page }) => {
        await skipSpoilerWarning(page);
        await gotoFlow(page, '?flow=scriptableObject');
        await openCaseFile(page);
        await writeFixture(page, file,
            JSON.stringify({ fileType: 'MurderMO', name: 'Taken', presetName: 'Taken', notes: 'not mine' }));

        await fieldInput(page, 'presetName').fill('Taken');
        await fieldInput(page, 'presetName').blur();

        await expect.poll(() => alerts(page)).toHaveLength(1);

        // The other asset is untouched: overwriting one because a field was edited is not a
        // rename, and the file it would have taken is somebody else's.
        expect(JSON.parse(await readFile(page, file)).notes).toBe('not mine');

        // The edit itself is not lost -- it is saved where the preset already lives -- and
        // the manifest still names the file that is actually there.
        const kept = JSON.parse(await readFile(page, CASE_FILE));
        expect(kept.presetName).toBe('Taken');
        expect(kept.name).toBe('Taken');
        expect(JSON.parse(await readFile(page, MANIFEST_FILE)).fileOrder).toEqual(['REF:testcase']);
    });
}

test('renaming onto a name another type uses is not a collision at all', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    // An EvidencePreset called Taken, under the older file name -- so the only thing
    // saying it is not this MurderMO's file is what is inside it. Refusing here would
    // hand back the problem the type in the file name was added to solve.
    await writeFixture(page, 'Mods/TestCase/Taken.sodso.json',
        JSON.stringify({ fileType: 'EvidencePreset', name: 'Taken', presetName: 'Taken', notes: 'not mine' }));

    await fieldInput(page, 'presetName').fill('Taken');
    await fieldInput(page, 'presetName').blur();

    await expect.poll(() => readFile(page, 'Mods/TestCase/Taken.MurderMO.sodso.json')).not.toBeNull();
    expect(await readFile(page, CASE_FILE)).toBeNull();

    // Both assets are in the mod, each in its own file, and the evidence is as it was.
    expect(JSON.parse(await readFile(page, 'Mods/TestCase/Taken.sodso.json')).notes).toBe('not mine');
    expect(JSON.parse(await readFile(page, MANIFEST_FILE)).fileOrder).toEqual(['REF:Taken.MurderMO']);
    expect(await alerts(page)).toEqual([]);
});

/**
 * Overrides of the base game's assets.
 *
 * A patch used to be a partial file -- the fields it named were written over the asset and
 * nothing else was touched -- and it is now a list of changes to make to that asset, which
 * the loader applies before deserialising. See flows/scriptableObject/scripts/patchFormat.js.
 *
 * That turns the editor inside out. The document on screen is the base game's asset, in
 * full; the file holds the difference between what is on screen and what the game ships.
 * None of that is the author's to think about, so what is pinned here is mostly that it
 * stays invisible: they open an asset, change a field, and the file says one thing.
 */

/** Open the mod's override of a base game asset, whatever format it is stored in. */
async function openOverride(page, asset) {
    await page.locator(`#so-file-list .file-panel-entry[data-id="${asset}"] .file-panel-open`).click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);
}

/** A folder holding overrides, opened. */
async function openFolderWithOverrides(page) {
    await seedFs(page, soFolderContent);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');
}

/**
 * The case fixture with one more file in it, opened.
 *
 * Seeded rather than written afterwards, because the file panel is built when the content
 * folder is chosen and a file that appears behind it is one nothing lists.
 */
async function openModHolding(page, path, contents) {
    await seedFs(page, { ...soFixture, [path]: JSON.stringify(contents) });
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');
}

/** An override of a shipped MurderMO with nothing overridden yet, as this app writes one. */
const EMPTY_OVERRIDE = { name: 'Hitman', fileType: 'MurderMO', patches: [] };
const OVERRIDE_FILE = 'Mods/TestCase/Hitman.sodso_patch.json';

test('an override is edited as the asset it overrides, not as the file on disk', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openFolderWithOverrides(page);

    await openOverride(page, 'ExCopSniper');

    // The whole of the base game's MurderMO, including fields the patch has never
    // mentioned -- there is no editing a difference without the thing it differs from.
    await expect(fieldRow(page, 'presetName')).toBeVisible();
    await expect(fieldInput(page, 'presetName')).toHaveValue('ExCopSniper');
    await expect(fieldRow(page, 'baseDifficulty')).toBeVisible();

    // And what the file itself is made of is nowhere on screen. `patches` is machinery.
    await expect(fieldRow(page, 'patches')).toHaveCount(0);
    await expect(fieldRow(page, 'fileType')).toHaveCount(0);
});

test('an override of an asset this tool cannot read says so rather than opening empty', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openFolderWithOverrides(page);

    // Bar is an AddressPreset, which is not one of the nine types this tool ships assets
    // for, and no exported ScriptableObjects folder is connected. This is the capability
    // the format costs: an override is a difference, and there is nothing here to differ
    // from. The old format needed no reference data at all.
    await page.locator('#so-file-list .file-panel-entry[data-id="Bar"] .file-panel-open').click();

    // Polled, not read once: reading the asset is a fetch, so the refusal arrives a turn
    // after the click and a window that is not there yet looks exactly like one that is
    // never going to be.
    await expect
        .poll(() => alerts(page))
        .toEqual([expect.stringContaining('exported ScriptableObjects folder')]);
    await expect(page.locator('#trees .file-window')).toHaveCount(0);
});

test('an override nobody has touched saves as no changes at all', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    // The single assertion that catches every infidelity on the way in: if anything is
    // lost or rewritten between the asset on disk and the document on screen, it comes
    // back here as a change nobody made. Unmapped references were exactly that.
    await openModHolding(page, OVERRIDE_FILE, EMPTY_OVERRIDE);
    await openOverride(page, 'Hitman');

    await page.locator('#trees .file-window').getByRole('button', { name: 'Save' }).click();

    await expect.poll(async () => JSON.parse(await readFile(page, OVERRIDE_FILE))).toEqual(EMPTY_OVERRIDE);
    expect(await alerts(page)).toEqual([]);
});

test('editing a field in an override writes the one change it is', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openModHolding(page, OVERRIDE_FILE, EMPTY_OVERRIDE);
    await openOverride(page, 'Hitman');

    await fieldInput(page, 'notes').fill('Rewritten by the mod');
    await fieldInput(page, 'notes').blur();

    // One operation, against the field that changed. Everything else the asset holds is
    // simply not mentioned, which is what makes a patch survive a game update.
    await expect
        .poll(async () => JSON.parse(await readFile(page, OVERRIDE_FILE)).patches)
        .toEqual([{ op: 'replace', path: '/notes', value: 'Rewritten by the mod' }]);
});

test('an override in the older format is converted on save, and its author is told first', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openFolderWithOverrides(page);

    // ExCopSniper.sodso_patch.json is `{ notes: 'x' }`: the old whole-field format, which
    // the loader still reads and this editor no longer writes.
    await openOverride(page, 'ExCopSniper');

    // Opening it is where that is said. Saving is what does it, and with autosave on
    // that is the next keystroke -- too late to be a warning.
    expect((await confirms(page)).join('\n')).toContain('older format');

    // The field the old file set is on screen as the asset's value, and editing another
    // one leaves both in the converted file.
    await expect(fieldInput(page, 'notes')).toHaveValue('x');
    await fieldInput(page, 'baseDifficulty').fill('9');
    await fieldInput(page, 'baseDifficulty').blur();

    await expect
        .poll(async () => JSON.parse(await readFile(page, 'Mods/TestCase/ExCopSniper.sodso_patch.json')))
        .toEqual({
            name: 'ExCopSniper',
            fileType: 'MurderMO',
            patches: expect.arrayContaining([
                { op: 'replace', path: '/notes', value: 'x' },
                { op: 'replace', path: '/baseDifficulty', value: 9 },
            ]),
        });
});

/**
 * The field selector, which asks a different question of each kind of file the mod owns.
 *
 * On one of the mod's own files it is which fields the file states, the rest being taken
 * from whatever it copies from. On an override it is which fields the file changes about
 * the base game's asset -- and since an override is nothing but those changes, turning one
 * off is how a change is taken back out.
 */

/** Open the field selector on the document that is showing. */
async function openFieldSelector(page, within = '#trees .file-window') {
    await page.locator(within).getByRole('button', { name: 'Select Override Fields' }).click();
    await expectDialogOpen(page, '#select-fields-modal', true);
}

/** The list's checkbox for one field. */
const fieldSelectorBox = (page, field) =>
    page.locator(`#select-fields-modal-field-list input[type="checkbox"][value="${field}"]`);

/** Every field the selector is currently listing. */
const listedFields = (page) =>
    page.locator('#select-fields-modal-field-list input[type="checkbox"]')
        .evaluateAll((boxes) => boxes.map((box) => box.value));

test('an override and one of the mod\'s own files both offer a field selector', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openFolderWithOverrides(page);

    await openOverride(page, 'ExCopSniper');
    await expect(page.locator('#trees .file-window').getByRole('button', { name: 'Select Override Fields' }))
        .toHaveCount(1);

    // What it states is what it overrides of whatever it copies from, so which fields it
    // carries is a choice of the same kind.
    await page.locator('#so-file-list .file-panel-entry[data-id="IP_Note"] .file-panel-open').click();
    await expect(page.locator('#trees .file-window[path="IP_Note.sodso.json"]')
        .getByRole('button', { name: 'Select Override Fields' })).toHaveCount(1);
});

test('an override lists the fields it changes, and only those', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openModHolding(page, OVERRIDE_FILE, {
        ...EMPTY_OVERRIDE,
        patches: [{ op: 'replace', path: '/notes', value: 'Rewritten by the mod' }],
    });
    await openOverride(page, 'Hitman');

    await openFieldSelector(page);

    // One field, selected -- not the forty-odd a MurderMO has. The document on screen is
    // the whole asset; the file is this.
    expect(await listedFields(page)).toEqual(['notes']);
    await expect(fieldSelectorBox(page, 'notes')).toBeChecked();
});

test('unselecting a field in an override takes its change back out', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openModHolding(page, OVERRIDE_FILE, EMPTY_OVERRIDE);
    await openOverride(page, 'Hitman');

    // What the game ships, which is what the field is about to go back to.
    const shipped = await fieldInput(page, 'notes').inputValue();
    expect(shipped).not.toBe('');

    await fieldInput(page, 'notes').fill('Rewritten by the mod');
    await fieldInput(page, 'notes').blur();

    await expect
        .poll(async () => JSON.parse(await readFile(page, OVERRIDE_FILE)).patches)
        .toEqual([{ op: 'replace', path: '/notes', value: 'Rewritten by the mod' }]);

    await openFieldSelector(page);
    await fieldSelectorBox(page, 'notes').uncheck();
    await page.locator('#select-fields-submit-button').click();
    await expectDialogOpen(page, '#select-fields-modal', false);

    // The file overrides nothing again -- not a change back to the base game's value,
    // which would still be a change -- and the document says what the asset says.
    await expect
        .poll(async () => JSON.parse(await readFile(page, OVERRIDE_FILE)).patches)
        .toEqual([]);
    await expect(fieldInput(page, 'notes')).toHaveValue(shipped);

    // And the selector agrees, rather than still listing what was just dropped.
    await openFieldSelector(page);
    expect(await listedFields(page)).toEqual([]);
    await expect(page.locator('#select-fields-modal-empty')).toHaveText(/does not change anything/);
});

test('a field an override adds is dropped by removing it, not by writing a value back', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    // A key the base game's MurderMO does not carry at all, which the loader would add to
    // the asset. There is no shipped value to restore, so unselecting it has to take the
    // key away -- and what is written is then an override with nothing in it.
    await openModHolding(page, OVERRIDE_FILE, {
        ...EMPTY_OVERRIDE,
        patches: [{ op: 'add', path: '/modOnlyField', value: 'x' }],
    });
    await openOverride(page, 'Hitman');

    await openFieldSelector(page);
    expect(await listedFields(page)).toEqual(['modOnlyField']);

    await fieldSelectorBox(page, 'modOnlyField').uncheck();
    await page.locator('#select-fields-submit-button').click();

    await expect
        .poll(async () => JSON.parse(await readFile(page, OVERRIDE_FILE)).patches)
        .toEqual([]);
    await expect(fieldRow(page, 'modOnlyField')).toHaveCount(0);
});

test('(De)Select all empties an override in one go', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openModHolding(page, OVERRIDE_FILE, {
        ...EMPTY_OVERRIDE,
        patches: [
            { op: 'replace', path: '/notes', value: 'Rewritten by the mod' },
            { op: 'replace', path: '/baseDifficulty', value: 9 },
        ],
    });
    await openOverride(page, 'Hitman');

    await openFieldSelector(page);
    expect((await listedFields(page)).sort()).toEqual(['baseDifficulty', 'notes']);

    // Every box starts selected, so the control starts checked and one click clears it.
    await expect(page.locator('#select-fields-modal-select-all')).toBeChecked();
    await page.locator('#select-fields-modal-select-all').uncheck();
    await page.locator('#select-fields-submit-button').click();

    await expect
        .poll(async () => JSON.parse(await readFile(page, OVERRIDE_FILE)).patches)
        .toEqual([]);
});

test('a type with no readable asset cannot be overridden from the new file dialog', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);

    await openNewFileDialog(page);
    await page.getByRole('button', { name: 'Override', exact: true }).click();

    // AddressPreset is a type the game has and this tool ships no assets for.
    await page.selectOption('#new-file-modal-file-type', 'AddressPreset');
    await page.selectOption('#new-file-modal-copy-from', await firstCopyFromOption(page));

    // Said in the dialog rather than left to a disabled button with a tooltip: the
    // author has chosen a real asset and nothing about the screen would explain the
    // refusal.
    await expect(page.locator('#new-file-modal-submit')).toBeDisabled();
    await expect(page.locator('#new-file-modal-note')).toContainText('exported ScriptableObjects folder');

    // A type it does ship is unaffected.
    await page.selectOption('#new-file-modal-file-type', 'MurderMO');
    await page.selectOption('#new-file-modal-copy-from', await firstCopyFromOption(page));
    await expect(page.locator('#new-file-modal-submit')).toBeEnabled();
});

/** The ➥ that opens whatever a given field references. */
const openTarget = (page, label) =>
    page.locator(`#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"${label}"')) .open-target`).first();

/** Open a case whose fields reference assets in both of the places they can live. */
async function openCaseWithReferences(page) {
    await seedFs(page, caseWithCustomReference);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');
    await page.locator('#manifest_panel .files-order ul button').click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);
}

test('a reference to the mod\'s own asset opens it', async ({ page }) => {
    const errors = collectPageErrors(page);
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseWithReferences(page);

    // Its entries are a level down, and arrays of these are not auto-expanded.
    await page.locator("#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"denStyleOverride\"'))")
        .first().locator('.jsontree_expand-button').first().click();

    // denStyleOverride names a DesignStylePreset the base game has never heard of, so
    // the dropdown shows it as Custom and offers a way through to the file itself.
    // That ➥ called three functions the module never imported, so it could only throw.
    await openTarget(page, 'denStyleOverride').click();

    await expect(page.locator('#trees .file-window')).toHaveCount(2);
    await expect(page.locator('#trees')).toContainText('HouseStyle');
    expect(errors).toEqual([]);
    expect(await alerts(page)).toEqual([]);
});

/**
 * Two of the mod's own assets called `Bar`, differing only by type, and stored under the
 * typed file names this app now writes -- `<name>.<type>.sodso.json`.
 *
 * Both halves matter. The reference carries a name and a type, and the file is named
 * after both, so resolving it by name alone finds either the wrong one or none at all.
 */
const caseWithSameNamedAssets = {
    'Mods/TestCase/murdermanifest.sodso.json': JSON.stringify({
        enabled: true,
        fileOrder: ['REF:testcase.MurderMO', 'REF:Bar.DesignStylePreset', 'REF:Bar.MurderPreset'],
        loadBefore: '',
        version: 1,
    }, null, 2),
    'Mods/TestCase/testcase.MurderMO.sodso.json': JSON.stringify({
        fileType: 'MurderMO',
        name: 'testcase',
        presetName: 'testcase',
        denStyleOverride: ['REF:DesignStylePreset|Bar'],
    }, null, 2),
    'Mods/TestCase/Bar.DesignStylePreset.sodso.json': JSON.stringify({
        fileType: 'DesignStylePreset', name: 'Bar', presetName: 'Bar',
    }, null, 2),
    'Mods/TestCase/Bar.MurderPreset.sodso.json': JSON.stringify({
        fileType: 'MurderPreset', name: 'Bar', presetName: 'Bar',
    }, null, 2),
};

test('a reference opens the asset of that name *and* type, from its typed file', async ({ page }) => {
    const errors = collectPageErrors(page);
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    await seedFs(page, caseWithSameNamedAssets);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');
    await page.locator('#manifest_panel .files-order ul button').first().click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    await page.locator("#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"denStyleOverride\"'))")
        .first().locator('.jsontree_expand-button').first().click();

    await openTarget(page, 'denStyleOverride').click();

    // The DesignStylePreset, not the MurderPreset of the same name -- and found at all,
    // which resolving the reference to `Bar.sodso.json` never would have been.
    await expect(page.locator('#trees .file-window')).toHaveCount(2);
    await expect(page.locator('#trees .file-window').nth(1).locator('.doc-title h5'))
        .toHaveText('DesignStylePreset/Bar');

    expect(errors).toEqual([]);
    expect(await alerts(page)).toEqual([]);
});

test('a reference to a base game asset opens the copy shipped with the tool', async ({ page }) => {
    const errors = collectPageErrors(page);
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseWithReferences(page);

    // compatibleWith names a MurderPreset, one of the types this tool carries assets for,
    // so its ➥ reads them rather than the game folder. Those assets moved under the flow
    // when it stopped being a site of its own, and the fetch went on asking for /data --
    // handing the 404 page to JSON.parse.
    //
    // Read through this rather than through copyFrom, which says the same thing about the
    // same code from a field that is not nested in an array.
    await page.locator("#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"compatibleWith\"'))")
        .first().locator('.jsontree_expand-button').first().click();

    await openTarget(page, 'compatibleWith').click();

    await expect(page.locator('#trees .file-window')).toHaveCount(2);
    await expect(page.locator('#trees')).toContainText('Hitman');
    expect(errors).toEqual([]);
    expect(await alerts(page)).toEqual([]);
});

test('expanded nodes stay expanded across an edit', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    const nestedNode = page.locator("#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"nested\"'))").first();
    await nestedNode.locator('.jsontree_expand-button').first().click();
    await expect(nestedNode).toHaveClass(/jsontree_node_expanded/);

    // The edit loop rebuilds the tree from scratch, so it has to snapshot which
    // nodes were open and reopen them afterwards.
    await fieldInput(page, 'notes').fill('another edit');
    await fieldInput(page, 'notes').blur();
    await expect.poll(async () => JSON.parse(await readFile(page, CASE_FILE)).notes).toBe('another edit');

    await expect(
        page.locator("#trees li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"nested\"'))").first()
    ).toHaveClass(/jsontree_node_expanded/);
});

test('editor bar keeps Select Override Fields on its own row', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    // Its label is far longer than Save/Copy/Close and the editor bar caps button
    // width at 100px, so folding it into their group wraps it over several lines.
    //
    // Alone on the row here rather than always: Open Base is built beside it on every
    // document that can be edited and hidden while there is nothing for it to open, which
    // is this fixture -- its copyFrom is null.
    const rows = page.locator('#trees .editor-bar .jsontree-editor-bar-button-group');
    await expect(rows).toHaveCount(2);

    await expect(rows.nth(0)).toHaveText('SaveCopyClose');
    await expect(rows.nth(1).locator('button:visible')).toHaveText(['Select Override Fields']);

    // One line, not four.
    const box = await rows.nth(1).locator('button:visible').boundingBox();
    expect(box.height).toBeLessThan(60);
});

test('manifest file references are shown but not editable', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);

    // The manifest tree is collapsed behind a toggle by default.
    await page.getByRole('switch', { name: 'Show full manifest' }).click();

    const fileOrder = page.locator(
        "#manifest_content_tree li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"fileOrder\"'))"
    ).first();
    await expect(fileOrder).toBeVisible();

    // fileOrder entries resolve to the FileType pseudo-type, which the type system
    // marks as not editable -- they are changed by adding and removing files, not
    // by typing over them.
    await expect(fileOrder.locator('input')).toHaveCount(0);
    await expect(fileOrder.locator('select')).toHaveCount(0);
    await expect(fileOrder).toContainText('testcase');
});

/**
 * Create a case folder the way a user does: the shell's New content button asks for the
 * name, and that is the whole of it. This editor is asked for nothing to put inside --
 * see the note on `newContent` in flows/scriptableObject/flow.js.
 */
async function newCase(page, name) {
    await queuePrompts(page, [name]);
    await page.getByRole('button', { name: 'New content' }).click();
}

test('creating a case refuses to clobber an existing content folder', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, {
        // Its own mod: content folders do not nest, so the search stops at a mod that
        // already has content at its root.
        'Mods/OtherMod/Existing/murdermanifest.sodso.json': JSON.stringify({
            enabled: true,
            fileOrder: ['REF:handwritten'],
            loadBefore: 'some.other.mod',
            version: 7,
        }, null, 2),
    });
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'OtherMod', 'Existing');

    await newCase(page, 'Existing');

    // Refused rather than silently written over.
    await expect.poll(() => alerts(page)).toContainEqual(expect.stringContaining('already exists'));

    const manifest = JSON.parse(await readFile(page, 'Mods/OtherMod/Existing/murdermanifest.sodso.json'));
    expect(manifest.fileOrder).toEqual(['REF:handwritten']);
    expect(manifest.loadBefore).toBe('some.other.mod');
    expect(manifest.version).toBe(7);
});

test('creating a case puts it beside the mod\'s existing content', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, {
        // This mod keeps its content under the BepInEx plugins/ convention.
        'Mods/ConventionMod/plugins/FirstCase/murdermanifest.sodso.json':
            JSON.stringify({ enabled: true, fileOrder: [], loadBefore: '', version: 1 }),
    });
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'ConventionMod', 'plugins/FirstCase');

    await newCase(page, 'SecondCase');

    // Beside the existing one, not at the mod root where the loader would miss it.
    await expect.poll(() => listDir(page, 'Mods/ConventionMod/plugins')).toContain('SecondCase');
    expect(await listDir(page, 'Mods/ConventionMod/SecondCase')).toBeNull();

    // And it becomes the selection.
    await expect.poll(() => page.evaluate(() => window.selectedMod?.contentPath))
        .toBe('plugins/SecondCase');

    // Empty. A new folder used to arrive as a case -- a manifest and the preset it
    // revolves around, from a dialog asking which kind of case it was -- which decided
    // what the folder held before its author had.
    expect(await listDir(page, 'Mods/ConventionMod/plugins/SecondCase')).toEqual([]);
});

test('a new case folder is empty, and nothing is asked about it', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, {
        'Mods/OtherMod/Existing/murdermanifest.sodso.json':
            JSON.stringify({ enabled: true, fileOrder: [], loadBefore: '', version: 1 }),
    });
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'OtherMod', 'Existing');

    await newCase(page, 'Fresh');

    await expect.poll(() => page.evaluate(() => window.selectedMod?.contentPath)).toBe('Fresh');
    expect(await listDir(page, 'Mods/OtherMod/Fresh')).toEqual([]);

    // Nothing on screen and nothing said about it: an empty folder is an empty file
    // panel, and the editor is ready for the first file to be added to it.
    await expect(page.locator('#so-file-list .file-panel-entry')).toHaveCount(0);
    await expect(page.locator('#manifest_add_item_button')).toBeEnabled();
    expect(await alerts(page)).toEqual([]);
});

test('the first file added to an empty folder writes the manifest with it', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, {
        'Mods/OtherMod/Existing/murdermanifest.sodso.json':
            JSON.stringify({ enabled: true, fileOrder: [], loadBefore: '', version: 1 }),
    });
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'OtherMod', 'Existing');

    await newCase(page, 'Fresh');
    await expect.poll(() => page.evaluate(() => window.selectedMod?.contentPath)).toBe('Fresh');

    // The folder holds no manifest, so the load order the button adds to is the blank
    // one held in memory until there is something to write.
    await openNewFileDialog(page);
    await page.selectOption('#new-file-modal-file-type', 'MurderMO');
    await page.locator('#new-file-modal-file-name').fill('FreshCase');
    await page.locator('#new-file-modal-submit').click();

    await expect
        .poll(() => readFile(page, 'Mods/OtherMod/Fresh/FreshCase.MurderMO.sodso.json'))
        .not.toBeNull();

    // And the manifest arrives with it, naming it -- a file no manifest lists is a file
    // the game never reads.
    await expect
        .poll(async () => JSON.parse((await readFile(page, 'Mods/OtherMod/Fresh/murdermanifest.sodso.json')) || '{}'))
        .toMatchObject({ enabled: true, fileOrder: ['REF:FreshCase.MurderMO'], loadBefore: '', version: 1 });

    // The folder it was created beside is untouched: the blank manifest belongs to the
    // folder that is open, not to the last one that had one.
    expect(JSON.parse(await readFile(page, 'Mods/OtherMod/Existing/murdermanifest.sodso.json')).fileOrder)
        .toEqual([]);
    expect(await alerts(page)).toEqual([]);
});

test('the manifest is written with the file even when autosaving is off', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, {
        'Mods/OtherMod/Existing/murdermanifest.sodso.json':
            JSON.stringify({ enabled: true, fileOrder: [], loadBefore: '', version: 1 }),
    });
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'OtherMod', 'Existing');
    await page.locator('#autosave-switch').uncheck();

    await newCase(page, 'Fresh');
    await expect.poll(() => page.evaluate(() => window.selectedMod?.contentPath)).toBe('Fresh');

    await openNewFileDialog(page);
    await page.selectOption('#new-file-modal-file-type', 'MurderMO');
    await page.locator('#new-file-modal-file-name').fill('FreshCase');
    await page.locator('#new-file-modal-submit').click();

    // Both files, though nothing has been saved. The manifest is the one document with no
    // Save button of its own -- it is a navigation panel -- so a load order left to the
    // autosave that is switched off is one that never reaches disk, and a file the manifest
    // does not name is a file the game never reads.
    await expect
        .poll(() => readFile(page, 'Mods/OtherMod/Fresh/FreshCase.MurderMO.sodso.json'))
        .not.toBeNull();
    await expect
        .poll(async () => JSON.parse((await readFile(page, 'Mods/OtherMod/Fresh/murdermanifest.sodso.json')) || '{}'))
        .toMatchObject({ fileOrder: ['REF:FreshCase.MurderMO'] });
    expect(await alerts(page)).toEqual([]);
});

test('a document longer than the window scrolls inside its own panel', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    // Long enough to outrun any viewport this runs in.
    const long = { fileType: 'MurderMO', name: 'testcase' };
    for (let i = 0; i < 120; i++) long[`field${i}`] = `value ${i}`;
    await seedFs(page, {
        'Mods/TestCase/murdermanifest.sodso.json': JSON.stringify({
            enabled: true, fileOrder: ['REF:testcase'], loadBefore: '', version: 1,
        }),
        'Mods/TestCase/testcase.sodso.json': JSON.stringify(long),
    });
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await page.locator('#so-file-list').getByRole('button', { name: 'testcase' }).click();
    await page.locator('#trees .file-window').first().waitFor();

    // The window is given the height of the trees area and no more. It used to be
    // given the height of its contents -- the grid row grew to fit the document --
    // and the wrapper clipped everything past the fold with no way to scroll to it.
    const fits = await page.evaluate(() => {
        const area = document.querySelector('#trees');
        const window_ = document.querySelector('#trees > .file-window');
        return window_.getBoundingClientRect().height <= area.getBoundingClientRect().height + 1;
    });
    expect(fits).toBe(true);

    // The tree scrolls within the window, rather than the page scrolling.
    const container = page.locator('#trees .jsontree-container').first();
    expect(await container.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    expect(await page.evaluate(() => {
        const doc = document.scrollingElement;
        return doc.scrollHeight <= doc.clientHeight;
    })).toBe(true);

    await container.evaluate((e) => { e.scrollTop = 200; });
    expect(await container.evaluate((e) => e.scrollTop)).toBe(200);
});

/** Open the new file dialog the way a user does, from the manifest panel. */
async function openNewFileDialog(page) {
    await page.locator('#manifest_add_item_button').click();
    await expectDialogOpen(page, '#new-file-modal', true);
}

/** The first base game asset the Copy From / Override list offers for a type. */
async function firstCopyFromOption(page) {
    return page.locator('#new-file-modal-copy-from option').nth(1).innerText();
}

test('the new file dialog offers the base game assets for the chosen type on opening', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);

    await openNewFileDialog(page);

    // Filled on opening rather than only when the type select is touched, which used
    // to leave the list at None.
    const options = page.locator('#new-file-modal-copy-from option');
    await expect(options.first()).toHaveText('None');
    expect(await options.count()).toBeGreaterThan(1);

    // And it follows the type.
    await page.selectOption('#new-file-modal-file-type', 'InteractablePreset');
    await expect(options.first()).toHaveText('None');
    await expect
        .poll(() => page.evaluate(() => window.typeMap['InteractablePreset'].length + 1))
        .toBe(await options.count());
});

test('an override cannot be created without a file to override', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);

    await openNewFileDialog(page);

    const submit = page.locator('#new-file-modal-submit');
    const fileName = page.locator('#new-file-modal-file-name');

    // Copying from nothing is a template, which is a file worth creating.
    await expect(submit).toBeEnabled();

    await page.getByRole('button', { name: 'Override', exact: true }).click();
    await expect(submit).toBeDisabled();
    // The name comes from the overridden file, so it is not the author's to fill in.
    await expect(fileName).toBeDisabled();

    await page.selectOption('#new-file-modal-copy-from', await firstCopyFromOption(page));
    await expect(submit).toBeEnabled();

    await page.getByRole('button', { name: 'Copy From' }).click();
    await expect(submit).toBeEnabled();
    await expect(fileName).toBeEnabled();
});

test('the new file dialog reopens on Copy From', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);

    await openNewFileDialog(page);
    await page.getByRole('button', { name: 'Override', exact: true }).click();
    await page.locator('#new-file-modal').getByLabel('Close').click();
    await expectDialogOpen(page, '#new-file-modal', false);

    await openNewFileDialog(page);

    // Overriding is the exception, so it is not what the next file defaults to.
    await expect(page.getByRole('button', { name: 'Copy From' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Override', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#new-file-modal-file-name')).toBeEnabled();
});

test('overriding a base game asset writes a patch named after it', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);

    await openNewFileDialog(page);
    // The type list is every type the game has; the dialog opens on the first of them.
    await page.selectOption('#new-file-modal-file-type', 'MurderMO');
    await page.getByRole('button', { name: 'Override', exact: true }).click();

    const asset = await firstCopyFromOption(page);
    await page.selectOption('#new-file-modal-copy-from', asset);
    // Ignored: an override takes its name from what it overrides.
    await page.locator('#new-file-modal-submit').click();

    await expect
        .poll(() => readFile(page, `Mods/TestCase/${asset}.sodso_patch.json`))
        .not.toBeNull();
    expect(await readFile(page, `Mods/TestCase/${asset}.sodso.json`)).toBeNull();

    // A patch is the list of changes to make to the asset, so a new one carries what
    // says which asset it is, what type that asset is, and no changes at all. The empty
    // list is written rather than left out: it is what marks the file as this format
    // rather than the whole-field one it replaces.
    const patch = JSON.parse(await readFile(page, `Mods/TestCase/${asset}.sodso_patch.json`));
    expect(patch).toEqual({ name: asset, fileType: 'MurderMO', patches: [] });

    // And the manifest lists it, as it does any other file this dialog creates.
    await expect
        .poll(async () => JSON.parse(await readFile(page, 'Mods/TestCase/murdermanifest.sodso.json')).fileOrder)
        .toContain(`REF:${asset}`);
});

test('copying from a base game asset writes a normal file that points at it', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);

    await openNewFileDialog(page);
    await page.selectOption('#new-file-modal-file-type', 'MurderMO');

    const asset = await firstCopyFromOption(page);
    await page.selectOption('#new-file-modal-copy-from', asset);
    await page.locator('#new-file-modal-file-name').fill('CopiedCase');
    await page.locator('#new-file-modal-submit').click();

    await expect
        .poll(() => readFile(page, 'Mods/TestCase/CopiedCase.MurderMO.sodso.json'))
        .not.toBeNull();
    expect(await readFile(page, `Mods/TestCase/CopiedCase.sodso_patch.json`)).toBeNull();

    const file = JSON.parse(await readFile(page, 'Mods/TestCase/CopiedCase.MurderMO.sodso.json'));
    expect(file.name).toBe('CopiedCase');
    expect(file.copyFrom).toBe(`REF:MurderMO|${asset}`);

    // The manifest names files, so the entry carries the type the file name carries.
    // An entry that names the asset alone is an entry the loader looks for and does not
    // find, which in game is a file that is simply not loaded.
    await expect
        .poll(async () => JSON.parse(await readFile(page, 'Mods/TestCase/murdermanifest.sodso.json')).fileOrder)
        .toContain('REF:CopiedCase.MurderMO');
});

/**
 * "Use as...": the button on a base game asset's window, which opens the new file dialog
 * on that asset. The asset itself is read-only, so copying it is what there is to do with
 * one, and the dialog otherwise offers it in a list of every asset of its type.
 */

/** Open one of the base game's assets the way a user does, from the asset explorer. */
async function openBaseAsset(page, type, name) {
    await page.getByRole('link', { name: 'Asset Explorer' }).click();

    await pickInAssetExplorer(page, 0, type);
    await pickInAssetExplorer(page, 1, name);

    await page.locator('#asset-explorer-modal').getByLabel('Close').click();

    await expect(page.locator('#trees .file-window')).toHaveCount(1);
}

/**
 * Choose in one of the explorer's two typeaheads -- 0 is the type, 1 is the asset.
 *
 * Typed rather than set. Both are select2 over a real `<select>`, and writing the
 * element's value would not go through the control the user is looking at; the search is
 * what narrows the list, exactly as for the reference fields.
 */
async function pickInAssetExplorer(page, index, name) {
    await page.locator('#asset-explorer-modal .select2-selection').nth(index).click();
    await page.locator('.select2-search__field').pressSequentially(name);
    await page.locator('.select2-results__option--highlighted').click();
}

test('a base game asset is titled by its type and offers Use as...', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);

    await openBaseAsset(page, 'MurderMO', 'Hitman');

    const window_ = page.locator('#trees .file-window');
    await expect(window_.locator('.doc-title h5')).toHaveText('MurderMO/Hitman');

    // Nothing else can be done with it: it is the game's file, not the mod's, so there
    // is no Save either -- and no field selector, since every field it holds is the
    // game's and none of them is anything this mod has decided.
    await expect(window_.getByRole('button', { name: 'Use as...' })).toBeVisible();
    await expect(window_.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(window_.getByRole('button', { name: 'Select Override Fields' })).toHaveCount(0);
});

test('a file the mod owns is edited rather than copied', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseFile(page);

    const window_ = page.locator('#trees .file-window');
    await expect(window_.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(window_.getByRole('button', { name: 'Use as...' })).toHaveCount(0);
});

test('Use as... opens the new file dialog on the asset being looked at', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);

    await openBaseAsset(page, 'MurderMO', 'Hitman');
    await page.locator('#trees .file-window').getByRole('button', { name: 'Use as...' }).click();

    await expectDialogOpen(page, '#new-file-modal', true);
    await expect(page.locator('#new-file-modal-file-type')).toHaveValue('MurderMO');
    await expect(page.locator('#new-file-modal-copy-from')).toHaveValue('Hitman');

    // Copying, not overriding: an override of a base game asset is a different thing to
    // want, and it is still a click away.
    await expect(page.getByRole('button', { name: 'Copy From' })).toHaveAttribute('aria-pressed', 'true');

    // The copy is a new asset and needs a name of its own, so the field is left empty
    // rather than prefilled with a name that would clash.
    await expect(page.locator('#new-file-modal-file-name')).toHaveValue('');

    await page.locator('#new-file-modal-file-name').fill('HitmanVariant');
    await page.locator('#new-file-modal-submit').click();

    await expect
        .poll(() => readFile(page, 'Mods/TestCase/HitmanVariant.MurderMO.sodso.json'))
        .not.toBeNull();

    const created = JSON.parse(await readFile(page, 'Mods/TestCase/HitmanVariant.MurderMO.sodso.json'));
    expect(created.presetName).toBe('HitmanVariant');
    expect(created.copyFrom).toBe('REF:MurderMO|Hitman');

    // Created through the same path as Add new file, so it is listed in the load order
    // like anything else that dialog makes -- an unlisted file is one the game never
    // reads.
    await expect
        .poll(async () => JSON.parse(await readFile(page, 'Mods/TestCase/murdermanifest.sodso.json')).fileOrder)
        .toContain('REF:HitmanVariant.MurderMO');

    // And it is a new file in the folder, so the panel shows it.
    await expect(page.locator('#so-file-list .file-panel-entry[data-id="HitmanVariant.MurderMO"]'))
        .toHaveCount(1);

    expect(await alerts(page)).toEqual([]);
});

test('the next new file is a new file, not another copy of the last asset', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);

    await openBaseAsset(page, 'MurderMO', 'Hitman');
    await page.locator('#trees .file-window').getByRole('button', { name: 'Use as...' }).click();
    await page.locator('#new-file-modal').getByLabel('Close').click();

    // Add new file means a blank dialog. The asset is remembered only for the one
    // opening it was chosen for.
    await openNewFileDialog(page);
    await expect(page.locator('#new-file-modal-copy-from')).toHaveValue('None');
});

test('Use as... with no mod to write into says so rather than doing nothing', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    // Browsing with no folders connected, which is what a shared link opens in.
    await page.locator('#folders-continue').click();
    await openBaseAsset(page, 'MurderMO', 'Hitman');

    await page.locator('#trees .file-window').getByRole('button', { name: 'Use as...' }).click();

    await expectDialogOpen(page, '#new-file-modal', false);
    expect(await alerts(page)).toEqual(['Please select a mod to save in first']);
});

/**
 * Two of the mod's own MurderMOs, each holding fields still at the MurderMO template's
 * values. Those are what get marked as defaults, and a case with none of them gives the
 * switch below nothing to act on.
 */
const caseWithUntouchedFields = {
    'Mods/TestCase/murdermanifest.sodso.json': JSON.stringify({
        enabled: true, fileOrder: ['REF:testcase', 'REF:MyOtherMO'], loadBefore: '', version: 1,
    }, null, 2),
    'Mods/TestCase/testcase.sodso.json': JSON.stringify({
        fileType: 'MurderMO', name: 'testcase', presetName: 'testcase',
        baseDifficulty: 0, updateThis: false, notes: 'decided',
    }, null, 2),
    'Mods/TestCase/MyOtherMO.sodso.json': JSON.stringify({
        fileType: 'MurderMO', name: 'MyOtherMO', presetName: 'MyOtherMO',
        baseDifficulty: 0, updateThis: false, maximumPotentialScore: 0,
    }, null, 2),
};

/**
 * Hide Default Values is one switch over everything open, so every document has to be in
 * the state it stands in -- including one opened while it was already on.
 *
 * The switch used to flip each marked node in turn. A file opened under it marked its
 * defaults without hiding them, so the next flip took that file's defaults off the screen
 * and put every other file's back on it: the two halves swapped over instead of all of
 * them following the switch.
 */
test('hiding default values follows the switch, in files opened after it was flipped', async ({ page }) => {
    const errors = collectPageErrors(page);
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    await seedFs(page, caseWithUntouchedFields);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    const defaults = page.locator('#trees .default-value-node');
    const hidden = page.locator('#trees .default-value-node.hidden-default-value-node');

    await page.locator('#so-file-list .file-panel-entry[data-id="testcase"] .file-panel-open').click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    const first = await defaults.count();
    expect(first).toBeGreaterThan(0);
    await expect(hidden).toHaveCount(0);

    await page.locator('#hide-default-values').click();
    await expect(hidden).toHaveCount(first);

    // Marked while the switch is already on, so it has to arrive hidden like the rest.
    await page.locator('#so-file-list .file-panel-entry[data-id="MyOtherMO"] .file-panel-open').click();
    await expect(page.locator('#trees .file-window')).toHaveCount(2);

    const both = await defaults.count();
    expect(both).toBeGreaterThan(first);
    await expect(hidden).toHaveCount(both);

    // And the switch off shows every one of them, rather than swapping the two files over.
    await page.locator('#hide-default-values').click();
    await expect(hidden).toHaveCount(0);
    await expect(defaults).toHaveCount(both);

    expect(errors).toEqual([]);
    expect(await alerts(page)).toEqual([]);
});

test('two assets of one name and different types are two files', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openMod(page);

    for (const type of ['MurderMO', 'EvidencePreset']) {
        await openNewFileDialog(page);
        await page.selectOption('#new-file-modal-file-type', type);
        await page.locator('#new-file-modal-file-name').fill('Matchbook');
        await page.locator('#new-file-modal-submit').click();

        await expect
            .poll(() => readFile(page, `Mods/TestCase/Matchbook.${type}.sodso.json`))
            .not.toBeNull();
    }

    // The whole point of the type being in the file name. Hundreds of the game's own
    // names belong to more than one type, so a mod defining two of them used to have two
    // files fighting over one name and whichever was written second won.
    const evidence = JSON.parse(await readFile(page, 'Mods/TestCase/Matchbook.EvidencePreset.sodso.json'));
    expect(evidence.fileType).toBe('EvidencePreset');
    expect(evidence.presetName).toBe('Matchbook');

    const murder = JSON.parse(await readFile(page, 'Mods/TestCase/Matchbook.MurderMO.sodso.json'));
    expect(murder.fileType).toBe('MurderMO');
    expect(murder.presetName).toBe('Matchbook');

    // Both loaded, and each named as its own file.
    await expect
        .poll(async () => JSON.parse(await readFile(page, 'Mods/TestCase/murdermanifest.sodso.json')).fileOrder)
        .toEqual(expect.arrayContaining(['REF:Matchbook.MurderMO', 'REF:Matchbook.EvidencePreset']));

    expect(await alerts(page)).toEqual([]);
});
