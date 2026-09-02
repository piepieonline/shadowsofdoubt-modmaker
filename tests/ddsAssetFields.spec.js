import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, selectContent, gotoFlow, alerts, readFile,
    collectPageErrors, openDdsDocument, showAllDdsFields,
} from '../test-support/harness.js';
import { ddsFixture, TREE_GUID, MSG_GUID } from '../test-support/fixtures.js';

/**
 * The DDS fields that hold the name of one of the game's assets.
 *
 * A participant's traits and jobs and a tree's item pool are typed `String` by the game's
 * layout, which is true and says nothing: they are names of `CharacterTrait`,
 * `OccupationPreset` and `InteractablePreset` assets, and a name spelled wrong is not an
 * error anywhere -- it is a condition that never matches, in a conversation that then
 * never plays. So they are the searchable list the case editor gives a reference field.
 *
 * Which fields those are is decided in flows/dds/scripts/assetFields.js and covered by its
 * unit spec. These are about the control being there and writing what was picked.
 */

const TREE_PATCH = `Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`;

/**
 * The vanilla tree, carrying the three lists of names.
 *
 * The shared fixture's participant is the smallest thing that is still a participant, and
 * these fields are not in it. A real tree has all of them -- Unity writes every serialised
 * field -- and this is the same file with them put back.
 */
const treeWithNameLists = {
    ...ddsFixture,
    [`StreamingAssets/DDS/Trees/${TREE_GUID}.tree`]: JSON.stringify({
        id: TREE_GUID,
        name: 'TestTree',
        treeType: 1,
        priority: 3,
        participantA: { connection: 15, triggers: [], traits: [], jobs: [] },
        itemPool: [],
        startingMessage: 'instance-1',
        messages: [{ msgID: MSG_GUID, instanceID: 'instance-1', order: 0 }],
    }, null, 2),
};

/** A trait of the mod's own, in the content folder and named by its manifest. */
const MOD_TRAIT = 'HatesWizcards';

const withModdedTrait = {
    ...treeWithNameLists,
    'Mods/TestMod/Content/murdermanifest.sodso.json': JSON.stringify({
        enabled: true,
        fileOrder: [`REF:${MOD_TRAIT}.CharacterTrait`],
        loadBefore: '',
        version: 1,
    }, null, 2),
    [`Mods/TestMod/Content/${MOD_TRAIT}.CharacterTrait.sodso.json`]: JSON.stringify({
        fileType: 'CharacterTrait',
        name: MOD_TRAIT,
        presetName: MOD_TRAIT,
    }, null, 2),
};

const TREE = '#file-window-0';

/** The row for a key, matched on the label being this node's own. */
const namedNode = (page, label, scope = TREE) => page.locator(
    `${scope} li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"${label}"'))`
).first();

/** Open a node's children: a click on its label. */
const expand = (node) =>
    node.locator('> .jsontree_label-wrapper > .jsontree_label').click();

/** The + on an array. */
const add = (node) => node.locator(
    '> .jsontree_value-wrapper > .jsontree_value > .array-controls > [data-action="add"]'
).click();

/** The tree with a participant's traits open and one blank name in it. */
async function openTreeWithATrait(page, fixture = treeWithNameLists) {
    await gotoFlow(page, '?flow=dds');
    await seedFs(page, fixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await openDdsDocument(page, TREE_GUID);
    // Opening a tree cascades into its message and then its block; the third window is
    // the signal that the app has finished.
    await page.locator('#file-window-2 .jsontree_child-nodes').first().waitFor();
    await selectContent(page, 'TestMod', 'Content');

    await expand(namedNode(page, 'participantA'));
    await add(namedNode(page, 'traits'));
    await expand(namedNode(page, 'traits'));
}

/** Open the dropdown on the one control in the tree, and search it. */
async function search(page, term) {
    await page.locator(`${TREE} .select2-selection`).first().click();
    await page.locator('.select2-search__field').fill(term);
}

/** What the mod has written against the vanilla tree. */
const patch = async (page) => JSON.parse((await readFile(page, TREE_PATCH)) ?? '[]');

/**
 * The trait the patched tree gives participant A.
 *
 * The patch is a diff against the vanilla file, recomputed whole on every save. Vanilla's
 * participant has the empty list, so what a pick writes is an operation on the element
 * inside it rather than on the list -- and the last of those is where it ended up.
 */
const traitWritten = async (page) => (await patch(page))
    .filter((op) => op.path.startsWith('/participantA/traits'))
    .at(-1)?.value;

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

test('a trait is picked from the game\'s own, not typed from memory', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openTreeWithATrait(page);

    // The row is the control, where it used to be a text box the author had to spell
    // `Char-Enthusiastic` into against 389 traits they could not see. Counted within the
    // list rather than across the window: `startingMessage` is a searchable list too, of
    // this tree's own messages, so the window holds more than one by design.
    await expect(namedNode(page, 'traits').locator('.select2')).toHaveCount(1);

    await search(page, 'Char-Cheerful');
    await page.locator('.select2-results__option', { hasText: 'Char-Cheerful' }).first().click();

    await expect.poll(() => traitWritten(page)).toBe('Char-Cheerful');
    expect(errors).toEqual([]);
    expect(await alerts(page)).toEqual([]);
});

test('the mod\'s own traits are offered above the base game\'s', async ({ page }) => {
    // An author writing a trait condition is often naming something they just made, and
    // the mod's own assets live in the same content folder as its DDS text.
    await openTreeWithATrait(page, withModdedTrait);

    const groups = await page.locator(`${TREE} select optgroup`).evaluateAll(
        (list) => list.map((group) => [group.label, [...group.children].map((o) => o.text)]));

    expect(groups[0][0]).toBe('Modded');
    expect(groups[0][1]).toEqual([MOD_TRAIT]);
    expect(groups[1][0]).toBe('Vanilla');
    expect(groups[1][1]).toContain('Char-Cheerful');

    await search(page, MOD_TRAIT);
    await page.locator('.select2-results__option', { hasText: MOD_TRAIT }).first().click();

    await expect.poll(() => traitWritten(page)).toBe(MOD_TRAIT);
});

test('a name on neither list can still be written', async ({ page }) => {
    // A mod may define a trait this list has never heard of -- one it has not written yet,
    // or one in another mod entirely. Typing it is how it gets in.
    await openTreeWithATrait(page);

    await search(page, 'Char-NotShippedWithTheGame');
    await page.locator('.select2-results__option', { hasText: 'Char-NotShippedWithTheGame' })
        .first().click();

    await expect.poll(() => traitWritten(page)).toBe('Char-NotShippedWithTheGame');
    expect(await alerts(page)).toEqual([]);
});

test('a job and an item pool are the same kind of list, of their own types',
    async ({ page }) => {
        // Three fields, three asset types. `jobs` is a citizen's occupation rather than
        // the game's other kind of job, and `itemPool` is what the tree can hand out.
        await openTreeWithATrait(page);

        // `itemPool` belongs to an interactionDialog and the fixture is a vmail, so the
        // view has it off the screen. What is being asked here is which list a field
        // offers, which is the same question wherever the field is shown.
        await showAllDdsFields(page);

        await add(namedNode(page, 'jobs'));
        await expand(namedNode(page, 'jobs'));
        await add(namedNode(page, 'itemPool'));
        await expand(namedNode(page, 'itemPool'));

        const optionsUnder = (label) => namedNode(page, label)
            .locator('select option').evaluateAll((list) => list.map((o) => o.text));

        expect(await optionsUnder('jobs')).toContain('BarStaff');
        expect(await optionsUnder('itemPool')).toContain('AddressBook');
    });

test('a plain string field is still a text box', async ({ page }) => {
    // Only the fields that name an asset get the list. `name` is a string like any other,
    // and turning every string in the document into a dropdown of 389 traits would be a
    // worse editor than the one this replaces.
    await openTreeWithATrait(page);

    await expect(namedNode(page, 'name').locator('input').first()).toHaveValue('TestTree');
    await expect(namedNode(page, 'name').locator('select')).toHaveCount(0);
});
