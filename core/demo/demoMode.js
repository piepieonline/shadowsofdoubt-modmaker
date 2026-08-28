/**
 * Demo mode: the whole app, against content that is not on your disk.
 *
 * Turned on with `?demo` and off by leaving it out. There is no button for it -- it is
 * for trying the UI out, not a mode anyone should land in by accident.
 *
 * The point is that nothing about the app changes. Rather than teaching the flows about
 * a fake filesystem, this seeds the **Origin Private File System** and hands the shell
 * genuine browser-native `FileSystemDirectoryHandle` objects, exactly as the Playwright
 * harness does (see tests/support/harness.js). `createWritable({ keepExistingData })`,
 * `writable.seek()`, async `values()` and nested `getDirectoryHandle(..., { create })`
 * are the browser's real implementations, so every flow reads and writes the way it
 * always does and there is no demo-only code path to drift out of step.
 *
 * What that buys, and what it costs:
 *
 *  - Nothing is read from a Shadows of Doubt install, and nothing is read from or
 *    written to your mod folder. The remembered handles for both are left alone -- demo
 *    mode never calls selectFolder and never touches idb-keyval, so leaving demo mode is
 *    a reload with the parameter dropped.
 *  - Saving genuinely works, into the demo tree. That is what makes it useful: an edit
 *    can be saved, reopened and seen again, which a save that quietly did nothing could
 *    not show. The tree is wiped and reseeded on every load, so nothing accumulates and
 *    every visit starts from the same content.
 *
 * Only this subtree is wiped, never the OPFS root: the origin is shared with the test
 * harness, which seeds a tree of its own.
 */

/** The query parameter, and where the seeded content lives within OPFS. */
export const DEMO_PARAM = 'demo';
const DEMO_ROOT = 'demo-mode';

/**
 * Whether this page is in demo mode.
 *
 * Present is on, so `?demo` and `?demo=1` both work. `0` and `false` are honoured
 * because a URL carrying the parameter is easier to edit than one that has to have it
 * deleted -- and because a flow switch rewrites the query string, so the parameter is
 * sticky once it is there.
 */
export function isDemoMode(search = location.search) {
    const value = new URLSearchParams(search).get(DEMO_PARAM);
    return value !== null && value !== '0' && value !== 'false';
}

/** Resolve a '/'-separated path below a directory, creating as it goes. */
async function directoryAt(root, path) {
    let dir = root;
    for (const part of path.split('/').filter(Boolean)) {
        dir = await dir.getDirectoryHandle(part, { create: true });
    }
    return dir;
}

/**
 * Lay the demo content out fresh.
 *
 * A key ending in `/` is a directory rather than a file -- an empty `Floors/` is what
 * marks a building mod that has not saved a floor yet, and there is no file that would
 * imply it.
 */
async function seed(root, demoFiles) {
    for (const [path, contents] of Object.entries(demoFiles)) {
        if (path.endsWith('/')) {
            await directoryAt(root, path);
            continue;
        }

        const parts = path.split('/');
        const fileName = parts.pop();
        const dir = await directoryAt(root, parts.join('/'));

        const handle = await dir.getFileHandle(fileName, { create: true });
        const writable = await handle.createWritable();
        await writable.write(contents);
        await writable.close();
    }
}

/**
 * Wipe and reseed the demo tree, and answer with what the shell needs to open it: the
 * two folders, and the mod and content folder to start in.
 *
 * Installing the folders is the shell's, not this module's -- which global a folder is
 * published as belongs to core/folders.js, and demo mode has no business knowing it.
 *
 * The content is imported here rather than at the top of the file so that it is fetched
 * only in demo mode. `main.js` reaches this module, and everything main.js reaches is on
 * the initial page load for every visitor; see the note in core/refs.js about the rule
 * that protects.
 */
export async function seedDemoFolders() {
    const { demoFiles, DEMO_SELECTION, DEMO_PLUGINS, DEMO_STREAMING_ASSETS } =
        await import('./fixtures.js');

    const opfs = await navigator.storage.getDirectory();

    try {
        await opfs.removeEntry(DEMO_ROOT, { recursive: true });
    } catch {
        // Nothing there yet, which is the first visit.
    }

    const root = await opfs.getDirectoryHandle(DEMO_ROOT, { create: true });
    await seed(root, demoFiles);

    return {
        streamingAssets: await directoryAt(root, DEMO_STREAMING_ASSETS),
        modDir: await directoryAt(root, DEMO_PLUGINS),
        selection: DEMO_SELECTION,
    };
}
