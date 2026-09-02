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
import { isNameFieldSafe, makeNameFieldSafe } from '../../../core/strings.js';
import { ROOM_NAMES_VIRTUAL } from '../../../core/ddsManifest.js';
import { ensureListed } from '../../../core/murderManifest.js';
import { PRESET_SUFFIX, stemFor } from '../../../core/soFileName.js';
import { writeStringsRow } from '../../../core/modStrings.js';
import { scheduleSync } from '../../../core/urlState.js';

import {
    parseFloor, serialiseFloor, describeIssues, getWall, tileForNode,
    blankFloor, floorLike, floorCopy,
} from './floorModel.js';
import { generateRoof } from './roofGenerator.js';
import {
    FLOORS_DIR, BUILDING_TYPE,
    listBuildings, listCustomBuildings, listCustomBlueprints, loadPreset, resolveBlueprint,
    enumerateSlots, storeysOf, adjoiningStorey, firstLayoutOf,
    sameSlot, setBlueprint, removeBlueprint, presetForSaving,
    writeCustomPreset, writeCustomBlueprint, deleteCustomBlueprint, createCustomBuilding,
    loadFloorIndex, stubFor, readCustomPreset, stairwellElevators,
} from './buildingLibrary.js';
import {
    generateBuilding, writeGeneratedBuilding, isMeshStale, GENERATED_FIELDS, MESH_ROOF_FIELD,
} from './meshExport.js';
import { createScene, Overlay, describeCell } from './scene.js';
import { createToolState, attachPainting, nearestEdge, Tool, PaintMode } from './tools.js';
import {
    createPanels, renderStatusPanel, renderFloorPanel, setModFurnitureSource, releaseSelects,
    wallPresetName, floorDescription, tileDescription,
} from './panels.js';
import { loadFurnitureChain, applyModOverlay, baseFurnitureChain } from './furnitureChain.js';
import { readModAssets } from './furnitureOverlay.js';

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
 * Whether there is anywhere to write.
 *
 * The base game's buildings and floors ship with the app, so all of them can be opened
 * and looked at with no mod selected at all -- which is worth being able to do, because
 * "how did the game build a hotel" is a question you have before you have a mod. What
 * needs a mod is changing one: painting is switched off and cannot be switched on, and
 * a building cannot be added.
 */
const canEdit = () => contentFolder() !== null;

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

/** Whether a WebGL context is being held. See ensureView and suspend. */
export const viewIsLive = () => view !== null;

/** Where a cell is on screen. Null when there is no view, or it is behind the camera. */
export const projectCell = (x, y, height) => view?.project(x, y, height) ?? null;

/**
 * The square the view is marking, which should be the one the tool state has selected.
 *
 * The two are set together by `clearSelection` and by a pick, and nothing else may move
 * either -- so a caller comparing them is checking the one invariant that spans the panel
 * and the floor.
 */
export const markedSquare = () => view?.selected ?? null;

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
    // A null folder is a listing of the base game's buildings alone. Every function this
    // calls takes one, and the file-system helpers under them return nothing rather than
    // throwing when handed nothing, so the mod's half simply comes back empty.
    //
    // The base game's half is a fetch of the reference index, and that can fail -- no
    // network, or the reference data not deployed beside the app. Caught here rather than
    // left to propagate: every caller is a folder or mod change that has nothing useful to
    // do with the error, and what it left behind was an empty panel that looked like a mod
    // with nothing in it. Null is renderFilePanel's "nothing to list", which is where the
    // message below is shown.
    let categories = null;
    try {
        categories = await buildCategories(contentFolder());
    } catch (error) {
        console.error('Could not list buildings', error);
    }

    renderFilePanel(
        FILE_LIST,
        categories,
        (entry) => { closeBrowse(); openFloor(entry.openAs); },
        'Buildings failed to load');

    bindBrowseResizing();
    bindBrowseSizing();

    // The mod's own furniture assets, which the chain has to be asked against rather
    // than the base game's alone -- see furnitureOverlay.js. Here because this is the one
    // funnel every folder and mod change comes through, and because every write that puts
    // an asset in the mod ends by calling it.
    await refreshModOverlay();

    // This runs whenever the flow's markup is on screen and the folders have changed,
    // which includes the first time it is shown with nothing open. Without them the
    // status column and the Floor section would be empty bordered boxes until a floor
    // was opened.
    updateStatus();
    updateFloorPanel();

    // And the panels, because the overlay above is where their name lists get the mod's
    // half from: changing mod changes what the address and room dropdowns offer, and
    // nothing else on this path would redraw them. A no-op with no floor open.
    renderPanels();
}

/**
 * What the mod adds to the chain, what it would add if the manifest named it, and what
 * could not be read at all.
 *
 * Held for the panel to report. Rebuilt rather than added to, so a file deleted from the
 * mod stops counting -- and rebuilt from the folder rather than from what this app wrote,
 * because a mod is edited by hand as often as through here.
 */
let modAssets = { applied: [], unlisted: [], unresolved: [] };

/** What the mod contributes to the furniture chain, for the status column to say. */
export const modFurniture = () => modAssets;

// The panels draw what they are handed and reach for nothing themselves. This is the one
// thing they need that is neither the model nor the tool state, so it is handed over once
// rather than imported across the seam.
setModFurnitureSource(modFurniture);

async function refreshModOverlay() {
    // Nothing to lay them over yet. The chain is fetched when the first floor opens, and
    // this is called again once it lands -- so until then the folder is not read at all,
    // which matters because this runs on every panel refresh and one of those follows
    // every autosave. Reading the folder is already what listing the mod's buildings
    // costs; there is no reason to pay it twice before there is anything to merge.
    if (!baseFurnitureChain()) {
        modAssets = { applied: [], unlisted: [], unresolved: [] };
        return;
    }

    const { assets, unlisted, unresolved } = await readModAssets(contentFolder());

    modAssets = { applied: applyModOverlay(assets), unlisted, unresolved };
}

/* -------------------------------------------------------------------------- */

const BROWSE = '#building-browse';

const closeBrowse = () => document.querySelector(BROWSE)?.removeAttribute('open');

/**
 * Re-measure an open menu when the window changes size.
 *
 * The menu hangs off the bar, so nothing about the page moves when it opens and its
 * height is only ever a cap. It is re-measured on a resize because the thing it is
 * measured against is the workspace, which is sized to the window.
 *
 * One listener for the life of the page rather than one per refresh: it is added once,
 * and it looks the menu up each time, so it costs nothing on the many resizes that
 * happen while another flow's markup is on screen and there is no menu to find.
 *
 * Closing it on a click elsewhere is not here: every flow's bar has a menu on it now,
 * and one listener does all of them -- see core/barMenu.js.
 */
let browseResizeBound = false;

function bindBrowseResizing() {
    if (browseResizeBound) return;
    browseResizeBound = true;

    window.addEventListener('resize', () => {
        if (document.querySelector(BROWSE)?.hasAttribute('open')) sizeBrowseMenu();
    });
}

/**
 * Let the menu run down to where the columns end.
 *
 * A building of a dozen floors, each holding its layouts, is taller than the 28rem the
 * menu was capped at, and a menu that scrolls inside a page that does not is a list read
 * through a slot. There is nothing below the workspace for it to cover, so it goes as far
 * as the workspace does and no further -- past that and the bottom of the menu would be
 * off the page with no way to scroll to it.
 *
 * Measured rather than declared: this is a `position: absolute` box hanging off the flow
 * bar, so its height in CSS could only be a fraction of the viewport, which is not what
 * the columns beside it are.
 */
const BROWSE_MENU = `${BROWSE} .browse-menu`;
const LEFT_COLUMN = '#building-left';

/** Under this the cap is doing more harm than the overflow it prevents. */
const MIN_BROWSE_HEIGHT = 160;

function sizeBrowseMenu() {
    const menu = document.querySelector(BROWSE_MENU);
    const column = document.querySelector(LEFT_COLUMN);
    if (!menu || !column) return;

    const available = column.getBoundingClientRect().bottom
        - menu.getBoundingClientRect().top;
    menu.style.maxHeight = `${Math.max(available, MIN_BROWSE_HEIGHT)}px`;
}

/**
 * Bound to the menu itself rather than to the document, because `toggle` does not bubble.
 *
 * The marker is on the element and not in a module-level flag: switching flows replaces
 * this flow's markup, so the menu this is bound to is gone and the next one needs it
 * again. See the note above about the dismissal handler, which can be bound once because
 * it looks the menu up each time.
 */
function bindBrowseSizing() {
    const details = document.querySelector(BROWSE);
    if (!details || details.dataset.sized) return;

    details.dataset.sized = 'true';
    details.addEventListener('toggle', () => {
        if (details.open) sizeBrowseMenu();
    });
}

/** The two runs the menu is divided into. See `group` in core/filePanel.js. */
const CUSTOM = 'Custom';
const VANILLA = 'Vanilla';

async function buildCategories(folder) {
    const custom = [];
    const vanilla = [];
    const buildings = await listBuildings(folder);
    const modFloors = new Set(await listCustomBlueprints(folder));

    for (const building of buildings) {
        const preset = building.preset ?? (await loadPreset(folder, building.name))?.preset;
        const slots = enumerateSlots(preset);

        // The three BoundaryCoastal/BoundaryCorner buildings are the scenery along the
        // edge of the city: nonEnterable, with no floors at all. A category that can
        // never be opened is noise in a menu, so they are left out by what makes them
        // useless rather than by name. A building the mod itself holds is listed either
        // way -- an empty one is the author's own, and hiding it would hide the fact
        // that adding it worked.
        if (!slots.length && !building.isCustom) continue;

        // Which of the two it is was a "(this mod)" on the end of the name, which put
        // the answer in the middle of a list of twelve where it had to be read one
        // category at a time. It is a heading now, so the division is the shape of the
        // menu rather than something spelled out on each line.
        //
        // Adding and deleting floors is offered on the mod's own buildings only. A base
        // game building has to become a stub in the mod before its floor list is
        // anything this app can write -- which is what saving a floor against one does,
        // and doing it silently from a delete button would be a mod gaining a building
        // it never asked for.
        (building.isCustom ? custom : vanilla).push({
            id: building.name,
            label: building.name,
            group: building.isCustom ? CUSTOM : VANILLA,
            // Twelve buildings of a dozen floors each is a scroll, not a list, and the
            // one being looked for is found by name.
            open: false,
            // A storey each, because that is the shape a building has: the blueprints in
            // one setting are alternative layouts of the same floor, which the game picks
            // between, and listing them all at one level said "twelve floors" where the
            // building has four. See storeysOf in buildingLibrary.js.
            sections: storeysOf(slots).map((storey) => ({
                id: `${building.name}/${storey.key}`,
                label: storey.label,
                entries: storey.options.map((option) => floorEntry(
                    building, option, modFloors)),
                footer: building.isCustom ? {
                    label: 'Add layout',
                    title: `Add another layout of ${storey.label} to ${building.name}, `
                        + 'as a copy of the one already there. The game picks between the '
                        + 'layouts of one floor when it builds the city.',
                    onClick: () => addLayout(building.name, storey),
                } : null,
            })),
            // A building grows in two directions, and the game keeps the two apart:
            // floorLayouts up from the ground floor, basementLayouts down from it. So
            // they are two buttons rather than one asking which -- the answer is the
            // thing being asked for.
            footer: building.isCustom ? [
                {
                    id: 'add-floor',
                    label: 'Add floor',
                    title: `Add a floor to the top of ${building.name}`,
                    onClick: () => addStorey(building.name, { isBasement: false }),
                },
                {
                    id: 'add-basement',
                    label: 'Add basement',
                    title: `Add a basement under ${building.name}`,
                    onClick: () => addStorey(building.name, { isBasement: true }),
                },
            ] : null,
        });
    }

    // A floor the mod holds that no building refers to. Reachable rather than stranded:
    // renaming a floor, or removing it from a slot, leaves one behind.
    //
    // Counted against every building, the base game's included: a mod floor named after
    // a base game one shadows it and is reached through that building, so it is not
    // stranded. But it is the mod's own, so it goes under Custom rather than after the
    // list it was checked against.
    const referenced = new Set([...custom, ...vanilla].flatMap(
        (category) => category.sections.flatMap(
            (section) => section.entries.map((entry) => entry.openAs.blueprint))));
    const orphans = [...modFloors].filter((name) => !referenced.has(name));

    if (orphans.length) {
        custom.push({
            id: 'unused-floors',
            label: 'Floors no building uses',
            group: CUSTOM,
            open: false,
            entries: orphans.map((name) => ({
                id: name,
                label: name,
                tag: 'unused',
                // No building to take it out of, so this is the file and nothing else.
                action: {
                    label: '×',
                    title: `Delete ${name}`,
                    onClick: () => deleteFloor(null, name, null),
                },
                openAs: { building: null, blueprint: name, slot: null },
            })),
        });
    }

    return [...custom, ...vanilla];
}

/**
 * One layout of one floor.
 *
 * Named by its blueprint and nothing else: the storey it belongs to is the section it is
 * listed in, and repeating "Floor 3" on every line under a heading that says Floor 3 was
 * most of the width of the menu. A control room variant still says so, in the same words
 * the Floor panel's Layout select uses -- it is a different thing from the layout beside
 * it rather than another of the same.
 */
function floorEntry(building, option, modFloors) {
    return {
        id: `${building.name}/${option.blueprint}`,
        label: `${option.slot.isControlVariant ? 'Control: ' : ''}${option.blueprint}`,
        // Says where the file being opened will come from, which is the one thing that is
        // not obvious from the name: a floor the mod holds shadows the base game copy of
        // the same name.
        tag: modFloors.has(option.blueprint) ? 'edited' : null,
        action: building.isCustom ? {
            label: '×',
            title: `Delete ${option.blueprint}`,
            onClick: () => deleteFloor(building.name, option.blueprint, option.slot),
        } : null,
        openAs: {
            building: building.name,
            blueprint: option.blueprint,
            slot: option.slot,
        },
    };
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
export async function openFloor({ building, blueprint, slot }, selections = [], { quiet = false } = {}) {
    // A floor that could not be *read* is a different answer from one that is not there,
    // and neither is a reason to leave a click doing nothing visible. resolveBlueprint
    // raises rather than quietly handing back the base game's copy of a floor the mod has
    // its own version of -- see buildingLibrary.js -- and this is where that has to be
    // said, because nothing above awaits this.
    let found = null;

    try {
        found = await resolveBlueprint(contentFolder(), blueprint);
    } catch (error) {
        console.error('Could not read the floor', error);
        alert(error.message);
        return;
    }

    if (!found) {
        if (!quiet) alert(`Could not find a floor called "${blueprint}".`);
        return;
    }

    // Whatever was open is being replaced, so anything unsaved in it has to go now
    // rather than be written over the new floor later.
    await flushPendingSave();

    // The building this floor belongs to, read once for the two things that want it. Both
    // are read here rather than each time they are drawn, which is on every edit: it is a
    // file read, and neither the building's floor list nor its stairwell changes while one
    // of its floors is open.
    //
    // A read that fails leaves the building unknown rather than stopping the floor opening,
    // and unknown is already handled below: the floor opens on its own and saving it
    // touches no preset. That is the safe half of the two, and it is the same answer this
    // gives a name nothing answers to.
    let preset = null;

    try {
        preset = await presetOfBuilding(building);
    } catch (error) {
        console.error('Could not read the building this floor belongs to', error);
    }

    /**
     * The building this floor is actually held to belong to, which is the name only when
     * something answers to it.
     *
     * A name with no preset behind it is not a building to save against, and there are two
     * ways to arrive holding one. A restored session names the building in the URL, and the
     * content folder that came back is not always the one the URL named -- see
     * restoreSession, which asks for a folder and takes what it is given. And a preset that
     * will not parse reads as absent here, exactly as one that is not there does.
     *
     * Kept, either would put the name in front of the next autosave, which has to answer
     * "what does this mod's <name> look like" and would have nothing to answer with. That
     * is where a preset copying from itself came from.
     *
     * The floor still opens. It is a file in its own right, worth looking at and worth
     * editing; what it loses is the storey it sits in, which the Floor panel says plainly.
     * The slot goes with the building, because a slot is a position in a building.
     */
    const inBuilding = preset ? building : null;

    if (building && !inBuilding && !quiet) {
        alert(`Could not find a building called "${building}", so "${blueprint}" has been `
            + 'opened on its own. Saving it will not change any building.');
    }

    const model = parseFloor(found.data, { selections });

    // What stands in this floor's stairwell tiles, which is the building's to say and not
    // the floor's. Awaited before the floor is drawn so that the labels are right the
    // first time rather than losing a line a moment after they appear.
    model.stairwellElevators = await stairwellElevators(contentFolder(), preset);

    open = {
        building: inBuilding,
        blueprint,
        slot: inBuilding ? slot : null,
        isCustom: found.isCustom,
        model,
        // What the Floor panel steps through.
        storeys: storeysOf(enumerateSlots(preset)),
    };

    dirty = false;

    // Every floor is opened to look at first. Painting stays where it was left for as
    // long as one floor is open, but opening another is a fresh floor to be careful
    // with -- and often a base game one, which the first stray click would copy into
    // the mod.
    toolState.mode = PaintMode.NONE;

    // And what would be painted is this floor's, not the last one's. An address and a
    // room are both positions in the floor that is open: address 3 is a different
    // dwelling in every building, and a room slot within it is not even the same kind of
    // room. Nothing else in the state means anything about a particular floor.
    toolState.addressIndex = 0;
    toolState.roomIndex = 0;

    clearSelection();

    // What the last generation said was about the last building. Whether this one's mesh
    // is out of date is a fresh question, answered below once the floor is on screen --
    // it reads every floor of the building, so it is not something to wait for. So is
    // whether it has a roof, which comes off the same read of the same preset.
    meshState = NO_MESH_STATE;

    await showOpenFloor();
    refreshMeshState();

    scheduleSync();

    // What could spawn on a square, which the status column shows once it has arrived
    // and omits until then. Not awaited: it is a 20 KB fetch that nothing else needs,
    // and a floor should be on screen before it rather than behind it. The redraw is
    // what makes the section appear, and is a no-op if the floor was closed meanwhile.
    loadFurnitureChain().then(async () => {
        if (!open) return;

        // The overlay is laid over the base, and on the first floor of a session the
        // base did not exist when the mod was read. Re-applied here rather than awaited
        // above, which would put a 20 KB fetch in front of the floor appearing.
        await refreshModOverlay();
        if (!open) return;

        updateStatus();

        // The address and room dropdowns read the mod's half of their lists off the same
        // overlay. On the first floor of a session it did not exist when they were drawn,
        // so without this the mod's own layouts are missing from them until the next edit.
        renderPanels();
    });
}

/**
 * The preset of the building a floor was opened through, or null for a floor no building
 * refers to.
 *
 * Null rather than an empty preset, because the two are different answers: a building with
 * nothing in it still names a stairwell and still has storeys to be one of, and a floor
 * belonging to no building has neither.
 */
async function presetOfBuilding(building) {
    if (!building) return null;

    const found = await loadPreset(contentFolder(), building);
    return found?.preset ?? null;
}

/**
 * The storeys of the building a floor was opened through.
 *
 * Empty for a floor no building refers to: there is no building to be a storey of, and
 * the Floor panel says so rather than offering to climb one.
 */
async function storeysForBuilding(building) {
    return storeysOf(enumerateSlots(await presetOfBuilding(building)));
}

/**
 * Where the open floor sits in its building, for the Floor panel.
 *
 * The storey is found by the slot rather than by the blueprint's name. No base game
 * building lists one blueprint twice, but nothing stops a mod doing it -- a floor used
 * for two storeys is one file, not two -- and the answer to "which floor am I on" is the
 * slot that was opened rather than the first one that happens to name this file.
 */
function openFloorContext() {
    if (!open) return null;

    const storeys = open.storeys ?? [];

    return {
        building: open.building,
        blueprint: open.model?.floorName ?? open.blueprint,
        slot: open.slot,
        storeys,
        storeyIndex: storeys.findIndex(
            (storey) => storey.options.some((option) => sameSlot(option.slot, open.slot))),
        // A floor no building refers to has no building to generate a model for.
        mesh: {
            canGenerate: canEdit() && !!open.building,
            busy: meshState.busy,
            stale: meshState.stale,
            status: meshState.status,
            roof: meshState.roof,
        },
    };
}

/** Open another slot of the building already open. */
const openSlot = (option) => openFloor({
    building: open?.building ?? null, blueprint: option.blueprint, slot: option.slot,
});

/**
 * The Floor section on its own.
 *
 * Drawn outside the panels as well as with them, because it is the one of them that has
 * something to say when nothing is open -- and because saving a floor can move it into a
 * slot it was not in before.
 */
function updateFloorPanel() {
    const container = document.querySelector('#building-floor');
    if (container) {
        renderFloorPanel(container, openFloorContext(), {
            onOpen: openSlot,
            onGenerateMesh: generateMesh,
            onMeshRoof: setMeshRoof,
        });
    }
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

    // The panels' dropdowns are select2 controls kept across redraws, and their dropdowns
    // are parented to this flow's markup -- which is replaced when another flow is shown.
    // Nothing else destroys them, and an instance whose element has left the document
    // keeps the scroll handlers it bound to a column that is no longer there.
    releaseSelects();
}


/* -------------------------------------------------------------------------- */
/* Editing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Forget which square was selected, in the tool state and in the view together.
 *
 * A selection is a square *of a floor*, and node 10,10 exists on every one of them: it is
 * a different room in a different address on each, so carrying one across is carrying a
 * coordinate and calling it a place.
 *
 * The view has to be told rather than left to work it out. `setModel` re-places the mark
 * rather than clearing it -- a layout variation switch rebuilds the grid under a selection
 * that should survive it -- so nothing else in the scene would take the mark off the floor
 * a new blueprint is drawn on.
 */
function clearSelection() {
    toolState.selectedNode = null;
    toolState.selectedTile = null;
    toolState.selectedWall = null;

    view?.setSelected(null);
}

/** A stroke changed the floor, or picked a value off it. */
function onPainted(result) {
    if (result.changed) markDirty();

    // Before the refresh, which is what puts the mark on the square's surface -- see
    // placeSelection. A pick is the only thing that moves the selection, but a stroke
    // can move the surface it lies on, so this runs for both.
    view?.setSelected(toolState.selectedNode);

    view?.refresh();
    renderPanels();
    updateLabels();
}

/**
 * The pointer moved over the floor with nothing held.
 *
 * Walls are kept as well as cells, which they were not when the only thing reading this
 * was the cell label: the status column shows what is under the pointer, and a wall is
 * one of the things that can be.
 */
function onHovered(target) {
    hoveredPick = target;
    applyHover();
}

/** The last thing the pointer was over, before the tool had its say. See resolveHover. */
let hoveredPick = null;

let hovered = null;
let hoveredKey = null;

/**
 * Work out what the last pick means under the chosen tool, and redraw if it moved.
 *
 * Split from onHovered because a tool change re-answers the question without the pointer
 * having moved: switching to the wall tool over the middle of a cell turns what is under
 * the pointer from that cell into one of its edges.
 */
function applyHover() {
    const next = resolveHover(hoveredPick);

    // A pointermove arrives every few pixels and most of them are over the same cell as
    // the last. Rebuilding the column and the labels for each would be a redraw per
    // pixel of a slow drag across the floor.
    const key = next && `${next.kind}:${next.x},${next.y},${next.axis ?? ''}`;
    if (key === hoveredKey) return;

    hoveredKey = key;
    hovered = next;

    updateStatus();
    updateLabels();
}

/**
 * What the pointer is over, which depends on which tool is chosen.
 *
 * With the wall tool, a cell resolves to one of its edges -- because that is what a click
 * there would paint. An edge with no wall on it is a sliver a few pixels high, so a pick
 * almost never lands on one directly, and reporting the cell instead would have the status
 * column and the label describing the floor while the only thing a click could change is
 * a wall.
 *
 * `nearestEdge` returns nothing at the corners of a cell, which belong to no edge, and
 * nothing at the outside of the grid, where a cell's outer edge is off it. Nothing is what
 * both of those are: there is no wall there and no click can make one. Showing that is the
 * point rather than a shortcoming -- the corners are where the pointer is between two
 * perpendicular edges and a guess would put a stray wall down, so the label going out is
 * how an author sees where an edge starts and stops answering.
 */
function resolveHover(target) {
    if (!target) return null;

    if (target.kind === 'wall') {
        return { kind: 'wall', x: target.x, y: target.y, axis: target.axis };
    }

    if (toolState.tool === Tool.WALL) {
        const edge = nearestEdge(target);
        return edge && { kind: 'wall', x: edge.x, y: edge.y, axis: edge.axis };
    }

    return { kind: 'cell', x: target.x, y: target.y };
}

/** The left column: what a click would paint, and what is under the pointer. */
function updateStatus() {
    const container = document.querySelector('#building-status');
    if (container) renderStatusPanel(container, open?.model ?? null, toolState, hovered);
}


/**
 * A panel changed something.
 *
 * Panels edit the model directly, so this only has to redraw and remember that the
 * floor no longer matches what is on disk.
 *
 * The URL is asked to catch up here rather than at the one panel that changes something
 * it records -- which layout variation an address is showing. This flow has no windows
 * for core to watch, so the choice is between naming every such site and asking after
 * every edit; asking is the one that cannot be left behind by a new panel. It is cheap:
 * the write is debounced, and skipped when the URL would not change, which is what
 * almost every edit here leaves it.
 */
function onPanelEdit() {
    markDirty();
    view?.refresh();
    updateLabels();
    scheduleSync();
}

/** A change that moves nodes about, so the whole grid has to be read again. */
function onPanelRebuild() {
    markDirty();
    view?.setModel(open?.model ?? null);
    updateLabels();
    scheduleSync();
}

function renderPanels() {
    if (!open?.model) return;

    // Nothing can turn painting on without a mod, but something could already have left
    // it on -- opening a floor, then disconnecting the folder it came from. Settled here
    // rather than guarded at every point a stroke passes through.
    if (!canEdit()) toolState.mode = PaintMode.NONE;

    createPanels({
        floor: document.querySelector('#building-floor'),
        tools: document.querySelector('#building-tools'),
        status: document.querySelector('#building-status'),
        addresses: document.querySelector('#building-addresses'),
        rooms: document.querySelector('#building-rooms'),
        floorTypes: document.querySelector('#building-floor-type'),
        walls: document.querySelector('#building-walls'),
        tiles: document.querySelector('#building-tiles'),
    }, open.model, toolState, {
        onEdit: onPanelEdit,
        onRebuild: onPanelRebuild,
        onToolChange: onToolChanged,
        getHovered: () => hovered,
        getFloor: openFloorContext,
        onOpenFloor: openSlot,
        onGenerateMesh: generateMesh,
        onMeshRoof: setMeshRoof,
        canPaint: canEdit(),
    });

    syncView();
}

/**
 * A tool button was pressed: what the floor is coloured by, the tile squares, and what
 * the pointer is taken to be over.
 */
function onToolChanged() {
    syncView();
    applyHover();
    updateLabels();
    scheduleSync();
}

/**
 * Point the view at whatever the chosen tool is about.
 *
 * The scene is told rather than asked to work it out: it is handed a model and draws it,
 * and which tool is active is not part of a floor. This is the only place the two meet.
 */
function syncView() {
    syncOverlay();
    syncTileOverlay();
}

/**
 * How the floor is coloured, chosen by the tool rather than by a control of its own.
 *
 * A dropdown in the bar was a second thing to set for a question the tool has already
 * answered: you choose the room tool to work on rooms, so rooms are what the floor should
 * be telling you apart. The three tools with no colouring of their own -- address, wall
 * and tile -- fall back to the address colours, which is what makes a wall or a tile
 * readable: both are placed with respect to where one dwelling ends and the next begins.
 */
const OVERLAY_FOR_TOOL = {
    [Tool.ADDRESS]: Overlay.ADDRESS,
    [Tool.WALL]: Overlay.ADDRESS,
    [Tool.TILE]: Overlay.ADDRESS,
    [Tool.ROOM]: Overlay.ROOM,
    [Tool.FLOOR_TYPE]: Overlay.FLOOR_TYPE,
};

function syncOverlay() {
    view?.setOverlay(OVERLAY_FOR_TOOL[toolState.tool] ?? Overlay.ADDRESS);
}

/** Show the tile squares while the tile tool is chosen. */
function syncTileOverlay() {
    view?.setTileOverlay(toolState.tool === Tool.TILE);
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

/** How far above the floor a label floats: clear of the walls, which stand at 0.55. */
const LABEL_HEIGHT = 0.8;

/**
 * What the pointer is over, labelled with HTML positioned over the canvas.
 *
 * One label rather than 441. The reference tool puts the room preset, its id and the
 * coordinates on every cell with TextMeshPro; this shows what the cell being looked at
 * carries instead, the coordinates left to the status column, which says them for the
 * same hover. The selected cell has no label of its own: the status column already says
 * what it is, and a second label that stayed put after a click sat over whatever you
 * moved on to look at next.
 *
 * A wall is labelled where the wall is rather than over either of the cells it divides,
 * and says what a click would replace: with the wall tool chosen that is the only thing
 * a click can change, so the cell's room and address are not what is being asked about.
 * A wall picked under any other tool is scenery, and a click on it does nothing at all:
 * applyTool sends the pick to the cell tools, which take a cell and return unchanged for
 * anything else. So nothing is labelled -- naming the wall would read as an offer to
 * change it, and naming the cell behind it would describe something the click never
 * reaches.
 */
function updateLabels() {
    const host = document.querySelector(LABELS);
    if (!host || !view) return;

    host.replaceChildren();
    if (!open?.model || !hovered) return;

    const { x, y } = hovered;
    const wall = hovered.kind === 'wall';
    if (wall && toolState.tool !== Tool.WALL) return;

    const text = wall ? describeWallAt(x, y, hovered.axis) : describeCellAt(x, y);
    const at = wall
        ? view.projectWall(x, y, hovered.axis, LABEL_HEIGHT)
        : view.project(x, y, LABEL_HEIGHT);
    if (!text || !at) return;

    const rect = view.canvas.getBoundingClientRect();
    const label = document.createElement('div');
    label.className = 'cell-label hover';
    label.style.left = `${at.left - rect.left}px`;
    label.style.top = `${at.top - rect.top}px`;
    label.textContent = text;
    host.appendChild(label);
}

/**
 * The three things a node carries that the floor is painted with: its room, its address
 * and its floor type. All three whichever of those tools is chosen, because the floor is
 * only coloured by one of them at a time and the label is where the other two are read.
 *
 * The tile tool is the exception. A tile is not a node -- it is the 3x3 block of them the
 * squares are drawn over -- so its own label would sit over a cell describing something
 * nine cells wide. What the tile carries is the one thing that tool can change, and is
 * all the label says while it is chosen.
 */
function describeCellAt(x, y) {
    if (toolState.tool === Tool.TILE) {
        return tileDescription(tileForNode(open.model, x, y), open.model.stairwellElevators);
    }

    const described = describeCell(open.model, x, y);
    if (!described) return null;

    return `${described.room}\n${described.address}\n${
        floorDescription(described.floorType, described.height)}`;
}

/**
 * A wall, where there is one.
 *
 * A bare edge is left unlabelled. The wall tool puts the pointer on the nearest edge
 * wherever in a cell it actually is, so most of a floor's edges are bare and a "None"
 * following the pointer around said nothing you could not see. The status column still
 * names it, for the hover that is asking.
 */
function describeWallAt(x, y, axis) {
    const wall = getWall(open.model, x, y, axis);
    if (!wall) return null;

    const name = wallPresetName(wall.preset);
    const where = `${x}, ${y} (${axis})`;

    return wall.matched ? `${name}\n${where}` : `${name}\n${where}\nsides disagree`;
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

    // With no mod selected there is nowhere to write. Left to schedule, the autosave
    // would come back in 600ms, alert that no mod is selected, and throw out of a timer
    // where nothing can catch it. The floor is still editable in memory; the bar says so.
    if (!canEdit()) return;

    if (!shouldSave(false)) return;

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveFloor(); }, SAVE_DELAY);
}

/**
 * The preset a building's floors should be written into, or null once the author has been
 * told why there is none.
 *
 * `presetForSaving` refuses rather than inventing a preset for a building it cannot read or
 * cannot find -- see buildingLibrary.js, and the file that inventing one produced. Every
 * caller of this is a button, so a refusal has to be said out loud: swallowed, the button
 * would appear to do nothing whatever.
 *
 * Not used by the autosave, which has more to say than the refusal itself -- the floor is
 * already written by then -- and more to do about it. See saveFloor.
 */
async function presetToWrite(folder, buildingName) {
    try {
        return (await presetForSaving(folder, buildingName)).preset;
    } catch (error) {
        console.error('Could not read the building to write it back', error);
        alert(error.message);
        return null;
    }
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
    if (!canEdit()) return;
    if (!shouldSave(force)) return;

    assertModSelected();
    const folder = contentFolder();

    await writeCustomBlueprint(folder, open.model.floorName, serialiseFloor(open.model));

    if (open.building) {
        // Both read before the awaits below, because `open` is replaced by whatever is
        // opened next and the message has to name the floor that was actually written.
        const building = open.building;
        const floorName = open.model.floorName;

        try {
            const { preset } = await presetForSaving(folder, building);
            if (open.slot) open.slot = setBlueprint(preset, open.slot, open.model.floorName);
            await writeCustomPreset(folder, building, preset);
        } catch (error) {
            // The blueprint is already on disk, so nothing drawn has been lost; what failed
            // is pointing the building at it. presetForSaving refuses rather than inventing
            // a preset, so this is reached with the building's file exactly as it was --
            // which is the point of it refusing.
            //
            // The building is then let go of, for the same reason openFloor declines to
            // take one it cannot find: the autosave comes back on the next stroke, and a
            // name that failed once will fail every time. Repeating the alert per stroke
            // would be worse than the slot the floor gives up, and holding the name while
            // saying nothing more would be worse than both.
            console.error('Could not save the floor against its building', error);

            if (open?.building === building) {
                open.building = null;
                open.slot = null;
            }

            alert(`"${floorName}" has been saved, but it could not be pointed at `
                + `${building}: ${error.message}`);
        }
    }

    // The floor may have been saved under a new name, and its building may have become
    // the mod's just now -- both change what the panel should say.
    open.blueprint = open.model.floorName;
    open.isCustom = true;

    // Saving can put a floor in a slot it was not in before -- a base game building
    // becoming a stub, or a slot appended for one that had none -- so the storeys the
    // Floor section steps through are read again rather than left as they were opened.
    open.storeys = await storeysForBuilding(open.building);

    dirty = false;

    await refreshPanel();
    updateHeading();

    // The floor that just changed is one the building's mesh may have been built from,
    // which is the whole of what makes window data go stale. Not waited for: it reads
    // every floor of the building, and this runs at the end of a 600ms autosave.
    refreshMeshState();
}

/** The explicit Save button, which writes whatever the autosave switch says. */
export async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveFloor(true);
}


/* -------------------------------------------------------------------------- */
/* The building's model                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What the last generation did, whether the building's model still matches its floors,
 * and whether the next one puts a top on it.
 *
 * `stale` is three-valued on purpose. `true` and `false` are answers about a building
 * whose mesh this app generated; `null` is *no question* -- a building copying its model
 * from a base game one, or one that has never had a mesh generated, has nothing that
 * could have gone out of date and nothing regenerating would fix.
 *
 * `roofChosen` is what keeps the checkbox from being answered over the top of. The
 * preset only learns the answer when a mesh is generated, so between ticking the box and
 * pressing the button every autosave reads a preset that still says the old thing --
 * and without this, the first one would untick it again.
 */
const NO_MESH_STATE = { busy: false, stale: null, status: '', roof: true, roofChosen: false };

let meshState = NO_MESH_STATE;

/**
 * A blueprint's data by name, which is what the generator reads floors through.
 *
 * The mod's copy first and the base game's second, exactly as opening a floor does -- a
 * building whose floors are half its own and half the base game's is the ordinary case,
 * and the model has to be built from what the game will actually load.
 */
const resolveFloorData = async (blueprint) =>
    (await resolveBlueprint(contentFolder(), blueprint))?.data ?? null;

/**
 * Remember whether the next mesh gets a top, without redrawing to say so.
 *
 * The checkbox is already showing what was just clicked, and the Floor panel is rebuilt
 * from scratch every time it is drawn -- so redrawing here would take the focus off the
 * box the author is still on and put nothing new on screen. Nothing is written to the
 * preset either: the answer belongs to the mesh, and there is no mesh until Generate.
 */
function setMeshRoof(roof) {
    meshState = { ...meshState, roof, roofChosen: true };
}

/**
 * Build the model, textures, prefab and window data for the open floor's building.
 *
 * Everything the game needs to draw a building that is not copying its appearance from a
 * base game one: an OBJ, five PNGs, a prefab definition, and the `sortedWindows` block
 * that decides which rectangle lights up when a room's light comes on.
 *
 * Unsaved edits are written first. The mesh is read off the *files*, so generating with a
 * floor half-painted would produce a model of the version on disk and immediately declare
 * itself stale against the one on screen -- which is true, and not what anyone pressing
 * the button meant.
 *
 * On a base game building this creates the mod's stub of it first, the same way saving a
 * floor against one does. That is not a side effect to be quiet about: the generated
 * prefab and window data are exactly what stops the stub deferring to the original, so a
 * stub is what has to exist for any of this to be written at all.
 */
export async function generateMesh() {
    const folder = contentFolder();

    // The button is disabled when either is missing. This is the guard against being
    // called some other way.
    if (!folder || !open?.building || meshState.busy) return;

    if (dirty) await saveFloor(true);

    const building = open.building;
    const roof = meshState.roof;

    meshState = { ...meshState, busy: true, stale: null, status: 'Reading the floors…' };
    updateFloorPanel();

    try {
        const { preset } = await presetForSaving(folder, building);
        const result = await generateBuilding(building, preset, resolveFloorData, { roof });

        if (!result.ok) {
            meshState = { ...meshState, busy: false, stale: null, status: result.reason };
        } else {
            // The prefab before the preset that points at it, for the same reason a floor
            // is written before the building that names it: a preset naming a model that
            // is not there is a building the city cannot draw, and the other way round is
            // seven files nothing reads.
            await writeGeneratedBuilding(folder, building, result.files);
            await writeCustomPreset(folder, building, preset, { alsoWritten: GENERATED_FIELDS });

            // The preset now says what the checkbox says, so reading it back is no longer
            // reading a stale answer over the top of the author's.
            meshState = {
                busy: false, stale: false, status: describeGeneration(result),
                roof, roofChosen: false,
            };
        }
    } catch (error) {
        console.error('Could not generate the building mesh', error);
        meshState = {
            ...meshState, busy: false, stale: null,
            status: `Could not generate: ${error.message}`,
        };
    }

    // The building may have become the mod's just now, which changes what Browse lists
    // and puts the Floor section's own storeys back in step.
    if (open?.building === building) open.storeys = await storeysForBuilding(building);
    await refreshPanel();
}

/** What was built, in the one line the panel has for it. */
function describeGeneration(result) {
    const parts = [
        `${result.floorCount} window row${result.floorCount === 1 ? '' : 's'}`,
        `${result.height.toFixed(1)} m`,
        `${result.triangleCount} tris`,
        `${result.windowCount} window${result.windowCount === 1 ? '' : 's'}`,
    ];

    // All three are worth saying out loud rather than only in the console. A floor that
    // could not be read is a hole in the model, and what the ground floor and a rooftop
    // get is deliberate but surprising -- the ground floor is drawn by the street frontage
    // in front of it, and a rooftop is in the silhouette without being a window row.
    const notes = [];
    if (result.excluded.length) notes.push(`Not modelled: ${result.excluded.join(', ')}.`);
    if (result.shellOnly.length) notes.push(`Shell only: ${result.shellOnly.join(', ')}.`);
    if (result.missing.length) notes.push(`Floors not found: ${result.missing.join(', ')}.`);

    return [`${parts.join(', ')}.`, ...notes].join(' ');
}

/**
 * Ask whether the open building's model still describes its floors, and redraw if so.
 *
 * Cheap for the buildings it does not apply to: `isMeshStale` answers null and reads
 * nothing when the preset carries no hash, which is every building whose mesh this app
 * never generated. Only one that *was* generated pays for reading its floors again.
 *
 * The building is checked again before the answer is used, because this runs unawaited
 * from opening and saving and either can be overtaken by opening a different floor.
 */
async function refreshMeshState() {
    const building = open?.building;
    if (!building || !contentFolder()) return;

    try {
        const preset = await readCustomPreset(contentFolder(), building);
        const stale = preset ? await isMeshStale(preset, resolveFloorData) : null;

        if (open?.building !== building || meshState.busy) return;

        meshState = {
            ...meshState,
            stale,
            // Only until the author has said otherwise. Between ticking the box and
            // generating, the preset still describes the mesh on disk rather than the one
            // about to be built, and this runs after every autosave.
            roof: meshState.roofChosen ? meshState.roof : (preset?.[MESH_ROOF_FIELD] ?? true),
        };
        updateFloorPanel();
    } catch (error) {
        // Whether a mesh is out of date is a footnote. A folder that went away underneath
        // this is not worth interrupting an edit over, and the next save asks again.
        console.error('Could not check whether the building mesh is up to date', error);
    }
}



/* -------------------------------------------------------------------------- */
/* Buildings                                                                   */
/* -------------------------------------------------------------------------- */

const ADD_BUILDING_MODAL = '#new-building-modal';

const field = (id) => document.getElementById(id);

/**
 * Ask what the new building is, before any of it is written.
 *
 * Three answers, because a building's name is two different things:
 *
 *   Title        what a player reads. It is used in one place only -- a row in the
 *                mod's names.rooms.csv, keyed by the preset name -- so it may hold
 *                spaces and punctuation like any other line of text.
 *   Preset name  what everything else uses: the file it is written to, the `REF:`
 *                string a floor's building points at, and the key that strings row is
 *                stored against. So it has to be safe as an identifier and as a file
 *                name, which is what makeNameFieldSafe means by safe.
 *   Copy from    a base game building to take a prefab, mesh and window data from.
 *
 * Asked together in a dialog rather than one prompt after another, so they can be seen
 * and changed against each other, and so cancelling leaves nothing behind.
 *
 * Offering a base game building to copy from is the point of this rather than an
 * extra: a building of its own has no prefab, no mesh and no window data, so the game
 * has nothing to draw until those are generated. One that copies from a base game
 * building has all three from the start and only its floors are the mod's.
 */
export async function showAddBuilding() {
    // The button is disabled without a content folder, so this is only the guard against
    // being called some other way.
    if (!canEdit()) {
        alert('Choose a mod and content folder first');
        return;
    }

    field('new-building-form').reset();

    // reset() clears the fields but not what was learned about them, and a preset name
    // that stayed "edited" from a previous building would sit empty while the title was
    // typed.
    delete field('new-building-preset-name').dataset.edited;

    await fillCopyFromOptions();

    document.querySelector(ADD_BUILDING_MODAL).setAttribute('open', '');
    field('new-building-title').focus();
}

export function closeAddBuilding() {
    document.querySelector(ADD_BUILDING_MODAL)?.removeAttribute('open');
}


/* -------------------------------------------------------------------------- */
/* Help                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What the editor is and how the pieces of a building fit together, plus the controls.
 *
 * Under the id the other two flows use for theirs, which is safe because only one flow is
 * mounted at a time -- and the same reason these two handlers may take the names those
 * flows give theirs. The registry removes the last flow's globals before installing the
 * next flow's, so a name is only ever the active flow's.
 */
const HELP_MODAL = '#help-modal';

export function showHelp() {
    document.querySelector(HELP_MODAL)?.setAttribute('open', '');
}

export function closeHelp() {
    document.querySelector(HELP_MODAL)?.removeAttribute('open');
}

/**
 * The base game's buildings, listed for copying from.
 *
 * Rebuilt each time the dialog opens rather than once: the index is fetched once per
 * page and cached, so this is a list rebuild, and the dialog's markup goes away with the
 * flow's template when another editor is shown.
 */
async function fillCopyFromOptions() {
    const select = field('new-building-copy-from');
    const index = await loadFloorIndex();

    // "None" is a real answer, not a placeholder, so it is the first option rather than
    // an empty selection -- and it stays as the default, because a building of its own
    // is the one choice that cannot be undone by picking differently later.
    select.replaceChildren(new Option('None', ''));
    for (const name of index.buildings) select.append(new Option(name, name));

    select.value = '';
}

/**
 * The preset name follows the title while it has not been typed into, made safe on the
 * way -- "Grand Hotel" gives GrandHotel.
 *
 * Derived rather than asked for twice: the two are the same word for almost every
 * building, and the difference between them is exactly what makeNameFieldSafe takes out.
 * Typing in the field stops it following, because from then on it is an answer rather
 * than a guess.
 */
export function syncPresetNameToTitle() {
    const presetName = field('new-building-preset-name');
    if (presetName.dataset.edited === 'true') return;

    presetName.value = makeNameFieldSafe(field('new-building-title').value);
}

export function markPresetNameEdited() {
    field('new-building-preset-name').dataset.edited = 'true';
}

export async function submitAddBuilding() {
    const folder = contentFolder();
    if (!folder) {
        alert('Choose a mod and content folder first');
        return;
    }

    const title = field('new-building-title').value.trim();
    const presetName = field('new-building-preset-name').value.trim();
    const copyFrom = field('new-building-copy-from').value || null;

    // Both are `required`, so the browser will not submit without them. This is the
    // guard against being called some other way.
    if (!title || !presetName) return;

    // The input's pattern says the same thing, but a preset name that got past it would
    // be a file name with a space in it and a `REF:` string nothing resolves.
    if (!isNameFieldSafe(presetName)) {
        alert('A preset name can hold only letters, digits, hyphens and underscores.');
        return;
    }

    const existing = await listCustomBuildings(folder);
    if (existing.some((entry) => entry.name === presetName)) {
        alert(`This mod already has a building called "${presetName}".`);
        return;
    }

    // Only closed once the answers are known to be usable: a dialog that closes on a
    // name the mod already has would leave the alert as the only sign of what happened,
    // with everything typed thrown away.
    closeAddBuilding();

    await createCustomBuilding(folder, presetName, { copyFrom, title });
    await writeBuildingTitle(folder, presetName, title);

    await refreshPanel();
}

/**
 * The building's readable name, as a row in the mod's room names CSV.
 *
 * This is the only place a title is used: the preset carries it, but what the game
 * shows a player is what this row says, looked up by the preset name.
 *
 * A failure here does not undo the building. The preset is the thing that was asked
 * for and it is on disk by now; a missing row shows in game as the preset name, which
 * is recoverable by hand and not worth throwing the building away over. So it is
 * reported rather than thrown -- silently swallowing it would leave a building that
 * quietly never gets its name.
 */
async function writeBuildingTitle(folder, presetName, title) {
    try {
        await writeStringsRow(folder, ROOM_NAMES_VIRTUAL, presetName, title);
    } catch (error) {
        alert(`The building was created, but its title could not be written: ${error.message}`);
    }
}


/* -------------------------------------------------------------------------- */
/* Floors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The content folder to write in, or nothing and a word about why not.
 *
 * Every one of these is reached from a button the panel only draws for a mod's own
 * building, so this is the guard against being called some other way rather than
 * something an author is expected to meet.
 */
function folderToWriteIn() {
    const folder = contentFolder();
    if (!folder) alert('Choose a mod and content folder first');
    return folder;
}

/**
 * How much of the storey it sits against a new storey starts as.
 *
 * The order they are offered in, which is most to least: a floor that copies everything
 * is a floor to alter, and one that starts empty is a floor to draw.
 */
export const StoreyStart = {
    /** Everything: rooms, addresses, fittings. */
    WHOLE: 'whole',
    /** The walls, and the tiles holding the stairwells and the entrances. */
    FITTINGS: 'fittings',
    /** The wall between inside and out, without the partitions inside it. */
    OUTLINE: 'outline',
    /** The roof over it: its shape as a rooftop. See scripts/roofGenerator.js. */
    ROOF: 'roof',
    /** Nothing: the whole lot as one room, as a building's first floor starts. */
    EMPTY: 'empty',
};

/**
 * Add a storey to one of the mod's buildings and open it.
 *
 * A building grows in two directions and the game keeps the two apart -- `floorLayouts`
 * counts up from the ground floor, `basementLayouts` down from it -- so which of them is
 * being added is the caller's, from the button that was pressed.
 *
 * What the new storey starts as is asked before anything is written, because there is no
 * one right answer: a tower's floors are mostly the same shape with different rooms in
 * them, its lobby is not, and its roof is neither.
 */
async function addStorey(buildingName, { isBasement = false } = {}) {
    const folder = folderToWriteIn();
    if (!folder) return;

    closeBrowse();

    // What the new storey starts as is read off the storey it sits against, so a
    // debounced save of the floor that is open has to land first. Otherwise drawing a
    // wall and reaching straight for Add floor copies the floor as it was before that
    // wall -- and here it would also be described in the dialog as the floor it was.
    await flushPendingSave();

    // Read before the question is asked, because what the building already has is what
    // decides which answers are worth offering. Nothing is written by reading it -- but a
    // building that cannot be read is one there is no point asking about, since the answer
    // could not be written either.
    const preset = await presetToWrite(folder, buildingName);
    if (!preset) return;

    const against = adjoiningStorey(storeysOf(enumerateSlots(preset)), { isBasement });

    const start = await askStoreyStart(buildingName, { isBasement, against });
    if (!start) return;

    await writeNewFloor(folder, buildingName, { isBasement, start });
}

/**
 * Add another layout of a storey the building already has, and open it.
 *
 * Not asked about, unlike a storey: the blueprints in one setting are alternatives of
 * the same storey that the game picks between, so a new one is that storey again, to be
 * altered rather than drawn. Anything less than the whole of it would be a different
 * storey wearing its number.
 */
async function addLayout(buildingName, storey) {
    const folder = folderToWriteIn();
    if (!folder) return;

    closeBrowse();
    await flushPendingSave();

    await writeNewFloor(folder, buildingName, { storey });
}

/**
 * Write the floor and point the building at it.
 *
 * Two files, and in the same order as saving: the blueprint, then the building that
 * names it. A building pointing at a floor that is not there is the failure that shows
 * in game as a missing floor.
 *
 * Adding a storey and adding a layout are one function because they differ only in which
 * slot is asked for. A storey goes in a setting of its own -- `layoutIndex: -1` is
 * setBlueprint's "a new one" -- and a layout goes on the end of an existing setting,
 * which is what the blueprint list in a setting is: the alternatives the game picks
 * between for that one storey.
 *
 * The floor is named rather than asked about. A floor's name is not content: it is what
 * the building refers to it by, it is never shown to a player, and there is nothing to
 * say about a floor before seeing it. Opening it immediately is the answer to "and now
 * what" -- the name can be changed on the floor itself.
 *
 * @param storey a storey from storeysOf to add a layout to, or null for a new storey
 */
async function writeNewFloor(folder, buildingName, { storey = null, isBasement = false, start = null }) {
    const name = await nextFloorName(folder, buildingName, { storey, isBasement });

    // Read again here rather than passed in, because what the new floor starts as
    // depends on what the building has now -- the dialog above is not modal, and the
    // building may have gained a floor while it was open. Still only read: the write
    // order is the blueprint and then the building, as below.
    //
    // Before the blueprint is written, so that a building that refuses leaves nothing
    // behind. A floor written for a building that could not be pointed at it is a file
    // nothing reads and nothing lists.
    const preset = await presetToWrite(folder, buildingName);
    if (!preset) return;

    const data = await newFloorData(folder, name, preset, { storey, isBasement, start });
    await writeCustomBlueprint(folder, name, data);

    // A blueprintIndex outside the list appends rather than leaving a hole, so a layout
    // lands after the ones already in the storey. Never a control room variant: those
    // are the same layouts with a control room in them, which is not something this can
    // make out of a blank floor.
    const slot = setBlueprint(preset, storey
        ? {
            isBasement: storey.isBasement,
            isControlVariant: false,
            layoutIndex: storey.layoutIndex,
            blueprintIndex: -1,
        }
        : { isBasement, isControlVariant: false, layoutIndex: -1, blueprintIndex: 0 },
        name);
    await writeCustomPreset(folder, buildingName, preset);

    await refreshPanel();
    await openFloor({ building: buildingName, blueprint: name, slot });
}

/**
 * What a new floor starts as: some floor already in the building, or a blank floor if
 * there is none.
 *
 * Which floor it reads is settled here; how much of that floor comes across is the
 * author's answer, or the whole of it for a layout.
 *
 * A new *layout* is an alternative of a storey that already exists, which the game picks
 * between when it builds the city -- so it starts as that storey copied whole, addresses
 * and rooms and fittings included.
 *
 * A new *storey* goes on the top of the building or under the bottom of it, so it starts
 * from the storey it will sit against -- as much of that storey as was asked for. A
 * building is one shape all the way up; what is inside the walls is what makes one
 * storey differ from the next, which is why the whole of it is not the default.
 *
 * Either way it is read off the *first* blueprint of that storey: they are alternative
 * layouts of one storey and share its walls.
 *
 * The storey is looked up again in the preset that was just read rather than taken from
 * the one the panel was built with, so that a storey the panel is out of date about
 * yields a blank floor instead of some other storey's walls. A building with nothing in
 * it yet yields one too, whatever was asked for: there is nothing to copy, which is what
 * the dialog says while it offers the answer this falls back to.
 *
 * A floor the mod does not hold resolves to the base game's copy, which is what a stub
 * building's floors are -- so adding a floor to a stub of a base game building starts
 * from that building's own shape.
 */
async function newFloorData(folder, name, preset, { storey = null, isBasement = false, start = null }) {
    if (!storey && start === StoreyStart.EMPTY) return blankFloor(name);

    const storeys = storeysOf(enumerateSlots(preset));
    const source = storey
        ? storeys.find((candidate) => candidate.key === storey.key)
        : adjoiningStorey(storeys, { isBasement });

    const from = firstLayoutOf(source);
    const data = from ? (await resolveBlueprint(folder, from))?.data : null;
    if (!data) return blankFloor(name);

    if (storey || start === StoreyStart.WHOLE) return floorCopy(name, data);
    if (start === StoreyStart.OUTLINE) return floorLike(name, data, { outline: true });
    if (start === StoreyStart.ROOF) return generateRoof(name, data);

    return floorLike(name, data, { tiles: true });
}

const ADD_STOREY_MODAL = '#add-storey-modal';
const STOREY_START_INPUTS = '#add-storey-options input[name="storey-start"]';

/**
 * The answer the open Add floor / Add basement dialog is waiting for.
 *
 * The dialog is asked from the middle of adding a storey, so it hands back a promise
 * rather than a value and this is what settles it. Dismissing settles it too, with null:
 * a promise left pending would be an Add floor that never finished and never said so.
 */
let storeyStartResolve = null;

/**
 * Ask what the new storey should start as.
 *
 * Every answer but the last copies from the storey the new one will sit against, so the
 * dialog says which storey that is: "the floor below" is not something an author can
 * check, and on a building whose panel is out of date it would be wrong.
 *
 * A building with no storeys yet has nothing to copy, so those answers are shown
 * disabled with the reason rather than hidden. The button then does what it always does
 * -- the shape of what it is offering is what changes, which is a thing to read rather
 * than a thing to notice the absence of.
 *
 * @param against the storey the new one will sit against, or null if there is none
 * @returns one of StoreyStart, or null if the dialog was dismissed
 */
async function askStoreyStart(buildingName, { isBasement = false, against = null } = {}) {
    const dialog = document.querySelector(ADD_STOREY_MODAL);
    if (!dialog) return null;

    // A dialog opened over one that was never answered. The first caller is waiting on a
    // promise nothing else will settle, and it asked about the building as it was.
    storeyStartResolve?.(null);
    storeyStartResolve = null;

    const title = isBasement ? 'Add basement' : 'Add floor';
    field('add-storey-title').textContent = `${title} to ${buildingName}`;
    field('add-storey-submit').textContent = title;

    field('add-storey-source').textContent = against
        ? `Copying from ${against.label}, the storey this one will sit `
            + `${isBasement ? 'under' : 'on'}.`
        : `${buildingName} has no storeys yet, so there is nothing to copy from.`;

    // Walls, stairs and entrances is the default where there is something to copy: a
    // building is one shape all the way up, and its stairwell has to be in the same
    // place on every storey it passes through, so those are the parts that are wrong
    // if they are not carried rather than the parts that are wrong if they are.
    const fallback = against ? StoreyStart.FITTINGS : StoreyStart.EMPTY;

    for (const input of document.querySelectorAll(STOREY_START_INPUTS)) {
        // A roof goes on the top of a building. Under the bottom of one it is not an
        // answer that is unavailable, it is not an answer -- so it is taken away rather
        // than dimmed, which is what the answers that need something to copy are.
        const roofDownwards = isBasement && input.value === StoreyStart.ROOF;
        input.closest('label').hidden = roofDownwards;

        input.disabled = roofDownwards || (!against && input.value !== StoreyStart.EMPTY);
        input.checked = input.value === fallback;
    }

    dialog.setAttribute('open', '');

    return new Promise((resolve) => { storeyStartResolve = resolve; });
}

/** Settle the dialog and put it away. */
function answerStoreyStart(answer) {
    document.querySelector(ADD_STOREY_MODAL)?.removeAttribute('open');

    const resolve = storeyStartResolve;
    storeyStartResolve = null;
    resolve?.(answer);
}

export function closeAddStorey() {
    answerStoreyStart(null);
}

export function submitAddStorey() {
    const chosen = document.querySelector(`${STOREY_START_INPUTS}:checked`);

    // One is always checked, so this is the guard against being called some other way.
    if (!chosen) return;

    answerStoreyStart(chosen.value);
}

/**
 * `<Building>_Floor1`, or the first number after it that nothing has taken. A basement
 * is `<Building>_Basement1`, because the two are separate lists in the preset and a
 * basement called Floor is a file whose name says where it is and is wrong. A layout is
 * named after the storey it is a layout of instead -- `<Building>_Floor0_v1` -- because
 * the next free floor number would name a floor the building does not have.
 *
 * Checked against the base game's blueprints as well as the mod's: a mod floor named
 * after a base game one shadows it everywhere it is used, so a name that collides by
 * accident would silently replace a floor in some other building.
 */
async function nextFloorName(folder, buildingName, { storey = null, isBasement = false } = {}) {
    const taken = new Set([
        ...await listCustomBlueprints(folder),
        ...(await loadFloorIndex()).blueprints ?? [],
    ]);

    const stem = storey
        ? `${buildingName}_${storey.isBasement ? 'Basement' : 'Floor'}${storey.layoutIndex}_v`
        : `${buildingName}_${isBasement ? 'Basement' : 'Floor'}`;

    for (let n = 1; ; n++) {
        const name = `${stem}${n}`;
        if (!taken.has(name)) return name;
    }
}

/**
 * Take a floor out of a building, and delete the mod's copy of it.
 *
 * Both halves, because either on its own leaves something misleading behind: the file
 * with nothing referring to it, or a building naming a floor that is not there.
 *
 * Only ever the mod's own file. A slot holding a base game blueprint has no file here to
 * delete, and deleting the mod's copy of a floor the base game also has uncovers the
 * original rather than losing it -- so on a stub, this means "stop overriding it".
 *
 * `slot` is null for a floor no building uses, which is a file and nothing else.
 */
async function deleteFloor(buildingName, blueprint, slot) {
    const folder = contentFolder();
    if (!folder) return;

    if (!confirm(`Delete the floor "${blueprint}" from this mod?`)) return;

    closeBrowse();

    // Anything unsaved in the floor being deleted would otherwise be written back out
    // moments after the file was removed.
    if (open?.blueprint === blueprint) {
        clearTimeout(saveTimer);
        saveTimer = null;
        closeFloor();
    } else {
        await flushPendingSave();
    }

    // The file first, then the building. A preset is written pointing at the floors the
    // mod holds at that moment, so taking the slot out first would leave any *other* slot
    // naming the same floor -- a building may list one twice -- pointing at a file that
    // was about to be deleted. This way that slot comes back a bare name, which is the
    // base game's copy if there is one and nothing if there is not.
    await deleteCustomBlueprint(folder, blueprint);

    if (buildingName && slot) {
        // A building that cannot be read leaves the slot naming a floor that has gone,
        // which is the lesser of the two: the file is deleted either way, and the author
        // has been told which building still points at it.
        const preset = await presetToWrite(folder, buildingName);
        if (preset && removeBlueprint(preset, slot)) {
            await writeCustomPreset(folder, buildingName, preset);
        }
    }

    await refreshPanel();
}

/** Put the editor back to nothing open. */
function closeFloor() {
    open = null;
    hoveredPick = null;
    hovered = null;
    hoveredKey = null;
    dirty = false;
    meshState = NO_MESH_STATE;

    // Before the model goes: what was selected was a square of the floor being closed.
    clearSelection();

    view?.setModel(null);
    updateHeading();
    updateStatus();
    updateFloorPanel();
    updateLabels();

    scheduleSync();
}

/**
 * Lay out a new content folder as a building mod.
 *
 * Returned to core/newContent.js, which calls it once the folder exists. The Floors
 * directory is created empty because it is what marks the folder as holding buildings
 * -- without it the folder would not be offered as content to edit at all.
 *
 * The manifest is written for the same reason it is written for a building added to an
 * existing mod: a preset it does not name is a preset the loader never reads. This does
 * not go through writeCustomPreset, which would list it -- the file written here is the
 * bare minimum a building can be rather than a preset with its defaults dropped -- so it
 * says so itself.
 */
export function scaffoldBuildingFolder(name) {
    return async (folder) => {
        const preset = stubFor(name, null, { copyFrom: null });

        // Named for the building and for what it is, as everything written here is:
        // see core/soFileName.js. The manifest names the file, so it gets the stem.
        const stem = stemFor(name, BUILDING_TYPE);

        const handle = await getFile(folder, [`${stem}${PRESET_SUFFIX}`], true);
        await writeFile(handle, `${JSON.stringify({
            name: preset.name,
            presetName: preset.presetName,
            type: BUILDING_TYPE,
            fileType: BUILDING_TYPE,
            copyFrom: null,
        }, null, 2)}\n`);

        await ensureListed(folder, stem);

        await getFolder(folder, [FLOORS_DIR], true);
    };
}


/* -------------------------------------------------------------------------- */
/* View controls                                                               */
/* -------------------------------------------------------------------------- */

export function resetView() {
    view?.resetView();
    updateLabels();
}


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

    closeFloor();
    await refreshPanel();
}

/**
 * A floor slot as one parameter, and back.
 *
 * A slot is not a number: it is the four coordinates enumerateSlots names -- above or
 * below ground, which floor setting, ordinary or control variant, and which of that
 * setting's list. Writing one with `String` put "[object Object]" in the URL, so coming
 * back left the floor open with no slot the building recognised: the Floor section said
 * "Not in this building", up and down went nowhere, and the layout select was gone. The
 * blueprint name cannot stand in for it -- nothing stops a building listing one floor in
 * two slots, which is why the storey is found by slot in the first place.
 *
 * The four in that order, comma-separated for the same reason `variations` is: they are
 * plain numbers, and this is shorter and no less readable than JSON. Decoding is strict
 * and gives back nothing rather than a wrong answer -- a hand-edited or truncated value
 * should leave the floor open with no slot, which is the state a floor no building refers
 * to is already in and which the panels already say.
 */
function encodeSlot(slot) {
    if (!slot) return null;

    return [
        slot.isBasement ? 1 : 0,
        slot.isControlVariant ? 1 : 0,
        slot.layoutIndex,
        slot.blueprintIndex,
    ].join(',');
}

function decodeSlot(value) {
    const parts = (value ?? '').split(',');
    if (parts.length !== 4) return null;

    const [isBasement, isControlVariant, layoutIndex, blueprintIndex] = parts.map(Number);

    if (isBasement !== 0 && isBasement !== 1) return null;
    if (isControlVariant !== 0 && isControlVariant !== 1) return null;
    // Negative means "somewhere new" to setBlueprint, which is not a place to reopen.
    if (!Number.isInteger(layoutIndex) || layoutIndex < 0) return null;
    if (!Number.isInteger(blueprintIndex) || blueprintIndex < 0) return null;

    return {
        isBasement: isBasement === 1,
        isControlVariant: isControlVariant === 1,
        layoutIndex,
        blueprintIndex,
    };
}

/**
 * The floor that is open, as URL parameters.
 *
 * The variation each address is showing is part of it: a blueprint has nowhere to
 * record which of an address's layouts you were editing, so without this, coming back
 * would silently drop you onto layout 0 of every one of them. They are plain numbers,
 * so a comma-separated list is enough and shorter than JSON would be.
 *
 * Read-only, and cheap: the URL asks several times a minute. Leaving the flow is
 * `suspend`.
 */
export function sessionState() {
    if (!open) return {};

    return {
        building: open.building || null,
        blueprint: open.blueprint,
        slot: encodeSlot(open.slot),
        variations: open.model.addresses.map((address) => address.selectedVariation).join(',') || null,
        tool: toolState.tool,
    };
}

/**
 * Leaving this editor for another.
 *
 * The only signal the flow gets that it is being switched away from, so it is where
 * anything unsaved is written and where the WebGL context is given back. See ensureView:
 * a browser allows a handful of contexts across the whole page, and holding one for an
 * editor nobody is looking at is how the next one fails to get one.
 */
export async function suspend() {
    await flushPendingSave();
    releaseView();
}

export async function restoreSession(params) {
    if (!params?.blueprint) return;

    if (params.tool && Object.values(Tool).includes(params.tool)) {
        toolState.tool = params.tool;
    }

    const selections = (params.variations ?? '')
        .split(',')
        .filter((entry) => entry !== '')
        .map(Number)
        .filter((entry) => Number.isInteger(entry) && entry >= 0);

    await openFloor(
        {
            building: params.building ?? null,
            blueprint: params.blueprint,
            slot: decodeSlot(params.slot),
        },
        selections,
        // What the URL names may have been renamed or deleted since, and arriving to an
        // alert about a floor you did not ask for is worse than arriving to no floor.
        { quiet: true });
}
