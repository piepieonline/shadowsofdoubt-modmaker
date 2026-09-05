import { defineConfig } from '@playwright/test';

/**
 * The app inside Electron, running the built bundle over app://.
 *
 * A smoke subset rather than a second full run of tests/. The renderer is the same Chromium
 * either way and the same bundle tests-build/ already checks, so duplicating 38 spec files
 * would multiply CI time for almost no added signal. What is *not* the same is everything
 * around it: a custom protocol instead of a web server, a preload script, a stable origin
 * that idb-keyval stores directory handles against, and a secure context that the File
 * System Access API refuses to work without. Those are what this covers.
 *
 * Not inheriting playwright.shared.js, which raises the Vite dev server and points baseURL
 * at it -- neither applies when Electron serves itself. What is worth taking from it is
 * taken by hand below. playwright.build.js is the nearer relative: it also runs against
 * built output rather than source.
 */
export default defineConfig({
    testDir: './tests-desktop',
    testMatch: '**/*.spec.js',

    // The bundle Electron will serve, rebuilt first. See the file for why never reused.
    globalSetup: './tests-desktop/support/build.js',

    // One at a time. Each test launches an Electron app -- a browser process, a GPU
    // process and a renderer apiece -- and several at once on a CI runner is how a suite
    // starts failing for reasons that have nothing to do with the code.
    fullyParallel: false,
    workers: 1,

    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],

    expect: { timeout: 15_000 },

    // Longer than the web suites'. Every test here pays for an Electron launch, and the
    // shell reloads once more on top of that to get the harness in ahead of the app.
    timeout: 120_000,

    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },

    // No webServer and no projects. There is one target, it is Electron, and it is
    // launched per test by tests-desktop/support/launch.js -- a config-level browser would
    // be a second, unused one.
});
