import { test, expect } from 'vitest';
import { describeContentFolder } from './modFolders.js';

/**
 * How a content folder reads in the shell's dropdown.
 *
 * Finding the folders walks a directory handle and stays in tests/modFolders.spec.js.
 * Describing one is a read of the four flags that walk produced, and it is the only
 * thing telling an author which of a mod's folders they are about to edit.
 */

const folder = (path, kinds = {}) => ({
    path,
    hasManifest: false,
    hasDdsContent: false,
    hasFloors: false,
    ...kinds,
});

test('a folder is named by its path and what it holds', () => {
    expect(describeContentFolder(folder('BinPasscodes', { hasManifest: true })))
        .toBe('BinPasscodes — case');
    expect(describeContentFolder(folder('Floors', { hasFloors: true })))
        .toBe('Floors — building');
});

test('a folder holding several kinds lists them all, in one order', () => {
    expect(describeContentFolder(folder('GroupFlyers', {
        hasManifest: true, hasDdsContent: true, hasFloors: true,
    }))).toBe('GroupFlyers — case + DDS + building');
});

test('the mod root is named, and a folder with nothing in it yet is new', () => {
    // A folder created a moment ago holds none of the three, and saying so beats
    // showing an author a blank entry they cannot tell apart from a broken one.
    expect(describeContentFolder(folder('', { hasManifest: true }))).toBe('(mod root) — case');
    expect(describeContentFolder(folder('Brand/New'))).toBe('Brand/New — new');
});
