/**
 * A mod's strings CSV, edited as the list of strings it is.
 *
 * These files are rows of `guid,,text,,,,timestamp`, and everything the app wrote into
 * one it wrote a row at a time -- through addOrModifyStrings, keyed by a block's GUID.
 * That covers adding text and nothing else: a typo three rows down, a row for a GUID no
 * block references any more, or a file DDS never names at all (room names, job titles,
 * evidence names) had no way to be touched here.
 *
 * The format is fixed and only two of its seven columns are strings -- the key and the
 * text -- so that is what the editor shows: a pair of boxes per row, a button to drop
 * one and a button to add one. The other five columns are carried back out of each row
 * unchanged, because they are the file author's and this app has no view on them. See
 * core/stringsCsv.js for the row model and what it does and does not touch.
 *
 * There is one window for it, beside the tree -> message -> block drill-down rather
 * than inside it. A strings file is not a level of that cascade, and the reason to have
 * it open is usually the block in the window next to it.
 *
 * On request, the base game's own rows for the same file are listed under the mod's,
 * read only. A mod's CSV is a handful of lines standing in front of a file of thousands,
 * and what those lines are replacing was otherwise only readable by opening the game's
 * copy outside this app. Read only because this editor writes into the mod and nowhere
 * else: the game's files are not a mod author's to edit, and a mod that wants a line
 * changed says so with a row of its own. See applyVanilla.
 *
 * The catch is the cache. Block text is read once into window.stringMapping and
 * window.moddedStringMapping (see loadI18n) and resolved into each open document as it
 * loads (see createDummyKeys), so editing the file a mod's block text lives in leaves
 * both stale. Saving reseeds them; see afterSave.
 */
import { fastDiv, fastElement } from '../../../core/dom.js';
import { readFileContent, tryGetFile, writeFile } from '../../../core/fs.js';
import { assertModSelected, shouldSave } from '../../../core/persistence.js';
import { editedStamp, parseStringsCsv, serialiseStringsCsv } from '../../../core/stringsCsv.js';
import { closeWindow, createTreeWindow } from '../../../core/treeWindow.js';
import {
    DDS_BLOCKS_VIRTUAL, ddsContentFolder, readManifest, stringsFileHandle, toReal, toVirtual,
} from '../../../core/ddsManifest.js';
import { reloadOpenDocuments } from './ui.js';
import { loadI18n } from '../index.js';

export const STRINGS_WINDOW_ID = 'strings-window';

/**
 * The file the window holds, or null when nothing is open.
 *
 * `handle` is what identifies it, not `real`. A path is only a name for a file, and one
 * file answers to several: a manifest is spelled however its author spelled it, and the
 * filesystems these mods live on are case-insensitive, so Strings/English and
 * strings/english are one folder that compares as two. Everything asking "is this the
 * file I have open" asks the handle. See isOpenFile.
 */
let openFile = null;

/**
 * Writes, one after another.
 *
 * A row is two boxes, and moving from one to the other blurs the first -- so with
 * autosave on, a write starts while the author is still typing the rest of the row.
 * Left to run as they are asked for, two of those race: both read the rows, both write
 * the file, and whichever finishes last is what is on disk. Chaining them means the
 * second reads the rows the first has already written.
 */
let writes = Promise.resolve();

/**
 * Whether the base game's own rows are listed below the mod's.
 *
 * Kept for the session rather than per file: it is how an author wants to read these
 * files, not something about the one that happens to be open.
 */
let showVanilla = false;

const basename = (path) => path.split('/').at(-1);

/** The mod's DDSContent, and what its manifest says about where files are read from. */
async function contentAndManifest(create) {
    const ddsFolder = await ddsContentFolder(window.selectedMod.baseFolder, create);
    return { ddsFolder, manifest: await readManifest(ddsFolder) };
}

/** The file the mod's block text is read from, or null when it has none. */
async function blockTextFile(ddsFolder, manifest) {
    return stringsFileHandle(ddsFolder, toReal(manifest, DDS_BLOCKS_VIRTUAL), false);
}

/**
 * Whether a write landed on the file this window holds.
 *
 * Path equality is the fallback, for a file that is not on disk yet: a handle can only
 * identify something that exists, and a manifest may name a file the mod has never
 * written. Both callers name it the same way in that case -- from the manifest -- so
 * comparing the names is sound exactly where comparing the files is impossible.
 */
async function isOpenFile(realPath, handle) {
    if (!openFile) return false;
    if (openFile.handle && handle) return openFile.handle.isSameEntry(handle);

    return openFile.real === realPath;
}

/**
 * Open a strings file, replacing whatever the window held.
 *
 * @param realPath path below DDSContent, as the file panel and the manifest give it
 */
export async function openStringsFile(realPath) {
    // Both lists that lead here are built from a selected mod, so this is only the
    // guard against being called some other way.
    if (!window.selectedMod) return;

    const { ddsFolder, manifest } = await contentAndManifest(false);
    const handle = await stringsFileHandle(ddsFolder, realPath, false);

    // A manifest can name a file that is not there, and opening it is a reasonable way
    // to write it -- so an absent file is an empty document rather than an error. The
    // file itself is created on save, as everything else in this flow is.
    const text = handle ? (await readFileContent(handle)) ?? '' : '';

    closeStringsWindow(true);

    openFile = {
        real: realPath,
        virtual: toVirtual(manifest, realPath),
        // Null until the file exists. Saving one that does not yet puts it here.
        handle,
        dirty: false,
        // Bumped by every edit, so a write can tell whether what it is about to call
        // saved is still what is on screen. See save.
        revision: 0,
        windowEl: null,
        // The lines held back from the top of the file, written out above the rows.
        headers: [],
        rows: [],
    };

    render(text);
}

function render(text) {
    const { windowEl, treeEl } = createTreeWindow({
        id: STRINGS_WINDOW_ID,
        parent: document.getElementById('trees'),
        // Recorded so the open file can be captured and restored across a flow switch.
        attributes: { strings: openFile.real },
        // Filled in as text below: a file name is whatever is on disk, and this is set
        // as HTML.
        title: '<h2></h2><h3></h3>',
        actions: [
            {
                label: vanillaLabel(),
                className: 'strings-vanilla-toggle',
                // State-neutral: the label says which way the switch is about to go, and
                // this says what the switch is about.
                title: 'The base game\'s strings for this file, listed below your own',
                onClick: (event) => toggleVanilla(event.currentTarget),
            },
            { label: 'Save', onClick: () => save(true) },
            { label: 'Close', onClick: () => closeStringsWindow() },
        ],
        onTitleReady: (titleEl) => {
            titleEl.querySelector('h2').textContent = `Strings: ${basename(openFile.real)}`;
            // The path the game reads it from, and where it actually is when the
            // manifest has moved it -- the file panel says it the same way.
            titleEl.querySelector('h3').textContent = openFile.virtual === openFile.real
                ? openFile.real
                : `${openFile.virtual} (really ${openFile.real})`;
        },
    });

    const editor = fastDiv('strings-editor');

    // Said rather than hidden: the file has lines in it that the list does not show,
    // and an author who cannot see them has no way to know they are being kept.
    const headerNote = fastElement('p', 'strings-headers');

    // A real table, so that the column a box is in is something a screen reader can
    // say. Every row's boxes are otherwise a wall of identically labelled fields.
    const table = fastElement('table', 'strings-table');
    // The third column is a button per row, and each of those says what it removes.
    // Its heading is for anyone who cannot see that, so it is not taking up width.
    table.innerHTML = '<thead><tr>'
        + '<th scope="col">Key</th><th scope="col">Text</th>'
        + '<th scope="col"><span class="strings-unseen">Remove</span></th>'
        + '</tr></thead>';

    const body = fastElement('tbody', 'strings-rows');

    // The base game's rows, below the mod's: a second body of the same table rather than
    // a table of its own, so the two lists share their column widths and their headings
    // instead of being a pair of lists that only look alike.
    const vanillaBody = fastElement('tbody', 'strings-vanilla');
    vanillaBody.hidden = true;

    table.append(body, vanillaBody);

    const scroll = fastDiv('strings-scroll');
    scroll.appendChild(table);

    const add = fastElement('button', 'strings-add');
    add.type = 'button';
    add.textContent = '+ Add row';
    add.addEventListener('click', () => {
        // Focused, because the reason to add a row is to type in it -- and because an
        // added row with nothing in it is not written, so nothing has happened yet.
        addRow({ key: '', text: '' }).keyInput.focus();
        markDirty(true);
        validate();
    });

    editor.append(headerNote, scroll, add);
    treeEl.appendChild(editor);

    openFile.windowEl = windowEl;
    openFile.bodyEl = body;
    openFile.vanillaBodyEl = vanillaBody;
    openFile.headerNoteEl = headerNote;

    // The button says what it will do; this says what it has done. Set here rather than
    // through the action list, which has no view on a button that is a switch.
    windowEl.querySelector('.strings-vanilla-toggle')
        .setAttribute('aria-pressed', String(showVanilla));

    fill(text);

    // A file opened while the switch is on has the base game's rows under it already.
    applyVanilla();
}

const vanillaLabel = () => (showVanilla ? 'Hide vanilla' : 'Show vanilla');

const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Turn the base game's rows on or off, for this file and the next one opened. */
function toggleVanilla(button) {
    showVanilla = !showVanilla;

    button.innerText = vanillaLabel();
    button.setAttribute('aria-pressed', String(showVanilla));

    applyVanilla();
}

/**
 * Put the base game's rows under the mod's, or take them away.
 *
 * Taken away rather than hidden: dds.blocks.csv alone is thousands of rows, and rows
 * left in the document cost their memory whether or not anything is drawing them.
 */
function applyVanilla() {
    openFile.vanillaBodyEl.hidden = !showVanilla;

    if (!showVanilla) {
        openFile.vanillaBodyEl.replaceChildren();
        return;
    }

    fillVanilla(openFile);
}

/**
 * The base game's rows for the file the window holds.
 *
 * Read at the *virtual* path -- where the game reads the mod's file from, which is the
 * file the mod is overriding. A manifest can put the mod's copy anywhere in DDSContent,
 * and where it happens to sit says nothing about what it stands in for.
 *
 * @returns rows, or a note saying why there are none to show
 */
async function readVanilla(file) {
    if (!window.dirHandleStreamingAssets) {
        return { note: 'Connect the game folder to see the base game\'s strings.' };
    }

    const handle = await tryGetFile(window.dirHandleStreamingAssets, file.virtual.split('/'), false);

    // Not every strings file is one of the game's: a mod naming its own rooms or its own
    // evidence writes a CSV the base game has no counterpart for.
    if (!handle) return { note: `The base game has no ${file.virtual}.` };

    return { rows: parseStringsCsv((await readFileContent(handle)) ?? '').rows };
}

/** Fill in the read-only half of the list. */
async function fillVanilla(file) {
    let result;

    try {
        result = await readVanilla(file);
    } catch (error) {
        console.warn('Could not read the base game strings', error);
        result = { note: 'The base game file could not be read.' };
    }

    // Toggled off, closed or replaced by another file while it was being read.
    if (file !== openFile || !showVanilla) return;

    const { rows, note } = result;

    file.vanillaBodyEl.replaceChildren(
        vanillaHeading(note ?? `Base game — ${count(rows.length, 'string')}, read only.`),
        // Built in one pass and appended once: a base game CSV is long enough that
        // adding its rows one at a time is visible.
        ...(rows ?? []).map(vanillaRow),
    );
}

/**
 * The line between the two lists: what is below it and where it came from.
 *
 * A row of the table rather than something above it, because that is what keeps it in
 * step with the columns it divides while the list scrolls past.
 */
function vanillaHeading(text) {
    const row = fastElement('tr', 'strings-vanilla-heading');
    const cell = fastElement('td');

    cell.colSpan = 3;
    cell.innerText = text;
    row.appendChild(cell);

    return row;
}

/** One of the game's strings: the pair, said rather than offered as boxes to type in. */
function vanillaRow({ key, text }) {
    const row = fastElement('tr', 'strings-vanilla-row');

    const keyCell = fastElement('td', 'strings-vanilla-key');
    keyCell.innerText = key;

    const textCell = fastElement('td');
    textCell.innerText = text;

    // The column the mod's rows keep their remove button in. Nothing here to remove --
    // this file is the game's -- and the cell is what holds the columns lined up.
    row.append(keyCell, textCell, fastElement('td', 'strings-remove-cell'));

    return row;
}

/** Put a file's contents in the window, replacing whatever rows were there. */
function fill(text) {
    const { headers, rows } = parseStringsCsv(text);

    openFile.headers = headers;
    openFile.rows = [];
    openFile.bodyEl.replaceChildren();

    for (const row of rows) addRow(row);

    openFile.headerNoteEl.textContent = headers.length === 1
        ? '1 header line at the top of this file, kept as it is.'
        : `${headers.length} header lines at the top of this file, kept as they are.`;
    openFile.headerNoteEl.hidden = headers.length === 0;

    validate();
}

/** One of the two boxes in a row. */
function fieldInput(className, label, value, onInput) {
    const input = fastElement('input', className);
    input.type = 'text';
    input.value = value;
    input.spellcheck = false;
    input.setAttribute('aria-label', label);

    input.addEventListener('input', () => {
        onInput(input.value);
        markDirty(true);
        validate();
    });

    // Autosave writes on the way out, the way an edited tree value does. With autosave
    // off this does nothing and the Save button is the only writer.
    input.addEventListener('blur', () => save(false));

    return input;
}

/**
 * Append a row to the list.
 *
 * `fields` comes along for the ride: it is the row as it was read, and the columns
 * this app has no view on are only still there because it was kept. A row added here
 * has none, and is written as a fresh one.
 */
function addRow({ key, text, fields }) {
    const row = { key, text, fields };

    row.el = fastElement('tr', 'strings-row');

    row.keyInput = fieldInput('strings-key', 'Key', key, (value) => {
        row.key = value;
        labelRemove(row);
    });
    row.valueInput = fieldInput('strings-value', 'Text', text, (value) => { row.text = value; });

    // Under the key box rather than beside the row: both things that can be wrong with
    // a row are wrong with its key.
    row.issueEl = fastElement('p', 'strings-issue');
    row.issueEl.hidden = true;

    row.removeButton = fastElement('button', 'strings-remove');
    row.removeButton.type = 'button';
    row.removeButton.textContent = '×';
    row.removeButton.addEventListener('click', () => removeRow(row));
    labelRemove(row);

    const keyCell = fastElement('td');
    keyCell.append(row.keyInput, row.issueEl);

    const valueCell = fastElement('td');
    valueCell.appendChild(row.valueInput);

    const removeCell = fastElement('td', 'strings-remove-cell');
    removeCell.appendChild(row.removeButton);

    row.el.append(keyCell, valueCell, removeCell);
    openFile.bodyEl.appendChild(row.el);
    openFile.rows.push(row);

    return row;
}

/** Name the remove button by what it removes, since there is one per row. */
function labelRemove(row) {
    row.removeButton.setAttribute(
        'aria-label', row.key === '' ? 'Remove the empty row' : `Remove ${row.key}`,
    );
}

/**
 * Drop a row.
 *
 * Written like an edit rather than immediately: removing a row is a decision, but it
 * is the same kind of decision as retyping one, and the autosave switch is what says
 * whether a decision reaches disk on its own.
 */
function removeRow(row) {
    row.el.remove();
    openFile.rows = openFile.rows.filter((other) => other !== row);

    markDirty(true);
    validate();
    save(false);
}

/**
 * Say what the game will not be able to read.
 *
 * Only two things, and both are about the key. What a line says is the author's, and a
 * key that is not a GUID is not a mistake -- rooms and jobs are keyed by name -- so
 * there is nothing to check about either.
 */
function validate() {
    const keys = new Map();
    for (const row of openFile.rows) {
        if (row.key !== '') keys.set(row.key, (keys.get(row.key) ?? 0) + 1);
    }

    for (const row of openFile.rows) {
        let issue = '';

        if (row.key === '') {
            // An empty row is one waiting to be typed in, and is not written at all.
            if (row.text !== '') issue = 'No key: nothing can look this line up.';
        } else if (keys.get(row.key) > 1) {
            issue = 'Duplicate key: the game reads whichever row it finds first.';
        }

        row.issueEl.textContent = issue;
        row.issueEl.hidden = issue === '';

        // The string, not a bare attribute: Pico styles `[aria-invalid="true"]`.
        if (issue === '') row.keyInput.removeAttribute('aria-invalid');
        else row.keyInput.setAttribute('aria-invalid', 'true');
    }
}

function markDirty(dirty) {
    openFile.dirty = dirty;
    if (dirty) openFile.revision++;

    // Shown, because unsaved rows here are rows that a write from elsewhere will not
    // overwrite and a reseed will not account for. See refreshOpenStringsFile.
    openFile.windowEl.toggleAttribute('data-dirty', dirty);
}

/**
 * Write the file.
 *
 * @param force an explicit Save, which writes whatever autosave is set to. Blur fires
 *              whether or not anything was typed, so autosave has nothing to do until
 *              something has been.
 */
function save(force) {
    if (!openFile) return Promise.resolve();

    // Read now rather than in the write: this is the mod the edit was made in, and a
    // write queued behind another has no other way to know it.
    const file = openFile;
    const mod = window.selectedMod;

    const queued = writes.then(() => write(file, mod, force), () => write(file, mod, force));

    // The queue itself must not be left rejected, or every write after a failed one is
    // dropped. The caller still gets the failure, from `queued`.
    writes = queued.catch(() => {});
    return queued;
}

async function write(file, mod, force) {
    if (!force && !(file.dirty && shouldSave(false))) return;

    // The window can be closed between an edit and its write, and the file is still
    // worth writing when it is -- but a different mod is a different DDSContent, and
    // this file's path means something else under it, or nothing at all.
    if (window.selectedMod !== mod) return;

    assertModSelected();

    const { ddsFolder } = await contentAndManifest(true);
    const handle = await stringsFileHandle(ddsFolder, file.real, true);

    // Read after the awaits, so a keystroke that landed while the folder was being
    // resolved goes into this write rather than waiting for another.
    const revision = file.revision;
    await writeFile(handle, serialiseStringsCsv(file, editedStamp()), false);

    // Written for the first time, so there is now a file to be identified by.
    file.handle = handle;

    // Only what is still on screen is marked saved. Clearing the flag for an edit this
    // write did not include would leave that edit sitting there looking stored, and a
    // write from elsewhere would then feel free to overwrite it.
    if (file === openFile && file.revision === revision) markDirty(false);

    await afterSave(handle);
}

/**
 * Put back what this file's text is cached in.
 *
 * Only block text is cached, so only the file the mod's block text is read from is
 * worth the work -- the others name rooms, jobs and evidence, which nothing here holds.
 * Which file that is comes from the manifest, and is resolved again rather than
 * remembered: a mapping can have been added since the window was opened.
 *
 * It is the file that is compared, not the path to it, so that a mod whose folders are
 * spelled differently to the game's still has its text reseeded. loadI18n resolves the
 * same handle, so this asks precisely the question that matters: is what was just
 * written the file that block text is read from?
 */
async function afterSave(saved) {
    const { ddsFolder, manifest } = await contentAndManifest(false);
    if (!(await (await blockTextFile(ddsFolder, manifest))?.isSameEntry(saved))) return;

    await loadI18n();

    // The maps are half of it. Each open document had its English text resolved into it
    // as it loaded, so reload those too, or the reseed is invisible until the next time
    // something is opened.
    await reloadOpenDocuments();
}

/**
 * Show what a write from elsewhere put in the file this window holds.
 *
 * addOrModifyStrings writes a row straight to disk, so an open editor is left looking
 * at what the file was a moment ago. Unsaved rows are left exactly as they are: they
 * are work that re-reading would throw away, and the window marks itself as unsaved.
 *
 * @param realPath the file that was written, below DDSContent
 * @param handle   that file, which is what it is actually recognised by
 */
export async function refreshOpenStringsFile(realPath, handle) {
    if (!openFile || openFile.dirty) return;
    if (!(await isOpenFile(realPath, handle))) return;

    // The write may have created it, in which case this window has been holding a file
    // that did not exist and can now be identified by the one that does.
    openFile.handle = handle ?? openFile.handle;

    fill(openFile.handle ? (await readFileContent(openFile.handle)) ?? '' : '');
}

/**
 * Close the window.
 *
 * @param discard skip the confirmation, for a close the user did not ask for
 */
export function closeStringsWindow(discard) {
    // Clicking any control moves focus out of the box first, so with autosave on the
    // rows are already written. With it off, this is the only thing between typing and
    // losing it.
    if (!discard && openFile?.dirty && !confirm('Discard unsaved changes to this file?')) return;

    closeWindow(document.getElementById(STRINGS_WINDOW_ID));
    openFile = null;
}

/** The file the window holds, for the session capture. Null when it is closed. */
export function openStringsPath() {
    return openFile?.real ?? null;
}
