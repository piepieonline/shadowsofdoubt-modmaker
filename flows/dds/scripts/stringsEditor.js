/**
 * A mod's strings CSV, edited as text.
 *
 * These files are rows of `guid,,text,,,,timestamp`, and everything the app wrote into
 * one it wrote a row at a time -- through addOrModifyStrings, keyed by a block's GUID.
 * That covers adding text and nothing else: a typo three rows down, a row for a GUID no
 * block references any more, or a file DDS never names at all (room names, job titles,
 * evidence names) had no way to be touched here.
 *
 * So the editor is the file, as text. No columns, no parsing, no validation -- a CSV
 * this app half-understood would be worse than one it left alone, and the shape of a
 * row is the author's to keep.
 *
 * There is one window for it, beside the tree -> message -> block drill-down rather
 * than inside it. A strings file is not a level of that cascade, and the reason to have
 * it open is usually the block in the window next to it.
 *
 * The catch is the cache. Block text is read once into window.stringMapping and
 * window.moddedStringMapping (see loadI18n) and resolved into each open document as it
 * loads (see createDummyKeys), so editing the file a mod's block text lives in leaves
 * both stale. Saving reseeds them; see afterSave.
 */
import { fastElement } from '../../../core/dom.js';
import { readFileContent, writeFile } from '../../../core/fs.js';
import { assertModSelected, shouldSave } from '../../../core/persistence.js';
import { closeWindow, createTreeWindow } from '../../../core/treeWindow.js';
import { DDS_BLOCKS_VIRTUAL, readManifest, stringsFileHandle, toReal, toVirtual } from './ddsManifest.js';
import { ddsContentFolder } from './modFileManager.js';
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
        windowEl: null,
        textarea: null,
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

    const textarea = fastElement('textarea', 'strings-text');
    textarea.value = text;
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', `${openFile.virtual} contents`);
    textarea.addEventListener('input', () => markDirty(true));
    // Autosave writes on the way out, the way an edited tree value does. With autosave
    // off this does nothing and the Save button is the only writer.
    textarea.addEventListener('blur', () => save(false));
    treeEl.appendChild(textarea);

    openFile.windowEl = windowEl;
    openFile.textarea = textarea;
}

function markDirty(dirty) {
    openFile.dirty = dirty;
    // Shown, because unsaved text here is text that a write from elsewhere will not
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
async function save(force) {
    if (!openFile) return;
    if (!force && !(openFile.dirty && shouldSave(false))) return;

    assertModSelected();

    const { ddsFolder } = await contentAndManifest(true);
    const handle = await stringsFileHandle(ddsFolder, openFile.real, true);
    await writeFile(handle, openFile.textarea.value, false);

    // Written for the first time, so there is now a file to be identified by.
    openFile.handle = handle;

    markDirty(false);
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
 * at what the file was a moment ago. Unsaved text is left exactly as it is: it is work
 * that re-reading would throw away, and the window marks itself as unsaved.
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

    openFile.textarea.value = openFile.handle
        ? (await readFileContent(openFile.handle)) ?? ''
        : '';
}

/**
 * Close the window.
 *
 * @param discard skip the confirmation, for a close the user did not ask for
 */
export function closeStringsWindow(discard) {
    // Clicking any control moves focus out of the textarea first, so with autosave on
    // the text is already written. With it off, this is the only thing between typing
    // and losing it.
    if (!discard && openFile?.dirty && !confirm('Discard unsaved changes to this file?')) return;

    closeWindow(document.getElementById(STRINGS_WINDOW_ID));
    openFile = null;
}

/** The file the window holds, for the session capture. Null when it is closed. */
export function openStringsPath() {
    return openFile?.real ?? null;
}
