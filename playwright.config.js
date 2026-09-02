import { defineConfig } from '@playwright/test';
import { shared } from './playwright.shared.js';

/**
 * The standard run: the app covered a feature at a time.
 *
 * `e2e/` is deliberately not collected here. Those specs play a shipped walkthrough from
 * its first step to its last, which is minutes apiece and is about the tutorials rather
 * than about the app -- so they have a config of their own and are asked for by name. See
 * playwright.e2e.config.js.
 */
export default defineConfig({
    ...shared,

    // Rooted at the repo, so the match has to name the suite -- and Playwright's default
    // testMatch takes `*.test.js` too. The unit suite's files are `*.unit.spec.js` beside
    // the module they cover, in core/ and flows/; both lines keep them out, so one moved
    // in here fails loudly rather than being collected by a runner that cannot import it.
    testDir: '.',
    testMatch: 'tests/**/*.spec.js',
    testIgnore: '**/*.unit.spec.js',

    // Longer than the defaults, because the building flow renders through WebGL and
    // several workers do it at once. On software rendering, opening a floor is tens of
    // milliseconds on an idle machine and seconds on a loaded one, and every test in the
    // run feels that -- the failures it caused were spread across specs that have
    // nothing to do with each other, a different one each time.
    //
    // This is what a wait is allowed to take before something is called hung, not what
    // anything is expected to take. Nothing waits out the clock on a passing run.
    timeout: 60_000,
});
