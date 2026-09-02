import { test, expect } from '@playwright/test';
import {
    installFsHarness, seedFs, connectFolders, gotoFlow, alerts, queuePrompts, readFile,
    listDir, pickStringsFile, clipboard, reveal,
} from '../test-support/harness.js';
import { ddsBareFixture } from '../test-support/fixtures.js';

/**
 * The Theft Gone Wrong walkthrough, played from its first step to its last.
 *
 * One test, because the walkthrough is one thing: every step is unlocked by what the step
 * before it wrote, so there is no half of this that can be checked without doing the other
 * half first. Playing it is what says the tutorial can be walked at all -- a step naming a
 * control that is not there, or waiting on a condition the app never satisfies, leaves a
 * player stuck with nowhere to click and nothing said about why.
 *
 * The runner that plays a tutorial is covered by tests/tutorialRunner.spec.js, against
 * tutorials written for it. This is about the shipped file.
 *
 * It crosses both editors, because the walkthrough does: the case files, then the DDS
 * documents that hold the words on the note, then back to the case files to join the two
 * by the GUIDs those documents turned out to have.
 */

const POPOVER = '.driver-popover';
const FORWARD = '.driver-popover-next-btn';

/** The step on screen now. */
const heading = (page) => page.locator(`${POPOVER} .driver-popover-title`);

/**
 * Take the step, which doing what it asked has unlocked.
 *
 * The runner opens the way forward when a step's condition is met and leaves the leaving
 * to the player, so a test walking the tutorial presses the button like one. No wait of
 * its own is needed: Playwright will not click a disabled button, so a step that never
 * unlocks fails here -- which is exactly where it should fail.
 */
const takeStep = (page) => page.locator(FORWARD).click();

/**
 * Wait for a step to arrive, which is how a step that carries itself is taken.
 *
 * The walkthrough marks the steps whose doing is the whole of them -- open this file,
 * set this one field -- with `autoAdvance`, and those leave on their own. Pressing is
 * for the steps that stop; asserting the heading is for the steps that do not.
 *
 * That distinction is the reason this cannot be one helper that presses if it can: an
 * auto step keeps its button disabled for its whole life, so "press if enabled" would
 * quietly pass over a step that was meant to stop and never unlocked.
 */
const onStep = (page, title) => expect(heading(page)).toHaveText(title);

/**
 * Fail if the popover is sitting on a control the step is asking the player to use.
 *
 * The overlay lets clicks through, so the popover is the one thing left that can swallow
 * them. A step that points at a button and then covers what it told you to click next is
 * a walkthrough that cannot be walked -- and it is invisible to a test that drives the
 * control through `fill` or `selectOption`, neither of which does a hit test.
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

/** Whether the popover has come to rest on the card a step is pointing at. */
async function expectCutoutOn(page, selector) {
    // Polled because Pico animates a dialog open: the cutout and the card only agree once
    // it has settled, and the point here is where it comes to rest.
    await expect.poll(async () => {
        const card = await page.locator(selector).boundingBox();
        const cutout = await cutoutOrigin(page);
        return Math.max(Math.abs(cutout.x - card.x), Math.abs(cutout.y - card.y));
    }).toBeLessThan(20);
}

/** A row in an open document, found by the key the walkthrough names in its text. */
const label = (key) =>
    `li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"${key}"'))`;

const MOD = 'Mods/BareMod';
const CASE_FILE = 'theftgonewrong.MurderMO.sodso.json';
const EVIDENCE_FILE = 'CrumpledPaperStickupEvidence.EvidencePreset.sodso.json';
const OBJECT_FILE = 'CrumpledPaperStickupInteractable.InteractablePreset.sodso.json';

const windowFor = (file) => `.file-window[path$="${file}"]`;
const CASE_WINDOW = windowFor(CASE_FILE);

const row = (page, key, scope = CASE_WINDOW) => page.locator(`${scope} ${label(key)}`).first();

/**
 * Add an element to an array field and open it, which is what "add an entry" means.
 *
 * The right-click is the tree's own add: an array row carries its menu on the label. The
 * expand after it is what puts the new element's controls on screen -- an array comes
 * back collapsed, so without it the next thing to fill in is in the DOM and unreachable.
 */
async function addElement(page, key, scope = CASE_WINDOW) {
    const target = row(page, key, scope);
    await reveal(target);
    await target.locator('> .jsontree_label-wrapper > .jsontree_label').first()
        .click({ button: 'right' });
    await target.locator('.jsontree_expand-button').first().click();
}

/** Open a row that is already there, for the array elements that hold other fields. */
async function expandRow(page, key, scope = CASE_WINDOW) {
    const target = row(page, key, scope);
    await reveal(target);
    await target.locator('> .jsontree_label-wrapper .jsontree_expand-button').first().click();
}

/** Type into a field and leave it, which is what commits an edit. */
async function setField(page, key, value, scope = CASE_WINDOW) {
    const input = row(page, key, scope).locator('input').first();
    await reveal(input);
    await input.fill(value);
    await input.blur();
}

/**
 * Choose a `REF:` by name, out of the select2 a reference field hands over.
 *
 * Searched rather than picked by position: the walkthrough names the entry it wants, and
 * an index would pass just as well against the wrong list -- which is the failure this is
 * here to catch, since the names come from the shipped asset index rather than the mod.
 */
async function pickRef(page, scope, name) {
    await page.locator(`${scope} .select2-selection`).first().click();
    await page.locator('.select2-search__field').fill(name);
    await page.locator('.select2-results__option', { hasText: name }).first().click();
}

/**
 * Copy the GUID of the document in a DDS window, which is what its 📄 does.
 *
 * Two of the steps ask the player to keep a GUID and paste it into a case file later.
 * Clicking the icon rather than reading the title text is the point: the walkthrough's
 * instructions are only followable if that is what the icon does.
 */
async function copyGuid(page, windowSelector) {
    await page.locator(`${windowSelector} .copy-icon`).click();
    const guid = await clipboard(page);
    expect(guid, 'the 📄 put no GUID on the clipboard').toMatch(/^[0-9a-f-]{36}$/);
    return guid;
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

test('it walks from an empty mod to a case that drops a note the player can read',
    async ({ page }) => {
        // Thirty-four steps across both editors, most of which write a file and wait for
        // it to reach disk before the next one unlocks.
        test.slow();

        await gotoFlow(page, '?flow=scriptableObject');
        await seedFs(page, ddsBareFixture);
        // Both, because the walkthrough crosses into the DDS editor half way through and
        // that one reads the game's own content. The mod is bare either way: the folder
        // the case goes in is made by the walkthrough itself, a few steps below.
        await connectFolders(page, { streamingAssets: 'StreamingAssets', modDir: 'Mods' });

        await page.getByRole('button', { name: 'Tutorials' }).click();
        await page.getByRole('button', { name: 'Theft Gone Wrong' }).click();

        // --- scaffolding the case -------------------------------------------------

        await onStep(page, 'Pick a mod to build in');
        await page.selectOption('#select-mod', 'BareMod');

        // Choosing the mod is the whole of that step, so it carries itself.
        //
        // The walkthrough asks for this name exactly, because later steps read the file
        // by it. Naming the folder is the whole of this step too, and what satisfies it is
        // that folder becoming the one being edited -- so it carries itself as well.
        await onStep(page, 'Make a home for the case');
        await queuePrompts(page, ['theftgonewrong']);
        await page.locator('#new-content').click();

        // The folder arrives empty: this editor is asked for nothing to put in it, and
        // the manifest is written with the first file added to the load order.
        await onStep(page, 'Put the case in it');
        expect(await listDir(page, `${MOD}/theftgonewrong`)).toEqual([]);
        await page.locator('#manifest_add_item_button').click();

        await onStep(page, 'Make it a murder');

        // Pointing at the card, not at the dialog. Pico lays a <dialog> out as a full
        // viewport flex container holding the backdrop, so naming the dialog itself cuts
        // the hole around the whole screen and points at nothing.
        await expectCutoutOn(page, '#new-file-modal article');
        await expectPopoverClearOf(page, '#new-file-modal-submit', 'Create File');

        await page.fill('#new-file-modal-file-name', 'theftgonewrong');
        await page.selectOption('#new-file-modal-file-type', 'MurderMO');
        await page.locator('#new-file-modal-submit').click();

        // --- the case's own fields ------------------------------------------------

        // Making a file opens it, which is what that step waits for -- so it carries
        // itself, and the case is on screen for the steps below.
        //
        // Anchored to the document window rather than floating: driver.js centres a
        // popover whose element it could not resolve, which is what a step naming a
        // window that is not open would produce.
        await onStep(page, 'Say which killer this fits');

        // The manifest arrives with the file rather than with the folder, naming the file
        // the loader is to read. An unlisted case is one the game never loads.
        await expect
            .poll(async () => JSON.parse(
                (await readFile(page, `${MOD}/theftgonewrong/murdermanifest.sodso.json`)) || '{}'))
            .toMatchObject({ fileOrder: ['REF:theftgonewrong.MurderMO'] });

        await expect(page.locator('.driver-popover-arrow'))
            .not.toHaveClass(/driver-popover-arrow-none/);

        // Each of the auto steps below carries itself, so arriving at the next one is the
        // assertion that the last was satisfied by what the editor wrote.
        await addElement(page, 'compatibleWith');
        await pickRef(page, `${CASE_WINDOW} ${label('compatibleWith')}`, 'SerialKiller');

        // This one stops rather than carries: its condition sees the trait, and the score
        // it also asks for comes after. So the press is the player agreeing they are done.
        await onStep(page, 'Who does this?');
        await addElement(page, 'murdererTraitModifiers');
        const TRAITS = `${CASE_WINDOW} ${label('murdererTraitModifiers')}`;
        await expandRow(page, '0', TRAITS);
        await addElement(page, 'traitList', TRAITS);
        await pickRef(page, `${TRAITS} ${label('traitList')}`, 'Affliction-Destitute');
        await takeStep(page);

        // Also a stop: `Blades` is offered as well, and a step that left the moment `Guns`
        // landed would take the popover away mid-list.
        await onStep(page, 'What they bring');
        await addElement(page, 'weaponsPool');
        await pickRef(page, `${CASE_WINDOW} ${label('weaponsPool')}`, 'Guns');
        await takeStep(page);

        // A boolean is a true/false dropdown, and the game stores booleans as 0 and 1 --
        // so the step asking for `1` is asking for what picking `true` writes, not for a
        // number typed into a box. Worth pinning: the condition compares strictly.
        await onStep(page, 'Where it happens');
        const work = row(page, 'allowWork');
        await reveal(work);
        await work.locator('select').first().selectOption('true');

        await onStep(page, 'Who is behind the counter');
        await addElement(page, 'victimJobModifiers');
        const JOBS = `${CASE_WINDOW} ${label('victimJobModifiers')}`;
        await expandRow(page, '0', JOBS);
        await addElement(page, 'jobs', JOBS);
        await pickRef(page, `${JOBS} ${label('jobs')}`, 'Shopkeeper');
        await takeStep(page);

        await onStep(page, 'Somewhere worth robbing');
        await addElement(page, 'victimCompanyModifiers');
        const COMPANIES = `${CASE_WINDOW} ${label('victimCompanyModifiers')}`;
        await expandRow(page, '0', COMPANIES);
        await addElement(page, 'companies', COMPANIES);
        await pickRef(page, `${COMPANIES} ${label('companies')}`, 'PawnShop');
        await takeStep(page);

        await onStep(page, 'A stranger, not a colleague');
        await setField(page, 'sameWorkplaceBoost', '-3');

        // --- the two files the note takes -----------------------------------------

        await onStep(page, 'The thing they leave behind');
        await page.locator('#manifest_add_item_button').click();

        // The card is 660px wide in a 1280px viewport -- 310px either side, and a popover
        // at its 300px default needs that plus its offset and a margin, so it used to land
        // over the card and come to rest on Create File. The step wears
        // `tutorial-popover-narrow` for the gutter, which is what the DDS dialog's step
        // does for the same reason.
        //
        // Asserted rather than assumed: the step tells the player to press that button,
        // and a `fill` or a `selectOption` would never notice it was covered.
        await onStep(page, 'The evidence');
        await expectPopoverClearOf(page, '#new-file-modal-submit', 'Create File');

        // And the controls it names are reachable too -- a trial click hit-tests the point
        // the player would press without pressing it.
        for (const control of ['#new-file-modal-file-name', '#new-file-modal-file-type',
            '#new-file-modal-copy-from']) {
            await page.locator(control).click({ trial: true });
        }

        await page.fill('#new-file-modal-file-name', 'CrumpledPaperStickupEvidence');
        await page.selectOption('#new-file-modal-file-type', 'EvidencePreset');
        await page.selectOption('#new-file-modal-copy-from', 'CrumpledNameCipher');
        await page.locator('#new-file-modal-submit').click();

        // This one stops: what it has to say about copying is spent only once the file it
        // made is there to be described.
        await takeStep(page);

        // The next carries itself, so arriving is the assertion that the file was written.
        await onStep(page, 'The object itself');
        await page.locator('#manifest_add_item_button').click();
        await expectPopoverClearOf(page, '#new-file-modal-submit', 'Create File');
        await page.fill('#new-file-modal-file-name', 'CrumpledPaperStickupInteractable');
        await page.selectOption('#new-file-modal-file-type', 'InteractablePreset');
        await page.selectOption('#new-file-modal-copy-from', 'CrumpledPaperNameCypher');
        await page.locator('#new-file-modal-submit').click();

        // Making a file opens it, so the walkthrough goes straight to wiring the two
        // together: there is no step asking for the object to be opened, because there
        // would be nothing left for the player to do in it.
        //
        // A single reference field rather than an array -- the tree gives it a select2 of
        // its own -- and what lands is built from the preset's name, which is the name the
        // file was given. That is why the walkthrough names these two in the game's own
        // casing: a preset called `crumpledpaperstickupevidence` would write a reference
        // this step could never match.
        await onStep(page, 'Join the two');
        const OBJECT_WINDOW = windowFor(OBJECT_FILE);
        const spawn = row(page, 'spawnEvidence', OBJECT_WINDOW);
        await reveal(spawn);
        await pickRef(page, `${OBJECT_WINDOW} ${label('spawnEvidence')}`,
            'CrumpledPaperStickupEvidence');

        // The case has been open in the row since it was scaffolded, so there is no step
        // asking for it to be reopened -- one used to be here and could never have been
        // read, for the same reason opening the object could not.
        //
        // This is also the reason the walkthrough can be finished at all: the interactable
        // was made while this window was already open, and what a document may point at is
        // what the manifest names. The listing behind these dropdowns is re-read when the
        // manifest is saved rather than before, so the file made two steps ago is offered
        // here. See soReferenceEditing.
        await onStep(page, 'Leave it at the scene');
        await addElement(page, 'callingCardPool');
        const CARDS = `${CASE_WINDOW} ${label('callingCardPool')}`;
        await expandRow(page, '0', CARDS);
        await reveal(row(page, 'item', CARDS));
        await pickRef(page, `${CARDS} ${label('item')}`, 'CrumpledPaperStickupInteractable');

        // --- across into the DDS editor -------------------------------------------

        // The crossing is the player's to make -- but making it is the whole of the step,
        // so it leaves on its own once the editor has changed.
        await onStep(page, 'Now the words on the note');
        await page.selectOption('#flow-picker', 'dds');

        await onStep(page, 'Make a tree');
        await page.locator('#new-file-button').click();

        // Opening the dialog is what that step wanted; the next one wants the document. So
        // filling the dialog in must leave this one where it is: a walkthrough that moved
        // on here would land the player before the tree the following steps point into
        // exists.
        //
        // Asserted on the heading rather than the button, because this step carries itself
        // and an auto step's button is disabled for its whole life -- it would read as
        // locked whether the condition had been met or not.
        await onStep(page, 'Say what it is and what it says');
        // A note the player reads is a document, which is a kind of tree rather than a
        // thing of its own. Picking it here is what gives the note a page to be drawn on.
        await page.selectOption('#new-dds-file-type', 'tree:2');
        await page.fill('#new-dds-file-name', 'CrumpledNoteStickup');
        await page.fill('#new-dds-file-line', 'Hand everything over!');
        await onStep(page, 'Say what it is and what it says');

        // The popover must not sit over the dialog it is talking about, and this dialog is
        // tall enough that one below it has nowhere to go.
        await expectPopoverClearOf(page, '#new-dds-file-submit', 'Create');

        await page.locator('#new-dds-file-submit').click();

        // The two steps that follow are the walkthrough explaining what it just made, so
        // both stop and both are pressed: they have no condition at all, which is a step
        // that offers an open way forward rather than one that carries itself.
        await onStep(page, 'What the note says');
        await expect(page.locator('#file-window-0')).toHaveAttribute('path', /\.tree$/);
        await takeStep(page);

        // The first of the two GUIDs the last chapter is waiting for. Copied here because
        // this is the step that asks for it, and the tree window is about to be replaced
        // by the message.
        await onStep(page, 'Keep the GUID');
        const treeGuid = await copyGuid(page, '#file-window-0');
        await takeStep(page);

        // The message step must wait for the message, not for its dialog: the tree window
        // is still on screen while it is being filled in, and the step after this one
        // points at whatever #file-window-0 holds. It carries itself, so the check is that
        // it has not moved on yet.
        await onStep(page, 'The name the papers give them');
        await page.locator('#new-file-button').click();
        await page.selectOption('#new-dds-file-type', 'message');
        await onStep(page, 'The name the papers give them');

        await page.fill('#new-dds-file-name', 'MonkierTheftGoneWrong');
        await page.fill('#new-dds-file-line', 'The Robbery Reaper');
        await page.locator('#new-dds-file-submit').click();

        await onStep(page, 'Keep this GUID too');
        await expect(page.locator('#file-window-0')).toHaveAttribute('path', /\.msg$/);
        const messageGuid = await copyGuid(page, '#file-window-0');
        expect(messageGuid, 'the message copied the tree\'s GUID').not.toBe(treeGuid);
        await takeStep(page);

        // Two steps, for the same reason the tree and the message are two: the button and
        // the dialog it opens cannot both be pointed at from one place. The first ends when
        // the dialog appears.
        await onStep(page, 'One more thing to name');
        await page.locator('#new-file-button').click();

        // A strings file is chosen from the paths the game reads rather than named, so the
        // second ends when the CSV is open, not when the dialog is.
        await onStep(page, 'The file the name goes in');
        await page.selectOption('#new-dds-file-type', 'strings');
        await onStep(page, 'The file the name goes in');

        // Reachable rather than uncovered, which is the most this step can promise: the
        // dialog is centred and 660px wide, so in a 1280px viewport neither side has room
        // for a 300px popover and driver.js lays it over the dialog whatever `side` says.
        // A trial click is Playwright's own actionability check -- it hit-tests the point
        // the player would click and presses nothing -- so it fails exactly when the
        // popover would swallow the click, which is the thing that makes a step unwalkable.
        await page.locator('#new-dds-file-strings-field .select2-selection')
            .click({ trial: true });

        await pickStringsFile(page, 'Evidence/evidence.names');
        await page.locator('#new-dds-file-submit').click();

        // This one stops: a row is a key and a value and the click that writes them, and
        // its condition only sees the text reach the CSV.
        await onStep(page, 'Call it a crumpled paper');

        // Same hazard as the Create button: the player has to reach this control, so the
        // popover must not be sitting on it.
        await expectPopoverClearOf(page, '#strings-window .strings-add', 'the text box');

        // Added, typed and blurred, which is what autosave writes on.
        await page.locator('#strings-window .strings-add').click();

        const added = page.locator('#strings-window tbody.strings-rows tr').last();
        await added.getByLabel('Key').fill('CrumpledPaperStickupEvidence');
        await added.getByLabel('Text').fill('Crumpled Paper');
        await added.getByLabel('Text').blur();
        await takeStep(page);

        // --- back to the case files, to join the two by their GUIDs ---------------

        await onStep(page, 'Back to the case files');
        await page.selectOption('#flow-picker', 'scriptableObject');

        // Three of the last five steps ask for a file to be opened, and all three pass by
        // themselves here: switching editors keeps what each one had open -- see
        // navigation.js -- so the three documents are back on screen as soon as the case
        // editor is, and a step waiting for one of them to be open is satisfied before it
        // is read. They carry themselves, so a player who still has them open never sees
        // them; they are there for the run where the windows were closed on the way past.
        //
        // Which is why what is asserted is the step after each: arriving at it is the
        // walkthrough agreeing that the document the next instruction points into is open.
        await onStep(page, 'Point it at the note');

        // The GUID the player kept, pasted where the step says. Its condition only asks
        // that the field hold something, so the assertion that it holds the *right* thing
        // is the file read at the end.
        await setField(page, 'ddsDocumentID', treeGuid, windowFor(EVIDENCE_FILE));
        await takeStep(page);

        await onStep(page, 'And what it reads as');
        await setField(page, 'summaryMessageSource', treeGuid, windowFor(OBJECT_FILE));
        await takeStep(page);

        // The other GUID, and the one place the two must not be confused: the papers print
        // the name in the message, not the words on the note.
        await onStep(page, 'Give the killer a name');
        await setField(page, 'monkierDDSMessageList', messageGuid);
        await takeStep(page);

        // The last step has nothing to wait for and nothing after it, so pressing it is
        // what ends the walkthrough.
        await onStep(page, 'That is the case');
        await takeStep(page);
        await expect(page.locator(POPOVER)).toHaveCount(0);

        // --- and this is the mod it built ----------------------------------------

        // The case folder is the one the walkthrough made, so the DDS content it wrote is
        // inside the case rather than beside it.
        const CASE_DIR = `${MOD}/theftgonewrong`;
        const DDS = `${CASE_DIR}/DDSContent/DDS`;

        // Both chains, each ending in a line of text: the note's tree, and the message
        // that only carries the killer's nickname.
        await expect.poll(() => listDir(page, `${DDS}/Trees`)).toHaveLength(1);
        await expect.poll(() => listDir(page, `${DDS}/Messages`)).toHaveLength(2);
        await expect.poll(() => listDir(page, `${DDS}/Blocks`)).toHaveLength(2);

        expect(await readFile(page,
            `${CASE_DIR}/DDSContent/Strings/English/Evidence/evidence.names.csv`))
            .toContain('Crumpled Paper');

        // The GUIDs really were the ones copied out of the two documents, which is what
        // makes the evidence read the player's note instead of the base game's.
        const [treeFile] = await listDir(page, `${DDS}/Trees`);
        expect(treeFile).toBe(`${treeGuid}.tree`);

        // Both files the note takes landed, and the copied-from base is what makes them
        // short -- the step says four lines, so a copy that inlined the whole preset would
        // be a different file from the one the walkthrough describes.
        const evidence = JSON.parse(await readFile(page, `${CASE_DIR}/${EVIDENCE_FILE}`));
        expect(evidence.copyFrom).toBe('REF:EvidencePreset|CrumpledNameCipher');
        expect(evidence.ddsDocumentID).toBe(treeGuid);

        const object = JSON.parse(await readFile(page, `${CASE_DIR}/${OBJECT_FILE}`));
        expect(object.copyFrom).toBe('REF:InteractablePreset|CrumpledPaperNameCypher');
        expect(object.spawnEvidence).toBe('REF:EvidencePreset|CrumpledPaperStickupEvidence');
        expect(object.summaryMessageSource).toBe(treeGuid);

        // What the mod actually gained: every value a step waited for, in the file, in the
        // shape the game reads. The walkthrough advancing says the conditions were met;
        // this says they were met by the right thing.
        const saved = JSON.parse(await readFile(page, `${CASE_DIR}/${CASE_FILE}`));
        expect(saved.fileType).toBe('MurderMO');
        expect(saved.compatibleWith).toEqual(['REF:MurderPreset|SerialKiller']);
        expect(saved.murdererTraitModifiers[0].traitList)
            .toEqual(['REF:CharacterTrait|Affliction-Destitute']);
        expect(saved.weaponsPool).toEqual(['REF:MurderWeaponsPool|Guns']);
        expect(saved.allowWork).toBe(1);
        expect(saved.victimJobModifiers[0].jobs).toEqual(['REF:OccupationPreset|Shopkeeper']);
        expect(saved.victimCompanyModifiers[0].companies).toEqual(['REF:CompanyPreset|PawnShop']);
        expect(saved.sameWorkplaceBoost).toBe(-3);
        expect(saved.callingCardPool[0].item)
            .toBe('REF:InteractablePreset|CrumpledPaperStickupInteractable');
        expect(saved.monkierDDSMessageList).toBe(messageGuid);

        expect(await alerts(page)).toEqual([]);
    });
