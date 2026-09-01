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

        // Reopened whether or not the save worked. A save can fail -- a folder no longer
        // writable, a name taken since -- and the author being thrown back to the top of
        // a document is not a useful second thing to happen about it. The failure still
        // travels; only the place is kept.
        try {
            await save();
        } finally {
            tree.findAndHandle(
                (item) => openPaths.has(getJSONPointer(item)),
                (item) => { item.expand(); }
            );
        }

        if (afterRebuild) afterRebuild();
    };
}

/**
 * Open the keys a document is worth arriving at open on -- once, when it is first shown.
 *
 * Both flows do this, and both used to do it on every rebuild, from inside the setup pass
 * the loop above calls. That is the same pass that puts the controls back, so it ran after
 * every edit: a node the author had *closed* was opened again by the next keystroke, and
 * the snapshot taken a moment earlier -- which had faithfully recorded that it was closed
 * -- was overruled.
 *
 * It only rarely showed in the case flow, whose keys are `fileOrder` and two leftovers a
 * case document seldom holds. In the DDS flow the keys are `messages`, `blocks` and
 * `replacements`, which is the whole of what a tree is: closing one to see past it lasted
 * exactly until the next edit.
 *
 * So the defaults are an opening state rather than something re-asserted. After that,
 * what is open is whatever the author left open.
 *
 * @param labels the keys to open, with their children
 * @returns (tree) => void, to call from the flow's per-node setup. One per open document:
 *          the same document reopened is arrived at afresh.
 */
export function expandDefaultsOnce(labels) {
    let opened = false;

    return function openDefaults(tree) {
        if (opened) return;
        opened = true;

        tree.expand((node) => {
            if (!labels.includes(node.label)) return false;

            // The children too, so an array of objects reads as its contents rather than
            // as a list of braces. A primitive element has nothing to expand.
            node.childNodes.forEach((child) => child.expand !== undefined && child.expand());
            return true;
        });
    };
}
