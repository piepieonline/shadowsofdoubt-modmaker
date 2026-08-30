import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, selectContent, queuePrompts, readFile,
    alerts, collectPageErrors, gotoFlow, openDdsDocument, clipboard, setClipboard,
} from './support/harness.js';
import { ddsFixture, ddsFixtureWithContent, soFixture, TREE_GUID, MSG_GUID, MSG2_GUID }
    from './support/fixtures.js';

/**
 * The +, −, copy and paste buttons on an array and on each of its elements.
 *
 * All of it was a right-click on the label before, which nothing on screen said. These
 * tests are about the buttons being there and doing what they say; which buttons a node
 * gets, and what the text on the clipboard means, are decided in core/arrayControls.js
 * and covered by its unit spec.
 *
 * The clipboard is the harness's in-page buffer -- reading the real one needs a
 * permission granted per browser context. See installFsHarness.
 */

const TREE_PATCH = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;
const CASE_FILE = 'Mods/TestCase/testcase.sodso.json';
const MOD_BLOCK_GUID = 'cccccccc-3333-4333-8333-333333333333';
const REPLACEMENT_GUID = 'dddddddd-4444-4444-8444-444444444444';

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

/** The DDS flow, with the test tree open and a mod to write into. */
async function openTree(page, fixture = ddsFixture) {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, fixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await openDdsDocument(page, TREE_GUID);
    // Opening a tree cascades into its message and then its block; the third window is
    // the signal that the app has finished.
    await page.locator('#file-window-2 .jsontree_child-nodes').first().waitFor();
    await selectContent(page, 'TestMod', 'Content');
}

/** The case flow, with the fixture case open. */
async function openCase(page) {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFixture);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');
    await page.locator('#manifest_panel .files-order ul button').click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);
}

/**
 * The node for a named key, within a window or panel.
 *
 * Matched on the label being this node's own rather than one of its children's: a
 * complex node's element contains every label below it too.
 */
const namedNode = (page, scope, label) => page.locator(
    `${scope} li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"${label}"'))`
).first();

/**
 * One of an array's elements, by position. Elements are labelled by index, and an index
 * is not unique in a document -- every array has a 0 -- so they are reached through the
 * array they belong to rather than by their label.
 */
const elementNode = (arrayNode, index) => arrayNode.locator(
    '> .jsontree_value-wrapper > .jsontree_value > .jsontree_child-nodes > li'
).nth(index);

/** How many elements an array is rendering. */
const elementCount = (arrayNode) => arrayNode.locator(
    '> .jsontree_value-wrapper > .jsontree_value > .jsontree_child-nodes > li'
);

/**
 * The buttons on a node, in the order they are laid out.
 *
 * Read out of the page rather than through a locator: the row sits at the end of the
 * node's opening line, which is one of two places depending on whether the node is
 * complex, and a node's element contains every row below it as well as its own.
 */
const actionsOn = (node) => node.evaluate((li) => {
    const wrapper = li.querySelector(':scope > .jsontree_value-wrapper');
    const row = wrapper?.querySelector(
        ':scope > .array-controls, :scope > .jsontree_value > .array-controls');
    return row ? [...row.children].map((button) => button.dataset.action) : [];
});

/**
 * One of them. A node's own row always comes before any row below it, so the first
 * match is this node's -- which is what makes .first() right here and wrong above,
 * where the answer for a node with no row of its own has to be nothing.
 */
const control = (node, action) =>
    node.locator(`.array-controls > [data-action="${action}"]`).first();

/** The patch the mod has written against the vanilla tree. */
const treePatch = async (page) => JSON.parse((await readFile(page, TREE_PATCH)) ?? '[]');

test('an array is offered add, copy and paste; its elements remove, copy and paste',
    async ({ page }) => {
        await openTree(page);

        const messages = namedNode(page, '#file-window-0', 'messages');
        expect(await actionsOn(messages)).toEqual(['add', 'copy', 'paste']);
        expect(await actionsOn(elementNode(messages, 0))).toEqual(['remove', 'copy', 'paste']);
    });

test('nothing that is not an array or one of its elements carries buttons',
    async ({ page }) => {
        await openTree(page);

        expect(await actionsOn(namedNode(page, '#file-window-0', 'name'))).toEqual([]);
        expect(await actionsOn(namedNode(page, '#file-window-0', 'participantA'))).toEqual([]);
        // An object *inside* an array is an element of it, and does carry them.
        expect(await actionsOn(namedNode(page, '#file-window-0', 'document'))).toEqual([]);
    });

test('+ adds an element to the array and writes it', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openTree(page);

    const messages = namedNode(page, '#file-window-0', 'messages');
    await expect(elementCount(messages)).toHaveCount(2);

    // A new message asks for the GUID of the message it points at.
    await queuePrompts(page, [MSG_GUID]);
    await control(messages, 'add').click();

    await expect(elementCount(namedNode(page, '#file-window-0', 'messages'))).toHaveCount(3);
    await expect.poll(async () => (await treePatch(page))
        .some((op) => op.op === 'add' && op.path.startsWith('/messages'))).toBe(true);
    expect(errors).toEqual([]);
});

test('− removes the element it sits on', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openTree(page);

    // confirm() answers true in the harness, which stands for the user agreeing.
    const messages = namedNode(page, '#file-window-0', 'messages');
    await control(elementNode(messages, 1), 'remove').click();

    await expect(elementCount(namedNode(page, '#file-window-0', 'messages'))).toHaveCount(1);
    await expect.poll(async () => (await treePatch(page))
        .some((op) => op.op === 'remove' && op.path === '/messages/1')).toBe(true);
    expect(errors).toEqual([]);
});

test('copy puts an element on the clipboard as JSON', async ({ page }) => {
    await openTree(page);

    const messages = namedNode(page, '#file-window-0', 'messages');
    await control(elementNode(messages, 0), 'copy').click();

    await expect.poll(async () => JSON.parse(await clipboard(page)))
        .toMatchObject({ msgID: MSG_GUID, instanceID: 'instance-1', order: 0 });
});

test('copy on the array itself puts the whole array on the clipboard', async ({ page }) => {
    await openTree(page);

    await control(namedNode(page, '#file-window-0', 'messages'), 'copy').click();

    await expect.poll(async () => JSON.parse(await clipboard(page))).toHaveLength(2);
});

test('what is copied is what the file holds, not the text shown beside it',
    async ({ page }) => {
        // A block's replacements each show the English line they resolve to, which is
        // read out of a CSV for display and stripped on save. Copying one strips it too,
        // or the display-only key travels into whatever it is pasted into.
        await openTree(page, ddsFixtureWithContent);
        await openDdsDocument(page, MOD_BLOCK_GUID, 'block');

        const replacements = namedNode(page, '#file-window-0', 'replacements');
        await queuePrompts(page, [REPLACEMENT_GUID]);
        await control(replacements, 'add').click();

        const added = elementNode(namedNode(page, '#file-window-0', 'replacements'), 0);
        await expect(added).toBeAttached();
        await control(added, 'copy').click();

        await expect.poll(async () => JSON.parse(await clipboard(page)))
            .toMatchObject({ replaceWithID: REPLACEMENT_GUID });
        expect(await clipboard(page)).not.toContain('_ENG Localisation_');
    });

test('paste replaces the element it sits on', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openTree(page);

    await setClipboard(page, JSON.stringify({
        msgID: MSG2_GUID, instanceID: 'pasted-instance', order: 9,
    }));

    const messages = namedNode(page, '#file-window-0', 'messages');
    await control(elementNode(messages, 1), 'paste').click();

    await expect.poll(async () => (await treePatch(page))
        .some((op) => op.path.startsWith('/messages/1') && op.value === 'pasted-instance'))
        .toBe(true);
    expect(errors).toEqual([]);
});

test('paste on the array replaces the whole of it', async ({ page }) => {
    await openTree(page);

    await setClipboard(page, JSON.stringify([
        { msgID: MSG2_GUID, instanceID: 'only-one', order: 0 },
    ]));
    await control(namedNode(page, '#file-window-0', 'messages'), 'paste').click();

    await expect(elementCount(namedNode(page, '#file-window-0', 'messages'))).toHaveCount(1);
});

test('a single element pasted onto an array is refused, and says so', async ({ page }) => {
    await openTree(page);

    await setClipboard(page, JSON.stringify({ msgID: MSG2_GUID }));
    await control(namedNode(page, '#file-window-0', 'messages'), 'paste').click();

    await expect.poll(() => alerts(page))
        .toEqual([expect.stringContaining('single element')]);

    // And the array is left as it was.
    await expect(elementCount(namedNode(page, '#file-window-0', 'messages'))).toHaveCount(2);
    expect(await readFile(page, TREE_PATCH)).toBeNull();
});

test('right-clicking the label still removes, as it always did', async ({ page }) => {
    // The buttons replace a context menu that was the only way in. Anyone who found it
    // is used to it, so it is kept, routed through the same actions.
    await openTree(page);

    const messages = namedNode(page, '#file-window-0', 'messages');
    await elementNode(messages, 1)
        .locator('> .jsontree_label-wrapper > .jsontree_label')
        .click({ button: 'right' });

    await expect(elementCount(namedNode(page, '#file-window-0', 'messages'))).toHaveCount(1);
});

test('the case flow carries the same buttons', async ({ page }) => {
    await openCase(page);

    expect(await actionsOn(namedNode(page, '#trees', 'MOleads')))
        .toEqual(['add', 'copy', 'paste']);
    // The manifest's load order is an array in a panel of its own.
    expect(await actionsOn(namedNode(page, '#manifest_content_tree', 'fileOrder')))
        .toEqual(['add', 'copy', 'paste']);
});

/**
 * A building preset in the same mod, opened in the case flow: a floor layout, and the
 * floor blueprints the game picks between for that storey.
 *
 * The manifest names the case as well, so the folder is still a case folder rather than
 * a building one -- the marker for a building is a manifest naming a preset and nothing
 * else. See core/modFolders.js.
 */
const caseWithBuildingPreset = {
    ...soFixture,
    'Mods/TestCase/murdermanifest.sodso.json': JSON.stringify({
        enabled: true,
        fileOrder: ['REF:testcase', 'REF:MyTower.BuildingPreset'],
        loadBefore: '',
        version: 1,
    }, null, 2),
    'Mods/TestCase/MyTower.BuildingPreset.sodso.json': JSON.stringify({
        fileType: 'BuildingPreset',
        name: 'MyTower',
        presetName: 'MyTower',
        floorLayouts: [{ floorsWithThisSetting: 1, blueprints: ['Hotel_GroundFloor'] }],
    }, null, 2),
};

const TOWER_FILE = 'Mods/TestCase/MyTower.BuildingPreset.sodso.json';

/** Open a node's children, which is what puts them on screen to be clicked. */
const expand = (node) => node.locator('.jsontree_expand-button').first().click();

/**
 * The blueprint list the file on disk holds.
 *
 * Tolerant of a file that cannot be read yet: a save writes through a swap file, so a
 * read that lands mid-write comes back with nothing. Polling on a callback that throws
 * fails then and there rather than trying again.
 */
const blueprintsInFile = async (page) =>
    JSON.parse((await readFile(page, TOWER_FILE)) ?? '{}')?.floorLayouts?.[0]?.blueprints;

test('an array of floor blueprints can be added to', async ({ page }) => {
    // A blueprint is a TextAsset, which the game's layout gives no shape for -- so the
    // flow could not make an element of one and offered no + on the array at all. It is
    // named rather than described, so a new element is a blank name to type into.
    const errors = collectPageErrors(page);
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, caseWithBuildingPreset);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');
    await page.locator('#manifest_panel .files-order ul button').nth(1).click();
    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    const layouts = namedNode(page, '#trees', 'floorLayouts');
    await expand(layouts);
    await expand(elementNode(layouts, 0));

    const blueprints = namedNode(page, '#trees', 'blueprints');
    expect(await actionsOn(blueprints)).toEqual(['add', 'copy', 'paste']);

    await control(blueprints, 'add').click();

    await expect.poll(() => blueprintsInFile(page)).toEqual(['Hotel_GroundFloor', '']);
    expect(errors).toEqual([]);
    expect(await alerts(page)).toEqual([]);
});

test('the case flow adds and removes through them', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openCase(page);

    const leads = namedNode(page, '#trees', 'MOleads');
    // Not one of the keys the flow auto-expands, and an element has to be on screen to
    // be clicked.
    await leads.locator('> .jsontree_label-wrapper > .jsontree_label').click();

    await control(leads, 'add').click();
    await expect.poll(async () => JSON.parse(await readFile(page, CASE_FILE)).MOleads.length)
        .toBe(2);

    const added = namedNode(page, '#trees', 'MOleads');
    await control(elementNode(added, 1), 'remove').click();
    await expect.poll(async () => JSON.parse(await readFile(page, CASE_FILE)).MOleads.length)
        .toBe(1);
    expect(errors).toEqual([]);
});

test('a base game asset can be copied out of and nothing else', async ({ page }) => {
    // Opened from the reference assets shipped with the tool, which are read-only:
    // no + and no −, but nothing is wrong with copying one to paste into a mod.
    await gotoFlow(page,
        '?flow=scriptableObject&viewOnly=true&open='
        + encodeURIComponent('["asset:MurderMO/ExCopSniper.json"]'));

    await expect(page.locator('#trees .file-window')).toHaveCount(1);

    expect(await actionsOn(namedNode(page, '#trees', 'murdererTraitModifiers')))
        .toEqual(['copy']);
});
