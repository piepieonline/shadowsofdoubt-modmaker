/**
 * What a tree of each kind is actually made of.
 *
 * `DDSTreeSave` has 23 fields and `DDSMessageSettings` has 22, and no kind of tree reads
 * more than about half of either. The six kinds are barely the same format: a document is
 * a page with elements placed on it, a conversation is two citizens and a branch graph, a
 * misc tree is a bag of messages other systems pull by ID. The editor used to show all of
 * it for all of them, so an author writing a note on a scrap of paper was asked which
 * citizen says it, how often it may repeat, and how likely it is to fire.
 *
 * So each field is classified per `treeType`, and the ones that kind never reads come off
 * the screen. What is left is what the game will actually consult.
 *
 * ## Where this comes from
 *
 * `ddsCategories.md` §3, which is a field-by-field read of the decompiled source --
 * `Human.cs`, `WindowContentController.cs`, `NewspaperController.cs`, `DDSControls.cs` --
 * cross-checked against the 500 shipped trees. The table below is that table, in its own
 * symbols, so the two can be compared by eye.
 *
 * The source reading is what decides, not the shipped data. Four rows are set all over the
 * shipped files and hidden here anyway: `order` (386 of 472 conversation messages),
 * `ignoreGlobalRepeat` (107 of 218 documents), and both newspaper fields (149 of 218
 * documents). Nothing reads them there. A number in a field the game never consults is
 * exactly what this is for -- it looks like a setting and is not one.
 *
 * ## What this does not do
 *
 * Nothing here changes a document. It answers a question about a field; the caller marks
 * a row with the answer, and a stylesheet takes the row off the screen. A hidden field's
 * value is read in and written out untouched, so a tree opened in a view and saved is the
 * same bytes as one saved with the view switched off.
 */

/** `<owner type>.<field>`, as `scripts/instances.js` keys its tables. */
const key = (resolved) => `${resolved.ownerType}.${resolved.field}`;

export const Relevance = {
    /** Read for this kind of tree, and worth an author's attention. */
    PRIMARY: 'primary',
    /** Read, but rarely the point. Shown. */
    MINOR: 'minor',
    /** Never read for this kind of tree. Hidden. */
    HIDDEN: 'hidden',
};

/** `DDSSaveClasses.TreeType`, for the places that need to name one. */
export const TreeType = {
    CONVERSATION: 0,
    VMAIL: 1,
    DOCUMENT: 2,
    NEWSPAPER: 3,
    MISC: 4,
    INTERACTION_DIALOG: 5,
};

/** How many kinds of tree there are. */
const TREE_TYPES = Object.keys(TreeType).length;

const SYMBOLS = { '●': Relevance.PRIMARY, '○': Relevance.MINOR, '–': Relevance.HIDDEN };

/**
 * One row of the table: six symbols, one per `treeType`, in the game's enum order.
 *
 * Spread rather than split, because these are not one byte each.
 */
function row(symbols) {
    const cells = [...symbols].filter((symbol) => symbol in SYMBOLS).map((symbol) => SYMBOLS[symbol]);

    // A row that does not describe every kind of tree would answer some of them
    // `undefined`, which reads as "not hidden" and so silently shows the field. Better to
    // fail at load, where the table is in front of whoever broke it.
    if (cells.length !== TREE_TYPES) {
        throw new Error(`A view row needs ${TREE_TYPES} cells, not ${cells.length}: ${symbols}`);
    }

    return cells;
}

/**
 * The fields that depend on what kind of tree they are in.
 *
 * Only rows with something to hide are listed. A field every kind reads -- `name`, `id`,
 * `treeType`, `messages`, `msgID`, a link's `from` and `to` -- is left out, because the
 * default for anything unlisted is PRIMARY. That default is the important half of this:
 * a field nobody has classified, or one a future game update adds, stays on the screen.
 * The view can only ever be wrong in the direction of showing too much.
 */
const MATRIX = {
    //                                            convo vmail  doc  news  misc  iDlg
    'DDSTreeSave.triggerPoint':               row('  ●    ●    –    ●    –    ●  '),
    'DDSTreeSave.participantA':               row('  ●    ●    –    ○    –    ●  '),
    'DDSTreeSave.participantB':               row('  ●    ●    –    –    –    –  '),
    'DDSTreeSave.participantC':               row('  ●    ●    –    –    –    –  '),
    'DDSTreeSave.participantD':               row('  ●    ●    –    –    –    –  '),
    'DDSTreeSave.repeat':                     row('  ●    ●    –    –    –    –  '),
    'DDSTreeSave.ignoreGlobalRepeat':         row('  ●    –    –    –    –    –  '),
    'DDSTreeSave.treeChance':                 row('  ●    ●    –    –    –    –  '),
    'DDSTreeSave.priority':                   row('  ●    ○    –    –    –    –  '),
    'DDSTreeSave.stopMovement':               row('  ●    –    –    –    –    –  '),
    'DDSTreeSave.startingMessage':            row('  ●    ●    –    ●    –    ●  '),
    // The page itself. For every other kind `background` is "" and the whole sub-object
    // is inert, so the section goes rather than its contents.
    'DDSTreeSave.document':                   row('  –    –    ●    –    –    –  '),
    'DDSTreeSave.newspaperCategory':          row('  –    –    –    ●    –    –  '),
    'DDSTreeSave.newspaperContext':           row('  –    –    –    ●    –    –  '),
    'DDSTreeSave.itemPool':                   row('  –    –    –    –    –    ●  '),
    'DDSTreeSave.interactionCitizenLimitation': row('–    –    –    –    –    ●  '),
    'DDSTreeSave.interactionOnePerCity':      row('  –    –    –    –    –    ●  '),

    // Which participant's inbox to keep the thread out of, so a spam or no-reply sender
    // does not get a copy of what it sent. There are no inboxes outside vmail.
    'DDSParticipant.disableInbox':            row('  –    ●    –    –    –    –  '),

    // A placed message. Half of these fields exist on the shared settings struct only
    // because a document needs them -- a conversation has no paper, so no background,
    // size, font, colour or alignment.
    'DDSMessageSettings.elementName':         row('  –    –    ●    –    –    –  '),
    'DDSMessageSettings.saidBy':              row('  ●    ●    –    –    –    –  '),
    'DDSMessageSettings.saidTo':              row('  ●    ●    –    –    –    –  '),
    'DDSMessageSettings.links':               row('  ●    ●    –    –    –    ●  '),
    'DDSMessageSettings.size':                row('  –    –    ●    –    –    –  '),
    'DDSMessageSettings.rot':                 row('  –    –    ●    –    –    –  '),
    'DDSMessageSettings.col':                 row('  –    –    ●    –    –    –  '),
    'DDSMessageSettings.font':                row('  –    –    ●    –    –    –  '),
    'DDSMessageSettings.fontSize':            row('  –    –    ●    –    –    –  '),
    'DDSMessageSettings.charSpace':           row('  –    –    ●    –    –    –  '),
    'DDSMessageSettings.wordSpace':           row('  –    –    ●    –    –    –  '),
    'DDSMessageSettings.lineSpace':           row('  –    –    ●    –    –    –  '),
    'DDSMessageSettings.paraSpace':           row('  –    –    ●    –    –    –  '),
    'DDSMessageSettings.alignH':              row('  –    –    ●    –    –    –  '),
    'DDSMessageSettings.alignV':              row('  –    –    ●    –    –    –  '),
    'DDSMessageSettings.usePages':            row('  –    –    ●    –    –    –  '),
    'DDSMessageSettings.isHandwriting':       row('  –    –    ●    –    –    –  '),
    // Draw order on the page. Sorted ascending and instantiated in sequence, so a higher
    // number draws on top. Nothing outside a document sorts by it -- the 386 conversation
    // messages carrying one are carrying a number that is never read.
    'DDSMessageSettings.order':               row('  –    –    ●    –    –    –  '),

    // A branch edge. `from` and `to` are the edge; everything else is a bonus applied
    // when the game ranks the edges leaving a message, and only two kinds of tree rank
    // anything. See §5 -- `Human.GetConversationTreeLinkRankings`.
    'DDSMessageLink.delayInterval':           row('  ●    –    –    –    –    –  '),
    'DDSMessageLink.useWeights':              row('  ●    –    –    –    –    ●  '),
    'DDSMessageLink.choiceWeight':            row('  ●    –    –    –    –    ●  '),
    'DDSMessageLink.useKnowLike':             row('  ●    –    –    –    –    –  '),
    'DDSMessageLink.know':                    row('  ●    –    –    –    –    –  '),
    'DDSMessageLink.like':                    row('  ●    –    –    –    –    –  '),
    'DDSMessageLink.useTraits':               row('  ●    –    –    –    –    ●  '),
    'DDSMessageLink.traits':                  row('  ●    –    –    –    –    ●  '),
    'DDSMessageLink.traitConditions':         row('  ●    –    –    –    –    ●  '),
    // Absent from the JSON of every non-interactionDialog tree, because they postdate
    // those files.
    'DDSMessageLink.isDialogSuccess':         row('  –    –    –    –    –    ●  '),
    'DDSMessageLink.secondaryBranchTrigger':  row('  –    –    –    –    –    ●  '),
    'DDSMessageLink.dialogSuccessModifier':   row('  –    –    –    –    –    ●  '),

    // The message document, one level down the drill-down. Both of these become part of
    // the dialog option an interactionDialog generates onto a citizen.
    'DDSMessageSave.baseSuccessChance':       row('  –    –    –    –    –    ●  '),
    'DDSMessageSave.events':                  row('  –    –    –    –    –    ●  '),
};

/**
 * Hidden whatever kind of tree it is in.
 *
 * `fontStyle` is serialised and never applied -- `ConstructContent` does not read it, and
 * the eight shipped non-zero values do nothing. The other two are `[NonSerialized]`
 * runtime state that should not be in a file at all; a tree that has them is showing the
 * author something the game put there and will overwrite.
 */
const ALWAYS_HIDDEN = new Set([
    'DDSMessageSettings.fontStyle',
    'DDSTreeSave.messageRef',
    'DDSTreeSave.citizenAddCount',
]);

/**
 * Which trigger points each kind of tree may have -- `ddsCategories.md` §2.
 *
 * `treeType` and `triggerPoint` are coupled: the pairs below are the only ones that occur
 * in the shipped data, and each is the pair the dispatching code actually looks for. A
 * newspaper tree set to `never` is filtered out of every article query and is silently
 * dead, which is what four shipped trees are.
 *
 * A document's trigger point is hidden rather than restricted -- documents never trigger,
 * and all 218 leave it at `onNewTrackTarget` -- so the entry here is only what a document
 * would offer if the field were ever shown.
 *
 * Values are `TriggerPoint` indices.
 */
const TRIGGER_POINTS = [
    [0, 2, 4, 5],   // conversation: onNewTrackTarget, whileTickOnTrackTarget, telephone, never
    [3, 5],         // vmail: vmail, never
    [0],            // document: ignored, never dispatched
    [5, 6],         // newspaper: never, newspaperArticle
    [5],            // misc: never -- a library, not something that runs
    [7],            // interactionDialog: onGameStart
];

/**
 * The two halves of the table, by key, for the spec that checks them.
 *
 * Every key has to name a field the game really has: one that does not is a row that
 * silently never matches, which looks exactly like a field nobody classified. Published
 * as `assetFields.js` publishes `ASSET_TYPES_NAMED`, for the same reason.
 */
export const VIEW_DEPENDENT_FIELDS = Object.keys(MATRIX);
export const ALWAYS_HIDDEN_FIELDS = [...ALWAYS_HIDDEN];

/** Whether a document's `treeType` names one of the six kinds. */
export function isViewType(treeType) {
    return Number.isInteger(treeType) && treeType >= 0 && treeType < TREE_TYPES;
}

/**
 * What this field is worth in a tree of this kind.
 *
 * @param resolved a `core/typeHints.js` resolution, or null for a node the game's layout
 *                 does not describe -- the `_ENG Localisation_` row the editor adds, or
 *                 the document root. Those are shown: not knowing what a field is has
 *                 never been a reason to take it off the screen.
 * @param treeType the kind of tree being shown, or null when there is nothing to go on --
 *                 a message opened straight from the panel rather than under a tree. With
 *                 no view, everything is primary.
 */
export function relevanceOf(resolved, treeType) {
    if (!resolved) return Relevance.PRIMARY;

    const field = key(resolved);
    if (ALWAYS_HIDDEN.has(field)) return Relevance.HIDDEN;

    if (!isViewType(treeType)) return Relevance.PRIMARY;

    return MATRIX[field]?.[treeType] ?? Relevance.PRIMARY;
}

/**
 * The trigger points a tree of this kind may have, or null to offer all of them.
 *
 * Null rather than the full list, so the caller can tell "every value is valid here" from
 * "this kind happens to allow every value" -- only the first means the control should not
 * be filtered at all.
 */
export function allowedTriggerPoints(treeType) {
    return isViewType(treeType) ? TRIGGER_POINTS[treeType] : null;
}

/**
 * Narrow a dropdown to the values that mean something in this kind of tree, or null to
 * leave it alone.
 *
 * `triggerPoint` is the only field coupled to `treeType` this way, and it is worth the
 * coupling: the eight `TriggerPoint` values are eight different subsystems, and six of
 * them will never look at any given tree. A vmail set to `newspaperArticle` is not an
 * unusual vmail, it is a vmail that never sends.
 *
 * Which field is coupled to what lives here rather than at the call site, so the whole of
 * §2 is in one module with §3.
 *
 * @returns (optionIndex) => boolean, for `createSelectEditor`'s `include`
 */
export function optionFilterFor(resolved, treeType) {
    if (!resolved || key(resolved) !== 'DDSTreeSave.triggerPoint') return null;

    const allowed = allowedTriggerPoints(treeType);
    return allowed ? (index) => allowed.includes(index) : null;
}
