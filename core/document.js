/**
 * The edit loop shared by both flows.
 *
 * Editing anything rebuilds the whole tree: apply a JSON Patch, reload the renderer,
 * re-run the flow's setup, save. Rebuilding collapses everything, so which nodes were
 * open has to be snapshotted and restored around it -- otherwise a one-character edit
 * deep in a file throws the user back to the top.
 *
 * Only the ScriptableObject flow did that restoration; the DDS flow's
 * modifyTreeElement did not, and lost your place on every keystroke. Both use this now.
 *
 * Nodes are identified by JSON Pointer. This was `item.pathToItem`, which only the
 * ScriptableObject flow assigns: in the DDS flow every node's was `undefined`, so the
 * list of open paths filled with `undefined`, matched every node in the rebuilt tree,
 * and opened the document in full on every edit.
 *
 * `jsonpatch` is a global from libs/JSON-Patch, loaded as a classic script.
 */
import { getJSONPointer } from './jsonPointer.js';

/**
 * Build the `applyPatch` function for one open document.
 *
 * @param tree      the jsonTree instance rendering this document
 * @param getData   returns the current document
 * @param setData   stores the patched document
 * @param onRebuild re-runs the flow's per-node setup after the tree reloads
 * @param save      persists the document
 * @param afterRebuild optional extra work once nodes are reopened
 */
export function createEditLoop({ tree, getData, setData, onRebuild, save, afterRebuild }) {
    return async function applyPatch(patch) {
        const openPaths = new Set();
        tree.findAndHandle(
            (item) => item.el.classList.contains('jsontree_node_expanded'),
            (item) => { openPaths.add(getJSONPointer(item)); }
        );

        setData(jsonpatch.applyPatch(getData(), patch).newDocument);

        tree.loadData(getData());
        onRebuild();

        await save();

        tree.findAndHandle(
            (item) => openPaths.has(getJSONPointer(item)),
            (item) => { item.expand(); }
        );

        if (afterRebuild) afterRebuild();
    };
}
