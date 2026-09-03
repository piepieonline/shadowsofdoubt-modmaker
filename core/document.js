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
 * ## Why the whole rebuild happens before the save
 *
 * Reopening the nodes used to come *after* `await save()`, which left the document on
 * screen collapsed for as long as the write took. A write to a real folder is long
 * enough to be painted, and a collapsed document is a few hundred pixels tall however
 * long it really is -- so the browser clamped the scroll position to the top of it, and
 * the author lost their place on every dropdown change.
 *
 * Which document that showed on was a matter of shape rather than of flow. A DDS tree is
 * `messages`, `blocks` and `replacements` expanded, which is to say it is almost entirely
 * the part that collapses; a case file is mostly top-level keys, which survive. The two
 * behaved differently while running the same code, and a case file with an array open in
 * it lost its place exactly as a tree did.
 *
 * So nothing awaits until the tree is whole again: patch, reload, decorate, reopen,
 * `afterRebuild`, put the scroll back, and only then save. The rebuild is one synchronous
 * run and there is no collapsed frame to paint. `afterRebuild` moving with it is a fix in
 * its own right -- it ran outside the old try/finally, so a save that threw left the case
 * flow's default-value marks off a tree that had just been rebuilt without them.
 *
 * Nodes are identified by JSON Pointer. This was `item.pathToItem`, which only the
 * ScriptableObject flow assigns: in the DDS flow every node's was `undefined`, so the
 * list of open paths filled with `undefined`, matched every node in the rebuilt tree,
 * and opened the document in full on every edit.
 *
 * `jsonpatch` is a global published by core/vendorGlobals.js.
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

        // Where in the document the author was. The tree is rendered into the window's
        // container and that is what scrolls -- see core/treeWindow.js.
        //
        // Restoring this is belt to the braces of rebuilding before saving: the setup
        // pass can read layout while the tree is part-built -- select2 measures the
        // control it is initialising -- and a measurement is enough to have the scroll
        // clamped against a document that is still collapsed.
        const scroller = tree.wrapper.parentElement;
        const scrollTop = scroller?.scrollTop ?? 0;

        setData(jsonpatch.applyPatch(getData(), patch).newDocument);

        tree.loadData(getData());
        onRebuild();

        tree.findAndHandle(
            (item) => openPaths.has(getJSONPointer(item)),
            (item) => { item.expand(); }
        );

        // Before the scroll is put back, not after: this is what marks the case flow's
        // default values, and Hide Default Values then takes those rows off the screen.
        // Restoring a position measured against a document that is about to lose rows
        // would leave the author somewhere they had not been.
        if (afterRebuild) afterRebuild();

        if (scroller) scroller.scrollTop = scrollTop;

        // Last, and its failure travels. A save can fail -- a folder no longer writable,
        // a name taken since -- and the author being thrown back to the top of a document
        // is not a useful second thing to happen about it. By here there is nothing left
        // to put back, so there is no longer anything to unwind.
        await save();
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
