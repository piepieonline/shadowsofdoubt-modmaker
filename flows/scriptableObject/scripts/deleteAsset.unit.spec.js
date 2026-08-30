import { test, expect } from 'vitest';
import { refersToAsset } from './deleteAsset.js';

/**
 * Whether one case document points at another.
 *
 * This is what decides whether an author is warned before deleting an asset, so both
 * failures cost them something real: a miss deletes the file a preset depended on with
 * nothing said, and a false hit sends them looking through a file that was never involved.
 *
 * Walking a folder needs directory handles and is covered in tests/soFilePanel.spec.js.
 * What is here takes a parsed document and answers the question.
 */

const target = { assetName: 'GrandHotel', type: 'AddressPreset' };

test('finds a reference written the way this app writes one', () => {
    expect(refersToAsset({ copyFrom: 'REF:AddressPreset|GrandHotel' }, target)).toBe(true);
});

test('finds one written without the type, as a hand-written mod has it', () => {
    // A bare `REF:` names no type, so there is nothing to check it against -- and
    // reporting it against every asset of that name is the failure that costs least.
    expect(refersToAsset({ copyFrom: 'REF:GrandHotel' }, target)).toBe(true);
});

test('a different type of the same name is not a reference', () => {
    // Hundreds of names belong to more than one type: `Bar` is six things. A reference
    // that says which one it means is taken at its word.
    expect(refersToAsset({ copyFrom: 'REF:RoomTypeFilter|GrandHotel' }, target)).toBe(false);
});

test('a different asset of the same type is not a reference', () => {
    expect(refersToAsset({ copyFrom: 'REF:AddressPreset|GrandHotelAnnex' }, target)).toBe(false);

    // Names are compared whole, so neither is a prefix match on the other.
    expect(refersToAsset({ copyFrom: 'REF:AddressPreset|Grand' }, target)).toBe(false);
});

test('looks everywhere in the document, however deeply nested', () => {
    // A real MurderMO holds references four levels down, inside arrays of objects.
    expect(refersToAsset({
        MOleads: [{ traitModifiers: [{ preset: 'REF:AddressPreset|GrandHotel' }] }],
    }, target)).toBe(true);

    expect(refersToAsset({ compatibleWith: ['REF:AddressPreset|GrandHotel'] }, target)).toBe(true);
});

test('a name that merely appears in the text is not a reference', () => {
    // The whole point of matching `REF:` rather than the name: a mod that mentions an
    // asset in its notes has not made the file depend on it.
    expect(refersToAsset({ notes: 'Set in the GrandHotel' }, target)).toBe(false);
    expect(refersToAsset({ name: 'GrandHotel' }, target)).toBe(false);
});

test('an untyped target matches on the name alone', () => {
    // An Invalid file has no type the game recognises, so a type check would rule out
    // every reference to it -- and those are exactly the files worth warning about.
    expect(refersToAsset({ copyFrom: 'REF:AddressPreset|Nonsense' }, { assetName: 'Nonsense', type: null }))
        .toBe(true);
});

test('surrounding space does not hide a reference', () => {
    expect(refersToAsset({ copyFrom: ' REF:AddressPreset|GrandHotel ' }, target)).toBe(true);
});

test('a document with no references at all is not one', () => {
    expect(refersToAsset({ fileType: 'MurderMO', name: 'x', chance: 0.5, ok: true }, target)).toBe(false);
    expect(refersToAsset({}, target)).toBe(false);
    expect(refersToAsset(null, target)).toBe(false);
});
