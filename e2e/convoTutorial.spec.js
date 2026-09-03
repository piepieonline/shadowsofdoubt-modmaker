import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, selectContent, gotoFlow, alerts, prompts,
    readFile, listDir, reveal,
} from '../test-support/harness.js';
import { ddsBareFixture } from '../test-support/fixtures.js';

/**
 * The Wizcards walkthrough, played rather than parsed.
 *
 * Unlike the case editor's, every step of this one is inside the DDS editor and most of
 * them edit a document that already exists -- so a step naming a row that is not there, or
 * a condition that cannot be met, would leave a player stuck with nowhere to click and
 * nothing said about why. Playing it is the only way to find that out.
 *
 * The static check that each step's shape is one the runner understands lives in
 * caseTutorial.spec.js, which runs it over every shipped tutorial.
 */

const POPOVER = '.driver-popover';
const FORWARD = '.driver-popover-next-btn';

const TREE = '#file-window-0';
const MESSAGE = '#file-window-1';
const BLOCK = '#file-window-2';

const BLOCKS_CSV = 'Mods/BareMod/Content/DDSContent/Strings/English/DDS/dds.blocks.csv';

/** The step on screen now. */
const heading = (page) => page.locator(`${POPOVER} .driver-popover-title`);

/**
 * Wait for a step by its title, which is how each assertion below names its place.
 *
 * Used where the step before it carries itself -- `autoAdvance` in the tutorial file --
 * so nothing has to be pressed to arrive. That is most of the tree chapter: a run of
 * one-field edits where the doing is the whole of the step.
 */
const onStep = (page, title) => expect(heading(page)).toHaveText(title);

/**
 * Take the step just finished, and arrive at the one named.
 *
 * For the rest: a step that explains what just happened or asks for several things at
 * once opens its way forward and waits to be left, so playing it means pressing the
 * button like a player would. The press is its own wait -- Playwright will not click a
 * disabled button -- so a step that never opened up fails here, naming the step it
 * failed on its way to.
 */
async function nextStep(page, title) {
    await page.locator(FORWARD).click();
    await onStep(page, title);
}

/**
 * The row at a dotted path inside a document window.
 *
 * The same walk the runner does, for the same reason: jsonTree renders the key as text,
 * which CSS cannot match on, and it labels an array element by its index exactly as it
 * labels a key -- so `messages.1.saidBy` is one rule, not two.
 *
 * The label match is a `filter` rather than a `:has()` inside the selector. Playwright's
 * CSS engine quietly matches nothing for `:scope > li:has(> …)` -- the two combined, not
 * either alone -- so a wrong path and a right one would look the same.
 */
function rowAt(page, scope, path) {
    let list = page.locator(`${scope} .jsontree_child-nodes`).first();
    let node = null;

    for (const segment of path.split('.')) {
        node = list.locator(':scope > li').filter({
            has: page.locator(`> .jsontree_label-wrapper > .jsontree_label:text-is('"${segment}"')`),
        }).first();
        list = node.locator(':scope > .jsontree_value-wrapper > .jsontree_value > .jsontree_child-nodes');
    }

    return node;
}

/** A row's own value element, as opposed to anything nested under it. */
const valueAt = (page, scope, path) =>
    rowAt(page, scope, path).locator(':scope > .jsontree_value-wrapper > .jsontree_value');

/**
 * Type into a field and leave it, which is what commits an edit.
 *
 * Each of these brings what it is about to use into view first. That is nothing under an
 * ordinary run and the whole point under a paced one: the rows these steps are about are
 * mostly below the fold of a document window, so without it the value changes off screen
 * and the walkthrough looks like it is doing nothing. See reveal.
 */
async function setText(page, scope, path, value) {
    const input = valueAt(page, scope, path).locator(':scope > input');
    await reveal(input);
    await input.fill(String(value));
    await input.blur();
}

/** Choose from a field's dropdown. Enums and booleans both store the option's index. */
async function setEnum(page, scope, path, value) {
    const select = valueAt(page, scope, path).locator(':scope > select');
    await reveal(select);
    await select.selectOption(String(value));
}

/** Open a collapsed node, the way a player does: a click on its label. */
async function expandAt(page, scope, path) {
    const label = rowAt(page, scope, path)
        .locator(':scope > .jsontree_label-wrapper > .jsontree_label');
    await reveal(label);
    await label.click();
}

/** The + on an array. */
async function addTo(page, scope, path) {
    const add = valueAt(page, scope, path)
        .locator(':scope > .array-controls > button[data-action="add"]');
    await reveal(add);
    await add.click();
}

/** The ➥ beside a GUID, which opens the document it names at the level below. */
async function drillInto(page, scope, path) {
    const open = valueAt(page, scope, path).locator(':scope > .open-target');
    await reveal(open);
    await open.click();
}

/**
 * What a field holds right now, as the editor shows it.
 *
 * Input or dropdown: a field that names a message in this tree is a list of them, and its
 * value is still the instanceID underneath. The same pair the tutorial runner reads.
 */
const textAt = (page, scope, path) =>
    valueAt(page, scope, path).locator(':scope > input, :scope > select').first().inputValue();

/**
 * Where the hole in the overlay starts -- which is to say, what is being highlighted.
 *
 * driver.js draws the backdrop as one path: the viewport rectangle, then the cutout as a
 * second subpath. The cutout's first point is the highlighted element's top left, less
 * the stage padding.
 */
const cutoutOrigin = (page) => page.evaluate(() => {
    const d = document.querySelector('.driver-overlay path')?.getAttribute('d') ?? '';
    const cutout = d.split('M')[2] ?? '';
    const [x, y] = cutout.trim().split(/[\s,]+/).slice(0, 2).map(Number);
    return { x, y };
});

/**
 * Fail if the popover is sitting on a control the step is asking the player to use.
 *
 * The overlay lets clicks through, so the popover is the one thing left that can swallow
 * them. Playwright's own click would notice too, but only as "element intercepts pointer
 * events" pointing at a driver.js div -- which says nothing about which step is unwalkable.
 * The DDS dialog is the hazard: it nearly fills the window, so a popover beside it has
 * nowhere to go and driver.js lays it over the top.
 */
async function expectPopoverClearOf(page, selector, what) {
    const target = await page.locator(selector).boundingBox();
    const popover = await page.locator(POPOVER).boundingBox();

    const overlaps = popover.x < target.x + target.width
        && popover.x + popover.width > target.x
        && popover.y < target.y + target.height
        && popover.y + popover.height > target.y;

    const box = (b) => `x ${Math.round(b.x)}-${Math.round(b.x + b.width)}, `
        + `y ${Math.round(b.y)}-${Math.round(b.y + b.height)}`;

    expect(
        overlaps,
        `the popover is covering ${what} -- popover ${box(popover)}, ${what} ${box(target)}`,
    ).toBe(false);
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

/**
 * Add an element to an array and open it, which is where the steps that follow write.
 *
 * An element the + makes arrives collapsed. So does the array, the first time: one that
 * was empty had nothing to open and no button to open it with, and the + gives it both.
 * A second click on the label of an open node closes it again, so the array is opened on
 * the element that made it openable and not after that.
 */
async function addAndOpen(page, scope, path, index) {
    await addTo(page, scope, path);
    if (index === 0) await expandAt(page, scope, path);
    await expandAt(page, scope, `${path}.${index}`);
}

/** Add a message to the tree. The + writes the document it points at. */
const addMessage = (page, index) => addAndOpen(page, TREE, 'messages', index);

/**
 * Fill a list of trait names: one + per name, then pick each in the row it made.
 *
 * The array is opened once they are all there rather than before -- an empty one has
 * nothing to open, and a second click on the label of an open node closes it again.
 */
async function addNames(page, scope, path, names) {
    for (const _ of names) await addTo(page, scope, path);

    await expandAt(page, scope, path);
    for (const [index, name] of names.entries()) {
        await pickName(page, scope, `${path}.${index}`, name);
    }
}

/**
 * Choose in one of the searchable lists -- a trait, a job, an item pool, or a message of
 * this tree's.
 *
 * These rows hold a name or an ID that has to match something, so they are a dropdown of
 * what it could be rather than a box to spell one into. Searched rather than scrolled to:
 * there are 389 traits, and select2 renders every matching row.
 *
 * The row is matched on its whole text and not on containing the term. These lists take a
 * value of their own as well -- a trait the mod has not written yet -- so a term that only
 * prefixes a real option is also offered as itself, at the top of the list. Picking that
 * stores the term, which for a message means the label where the instanceID should be.
 */
async function pickName(page, scope, path, name) {
    const list = valueAt(page, scope, path).locator('.select2-selection');
    await reveal(list);
    await list.click();
    await page.locator('.select2-search__field').fill(name);
    await page.locator(`.select2-results__option:text-is("${name}")`).first().click();
}

/**
 * Fill a list of enum values the same way, through the dropdown each row carries.
 *
 * A new entry is the first name in the enum, which is what the walkthrough tells the
 * player -- so the ones set here are those that are not `awake`, and the assertion at the
 * end is that they all landed as the numbers the game reads.
 *
 * @param from how many entries the list already holds. A new conversation arrives with
 *             `awake` and `noReactionState` on A, so the walkthrough asks for three more
 *             rather than five, and they are set at the end of what is there.
 */
async function addChoices(page, scope, path, values, from = 0) {
    for (const _ of values) await addTo(page, scope, path);

    await expandAt(page, scope, path);
    for (const [index, value] of values.entries()) {
        await setEnum(page, scope, `${path}.${from + index}`, value);
    }
}

/**
 * Open the document a GUID row names, and wait for the window to be showing it.
 *
 * The windows below are already showing whatever was opened last, so that one of them is
 * visible says nothing about which document is in it. Typing into a window that has not
 * caught up yet writes into the document being replaced, and the redraw that follows
 * takes the half-finished edit away with it -- leaving a step that asked for a line
 * waiting on a line that was never saved.
 */
async function openFrom(page, scope, path, window) {
    const id = await textAt(page, scope, path);
    await drillInto(page, scope, path);
    await expect(page.locator(window)).toHaveAttribute('path', new RegExp(id));
}

/**
 * Open a message from the tree, which cascades into its block on the right.
 *
 * Asked for at the end of the step that finished with the tree, rather than at the start
 * of the one that wants the block: the ➥ is a row of the tree, so the instruction has to
 * be given while the tree is the window being pointed at.
 */
const openMessage = (page, index) =>
    openFrom(page, TREE, `messages.${index}.msgID`, MESSAGE);

/**
 * Give the open block its line.
 *
 * The row is the line looked up from the strings CSV rather than a field of the block, so
 * typing in it writes the CSV.
 */
async function setLine(page, line) {
    await expect(page.locator(BLOCK)).toBeVisible();
    await setText(page, BLOCK, '_ENG Localisation_', line);
}

/**
 * Link one message to the next, which runs between instanceIDs rather than msgIDs.
 *
 * `from` fills itself in -- the editor knows which message the link was added to -- and
 * `to` is chosen from the messages this tree holds, by where each one sits in it. It was a
 * GUID copied out of the message being linked to and pasted in.
 *
 * The list names a message by where it sits, which is what the player reads off the screen.
 * On a page it also names the draw order; a conversation has nothing to draw, so it does
 * not -- see flows/dds/scripts/instances.js.
 */
async function linkMessages(page, from, to) {
    await addAndOpen(page, TREE, `messages.${from}.links`, 0);
    await pickName(page, TREE, `messages.${from}.links.0.to`, `messages.${to}`);
}


test('it walks from an empty mod to a conversation the game can play', async ({ page }) => {
    // Thirty-nine steps, most of which rebuild a document and write it to disk.
    test.slow();

    await gotoFlow(page, '?flow=dds');
    await seedFs(page, ddsBareFixture);
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

    await page.getByRole('button', { name: 'Tutorials' }).click();
    await page.getByRole('button', { name: 'Wizcards Casual Chat' }).click();

    // --- the tree -------------------------------------------------------------------

    await onStep(page, 'Pick a mod to build in');
    await selectContent(page, 'BareMod', 'Content');

    await onStep(page, 'Start a conversation');
    await expectPopoverClearOf(page, '#new-file-button', 'Add new...');
    await page.locator('#new-file-button').click();

    await onStep(page, 'Name it, and give it its first line');

    // The whole card is what is cut out, rather than the first field inside it: the step
    // asks for three answers, and pointing at one of them says nothing about the others.
    // Polled because Pico animates the dialog open, and the point is where it settles.
    await expect.poll(async () => {
        const card = await page.locator('#new-dds-file-modal article').boundingBox();
        const cutout = await cutoutOrigin(page);
        return Math.max(Math.abs(cutout.x - card.x), Math.abs(cutout.y - card.y));
    }).toBeLessThan(20);

    await page.selectOption('#new-dds-file-type', 'tree:0');
    await page.fill('#new-dds-file-name', 'WizcardsChat');
    await page.fill('#new-dds-file-line', 'You still playing Wizcards?');
    await expectPopoverClearOf(page, '#new-dds-file-submit', 'Create');
    await page.locator('#new-dds-file-submit').click();

    await onStep(page, 'Three documents, not one');
    await expect(page.locator(TREE)).toHaveAttribute('path', /\.tree$/);
    await expect(page.locator(MESSAGE)).toHaveAttribute('path', /\.msg$/);
    await expect(page.locator(BLOCK)).toHaveAttribute('path', /\.block$/);

    // What kind of tree it is was the first thing the walkthrough had to fix, because
    // every new one came out a v-mail. It is answered in the dialog now, so the step that
    // is left only points at the field -- and this is the assertion that the answer
    // travelled from there to the document.
    await nextStep(page, 'It already knows what it is');
    await expect(valueAt(page, TREE, 'treeType').locator('select')).toHaveValue('0');

    await nextStep(page, 'When the game goes looking for it');
    await setEnum(page, TREE, 'triggerPoint', 2);

    await onStep(page, 'And how often');
    await setText(page, TREE, 'treeChance', '0.25');

    // --- who is talking -------------------------------------------------------------

    await onStep(page, 'Who starts it');
    await expandAt(page, TREE, 'participantA');
    await setEnum(page, TREE, 'participantA.connection', 0);

    // awake(0) and noReactionState(4) come with a new conversation, so the three added
    // here go on the end of them.
    //
    // Both trigger steps are pressed rather than carried, and that is deliberate in the
    // tutorial: their condition counts rows, and a row arrives holding `awake` and has to
    // be changed afterwards -- so the count is met while there is still half the step to
    // do. Carrying it would take the instructions away mid-edit.
    await onStep(page, 'Where they have to be');
    await addChoices(page, TREE, 'participantA.triggers', ['29', '21', '15'], 2);

    await nextStep(page, 'And who they are talking to');
    await expandAt(page, TREE, 'participantB');
    await setEnum(page, TREE, 'participantB.connection', 18);

    await onStep(page, 'B has less to satisfy');
    await addChoices(page, TREE, 'participantB.triggers', ['0', '4', '15']);

    // --- the other four messages ----------------------------------------------------

    await nextStep(page, 'The second thing said');
    await addMessage(page, 1);

    // Each of these ends by drilling into the message it just described. The step asks
    // for it last, while the tree is still the window being pointed at, because that is
    // where the ➥ is.
    await onStep(page, 'B answers');
    await setText(page, TREE, 'messages.1.saidBy', '1');
    await setText(page, TREE, 'messages.1.saidTo', '0');
    await openMessage(page, 1);

    await nextStep(page, 'What B says');
    await setLine(page, 'Every night on my cruncher.');

    await nextStep(page, 'A comes back');
    await addMessage(page, 2);

    await onStep(page, 'A is already the speaker');
    await openMessage(page, 2);

    await nextStep(page, 'What A asks');
    await setLine(page, 'Any good at it?');

    // The last two are one step, because by here the loop has been walked twice and the
    // third and fourth times have nothing left to teach. So this is the whole of both
    // messages against a single popover -- which is also the assertion that everything it
    // asks for can be reached without the step it belongs to going away.
    await nextStep(page, 'Two more, the same way');

    await addMessage(page, 3);
    await setText(page, TREE, 'messages.3.saidBy', '1');
    await setText(page, TREE, 'messages.3.saidTo', '0');
    await openMessage(page, 3);
    await setLine(page, 'I hold my own.');

    await addMessage(page, 4);
    await openMessage(page, 4);
    await setLine(page, "Ain't no talking you into it?");

    // --- the links ------------------------------------------------------------------

    await nextStep(page, 'Chain the first two');
    await linkMessages(page, 0, 1);

    await nextStep(page, 'And the rest of the chain');
    await linkMessages(page, 1, 2);
    await linkMessages(page, 2, 3);
    await linkMessages(page, 3, 4);

    // The tree begins at the first message's instance, which creating it already set.
    expect(await textAt(page, TREE, 'startingMessage'))
        .toBe(await textAt(page, TREE, 'messages.0.instanceID'));

    // --- the replacements -----------------------------------------------------------

    await openMessage(page, 1);

    // Nothing to do on this one: the drill above is what it was asking for, and the step
    // itself is what the replacements are for.
    await nextStep(page, 'Back to what B said first');

    await nextStep(page, 'The same line, from someone keen');
    await addAndOpen(page, BLOCK, 'replacements', 0);
    await setText(page, BLOCK, 'replacements.0._ENG Localisation_',
        "Every night! I'm on a streak.");

    await nextStep(page, 'Say who gets it');
    await setEnum(page, BLOCK, 'replacements.0.useTraits', 1);
    await addNames(page, BLOCK, 'replacements.0.traits',
        ['Char-Enthusiastic', 'Char-Cheerful']);

    // The second replacement is one step, for the reason the last two messages were: the
    // first one was walked through line-then-traits, and doing it again teaches nothing.
    await nextStep(page, 'And one for the sour ones');
    await addAndOpen(page, BLOCK, 'replacements', 1);
    await setText(page, BLOCK, 'replacements.1._ENG Localisation_', 'I quit. Rigged deck.');
    await setEnum(page, BLOCK, 'replacements.1.useTraits', 1);
    await addNames(page, BLOCK, 'replacements.1.traits',
        ['Char-Pessimistic', 'Char-Spiteful']);

    // Its own step, because the step before it points at the block window: there is no
    // tree highlighted to hang "drill into messages.3" off the end of. Drilling in is all
    // it asks, so it carries itself.
    await nextStep(page, 'Back to the boast');
    await openMessage(page, 3);

    // And the boast's pair is one step for the same reason again -- by here it is the
    // third time round, and the step gives each replacement whole rather than splitting
    // the lines from the traits they belong to.
    await onStep(page, 'Do it again for the boast');
    await addAndOpen(page, BLOCK, 'replacements', 0);
    await setText(page, BLOCK, 'replacements.0._ENG Localisation_', "I'm unbeatable.");
    await setEnum(page, BLOCK, 'replacements.0.useTraits', 1);
    await addNames(page, BLOCK, 'replacements.0.traits',
        ['Char-Enthusiastic', 'Char-Cheerful']);

    await addAndOpen(page, BLOCK, 'replacements', 1);
    await setText(page, BLOCK, 'replacements.1._ENG Localisation_', 'I lose every hand.');
    await setEnum(page, BLOCK, 'replacements.1.useTraits', 1);
    await addNames(page, BLOCK, 'replacements.1.traits',
        ['Char-Abrasive', 'Char-Pessimistic']);

    // --- the ending -----------------------------------------------------------------

    // Split for the same reason as the boast, and carries itself for the same reason.
    await nextStep(page, 'Back to the last line');
    await openMessage(page, 4);

    // What is left of that step is what the ending is for, so there is nothing to do on
    // it and nothing for it to wait on.
    await onStep(page, 'Now the ending');

    await nextStep(page, 'A second thing A might say');
    await addAndOpen(page, MESSAGE, 'blocks', 1);
    await openFrom(page, MESSAGE, 'blocks.1.blockID', BLOCK);
    await setText(page, BLOCK, '_ENG Localisation_', 'Deal me in next time.');

    await nextStep(page, 'Let the game pick one');
    await setEnum(page, MESSAGE, 'blocks.0.alwaysDisplay', 0);
    await setText(page, MESSAGE, 'blocks.0.group', '1');
    await setEnum(page, MESSAGE, 'blocks.1.alwaysDisplay', 0);
    await setText(page, MESSAGE, 'blocks.1.group', '1');

    await nextStep(page, 'And spare the cheerful ones');
    await setEnum(page, TREE, 'messages.3.links.0.useTraits', 1);
    await addNames(page, TREE, 'messages.3.links.0.traits',
        ['Char-Cheerful', 'Char-Enthusiastic']);
    await setEnum(page, TREE, 'messages.3.links.0.traitConditions', 2);

    await nextStep(page, 'That is a conversation');

    // --- and it really is in the mod ------------------------------------------------

    const root = 'Mods/BareMod/Content/DDSContent/DDS';
    await expect.poll(() => listDir(page, `${root}/Trees`)).toHaveLength(1);
    await expect.poll(() => listDir(page, `${root}/Messages`)).toHaveLength(5);
    await expect.poll(() => listDir(page, `${root}/Blocks`)).toHaveLength(6);

    const csv = await readFile(page, BLOCKS_CSV);
    for (const line of [
        'You still playing Wizcards?',
        'Every night on my cruncher.',
        'Any good at it?',
        'I hold my own.',
        "Ain't no talking you into it?",
        'Deal me in next time.',
        "Every night! I'm on a streak.",
        'I quit. Rigged deck.',
        "I'm unbeatable.",
        'I lose every hand.',
    ]) {
        expect(csv, `${line} did not reach the strings file`).toContain(line);
    }

    // The tree the game will actually read, as opposed to what the editor was showing.
    const [treeFile] = await listDir(page, `${root}/Trees`);
    const tree = JSON.parse(await readFile(page, `${root}/Trees/${treeFile}`));

    expect(tree.treeType).toBe(0);
    expect(tree.triggerPoint).toBe(2);
    expect(tree.treeChance).toBe(0.25);
    expect(tree.participantA.connection).toBe(0);
    expect(tree.participantB.connection).toBe(18);

    // Numbers, which is what the game reads: each row is a dropdown of names and stores
    // the position of the one picked.
    expect(tree.participantA.triggers).toEqual([0, 4, 29, 21, 15]);
    expect(tree.participantB.triggers).toEqual([0, 4, 15]);

    // Chained end to end, and only the last message leads nowhere.
    expect(tree.messages).toHaveLength(5);
    expect(tree.startingMessage).toBe(tree.messages[0].instanceID);
    for (const [index, message] of tree.messages.entries()) {
        // What follows what is the links, and only the links. `order` used to be set
        // alongside them here, on a kind of tree that never reads it -- five numbers that
        // looked like the answer to that question and were not.
        expect(message.order, `messages.${index}.order`).toBe(0);
        expect(message.saidBy, `messages.${index}.saidBy`).toBe(index % 2);

        if (index === tree.messages.length - 1) {
            expect(message.links).toHaveLength(0);
        } else {
            expect(message.links[0].to).toBe(tree.messages[index + 1].instanceID);
        }
    }

    // The sour ending is gated on the link, not on the message it leads to.
    expect(tree.messages[3].links[0].useTraits).toBe(true);
    expect(tree.messages[3].links[0].traitConditions).toBe(2);
    expect(tree.messages[3].links[0].traits)
        .toEqual(['Char-Cheerful', 'Char-Enthusiastic']);

    // Thirty-nine steps of editing, and not one dialog in the way of any of it. Every
    // value above went into the control the row it lives in already had.
    expect(await prompts(page)).toEqual([]);
    expect(await alerts(page)).toEqual([]);
});
