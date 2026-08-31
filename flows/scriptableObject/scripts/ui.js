import { scaffoldCase } from './modFileManager.js';
import {
    renderFilePanel, filterCategories, withoutEntries, countEntries,
} from '../../../core/filePanel.js';
import { searchSelect } from '../../../core/components/searchSelect/searchSelect.js';
import { tryGetFile } from '../../../core/fs.js';
import { decodeList, encodeList, syncNow } from '../../../core/urlState.js';
import { listContent } from './contentList.js';
import { deleteAsset } from './deleteAsset.js';
import { forgetScannedTypes } from './assetScan.js';
import { initAndLoad, loadFile, loadFileFromFolder, loadFileFromOnlineRepo, openBaseGameAsset, reloadManifestPanel, showNewCasePopup, closeNewCasePopup, Source } from '../index.js';

//Manifest Panel
export function toggleManifestPanel() {
	document.querySelector('#manifest_panel .jsontree-container').classList.toggle("hidden");
	document.querySelector('#manifest_panel .files-order').classList.toggle("hidden");
}

/**
 * What Help/Summary in the bar's Tools menu opens.
 *
 * Under the id the other two flows use for theirs, which is safe because only one flow
 * is mounted at a time -- and named as they name theirs, so the menu is the same markup
 * in all three bars rather than three ways of saying one thing. See the note above
 * showHelp in flows/building/scripts/ui.js.
 */
const HELP_MODAL = '#help-modal';

export function showHelp() {
	document.querySelector(HELP_MODAL)?.setAttribute('open', '');
}

export function closeHelp() {
	document.querySelector(HELP_MODAL)?.removeAttribute('open');
}

/**
 * A link to what is on screen.
 *
 * The URL already says what is open -- it is kept up to date as documents come and go
 * -- so this copies it rather than deriving a second, weaker description from the
 * window titles as it used to. `viewOnly` is what makes it a link to *read*: the
 * recipient sees the documents without the editing chrome for a mod folder they do not
 * have. Synced first, in case the last change has not settled yet.
 */
export async function shareOpen() {
	await syncNow();

	const url = new URL(location.href);
	url.searchParams.set('viewOnly', 'true');

	await navigator.clipboard.writeText(url.toString());
	alert('Link copied to clipboard');
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

	// Connecting the author's export is what turns the other seventy types from names
	// into assets that open, and it can happen at any time from the folders modal. Only
	// when that has actually changed: this is called for every folder, and rebuilding
	// the lists closes whichever of them is open.
	if (Boolean(window.dirHandleExportedSOPath) !== builtWithExport) updateAssetModel();

	// And what a field summary has already read, for the same reason: an export connected
	// mid-session is a different set of assets to answer from, and the ones read before it
	// arrived were whatever this tool happens to ship.
	forgetScannedTypes();
}

/** A content folder was chosen in the shell: show its manifest and its files. */
export async function onModSelected(selection) {
	document.getElementById('manifest_content_tree').replaceChildren();

	if (selection) {
		await initAndLoad('murdermanifest');
	}

	// A search left over from the last mod would narrow this one to a list of nothing,
	// and read as a folder with nothing in it. The filter beside it, for the same reason
	// and more so: it takes files out without anything having been typed to explain why.
	setFileSearch('');
	setFileFilters([]);

	await refreshPanel();
}

const FILE_SEARCH = '#so-file-search';
const FILE_FILTER = '#so-file-filter';
const FILE_HIDDEN = '#so-file-hidden';

/** What the panel is currently narrowed by, kept across the rebuilds below. */
let fileSearch = '';

/** The last listing, so a search can narrow it without going back to the folder. */
let listing = null;

/**
 * Rebuild the left-hand list of everything in the folder, grouped by type.
 *
 * Reads the folder, so it is the panel's slow path: it runs when what is in the folder
 * could have changed. Typing in the search box re-renders what this last found instead.
 */
export async function refreshPanel() {
	listing = withDeleteActions(await listContent(window.selectedMod?.baseFolder ?? null));
	renderPanel();
}

/**
 * Give every entry the button that removes it.
 *
 * Every one of them: the panel lists what is in the mod's own content folder, so all of it
 * is the author's to delete -- the assets it defines, the patches it applies over the base
 * game, and the files under Invalid, which are the ones most likely to want removing.
 *
 * Attached here rather than in `contentList.js`, which answers what the folder holds and
 * has no view on what may be done about it, and here rather than in `renderPanel`, which
 * runs on every keystroke in the search box.
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
 * Delete the file an entry stands for, once its author has seen what pointed at it.
 *
 * The window is closed before the panel is rebuilt, and only once the file is actually
 * gone. A document left open over a deleted file is one autosave away from writing it
 * back, and the author would have no way of telling that had happened.
 */
async function removeEntry(entry) {
	const folder = window.selectedMod?.baseFolder;
	if (!folder) return;

	const file = `${entry.id}${entry.suffix}`;

	const deleted = await deleteAsset(folder, {
		id: entry.id,
		suffix: entry.suffix,
		label: entry.label,
		// What a `REF:` to it resolves against, which is not always what the file is
		// called. See core/soFileName.js.
		assetName: entry.assetName,
		type: entry.openAs,
	});

	if (!deleted) return;

	document.querySelector(`#trees .file-window[path="${file}"]`)?.remove();

	await refreshPanel();
	// The load order no longer names it, and the panel beside this one is showing it.
	await reloadManifestPanel();
}

/**
 * Narrow the panel to files whose name -- or whose type -- contains `query`.
 *
 * A case folder is a flat list of every asset the mod defines, and a mod of any size
 * puts more of them in it than fit on the screen. Typing part of a name is how you get
 * to one; the alternative is reading down a dozen categories for it.
 */
export function filterFilePanel(query) {
	fileSearch = query ?? '';
	renderPanel();
}

/** Put the search box back to `value`, both the state and what the author can see. */
function setFileSearch(value) {
	fileSearch = value;

	const box = document.querySelector(FILE_SEARCH);
	if (box) box.value = value;
}

/**
 * Which kinds of file the panel has been asked not to show, as `roomPermissions.js` names
 * them. Empty is everything, which is why the menu holds no row saying so: not filtering
 * is what an untouched menu already means.
 */
let fileFilters = new Set();

/**
 * A box in the filter menu was ticked or unticked.
 *
 * The folder is not read again. What is filtered was worked out when each file was
 * parsed, so this is the same cheap path as typing in the search box.
 */
export function toggleFileFilter(kind, exclude) {
	if (exclude) fileFilters.add(kind);
	else fileFilters.delete(kind);

	renderPanel();
}

/** Put the filter back to `kinds`, both the state and what the boxes show. */
function setFileFilters(kinds) {
	fileFilters = new Set(kinds);

	for (const box of document.querySelectorAll(`${FILE_FILTER} input[type="checkbox"]`)) {
		box.checked = fileFilters.has(box.value);
	}
}

/** What a filtered panel holds altogether, however deeply it is grouped. */
const total = (categories) =>
	(categories ?? []).reduce((count, category) => count + countEntries(category), 0);

function renderPanel() {
	// Filtered first and searched second, so that what is typed searches what is on offer.
	// The unfiltered search is kept because the difference between the two is the number
	// of files the filter is holding back from this very list -- which is the honest
	// figure to report, rather than the count for the whole folder.
	const searched = filterCategories(listing, fileSearch);
	const shown = filterCategories(
		withoutEntries(listing, fileFilters.size ? (entry) => fileFilters.has(entry.permission) : null),
		fileSearch
	);

	const hidden = total(searched) - total(shown);
	showHiddenCount(hidden);

	// An empty panel says why it is empty, rather than being left to read as a folder that
	// has emptied. Two reasons now, and the filter is the one an author cannot see for
	// themselves: nothing was typed to explain it.
	const nothingLeft = Boolean(listing?.length) && shown.length === 0;
	const searchTerm = fileSearch.trim();

	renderFilePanel(
		'#so-file-list',
		nothingLeft ? null : shown,
		(entry) => loadFile(entry.id, false, entry.openAs, entry.suffix),
		nothingLeft ? emptyBecause(hidden, searchTerm)
			: 'Choose a mod and content folder to see what it contains.'
	);
}

/** Why a panel of a folder that holds files is showing none of them. */
function emptyBecause(hidden, searchTerm) {
	if (hidden > 0) {
		return searchTerm
			? `Everything called "${searchTerm}" here is hidden by the filter.`
			: 'Everything here is hidden by the filter.';
	}

	return `Nothing here is called "${searchTerm}".`;
}

/**
 * How much of the list the filter is keeping out of sight.
 *
 * Said out loud rather than left to the state of a button. A file browser that quietly
 * omits files is one an author reads as a folder that does not hold them -- the same
 * reason an empty panel gives its reason above.
 */
function showHiddenCount(hidden) {
	const line = document.querySelector(FILE_HIDDEN);
	if (line) {
		line.hidden = hidden === 0;
		line.textContent = `${hidden} ${hidden === 1 ? 'file' : 'files'} hidden by the filter`;
	}

	// And the button carries it too, for the moment the line is scrolled off the top.
	document.querySelector(FILE_FILTER)?.classList.toggle('filtering', fileFilters.size > 0);
}

export async function enableAssetOnlyMode(skipAssetModel) {
	toggleEditMode(false);
	if(!skipAssetModel)
		document.querySelector('#asset-explorer-modal').toggleAttribute('open')
}

export async function toggleEditMode(editingMode) {
	// Hiding the panel is the whole of it: the workspace is a flex row, so what is left
	// takes the width. It used to need a second class to swap the grid's columns over.
	document.getElementById('manifest_panel').classList.toggle('hidden', !editingMode)
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

/** The switch that says whether default values are on the screen. */
const HIDE_DEFAULTS = '#hide-default-values';

/** The switch was flipped: take every open document to where it now stands. */
export function toggleDefaultValues() {
	applyDefaultValueVisibility();
}

/**
 * Put every default-valued node into the state the switch is in.
 *
 * Set rather than flipped, one answer for all of them. A tree built while the switch was
 * already on marks its default values without hiding them, so its nodes stand opposite
 * to every other document's -- and flipping each node in turn then swapped the two halves
 * over, taking the newest file's defaults off the screen and putting the rest back on it,
 * whichever way the switch had just been moved.
 *
 * Called wherever those nodes are marked, so a document opened or rebuilt under a switch
 * that is already on arrives in the mode the author asked for.
 */
export function applyDefaultValueVisibility() {
	const hidden = Boolean(document.querySelector(HIDE_DEFAULTS)?.checked);

	document.querySelectorAll('.default-value-node').forEach(ele => {
		ele.classList.toggle('hidden-default-value-node', hidden);
	});
}

/*
 * The asset explorer: a type, and then one of its assets -- or, with no type named, any
 * asset the game has, searched by name.
 *
 * Both dropdowns are parented to the dialog itself. Pico gives the `<article>` inside it
 * an `overflow` of its own, which is the one thing searchSelect says a dropdown's parent
 * must not have; and the dialog is the element that paints the overlay, so it is also
 * the shallowest place a dropdown renders in front of the modal rather than behind it.
 */
const ASSET_EXPLORER = '#asset-explorer-modal';

/** The controls over the two `<select>`s, so a rebuild can take the last one off first. */
let typePicker = null;
let assetPicker = null;

/** Whether the last build of the lists below had the author's own export connected. */
let builtWithExport = null;

/**
 * Fill the asset explorer, and with it the New File dialog's list of types -- the same
 * types in the same order, and the reason this fills both is below.
 *
 * Reads the export folder rather than being told about it: it is connected from the
 * folders modal now, which knows nothing of this dialog, so the two things that rebuild
 * these lists -- starting the flow and connecting that folder -- would otherwise have to
 * agree on an answer that is already on `window`. That folder holds every type; without
 * it the only assets that can be opened are the ones this tool ships, so their types come
 * first and the rest can be read by name alone.
 */
export function updateAssetModel() {
	const hasLocalFiles = Boolean(window.dirHandleExportedSOPath);
	builtWithExport = hasLocalFiles;

	const types = Object.keys(window.typeMap).sort();

	// `window.onlineTypes` whole and in its own order, as the flat list this replaces
	// had it: a type it names that the type map has nothing for is still a type this
	// tool ships assets for.
	const openable = hasLocalFiles ? types : window.onlineTypes;
	const nameOnly = hasLocalFiles ? [] : types.filter((type) => !window.onlineTypes.includes(type));

	typePicker?.close();
	typePicker?.destroy();

	typePicker = searchSelect(document.getElementById('asset-model-type-list'), {
		parent: document.querySelector(ASSET_EXPLORER),

		// Headed sections rather than the row of dashes that used to divide these. The
		// two halves differ in what can be done with them, and a heading says so where a
		// separator left it to be worked out: "Included" opens as it stands, "Exported"
		// is named after the folder it takes to open one. One list when there is nothing
		// to divide, which is when the author's own export can open every type on it.
		options: nameOnly.length ? null : openable,
		groups: nameOnly.length ? [
			{ label: 'Included', options: openable },
			{ label: 'Exported', options: nameOnly },
		] : null,

		placeholder: 'Search types',

		// Clearable, because no type chosen is a state worth getting back to rather than
		// the absence of one: it is what puts the picker below back to searching every
		// type by name. Without the `×` that is reachable only on the first open, since
		// nothing else here rebuilds the list once a type has been picked.
		allowClear: true,

		// One list, so one key. It is rebuilt whenever the export folder is connected,
		// and the term searched before that is still the one being looked for.
		memoryKey: 'asset-explorer:type',

		onChange: showAssetsOfType,
	});

	fillNewFileTypes([...openable, ...nameOnly]);

	// Connecting an export is what turns overriding the rest of the types on, and the
	// dialog may be open while it happens.
	updateNewFileSubmitState();

	// The type list was just rebuilt, so nothing on it is chosen, and the asset list below
	// it is rebuilt to match rather than left showing whatever the last one held. Which
	// makes it the every-type list -- the state the dialog opens in.
	showAssetsOfType(document.getElementById('asset-model-type-list').value);
}

/**
 * How much of a name has to be typed before the every-type list answers.
 *
 * select2 renders every matching row into the DOM at once, and with no type chosen there
 * are over five thousand of them. Two characters brings the worst case down to a few
 * hundred, and leaves the empty search the list opens on matching nothing at all.
 */
const EVERY_TYPE_MIN_SEARCH = 2;

/**
 * The second typeahead: the base game assets there are to open.
 *
 * With a type chosen it is that type's, by name. With none it is every type's, under a
 * heading each -- the type picker above is for reading one type end to end, and this is
 * for the far commoner case of knowing a name and not which type carries it.
 *
 * The base game's alone. A reference field offers the mod's own assets alongside them --
 * that is a field whose value the mod decides -- but this dialog is for reading the game
 * as it ships, and what the mod defines is listed in the panel behind it.
 *
 * A type with nothing to open is still listed by name: this tool ships assets for nine of
 * the game's seventy-nine types and names every one of them, and browsing the names is most
 * of what the dialog is for with no game files connected. Picking one of those says what
 * would make it open rather than trying and failing -- see `noteUnopenable`.
 */
function showAssetsOfType(type) {
	const canOpen = hasAssetsFor(type);

	setExplorerNote(null);

	assetPicker?.close();
	assetPicker?.destroy();

	assetPicker = searchSelect(document.getElementById('asset-model-asset-list'), {
		parent: document.querySelector(ASSET_EXPLORER),

		// Copied before sorting: the type map is the reference data every other reader
		// of it shares, not this dialog's list to reorder.
		options: type ? [...(window.typeMap[type] ?? [])].sort() : null,
		groups: type ? null : everyTypesAssets(),

		// Only the every-type list is big enough to need holding back, and only it has a
		// message worth showing in the meantime.
		minSearchLength: type ? 0 : EVERY_TYPE_MIN_SEARCH,
		tooShortMessage: `Type ${EVERY_TYPE_MIN_SEARCH} or more characters to search every type`,

		placeholder: !type
			? 'Search every type by name'
			: canOpen
				? 'Search assets'
				: 'Search assets -- opening one needs the game files',

		// Per type, because that is what makes it a different list. A term remembered
		// across the whole control would open a freshly chosen type's assets already
		// filtered by a name searched for among every type's, which is a list of nothing
		// under a box explaining neither half of why.
		memoryKey: `asset-explorer:assets:${type || '*'}`,

		onChange: (value) => {
			if (!value) return;

			// A row of the every-type list carries its type; one of a single type's list
			// is the bare name, and the type is the argument this was called with.
			const chosen = type ? { type, name: value } : parseQualified(value);

			// Checked here rather than by the opener, because the every-type list is a
			// list of names across all seventy-nine types and only nine of them are
			// readable without the author's own export. Opening anyway meant a fetch that
			// 404ed and an alert to dismiss, for a row this already knows will not open.
			if (!hasAssetsFor(chosen.type)) {
				setExplorerNote(EXPORT_NEEDED);
				return;
			}

			setExplorerNote(null);
			openBaseGameAsset(chosen.type, chosen.name);
		},
	});
}

/**
 * What to do about a type this copy of the tool cannot read, shown in place of opening it.
 *
 * Names where that folder is connected, since it is no longer a button in this dialog:
 * every folder the app uses is picked from the one modal behind the header.
 */
const EXPORT_NEEDED = 'Connect your exported ScriptableObjects folder under Folders';

/** Say why nothing opened, or take the last such note back down. */
function setExplorerNote(message) {
	const note = document.getElementById('asset-explorer-note');
	if (!note) return;

	note.textContent = message ?? '';
	note.classList.toggle('hidden', !message);
}

/**
 * Every base game asset, grouped under the type it belongs to.
 *
 * The heading is not decoration. Six hundred of these names belong to more than one type,
 * so a row showing the name alone would not say which asset it is -- and the value has to
 * carry the type for the same reason, since `openBaseGameAsset` reads a folder named after
 * it. `Type|Name` is how a `copyFrom` reference already writes that pair.
 *
 * Types with no assets fall out on their own: searchSelect skips an empty group rather
 * than rendering a heading over nothing.
 */
function everyTypesAssets() {
	return Object.keys(window.typeMap).sort().map((type) => ({
		label: type,
		options: [...window.typeMap[type]].sort().map((name) => ({
			value: `${type}|${name}`,
			text: name,
		})),
	}));
}

/** The other half of the `Type|Name` above. A name cannot contain the separator. */
function parseQualified(value) {
	const split = value.indexOf('|');
	return { type: value.slice(0, split), name: value.slice(split + 1) };
}

/**
 * The New File dialog's File Type list.
 *
 * It used to be a copy of the explorer's markup, taken once at startup by a line that
 * read one dialog's `innerHTML` into another's. The explorer's list is a control's now --
 * with an empty option and headings that mean something there and nothing here -- so the
 * two are filled from the same list of types instead, which is what the copy was for.
 *
 * The selection survives, when the type is still on the list. Connecting an export
 * reorders these, and a dialog standing open while that happens would otherwise change
 * which type it was about, leaving the Copy From list under it describing another one.
 */
function fillNewFileTypes(types) {
	const select = document.querySelector('#new-file-modal-file-type');
	const chosen = select.value;

	select.replaceChildren();

	for (const type of types) {
		const option = document.createElement('option');
		option.text = type;
		select.appendChild(option);
	}

	if (types.includes(chosen)) select.value = chosen;
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

/**
 * Open the new file dialog on an asset, for "Use as..." -- see useAsNewFile.
 *
 * Nothing is filled in for a dialog opened with no asset in mind, which is the manifest's
 * Add new file: the type list stays wherever it was left and the Copy From list is
 * rebuilt for it, as it always was.
 *
 * The File Name is deliberately left empty either way. A copy is a new asset and needs a
 * name of its own; prefilling the one it was copied from would be a name that clashes,
 * offered as though it were the obvious answer.
 *
 * Both selections are only made if the list holds them. The type list is every type the
 * game has and the asset list is every asset of that type, so a document naming something
 * neither has heard of is a mod's own -- and a mod's file is not what this opens on.
 */
export function setNewFileSource(source = null) {
	let typeSelect = document.querySelector('#new-file-modal-file-type');

	if (source?.type && [...typeSelect.options].some((option) => option.value === source.type)) {
		typeSelect.value = source.type;
	}

	// After the type, which is what decides the list, and before the asset, which is
	// one of the options it just made.
	updateNewFileCopyFrom();

	let copyFrom = document.querySelector('#new-file-modal-copy-from');

	if (source?.name && [...copyFrom.options].some((option) => option.value === source.name)) {
		copyFrom.value = source.name;
	}

	// Rebuilding the list dropped the selection back to None, and this may have put it
	// somewhere else again.
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

/**
 * Whether this copy of the tool can read the game's assets of `type` at all.
 *
 * The author's own export of the game's ScriptableObjects holds every type; without one it
 * is the types this tool ships assets for, and there are nine of them out of seventy-nine.
 *
 * Two dialogs turn on this. The explorer will not open what it cannot read, and the New
 * File dialog will not author an override of it -- an override is a difference from the
 * asset it overrides, so that asset has to be readable. Both state it rather than leaving
 * it to be found out: the old override format let anyone hand-write one for any type,
 * because a list of fields needs nothing to compare against.
 */
function hasAssetsFor(type) {
	return Boolean(window.dirHandleExportedSOPath) || window.onlineTypes.includes(type);
}

/** Overriding needs a file to override, and something to read it from. */
export function updateNewFileSubmitState() {
	let overriding = newFileMode() === 'override';
	let type = document.querySelector('#new-file-modal-file-type').value;
	let submit = document.querySelector('#new-file-modal-submit');
	let note = document.querySelector('#new-file-modal-note');

	const blocked = !overriding ? null
		: !hasAssetsFor(type)
			? `This tool does not have the game's ${type} assets, and an override is a change `
				+ 'to one of them. Connect your exported ScriptableObjects folder under Folders '
				+ 'to override this type.'
		: document.querySelector('#new-file-modal-copy-from').value === 'None'
			? 'Choose the file to override'
			: null;

	submit.disabled = Boolean(blocked);
	submit.title = blocked ?? '';

	note.innerText = blocked ?? '';
	note.classList.toggle('hidden', !blocked);
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

/**
 * Whether a link asked for this to be read rather than edited.
 *
 * Kept because it has to survive the trip through the URL as much as the open documents
 * do -- a shared link that stops being view-only on the first refresh is a link that
 * behaves differently the second time it is used.
 */
let assetOnly = false;

/** Where a document was read from, and what it is called there. */
function describeWindow(el) {
	const path = el.getAttribute('path');
	if (!path) return null;

	return `${el.getAttribute('source') || Source.MOD}:${path}`;
}

/** The other half of `describeWindow`. A path may itself contain a colon. */
function parseEntry(entry) {
	const split = entry.indexOf(':');
	if (split === -1) return { source: Source.MOD, path: entry };

	return { source: entry.slice(0, split), path: entry.slice(split + 1) };
}

/**
 * What is open, as URL parameters, so it can be put back after a trip to another editor
 * or after a reload.
 *
 * Only the tree area: the manifest panel reopens itself when the content folder is
 * applied, and is not something you can close.
 *
 * Each entry carries where the document came from as well as its path, because the path
 * does not say and the three sources are not interchangeable -- one is the mod's own
 * file, and the other two are base game assets that can be read with no mod selected at
 * all.
 */
export function sessionState() {
	const open = [...document.querySelectorAll('#trees .file-window')]
		.map(describeWindow)
		.filter(Boolean);

	return { open: encodeList(open), viewOnly: assetOnly ? 'true' : null };
}

export async function restoreSession(params) {
	if (!params) return;

	const entries = decodeList(params.open);

	if (params.viewOnly === 'true') {
		assetOnly = true;
		// The asset explorer is what you would open first with nothing else on screen,
		// and is in the way when the link already names something to look at.
		await enableAssetOnlyMode(entries.length > 0);
	}

	for (const entry of entries) {
		await openSaved(parseEntry(entry));
	}
}

/**
 * Reopen one document named by the URL.
 *
 * Silent about anything it cannot open. What the URL names may have been deleted,
 * renamed, or read from a folder that is not connected this time -- none of which is
 * worth an alert on arrival, and all of which corrects itself when the URL is written
 * back describing what did open.
 */
async function openSaved({ source, path }) {
	// The type is the folder a base game asset sits in. A mod's own file is a flat name
	// and states its own type, so it needs none.
	const type = path.includes('/') ? path.split('/')[0] : null;

	if (source === Source.ASSET) {
		await loadFileFromOnlineRepo(path, type, { quiet: true });
		return;
	}

	const folder = source === Source.EXPORTED
		? window.dirHandleExportedSOPath
		: window.selectedMod?.baseFolder;

	if (!folder) return;
	// Checked before opening rather than after: loading a file that is not there alerts.
	if (!await tryGetFile(folder, path.split('/'))) return;

	await loadFileFromFolder(path, folder, source === Source.EXPORTED, type, source);
}
