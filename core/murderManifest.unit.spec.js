import { test, expect } from 'vitest';
import { blankManifest, isListed, refFor, withListing } from './murderManifest.js';

/**
 * Deciding whether a file is named in a mod's load order, and adding it when it is not.
 *
 * Reading and writing the file needs a directory handle and is covered in
 * tests/buildingLibrary.spec.js, where a building actually reaches a mod. What is here is
 * the part carrying the risk: getting this wrong lists one file twice, or drops entries
 * an author put in by hand.
 */

const manifest = (fileOrder, extra = {}) => ({ enabled: true, fileOrder, loadBefore: '', version: 1, ...extra });

test('a file is listed when fileOrder names it, whatever the case', () => {
    expect(isListed(manifest(['REF:GrandHotel']), 'GrandHotel')).toBe(true);

    // Mods in the wild lowercase the entry -- the case scaffolder does -- and listing
    // the file a second time is worse than matching one loosely.
    expect(isListed(manifest(['REF:grandhotel']), 'GrandHotel')).toBe(true);
    expect(isListed(manifest(['REF: GrandHotel ']), 'GrandHotel')).toBe(true);

    // An entry written without the prefix still names a file.
    expect(isListed(manifest(['GrandHotel']), 'GrandHotel')).toBe(true);
});

test('a file no entry names is not listed', () => {
    expect(isListed(manifest(['REF:SomethingElse']), 'GrandHotel')).toBe(false);
    expect(isListed(manifest([]), 'GrandHotel')).toBe(false);

    // A near miss is a different file: names are compared whole, not by prefix.
    expect(isListed(manifest(['REF:GrandHotelAnnex']), 'GrandHotel')).toBe(false);
});

test('a manifest with no usable fileOrder names nothing', () => {
    expect(isListed({}, 'GrandHotel')).toBe(false);
    expect(isListed({ fileOrder: 'REF:GrandHotel' }, 'GrandHotel')).toBe(false);
    expect(isListed(null, 'GrandHotel')).toBe(false);
});

test('a new entry goes last, and everything else is carried through', () => {
    const before = manifest(['REF:Weapon'], { somethingUnknown: 42 });
    const after = withListing(before, 'GrandHotel');

    // Last, because where an entry sits is a statement about what loads before what --
    // and the end is the only position that says nothing about the entries already
    // there. A MurderMO stays where its author put it relative to them.
    expect(after.fileOrder).toEqual(['REF:Weapon', 'REF:GrandHotel']);

    expect(after.somethingUnknown).toBe(42);
    expect(after.loadBefore).toBe('');
    expect(after.enabled).toBe(true);
    expect(after.version).toBe(1);

    // The manifest it was given is not modified, so a caller that decides not to write
    // has not already changed what it read.
    expect(before.fileOrder).toEqual(['REF:Weapon']);
});

test('listing a file that is already listed changes nothing at all', () => {
    const before = manifest(['REF:grandhotel']);

    // The same object back, which is how the writer knows there is nothing to write.
    expect(withListing(before, 'GrandHotel')).toBe(before);
});

test('a manifest missing its fileOrder gains one rather than losing its other keys', () => {
    const after = withListing({ enabled: true, loadBefore: 'SomeOtherMod' }, 'GrandHotel');

    expect(after.fileOrder).toEqual(['REF:GrandHotel']);
    expect(after.loadBefore).toBe('SomeOtherMod');
});

test('a mod with no manifest gets the loader\'s four keys and the one entry', () => {
    expect(withListing(blankManifest(), 'GrandHotel'))
        .toEqual({ enabled: true, fileOrder: ['REF:GrandHotel'], loadBefore: '', version: 1 });

    expect(refFor('GrandHotel')).toBe('REF:GrandHotel');
});
