/**
 * The furniture creator: pick a piece of furniture and see what it is made of.
 *
 * The room creator's sibling, one level down the same chain. Where that one asks what a
 * room will admit, this asks what one admitted thing actually is: which model, which slot
 * it fills, what arrangements it appears in, and what sits on top of it.
 *
 * ## Why all three levels are on screen at once
 *
 * Because an author cannot get from one to another by reading a file. A preset names its
 * classes; a cluster names classes too; nothing points from a preset to the clusters it
 * can appear in, and that hop -- "this is a 3x1 lobby desk, so it turns up in these four
 * arrangements" -- is most of what somebody opening this pane wants to know.
 *
 * ## What is real in the 3D pane
 *
 * The sub-object positions are. The box under them is not: a shipped model lives in an
 * asset bundle this app cannot open, so what is drawn is the footprint its class declares.
 * The pane says so rather than letting a wireframe pass for a desk.
 *
 * Read-only, this pass. Nothing here writes a file -- see the plan's phase 5.
 */
import {
    describePreset, presetNames, proxyBox, modelExtent, clustersFor, clusterLayout,
    coLocated, warningsFor, describeSlot,
} from './furnitureModel.js';
import {
    readAssets, readClusterIndex, haveClusterIndex, readMissing, setModAssets, listAssets,
} from './furnitureAssets.js';
import { readFurnitureFiles, modPreset, readModClasses } from './modFurniture.js';
import { readModel } from './furniturePrefab.js';
import { planFurniture, CLASS_SUFFIX } from './furniturePlan.js';
import {
    describePlacement, explainRule, explainBlock, explainExtent, overhangTiles, boundsOf,
    TAG_MEANING,
} from './furnitureClass.js';
import { drawPlacement, blockNotes } from './furnitureClassView.js';
import { WALL_RULE, BLOCKING_DIRECTION } from '../../../core/furnitureRules.js';
import { INTERACTABLE_ID } from './furnitureEnums.js';
import {
    readModFiles, indexMod, emptyIndex, landAll, commit,
} from '../../../core/soBuilder.js';
import { MANIFEST_FILE } from '../../../core/murderManifest.js';
import { createStepper } from './creatorSteps.js';

/**
 * What each step is for, said in the footer while it is being read.
 *
 * Keyed on the `data-step` in the markup rather than listed in order, for the reason the
 * room creator's are: a step renamed in one place and not the other loses its note instead
 * of putting it on the wrong pane.
 */
const STEP_NOTES = {
    source: 'A preset on its own is a reskin — the model joins the draw for a slot others '
        + 'also fill. What makes a slot this model or nothing is its class and a cluster.',
    placement: 'Front is up. Everything here is in the furniture’s own frame, and the '
        + 'generator tries all four quarter-turns of it.',
    sits: 'Positions are the model’s own, in metres from its origin. Drag one in the view '
        + 'or type the numbers.',
    built: 'Each of these is created at a controller inside the model rather than spawned, '
        + 'so the ids that work are the ones the model already has.',
    appears: 'Nothing in the files points this way round — a preset names classes and so '
        + 'does a cluster — so this is the hop worth having.',
    write: 'Three assets, not one: the preset is the model, the class is where it may '
        + 'stand, the cluster is what puts it down.',
};

/** The step rail, built on first open. Null until the dialog is on screen. */
let steps = null;

/** What `drawPlan` last worked out, for the rail to read without planning again. */
let planned = null;

/**
 * What is being looked at.
 *
 * `selected` is a sub-object rather than an index into one list, because there are two
 * lists -- placed and parented -- and an index alone cannot say which.
 *
 * `mod` is the selected content folder's own presets, keyed by name, and `model` is
 * whatever was read off disk for the one that is open -- either its meshes or the name of
 * the file that was not there.
 */
const state = {
    preset: null,
    search: '',
    selected: null,

    /*
     * Which integrated interactable is marked, as an index, or null.
     *
     * Its own state rather than a third case of `selected`, because the two are not the
     * same kind of thing: a sub-object is a position this pane owns and can drag, and an
     * integrated interactable stands wherever a controller inside the prefab is. They are
     * held apart and marked apart -- selecting one clears the other, so the drag handles
     * cannot sit on a sub-object while an interactable's row is the one highlighted.
     */
    interactable: null,

    showParented: false,
    cluster: null,
    mod: new Map(),
    model: null,

    // The sub-objects as edited, and the name they would be written under. `edits` is null
    // until something is changed, which is what tells the pane whether it is showing a
    // preset or an edit of one -- and what stops a name typed and then cleared from
    // looking like an unsaved change.
    edits: null,
    name: '',

    // The folder as it was when it was last read, for the plan's preview. A preview only:
    // `writeFurniture` reads the folder again rather than trusting it.
    index: emptyIndex(),

    // Why the chosen preset could not be read, where it could not. `readBaseAsset`'s own
    // reason, which distinguishes "your export does not hold this" from "connect one".
    unreadable: null,

    /*
     * The placement half, and what it is looking at.
     *
     * `classIndex` is which of the preset's classes, for the handful that are in more than
     * one. `placement` is the edited rules, null until something changes them -- the same
     * shape as `edits` above and for the same reason.
     *
     * `rule` is the marked rule or block; `tile` is the marked tile as `[x, y]`. Two states
     * rather than one because they answer different questions -- which entry is being edited,
     * and where a new one would go -- and marking a rule marks the tile it is on, so they
     * agree without being the same thing.
     */
    classIndex: 0,
    placement: null,
    rule: null,
    tile: null,

    // The content folder's own `FurnitureClass` assets, as placements keyed by name. Read
    // from the folder rather than from the export, because these are the files being
    // edited and they shadow the shipped asset of the same name.
    modClasses: new Map(),

    // The placement for whichever class is open, and the sub-object classes the open
    // preset names. Both are read when a preset is chosen and held while it is.
    classPlacement: null,
    slots: new Map(),

    // Which clusters have a slot for which class. One read of every cluster, so it is
    // asked for rather than assumed -- see `findWhereItAppears`.
    clusterIndex: null,
    scanning: null,

    // What the export folder holds, listed rather than looked up in the generated tables:
    // furniture a newer game added is on the author's disk and not in those. One directory
    // listing per type, and no asset read until one is chosen.
    presets: [],
    clusters: [],

    // The names the interactable picker offers. Listed once when the pane opens, the way
    // the other two are: 732 names is a `<datalist>`, not a read per keystroke.
    interactablePresets: [],
};

/** Test seam, and what the pane reads. */
export const furnitureCreatorState = () => state;

const $ = (selector) => document.querySelector(selector);

/** The 3D pane, built on first open and kept: it holds a GPU context. */
let view = null;


/* -------------------------------------------------------------------------- */
/* Opening                                                                     */
/* -------------------------------------------------------------------------- */

export async function openFurnitureCreator() {
    const dialog = $('#furniture-creator-modal');
    if (!dialog) return;

    dialog.toggleAttribute('open', true);

    // Built once and kept, along with the step it was left on. See the same line in
    // roomCreator.js: closing the pane to look at a file and coming back to where you were
    // is the ordinary way this gets used.
    steps ??= createStepper(dialog, { onShow: placeView });

    state.presets = await listAssets('FurniturePreset');
    state.clusters = await listAssets('FurnitureCluster');
    state.interactablePresets = await listAssets('InteractablePreset');

    await refreshModFurniture();
    drawPicker();
    drawPreset();

    // After the dialog is open, not before: a canvas sized against a container that is
    // still display:none comes out 1x1 and stays that way until something resizes it.
    await ensureView();
    placeView(steps?.key());
}

export function closeFurnitureCreator() {
    $('#furniture-creator-modal')?.removeAttribute('open');
}

/**
 * Stand the 3D pane in whichever step is showing, and measure it there.
 *
 * There is one view and there can only be one -- a WebGL context is not free to make and
 * browsers cap how many a page may hold -- so three steps share it by moving it rather than
 * by each holding a view of its own. Moving the element keeps the canvas, its context and
 * the pointer handler `ensureView` put on it; only the size changes, and a canvas measured
 * against a container that was hidden comes out 1px tall, which is why the resize is
 * unconditional rather than only on a move.
 *
 * A step with no slot parks the viewport back outside the panes, hidden. Left where it was
 * it would be inside a pane carrying `hidden`, and a canvas hidden that way is one that
 * measures zero the next time anything asks.
 */
function placeView(key) {
    const viewport = $('#furniture-creator-viewport');
    if (!viewport) return;

    const slot = key
        ? $(`#furniture-creator-modal .creator-pane[data-step="${key}"] [data-view-slot]`)
        : null;

    const home = slot ?? viewport.closest('article');
    if (home && viewport.parentElement !== home) home.append(viewport);

    viewport.hidden = !slot;
    if (slot) view?.resize();
}

/**
 * Build the 3D pane once, and let go of it never.
 *
 * A WebGL context is not free to make and browsers cap how many a page may hold, so the
 * view outlives a close: reopening the modal shows what was there rather than paying for
 * a new context. It is disposed only if the container goes, which in this app it does not.
 */
async function ensureView() {
    const container = $('#furniture-creator-view');
    if (!container || view) {
        view?.resize();
        return;
    }

    const { createFurnitureView } = await import('./furnitureView.js');
    view = await createFurnitureView(container);

    container.addEventListener('pointerdown', (event) => {
        // Sub-objects first: they are the ones that can be dragged, so a marker of each at
        // the same point should hand the pointer to the one a drag would act on.
        const hit = view.markerAt(event);
        if (hit) {
            selectSubObject(hit.parented ? 'parented' : 'placed', hit.index);
            return;
        }

        const built = view.interactableAt(event);
        if (built) selectInteractable(built.index);
    });

    showInView();
}

/** Push what is selected into the 3D pane, if there is one yet. */
function showInView() {
    if (!view) return;

    view.show(shown(), state.model);
    view.setParentedVisible(state.showParented);
    view.select(state.selected);
    view.selectInteractable(state.interactable);

    // The handles go on whatever is marked, and report back in the game's own numbers.
    // Only where there is something to drag: a parented sub-object that is not drawn has
    // no marker to put them on.
    view.setDragging(state.selected, dragMode(), (entry, place) => {
        const edits = editable();
        const list = entry.parented ? edits.parented : edits.placed;
        const sub = list[entry.index];
        if (!sub) return;

        sub.pos = place.pos;
        sub.rot = place.rot;

        // Not `showInView`: the marker is already where the drag put it, and rebuilding
        // the markers under a gizmo mid-drag detaches it from what is being dragged.
        drawSubObjects();
        drawEditor(false);
        drawPlan();
    });
}

/** Which gizmo the author asked for. Moving is the common one, so it is the default. */
const dragMode = () => ($('#furniture-creator-rotate')?.checked ? 'rotate' : 'translate');

/** Wired to the move/turn switch. */
export function furnitureDragModeChanged() {
    showInView();
}

/**
 * The selected content folder's own furniture presets.
 *
 * Read on open rather than watched. A folder can be written to while the pane is up, and
 * re-reading on every draw would put a directory scan behind every keystroke in the search
 * box; reopening the pane is the refresh.
 */
async function refreshModFurniture() {
    const folder = window.selectedMod?.baseFolder;

    state.mod = new Map();
    state.modClasses = new Map();
    state.index = emptyIndex();
    if (!folder) return;

    state.modClasses = await readModClasses(folder);

    // Awaited in turn rather than in parallel: every one of these may read a donor or a
    // shipped asset, and a mod holds a handful of them.
    const documents = new Map();

    for (const file of await readFurnitureFiles(folder)) {
        const record = await modPreset(file);

        state.mod.set(file.name, record);
        if (record.document) documents.set(file.name, record.document);
    }

    // The mod's own shadow the game's, which is what the loader does with them: a preset
    // of the same name replaces the shipped one, so anything that looks one up by name
    // should find this before the export's.
    setModAssets('FurniturePreset', documents);

    // A folder that cannot be listed comes back empty, which is one the plan cannot check
    // names against. The write reads it again anyway, so this costs a preview rather than a
    // safeguard.
    state.index = indexMod(await readModFiles(folder));
}

/**
 * The model for whatever is open, read off disk.
 *
 * Only for a preset that names one: a shipped preset's `prefab` resolves to a `GameObject`
 * name with no file behind it, so there is nothing to look for and `readModel` says so by
 * returning null.
 */
async function loadModel() {
    const folder = window.selectedMod?.baseFolder;

    state.model = state.preset
        ? await readModel(folder, state.preset.prefab)
        : null;
}


/* -------------------------------------------------------------------------- */
/* Choosing a preset                                                           */
/* -------------------------------------------------------------------------- */

/** Wired to the search box. */
export function furnitureCreatorChanged() {
    state.search = $('#furniture-creator-search')?.value ?? '';
    drawPicker();
}

/**
 * Show one preset. Called from the picker, and from a cluster's slot list.
 *
 * The mod's own comes first where both have the name. That is what the game does -- a
 * mod's asset of the same name shadows the shipped one -- and showing the base game's
 * record for a preset the author has overridden would answer a question about the wrong
 * file.
 */
export async function openFurniturePreset(name) {
    state.preset = state.mod.get(name) ?? await describePreset(name);

    // Why it could not be read, which is a different sentence for "your export does not
    // have this" and "connect an export folder".
    state.unreadable = state.preset ? null : await readMissing('FurniturePreset', name);
    state.selected = null;
    state.interactable = null;
    state.cluster = null;
    state.model = null;
    state.edits = null;
    state.placement = null;
    state.rule = null;
    state.tile = null;
    state.classIndex = 0;
    state.classPlacement = null;
    state.slots = new Map();

    // Built for whatever was open before, and just as true of this one.
    if (haveClusterIndex()) state.clusterIndex = await readClusterIndex([]);

    // The mod's own file of fields keeps its name, because saving it is saving that file.
    // A shipped preset does not: writing under `HotelDesk` would be writing a file the
    // loader treats as an override of the shipped asset, which is a different act from
    // making one of your own. Nor does a patch: the name is the shipped asset's, and a
    // file of fields under it would be a second asset called that.
    const own = state.mod.get(name);
    state.name = own && own.source !== 'patch' ? name : '';
    if ($('#furniture-creator-name')) $('#furniture-creator-name').value = state.name;

    // The sub-object classes this preset names, for what each slot says about itself.
    // A handful of files, read together rather than one per row.
    const slotNames = [...new Set([...(state.preset?.placed ?? []), ...(state.preset?.parented ?? [])]
        .map((sub) => sub.class))];

    for (const document of await readAssets('SubObjectClassPreset', slotNames)) {
        state.slots.set(document.presetName ?? document.name, document);
    }

    await loadClassPlacement();

    drawPicker();
    drawPreset();
    showInView();

    // Reading the model is a folder walk and two file reads, so the pane is drawn without
    // it first and redrawn when it arrives. A preset with no prefab of its own resolves
    // immediately to null and the second draw is a no-op.
    loadModel().then(() => {
        if (state.preset?.name !== name) return;
        drawPreset();
        showInView();
    });
}

/**
 * Mark one sub-object, from the list or from the view.
 *
 * `kind` says which of the two lists the index is into. Clicking the row that is already
 * marked unmarks it, which is how a list with no other way to clear a selection has one.
 */
export function selectSubObject(kind, index) {
    const parented = kind === 'parented';
    const same = state.selected
        && state.selected.parented === parented
        && state.selected.index === index;

    state.selected = same ? null : { index, parented };

    // One thing marked at a time. The two editors are different forms about different
    // kinds of thing, and both open at once reads as one of them applying to the other.
    if (state.selected) state.interactable = null;

    drawSubObjects();
    drawEditor();
    drawInteractables();
    showInView();
}

/** Show or hide the sub-objects whose position cannot be believed. */
export function toggleParentedSubObjects() {
    state.showParented = !!$('#furniture-creator-parented')?.checked;

    // A marker that has just been hidden cannot stay marked: the row would be highlighted
    // with nothing in the view to match it.
    if (!state.showParented && state.selected?.parented) state.selected = null;

    drawSubObjects();
    drawEditor();
    showInView();
}

/** Draw one of the arrangements this preset appears in. */
export function openFurnitureCluster(name) {
    state.cluster = state.cluster === name ? null : name;
    drawClusters();
}

export function resetFurnitureView() {
    view?.resetView();
}


/* -------------------------------------------------------------------------- */
/* Placement mode                                                              */
/* -------------------------------------------------------------------------- */

/** Which of the preset's classes the diagram is about, for a preset in more than one. */
export async function furnitureClassChanged() {
    state.classIndex = Number($('#furniture-creator-class')?.value ?? 0) || 0;
    state.placement = null;
    state.rule = null;
    state.tile = null;

    await loadClassPlacement();

    drawPlacementPane();
    drawPlan();
}

/**
 * The class the diagram is about, as edited if it has been.
 *
 * Read fresh from the reference data until something changes it, so switching preset does
 * not carry the last one's rules across -- which would be the pane showing an author rules
 * they never wrote for a class they are only looking at.
 */
function placementOf() {
    return state.placement ?? state.classPlacement;
}

/**
 * Read the class the diagram is about.
 *
 * The mod's own first, the way a preset of the same name shadows a shipped one -- and for
 * a stronger reason here: a class the export folder does not hold is not a class that does
 * not exist, it is one the author wrote, and its rules are in the folder that is open.
 */
async function loadClassPlacement() {
    const entry = state.preset?.classes?.[state.classIndex];

    state.classPlacement = !entry
        ? null
        : state.modClasses.get(entry.name) ?? await describePlacement(entry.name);
}

/**
 * A copy to edit, taken the first time anything is changed.
 *
 * `bounds` is deliberately not carried across. It is derived from the size, the rules and
 * the blocks, and every edit path recomputes it through `settle` -- a copied one is right
 * until the first change and then quietly stale, which draws the rule that was just moved
 * outside the grid it was moved on.
 */
function editablePlacement() {
    const base = placementOf();
    if (!base) return null;

    state.placement ??= {
        ...base,
        size: [...base.size],
        rules: base.rules.map((rule) => ({ ...rule, at: [...rule.at] })),
        blocks: base.blocks.map((entry) => ({ ...entry, at: [...entry.at], dirs: [...entry.dirs] })),
        weights: base.weights.map((entry) => ({ ...entry, at: [...entry.at] })),
    };

    return state.placement;
}

/**
 * Recompute what an edit invalidated, then redraw.
 *
 * One call at the end of every edit path rather than each of them remembering. The bounds
 * are the thing: they are derived from the size and from where the rules sit, and both are
 * editable now -- widening a footprint or dragging a rule out to a far tile has to grow the
 * grid, or the change is drawn outside it and reads as having been dropped.
 */
function settle() {
    if (state.placement) state.placement.bounds = boundsOf(state.placement);

    drawPlacementPane();
    drawPlan();
}

/**
 * Mark one rule or block, from the diagram. Clicking it again unmarks it.
 *
 * Marking one also marks the tile it sits on, so the two states agree: the editor is on this
 * rule, and a `+` pressed next would put its neighbour beside it rather than back on the
 * anchor.
 */
export function selectPlacementRule(rule) {
    const same = state.rule === rule;

    state.rule = same ? null : rule;
    if (!same && rule) state.tile = [...rule.at];

    drawPlacementPane();
}

/** Mark a tile. Clicking it again unmarks it, and marking one drops the marked rule. */
export function selectPlacementTile(at) {
    const same = state.tile && state.tile[0] === at[0] && state.tile[1] === at[1];

    state.tile = same ? null : [...at];
    state.rule = null;

    drawPlacementPane();
}

/**
 * Change the footprint.
 *
 * Not in the rule editor, because it is not about a rule: it is the field the whole diagram
 * is drawn from, and it has to be reachable when nothing is marked. Refused rather than
 * clamped when it is not a whole number of at least one -- a half-typed "" is a field being
 * edited, not a request for a piece nought nodes wide.
 */
export function placementSizeChanged() {
    const edited = editablePlacement();
    if (!edited) return;

    const across = Number.parseInt($('#furniture-creator-size-x')?.value, 10);
    const deep = Number.parseInt($('#furniture-creator-size-y')?.value, 10);

    if (!Number.isFinite(across) || !Number.isFinite(deep)) return;
    if (across < 1 || deep < 1) return;

    edited.size = [across, deep];
    settle();
}

/**
 * Change the marked rule, from the fields under the diagram.
 *
 * Read whole every time rather than by which control fired, the same way the sub-object
 * editor is: a pane rebuilt from its controls cannot disagree with them.
 *
 * The kind select is handled first and on its own, because it is the one control that
 * changes what all the others mean.
 */
export function placementRuleChanged() {
    const edited = editablePlacement();
    if (!edited || !state.rule) return;

    const value = (id) => $(`#furniture-creator-rule-${id}`)?.value;

    const before = state.rule;
    const entry = convertRule(edited, before, value('kind'));

    /*
     * A conversion is the whole of the change, and reading the fields after one would undo
     * it.
     *
     * This runs from the form's own `oninput`, so when the select is what fired it the new
     * kind's form has not been drawn yet: its controls either do not exist -- a block's
     * direction boxes are built on demand -- or still hold the values of whatever was last
     * shown there. Reading them would give a block with no ways out closed at all, or a
     * node rule carrying some earlier rule's class name.
     *
     * The entry `convertRule` made already carries the defaults for its kind. `settle` draws
     * the form from those, and the next keystroke is read the ordinary way.
     */
    if (entry !== before) {
        state.rule = entry;
        state.tile = [...entry.at];

        settle();
        return;
    }

    if (entry.kind === 'wall') {
        entry.tag = value('tag') ?? entry.tag;
        entry.dir = value('dir') ?? entry.dir;

        const option = value('option');
        entry.gates = option !== 'canFeature';
        entry.must = option === 'mustFeature';
    } else if (entry.kind === 'node') {
        entry.option = value('node-option') ?? entry.option;
        entry.gates = entry.option !== 'canFeature';

        const named = (value('class') ?? '').trim();
        entry.any = named === '*';
        entry.class = entry.any ? null : named || null;
    } else {
        entry.dirs = BLOCKING_DIRECTION
            .filter((dir) => dir !== 'none' && $(`#furniture-creator-block-${dir}`)?.checked);

        entry.diagonals = !!$('#furniture-creator-block-diagonals')?.checked;
    }

    const x = Number.parseInt(value('at-x'), 10);
    const y = Number.parseInt(value('at-y'), 10);
    if (Number.isFinite(x) && Number.isFinite(y)) {
        entry.at = [x, y];
        state.tile = [x, y];
    }

    settle();
}

/**
 * Turn one kind of entry into another, in place on the grid it is drawn on.
 *
 * This is what makes the other two kinds reachable. A `+` makes a wall rule, and a class
 * with no occupancy rule and no closed way out has neither to mark -- so without conversion
 * the first one of either could never be written, which is exactly the dead end this pane
 * had. One select rather than three Add buttons, because the three are the same thing seen
 * three ways: something asserted about a tile at an offset.
 *
 * A block is not a rule and does not live in `rules`, so converting moves it between the two
 * lists. The offset is what survives the move, since that is what the author chose by
 * pointing at a tile; everything else is a sensible default for the kind being made.
 */
function convertRule(edited, entry, wanted) {
    if (!wanted || wanted === entry.kind) return entry;

    const at = [...entry.at];

    const made = wanted === 'wall'
        ? { kind: 'wall', at, dir: 'behind', tag: 'wall', must: true, room: null, score: 0, gates: true }
        : wanted === 'node'
            ? { kind: 'node', at, option: 'cantFeature', class: null, any: true, score: 0, gates: true }
            : { kind: 'block', at, dirs: ['front'], diagonals: false };

    // Out of whichever list held it, into whichever list takes it. Both are reassigned
    // rather than spliced, so a stale reference cannot survive in the other one.
    edited.rules = edited.rules.filter((other) => other !== entry);
    edited.blocks = edited.blocks.filter((other) => other !== entry);

    if (made.kind === 'block') edited.blocks.push(made);
    else edited.rules.push(made);

    return made;
}

/**
 * Put a rule on one tile, and mark it.
 *
 * The offset comes from the tile that was pressed, which is the whole of the fix: a single
 * Add under the grid put every rule on the anchor and left the author to type the tile back
 * out in two number fields, having just pointed at it.
 *
 * A wall rule, because 233 of the 262 classes have one. The kind select converts it, so a
 * press is never the wrong move -- only sometimes one step from the right one.
 */
export function addPlacementRule(at = state.tile ?? [0, 0]) {
    const edited = editablePlacement();
    if (!edited) return;

    const rule = {
        kind: 'wall', at: [...at], dir: 'behind', tag: 'wall',
        must: true, room: null, score: 0, gates: true,
    };

    edited.rules.push(rule);
    state.rule = rule;
    state.tile = [...at];

    settle();
}

/** Take the marked entry off, from whichever of the two lists holds it. */
export function removePlacementRule() {
    const edited = editablePlacement();
    if (!edited || !state.rule) return;

    edited.rules = edited.rules.filter((rule) => rule !== state.rule);
    edited.blocks = edited.blocks.filter((entry) => entry !== state.rule);
    state.rule = null;

    settle();
}

export function revertPlacementEdits() {
    state.placement = null;
    state.rule = null;
    state.tile = null;

    drawPlacementPane();
    drawPlan();
}


/* -------------------------------------------------------------------------- */
/* Editing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The sub-objects being edited: a copy the first time something changes one.
 *
 * Copied rather than mutated in place because the record it comes from is the reference
 * data itself -- shared, cached for the life of the page, and read by everything else
 * here. Editing it directly would move a shipped preset's lamp for the rest of the
 * session, in a pane whose whole subject is where the lamp is.
 */
function editable() {
    if (!state.preset) return null;

    state.edits ??= {
        placed: state.preset.placed.map((sub) => ({ ...sub, pos: [...sub.pos], rot: [...sub.rot] })),
        parented: state.preset.parented.map((sub) => ({ ...sub, pos: [...sub.pos], rot: [...sub.rot] })),

        // Flat records, so a shallow copy of each is a whole copy. Taken here with the
        // sub-objects rather than in a second `editable` of its own, because Revert is one
        // button and it throws away everything this pane changed.
        interactables: (state.preset.interactables ?? []).map((entry) => ({ ...entry })),
    };

    return state.edits;
}

/** What the pane and the view draw: the edits if there are any, the preset if not. */
function shown() {
    if (!state.preset) return null;
    if (!state.edits) return state.preset;

    return {
        ...state.preset,
        placed: state.edits.placed,
        parented: state.edits.parented,
        interactables: state.edits.interactables,
    };
}

/** The sub-object a selection points at, in whichever list it is in. */
function selectedSub() {
    if (!state.selected) return null;

    const lists = state.edits ?? state.preset;
    const list = state.selected.parented ? lists.parented : lists.placed;
    return list?.[state.selected.index] ?? null;
}

/**
 * Move or turn the marked sub-object, from the number fields.
 *
 * Every field is read every time rather than the one that changed. Six inputs and one
 * object: reading them all is cheaper than working out which fired, and a pane that
 * rebuilds from the controls cannot disagree with them.
 */
export function furnitureSubObjectChanged() {
    const sub = selectedSub() && editable() && selectedSub();
    if (!sub) return;

    const read = (id, fallback) => {
        const raw = $(`#furniture-creator-${id}`)?.value;
        const value = Number.parseFloat(raw);
        return Number.isFinite(value) ? value : fallback;
    };

    sub.pos = [read('pos-x', sub.pos[0]), read('pos-y', sub.pos[1]), read('pos-z', sub.pos[2])];
    sub.rot = [read('rot-x', sub.rot[0]), read('rot-y', sub.rot[1]), read('rot-z', sub.rot[2])];

    drawSubObjects();
    drawEditor(false);
    drawPlan();
    showInView();
}

/**
 * Take one sub-object off, named rather than inferred from what is marked.
 *
 * It used to remove whatever the editor was showing, from a button under the editor. Which
 * meant marking a row before it could go -- and marking is what moves the 3D view, so
 * taking three of five off walked the camera around the model on the way. The row carries
 * its own now, and this takes the index it was drawn with.
 *
 * The marker follows the object rather than the index. Removing the one that is marked
 * clears it -- the index would point at a different object, and a marker that jumps under
 * a press meaning "remove" is worse than one that goes -- but removing anything else leaves
 * the marked object marked, which is what shifting the index down does.
 */
export function removeFurnitureSubObject(index, parented) {
    const edits = editable();
    if (!edits) return;

    const list = parented ? edits.parented : edits.placed;
    if (!list[index]) return;

    list.splice(index, 1);

    if (state.selected?.parented === parented) {
        if (state.selected.index === index) state.selected = null;
        else if (state.selected.index > index) state.selected.index -= 1;
    }

    redrawEdits();
}

/**
 * Put another sub-object on, of the same class as the marked one.
 *
 * The class is copied from what is selected rather than chosen from a list of 86, because
 * the useful case is "another one of those" -- a second drawer item, a third piece of
 * junk. It lands a little to one side of the original so that it is not hidden inside it.
 */
export function addFurnitureSubObject() {
    const edits = editable();
    const from = selectedSub();
    if (!edits || !from) return;

    const copy = {
        ...from,
        pos: [from.pos[0] + 0.15, from.pos[1], from.pos[2] + 0.15],
        rot: [...from.rot],
    };

    const list = state.selected.parented ? edits.parented : edits.placed;
    list.push(copy);
    state.selected = { index: list.length - 1, parented: state.selected.parented };

    redrawEdits();
}

/** Throw the edits away and go back to what the files say. */
export function revertFurnitureEdits() {
    state.edits = null;
    state.selected = null;
    state.interactable = null;
    redrawEdits();
}

export function furnitureNameChanged() {
    state.name = $('#furniture-creator-name')?.value.trim() ?? '';
    drawPlan();
}

function redrawEdits() {
    drawSubObjects();
    drawEditor();
    drawInteractables();
    drawPlan();
    showInView();
}


/* -------------------------------------------------------------------------- */
/* Editing what is built into it                                               */
/* -------------------------------------------------------------------------- */

/**
 * The controllers the prefab declares, or null where that cannot be known.
 *
 * Null and empty are different answers and the pane says different things about them: null
 * is "there is no prefab here to read" -- a shipped preset, no mod folder, a file that is
 * not there -- and empty is "this prefab declares none", which is a model an author can go
 * and add one to. Conflating them would tell somebody with a real `.sodprefab.json` that
 * their own file could not be opened.
 */
const controllersOf = () => state.model?.controllers ?? null;

/**
 * Whether the interactables can be edited, which is whether the prefab was read.
 *
 * Not whether it has controllers in it: a prefab with none is one an author may be about
 * to add one to, and a list they cannot touch is no help with that. What editing needs is
 * a file this pane could open, so that the ids it offers are the ones that exist.
 */
const canEditInteractables = () => Array.isArray(controllersOf());

/** The interactables as shown: the edits where there are any, the preset's where not. */
const interactablesShown = () => shown()?.interactables ?? [];

/** The marked one, or null. */
function selectedInteractable() {
    if (state.interactable === null) return null;
    return interactablesShown()[state.interactable] ?? null;
}

/**
 * Mark one, from the list or from the view. Clicking the marked one unmarks it.
 *
 * The sub-object selection goes when this arrives, for the reason `selectSubObject` gives
 * from the other side.
 */
export function selectInteractable(index) {
    state.interactable = state.interactable === index ? null : index;
    if (state.interactable !== null) state.selected = null;

    drawSubObjects();
    drawEditor();
    drawInteractables();
    showInView();
}

/**
 * Change the marked entry, from the three controls.
 *
 * Every field read every time rather than the one that fired, the way
 * `furnitureSubObjectChanged` is: three controls and one object, and a pane rebuilt from
 * its controls cannot disagree with them.
 *
 * The preset name is taken as typed and trimmed, and an empty one is kept as null rather
 * than as `''`. Half a name is a field being edited; what makes it a problem is trying to
 * write it, which is where `planFurniture` says so.
 */
export function furnitureInteractableChanged() {
    if (!canEditInteractables()) return;

    const edits = editable();
    const entry = edits?.interactables[state.interactable];
    if (!entry) return;

    entry.preset = ($('#furniture-creator-interactable-preset')?.value ?? '').trim() || null;
    entry.controller = $('#furniture-creator-interactable-controller')?.value ?? entry.controller;
    entry.owner = $('#furniture-creator-interactable-owner')?.value ?? entry.owner;

    // Not `drawInteractables` alone: the row's own text is what changed, and the notes
    // above it are about which controllers are paired to.
    drawInteractables(false);
    drawPlan();
    showInView();
}

/**
 * Put another one on, and mark it.
 *
 * Reachable with nothing marked, unlike the sub-object Add, which copies what is selected.
 * There is nothing to copy the useful part of here -- an interactable is three choices, not
 * a position -- and a preset carrying none is exactly the one an author wants to add the
 * first to.
 *
 * It lands on the first controller the prefab has that nothing is paired to, because two
 * interactables on one controller is two things in the same place. Falling back to the
 * first one at all when they are all taken: pairing to `none` would be adding an entry the
 * game skips, which is a row that does nothing and says nothing.
 */
export function addFurnitureInteractable() {
    if (!canEditInteractables()) return;

    const edits = editable();
    if (!edits) return;

    const ids = usableControllerIds();
    const taken = new Set(edits.interactables.map((entry) => entry.controller));

    edits.interactables.push({
        preset: null,
        controller: ids.find((id) => !taken.has(id)) ?? ids[0] ?? 'none',
        owner: 'nobody',
    });

    state.interactable = edits.interactables.length - 1;
    state.selected = null;

    redrawEdits();
}

/**
 * Take one off, named rather than inferred from what is marked.
 *
 * The row carries its own cross, for the reason the sub-object rows do -- and the mark
 * follows the entry rather than the index, so removing the first of three leaves the third
 * one open in the editor instead of quietly swapping it for the second.
 */
export function removeFurnitureInteractable(index) {
    if (!canEditInteractables()) return;

    const edits = editable();
    if (!edits || !edits.interactables[index]) return;

    edits.interactables.splice(index, 1);

    if (state.interactable === index) state.interactable = null;
    else if (state.interactable > index) state.interactable -= 1;

    redrawEdits();
}

/**
 * The controller ids that can actually be paired to, in the order the prefab names them.
 *
 * The prefab's own, less any it declares that is not an `InteractableID` member. The game
 * matches by the enum, so a controller called `Handle` is a controller nothing can name --
 * the picker leaves it out and `interactableNotes` says so, since offering it would be
 * offering a choice that writes `none`.
 */
const usableControllerIds = () =>
    (controllersOf() ?? [])
        .map((controller) => controller.id)
        .filter((id) => INTERACTABLE_ID.includes(id));


/* -------------------------------------------------------------------------- */
/* Drawing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The preset list.
 *
 * Capped at what fits with the count said out loud, the way the room creator caps its
 * clusters: 310 rows is not a list anyone reads, and a silent truncation reads as "that is
 * all there is".
 */
function drawPicker() {
    const list = $('#furniture-creator-presets');
    if (!list) return;

    const term = state.search.trim().toLowerCase();

    // The mod's own first, and marked. They are what an author opened this pane to look
    // at, and burying them alphabetically among 310 shipped presets is burying them.
    const mine = [...state.mod.keys()]
        .filter((name) => !term || name.toLowerCase().includes(term))
        .sort();

    const theirs = presetNames(state.presets, state.search)
        .filter((name) => !state.mod.has(name));
    const names = [...mine, ...theirs];
    const shown = names.slice(0, 40);

    const rows = shown.map((name) => {
        const row = document.createElement('li');
        const button = document.createElement('button');
        const own = state.mod.get(name);

        button.type = 'button';
        button.className = 'furniture-creator-pick';
        button.textContent = own
            ? `${name} — ${own.source === 'patch' ? 'this mod’s patch'
                : own.source === 'copy' ? `this mod’s, copying ${own.donor}` : 'this mod’s'}`
            : name;
        if (state.preset?.name === name) button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => openFurniturePreset(name));

        row.append(button);
        return row;
    });

    if (names.length > shown.length) {
        rows.push(note(`${names.length - shown.length} more match. Narrow the search to see them.`,
            'plain', 'li'));
    }

    if (!names.length) {
        rows.push(note(state.search
            ? `No furniture preset is called “${state.search}”.`
            : 'The reference data could not be loaded, so there is nothing to show.',
        'plain', 'li'));
    }

    list.replaceChildren(...rows);
}

/** The three levels, and the warnings, for whatever is open. */
function drawPreset() {
    const out = $('#furniture-creator-summary');
    if (!out) return;

    if (!state.preset) {
        out.replaceChildren(note(state.unreadable
            ? `That preset could not be read: ${state.unreadable}.`
            : 'Choose a piece of furniture to see what it is made of.',
        state.unreadable ? 'warning' : 'plain'));
        drawSubObjects();
        drawEditor();
        drawInteractables();
        drawClusters();
        drawPlan();
        return;
    }

    const preset = state.preset;
    const box = proxyBox(preset);
    const parts = [];

    if (preset.unread) {
        parts.push(note(preset.unread, 'warning'));
        out.replaceChildren(...parts);
        drawSubObjects();
        drawInteractables();
        drawClusters();
        drawSteps();
        return;
    }

    const heading = document.createElement('p');
    heading.innerHTML = `<strong>${preset.name}</strong> draws <em>${preset.prefab ?? 'nothing'}</em>`
        + `${preset.sharesModel ? ', which is not named after it — any other preset naming '
            + 'the same model draws the same thing' : ''}.`;
    parts.push(heading);

    if (preset.patched) {
        parts.push(note(`These are ${preset.name} as this mod patches it, not as the game `
            + 'ships it: the shipped asset was read whole and the patch applied over it, so '
            + 'the positions below are the ones that will be in play.'));
    }

    parts.push(...modelNotes(preset));

    // The slot, which is where placement actually lives.
    const slot = document.createElement('p');
    slot.innerHTML = preset.classes.length
        ? `It fills ${preset.classes.length === 1 ? 'the slot' : 'the slots'} `
            + `${preset.classes.map((entry) => `<strong>${entry.name}</strong>`).join(', ')}`
            + `${box ? ` — ${box.tiles[0]}×${box.tiles[1]} nodes, `
                + `${box.tall ? 'tall enough to cover a lightswitch or a window' : 'low'}` : ''}.`
        : 'It is in no furniture class at all.';
    parts.push(slot);

    if (preset.filters.length) {
        parts.push(note(`Admitted by the room filters ${preset.filters.join(', ')}.`));
    }

    // What it carries is its own section now -- "What is built into it" -- because it is a
    // list to be edited rather than a sentence to be read.

    for (const warning of warningsFor(preset)) parts.push(note(warning, 'warning'));

    out.replaceChildren(...parts);

    drawSubObjects();
    drawEditor();
    drawInteractables();
    drawClusters();
    drawPlacementPane();
    drawPlan();
}

/**
 * What is standing in for the model, said out loud.
 *
 * Three states, and the difference between the last two is the whole reason this is here.
 * A shipped preset has a model nobody can open, so a box is the best there is and the pane
 * says so. A preset in the mod that names a prefab and has it gets the real thing. One
 * that names a prefab and has not got it gets neither -- because a box where a model was
 * expected reads as the model being wrong rather than missing, and the file that could not
 * be found is the thing the author can act on.
 */
function modelNotes(preset) {
    if (state.model?.meshes?.length) {
        const faces = state.model.meshes
            .reduce((total, mesh) => total + mesh.geometry.indices.length / 3, 0);

        return [note(`Drawn from this mod’s own ${state.model.meshes.length === 1 ? 'model'
            : `${state.model.meshes.length} models`} — ${faces.toLocaleString()} triangles, read `
            + `from ${state.model.meshes.map((mesh) => mesh.name).join(', ')}.`)];
    }

    if (state.model?.missing) {
        return [note(`This preset points at ${preset.prefab}, and ${state.model.missing} is not `
            + 'in the content folder. Nothing is drawn in its place: a box the size of its '
            + 'footprint here would look like the model being wrong rather than absent.',
        'warning')];
    }

    if (!window.selectedMod?.baseFolder && /^PREFAB:/i.test(preset.prefab ?? '')) {
        return [note('This preset points at a prefab in a mod folder, and no mod folder is '
            + 'connected — so there is nothing to read it from.')];
    }

    return [note('The box is the size of the slot this fills, not the model. A shipped model '
        + 'is a Unity prefab in an asset bundle this app cannot open, so what is drawn is '
        + 'scaffolding to read the positions against.')];
}

/**
 * The sub-objects, in two lists.
 *
 * Two rather than one because they mean different things. A placed sub-object is where it
 * says it is; a parented one is somewhere relative to a transform inside the model, and
 * this app cannot open the model. Sorting them together under one heading would be the
 * pane asserting it knows where all of them are.
 */
function drawSubObjects() {
    const out = $('#furniture-creator-subobjects');
    const parentedOut = $('#furniture-creator-parented-list');
    if (!out) return;

    // The edits where there are any: the list is what would be written, not what the file
    // said when it was opened.
    //
    // An unread preset is left blank rather than reported as empty. "Nothing sits on this
    // one" is a claim about the asset, and the whole state of an unread patch is that no
    // such claim can be made -- the summary above says why instead.
    const preset = state.preset?.unread ? null : shown();

    out.replaceChildren(...(preset?.placed.length
        ? preset.placed.map((sub, index) => subObjectRow(sub, index, false))
        : preset ? [note('Nothing sits on this one.', 'plain', 'li')] : []));

    if (!parentedOut) return;

    const parented = preset?.parented ?? [];
    const rows = parented.map((sub, index) => subObjectRow(sub, index, true));

    // Same again: "none of them" is a claim, and an unread preset supports none.
    if (preset && !parented.length) {
        rows.push(note('None of this one’s sub-objects hangs off a named transform.',
            'plain', 'li'));
    }

    parentedOut.replaceChildren(...rows);

    const count = $('#furniture-creator-parented-count');
    if (count) {
        count.textContent = !preset ? ''
            : parented.length === 1
                ? '1 sub-object hangs off a transform inside the model'
                : parented.length
                    ? `${parented.length} sub-objects hang off a transform inside the model`
                    : 'No sub-objects hang off a transform inside the model';
    }
}

/** One sub-object: what it is, where it is, and whether that position means anything. */
function subObjectRow(sub, index, parented) {
    const row = document.createElement('li');
    const button = document.createElement('button');

    const marked = state.selected
        && state.selected.parented === parented
        && state.selected.index === index;

    button.type = 'button';
    button.className = 'furniture-creator-subobject';
    if (marked) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => selectSubObject(parented ? 'parented' : 'placed', index));

    const name = document.createElement('span');
    name.className = 'furniture-creator-subobject-name';
    name.textContent = sub.class;

    const where = document.createElement('small');
    where.className = 'furniture-creator-subobject-where';
    where.textContent = parented
        ? `on ${sub.parent}, at ${vector(sub.pos)}`
        : `${vector(sub.pos)}${turned(sub.rot) ? `, turned ${turned(sub.rot)}` : ''}`;

    button.append(name, where);
    row.append(button, removeRowButton(
        `Remove ${sub.class}`,
        `Take this ${sub.class} off the model`,
        () => removeFurnitureSubObject(index, parented),
    ));

    const detail = [];
    if (sub.owner !== 'nobody') detail.push(sub.owner === 'everybody' ? 'anyone’s' : `${sub.owner}’s`);
    if (sub.security) detail.push(`security ${sub.security}`);

    const slot = describeSlot(state.slots.get(sub.class));
    if (slot) detail.push(slot);

    if (detail.length) {
        const extra = document.createElement('small');
        extra.className = 'furniture-creator-subobject-detail';
        extra.textContent = detail.join(' · ');
        row.append(extra);
    }

    return row;
}

/* -------------------------------------------------------------------------- */
/* What is built into it                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The integrated interactables, what is wrong with them, and the editor for the marked one.
 *
 * `fill` is false while the editor's own fields are what changed, for the reason
 * `drawEditor` takes the same flag: writing a field back from the value it just produced
 * takes the cursor out of it mid-keystroke.
 */
function drawInteractables(fill = true) {
    const out = $('#furniture-creator-interactables');
    if (!out) return;

    // An unread preset is left blank rather than reported as carrying none, the same way
    // the sub-object lists are: "nothing is built into this" is a claim about an asset, and
    // a patch that would not apply supports no claim at all.
    const preset = state.preset?.unread ? null : shown();
    const entries = preset ? interactablesShown() : [];

    out.replaceChildren(...(entries.length
        ? entries.map((entry, index) => interactableRow(entry, index))
        : preset ? [note('Nothing is built into this one, so there is nothing a citizen can '
            + 'do with it.', 'plain', 'li')] : []));

    const notes = $('#furniture-creator-interactable-notes');
    if (notes) notes.replaceChildren(...(preset ? interactableNotes(entries) : []));

    // Reachable with nothing marked, which is the case a preset carrying none is always in.
    const add = $('#furniture-creator-interactable-add');
    if (add) {
        add.hidden = !preset || !canEditInteractables();
        add.textContent = entries.length ? 'Add another' : 'Add an interactable';
    }

    drawInteractableEditor(fill);
}

/** One entry: what it creates, where it is paired, and whose it is. */
function interactableRow(entry, index) {
    const row = document.createElement('li');
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'furniture-creator-subobject';
    if (state.interactable === index) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => selectInteractable(index));

    const name = document.createElement('span');
    name.className = 'furniture-creator-subobject-name';
    name.textContent = entry.preset ?? '(unnamed)';

    const where = document.createElement('small');
    where.className = 'furniture-creator-subobject-where';
    where.textContent = entry.controller === 'none'
        ? 'paired to nothing'
        : `at ${entry.controller}`;

    button.append(name, where);
    row.append(button);

    // Only where the prefab was read. Without it the list is a reading of a shipped asset
    // rather than something to change, and a cross on a row nothing can edit is a control
    // that refuses every press. See `canEditInteractables`.
    if (canEditInteractables()) {
        // Named by its pairing as well as its preset. Two entries creating the same thing
        // at two controllers is the ordinary case -- `HotelDesk` ships exactly that -- so
        // the preset name alone would give a list of identically labelled crosses.
        const what = `${entry.preset ?? 'this interactable'}`
            + `${entry.controller === 'none' ? '' : ` at ${entry.controller}`}`;

        row.append(removeRowButton(
            `Remove ${what}`,
            `Take ${what} out of this piece of furniture`,
            () => removeFurnitureInteractable(index),
        ));
    }

    const detail = [];
    if (entry.owner !== 'nobody') {
        detail.push(entry.owner === 'everybody' ? 'anyone’s' : `${entry.owner}’s`);
    }

    // Where the controller stands, for an entry the prefab can place. The one number this
    // section has, and it is the prefab's rather than the preset's -- which is why it is
    // stated as being read from there.
    const controller = (controllersOf() ?? []).find((one) => one.id === entry.controller);
    if (controller) detail.push(`at ${vector(controller.offset)} in the model`);

    if (detail.length) {
        const extra = document.createElement('small');
        extra.className = 'furniture-creator-subobject-detail';
        extra.textContent = detail.join(' · ');
        row.append(extra);
    }

    return row;
}

/**
 * What is worth saying about the list, before anything is changed.
 *
 * Every line here is silent in game: a pairing that misses logs once and puts the
 * interactable at the model's origin, `none` skips the entry outright, and an owner index
 * the class does not assign logs and leaves a worker with no desk. None of it is an error
 * an author will meet before they are standing in the room wondering where the thing went.
 */
function interactableNotes(entries) {
    const controllers = controllersOf();
    const parts = [];

    /*
     * Two kinds of check, and only one of them needs a prefab.
     *
     * Whether an entry is paired to a controller that exists is a question about the model,
     * and for a shipped preset there is no readable model to ask. Whether two entries share
     * a controller, or ask for more owners than the class assigns, is a question about the
     * files alone -- and both are worth answering while an author is deciding whether to
     * clone the thing. So the read-only case says why it is read-only and then goes on.
     */
    if (!controllers) parts.push(note(interactableReadOnlyReason()));
    else parts.push(...prefabNotes(controllers, entries));

    const skipped = entries.filter((entry) => entry.controller === 'none').length;
    if (skipped) {
        parts.push(note(`${skipped} ${skipped === 1 ? 'entry is' : 'entries are'} paired to `
            + `none, which the game skips outright — ${skipped === 1 ? 'it' : 'they'} will not `
            + 'be created at all.', 'warning'));
    }

    // Two on one controller is two things in the same place, which is a thing the game will
    // do and nobody meant.
    const seen = new Set();
    const doubled = new Set();
    for (const entry of entries) {
        if (entry.controller === 'none') continue;
        if (seen.has(entry.controller)) doubled.add(entry.controller);
        seen.add(entry.controller);
    }

    if (doubled.size) {
        parts.push(note(`${[...doubled].join(', ')} `
            + `${doubled.size === 1 ? 'has' : 'have'} more than one interactable paired to `
            + `${doubled.size === 1 ? 'it' : 'them'}, so they are created at the same point.`,
        'warning'));
    }

    parts.push(...ownershipNotes(entries));
    return parts;
}

/** The half of the checks that needs the prefab, and therefore a local one. */
function prefabNotes(controllers, entries) {
    const parts = [];
    const ids = new Set(controllers.map((controller) => controller.id));
    const named = state.model?.name ?? 'the prefab';

    // A controller the game itself cannot name. Reported whether or not anything is paired
    // to it, because it is a fault in the prefab rather than in the list.
    const unnameable = controllers
        .filter((controller) => !INTERACTABLE_ID.includes(controller.id))
        .map((controller) => controller.id);

    if (unnameable.length) {
        parts.push(note(`${named} declares ${unnameable.join(', ')}, which `
            + `${unnameable.length === 1 ? 'is not one' : 'are not'} of the game’s `
            + 'InteractableID values — nothing can ever pair to '
            + `${unnameable.length === 1 ? 'it' : 'them'}. The usable ids are A to J, K to Z, `
            + 'AA to DD, and hidingPlace.', 'warning'));
    }

    if (!controllers.length) {
        parts.push(note(`${named} declares no InteractableController at all, so nothing here `
            + 'can be positioned. Add one to the prefab — a child with a `position` and a '
            + '`{ "type": "InteractableController", "id": "A" }` component — and it will be '
            + 'offered here.', 'warning'));
    }

    const missing = entries
        .filter((entry) => entry.controller !== 'none' && !ids.has(entry.controller));

    if (missing.length) {
        parts.push(note(`${missing.map((entry) => entry.controller).join(', ')} `
            + `${missing.length === 1 ? 'is not a controller' : 'are not controllers'} in `
            + `${named}. The game logs a line and creates `
            + `${missing.length === 1 ? 'the interactable' : 'them'} at the model’s origin `
            + 'with no rotation, which is inside the model rather than on it.', 'warning'));
    }

    return parts;
}

/**
 * Whether the class assigns as many owners as the list asks for.
 *
 * `belongsTo: person2` is an index into the furniture's owner map, and the map is only as
 * long as the class's `assignBelongsToOwners` made it. Ask for an index past the end and
 * `UpdateIntegratedObjectOwnership` logs `Could not find interactable owner for index N`,
 * which is a desk nobody is assigned to work at -- and the two files that have to agree are
 * not the two an author is looking at.
 *
 * Read straight off the class document `describeClasses` already keeps, so this costs
 * nothing and is skipped where the class could not be read.
 */
function ownershipNotes(entries) {
    const highest = entries
        .map((entry) => /^person(\d+)$/.exec(entry.owner ?? '')?.[1])
        .filter((index) => index !== undefined)
        .reduce((most, index) => Math.max(most, Number(index) + 1), 0);

    if (!highest) return [];

    const entry = (state.preset?.classes ?? []).find((one) => !one.missing && one.document);
    if (!entry) return [];

    const assigned = entry.document.assignBelongsToOwners ?? 0;
    if (assigned >= highest) return [];

    return [note(`This asks for ${highest} ${highest === 1 ? 'owner' : 'owners'}, and `
        + `${entry.name} assigns ${assigned}. The game logs “Could not find interactable owner `
        + `for index ${highest - 1}” and leaves ${highest === 1 ? 'that one' : 'the extras'} `
        + 'unowned, so whoever was meant to work there has no work position.', 'warning')];
}

/** Why the list cannot be edited, in the words of whichever reason it is. */
function interactableReadOnlyReason() {
    const prefab = state.preset?.prefab ?? null;

    if (state.model?.missing) {
        return `This is read-only because ${state.model.missing} could not be read, and the `
            + 'controllers an interactable pairs to are in the prefab.';
    }

    if (/^PREFAB:/i.test(prefab ?? '') && !window.selectedMod?.baseFolder) {
        return 'This points at a prefab in a mod folder and no mod folder is connected, so '
            + 'the controllers it declares cannot be read and the list is read-only.';
    }

    // A preset naming no prefab at all draws nothing, so there is no model for a controller
    // to be in. Said as that rather than as a bundle that cannot be opened, which would be
    // describing a file this preset has not got.
    if (!prefab) {
        return 'This preset names no prefab, so there is no model for a controller to be in '
            + 'and nothing here could be positioned. The list is read-only.';
    }

    return `${prefab} is a Unity prefab inside an asset bundle this app cannot open, so `
        + 'which controllers exist is unknowable here and the list is read-only. A preset of '
        + 'your own pointing at a .sodprefab.json can be edited.';
}

/**
 * The three controls for the marked entry.
 *
 * The controller select is rebuilt every time rather than once, unlike the rule editor's
 * fixed lists: its options are the prefab's and the prefab changes with the preset.
 */
function drawInteractableEditor(fill = true) {
    const panel = $('#furniture-creator-interactable-editor');
    if (!panel) return;

    const entry = selectedInteractable();
    panel.hidden = !entry;
    if (!entry) return;

    const changeable = canEditInteractables();

    const where = $('#furniture-creator-interactable-editing');
    if (where) where.textContent = entry.preset ?? '(unnamed)';

    const meaning = $('#furniture-creator-interactable-meaning');
    if (meaning) meaning.textContent = explainInteractable(entry);

    // No `remove` in this list any more: taking one off is a cross on its row, and a row
    // that cannot be edited is not given one -- see `interactableRow`.
    for (const id of ['preset', 'controller', 'owner']) {
        const control = $(`#furniture-creator-interactable-${id}`);
        if (control) control.disabled = !changeable;
    }

    const names = $('#furniture-creator-interactable-presets');
    if (names && names.options.length !== state.interactablePresets.length) {
        names.replaceChildren(...state.interactablePresets.map((name) => new Option(name)));
    }

    const owner = $('#furniture-creator-interactable-owner');
    if (owner && !owner.options.length) {
        owner.append(new Option('nobody', 'nobody'), new Option('anybody', 'everybody'));

        // Four, which is what the shipped assets use: `HotelDesk` pairs two and nothing in
        // the game goes past the third. The enum reaches person29, and a select of 32 for a
        // field whose real range is four would be a list nobody reads.
        for (let index = 0; index < 4; index++) {
            owner.append(new Option(`person${index}`, `person${index}`));
        }
    }

    /*
     * `none` first: it is the game's own "skip this", and the only honest option for a
     * prefab that declares nothing.
     *
     * Rebuilt only when the options would differ, and the value put back **whether or not**
     * `fill` is set. Both halves of that are the same bug. `replaceChildren` on a `<select>`
     * drops its value to the first option, and `furnitureInteractableChanged` reads every
     * control every time -- so a rebuild during an edit to the *preset* field left the
     * select showing `none`, and the next keystroke anywhere in the form read that back and
     * wrote the pairing away. A select is not typed into, so there is no cursor for putting
     * its value back to fight over; `fill` guards the free-text field below and nothing else.
     */
    const controller = $('#furniture-creator-interactable-controller');
    if (controller) {
        const ids = usableControllerIds();

        // The entry's own id even where the prefab has not got it, so that opening a preset
        // whose pairing is broken shows what it is paired to rather than silently rewriting
        // it to the first thing on the list.
        const options = ['none', ...ids];
        if (entry.controller && !options.includes(entry.controller)) options.push(entry.controller);

        const shownIds = [...controller.options].map((option) => option.value);
        const same = shownIds.length === options.length
            && shownIds.every((id, index) => id === options[index]);

        if (!same) {
            controller.replaceChildren(...options.map((id) => new Option(
                id === 'none' ? 'none — skip this entry'
                    : ids.includes(id) ? id : `${id} — not in this prefab`,
                id)));
        }

        controller.value = entry.controller ?? 'none';
    }

    if (owner) owner.value = entry.owner ?? 'nobody';

    // The one control with a cursor in it, and the only one `fill` has to hold off.
    const preset = $('#furniture-creator-interactable-preset');
    if (preset && fill) preset.value = entry.preset ?? '';
}

/** What the marked entry comes to, one line. */
function explainInteractable(entry) {
    if (entry.controller === 'none') {
        return 'Paired to none, which the game skips — this entry creates nothing.';
    }

    const controller = (controllersOf() ?? []).find((one) => one.id === entry.controller);

    if (controller) {
        return `Created at ${entry.controller}${controller.node ? ` (${controller.node})` : ''}, `
            + `${vector(controller.offset)} from the model’s origin.`;
    }

    return canEditInteractables()
        ? `${entry.controller} is not in this prefab, so this is created at the model’s origin.`
        : `Created wherever ${entry.controller} is in the model, which cannot be read here.`;
}


/** A position, in the game's own numbers rather than the scene's. */
const vector = (values) => values.map((value) => value.toFixed(2)).join(', ');

/** A rotation, said only where there is one. Degrees, and the axes that are not zero. */
function turned(rot) {
    const axes = ['x', 'y', 'z']
        .map((axis, index) => (rot[index] ? `${Math.round(rot[index])}° about ${axis}` : null))
        .filter(Boolean);

    return axes.join(', ');
}

/**
 * The arrangements this preset can appear in, and one of them drawn as a plan.
 *
 * The plan is text rather than a second 3D view. A cluster is a handful of tiles and what
 * stands on each, which reads better as a grid of names than as boxes to orbit -- and a
 * pane with two canvases in it is a pane where neither is big enough to use.
 */
function drawClusters() {
    const out = $('#furniture-creator-clusters');
    if (!out) return;

    if (!state.preset) {
        out.replaceChildren();
        return;
    }

    /*
     * The one question here that is not about one asset.
     *
     * A preset names classes and a cluster names classes; nothing points from one to the
     * other, so the answer is "none of them" exactly when every cluster has been checked.
     * That is a read of all of them, which is asked for rather than assumed -- and kept
     * afterwards, so the second piece of furniture is instant.
     */
    if (!state.clusterIndex) {
        out.replaceChildren(scanRow());
        return;
    }

    const clusters = clustersFor(state.clusterIndex, state.preset);
    const parts = [];

    if (!clusters.length) {
        parts.push(note('No cluster in the game has a slot this fills, so nothing the '
            + 'generator places puts one down. It can still be placed by hand in decor mode, '
            + 'and a new cluster would be what makes it appear in a city.', 'warning'));
    }

    for (const cluster of clusters) {
        const row = document.createElement('li');
        const button = document.createElement('button');

        button.type = 'button';
        button.className = 'furniture-creator-pick';
        button.textContent = `${cluster.name} — ${cluster.slots.length} of `
            + `${cluster.elements} slots${cluster.disabled ? ', switched off' : ''}`;
        if (state.cluster === cluster.name) button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => openFurnitureCluster(cluster.name));

        row.append(button);

        if (cluster.disabled) {
            row.append(note('This cluster has `disable` set, so it places nothing at all.',
                'warning'));
        }

        if (state.cluster === cluster.name) {
            const layout = clusterLayout(state.clusterIndex, cluster.name);
            row.append(clusterPlan(layout, state.preset));

            for (const pair of coLocated(layout)) {
                row.append(note(`${pair.first} and ${pair.second} share the tile at `
                    + `${pair.tile[0]}, ${pair.tile[1]}, and the second is only placed if the `
                    + 'first was. That condition records the class rather than the model, so '
                    + 'swapping what fills the first slot leaves the second one firing '
                    + 'regardless.', 'warning'));
            }
        }

        parts.push(row);
    }

    out.replaceChildren(...parts);
}

/**
 * The press that reads every cluster, and what it costs, said before it is pressed.
 *
 * A progress line rather than a spinner: it is several hundred files, and "reading 143 of
 * 399" is the difference between waiting and wondering.
 */
function scanRow() {
    const row = document.createElement('li');

    if (state.scanning) {
        row.className = 'room-creator-note room-creator-note-plain';
        row.textContent = state.scanning;
        return row;
    }

    const names = state.clusters;
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'secondary outline';
    button.textContent = `Find where it appears (reads ${names.length} clusters)`;
    button.addEventListener('click', findWhereItAppears);

    row.append(button);
    return row;
}

/**
 * Read every cluster once, and keep it.
 *
 * Nothing else here reads more than a dozen files, so this is the only place a progress
 * count is worth the wiring -- and the only place the pane could appear to have hung.
 */
export async function findWhereItAppears() {
    const names = state.clusters;
    if (!names.length || state.scanning) return;

    state.scanning = `Reading 0 of ${names.length} clusters…`;
    drawClusters();

    state.clusterIndex = await readClusterIndex(names, ({ read, total }) => {
        // Every fortieth, not every file: a text node rewritten 399 times in a second is
        // work the browser does instead of drawing.
        if (read % 40 && read !== total) return;

        state.scanning = `Reading ${read} of ${total} clusters…`;
        drawClusters();
    });

    state.scanning = null;
    drawClusters();

    // The rail's hint for this step is "not read yet" until this returns, which is the one
    // thing in it that a press rather than a keystroke changes.
    drawSteps();
}

/** One arrangement as a list of tiles, nearest the anchor first. */
function clusterPlan(layout, preset) {
    const mine = new Set(preset.classes.map((entry) => entry.name));
    const list = document.createElement('ul');
    list.className = 'furniture-creator-plan';

    for (const slot of layout?.slots ?? []) {
        const row = document.createElement('li');

        row.textContent = `${slot.x}, ${slot.y} — ${slot.class}, facing ${slot.facing}`
            + `${slot.important ? ', without which the cluster is abandoned' : ''}`
            + `${slot.afterPrevious ? ', only after the one before it' : ''}`
            + `${slot.alternate ? ' (an alternate position)' : ''}`;

        if (mine.has(slot.class)) row.className = 'furniture-creator-plan-mine';
        list.append(row);
    }

    return list;
}

/* -------------------------------------------------------------------------- */
/* The editor, and what would be written                                       */
/* -------------------------------------------------------------------------- */

/**
 * The numbers for the marked sub-object.
 *
 * `fill` is false while a drag is in flight: the fields are being written *from* the
 * marker, and rewriting the field the author is typing in from a value it just produced
 * would fight them for the cursor.
 */
function drawEditor(fill = true) {
    const panel = $('#furniture-creator-editor');
    if (!panel) return;

    const sub = selectedSub();
    panel.hidden = !sub;
    if (!sub) return;

    const where = $('#furniture-creator-editing');
    if (where) {
        where.textContent = sub.parent
            ? `${sub.class}, on ${sub.parent} — these numbers are relative to that, not to the model`
            : sub.class;
    }

    if (!fill) {
        // Only the read-out, which is the one thing a drag has to keep current.
        const live = $('#furniture-creator-live');
        if (live) live.textContent = `${vector(sub.pos)} · ${turned(sub.rot) || 'not turned'}`;
        return;
    }

    const axes = ['x', 'y', 'z'];
    axes.forEach((axis, index) => {
        const position = $(`#furniture-creator-pos-${axis}`);
        const rotation = $(`#furniture-creator-rot-${axis}`);

        if (position) position.value = sub.pos[index];
        if (rotation) rotation.value = sub.rot[index];
    });

    const live = $('#furniture-creator-live');
    if (live) live.textContent = `${vector(sub.pos)} · ${turned(sub.rot) || 'not turned'}`;
}

/**
 * What writing would come to, before it does.
 *
 * Drawn from the same `planFurniture` the write runs, so the list is the act rather than a
 * description of it. What is on disk is checked twice -- here against what the folder held
 * when the pane opened, and again inside `writeFurniture` against what it holds now.
 */
function drawPlan() {
    const out = $('#furniture-creator-plan');
    const button = $('#furniture-creator-write');
    if (!out) return;

    if (!state.preset) {
        // Said rather than left blank. On a step of its own an empty pane reads as the
        // plan having failed to draw, where in the column this used to be it read as a
        // section nobody had opened yet.
        out.replaceChildren(note('Nothing is open, so there is nothing to write. Choose a '
            + 'piece of furniture on the first step.'));

        if (button) button.disabled = true;

        planned = null;
        drawSteps();
        return;
    }

    const { plan, landed } = landing(state.index);
    const clashes = landed.filter((item) => item.action === 'clash' || item.action === 'refuse');

    const parts = [];

    /*
     * What each file will get, said before the button rather than after it.
     *
     * Three outcomes now, not two. "Rewritten" was the old word for all of them and it was
     * the wrong one twice over: a save merges into what is there, keeping every field this
     * pane does not own, and it does not touch an existing cluster at all.
     */
    const list = document.createElement('ol');
    for (const item of landed) {
        const row = document.createElement('li');

        // The name as a name, and what happens to it as a reading of that -- a file name is
        // a thing the author will go looking for in the folder, and it reads as one rather
        // than as the first few words of a sentence about it.
        row.append(asFile(item.file), said({
            create: ' — new',
            merge: ' — already here, and the fields this pane owns updated in it',
            leave: ' — already here, and left alone',
            clash: ' — already here, and something else’s',
        }[item.action] ?? ` — cannot be written: ${item.reason}`));

        list.append(row);
    }
    parts.push(list);

    if (clashes.length) {
        parts.push(note(`${clashes.map((item) => item.file).join(', ')} `
            + `${clashes.length === 1 ? 'is' : 'are'} already in this folder and not this `
            + 'furniture’s. Change the name before writing.', 'warning'));
    }

    for (const problem of plan.problems) parts.push(note(problem, 'warning'));

    out.replaceChildren(...parts);

    planned = { count: landed.length, problems: plan.problems };
    drawSteps();

    if (!button) return;

    // No changes is the plan saying the name is not settled -- see `planFurniture`. Read
    // structurally rather than by recognising a problem's wording, so a new reason to
    // refuse a name cannot leave the button enabled by being phrased unexpectedly.
    const blocked = !window.selectedMod?.baseFolder;
    const unnamed = !plan.changes.length;

    button.disabled = blocked || unnamed || clashes.length > 0;

    button.textContent = blocked ? 'Choose a mod to write into'
        : unnamed ? 'Name it to write'
            : clashes.length ? 'Change the name to write'
                : landed.some((item) => item.action !== 'create') ? `Save ${state.name}`
                    : `Write ${plan.changes.length} files`;
}

/**
 * The whole write, landed against a folder.
 *
 * One function for the preview and for the write, called with the folder as it was last
 * read and with the folder as it is -- see the same note in `roomCreator.js`.
 *
 * A patch of this name is not "this furniture's own files": it is a different file doing a
 * different thing, and treating it as ours would call an overwrite a save.
 */
function landing(index) {
    const plan = planFurniture(choices());
    const named = state.mod.get(state.name);

    const own = new Set(named && named.source !== 'patch'
        ? plan.changes.map((change) => change.file) : []);

    return { plan, landed: landAll(plan.changes, index, { own }) };
}

/**
 * The rail: what each step has to say about itself.
 *
 * Read off `state` rather than tracked alongside it, for the reason every pane here redraws
 * whole -- a rail keeping its own counts could disagree with the pane beside it about what
 * the author last did. The only thing held is the plan's file count, in `planned`, because
 * working it out again would be a second `planFurniture` per keystroke.
 */
function drawSteps() {
    if (!steps) return;

    const preset = state.preset?.unread ? null : shown();
    const size = placementOf()?.size;
    const built = preset?.interactables?.length ?? 0;
    const subtitle = $('#furniture-creator-subtitle');
    const own = state.preset ? state.mod.get(state.preset.name) : null;

    if (subtitle) {
        subtitle.textContent = !state.preset ? 'nothing open'
            : `${state.preset.name} · ${own ? 'this mod’s' : 'the game’s'}`
                + `${state.edits ? ' · edited' : ''}`;
    }

    steps.update({
        source: { hint: state.preset?.name ?? 'nothing open', note: STEP_NOTES.source },
        placement: {
            hint: size ? `${size[0]} × ${size[1]} nodes` : 'no class',
            note: STEP_NOTES.placement,
        },
        sits: {
            hint: preset ? `${preset.placed.length} ${preset.placed.length === 1 ? 'object' : 'objects'}` : '',
            note: STEP_NOTES.sits,
        },
        built: {
            hint: preset ? `${built} ${built === 1 ? 'interactable' : 'interactables'}` : '',
            note: STEP_NOTES.built,
        },
        appears: {
            hint: state.clusterIndex
                ? `${clustersFor(state.clusterIndex, state.preset).length} clusters`
                : 'not read yet',
            note: STEP_NOTES.appears,
        },
        write: {
            hint: planned ? `${planned.count} ${planned.count === 1 ? 'file' : 'files'}` : '',
            note: STEP_NOTES.write,
        },
    });

    // The first thing standing between this preset and a write. One line: the plan says
    // the rest, on the step that is about it.
    steps.say(planned?.problems?.[0] ?? '');
}

/** The name the class this plan writes would take. */
const classNameNow = () => `${(state.name ?? '').trim()}${CLASS_SUFFIX}`;

/**
 * Whether this save writes over a class of this mod's that already exists.
 *
 * True from the second save of a piece of furniture onwards, which is how anything actually
 * gets edited: write `MyDesk`, come back to it, change something, write it again.
 */
function savingOverOwnClass() {
    const name = classNameNow();
    return name !== CLASS_SUFFIX && state.modClasses.has(name);
}

/**
 * The class the new one copies, never itself.
 *
 * The same rule the preset's `donor` has followed from the start, arrived at the same way. A
 * preset states the class this pane wrote for it, so on the way back in that class is the
 * one the pane finds itself mimicking -- and copying it would write `MyDeskFC` with
 * `copyFrom: MyDeskFC`. That is a loop for the loader and a class with no rules of its own,
 * and neither shows up before the city is generated.
 *
 * So when the class named is the one about to be written, this takes whatever *that* class
 * copies from instead: the chain back to the shipped class stays intact through any number
 * of saves. Null where there is nothing behind it, which is a class written from scratch --
 * and then the rules are stated in full, which is what `choices` arranges.
 */
function classDonorFor() {
    const named = state.preset.classes.find((entry) =>
        !entry.missing || state.modClasses.has(entry.name))?.name ?? null;

    if (!named || named !== classNameNow()) return named;

    return state.modClasses.get(named)?.donor ?? null;
}

/** The author's choices, in the shape `planFurniture` reads. */
function choices() {
    const edits = state.edits ?? state.preset;
    const own = state.mod.get(state.preset.name);

    return {
        name: state.name,

        /*
         * What the new preset copies from.
         *
         * A shipped preset: itself. The mod's own file of fields: whatever *it* copies,
         * rather than itself -- a file naming itself in `copyFrom` is a loop, and the
         * loader following one is not something to find out in game. A patch: the shipped
         * asset it patches, because that is the thing the numbers on screen came from.
         */
        donor: !own || own.source === 'patch'
            ? state.preset.name
            : state.preset.donor ?? null,

        // Names this mod patches, which are names a file of fields may not also take.
        patched: [...state.mod.values()]
            .filter((entry) => entry.source === 'patch')
            .map((entry) => entry.name),

        // The slot being mimicked, which the new class copies. The first, where a preset
        // is in several: the class is the one this preset is going to be the only member
        // of, and there can only be one of those.
        classDonor: classDonorFor(),

        subObjects: [...(edits.placed ?? []), ...(edits.parented ?? [])],

        // Stated whole every time, edited or not. The field replaces the donor's rather
        // than adding to it, so the list on screen -- which is the donor's already resolved
        // -- is what has to go out or a save would drop every one of them.
        interactables: edits.interactables ?? [],

        /*
         * The rules, where the author has opened Placement and changed one. Absent means the
         * class is written as a bare clone -- see `planFurniture`.
         *
         * Except when the class being written is this mod's own and already exists, which is
         * every save after the first. There is no bare clone of yourself: the `copyFrom`
         * that would have carried the rules is the one `classDonorFor` just refused to
         * write, so the rules have to be stated or they are gone. What was read is what is
         * in play, so stating it is a no-op except that it survives.
         */
        placement: state.placement ?? (savingOverOwnClass() ? placementOf() : null),
        filters: state.preset.filters ?? [],
        prefab: state.preset.prefab && /^PREFAB:/i.test(state.preset.prefab)
            ? state.preset.prefab : null,
        minimumRoomSize: state.preset.minimumRoomSize >= 99 ? 1 : state.preset.minimumRoomSize,
    };
}

/**
 * Write the three assets into the selected mod's content folder.
 *
 * The files go down before the manifest, so a failure part way through leaves assets the
 * loader never reaches rather than a load order naming files that are not there. Nothing
 * belonging to anything else is touched: three files with this furniture's names, and
 * three entries appended to `fileOrder` in dependency order.
 */
export async function writeFurniture() {
    const folder = window.selectedMod?.baseFolder;
    const out = $('#furniture-creator-plan');
    if (!folder || !out || !state.preset) return;

    /*
     * Read before deciding anything, and read the *contents* rather than only the names.
     *
     * The index the preview was drawn from is whatever the folder held when the pane opened,
     * and a write has to answer to it as it is now. The contents matter because a save is a
     * merge: this pane owns a named handful of fields in each file and must leave the rest
     * alone -- an arrangement built by hand, a `minimumRoomSize` typed in, a field of the
     * game's that nothing here has heard of.
     *
     * A file that will not parse stops the write. It is the one case where the honest thing
     * is to refuse: merging into a file this cannot read would silently drop all of it,
     * which is exactly what the owned merge exists to stop.
     */
    const { landed } = landing(indexMod(await readModFiles(folder)));
    const result = await commit(folder, landed);

    if (result.refused.length) {
        out.prepend(note(`Nothing has been written. ${result.refused.map((item) => item.reason).join('. ')}. `
            + 'Change this furniture’s name, or fix the file.', 'warning'));
        return;
    }

    if (result.malformed) {
        out.prepend(note(`${MANIFEST_FILE} could not be read, so it has been left alone. The `
            + `${result.written.length} files are written but none of them will load until they `
            + 'are listed there by hand.', 'warning'));
        return;
    }

    // What was written, and what was deliberately not. The cluster is the second kind: once
    // it exists the pane owns nothing in it, so a save leaves it alone entirely.
    const written = result.written.map((item) => item.file);
    const untouched = result.left.map((item) => item.file);

    // Re-read and redraw before saying anything: `drawPlan` replaces this pane wholesale,
    // so a note put up before it runs is one the author never sees.
    state.presets = await listAssets('FurniturePreset');
    state.clusters = await listAssets('FurnitureCluster');

    await refreshModFurniture();
    drawPicker();
    drawPlan();

    /*
     * What happened, said as what happened.
     *
     * The first write and every save after it read differently, and they should: the first
     * makes three files and the note can explain what they are for, and a save has left one
     * of them alone on purpose. Saying "3 files written" for a save that wrote two was the
     * pane claiming to have done the thing this change exists to stop it doing.
     */
    const kept = untouched.length
        ? ` ${untouched.join(', ')} ${untouched.length === 1 ? 'was' : 'were'} left exactly as `
            + 'you have it — the arrangement is yours to edit, and this pane has nothing to '
            + 'put in it.'
        : '';

    out.prepend(note(`${written.length} ${written.length === 1 ? 'file' : 'files'} written, `
        + `listed in ${MANIFEST_FILE}.${kept}`
        + (untouched.length ? '' : ` ${state.name} is a piece of furniture in its own class, `
            + 'placed by its own cluster — the arrangement is one slot, and editing the '
            + 'cluster is how it becomes more.')));
}

/* -------------------------------------------------------------------------- */
/* Drawing the placement half                                                  */
/* -------------------------------------------------------------------------- */

/** The class picker, the diagram, what it cannot draw, and the editor for one rule. */
function drawPlacementPane() {
    const picker = $('#furniture-creator-class');
    const canvas = $('#furniture-creator-placement');
    if (!canvas) return;

    // Every class the preset names, not only the ones the reference data has: one it does
    // not know may still be the mod's own, and dropping it from the picker would hide the
    // class an author is most likely to be here about.
    const classes = state.preset?.classes ?? [];

    if (picker) {
        picker.replaceChildren(...classes.map((entry, index) => {
            const own = state.modClasses.has(entry.name);
            const option = new Option(own ? `${entry.name} — this mod’s` : entry.name, String(index));
            option.selected = index === state.classIndex;
            return option;
        }));

        // One class is not a choice, and a select with one option in it reads as one.
        picker.parentElement.hidden = classes.length < 2;
    }

    const placement = placementOf();
    const footprint = $('.furniture-creator-footprint');

    if (!placement) {
        const entry = classes[state.classIndex];

        canvas.replaceChildren(note(!state.preset
            ? 'Choose a piece of furniture to see where it may stand.'
            : !entry
                ? 'This preset is in no furniture class at all, so nothing decides where it '
                    + 'may stand — and no cluster has a slot it can fill.'
                : `${entry.name} is neither one of the game's classes nor a `
                    + `FurnitureClass file in this content folder, so its rules cannot be read. `
                    + 'If it is this mod’s, check the file is in the folder you have open and '
                    + 'that its `fileType` says FurnitureClass.'));

        if (footprint) footprint.hidden = true;
        drawRuleEditor(null);
        return;
    }

    // The size the diagram is drawn from. Only ever written into the fields from here, so a
    // half-typed number is not overwritten mid-keystroke -- `placementSizeChanged` refuses
    // a value it cannot read rather than correcting it, and this puts back what stuck.
    if (footprint) {
        footprint.hidden = false;

        const across = $('#furniture-creator-size-x');
        const deep = $('#furniture-creator-size-y');

        if (across && document.activeElement !== across) across.value = placement.size[0];
        if (deep && document.activeElement !== deep) deep.value = placement.size[1];
    }

    // What the mesh measures, where there is a mesh. Null for every shipped preset, whose
    // model is in an asset bundle this app cannot open -- so the overlay is absent rather
    // than empty, and the diagram claims nothing it cannot see.
    const extent = modelExtent(state.model);

    drawPlacement(canvas, placement, {
        extent,
        selected: state.rule,
        selectedTile: state.tile,
        onSelect: selectPlacementRule,
        onSelectTile: selectPlacementTile,
        onAdd: addPlacementRule,
    });

    const notes = $('#furniture-creator-placement-notes');
    if (notes) {
        const parts = [];

        // The model against the footprint, first: it is the only thing here the game does
        // not check, so it is the only thing that will not show up as a placement that
        // simply never happens.
        const overhang = explainExtent(placement, extent);
        if (overhang) {
            parts.push(note(overhang,
                overhangTiles(placement, extent).length ? 'warning' : 'plain'));
        }

        // Blocked access is not about whether the piece may stand here, so it is under the
        // grid rather than on it -- and it is the field most likely to be copied by
        // accident from a class that blocks differently.
        for (const line of blockNotes(placement)) parts.push(note(line));

        // Which file the rules came out of. A mod's own class is read whole from the
        // folder; a shipped one is the two reference files joined. The difference matters
        // when they disagree, which is exactly when an author is looking.
        if (placement.fromAsset) {
            parts.push(note(`Read from this mod’s own ${placement.name}. A rule its file does `
                + 'not state is the one it copies from, because a stated list replaces the '
                + 'donor’s rather than adding to it.'));
        }

        if (state.placement) {
            parts.push(note('These rules have been edited. Writing states them in full, which '
                + 'replaces the donor’s rather than adding to them — and is what stops a copied '
                + 'class keeping rules that name the class it was copied from.'));
        }

        notes.replaceChildren(...parts);
    }

    drawRuleEditor(state.rule);
}

/**
 * The three things a `+` can turn into, in the words they read as on the diagram.
 *
 * The values are the `kind` each entry carries, so the select is read straight into
 * `convertRule` with nothing in between to get out of step.
 */
const RULE_KINDS = [
    ['wall', 'the walls around this tile'],
    ['node', 'what is already standing on this tile'],
    ['block', 'the ways out of this tile it closes'],
];

/**
 * The fields for one entry.
 *
 * Three forms shown one at a time -- a single form with two thirds of its fields greyed is
 * harder to read than any of them -- under one select that says which of the three this is.
 *
 * That select is not a convenience. A class with no occupancy rule has none to mark, so
 * before it there was no reachable way to write the first one; the same was true of a closed
 * way out. Converting an entry the `+` just made is what opens both.
 */
function drawRuleEditor(rule) {
    const panel = $('#furniture-creator-rule-editor');
    if (!panel) return;

    // Revert acts on the whole class rather than on one rule, so it is outside this panel
    // and has to be reachable when nothing at all is marked. Remove is inside, where the
    // rule it takes away is described.
    const revert = $('#furniture-creator-rule-revert');
    if (revert) revert.disabled = !state.placement;

    panel.hidden = !rule;
    if (!rule) return;

    const kind = rule.kind ?? 'wall';

    $('#furniture-creator-rule-wall').hidden = kind !== 'wall';
    $('#furniture-creator-rule-node').hidden = kind !== 'node';
    $('#furniture-creator-rule-block').hidden = kind !== 'block';

    const said = kind === 'block' ? explainBlock(rule) : explainRule(rule);

    const meaning = $('#furniture-creator-rule-meaning');
    if (meaning) meaning.textContent = said;

    // Named after the rule rather than "remove": a cross whose whole label is a cross says
    // nothing to a screen reader about which of a grid's rules it would take off.
    const remove = $('#furniture-creator-rule-remove');
    if (remove) {
        remove.title = `Take this rule off: ${said}`;
        remove.setAttribute('aria-label', remove.title);
    }

    const kinds = $('#furniture-creator-rule-kind');
    if (kinds && !kinds.options.length) {
        for (const [value, label] of RULE_KINDS) kinds.append(new Option(label, value));
    }
    if (kinds) kinds.value = kind;

    const tag = $('#furniture-creator-rule-tag');
    if (tag && !tag.options.length) {
        for (const name of WALL_RULE) {
            tag.append(new Option(`${name} — ${TAG_MEANING[name] ?? ''}`, name));
        }
    }

    const dir = $('#furniture-creator-rule-dir');
    if (dir && !dir.options.length) {
        for (const name of BLOCKING_DIRECTION) dir.append(new Option(name, name));
    }

    /*
     * Two option selects rather than one shared between the forms.
     *
     * The shared one lived inside the wall form, so it went away with it -- and
     * `placementRuleChanged` went on reading it, which meant a node rule's option could
     * never be changed and silently kept whatever it was read with. Two selects, each in
     * its own form, cannot go out of sight of the code that reads them.
     */
    for (const id of ['option', 'node-option']) {
        const select = $(`#furniture-creator-rule-${id}`);
        if (!select || select.options.length) continue;

        select.append(new Option('must have', 'mustFeature'));
        select.append(new Option('must not have', 'cantFeature'));
        select.append(new Option('prefers', 'canFeature'));
    }

    if (tag) tag.value = rule.tag ?? 'wall';
    if (dir) dir.value = rule.dir ?? 'behind';

    const option = $('#furniture-creator-rule-option');
    if (option && kind === 'wall') {
        option.value = rule.gates === false ? 'canFeature'
            : rule.must ? 'mustFeature' : 'cantFeature';
    }

    const nodeOption = $('#furniture-creator-rule-node-option');
    if (nodeOption && kind === 'node') nodeOption.value = rule.option ?? 'cantFeature';

    const named = $('#furniture-creator-rule-class');
    if (named && kind === 'node') named.value = rule.any ? '*' : rule.class ?? '';

    if (kind === 'block') drawBlockDirections(rule);

    $('#furniture-creator-rule-at-x').value = rule.at[0];
    $('#furniture-creator-rule-at-y').value = rule.at[1];
}

/**
 * The ways out a block closes, as one checkbox each.
 *
 * Several at once, unlike a wall rule's single direction: `blocked` is a list, and a piece
 * standing in a corner closes two or three of them. `none` is left out -- it is the enum's
 * zero and closes nothing, so a box for it would be a way to write an entry that does not
 * do anything.
 */
function drawBlockDirections(entry) {
    const fieldset = $('#furniture-creator-block-dirs');
    if (!fieldset) return;

    const wanted = BLOCKING_DIRECTION.filter((dir) => dir !== 'none');

    // Built once and then only ticked. Replacing them on every redraw would take the focus
    // out of the box that was just clicked, mid-`oninput`.
    if (fieldset.children.length !== wanted.length) {
        fieldset.replaceChildren(...wanted.map((dir) => {
            const label = document.createElement('label');
            const box = document.createElement('input');

            box.type = 'checkbox';
            box.id = `furniture-creator-block-${dir}`;

            label.append(box, document.createTextNode(dir));
            return label;
        }));
    }

    for (const dir of wanted) {
        const box = $(`#furniture-creator-block-${dir}`);
        if (box) box.checked = entry.dirs.includes(dir);
    }

    const diagonals = $('#furniture-creator-block-diagonals');
    if (diagonals) diagonals.checked = !!entry.diagonals;
}

function note(text, kind = 'plain', tag = 'small') {
    const element = document.createElement(tag);
    element.className = `room-creator-note room-creator-note-${kind}`;
    if (tag === 'small') element.setAttribute('role', 'status');
    element.textContent = text;
    return element;
}

/**
 * The cross that takes a row off, drawn at the end of the row it acts on.
 *
 * A sibling of the row's own button rather than inside it: the row is a button already --
 * pressing it marks the sub-object -- and a button within a button is not a thing the
 * parser will build. The cross is what the building flow's address rows use for the same
 * act, and the label says which row it is so that a screen reader hears five different
 * buttons rather than five called "remove".
 */
function removeRowButton(label, why, onPress) {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'furniture-creator-row-remove';
    button.textContent = '✕';
    button.title = why;
    button.setAttribute('aria-label', label);

    button.addEventListener('click', (event) => {
        // The row behind it marks the sub-object, and this press is not that.
        event.stopPropagation();
        onPress();
    });

    return button;
}

/** A file name in the plan, set apart from the prose around it. */
function asFile(text) {
    const element = document.createElement('code');
    element.textContent = text;
    return element;
}

/** What the plan says about the file beside it. */
function said(text) {
    const element = document.createElement('span');
    element.className = 'creator-plan-how';
    element.textContent = text;
    return element;
}
