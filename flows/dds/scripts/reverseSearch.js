/**
 * Where a line of block text is said.
 *
 * The generated index maps a document to the documents that hold it: a replacement to
 * its blocks, a block to its messages, a message to its trees. Walking it upwards from
 * the GUID a line is stored against gives every place that line is reached from.
 *
 * Answered as whole chains rather than as a set of trees, because a list of trees cannot
 * say which message under a tree is the one that holds the block -- and opening the tree
 * on its own leaves that to the cascade, which takes the first message and the first
 * block and so lands on the searched line only by luck. Nearly every line is said in one
 * place; a handful are said in a couple of dozen.
 */

/** The levels of the drill-down, outermost first. */
export const LEVELS = ['tree', 'message', 'block'];

/**
 * Every chain from a root down to `id`, root first, with `id` itself as the last step.
 *
 * @param reverseIdMap document GUID -> the GUIDs of the documents holding it
 */
export function ancestryPaths(reverseIdMap, id, seen = new Set()) {
    // The same parent is listed once per time it holds the child -- a tree that plays a
    // message twice holds it twice -- and that is one place to open, not two.
    const parents = [...new Set(reverseIdMap?.[id] ?? [])];

    // A document nothing holds is a chain of one. So is one already on this chain: the
    // index is generated from what the game ships rather than promised to be acyclic,
    // and a cycle walked a second time does not terminate.
    if (parents.length === 0 || seen.has(id)) return [[id]];

    const visited = new Set(seen).add(id);

    return parents.flatMap((parent) =>
        ancestryPaths(reverseIdMap, parent, visited).map((path) => [...path, id]));
}

/**
 * The drill-downs that reach `id`: which document opens at which level.
 *
 * A chain can be one step longer than the drill-down is deep -- a searched line is often
 * a replacement, which is a field of a block rather than a document of its own -- so each
 * step is placed by what it *is* rather than by where it sits in the chain. `typeOf` is
 * the reference data's answer, and a step it cannot place is not a level.
 *
 * @param typeOf GUID -> 'tree' | 'message' | 'block' | null
 */
export function occurrences(reverseIdMap, typeOf, id) {
    const found = new Map();

    for (const path of ancestryPaths(reverseIdMap, id)) {
        const levels = {};
        for (const step of path) {
            const type = typeOf(step);
            // First wins: a chain is walked from its root down, so the shallowest
            // document of a kind is the one that level opens.
            if (type && !levels[type]) levels[type] = step;
        }

        // A chain of steps the reference data cannot place is not somewhere the line is
        // said: it is a GUID the index has and the index alone knows anything about.
        if (Object.keys(levels).length === 0) continue;

        // Two chains can describe the same documents -- one running through a step the
        // reference data cannot place -- and that is one row, not two.
        found.set(LEVELS.map((level) => levels[level]).join('/'), levels);
    }

    return [...found.values()];
}

/** The documents one occurrence opens, outermost first. */
export function chain(levels) {
    return LEVELS.map((level) => levels[level]).filter(Boolean);
}
