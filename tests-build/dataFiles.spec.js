/**
 * The runtime data directories, as the artifact ships them.
 *
 * `refs/` and `tutorials/` are read a file at a time by URL rather than imported, so
 * Rollup never sees them and the only thing that puts them in `dist` is the copy step in
 * vite.config.js. Nothing else in the suites can notice when that step misses something:
 * the dev server serves the source tree, where every one of these files is present at the
 * path the app asks for whether the build would have copied it or not.
 *
 * The bug this exists for shipped exactly that way. The copy list named `refs/assets` and
 * `refs/floors` and not `refs/derived`, so three fetches 404ed on the deployed site while
 * every spec passed. It was close to invisible in use, too -- `loadFurnitureChain` turns a
 * failed fetch into an absent panel -- so the first two checks here are deliberately blunt
 * and compare directory listings rather than trusting a hand-written list of what matters.
 */
import { test, expect } from '@playwright/test';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_URL } from '../playwright.build.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = new URL(BUILD_URL).pathname;

/** Every directory copied into the artifact whole, as vite.config.js lists them. */
const COPIED = ['refs', 'tutorials'];

/**
 * Every file under `dir`, as paths relative to it, with the OS separator normalised.
 *
 * A directory that is not there is empty rather than an error. Absent is the exact failure
 * being tested for -- a directory left out of the copy list does not arrive at all -- and
 * letting readdir throw turns the clearest possible result into an ENOENT stack from
 * inside a helper, which reads as a broken spec rather than a broken build.
 */
const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }) : [])
    .map((entry) => String(entry).split('\\').join('/'))
    .filter((entry) => statSync(join(dir, entry)).isFile());

for (const dir of COPIED) {
    /**
     * Listing against listing, not a sample.
     *
     * A sample answers "did the copy run", which was never the question -- the copy ran,
     * it ran over the wrong list. Only comparing the whole tree catches a directory that
     * was left out, and it catches it without anyone having to remember to add the new
     * directory to a spec as well as to the config.
     */
    test(`${dir}/ reaches dist with every child intact`, () => {
        const source = filesUnder(join(ROOT, dir)).sort();
        const built = new Set(filesUnder(join(ROOT, 'dist', dir)));

        const missing = source.filter((file) => !built.has(file));

        expect(missing, `${dir}/ files absent from dist/${dir}/`).toEqual([]);
        expect(source.length).toBeGreaterThan(0);
    });
}

/**
 * One file from each, actually served.
 *
 * Present in `dist` and served under the base are two different claims: the first is the
 * copy step's, the second is the base's, and the original bug broke both at once. These
 * are named rather than sampled from the listing so that a failure says which flow stops
 * working, and they are the specific files the three flows read on the paths that were
 * wrong.
 */
const SERVED = [
    ['refs/derived/furnitureChain.json', 'the building flow\'s furniture panel'],
    ['refs/derived/roomCreator.json', 'the room creator'],
    ['refs/floors/index.json', 'the building library'],
    ['refs/assets/index.json', 'the ScriptableObject flow\'s base assets'],
    ['tutorials/theftgonewrong.tutorial.json', 'the tutorials modal'],
];

for (const [path, reader] of SERVED) {
    test(`${path} is served under the base, for ${reader}`, async ({ request }) => {
        // Relative, so Playwright resolves it against the base the way the app's own
        // BASE_URL-joined fetches do. A leading slash here would test the wrong thing.
        const response = await request.get(path);

        expect(response.status(), `${BASE}${path}`).toBe(200);

        // Parsed, not just fetched: a 200 of HTML is what the single-page fallback would
        // hand back, and it is the failure the next test guards against directly.
        expect(await response.json()).toBeTruthy();
    });
}

/**
 * The base is load-bearing, not decoration.
 *
 * This is the half of the bug that a same-origin fetch hides in development: at the dev
 * server the site *is* at the root, so `/refs/...` and `<base>refs/...` are the same URL
 * and a path written without the prefix works perfectly until it is deployed.
 */
test('the same path without the base prefix is not served', async ({ request }) => {
    const response = await request.get('/refs/derived/furnitureChain.json');

    expect(response.status()).toBe(404);
});

/**
 * A missing file must 404 rather than resolve to the shell.
 *
 * `appType: 'mpa'` in vite.config.js is what turns the single-page fallback off, and the
 * app depends on it: `readBaseAsset` reads a failed fetch as "the base game asset is not
 * shipped", which is how it knows to ask for an exported ScriptableObjects folder. Under
 * the fallback that fetch succeeds with a page of HTML and the message becomes "not valid
 * JSON" -- a parse error standing in for a missing file. Nothing about that reads as a
 * config regression, so it is asserted here where the config is what is under test.
 */
test('a missing data file 404s instead of falling back to index.html', async ({ request }) => {
    const response = await request.get('refs/assets/CharacterTrait/NoSuchTrait.json');

    expect(response.status()).toBe(404);
    expect(response.headers()['content-type'] ?? '').not.toContain('text/html');
});
