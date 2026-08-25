/**
 * The flow registry.
 *
 * A "flow" is one kind of mod content: DDS text, ScriptableObject case files, and
 * whatever comes next. Each flow describes itself with a descriptor and registers it;
 * core dispatches through the descriptor rather than knowing about specific flows.
 *
 * Adding a flow should mean adding a directory under flows/ and one register() call.
 * If it ever requires editing something under core/, the contract has a gap.
 *
 * Descriptor:
 *   id            string, unique, and stable -- it appears in URLs
 *   label         human-readable, for the flow picker
 *   saveStrategy  'fullFile' | 'vanillaPatch'  (see core/persistence.js)
 *   windowPolicy  WindowPolicy.*               (see core/treeWindow.js)
 *   loadRefs      () => Promise -- reference data, loaded on activation rather than
 *                 at page load. The two current flows pull ~3.7 MB of generated JSON
 *                 between them, and a single shell must not make every user download
 *                 all of it to edit one kind of content.
 *   template      optional css selector for a <template> holding the flow's markup.
 *                 Only the active flow is mounted: the flows share element ids, so
 *                 having both in the document would break getElementById.
 *   styles        optional [href] loaded on activation and removed on switch, so one
 *                 flow's rules cannot reach another's markup
 *   treeOptions   optional jsonTree render settings. These were hard-coded differences
 *                 between two forked copies of the library; applied on activation so
 *                 they belong to the flow rather than to whichever page loaded last.
 *   start         optional () => Promise, run once refs and markup are ready
 *   newContent    optional (name) => Promise<scaffold | null>. The header's New
 *                 content button, asking what this flow needs to know before the
 *                 folder exists; answer with a function that lays the folder out, or
 *                 null to cancel. A flow that needs nothing omits it.
 */

const flows = new Map();

export function registerFlow(descriptor) {
    for (const field of ['id', 'label', 'loadRefs']) {
        if (!descriptor?.[field]) {
            throw new Error(`Flow descriptor is missing "${field}"`);
        }
    }
    if (flows.has(descriptor.id)) {
        throw new Error(`Flow "${descriptor.id}" is already registered`);
    }
    flows.set(descriptor.id, descriptor);
    return descriptor;
}

export function getFlow(id) {
    return flows.get(id) ?? null;
}

export function listFlows() {
    return [...flows.values()].map(({ id, label }) => ({ id, label }));
}

/** The flow currently driving the page. */
let active = null;

export function activeFlow() {
    return active;
}

/**
 * Load a flow's reference data and start it. Resolves once the flow is usable, so
 * callers can await it before touching anything that depends on reference data.
 *
 * Reference data now arrives asynchronously, where a static import used to guarantee
 * it before anything else ran. That leaves a window where the page is interactive but
 * the flow is not ready, so readiness is published two ways: this promise, and a
 * data-flow-ready attribute on <html>. Phase 7 should use it to gate the UI -- right
 * now the DDS folder-picker modal happens to cover the gap, and the case flow's
 * spoiler warning does the same, but neither is a guarantee.
 */
export function flowReady() {
    return readyPromise;
}

let readyPromise = null;

/** Where a flow's markup is mounted. Absent on the per-flow pages. */
const flowRoot = () => document.getElementById('flow-root');

/**
 * Swap in the flow's stylesheets, resolving once they have actually loaded.
 *
 * Waiting matters: these are injected rather than in the document, so without it the
 * flow is marked ready while its markup is still unstyled. That shows up as a flash
 * of unstyled content on a slow load, and as intermittently wrong measurements for
 * anything reading computed styles.
 */
function applyStyles(hrefs = []) {
    document.querySelectorAll('link[data-flow-style]').forEach((link) => link.remove());

    return Promise.all(hrefs.map((href) => new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.dataset.flowStyle = '';
        // Resolve either way: a missing stylesheet should not wedge activation.
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', resolve, { once: true });
        document.head.appendChild(link);
    })));
}

function mountTemplate(selector) {
    const root = flowRoot();
    if (!root || !selector) return;

    const template = document.querySelector(selector);
    if (!template) throw new Error(`Flow template "${selector}" not found`);

    root.replaceChildren(template.content.cloneNode(true));
}

export async function activateFlow(id) {
    const flow = getFlow(id);
    if (!flow) throw new Error(`Unknown flow "${id}"`);

    readyPromise = (async () => {
        await applyStyles(flow.styles);
        mountTemplate(flow.template);

        if (flow.treeOptions) jsonTree.configure(flow.treeOptions);

        await flow.loadRefs();
        active = flow;

        // Exposed for tests and for the deep-link handling Phase 7 adds.
        window.activeFlow = flow;

        if (flow.start) await flow.start();

        // Everything the flow needs is in place: markup, styles, reference data.
        flowRoot()?.removeAttribute('aria-busy');
        document.documentElement.dataset.flowReady = flow.id;
        return flow;
    })();

    return readyPromise;
}
