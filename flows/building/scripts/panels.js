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
    Tool, createToolState,
} from './tools.js';
import {
    TileMode,
    nodeAt, tileAt, roomsOfAddress, roomOfNode, getWall,
    addAddress, addRoom, nextRoomId, selectVariation, addVariation,
    duplicateVariation, removeVariation, describeIssues,
} from './floorModel.js';

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
 * A select over a list of names, which also accepts one that is not on it.
 *
 * A mod may add a layout configuration or a room preset the generated data has never
 * heard of, and a floor referring to one is perfectly valid. So the current value is
 * always an option even when the list does not contain it, marked so it is clear it is
 * not the game's.
 */
function nameSelect(value, names, onPick) {
    const select = el('select', { onchange: (event) => onPick(event.target.value) });

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

/**
 * Which tool is active, and the reminder of what the modifiers do.
 *
 * The reminder is on screen rather than in a manual because the modifiers are the whole
 * interface: without ctrl there is no way to pick a value off the floor, and a tool bar
 * that does not say so leaves the feature undiscoverable.
 */
export function renderToolBar(container, state, { onChange } = {}) {
    clear(container);

    const buttons = TOOL_LABELS.map(([tool, label]) => el('button', {
        type: 'button',
        class: state.tool === tool ? 'tool active' : 'tool',
        'aria-pressed': state.tool === tool ? 'true' : 'false',
        'data-tool': tool,
        text: label,
        onclick: () => {
            state.tool = tool;
            renderToolBar(container, state, { onChange });
            onChange?.();
        },
    }));

    container.appendChild(el('div', { class: 'tool-bar' }, buttons));
    container.appendChild(el('p', {
        class: 'tool-hint',
        text: state.tool === Tool.WALL
            ? 'Click to paint · Ctrl+click to pick · Shift+click to remove'
            : 'Click to paint · Ctrl+click to pick',
    }));
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
export function renderAddressPanel(container, model, state, { onChange, onRebuild } = {}) {
    clear(container);
    if (!model) return;

    const { layoutConfigurations } = refs();
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
            onchange: () => { state.addressIndex = index; onChange?.(); },
        }));

        // Index 0 is Outside and index 1 the Lobby, by a convention the game relies on,
        // so both are labelled rather than left to be inferred from the name.
        const role = index === 0 ? ' (outside)' : (index === 1 ? ' (lobby)' : '');
        row.appendChild(el('span', { class: 'address-index', text: `${index}${role}` }));

        row.appendChild(nameSelect(address.layoutConfiguration, layoutConfigurations, (value) => {
            address.layoutConfiguration = value;
            onChange?.();
        }));

        row.appendChild(el('input', {
            type: 'color',
            value: toHex(address.colour),
            title: 'Colour shown in the editor, and stored in the floor',
            oninput: (event) => {
                Object.assign(address.colour, fromHex(event.target.value));
                onChange?.();
            },
        }));

        row.appendChild(variationControls(model, index, address, { onRebuild }));
        list.appendChild(row);
    });

    container.appendChild(list);
    container.appendChild(el('button', {
        type: 'button',
        class: 'add-entry secondary',
        text: 'Add address',
        onclick: () => {
            state.addressIndex = addAddress(model, 'Outside', { r: 0, g: 0.8, b: 0.8, a: 1 });
            onRebuild?.();
        },
    }));
}

/** Which layout of an address is on show, and the controls for having more of them. */
function variationControls(model, index, address, { onRebuild }) {
    const wrapper = el('span', { class: 'variations' });

    if (address.variations.length === 0) {
        // Six base game addresses are in this state. It is representable rather than
        // prevented, so say so plainly rather than showing an empty dropdown.
        wrapper.appendChild(el('span', { class: 'variation-none', text: 'no layouts' }));
    } else {
        const select = el('select', {
            title: 'Which of this address’s layouts is being edited',
            onchange: (event) => {
                selectVariation(model, index, Number(event.target.value));
                onRebuild?.();
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
        onclick: () => { addVariation(model, index); onRebuild?.(); },
    }));
    wrapper.appendChild(el('button', {
        type: 'button', text: '⧉', title: 'Duplicate the layout on show',
        onclick: () => { duplicateVariation(model, index); onRebuild?.(); },
    }));
    wrapper.appendChild(el('button', {
        type: 'button', text: '−', title: 'Remove the layout on show',
        onclick: () => {
            if (address.selectedVariation < 0) return;
            removeVariation(model, index, address.selectedVariation);
            onRebuild?.();
        },
    }));

    return wrapper;
}


/* -------------------------------------------------------------------------- */
/* Rooms                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The rooms of the address being painted with.
 *
 * A room is chosen by its preset and its id, which is how the file names one and how
 * the room tool paints. Ids are the game's and clash within a single variation in 58
 * places across the base game, so the list can legitimately show two rooms that look
 * identical -- they are different rooms, and the floor treats them as such.
 */
export function renderRoomPanel(container, model, state, { onChange, onRebuild } = {}) {
    clear(container);
    if (!model) return;

    const { roomTypePresets } = refs();
    const rooms = roomsOfAddress(model, state.addressIndex);

    const list = el('div', { class: 'room-list' });

    for (const room of rooms) {
        const selected = state.roomPreset === room.preset && state.roomId === room.id;

        const row = el('div', {
            class: selected ? 'room-row selected' : 'room-row',
            'data-room': `${room.preset}#${room.id}`,
        });

        row.appendChild(el('input', {
            type: 'radio',
            name: 'painting-room',
            ...(selected ? { checked: 'checked' } : {}),
            onchange: () => {
                state.roomPreset = room.preset;
                state.roomId = room.id;
                onChange?.();
            },
        }));

        row.appendChild(nameSelect(room.preset, roomTypePresets, (value) => {
            room.preset = value;
            if (selected) state.roomPreset = value;
            onRebuild?.();
        }));

        row.appendChild(el('input', {
            type: 'number',
            class: 'room-id',
            value: String(room.id),
            title: 'The id the game stores for this room',
            onchange: (event) => {
                room.id = Number(event.target.value) || 0;
                if (selected) state.roomId = room.id;
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
        onclick: () => {
            const id = nextRoomId(model, state.addressIndex);
            const room = addRoom(model, state.addressIndex, roomTypePresets[0] ?? 'Null', id);
            if (room) { state.roomPreset = room.preset; state.roomId = room.id; }
            onRebuild?.();
        },
    }));
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
    container.appendChild(select);
}


/* -------------------------------------------------------------------------- */
/* What is selected                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The fields of the selected node, the selected tile, and the selected wall.
 *
 * `f_r` is shown and not editable. It names a RoomConfiguration on 1,889 nodes across
 * 40 base game floors, and the model carries it through untouched -- but what a doubled
 * value like "Lobby.Lobby" means, and how the game resolves one that disagrees with the
 * room's own preset, are both unknown. Editing it would be guessing. Showing it is how
 * an author finds out it is there at all.
 */
export function renderSelectionPanel(container, model, state, { onChange } = {}) {
    clear(container);
    if (!model) return;

    const { floorTileTypes } = refs();

    const node = state.selectedNode
        ? nodeAt(model, state.selectedNode.x, state.selectedNode.y)
        : null;

    if (node) {
        const room = roomOfNode(model, node);
        const address = model.addresses[node.addressIndex];
        const section = el('section', { class: 'selected-node' });

        section.appendChild(el('h4', { text: `Node ${node.x}, ${node.y}` }));
        section.appendChild(field('Address', el('span', {
            text: `${node.addressIndex}: ${address?.layoutConfiguration ?? '?'}`,
        })));
        section.appendChild(field('Room', el('span', {
            text: room ? `${room.preset} #${room.id}` : '?',
        })));

        const floorType = el('select', {
            onchange: (event) => { node.floorType = Number(event.target.value); onChange?.(); },
        });
        floorTileTypes.forEach((name, index) => {
            floorType.appendChild(el('option', { value: String(index), text: name }));
        });
        floorType.value = String(node.floorType);
        section.appendChild(field('Floor type', floorType));

        section.appendChild(field('Height', el('input', {
            type: 'number',
            value: String(node.height),
            onchange: (event) => { node.height = Number(event.target.value) || 0; onChange?.(); },
        })));

        if (node.forcedRoom) {
            section.appendChild(field('Forced room', el('span', {
                class: 'read-only',
                title: 'Stored by the game and preserved exactly. Not editable here.',
                text: node.forcedRoom,
            })));
        }

        if (node.backfilled) {
            section.appendChild(el('p', {
                class: 'note',
                text: 'This node was missing from the file and was filled in as Outside.',
            }));
        }

        container.appendChild(section);
    }

    if (state.selectedWall) {
        const { x, y, axis } = state.selectedWall;
        const wall = getWall(model, x, y, axis);
        const section = el('section', { class: 'selected-wall' });

        section.appendChild(el('h4', { text: `Wall ${x}, ${y} (${axis})` }));
        section.appendChild(field('Preset', el('span', {
            text: wall ? `${window.doorPairIds?.[wall.preset] ?? wall.preset}` : 'none',
        })));

        if (wall && !wall.matched) {
            section.appendChild(el('p', {
                class: 'warning',
                text: 'The two sides of this wall disagree. Painting it will set both.',
            }));
        }

        container.appendChild(section);
    }

    const tile = state.selectedTile ? tileAt(model, state.selectedTile.x, state.selectedTile.y) : null;
    if (tile) container.appendChild(tileSection(tile, state, { onChange }));

    const issues = describeIssues(model);
    if (issues.length) {
        container.appendChild(el('section', { class: 'issues' }, [
            el('h4', { text: 'Worth knowing' }),
            ...issues.map((note) => el('p', { class: 'note', text: note })),
        ]));
    }
}

/** A tile's own fields, plus which of its three cycles the tile tool is stepping. */
function tileSection(tile, state, { onChange }) {
    const section = el('section', { class: 'selected-tile' });
    section.appendChild(el('h4', { text: `Tile ${tile.x}, ${tile.y}` }));

    const mode = el('select', {
        onchange: (event) => { state.tileMode = event.target.value; onChange?.(); },
    });
    for (const [value, label] of [
        [TileMode.STAIRWELL, 'Stairwell'],
        [TileMode.ELEVATOR, 'Elevator'],
        [TileMode.ENTRANCE, 'Entrance'],
    ]) {
        mode.appendChild(el('option', { value, text: label }));
    }
    mode.value = state.tileMode;
    section.appendChild(field('Tile tool paints', mode));

    section.appendChild(field('Stairwell', el('span', {
        text: tile.isStairwell
            ? `${tile.isInverted ? 'elevator' : 'stairs'}, ${tile.stairwellRotation}°`
            : 'none',
    })));
    section.appendChild(field('Entrance', el('span', {
        text: tile.isMainEntrance ? 'main entrance' : (tile.isEntrance ? 'entrance' : 'none'),
    })));

    return section;
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
 */
export function createPanels(elements, model, state = createToolState(), handlers = {}) {
    const refresh = () => {
        if (elements.tools) renderToolBar(elements.tools, state, { onChange: onToolChange });
        if (elements.addresses) {
            renderAddressPanel(elements.addresses, model, state, {
                onChange: onEdit, onRebuild: rebuild,
            });
        }
        if (elements.rooms) {
            renderRoomPanel(elements.rooms, model, state, { onChange: onEdit, onRebuild: rebuild });
        }
        if (elements.walls) renderWallPanel(elements.walls, state, { onChange: onEdit });
        if (elements.selection) {
            renderSelectionPanel(elements.selection, model, state, { onChange: onEdit });
        }
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
