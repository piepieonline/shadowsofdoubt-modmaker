import { test, expect } from 'vitest';
import { resolveReferences } from './soReferences.js';

/**
 * What an exported ScriptableObject's references become on the way in.
 *
 * The unmapped case is the one that matters. It was a display bug while a patch held whole
 * fields; now that a patch is a diff, a null written here is a null written into the game's
 * object -- so the three outcomes are kept apart deliberately and tested that way.
 */

const pathIdMap = { 40114: 'MurderMO|ExCopSniper', 14318: 'CharacterTrait|Sniper' };

test('a reference the data knows becomes the name it stands for', () => {
    expect(resolveReferences({ compatibleWith: [{ m_FileID: 40114, m_PathID: 0 }] }, pathIdMap))
        .toEqual({ compatibleWith: ['REF:MurderMO|ExCopSniper'] });
});

test('a reference to nothing is null, because that is what it means', () => {
    expect(resolveReferences({ weapon: { m_FileID: 0, m_PathID: 0 } }, pathIdMap))
        .toEqual({ weapon: null });
});

test('a reference the data does not cover is left exactly as it was found', () => {
    // 181 of the 10,565 references in the shipped assets are these, mostly prefabs and
    // materials. Writing null here would carry a null into any operation whose value
    // contains it, and replace the game's reference with nothing.
    const document = { icon: { m_FileID: 99999, m_PathID: 0 } };

    expect(resolveReferences(document, pathIdMap)).toEqual({ icon: { m_FileID: 99999, m_PathID: 0 } });
});

test('references are found however deeply they are nested', () => {
    const document = {
        murdererTraitModifiers: [
            { rule: 0, traitList: [{ m_FileID: 14318, m_PathID: 0 }, { m_FileID: 77, m_PathID: 0 }] },
        ],
    };

    expect(resolveReferences(document, pathIdMap)).toEqual({
        murdererTraitModifiers: [
            { rule: 0, traitList: ['REF:CharacterTrait|Sniper', { m_FileID: 77, m_PathID: 0 }] },
        ],
    });
});

test('the document handed in is not modified', () => {
    const document = { compatibleWith: [{ m_FileID: 40114, m_PathID: 0 }] };
    resolveReferences(document, pathIdMap);

    expect(document.compatibleWith[0]).toEqual({ m_FileID: 40114, m_PathID: 0 });
});

test('a document with no references comes back as it went in', () => {
    const document = { presetName: 'Bar', notes: 'nothing to resolve', list: [1, 2, 3] };

    expect(resolveReferences(document, pathIdMap)).toEqual(document);
});
