/**
 * The desktop shell.
 *
 * This exists for one reason: Chromium will not let web content open a directory under
 * `Program Files` or `Program Files (x86)`. The list is compiled into the browser as
 * `kBlockAllChildren` -- reads as well as writes -- and no flag, prompt or amount of user
 * consent lifts it. A default Steam install puts the game at
 * `C:\Program Files (x86)\Steam\steamapps\common\Shadows of Doubt`, with the BepInEx
 * `plugins` folder inside it, so for those users both folders this app needs are
 * unreachable and `showDirectoryPicker` rejects with the same `AbortError` it gives for a
 * cancel. Users whose Steam library is on a second drive never see it, which is why it
 * reads as an intermittent complaint rather than a universal one.
 *
 * Electron inherits the blocklist and, unlike the browser, exposes a way out of it:
 * `file-system-access-restricted`. That is the whole of the difference. The renderer is the
 * same bundle the web build ships, it keeps calling `showDirectoryPicker`, and nothing here
 * bridges the filesystem -- there is no `fs` over IPC, because once the blocklist is lifted
 * there is nothing to bridge.
 *
 * Two files, both small, both plain Node: electron-vite was considered and dropped, because
 * the renderer's build is Vite's and is covered by tests-build/, and adopting electron-vite
 * would move that config under a tool whose job is the part that needs no bundling at all.
 */
import { app, BrowserWindow, net, protocol, session, shell } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isNewer } from './version.js';

/**
 * Where the renderer is served from.
 *
 * Not `loadFile`, and the reasons survived bundling. A module script under `file://` gets an
 * opaque origin and will not load at all. And `core/folders.js` persists
 * `FileSystemDirectoryHandle` objects through idb-keyval, which needs durable storage, which
 * an opaque origin does not get -- so every launch would open with no folders connected and
 * no way to remember the ones you picked.
 *
 * A fixed host, so the origin is one string for the lifetime of the app. Change it and every
 * folder anyone has connected is forgotten, because the handles are stored against it.
 */
const SCHEME = 'app';
const HOST = 'modmaker';
const START_URL = `${SCHEME}://${HOST}/index.html`;

/** The Vite build, beside this directory. `npm run build:desktop` writes it. */
const ROOT = fileURLToPath(new URL('../dist-desktop/', import.meta.url));

const RELEASES_API = 'https://api.github.com/repos/piepieonline/shadowsofdoubt-modmaker/releases/latest';
const RELEASES_PAGE = 'https://github.com/piepieonline/shadowsofdoubt-modmaker/releases/latest';

/**
 * Content types by extension, because nothing else is going to supply them.
 *
 * A protocol handler returns whatever headers it says it returns, and a `.js` served without
 * `text/javascript` is refused by the module loader -- which looks like the app simply not
 * starting. `.json` matters as much: `refs/` is read by `fetch(...).json()` in a dozen
 * places.
 *
 * The fallback is `application/octet-stream` rather than a guess. A wrong type that happens
 * to be executable or renderable is worse than a download that never happens, and every
 * extension the build actually emits is on this list.
 */
const CONTENT_TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
};

/**
 * No remote origin, anywhere.
 *
 * This is what bounds the grant made below. Allowing every blocked path is a wide thing to
 * do, and it is only defensible while the renderer cannot be made to run somebody else's
 * code -- so the policy that says it cannot is next to the code that needs it to be true.
 * `tests/offline.spec.js` and `tests-build/dist.spec.js` already assert the bundle reaches
 * for nothing remote; this is the same claim enforced rather than observed.
 *
 * `'unsafe-inline'` is in `script-src` because the markup still uses inline `onclick`
 * attributes -- see the note at the top of main.js -- and index.html carries one inline
 * script. It weakens the policy against injected inline code, and does not weaken the part
 * that matters here, which is that no script may be *fetched* from anywhere but this origin.
 * `style-src` needs it for the same reason at one remove: jsonTree and select2 both write
 * style attributes.
 *
 * `'unsafe-eval'` and `blob:` are both troika, and both were left out of the first version of
 * this policy -- which silently removed every piece of text from the floorplan view.
 * troika-worker-utils assembles its worker out of stringified functions: it rebuilds them on
 * the other side with `new Function`, which needs the first, and pulls its modules in with
 * `importScripts` on a blob URL, which needs the second. `worker-src blob:` is not enough for
 * that second one -- it permits the worker to exist, while a script the worker then loads is
 * `script-src`'s business.
 *
 * They fail one at a time, which is worth knowing if this ever moves again: fixing the eval
 * only got as far as `Failed to execute 'importScripts'`. And neither says anything on screen.
 * The floor renders, the room colours are right, and the labels and the selected square's mark
 * are simply not there -- which reads as a rendering quirk, not as a policy refusing an API.
 *
 * What is left of this policy after those three is still the part that matters and the part
 * the grant below is defended by: no script, style, font, image or connection may come from
 * anywhere but this origin. Eval of a local string is a much smaller thing than a fetch of a
 * remote one, and no remote one can happen here.
 *
 * `blob:` in `worker-src` is troika, which compiles its font worker from a blob URL. Local
 * by construction -- a blob comes from this origin or it does not exist.
 *
 * The update check is deliberately not here. It runs in the main process precisely so that
 * `api.github.com` never has to appear in this list.
 */
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

/**
 * Before `app.whenReady`, which is a hard requirement of the API and not a preference.
 *
 * `standard` gives the scheme a real origin, which is what localStorage and IndexedDB are
 * keyed by. `secure` is what makes it a secure context, which the File System Access API
 * requires -- without it `showDirectoryPicker` is not defined and the app cannot do anything
 * at all. `supportFetchAPI` is `fetch('refs/...')`, which is how every reference file is
 * read. `stream` lets a response body be one.
 */
protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

/**
 * A request path resolved inside the bundle, or null if it points outside it.
 *
 * `..` in a URL is normalised away by `new URL` before it reaches here, but the check is on
 * the resolved path rather than on the request, because that is the property that actually
 * matters and it does not depend on being right about what the URL parser does.
 */
function resolveWithin(pathname) {
    let decoded;

    try {
        // Percent-encoding is real here: several reference files have spaces in their names.
        decoded = decodeURIComponent(pathname);
    } catch {
        // A malformed escape -- `%zz`. Thrown rather than returned by decodeURIComponent, and
        // thrown from outside the handler's try, where it would reject the response and show
        // a network error instead of a status.
        return null;
    }

    const target = join(ROOT, decoded === '/' ? '/index.html' : decoded);

    const inside = relative(ROOT, target);
    if (inside.startsWith('..') || isAbsolute(inside)) return null;

    return target;
}

/**
 * Serve the built renderer.
 *
 * Read whole rather than streamed: the largest file the build emits is under 2 MB, and
 * `readFile` is patched for asar while a file:// stream through the network stack is one
 * more thing that would have to be true of a packaged build.
 *
 * A missing file is a 404 and must stay one. `vite.config.js` turns the single-page fallback
 * off for the same reason: `readBaseAsset` reads a failed fetch of
 * `refs/assets/<Type>/<Name>.json` as "the base game asset is not shipped", which is how the
 * app knows to ask for an exported ScriptableObjects folder. Answer that with index.html and
 * the message becomes a JSON parse error standing in for a missing file.
 */
async function serve(request) {
    const target = resolveWithin(new URL(request.url).pathname);

    if (!target) return new Response('Forbidden', { status: 403 });

    try {
        if ((await stat(target)).isDirectory()) return new Response('Not found', { status: 404 });

        return new Response(await readFile(target), {
            headers: {
                'Content-Type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
                'Content-Security-Policy': CSP,
            },
        });
    } catch {
        return new Response('Not found', { status: 404 });
    }
}

/**
 * Let the renderer open the folder it asked for, wherever it is.
 *
 * Unconditionally. A policy that allowed only `Program Files` would be a guess about where
 * anyone's game is installed, and being wrong about it puts the user back in front of a
 * dialog that closes and does nothing -- which is the entire problem this build exists to
 * solve. What bounds this is the CSP above, not a path list.
 *
 * The path is logged because the first bug report will be "it still cannot see my game
 * folder", and this line is the difference between diagnosing that and guessing at it.
 */
function allowRestrictedPaths(ses) {
    ses.on('file-system-access-restricted', (event, details, callback) => {
        console.log(`[fs-access] allowing blocked path: ${details.path}`
            + ` (directory: ${details.isDirectory}, origin: ${details.origin})`);
        callback('allow');
    });
}

/**
 * Links go to the user's browser, never into this window.
 *
 * The update banner links to the Releases page, and without this, clicking it navigates the
 * app itself to github.com -- the shell, the connected folders and any unsaved edits
 * replaced by a web page, with no way back but restarting. `will-navigate` covers an
 * ordinary link and `setWindowOpenHandler` covers `target="_blank"`.
 */
function keepNavigationLocal(contents) {
    contents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://')) shell.openExternal(url);
        return { action: 'deny' };
    });

    contents.on('will-navigate', (event, url) => {
        if (new URL(url).origin === `${SCHEME}://${HOST}`) return;

        event.preventDefault();
        if (url.startsWith('https://')) shell.openExternal(url);
    });
}

/**
 * Tell the renderer, once it is there to be told.
 *
 * The check is started as the window is created, so on a fast network it can finish before
 * the page exists -- and `webContents.send` to a renderer that has not loaded yet is
 * dropped, silently, which would read as "the update banner sometimes does not appear".
 * The preload holds the message for a subscriber that has not registered yet; this holds it
 * for a renderer that is not there at all.
 */
function announce(window, release) {
    if (window.isDestroyed()) return;

    const send = () => {
        if (!window.isDestroyed()) window.webContents.send('update-available', release);
    };

    if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send);
    else send();
}

/**
 * Ask GitHub what the latest release is, and say so if it is newer than this.
 *
 * In the main process rather than the renderer, which keeps `api.github.com` out of the CSP
 * and out of the two suites that assert the renderer reaches for nothing remote.
 *
 * Every failure is silence: no network, rate-limited at 60 requests an hour unauthenticated,
 * a non-200, JSON that will not parse, a tag that is not a version. A modding tool that
 * complains about its own update server to somebody with no internet is worse than one that
 * says nothing, and there is no case where a message about this is what the user came for.
 */
async function checkForUpdate(window) {
    try {
        const response = await net.fetch(RELEASES_API, {
            headers: { Accept: 'application/vnd.github+json' },
        });
        if (!response.ok) return;

        const { tag_name: tag } = await response.json();
        if (!isNewer(tag, app.getVersion())) return;

        announce(window, { version: tag, url: RELEASES_PAGE });
    } catch {
        // Deliberately nothing. See above.
    }
}

function createWindow() {
    const window = new BrowserWindow({
        width: 1440,
        height: 900,
        // The app draws its own header and the flows fill the rest; anything narrower than
        // this squeezes the two selects in the nav until the folder and tutorial buttons
        // leave the screen. tests/shell.spec.js pins that at 1280.
        minWidth: 1280,
        minHeight: 720,
        show: false,
        backgroundColor: '#13171f',

        webPreferences: {
            preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,

            // How the preload learns the version without a synchronous IPC round trip on
            // the way to the first paint. See the note in preload.cjs.
            additionalArguments: [`--modmaker-version=${app.getVersion()}`],
        },
    });

    keepNavigationLocal(window.webContents);

    // Shown when it has something to draw, rather than as an empty frame while the bundle
    // parses. The building flow's chunk is several megabytes of three.js.
    window.once('ready-to-show', () => window.show());

    window.loadURL(START_URL);

    return window;
}

app.whenReady().then(() => {
    protocol.handle(SCHEME, serve);
    allowRestrictedPaths(session.defaultSession);

    const window = createWindow();
    checkForUpdate(window);

    // macOS is not a shipping target, but this is what makes the app usable while it is
    // being developed on one: with no windows, clicking the dock icon must reopen it.
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) checkForUpdate(createWindow());
    });
});

// Windows and Linux only, so closing the last window is quitting. Left as an explicit
// platform test rather than an unconditional quit because the app runs on macOS during
// development and quitting on close there is wrong enough to be confusing.
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
