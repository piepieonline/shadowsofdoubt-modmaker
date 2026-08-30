import { defineConfig } from 'vitest/config';

/**
 * Unit tests, beside the module each one is about.
 *
 * These cover the logic that carries the correctness risk and needs no browser to
 * exercise: parsing and serialising a file, turning a blueprint into a grid and back,
 * deciding what a tool does to a node. The Playwright suite in tests/ keeps everything
 * that needs a real page -- see tests/README.md for the line between them.
 *
 * `environment: 'node'` is the enforcement of that line rather than a performance
 * choice: a unit test that reaches for `document` fails outright instead of passing
 * against a DOM that is not the one the app is served into.
 */
export default defineConfig({
    test: {
        environment: 'node',

        // Beside the module, not in a directory of their own. `.unit.spec.js` so the
        // suite a file belongs to is readable from its name.
        include: ['{core,flows}/**/*.unit.spec.js'],

        // Reference data is fetched from app-absolute paths at runtime, and the JSON
        // Patch library arrives as a global from a classic script. See both shims.
        setupFiles: ['./tests/support/refs.js', './tests/support/jsonpatch.js'],
    },
});
