import { test, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyPatches, diffToPatches, isPatchFormat, mergeOldFormat } from './patchFormat.js';
import { resolveReferences } from './soReferences.js';

/**
 * The patch format, both ways round.
 *
 * What carries the risk here is not that a diff is produced but that it says the same
 * thing after a game update as it said when it was written -- so most of this is about
 * which paths come out durable and which honestly fall back to an index. The round trip at
 * the bottom is the blunt instrument: every shipped asset that can be read, edited, and
 * put back together from the difference alone.
 */

const clone = (value) => JSON.parse(JSON.stringify(value));

test('a document nobody edited produces no operations', () => {
    const base = { presetName: 'Bar', list: [{ name: 'a' }, { name: 'b' }], nested: { x: 1 } };

    expect(diffToPatches(base, clone(base))).toEqual([]);
});

test('a changed field is a replace at its path', () => {
    const base = { presetName: 'Bar', baseDifficulty: 2 };
    const edited = { ...base, baseDifficulty: 5 };

    expect(diffToPatches(base, edited)).toEqual([
        { op: 'replace', path: '/baseDifficulty', value: 5 },
    ]);
});

test('an element added to the end of a list appends rather than landing on an index', () => {
    // `/-` is what survives the game shipping another element into that list.
    const base = { roomCompatibility: ['REF:RoomConfiguration|Lobby'] };
    const edited = { roomCompatibility: [...base.roomCompatibility, 'REF:RoomConfiguration|Vestibule'] };

    expect(diffToPatches(base, edited)).toEqual([
        { op: 'add', path: '/roomCompatibility/-', value: 'REF:RoomConfiguration|Vestibule' },
    ]);
});

test('two elements appended both append, rather than the second landing past the end', () => {
    // The second is judged against the list as the first one leaves it, not against the
    // list as it was shipped -- an index of 2 in a list of one is not an append.
    const base = { list: ['a'] };
    const edited = { list: ['a', 'b', 'c'] };

    expect(diffToPatches(base, edited).map((op) => op.path)).toEqual(['/list/-', '/list/-']);
});

test('a field added to the document is an add at its own path', () => {
    const base = { presetName: 'Bar' };

    expect(diffToPatches(base, { presetName: 'Bar', notes: 'new' })).toEqual([
        { op: 'add', path: '/notes', value: 'new' },
    ]);
});

test('a list element is found by what identifies it rather than by where it sits', () => {
    const base = {
        companyStructure: {
            subordinates: [
                { occupation: 'Manager', positionsMaximum: 4, positionsMinimum: 1 },
                { occupation: 'Cleaner', positionsMaximum: 2, positionsMinimum: 0 },
            ],
        },
    };

    const edited = clone(base);
    edited.companyStructure.subordinates[1].positionsMinimum = 3;

    expect(diffToPatches(base, edited)).toEqual([
        {
            op: 'replace',
            path: '/companyStructure/subordinates/[occupation=Cleaner]/positionsMinimum',
            value: 3,
        },
    ]);
});

test('a whole number identifies an element as well as a name does', () => {
    const base = { list: [{ id: 4, v: 1 }, { id: 9, v: 1 }] };
    const edited = clone(base);
    edited.list[0].v = 2;

    // `name` is not there, so the first identifying field that is gets used.
    expect(diffToPatches(base, edited)[0].path).toBe('/list/[id=4]/v');
});

test('a field that identifies nothing is not matched on', () => {
    // Only a field that can be expected to still name the same element after a game
    // update. `scoreModifier` happening to be unique today is not that.
    const base = { list: [{ scoreModifier: 5, v: 1 }, { scoreModifier: 9, v: 1 }] };
    const edited = clone(base);
    edited.list[0].v = 2;

    expect(diffToPatches(base, edited)[0].path).toBe('/list/0/v');
});

test('an identifying value shared by two elements identifies neither', () => {
    const base = { list: [{ name: 'same', v: 1 }, { name: 'same', v: 2 }] };
    const edited = clone(base);
    edited.list[1].v = 3;

    // A selector matching two elements is one the loader refuses, so the index is the
    // honest answer -- position-dependent, and correct today.
    expect(diffToPatches(base, edited)[0].path).toBe('/list/1/v');
});

test('a value that would have to be escaped keeps its index instead', () => {
    // `/` is a pointer separator and `=` is the selector's own delimiter. Two escaping
    // schemes that have to agree across this file and the loader's C# is a worse bet than
    // an index.
    const base = { list: [{ name: 'Ads/Left', v: 1 }, { name: 'Other', v: 1 }] };
    const edited = clone(base);
    edited.list[0].v = 2;

    expect(diffToPatches(base, edited)[0].path).toBe('/list/0/v');
});

test('an element of a list of plain values has nothing to identify it', () => {
    const base = { list: ['a', 'b'] };
    const edited = { list: ['a', 'changed'] };

    expect(diffToPatches(base, edited)[0].path).toBe('/list/1');
});

test('a list nested inside an identified element is reached through the selector', () => {
    const base = { outer: [{ name: 'first', inner: ['x'] }, { name: 'second', inner: [] }] };
    const edited = clone(base);
    edited.outer[1].inner.push('y');

    expect(diffToPatches(base, edited)).toEqual([
        { op: 'add', path: '/outer/[name=second]/inner/-', value: 'y' },
    ]);
});

test('a removed field is a remove', () => {
    const base = { presetName: 'Bar', notes: 'gone' };

    expect(diffToPatches(base, { presetName: 'Bar' })).toEqual([
        { op: 'remove', path: '/notes' },
    ]);
});

/* -------------------------------------------------------------------------- */

test('applying resolves a selector to the element it names', () => {
    const base = { list: [{ name: 'a', v: 1 }, { name: 'b', v: 2 }] };

    const { document, failed } = applyPatches(base, [
        { op: 'replace', path: '/list/[name=b]/v', value: 9 },
    ]);

    expect(failed).toBeUndefined();
    expect(document.list[1].v).toBe(9);
    // The base is not touched: it is what the next save is compared against.
    expect(base.list[1].v).toBe(2);
});

test('applying resolves a selector against the document as the operations leave it', () => {
    const base = { list: [{ name: 'a', v: 1 }] };

    const { document } = applyPatches(base, [
        { op: 'add', path: '/list/-', value: { name: 'b', v: 1 } },
        { op: 'replace', path: '/list/[name=b]/v', value: 7 },
    ]);

    expect(document.list).toEqual([{ name: 'a', v: 1 }, { name: 'b', v: 7 }]);
});

test('a selector that matches nothing stops the file and says which operation', () => {
    const base = { list: [{ name: 'a' }] };

    const { document, failed } = applyPatches(base, [
        { op: 'replace', path: '/list/[name=missing]/v', value: 1 },
    ]);

    expect(document).toBeUndefined();
    expect(failed.index).toBe(0);
    expect(failed.reason).toContain('nothing in /list has name = missing');
});

test('a selector that matches twice stops the file rather than picking one', () => {
    const base = { list: [{ name: 'same' }, { name: 'same' }] };

    const { failed } = applyPatches(base, [{ op: 'remove', path: '/list/[name=same]' }]);

    expect(failed.reason).toContain('2 things in /list have name = same');
});

test('a path the base no longer has stops the file', () => {
    // The asset was patched against one version of the game and opened against another.
    // Carrying on would show a document the patch does not describe and then save the
    // difference back over it.
    const { failed } = applyPatches({ presetName: 'Bar' }, [
        { op: 'replace', path: '/goneInThisVersion', value: 1 },
    ]);

    expect(failed.index).toBe(0);
    expect(failed.op.path).toBe('/goneInThisVersion');
});

/* -------------------------------------------------------------------------- */

test('a file carrying a patches array is in the new format, and one without is not', () => {
    expect(isPatchFormat({ name: 'Bar', fileType: 'AddressPreset', patches: [] })).toBe(true);
    expect(isPatchFormat({ name: 'Bar', fileType: 'AddressPreset', notes: 'x' })).toBe(false);
    expect(isPatchFormat(null)).toBe(false);
});

test('an old format patch merges over the base key by key', () => {
    const base = { presetName: 'Bar', notes: 'original', nested: { kept: 1, changed: 1 } };
    const old = { name: 'Bar', fileType: 'AddressPreset', notes: 'mine', nested: { changed: 2 } };

    expect(mergeOldFormat(base, old)).toEqual({
        presetName: 'Bar',
        notes: 'mine',
        // Merged, not replaced: the fields the patch is silent about are the game's.
        nested: { kept: 1, changed: 2 },
    });
});

test('an old format patch replaces a list whole rather than merging into it', () => {
    const base = { list: ['a', 'b', 'c'] };

    expect(mergeOldFormat(base, { list: ['z'] })).toEqual({ list: ['z'] });
});

test('converting an old format patch produces only the operations it meant', () => {
    // The keys naming the target are not fields of the asset, so they must not turn into
    // `add /name` and `add /fileType` in every file this app converts.
    const base = { presetName: 'ExCopSniper', notes: 'original', baseDifficulty: 2 };
    const old = { name: 'ExCopSniper', fileType: 'MurderMO', notes: 'mine' };

    expect(diffToPatches(base, mergeOldFormat(base, old))).toEqual([
        { op: 'replace', path: '/notes', value: 'mine' },
    ]);
});

/* -------------------------------------------------------------------------- */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'refs', 'assets');

/** Every shipped asset that parses, which is all but five holding `Infinity`. */
async function shippedAssets() {
    const types = (await readdir(ASSETS, { withFileTypes: true })).filter((e) => e.isDirectory());

    // The map the flow builds in loadRefs.js, so the documents here are the ones the
    // editor actually holds -- named references, nulls, and the unmapped ids left alone.
    const soPathIds = JSON.parse(await readFile(join(ROOT, 'refs/generated/soPathIds.json'), 'utf8'));
    const pathIdMap = Object.fromEntries(Object.entries(soPathIds).map(([id, names]) => [id, names[0]]));

    const loaded = [];
    for (const type of types) {
        for (const file of await readdir(join(ASSETS, type.name))) {
            try {
                const parsed = JSON.parse(await readFile(join(ASSETS, type.name, file), 'utf8'));
                loaded.push({ where: `${type.name}/${file}`, document: resolveReferences(parsed, pathIdMap) });
            } catch {
                // Not this test's subject: an asset the browser cannot parse either is one
                // the editor refuses to open, and is covered where that decision is made.
            }
        }
    }

    return loaded;
}

/**
 * Make an edit of each kind this editor can make, wherever the asset has somewhere to
 * make it. Returns null for an asset with nothing to edit.
 */
function scriptedEdit(document) {
    const edited = clone(document);
    let touched = false;

    for (const [key, value] of Object.entries(edited)) {
        if (typeof value === 'string' && key !== 'presetName') { edited[key] = `${value} edited`; touched = true; }
        else if (typeof value === 'number') { edited[key] = value + 1; touched = true; }
        else if (typeof value === 'boolean') { edited[key] = !value; touched = true; }
        else if (Array.isArray(value) && value.length) {
            // An append, a removal, and an edit inside an element that survives both.
            edited[key] = [...value, clone(value[0])];
            if (isObject(value[0])) {
                const field = Object.keys(value[0]).find((f) => typeof value[0][f] === 'number');
                if (field) edited[key][0][field] = value[0][field] + 1;
            }
            touched = true;
        } else if (isObject(value)) {
            const field = Object.keys(value).find((f) => typeof value[f] === 'number');
            if (field) { edited[key][field] = value[field] + 1; touched = true; }
        }
    }

    return touched ? edited : null;
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Given room rather than left on vitest's five second default, which this is close enough
 * to to fail on a busy machine: it reads all 1,500 shipped assets off disk and diffs every
 * one of them, which is 600ms on an idle run and several times that with the rest of the
 * suite going at once. That is a false failure about the machine rather than the code.
 */
test('every shipped asset survives being edited, diffed and put back together', { timeout: 30_000 }, async () => {
    const assets = await shippedAssets();
    expect(assets.length).toBeGreaterThan(1400);

    const broken = [];

    for (const { where, document } of assets) {
        // Opening one and saving it untouched writes an empty patch, not a file full of
        // operations that say nothing. This one assertion catches every load-path
        // infidelity there is, the unmapped-reference one included.
        if (diffToPatches(document, clone(document)).length) {
            broken.push(`${where}: unedited, and the diff is not empty`);
            continue;
        }

        const edited = scriptedEdit(document);
        if (!edited) continue;

        const patches = diffToPatches(document, edited);
        const { document: rebuilt, failed } = applyPatches(document, patches);

        if (failed) broken.push(`${where}: ${failed.reason}`);
        else if (JSON.stringify(rebuilt) !== JSON.stringify(edited)) broken.push(`${where}: rebuilt differently`);
    }

    expect(broken).toEqual([]);
});
