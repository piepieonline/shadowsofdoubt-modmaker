/**
 * What the game's type layout says about the field a tree node shows.
 *
 * `refs/generated/soTypeLayout.json` describes every serialised type the game has --
 * field name to `{ Item1: type, Item2: isArray, Item3: description }`. That is not only
 * ScriptableObject data: a DDS tree is a `DDSTreeSave`, its messages are
 * `DDSMessageSettings`, and its `treeType` is a `TreeType` enum. Both flows read it.
 *
 * This used to be three separate answers to one question. The case flow had
 * `mapSplitPath` for choosing an editor and a second, one-level-deep lookup for the
 * tooltip beside it; the DDS flow had neither, and keyed enums off the field name alone
 * -- which is why an array of enums never resolved, every element being labelled by its
 * index rather than by the field it belongs to.
 */

/**
 * The field names from the document root down to this node.
 *
 * Array indices are dropped, which is the point: `messages[3].msgID` is described by the
 * layout as `messages` -> `DDSMessageSettings` -> `msgID`, and the 3 says nothing about
 * what the field is. Every element of an array resolves through its element type.
 *
 * @param item a jsonTree node
 * @returns e.g. ['messages', 'msgID'] -- empty for the root
 */
export function fieldPath(item) {
    const path = [];

    for (let node = item; node && node.label != null; node = node.parent) {
        const label = node.label.toString();
        // A label that is nothing but digits is an array index.
        if (!/^\d+$/.test(label)) path.unshift(label);
    }

    return path;
}

/**
 * Walk the layout from a root type down a path of field names.
 *
 * @param splitPath [rootTypeName, ...fieldPath(item)]
 * @param typeLayout window.typeLayout
 * @returns `{ ownerType, field, type, isArray, officialDescription }`, or null when the
 *          layout does not describe this path -- an unknown type, a field the game does
 *          not have, or a display-only key the editor added to the document. Callers
 *          treat null as "no idea", never as an error: a document may legitimately hold
 *          fields the reference data has no entry for.
 */
export function resolveField(splitPath, typeLayout) {
    if (!typeLayout || splitPath.length < 2) return null;

    let ownerType = splitPath[0];

    for (let i = 1; i < splitPath.length; i++) {
        const entry = typeLayout[ownerType]?.[splitPath[i]];
        if (!entry) return null;

        if (i === splitPath.length - 1) {
            return {
                ownerType,
                field: splitPath[i],
                type: entry.Item1,
                isArray: Boolean(entry.Item2),
                officialDescription: entry.Item3 || '',
            };
        }

        // Item1 of a non-leaf is the type its children are described by. For an array
        // it is the element type, which is what the dropped index leaves us wanting.
        ownerType = entry.Item1;
    }

    return null;
}

/**
 * The tooltip for a field: what we wrote about it, then what the game says.
 *
 * @param descriptions window.fieldDescriptions -- type name -> field name -> prose
 * @returns the tooltip text, or '' when nothing is known about the field
 */
export function describeField(splitPath, { typeLayout, descriptions }) {
    const resolved = resolveField(splitPath, typeLayout);
    if (!resolved) return '';

    const authored = descriptions?.[resolved.ownerType]?.[resolved.field] || '';
    const official = resolved.officialDescription;

    if (authored && official) return `${authored}\n\nOfficial description: ${official}`;
    if (official) return `Official description: ${official}`;
    return authored;
}
