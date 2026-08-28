import { defineConfig, devices } from '@playwright/test';

// Bound to 127.0.0.1 deliberately: it is a secure context (so the File System
// Access API and OPFS are available) without needing the self-signed cert that
// the manual HTTPS workflow requires, and it does not expose the repo on the LAN.
const PORT = 8123;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
    testDir: './tests',

    // Playwright's default testMatch takes `*.test.js` too, and the unit suite's files
    // are `*.unit.spec.js` beside the module they cover. testDir already keeps those out
    // -- they live in core/ and flows/ -- but say it, so moving one here fails loudly
    // rather than being collected by a runner that cannot import it.
    testMatch: '**/*.spec.js',
    testIgnore: '**/*.unit.spec.js',

    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],

    // Longer than the defaults, because the building flow renders through WebGL and
    // several workers do it at once. On software rendering, opening a floor is tens of
    // milliseconds on an idle machine and seconds on a loaded one, and every test in the
    // run feels that -- the failures it caused were spread across specs that have
    // nothing to do with each other, a different one each time.
    //
    // This is what a wait is allowed to take before something is called hung, not what
    // anything is expected to take. Nothing waits out the clock on a passing run.
    timeout: 60_000,
    expect: { timeout: 15_000 },

    use: {
        baseURL: BASE_URL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },

    // Chromium only. Firefox and Safari do not implement the File System Access
    // API, so the apps cannot function there at all -- testing them would only
    // assert that they are broken.
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],

    webServer: {
        command: `npx http-server -a 127.0.0.1 -p ${PORT} -c-1 --silent`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
