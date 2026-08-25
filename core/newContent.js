/**
 * Creating a new content folder inside a mod.
 *
 * One button in the shell header, for every flow. What goes *in* the folder is the
 * active flow's business -- a case needs a manifest and a preset, DDS content needs
 * nothing until there is a document to write.
 *
 * Where it goes follows the folder you are working in, so a new one lands beside it:
 *
 *   AdditionalEvidence/BinPasscodes                 -> AdditionalEvidence/NewThing
 *   DialogAdditions/plugins/TalkToPartner           -> DialogAdditions/plugins/NewThing
 *   WhiteCollarSideJobs/plugins/Cases/test          -> WhiteCollarSideJobs/plugins/Cases/NewThing
 *
 * With nothing selected there is no "beside", so it falls back to where the mod
 * already keeps content. Mods disagree about that and the loader cares: some keep
 * content directly under the mod folder, most under the BepInEx `plugins/` convention,
 * and some nest it further still. Putting a new folder somewhere the mod does not use
 * would produce content that silently fails to load.
 */
import { getFolder, tryGetFolder } from './fs.js';
import { findContentFolders } from './modFolders.js';
import { folderHandle } from './folders.js';
import { currentModName, onSelectionChanged, selectContentFolder } from './modSelection.js';

/**
 * The directory a new content folder should be created in, as a path relative to the
 * mod root. Empty means directly under the mod.
 *
 * Uses where the mod already keeps content. A mod whose only content folder *is* its
 * root has no convention to copy, so new content goes alongside at the root.
 */
export function conventionalParent(existing) {
    const parents = existing
        .map(({ path }) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''))
        .filter((parent) => parent !== '');

    if (parents.length === 0) return '';

    // The most common, so one oddly placed folder does not decide it.
    const counts = new Map();
    for (const parent of parents) counts.set(parent, (counts.get(parent) ?? 0) + 1);

    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/**
 * Create a content folder in `modName` and return its path relative to the mod, with
 * the handle -- the folder has nothing in it yet, so it cannot be found by searching
 * for it. See the pending entries in core/modSelection.js.
 *
 * @param scaffold  called with the new folder's handle, to lay out whatever the
 *                  flow needs inside it
 * @param parent    directory to create it in, relative to the mod; '' is the mod
 *                  root. null asks for the mod's own convention.
 */
export async function createContentFolder(modName, name, scaffold, { parent = null } = {}) {
    const plugins = folderHandle('modDir');
    if (!plugins) throw new Error('No mod folder connected');

    const mod = await plugins.getDirectoryHandle(modName);
    const where = parent ?? conventionalParent(await findContentFolders(mod));
    const path = where ? `${where}/${name}` : name;

    if (await tryGetFolder(mod, path.split('/'))) {
        throw new Error(`"${path}" already exists in ${modName}`);
    }

    const folder = await getFolder(mod, path.split('/'), true);
    if (scaffold) await scaffold(folder);

    return { path, handle: folder };
}

/** Where a new folder goes to sit beside the one being worked in. */
function parentOfSelection(modName) {
    if (window.selectedMod?.modName !== modName) return null;

    const path = window.selectedMod.contentPath;
    return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/**
 * The header's New content button.
 *
 * The flow is asked what it needs *before* the folder exists, and answers with how to
 * lay it out. Cancelling its dialog therefore leaves nothing behind on disk, which
 * asking afterwards would not.
 */
export async function newContentFolder() {
    const modName = window.selectedMod?.modName ?? currentModName();

    if (!modName) {
        alert('Choose a mod first');
        return;
    }

    const name = prompt('Name for the new content folder')?.trim();
    if (!name) return;

    if (name.includes('/') || name.includes('\\')) {
        alert('A folder name cannot contain a slash');
        return;
    }

    const scaffold = await window.activeFlow?.newContent?.(name);
    if (scaffold === null) return;

    try {
        const { path, handle } = await createContentFolder(modName, name, scaffold, {
            parent: parentOfSelection(modName),
        });
        await selectContentFolder(modName, path, handle);
    } catch (error) {
        alert(error.message);
    }
}

/**
 * Controls that have nothing to act on until something is chosen, marked in the markup
 * rather than listed here -- a flow's own "Add new ..." button is in that flow's
 * template, and the shell has no business knowing its id.
 *
 *   data-needs-mod      a mod is selected. Creating a content folder needs somewhere
 *                       to put it.
 *   data-needs-content  a content folder is selected too, which is what makes
 *                       `window.selectedMod` non-null. Anything writing a file needs
 *                       one: without it the flows had no base folder and failed at
 *                       the point of writing, well after the click.
 *
 * Both start disabled in the markup, so a control is only ever live because this said
 * so -- a flow whose markup is mounted before any selection has been made would
 * otherwise show an enabled button until the next change.
 */
function syncContentControls() {
    const mod = window.selectedMod?.modName ?? currentModName();

    for (const el of document.querySelectorAll('[data-needs-mod]')) el.disabled = !mod;
    for (const el of document.querySelectorAll('[data-needs-content]')) el.disabled = !window.selectedMod;
}

/** Bind the shell's own control. Called once, not per flow. */
export function initNewContent() {
    document.querySelector('#new-content').addEventListener('click', () => newContentFolder());

    // Fires on every selection change, and again when a flow is mounted -- the shell
    // reapplies the selection to the new flow, which is what makes its freshly cloned
    // markup follow the state it was mounted into.
    onSelectionChanged(syncContentControls);
    syncContentControls();
}
