/**
 * The container a rendered document lives in, and its editor bar.
 *
 * Both flows share the chrome now that both render with PicoCSS. What they do not
 * share is *window lifecycle*, and that difference is real rather than incidental:
 *
 *  - The DDS flow's three windows are levels of a drill-down (tree -> message ->
 *    block). Opening a level closes it and everything below, because what is below
 *    only exists as a consequence of what is above.
 *  - The case flow's windows are independent documents keyed by path. Reopening one
 *    that is already open is a no-op, and each closes on its own.
 *
 * Each flow states which it wants via `windowPolicy`, rather than encoding it in
 * where the code happens to live.
 */
import { fastDiv } from './dom.js';

export const WindowPolicy = {
    /** Levels of a drill-down. Opening one closes it and every level below it. */
    DRILLDOWN: 'drilldown',
    /** Independent documents. Opening one that is already open does nothing. */
    BY_PATH: 'byPath',
};

/**
 * Create an empty window and its tree container.
 *
 * @param id         unique element id; if one already exists, returns null so the
 *                   caller can decide whether that is a no-op or an error
 * @param parent     element to append to
 * @param attributes extra attributes to set on the window element
 * @returns {{windowEl: HTMLElement, treeEl: HTMLElement}|null}
 */
export function createWindowShell({ id, parent, attributes = {} }) {
    if (document.getElementById(id)) return null;

    const windowEl = fastDiv('file-window');
    windowEl.id = id;
    for (const [name, value] of Object.entries(attributes)) {
        windowEl.setAttribute(name, value);
    }

    const treeEl = fastDiv('jsontree-container');
    windowEl.appendChild(treeEl);
    parent.appendChild(windowEl);

    return { windowEl, treeEl };
}

/** Remove a window. Tolerates null so callers need not guard. */
export function closeWindow(element) {
    element?.remove();
}

/**
 * Append a row of buttons built from a flow-supplied action list.
 *
 * @param actions [{ label, onClick, when }] -- entries with `when === false` are skipped
 */
export function renderActions(container, actions, buttonClass) {
    for (const action of actions) {
        if (action.when === false) continue;
        const button = document.createElement('button');
        const className = action.className ?? buttonClass;
        if (className) button.className = className;
        button.innerText = action.label;
        button.addEventListener('click', action.onClick);
        container.appendChild(button);
    }
}

/** A row of actions in the editor bar. */
function appendActionRow(list, actions, buttonClass) {
    if (!actions.some((action) => action.when !== false)) return;

    const cell = document.createElement('li');
    list.appendChild(cell);

    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.classList.add('jsontree-editor-bar-button-group');
    cell.appendChild(group);

    renderActions(group, actions, buttonClass);
}

/** Close every window from `depth` down to `maxDepth - 1`. */
export function closeFromDepth(depth, maxDepth, idForDepth) {
    for (let level = depth; level < maxDepth; level++) {
        closeWindow(document.getElementById(idForDepth(level)));
    }
}

/**
 * Create a window with its editor bar: a title and a row of actions.
 *
 * @param id          unique element id
 * @param parent      element to append to
 * @param attributes  extra attributes for the window element
 * @param title       HTML for the title cell -- flows differ in heading level and
 *                    in what decorations they add, so this is theirs to supply
 * @param actions     [{ label, onClick, when, className }]
 * @param secondaryActions a second row, for actions whose labels are too long to sit
 *                    in a group of short ones (the case flow's Select Override Fields)
 * @param buttonClass optional class for every action button
 * @param onTitleReady called with the title element, for flows that attach
 *                    behaviour to what they put in it (copy/favourite icons)
 * @returns {{windowEl, treeEl, titleEl}|null} -- null if a window with this id is open
 */
export function createTreeWindow({
    id, parent, attributes = {}, title = '', actions = [], secondaryActions = [],
    buttonClass, onTitleReady,
}) {
    const shell = createWindowShell({ id, parent, attributes });
    if (!shell) return null;

    const { windowEl, treeEl } = shell;

    const editorBar = document.createElement('nav');
    editorBar.className = 'editor-bar';
    treeEl.appendChild(editorBar);

    const list = document.createElement('ul');
    editorBar.appendChild(list);

    const titleEl = document.createElement('li');
    titleEl.className = 'doc-title';
    titleEl.innerHTML = title;
    list.appendChild(titleEl);

    appendActionRow(list, actions, buttonClass);
    appendActionRow(list, secondaryActions, buttonClass);

    if (onTitleReady) onTitleReady(titleEl);

    return { windowEl, treeEl, titleEl };
}
