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
 *                          picked from the files the game looks for.
 */
import { writeFile } from '../../../core/fs.js';
import { placeStringsFile, readManifest, stringsFileHandle, withMapping, writeManifest } from './ddsManifest.js';
import { ddsContentFolder } from './modFileManager.js';
import { refreshManifestPanel } from './manifestPanel.js';
import { openStringsFile } from './stringsEditor.js';
import { closeModal, newFile, openModal, refreshPanel } from './ui.js';

const MODAL = '#new-dds-file-modal';

/** The strings dropdown holds paths below this, without the .csv. */
const STRINGS_ROOT = 'Strings/English';

const field = (id) => document.getElementById(id);

export function showNewDdsFile() {
    // The button is disabled without a content folder, so this is only the guard
    // against being called some other way.
    if (!window.selectedMod) {
        alert('Please select a mod to edit first');
        return;
    }

    field('new-dds-file-form').reset();
    updateNewDdsFileForm();
    openModal(MODAL);
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
    const strings = field('new-dds-file-type').value === 'strings';

    field('new-dds-file-name-field').hidden = strings;
    field('new-dds-file-name').required = !strings;
    field('new-dds-file-line-field').hidden = strings;
    field('new-dds-file-strings-field').hidden = !strings;
}

export async function submitNewDdsFile() {
    const type = field('new-dds-file-type').value;

    // Closed first: creating a tree reads and writes several files, and the dialog
    // sitting over the document it produced looks like nothing happened.
    closeNewDdsFile();

    if (type === 'strings') {
        await createStringsFile(field('new-dds-file-strings').value);
        return;
    }

    await newFile(type, undefined, {
        name: field('new-dds-file-name').value.trim(),
        line: field('new-dds-file-line').value,
    });
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
