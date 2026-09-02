/**
 * Test harness for the File System Access API.
 *
 * Both apps reach the filesystem only through `window.showDirectoryPicker`, which
 * Playwright cannot drive -- it opens a native OS dialog. Rather than hand-rolling a
 * mock of FileSystemDirectoryHandle, we seed the Origin Private File System
 * (`navigator.storage.getDirectory()`) and hand the app *real* browser-native handles.
 *
 * That matters: the apps use `createWritable({ keepExistingData })`, `writable.seek()`,
 * async `values()` iteration and nested `getDirectoryHandle(..., { create })`. A mock
 * would encode our assumptions about those; OPFS exercises the real implementations.
 *
 * core/folders.js does call queryPermission/requestPermission, and OPFS answers both
 * with 'granted' -- the same answer a picked folder gives once its permission is held.
 * So the re-grant shortcut a remembered folder takes is exercised here rather than
 * skipped, which is what lets a test tell it apart from opening the picker.
 */

/** Whether this is a paced run being watched rather than an ordinary one. See `npm run demo`. */
const demoRun = () => Boolean(Number(process.env.TUTORIAL_DEMO ?? 0));

/**
 * Say on screen that a run being watched is a run, not somebody's own work.
 *
 * Demo mode itself cannot be used for this. `?demo` connects folders of its own and then
 * disables changing them -- which is the promise it makes, and which leaves a test unable
 * to connect the fixture it is about to run against. So the app's strip is borrowed rather
 * than its mode: the element is the one index.html already carries, so it is styled and
 * placed exactly as the real thing, and the words are this harness's own because the real
 * ones tell you to reload without a parameter that is not in the URL.
 *
 * An init script rather than a one-off, so it survives the reload a flow switch does.
 */
const markAsDemoRun = (page) => page.addInitScript(() => {
    const show = () => {
        const banner = document.getElementById('demo-banner');
        if (!banner) return;

        banner.innerHTML = '<strong>Demo run</strong> — a walkthrough being played by '
            + 'the test suite, against made-up content inside the browser. Nothing here is '
            + 'read from or written to your own folders.';
        banner.hidden = false;
    };

    // The script runs before the document does, so there is nothing to find yet.
    document.addEventListener('DOMContentLoaded', show, { once: true });
});

/**
 * Put what is about to be used in the middle of the screen, for a run being watched.
 *
 * A document is far taller than the pane holding it -- the tree the DDS walkthrough builds
 * is 1760px of rows in a 481px scroller -- so the row a step is about is usually well below
 * the fold. Playwright does not mind: it scrolls only where an action needs a hit test, and
 * `fill` and `selectOption` reach the element without one, so the value changes a thousand
 * pixels down and a watcher sees a still screen and no reason for the step to have passed.
 *
 * Nothing under an ordinary run, where the point is the assertion rather than the sight of
 * it, and where scrolling would be a difference between what is watched and what CI runs.
 *
 * Instant rather than smooth: a paced run leaves a second before the action either way, and
 * an animation still running when the action lands is a moving target to click.
 */
export async function reveal(locator) {
    if (!demoRun()) return;
    await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
}

/**
 * Installs the picker stub and OPFS helpers. Must be called before `page.goto`, since
 * the stub has to be in place before the app's scripts run.
 */
export async function installFsHarness(page) {
    if (demoRun()) await markAsDemoRun(page);

    await page.addInitScript(() => {
        // Directories the app will receive from showDirectoryPicker, in call order.
        window.__pickerQueue = [];
        // Every alert() the app raised, so tests can assert the absence of error paths.
        window.__alerts = [];

        const nativeAlert = window.alert;
        window.alert = (msg) => { window.__alerts.push(String(msg)); };
        window.__nativeAlert = nativeAlert;

        // Adding content, and correcting a value that will not parse, both ask through
        // window.prompt/confirm. Tests queue responses; an empty queue is a cancel, and
        // confirm defaults to true so "Add/Remove element?" proceeds.
        window.__promptQueue = [];
        // What the app asked, and what it offered as the answer -- a correction prompt
        // has to come back prefilled with the text that was rejected.
        window.__promptCalls = [];
        window.prompt = (message, defaultValue) => {
            window.__promptCalls.push({ message: String(message), defaultValue });
            return window.__promptQueue.length ? window.__promptQueue.shift() : null;
        };
        // What each confirm() asked, and what a test wants answered. Recorded because
        // for a delete the question *is* the feature: it lists what the file being
        // removed was referenced by, and nothing else reports that.
        window.__confirmCalls = [];
        window.__confirmQueue = [];
        window.confirm = (message) => {
            window.__confirmCalls.push(String(message));
            return window.__confirmQueue.length ? window.__confirmQueue.shift() : true;
        };

        // Copying and pasting array elements goes through the async Clipboard API,
        // which reads only with a permission the browser grants per context and which
        // Playwright would have to be configured to hand out. An in-page buffer stands
        // in: what the app writes is what it reads back, and a test can seed it.
        window.__clipboard = '';
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText: async (text) => { window.__clipboard = String(text); },
                readText: async () => window.__clipboard,
            },
        });

        // Recorded so tests can assert what the app asked for -- notably `startIn`,
        // which is how a remembered folder is offered back to the user.
        window.__pickerCalls = [];

        window.showDirectoryPicker = async (options) => {
            window.__pickerCalls.push(options ?? {});
            window.__lastPickerOptions = options ?? {};
            if (window.__pickerQueue.length === 0) {
                throw new Error('showDirectoryPicker called but the test queued no directory');
            }
            return window.__pickerQueue.shift();
        };

        /** Resolve an OPFS directory by '/'-separated path, creating as needed. */
        window.__opfsDir = async (path, create = true) => {
            let dir = await navigator.storage.getDirectory();
            for (const part of path.split('/').filter(Boolean)) {
                dir = await dir.getDirectoryHandle(part, { create });
            }
            return dir;
        };

        /** Wipe OPFS so each test starts from a known state. */
        window.__opfsReset = async () => {
            const root = await navigator.storage.getDirectory();
            for await (const name of root.keys()) {
                await root.removeEntry(name, { recursive: true });
            }
        };

        /**
         * Seed OPFS from a flat map of 'path/to/file' -> string contents.
         * Directories are created implicitly.
         */
        window.__opfsSeed = async (files) => {
            for (const [path, contents] of Object.entries(files)) {
                const parts = path.split('/');
                const fileName = parts.pop();
                const dir = await window.__opfsDir(parts.join('/'));
                const handle = await dir.getFileHandle(fileName, { create: true });
                const w = await handle.createWritable();
                await w.write(contents);
                await w.close();
            }
        };

        /** Read a file back out of OPFS, or null if absent. */
        window.__opfsRead = async (path) => {
            const parts = path.split('/');
            const fileName = parts.pop();
            try {
                const dir = await window.__opfsDir(parts.join('/'), false);
                return await (await (await dir.getFileHandle(fileName)).getFile()).text();
            } catch {
                return null;
            }
        };

        /** List entry names under an OPFS directory, or null if absent. */
        window.__opfsList = async (path) => {
            try {
                const dir = await window.__opfsDir(path, false);
                const out = [];
                for await (const name of dir.keys()) out.push(name);
                return out.sort();
            } catch {
                return null;
            }
        };
    });
}

/**
 * Navigate to a flow and wait until it is usable.
 *
 * Reference data loads through the flow descriptor, so it arrives after the page
 * does. Anything touching enums, templates or the type map must wait for this.
 */
export async function gotoFlow(page, path) {
    await page.goto(path);
    await page.locator('html[data-flow-ready]').waitFor();
}

/** Reset OPFS and write the given fixture files. Call after `page.goto`. */
export async function seedFs(page, files) {
    await page.evaluate(async (f) => {
        await window.__opfsReset();
        await window.__opfsSeed(f);
    }, files);
}

/** Queue OPFS directories to be returned by successive showDirectoryPicker calls. */
export async function queuePicks(page, paths) {
    await page.evaluate(async (ps) => {
        for (const p of ps) {
            window.__pickerQueue.push(await window.__opfsDir(p, false));
        }
    }, paths);
}

/**
 * Connect folders through the shared modal.
 *
 * @param mapping { folderId: opfsPath } -- e.g. { streamingAssets: 'StreamingAssets' }
 */
export async function connectFolders(page, mapping) {
    for (const [id, path] of Object.entries(mapping)) {
        await queuePicks(page, [path]);
        await page.locator(`[data-select-folder="${id}"]`).click();
        await page.locator(`.folder-row[data-folder="${id}"][data-state="connected"]`).waitFor();
    }
    await page.locator('#folders-continue').click();
}

/**
 * Choose a mod and one of its content folders, through the shell's two dropdowns.
 *
 * The waits take the default timeout rather than a shorter one of their own. Choosing a
 * mod reads the folder, and in the building flow that is followed by building a scene,
 * which under a full parallel run takes longer than the few seconds this used to allow.
 * A wait that gives up before the test does turns load into a failure; the test's own
 * timeout is what should decide that something has actually hung.
 *
 * @param contentPath path within the mod; '' selects the mod root
 */
export async function selectContent(page, modName, contentPath = '') {
    await page.selectOption('#select-mod', modName);
    // A mod-root content folder has an empty path, so match on the value exactly.
    await page.waitForFunction(
        (p) => [...document.querySelectorAll('#select-content option')].some((o) => o.value === p),
        contentPath);
    await page.selectOption('#select-content', contentPath);
    await page.waitForFunction((m) => window.selectedMod?.modName === m, modName);
}

/**
 * Open a DDS document by GUID, and wait for it.
 *
 * There is no GUID field to type into any more: documents are opened from the file
 * panel, from Browse..., or by following a reference out of a case file. None of those
 * can name an arbitrary base game GUID from a test, so this calls what all three of
 * them call.
 *
 * @param type for a GUID the reference data does not know -- a mod's own document
 */
export const openDdsDocument = (page, guid, type = null) =>
    page.evaluate(([g, t]) => window.setIdAndLoad(g, t), [guid, type]);

/**
 * Take the DDS view off, so every field a document holds is on the screen.
 *
 * A tree is shown the fields its own `treeType` is read for -- see
 * flows/dds/scripts/treeViews.js -- and the fixtures are mostly vmails, which read
 * neither `document`, nor `stopMovement`, nor a message's `order`, nor `itemPool`.
 *
 * For a test that is about something else and reached for a handy field to exercise it
 * with. A test about the view itself drives the switch directly, in tests/ddsViews.spec.js.
 */
export const showAllDdsFields = (page, on = true) =>
    page.locator('#dds-show-all-fields').setChecked(on);

/**
 * Answer the Add new... dialog's File question.
 *
 * Typed rather than set. The list is the game's strings files as a searchable select,
 * and select2 searches on the keystrokes -- writing the element's value leaves the
 * control showing something else, and the control is what the answer is read from.
 *
 * The whole path is typed, so the term matches an option exactly. That is also what
 * keeps the free-text entry select2 offers for an unmatched term off the top of the
 * results, where the highlighted one is.
 */
export async function pickStringsFile(page, path) {
    await page.locator('#new-dds-file-strings-field .select2-selection').click();
    await page.locator('.select2-search__field').pressSequentially(path);
    await page.locator('.select2-results__option--highlighted').click();
}

/**
 * Create DDS content through the Add new... dialog.
 *
 * The dialog offers a tree as one of the six kinds the game has rather than as "tree", so
 * `type: 'tree'` picks a conversation unless a `kind` says which. Named that way round
 * because what most of these tests are about is a document being written at all, and a
 * conversation is the plainest of the six -- the tests that care say so.
 *
 * @param fields type, and then name and line for a document, or strings for a CSV
 * @param fields.kind a `TreeType` index, for `type: 'tree'`
 */
export async function addDdsContent(page, { type, kind = 0, name, line = '', strings }) {
    await page.locator('#new-file-button').click();
    await page.selectOption('#new-dds-file-type', type === 'tree' ? `tree:${kind}` : type);

    if (type === 'strings') {
        await pickStringsFile(page, strings);
    } else {
        await page.fill('#new-dds-file-name', name);
        await page.fill('#new-dds-file-line', line);
    }

    await page.locator('#new-dds-file-submit').click();
}

/**
 * The `<input>` a tree renders over a field's value.
 *
 * Both flows edit values through one of these, so a value is read with toHaveValue
 * rather than toContainText: the text is the input's contents, not the document's.
 *
 * @param scope a selector for the window or panel to look in
 */
export const fieldInput = (page, scope, label) =>
    page.locator(`${scope} li:has(> .jsontree_label-wrapper > .jsontree_label:text-is('"${label}"')) input`).first();

/** Edit a field the way a user does: type into it, then leave. */
export async function editField(page, scope, label, value) {
    await reveal(fieldInput(page, scope, label));
    await fieldInput(page, scope, label).fill(value);
    await fieldInput(page, scope, label).blur();
}

/** Queue responses for the app's next window.prompt() calls. */
export const queuePrompts = (page, values) =>
    page.evaluate((v) => { window.__promptQueue.push(...v); }, values);

/** Every window.prompt() the app raised, as `{ message, defaultValue }`. */
export const prompts = (page) => page.evaluate(() => window.__promptCalls);

/** Every window.confirm() the app raised, in order. */
export const confirms = (page) => page.evaluate(() => window.__confirmCalls);

/** Answer the app's next window.confirm() calls. Anything past the queue is a yes. */
export const queueConfirms = (page, answers) =>
    page.evaluate((v) => { window.__confirmQueue.push(...v); }, answers);

/** Overwrite a single fixture file in place. */
export const writeFixture = (page, path, contents) =>
    page.evaluate(([p, c]) => window.__opfsSeed({ [p]: c }), [path, contents]);

/** What the app has put on the clipboard. */
export const clipboard = (page) => page.evaluate(() => window.__clipboard);

/** Put text on the clipboard for the app to paste. */
export const setClipboard = (page, text) =>
    page.evaluate((t) => { window.__clipboard = t; }, text);

export const readFile = (page, path) => page.evaluate((p) => window.__opfsRead(p), path);
export const listDir = (page, path) => page.evaluate((p) => window.__opfsList(p), path);
export const alerts = (page) => page.evaluate(() => window.__alerts);

/**
 * The labels of a rendered tree's *top-level* keys, in render order.
 *
 * `.jsontree_label` alone matches depth-first across the whole tree, so it picks up
 * nested keys and array indices too. This walks to the root node's immediate child
 * list instead. textContent rather than innerText because the DDS flow renders trees
 * collapsed, which makes innerText empty and any assertion on it vacuous.
 */
export async function topLevelLabels(page, windowSelector) {
    return page.evaluate((sel) => {
        // The first jsontree_child-nodes list under the window is the root's.
        const ul = document.querySelector(`${sel} ul.jsontree_child-nodes`);
        if (!ul) return [];
        return [...ul.children]
            .map((li) => li.querySelector(':scope > .jsontree_label-wrapper > .jsontree_label'))
            .filter(Boolean)
            .map((el) => el.textContent.replace(/"/g, '').trim());
    }, windowSelector);
}

/** Collect page console errors and uncaught exceptions for assertion. */
export function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });
    return errors;
}

/**
 * Whether an element's text can be read against what it is drawn on.
 *
 * Perceived brightness rather than the two colours being unequal: white on off-white
 * would pass that and be no more legible than white on white.
 *
 * This exists because the same mistake has been made twice. Pico sets `--pico-color` to
 * `--pico-primary-inverse` inside every `button`, for text sitting on a filled one -- so a
 * rule styling a button as a plain row and taking its colour from `--pico-color` gets
 * white, on whatever pale surface the row is actually on. Both places that draw a button
 * that way are covered by a check through here.
 *
 * @returns the gap, 0 to 255. Under about 100 is not worth calling readable.
 */
export function contrastGap(page, textSelector, backdropSelector) {
    return page.evaluate(([text, backdrop]) => {
        const value = (colour) => {
            const [r, g, b] = colour.match(/[\d.]+/g).map(Number);
            return 0.299 * r + 0.587 * g + 0.114 * b;
        };

        return Math.abs(
            value(getComputedStyle(document.querySelector(text)).color)
            - value(getComputedStyle(document.querySelector(backdrop)).backgroundColor));
    }, [textSelector, backdropSelector]);
}
