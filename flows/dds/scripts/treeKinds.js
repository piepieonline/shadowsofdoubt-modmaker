/**
 * What kind of tree to make, and what a tree of that kind has to hold to work.
 *
 * `refs/authored/ddsTemplates.json` is one skeleton, and it is `DDSTreeSave`'s own class
 * initialisers -- what the game builds when it constructs one, field for field. That is
 * the right thing for a template to be and the wrong thing to hand an author, because a
 * `DDSTreeSave` is six formats sharing a struct: the same 23 fields are a speech graph, a
 * mail thread, a page of paper, a newspaper column, a message library and a dialog chain.
 * A skeleton can only be one of them, and it used to be a vmail -- so every conversation
 * anyone made started wrong in the one field that decides whether it ever runs.
 *
 * So the kind is asked for at creation, and the values that kind needs are put in with it.
 * `ddsCategories.md` §8.1: "`treeType` should be a create-time choice that selects an
 * entire editing mode, not a dropdown buried in an inspector alongside 20 irrelevant
 * fields." The filtered view already reads `treeType` that way -- see treeViews.js, which
 * is §2 and §3 of the same document. This is the other half of it: the view decides what
 * an author is shown, and this decides what they are given.
 *
 * ## What counts as "what that kind needs"
 *
 * Only values that are wrong at the class default *for this kind*. Two tests:
 *
 *   - the game will not run the tree at all without it. `triggerPoint` for every kind
 *     (§2 -- the pairs below are the only ones the dispatching code looks for), and
 *     `interactionCitizenLimitation`, which gates on `count >= citizens / limitation` and
 *     so adds the tree to nobody while it is 0.
 *   - the tree runs and shows nothing. A document with no `background` and a 0x0 page is
 *     a piece of evidence that opens blank.
 *
 * Everything else is left at the class default, including fields this kind happens to
 * read. `repeat`, `treeChance` and `priority` are a conversation's business and are all
 * initialised to something sensible in the class; restating them here would be a second
 * place for them to be wrong, and the first place is the game's own source.
 *
 * Nothing here is more than a starting point -- every value is a row in the tree with the
 * control it always had, and an author who changes one is not fighting this table.
 */
import { deepClone } from '../../../core/files.js';
import { allowedTriggerPoints, TreeType } from './treeViews.js';

/**
 * The six kinds, in `DDSSaveClasses.TreeType` order.
 *
 * `label` is what the create dialog offers and `blurb` the line under it. They read as
 * what the thing *is* in the game rather than as the enum name -- an author making a note
 * for the player to find is looking for "a document", not for `treeType: 2`.
 *
 * `tree` and `message` are applied over the template: `tree` onto the document,
 * `message` onto the one placed message it starts with. Absent where the class default
 * is already right for that kind, which is most of them.
 */
export const TREE_KINDS = [
    {
        treeType: TreeType.CONVERSATION,
        label: 'Conversation',
        blurb: 'Two citizens talking out loud in the world',
        tree: {
            // onNewTrackTarget. The commonest of the four a conversation may have (45 of
            // 89 shipped), and the one that fires when the player starts watching someone.
            triggerPoint: 0,
            participantA: {
                // A is always checked whether or not this is set -- §4.0 -- but B is only
                // matched where it is, and a conversation with nobody to talk to is one
                // that never plays. The template leaves both at the class default.
                required: true,
                // "Every executed conversation should set at least those two": 344 uses of
                // awake and 336 of noReactionState across the shipped conversation trees.
                // Without them the line can come out of someone asleep, or mid-fight.
                triggers: [0, 4],
            },
            participantB: { required: true },
        },
    },
    {
        treeType: TreeType.VMAIL,
        label: 'V-mail',
        blurb: 'A message thread on a citizen’s cruncher',
        tree: {
            // vmail. The only trigger point that sends one; `never`(5) is the other legal
            // value and means a thread that exists and is never delivered.
            triggerPoint: 3,
            // Sender and recipient. Both are cast city-wide rather than by proximity.
            participantA: { required: true },
            participantB: { required: true },
        },
    },
    {
        treeType: TreeType.DOCUMENT,
        label: 'Document',
        blurb: 'A page the player reads — a note, a ledger, an ID',
        tree: {
            // Documents are never dispatched, so this is read by nothing; all 218 shipped
            // ones leave it here, and the view hides the field. Named rather than left to
            // the template so this table says what every kind's value is.
            triggerPoint: 0,
            // The page itself, which for every other kind is inert and hidden. A document
            // with no background on a 0x0 page opens as nothing at all, so these are the
            // commonest shipped answers: Paper (95 of 218), 342x482 (177), Sliced (167).
            document: {
                background: 'Paper',
                fill: 1,
                size: { x: 342, y: 482 },
            },
        },
        message: {
            // This element is the document's primary text: `Strings.GetMainText` returns
            // the first `usePages` element as the summary shown before the page is opened,
            // and it gets the minimum font-size boost. Set on exactly one element per
            // document -- which is what a new one has.
            usePages: true,
        },
    },
    {
        treeType: TreeType.NEWSPAPER,
        label: 'Newspaper article',
        blurb: 'An article or classified ad in the paper',
        tree: {
            // newspaperArticle. Every article query filters on it; the four shipped trees
            // set to `never`(5) are silently dead, which §4.3 asks an editor not to make
            // any more of.
            triggerPoint: 6,
            // Category 0 is the filler/general slot and context 0 is `nothing`, which are
            // the class defaults and the right pair to start from: an article written
            // against a murder context with no `|murder.*|` tokens in it renders empty.
        },
    },
    {
        treeType: TreeType.MISC,
        label: 'Message library',
        blurb: 'Messages other content pulls by ID — never runs on its own',
        tree: {
            // never. All 21 shipped libraries have it, and it is what keeps them out of
            // `GenerateVocab` -- a library is a place to keep messages, not something that
            // fires. The only product of one is its messages' msgIDs.
            triggerPoint: 5,
        },
    },
    {
        treeType: TreeType.INTERACTION_DIALOG,
        label: 'Interaction dialog',
        blurb: 'Player dialog options added to citizens at world generation',
        tree: {
            // onGameStart -- instances are handed out during world generation and never
            // afterwards.
            triggerPoint: 7,
            // One instance per this many citizens. `citizenAddCount` stops once
            // `count >= citizenDirectory.Count / limitation`, so at the class default of 0
            // the tree is added to nobody and does nothing, with no error to say why.
            // 20 is a sprinkle -- roughly one citizen in twenty of those that pass A's
            // filter -- which is the scale the one shipped example works at.
            interactionCitizenLimitation: 20,
        },
    },
];

/** The kind a `treeType` names, or undefined for a number that names none of them. */
export const treeKind = (treeType) =>
    TREE_KINDS.find((kind) => kind.treeType === treeType);

/**
 * How the create dialog names a kind in its `<option value>`.
 *
 * The dialog's other three answers are bare type names -- `message`, `block`, `strings` --
 * and a tree is still one of those with a kind attached, rather than six unrelated things.
 * Keeping the type in front means the submit handler splits rather than switching on a
 * list of six values it would have to be kept in step with.
 */
export const treeKindValue = (kind) => `tree:${kind.treeType}`;

/**
 * What the create dialog was answered with: `{ type, treeType }`.
 *
 * `treeType` is null for the three answers that are not trees, and for a `tree:` value
 * naming a kind this does not have -- which nothing on screen can produce, and which
 * leaves the document at the template's own type rather than at some seventh thing.
 */
export function parseNewFileType(value) {
    const [type, kind] = String(value ?? '').split(':');

    // Digits, not `Number(kind)`, which reads "" and " " as 0 -- and so would turn a
    // half-written value into a conversation rather than into nothing.
    if (type !== 'tree' || !/^\d+$/.test(kind ?? '')) return { type, treeType: null };

    return { type, treeType: treeKind(Number(kind)) ? Number(kind) : null };
}

/**
 * Make this tree one of its kind.
 *
 * Applied to a document built from the template, before the GUIDs that make it *this*
 * document are stamped on. A `treeType` naming no kind leaves the tree exactly as it was:
 * the template is a valid tree already, and inventing values for a type nothing here
 * knows would be worse than the class defaults it arrives with.
 *
 * @param tree     a `DDSTreeSave`, modified in place, holding the one message it starts
 *                 with. Returned as well, so it reads as a value where it is used as one.
 * @param treeType a `TreeType` index
 */
export function applyTreeKind(tree, treeType) {
    const kind = treeKind(treeType);
    if (!kind) return tree;

    tree.treeType = kind.treeType;
    applyOverrides(tree, kind.tree ?? {});

    // The placed message, where the kind has something to say about it. A tree always
    // starts with exactly one; guarded anyway, because a caller that has not filled it in
    // yet should get a tree of the right kind rather than an exception.
    if (kind.message && tree.messages?.[0]) applyOverrides(tree.messages[0], kind.message);

    return tree;
}

/**
 * Copy `overrides` onto `target`, one field at a time, recursing into objects.
 *
 * Recursive so that a kind can say what a document's `background` is without restating
 * the colour and the fill beside it. An array or a value replaces rather than merges --
 * `triggers: [0, 4]` is the list, not two entries to add to whatever is there -- and it
 * is cloned on the way in, or every tree made in one session would share the table's own
 * arrays and editing one would edit the next.
 */
function applyOverrides(target, overrides) {
    for (const [field, value] of Object.entries(overrides)) {
        target[field] = isPlainObject(value) && isPlainObject(target[field])
            ? applyOverrides(target[field], value)
            : deepClone(value);
    }

    return target;
}

const isPlainObject = (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The kinds whose trigger point disagrees with §2, for the spec that checks them.
 *
 * Published rather than asserted here: this is the one fact in the table that another
 * module already holds an answer to, and a create-time value outside the list the *view*
 * will filter that dropdown down to is a tree the editor immediately calls invalid.
 */
export const kindsWithAnInvalidTriggerPoint = () => TREE_KINDS.filter((kind) => {
    const allowed = allowedTriggerPoints(kind.treeType);
    return allowed && !allowed.includes(kind.tree?.triggerPoint);
});
