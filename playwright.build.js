import { defineConfig, devices } from '@playwright/test';

/**
 * The built site, served the way GitHub Pages will serve it.
 *
 * The other two suites run against the dev server, which serves source at its real paths.
 * That is what lets them reach into a module directly and what keeps a failure pointing at
 * a file. It also means they cannot see anything the *build* gets wrong, and the build has
 * its own failure modes: an asset URL written against the wrong base, a side-effect import
 * dropped because nothing appeared to use it, stylesheets concatenated in the wrong order.
 *
 * Every one of those breaks the deployed site while every existing spec still passes. This
 * suite is the check for them, so it is deliberately small: what it covers is the seam
 * between source and artifact, not the app's behaviour, which `tests/` already owns.
 *
 * Served under the project base rather than the root, because that is where Pages mounts it
 * and a path that only works at the root is exactly the bug worth catching.
 */
const PORT = 8124;
const BASE = '/shadowsofdoubt-modmaker/';

export const BUILD_URL = `http://127.0.0.1:${PORT}${BASE}`;

export default defineConfig({
    testDir: './tests-build',
    testMatch: '**/*.spec.js',

    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],

    expect: { timeout: 15_000 },
    timeout: 60_000,

    use: {
        baseURL: BUILD_URL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },

    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],

    // Builds first, every time, and never reuses a server that is already up. A suite whose
    // whole purpose is to check the artifact must not be handed yesterday's artifact --
    // passing against a stale `dist/` is worse than not running at all.
    webServer: {
        command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
        url: BUILD_URL,
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
