import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, selectContent, gotoFlow, alerts, editField, fieldInput,
} from './support/harness.js';
import { soFolderContent } from './support/fixtures.js';

/**
 * The tutorial runner's mechanics, against tutorials written for the test rather than
 * the shipped one -- so a change to the walkthrough's wording is not a test failure.
 *
 * What matters here is the waiting. A walkthrough builds a real mod, so a step has to
 * be finished by doing the thing; a step that could be clicked past would leave the
 * next one pointing at something that does not exist yet.
 */

const POPOVER = '.driver-popover';
const BACK = '.driver-popover-prev-btn';
const FORWARD = '.driver-popover-next-btn';

/** The "Step X of Y" the walkthrough shows between its arrows. */
const progress = (page) => page.locator('.driver-popover-progress-text');

/** Serve a tutorial of the test's own, in place of whatever is on disk. */
async function useTutorial(page, definition) {
    await page.route('**/tutorials/*.tutorial.json', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(definition) }));
}

const start = (page) => page.getByRole('button', { name: 'Theft Gone Wrong' }).click();

async function openTutorials(page) {
    await page.getByRole('button', { name: 'Tutorials' }).click();
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

/**
 * The case editor's fixture plus a field to point at. The tree renders the fields the
 * file actually has, so a field a step names has to be one of them.
 */
const withNotes = {
    ...soFolderContent,
    'Mods/TestCase/testcase.sodso.json':
        JSON.stringify({ fileType: 'MurderMO', name: 'testcase', notes: '' }, null, 2),
};

/** A mod open in the case editor, with a file the tutorial can point into. */
async function openCase(page) {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, withNotes);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');
}

test('a step waits for the user to do it, rather than offering Next', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            {
                element: '#select-mod', title: 'Choose a mod',
                description: 'Pick one.', advanceWhen: 'mod-chosen',
            },
            { element: '#select-content', title: 'Choose where', description: 'Pick a folder.' },
        ],
    });

    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFolderContent);
    await connectFolders(page, { modDir: 'Mods' });

    await openTutorials(page);
    await start(page);

    const popover = page.locator(POPOVER);
    await expect(popover).toContainText('Choose a mod');
    // The point of the whole thing: a step that has not been done cannot be skipped.
    await expect(popover.locator(FORWARD)).toBeHidden();

    await page.selectOption('#select-mod', 'TestCase');
    await expect(popover).toContainText('Choose where');
    expect(await alerts(page)).toEqual([]);
});

test('a step with nothing to wait for is moved on by its Next button', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            { element: '#select-mod', title: 'First', description: 'Just reading.' },
            { element: '#select-content', title: 'Second', description: 'Also reading.' },
        ],
    });

    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFolderContent);
    await connectFolders(page, { modDir: 'Mods' });
    await openTutorials(page);
    await start(page);

    const popover = page.locator(POPOVER);
    await expect(popover).toContainText('First');
    await popover.locator(FORWARD).click();
    await expect(popover).toContainText('Second');
});

test('the walkthrough says how far through it you are', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            { element: '#select-mod', title: 'First', description: 'Reading.' },
            { element: '#select-content', title: 'Second', description: 'Reading.' },
            { element: '#folders-open', title: 'Third', description: 'Reading.' },
        ],
    });

    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFolderContent);
    await connectFolders(page, { modDir: 'Mods' });
    await openTutorials(page);
    await start(page);

    await expect(progress(page)).toHaveText('Step 1 of 3');
    await page.locator(FORWARD).click();
    await expect(progress(page)).toHaveText('Step 2 of 3');
});

test('you can step back to re-read, and forward to return', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            {
                element: '#select-mod', title: 'Choose a mod',
                description: 'Pick one.', advanceWhen: 'mod-chosen',
            },
            { element: '#select-content', title: 'Second', description: 'Reading.' },
            { element: '#folders-open', title: 'Third', description: 'Reading.' },
        ],
    });

    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFolderContent);
    await connectFolders(page, { modDir: 'Mods' });
    await openTutorials(page);
    await start(page);

    // Nowhere to go back to on the first step.
    await expect(progress(page)).toHaveText('Step 1 of 3');
    await expect(page.locator(BACK)).toBeHidden();

    await page.selectOption('#select-mod', 'TestCase');
    await expect(progress(page)).toHaveText('Step 2 of 3');
    await page.locator(FORWARD).click();
    await expect(progress(page)).toHaveText('Step 3 of 3');

    await page.locator(BACK).click();
    await expect(progress(page)).toHaveText('Step 2 of 3');
    await page.locator(BACK).click();

    // Back on a step that was finished by doing something. It must not fly past on the
    // condition it already met, or going back would be pointless.
    await expect(progress(page)).toHaveText('Step 1 of 3');
    await expect(page.locator(POPOVER)).toContainText('Choose a mod');
    await page.waitForTimeout(300);
    await expect(progress(page)).toHaveText('Step 1 of 3');

    // Forward returns to where the walkthrough had got to, rather than starting over.
    await expect(page.locator(FORWARD)).toBeVisible();
    await page.locator(FORWARD).click();
    await expect(progress(page)).toHaveText('Step 2 of 3');
    await page.locator(FORWARD).click();
    await expect(progress(page)).toHaveText('Step 3 of 3');

    expect(await alerts(page)).toEqual([]);
});

test('a live step that has not been done offers no way forward', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            { element: '#select-content', title: 'First', description: 'Reading.' },
            {
                element: '#select-mod', title: 'Choose a mod',
                description: 'Pick one.', advanceWhen: 'mod-chosen',
            },
        ],
    });

    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFolderContent);
    await connectFolders(page, { modDir: 'Mods' });
    await openTutorials(page);
    await start(page);

    await page.locator(FORWARD).click();
    await expect(progress(page)).toHaveText('Step 2 of 2');

    // Gated and not yet done: back to re-read is offered, forward is not.
    await expect(page.locator(FORWARD)).toBeHidden();
    await expect(page.locator(BACK)).toBeVisible();
});

test('the step count sits between the two arrows', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            { element: '#select-mod', title: 'First', description: 'Reading.' },
            { element: '#select-content', title: 'Second', description: 'Reading.' },
        ],
    });

    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFolderContent);
    await connectFolders(page, { modDir: 'Mods' });
    await openTutorials(page);
    await start(page);

    // Second step, so both arrows are on screen.
    await page.locator(FORWARD).click();
    await expect(progress(page)).toHaveText('Step 2 of 2');

    // driver.js groups its buttons together on one side; these have to straddle the
    // count instead.
    const back = await page.locator(BACK).boundingBox();
    const count = await progress(page).boundingBox();
    const forward = await page.locator(FORWARD).boundingBox();

    expect(back.x + back.width).toBeLessThanOrEqual(count.x + 1);
    expect(count.x + count.width).toBeLessThanOrEqual(forward.x + 1);

    // And centred: the gaps either side of it match.
    const footer = await page.locator('.driver-popover-footer').boundingBox();
    const leftGap = count.x - footer.x;
    const rightGap = (footer.x + footer.width) - (count.x + count.width);
    expect(Math.abs(leftGap - rightGap)).toBeLessThan(2);
});

test('a step waits for a file to be opened, then points at a field inside it', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            {
                element: '#so-file-list', title: 'Open the case',
                description: 'Click it.', advanceWhen: { fileOpen: 'testcase.sodso.json' },
            },
            {
                element: { file: 'testcase.sodso.json', field: 'notes' },
                title: 'Describe the case',
                description: 'Say what it is.',
                advanceWhen: { field: 'notes', file: 'testcase.sodso.json', is: 'A robbery' },
            },
        ],
    });

    await openCase(page);
    await openTutorials(page);
    await start(page);

    const popover = page.locator(POPOVER);
    await expect(popover).toContainText('Open the case');

    await page.locator('.file-panel-category[data-category="MurderMO"]')
        .getByRole('button', { name: 'testcase' }).click();

    await expect(popover).toContainText('Describe the case');

    // jsonTree renders the key as text, which no CSS selector can match, so the runner
    // finds the row by reading labels. This is the check that it found the right one:
    // the popover is anchored beside that row rather than floating unanchored, which is
    // what driver.js does when a step's element cannot be resolved.
    await expect(page.locator('.driver-popover-arrow')).not.toHaveClass(/driver-popover-arrow-none/);

    const row = fieldInput(page, '.file-window[path="testcase.sodso.json"]', 'notes');
    const rowBox = await row.boundingBox();
    const popoverBox = await popover.boundingBox();
    expect(Math.abs(popoverBox.y - rowBox.y)).toBeLessThan(60);

    expect(await alerts(page)).toEqual([]);
});

test('a field step waits for the value the tutorial asked for', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            {
                element: { file: 'testcase.sodso.json', field: 'notes' },
                title: 'Describe the case',
                description: 'Type "A robbery".',
                advanceWhen: { field: 'notes', file: 'testcase.sodso.json', is: 'A robbery' },
            },
            { element: '#select-mod', title: 'Done', description: 'That is it.' },
        ],
    });

    await openCase(page);
    await page.locator('.file-panel-category[data-category="MurderMO"]')
        .getByRole('button', { name: 'testcase' }).click();
    await page.locator('.file-window[path="testcase.sodso.json"]').waitFor();

    await openTutorials(page);
    await start(page);

    const popover = page.locator(POPOVER);
    await expect(popover).toContainText('Describe the case');

    const CASE = '.file-window[path="testcase.sodso.json"]';

    // Something, but not what was asked for: the walkthrough must not move on.
    await editField(page, CASE, 'notes', 'Something else');
    await expect(popover).toContainText('Describe the case');

    await editField(page, CASE, 'notes', 'A robbery');
    await expect(popover).toContainText('Done');

    expect(await alerts(page)).toEqual([]);
});

test('a step can wait for the user to change editor themselves', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            {
                element: '#flow-picker', title: 'Switch over',
                description: 'Change it yourself.', advanceWhen: { editor: 'dds' },
            },
            { element: '#new-file-button', title: 'Arrived', description: 'In the DDS editor.' },
        ],
    });

    await openCase(page);
    await openTutorials(page);
    await start(page);

    // No `flow` on the step, so nothing moves until the picker is used.
    await expect(page.locator(POPOVER)).toContainText('Switch over');
    await expect(page.locator('html[data-flow-ready="scriptableObject"]')).toBeAttached();

    await page.selectOption('#flow-picker', 'dds');
    await expect(page.locator(POPOVER)).toContainText('Arrived');
    expect(await alerts(page)).toEqual([]);
});

test('a step in another editor switches to it first', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            { element: '#select-mod', title: 'Here', description: 'In the case editor.' },
            {
                flow: 'dds', element: '#new-file-button',
                title: 'Over there', description: 'In the DDS editor.',
            },
        ],
    });

    await openCase(page);
    await openTutorials(page);
    await start(page);

    await expect(page.locator(POPOVER)).toContainText('Here');
    await page.locator(FORWARD).click();

    // The mod spans both editors, so a walkthrough that could not move between them
    // could only ever teach half the case.
    await expect(page.locator('html[data-flow-ready="dds"]')).toBeAttached();
    await expect(page.locator(POPOVER)).toContainText('Over there');
    expect(await alerts(page)).toEqual([]);
});

/** A case file long enough that its window has to scroll to reach the lower fields. */
const tallCase = {
    ...soFolderContent,
    'Mods/TestCase/testcase.sodso.json': JSON.stringify(
        Object.fromEntries([
            ['fileType', 'MurderMO'], ['name', 'testcase'],
            ...Array.from({ length: 60 }, (_, i) => [`field${i}`, `value ${i}`]),
        ]), null, 2),
};

const SCROLLER = '.file-window[path="testcase.sodso.json"] .jsontree-container';

test('the editor still scrolls as the walkthrough moves through it', async ({ page }) => {
    // Six steps, each pointing somewhere else, which is what used to break it: driver.js
    // marks the element it highlights and never unmarks it, and its stylesheet clamps
    // `overflow: hidden` on whatever holds a marked element. A few steps in, the file
    // list and the open document could no longer be scrolled to reach the next field --
    // and stayed that way after the walkthrough was closed.
    await useTutorial(page, {
        steps: Array.from({ length: 6 }, (_, i) => ({
            element: { file: 'testcase.sodso.json', field: `field${i * 5}` },
            title: `Step ${i}`,
            description: 'Reading.',
        })),
    });

    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, tallCase);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');
    await page.locator('.file-panel-category[data-category="MurderMO"]')
        .getByRole('button', { name: 'testcase' }).click();
    await page.locator(SCROLLER).waitFor();

    await openTutorials(page);
    await start(page);
    await expect(page.locator(POPOVER)).toContainText('Step 0');

    const clamped = () => page.evaluate(() =>
        document.querySelectorAll('*:not(body):has(> .driver-active-element)').length);

    for (let step = 1; step < 6; step += 1) {
        await page.locator(FORWARD).click();
        await expect(page.locator(POPOVER)).toContainText(`Step ${step}`);
        expect(await clamped(), `nothing clamped at step ${step}`).toBe(0);
    }

    // The document still scrolls, which is the whole point -- the fields a later step
    // points at are below the fold.
    const scrolled = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        el.scrollTop = 0;
        el.scrollTop = 300;
        return el.scrollTop;
    }, SCROLLER);
    expect(scrolled).toBe(300);

    await page.locator('.driver-popover-close-btn').click();
    await expect(page.locator(POPOVER)).toBeHidden();
    expect(await clamped()).toBe(0);
});

test('the highlight still tracks the element it points at', async ({ page }) => {
    // The mark is stripped, so this is the check that the cutout is not what was
    // carrying the highlight: it is drawn by the overlay, and has to keep moving.
    await useTutorial(page, {
        steps: [
            { element: '#select-mod', title: 'First', description: 'Reading.' },
            { element: '#folders-open', title: 'Second', description: 'Reading.' },
        ],
    });

    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFolderContent);
    await connectFolders(page, { modDir: 'Mods' });
    await openTutorials(page);
    await start(page);

    await expect(page.locator(POPOVER)).toContainText('First');
    const cutout = page.locator('.driver-overlay path');
    const first = await cutout.getAttribute('d');
    expect(first).toBeTruthy();

    await page.locator(FORWARD).click();
    await expect(page.locator(POPOVER)).toContainText('Second');
    await expect(cutout).not.toHaveAttribute('d', first);
});

/**
 * A case file with something nested to wait for.
 *
 * The DDS editor is what needs nested conditions -- a tree is nesting almost all the way
 * down -- but its documents are named after a GUID minted at creation, so a test cannot
 * point a step at one. The case editor renders the same jsonTree from a file whose path
 * is known, which is what these are really about: the walk, not the flow.
 *
 * The inner `name` is deliberate. It is what a step asking for the document's own `name`
 * must not find.
 */
const withNesting = {
    ...soFolderContent,
    'Mods/TestCase/testcase.sodso.json': JSON.stringify({
        fileType: 'MurderMO',
        name: '',
        victimJobModifiers: [{ name: 'inner', jobs: [], jobBoost: 0 }],
    }, null, 2),
};

const CASE_WINDOW = '.file-window[path="testcase.sodso.json"]';

/**
 * Open a collapsed node, the way jsonTree does it: a click on its label.
 *
 * Only the tests need this. The runner's conditions read rows whether or not their parent
 * is expanded -- jsonTree builds the whole tree and hides it by class -- but a user
 * cannot type into a row that is not on screen, and neither can Playwright.
 */
const expandNode = (page, scope, label) =>
    page.locator(`${scope} li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"${label}"'))`)
        .first()
        .locator(':scope > .jsontree_label-wrapper > .jsontree_label')
        .click();

/** The nesting fixture, with the case already open and the tutorial started. */
async function openNestedCase(page) {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, withNesting);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'TestCase', '');

    await page.locator('.file-panel-category[data-category="MurderMO"]')
        .getByRole('button', { name: 'testcase' }).click();
    await page.locator(CASE_WINDOW).waitFor();

    await openTutorials(page);
    await start(page);
}

test('a step can wait for a value nested inside the document', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            {
                element: { file: 'testcase.sodso.json' },
                title: 'Weight the job',
                description: 'Set it to 20.',
                advanceWhen: {
                    field: 'victimJobModifiers.0.jobBoost',
                    file: 'testcase.sodso.json',
                    is: 20,
                },
            },
            { element: '#select-mod', title: 'Done', description: 'That is it.' },
        ],
    });

    await openNestedCase(page);

    const popover = page.locator(POPOVER);
    await expect(popover).toContainText('Weight the job');

    await expandNode(page, CASE_WINDOW, 'victimJobModifiers');
    await expandNode(page, CASE_WINDOW, '0');

    // Something, but not what was asked for. Without this the walk could be matching the
    // wrong row entirely and every other assertion here would still pass.
    await editField(page, CASE_WINDOW, 'jobBoost', '5');
    await expect(popover).toContainText('Weight the job');

    await editField(page, CASE_WINDOW, 'jobBoost', '20');
    await expect(popover).toContainText('Done');

    expect(await alerts(page)).toEqual([]);
});

test('a nested field of the same name does not satisfy a step', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            {
                element: { file: 'testcase.sodso.json' },
                title: 'Name the case',
                description: 'Call it something.',
                advanceWhen: { field: 'name', file: 'testcase.sodso.json', is: 'outer' },
            },
            { element: '#select-mod', title: 'Done', description: 'That is it.' },
        ],
    });

    await openNestedCase(page);

    const popover = page.locator(POPOVER);
    await expect(popover).toContainText('Name the case');

    await expandNode(page, CASE_WINDOW, 'victimJobModifiers');
    await expandNode(page, CASE_WINDOW, '0');

    // The element inside victimJobModifiers is already called `inner`, and putting the
    // asked-for value in it must change nothing: an unqualified name means the
    // document's own field, not the first one of that name anywhere in it.
    const nested = page.locator(
        `${CASE_WINDOW} li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"name"')) input`
    ).nth(1);
    await nested.fill('outer');
    await nested.blur();
    await expect(popover).toContainText('Name the case');

    await editField(page, CASE_WINDOW, 'name', 'outer');
    await expect(popover).toContainText('Done');

    expect(await alerts(page)).toEqual([]);
});

test('a step can wait for an array to grow', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            {
                element: { file: 'testcase.sodso.json' },
                title: 'Add another',
                description: 'Two of them.',
                advanceWhen: {
                    rows: 'victimJobModifiers',
                    file: 'testcase.sodso.json',
                    count: 2,
                },
            },
            { element: '#select-mod', title: 'Done', description: 'That is it.' },
        ],
    });

    await openNestedCase(page);

    const popover = page.locator(POPOVER);
    // One element already, so the step must be waiting rather than already satisfied.
    await expect(popover).toContainText('Add another');

    await page.locator(CASE_WINDOW)
        .getByRole('button', { name: 'Add an element to "victimJobModifiers"' })
        .first().click();

    await expect(popover).toContainText('Done');
    expect(await alerts(page)).toEqual([]);
});

test('a step can ask for a popover of its own shape', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            {
                element: '#select-mod', title: 'Beside something wide',
                description: 'Reading.', popoverClass: 'tutorial-popover-narrow',
            },
            { element: '#select-content', title: 'Ordinary', description: 'Reading.' },
        ],
    });

    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFolderContent);
    await connectFolders(page, { modDir: 'Mods' });
    await openTutorials(page);
    await start(page);

    // The class is what the narrow rule in core/chrome.css keys off. Without it a step
    // pointing at a dialog card has no way to stop driver.js centring the popover over
    // the button it has just told you to press -- see the DDS "Add new..." step.
    const popover = page.locator(POPOVER);
    await expect(popover).toContainText('Beside something wide');
    await expect(popover).toHaveClass(/tutorial-popover-narrow/);

    // And it is this step's, not the walkthrough's.
    await popover.locator(FORWARD).click();
    await expect(popover).toContainText('Ordinary');
    await expect(popover).not.toHaveClass(/tutorial-popover-narrow/);
});

test('closing the walkthrough stops it watching', async ({ page }) => {
    await useTutorial(page, {
        steps: [
            {
                element: '#select-mod', title: 'Choose a mod',
                description: 'Pick one.', advanceWhen: 'mod-chosen',
            },
            { element: '#select-content', title: 'Next one', description: 'Reading.' },
        ],
    });

    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, soFolderContent);
    await connectFolders(page, { modDir: 'Mods' });
    await openTutorials(page);
    await start(page);

    await expect(page.locator(POPOVER)).toContainText('Choose a mod');
    await page.locator('.driver-popover-close-btn').click();
    await expect(page.locator(POPOVER)).toBeHidden();

    // Doing the thing the abandoned step was waiting for must not bring it back.
    await page.selectOption('#select-mod', 'TestCase');
    await expect(page.locator(POPOVER)).toBeHidden();
    expect(await alerts(page)).toEqual([]);
});
