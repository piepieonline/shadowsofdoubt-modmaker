/**
 * Deciding what kind of editor a value node gets.
 *
 * This is the seam between the flows. Both walk every non-complex node in a rendered
 * tree and choose an editor for it, but they decide differently:
 *
 *  - The DDS flow looks the node's label up in a flat table of enums.
 *  - The case flow walks the game's type layout, which can resolve a node to an enum,
 *    a reference to another ScriptableObject, or something not editable at all.
 *
 * Core owns the walk and the dispatch; each flow supplies `resolveNode`, which
 * answers "what is this?", and the renderers for the kinds it can produce. The tree
 * renderer no longer needs to know which flow it is serving, and a third flow only
 * has to answer the same question its own way.
 */

export const NodeKind = {
    /** A fixed set of named values. */
    ENUM: 'enum',
    /** A pointer to another asset. */
    REFERENCE: 'reference',
    /** Displayed but not editable. */
    READ_ONLY: 'readOnly',
    /** Anything else: free text, numbers, booleans. */
    TEXT: 'text',
};

/**
 * @param tree        the jsonTree instance
 * @param resolveNode (item, valueEl) => { kind, ... } | null -- null means TEXT
 * @param render      { [kind]: (valueEl, item, node) => void }
 */
export function decorateValueNodes(tree, { resolveNode, render }) {
    tree.findAndHandle(
        (item) => !item.isComplex,
        (item) => {
            const valueEl = item.el.querySelector('.jsontree_value');
            if (!valueEl) return;

            const node = resolveNode(item, valueEl) ?? { kind: NodeKind.TEXT };

            // Displayed as-is: no editor, no handlers.
            if (node.kind === NodeKind.READ_ONLY) return;

            const renderer = render[node.kind];
            if (!renderer) {
                console.warn(`No renderer for node kind "${node.kind}"`);
                return;
            }

            renderer(valueEl, item, node);
        }
    );
}
