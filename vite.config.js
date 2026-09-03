import { defineConfig } from 'vite';
import { cp } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * HTTPS for the LAN, when a certificate has been made.
 *
 * `npm run dev` is localhost-only and plain HTTP, which is all the tests and local work
 * need -- 127.0.0.1 is a secure context, so the File System Access API and OPFS are both
 * available without a certificate.
 *
 * `npm run dev:lan` is for driving the app from another machine, which is the normal case
 * for this tool: the game is installed on a Windows box and the mod folders are over
 * there. That needs HTTPS and not merely a different host. A LAN IP over plain HTTP is not
 * a secure context, so `showDirectoryPicker` would be undefined and every flow would fail
 * at the first folder prompt -- silently enough to look like the app is broken.
 *
 * Certificate absent means fall back to HTTP rather than fail: the mode is still useful
 * for looking at the layout on a phone. `npm run cert` makes one.
 */
const lanHttps = () => {
    const key = join(ROOT, 'key.pem');
    const cert = join(ROOT, 'cert.pem');

    if (!existsSync(key) || !existsSync(cert)) {
        console.warn('\nNo cert.pem/key.pem, serving the LAN over plain HTTP.'
            + '\nThe File System Access API needs a secure context, so folders will not open'
            + ' from another machine. Run `npm run cert` first.\n');
        return undefined;
    }

    return { key: readFileSync(key), cert: readFileSync(cert) };
};

/**
 * The data directories that are read at runtime by URL, copied whole.
 *
 * Whole directories, not the subdirectories that are known to be fetched. That distinction
 * was the bug: this list held `refs/assets` and `refs/floors` because those are read a file
 * at a time and obviously need to be plain files, while `refs/authored`, `refs/derived` and
 * `refs/generated` were taken to be the imported half -- read through `import ... with
 * { type: 'json' }`, inlined by Rollup, and not to be copied on top.
 *
 * That was true of two of the three. `refs/derived` is imported only by unit specs, which
 * run in Node against the source tree, so nothing inlined it and nothing shipped it, and
 * the three fetches of it 404ed on the deployed site. Splitting a directory by how its
 * files *happen* to be read today means every new fetch is a chance to get this wrong
 * again, and the failure is close to silent: `loadFurnitureChain` turns a failed fetch into
 * an absent panel, so the symptom was a feature quietly not being there.
 *
 * So the rule is now the coarse one -- if a directory is read at runtime at all, all of it
 * ships. The cost is that `refs/generated` is inlined *and* copied, about 4 MB of duplicate
 * in `dist`. That is deploy-artifact size only: nothing fetches those copies, so no user
 * ever downloads them, and the same was already true of refs/assets/index.json. Paying it
 * once is worth more than a list that has to be revised every time a fetch is added.
 *
 * Not `publicDir`, because refs/ has to stay importable -- Vite does not allow importing
 * out of the public folder. Copying leaves refs/ where every existing path expects it.
 */
const FETCHED_AT_RUNTIME = ['refs', 'tutorials'];

const copyFetchedRefs = () => ({
    name: 'copy-fetched-refs',
    apply: 'build',

    // `closeBundle` rather than `generateBundle`: these are opaque data files, not assets
    // Rollup should hash, reference or try to parse. A plain recursive copy is the whole
    // requirement.
    async closeBundle() {
        const out = this.environment?.config?.build?.outDir ?? 'dist';
        for (const dir of FETCHED_AT_RUNTIME) {
            await cp(join(ROOT, dir), join(ROOT, out, dir), { recursive: true });
        }
    },
});

/**
 * Two targets from one config.
 *
 * The web build is served from a GitHub Pages project site, so it is mounted under
 * /<repo>/ and every asset URL has to carry that prefix. The desktop build is served by
 * Electron over a custom app:// scheme from the packaged root, where document-relative is
 * both correct and the only thing that works. `base` is the whole of the difference, and
 * modules read it back through `import.meta.env.BASE_URL` rather than assuming either.
 *
 * `--mode desktop` selects it, so the two builds are one config and one command shape.
 */
export default defineConfig(({ command, mode, isPreview }) => ({
    // Only the built artifact is mounted anywhere but the root, so the base belongs to the
    // build and to previewing the build. Serving *dev* under the Pages prefix would move
    // every source path with it, and the Playwright suites reach into modules directly --
    // `import('/flows/...')` -- as does every `fetch('/refs/...')`. Those are the paths the
    // app itself uses when BASE_URL is `/`, which is what dev reports.
    //
    // `isPreview` is the whole reason this is not just `command`: Vite reports `serve` for
    // preview as well as dev, so testing `command` alone silently previews the built site
    // at the wrong base and every asset 404s.
    base: (command === 'serve' && !isPreview)
        ? '/'
        : (mode === 'desktop' ? './' : '/shadowsofdoubt-modmaker/'),

    plugins: [copyFetchedRefs()],

    /**
     * No single-page fallback. A request for a file that is not there must 404.
     *
     * The default serves index.html for any unmatched path, which this app reads as data:
     * `readBaseAsset` fetches refs/assets/<Type>/<Name>.json and treats a failure as "the
     * base game asset is not shipped", which is how it knows to ask for an exported
     * ScriptableObjects folder. Under the fallback that fetch succeeds with a page of
     * HTML, and the message becomes "not valid JSON" -- a parse error standing in for a
     * missing file.
     *
     * Nothing here needs the fallback. The shell selects a flow with a query parameter,
     * not a path, and the old per-flow URLs are real .html files that redirect.
     */
    appType: 'mpa',

    build: {
        outDir: mode === 'desktop' ? 'dist-desktop' : 'dist',
        emptyOutDir: true,

        // The three flows are dynamic-imported by the shell, so Rollup already splits them
        // out. Raised only to stop the building flow's three.js chunk printing a warning
        // on every build -- it is a 3D editor and that chunk is meant to be large.
        chunkSizeWarningLimit: 2_000,
    },

    server: {
        // Bound to loopback by default: that is what the Playwright suites expect, and
        // 127.0.0.1 is a secure context, so the File System Access API and OPFS are both
        // available without a certificate. See the note in playwright.shared.js.
        //
        // `--mode lan` opens it to the network over HTTPS instead. See lanHttps above for
        // why HTTPS is not optional there.
        host: mode === 'lan' ? true : '127.0.0.1',
        https: mode === 'lan' ? lanHttps() : undefined,
        port: 8123,
        strictPort: true,

        // No hot reload. Nothing in the app implements `import.meta.hot`, so an edit was
        // never being patched in -- the HMR client just reloaded the page whole, which
        // throws away the state the app is actually holding: the picked mod folder, the
        // open document and its unsaved edits. Reloading is a keypress; getting back to a
        // half-edited ScriptableObject is not. Edit, then refresh when you want to see it.
        hmr: false,
    },

    preview: {
        host: '127.0.0.1',
        port: 8124,
        strictPort: true,
    },
}));
