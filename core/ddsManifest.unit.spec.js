import { test, expect } from 'vitest';
import { toVirtual, toReal, placeStringsFile, withMapping, withoutMapping, isActive, virtualPathOf } from './ddsManifest.js';

/**
 * Translating between where a strings file sits and where the loader reads it from.
 *
 * A mod may keep its CSVs anywhere and declare the move in ddsmanifest.json; the game
 * only ever asks for the virtual path. Getting the direction wrong writes an edit into
 * a file nothing reads, which looks exactly like an edit that worked.
 *
 * Reading and writing the manifest itself goes through a directory handle and is
 * covered in tests/ddsManifest.spec.js. What is here takes a parsed manifest and a
 * path and returns a path.
 */

/** A manifest as readManifest returns one, with the given mappings. */
const manifest = (files = []) => ({ present: true, malformed: false, files, extra: {}, raw: '' });

const ABSENT = { present: false, malformed: false, files: [], extra: {}, raw: '' };
const MALFORMED = { present: true, malformed: true, files: [], extra: {}, raw: '{ not json' };

const BLOCKS = { real: 'MyStrings/dds.blocks.csv', virtualDir: 'Strings/English/DDS' };

test('a mapping names the path the loader reads it from', () => {
    expect(virtualPathOf(BLOCKS)).toBe('Strings/English/DDS/dds.blocks.csv');

    // The file keeps its name; only the directory moves.
    expect(virtualPathOf({ real: 'a/b/names.rooms.csv', virtualDir: 'Strings/English' }))
        .toBe('Strings/English/names.rooms.csv');
});

test('mappings apply only when there is a manifest that parsed', () => {
    expect(isActive(manifest())).toBe(true);
    expect(isActive(ABSENT)).toBe(false);

    // A manifest its author can still repair is not one to resolve paths through --
    // guessing at half-read entries would write files to invented places.
    expect(isActive(MALFORMED)).toBe(false);
});

test('a real path resolves to the virtual one the mapping declares', () => {
    expect(toVirtual(manifest([BLOCKS]), 'MyStrings/dds.blocks.csv'))
        .toBe('Strings/English/DDS/dds.blocks.csv');
});

test('an unmapped path is its own virtual path', () => {
    expect(toVirtual(manifest([BLOCKS]), 'Strings/English/names.rooms.csv'))
        .toBe('Strings/English/names.rooms.csv');
});

test('a virtual path resolves back to where the file really is', () => {
    expect(toReal(manifest([BLOCKS]), 'Strings/English/DDS/dds.blocks.csv'))
        .toBe('MyStrings/dds.blocks.csv');
});

test('without an active manifest both directions are the identity', () => {
    const path = 'Strings/English/DDS/dds.blocks.csv';

    for (const inactive of [ABSENT, MALFORMED]) {
        expect(toVirtual(inactive, 'MyStrings/dds.blocks.csv')).toBe('MyStrings/dds.blocks.csv');
        expect(toReal(inactive, path)).toBe(path);
    }
});

test('a file the manifest already maps is written where the manifest says', () => {
    const placed = placeStringsFile(manifest([BLOCKS]), 'Strings/English/DDS/dds.blocks.csv');

    // Already declared, so there is nothing to add.
    expect(placed).toEqual({ real: 'MyStrings/dds.blocks.csv', addEntry: null });
});

test('a mod that keeps its CSVs together gets its new one there, and declares it', () => {
    const placed = placeStringsFile(manifest([BLOCKS]), 'Strings/English/names.rooms.csv');

    // Every entry agrees on MyStrings, so the mod has said where its CSVs go.
    expect(placed.real).toBe('MyStrings/names.rooms.csv');
    expect(placed.addEntry).toEqual({ real: 'MyStrings/names.rooms.csv', virtualDir: 'Strings/English' });
});

test('a mod whose entries disagree gets the plain layout and no new entry', () => {
    const disagreeing = manifest([
        BLOCKS,
        { real: 'Elsewhere/names.rooms.csv', virtualDir: 'Strings/English' },
    ]);

    const placed = placeStringsFile(disagreeing, 'Strings/English/DDS/dds.rules.csv');

    // Inventing a layout for a mod that has not settled on one is worse than using the
    // one the game reads from, which needs no entry at all.
    expect(placed).toEqual({ real: 'Strings/English/DDS/dds.rules.csv', addEntry: null });
});

test('a mapping is appended, leaving the order the author chose alone', () => {
    const extra = { real: 'MyStrings/names.rooms.csv', virtualDir: 'Strings/English' };
    const grown = withMapping(manifest([BLOCKS]), extra);

    expect(grown.files).toEqual([BLOCKS, extra]);

    // And the manifest it came from is untouched, so a write that fails changes nothing.
    expect(manifest([BLOCKS]).files).toEqual([BLOCKS]);
    expect(grown.present).toBe(true);
});

test('a deleted file\'s mapping is dropped and the rest keep their order', () => {
    const rooms = { real: 'MyStrings/names.rooms.csv', virtualDir: 'Strings/English' };
    const before = manifest([BLOCKS, rooms]);

    expect(withoutMapping(before, rooms.real).files).toEqual([BLOCKS]);

    // The manifest it came from is untouched, so a write that fails changes nothing.
    expect(before.files).toEqual([BLOCKS, rooms]);
});

test('every entry claiming a deleted path goes, not just the one that won', () => {
    // Two entries can claim one file; order decides which the loader reads it through.
    // Leaving the loser behind leaves the loader looking for a file that has gone.
    const second = { real: BLOCKS.real, virtualDir: 'Strings/French/DDS' };
    const stripped = withoutMapping(manifest([BLOCKS, second]), BLOCKS.real);

    expect(stripped.files).toEqual([]);
});

test('a file nothing maps leaves the mappings alone', () => {
    // The file sat where the game reads it from and needed no entry, so there is nothing
    // to rewrite -- which is what stops a delete touching the author's manifest at all.
    const before = manifest([BLOCKS]);

    expect(withoutMapping(before, 'Strings/English/names.rooms.csv').files).toEqual([BLOCKS]);
});
