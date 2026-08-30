/**
 * `jsonpatch`, in the unit suite.
 *
 * The page loads libs/JSON-Patch as a classic script -- `<script src>` in index.html --
 * which publishes a `jsonpatch` global that core/document.js, core/persistence.js and the
 * patch format module all reach for. There is no `<script>` in Node, so this evaluates the
 * same file the same way and leaves the same global behind.
 *
 * Like the fetch shim beside it, this is not a mock: it is the library the app ships,
 * loaded from the path the app loads it from. Nothing under test knows it is here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInThisContext } from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The unminified build: a stack trace out of a failing operation should name something.
runInThisContext(readFileSync(join(ROOT, 'libs/JSON-Patch/fast-json-patch.js'), 'utf8'));
