import { GUID_PATTERN } from '../../../core/guid.js';
import { loadVanillaStrings } from './fileManager.js';
import { createNewFile } from './modFileManager.js';
import { renderFilePanel } from '../../../core/filePanel.js';
import { WINDOW_DEPTHS } from './jsonTreeAdditions.js';
import { listContent, STRINGS_OPEN_AS } from './contentList.js';
import { refreshManifestPanel } from './manifestPanel.js';
import { closeStringsWindow, openStringsFile, openStringsPath } from './stringsEditor.js';
import { initAndLoad, loadI18n, loadFile } from '../index.js';

/**
 * Pick up folders connected by the shell: load the vanilla strings and rebuild the
 * mod list. Called on activation and whenever a folder changes.
 */
/** Load the vanilla strings once the game folder is connected. */
export async function onFoldersConnected() {
    if (!window.dirHandleStreamingAssets) return;

    await loadVanillaStrings();

    // A deep link arrives before any folder is connected, and a document cannot be
    // read until one is. Taken rather than read, so a second folder change does not
    // reopen it over whatever is being looked at by then.
    const pending = pendingDocument;
    pendingDocument = null;
    if (pending) await loadDocument(pending.id, pending.type);
}

/**
 * A document to open as soon as there is somewhere to read it from. See flow.js: the
 * old DDS Viewer's URLs name one, and the wiki links to them.
 */
let pendingDocument = null;

export function openWhenReady(id, type) {
    pendingDocument = { id, type };
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
        await listContent(window.selectedMod?.baseFolder ?? null),
        openPanelEntry,
        'Choose a mod and content folder to see what it contains.'
    );
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
 */
export async function loadDocument(id, type = null) {
    // Folders are connected by the shell before any flow runs, so this only loads.
    if (!GUID_PATTERN.test(id)) {
        alert('Invalid GUID format, please check and try loading again');
        return;
    }

    const fileType = vanillaType(id) ?? type ?? lastType;
    lastType = fileType;

    const { prefix, postfix } = DOCUMENT_PATHS[fileType];
    await initAndLoad(prefix + id + postfix);
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

export function updateRSearchResultsTable(blockId) {
    // .rsearch-result-view

    var cells = '';


    var blockCell = `<td><ul><li>${blockId}</li></ul></td>`;
    var messageId = window.ddsMap.reverseIdMap[blockId].join('</li><li>');
    var messageCell = `<td><ul><li>${messageId}</li></ul></td>`;
    var treeId = window.ddsMap.reverseIdMap[messageId].join('</li><li>');
    var treeList = `<td><ul><li>${treeId}</li></ul></td>`;

    var openList = {};

    let currentId = blockId;
    while (window.ddsMap.reverseIdMap[currentId] != null) {
        // TODO: Show trees only? How to display this
        cells = '<td><ul>' +
            window.ddsMap.reverseIdMap[currentId]
                .filter((value, index, array) => array.indexOf(value) === index) // One result per tree/message found contained in
                .map(id => ({ name: window.ddsMap.idNameMap[id], id }))
                .map(ele => `<li class="link-element" x-guid=${ele.id}>${window.ddsMap.idNameMap[ele.id] || ele.id}</li>`)
                .join('')
            + '</ul></td>'; // + cells;
        currentId = window.ddsMap.reverseIdMap[currentId];
    }


    var rows = `<tr>${cells}</tr>`;


    /*
    var treeIds = {};
    var messageIds = {};

    window.ddsMap.reverseIdMap[guid].forEach(messageId => {
        if(messageIds[messageId] == null ) messageIds[messageId] = {};
        messageIds[messageId].push(guid);
        window.ddsMap.reverseIdMap[messageId].forEach(treeId => {
            if(treeIds[treeId] == null ) treeIds[treeId] = {};
            treeIds[treeId].push(messageId);
        })
    });

    var rows = [];
    Object.keys(treeIds).forEach(treeId => {
        let messages = '<ul>';
        treeIds[treeId].forEach(messageId => {
            messages += `<li>${messageId}</li>`;
        });
        messages += '</ul>';

        var row = `<tr><td>${treeId}</td><td>${messages}</td><td>${}</td></tr>`;
    })
        */

    document.querySelector('#rsearch-result-view').innerHTML = rows; // `<tr><td>${}</td><td>${}</td></tr>`;

    document.querySelector('#rsearch-result-view').querySelectorAll('li').forEach(liEle => {
        liEle.addEventListener('click', () => {
            setIdAndLoad(liEle.getAttribute('x-guid'));
        });
    })
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

/** What is open, so it can be put back after a trip to another editor. */
export function captureSession() {
    return { documents: captureDocuments(), strings: openStringsPath() };
}

export async function restoreSession(session) {
    if (!session) return;

    await restoreDocuments(session.documents);

    // Last, so a reload triggered by the documents cannot land on a half-open window.
    if (session.strings) await openStringsFile(session.strings);
}
