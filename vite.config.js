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
 * The reference data that is fetched at runtime rather than imported.
 *
 * refs/ splits in two. `authored/`, `derived/` and `generated/` are 17 files read through
 * `import ... with { type: 'json' }`, so Rollup inlines them into the bundle and they must
 * not also be copied -- that would ship 4.3 MB twice. These two are read a file at a time
 * by URL, 1642 of them, and have to arrive as plain files.
 *
 * Not `publicDir`, because refs/ has to stay importable for the other three directories
 * and Vite does not allow importing out of the public folder. Copying only what is fetched
 * keeps both halves working and leaves refs/ where every existing path expects it.
 *
 * refs/assets/index.json is the awkward one: imported by the ScriptableObject flow's
 * loadRefs and fetched by nothing, while its 1532 neighbours are fetched and imported by
 * nothing. It ends up inlined *and* copied, which costs 177 bytes and needs no special case.
 */
const FETCHED_AT_RUNTIME = ['refs/assets', 'refs/floors'];

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
    },

    preview: {
        host: '127.0.0.1',
        port: 8124,
        strictPort: true,
    },
}));
