/**
 * The building flow's entry points: what is open, what the panel lists, and saving.
 *
 * This is the only file in the flow that knows about the shell. The model, the scene,
 * the tools and the panels are all handed what they need, which is what let each of
 * them be tested without a flow existing at all.
 *
 * One floor is open at a time. It is identified by two things rather than one -- the
 * building and the blueprint -- because a blueprint is meaningless on its own: the game
 * only ever loads one through a building that names it, and saving has to put it back
 * in the slot it came from.
 */
import { renderFilePanel } from '../../../core/filePanel.js';
import { assertModSelected, shouldSave } from '../../../core/persistence.js';
import { getFolder, getFile, writeFile } from '../../../core/fs.js';

import {
    parseFloor, serialiseFloor, describeIssues,
} from './floorModel.js';
import {
    FLOORS_DIR, BUILDING_TYPE,
    listBuildings, listCustomBuildings, listCustomBlueprints, loadPreset, resolveBlueprint,
    enumerateSlots, setBlueprint, presetForSaving, writeCustomPreset, writeCustomBlueprint,
    createCustomBuilding, loadFloorIndex, stubFor,
} from './buildingLibrary.js';
import { createScene, Overlay, describeCell, tileMarkers } from './scene.js';
import { createToolState, attachPainting, Tool } from './tools.js';
import { createPanels } from './panels.js';

const CANVAS = '#building-canvas';
const LABELS = '#building-labels';
const FILE_LIST = '#building-file-list';

/**
 * What is open.
 *
 * Kept in one object so that closing a floor is one assignment and so that nothing can
 * end up with a model from one floor and a slot from another.
 */
let open = null;

/** The view, which outlives an open floor -- building it costs a WebGL context. */
let view = null;
let detachPainting = null;

const toolState = createToolState();

/** Set when something has changed and not yet reached disk. */
let dirty = false;
let saveTimer = null;

const contentFolder = () => window.selectedMod?.baseFolder ?? null;

/**
 * What is open, and what the tools are set to.
 *
 * Readable rather than reachable only through the DOM: the model is the floor, and a
 * caller that has it can ask the model anything. Nothing outside this file writes
 * through them -- painting goes through the tools, which go through the model.
 */
export const openFloorModel = () => open?.model ?? null;
export const openFloorName = () => (open ? { building: open.building, blueprint: open.blueprint } : null);
export const currentToolState = () => toolState;

/** Whether a WebGL context is being held. See ensureView and captureSession. */
export const viewIsLive = () => view !== null;

/** Where a cell is on screen. Null when there is no view, or it is behind the camera. */
export const projectCell = (x, y, height) => view?.project(x, y, height) ?? null;

/** Whether the open floor has changes that have not reached disk. */
export const hasUnsavedChanges = () => dirty;


/* -------------------------------------------------------------------------- */
/* The panel                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every building and the floors in it, as one category per building.
 *
 * A building is the right grouping because it is the unit the game loads: a blueprint
 * listed on its own would be a name with nothing to open it against. The mod's own
 * buildings come first, then the base game's -- which are listed precisely so a base
 * game floor can be opened and saved into the mod.
 */
export async function refreshPanel() {
    const folder = contentFolder();

    renderFilePanel(
        FILE_LIST,
        folder ? await buildCategories(folder) : null,
        (entry) => openFloor(entry.openAs),
        'Choose a mod and content folder to see the buildings in it.');
}

async function buildCategories(folder) {
    const categories = [];
    const buildings = await listBuildings(folder);
    const modFloors = new Set(await listCustomBlueprints(folder));

    for (const building of buildings) {
        const preset = building.preset ?? (await loadPreset(folder, building.name))?.preset;
        const slots = enumerateSlots(preset);

        categories.push({
            id: building.name,
            label: building.isCustom ? `${building.name} (this mod)` : building.name,
            entries: slots.map((option) => ({
                id: `${building.name}/${option.blueprint}`,
                label: `${option.label}: ${option.blueprint}`,
                // Says where the file being opened will come from, which is the one
                // thing that is not obvious from the name: a floor the mod holds
                // shadows the base game copy of the same name.
                tag: modFloors.has(option.blueprint) ? 'edited' : null,
                openAs: {
                    building: building.name,
                    blueprint: option.blueprint,
                    slot: option.slot,
                },
            })),
        });
    }

    // A floor the mod holds that no building refers to. Reachable rather than stranded:
    // renaming a floor, or removing it from a slot, leaves one behind.
    const referenced = new Set(categories.flatMap(
        (category) => category.entries.map((entry) => entry.openAs.blueprint)));
    const orphans = [...modFloors].filter((name) => !referenced.has(name));

    if (orphans.length) {
        categories.push({
            id: 'unused-floors',
            label: 'Floors no building uses',
            entries: orphans.map((name) => ({
                id: name,
                label: name,
                tag: 'unused',
                openAs: { building: null, blueprint: name, slot: null },
            })),
        });
    }

    return categories;
}


/* -------------------------------------------------------------------------- */
/* Opening a floor                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Open a floor, from the panel or from a restored session.
 *
 * `selections` puts back which layout variation each address was showing, which is the
 * one piece of editor state a blueprint has nowhere to store.
 */
export async function openFloor({ building, blueprint, slot }, selections = []) {
    const folder = contentFolder();
    if (!folder) return;

    const found = await resolveBlueprint(folder, blueprint);
    if (!found) {
        alert(`Could not find a floor called "${blueprint}".`);
        return;
    }

    // Whatever was open is being replaced, so anything unsaved in it has to go now
    // rather than be written over the new floor later.
    await flushPendingSave();

    open = {
        building,
        blueprint,
        slot,
        isCustom: found.isCustom,
        model: parseFloor(found.data, { selections }),
    };

    dirty = false;

    await showOpenFloor();
}

/** Put the open floor on screen: the view, the tools bound to it, and the panels. */
async function showOpenFloor() {
    await ensureView();

    view.setModel(open.model);
    renderPanels();
    updateHeading();
    updateLabels();
}

/**
 * Build the view if there is not one, or if the last one went away with the flow's
 * markup.
 *
 * A flow that is switched away from has its template replaced, which takes the canvas
 * with it. The controller would still be holding a live WebGL context, and a browser
 * drops the oldest once about sixteen are alive -- so the old one is released rather
 * than left to be collected whenever.
 */
async function ensureView() {
    const container = document.querySelector(CANVAS);
    if (!container) return;

    if (view && view.canvas.isConnected && container.contains(view.canvas)) return;

    releaseView();

    view = await createScene(container);
    detachPainting = attachPainting(view, () => open?.model ?? null, toolState, {
        onChange: onPainted,
        onHover: onHovered,
    });
}

/** Give back the WebGL context and unbind the pointer handling. */
export function releaseView() {
    detachPainting?.();
    detachPainting = null;

    view?.dispose();
    view = null;
}


/* -------------------------------------------------------------------------- */
/* Editing                                                                     */
/* -------------------------------------------------------------------------- */

/** A stroke changed the floor, or picked a value off it. */
function onPainted(result) {
    if (result.changed) markDirty();

    view?.refresh();
    renderPanels();
    updateLabels();
}

/** The pointer moved over the floor with nothing held. */
function onHovered(target) {
    hovered = target && target.kind === 'cell' ? { x: target.x, y: target.y } : null;
    updateLabels();
}

let hovered = null;

/**
 * A panel changed something.
 *
 * Panels edit the model directly, so this only has to redraw and remember that the
 * floor no longer matches what is on disk.
 */
function onPanelEdit() {
    markDirty();
    view?.refresh();
    updateLabels();
}

/** A change that moves nodes about, so the whole grid has to be read again. */
function onPanelRebuild() {
    markDirty();
    view?.setModel(open?.model ?? null);
    updateLabels();
}

function renderPanels() {
    if (!open?.model) return;

    createPanels({
        tools: document.querySelector('#building-tools'),
        addresses: document.querySelector('#building-addresses'),
        rooms: document.querySelector('#building-rooms'),
        walls: document.querySelector('#building-walls'),
        selection: document.querySelector('#building-selection'),
    }, open.model, toolState, {
        onEdit: onPanelEdit,
        onRebuild: onPanelRebuild,
        onToolChange: updateLabels,
    });
}

function updateHeading() {
    const heading = document.querySelector('#building-open-name');
    if (!heading) return;

    heading.textContent = open
        ? `${open.blueprint}${open.building ? ` — ${open.building}` : ''}`
        : 'No floor open';

    const issues = document.querySelector('#building-open-issues');
    if (issues) {
        const notes = open?.model ? describeIssues(open.model) : [];
        issues.textContent = notes.join(' · ');
        issues.classList.toggle('hidden', notes.length === 0);
    }
}


/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The hovered and selected cells, labelled with HTML positioned over the canvas.
 *
 * Two labels rather than 441. The reference tool puts the room preset, its id and the
 * coordinates on every cell with TextMeshPro; this shows the same three things for the
 * cell being looked at, which is the one it was for.
 */
function updateLabels() {
    const host = document.querySelector(LABELS);
    if (!host || !view) return;

    host.replaceChildren();
    if (!open?.model) return;

    const wanted = [
        hovered && { ...hovered, kind: 'hover' },
        toolState.selectedNode && { ...toolState.selectedNode, kind: 'selected' },
    ].filter(Boolean);

    // The same cell hovered and selected is one label, not two on top of each other.
    const seen = new Set();

    for (const { x, y, kind } of wanted) {
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const described = describeCell(open.model, x, y);
        const at = view.project(x, y, 0.8);
        if (!described || !at) continue;

        const rect = view.canvas.getBoundingClientRect();
        const label = document.createElement('div');
        label.className = `cell-label ${kind}`;
        label.style.left = `${at.left - rect.left}px`;
        label.style.top = `${at.top - rect.top}px`;
        label.textContent = `${described.room}\n${described.address}\n${described.coordinate}`;
        host.appendChild(label);
    }

    for (const marker of tileMarkers(open.model)) {
        const at = view.project(marker.nodeX, marker.nodeY, 1.4);
        if (!at) continue;

        const rect = view.canvas.getBoundingClientRect();
        const pin = document.createElement('div');
        pin.className = 'tile-marker';
        pin.style.left = `${at.left - rect.left}px`;
        pin.style.top = `${at.top - rect.top}px`;
        pin.textContent = markerText(marker);
        pin.title = `Tile ${marker.x}, ${marker.y}`;
        host.appendChild(pin);
    }
}

function markerText(marker) {
    if (marker.stairwell === 'elevator') return `⇕ ${marker.rotation}°`;
    if (marker.stairwell === 'stairs') return `⌁ ${marker.rotation}°`;
    return marker.entrance === 'main' ? '★' : '▣';
}


/* -------------------------------------------------------------------------- */
/* Saving                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Saving is debounced rather than immediate.
 *
 * A blueprint is around 55 KB of coordinates and a stroke can touch a hundred nodes, so
 * writing on every change would write the file a hundred times for one drag. Waiting
 * until the edits stop writes it once.
 */
const SAVE_DELAY = 600;

function markDirty() {
    dirty = true;
    updateSaveState();

    if (!shouldSave(false)) return;

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveFloor(); }, SAVE_DELAY);
}

/** Write a pending autosave now, for before the open floor is replaced. */
async function flushPendingSave() {
    if (saveTimer === null) return;

    clearTimeout(saveTimer);
    saveTimer = null;
    await saveFloor();
}

/**
 * Write the open floor into the mod, and point its building at it.
 *
 * Two files, always in this order: the blueprint, then the building that names it. A
 * building referring to a floor that is not there yet is the failure that shows up as a
 * missing floor in game; the other way round is a floor nothing uses, which is visible
 * in the panel and harmless.
 *
 * If the floor came from a base game building, this is where that building becomes a
 * stub in the mod. See buildingLibrary.js -- the base game's copy is a URL this app
 * fetched, not a file it could write to even if it wanted.
 */
export async function saveFloor(force = false) {
    if (!open?.model) return;
    if (!shouldSave(force)) return;

    assertModSelected();
    const folder = contentFolder();

    await writeCustomBlueprint(folder, open.model.floorName, serialiseFloor(open.model));

    if (open.building) {
        const { preset } = await presetForSaving(folder, open.building);
        if (open.slot) open.slot = setBlueprint(preset, open.slot, open.model.floorName);
        await writeCustomPreset(folder, open.building, preset);
    }

    // The floor may have been saved under a new name, and its building may have become
    // the mod's just now -- both change what the panel should say.
    open.blueprint = open.model.floorName;
    open.isCustom = true;

    dirty = false;
    updateSaveState();

    await refreshPanel();
    updateHeading();
}

/** The explicit Save button, which writes whatever the autosave switch says. */
export async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveFloor(true);
}

function updateSaveState() {
    const button = document.querySelector('#building-save');
    if (button) button.dataset.dirty = dirty ? 'true' : 'false';
}


/* -------------------------------------------------------------------------- */
/* Buildings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Add a building to the mod.
 *
 * Offering a base game building to copy from is the point of this rather than an
 * extra: a building of its own has no prefab, no mesh and no window data, so the game
 * has nothing to draw until those are generated. One that copies from a base game
 * building has all three from the start and only its floors are the mod's.
 */
export async function addBuilding() {
    const folder = contentFolder();
    if (!folder) {
        alert('Choose a mod and content folder first');
        return;
    }

    const name = prompt('Name for the new building')?.trim();
    if (!name) return;

    const existing = await listCustomBuildings(folder);
    if (existing.some((entry) => entry.name === name)) {
        alert(`This mod already has a building called "${name}".`);
        return;
    }

    const index = await loadFloorIndex();
    const copyFrom = prompt(
        'Copy from which base game building?\n\n'
        + 'Leave blank for a building of its own, which will need a mesh generating '
        + 'before the game can show it.\n\n'
        + index.buildings.join(', '),
        'Hotel')?.trim();

    if (copyFrom && !index.buildings.includes(copyFrom)) {
        alert(`"${copyFrom}" is not a base game building.`);
        return;
    }

    await createCustomBuilding(folder, name, { copyFrom: copyFrom || null });
    await refreshPanel();
}

/**
 * Lay out a new content folder as a building mod.
 *
 * Returned to core/newContent.js, which calls it once the folder exists. The Floors
 * directory is created empty because it is what marks the folder as holding buildings
 * -- without it the folder would not be offered as content to edit at all.
 */
export function scaffoldBuildingFolder(name) {
    return async (folder) => {
        const preset = stubFor(name, null, { copyFrom: null });

        const handle = await getFile(folder, [`${name}${'.sodso.json'}`], true);
        await writeFile(handle, `${JSON.stringify({
            name: preset.name,
            presetName: preset.presetName,
            type: BUILDING_TYPE,
            fileType: BUILDING_TYPE,
            copyFrom: null,
        }, null, 2)}\n`);

        await getFolder(folder, [FLOORS_DIR], true);
    };
}


/* -------------------------------------------------------------------------- */
/* View controls                                                               */
/* -------------------------------------------------------------------------- */

export function setOverlay(mode) {
    view?.setOverlay(mode);
    updateLabels();
}

export function resetView() {
    view?.resetView();
    updateLabels();
}

/** The overlay dropdown's options, so the markup does not repeat the enum. */
export const OVERLAYS = [
    [Overlay.ADDRESS, 'Colour by address'],
    [Overlay.ROOM, 'Colour by room'],
    [Overlay.FLOOR_TYPE, 'Colour by floor type'],
];


/* -------------------------------------------------------------------------- */
/* The shell's hooks                                                           */
/* -------------------------------------------------------------------------- */

export async function onFoldersConnected() {
    await refreshPanel();
}

/**
 * A content folder was chosen.
 *
 * Anything open belongs to the folder it was opened from -- a floor is identified by a
 * name that another mod can have a file of its own at -- so it is closed rather than
 * left to be saved into the wrong place.
 */
export async function onModSelected() {
    await flushPendingSave();

    open = null;
    hovered = null;
    dirty = false;

    view?.setModel(null);
    updateHeading();
    updateLabels();

    await refreshPanel();
}

/**
 * What is open, for coming back from another editor.
 *
 * The variation each address is showing is part of it: a blueprint has nowhere to
 * record which of an address's layouts you were editing, so without this, coming back
 * would silently drop you onto layout 0 of every one of them.
 *
 * This is also the only signal the flow gets that it is being switched away from, so it
 * is where the WebGL context is given back. See ensureView.
 */
export async function captureSession() {
    await flushPendingSave();

    const session = open && {
        building: open.building,
        blueprint: open.blueprint,
        slot: open.slot,
        selections: open.model.addresses.map((address) => address.selectedVariation),
        tool: toolState.tool,
    };

    releaseView();
    return session;
}

export async function restoreSession(session) {
    if (!session?.blueprint) return;

    if (session.tool && Object.values(Tool).includes(session.tool)) {
        toolState.tool = session.tool;
    }

    await openFloor(
        { building: session.building, blueprint: session.blueprint, slot: session.slot },
        session.selections ?? []);
}
