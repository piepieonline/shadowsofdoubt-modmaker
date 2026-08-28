/**
 * The one startup modal.
 *
 * Replaces the two flows' separate "before you start" dialogs, which each asked only
 * for the folders that flow cared about and neither showed what was already chosen.
 * This lists every folder, marks the ones already connected, and lets any of them be
 * changed at any time -- including after startup, from the header.
 */
import { FOLDERS, folderName, isPending, pendingName, selectFolder, missingFolders } from './folders.js';
import { isDemoMode } from './demo/demoMode.js';

const MODAL = '#folders-modal';

const statusOf = (kind) => {
    const name = folderName(kind.id);
    if (name) return { text: name, state: 'connected', action: 'Change' };
    if (isPending(kind.id)) return { text: `${pendingName(kind.id)} — needs reconnecting`, state: 'pending', action: 'Reconnect' };
    return { text: kind.optional ? 'Not set (optional)' : 'Not set', state: 'missing', action: 'Select' };
};

function render(flow) {
    const list = document.querySelector('#folders-list');
    list.replaceChildren();

    const required = new Set(flow?.requiredFolders ?? []);

    for (const kind of FOLDERS) {
        const status = statusOf(kind);

        const row = document.createElement('li');
        row.className = 'folder-row';
        row.dataset.folder = kind.id;
        row.dataset.state = status.state;

        const text = document.createElement('div');
        text.innerHTML =
            `<strong>${kind.label}${required.has(kind.id) ? ' <small>(required)</small>' : ''}</strong>` +
            `<br /><small>${kind.hint}</small>` +
            `<br /><small class="folder-status">${status.text}</small>`;

        const button = document.createElement('button');
        button.className = status.state === 'connected' ? 'secondary' : '';
        button.textContent = status.action;
        button.dataset.selectFolder = kind.id;
        // Enforced in selectFolder as well. Disabling it here is so the state is
        // visible, rather than a click that answers with an alert.
        button.disabled = isDemoMode();
        if (button.disabled) button.title = 'Folders cannot be changed in demo mode';
        button.addEventListener('click', async () => {
            try {
                await selectFolder(kind.id);
            } catch {
                // The user dismissed the picker; leave everything as it was.
            }
            render(currentFlow);
            await notifyChanged();
        });

        row.append(text, button);
        list.appendChild(row);
    }

    // Say what is missing, but do not trap anyone: the case flow can browse assets
    // online with no folders at all, and a flow that needs one will say so when asked
    // to do the thing that needs it.
    const missing = missingFolders(flow)
        .map((id) => FOLDERS.find((f) => f.id === id).label);

    const note = document.querySelector('#folders-missing');

    if (isDemoMode()) {
        // Demo mode connects folders of its own, so nothing is ever missing here. Saying
        // what they are matters more: the names below are not folders on this machine.
        note.textContent = 'Demo mode — these are made-up folders inside the browser. '
            + 'Your own folders are untouched. Reload without ?demo to use them.';
        note.hidden = false;
    } else {
        note.textContent = missing.length
            ? `${missing.join(' and ')} not set — needed to edit, but you can browse without.`
            : '';
        note.hidden = missing.length === 0;
    }

    markFoldersButton(missing.length > 0);
}

const listeners = new Set();

/** Called whenever a folder is connected or changed. */
export function onFoldersChanged(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Awaits its listeners, which is the whole point of it being async.
 *
 * Both callers already awaited this, and neither got what it was waiting for: connecting
 * a folder starts a mod-list rebuild that reads the folder, and firing the listeners
 * without awaiting them meant the caller carried on while that was still in flight.
 * Anything choosing a mod in the next breath -- demo mode does, immediately -- raced the
 * rebuild for the same `<select>` and lost.
 */
async function notifyChanged() {
    await Promise.all([...listeners].map((fn) => fn()));
}

export function openFoldersModal(flow) {
    render(flow);
    document.querySelector(MODAL).setAttribute('open', '');
}

export function closeFoldersModal() {
    document.querySelector(MODAL).removeAttribute('open');
}

/** The flow whose requirements the modal is currently reflecting. */
let currentFlow = null;

/** Bind the shell's own controls. Called once, not per flow. */
export function initFoldersModal() {
    document.querySelector('#folders-continue').addEventListener('click', closeFoldersModal);
    document.querySelector('#folders-open').addEventListener('click', () => openFoldersModal(currentFlow));
}

/**
 * Point the modal at a flow.
 *
 * Only opens itself on first load, and only if that flow is missing something it
 * needs. Switching flows never reopens it: flows require different folders, so a
 * modal on every switch is in the way rather than helpful. The Folders button in the
 * header is marked instead, and stays available whenever you do want it.
 */
export async function activateFoldersFor(flow, { autoOpen = false } = {}) {
    currentFlow = flow;

    const missing = missingFolders(flow);
    markFoldersButton(missing.length > 0);

    if (autoOpen && missing.length > 0) openFoldersModal(flow);

    // Always: the flow still has to pick up whatever is already connected.
    await notifyChanged();
}

/** Show on the header button that the active flow is missing a folder it needs. */
function markFoldersButton(missing) {
    const button = document.querySelector('#folders-open');
    button.classList.toggle('secondary', !missing);
    button.toggleAttribute('data-folders-missing', missing);
    button.title = missing
        ? 'This needs a folder that is not set yet'
        : 'Change the folders this app uses';
}
