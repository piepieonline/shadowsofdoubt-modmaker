import { selectFolder } from '../../../core/folders.js';

import { scaffoldCase } from './modFileManager.js';
import { renderFilePanel } from '../../../core/filePanel.js';
import { listContent } from './contentList.js';
import { initAndLoad, loadFile, loadFileFromFolder, loadFileFromOnlineRepo, showNewCasePopup, closeNewCasePopup } from '../index.js';

// Autosaving INIT
/**
 * Startup for this flow.
 *
 * Was a DOMContentLoaded handler, which no longer works in the shell: the flow's
 * markup is mounted on activation, which can be after the document has finished
 * parsing, and the handler would run against markup that is not there yet -- or not
 * run at all.
 */
export function startFlow() {
	document.querySelector('#new-file-modal-file-type').innerHTML = document.querySelector('#asset-model-type-list').innerHTML;

	if(window.queryParams.viewOnly) {
		enableAssetOnlyMode(window.queryParams.openDefaultFiles);
	}

	if(window.queryParams.openDefaultFiles) {
		let openDefaultFiles;
		try
		{
			JSON.parse(window.queryParams.openDefaultFiles).forEach(file => {
				loadFileFromOnlineRepo(file.type + '/' + file.name + ".json", file.type);
			});
		}
		catch {}
	}
}

//Manifest Panel
export function toggleManifestPanel() {
	document.querySelector('#manifest_panel .jsontree-container').classList.toggle("hidden");
	document.querySelector('#manifest_panel .files-order').classList.toggle("hidden");
}

export function shareOpen() {
	let openFiles = [...document.querySelectorAll('.file-window')].map(el => el.getAttribute('path').split('.')[0]).map(file => ({
		type: file.split('/')[0],
		name: file.split('/')[1]
	}));

	navigator.clipboard.writeText(`${location.href.replace('/' + location.search, '')}/?openDefaultFiles=${JSON.stringify(openFiles)}&viewOnly=true`).then(() => {
		alert('Link copied to clipboard');
	})
}

// Assets loading
/**
 * Pick up folders connected by the shell and rebuild the mod list. Called on
 * activation and whenever a folder changes.
 */
/**
 * Having somewhere to write is what editing mode means. This is also the only way
 * back out of the view-only mode a shared link opens in -- the "Enable Editing Mode"
 * button that used to do it did nothing this does not, and the header has no room
 * for a control that duplicates connecting a folder.
 */
export async function onFoldersConnected() {
	toggleEditMode(Boolean(window.dirHandleModDir));
}

/** A content folder was chosen in the shell: show its manifest and its files. */
export async function onModSelected(selection) {
	document.getElementById('manifest_content_tree').replaceChildren();

	if (selection) {
		await initAndLoad('murdermanifest');
	}

	await refreshPanel();
}

/** Rebuild the left-hand list of everything in the folder, grouped by type. */
export async function refreshPanel() {
	renderFilePanel(
		'#so-file-list',
		await listContent(window.selectedMod?.baseFolder ?? null),
		(entry) => loadFile(entry.id, false, entry.openAs, entry.suffix),
		'Choose a mod and content folder to see what it contains.'
	);
}

export async function enableAssetOnlyMode(skipAssetModel) {
	toggleEditMode(false);
	if(!skipAssetModel)
		document.querySelector('#asset-explorer-modal').toggleAttribute('open')
}

export async function toggleEditMode(editingMode) {
	document.getElementById('manifest_panel').classList.toggle('hidden', !editingMode)
	document.getElementById('files-section-container').classList.toggle('file-section-edit-mode', editingMode)
	document.getElementById('editing-mode-control-group').classList.toggle('hidden', !editingMode)
	document.getElementById('viewing-mode-control-group').classList.toggle('hidden', editingMode)
}


// Murder loading
/**
 * The shell is about to create a content folder: ask what kind of case goes in it, and
 * answer with how to lay it out.
 *
 * A case is a manifest plus, usually, the preset it revolves around. The folder itself
 * and its name are the shell's, so this only asks what it alone knows.
 */
export async function newContent(name) {
	const chosen = await showNewCasePopup();
	closeNewCasePopup();

	if (!chosen) return null;

	return (folder) => scaffoldCase(folder, name, chosen.type);
}

export function toggleDefaultValues() {
	document.querySelectorAll('.default-value-node').forEach(ele => {
		ele.classList.toggle('hidden-default-value-node');
	});
}

export function updateAssetModel(rebuildList, hasLocalFiles) {
	let typeListEle = document.getElementById('asset-model-type-list');
	
	if(rebuildList)
	{
		typeListEle.innerHTML = '';
		let typeList = Object.keys(window.typeMap).sort();

		if(!hasLocalFiles) {
			typeList = [
				...window.onlineTypes,
				'------',
				...typeList.filter(type => !window.onlineTypes.includes(type))
			];
		}

		typeList.forEach(type => {
			var option = document.createElement("option");
			option.text = type;
			typeListEle.appendChild(option);
		});
	}

	let assetList = document.getElementById('asset-model-asset-list');
	assetList.innerHTML = '';

	window.typeMap[typeListEle.value]?.sort().forEach(SO => {
		let tr = document.createElement('tr');
		var option = document.createElement("td");
		option.innerText = SO;

		if(window.dirHandleExportedSOPath) {
			option.classList.add('link-element');
			option.addEventListener('click', (e) => {
				loadFileFromFolder(typeListEle.value + '/' + SO + ".json", window.dirHandleExportedSOPath, true, typeListEle.value);
			});
		} else if(window.onlineTypes.includes(typeListEle.value)) {
			option.classList.add('link-element');
			option.addEventListener('click', (e) => {
				loadFileFromOnlineRepo(typeListEle.value + '/' + SO + ".json", typeListEle.value);
			});
		}
		tr.appendChild(option)
		assetList.appendChild(tr);
	});

	assetList.classList.toggle('asset-loaded-link', window.dirHandleExportedSOPath || window.onlineTypes.includes(typeListEle.value))
}

export function updateNewFileCopyFrom() {
	let type = document.querySelector('#new-file-modal-file-type').value;
	let ele = document.querySelector('#new-file-modal-copy-from');
	ele.replaceChildren();
	// The type select is filled from the asset model list, which can name types the
	// map has nothing for. Spreading undefined there threw and left the list empty.
	['None', ...(window.typeMap[type]?.sort() ?? [])].forEach(SO => {
		var option = document.createElement("option");
		option.text = SO;
		ele.appendChild(option);
	});
	// Repopulating drops the selection back to None, which the mode may not allow.
	updateNewFileSubmitState();
}

/** Which half of the new file dialog's Copy From / Override choice is selected. */
export function newFileMode() {
	return document.querySelector('.new-file-mode button[aria-pressed="true"]')?.dataset.mode ?? 'copy';
}

/**
 * Copy From / Override. An override is named after the asset it overrides, so the
 * File Name field is not the mod author's to fill in while Override is selected.
 */
export function setNewFileMode(mode) {
	document
		.querySelectorAll('.new-file-mode button')
		.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));

	let fileName = document.querySelector('#new-file-modal-file-name');
	fileName.disabled = mode === 'override';
	fileName.title = fileName.disabled ? 'An override takes the name of the file it overrides' : '';

	updateNewFileSubmitState();
}

/** Overriding needs a file to override, so None leaves nothing to create. */
export function updateNewFileSubmitState() {
	let overriding = newFileMode() === 'override';
	let submit = document.querySelector('#new-file-modal-submit');

	submit.disabled = overriding && document.querySelector('#new-file-modal-copy-from').value === 'None';
	submit.title = submit.disabled ? 'Choose the file to override' : '';
}

export function updateSelectAllCopyFrom() {
	let checked = document.querySelector('#select-fields-modal-select-all').checked;
	document
		.querySelector('#select-fields-modal-field-list')
		.querySelectorAll('input[type="checkbox"]')
		.forEach((checkbox) => {
			checkbox.checked = checked;
		});
}

export async function loadExportedSOs() {
	// One of the shared folders now, so it is remembered and reconnected like the rest.
	if (await selectFolder('exportedSOs')) {
		updateAssetModel(true, true);
	}
}


/**
 * What is open, so it can be put back after a trip to another editor.
 *
 * Only the tree area: the manifest panel reopens itself when the content folder is
 * applied, and is not something you can close.
 */
export function captureSession() {
	return [...document.querySelectorAll('#trees .file-window')]
		.map((el) => el.getAttribute('path'))
		.filter(Boolean);
}

export async function restoreSession(paths) {
	if (!paths?.length || !window.selectedMod) return;

	for (const path of paths) {
		await loadFileFromFolder(path, window.selectedMod.baseFolder, false);
	}
}
