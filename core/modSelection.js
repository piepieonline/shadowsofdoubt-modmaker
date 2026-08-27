/**
 * Choosing what to edit: a mod, then a content folder inside it.
 *
 * Two steps because a mod is a package, not a unit of content. One mod often holds
 * several editable folders, and where they sit varies -- see core/modFolders.js.
 *
 * Both steps live in the shell rather than in a flow. A content folder can hold DDS
 * text and case files at once, so which one you are working on is not a property of
 * the flow you happen to be looking at, and the choice survives switching flows.
 *
 * The result is published as `window.selectedMod`, which the flows already read:
 *   modName      the mod's folder name
 *   contentPath  the content folder's path within the mod, '' for the mod root
 *   baseFolder   the content folder's handle -- what everything is written relative to
 */
import { listMods, findContentFolders, describeContentFolder } from './modFolders.js';
import { folderHandle } from './folders.js';

const MOD_SELECT = '#select-mod';
const CONTENT_SELECT = '#select-content';

/**
 * A content folder at the mod root has an empty path, so "nothing selected" needs a
 * value of its own -- otherwise the placeholder and the mod root are the same option.
 */
const NONE = '\u0000none';

let mods = [];
let contentFolders = [];

/**
 * Folders just created, which disk cannot yet confirm.
 *
 * A content folder is recognised by what is *in* it -- a case manifest or a DDSContent
 * directory -- and a folder created a moment ago has neither until something is
 * written into it. Without these entries, creating one would drop it from the list in
 * the same breath, leaving nowhere to put that first file.
 *
 * Each is dropped as soon as a search finds the folder for itself.
 */
let pending = [];

const listeners = new Set();

/** Called when the chosen content folder changes, including when it is cleared. */
export function onSelectionChanged(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

const notify = () => { for (const fn of listeners) fn(); };

function fill(select, options, selected) {
    select.replaceChildren();
    for (const { value, label, disabled } of options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        if (disabled) option.disabled = true;
        option.selected = value === selected;
        select.appendChild(option);
    }
}

/** Rebuild the mod list from the connected plugins folder. */
export async function refreshMods({ keepSelection = true } = {}) {
    const plugins = folderHandle('modDir');
    const previous = keepSelection ? window.selectedMod?.modName : null;

    mods = plugins ? await listMods(plugins) : [];

    fill(document.querySelector(MOD_SELECT), [
        { value: NONE, label: mods.length ? 'Choose a mod…' : 'No mod folder connected' },
        ...mods.map((m) => ({ value: m.name, label: m.name })),
    ], previous ?? NONE);

    await refreshContentFolders({ keepSelection });
}

/** Rebuild the content list for whichever mod is selected. */
export async function refreshContentFolders({ keepSelection = true } = {}) {
    const modName = document.querySelector(MOD_SELECT).value;
    const previous = keepSelection ? window.selectedMod?.contentPath : null;
    const mod = mods.find((m) => m.name === modName);

    const found = mod ? await findContentFolders(mod) : [];
    const onDisk = (entry) => entry.modName === modName && found.some((f) => f.path === entry.path);

    pending = pending.filter((entry) => !onDisk(entry));

    contentFolders = [
        ...found,
        ...pending.filter((entry) => entry.modName === modName),
    ].sort((a, b) => a.path.localeCompare(b.path));

    const select = document.querySelector(CONTENT_SELECT);

    if (!mod) {
        fill(select, [{ value: NONE, label: 'Choose a mod first' }], NONE);
    } else if (contentFolders.length === 0) {
        // Plenty of mods are loaders or utilities with nothing to edit.
        fill(select, [{ value: NONE, label: 'Nothing editable in this mod' }], NONE);
    } else {
        fill(select, [
            { value: NONE, label: 'Choose a folder…' },
            ...contentFolders.map((f) => ({ value: f.path, label: describeContentFolder(f) })),
        ], previous ?? NONE);
    }

    await applySelection();
}

/**
 * What has already been handed to a flow, as flow + selection.
 *
 * Applying is destructive for some flows -- the case flow closes every open document
 * and reloads its manifest -- so doing it twice for the same state is not merely
 * wasted work. It was wiping documents that had just been restored.
 */
let applied = null;

/** Publish the chosen content folder and tell the active flow, once. */
async function applySelection() {
    const modName = document.querySelector(MOD_SELECT).value;
    const contentPath = document.querySelector(CONTENT_SELECT).value;
    const folder = contentPath === NONE
        ? null
        : contentFolders.find((f) => f.path === contentPath);

    window.selectedMod = (modName !== NONE && folder)
        ? { modName, contentPath, baseFolder: folder.handle }
        : null;

    const key = [
        window.activeFlow?.id ?? '',
        window.selectedMod ? `${window.selectedMod.modName}/${window.selectedMod.contentPath}` : '',
    ].join('::');

    if (key !== applied) {
        applied = key;
        await window.activeFlow?.onModSelected?.(window.selectedMod);
    }

    notify();
}

/**
 * Hand the current selection to whichever flow is now active. A no-op if that flow
 * has already been told, so the shell can call it without having to know.
 */
export const reapplySelection = () => applySelection();

export function initModSelection() {
    document.querySelector(MOD_SELECT)
        .addEventListener('change', () => refreshContentFolders({ keepSelection: false }));
    document.querySelector(CONTENT_SELECT)
        .addEventListener('change', () => applySelection());
}

/**
 * Select a mod and content folder programmatically, after creating one.
 * Rebuilds both lists so a newly created folder appears.
 *
 * @param handle the folder's handle, for one that was just created and so has nothing
 *               in it to find it by
 */
export async function selectContentFolder(modName, contentPath, handle) {
    if (handle) {
        pending = pending.filter((entry) => !(entry.modName === modName && entry.path === contentPath));
        pending.push({
            modName,
            path: contentPath,
            handle,
            hasManifest: false,
            hasDdsContent: false,
            hasFloors: false,
        });
    }

    await refreshMods({ keepSelection: false });
    document.querySelector(MOD_SELECT).value = modName;
    await refreshContentFolders({ keepSelection: false });
    document.querySelector(CONTENT_SELECT).value = contentPath;
    await applySelection();
}

/** The content folders found in the selected mod, for code that needs their shape. */
export const currentContentFolders = () => contentFolders;

/** The mod chosen in the header, or null for the placeholder. */
export function currentModName() {
    const value = document.querySelector(MOD_SELECT).value;
    return value === NONE ? null : value;
}
