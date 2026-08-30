/**
 * Moving between flows.
 *
 * Switching lives here rather than in the shell so that a flow can hand off to
 * another: a case file referencing a DDS tree should open that tree, and the two are
 * no longer separate sites to link between.
 *
 * The folders and the chosen content folder are deliberately untouched. A content
 * folder holds a case's files and its DDS text together, so following a reference
 * from one to the other is a change of view, not of what you are working on.
 */
import { activateFlow, getFlow } from './flowRegistry.js';
import { abandonRestore, whileRestoring, writeUrlState } from './urlState.js';

let afterSwitch = null;

/**
 * What each flow had open, so coming back to one puts you where you left off rather
 * than at an empty workspace. Switching unmounts a flow's markup, so this is the only
 * thing that survives.
 *
 * Keyed by the content folder as well: if you change what you are working on while in
 * the other editor, the documents you had open no longer apply.
 *
 * Still in memory rather than in the URL, which holds the active flow's session alone:
 * three sessions in the address bar to save the two you are not looking at is not worth
 * what it does to the length. A reload therefore comes back to the editor you were in,
 * with an empty workspace behind the picker.
 */
const sessions = new Map();

const selectionKey = () =>
    window.selectedMod ? `${window.selectedMod.modName}/${window.selectedMod.contentPath}` : null;

/** The shell supplies what else needs doing once a flow is active. */
export function configureNavigation(hooks) {
    afterSwitch = hooks.afterSwitch;
}

export async function switchFlow(id) {
    if (window.activeFlow?.id === id) return getFlow(id);

    // Startup may still be holding the URL, waiting for a folder before it can put back
    // what a link asked for. Those parameters describe the editor being left, so leaving
    // is the end of that wait however it turns out.
    await abandonRestore();

    const leaving = window.activeFlow;
    if (leaving?.sessionState) {
        sessions.set(leaving.id, { key: selectionKey(), state: await leaving.sessionState() });
    }
    // Reading what a flow has open and tearing it down are separate, because only the
    // second is destructive: the building flow gives up its WebGL context here, and the
    // URL asks for the first of these several times a minute.
    await leaving?.suspend?.();

    // The flow's own parameters go with it. Passing an empty set clears whatever the
    // outgoing flow wrote, so the incoming one cannot read `open` and find someone
    // else's documents in it.
    writeUrlState({ flow: id, params: {} });

    document.documentElement.removeAttribute('data-flow-ready');
    document.getElementById('flow-root')?.setAttribute('aria-busy', 'true');
    document.getElementById('flow-picker').value = id;

    await activateFlow(id);
    const flow = getFlow(id);

    // Before restoring: applying the content folder opens the flow's default view,
    // which would otherwise replace whatever was put back.
    if (afterSwitch) await afterSwitch(flow);

    // Restoring opens documents, and opening a document is what writes the URL, so the
    // write is held until the end -- and then made once, describing what actually came
    // back rather than what was half way there.
    await whileRestoring(async () => {
        const session = sessions.get(id);
        if (session && flow.restoreSession && session.key === selectionKey()) {
            await flow.restoreSession(session.state);
        }
    });

    return flow;
}

/**
 * Switch to a flow and open something in it.
 *
 * The flow decides what `request` means -- see its `openDocument`.
 */
export async function openInFlow(flowId, request) {
    const flow = await switchFlow(flowId);

    if (!flow?.openDocument) {
        throw new Error(`Flow "${flowId}" cannot open documents`);
    }

    await flow.openDocument(request);
}
