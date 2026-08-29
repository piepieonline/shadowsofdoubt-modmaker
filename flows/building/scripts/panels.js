/**
 * The controls beside the floorplan: the tool bar, the address and room lists, the wall
 * preset picker, and the fields of whatever is selected.
 *
 * These render into elements they are given rather than into ids of their own, so the
 * flow decides the layout and this decides what goes in it. Every one of them is a full
 * redraw: a floor has at most a few dozen addresses and rooms, and rebuilding a list
 * that size is cheaper than keeping a diff of it correct.
 *
 * The name lists come from the generated reference data rather than from a table here.
 * Both are the game's own assets -- a layout configuration the game does not have is a
 * floor it will not load -- but a name can still be typed in, because a mod may add
 * one. That is the same reasoning as the ScriptableObject flow's reference fields: the
 * list is what exists, not what is allowed.
 */
import {
    Tool, PaintMode, createToolState,
} from './tools.js';
import {
    TileMode, tileParts,
    nodeAt, tileForNode, roomsOfAddress, roomAt, roomOfNode, getWall,
    addAddress, addRoom, removeRoom, seedRoomForLayout, selectVariation, addVariation,
    duplicateVariation, removeVariation,
} from './floorModel.js';
import { sameSlot } from './buildingLibrary.js';

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

/**
 * A select over a list of names, which also accepts one that is not on it.
 *
 * A mod may add a layout configuration or a room preset the generated data has never
 * heard of, and a floor referring to one is perfectly valid. So the current value is
 * always an option even when the list does not contain it, marked so it is clear it is
 * not the game's.
 */
function nameSelect(value, names, onPick, canEdit = true) {
    const select = el('select', {
        ...unless(canEdit),
        onchange: (event) => onPick(event.target.value),
    });

    const known = names.includes(value);
    if (!known && value !== undefined) {
        select.appendChild(el('option', { value, text: `${value} (not a base game asset)` }));
    }

    for (const name of names) select.appendChild(el('option', { value: name, text: name }));

    select.value = value ?? '';
    return select;
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
    [TileMode.ELEVATOR]: 'Elevator',
    [TileMode.ENTRANCE]: 'Entrance',
};

const MODE_LABELS = [
    [PaintMode.NONE, 'None', 'A click selects what is under it and takes its value. '
        + 'Nothing is edited.'],
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
    if (state.mode === PaintMode.NONE) return 'Left click to select and pick · Nothing is edited';

    const floods = state.mode === PaintMode.FLOOD
        && state.tool !== Tool.WALL && state.tool !== Tool.TILE;

    const click = floods ? 'Left click to fill up to the walls' : 'Left click to paint';

    return state.tool === Tool.WALL
        ? `${click} · Ctrl+click to pick · Shift+click to remove`
        : `${click} · Ctrl+click to pick`;
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
    clear(container);
    if (!model) return;

    const { layoutConfigurations, roomTypePresets } = refs();
    const list = el('div', { class: 'address-list' });

    model.addresses.forEach((address, index) => {
        const selected = state.addressIndex === index;

        const row = el('div', {
            class: selected ? 'address-row selected' : 'address-row',
            'data-address': String(index),
        });

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

        row.appendChild(nameSelect(address.layoutConfiguration, layoutConfigurations, (value) => {
            address.layoutConfiguration = value;

            // An address is added before it is told what it is, so the room named after
            // its layout is added at the moment that question is answered rather than at
            // the moment the address appeared. See seedRoomForLayout: it fires once, on
            // an address that is still nothing but the Null room it was created with.
            const seeded = seedRoomForLayout(model, index, roomTypePresets);
            (seeded ? onRebuild : onChange)?.();
        }, canEdit));

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
        list.appendChild(row);
    });

    container.appendChild(list);
    container.appendChild(el('button', {
        type: 'button',
        class: 'add-entry secondary',
        text: 'Add address',
        ...unless(canEdit),
        onclick: () => {
            state.addressIndex = addAddress(model, 'Outside', { r: 0, g: 0.8, b: 0.8, a: 1 });
            // The Null room it arrives with, which is the only one it has until its
            // layout is chosen -- Outside is not the name of any room preset.
            state.roomIndex = 0;
            seedRoomForLayout(model, state.addressIndex, roomTypePresets);
            onRebuild?.();
        },
    }));
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
export function renderFloorPanel(container, floor, { onOpen, onGenerateMesh } = {}) {
    clear(container);

    if (!floor?.blueprint) {
        container.appendChild(el('p', { class: 'tool-hint', text: 'No floor open.' }));
        return;
    }

    const { storeys = [], storeyIndex = -1 } = floor;
    const storey = storeys[storeyIndex] ?? null;

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
            ...unless(!!storey && !!storeys[storeyIndex + 1]),
            onclick: () => step(1),
        }),
        el('span', {
            class: 'floor-storey',
            text: storey?.label ?? (floor.building ? 'Not in this building' : 'No building'),
        }),
        el('button', {
            type: 'button', class: 'secondary', text: '▼',
            title: 'Open the floor below',
            ...unless(!!storey && storeyIndex > 0),
            onclick: () => step(-1),
        }),
    ]));

    container.appendChild(el('p', {
        class: 'floor-name',
        title: floor.building ? `${floor.blueprint} in ${floor.building}` : floor.blueprint,
        text: floor.blueprint,
    }));

    if (storey) container.appendChild(layoutSelect(storey, floor.slot, onOpen));
    if (floor.mesh) container.appendChild(meshSection(floor.mesh, onGenerateMesh));
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
function meshSection(mesh, onGenerate) {
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
        notes.length
            ? el('small', { class: mesh.stale ? 'mesh-note stale' : 'mesh-note', text: notes.join(' ') })
            : null,
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
    clear(container);
    if (!model) return;

    const { roomTypePresets } = refs();
    const rooms = roomsOfAddress(model, state.addressIndex);

    const list = el('div', { class: 'room-list' });

    for (const room of rooms) {
        const selected = state.roomIndex === room.roomIndex;

        const row = el('div', {
            class: selected ? 'room-row selected' : 'room-row',
            'data-room': `${room.preset}#${room.id}`,
            'data-room-index': String(room.roomIndex),
        });

        row.appendChild(el('input', {
            type: 'radio',
            name: 'painting-room',
            ...(selected ? { checked: 'checked' } : {}),
            onchange: () => { state.roomIndex = room.roomIndex; onChange?.(); },
        }));

        row.appendChild(nameSelect(room.preset, roomTypePresets, (value) => {
            room.preset = value;
            onRebuild?.();
        }, canEdit));

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

        list.appendChild(row);
    }

    if (rooms.length === 0) {
        list.appendChild(el('p', { class: 'empty', text: 'This address has no rooms yet.' }));
    }

    container.appendChild(list);
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
 */
export function renderWallPanel(container, state, { onChange } = {}) {
    clear(container);

    const { wallPresets } = refs();
    const select = el('select', {
        class: 'wall-preset',
        onchange: (event) => { state.wallPreset = event.target.value; onChange?.(); },
    });

    for (const kind of ['wall', 'window', 'door', 'blank']) {
        const inKind = wallPresets.filter((preset) => preset.kind === kind);
        if (inKind.length === 0) continue;

        const group = el('optgroup', { label: `${kind[0].toUpperCase()}${kind.slice(1)}s` });
        for (const preset of inKind) {
            group.appendChild(el('option', { value: preset.id, text: preset.name }));
        }
        select.appendChild(group);
    }

    // A floor may name an id this list has no name for -- 28 to 30 exist in the
    // reference tool's table and name nothing the game has. Shown rather than silently
    // replaced, because replacing it would rewrite a wall nobody asked to change.
    if (!wallPresets.some((preset) => preset.id === state.wallPreset)) {
        select.insertBefore(
            el('option', { value: state.wallPreset, text: `Unnamed preset ${state.wallPreset}` }),
            select.firstChild);
    }

    select.value = state.wallPreset;
    // The same labelled row the tile setting below it uses: both are a setting of a
    // tool, and a bare full-width select read as something else entirely.
    container.appendChild(field('Wall tool paints', select));
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
    clear(container);

    if (!model) {
        container.appendChild(el('p', { class: 'empty', text: 'No floor open.' }));
        return;
    }

    container.appendChild(statusBlock(
        'Painting with',
        MODE_CAPTIONS[state.mode] ?? null,
        paintingValues(model, state),
        state.tool));

    const under = statusBlock(
        'Under the pointer',
        hovered ? hoveredCaption(hovered) : 'Move the pointer over the floor',
        hoveredValues(model, hovered),
        state.tool);

    for (const note of hoveredNotes(model, hovered)) {
        under.appendChild(el('p', { class: 'note status-note', text: note }));
    }

    container.appendChild(under);
}

/** What the mode means for the values below it. Paint is the plain case and says nothing. */
const MODE_CAPTIONS = {
    [PaintMode.NONE]: 'A click picks these instead of painting them',
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
 */
function hoveredNotes(model, hovered) {
    if (!model || hovered?.kind !== 'cell') return [];

    const node = nodeAt(model, hovered.x, hovered.y);
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
        [Tool.TILE]: { text: tileDescription(tileForNode(model, hovered.x, hovered.y)) },
    };
}

function hoveredCaption(hovered) {
    return hovered.kind === 'wall'
        ? `Wall ${hovered.x}, ${hovered.y} (${hovered.axis})`
        : `Node ${hovered.x}, ${hovered.y}`;
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
 */
export function wallPresetName(id) {
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
 * Exported for the label over the canvas, which says this and nothing else while the tile
 * tool is chosen.
 */
export function tileDescription(tile) {
    return tileParts(tile).join(' · ') || 'Nothing';
}


/* -------------------------------------------------------------------------- */
/* The tile setting                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which of a tile's three cycles the tile tool steps.
 *
 * A setting of the tool, like the wall preset above it, and not a fact about any one
 * tile -- which is why it is here rather than in something that appears once a tile has
 * been clicked. What a given tile actually carries is read off the status column, under
 * the pointer, along with everything else that is there.
 */
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
        text: 'A click steps the tile on: off, each rotation, then off again.',
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
