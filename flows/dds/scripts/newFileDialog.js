/**
 * "Add new..." -- the one place this flow creates content.
 *
 * What kind of thing, and what to call it, used to be split between a dropdown in the
 * nav bar and a prompt part way through writing the files: the button read "Add new
 * tree" because a select three feet away said tree, and the line a block says was
 * asked for by a browser prompt after the document had already been created. The
 * dialog asks for all of it before anything is written, so cancelling leaves nothing
 * behind and the answers are visible together.
 *
 * Four things can be created, and they divide in two:
 *
 *   tree, message, block   a document, from a template, named by its author and
 *                          identified by a GUID. Each carries the level below it, so
 *                          all three end in a block with a line of text.
 *   strings file           a CSV the game reads from a path it decides. Not named:
 *                          picked from the files the game ships, or -- for text the
 *                          base game has no file for -- typed as a path of its own.
 *
 * A tree is asked about more closely than the other three, because "tree" is not a thing
 * the game has: a conversation, a v-mail, a document, a newspaper article, a message
 * library and a dialog chain are six formats sharing one struct, and one of them was
 * being made for all six. So the type list offers the six by name and the answer carries
 * the kind. See treeKinds.js, which is also where the values that kind needs come from.
 */
import { writeFile } from '../../../core/fs.js';
import {
    ddsContentFolder, placeStringsFile, readManifest, stringsFileHandle, withMapping, writeManifest,
} from '../../../core/ddsManifest.js';
import { searchSelect } from '../../../core/components/searchSelect/searchSelect.js';
import { refreshManifestPanel } from './manifestPanel.js';
import { openStringsFile } from './stringsEditor.js';
import { parseNewFileType, TREE_KINDS, treeKindValue } from './treeKinds.js';
import { closeModal, newFile, openModal, refreshPanel } from './ui.js';

const MODAL = '#new-dds-file-modal';

/** The strings dropdown holds paths below this, without the .csv. */
const STRINGS_ROOT = 'Strings/English';

const field = (id) => document.getElementById(id);

/**
 * The file picker, and the path it last reported.
 *
 * The path is kept rather than read off the `<select>` when the form is submitted,
 * because a typed one is held on the element wrapped in a marker of searchSelect's own.
 * `onChange` is where that comes off, so it is the only place the answer is readable.
 */
let stringsPicker = null;
let stringsPath = '';

export function showNewDdsFile() {
    // The button is disabled without a content folder, so this is only the guard
    // against being called some other way.
    if (!window.selectedMod) {
        alert('Please select a mod to edit first');
        return;
    }

    buildTreeKinds();
    field('new-dds-file-form').reset();
    buildStringsPicker();
    updateNewDdsFileForm();
    openModal(MODAL);
}

/**
 * Fill the six kinds of tree into the type dropdown.
 *
 * Built from the table rather than written into the markup, so the value the submit
 * handler splits and the values the table answers to cannot drift apart -- an option
 * naming a seventh kind would create a tree the game has no code for.
 *
 * Before the `reset()` above, which is what puts the selection back on the first of them.
 */
function buildTreeKinds() {
    field('new-dds-file-tree-kinds').replaceChildren(...TREE_KINDS.map((kind) => {
        const option = document.createElement('option');
        option.value = treeKindValue(kind);
        option.textContent = kind.label;
        return option;
    }));
}

/**
 * Fill the file picker, with nothing chosen on it.
 *
 * Built afresh on each opening rather than left to the `reset()` above. select2 mirrors
 * the `<select>` rather than watching it, so a reset puts the element back to nothing and
 * leaves the control showing the file picked last time -- and a dialog naming one file
 * while holding another creates the wrong one. A path typed into the previous opening is
 * an option on the element by then as well, which only rebuilding takes off.
 */
function buildStringsPicker() {
    stringsPath = '';

    // Closed before it is destroyed, or its scroll handlers outlive it. See searchSelect.
    stringsPicker?.close();
    stringsPicker?.destroy();

    stringsPicker = searchSelect(field('new-dds-file-strings'), {
        // The dialog itself, which is what paints the overlay and so is the shallowest
        // place the dropdown renders in front of it. Not the <article> inside, which Pico
        // gives an overflow of its own -- the one thing a dropdown's parent must not have.
        parent: document.querySelector(MODAL),

        groups: stringsFileGroups(),

        // A mod may carry text the base game has no file for, and the game reads a CSV
        // from wherever the manifest says -- so the list is where the paths are known to
        // be, not where they have to be.
        allowCustom: true,

        placeholder: "Search the game's strings files, or type a path",

        // Survives the rebuild above, which is what happens on every opening of the
        // dialog. The file picked is deliberately not kept -- see the note on it -- but
        // the folder being searched for usually is the same one.
        memoryKey: 'dds:new-file:strings',

        onChange: (value) => { stringsPath = value ?? ''; },
    });
}

/**
 * The strings files the game ships, a group per folder, in the order the folder holds
 * them. See refs/README.md -- the list is a copy of the game's own Strings/English.
 *
 * An option reads as its whole path rather than as a file name under a heading naming its
 * folder. The repetition is what makes the search work on either half: this control takes
 * free text, so a term matching nothing is offered back as a path to create, and typing
 * "Evidence/" to see that folder would otherwise turn browsing into an offer to invent a
 * file.
 */
function stringsFileGroups() {
    const folders = new Map();

    for (const path of window.baseGameStringsFiles) {
        const cut = path.lastIndexOf('/');
        const folder = cut < 0 ? STRINGS_ROOT : path.slice(0, cut);

        if (!folders.has(folder)) folders.set(folder, []);
        folders.get(folder).push(path);
    }

    return [...folders].map(([label, options]) => ({ label, options }));
}

export function closeNewDdsFile() {
    closeModal(MODAL);
}

/**
 * Show the fields the chosen type has an answer for.
 *
 * `required` follows `hidden`: a hidden field the browser still insists on is a form
 * that will not submit and does not say why.
 */
export function updateNewDdsFileForm() {
    const { type, treeType } = parseNewFileType(field('new-dds-file-type').value);
    const strings = type === 'strings';

    field('new-dds-file-name-field').hidden = strings;
    field('new-dds-file-name').required = !strings;
    field('new-dds-file-line-field').hidden = strings;
    field('new-dds-file-strings-field').hidden = !strings;

    // What the chosen kind of tree is for. Nothing for the other three: "Message" and
    // "Block" are the names of the things themselves, and a strings file is described by
    // the field below it.
    field('new-dds-file-type-blurb').textContent =
        TREE_KINDS.find((kind) => kind.treeType === treeType)?.blurb ?? '';
}

export async function submitNewDdsFile() {
    const { type, treeType } = parseNewFileType(field('new-dds-file-type').value);
    const strings = type === 'strings';

    // Read before anything is closed, so a path that cannot be created leaves the
    // question on screen with the answer still in it. Not left to `required`: the
    // element carrying it is the one select2 hides, and a form that refuses to submit
    // over a control the browser cannot point at gives no reason at all.
    const relative = strings ? stringsFilePath(stringsPath) : null;
    if (strings && !relative) return;

    // Closed first: creating a tree reads and writes several files, and the dialog
    // sitting over the document it produced looks like nothing happened.
    closeNewDdsFile();

    if (strings) {
        await createStringsFile(relative);
        return;
    }

    await newFile(type, undefined, {
        name: field('new-dds-file-name').value.trim(),
        line: field('new-dds-file-line').value,
        treeType,
    });
}

/**
 * What the picker's answer means as a path, or null if it cannot mean one.
 *
 * A file chosen from the list arrives ready. A typed one is the author's spelling of a
 * path nothing here has seen, and where the file lands is read straight out of it: the
 * separators are levelled onto forward slashes, and a `.csv` written out by hand is taken
 * back off, since createStringsFile adds one and `misc.csv.csv` is never read by anything.
 *
 * A path that climbs out with `..` is refused rather than trimmed down to something that
 * stays. It was written to leave the folder, and quietly making it mean somewhere else
 * would put a file wherever the shortened version landed -- over one of the mod's own,
 * for a path aimed at a folder the mod has. Nothing chosen at all is refused in silence:
 * the dialog is simply not answered yet, which is what the empty option on it says.
 */
function stringsFilePath(answer) {
    const relative = answer
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\.csv$/i, '');

    if (!relative) return null;

    if (relative.split('/').some((step) => step === '' || step === '.' || step === '..')) {
        alert(`A strings file lives below ${STRINGS_ROOT}, so "${answer}" cannot be created.`);
        return null;
    }

    return relative;
}

/**
 * Add a strings CSV to the mod and open it.
 *
 * Where it goes is the manifest's business, exactly as it is for a line of block text:
 * a mod that keeps its CSVs somewhere of its own gets this one there, and gains the
 * entry that tells the loader where to read it from. See placeStringsFile.
 *
 * A file that is already there is opened rather than created. "Add new" on a file the
 * mod already has is a request to work on it, and writing an empty one over it would
 * throw away every row in it.
 *
 * @param relative path below Strings/English, without the .csv
 */
async function createStringsFile(relative) {
    const virtual = `${STRINGS_ROOT}/${relative}.csv`;

    const ddsFolder = await ddsContentFolder(window.selectedMod.baseFolder, true);
    const manifest = await readManifest(ddsFolder);
    const { real, addEntry } = placeStringsFile(manifest, virtual);

    if (!(await stringsFileHandle(ddsFolder, real, false))) {
        const handle = await stringsFileHandle(ddsFolder, real, true);

        // Creating it is allowed to fail -- a folder that cannot be written, a name
        // taken by a directory -- and opening a file that is not there would look like
        // an empty one that saving could repair.
        if (!handle) {
            alert(`Could not create ${real} in this mod.`);
            return;
        }

        await writeFile(handle, '', false);

        // The file went where the mod keeps its CSVs, which is not where the game
        // looks for it -- so say so, or nothing written into it is ever read.
        if (addEntry) {
            await writeManifest(ddsFolder, withMapping(manifest, addEntry));
            await refreshManifestPanel();
        }
    }

    await refreshPanel();
    await openStringsFile(real);
}
