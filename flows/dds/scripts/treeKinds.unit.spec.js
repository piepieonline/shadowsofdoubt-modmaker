import { describe, test, expect } from 'vitest';
import { enums } from '../../../core/refs.js';
import ddsTemplates from '../../../refs/authored/ddsTemplates.json' with { type: 'json' };
import { deepClone } from '../../../core/files.js';
import {
    applyTreeKind, kindsWithAnInvalidTriggerPoint, parseNewFileType, TREE_KINDS, treeKind,
    treeKindValue,
} from './treeKinds.js';
import { allowedTriggerPoints, TreeType } from './treeViews.js';

/**
 * What a new tree of each kind is.
 *
 * The rule under all of these is that a tree the editor makes should be one the game will
 * actually run. A `DDSTreeSave` is six formats sharing a struct, so a single template can
 * only be one of them -- and the one it was, a v-mail, was the wrong answer five times
 * out of six. The tests that matter most are the ones checking the type/trigger pairing
 * against `treeViews.js`, which is the same §2 table the *view* filters that dropdown by:
 * a created value the editor would then refuse to offer is the editor disagreeing with
 * itself.
 *
 * Run against the real templates and the real enums rather than a fixture, as
 * `elementTemplates.unit.spec.js` is, for the same reason: an invented type would say
 * nothing about the trees an author ends up with.
 */

/** A fresh tree as createNewFile has it: the template, with its one message in place. */
function newTree() {
    const tree = deepClone(ddsTemplates.tree);
    tree.messages.push(deepClone(ddsTemplates.treeMessage));
    return tree;
}

const of = (treeType) => applyTreeKind(newTree(), treeType);

describe('the six kinds', () => {
    test('are the game\'s six, in its order', () => {
        expect(TREE_KINDS.map((kind) => kind.treeType)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(TREE_KINDS).toHaveLength(enums.TreeType.length);
    });

    test('each name a kind rather than an enum value', () => {
        // The dialog asks what to make, so the answers read as the thing in the game --
        // "Message library", not `misc`. Every one has a line under it saying what it is.
        for (const kind of TREE_KINDS) {
            expect(kind.label, String(kind.treeType)).toBeTruthy();
            expect(kind.blurb, kind.label).toBeTruthy();
        }
    });

    test('and are addressed by the value the dialog carries', () => {
        expect(TREE_KINDS.map(treeKindValue))
            .toEqual(['tree:0', 'tree:1', 'tree:2', 'tree:3', 'tree:4', 'tree:5']);
        expect(treeKind(TreeType.MISC).label).toBe('Message library');
        expect(treeKind(6)).toBeUndefined();
    });
});

describe('parseNewFileType', () => {
    test('splits a tree from its kind', () => {
        expect(parseNewFileType('tree:0')).toEqual({ type: 'tree', treeType: 0 });
        expect(parseNewFileType('tree:5')).toEqual({ type: 'tree', treeType: 5 });
    });

    test('leaves the other three answers alone', () => {
        // These are what they always were, so nothing downstream of them changed.
        expect(parseNewFileType('message')).toEqual({ type: 'message', treeType: null });
        expect(parseNewFileType('block')).toEqual({ type: 'block', treeType: null });
        expect(parseNewFileType('strings')).toEqual({ type: 'strings', treeType: null });
    });

    test('and a kind it does not have is no kind', () => {
        // Nothing on screen produces these -- the options are built from the table. The
        // answer is a tree of the template's own type rather than of a seventh one.
        expect(parseNewFileType('tree:6').treeType).toBeNull();
        expect(parseNewFileType('tree:').treeType).toBeNull();
        expect(parseNewFileType('tree').treeType).toBeNull();
        expect(parseNewFileType(undefined)).toEqual({ type: '', treeType: null });
    });
});

describe('applyTreeKind', () => {
    test('says what kind of tree it is', () => {
        for (const kind of TREE_KINDS) {
            expect(of(kind.treeType).treeType).toBe(kind.treeType);
        }
    });

    test('with a trigger point the game will dispatch it on', () => {
        // The heart of it. A conversation left at the template's vmail(3) is registered
        // under a trigger point nothing conversational ever fires, and a newspaper at
        // never(5) is filtered out of every article query -- both silently.
        expect(of(TreeType.CONVERSATION).triggerPoint).toBe(0);   // onNewTrackTarget
        expect(of(TreeType.VMAIL).triggerPoint).toBe(3);          // vmail
        expect(of(TreeType.NEWSPAPER).triggerPoint).toBe(6);      // newspaperArticle
        expect(of(TreeType.MISC).triggerPoint).toBe(5);           // never
        expect(of(TreeType.INTERACTION_DIALOG).triggerPoint).toBe(7); // onGameStart

        // A document is never dispatched at all; all 218 shipped ones sit here.
        expect(of(TreeType.DOCUMENT).triggerPoint).toBe(0);
    });

    test('and one the view would let an author pick', () => {
        // Asked of treeViews.js rather than restated, so the two halves of the same table
        // cannot disagree: the create-time value has to survive the dropdown filter the
        // document is opened under, or the editor immediately contradicts itself.
        expect(kindsWithAnInvalidTriggerPoint()).toEqual([]);

        for (const kind of TREE_KINDS) {
            expect(allowedTriggerPoints(kind.treeType), kind.label)
                .toContain(of(kind.treeType).triggerPoint);
        }
    });

    test('a conversation has two people in it, awake and not reacting to anything', () => {
        const tree = of(TreeType.CONVERSATION);

        // B is only matched where it is required, and a conversation with nobody to talk
        // to never plays.
        expect(tree.participantA.required).toBe(true);
        expect(tree.participantB.required).toBe(true);
        // C and D are left as the class has them: this is a conversation between two.
        expect(tree.participantC.required).toBe(false);
        expect(tree.participantD.required).toBe(false);

        expect(tree.participantA.triggers).toEqual([0, 4]);
        expect(enums.TreeTriggers[0]).toBe('awake');
        expect(enums.TreeTriggers[4]).toBe('noReactionState');
    });

    test('a v-mail has a sender and a recipient and no world state to satisfy', () => {
        const tree = of(TreeType.VMAIL);

        expect(tree.participantA.required).toBe(true);
        expect(tree.participantB.required).toBe(true);
        // Participants are picked city-wide, so where they are and what they are doing is
        // not a condition on the mail being sent.
        expect(tree.participantA.triggers).toEqual([]);
    });

    test('a document is a page that can be seen', () => {
        const tree = of(TreeType.DOCUMENT);

        // At the class defaults -- no background on a 0x0 page -- a document opens blank,
        // and nothing on screen says why. These are the commonest shipped answers.
        expect(tree.document).toEqual({
            background: 'Paper',
            fill: 1,
            size: { x: 342, y: 482 },
            // Untouched: the tint over the sprite, which the template already has white.
            colour: { r: 1, g: 1, b: 1, a: 1 },
        });

        // Its one element is the document's primary text, which is what the evidence
        // window shows as the summary before the page is opened.
        expect(tree.messages[0].usePages).toBe(true);
    });

    test('an interaction dialog reaches somebody', () => {
        // 0 is the class default and means the tree is added to no citizen at all: the
        // count gates on `citizens / limitation`. A tree that does nothing, with nothing
        // to say so.
        expect(ddsTemplates.tree.interactionCitizenLimitation).toBe(0);
        expect(of(TreeType.INTERACTION_DIALOG).interactionCitizenLimitation).toBe(20);
    });

    test('leaves everything the kind has nothing to say about', () => {
        // The class initialisers are the template's job, and restating one here would be
        // a second place for it to be wrong. A misc library is the plainest case: a
        // trigger point, and otherwise the tree the template describes.
        expect(of(TreeType.MISC)).toEqual({
            ...newTree(), treeType: TreeType.MISC, triggerPoint: 5,
        });
    });

    test('and a kind it does not have leaves the tree exactly as it was', () => {
        expect(of(6)).toEqual(newTree());
        expect(of(null)).toEqual(newTree());
        expect(of(undefined)).toEqual(newTree());
    });

    test('never hands out the table\'s own values', () => {
        // A conversation's triggers are a list in this module. Two trees made in one
        // session sharing it would mean editing one and finding the other changed.
        const first = of(TreeType.CONVERSATION);
        first.participantA.triggers.push(29);

        expect(of(TreeType.CONVERSATION).participantA.triggers).toEqual([0, 4]);
        expect(of(TreeType.DOCUMENT).document)
            .not.toBe(of(TreeType.DOCUMENT).document);
    });

    test('and copes with a tree that has no message yet', () => {
        const bare = deepClone(ddsTemplates.tree);

        expect(() => applyTreeKind(bare, TreeType.DOCUMENT)).not.toThrow();
        expect(bare.treeType).toBe(TreeType.DOCUMENT);
    });
});

describe('every value a kind writes', () => {
    test('is a field the template already has', () => {
        // A field the template does not carry is one the class does not declare -- see
        // elementTemplates.unit.spec.js, which checks that pairing -- so writing it would
        // put a key in a mod's document that the game reads nothing from.
        for (const kind of TREE_KINDS) {
            for (const field of Object.keys(kind.tree ?? {})) {
                expect(field in ddsTemplates.tree, `${kind.label}.${field}`).toBe(true);
            }

            for (const field of Object.keys(kind.message ?? {})) {
                expect(field in ddsTemplates.treeMessage, `${kind.label}.${field}`).toBe(true);
            }
        }
    });

    test('and lands in range where it is an enum', () => {
        for (const kind of TREE_KINDS) {
            expect(enums.TriggerPoint[kind.tree.triggerPoint], kind.label).toBeTruthy();

            for (const trigger of kind.tree.participantA?.triggers ?? []) {
                expect(enums.TreeTriggers[trigger], kind.label).toBeTruthy();
            }
        }
    });
});
