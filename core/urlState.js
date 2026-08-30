/**
 * What you are working on, kept in the URL.
 *
 * The editor, the mod and content folder, and what is open in that editor. All of it
 * used to live in memory alone, so a refresh -- which is cheap to trigger by accident --
 * put you back in an empty workspace with nothing selected. It also means a URL is a
 * link to a piece of work rather than to the app in general.
 *
 * Core owns `flow`, `mod` and `content`; `demo` belongs to demo mode. Every other
 * parameter belongs to the active flow, which names its own -- see `sessionState` in
 * each flows/<id>/flow.js. Core neither reads nor understands those, beyond writing them
 * out and handing them back.
 *
 * `history.replaceState` throughout, never pushState: the URL states where you are, and
 * Back is not repurposed as an undo of navigation.
 *
 * The pure half of this module -- parse, merge, encode -- is separated from the half
 * that touches `location` and `history` because the unit suite runs under `node`, where
 * neither exists.
 */
import { onWindowsChanged } from './treeWindow.js';

/** Parameter names core owns. A flow may not use these for its own state. */
export const CORE_PARAMS = ['flow', 'mod', 'content', 'demo'];

/**
 * Longest query we will write.
 *
 * Browsers accept far more than this, but a URL that has to be scrolled to read is not
 * the readable link this exists to produce. Past it, the flow's own parameters are
 * dropped and the selection is kept: which mod you were in matters more than which
 * documents were open, and open documents are the part that grows without bound.
 */
export const MAX_QUERY_LENGTH = 1800;

/** How long a burst of changes is allowed to settle before one write. */
const SYNC_DELAY = 250;

/**
 * Read a query string as core's parameters plus the flow's.
 *
 * `content` is deliberately kept when empty: a content folder at the mod root has an
 * empty path, so '' is a selection and absent is not. See core/modSelection.js.
 */
export function parseState(search) {
    const query = new URLSearchParams(search);
    const params = {};

    for (const [key, value] of query) {
        if (!CORE_PARAMS.includes(key)) params[key] = value;
    }

    return {
        flow: query.get('flow'),
        mod: query.get('mod'),
        content: query.get('content'),
        params,
    };
}

/**
 * The query string that results from applying `state` to `search`.
 *
 * Only the fields present in `state` are touched, so a caller changing the selection
 * need not know what the flow put in the URL. `clearKeys` names the flow parameters the
 * previous state wrote, which are removed before the new ones go in -- otherwise
 * switching flows would leave the last one's parameters behind for the next one to
 * misread as its own.
 *
 * A null or empty value removes a parameter rather than writing it empty, except for
 * `content`, which is meaningful when empty.
 */
export function buildSearch(search, { flow, mod, content, params, clearKeys = [] } = {}) {
    const query = new URLSearchParams(search);

    const put = (key, value, keepEmpty = false) => {
        if (value === null || value === undefined || (value === '' && !keepEmpty)) {
            query.delete(key);
        } else {
            query.set(key, value);
        }
    };

    if (flow !== undefined) put('flow', flow);

    if (mod !== undefined) {
        put('mod', mod);
        // The content folder is a path within the mod, so it cannot outlive it.
        if (!mod) query.delete('content');
    }

    // Only alongside a mod: a content path on its own names nothing.
    if (content !== undefined && query.get('mod')) put('content', content, true);

    if (params) {
        for (const key of clearKeys) query.delete(key);
        for (const [key, value] of Object.entries(params)) {
            if (CORE_PARAMS.includes(key)) {
                throw new Error(`Flow parameter "${key}" collides with a core parameter`);
            }
            put(key, value);
        }
    }

    const full = query.toString();
    if (full.length <= MAX_QUERY_LENGTH) return full;

    // Too long: keep the selection, drop what the flow asked for.
    const trimmed = new URLSearchParams(full);
    for (const key of [...trimmed.keys()]) {
        if (!CORE_PARAMS.includes(key)) trimmed.delete(key);
    }
    return trimmed.toString();
}

/**
 * A list of strings as one parameter, and back.
 *
 * JSON rather than a separator so that a comma or a quote in a filename cannot corrupt
 * the list, and readable in the address bar either way. Decoding is tolerant: a
 * hand-edited or truncated value should leave you with nothing open, not an exception
 * during startup.
 */
export const encodeList = (values) => (values?.length ? JSON.stringify(values) : null);

export function decodeList(value) {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
    } catch {
        return [];
    }
}

/* -------------------------------------------------------------------------- */
/* The half that touches the address bar                                       */
/* -------------------------------------------------------------------------- */

/**
 * The flow parameters currently in the URL.
 *
 * Seeded from the URL on the first read rather than starting empty: at startup the
 * query holds the parameters of the flow that was active when the page was last
 * written, and those have to be cleared when the active flow's own are written or when
 * another flow takes over.
 */
let flowKeys = [];

/**
 * Whether state is being put back, during which nothing may write.
 *
 * Restoring opens documents, and opening a document is exactly what triggers a write.
 * Without this, restoring the first of three documents would rewrite the URL as "one
 * document open" and the other two would be lost before they were read.
 */
let restoring = false;

let timer = null;

/**
 * Follow what is open.
 *
 * Both document flows open and close their windows through core/treeWindow.js, so one
 * subscription covers every way a document can be opened -- the panel, a manifest
 * entry, a reference followed from another document, the close button -- without either
 * flow knowing the URL exists. The building flow has no windows and says so itself.
 */
export function initUrlState() {
    onWindowsChanged(scheduleSync);
}

/** The state the URL is asking for. */
export function readUrlState() {
    const state = parseState(location.search);
    flowKeys = Object.keys(state.params);
    return state;
}

/** Apply a change to the URL, leaving everything it does not mention alone. */
export function writeUrlState(state) {
    if (restoring) return;

    const search = buildSearch(location.search, { ...state, clearKeys: flowKeys });

    // Nothing has changed, so there is nothing to write. Worth the comparison: the
    // triggers are deliberately coarse -- every panel edit in the building flow asks --
    // and most of what they report leaves the URL exactly as it was.
    if (search === location.search.replace(/^\?/, '')) return;

    if (state.params) {
        // What was actually written, so the next write clears exactly these. Read back
        // from the query rather than from `params`, since the length guard may have
        // dropped them and an empty value is not written at all.
        const written = new URLSearchParams(search);
        flowKeys = [...written.keys()].filter((key) => !CORE_PARAMS.includes(key));
    }

    history.replaceState(null, '', search ? `?${search}` : location.pathname);
}

/**
 * Write the whole of the current state: the selection, and what the active flow has
 * open.
 *
 * Everything that changes any of it calls this (or `scheduleSync`) rather than
 * composing a write of its own, so there is one description of the state and it cannot
 * disagree with itself. It is also what corrects the URL after a restore that could not
 * find everything it named.
 */
export async function syncNow() {
    if (restoring) return;

    const params = (await window.activeFlow?.sessionState?.()) ?? {};

    writeUrlState({
        mod: window.selectedMod?.modName ?? null,
        content: window.selectedMod?.contentPath ?? null,
        params,
    });
}

/**
 * Write soon, once things have stopped changing.
 *
 * Opening one document closes others, rebuilds panels and can cascade into further
 * opens, so the sync triggers fire in bursts. One write per burst.
 */
export function scheduleSync() {
    if (restoring) return;
    clearTimeout(timer);
    timer = setTimeout(() => { syncNow(); }, SYNC_DELAY);
}

/**
 * Stop writing to the URL, because what is in it is about to be put back.
 *
 * What is being restored is read from the URL, so anything writing to it mid-restore is
 * overwriting its own source -- and at startup that is not hypothetical: connecting a
 * folder rebuilds the mod list, which publishes "nothing selected" and would have the
 * URL describing an empty workspace within a quarter of a second of arriving at a link.
 *
 * Held open across a wait, too. A restore can be waiting on a folder the user has yet to
 * grant, and a link whose state is erased while its own permission prompt is on screen
 * is a link that only works if answered quickly.
 */
export function beginRestore(onAbandon = null) {
    restoring = true;
    abandon = onAbandon;
}

/**
 * Told when a restore that had not run yet is given up on.
 *
 * Startup holds the URL from the moment the page loads until what it asked for is back,
 * which can mean holding it across a folder prompt. Two things can happen in the
 * meantime that mean the wait is over: the author switches editor, in which case the
 * parameters belong to an editor they have left, or chooses a mod themselves, in which
 * case what they chose is what the URL should say.
 */
let abandon = null;

export async function abandonRestore() {
    if (!restoring) return;

    const notify = abandon;
    await endRestore({ sync: false });
    notify?.();
}

/**
 * Start writing again.
 *
 * `sync` writes once, describing what actually came back: state naming a file that has
 * since been deleted corrects itself here rather than staying in the URL forever.
 */
export async function endRestore({ sync = true } = {}) {
    restoring = false;
    abandon = null;
    // Anything that asked to be written while the hold was on was describing the page
    // mid-restore, which is not a state worth recording.
    clearTimeout(timer);
    if (sync) await syncNow();
}

/** Restore, with writing held off for exactly as long as it takes. */
export async function whileRestoring(work) {
    beginRestore();
    try {
        await work();
    } finally {
        await endRestore();
    }
}
