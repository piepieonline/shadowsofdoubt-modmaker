/**
 * Build the renderer before the desktop suite runs.
 *
 * Every time, and never reusing what is already there. This suite exists to check the built
 * artifact and the shell around it, and a suite that checks an artifact must not be handed
 * yesterday's -- passing against a stale `dist-desktop/` is worse than not running.
 * playwright.build.js makes the same argument for the same reason, in its `webServer`.
 *
 * Through Vite's own API rather than by shelling out to `npm run build:desktop`. That was the
 * first version and it was Windows-only-broken: `execFileSync('npm', ...)` looks for a file
 * called `npm`, and on Windows it is `npm.cmd`, so global setup died with ENOENT before a
 * single test ran. This suite is meant to run on both halves of a CI matrix, and calling the
 * bundler directly has no shell, no PATH lookup and no platform in it at all.
 */
import { build } from 'vite';
import { fileURLToPath } from 'node:url';

export default async function buildRenderer() {
    // `mode` is what vite.config.js reads to pick `dist-desktop/` and a document-relative
    // base -- the exact thing `--mode desktop` does on the command line.
    await build({ root: fileURLToPath(new URL('../../', import.meta.url)), mode: 'desktop' });
}
