import { defineConfig } from '@playwright/test';
import { shared } from './playwright.shared.js';

/**
 * The walkthroughs, played.
 *
 * One test per shipped tutorial, each doing what every step of it asks, in order, from
 * an empty mod to the last thing the tutorial has to say. That is what makes them worth
 * having -- a step naming a control that does not exist, or a condition the app can never
 * satisfy, leaves a player stuck with nowhere to click and nothing said about why, and
 * nothing short of playing the file finds it.
 *
 * It is also what keeps them out of `npm test`. Each is a few hundred inputs against a
 * real page, they are about the tutorial files rather than about the app, and a change to
 * either walkthrough is the thing that breaks them. So they are asked for by name --
 * `npm run test:e2e` -- and a config of their own means a bare `playwright test` cannot
 * pick them up by accident. The app's own coverage is in tests/.
 */

// Milliseconds to leave between one input and the next, for watching a run rather than
// only reading its result -- see the `demo` script. Zero for an ordinary run, so the
// setting existing does not slow one down.
//
// Playwright has no flag for this: slowMo belongs to the browser launch, which only a
// config can reach. It paces the actions a test takes, not the app's own reactions.
const SLOW_MO = Number(process.env.TUTORIAL_DEMO ?? 0);

export default defineConfig({
    ...shared,

    testDir: './e2e',
    testMatch: '**/*.spec.js',

    // A walkthrough is a few hundred inputs, and each one waits for the app to have
    // written something before the next step will unlock. Raised again rather than
    // lifted for a paced run: with a second between inputs the whole of one is over the
    // limit before the app has done anything, but no timeout at all means a run that has
    // got stuck sits there looking like a slow one -- the worse failure when the point is
    // to watch it.
    timeout: SLOW_MO ? 30 * 60_000 : 5 * 60_000,

    use: {
        ...shared.use,
        launchOptions: { slowMo: SLOW_MO },
    },
});
