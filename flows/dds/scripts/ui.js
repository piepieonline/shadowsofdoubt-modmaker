import { GUID_PATTERN } from '../../../core/guid.js';
import { loadVanillaStrings } from './fileManager.js';
import { createNewFile } from './modFileManager.js';
import { renderFilePanel } from '../../../core/filePanel.js';
import { WINDOW_DEPTHS, deleteTree } from './jsonTreeAdditions.js';
import { listContent, STRINGS_OPEN_AS } from './contentList.js';
import { deleteDocument, deleteStringsFile } from './deleteDocument.js';
import { refreshManifestPanel } from './manifestPanel.js';
import { closeStringsWindow, openStringsFile, openStringsPath } from './stringsEditor.js';
import { decodeList, encodeList } from '../../../core/urlState.js';
import { chain, LEVELS, occurrences } from './reverseSearch.js';
import { initAndLoad, loadI18n, loadFile } from '../index.js';

/**
 * Pick up folders connected by the shell: load the vanilla strings and rebuild the
 * mod list. Called on activation and whenever a folder changes.
 */
/** Load the vanilla strings once the game folder is connected. */
export async function onFoldersConnected() {
    if (!window.dirHandleStreamingAssets) return;

    await loadVanillaStrings();
}

/**
 * A content folder was chosen in the shell. Reload the strings, which merge the mod's
 * own over the vanilla ones.
 *
 * Nothing is created here. Looking at a folder is not a reason to plant a DDS layout
 * in it -- the folders appear when there is a document to put in them.
 */
export async function onModSelected(selection) {
    if (window.dirHandleStreamingAssets) {
        await loadI18n();
    }

    // An open strings file belongs to the mod it was opened from, and is identified by
    // a path relative to that mod's content folder -- which another mod can have a file
    // of its own at. Saving after a switch would write into the wrong one.
    closeStringsWindow(true);

    await refreshManifestPanel();
    await refreshPanel();
}

/** Rebuild the left-hand list of what this mod contains. */
export async function refreshPanel() {
    renderFilePanel(
        '#dds-file-list',
        withDeleteActions(await listContent(window.selectedMod?.baseFolder ?? null)),
        openPanelEntry,
        'Choose a mod and content folder to see what it contains.'
    );
}

/**
 * Give every entry the button that removes it.
 *
 * Every one of them, strings CSVs included: this panel lists the mod's own DDSContent and
 * nothing else, so all of it is the author's. A patch is the interesting case -- deleting
 * one is how a mod stops overriding a piece of base game content, and the base game file
 * it was written against is untouched by it.
 *
 * Attached here rather than in `contentList.js`, which answers what the folder holds and
 * has no view on what may be done about it.
 */
function withDeleteActions(categories) {
    if (!categories) return categories;

    return categories.map((category) => ({
        ...category,
        entries: category.entries.map((entry) => ({
            ...entry,
            action: {
                label: '×',
                title: `Delete ${entry.label} from this mod`,
                danger: true,
                onClick: () => removeEntry(entry),
            },
        })),
    }));
}

/**
 * Delete what an entry stands for, once its author has seen what pointed at it.
 *
 * Whatever was showing the file is closed first, and only once the file is really gone. A
 * window left open over a deleted file is one save away from writing it back out, and
 * nothing would say that had happened.
 */
async function removeEntry(entry) {
    const folder = window.selectedMod?.baseFolder;
    if (!folder) return;

    if (entry.openAs === STRINGS_OPEN_AS) {
        // A strings entry's id is the path it really sits at below DDSContent, which is
        // what the manifest maps and what identifies it -- two languages hold files of
        // the same name.
        if (!await deleteStringsFile(folder, { id: entry.id, label: entry.label })) return;

        if (openStringsPath() === entry.id) closeStringsWindow(true);

        // Block text is resolved into a document as it loads, so the documents still open
        // are showing lines that have just been deleted.
        await loadI18n();
        await reloadOpenDocuments();

        // The deleted file may have been one the manifest placed.
        await refreshManifestPanel();
    } else {
        // `openAs` is which of the three kinds of document it is, which says both where
        // the file sits and, with `file`, which of the two forms of it is on disk.
        const target = { id: entry.id, file: entry.file, type: entry.openAs, label: entry.label };
        if (!await deleteDocument(folder, target)) return;

        closeDocumentWindows(entry.id);
    }

    await refreshPanel();
}

/**
 * Close the window showing a document, and the levels below it.
 *
 * By GUID rather than by path, because the window records the path of the *base game*
 * file -- a patch is a sibling of it and is never what a window is opened under. The
 * levels below go too: they were reached by drilling down through the document that has
 * just been deleted.
 */
function closeDocumentWindows(id) {
    for (let depth = 0; depth < WINDOW_DEPTHS; depth++) {
        const path = document.getElementById(`file-window-${depth}`)?.getAttribute('path');
        if (path?.includes(id)) {
            deleteTree(depth);
            return;
        }
    }
}

/**
 * Open whatever was clicked in the panel.
 *
 * A strings file is text rather than a document, and opens in a window of its own
 * beside the drill-down; everything else is a level of it.
 */
async function openPanelEntry(entry) {
    if (entry.openAs === STRINGS_OPEN_AS) {
        // The entry's id is the path on disk, which is what identifies the file.
        await openStringsFile(entry.id);
        return;
    }

    await openDdsFile(entry.id, entry.openAs);
}

/**
 * Open a document from the panel.
 *
 * A mod's own files are not in the generated reference data, so their type cannot be
 * inferred -- the panel knows it and says so here.
 */
export async function openDdsFile(id, type) {
    await loadDocument(id, type);
}

/** Open a document whose type the caller may or may not know. */
export async function setIdAndLoad(id, type = null) {
    await loadDocument(id, type);
}

/** Where each kind of document is read from, below the content root. */
const DOCUMENT_PATHS = {
    tree: { prefix: 'DDS/Trees/', postfix: '.tree' },
    message: { prefix: 'DDS/Messages/', postfix: '.msg' },
    block: { prefix: 'DDS/Blocks/', postfix: '.block' },
};

/**
 * The type of the last document opened, for a GUID nothing can say the type of.
 *
 * This is what the type dropdown in the nav bar used to hold. It was there to be read
 * at exactly this point, and every other thing it did -- being set by the panel, by a
 * new document, by the lookup below -- was keeping it honest for this one read.
 */
let lastType = 'tree';

/** The type the generated reference data gives a base game GUID, if it knows it. */
function vanillaType(id) {
    if (window.ddsMap?.trees?.includes(id)) return 'tree';
    if (window.ddsMap?.messages?.includes(id)) return 'message';
    if (window.ddsMap?.blocks?.includes(id)) return 'block';
    return null;
}

/**
 * Open a DDS document by GUID.
 *
 * The reference data is asked first and the caller second, as it always was: a base
 * game GUID is only ever the type the game gives it, whatever the caller thinks.
 *
 * @param openTheseIds the levels to open below this one, outermost first. Omitted by
 *        everything that has no route in mind, which cascades into the first message
 *        and the first block as before.
 */
export async function loadDocument(id, type = null, openTheseIds = null) {
    // Folders are connected by the shell before any flow runs, so this only loads.
    if (!GUID_PATTERN.test(id)) {
        alert('Invalid GUID format, please check and try loading again');
        return;
    }

    const fileType = vanillaType(id) ?? type ?? lastType;
    lastType = fileType;

    const { prefix, postfix } = DOCUMENT_PATHS[fileType];
    await initAndLoad(prefix + id + postfix, openTheseIds);
}

/**
 * Create a document and open it.
 *
 * @param templateData an existing document to copy; omitted for a fresh one
 * @param options      name, and the English line its block says. See createNewFile.
 */
export async function newFile(type, templateData, options) {
    if (window.selectedMod == null) {
        alert('Please select a mod to edit first');
        throw 'Please select a mod to edit first';
    }

    let newGUID = await createNewFile(type, templateData, options)

    await loadDocument(newGUID, type);
    await refreshPanel();
}

/** Pico dialogs: open/close via the `open` property rather than a class. */
export function openModal(selector) {
    document.querySelector(selector).setAttribute('open', '');
}

export function closeModal(selector) {
    document.querySelector(selector).removeAttribute('open');
}

export function showHelp() {
    openModal('#help-modal');
}


export function showBrowse() {
    updateBrowse();
    updateBrowseTypeahead();
    openModal('#fav-modal');
}

export function updateBrowse() {
    const browseTypeSelector = document.querySelector('#browse-type-select');
    const browseList = document.querySelector('#fav-list');

    browseList.replaceChildren();

    let listToShow;

    if (browseTypeSelector.value === 'fav') {
        listToShow = JSON.parse(localStorage.getItem('favs'));
    } else {
        listToShow = window.ddsMap[browseTypeSelector.value].sort((a, b) => window.ddsMap.idNameMap[a].localeCompare(window.ddsMap.idNameMap[b])).map(id => ({
            guid: id,
            name: window.ddsMap.idNameMap[id]
        }));
    }

    // A favourite carries the type it was saved with, which a mod's own document needs
    // -- only base game GUIDs are in the reference data to be looked up. Everything
    // else in this list is base game, so it passes nothing and is recognised.
    document.getElementById('fav-list').innerHTML = listToShow.map(fav =>
        `<li><span class="link-element" onclick="setIdAndLoad('${fav.guid}'${fav.type ? `, '${fav.type}'` : ''});">${fav.guid}</span>: ${fav.name}</li>`
    ).join('');
}

export function updateBrowseTypeahead() {
    const browseTypeAheadSelector = document.querySelector('#browse-typeahead');
    const browseList = document.querySelector('#fav-list');

    browseList.querySelectorAll('li').forEach(element => {
        let visible = false;
        if (browseTypeAheadSelector.value === "")
            visible = true;
        else if (element.innerText.toLocaleLowerCase().indexOf(browseTypeAheadSelector.value.toLocaleLowerCase()) !== -1)
            visible = true;

        if (visible)
            element.classList.remove('hidden')
        else
            element.classList.add('hidden')
    });
}

window.toggleFav = (guid, type) => {
    let favs = JSON.parse(localStorage.getItem('favs'));

    let currentFav = favs.find(ele => ele.guid === guid);

    if (currentFav) {
        favs.splice(favs.indexOf(currentFav), 1);
    } else {
        let name = prompt('Name this favourite:', window.ddsMap.idNameMap[guid]);
        if (name) {
            favs.push({
                mod: window.selectedMod,
                type,
                guid,
                name
            });
        }
    }

    localStorage.setItem('favs', JSON.stringify(favs));

    return !currentFav;
}

export function showReverseSearch() {
    openModal('#rsearch-modal');
}

window.createRSearchList = () => {
    const researchList = document.querySelector('#rsearch-text-list');

    researchList.replaceChildren();

    let listToShow = window.vanillaDDSStringsContent;

    window.rSearchList = [];

    listToShow.forEach((result, i) => {
        let mapping = result.match(/"?(.{36})"?,.*?,"?(.*)"?,"?.*?"?,"?.*?"?,"?.*?"?,/);

        if (!mapping) {
            console.log(`Error with line ${i}: ${result}`)
            return;
        }

        window.rSearchList.push({ id: mapping[1], str: mapping[2].toLocaleLowerCase() });

        let newEle = document.createElement('li');
        newEle.innerText = mapping[2].replace(/",$/, '');
        newEle.setAttribute('x-guid', mapping[1]);
        newEle.classList.add('link-element');
        researchList.appendChild(newEle);

        newEle.addEventListener('click', () => {
            updateRSearchResultsTable(mapping[1]);
        });
    });
}

export function updateRSearch() {
    const rsearchTypeaheadValue = document.querySelector('#rsearch-typeahead').value.toLocaleLowerCase();
    const researchList = document.querySelector('#rsearch-text-list').querySelectorAll('li');

    window.rSearchList.forEach(({ id, str }, i) => {
        let visible = false;
        if (rsearchTypeaheadValue === "")
            visible = true;
        else if (str.indexOf(rsearchTypeaheadValue) !== -1)
            visible = true;
        else if (id.indexOf(rsearchTypeaheadValue) !== -1)
            visible = true;

        if (visible)
            researchList[i].classList.remove('hidden')
        else
            researchList[i].classList.add('hidden')
    });
}

/**
 * Show every place a searched line is said: one row per drill-down that reaches it.
 *
 * A row is the whole chain rather than the tree at the top of it. The same block under
 * two messages of one tree is two rows, which are two different things to open -- and
 * were indistinguishable while this listed only the top level.
 */
export function updateRSearchResultsTable(id) {
    const found = occurrences(window.ddsMap.reverseIdMap, vanillaType, id);

    document.querySelector('#rsearch-result-view').replaceChildren(
        ...(found.length ? found.map(occurrenceRow) : [noOccurrencesRow()])
    );
}

/** One place the line is said, as the tree, message and block that reach it. */
function occurrenceRow(levels) {
    const row = document.createElement('tr');
    row.classList.add('rsearch-occurrence');
    row.append(...LEVELS.map((level) => documentCell(levels[level])));
    row.addEventListener('click', () => openOccurrence(levels));

    return row;
}

/**
 * One level of a row: what the document is called, with the GUID behind it.
 *
 * The name is what a row is read by; the GUID is what it is, and is on the cell rather
 * than in it so that a row stays readable. A document the reference data has no name for
 * shows its GUID, which is all there is to show.
 */
function documentCell(id) {
    const cell = document.createElement('td');

    if (!id) {
        // Nothing at this level holds the line -- a block reached by no message, say.
        // Saying so beats an empty cell, which reads as a level not yet drawn.
        cell.innerText = '—';
        cell.classList.add('rsearch-empty-level');
        return cell;
    }

    cell.innerText = window.ddsMap.idNameMap[id] || id;
    cell.title = id;

    return cell;
}

function noOccurrencesRow() {
    const row = document.createElement('tr');
    const cell = document.createElement('td');

    // The index covers the base game only, so a mod's own content is not missing from
    // it so much as never in it. Worth saying either way.
    cell.colSpan = LEVELS.length;
    cell.innerText = 'No base game tree, message or block says this line.';
    row.append(cell);

    return row;
}

/**
 * Open one occurrence: the tree, the message under it that holds the block, and the
 * block that says the line.
 *
 * The levels below the first are named rather than left to the cascade, which opens the
 * first message and the first block of whatever it is given.
 */
async function openOccurrence(levels) {
    // There is always a first: a row with no level to open is not a row at all.
    const [top, ...below] = chain(levels);

    await loadDocument(top, null, below);
}


/**
 * The open documents, deepest level included.
 *
 * The three windows are levels of one drill-down, so their depth is part of the
 * state -- reopening only the top level would rebuild the cascade from its first
 * message and block, which is not necessarily where you were.
 */
function captureDocuments() {
    const open = [];

    for (let depth = 0; depth < WINDOW_DEPTHS; depth++) {
        const path = document.getElementById(`file-window-${depth}`)?.getAttribute('path');
        if (path) open.push({ depth, path });
    }

    return open;
}

/**
 * Open one level of the drill-down.
 *
 * An entry is normally the path of the file the window is showing. A bare GUID is the
 * other form: it names a document without saying which of the three kinds it is, which
 * is what a link to a document can reasonably know -- the modding wiki's links say only
 * a GUID, and so does a reference followed out of a case file. `loadDocument` works the
 * kind out from the reference data.
 */
async function openEntry(entry, depth) {
    if (GUID_PATTERN.test(entry)) {
        await loadDocument(entry);
    } else {
        await loadFile(entry, depth);
    }
}

async function restoreDocuments(documents) {
    if (!documents?.length) return;

    // Shallowest first: opening a level cascades into the ones below it, so each
    // deeper entry then puts back what was actually there.
    for (const { depth, path } of [...documents].sort((a, b) => a.depth - b.depth)) {
        await loadFile(path, depth);
    }
}

/**
 * Load every open document again.
 *
 * For after the strings have changed underneath them: English text is resolved into a
 * document as it loads, so re-reading from disk is what shows the new text. The strings
 * window is deliberately not part of this -- it is what did the changing.
 */
export async function reloadOpenDocuments() {
    await restoreDocuments(captureDocuments());
}

/**
 * What is open, as URL parameters: the drill-down, and the strings file beside it.
 *
 * The drill-down is a list indexed by depth rather than a single document, because
 * reopening only the top level would rebuild the cascade from its first message and
 * block -- which is not necessarily where you were.
 */
export function sessionState() {
    return {
        open: encodeList(captureDocuments().map(({ path }) => path)),
        strings: openStringsPath(),
    };
}

export async function restoreSession(params) {
    if (!params) return;

    // The index in the list is the depth: with three levels of one drill-down, a level
    // cannot be open without the one above it, so the list has no gaps to record.
    const entries = decodeList(params.open);
    for (const [depth, entry] of entries.entries()) {
        await openEntry(entry, depth);
    }

    // Last, so a reload triggered by the documents cannot land on a half-open window.
    if (params.strings) await openStringsFile(params.strings);
}
