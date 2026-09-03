/**
 * The data URLs Rollup baked into the bundle, checked without being told what they are.
 *
 * dataFiles.spec.js names the files three flows read, which catches a regression in those
 * files and nothing else. This one goes the other way: it reads the built chunks, pulls
 * out every string literal that looks like a path into `refs/` or `tutorials/`, and holds
 * each one to the two things the original bug broke -- that it carries the base, and that
 * something is there when it is requested.
 *
 * Derived rather than listed, because the point is to cover a fetch nobody thought to add
 * a spec for. `const CHAIN_PATH = '/refs/derived/furnitureChain.json'` was written twice,
 * in two flows, months apart, and read correctly by everyone who saw it -- it looks exactly
 * like a correct path and is only wrong once the site is mounted somewhere other than the
 * root. A check that has to be remembered is no use against a mistake that easy to make.
 */
import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_URL } from '../playwright.build.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const BASE = new URL(BUILD_URL).pathname;

/**
 * Quoted string literals that reach into a runtime data directory.
 *
 * Both shapes matter. Some are whole files -- `"<base>refs/derived/roomCreator.json"` --
 * and some are directory prefixes a template joins a name onto at runtime, like
 * `ASSET_DATA` and `REF_ROOT`, which appear in the chunk as a literal ending in `/`. The
 * prefix ones cannot be fetched as they stand, so they are checked for the base only.
 */
const PATH_LITERAL = /["'`]([^"'`\n]*\b(?:refs|tutorials)\/[^"'`\n]*)["'`]/g;

const bakedPaths = () => {
    const found = new Set();

    for (const file of readdirSync(join(DIST, 'assets'))) {
        if (!file.endsWith('.js')) continue;

        const source = readFileSync(join(DIST, 'assets', file), 'utf8');
        for (const [, path] of source.matchAll(PATH_LITERAL)) {
            // Only the ones that are URLs the app requests. The chunks also carry prose
            // mentioning these directories -- the modules are heavily commented and some
            // of that survives into a string -- and a sentence with `refs/` in it is not
            // a path that has to resolve.
            if (/\s/.test(path)) continue;
            if (!path.includes('/refs/') && !path.includes('/tutorials/')) continue;

            found.add(path);
        }
    }

    return [...found].sort();
};

/**
 * The extraction itself, asserted before anything is concluded from it.
 *
 * A regex that quietly matches nothing would make every check below pass over an empty
 * list, which is the one way this spec could report success while testing the artifact not
 * at all. Minified chunk contents are exactly the kind of input where that happens.
 */
test('the built chunks contain data paths to check', () => {
    const paths = bakedPaths();

    expect(paths.length, `no refs/ or tutorials/ literals found in ${DIST}/assets`)
        .toBeGreaterThan(2);
});

test('every baked data path carries the base', () => {
    const stray = bakedPaths().filter((path) => !path.startsWith(BASE));

    expect(stray, `paths that would 404 once the site is mounted at ${BASE}`).toEqual([]);
});

test('every baked data file resolves', async ({ request }) => {
    /*
     * Only the paths that name a file outright. Two shapes cannot be requested as they
     * stand and are dropped here rather than filtered out of `bakedPaths`, so that the
     * base check above still sees them -- either written without the base is the same bug:
     *
     *   directory prefixes   `<base>refs/assets/`, joined to a name at runtime
     *   interpolated names   `<base>tutorials/${id}.tutorial.json`
     *
     * The second is why this is not simply an `.endsWith('.json')` test: that literal ends
     * in .json, is perfectly correct, and 404s when fetched with the placeholder still in
     * it. dataFiles.spec.js requests a real tutorial by name to cover what this cannot.
     */
    const files = bakedPaths()
        .filter((path) => path.endsWith('.json') && !path.includes('${'));

    const broken = [];
    for (const path of files) {
        const response = await request.get(path);
        if (!response.ok()) broken.push(`${path} -> ${response.status()}`);
    }

    expect(broken, 'data paths in the bundle that the artifact does not serve').toEqual([]);
    expect(files.length).toBeGreaterThan(0);
});

/**
 * The icons, which are the same seam by a different route.
 *
 * These are not fetched by any module -- they are `<link rel="icon">` hrefs that Vite
 * rewrites through the base while it processes index.html. Written with a leading slash
 * they would be passed through untouched and 404 on both builds, which is the identical
 * mistake in the identical place, so it is worth one assertion that the rewrite happened.
 */
test('the favicons are rewritten through the base and served', async ({ request }) => {
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    const hrefs = [...html.matchAll(/<link[^>]+rel="icon"[^>]*>/g)]
        .map(([tag]) => tag.match(/href="([^"]+)"/)?.[1])
        .filter(Boolean);

    expect(hrefs.length, 'no rel="icon" links in the built index.html').toBe(3);

    for (const href of hrefs) {
        expect(href.startsWith(BASE), `${href} was not rewritten through the base`).toBe(true);
        expect((await request.get(href)).status(), href).toBe(200);
    }
});
