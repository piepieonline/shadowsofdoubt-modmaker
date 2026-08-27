import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, gotoFlow, alerts, queuePrompts, readFile,
    listDir,
} from './support/harness.js';
import { ddsBareFixture } from './support/fixtures.js';

/**
 * The shipped walkthrough, as opposed to the runner that plays it -- which is covered
 * by tutorialRunner.spec.js against tutorials of its own.
 *
 * This plays the real file, doing what each step asks, so that a step naming a control
 * that does not exist or a condition that cannot be met is a failed test rather than a
 * player stuck with nowhere to click. It stops where the walkthrough starts needing
 * base game assets the test fixtures do not carry.
 */

const POPOVER = '.driver-popover';

/** The step on screen now. */
const heading = (page) => page.locator(`${POPOVER} .driver-popover-title`);

/**
 * Where the hole in the overlay starts -- which is to say, what is being highlighted.
 *
 * driver.js draws the backdrop as one path: the viewport rectangle, then the cutout as
 * a second subpath. The cutout's first point is the highlighted element's top left,
 * less the stage padding.
 */
const cutoutOrigin = (page) => page.evaluate(() => {
    const d = document.querySelector('.driver-overlay path')?.getAttribute('d') ?? '';
    const cutout = d.split('M')[2] ?? '';
    const [x, y] = cutout.trim().split(/[\s,]+/).slice(0, 2).map(Number);
    return { x, y };
});

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

/** Start the walkthrough with a mod connected and nothing else done. */
async function beginTutorial(page) {
    await gotoFlow(page, '?flow=scriptableObject');
    await seedFs(page, ddsBareFixture);
    await connectFolders(page, { modDir: 'Mods' });

    await page.getByRole('button', { name: 'Tutorials' }).click();
    await page.getByRole('button', { name: 'Theft Gone Wrong' }).click();
}

/**
 * Do what the opening steps ask, checking the walkthrough keeps up.
 *
 * Naming the folder and choosing the case type are separate steps because they happen
 * in different places -- the first in a prompt, the second in a dialog that only exists
 * once the first is answered.
 */
async function scaffoldTheCase(page) {
    await expect(heading(page)).toHaveText('Pick a mod to build in');
    await page.selectOption('#select-mod', 'BareMod');

    // The walkthrough asks for this name exactly, because later steps read the file by it.
    await expect(heading(page)).toHaveText('Make a home for the case');
    await queuePrompts(page, ['theftgonewrong']);
    await page.locator('#new-content').click();

    // The dialog opening is what ends that step, not the case being written.
    await expect(heading(page)).toHaveText('Make it a murder');

    // Pointing at the card, not at the dialog. Pico lays a <dialog> out as a full
    // viewport flex container holding the backdrop, so naming the dialog itself cuts
    // the hole around the whole screen and points at nothing.
    //
    // Polled because Pico animates the dialog open: the cutout and the card only agree
    // once it has settled, and the point here is where it comes to rest.
    await expect.poll(async () => {
        const card = await page.locator('#new-case-modal article').boundingBox();
        const cutout = await cutoutOrigin(page);
        return Math.max(Math.abs(cutout.x - card.x), Math.abs(cutout.y - card.y));
    }).toBeLessThan(20);

    await page.selectOption('#new-case-modal-case-type', 'MurderMO');
    await page.locator('#new-case-modal button[type=submit]').click();

    // Scaffolding the case is what satisfies this one -- it is read off disk.
    await expect(heading(page)).toHaveText('Open the case');
    await page.locator('.file-panel-category[data-category="MurderMO"]')
        .getByRole('button', { name: 'theftgonewrong' }).click();
}

test('every step names a control and a condition the runner understands', async ({ page }) => {
    // Parsed and checked here rather than played: the later steps need base game assets
    // the fixtures do not have, and a typo in one of them should still be caught.
    const definition = await page.request.get('/tutorials/theftgonewrong.tutorial.json')
        .then((r) => r.json());

    expect(definition.steps.length).toBeGreaterThan(0);

    const NAMED = ['mod-chosen', 'content-chosen'];
    const CONDITION_KEYS = ['visible', 'fileOpen', 'editor', 'field', 'saved', 'savedText'];

    // Only the opening step puts you in an editor. Crossing between them mid-walkthrough
    // is most of what there is to learn about how the app is laid out, so those steps
    // ask and wait rather than doing it while you are reading.
    expect(definition.steps.filter((step) => step.flow)).toHaveLength(1);
    expect(definition.steps[0].flow).toBe('scriptableObject');

    for (const [index, step] of definition.steps.entries()) {
        const where = `step ${index + 1} (${step.title})`;

        expect(step.title, where).toBeTruthy();
        expect(step.description, where).toBeTruthy();

        if (step.flow) expect(['dds', 'scriptableObject'], where).toContain(step.flow);

        // Steps point at a whole document window, never at a row inside the tree.
        // Highlighting a row did not survive contact with the real thing: the trees are
        // long, the rows move as they are expanded, and the highlight landed nowhere
        // useful. The step names the key in its text instead.
        if (typeof step.element === 'object') {
            expect(step.element.field, `${where} should not target a field row`)
                .toBeUndefined();
            expect(Boolean(step.element.file || step.element.window), where).toBe(true);
        }

        if (step.advanceWhen === undefined) continue;

        if (typeof step.advanceWhen === 'string') {
            expect(NAMED, where).toContain(step.advanceWhen);
        } else {
            expect(Object.keys(step.advanceWhen).some((k) => CONDITION_KEYS.includes(k)), where)
                .toBe(true);
        }
    }
});

test('it walks from an empty mod to an open case', async ({ page }) => {
    await beginTutorial(page);
    await scaffoldTheCase(page);

    // Straight into the first field once the case is open.
    await expect(heading(page)).toHaveText('Say which killer this fits');

    // Anchored to the document window rather than floating: driver.js centres a popover
    // whose element it could not resolve, which is what a step naming a window that is
    // not open would produce.
    await expect(page.locator('.driver-popover-arrow'))
        .not.toHaveClass(/driver-popover-arrow-none/);

    // The case really was scaffolded into the mod, not somewhere the walkthrough invented.
    const saved = JSON.parse(
        await readFile(page, 'Mods/BareMod/theftgonewrong/theftgonewrong.sodso.json'));
    expect(saved.fileType).toBe('MurderMO');

    expect(await alerts(page)).toEqual([]);
});

test('a step reading the saved file waits for the value to reach disk', async ({ page }) => {
    await beginTutorial(page);
    await scaffoldTheCase(page);

    await expect(heading(page)).toHaveText('Say which killer this fits');

    /** Set compatibleWith in the open case, the way the editor would leave it. */
    const setCompatibleWith = (ref) => page.evaluate(async (value) => {
        const handle = await window.selectedMod.baseFolder
            .getFileHandle('theftgonewrong.sodso.json');
        const data = JSON.parse(await (await handle.getFile()).text());
        data.compatibleWith = [value];
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(data, null, 2));
        await writable.close();
    }, ref);

    // compatibleWith is an array, so there is no input to read -- the step is gated on
    // what reached the file. The wrong entry must not move it on: this is the check
    // that "strict on wiring" is actually strict.
    await setCompatibleWith('REF:MurderPreset|Burglar');
    await expect(heading(page)).toHaveText('Say which killer this fits');

    await setCompatibleWith('REF:MurderPreset|SerialKiller');
    await expect(heading(page)).toHaveText('Who does this?');

    expect(await alerts(page)).toEqual([]);
});

test('a DDS step waits for the document, not merely for the dialog', async ({ page }) => {
    // Served in place of the shipped file so the DDS chapter can be reached directly;
    // the steps themselves are copied from it, which is what is under test.
    const shipped = await page.request.get('/tutorials/theftgonewrong.tutorial.json')
        .then((r) => r.json());
    const from = shipped.steps.findIndex((s) => s.advanceWhen?.editor === 'dds');
    const to = shipped.steps.findIndex((s) => s.advanceWhen?.editor === 'scriptableObject');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);

    await page.route('**/tutorials/*.tutorial.json', (route) => route.fulfill({
        contentType: 'application/json',
        // Through the crossing back, so the last DDS step has somewhere to land.
        body: JSON.stringify({ steps: shipped.steps.slice(from, to + 1) }),
    }));

    await gotoFlow(page, '?flow=scriptableObject');
    // The DDS fixture's mod has no case manifest, and the case editor says so on the
    // way past. By this point in the real walkthrough the case chapter has written one.
    await seedFs(page, {
        ...ddsBareFixture,
        'Mods/BareMod/Content/murdermanifest.sodso.json': JSON.stringify(
            { enabled: true, fileOrder: [], loadBefore: '', version: 1 }, null, 2),
    });
    await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });
    await page.selectOption('#select-mod', 'BareMod');
    await page.selectOption('#select-content', 'Content');
    await page.waitForFunction(() => Boolean(window.selectedMod));

    await page.getByRole('button', { name: 'Tutorials' }).click();
    await page.getByRole('button', { name: 'Theft Gone Wrong' }).click();

    // The crossing is the player's to make.
    await expect(heading(page)).toHaveText('Now the words on the note');
    await expect(page.locator('html[data-flow-ready="scriptableObject"]')).toBeAttached();
    await page.selectOption('#flow-picker', 'dds');

    await expect(heading(page)).toHaveText('Make a tree');
    await page.locator('#new-file-button').click();

    // Opening the dialog is what that step wanted; the next one wants the document.
    await expect(heading(page)).toHaveText('Say what it is and what it says');
    await page.selectOption('#new-dds-file-type', 'tree');
    await page.fill('#new-dds-file-name', 'CrumpledNoteStickup');
    await page.fill('#new-dds-file-line', 'Hand everything over!');
    await expect(heading(page)).toHaveText('Say what it is and what it says');

    // The popover must not sit over the dialog it is talking about. The overlay lets
    // clicks through, so the popover is the one thing left that can swallow them --
    // and this dialog is tall enough that a popover below it has nowhere to go.
    const submit = await page.locator('#new-dds-file-submit').boundingBox();
    const popover = await page.locator(POPOVER).boundingBox();
    const overlaps = popover.x < submit.x + submit.width
        && popover.x + popover.width > submit.x
        && popover.y < submit.y + submit.height
        && popover.y + popover.height > submit.y;
    expect(overlaps, 'the popover is covering Create').toBe(false);

    await page.locator('#new-dds-file-submit').click();
    await expect(heading(page)).toHaveText('What the note says');
    await expect(page.locator('#file-window-0')).toHaveAttribute('path', /\.tree$/);

    await page.locator('.driver-popover-next-btn').click();
    await expect(heading(page)).toHaveText('Keep the GUID');
    await page.locator('.driver-popover-next-btn').click();

    // The message step must wait for the message, not for its dialog: the tree window
    // is still on screen while it is being filled in, and the step after this one
    // points at whatever #file-window-0 holds.
    await expect(heading(page)).toHaveText('The name the papers give them');
    await page.locator('#new-file-button').click();
    await page.selectOption('#new-dds-file-type', 'message');
    await expect(heading(page)).toHaveText('The name the papers give them');

    await page.fill('#new-dds-file-name', 'MonkierTheftGoneWrong');
    await page.fill('#new-dds-file-line', 'The Robbery Reaper');
    await page.locator('#new-dds-file-submit').click();

    await expect(heading(page)).toHaveText('Keep this GUID too');
    await expect(page.locator('#file-window-0')).toHaveAttribute('path', /\.msg$/);
    await page.locator('.driver-popover-next-btn').click();

    // A strings file is chosen from the paths the game reads rather than named, so this
    // step ends when the CSV is open, not when the dialog is.
    await expect(heading(page)).toHaveText('One more thing to name');
    await page.locator('#new-file-button').click();
    await page.selectOption('#new-dds-file-type', 'strings');
    await expect(heading(page)).toHaveText('One more thing to name');

    await page.selectOption('#new-dds-file-strings', 'Evidence/evidence.names');
    await page.locator('#new-dds-file-submit').click();

    await expect(heading(page)).toHaveText('Call it a crumpled paper');

    // Same hazard as the Create button: the player has to reach this control, so the
    // popover must not be sitting on it.
    const box = await page.locator('#strings-window .strings-add').boundingBox();
    const over = await page.locator(POPOVER).boundingBox();
    expect(
        over.x < box.x + box.width && over.x + over.width > box.x
        && over.y < box.y + box.height && over.y + over.height > box.y,
        'the popover is covering the text box',
    ).toBe(false);

    // Added, typed and blurred, which is what autosave writes on.
    await page.locator('#strings-window .strings-add').click();

    const added = page.locator('#strings-window tbody tr').last();
    await added.getByLabel('Key').fill('crumpledpaperstickupevidence');
    await added.getByLabel('Text').fill('Crumpled Paper');
    await added.getByLabel('Text').blur();

    await expect(heading(page)).toHaveText('Back to the case files');
    expect(await readFile(
        page, 'Mods/BareMod/Content/DDSContent/Strings/English/Evidence/evidence.names.csv',
    )).toContain('Crumpled Paper');

    // And the mod really gained both chains, each ending in a line of text.
    await expect.poll(() => listDir(page, 'Mods/BareMod/Content/DDSContent/DDS/Trees'))
        .toHaveLength(1);
    await expect.poll(() => listDir(page, 'Mods/BareMod/Content/DDSContent/DDS/Messages'))
        .toHaveLength(2);
    await expect.poll(() => listDir(page, 'Mods/BareMod/Content/DDSContent/DDS/Blocks'))
        .toHaveLength(2);

    expect(await alerts(page)).toEqual([]);
});
