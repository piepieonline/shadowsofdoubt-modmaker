/**
 * The demo content is data, and data can be wrong in ways that only show up as an editor
 * that will not open. These pin the rules the app enforces at runtime, where the penalty
 * for breaking one is an alert or a thrown parse rather than a failing test:
 *
 *  - a DDS file's name is its `id`, or index.js alerts that it will not work in game
 *  - a GUID is a real UUID, or loadDocument refuses it
 *  - a strings row has seven fields, or loadI18n silently drops it
 *  - the content folder carries the markers modFolders.js searches for, or nothing in
 *    the demo is reachable at all
 *
 * No filesystem and no DOM: this is the fixture module read as the object it is.
 */
import { describe, expect, it } from 'vitest';
import { GUID_PATTERN } from '../guid.js';
import { MANIFEST_FILE, DDS_CONTENT_DIR, FLOORS_DIR } from '../modFolders.js';
import { parseStringsCsv, splitRow } from '../stringsCsv.js';
import {
    demoFiles, DEMO_SELECTION, DEMO_PLUGINS, DEMO_STREAMING_ASSETS,
    DEMO_TREE_GUID, DEMO_MESSAGE_GUID, DEMO_BLOCK_GUID,
    DEMO_MOD_TREE_GUID, DEMO_MOD_MESSAGE_GUID, DEMO_MOD_BLOCK_GUID, DEMO_REPLACEMENT_GUID,
} from './fixtures.js';

const paths = Object.keys(demoFiles);

/** Directories are keys ending in '/', with no contents of their own. */
const files = paths.filter((path) => !path.endsWith('/'));
const directories = paths.filter((path) => path.endsWith('/'));

const withExtension = (...extensions) =>
    files.filter((path) => extensions.some((ext) => path.endsWith(ext)));

/** The selected content folder, as a path prefix within the seeded tree. */
const CONTENT_ROOT = `${DEMO_PLUGINS}/${DEMO_SELECTION.modName}/${DEMO_SELECTION.contentPath}`;

describe('demo fixture paths', () => {
    it('seeds both of the folders the app is handed', () => {
        expect(files.some((path) => path.startsWith(`${DEMO_STREAMING_ASSETS}/`))).toBe(true);
        expect(files.some((path) => path.startsWith(`${DEMO_PLUGINS}/`))).toBe(true);
    });

    it('gives every path a folder to belong to', () => {
        // Nothing loose at the root: a path that is neither StreamingAssets nor Plugins
        // is seeded into a directory the app is never given a handle on.
        for (const path of paths) {
            expect(path.startsWith(`${DEMO_STREAMING_ASSETS}/`) || path.startsWith(`${DEMO_PLUGINS}/`))
                .toBe(true);
        }
    });

    it('declares its directories empty rather than with a placeholder file', () => {
        // A `.keep` would show up in the editor as a file the mod does not have. The
        // empty Floors directory is the point: it is what marks a building mod that has
        // not saved a floor yet.
        expect(directories).toContain(`${CONTENT_ROOT}/${FLOORS_DIR}/`);
        expect(files.some((path) => path.endsWith('/.keep'))).toBe(false);
    });
});

describe('the selected content folder', () => {
    it('is where DEMO_SELECTION points', () => {
        expect(files.some((path) => path.startsWith(`${CONTENT_ROOT}/`))).toBe(true);
    });

    /**
     * All three markers in one folder, which is what lets a flow switch keep the
     * selection -- see core/navigation.js. Miss one and that editor opens empty.
     */
    it('carries the marker for every flow', () => {
        expect(files).toContain(`${CONTENT_ROOT}/${MANIFEST_FILE}`);
        expect(files.some((path) => path.startsWith(`${CONTENT_ROOT}/${DDS_CONTENT_DIR}/`))).toBe(true);
        expect(directories).toContain(`${CONTENT_ROOT}/${FLOORS_DIR}/`);
    });

    it('is not the mod root, so the search has to walk to it', () => {
        expect(DEMO_SELECTION.contentPath).not.toBe('');
    });
});

describe('JSON content', () => {
    it('parses', () => {
        for (const path of withExtension('.json', '.tree', '.msg', '.block', '.tree_patch')) {
            expect(() => JSON.parse(demoFiles[path]), path).not.toThrow();
        }
    });

    /**
     * index.js compares the file name against the document's own id and alerts when they
     * disagree, because the game reads content by file name.
     */
    it('names each DDS document after its id', () => {
        for (const path of withExtension('.tree', '.msg', '.block')) {
            const fileName = path.split('/').at(-1);
            expect(JSON.parse(demoFiles[path]).id, path).toBe(fileName.split('.')[0]);
        }
    });

    it('uses GUIDs the app will accept', () => {
        const guids = [
            DEMO_TREE_GUID, DEMO_MESSAGE_GUID, DEMO_BLOCK_GUID,
            DEMO_MOD_TREE_GUID, DEMO_MOD_MESSAGE_GUID, DEMO_MOD_BLOCK_GUID,
            DEMO_REPLACEMENT_GUID,
        ];

        expect(new Set(guids).size).toBe(guids.length);
        for (const guid of guids) expect(GUID_PATTERN.test(guid), guid).toBe(true);
    });

    it('links each document to the one below it', () => {
        const read = (path) => JSON.parse(demoFiles[path]);

        const tree = read(`${DEMO_STREAMING_ASSETS}/DDS/Trees/${DEMO_TREE_GUID}.tree`);
        expect(tree.messages.map((m) => m.msgID)).toContain(DEMO_MESSAGE_GUID);

        const message = read(`${DEMO_STREAMING_ASSETS}/DDS/Messages/${DEMO_MESSAGE_GUID}.msg`);
        expect(message.blocks.map((b) => b.blockID)).toContain(DEMO_BLOCK_GUID);

        const modTree = read(`${CONTENT_ROOT}/${DDS_CONTENT_DIR}/DDS/Trees/${DEMO_MOD_TREE_GUID}.tree`);
        expect(modTree.messages.map((m) => m.msgID)).toContain(DEMO_MOD_MESSAGE_GUID);

        const modMessage = read(`${CONTENT_ROOT}/${DDS_CONTENT_DIR}/DDS/Messages/${DEMO_MOD_MESSAGE_GUID}.msg`);
        expect(modMessage.blocks.map((b) => b.blockID)).toContain(DEMO_MOD_BLOCK_GUID);
    });

    it('patches base game content rather than replacing it', () => {
        const patch = JSON.parse(
            demoFiles[`${CONTENT_ROOT}/${DDS_CONTENT_DIR}/DDS/Trees/${DEMO_TREE_GUID}.tree_patch`]);

        expect(Array.isArray(patch)).toBe(true);
        for (const operation of patch) expect(operation).toHaveProperty('op');
    });
});

describe('strings CSVs', () => {
    const csvPaths = withExtension('.csv');

    it('are there to be read', () => {
        expect(csvPaths.length).toBeGreaterThan(0);
    });

    /**
     * loadI18n splits a line on commas and skips anything with fewer than seven fields,
     * so a short row is not an error -- it is a line of text that never appears.
     */
    it('give every row the seven fields loadI18n requires', () => {
        for (const path of csvPaths) {
            for (const line of demoFiles[path].split('\n')) {
                expect(splitRow(line).length, `${path}: ${line}`).toBeGreaterThanOrEqual(7);
            }
        }
    });

    it('open with header lines the editor will not offer to edit', () => {
        for (const path of csvPaths) {
            const { headers, rows } = parseStringsCsv(demoFiles[path]);
            expect(headers.length, path).toBe(3);
            expect(rows.length, path).toBeGreaterThan(0);
        }
    });

    it('gives every block in the demo a line of text', () => {
        const keyed = new Set(
            csvPaths.flatMap((path) => parseStringsCsv(demoFiles[path]).rows.map((row) => row.key)));

        expect(keyed).toContain(DEMO_BLOCK_GUID);
        expect(keyed).toContain(DEMO_MOD_BLOCK_GUID);
        expect(keyed).toContain(DEMO_REPLACEMENT_GUID);
    });
});
