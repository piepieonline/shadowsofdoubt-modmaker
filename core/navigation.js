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

let afterSwitch = null;

/**
 * What each flow had open, so coming back to one puts you where you left off rather
 * than at an empty workspace. Switching unmounts a flow's markup, so this is the only
 * thing that survives.
 *
 * Keyed by the content folder as well: if you change what you are working on while in
 * the other editor, the documents you had open no longer apply.
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

    const leaving = window.activeFlow;
    if (leaving?.captureSession) {
        sessions.set(leaving.id, { key: selectionKey(), state: await leaving.captureSession() });
    }

    const params = new URLSearchParams(location.search);
    params.set('flow', id);
    history.replaceState(null, '', `?${params}`);

    document.documentElement.removeAttribute('data-flow-ready');
    document.getElementById('flow-root')?.setAttribute('aria-busy', 'true');
    document.getElementById('flow-picker').value = id;

    await activateFlow(id);
    const flow = getFlow(id);

    // Before restoring: applying the content folder opens the flow's default view,
    // which would otherwise replace whatever was put back.
    if (afterSwitch) await afterSwitch(flow);

    const session = sessions.get(id);
    if (session && flow.restoreSession && session.key === selectionKey()) {
        await flow.restoreSession(session.state);
    }

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
