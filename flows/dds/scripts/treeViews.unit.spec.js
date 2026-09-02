import { describe, test, expect } from 'vitest';
import { typeLayout, enums } from '../../../core/refs.js';
import { resolveField } from '../../../core/typeHints.js';
import {
    ALWAYS_HIDDEN_FIELDS, Relevance, VIEW_DEPENDENT_FIELDS,
    allowedTriggerPoints, isViewType, optionFilterFor, relevanceOf,
} from './treeViews.js';

/**
 * The table that decides what an author sees.
 *
 * A wrong entry here is a field taken off the screen that the game reads -- which is worse
 * than the noise the view exists to remove, because nothing on screen says it happened. So
 * the table is checked against the layout it claims things about rather than taken on
 * trust: a key that resolves to nothing is a row that would silently never match, and a
 * typo in a field name looks exactly like a field nobody classified.
 */

/** What the flow asks: the field a node resolves to, keyed as the table keys it. */
const at = (ownerType, field) => resolveField([ownerType, field], typeLayout);

const relevance = (ownerType, field, treeType) => relevanceOf(at(ownerType, field), treeType);

const CONVERSATION = 0, VMAIL = 1, DOCUMENT = 2, NEWSPAPER = 3, MISC = 4, INTERACTION = 5;

describe('the table describes fields that exist', () => {
    test.each([...VIEW_DEPENDENT_FIELDS, ...ALWAYS_HIDDEN_FIELDS])('%s is a real field', (fieldKey) => {
        const [ownerType, field] = fieldKey.split('.');
        expect(at(ownerType, field), `${fieldKey} is not in the game's type layout`).not.toBeNull();
    });

    test('keeps its two halves apart', () => {
        // A field cannot be both classified per kind and hidden outright -- one of the two
        // entries would never be consulted, and which one is an accident of lookup order.
        const overlap = VIEW_DEPENDENT_FIELDS.filter((k) => ALWAYS_HIDDEN_FIELDS.includes(k));
        expect(overlap).toEqual([]);
    });
});

describe('relevanceOf', () => {
    test('a document is a page, not a conversation', () => {
        // No participant matching, no triggering, no branching: a note does not have a
        // speaker, and all 218 shipped documents leave every one of these at default.
        for (const field of ['participantA', 'participantB', 'repeat', 'triggerPoint',
            'treeChance', 'priority', 'stopMovement', 'ignoreGlobalRepeat', 'startingMessage']) {
            expect(relevance('DDSTreeSave', field, DOCUMENT), field).toBe(Relevance.HIDDEN);
        }

        expect(relevance('DDSTreeSave', 'document', DOCUMENT)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSMessageSettings', 'order', DOCUMENT)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSMessageSettings', 'elementName', DOCUMENT)).toBe(Relevance.PRIMARY);
    });

    test('a conversation is spoken aloud, so it has no page', () => {
        // These sit on the shared DDSMessageSettings struct only because documents need
        // them. There is nothing to draw a conversation on.
        for (const field of ['size', 'rot', 'col', 'font', 'fontSize', 'charSpace', 'wordSpace',
            'lineSpace', 'paraSpace', 'alignH', 'alignV', 'usePages', 'isHandwriting', 'order']) {
            expect(relevance('DDSMessageSettings', field, CONVERSATION), field).toBe(Relevance.HIDDEN);
        }

        expect(relevance('DDSTreeSave', 'document', CONVERSATION)).toBe(Relevance.HIDDEN);
        expect(relevance('DDSMessageSettings', 'saidBy', CONVERSATION)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSMessageSettings', 'links', CONVERSATION)).toBe(Relevance.PRIMARY);
    });

    test('order is hidden wherever it is not read, however often the files set it', () => {
        // 386 of 472 shipped conversation messages carry a non-zero order, and 754 of 774
        // misc ones. Nothing sorts by it outside a document -- that is the whole point of
        // hiding it, and the reason this test exists rather than a data check.
        expect(relevance('DDSMessageSettings', 'order', CONVERSATION)).toBe(Relevance.HIDDEN);
        expect(relevance('DDSMessageSettings', 'order', VMAIL)).toBe(Relevance.HIDDEN);
        expect(relevance('DDSMessageSettings', 'order', NEWSPAPER)).toBe(Relevance.HIDDEN);
        expect(relevance('DDSMessageSettings', 'order', MISC)).toBe(Relevance.HIDDEN);
        expect(relevance('DDSMessageSettings', 'order', INTERACTION)).toBe(Relevance.HIDDEN);
    });

    test('an inbox is a vmail idea', () => {
        expect(relevance('DDSParticipant', 'disableInbox', VMAIL)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSParticipant', 'disableInbox', CONVERSATION)).toBe(Relevance.HIDDEN);

        // The rest of a participant means the same thing wherever a participant is read.
        expect(relevance('DDSParticipant', 'triggers', CONVERSATION)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSParticipant', 'triggers', VMAIL)).toBe(Relevance.PRIMARY);
    });

    test('a link is only ranked where something ranks links', () => {
        // A vmail branches -- 21 links across 175 messages -- but nothing weighs the
        // branches, so only `from` and `to` survive there.
        expect(relevance('DDSMessageLink', 'to', VMAIL)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSMessageLink', 'from', VMAIL)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSMessageLink', 'useWeights', VMAIL)).toBe(Relevance.HIDDEN);
        expect(relevance('DDSMessageLink', 'useKnowLike', VMAIL)).toBe(Relevance.HIDDEN);
        expect(relevance('DDSMessageLink', 'delayInterval', VMAIL)).toBe(Relevance.HIDDEN);

        expect(relevance('DDSMessageLink', 'useWeights', CONVERSATION)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSMessageLink', 'useWeights', INTERACTION)).toBe(Relevance.PRIMARY);
        // These three postdate every other tree's files and are absent from their JSON.
        expect(relevance('DDSMessageLink', 'isDialogSuccess', CONVERSATION)).toBe(Relevance.HIDDEN);
        expect(relevance('DDSMessageLink', 'isDialogSuccess', INTERACTION)).toBe(Relevance.PRIMARY);
    });

    test('the newspaper fields belong to newspapers', () => {
        expect(relevance('DDSTreeSave', 'newspaperCategory', NEWSPAPER)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSTreeSave', 'newspaperContext', NEWSPAPER)).toBe(Relevance.PRIMARY);
        // 149 of 218 documents carry a non-zero newspaperCategory. Nothing reads it there.
        expect(relevance('DDSTreeSave', 'newspaperCategory', DOCUMENT)).toBe(Relevance.HIDDEN);
        expect(relevance('DDSTreeSave', 'newspaperContext', CONVERSATION)).toBe(Relevance.HIDDEN);
    });

    test('the interaction fields belong to the one tree that uses them', () => {
        for (const field of ['itemPool', 'interactionCitizenLimitation', 'interactionOnePerCity']) {
            expect(relevance('DDSTreeSave', field, INTERACTION), field).toBe(Relevance.PRIMARY);
            expect(relevance('DDSTreeSave', field, CONVERSATION), field).toBe(Relevance.HIDDEN);
            expect(relevance('DDSTreeSave', field, DOCUMENT), field).toBe(Relevance.HIDDEN);
        }

        // One level down the drill-down: the message document, not the placed message.
        expect(relevance('DDSMessageSave', 'events', INTERACTION)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSMessageSave', 'events', VMAIL)).toBe(Relevance.HIDDEN);
    });

    test('a misc tree is a list of messages and nothing else', () => {
        // Not a document at all: these exist so a DialogPreset or BookPreset has a msgID
        // to point at. They never execute.
        for (const field of ['participantA', 'triggerPoint', 'repeat', 'treeChance',
            'startingMessage', 'document']) {
            expect(relevance('DDSTreeSave', field, MISC), field).toBe(Relevance.HIDDEN);
        }

        expect(relevance('DDSMessageSettings', 'msgID', MISC)).toBe(Relevance.PRIMARY);
    });

    test('hides what no tree of any kind reads', () => {
        for (const treeType of [CONVERSATION, VMAIL, DOCUMENT, NEWSPAPER, MISC, INTERACTION]) {
            // Serialised, and ConstructContent never applies it.
            expect(relevance('DDSMessageSettings', 'fontStyle', treeType)).toBe(Relevance.HIDDEN);
            // [NonSerialized] runtime state that should never be in a file.
            expect(relevance('DDSTreeSave', 'messageRef', treeType)).toBe(Relevance.HIDDEN);
            expect(relevance('DDSTreeSave', 'citizenAddCount', treeType)).toBe(Relevance.HIDDEN);
        }
    });

    test('shows a field nobody has classified', () => {
        // The important default. A field the table does not mention -- or one a future
        // game update adds -- stays on the screen, so the view can only ever be wrong in
        // the direction of showing too much.
        expect(relevance('DDSTreeSave', 'name', DOCUMENT)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSTreeSave', 'id', MISC)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSMessageSettings', 'instanceID', DOCUMENT)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSMessageSettings', 'pos', MISC)).toBe(Relevance.PRIMARY);
        // A block says the same thing whatever reaches it -- §6 has no per-type rows.
        expect(relevance('DDSBlockCondition', 'group', CONVERSATION)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSReplacement', 'useConnection', DOCUMENT)).toBe(Relevance.PRIMARY);
    });

    test('shows everything when there is no view to be in', () => {
        // A node the layout cannot describe: the `_ENG Localisation_` row the editor adds
        // beside a block, and the document root itself.
        expect(relevanceOf(null, DOCUMENT)).toBe(Relevance.PRIMARY);

        // A message opened straight from the panel has no tree above it to take a kind
        // from. Not knowing is a reason to show, never to hide.
        expect(relevance('DDSMessageSettings', 'order', null)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSTreeSave', 'participantA', undefined)).toBe(Relevance.PRIMARY);
        expect(relevance('DDSTreeSave', 'participantA', 99)).toBe(Relevance.PRIMARY);

        // Except what nothing reads anywhere -- that does not depend on the kind.
        expect(relevance('DDSMessageSettings', 'fontStyle', null)).toBe(Relevance.HIDDEN);
    });
});

describe('allowedTriggerPoints', () => {
    test('offers only the pairs the game dispatches', () => {
        expect(allowedTriggerPoints(CONVERSATION)).toEqual([0, 2, 4, 5]);
        expect(allowedTriggerPoints(VMAIL)).toEqual([3, 5]);
        expect(allowedTriggerPoints(NEWSPAPER)).toEqual([5, 6]);
        expect(allowedTriggerPoints(MISC)).toEqual([5]);
        expect(allowedTriggerPoints(INTERACTION)).toEqual([7]);
    });

    test('says nothing rather than everything when the kind is unknown', () => {
        // Null is "do not filter this control", which is not the same answer as a kind
        // that happens to allow every value.
        expect(allowedTriggerPoints(null)).toBeNull();
        expect(allowedTriggerPoints(99)).toBeNull();
    });

    test('every value it offers is a real trigger point', () => {
        const triggerPoints = enums.TriggerPoint;
        expect(triggerPoints.length).toBeGreaterThan(0);

        for (let treeType = 0; treeType < 6; treeType++) {
            for (const index of allowedTriggerPoints(treeType)) {
                expect(triggerPoints[index], `treeType ${treeType} offers index ${index}`)
                    .toBeDefined();
            }
        }
    });

    test('the newspaper slot the articles are actually drawn from', () => {
        // Every article query filters on newspaperArticle. The four shipped trees set to
        // `never` are dead, which is why both are offered rather than only the live one.
        const triggerPoints = enums.TriggerPoint;
        expect(allowedTriggerPoints(NEWSPAPER).map((i) => triggerPoints[i]))
            .toEqual(['never', 'newspaperArticle']);
    });
});

describe('optionFilterFor', () => {
    const triggerPoint = at('DDSTreeSave', 'triggerPoint');

    test('narrows the trigger points to the ones this kind of tree can have', () => {
        const filter = optionFilterFor(triggerPoint, VMAIL);

        // vmail(3) and never(5), and none of the other six subsystems.
        expect([0, 1, 2, 3, 4, 5, 6, 7].filter(filter)).toEqual([3, 5]);
    });

    test('leaves alone every other dropdown in the document', () => {
        // Only triggerPoint is coupled to treeType. A participant's connection means the
        // same thing in every kind of tree that has participants.
        expect(optionFilterFor(at('DDSParticipant', 'connection'), VMAIL)).toBeNull();
        expect(optionFilterFor(at('DDSTreeSave', 'repeat'), CONVERSATION)).toBeNull();
        expect(optionFilterFor(at('DDSTreeSave', 'treeType'), DOCUMENT)).toBeNull();
        expect(optionFilterFor(null, CONVERSATION)).toBeNull();
    });

    test('does not filter a control it has no view for', () => {
        // A tree whose treeType is out of range, or a window with no kind above it.
        expect(optionFilterFor(triggerPoint, null)).toBeNull();
        expect(optionFilterFor(triggerPoint, 99)).toBeNull();
    });
});

describe('isViewType', () => {
    test('recognises the six kinds and nothing else', () => {
        expect(enums.TreeType).toHaveLength(6);

        for (let treeType = 0; treeType < 6; treeType++) {
            expect(isViewType(treeType), String(treeType)).toBe(true);
        }

        for (const value of [-1, 6, null, undefined, '0', 1.5, NaN]) {
            expect(isViewType(value), String(value)).toBe(false);
        }
    });
});
