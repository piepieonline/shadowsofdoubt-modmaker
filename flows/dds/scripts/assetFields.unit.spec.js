import { describe, test, expect } from 'vitest';
import soAssetsByType from '../../../refs/generated/soAssetsByType.json' with { type: 'json' };
import { typeLayout } from '../../../core/refs.js';
import { resolveField } from '../../../core/typeHints.js';
import { assetTypeOfField, ASSET_TYPES_NAMED } from './assetFields.js';

/**
 * Which DDS strings name one of the game's assets.
 *
 * A wrong answer here is a field turned into a dropdown of the wrong list -- 389 traits
 * offered for something that is not a trait -- so what the table claims is checked against
 * the layout it claims it about, rather than taken on trust.
 */

const TREE = 'DDSTreeSave';
const MESSAGE = 'DDSMessageSave';
const BLOCK = 'DDSBlockSave';

/** What the flow asks about a node: the field it resolves to, and whether it is an element. */
const at = (path, isElement = true) =>
    assetTypeOfField(resolveField(path, typeLayout), isElement);

describe('assetTypeOfField', () => {
    test('names the type behind each list of names', () => {
        expect(at([TREE, 'participantA', 'traits'])).toBe('CharacterTrait');
        expect(at([TREE, 'participantA', 'jobs'])).toBe('OccupationPreset');
        expect(at([TREE, 'itemPool'])).toBe('InteractablePreset');
    });

    test('finds a trait wherever the format puts one', () => {
        // Four types carry `traits`, and a condition on a line means the same thing as a
        // condition on a branch or on who is in the conversation at all.
        expect(at([TREE, 'messages', 'links', 'traits'])).toBe('CharacterTrait');
        expect(at([MESSAGE, 'blocks', 'traits'])).toBe('CharacterTrait');
        expect(at([BLOCK, 'replacements', 'traits'])).toBe('CharacterTrait');
    });

    test('answers for the elements of the list and not for the list itself', () => {
        // Both resolve to the same field -- the layout is walked with array indices
        // dropped -- and only one of them is a name. The list is edited by adding to it.
        expect(at([TREE, 'participantA', 'traits'], false)).toBeNull();
    });

    test('says nothing about the strings that are not names', () => {
        expect(at([TREE, 'name'])).toBeNull();
        expect(at([TREE, 'startingMessage'])).toBeNull();
        expect(at([TREE, 'messages', 'msgID'])).toBeNull();
        // Every participant's triggers are an enum, which has its own control already.
        expect(at([TREE, 'participantA', 'triggers'])).toBeNull();
        expect(at([], true)).toBeNull();
    });
});

describe('the types named', () => {
    test('are types the game has assets of', () => {
        // The list is what fills the dropdown. A type the reference data does not carry
        // would be a control offering nothing, which reads as a field with no valid value.
        for (const type of ASSET_TYPES_NAMED) {
            expect(soAssetsByType[type]?.length, type).toBeGreaterThan(0);
        }
    });

    test('are the three the fields name', () => {
        expect(ASSET_TYPES_NAMED.sort()).toEqual(
            ['CharacterTrait', 'InteractablePreset', 'OccupationPreset']);
    });
});
