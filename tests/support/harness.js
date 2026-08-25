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
 * Verified precondition: neither app calls queryPermission/requestPermission, which are
 * the OPFS-vs-picker behavioural difference that would otherwise bite. See the API
 * inventory in .local/PLAN.md.
 */

/**
 * Installs the picker stub and OPFS helpers. Must be called before `page.goto`, since
 * the stub has to be in place before the app's scripts run.
 */
export async function installFsHarness(page) {
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
        window.confirm = () => true;

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
 * @param contentPath path within the mod; '' selects the mod root
 */
export async function selectContent(page, modName, contentPath = '') {
    await page.selectOption('#select-mod', modName);
    // A mod-root content folder has an empty path, so match on the value exactly.
    await page.waitForFunction(
        (p) => [...document.querySelectorAll('#select-content option')].some((o) => o.value === p),
        contentPath, { timeout: 5000 });
    await page.selectOption('#select-content', contentPath);
    await page.waitForFunction(
        (m) => window.selectedMod?.modName === m, modName, { timeout: 5000 });
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
    await fieldInput(page, scope, label).fill(value);
    await fieldInput(page, scope, label).blur();
}

/** Queue responses for the app's next window.prompt() calls. */
export const queuePrompts = (page, values) =>
    page.evaluate((v) => { window.__promptQueue.push(...v); }, values);

/** Every window.prompt() the app raised, as `{ message, defaultValue }`. */
export const prompts = (page) => page.evaluate(() => window.__promptCalls);

/** Overwrite a single fixture file in place. */
export const writeFixture = (page, path, contents) =>
    page.evaluate(([p, c]) => window.__opfsSeed({ [p]: c }), [path, contents]);

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
