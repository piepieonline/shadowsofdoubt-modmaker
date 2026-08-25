import { GUID_PATTERN } from '../../../core/guid.js';
import { loadVanillaStrings } from './fileManager.js';
import { createNewFile } from './modFileManager.js';
import { renderFilePanel } from '../../../core/filePanel.js';
import { WINDOW_DEPTHS } from './jsonTreeAdditions.js';
import { listContent, STRINGS_OPEN_AS } from './contentList.js';
import { refreshManifestPanel } from './manifestPanel.js';
import { initAndLoad, loadI18n, loadFile } from '../index.js';

/**
 * Pick up folders connected by the shell: load the vanilla strings and rebuild the
 * mod list. Called on activation and whenever a folder changes.
 */
/** Load the vanilla strings once the game folder is connected. */
export async function onFoldersConnected() {
    if (window.dirHandleStreamingAssets) {
        await loadVanillaStrings();
    }
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
 * A strings file has no editor yet. It is still listed as a button, because it is a
 * file of the mod's like any other and will open one when there is one.
 */
async function openPanelEntry(entry) {
    if (entry.openAs === STRINGS_OPEN_AS) return;

    await openDdsFile(entry.id, entry.openAs);
}

/**
 * Open a document from the panel.
 *
 * A mod's own files are not in the generated reference data, so loadFromGUI cannot
 * infer their type -- the panel knows it and sets it here.
 */
export async function openDdsFile(id, type) {
    // Only when the caller knows: loadFromGUI recognises base game GUIDs itself, and
    // a type of null would leave the select on something meaningless.
    if (type) document.getElementById('select-guid-type').value = type;
    await setIdAndLoad(id);
}

export async function setIdAndLoad(id) {
    document.getElementById('path-to-read').value = id;
    loadFromGUI();
}

export async function loadFromGUI() {
    // Folders are connected by the shell before any flow runs, so this only loads.
    let fileID = document.getElementById('path-to-read').value;

    if (!GUID_PATTERN.test(fileID)) {
        alert('Invalid GUID format, please check and try loading again');
        return;
    }

    let fileType = '';
    if (window.ddsMap.trees.indexOf(fileID) != -1) fileType = 'tree';
    else if (window.ddsMap.messages.indexOf(fileID) != -1) fileType = 'message';
    else if (window.ddsMap.blocks.indexOf(fileID) != -1) fileType = 'block';
    else fileType = document.getElementById('select-guid-type').value;

    document.getElementById('select-guid-type').value = fileType;

    var prefix = '', postfix = '';
    switch (fileType) {
        case 'tree': prefix = "DDS/Trees/"; postfix = ".tree"; break;
        case 'message': prefix = "DDS/Messages/"; postfix = ".msg"; break;
        case 'block': prefix = "DDS/Blocks/"; postfix = ".block"; break;
    }

    await initAndLoad(prefix + fileID + postfix);
}

export async function newFile(type, templateData) {
    if (window.selectedMod == null) {
        alert('Please select a mod to edit first');
        throw 'Please select a mod to edit first';
    }

    let newGUID = await createNewFile(type, templateData)

    document.getElementById('path-to-read').value = newGUID;
    document.getElementById('select-guid-type').value = type;

    await loadFromGUI();
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

    document.getElementById('fav-list').innerHTML = listToShow.map(fav =>
        `<li><span class="link-element" onclick="setIdAndLoad('${fav.guid}');">${fav.guid}</span>: ${fav.name}</li>`
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
 * What is open, so it can be put back after a trip to another editor.
 *
 * The three windows are levels of one drill-down, so their depth is part of the
 * state -- reopening only the top level would rebuild the cascade from its first
 * message and block, which is not necessarily where you were.
 */
export function captureSession() {
    const open = [];

    for (let depth = 0; depth < WINDOW_DEPTHS; depth++) {
        const path = document.getElementById(`file-window-${depth}`)?.getAttribute('path');
        if (path) open.push({ depth, path });
    }

    return open;
}

export async function restoreSession(open) {
    if (!open?.length) return;

    // Shallowest first: opening a level cascades into the ones below it, so each
    // deeper entry then puts back what was actually there.
    for (const { depth, path } of [...open].sort((a, b) => a.depth - b.depth)) {
        await loadFile(path, depth);
    }
}
