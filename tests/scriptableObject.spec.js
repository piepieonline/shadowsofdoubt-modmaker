import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, queuePicks, connectFolders, selectContent, queuePrompts, prompts, listDir, alerts, collectPageErrors, topLevelLabels, readFile, writeFixture, gotoFlow } from './support/harness.js';
import { soFixture, caseWithCustomReference } from './support/fixtures.js';

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

    // Editing mode replaces the read-only controls.
    await expect(page.locator('#manifest_panel')).not.toHaveClass(/hidden/);
    await expect(page.locator('#files-section-container')).toHaveClass(/file-section-edit-mode/);

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

    const optionCount = await page.locator('#asset-model-type-list option').count();
    expect(optionCount).toBeGreaterThan(1);

    // Online-browsable types are hoisted above a separator.
    const firstOption = await page.locator('#asset-model-type-list option').first().textContent();
    expect(await page.evaluate(() => window.onlineTypes)).toContain(firstOption);
});

test('assets can be browsed with no folders connected', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');

    // Browsing reads from the online asset data, so it must not require a folder.
    await page.locator('#folders-continue').click();
    await page.getByRole('link', { name: 'Asset Explorer' }).click();

    await expect(page.locator('#asset-explorer-modal')).toBeVisible();
    await expect(page.locator('#asset-model-type-list option').first()).toBeAttached();
    expect(await page.evaluate(() => window.dirHandleModDir ?? null)).toBeNull();
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

test('a reference to a base game asset opens the copy shipped with the tool', async ({ page }) => {
    const errors = collectPageErrors(page);
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await openCaseWithReferences(page);

    // copyFrom names a MurderMO, one of the types this tool carries assets for, so its
    // ➥ reads them rather than the game folder. Those assets moved under the flow when
    // it stopped being a site of its own, and the fetch went on asking for /data --
    // handing the 404 page to JSON.parse.
    await openTarget(page, 'copyFrom').click();

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
    const rows = page.locator('#trees .editor-bar .jsontree-editor-bar-button-group');
    await expect(rows).toHaveCount(2);

    await expect(rows.nth(0)).toHaveText('SaveCopyClose');
    await expect(rows.nth(1)).toHaveText('Select Override Fields');

    // One line, not four.
    const box = await rows.nth(1).locator('button').boundingBox();
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
 * Create a case the way a user does: the shell's New content button asks for the name,
 * then this flow asks what kind of case goes in it.
 */
async function newCase(page, name, type) {
    await queuePrompts(page, [name]);
    await page.getByRole('button', { name: 'New content' }).click();
    await page.selectOption('#new-case-modal-case-type', type);
    await page.getByRole('button', { name: 'Create Case' }).click();
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

    await newCase(page, 'Existing', 'MurderMO');

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

    await newCase(page, 'SecondCase', 'MurderMO');

    // Beside the existing one, not at the mod root where the loader would miss it.
    await expect
        .poll(() => readFile(page, 'Mods/ConventionMod/plugins/SecondCase/murdermanifest.sodso.json'))
        .not.toBeNull();
    expect(await readFile(page, 'Mods/ConventionMod/SecondCase/murdermanifest.sodso.json')).toBeNull();

    // And it becomes the selection.
    await expect.poll(() => page.evaluate(() => window.selectedMod?.contentPath))
        .toBe('plugins/SecondCase');

    // A case is a manifest and its preset. Empty DDS directories used to come with
    // it whether or not the case ever gained dialogue; the DDS flow makes them when
    // it has something to write.
    expect(await listDir(page, 'Mods/ConventionMod/plugins/SecondCase'))
        .toEqual(['SecondCase.sodso.json', 'murdermanifest.sodso.json']);
});

test('dismissing the new case dialog leaves no folder behind', async ({ page }) => {
    await skipSpoilerWarning(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, {
        'Mods/OtherMod/Existing/murdermanifest.sodso.json':
            JSON.stringify({ enabled: true, fileOrder: [], loadBefore: '', version: 1 }),
    });
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'OtherMod', 'Existing');

    await queuePrompts(page, ['Abandoned']);
    await page.getByRole('button', { name: 'New content' }).click();
    await page.locator('#new-case-modal').getByLabel('Close').click();

    // The flow is asked what it needs before anything is written, so backing out of
    // its dialog does not litter the mod with an empty folder.
    await expectDialogOpen(page, '#new-case-modal', false);
    expect(await listDir(page, 'Mods/OtherMod/Abandoned')).toBeNull();
    expect(await page.evaluate(() => window.selectedMod?.contentPath)).toBe('Existing');
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

    // Every field a patch carries is a field it overrides, so a new one carries only
    // what says which asset it is and what type that asset is -- it changes nothing
    // until the author adds to it.
    const patch = JSON.parse(await readFile(page, `Mods/TestCase/${asset}.sodso_patch.json`));
    expect(patch).toEqual({ name: asset, fileType: 'MurderMO' });

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
        .poll(() => readFile(page, 'Mods/TestCase/CopiedCase.sodso.json'))
        .not.toBeNull();
    expect(await readFile(page, `Mods/TestCase/CopiedCase.sodso_patch.json`)).toBeNull();

    const file = JSON.parse(await readFile(page, 'Mods/TestCase/CopiedCase.sodso.json'));
    expect(file.name).toBe('CopiedCase');
    expect(file.copyFrom).toBe(`REF:MurderMO|${asset}`);
});
