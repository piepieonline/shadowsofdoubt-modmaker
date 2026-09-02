import { devices } from '@playwright/test';

// What both Playwright suites need: the server they run against, the one browser they
// run in, and how a failure is recorded. The two configs beside this file differ only in
// which directory they collect and how long a test there is allowed to take.
//
// Bound to 127.0.0.1 deliberately: it is a secure context (so the File System Access API
// and OPFS are available) without needing the self-signed cert that the manual HTTPS
// workflow requires, and it does not expose the repo on the LAN.
const PORT = 8123;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export const shared = {
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],

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

    // Shared by both configs, and by both at once: whichever suite starts first raises the
    // server, and the other finds it already up.
    webServer: {
        command: `npx http-server -a 127.0.0.1 -p ${PORT} -c-1 --silent`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
};
