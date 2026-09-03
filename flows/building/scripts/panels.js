/**
 * The controls beside the floorplan: the tool bar, the address and room lists, the wall
 * preset picker, and the fields of whatever is selected.
 *
 * These render into elements they are given rather than into ids of their own, so the
 * flow decides the layout and this decides what goes in it. Every one of them is a full
 * redraw: a floor has at most a few dozen addresses and rooms, and rebuilding a list
 * that size is cheaper than keeping a diff of it correct.
 *
 * The name lists are the game's own assets and the mod's own, in that order of
 * precedence and the other order on screen -- the mod's first, under a heading of their
 * own, exactly as the furniture checker offers its presets. A layout configuration
 * neither has is a floor the game will not load, so the lists are the whole of what can
 * be chosen; a floor that already names something else keeps it and says what it is.
 */
import {
    Tool, PaintMode, createToolState,
} from './tools.js';
import {
    TileMode, tileParts,
    nodeAt, tileForNode, roomsOfAddress, roomAt, roomOfNode, getWall,
    addAddress, removeAddress, outsideAddressIndex, nodesOfAddress,
    addRoom, removeRoom, seedRoomForLayout, selectVariation, addVariation,
    duplicateVariation, removeVariation,
} from './floorModel.js';
import { sameSlot } from './buildingLibrary.js';
import {
    DIVIDER_END, DIVIDER_END_KIND, DIVIDER_END_NAME, isDividerEnd,
} from './dividerEnds.js';
import {
    furnitureChain, furnitureAt, explainFurniture, furniturePresetSections,
    findFurniturePreset, clusterWarnings, unfurnishedReason, UNAPPLIED_GATES,
} from './furnitureChain.js';
import { searchSelect } from '../../../core/components/searchSelect/searchSelect.js';
import { createSelectPool } from './keptSelects.js';

/** Where the panels read their name lists from, overridable so tests need no globals. */
const refs = () => ({
    layoutConfigurations: window.layoutConfigurations ?? [],
    roomTypePresets: window.roomTypePresets ?? [],
    wallPresets: window.wallPresets ?? [],
    floorTileTypes: window.floorTileTypes ?? [],
});

const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value !== null && value !== undefined) node.setAttribute(key, value);
    }
    for (const child of [children].flat()) if (child) node.appendChild(child);
    return node;
};

const clear = (element) => { while (element.firstChild) element.firstChild.remove(); };

/**
 * Spread into an element's props to grey it out.
 *
 * Used on every control that writes to the floor, and on none of the controls that only
 * choose what would be painted. With no mod selected there is nowhere to save to, so a
 * floor can be opened and read but not changed -- and a control that appears to work and
 * then loses what you did is worse than one that says it cannot.
 */
const unless = (allowed) => (allowed ? {} : { disabled: 'disabled' });

/* -------------------------------------------------------------------------- */
/* The name pickers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Where a dropdown hangs.
 *
 * Anywhere but the column the control is in. `#building-panels` is `overflow-y: auto`,
 * and a dropdown parented inside it is positioned against a box that moves under it --
 * which is what the plain `<select>`s these replaced never had to care about and what the
 * furniture checker's own control has been doing since it was written.
 *
 * Read on every render rather than held: switching flows replaces this flow's markup, so
 * the element a control was built against is not the one on the page afterwards. Its
 * identity is in every signature below for that reason.
 */
const dropdownParent = () => document.querySelector('.building-workspace');

/** One pool per list. See createSelectPool on why they cannot be shared. */
const addressSelects = createSelectPool({ onClosed: () => resumePanels() });
const roomSelects = createSelectPool({ onClosed: () => resumePanels() });
const wallSelects = createSelectPool({ onClosed: () => resumePanels() });

/**
 * A redraw of this column that is waiting for a dropdown to be shut.
 *
 * ## Why a redraw waits at all
 *
 * Redrawing a panel takes every control in it out of the document, and a control has to
 * be shut before that -- see `closeAll` in keptSelects.js, where the alternative is the
 * column losing its scrolling for good. So a redraw closes whatever list is open.
 *
 * Almost none of those redraws are about the control. The commonest by far is the 600ms
 * autosave: an edit starts the timer, the write finishes, and `refreshPanel` in ui.js
 * redraws every panel -- so a list opened in the second after any edit was taken away
 * while it was being read, for a save that changed nothing the list shows. The redraw
 * usually rebuilds nothing either: the pool keeps a control whose signature has not
 * changed, so what the user lost was the only part that was not being kept.
 *
 * ## What waiting costs
 *
 * Nothing the user can see for longer than the choice takes. The panels hold the model
 * they were last drawn from, which is the model the open list belongs to; anything that
 * changes underneath -- a stroke, a save, a mod change -- leaves its redraw here and it
 * runs the moment the list shuts. Choosing from the list shuts it too, and searchSelect
 * closes before it reports the choice, so an edit made through one of these controls
 * redraws as it always did.
 *
 * The status column is not held back with the rest: it is redrawn on its own for every
 * pointer move, and freezing it would stop it saying what the pointer is over. Its one
 * control, the furniture checker, is closed on hover as it always was.
 */
let pendingPanels = null;

/**
 * Run the redraw a dropdown was holding back.
 *
 * On a timer rather than here and now. select2 fires the close this answers from inside
 * its own `close`, which still has work to do afterwards -- and this rebuilds the row the
 * control is sitting in. One turn of the loop later it is finished.
 *
 * Checked again on arrival: closing one list can be the same gesture that opens another,
 * and a redraw between the two would be the thing this exists to prevent.
 */
function resumePanels() {
    setTimeout(() => {
        const redraw = pendingPanels;
        if (!redraw || dropdownsOpen()) return;

        pendingPanels = null;
        redraw();
    });
}

/** Whether any of this column's kept controls is showing its list. */
const dropdownsOpen = () =>
    addressSelects.anyOpen() || roomSelects.anyOpen() || wallSelects.anyOpen();

/**
 * Give up every control this file is holding.
 *
 * For the flow being switched away from. The controls are kept across a redraw on
 * purpose, which means nothing else ever destroys them -- and a select2 instance whose
 * `<select>` has left the document keeps the scroll handlers it bound to a column that is
 * no longer there. See keptSelects.js.
 */
export function releaseSelects() {
    addressSelects.clear();
    roomSelects.clear();
    wallSelects.clear();

    checker?.control.destroy();
    checker = null;

    // After the pools, not before: clearing them closes what was open, which is what asks
    // for a held-back redraw to be run. The panels this one was drawn for are on their way
    // off the screen, and the controls it would put back have just been destroyed.
    pendingPanels = null;
}

/**
 * Nothing from the mod, as one array rather than a fresh one each time.
 *
 * The sections below are memoised on this array's identity, so a `?? []` here would make
 * every redraw a cache miss -- and every cache miss rebuilds every control on the page.
 */
const NO_MOD_ASSETS = [];

/** What `nameSections` last worked out, per type. */
const sectionCache = new Map();

/**
 * The names on offer for a type, the mod's own separated from the game's.
 *
 * The mod's come from the same overlay the furniture checker is answered from: a
 * `LayoutConfiguration` or a `RoomTypePreset` in the selected content folder is read and
 * recorded by `readModAssets` and `overlayChain` whether or not the chain has a use for
 * its fields, precisely so that lists like this one can offer it.
 *
 * A name the mod defines is taken out of the game's half rather than shown twice. What
 * the mod ships wins at load time, so a duplicate is one asset under two headings, and
 * the heading that tells the truth about which file the game reads is the mod's.
 *
 * Memoised on the identity of the two lists, and that is not an optimisation: the object
 * returned is what the pools compare to decide whether a control still offers what it was
 * built with, so an equal-but-new object every redraw would rebuild every dropdown on
 * every paint stroke.
 */
function nameSections(type, base) {
    const applied = modFurniture?.()?.applied ?? NO_MOD_ASSETS;

    const cached = sectionCache.get(type);
    if (cached && cached.applied === applied && cached.base === base) return cached.sections;

    // A mod may hold both `<Name>.sodso.json` and a patch of the same name; both are
    // applied and both are recorded, and it is one name on the list.
    const modded = [...new Set(applied
        .filter((asset) => asset.type === type)
        .map((asset) => asset.name))];

    const own = new Set(modded);
    const vanilla = base.filter((name) => !own.has(name));

    const sections = { modded, vanilla, known: new Set([...modded, ...vanilla]) };

    sectionCache.set(type, { applied, base, sections });
    return sections;
}

/**
 * What a name picker is built from, short of what picking one does.
 *
 * A value on neither list is offered as an entry of its own, ahead of both sections and
 * marked. Free text is off -- a layout configuration nothing defines is a floor the game
 * will not load, so this is a list to choose from rather than a field to fill in -- and
 * that means a floor already naming something absent would otherwise open showing the
 * first name in the list and rewrite itself the moment anything else was edited.
 *
 * The signature is everything the control cannot be told again once select2 has it: the
 * options, the dropdown's parent, and whether it is disabled. The value is not in it,
 * because re-pointing a kept control is the whole point of keeping one.
 */
function nameSelectSpec(sections, value, { placeholder, className, canEdit, title }) {
    const unknown = value && !sections.known.has(value) ? value : null;
    const parent = dropdownParent();

    return {
        class: className,
        title,
        disabled: !canEdit,
        signature: [sections, parent, canEdit, unknown],

        parent,
        groups: [
            { label: 'Modded', options: sections.modded },
            { label: 'Vanilla', options: sections.vanilla },
        ],
        options: unknown
            ? [{ value: unknown, text: `${unknown} (not a base game asset)` }]
            : [],

        value: value ?? '',

        // Also what makes select2 hide the empty option `setOptions` prepends: without a
        // placeholder it has no reason to, and the list opens onto a blank first row.
        placeholder,
        dropdownClass: 'name-select-dropdown',

        // These sit in the right-hand column, and the dropdown is wider than they are so
        // that a name fits on one line. Anchored at the left edge it would open off the
        // side of the window; anchored at the right it opens back over the canvas, which
        // is where the room is. The checker opposite wants the opposite, and gets it by
        // not asking for this.
        alignRight: true,
    };
}


/* -------------------------------------------------------------------------- */
/* The tool bar                                                                */
/* -------------------------------------------------------------------------- */

const TOOL_LABELS = [
    [Tool.ADDRESS, 'Address'],
    [Tool.ROOM, 'Room'],
    [Tool.FLOOR_TYPE, 'Floor type'],
    [Tool.WALL, 'Wall'],
    [Tool.TILE, 'Tile'],
];

const TILE_MODE_LABELS = {
    [TileMode.STAIRWELL]: 'Stairwell',
    [TileMode.INVERTED]: 'Inverted',
    [TileMode.ENTRANCE]: 'Entrance',
};

const MODE_LABELS = [
    [PaintMode.NONE, 'None', 'A click selects the square under it and takes all five of '
        + 'its values. Nothing is edited.'],
    [PaintMode.PAINT, 'Paint', 'A click paints one cell, and a drag paints every cell it '
        + 'crosses.'],
    [PaintMode.FLOOD, 'Flood', 'A click paints every cell it can reach without crossing a '
        + 'wall, whatever those cells hold now.'],
];

/**
 * Whether clicks paint, which tool they paint with, and the reminder of what the
 * modifiers do.
 *
 * The mode is its own row rather than three more tools, because it is a different
 * question from which tool is active: the answer stays put while you cycle through all
 * five. It starts at None, so that opening a floor to look at it cannot edit it -- a
 * stray click on a base game floor would otherwise write a copy of it into the mod.
 *
 * The reminder is on screen rather than in a manual because the modifiers are the whole
 * interface: without ctrl there is no way to pick a value off the floor, and a tool bar
 * that does not say so leaves the feature undiscoverable.
 */
export function renderToolBar(container, state, { onChange, canPaint = true } = {}) {
    clear(container);

    const redraw = () => {
        renderToolBar(container, state, { onChange, canPaint });
        onChange?.();
    };

    const modes = MODE_LABELS.map(([mode, label, explanation]) => el('button', {
        type: 'button',
        class: state.mode === mode ? 'mode active' : 'mode',
        'aria-pressed': state.mode === mode ? 'true' : 'false',
        'data-mode': mode,
        text: label,
        // None is always available: with no mod there is nowhere to write, but reading a
        // floor by clicking about it is exactly what there is to do.
        ...unless(canPaint || mode === PaintMode.NONE),
        title: explanation,
        onclick: () => { state.mode = mode; redraw(); },
    }));

    container.appendChild(el('div', {
        class: state.mode === PaintMode.NONE ? 'mode-bar' : 'mode-bar on',
    }, modes));

    if (!canPaint) {
        container.appendChild(el('p', {
            class: 'tool-hint painting-blocked',
            text: 'Painting needs somewhere to save to. Choose a mod and content folder.',
        }));
    }

    const buttons = TOOL_LABELS.map(([tool, label]) => el('button', {
        type: 'button',
        class: state.tool === tool ? 'tool active' : 'tool',
        'aria-pressed': state.tool === tool ? 'true' : 'false',
        'data-tool': tool,
        text: label,
        onclick: () => { state.tool = tool; redraw(); },
    }));

    container.appendChild(el('div', { class: 'tool-bar' }, buttons));

    // What a click does right now, and nothing that does not change. The camera gestures
    // and the modifiers are in Help: they are a reference to read once, and four lines of
    // them here crowded out the panel below that says what is under the pointer.
    container.appendChild(el('p', { class: 'tool-hint', text: toolHint(state) }));
}

/**
 * What the left button does right now.
 *
 * Flood says the same as paint for the two tools it cannot fill. A wall is an edge rather
 * than an area and a tile click cycles rather than sets, so both go on behaving as they
 * do in paint -- and a hint promising a fill that will not happen is worse than no hint.
 */
function toolHint(state) {
    if (state.mode === PaintMode.NONE) return 'Left click to select a square · Nothing is edited';

    const floods = state.mode === PaintMode.FLOOD
        && state.tool !== Tool.WALL && state.tool !== Tool.TILE;

    const click = floods ? 'Left click to fill up to the walls' : 'Left click to paint';

    return state.tool === Tool.WALL
        ? `${click} · Ctrl+click to select · Shift+click to remove`
        : `${click} · Ctrl+click to select`;
}


/* -------------------------------------------------------------------------- */
/* Addresses                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The floor's addresses: which is being painted with, what each is, and which of its
 * layout variations is on show.
 *
 * The variation control is the part with no equivalent in the reference tool, which
 * shows variation 0 and writes only that. 117 of the base game's 602 addresses have
 * more than one, so for those this is the difference between editing a floor and
 * quietly deleting most of it.
 */
export function renderAddressPanel(
    container, model, state, { onChange, onRebuild, canEdit = true } = {},
) {
    // Before the clear, which detaches every control in this list. See closeAll.
    addressSelects.closeAll();

    clear(container);
    if (!model) return;

    const { layoutConfigurations, roomTypePresets } = refs();
    const sections = nameSections('LayoutConfiguration', layoutConfigurations);

    const list = el('div', { class: 'address-list' });

    // In the document before the rows are, because the pool hands each control to select2
    // as it builds it and select2 measures the element it is given. A row built into a
    // detached list would have its dropdown sized against nothing.
    container.appendChild(list);

    model.addresses.forEach((address, index) => {
        const selected = state.addressIndex === index;

        const row = el('div', {
            class: selected ? 'address-row selected' : 'address-row',
            'data-address': String(index),
        });
        list.appendChild(row);

        row.appendChild(el('input', {
            type: 'radio',
            name: 'painting-address',
            value: String(index),
            ...(selected ? { checked: 'checked' } : {}),
            onchange: () => {
                state.addressIndex = index;
                // The room list below is this address's, and a slot in the last one
                // names a different room here. First row, which is the one it draws
                // selected.
                state.roomIndex = 0;
                onChange?.();
            },
        }));

        // Index 0 is Outside and index 1 the Lobby, by a convention the game relies on,
        // so both are labelled rather than left to be inferred from the name.
        const role = index === 0 ? ' (outside)' : (index === 1 ? ' (lobby)' : '');
        row.appendChild(el('span', { class: 'address-index', text: `${index}${role}` }));

        addressSelects.acquire(index, row, {
            ...nameSelectSpec(sections, address.layoutConfiguration, {
                placeholder: 'Layout configuration',
                className: 'name-select layout-select',
                title: 'Which layout configuration this address is',
                canEdit,
            }),

            onPick: (value) => {
                // The empty entry that stands for "nothing chosen", which select2 hides
                // behind the placeholder and so cannot be reached from the dropdown. An
                // address without a layout is not a state this offers reaching.
                if (!value) return;

                address.layoutConfiguration = value;

                // An address is added before it is told what it is, so the room named
                // after its layout is added at the moment that question is answered rather
                // than at the moment the address appeared. See seedRoomForLayout: it fires
                // once, on an address that is still nothing but the Null room it was
                // created with.
                const seeded = seedRoomForLayout(model, index, roomTypePresets);
                (seeded ? onRebuild : onChange)?.();
            },
        });

        row.appendChild(removeButton(model, index, address, state, { onRebuild, canEdit }));

        row.appendChild(el('input', {
            type: 'color',
            value: toHex(address.colour),
            title: 'Colour shown in the editor, and stored in the floor',
            ...unless(canEdit),
            oninput: (event) => {
                Object.assign(address.colour, fromHex(event.target.value));
                onChange?.();
            },
        }));

        row.appendChild(variationControls(model, index, address, state, { onRebuild, canEdit }));
    });

    // After the rows, so a control belonging to an address this render did not build --
    // one that has just been removed -- is destroyed rather than left holding the column
    // it was in. See keptSelects.js.
    addressSelects.sweep();

    container.appendChild(el('button', {
        type: 'button',
        class: 'add-entry secondary',
        text: 'Add address',
        ...unless(canEdit),
        onclick: () => {
            // No colour: an address takes its slot's from the palette. See addAddress.
            state.addressIndex = addAddress(model, 'Outside');
            // The Null room it arrives with, which is the only one it has until its
            // layout is chosen -- Outside is not the name of any room preset.
            state.roomIndex = 0;
            seedRoomForLayout(model, state.addressIndex, roomTypePresets);
            onRebuild?.();
        },
    }));
}

/**
 * Take this address off the floor, and everything painted with it.
 *
 * Beside the layout dropdown rather than among the variation buttons, because the two
 * sit a level apart: those add and drop one layout of this address, this drops the
 * address and every layout it has. Same shape as them, so it reads as the same kind of
 * control, and only the one -- an address is added by the button under the list.
 *
 * A confirm stands in the way only when there is something to lose. An address holding
 * squares hands them back to Outside on the way out, which is a large edit and one
 * nothing here can undo; an address holding none is a row and nothing else.
 *
 * Outside itself is greyed out rather than left off, so the reason is on the button
 * instead of being a gap the author has to explain to themselves. It is where every
 * unclaimed square lands, so the floor cannot be without one.
 */
function removeButton(model, index, address, state, { onRebuild, canEdit = true }) {
    const isOutside = index === outsideAddressIndex(model);

    return el('button', {
        type: 'button',
        class: 'address-remove',
        text: '✕',
        title: isOutside
            ? 'The Outside address cannot be removed'
            : 'Remove this address, and give its squares back to Outside',
        ...unless(canEdit && !isOutside),
        onclick: () => {
            const held = nodesOfAddress(model, index).length;
            const name = address.layoutConfiguration || 'unnamed';

            if (held && !confirm(`Delete address ${index} (${name})? `
                + `${held} painted square(s) go back to Outside.`)) return;

            const wasSelected = state.addressIndex === index;
            if (!removeAddress(model, index)) return;

            // Every slot above this one has shifted down, the painting selection with
            // it. The row that was selected is gone, so that selection lands on Outside
            // -- and on its first room, since the rooms below the list are this
            // address's and a slot in the last one names nothing here.
            if (wasSelected) {
                state.addressIndex = outsideAddressIndex(model);
                state.roomIndex = 0;
            } else if (state.addressIndex > index) {
                state.addressIndex--;
            }

            onRebuild?.();
        },
    });
}

/**
 * Which layout of an address is on show, and the controls for having more of them.
 *
 * The dropdown stays usable with no mod selected. It changes which of an address's
 * layouts is drawn and nothing about what the floor holds -- so it is how you look at
 * the other 116 base game addresses that have more than one, and a viewer that could not
 * do that would be showing a fraction of the floor it claims to show.
 */
function variationControls(model, index, address, state, { onRebuild, canEdit = true }) {
    const wrapper = el('span', { class: 'variations' });

    // A layout holds its own rooms, so the list under this one is replaced wholesale by
    // every button here. A room slot from the layout being left names a different room
    // in the one arriving, or none at all.
    const changed = () => {
        if (state.addressIndex === index) state.roomIndex = 0;
        onRebuild?.();
    };

    if (address.variations.length === 0) {
        // Six base game addresses are in this state. It is representable rather than
        // prevented, so say so plainly rather than showing an empty dropdown.
        wrapper.appendChild(el('span', { class: 'variation-none', text: 'no layouts' }));
    } else {
        const select = el('select', {
            title: 'Which of this address’s layouts is being edited',
            onchange: (event) => {
                selectVariation(model, index, Number(event.target.value));
                changed();
            },
        });

        address.variations.forEach((_, variationIndex) => {
            select.appendChild(el('option', {
                value: String(variationIndex),
                text: `Layout ${variationIndex + 1} of ${address.variations.length}`,
            }));
        });

        select.value = String(address.selectedVariation);
        wrapper.appendChild(select);
    }

    wrapper.appendChild(el('button', {
        type: 'button', text: '+', title: 'Add an empty layout',
        ...unless(canEdit),
        onclick: () => { addVariation(model, index); changed(); },
    }));
    wrapper.appendChild(el('button', {
        type: 'button', text: '⧉', title: 'Duplicate the layout on show',
        ...unless(canEdit),
        onclick: () => { duplicateVariation(model, index); changed(); },
    }));
    wrapper.appendChild(el('button', {
        type: 'button', text: '−', title: 'Remove the layout on show',
        ...unless(canEdit),
        onclick: () => {
            if (address.selectedVariation < 0) return;
            removeVariation(model, index, address.selectedVariation);
            changed();
        },
    }));

    return wrapper;
}


/* -------------------------------------------------------------------------- */
/* The floor                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Where the open floor sits in its building, and how to get to the rest.
 *
 * Everything here is navigation: nothing it draws changes the floor. Which is why it
 * works with no mod selected, and why the buttons are plain arrows rather than anything
 * that could be mistaken for a tool.
 *
 * Up and down move a storey at a time, not a slot at a time. A storey holds several
 * blueprints when a building has alternative layouts for it, and the select below is how
 * those are reached -- stepping through them with the arrows would walk sideways and
 * call it climbing.
 *
 * @param floor {building, blueprint, storeys, storeyIndex, slot} from the flow, or null
 *              when nothing is open
 * @param onOpen called with the slot to open
 */
export function renderFloorPanel(container, floor, { onOpen, onGenerateMesh, onMeshRoof } = {}) {
    clear(container);

    if (!floor?.blueprint) {
        container.appendChild(el('p', { class: 'tool-hint', text: 'No floor open.' }));
        return;
    }

    const { storeys = [], storeyIndex = -1 } = floor;
    const storey = storeys[storeyIndex] ?? null;

    // Both arrows are dead while a floor asked for from here is still arriving. Until it
    // does, everything this panel was drawn from is the floor being replaced -- including
    // the index `step` counts from, which is why a second press stepped from the same
    // place as the first. See `opening` in ui.js.
    const ready = !floor.opening;

    // A floor reached without its building -- one no building refers to -- has nowhere
    // to go up or down to, and neither has one whose slot the building no longer has.
    // The name is still worth showing: it is what says which of the mod's files is being
    // edited.
    const step = (delta) => {
        const next = storey && storeys[storeyIndex + delta];
        if (next) onOpen?.(next.options[0]);
    };

    container.appendChild(el('div', { class: 'floor-steps' }, [
        el('button', {
            type: 'button', class: 'secondary', text: '▲',
            title: 'Open the floor above',
            ...unless(ready && !!storey && !!storeys[storeyIndex + 1]),
            onclick: () => step(1),
        }),
        el('span', {
            class: 'floor-storey',
            text: storey?.label ?? (floor.building ? 'Not in this building' : 'No building'),
        }),
        el('button', {
            type: 'button', class: 'secondary', text: '▼',
            title: 'Open the floor below',
            ...unless(ready && !!storey && storeyIndex > 0),
            onclick: () => step(-1),
        }),
    ]));

    container.appendChild(el('p', {
        class: 'floor-name',
        title: floor.building ? `${floor.blueprint} in ${floor.building}` : floor.blueprint,
        text: floor.blueprint,
    }));

    if (storey) container.appendChild(layoutSelect(storey, floor.slot, onOpen));
    if (floor.mesh) container.appendChild(meshSection(floor.mesh, onGenerateMesh, onMeshRoof));
}

/**
 * Generating the building's model, and whether the one it has still describes its floors.
 *
 * In the Floor section rather than beside the building in the Browse menu, because it is
 * about the building the open floor belongs to and reads as one more thing about where
 * you are. Browse is a list of things to open, and a slow action that writes seven files
 * does not belong on a row whose other buttons are open and delete.
 *
 * The staleness line is the reason this is worth a permanent place rather than a menu
 * item: window data is written once, from the floors the building named at that moment,
 * and every edit made afterwards silently pulls it out of step. It is the one thing here
 * you would not otherwise think to check.
 */
function meshSection(mesh, onGenerate, onRoof) {
    const notes = [];
    if (mesh.stale) notes.push('Built from floors that have changed since — generate again.');
    if (mesh.status) notes.push(mesh.status);

    return el('div', { class: 'floor-mesh' }, [
        el('button', {
            type: 'button',
            class: 'secondary',
            text: mesh.busy ? 'Generating…' : 'Generate mesh',
            title: mesh.canGenerate
                ? 'Build the model, textures and window data the game draws this building from'
                : 'Needs a mod folder and a building to generate for',
            ...unless(mesh.canGenerate && !mesh.busy),
            onclick: () => onGenerate?.(),
        }),
        roofToggle(mesh, onRoof),
        notes.length
            ? el('small', { class: mesh.stale ? 'mesh-note stale' : 'mesh-note', text: notes.join(' ') })
            : null,
    ]);
}

/**
 * Whether the next generation puts a top on the model.
 *
 * Ticked for the ordinary building, which is the one nothing is stacked on. Untick it for
 * one that carries another floor above it: what would be its roof is that floor's
 * underside, and two surfaces in the same place shimmer against each other as the camera
 * moves past.
 *
 * It reads off the preset the last generation wrote, so a building that was built without
 * a roof comes back unticked -- otherwise every edit to one of its floors would quietly
 * put the roof back the next time the mesh was regenerated.
 */
function roofToggle(mesh, onRoof) {
    return el('label', { class: 'mesh-roof', title: mesh.canGenerate
        ? 'Cap the top of the model. Untick it when another floor sits above this building.'
        : 'Needs a mod folder and a building to generate for' }, [
        el('input', {
            type: 'checkbox',
            checked: mesh.roof ? 'checked' : null,
            ...unless(mesh.canGenerate && !mesh.busy),
            onchange: (event) => onRoof?.(event.target.checked),
        }),
        el('span', { text: 'Roof' }),
    ]);
}

/**
 * The layouts of the storey on show.
 *
 * Shown even when there is only one, and disabled: "1 of 1" is the answer to "does this
 * floor have alternatives", and a control that appears only sometimes makes the reader
 * work out whether it is missing or absent.
 */
function layoutSelect(storey, slot, onOpen) {
    const select = el('select', {
        title: 'Which layout of this floor the building may pick',
        ...unless(storey.options.length > 1),
        onchange: (event) => onOpen?.(storey.options[Number(event.target.value)]),
    });

    storey.options.forEach((option, index) => {
        select.appendChild(el('option', {
            value: String(index),
            // The blueprint's name, because within one storey the slot labels differ by
            // a v-number that says nothing about which floor it is.
            text: `${option.slot.isControlVariant ? 'Control: ' : ''}${option.blueprint}`,
        }));
    });

    const current = storey.options.findIndex((option) => sameSlot(option.slot, slot));
    if (current >= 0) select.value = String(current);

    return field('Layout', select);
}


/* -------------------------------------------------------------------------- */
/* Rooms                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The rooms of the address being painted with.
 *
 * A room is chosen by the slot it sits in rather than by what it is called. Both of the
 * things that name one can be shared -- 24 rooms across 13 base game floors have the
 * same preset *and* the same id as another room in the same address -- so the list can
 * legitimately show two rows that read identically. They are different rooms, the floor
 * treats them as such, and which of them is selected is never in doubt.
 *
 * The id is shown and not offered. It is the game's own field and a floor is read and
 * written with whatever ids it arrived carrying, but nothing is served by typing one:
 * a room made here takes an id no other room in the floor is using, and one already in
 * a file has no better value than the one it has. Seeing it is still worth something --
 * it is what a floor's own JSON calls this room.
 */
export function renderRoomPanel(
    container, model, state, { onChange, onRebuild, canEdit = true } = {},
) {
    // Before the clear, which detaches every control in this list. See closeAll.
    roomSelects.closeAll();

    clear(container);
    if (!model) return;

    const { roomTypePresets } = refs();
    const sections = nameSections('RoomTypePreset', roomTypePresets);
    const rooms = roomsOfAddress(model, state.addressIndex);

    const list = el('div', { class: 'room-list' });

    // Before the rows, for the reason renderAddressPanel appends its list early.
    container.appendChild(list);

    for (const room of rooms) {
        const selected = state.roomIndex === room.roomIndex;

        const row = el('div', {
            class: selected ? 'room-row selected' : 'room-row',
            'data-room': `${room.preset}#${room.id}`,
            'data-room-index': String(room.roomIndex),
        });
        list.appendChild(row);

        row.appendChild(el('input', {
            type: 'radio',
            name: 'painting-room',
            ...(selected ? { checked: 'checked' } : {}),
            onchange: () => { state.roomIndex = room.roomIndex; onChange?.(); },
        }));

        // Keyed by slot rather than by what the room is called, for the same reason the
        // radio beside it is: two rooms of one address can share a preset and an id.
        roomSelects.acquire(room.roomIndex, row, {
            ...nameSelectSpec(sections, room.preset, {
                placeholder: 'Room preset',
                className: 'name-select room-select',
                title: 'Which room type preset this room is',
                canEdit,
            }),

            onPick: (value) => {
                if (!value) return;

                room.preset = value;
                onRebuild?.();
            },
        });

        row.appendChild(el('span', {
            class: 'room-id',
            text: `#${room.id}`,
            title: 'The id the game stores for this room. Generated, and unused by any '
                + 'other room in this floor.',
        }));

        row.appendChild(el('button', {
            type: 'button',
            class: 'room-remove',
            text: '−',
            title: 'Remove this room. Anything painted into it goes to the address’s '
                + 'Null room.',
            ...unless(canEdit),
            onclick: () => {
                if (!removeRoom(model, state.addressIndex, room.roomIndex)) return;
                state.roomIndex = afterRemoving(model, state, room.roomIndex);
                onRebuild?.();
            },
        }));

    }

    roomSelects.sweep();

    if (rooms.length === 0) {
        list.appendChild(el('p', { class: 'empty', text: 'This address has no rooms yet.' }));
    }

    container.appendChild(el('button', {
        type: 'button',
        class: 'add-entry secondary',
        text: 'Add room',
        ...unless(canEdit),
        onclick: () => {
            const room = addRoom(model, state.addressIndex, roomTypePresets[0] ?? 'Null');
            if (room) state.roomIndex = room.roomIndex;
            onRebuild?.();
        },
    }));
}

/**
 * Which row is selected once one has gone.
 *
 * Rooms are slots, so removing one renumbers every slot above it and a selection kept as
 * a number would slide onto the room below without being touched. The row that was
 * selected stays selected wherever it has moved to; removing the selected row itself
 * lands on the one that took its place, or on the last one left when it was the last.
 */
function afterRemoving(model, state, removed) {
    const remaining = roomsOfAddress(model, state.addressIndex).length;
    if (remaining === 0) return -1;

    if (state.roomIndex < removed) return state.roomIndex;
    if (state.roomIndex > removed) return state.roomIndex - 1;
    return Math.min(removed, remaining - 1);
}


/* -------------------------------------------------------------------------- */
/* Walls                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Which wall preset the wall tool paints.
 *
 * Grouped by what each preset is -- wall, window, door or blank -- because 27 names in
 * one list is unreadable and the kind is what an author is choosing between first. The
 * kinds come from a hand-written table with three unverified entries; see
 * refs/README.md. Getting one wrong shows the wrong shape, not a corrupt floor.
 *
 * Searchable, like the two name pickers above it, and with no mod half to offer: a wall
 * is stored as the string form of an index into the game's own table, so there is no
 * index for an asset a mod adds and nothing for this to list.
 */
export function renderWallPanel(container, state, { onChange } = {}) {
    // Before the clear, which detaches the control. See closeAll.
    wallSelects.closeAll();

    clear(container);

    const { wallPresets } = refs();
    const groups = [];

    for (const kind of ['wall', 'window', 'door', 'blank']) {
        const inKind = wallPresets.filter(
            (preset) => preset.kind === kind && !isDividerEnd(preset.id));
        if (inKind.length === 0 && kind !== DIVIDER_END_KIND) continue;

        const options = inKind.map((preset) => ({ value: preset.id, text: preset.name }));

        // The two ends stand in the list as one piece, because which of them a wall gets
        // is the editor's answer rather than the author's -- see dividerEnds.js. Offered
        // among the blanks, which is what the kinds table calls both of them.
        if (kind === DIVIDER_END_KIND) {
            options.push({ value: DIVIDER_END, text: DIVIDER_END_NAME });
        }

        groups.push({ label: `${kind[0].toUpperCase()}${kind.slice(1)}s`, options });
    }

    // A floor may name an id this list has no name for -- 28 to 30 exist in the
    // reference tool's table and name nothing the game has. Shown rather than silently
    // replaced, because replacing it would rewrite a wall nobody asked to change.
    const unnamed = state.wallPreset !== DIVIDER_END
        && !wallPresets.some((preset) => preset.id === state.wallPreset)
        ? state.wallPreset
        : null;

    const parent = dropdownParent();

    // The same labelled row the tile setting below it uses: both are a setting of a
    // tool, and a bare full-width select read as something else entirely. Built and
    // appended before the control goes in it, so the control is in the document by the
    // time select2 measures it.
    const label = field('Wall tool paints', null);
    container.appendChild(label);

    // Kept across the redraw for the same reason the row controls are, and there is no
    // second one: `wallPresets` is a fixed table, so the only things that can force a
    // rebuild are the flow's markup being replaced and the floor naming an id off it.
    wallSelects.acquire('wall', label, {
        class: 'name-select wall-preset',
        signature: [wallPresets, parent, unnamed],

        parent,
        groups,
        options: unnamed ? [{ value: unnamed, text: `Unnamed preset ${unnamed}` }] : [],
        value: state.wallPreset,
        placeholder: 'Wall preset',
        dropdownClass: 'name-select-dropdown',
        alignRight: true,

        onPick: (value) => {
            if (!value) return;

            state.wallPreset = value;
            onChange?.();
        },
    });

    wallSelects.sweep();
}


/* -------------------------------------------------------------------------- */
/* The floor type setting                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What each of the five types is, in the terms the view draws them in.
 *
 * The enum names are the game's and they are the ones shown, because the status column
 * and the label over the canvas already say them and three names for one thing is two too
 * many. But "noneButIndoors" is not self-explanatory to anyone who has not read the
 * game's code, so the chosen one is spelled out underneath -- including how it is drawn,
 * which is the other half of learning to read the floor.
 *
 * Keyed by the enum's index, like the colours in scene.js. A type outside this list gets
 * no line rather than a wrong one.
 */
const FLOOR_TYPE_NOTES = [
    'Nothing here at all. Drawn see-through, with nothing over it.',
    'An ordinary indoor square. Drawn solid, with a ceiling over it.',
    'A rooftop or a yard: something to stand on, open to the sky. Drawn solid, '
        + 'with nothing over it.',
    'Overhead only, with nothing to stand on. Drawn see-through, with a ceiling over it.',
    'Inside, but with nothing to stand on and nothing overhead. Drawn see-through, like '
        + '“none” — the difference is where the game counts the square as being, not what '
        + 'is there.',
];

/**
 * Which floor type the floor type tool paints, and how far it raises what it paints.
 *
 * Both, because the tool writes both: setNodeFloor takes a type and a height together,
 * and ctrl+click picks both off a cell for the same reason. A panel offering only the
 * type would leave the height at whatever was last picked up, so every square painted
 * after picking a raised one would come out raised too -- and the reference tool's own
 * note about this is that picking a type without its height paints at the wrong level.
 *
 * The height is a bare number because that is what it is. `f_h` is read against the
 * floor's own `defaultCeilingHeight`, and the base game's non-zero values run 7 to 51 on
 * floors whose ceilings are 42 and 52 -- so it is not a count of steps and there is no
 * list of them to offer. What it does to the view is in the hint below it.
 */
export function renderFloorTypePanel(container, state, { onChange } = {}) {
    clear(container);

    const { floorTileTypes } = refs();

    const type = el('select', {
        class: 'floor-type',
        onchange: (event) => { state.floorType = Number(event.target.value); onChange?.(); },
    });

    floorTileTypes.forEach((name, index) => {
        type.appendChild(el('option', { value: String(index), text: name }));
    });

    // A floor can carry a type this list has no name for -- the enum is positional, and a
    // game update that adds one leaves the generated data behind. Shown as its number so
    // it can be seen and painted back, rather than silently becoming something else.
    if (!floorTileTypes[state.floorType]) {
        type.insertBefore(
            el('option', { value: String(state.floorType), text: `Type ${state.floorType}` }),
            type.firstChild);
    }

    type.value = String(state.floorType);
    container.appendChild(field('Floor tool paints', type));

    const height = el('input', {
        type: 'number',
        step: '1',
        class: 'floor-height',
        value: String(state.extraHeight ?? 0),
        title: 'How far the square is raised, in the floor’s own units — the same number '
            + 'the file stores. Read against the floor’s ceiling height.',

        // On change rather than on input: every one of these redraws the panel it is in,
        // which would take the field out from under the caret on each keystroke. So the
        // value is taken when it is committed -- blur, Enter, or a press of the spinner.
        //
        // A committed value that is not a whole number is put back rather than written.
        // The empty string is tested for rather than left to Number, which makes it 0 --
        // and 0 is a height, so accepting it would turn clearing the box into painting at
        // floor level. A number input is empty for anything it cannot parse as well, so
        // that one test covers both a cleared field and typed nonsense.
        onchange: (event) => {
            const raw = event.target.value.trim();
            const value = Number(raw);

            if (raw === '' || !Number.isInteger(value)) {
                event.target.value = String(state.extraHeight ?? 0);
                return;
            }

            state.extraHeight = value;
            onChange?.();
        },
    });

    container.appendChild(field('Raised by', height));

    const note = FLOOR_TYPE_NOTES[state.floorType];
    if (note) container.appendChild(el('p', { class: 'tool-hint', text: note }));
}


/* -------------------------------------------------------------------------- */
/* The status column                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What a click would paint, and what is already under the pointer.
 *
 * Both halves list all five types in the same order, because the value of having them at
 * all is the comparison: a floor is painted by looking at what is there and deciding
 * whether it should be something else, and until now that meant reading one thing off
 * the tool panels and the other off a label over the canvas.
 *
 * Every type is listed whichever tool is active, not just the active one's. Switching
 * tool to find out what a cell's floor type is, and thereby changing what the next click
 * would do, is the trap this exists to remove. The active tool's row is marked instead.
 *
 * Read-only throughout. Everything on the left is set on the right.
 */
export function renderStatusPanel(container, model, state, hovered = null) {
    // The checker's control is kept across this redraw the same way the pickers are, and
    // is detached by the clear below just as they are. Open *and* detached is the state
    // that must not happen: select2 unbinds the scroll handler it holds on every
    // scrollable ancestor by walking them again at close, so a control closed out of the
    // document never unbinds and the left column stops scrolling for the life of the
    // page. See closeAll in keptSelects.js and `close` in searchSelect.js.
    //
    // Shutting it was how that used to be avoided, and it cost the author their list. The
    // window is wide and it is not only the pointer: the column is redrawn on every move
    // that crosses a square, and again by work that lands long after the floor opened --
    // `loadFurnitureChain` in openFloor is deferred precisely so the floor appears first,
    // so its redraw arrives whenever the fetch and the mod read happen to finish. Asking
    // about a preset while one was in flight lost the dropdown mid-question.
    //
    // So an open list is parked on the column instead of being shut. That is out of the
    // way of the clear and still in the document, which is all the unbind walk needs --
    // `#building-status` is a plain child of `#building-left`, so the scrollable ancestor
    // it was opened against is the one it is parked in. `settleChecker` below puts the
    // question beyond doubt: either the redraw took the box back, or it is shut where it
    // stands rather than left hanging off the column.
    // Only where there is somewhere to park it. A container already out of the document is
    // not a column anything is being read off, and shutting the list is what this did before.
    const held = checker?.control.isOpen() && container.parentElement ? checker : null;
    if (held) container.parentElement.appendChild(held.box);
    else checker?.control.close();

    clear(container);

    if (!model) {
        container.appendChild(el('p', { class: 'empty', text: 'No floor open.' }));
        settleChecker(held, container);
        return;
    }

    // Above the selection because it is not about the selection: these hold whatever
    // square is picked, and the block is absent unless there is something to say.
    const problems = modProblemsBlock();
    if (problems) container.appendChild(problems);

    // In none a click reads rather than writes, so the top block is the square that was
    // read: same five rows, and they are what a click took rather than what one would
    // put down. Calling it "Painting with" there was the caption's job to apologise for.
    const selecting = state.mode === PaintMode.NONE;
    const selected = selecting ? state.selectedNode : null;

    const first = selecting
        ? statusBlock(
            'Selected square',
            selected ? `Node ${selected.x}, ${selected.y}` : 'Click a square to select it',
            selectedValues(model, state),
            state.tool)
        : statusBlock(
            'Painting with',
            MODE_CAPTIONS[state.mode] ?? null,
            paintingValues(model, state),
            state.tool);

    for (const note of nodeNotes(model, selected)) {
        first.appendChild(el('p', { class: 'note status-note', text: note }));
    }

    // Only ever under the selection. What could spawn on a square is read while deciding
    // what that square should be, which is not something to lose by moving the pointer
    // to reach the panel -- and a forty-row list rebuilt on every pointer move is the
    // one thing in this column that could not follow a hover comfortably.
    appendFurniture(first, model, selected);

    container.appendChild(first);

    const under = statusBlock(
        'Under the pointer',
        hovered ? hoveredCaption(hovered) : 'Move the pointer over the floor',
        hoveredValues(model, hovered),
        state.tool);

    for (const note of nodeNotes(model, hovered?.kind === 'cell' ? hovered : null)) {
        under.appendChild(el('p', { class: 'note status-note', text: note }));
    }

    container.appendChild(under);

    settleChecker(held, container);
}

/**
 * Account for a checker whose list was parked through the redraw.
 *
 * Two ways it can end. The redraw had a square to answer for, `appendFurniture` asked for
 * the checker again, and moving it into the new section took it off the column -- there is
 * nothing to do, and the list the author is reading never flickered.
 *
 * Or the redraw had nothing to put it in: no floor, no selection, or the furniture chain
 * has not arrived. Then the list is answering for a square that is no longer shown, so it
 * is shut -- while it is still on the column, because closing it after taking it off is
 * the detached close the parking exists to avoid.
 *
 * Safe to call for a control `furnitureChecker` replaced meanwhile: that path closes and
 * destroys the old one itself, and both calls below tolerate having already happened.
 */
function settleChecker(held, container) {
    if (!held || container.contains(held.box)) return;

    held.control.close();
    held.box.remove();
}

/*
 * There used to be a `restoreTyping` here, saving and replacing the caret in the checker's
 * field around this redraw. The checker's control is now kept across redraws rather than
 * rebuilt -- see `furnitureChecker` -- so there is no longer a field to take out from
 * under the caret, and what someone is typing lives in the dropdown, which is parented
 * outside this column and never cleared.
 */


/* -------------------------------------------------------------------------- */
/* What could spawn here                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Where the answers came from, when some of them came from the mod.
 *
 * Silent when the mod adds nothing to the chain, which is the ordinary case and needs no
 * line. Said when it does, because an answer that counts a mod's own cluster is a
 * different claim from one that does not, and which of the two you are reading is not
 * otherwise visible.
 *
 * The unlisted count is the more useful half. A `.sodso.json` is loaded because the mod's
 * manifest names it in `fileOrder`, not because it is in the folder -- so a file that is
 * not listed is one the game never reads, which shows up in play as content simply
 * missing and nothing anywhere saying why.
 *
 * A patch this tool could not read is **not** reported here. It is in `modProblemsBlock`
 * with the rest of what is true of the mod rather than of a square -- see the note there.
 */
function appendModSources(section) {
    const { applied = [], unlisted = [] } = modFurniture?.() ?? {};

    if (applied.length > 0) {
        const patched = applied.filter((asset) => asset.patch).length;
        const added = applied.length - patched;

        const parts = [];
        if (added > 0) parts.push(`${added} added`);
        if (patched > 0) parts.push(`${patched} patched`);

        section.appendChild(el('p', {
            class: 'status-note furniture-source',
            text: `Including this mod's own assets: ${parts.join(', ')}.`,
        }));
    }

    if (unlisted.length > 0) {
        const one = unlisted.length === 1;

        section.appendChild(el('p', {
            class: 'status-note furniture-unlisted',
            text: `${unlisted.length} file${one ? '' : 's'} in this mod ${one ? 'is' : 'are'} not `
                + 'named in murdermanifest.sodso.json, so the game never loads '
                + `${one ? 'it' : 'them'} and nothing below counts ${one ? 'it' : 'them'}.`,
        }));
    }

}

/**
 * Problems in the mod's own assets, or null when there are none.
 *
 * Its own block rather than a note inside the furniture section, and the difference
 * matters: the furniture section returns early when no square is selected
 * (`appendFurniture`), so a cluster that can never place would stay invisible until the
 * reader happened to click the right cell. These are true of the mod rather than of a
 * square, and a warning only seen by accident is one that gets missed.
 *
 * First in the column for the same reason, and absent entirely when the list is empty --
 * which is every page with no mod selected, and most pages with one. It costs the
 * selection block its top slot only when there is something wrong.
 *
 * An override this tool could not read belongs here for exactly that reason, and it is
 * the most important thing the block ever says. Every other warning here means the
 * answers below are right and something in the mod is wrong; this one means the answers
 * below are **missing a file the game will load** -- so a patch of a shipped cluster is
 * silently absent from every list, and the shipped values are what the walk answered
 * against. A reader who has to click the right square first would never learn that.
 */
function modProblemsBlock() {
    const warnings = clusterWarnings(furnitureChain());
    const { unresolved = [] } = modFurniture?.() ?? {};

    if (warnings.length === 0 && unresolved.length === 0) return null;

    const count = warnings.length + unresolved.length;
    const one = count === 1;

    // Deliberately **not** a `.status-block`. The two blocks under it are "the same five
    // rows in the same order", and both the panel tests and the flow tests read them
    // positionally -- `[0]` the selection, `[1]` the pointer. A third block sharing the
    // class would silently shift that index the moment a mod had a problem, which is the
    // one time the tests most need to still mean what they say. This is a different kind
    // of thing anyway: prose about the mod rather than a reading of a square.
    const section = el('section', { class: 'mod-problems' });

    section.appendChild(el('header', {}, [
        el('strong', { text: one ? 'A problem in this mod' : `${count} problems in this mod` }),
    ]));

    section.appendChild(el('p', {
        class: 'status-note',
        text: `Found by reading this mod's own assets, so ${one ? 'it is' : 'they are'} true `
            + 'wherever you click. None of these is reported by the game at run time.',
    }));

    // First, and marked as blocking: an override that was not read is a hole in every
    // answer below it, which outranks anything that is merely wrong in the mod itself.
    for (const patch of unresolved) {
        section.appendChild(el('p', {
            class: 'status-note mod-problem blocks',
            text: `${patch.path} overrides ${patch.type}/${patch.name} and could not be read, `
                + `because ${patch.reason}. The game still loads it, so what it changes is `
                + 'missing from every answer here and the base game\'s values were used instead.',
        }));
    }

    for (const warning of warnings) {
        section.appendChild(el('p', {
            class: `status-note mod-problem ${warning.severity}`,
            text: warning.text,
        }));
    }

    return section;
}

/**
 * Where the panel asks what the mod contributed. Injected rather than imported, because
 * that is the flow's state and this file is handed everything else it draws.
 */
let modFurniture = null;

/** Told once, by the flow, when it mounts. */
export function setModFurnitureSource(source) {
    modFurniture = source;
}

/**
 * Which furniture groups are open, kept outside the render.
 *
 * The status column is redrawn in full on every pointer move, so a `<details>` element's
 * own open state would close again the moment the pointer shifted by a cell. Held by
 * address preset name rather than by node, because the question an open group answers --
 * "what does HighriseOffice put in a room like this" -- is one being asked of the floor
 * rather than of the one square that happened to be under the pointer when it was opened.
 *
 * Module state rather than tool state: nothing about it is saved, painted or exported.
 */
const openFurniture = new Set();

/**
 * The furniture section, which is absent until the chain data has been fetched.
 *
 * Absent rather than empty on purpose. Every other line in this column is read off the
 * floor and is always available; a heading that appears with nothing under it would say
 * the square has no furniture, which is a different claim from not yet knowing.
 *
 * `at` is the selected square, or null when nothing is selected. Selection rather than
 * hover, so a list can be read and scrolled without the pointer leaving it having to
 * mean anything.
 */
function appendFurniture(section, model, at) {
    if (!at) return;

    const chain = furnitureChain();
    if (!chain) return;

    const result = furnitureAt(chain, model, at.x, at.y);
    if (!result) return;

    section.appendChild(el('header', { class: 'furniture-header' }, [
        el('strong', { text: 'Furniture' }),
    ]));

    appendModSources(section);

    if (result.reason) {
        section.appendChild(el('p', { class: 'status-note', text: result.reason }));
        return;
    }

    // The count is of address presets rather than of furniture, because that is the
    // thing a reader has to understand before the numbers below mean anything: a
    // blueprint names a layout, and which preset claims the unit is decided when the
    // city is built. One is the ordinary case and says so plainly.
    //
    // The wall count is here because it is the one thing on this line that is about the
    // *square* rather than the room, and it is why two squares of one room give
    // different lists -- see the note on wallsAround.
    const where = `${result.roomType}, ${result.roomSize} nodes, ${wallCount(result.walls)}`;

    section.appendChild(el('p', {
        class: 'status-note',
        text: result.groups.length === 1
            ? `${where} — one address type uses this layout`
            : `${where} — ${result.groups.length} address types compete for this unit, `
                + 'and each furnishes it differently',
    }));

    for (const group of result.groups) section.appendChild(furnitureGroup(group));

    section.appendChild(el('p', {
        class: 'status-note furniture-caveat',
        text: `Could spawn, not will: ${UNAPPLIED_GATES.join(', ')} are decided when the `
            + 'city is built and are not filtered on here.',
    }));

    section.appendChild(furnitureChecker(model, at));
}


/* -------------------------------------------------------------------------- */
/* Why not this one                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which preset the checker is asking about, kept outside the render for the same reason
 * the open groups are: the column is rebuilt whenever the pointer moves.
 */
let checkedPreset = '';

/**
 * The square the checker is currently answering for.
 *
 * The control outlives any one redraw -- see `furnitureChecker` -- so its change handler
 * cannot close over the square it was built for, which would be whichever one happened to
 * be selected when the reference data arrived.
 */
let checkerTarget = { model: null, at: null };

/**
 * The control, kept across redraws.
 *
 * Rebuilt only when the list it offers changes. The status column is redrawn on every
 * pointer move; building a select over 310 names and handing it to select2 that often
 * would be the same cost the furniture rows are built lazily to avoid, and it would take
 * an open dropdown away at the first twitch that crossed a square. Re-appending an element
 * that already exists moves it; it does not rebuild it.
 */
let checker = null;

/**
 * Ask why a particular preset is not in the list above.
 *
 * The list answers "what could go here", which is the question with no starting point.
 * This answers "why not *that*", which is the one an author has after picking a model in
 * the game and finding it never appears -- and it is the harder question, because the
 * answer is an absence.
 *
 * Read straight off `explainFurniture`, which is the same walk the list is derived from.
 * A preset it calls possible is one the list contains, necessarily rather than by
 * agreement -- see the note on `checkFurniture`.
 */
function furnitureChecker(model, at) {
    // Identity, not contents: `furniturePresetSections` hands back the same object for the
    // same data, so this is false exactly when a mod has been selected, changed or dropped.
    const sections = furniturePresetSections(furnitureChain());

    // And the parent, because switching flows replaces this flow's markup: a control kept
    // across the switch holds a `dropdownParent` that has left the document, and opens
    // into a box that is no longer on the page.
    const parent = dropdownParent();

    if (checker?.sections !== sections || checker?.parent !== parent) {
        // Shut before destroyed, because select2's destroy does not close on the caller's
        // behalf and the unbind it skips is the one that keeps the left column scrolling
        // -- see `close` in searchSelect.js. Reachable with the list open now that
        // renderStatusPanel parks an open one rather than shutting it: a mod changed
        // while the checker is open replaces the control under it. The box goes too,
        // since the parked one is no longer the clear's to take away.
        checker?.control.close();
        checker?.control.destroy();
        checker?.box.remove();

        checker = buildFurnitureChecker(sections, parent);
    }

    checkerTarget = { model, at };
    renderVerdict(checker.verdict, model, at);

    return checker.box;
}

function buildFurnitureChecker(sections, parent) {
    const box = el('div', { class: 'furniture-check' });
    const select = el('select', { class: 'furniture-check-pick' });

    box.appendChild(el('label', { class: 'field' }, [
        el('span', { text: 'Why not…' }),
        select,
    ]));

    const verdict = el('div', { class: 'furniture-verdict' });
    box.appendChild(verdict);

    const control = searchSelect(select, {
        // Anywhere but this column, which scrolls: a dropdown parented inside it is
        // positioned against a box that moves under it. That is what the `<datalist>`
        // this replaced got wrong -- it opened sideways, or not at all.
        parent,

        // The mod's own first. See furniturePresetSections on which is which, and on why
        // a patched shipped preset counts as the mod's.
        groups: [
            { label: 'Modded', options: sections.modded },
            { label: 'Vanilla', options: sections.vanilla },
        ],

        value: checkedPreset || null,

        // A name the data has never heard of is not a hazard here, it is the point: the
        // walk answers it with a reason like any other, so asking about a preset this
        // reference data does not have is told so rather than silently ignored.
        allowCustom: true,

        placeholder: 'Furniture preset',

        // The dropdown is parented out to the workspace, so it inherits that element's
        // type rather than this column's smaller one. This is what reaches it.
        dropdownClass: 'furniture-check-dropdown',

        // One question asked repeatedly, of one preset at a time, and the control is
        // rebuilt whenever the mod changes or the flow is switched back to. The preset
        // being asked about is usually a family of names rather than a single one.
        memoryKey: 'building:furniture-check',

        onChange: (value) => {
            checkedPreset = value ?? '';
            renderVerdict(verdict, checkerTarget.model, checkerTarget.at);
        },
    });

    return { sections, parent, box, select, verdict, control };
}

/**
 * The answer, one line per address preset competing for the unit.
 *
 * Two states and no third. `No` is sound -- every gate the walk applies is a hard filter,
 * so a preset failing one cannot appear. `Possible` is the strongest thing a blueprint
 * supports, and is worded as such: the gates it cannot answer are named in the caveat
 * above rather than repeated here.
 *
 * Redrawn on its own when the select changes, rather than through the whole column: the
 * column is the flow's to rebuild, and rebuilding it here would take the select out from
 * under the pointer that was still on it.
 */
function renderVerdict(container, model, at) {
    clear(container);

    const chain = furnitureChain();
    if (!at || !checkedPreset.trim()) return;

    // The canonical name, whatever case it was reached by. Picking from the list gives an
    // exact one; typing a name the data does not have gives null, and the walk is asked
    // about what was typed so that it can say so.
    //
    // There is no half-typed state to guard against any more. The field is a select now,
    // so every value it reports is one somebody settled on -- a chosen option, or a name
    // they finished typing -- rather than a keystroke on the way to one.
    const name = findFurniturePreset(chain, checkedPreset);

    const result = explainFurniture(chain, model, at.x, at.y, name ?? checkedPreset.trim());
    if (!result) return;

    // The square answers for every address preset at once -- it is outdoors, or in no
    // room -- so the reason is the square's rather than one verdict repeated.
    if (result.reason) {
        container.appendChild(el('p', { class: 'status-note', text: result.reason }));
        return;
    }

    for (const group of result.groups) {
        const possible = group.verdict === 'possible';

        // The answer and its reason in one element rather than as siblings: they are one
        // verdict, and a reader -- or anything reading the markup -- should not have to
        // pair them up by position.
        const verdict = el('div', { class: 'verdict', 'data-verdict': group.verdict }, [
            el('div', { class: 'verdict-line' }, [
                el('span', { class: 'verdict-address', text: group.address }),
                el('span', {
                    class: possible ? 'verdict-answer possible' : 'verdict-answer no',
                    text: possible ? 'Possible' : 'No',
                }),
            ]),
        ]);

        // The first gate that says no, which is the one to act on: a preset failing
        // several fails the first *because* of which the others are true.
        if (!possible) {
            verdict.appendChild(el('p', { class: 'verdict-reason', text: group.reason }));
        }

        container.appendChild(verdict);
    }
}

/**
 * One address preset's answer, collapsed to a summary line.
 *
 * The summary is the whole chain on one line -- `HighriseOffice → Office / OfficeSpace` --
 * because the room class is what every filter below it actually keys off, and an author
 * looking for why two groups differ is looking for exactly that name.
 */
function furnitureGroup(group) {
    const details = el('details', { class: 'furniture-group' });

    // Filled when opened rather than when built. A closed `<details>` still holds
    // everything inside it -- it only hides it -- and this column is rebuilt on every
    // pointer move, so two collapsed groups would cost a few hundred elements per cell
    // the pointer crosses to show two summary lines.
    details.addEventListener('toggle', () => {
        if (!details.open) { openFurniture.delete(group.address); return; }

        openFurniture.add(group.address);
        fillFurnitureGroup(details, group);
    });

    // The two lines are wrapped rather than laid out as grid cells of the summary,
    // because Pico's disclosure marker is a `summary::after` and a pseudo-element of a
    // grid container is a grid item: it would claim a cell and land under the count.
    details.appendChild(el('summary', {}, [
        el('span', { class: 'furniture-summary' }, [
            el('span', { class: 'furniture-address', text: group.address }),
            el('span', {
                class: 'furniture-config',
                text: `${group.config}${group.forced ? ' (forced)' : ''} / ${group.roomClass}`,
            }),
        ]),
        el('span', {
            class: 'furniture-count',
            text: String(group.count),
            title: `${group.count} furniture presets could fill the slots in this room.`,
        }),
    ]));

    // A group the pointer left open stays open, and is filled here rather than by the
    // toggle event: setting `open` on a detached element does not fire one.
    if (openFurniture.has(group.address)) {
        details.setAttribute('open', 'open');
        fillFurnitureGroup(details, group);
    }

    return details;
}

/** The rows of one group, appended once. */
function fillFurnitureGroup(details, group) {
    if (details.querySelector('.furniture-row, .furniture-empty')) return;

    // A room no cluster furnishes. 22 of the base game's own address-and-room pairs are in
    // this state -- every `Atrium`, and every `Null` room in a real address -- so it is a
    // thing rooms are rather than a sign anything is wrong. Said, because a group that
    // opened onto nothing would read as the panel having failed.
    //
    // The sentence is `unfurnishedReason`'s rather than one of this file's, because it is
    // the same fact the preset check reports and this panel had its own wording for it: one
    // that named the room *filters* whatever had actually stopped the clusters, so a room
    // that was merely too big sent the author to widen a filter that was already wide
    // enough.
    //
    // It answers only for a room no cluster reaches, and null otherwise -- clusters reaching
    // this room and putting down slots the square itself has no use for is the other way to
    // arrive here, and is the room being fine and this square not.
    if (group.classes.length === 0 && group.empty === 0) {
        details.appendChild(el('p', {
            class: 'status-note furniture-empty',
            text: unfurnishedReason(group)
                ?? `Clusters are placeable in ${group.roomClass} rooms, but none of the slots `
                    + 'they put down can be filled here.',
        }));
        return;
    }

    for (const row of group.classes) {
        details.appendChild(el('div', { class: 'furniture-row' }, [
            el('span', { class: 'furniture-class', text: row.name }),
            el('span', { class: 'furniture-presets' }, row.presets.map(presetName)),
        ]));
    }

    // A slot class whose pool is empty here is not furniture and is not listed, but it
    // is why an arrangement that looks applicable may never place: an empty pool on an
    // element marked `importantToCluster` aborts the cluster it is in.
    if (group.empty > 0) {
        details.appendChild(el('p', {
            class: 'status-note furniture-empty',
            text: `${group.empty} more slot ${group.empty === 1 ? 'class has' : 'classes have'} `
                + 'no furniture that fits here.',
        }));
    }

    // The three the square's own walls ruled out, said separately from the above and from
    // each other: they are different reasons, and the fix for each is to select a
    // different square rather than to change anything about the room.
    const { needsWall = 0, needsOpen = 0, wrongWalls = 0 } = group.offWall ?? {};

    if (needsWall > 0) {
        details.appendChild(el('p', {
            class: 'status-note furniture-empty',
            text: `${needsWall} more need a square with more walls than this one has.`,
        }));
    }

    if (needsOpen > 0) {
        details.appendChild(el('p', {
            class: 'status-note furniture-empty',
            text: `${needsOpen} more need a square clear of walls.`,
        }));
    }

    // The count was right and the walls were not -- a doorway where a solid wall was
    // wanted, or a window on the edge a piece hangs from. Which edge is wrong is a
    // question for **Why not…**, which answers it for one named preset; here it would be
    // a paragraph per class.
    if (wrongWalls > 0) {
        details.appendChild(el('p', {
            class: 'status-note furniture-empty',
            text: `${wrongWalls} more need a different kind of wall than this square has.`,
        }));
    }

    // Neither ruled in nor out: `securityDoorDivider` reads the floor's air ducts among
    // other things, and no blueprint answers it. Named rather than counted among the
    // possible, which would be a claim, or among the refused, which would be another.
    if (group.unchecked > 0) {
        details.appendChild(el('p', {
            class: 'status-note furniture-empty',
            text: `${group.unchecked} more carry a wall rule this cannot check.`,
        }));
    }
}

/** How many walls a square has, as the phrase the line above it reads in. */
function wallCount(walls) {
    if (walls === 0) return 'no walls';
    return walls === 1 ? '1 wall' : `${walls} walls`;
}

/**
 * One furniture preset's name, marked if its appearance depends on the room's decor.
 *
 * A preset without `universalDesignStyle` is drawn from the styles it lists, matched
 * against a design style the generator picks for the room -- so it is a weaker claim
 * than the names beside it, and marking it is cheaper than a reader finding out in game.
 */
function presetName(preset) {
    if (preset.universal) return el('span', { class: 'furniture-preset', text: preset.name });

    return el('span', {
        class: 'furniture-preset styled',
        text: preset.name,
        title: 'Only in rooms whose design style this preset lists.',
    });
}

/**
 * What the mode means for the values below it.
 *
 * None is no longer here: its block is headed "Selected square" and says which square,
 * which is the whole of what the caption used to be apologising for. Paint is the plain
 * case and says nothing.
 */
const MODE_CAPTIONS = {
    [PaintMode.FLOOD]: 'A click fills up to the walls with these',
};

/**
 * The two things a node can carry that no row covers.
 *
 * `f_r` is the first. It names a RoomConfiguration on 1,889 nodes across 40 base game
 * floors, and the model carries it through untouched -- but what a doubled value like
 * "Lobby.Lobby" means, and how the game resolves one that disagrees with the room's own
 * preset, are both unknown. It is not editable anywhere for that reason. Saying it is
 * there is how an author finds out it exists at all, so it survived the panel it used to
 * be shown in.
 *
 * Takes a plain `{x, y}` so the selection and the hover can both be described by it. They
 * are the same square as often as not, and two functions saying this would be two places
 * for a third note to be added to only one of.
 */
function nodeNotes(model, at) {
    if (!model || !at) return [];

    const node = nodeAt(model, at.x, at.y);
    if (!node) return [];

    const notes = [];
    if (node.forcedRoom) notes.push(`Forced room: ${node.forcedRoom}`);
    if (node.backfilled) notes.push('Missing from the file; filled in as Outside.');

    return notes;
}

/** One half of the column: a heading, a line about it, and a row per type. */
function statusBlock(title, note, values, activeTool) {
    const section = el('section', { class: 'status-block' });
    section.appendChild(el('header', {}, [el('strong', { text: title })]));
    if (note) section.appendChild(el('p', { class: 'status-note', text: note }));

    for (const [tool, label] of TOOL_LABELS) {
        const value = values[tool];

        const shown = el('span', {
            class: value ? 'status-value' : 'status-value none',
            text: value?.text ?? '—',
        });

        // The address colour, because an address is recognised by it on the floor long
        // before its name is read.
        if (value?.colour) {
            shown.prepend(el('span', {
                class: 'status-swatch',
                style: `background: ${value.colour}`,
            }));
        }

        section.appendChild(el('div', {
            class: tool === activeTool ? 'status-row active' : 'status-row',
            'data-type': tool,
        }, [el('span', { class: 'status-label', text: label }), shown]));
    }

    return section;
}

function paintingValues(model, state) {
    const address = model.addresses[state.addressIndex];

    // An address with no rooms has nothing for the room tool to paint with, and says so
    // rather than naming a room that is not there.
    const room = roomAt(model, state.addressIndex, state.roomIndex);

    return {
        [Tool.ADDRESS]: {
            text: `${state.addressIndex}: ${address?.layoutConfiguration ?? '?'}`,
            colour: address ? toHex(address.colour) : null,
        },
        [Tool.ROOM]: room ? { text: `${room.preset} #${room.id}` } : null,
        [Tool.FLOOR_TYPE]: { text: floorDescription(state.floorType, state.extraHeight) },
        [Tool.WALL]: { text: wallPresetName(state.wallPreset) },
        [Tool.TILE]: { text: TILE_MODE_LABELS[state.tileMode] ?? state.tileMode },
    };
}

/**
 * What is where the pointer is.
 *
 * A hover is over a cell or over a wall, never both, so one of the two fills in the four
 * types a node carries and the other fills in the wall. What the hover is not over is
 * left out rather than guessed at, and shows as a dash.
 */
function hoveredValues(model, hovered) {
    if (!hovered) return {};

    if (hovered.kind === 'wall') {
        const wall = getWall(model, hovered.x, hovered.y, hovered.axis);
        if (!wall) return { [Tool.WALL]: { text: 'None' } };

        return {
            [Tool.WALL]: {
                text: wall.matched
                    ? wallPresetName(wall.preset)
                    : `${wallPresetName(wall.preset)} — sides disagree`,
            },
        };
    }

    const node = nodeAt(model, hovered.x, hovered.y);
    if (!node) return {};

    const address = model.addresses[node.addressIndex];
    const room = roomOfNode(model, node);

    return {
        [Tool.ADDRESS]: {
            text: `${node.addressIndex}: ${address?.layoutConfiguration ?? '?'}`,
            colour: address ? toHex(address.colour) : null,
        },
        [Tool.ROOM]: room ? { text: `${room.preset} #${room.id}` } : null,
        [Tool.FLOOR_TYPE]: { text: floorDescription(node.floorType, node.height) },
        [Tool.TILE]: {
            text: tileDescription(
                tileForNode(model, hovered.x, hovered.y), model.stairwellElevators),
        },
    };
}

function hoveredCaption(hovered) {
    return hovered.kind === 'wall'
        ? `Wall ${hovered.x}, ${hovered.y} (${hovered.axis})`
        : `Node ${hovered.x}, ${hovered.y}`;
}

/**
 * What the selected square is, which is a description of a square rather than of a brush.
 *
 * The four node rows are read off the node the same way the hover reads them, because a
 * selected square and a hovered one are the same kind of thing and describing them
 * differently would be the trap the two-block column exists to avoid.
 *
 * The wall row is the exception, and is read off `selectedWall` rather than off the node.
 * A square has up to four walls and no one of them is "the" wall, so what is named is the
 * edge the click landed nearest -- which is the same edge the wall tool would paint, and
 * the one the pick took its preset from. A square whose nearest edge is bare shows a
 * dash, exactly as a hover over a cell does.
 *
 * With nothing selected every row is a dash. That is a floor freshly opened, which is a
 * state to say plainly rather than fill in from whatever the tool state happens to hold.
 */
function selectedValues(model, state) {
    const at = state.selectedNode;
    if (!at) return {};

    const node = nodeAt(model, at.x, at.y);
    if (!node) return {};

    const address = model.addresses[node.addressIndex];
    const room = roomOfNode(model, node);
    const edge = state.selectedWall;
    const wall = edge && getWall(model, edge.x, edge.y, edge.axis);

    return {
        [Tool.ADDRESS]: {
            text: `${node.addressIndex}: ${address?.layoutConfiguration ?? '?'}`,
            colour: address ? toHex(address.colour) : null,
        },
        [Tool.ROOM]: room ? { text: `${room.preset} #${room.id}` } : null,
        [Tool.FLOOR_TYPE]: { text: floorDescription(node.floorType, node.height) },
        [Tool.WALL]: wall ? {
            text: wall.matched
                ? wallPresetName(wall.preset)
                : `${wallPresetName(wall.preset)} — sides disagree`,
        } : null,
        [Tool.TILE]: {
            text: tileDescription(tileForNode(model, at.x, at.y), model.stairwellElevators),
        },
    };
}

/**
 * A floor type and its height, which are painted together and so are read together.
 *
 * Exported for the cell label over the canvas, for the same reason the wall's name is:
 * the two places a floor is described should not describe it differently.
 */
export function floorDescription(floorType, height) {
    const { floorTileTypes } = refs();
    const name = floorTileTypes[floorType] ?? `Type ${floorType}`;
    return height ? `${name} +${height}` : name;
}

/**
 * A preset's name, or the id itself when the table has no name for it.
 *
 * Exported for the wall label over the canvas, so the two places a wall is named say the
 * same thing about it.
 *
 * The divider end the wall tool paints has no id until it is written, so it is named as
 * the piece. A wall already on the floor is still named by what it holds -- reporting a
 * square is answering what is stored there, and "DividerEndLeft" is what is stored.
 */
export function wallPresetName(id) {
    if (id === DIVIDER_END) return DIVIDER_END_NAME;

    const { wallPresets } = refs();
    return wallPresets.find((preset) => preset.id === id)?.name ?? `Unnamed preset ${id}`;
}

/**
 * What a tile carries, as one line: the phrases tileParts reads off it, or "Nothing".
 *
 * The word rather than an empty string, because this goes in a field that has to say
 * something -- a status column that went blank over an empty tile would read as the
 * column having failed rather than as the tile being empty. The label written on the tile
 * in the view has no such obligation and draws nothing there instead.
 *
 * The empty phrases go before the join rather than through it. They are there to keep the
 * label in the view three rows tall whatever a stairwell is -- see tileParts -- and a line
 * has no rows to line up: joined as they stand, a plain stairwell would read
 * "Stairs 90° ·  · Elevator".
 *
 * `stairwellElevators` is the open floor's, and says whether the stairwell standing in the
 * tile carries a lift. Passed on rather than looked up, because what a tile says is
 * tileParts' answer and this only lays it out.
 *
 * Exported for the label over the canvas, which says this and nothing else while the tile
 * tool is chosen.
 */
export function tileDescription(tile, stairwellElevators = null) {
    return tileParts(tile, stairwellElevators).filter(Boolean).join(' · ') || 'Nothing';
}


/* -------------------------------------------------------------------------- */
/* The tile setting                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What a click of the tile tool changes, and what the click will do.
 *
 * A setting of the tool, like the wall preset above it, and not a fact about any one
 * tile -- which is why it is here rather than in something that appears once a tile has
 * been clicked. What a given tile actually carries is read off the status column, under
 * the pointer, along with everything else that is there.
 *
 * The hint is per setting because the three no longer do the same shape of thing: two of
 * them step a tile through a cycle and one turns a stairwell's mirroring on and off. A
 * single sentence covering all three could only be vague about the one difference an
 * author has to know before clicking.
 */
const TILE_MODE_HINTS = {
    [TileMode.STAIRWELL]: 'A click steps the tile on: off, each rotation, then off again.',
    [TileMode.INVERTED]:
        'A click turns the mirroring on or off, and changes nothing else. An empty tile '
        + 'gets a mirrored stairwell.',
    [TileMode.ENTRANCE]: 'A click steps the tile on: entrance, main entrance, then off again.',
};

export function renderTilePanel(container, state, { onChange } = {}) {
    clear(container);

    const mode = el('select', {
        onchange: (event) => { state.tileMode = event.target.value; onChange?.(); },
    });
    for (const [value, label] of Object.entries(TILE_MODE_LABELS)) {
        mode.appendChild(el('option', { value, text: label }));
    }
    mode.value = state.tileMode;

    container.appendChild(field('Tile tool paints', mode));
    container.appendChild(el('p', {
        class: 'tool-hint',
        text: TILE_MODE_HINTS[state.tileMode] ?? TILE_MODE_HINTS[TileMode.STAIRWELL],
    }));
}


function field(label, control) {
    return el('label', { class: 'field' }, [el('span', { text: label }), control]);
}


/* -------------------------------------------------------------------------- */
/* Composition                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * All of the panels over one model and one tool state.
 *
 * `refresh` redraws the panels; `rebuild` also tells the caller the grid itself changed,
 * which is what a variation switch does. Kept apart because rebuilding the scene is the
 * expensive one and most edits do not need it.
 *
 * `handlers.getHovered` is asked for the hovered target rather than given it, because
 * the pointer moves far more often than anything here changes: the caller redraws the
 * status column on its own for a hover, and this only needs whatever is current when
 * something else has caused a redraw.
 */
export function createPanels(elements, model, state = createToolState(), handlers = {}) {
    const refresh = () => {
        // Not while one of this column's lists is open. See pendingPanels: the redraw is
        // kept, not dropped, and runs as soon as the list is shut. Keeping `refresh`
        // itself is what makes a redraw held back here the redraw that eventually runs --
        // it closes over this model, state and handlers, and a later `createPanels` for
        // another floor replaces it with its own.
        if (dropdownsOpen()) {
            pendingPanels = refresh;
            return;
        }

        pendingPanels = null;

        if (elements.tools) {
            renderToolBar(elements.tools, state, {
                onChange: onToolChange,
                canPaint: handlers.canPaint !== false,
            });
        }
        if (elements.status) {
            renderStatusPanel(elements.status, model, state, handlers.getHovered?.() ?? null);
        }
        // Navigation rather than editing, and asked for rather than held: which floor is
        // open is the flow's business, and it changes underneath these panels when one
        // of these buttons opens another.
        if (elements.floor) {
            renderFloorPanel(elements.floor, handlers.getFloor?.() ?? null, {
                onOpen: handlers.onOpenFloor,
                onGenerateMesh: handlers.onGenerateMesh,
                onMeshRoof: handlers.onMeshRoof,
            });
        }

        // `canPaint` is the same answer to both questions -- it means a mod is selected,
        // and that is what decides whether a click may write and whether a control may.
        const canEdit = handlers.canPaint !== false;

        if (elements.addresses) {
            renderAddressPanel(elements.addresses, model, state, {
                onChange: onEdit, onRebuild: rebuild, canEdit,
            });
        }
        if (elements.rooms) {
            renderRoomPanel(elements.rooms, model, state, {
                onChange: onEdit, onRebuild: rebuild, canEdit,
            });
        }
        if (elements.floorTypes) {
            renderFloorTypePanel(elements.floorTypes, state, { onChange: onEdit });
        }
        if (elements.walls) renderWallPanel(elements.walls, state, { onChange: onEdit });
        if (elements.tiles) renderTilePanel(elements.tiles, state, { onChange: onEdit });
    };

    function onEdit() {
        refresh();
        handlers.onEdit?.();
    }

    function onToolChange() {
        refresh();
        handlers.onToolChange?.();
    }

    function rebuild() {
        refresh();
        handlers.onRebuild?.();
    }

    refresh();
    return { refresh, state, rebuild };
}


/* -------------------------------------------------------------------------- */

/** A stored colour as the hex an `<input type="color">` wants, and back. */
export function toHex(colour) {
    const byte = (value) => Math.round(Math.min(1, Math.max(0, value ?? 0)) * 255)
        .toString(16).padStart(2, '0');
    return `#${byte(colour?.r)}${byte(colour?.g)}${byte(colour?.b)}`;
}

export function fromHex(hex) {
    const value = hex.replace('#', '');
    // Three channels only, so assigning this over a stored colour leaves the alpha
    // alone -- a colour picker has no say in it, and the floor stores one.
    return {
        r: parseInt(value.slice(0, 2), 16) / 255,
        g: parseInt(value.slice(2, 4), 16) / 255,
        b: parseInt(value.slice(4, 6), 16) / 255,
    };
}
