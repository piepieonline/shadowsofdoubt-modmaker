import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, selectContent, gotoFlow, collectPageErrors,
    contrastGap,
} from './support/harness.js';
import { soFixtureWithAssets } from './support/fixtures.js';

/**
 * The field summary: one field's values across every asset of its type.
 *
 * The type here is `MurderMO`, which this tool ships nine of, and the mod on top of them is
 * the shared fixture -- two assets of its own, an override of `ExCopSniper`, and one file
 * the manifest has forgotten. So every rule the table is built on has something to bite on:
 *
 * | | |
 * |---|---|
 * | `testcase`, `MyOtherMO` | the mod's own, counted alongside the game's |
 * | `ExCopSniper` | the mod's override *replacing* the shipped asset rather than joining it |
 * | `ForgottenMO` | not in the manifest, so the game would not load it and nor does this |
 *
 * The unit tests in `flows/scriptableObject/scripts/fieldValues.unit.spec.js` cover the
 * grouping itself. What is here is the mode, the reading, and the two coming together.
 */

const CASE = 'Mods/TestCase/testcase.sodso.json';

/**
 * The fixture, with a field of the type the mod's own document does not otherwise state.
 *
 * A mod's file holds the fields its author touched and no more, so the document on screen
 * is not a list of the type's fields -- and `baseDifficulty` is the field worth asking
 * about here, because all nine of the shipped assets carry one.
 */
const files = {
    ...soFixtureWithAssets,
    [CASE]: JSON.stringify(
        { ...JSON.parse(soFixtureWithAssets[CASE]), baseDifficulty: 0 }, null, 2),
};

const label = (page, path) =>
    page.locator(`#trees .jsontree_label[data-summary-path="${path}"]`).first();

const strip = (page) => page.locator('#field-summary-strip');
const modal = (page) => page.locator('#field-summary-modal');

/**
 * Whether jsonTree has this node open.
 *
 * Read off the node rather than by looking for a field inside it: one click opens one
 * level, and a list's fields are two down -- the list, then the element holding them.
 */
const isExpanded = (page, path) => page.evaluate((wanted) =>
    document.querySelector(`#trees .jsontree_label[data-summary-path="${wanted}"]`)
        ?.closest('li.jsontree_node')?.classList.contains('jsontree_node_expanded') ?? false,
path);

/** The table, as rows of `[value, count, the assets carrying it]`. */
const rows = (page) => page.evaluate(() =>
    [...document.querySelectorAll('#field-summary-rows tr')].map((tr) => ({
        value: tr.children[0].textContent.trim(),
        count: tr.children[1].textContent.trim(),
        assets: [...tr.querySelectorAll('.field-summary-asset')].map((button) => button.textContent),
    })));

const rowFor = async (page, value) => (await rows(page)).find((row) => row.value === value);

/** Turn the mode on from the Tools menu. */
async function startPicking(page) {
    await page.click('#tools-menu > summary');
    await page.locator('#tools-menu .browse-menu-item', { hasText: 'Summarise' }).click();
    await expect(strip(page)).toBeVisible();
}

/** Turn it on, pick a field, and wait for every asset to have been read. */
async function summarise(page, path) {
    await startPicking(page);
    await label(page, path).click();
    await expect(modal(page)).toHaveAttribute('open', '');
    await expect(page.locator('#field-summary-cancel')).toBeHidden();
}

async function openCase(page, fixture = files) {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, fixture);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await page.locator('#so-file-list .file-panel-entry[data-id="testcase"] .file-panel-open').click();
    await label(page, 'presetName').waitFor();
}


test('a field summarises across the game\'s assets and the mod\'s together', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openCase(page);

    await summarise(page, 'baseDifficulty');

    // Named the way the type describes it, so what was asked is on screen beside what
    // came back.
    await expect(page.locator('#field-summary-field')).toHaveText('MurderMO.baseDifficulty');

    // Nine shipped assets and two of the mod's own. `ExCopSniper` is the eleventh name and
    // not the twelfth asset: the mod overrides it, so the mod's version is the one counted.
    const status = page.locator('#field-summary-status');
    await expect(status).toContainText('11 MurderMO assets');
    await expect(status).toContainText('3 from this mod');

    expect(await rows(page)).toEqual([
        {
            value: '0',
            count: '5',
            assets: ['Hitman', 'RedGumsKiller', 'TheCoporateKiller', 'MyOtherMO', 'testcase'],
        },
        {
            value: '1',
            count: '4',
            assets: ['FinancialKidnapper', 'MadScientistKidnapper', 'TheDoveKiller', 'VoyeurSniper'],
        },
        { value: '2', count: '2', assets: ['ExCopSniper', 'TheRetiredKiller'] },
    ]);

    expect(errors).toEqual([]);
});

/**
 * The mod's own are marked, because which half of the answer is yours is the first thing a
 * row is read for -- and an override is the mod's even though the name is the game's.
 */
test('the mod\'s own assets are told apart from the game\'s', async ({ page }) => {
    await openCase(page);
    await summarise(page, 'baseDifficulty');

    const sources = page.locator('#field-summary-rows .field-summary-asset');
    await expect(sources.filter({ hasText: 'testcase' })).toHaveAttribute('data-source', 'mod');
    await expect(sources.filter({ hasText: 'ExCopSniper' })).toHaveAttribute('data-source', 'mod');
    await expect(sources.filter({ hasText: 'Hitman' })).toHaveAttribute('data-source', 'game');

    // The game's are the ones with no colour of their own, and so the ones a rule taking
    // --pico-color inside a button draws in white on white. See contrastGap.
    expect(await contrastGap(page, '#field-summary-rows .field-summary-asset', '#field-summary-modal article'))
        .toBeGreaterThan(100);
});

/**
 * A file the manifest does not name is one the game would not load, so counting it would
 * make the table disagree with the game. Said rather than silently dropped.
 */
test('a file the manifest has forgotten is left out, and reported', async ({ page }) => {
    await openCase(page);
    await summarise(page, 'baseDifficulty');

    const names = (await rows(page)).flatMap((row) => row.assets);
    expect(names).not.toContain('ForgottenMO');

    await expect(page.locator('#field-summary-notes'))
        .toContainText("1 of this mod's files are not named by its manifest");
});

/**
 * A whole object is one value, grouped on what it holds -- and the assets that do not
 * carry the field at all are counted apart from the ones that carry it empty or null.
 */
test('an object is one value, and a field nothing else has says so', async ({ page }) => {
    await openCase(page);

    // `nested` is not a MurderMO field. Only the mod's own document has it, which makes it
    // the case worth pinning: ten assets shaped as the game ships them, and one that is not.
    await summarise(page, 'nested');

    expect(await rowFor(page, '{"alpha":"a","beta":"b"}'))
        .toMatchObject({ count: '1', assets: ['testcase'] });

    // At the foot of the table whatever its count: it describes the data rather than being
    // a value in it.
    const table = await rows(page);
    expect(table.at(-1)).toMatchObject({ value: '(field absent)', count: '10' });
});

/**
 * The heart of it: a path running through a list is answered per element, so one asset can
 * hold several of the values in the table -- and an asset whose list is empty is not an
 * asset missing the field.
 */
test('a field inside a list is read once per element', async ({ page }) => {
    await openCase(page);

    // Two levels down and folded away. While picking, a plain click picks rather than
    // opens, so the modifier is how a field this deep is reached at all.
    await startPicking(page);
    await label(page, 'MOleads').click({ modifiers: ['ControlOrMeta'] });
    await expect(label(page, 'MOleads.chance')).toBeVisible();

    await label(page, 'MOleads.chance').click();
    await expect(page.locator('#field-summary-cancel')).toBeHidden();

    // The `[]` is what says the row counts are per element rather than per asset.
    await expect(page.locator('#field-summary-field')).toHaveText('MurderMO.MOleads[].chance');
    await expect(page.locator('#field-summary-status')).toContainText('values read in all');

    // The mod's own lead, at a chance nothing the game ships uses.
    expect((await rowFor(page, '0.5')).assets).toContain('testcase');

    // Hitman has no leads at all, which is a fact about Hitman rather than a missing field.
    expect((await rowFor(page, '(no elements)')).assets).toContain('Hitman');
});

/** The way back out, and the promise that nothing was touched on the way through. */
test('Escape leaves the mode and the document as they were', async ({ page }) => {
    await openCase(page);
    await startPicking(page);

    await page.keyboard.press('Escape');

    await expect(strip(page)).toBeHidden();
    await expect(modal(page)).not.toHaveAttribute('open', '');

    // And the tree is a tree again: a click opens a node up rather than picking it.
    await label(page, 'MOleads').click();
    expect(await isExpanded(page, 'MOleads')).toBe(true);
    await expect(modal(page)).not.toHaveAttribute('open', '');
});

/**
 * Picking a node that happens to be an object must not also open it: jsonTree binds its own
 * click on every label, and this mode has to get there first.
 */
test('picking a field does not also expand it', async ({ page }) => {
    await openCase(page);

    await startPicking(page);
    await label(page, 'MOleads').click();

    await expect(modal(page)).toHaveAttribute('open', '');
    expect(await isExpanded(page, 'MOleads')).toBe(false);
});

/** A row is a way into the assets it names, which is most of what the table is read for. */
test('an asset in a row opens that document', async ({ page }) => {
    await openCase(page);
    await summarise(page, 'baseDifficulty');

    await page.locator('#field-summary-rows .field-summary-asset', { hasText: 'Hitman' }).click();

    await expect(page.locator('#trees .file-window .doc-title h5').filter({ hasText: 'Hitman' }))
        .toHaveText('MurderMO/Hitman');
});

/** With nothing open there is no field to point at, and a menu item that does nothing at
 *  all would be the worst way to say so. */
test('with no document open the strip says what to do first', async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=scriptableObject');
    await page.locator('#folders-continue').click();

    await startPicking(page);

    await expect(page.locator('#field-summary-strip-text'))
        .toContainText('Open a ScriptableObject first');
});
