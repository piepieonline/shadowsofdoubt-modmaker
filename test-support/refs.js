/**
 * `fetch` for reference data, in the unit suite.
 *
 * The floors under refs/ are 5 MB across 108 files, so they are fetched a file at a time
 * from app-absolute paths rather than imported -- `fetch('/refs/floors/index.json')` and
 * friends, in flows/building/scripts/buildingLibrary.js. Node has no server to answer
 * those, so this reads them off disk from the same paths.
 *
 * This is not a mock of anything. It serves the same bytes `http-server` serves, from
 * the same paths, and every module under test is unaware of it. Nothing else in the unit
 * suite is stubbed: a test that needs a FileSystemDirectoryHandle or a WebGL context
 * belongs in the Playwright suite instead, not behind a fake.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

globalThis.fetch = async (url) => {
    const path = join(ROOT, decodeURIComponent(String(url)));

    try {
        const body = await readFile(path, 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
    } catch {
        // What the server gives for a floor that is not there, which loadVanillaPreset
        // and loadVanillaBlueprint both read as "the base game does not have this".
        return { ok: false, status: 404, json: async () => null, text: async () => '' };
    }
};
