/**
 * What a new element of a DDS array is.
 *
 * This used to be a table keyed by the array's *name*, and every entry in it asked a
 * question: `prompt('Trait name')`, `prompt('Job name')`, `prompt('Trigger index')`, a
 * GUID for a message or a block. The case flow has never done that -- it appends the
 * element the game's type layout describes and lets it be edited in the tree, which is
 * where every other value in a document is edited. A dialog that has to be answered
 * before the element exists is a second editor for the same act, and one that cannot show
 * the dropdown the value is going to get a moment later: `triggers` asked for an index
 * into an enum whose names were on screen either side of the prompt.
 *
 * So the shape comes from the layout here too. `refs/generated/soTypeLayout.json`
 * describes DDS documents like any other game type -- a tree's `messages` are
 * `DDSMessageSettings`, a participant's `triggers` are `TreeTriggers` -- so an element is
 * built from the element *type* rather than recognised by the field's name. Arrays the
 * old table had no entry for get a + for the first time as a result: `itemPool` and
 * `messageRef` on a tree, `events` on a message, `followupStories` on a newspaper.
 *
 * What the layout cannot say stays out of here. A new message points at a *document*,
 * which has to be written into the mod's folder, and a new replacement needs a row in the
 * strings CSV; both are side effects on the filesystem rather than facts about a type.
 * See ELEMENT_DOCUMENTS in ../index.js.
 */
import { deepClone } from '../../../core/files.js';
import { resolveField } from '../../../core/typeHints.js';

/**
 * Where an authored template says more than the layout can.
 *
 * A message carries a font, a size, a colour and a position; a link carries a delay
 * interval. The layout knows those fields are there and nothing about what they should
 * hold, and a message rendered at 0pt in transparent black in the corner of the document
 * is one an author has to repair before they can read it. `refs/authored/ddsTemplates.json`
 * holds the values the game's own content uses.
 *
 * Only these four. Every other DDS type is fields the layout describes fully, and a
 * template for one would be a second place for it to be wrong.
 */
const AUTHORED_TEMPLATES = {
    DDSMessageSettings: 'treeMessage',
    DDSMessageLink: 'treeMessageLinks',
    DDSBlockCondition: 'messageBlock',
    DDSReplacement: 'blockReplacement',
};

/**
 * Fields the game keeps at runtime and never writes to a file.
 *
 * `refs/generated/soTypeLayout.json` lists the fields a type declares, and it does not
 * skip the ones marked `[NonSerialized]` -- so a tree appears to have a `messageRef` list
 * of strings and a `citizenAddCount`, and the + on the first of those would have written
 * a field into a document that the game reads nothing from. `DDSTreeSave.messageRef` is a
 * `Dictionary` the game builds after loading, and neither field appears in any of the base
 * game's own trees.
 *
 * Named here rather than patched into the layout, which the generator rewrites whole. See
 * the note on the layout in refs/README.md.
 */
const NOT_WRITTEN_TO_A_FILE = new Set([
    'DDSTreeSave.messageRef',
    'DDSTreeSave.citizenAddCount',
]);

/** Whether a resolved field is one the game would ever put in a document. */
export function isSerialisedField(resolved) {
    return Boolean(resolved)
        && !NOT_WRITTEN_TO_A_FILE.has(`${resolved.ownerType}.${resolved.field}`);
}

/**
 * The type of an array's elements, or null where the layout does not describe one.
 *
 * Null for a field the layout has never heard of -- a document may hold one, and the
 * display-only keys this editor adds are not fields at all -- for a field it knows as a
 * single value rather than a list, and for one the game never writes. None of those is an
 * error: it is the answer "nothing here can be built", which is what leaves the + off.
 *
 * @param splitPath [rootTypeName, ...fieldPath(item)], as core/typeHints.js takes
 */
export function elementTypeAt(splitPath, typeLayout) {
    const resolved = resolveField(splitPath, typeLayout);
    if (!isSerialisedField(resolved)) return null;

    return resolved.isArray ? resolved.type : null;
}

/**
 * A new value of `type`, or null when nothing here knows how to make one.
 *
 * @param refs `{ typeLayout, enums, templates, basicTypeTemplates }` -- the flow's
 *             globals, passed in rather than read off window so this is testable and so
 *             it cannot quietly work against a half-loaded page
 */
export function newElement(type, refs) {
    const authored = AUTHORED_TEMPLATES[type];
    const template = authored ? refs.templates?.[authored] : undefined;

    return template ? deepClone(template) : buildValue(type, refs, new Set());
}

/**
 * Whether an element of `type` can be made at all, which is whether the + is offered.
 *
 * The same question `newElement` answers, asked the same way rather than by a second rule
 * that could disagree with it: a + that is offered and then does nothing is worse than no
 * + at all.
 */
export function canBuildElement(type, refs) {
    return type != null && newElement(type, refs) !== null;
}

/**
 * Build a value from what the layout says the type holds.
 *
 * @param seen the types being built above this one, so a type that contains itself ends
 *             rather than recurring for ever. Only a *field* can do that; an array field
 *             is an empty list and stops there.
 */
function buildValue(type, refs, seen) {
    // Before the enums, and the one place these two tables are read in this order: a DDS
    // document stores a boolean as `true`, where a case document stores every enum as its
    // index and a Boolean is an enum of ['false', 'true']. Writing 0 into `useTraits`
    // here would be a document the game reads as neither.
    if (type === 'Boolean') return false;

    // Every other enum is stored as its index, and 0 is the first name in the dropdown
    // the field is about to be edited through.
    if (refs.enums?.[type]?.length > 0) return 0;

    const basic = refs.basicTypeTemplates?.[type];
    if (basic !== undefined) return deepClone(basic);

    const layout = refs.typeLayout?.[type];
    if (!layout || seen.has(type)) return null;

    const value = {};
    for (const [field, entry] of Object.entries(layout)) {
        // Runtime state, not content. Writing one would be a field in the document that
        // the game overwrites the moment it loads it.
        if (NOT_WRITTEN_TO_A_FILE.has(`${type}.${field}`)) continue;

        // An array starts empty, whatever it is an array of. That is also what keeps a
        // self-referencing type finite -- a newspaper article's followupStories are
        // articles -- so the type is never entered on account of one.
        if (entry.Item2) {
            value[field] = [];
            continue;
        }

        const child = buildValue(entry.Item1, refs, new Set([...seen, type]));

        // A field nothing can make a value of makes the whole element unbuildable. The
        // alternative is a document with a hole in it, written to a mod's folder and read
        // by the game as whatever a missing field defaults to.
        if (child === null) return null;

        value[field] = child;
    }

    return value;
}
