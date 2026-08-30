import { test, expect } from 'vitest';
import {
    assetNameOf, assetOfPath, fileNameFor, PATCH_SUFFIX, PRESET_SUFFIX, stemFor, titleFor,
} from './soFileName.js';

/**
 * Composing a ScriptableObject's file name from what it is called and what it is, and
 * getting back to the first of those.
 *
 * The risk here is entirely in `assetNameOf`. Taking off too much renames an asset behind
 * its author's back -- every `REF:` pointing at it stops resolving -- and taking off too
 * little shows the file's name where the asset's belongs.
 */

test('a file is named by the asset and then by its type', () => {
    expect(stemFor('GrandHotel', 'BuildingPreset')).toBe('GrandHotel.BuildingPreset');
    expect(fileNameFor('GrandHotel', 'BuildingPreset')).toBe('GrandHotel.BuildingPreset.sodso.json');

    // A name is one thing and a type is another; there is no file without both.
    expect(() => stemFor('GrandHotel', null)).toThrow();
    expect(() => stemFor('', 'BuildingPreset')).toThrow();
});

test('the two suffixes are what tells the two kinds of file apart', () => {
    expect(PRESET_SUFFIX).toBe('.sodso.json');
    expect(PATCH_SUFFIX).toBe('.sodso_patch.json');
});

test('the type comes back off, and only the type', () => {
    expect(assetNameOf('GrandHotel.BuildingPreset', 'BuildingPreset')).toBe('GrandHotel');

    // Two assets of the same name and different types are two files, and each one still
    // knows what it is called.
    expect(assetNameOf('Bar.AddressPreset', 'AddressPreset')).toBe('Bar');
    expect(assetNameOf('Bar.RoomTypeFilter', 'RoomTypeFilter')).toBe('Bar');
});

test('a file named before this convention keeps the name it has', () => {
    // Still loadable, still listed, and not something to shorten.
    expect(assetNameOf('GrandHotel', 'BuildingPreset')).toBe('GrandHotel');

    // The type of some other file is not this file's to take off.
    expect(assetNameOf('GrandHotel.MurderMO', 'BuildingPreset')).toBe('GrandHotel.MurderMO');
});

test('a dot in the asset name is not mistaken for a type', () => {
    expect(assetNameOf('Something.Else', 'MurderMO')).toBe('Something.Else');
    expect(assetNameOf('Something.Else.MurderMO', 'MurderMO')).toBe('Something.Else');
});

test('a stem matches its type exactly, not loosely', () => {
    // `Preset` ends the stem but is not what ends it. Trimming on a partial match would
    // leave a trailing dot and an asset name nothing resolves.
    expect(assetNameOf('GrandHotel.BuildingPreset', 'Preset')).toBe('GrandHotel.BuildingPreset');

    // Case is not normalised here: `presetName` is written to the file as the author
    // typed it, and the stem is built from that same string.
    expect(assetNameOf('GrandHotel.buildingpreset', 'BuildingPreset')).toBe('GrandHotel.buildingpreset');
});

test('nothing to take a type off is not an error', () => {
    // A file with no type recorded -- one that would not parse, say -- still has to be
    // listed somewhere rather than stopping the listing.
    expect(assetNameOf('GrandHotel', null)).toBe('GrandHotel');
    expect(assetNameOf('', 'MurderMO')).toBe('');
    expect(assetNameOf(null, 'MurderMO')).toBe('');
});

/**
 * Titling an open document. Three kinds of path arrive here and all three are titled
 * the same way, which is the whole point: what an author is editing is an asset of a
 * type, and how the file happens to spell that is the editor's business rather than
 * theirs.
 */

test('an asset is recovered from any of the paths it can be stored under', () => {
    // The mod's own, which names the type after the asset.
    expect(assetOfPath('Bar.AddressPreset.sodso.json', 'AddressPreset')).toBe('Bar');

    // An override, which carries no type at all -- the name is what it overrides.
    expect(assetOfPath('Bar.sodso_patch.json', 'AddressPreset')).toBe('Bar');

    // A base game asset as this tool ships it: a folder per type, so the file is the
    // whole of the name and there is nothing to take off it.
    expect(assetOfPath('AddressPreset/Bar.json', 'AddressPreset')).toBe('Bar');
});

test('a file named before the type joined the name is still just its name', () => {
    expect(assetOfPath('GrandHotel.sodso.json', 'BuildingPreset')).toBe('GrandHotel');
    expect(assetOfPath('Something.Else.sodso.json', 'MurderMO')).toBe('Something.Else');
});

test('a document is titled by its type and then its name', () => {
    expect(titleFor('Bar.AddressPreset.sodso.json', 'AddressPreset')).toBe('AddressPreset/Bar');
    expect(titleFor('Bar.sodso_patch.json', 'AddressPreset')).toBe('AddressPreset/Bar');

    // Which is how the base game's files were already titled: their path is that title.
    expect(titleFor('AddressPreset/Bar.json', 'AddressPreset')).toBe('AddressPreset/Bar');
});

test('a document whose type is not known is titled by its name alone', () => {
    // A hand-written patch of an asset no type answers to, say. Titling it
    // "undefined/Bar" would be a claim about it, and there is nothing to claim.
    expect(titleFor('Bar.sodso_patch.json', null)).toBe('Bar');
    expect(titleFor('Nonsense.sodso.json', undefined)).toBe('Nonsense');
});
