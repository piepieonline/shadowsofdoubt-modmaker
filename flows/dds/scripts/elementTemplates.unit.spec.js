import { describe, test, expect } from 'vitest';
import { basicTypeTemplates, enums, typeLayout } from '../../../core/refs.js';
import ddsTemplates from '../../../refs/authored/ddsTemplates.json' with { type: 'json' };
import {
    canBuildElement, elementTypeAt, isSerialisedField, newElement,
} from './elementTemplates.js';

/**
 * What the + on a DDS array adds.
 *
 * The rule these tests are really about is that there is an answer at all: every array in
 * a DDS document used to be described by a `prompt()`, or by nothing, and the arrays with
 * nothing had no + on them. So the first thing asked of each is whether it can be built,
 * against the real reference data rather than a fixture -- a table of two invented types
 * would say nothing about the documents an author actually opens.
 *
 * What cannot be checked here is the half that touches the filesystem: a new message is a
 * document written into the mod, which is ELEMENT_DOCUMENTS in ../index.js and the
 * Playwright suite's business.
 */

/** The flow's globals, as scripts/loadRefs.js composes them. */
const refs = { typeLayout, enums, templates: ddsTemplates, basicTypeTemplates };

const TREE = 'DDSTreeSave';
const MESSAGE = 'DDSMessageSave';
const BLOCK = 'DDSBlockSave';

describe('elementTypeAt', () => {
    test('names the type of an array element, not the array', () => {
        expect(elementTypeAt([TREE, 'messages'], typeLayout)).toBe('DDSMessageSettings');
        expect(elementTypeAt([TREE, 'participantA', 'traits'], typeLayout)).toBe('String');
        expect(elementTypeAt([TREE, 'participantA', 'triggers'], typeLayout))
            .toBe('TreeTriggers');
        expect(elementTypeAt([BLOCK, 'replacements'], typeLayout)).toBe('DDSReplacement');
    });

    test('reaches through an array to the fields of its elements', () => {
        // The old table was keyed by the array's name, so it could not tell one `traits`
        // from another and could not see `links` at all until it was asked about by name.
        // A path with the index dropped resolves through the element type.
        expect(elementTypeAt([TREE, 'messages', 'links'], typeLayout)).toBe('DDSMessageLink');
        expect(elementTypeAt([TREE, 'messages', 'links', 'traits'], typeLayout)).toBe('String');
    });

    test('says nothing for a field that is not a list', () => {
        expect(elementTypeAt([TREE, 'name'], typeLayout)).toBeNull();
        expect(elementTypeAt([TREE, 'participantA'], typeLayout)).toBeNull();
    });

    test('says nothing for a key the layout has never heard of', () => {
        // The English line shown beside a block is this editor's, resolved from the
        // strings CSV for display and stripped on save. It is not a field of anything.
        expect(elementTypeAt([BLOCK, '_ENG Localisation_'], typeLayout)).toBeNull();
        expect(elementTypeAt([TREE, 'notAFieldOfATree'], typeLayout)).toBeNull();
    });
});

describe('newElement', () => {
    test('a list of names starts as one blank name', () => {
        // `traits` and `jobs`, which asked for the name at a prompt. Empty rather than a
        // placeholder: the row is a text input, and the author types into it.
        expect(newElement('String', refs)).toBe('');
    });

    test('a list of enum values starts at the first of them', () => {
        // `triggers`, which asked for the *index* -- a number typed against a list of
        // names that were on screen either side of the prompt. 0 is `awake`, and the row
        // it lands in is the dropdown that shows so.
        expect(newElement('TreeTriggers', refs)).toBe(0);
        expect(enums.TreeTriggers[0]).toBe('awake');
    });

    test('a boolean is a boolean, not the index of one', () => {
        // The one place the enums table has to lose. A DDS document stores `true`, where
        // a case document stores every enum as its index and `Boolean` is an enum of
        // ['false', 'true'] -- so the flows disagree here on purpose.
        expect(newElement('Boolean', refs)).toBe(false);
        expect(enums.Boolean).toEqual(['false', 'true']);
    });

    test('a message, a link, a block and a replacement come from the authored template', () => {
        // The layout knows a message has a font and a size; only the authored template
        // knows a readable one. A message built from the layout alone would be 0pt text
        // in transparent black at the origin.
        expect(newElement('DDSMessageSettings', refs)).toEqual(ddsTemplates.treeMessage);
        expect(newElement('DDSMessageLink', refs)).toEqual(ddsTemplates.treeMessageLinks);
        expect(newElement('DDSBlockCondition', refs)).toEqual(ddsTemplates.messageBlock);
        expect(newElement('DDSReplacement', refs)).toEqual(ddsTemplates.blockReplacement);
    });

    test('the template is copied, never handed out', () => {
        const first = newElement('DDSMessageSettings', refs);
        first.msgID = 'stamped-on-this-one-only';

        expect(newElement('DDSMessageSettings', refs).msgID)
            .toBe(ddsTemplates.treeMessage.msgID);
        // Deep, not shallow: a message's position is an object it would otherwise share.
        expect(newElement('DDSMessageSettings', refs).pos)
            .not.toBe(newElement('DDSMessageSettings', refs).pos);
    });

    test('a type with no authored template is built from the layout', () => {
        // `events` on a message, which the old table had no entry for at all -- so the
        // array carried no +, and the only way to add one was to edit the file by hand.
        expect(newElement('DDSInteractionEvent', refs)).toEqual({ on: 0, param: '' });
    });

    test('a type that contains itself is built once and stops', () => {
        // A newspaper article's followupStories are articles. An array starts empty
        // whatever it holds, which is what keeps this finite.
        expect(newElement('NewspaperArticle', refs)).toEqual({
            presetName: '',
            disabled: false,
            ddsReference: '',
            category: 0,
            followupStories: [],
            context: 0,
        });
    });

    test('nothing is made of a type nothing describes', () => {
        expect(newElement('NotAGameType', refs)).toBeNull();
        expect(newElement(null, refs)).toBeNull();
    });
});

/**
 * Every authored template, against the type the game gives it.
 *
 * A template wins outright where there is one -- for a whole document as much as for an
 * element -- so a field missing from it is a field missing from everything made through
 * it: a message with no `baseSuccessChance`, a link with none of its dialog-success
 * fields, a tree that never says whether it ignores the global repeat.
 */
const TEMPLATE_TYPES = {
    tree: 'DDSTreeSave',
    treeMessage: 'DDSMessageSettings',
    treeMessageLinks: 'DDSMessageLink',
    message: 'DDSMessageSave',
    messageBlock: 'DDSBlockCondition',
    block: 'DDSBlockSave',
    blockReplacement: 'DDSReplacement',
    newspaper: 'NewspaperArticle',
};

describe('the authored templates', () => {
    test('state every field the game writes to a file', () => {
        // Filled in by hand from the game's own class definitions rather than derived from
        // the layout, and this is why: the layout gives a type and no value, so anything
        // built from it would be 0/false/"" -- and a field whose C# initialiser is not
        // zero would be *overridden* by that rather than left alone. `baseSuccessChance`
        // is 0.5f and `isDialogSuccess` is true; a message at 0 and a link at false are
        // both a document that behaves differently from every one the game ships.
        //
        // So when this fails, the answer is in DDSSaveClasses -- what the field is
        // initialised to -- and not in what its type defaults to.
        for (const [name, type] of Object.entries(TEMPLATE_TYPES)) {
            const missing = Object.keys(typeLayout[type])
                .filter((field) => isSerialisedField({ ownerType: type, field }))
                .filter((field) => !(field in ddsTemplates[name]));

            expect(missing, `${name} (${type})`).toEqual([]);
        }
    });

    test('and nothing the game keeps to itself', () => {
        // A tree's `messageRef` is a Dictionary the game builds after loading and
        // `citizenAddCount` is a counter it keeps while running. Both are [NonSerialized],
        // both are in the generated layout anyway, and neither appears in any of the base
        // game's trees.
        expect('messageRef' in ddsTemplates.tree).toBe(false);
        expect('citizenAddCount' in ddsTemplates.tree).toBe(false);
    });

    test('are what a new document or element is, in full', () => {
        // The values that were missing, spelled out: this is what lands in a mod's folder,
        // and it is worth reading rather than deriving.
        expect(newElement('DDSMessageLink', refs)).toMatchObject({
            isDialogSuccess: true,
            secondaryBranchTrigger: false,
            dialogSuccessModifier: 0.5,
        });
        expect(newElement('DDSMessageSettings', refs)).toMatchObject({ isHandwriting: false });
        expect(ddsTemplates.message).toMatchObject({ baseSuccessChance: 0.5, events: [] });
        expect(ddsTemplates.tree).toMatchObject({
            ignoreGlobalRepeat: false,
            interactionCitizenLimitation: 0,
            interactionOnePerCity: false,
            itemPool: [],
            newspaperCategory: 0,
            newspaperContext: 0,
            // Color.white, which is what a document with a background needs to show it.
            document: { colour: { r: 1, g: 1, b: 1, a: 1 } },
        });
    });
});

describe('canBuildElement', () => {
    test('every array a DDS document holds can be added to', () => {
        // The point of the change, stated as a list. Each of these was a prompt or a + that
        // was not offered; `itemPool` and `events` are the latter.
        const arrays = [
            [TREE, 'messages'], [TREE, 'itemPool'],
            [TREE, 'participantA', 'jobs'], [TREE, 'participantA', 'traits'],
            [TREE, 'participantA', 'triggers'],
            [TREE, 'messages', 'links'], [TREE, 'messages', 'links', 'traits'],
            [MESSAGE, 'blocks'], [MESSAGE, 'events'], [MESSAGE, 'blocks', 'traits'],
            [BLOCK, 'replacements'], [BLOCK, 'replacements', 'traits'],
            ['NewspaperArticle', 'followupStories'],
        ];

        for (const path of arrays) {
            const type = elementTypeAt(path, typeLayout);
            expect(type, path.join('.')).not.toBeNull();
            expect(canBuildElement(type, refs), path.join('.')).toBe(true);
        }
    });

    test('and nothing else is offered a +', () => {
        // A key the layout does not describe resolves to no element type, which is the
        // same answer as a field that is not a list. `possibleImages` is in the newspaper
        // template this tool writes and not in the game's layout for the type.
        expect(canBuildElement(elementTypeAt(['NewspaperArticle', 'possibleImages'], typeLayout), refs))
            .toBe(false);
        expect(canBuildElement(elementTypeAt([TREE, 'treeType'], typeLayout), refs)).toBe(false);
    });

    test('and not a list the game never writes', () => {
        // `messageRef` is a list of strings as far as the generated layout is concerned,
        // so it would have carried a + like any other -- and adding to it would have put a
        // field in the document that the game replaces with its own index on load.
        expect(elementTypeAt([TREE, 'messageRef'], typeLayout)).toBeNull();
        expect(isSerialisedField({ ownerType: TREE, field: 'messageRef' })).toBe(false);
        expect(isSerialisedField({ ownerType: TREE, field: 'itemPool' })).toBe(true);
    });
});
