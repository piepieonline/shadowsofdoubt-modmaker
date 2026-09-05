/**
 * The whole of what the desktop build adds to the page.
 *
 * Three values, and deliberately no filesystem. The renderer reaches the disk through the
 * File System Access API exactly as the web build does; the desktop build's contribution is
 * that the main process lifts Chromium's blocklist first, which happens without the page
 * knowing. Bridging `fs` over IPC would work too, and would cost the property that makes
 * this whole approach cheap: one renderer, one set of specs, one way of reading a folder.
 *
 * `.cjs`, not `.js`. package.json declares `"type": "module"`, and a sandboxed preload is
 * CommonJS -- ESM preloads require `sandbox: false`, which is not a trade worth making for a
 * file this size. The extension is what says so unambiguously, to Electron and to a reader.
 *
 * `core/platform.js` reads this once at module load, so it has to be installed before any
 * page script runs. contextBridge does that by construction.
 */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * The app's version, handed over on the command line by main.js.
 *
 * Not `app.getVersion()`, which is a main-process call, and not sync IPC, which would block
 * the renderer's first paint on a round trip for a string that is known before the window
 * exists. `additionalArguments` is the one channel that is already there.
 */
const APP_VERSION_ARG = '--modmaker-version=';

const appVersion = process.argv
    .find((arg) => arg.startsWith(APP_VERSION_ARG))
    ?.slice(APP_VERSION_ARG.length) ?? null;

/**
 * The answer, held until somebody asks for it.
 *
 * Listening from here rather than from inside `onUpdateAvailable` because the two ends race:
 * the check is started in main as the window is created, and the renderer subscribes when
 * the shell's modules evaluate. Whichever wins, the message has to survive -- a listener
 * registered after delivery would miss it, and there is no second chance at a message that
 * is sent once per launch.
 */
let held = null;
let deliver = null;

ipcRenderer.on('update-available', (_event, release) => {
    if (deliver) deliver(release);
    else held = release;
});

contextBridge.exposeInMainWorld('__desktop', {
    /** Read as a boolean by core/platform.js; the object being here at all is the answer. */
    isDesktop: true,

    appVersion,

    /**
     * Called with `{ version, url }` when GitHub has a newer release than this one.
     *
     * Not called at all when the check fails for any reason -- offline, rate-limited, a
     * non-200, a tag that is not a version. Silence is the designed answer to every one of
     * those, so a renderer waiting on this must not treat never being called as an error.
     */
    onUpdateAvailable: (callback) => {
        deliver = callback;

        if (held) {
            deliver(held);
            held = null;
        }
    },
});
