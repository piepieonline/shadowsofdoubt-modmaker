import { test, expect } from '@playwright/test';
import { installFsHarness, seedFs, queuePicks, connectFolders, selectContent, queuePrompts, prompts, readFile, listDir, alerts, collectPageErrors, topLevelLabels, gotoFlow, fieldInput, editField, openDdsDocument, addDdsContent } from './support/harness.js';
import { ddsFixture, ddsBareFixture, TREE_GUID, MSG_GUID, BLOCK_GUID, BLOCK_TEXT, NEWS_TREE_GUID, NEWS_MSG_GUID } from './support/fixtures.js';

/**
 * Baseline smoke tests for the DDS flow, recorded against the app as it behaves
 * today. These exist to be refactored against in Phases 2-4 -- they assert current
 * behaviour, including behaviour that looks wrong. Anything suspicious is called out
 * in a comment rather than corrected here.
 */

/** Drive the app from a cold start through to a loaded tree. */
async function openTree(page, guid = TREE_GUID) {
    await seedFs(page, ddsFixture);
    // Folders are connected once, in the shell, for every flow.
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await openDdsDocument(page, guid);

    // Loading a tree cascades into its message and then its block, so the third
    // window appearing is the signal that the app has finished. Without this, any
    // assertion that is not an auto-retrying expect() races the render.
    await page.locator('#file-window-2 .jsontree_child-nodes').first().waitFor();
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    // The spoiler warning is shell-level now and gates every flow. It has its own
    // test in scriptableObject.spec.js.
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

test('boots and populates reference data from loadRefs.js', async ({ page }) => {
    const errors = collectPageErrors(page);
    await gotoFlow(page, '?flow=dds');

    // Phase 0 moved templates/enums out of immediate <script> tags and into the
    // loadRefs.js module. This is the check that could not be run at the time.
    const refs = await page.evaluate(() => ({
        templates: Object.keys(window.templates ?? {}),
        enums: Object.keys(window.enums ?? {}),
        ddsMapKeys: Object.keys(window.ddsMap ?? {}),
        treeCount: window.ddsMap?.trees?.length ?? 0,
        // A DDS document is an ordinary game type, so this flow reads the same generated
        // layout the case flow does -- including the Unity built-ins a message's pos and
        // col are made of, which the generator does not produce.
        hasRootTypes: ['DDSTreeSave', 'DDSMessageSave', 'DDSBlockSave', 'NewspaperArticle']
            .every((type) => !!window.typeLayout?.[type]),
        hasBasicTypes: !!window.typeLayout?.Vector2 && !!window.typeLayout?.Color,
        describedTypes: Object.keys(window.fieldDescriptions ?? {}),
    }));

    expect(refs.templates).toEqual(
        expect.arrayContaining(['tree', 'treeMessage', 'message', 'messageBlock', 'block', 'blockReplacement', 'newspaper'])
    );
    // Enums are keyed by type name now, not by field name. The hand-written table that
    // keyed them by field could not reach an array's elements, and had drifted from the
    // game -- see refs/README.md.
    expect(refs.enums).toEqual(
        expect.arrayContaining(['RepeatSetting', 'TreeType', 'TriggerPoint', 'TreeTriggers', 'ConnectionType', 'TraitConditionType'])
    );
    expect(refs.ddsMapKeys).toEqual(
        expect.arrayContaining(['trees', 'messages', 'blocks', 'idNameMap', 'reverseIdMap'])
    );
    expect(refs.treeCount).toBeGreaterThan(0);
    expect(refs.hasRootTypes).toBe(true);
    expect(refs.hasBasicTypes).toBe(true);
    expect(refs.describedTypes).toContain('DDSTreeSave');
    expect(errors).toEqual([]);
});

test('loads a tree and cascades into its message and block', async ({ page }) => {
    const errors = collectPageErrors(page);
    await gotoFlow(page, '?flow=dds');
    await openTree(page);

    // One window per level: tree -> msg -> block.
    await expect(page.locator('#file-window-0')).toContainText('Tree: TestTree');
    await expect(page.locator('#file-window-1')).toContainText('Message: TestMessage');
    await expect(page.locator('#file-window-2')).toContainText('Block: TestBlock');

    // The GUIDs linking the three levels are rendered. They are inputs, so they are
    // read as values rather than as the window's text.
    await expect(fieldInput(page, '#file-window-0', 'msgID')).toHaveValue(MSG_GUID);
    await expect(fieldInput(page, '#file-window-1', 'blockID')).toHaveValue(BLOCK_GUID);

    expect(await alerts(page)).toEqual([]);
    expect(errors).toEqual([]);
});

test('resolves block text from dds.blocks.csv into the localisation dummy key', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);

    await expect(page.locator('#file-window-2')).toContainText('_ENG Localisation_');

    const blockText = fieldInput(page, '#file-window-2', '_ENG Localisation_');
    await expect(blockText).toHaveValue(BLOCK_TEXT);
    // The failure mode when the CSV is missing or misparsed.
    await expect(blockText).not.toHaveValue('MISSING GUID IN dds.csv');
});

test('saving an unmodified vanilla file writes an empty patch beside the mod', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);

    // Selecting a mod is what gives the app somewhere to write.
    await selectContent(page, 'TestMod', 'Content');

    await page.locator('#file-window-0').getByRole('button', { name: 'Save' }).click();

    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;
    await expect.poll(() => readFile(page, patchPath)).not.toBeNull();

    // Nothing was edited, so the diff against the vanilla file is empty.
    expect(JSON.parse(await readFile(page, patchPath))).toEqual([]);
    expect(await alerts(page)).toEqual([]);
});

test('saving a block strips the display-only localisation key', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await selectContent(page, 'TestMod', 'Content');

    // The block tree shows '_ENG Localisation_' as a convenience: it is resolved from
    // dds.blocks.csv for display and must never be written back into the JSON.
    await expect(page.locator('#file-window-2')).toContainText('_ENG Localisation_');

    await page.locator('#file-window-2').getByRole('button', { name: 'Save' }).click();

    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Blocks/${BLOCK_GUID}.block_patch`;
    await expect.poll(() => readFile(page, patchPath)).not.toBeNull();
    const raw = await readFile(page, patchPath);

    expect(raw).not.toContain('_ENG Localisation_');
    expect(raw).not.toContain(BLOCK_TEXT);
    // Nothing was actually edited, so the patch against vanilla is empty.
    expect(JSON.parse(raw)).toEqual([]);
});

test('renders object keys sorted, with comma separators', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);

    // libs/jsonTree is shared with the ScriptableObject flow, which renders with the
    // opposite settings. This pins the options this flow passes to jsonTree.configure.
    const topLevel = await topLevelLabels(page, '#file-window-0');
    expect(topLevel).toEqual([
        'document', 'id', 'messages', 'name', 'participantA', 'priority',
        'startingMessage', 'stopMovement', 'treeType', 'triggerPoint',
    ]);
    expect(topLevel).toEqual([...topLevel].sort());

    // The ScriptableObject flow renders '&nbsp;' here instead, so a literal comma
    // after a value span is the discriminator between the two configurations.
    expect(await page.locator('#file-window-0').innerHTML()).toContain('</span>,');
});

test('selecting a content folder creates nothing inside it', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsBareFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'BareMod', 'Content');

    // Looking at a folder is not a reason to plant a DDS layout in it. This used to
    // create DDS/Trees, DDS/Messages and DDS/Blocks in every folder it was pointed at,
    // saying the folder held DDS text when it held nothing.
    expect(await listDir(page, 'Mods/BareMod/Content/DDSContent/DDS')).toBeNull();
});

test('a new document makes the folder it needs, and no others', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsBareFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'BareMod', 'Content');

    // A block on its own: nothing a block does not need is created.
    await addDdsContent(page, {
        type: 'block', name: 'NewBlock', line: 'A line for the new block',
    });

    await expect.poll(() => listDir(page, 'Mods/BareMod/Content/DDSContent/DDS')).toEqual(['Blocks']);
    expect((await listDir(page, 'Mods/BareMod/Content/DDSContent/DDS/Blocks'))[0]).toContain('.block');
    expect(await listDir(page, 'Mods/BareMod/Content/DDSContent/DDS/Trees')).toBeNull();
    expect(await listDir(page, 'Mods/BareMod/Content/DDSContent/DDS/Messages')).toBeNull();
    expect(await alerts(page)).toEqual([]);
});

test('a new tree comes with the message and block it starts from', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsBareFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'BareMod', 'Content');

    // One line, asked for once: the cascade ends at a block, and the block is what
    // says it.
    await addDdsContent(page, {
        type: 'tree', name: 'CrumpledNote', line: 'The first line of the new tree',
    });

    await expect.poll(() => listDir(page, 'Mods/BareMod/Content/DDSContent/DDS'))
        .toEqual(['Blocks', 'Messages', 'Trees']);

    const read = async (folder) => {
        const files = await listDir(page, `Mods/BareMod/Content/DDSContent/DDS/${folder}`);
        expect(files).toHaveLength(1);
        return JSON.parse(await readFile(page, `Mods/BareMod/Content/DDSContent/DDS/${folder}/${files[0]}`));
    };

    const [tree, message, block] = [await read('Trees'), await read('Messages'), await read('Blocks')];

    // Joined up, so the tree opens on a message that leads to a block. This branch
    // could not run at all until recently: the new GUID was stamped over the
    // template's DEFAULT_GUID before the code that tested for it, so every new tree
    // took the "copied from an existing one" path instead -- empty, and named
    // "DEFAULT-NAME-Clone".
    expect(tree.messages[0].msgID).toBe(message.id);
    expect(tree.startingMessage).toBe(tree.messages[0].instanceID);
    expect(message.blocks[0].blockID).toBe(block.id);

    // Named after the mod and what the author called it, never "(Clone)". The rungs
    // below carry the same name: they are levels of this document rather than
    // documents anyone went looking for.
    expect(tree.name).toBe('BareMod-CrumpledNote');
    expect(message.name).toBe('BareMod-CrumpledNote-Message');
    expect(block.name).toBe('BareMod-CrumpledNote-Block');

    // The block's text goes to the CSV, keyed by the block's GUID.
    await expect
        .poll(() => readFile(page, 'Mods/BareMod/Content/DDSContent/Strings/English/DDS/dds.blocks.csv'))
        .toContain(`"${block.id}",,"The first line of the new tree"`);

    expect(await alerts(page)).toEqual([]);
});

test('a new tree survives an empty English line', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsBareFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await selectContent(page, 'BareMod', 'Content');

    // The line is optional, and writing it is the last step of the cascade: failing
    // there would leave the tree and its message written but never joined up.
    await addDdsContent(page, { type: 'tree', name: 'Wordless' });

    await expect.poll(() => listDir(page, 'Mods/BareMod/Content/DDSContent/DDS'))
        .toEqual(['Blocks', 'Messages', 'Trees']);

    // A block is keyed by GUID, so it gets its row either way -- an empty one, rather
    // than none, which the game reads as a missing string.
    const blocks = await listDir(page, 'Mods/BareMod/Content/DDSContent/DDS/Blocks');
    await expect
        .poll(() => readFile(page, 'Mods/BareMod/Content/DDSContent/Strings/English/DDS/dds.blocks.csv'))
        .toContain(`"${blocks[0].split('.')[0]}",,"",,,`);

    expect(await alerts(page)).toEqual([]);
});

/** Choose the mod and its content folder, so the app has somewhere to write. */
async function selectMod(page) {
    await selectContent(page, 'TestMod', 'Content');
}

test('every value carries the control that edits it', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await selectMod(page);

    // The same controls the case flow uses: a value is edited where it is shown.
    await expect(fieldInput(page, '#file-window-0', 'name')).toHaveValue('TestTree');
    await expect(fieldInput(page, '#file-window-0', 'priority')).toHaveValue('3');
    await expect(page.locator(
        "#file-window-0 li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"treeType\"')) select"
    )).toHaveCount(1);

    // And nothing is left behind the right-click that used to be the only way in. The
    // queued response stands in for a prompt: if one opened, the value would change.
    await queuePrompts(page, ['EditedByAPromptThatShouldNotOpen']);
    await fieldInput(page, '#file-window-0', 'name').click({ button: 'right' });
    await expect(fieldInput(page, '#file-window-0', 'name')).toHaveValue('TestTree');
});

test('a GUID keeps a way through to the document it names', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);

    // The value is an input now, so following a reference is a control beside it
    // rather than a click on the text.
    const link = page.locator(
        "#file-window-0 li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"msgID\"')) .open-target"
    ).first();

    await expect(link).toHaveAttribute('title', 'Open this message');
    // Inside its own panel: a 36-character GUID is wide enough to push it out.
    const [linkBox, panelBox] = await Promise.all([
        link.boundingBox(),
        page.locator('#file-window-0').boundingBox(),
    ]);
    expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
});

test('a value that will not parse comes back to be corrected', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await selectMod(page);

    // priority is a number, and "three" is not one. This used to throw out of the blur
    // handler: the edit vanished and nothing said why.
    await queuePrompts(page, ['4']);
    await editField(page, '#file-window-0', 'priority', 'three');

    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;
    await expect.poll(async () => JSON.parse((await readFile(page, patchPath)) ?? '[]'))
        .toContainEqual({ op: 'replace', path: '/priority', value: 4 });

    // Offered back as it was typed, so a long line is corrected rather than retyped.
    const [asked] = await prompts(page);
    expect(asked.defaultValue).toBe('three');
    expect(asked.message).toContain("can't be stored");

    await expect(fieldInput(page, '#file-window-0', 'priority')).toHaveValue('4');
    expect(await alerts(page)).toEqual([]);
});

test('cancelling the correction leaves the field as it was', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await selectMod(page);

    // No queued response, so the prompt is cancelled.
    await editField(page, '#file-window-0', 'priority', 'three');

    // Back to the value the document holds, rather than showing one it does not.
    await expect(fieldInput(page, '#file-window-0', 'priority')).toHaveValue('3');
    expect(await prompts(page)).toHaveLength(1);

    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;
    expect(await readFile(page, patchPath)).toBeNull();
    expect(await alerts(page)).toEqual([]);
});

test('a correction that is still wrong is asked about again', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await selectMod(page);

    // Wrong twice, then right: each answer is revalidated, not taken on trust.
    await queuePrompts(page, ['still not a number', '7']);
    await editField(page, '#file-window-0', 'priority', 'three');

    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;
    await expect.poll(async () => JSON.parse((await readFile(page, patchPath)) ?? '[]'))
        .toContainEqual({ op: 'replace', path: '/priority', value: 7 });

    // The second prompt offers the second answer back, not the original text.
    const asked = await prompts(page);
    expect(asked.map((p) => p.defaultValue)).toEqual(['three', 'still not a number']);
});

test('editing a value writes a patch against the vanilla file', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await selectMod(page);

    // Values are inline inputs committed on blur, as in the case flow. This used to be
    // a right-click on the value opening a window.prompt, which nothing advertised.
    await editField(page, '#file-window-0', 'name', 'RenamedTree');

    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;
    await expect.poll(async () => JSON.parse((await readFile(page, patchPath)) ?? '[]'))
        .toContainEqual({ op: 'replace', path: '/name', value: 'RenamedTree' });

    // Only the edited field is in the patch -- the rest stays implicit in vanilla.
    expect(JSON.parse(await readFile(page, patchPath))).toHaveLength(1);
    expect(await alerts(page)).toEqual([]);
});

test('editing block text writes to the mod strings CSV, not the block file', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await selectMod(page);

    await editField(page, '#file-window-2', '_ENG Localisation_', 'Rewritten by test');

    // Block text lives in the CSV, keyed by block GUID -- never in the .block JSON.
    const csvPath = 'Mods/TestMod/Content/DDSContent/Strings/English/DDS/dds.blocks.csv';
    await expect.poll(() => readFile(page, csvPath)).toContain('Rewritten by test');

    const csv = await readFile(page, csvPath);
    expect(csv).toContain(BLOCK_GUID);

    const blockPatch = await readFile(page, `Mods/TestMod/Content/DDSContent/DDS/Blocks/${BLOCK_GUID}.block_patch`);
    if (blockPatch !== null) expect(blockPatch).not.toContain('Rewritten by test');
});

test('opening a newspaper tree creates its companion .newspaper file', async ({ page }) => {
    const errors = collectPageErrors(page);
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    // The mod has to be selected first: the newspaper file is written into it while
    // the tree loads, not on save.
    await selectMod(page);

    await openDdsDocument(page, NEWS_TREE_GUID);

    await expect(page.locator('#file-window-1')).toContainText('_Newspaper Article Configuration_');

    await expect
        .poll(() => readFile(page, `Mods/TestMod/Content/DDSContent/DDS/Messages/${NEWS_MSG_GUID}.newspaper`))
        .not.toBeNull();

    // The key is a way into that file, not part of this document: it is resolved on
    // load and stripped on save, so its control opens it and refuses edits.
    const key = fieldInput(page, '#file-window-1', '_Newspaper Article Configuration_');
    await expect(key).toHaveValue(NEWS_MSG_GUID);
    await expect(key).toHaveJSProperty('readOnly', true);
    await expect(page.locator(
        "#file-window-1 li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"_Newspaper Article Configuration_\"')) .open-target"
    )).toHaveAttribute('title', 'Open this newspaper article');

    expect(await alerts(page)).toEqual([]);
    expect(errors).toEqual([]);
});

test('expanded nodes stay expanded across an edit', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await selectMod(page);

    const docNode = page.locator("#file-window-0 li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"document\"'))").first();
    await docNode.locator('.jsontree_expand-button').first().click();
    await expect(docNode).toHaveClass(/jsontree_node_expanded/);

    // Before core/document.js this flow rebuilt the tree without restoring open
    // nodes, so any edit collapsed everything and lost the user's place.
    await editField(page, '#file-window-0', 'name', 'RenamedAgain');

    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;
    await expect.poll(async () => JSON.parse((await readFile(page, patchPath)) ?? '[]'))
        .toContainEqual({ op: 'replace', path: '/name', value: 'RenamedAgain' });

    await expect(
        page.locator("#file-window-0 li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"document\"'))").first()
    ).toHaveClass(/jsontree_node_expanded/);
});

test('a collapsed node stays collapsed across an edit', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await selectMod(page);

    const docNode = page.locator("#file-window-0 li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"document\"'))").first();
    await expect(docNode).not.toHaveClass(/jsontree_node_expanded/);

    // The other half of restoring open nodes, and the half that was wrong here: this
    // flow assigns no pathToItem, so every open path read as `undefined`, which then
    // matched every node in the rebuilt tree and opened the document in full.
    await editField(page, '#file-window-0', 'name', 'RenamedOnce');

    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;
    await expect.poll(async () => JSON.parse((await readFile(page, patchPath)) ?? '[]'))
        .toContainEqual({ op: 'replace', path: '/name', value: 'RenamedOnce' });

    await expect(docNode).not.toHaveClass(/jsontree_node_expanded/);
});

/**
 * Modal behaviour, asserted through visibility rather than the mechanism that
 * produces it. Phase 4 replaces hand-rolled .modal/.hidden divs with Pico <dialog>
 * elements, so these must hold before and after that change.
 */
test('the folders modal opens on start and closes once folders are chosen', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    // One modal for every folder, shared by all flows.
    await expect(page.locator('#folders-modal')).toBeVisible();

    await openTree(page);
    await expect(page.locator('#folders-modal')).toBeHidden();
});

test('help, browse and reverse search open and close', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);

    // Header actions are text links in both flows, not buttons.
    for (const [link, modal] of [
        ['Help', '#help-modal'],
        ['Browse...', '#fav-modal'],
        ['Reverse Search', '#rsearch-modal'],
    ]) {
        await expect(page.locator(modal)).toBeHidden();
        await page.getByRole('link', { name: link, exact: true }).click();
        await expect(page.locator(modal)).toBeVisible();

        await page.locator(`${modal} .close-button`).click();
        await expect(page.locator(modal)).toBeHidden();
    }
});

test('browse lists trees and filters by typeahead', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await page.getByRole('link', { name: 'Browse...', exact: true }).click();

    const items = page.locator('#fav-list li');
    await expect(items.first()).toBeVisible();
    const total = await items.count();

    await page.fill('#browse-typeahead', 'zzzzz-no-such-guid');
    await expect(items.filter({ visible: true })).toHaveCount(0);

    await page.fill('#browse-typeahead', '');
    await expect(items.filter({ visible: true })).toHaveCount(total);
});

test('a window can be closed, and closing one closes the levels below it', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await expect(page.locator('#trees .file-window')).toHaveCount(3);

    // Closing the deepest level leaves the ones above it alone.
    await page.locator('#file-window-2').getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#file-window-2')).toHaveCount(0);
    await expect(page.locator('#file-window-0')).toHaveCount(1);
    await expect(page.locator('#file-window-1')).toHaveCount(1);

    // These three windows are a drill-down, so closing a level closes what it opened.
    await page.locator('#file-window-0').getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#trees .file-window')).toHaveCount(0);
});

test('tree windows stay readable under a dark system theme', async ({ browser }) => {
    // Pico follows prefers-color-scheme, but libs/jsonTree hardcodes dark text
    // colours (#000, #025900, #000E59). Without forcing the light palette on the
    // tree area, values render dark-on-dark and are invisible.
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
    await openTree(page);

    const { prefersDark, windowLuminance } = await page.evaluate(() => {
        const bg = getComputedStyle(document.querySelector('#file-window-0')).backgroundColor;
        const [r, g, b] = bg.match(/\d+(\.\d+)?/g).map(Number);
        return {
            prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
            windowLuminance: (0.299 * r + 0.587 * g + 0.114 * b) / 255,
        };
    });

    expect(prefersDark).toBe(true);
    // Light background behind the hardcoded dark text.
    expect(windowLuminance).toBeGreaterThan(0.8);
    await context.close();
});

test('editor bar title and actions are centred in the panel', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);

    const measured = await page.evaluate(() => {
        const panel = document.querySelector('#file-window-0').getBoundingClientRect();

        // Measure the glyphs, not the element: the h2 is a block spanning the full
        // panel, so its own box is centred whatever the text-align is.
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#file-window-0 .doc-title h2'));
        const text = range.getBoundingClientRect();

        return {
            panelCentre: panel.x + panel.width / 2,
            titleCentre: text.x + text.width / 2,
            rowAlign: getComputedStyle(document.querySelector('#file-window-0 .doc-title')).textAlign,
            actionAlign: getComputedStyle(
                document.querySelector('#file-window-0 .jsontree-editor-bar-button-group').parentElement
            ).textAlign,
        };
    });

    expect(Math.abs(measured.titleCentre - measured.panelCentre)).toBeLessThan(20);
    // Both flows share these rules via core/chrome.css.
    expect(measured.rowAlign).toBe('center');
    expect(measured.actionAlign).toBe('center');
});

test('the GUID line keeps its icons on one line', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);

    // The copy and favourite icons sit after a 36-character GUID; if the line is
    // too large for the panel they wrap and the header grows a row.
    const h3 = await page.locator('#file-window-1 .doc-title h3').boundingBox();
    expect(h3.height).toBeLessThan(40);
});

test('enum fields render as dropdowns and editing one patches the file', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await selectMod(page);

    // treeType is an enum, so it gets a dropdown rather than the prompt editor.
    const select = page.locator(
        "#file-window-0 li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"treeType\"')) select"
    ).first();
    await expect(select).toHaveCount(1);
    await expect(select.locator('option')).toContainText([
        // interactionDialog is the sixth: the hand-written table this flow used to read
        // stopped at 'misc' and never gained it.
        'conversation', 'vmail', 'document', 'newspaper', 'misc', 'interactionDialog',
    ]);

    // The fixture is treeType 1, the second entry.
    await expect(select).toHaveValue('1');

    await select.selectOption('3');

    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;
    await expect.poll(async () => JSON.parse((await readFile(page, patchPath)) ?? '[]'))
        .toContainEqual({ op: 'replace', path: '/treeType', value: 3 });
});

/**
 * Reading the type layout rather than a table of field names, which is what the case
 * flow has always done. See core/typeHints.js.
 */
test('an enum inside an array gets a dropdown', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await selectMod(page);

    // participantA.triggers holds TreeTriggers indices. Every element of an array is
    // labelled by its index, so looking the enum up by field name found nothing and
    // these were edited as raw numbers.
    const participant = page.locator(
        "#file-window-0 li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"participantA\"'))"
    ).first();
    await participant.locator('.jsontree_expand-button').first().click();

    const triggers = participant.locator(
        "li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"triggers\"'))"
    ).first();
    await triggers.locator('.jsontree_expand-button').first().click();

    const options = triggers.locator('select');
    await expect(options).toHaveCount(2);
    // The fixture holds [12, 3]: 'legal' and 'unconscious'.
    await expect(options.nth(0)).toHaveValue('12');
    await expect(options.nth(1)).toHaveValue('3');

    await options.nth(1).selectOption('1');

    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;
    await expect.poll(async () => JSON.parse((await readFile(page, patchPath)) ?? '[]'))
        .toContainEqual({ op: 'replace', path: '/participantA/triggers/1', value: 1 });
});

test('a boolean is a dropdown, and is stored as a boolean', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);
    await selectMod(page);

    // Booleans reach the dropdown through refs/authored/basicEnums.json, which both
    // flows now read. This flow made you type `false` into a box before.
    const select = page.locator(
        "#file-window-0 li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"stopMovement\"')) select"
    ).first();
    await expect(select).toHaveCount(1);
    await expect(select).toHaveValue('1');

    await select.selectOption('0');

    // Stored as false, not as 0. Every other enum is an index, and a document holding an
    // index where the game wants a boolean is one the game cannot read back.
    const patchPath = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;
    await expect.poll(async () => JSON.parse((await readFile(page, patchPath)) ?? '[]'))
        .toContainEqual({ op: 'replace', path: '/stopMovement', value: false });
});

test('triggerPoint reads the game enum, not the table that had drifted from it', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);

    const select = page.locator(
        "#file-window-0 li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('\"triggerPoint\"')) select"
    ).first();

    // The hand-written table had newspaperMurder at 6, pushing newspaperArticle to 7 --
    // which the game reads as onGameStart. The fixture is 6.
    await expect(select).toHaveValue('6');
    await expect(select.locator('option:checked')).toHaveText('newspaperArticle');
    await expect(select.locator('option')).not.toContainText(['newspaperMurder']);
});

test('a field label carries what the field is for', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    await openTree(page);

    const label = (name) => page.locator(
        `#file-window-0 li > .jsontree_label-wrapper > .jsontree_label:text-is('"${name}"')`
    ).first();

    // From refs/authored/fieldDescriptions.json, keyed by the game's type name for a
    // tree. This flow showed nothing at all before.
    await expect(label('startingMessage')).toHaveAttribute('title', /`instanceID` of the message/);

    // Complex nodes are visited too, not just leaves -- an empty title is a title that
    // was set, where a node the pass skipped would carry no attribute at all. Nothing is
    // written about participantA yet.
    await expect(label('participantA')).toHaveAttribute('title', '');

    // A field the layout cannot place gets no tooltip rather than an error: name and id
    // come from the DDSComponent base, which the generated layout does not record.
    await expect(label('name')).toHaveAttribute('title', '');
});
