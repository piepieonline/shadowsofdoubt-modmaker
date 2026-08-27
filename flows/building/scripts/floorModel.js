/**
 * A floor blueprint as an editable grid, and back again.
 *
 * The game stores a floor as nested lists: a floor holds addresses, an address holds
 * layout variations, a variation holds rooms, and a room holds the nodes belonging to
 * it. Nothing in that shape can answer "what is at (9, 12)?" without walking all of it,
 * which is the one question a painting tool asks constantly. So this module turns a
 * blueprint into a 21 x 21 grid of nodes and turns the grid back into a blueprint.
 *
 * The round trip is the whole point of the file, and two things about the game's data
 * make it harder than it looks.
 *
 * **An address may hold several complete layout variations**, and the game picks one at
 * random per floor. 117 of the 602 addresses in the base game do. The editor shows one
 * variation per address -- the *selected* one -- and the grid is the union of every
 * address's selected variation. On save, only those are rebuilt from the grid; the rest
 * are written back exactly as they were read. The reference tool loads variation 0 and
 * writes a single variation, so saving any of those 117 through it deletes layouts the
 * game was relying on, silently.
 *
 * **A node's f_r is not blank.** 1,889 nodes across 40 base game floors name a
 * RoomConfiguration in it. The reference tool writes "" for every node, on the belief
 * that real files leave it empty. They do not, so the field is carried through here
 * untouched -- read, held, written back -- without being exposed as something to edit,
 * because what a doubled value like "Lobby.Lobby" means is not known.
 *
 * Order is preserved rather than re-derived. No single traversal explains the order the
 * base game writes nodes in -- x-major fits 2,094 of its 2,872 rooms and tile-major
 * 1,658 -- so a model that re-sorted on save would rewrite the node list of every floor
 * it touched. Instead each room remembers the order it was read in, and nodes that
 * arrive later are appended.
 *
 * Nothing here touches the DOM or three.js. It is the part of the flow that carries the
 * correctness risk and the part that is cheapest to test, so it is kept separable.
 */

/** The node grid is 21 x 21 in every base game floor, and the tile grid 7 x 7. */
export const NODE_GRID = 21;
export const NODES_PER_TILE = 3;
export const TILE_GRID = NODE_GRID / NODES_PER_TILE;

/**
 * The outer three nodes on each side are null in every base game floor -- they are the
 * margin the city puts between one lot and the next -- so painting is confined to the
 * middle. Read and written like any other node; just not offered as a target.
 */
export const PAINTABLE_MIN = NODES_PER_TILE;
export const PAINTABLE_MAX = NODE_GRID - NODES_PER_TILE - 1;

/** What BackfillOutside fills a missing node in as. Both are the game's own names. */
const OUTSIDE_LAYOUT = 'Outside';
const OUTSIDE_ROOM = 'Null';

/** FloorTileType.none, which is what a backfilled node's floor is. */
const FLOOR_TYPE_NONE = 0;

/** A wall sits half a node from the node that records it. */
const WALL_OFFSET = 0.5;

/**
 * The two axes a wall can lie on. `x` is the wall between (x, y) and (x + 1, y): the
 * node on the low side records it at +0.5, the node on the high side at -0.5.
 */
export const AXIS_X = 'x';
export const AXIS_Y = 'y';

const AXES = {
    [AXIS_X]: { dx: 1, dy: 0 },
    [AXIS_Y]: { dx: 0, dy: 1 },
};

const coordKey = (x, y) => `${x},${y}`;

const inGrid = (x, y) => x >= 0 && y >= 0 && x < NODE_GRID && y < NODE_GRID;

/** Whether a node is one a tool may paint, as opposed to the lot's outer margin. */
export const isPaintable = (x, y) =>
    x >= PAINTABLE_MIN && x <= PAINTABLE_MAX && y >= PAINTABLE_MIN && y <= PAINTABLE_MAX;

/** The tile a node falls in. Tiles are 3 x 3 nodes and hold stairwells and entrances. */
export const tileOf = (x, y) => ({
    x: Math.floor(x / NODES_PER_TILE),
    y: Math.floor(y / NODES_PER_TILE),
});

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));


/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A blueprint as a model.
 *
 * `selections` optionally names the variation to show for each address, as an array of
 * indices; anything missing or out of range shows variation 0. An address with no
 * variations at all -- six of the base game's addresses -- gets -1 and contributes no
 * nodes.
 */
export function parseFloor(data, { selections = [] } = {}) {
    const addresses = (data?.a_d ?? []).map((address, index) => {
        const variations = (address.vs ?? []).map((variation) => ({
            // Held verbatim so a variation nobody selected is written back byte for
            // byte. The selected one is rebuilt from the grid instead, and this copy
            // is refreshed from it whenever the selection moves off it.
            raw: clone(variation),
        }));

        const wanted = selections[index];
        const selected = variations.length === 0
            ? -1
            : (Number.isInteger(wanted) && wanted >= 0 && wanted < variations.length ? wanted : 0);

        return {
            layoutConfiguration: address.p_n ?? '',
            colour: clone(address.e_c) ?? { r: 0, g: 1, b: 1, a: 1 },
            variations,
            selectedVariation: selected,
        };
    });

    const model = {
        floorName: data?.floorName ?? 'newFloor',
        // Lot count rather than grid size -- (1, 1) in every base game floor. Carried
        // through rather than interpreted.
        size: clone(data?.size) ?? { x: 1, y: 1 },
        defaultFloorHeight: data?.defaultFloorHeight ?? 0,
        defaultCeilingHeight: data?.defaultCeilingHeight ?? 42,
        addresses,
        tiles: parseTiles(data?.t_d),
        nodes: [],
        rooms: [],
        issues: { overlaps: [], gaps: [], wallMismatches: [] },
    };

    rebuildGrid(model);
    return model;
}

/**
 * The 7 x 7 tile grid. Every base game floor stores all 49, x-major, so a missing or
 * out-of-range entry is a malformed file rather than a shorthand -- it is dropped, and
 * the tile it would have set keeps its defaults.
 */
function parseTiles(saved) {
    const tiles = [];
    for (let x = 0; x < TILE_GRID; x++) {
        for (let y = 0; y < TILE_GRID; y++) {
            tiles.push({
                x, y,
                isEntrance: false,
                isMainEntrance: false,
                isStairwell: false,
                isInverted: false,
                stairwellRotation: 0,
                elevatorRotation: 0,
            });
        }
    }

    for (const saved_ of saved ?? []) {
        const tile = tileAt({ tiles }, saved_.f_c?.x, saved_.f_c?.y);
        if (!tile) continue;

        tile.isEntrance = !!saved_.i_e;
        tile.isMainEntrance = !!saved_.m_e;
        tile.isStairwell = !!saved_.s_t;
        tile.isInverted = !!saved_.e_l;
        tile.stairwellRotation = saved_.s_r ?? 0;
        tile.elevatorRotation = saved_.e_r ?? 0;
    }

    return tiles;
}

/**
 * Lay every address's selected variation onto the grid, then fill in whatever it did
 * not cover.
 *
 * Called on load and whenever a selection changes. Painting mutates the grid in place
 * and does not come back through here.
 */
export function rebuildGrid(model) {
    model.nodes = new Array(NODE_GRID * NODE_GRID).fill(null);
    model.rooms = [];
    model.issues = { overlaps: [], gaps: [], wallMismatches: [] };

    model.addresses.forEach((address, addressIndex) => {
        const variation = address.variations[address.selectedVariation];
        if (!variation) return;

        (variation.raw?.r_d ?? []).forEach((room, roomIndex) => {
            model.rooms.push({
                addressIndex,
                roomIndex,
                id: room.id ?? 0,
                preset: room.l ?? '',
                // What keeps a saved floor's node order: the coordinates this room was
                // read holding, in the order it held them.
                order: (room.n_d ?? []).map((node) => coordKey(node.f_c.x, node.f_c.y)),
            });

            for (const node of room.n_d ?? []) {
                placeNode(model, node, addressIndex, roomIndex);
            }
        });
    });

    backfillOutside(model);
    findWallMismatches(model);
    return model;
}

/**
 * Put one saved node on the grid.
 *
 * Two addresses claiming the same node is an authoring error the base game contains --
 * five of its floors do it -- so it is recorded rather than resolved. The later address
 * wins the square, matching what the reference tool renders, and the loser is listed in
 * `issues.overlaps` for the editor to show.
 */
function placeNode(model, saved, addressIndex, roomIndex) {
    const { x, y } = saved.f_c ?? {};
    if (!Number.isInteger(x) || !Number.isInteger(y) || !inGrid(x, y)) return;

    const existing = model.nodes[y * NODE_GRID + x];
    if (existing) {
        model.issues.overlaps.push({
            x, y, heldBy: existing.addressIndex, alsoClaimedBy: addressIndex,
        });
    }

    model.nodes[y * NODE_GRID + x] = {
        x, y,
        addressIndex,
        roomIndex,
        height: saved.f_h ?? 0,
        floorType: saved.f_t ?? FLOOR_TYPE_NONE,
        // Never edited, never blanked. See the note at the top of the file.
        forcedRoom: saved.f_r ?? '',
        walls: (saved.w_d ?? []).map((wall) => ({
            ox: wall.w_o?.x ?? 0,
            oy: wall.w_o?.y ?? 0,
            preset: wall.p_n ?? '',
        })),
        backfilled: false,
    };
}

/**
 * Fill in squares no address covered, mirroring DataBuilder.BackfillOutside.
 *
 * Six base game floors stop short of the full grid in their first variation. Those are
 * nodes missing from the export rather than a smaller floor, so they are filled in as
 * Outside with no floor -- and given their half of any wall facing them, because a wall
 * is stored on both of the nodes it sits between and half a wall renders as a glitch.
 */
function backfillOutside(model) {
    const missing = [];
    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            if (!model.nodes[y * NODE_GRID + x]) missing.push({ x, y });
        }
    }
    if (missing.length === 0 || model.addresses.length === 0) return;

    model.issues.gaps = missing.map(({ x, y }) => ({ x, y }));

    const addressIndex = outsideAddressIndex(model);
    const roomIndex = outsideRoomIndex(model, addressIndex);

    for (const { x, y } of missing) {
        model.nodes[y * NODE_GRID + x] = {
            x, y,
            addressIndex,
            roomIndex,
            height: 0,
            floorType: FLOOR_TYPE_NONE,
            forcedRoom: '',
            walls: [],
            backfilled: true,
        };
    }

    for (const { x, y } of missing) mirrorNeighbourWalls(model, x, y);
}

/** The address named Outside, or the first one -- address 0 is Outside by convention. */
function outsideAddressIndex(model) {
    const named = model.addresses.findIndex((a) => a.layoutConfiguration === OUTSIDE_LAYOUT);
    return named >= 0 ? named : 0;
}

/**
 * A room to put backfilled nodes in: the Outside address's own Null room if it has one,
 * otherwise a new room appended to its selected variation.
 *
 * The reference tool will reuse a Null room belonging to a *different* address, which
 * writes that address's room id into this one's nodes. Kept to this address instead.
 */
function outsideRoomIndex(model, addressIndex) {
    const address = model.addresses[addressIndex];
    if (!address) return 0;

    const existing = model.rooms.find(
        (room) => room.addressIndex === addressIndex && room.preset === OUTSIDE_ROOM);
    if (existing) return existing.roomIndex;

    // Ids are the game's, and clash within a variation in 58 places across the base
    // game, so they identify nothing on their own -- a room is addressed by its slot.
    // A fresh one still gets an unused id, because the game does read it.
    const id = model.rooms.reduce((highest, room) => Math.max(highest, room.id + 1), 1);
    return appendRoom(model, addressIndex, OUTSIDE_ROOM, id).roomIndex;
}

/**
 * Give an address another room, in its selected variation.
 *
 * An address showing no variation at all gets one, because a room has to live in a
 * variation and this is only ever called because something needs to go in the room.
 */
function appendRoom(model, addressIndex, preset, id) {
    const address = model.addresses[addressIndex];

    if (address.selectedVariation < 0) {
        address.variations.push({ raw: { r_d: [] } });
        address.selectedVariation = address.variations.length - 1;
    }

    // The slot after this address's last room. Rooms are pushed in slot order when the
    // grid is built, so counting them gives the next index.
    const roomIndex = model.rooms.filter((room) => room.addressIndex === addressIndex).length;

    const room = { addressIndex, roomIndex, id, preset, order: [] };
    model.rooms.push(room);
    return room;
}

/**
 * Give a backfilled node its half of any wall its neighbours record facing it.
 *
 * A neighbour's wall faces this node when its offset points back the way we came, which
 * is what the dot product against the step from here to there tests.
 */
function mirrorNeighbourWalls(model, x, y) {
    const node = nodeAt(model, x, y);

    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const neighbour = nodeAt(model, x + dx, y + dy);
        if (!neighbour) continue;

        const facing = neighbour.walls.find((wall) => wall.ox * dx + wall.oy * dy < 0);
        if (!facing) continue;

        node.walls.push({ ox: offset(dx), oy: offset(dy), preset: facing.preset });
    }
}

/**
 * Walls whose two halves disagree, or that only exist on one side.
 *
 * Not repaired: 582 wall halves across 30 base game floors name a different preset from
 * their opposite number, and 3 have no opposite at all. Guessing which side is right
 * would rewrite the game's own data, so both are reported and left alone. Anything
 * written *through this model* has matching halves, which is what stops the editor
 * adding to the pile.
 */
function findWallMismatches(model) {
    const mismatches = [];

    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            for (const axis of [AXIS_X, AXIS_Y]) {
                const { dx, dy } = AXES[axis];
                if (!inGrid(x + dx, y + dy)) continue;

                const low = halfWallOn(nodeAt(model, x, y), axis, WALL_OFFSET);
                const high = halfWallOn(nodeAt(model, x + dx, y + dy), axis, -WALL_OFFSET);

                if (!low && !high) continue;
                if (low && high && low.preset === high.preset) continue;

                mismatches.push({
                    x, y, axis, low: low?.preset ?? null, high: high?.preset ?? null,
                });
            }
        }
    }

    model.issues.wallMismatches = mismatches;
}

/** The wall a node records on one side of itself, if any. */
function halfWallOn(node, axis, sign) {
    if (!node) return null;
    const component = axis === AXIS_X ? 'ox' : 'oy';
    return node.walls.find((wall) => Math.sign(wall[component]) === Math.sign(sign)) ?? null;
}


/* -------------------------------------------------------------------------- */
/* Reading the grid                                                            */
/* -------------------------------------------------------------------------- */

/** The node at a coordinate, or null off the grid. */
export function nodeAt(model, x, y) {
    return inGrid(x, y) ? model.nodes[y * NODE_GRID + x] : null;
}

/** The tile at a tile coordinate, or null off the tile grid. */
export function tileAt(model, x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    if (x < 0 || y < 0 || x >= TILE_GRID || y >= TILE_GRID) return null;
    return model.tiles[x * TILE_GRID + y] ?? null;
}

/** The tile a node falls in. */
export function tileForNode(model, x, y) {
    const tile = tileOf(x, y);
    return tileAt(model, tile.x, tile.y);
}

/** The rooms belonging to one address's selected variation. */
export function roomsOfAddress(model, addressIndex) {
    return model.rooms.filter((room) => room.addressIndex === addressIndex);
}

/** The room a node belongs to. */
export function roomOfNode(model, node) {
    if (!node) return null;
    return model.rooms.find(
        (room) => room.addressIndex === node.addressIndex && room.roomIndex === node.roomIndex)
        ?? null;
}


/* -------------------------------------------------------------------------- */
/* Painting a node                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Move a node into another address, keeping the room it is in.
 *
 * The reference tool holds addresses and rooms as two independent lists, so painting an
 * address leaves the square's room object alone and saving writes that room under the
 * new address. Here a room belongs to one address's variation -- it has to, because
 * room ids clash within a single variation in 58 places across the base game, so an id
 * identifies nothing on its own. Keeping the room therefore means finding the room of
 * the same preset and id in the address being painted, and adding one if it has none.
 *
 * The visible behaviour is the reference's. What differs is that the room the node ends
 * up in is genuinely the new address's, rather than another address's borrowed.
 */
export function setNodeAddress(model, node, addressIndex) {
    if (!node || !model.addresses[addressIndex]) return false;
    if (node.addressIndex === addressIndex) return false;

    const room = roomOfNode(model, node);
    const target = findOrAddRoom(
        model, addressIndex, room?.preset ?? OUTSIDE_ROOM, room?.id ?? 1);

    node.addressIndex = addressIndex;
    node.roomIndex = target.roomIndex;
    node.backfilled = false;
    return true;
}

/**
 * Put a node in a room, named the way the file names one: a preset and an id.
 *
 * Addressed by preset and id rather than by slot because that is what the room list
 * shows and what the author picked. The slot is an implementation detail of where it
 * sits in the address currently being painted.
 */
export function setNodeRoom(model, node, preset, id) {
    if (!node) return false;

    const target = findOrAddRoom(model, node.addressIndex, preset, id);
    if (node.roomIndex === target.roomIndex) return false;

    node.roomIndex = target.roomIndex;
    node.backfilled = false;
    return true;
}

/** The room of that preset and id in an address, made if it is not there. */
function findOrAddRoom(model, addressIndex, preset, id) {
    const existing = model.rooms.find((room) => (
        room.addressIndex === addressIndex && room.preset === preset && room.id === id));

    return existing ?? appendRoom(model, addressIndex, preset, id);
}

/** Set a node's floor type and how far it is raised. */
export function setNodeFloor(model, node, floorType, height) {
    if (!node) return false;

    node.floorType = floorType;
    if (Number.isInteger(height)) node.height = height;
    return true;
}

/** Give a floor another address, showing nothing until something is painted into it. */
export function addAddress(model, layoutConfiguration, colour) {
    model.addresses.push({
        layoutConfiguration,
        colour: clone(colour) ?? { r: 0, g: 1, b: 1, a: 1 },
        variations: [{ raw: { r_d: [] } }],
        selectedVariation: 0,
    });

    return model.addresses.length - 1;
}

/** Give an address another room to paint with. */
export function addRoom(model, addressIndex, preset, id) {
    if (!model.addresses[addressIndex]) return null;
    return findOrAddRoom(model, addressIndex, preset, id);
}

/** An id no room of this address is using, for a room being added by hand. */
export function nextRoomId(model, addressIndex) {
    return model.rooms
        .filter((room) => room.addressIndex === addressIndex)
        .reduce((highest, room) => Math.max(highest, room.id + 1), 1);
}


/* -------------------------------------------------------------------------- */
/* Painting a tile                                                             */
/* -------------------------------------------------------------------------- */

/** What the tile tool is cycling. */
export const TileMode = {
    STAIRWELL: 'stairwell',
    ELEVATOR: 'elevator',
    ENTRANCE: 'entrance',
};

/**
 * Advance a tile one step through its cycle, as the game's own FloorEditController does.
 *
 * A stairwell goes on, turns through its four rotations, and comes off again; an
 * entrance goes on, becomes the main entrance, and comes off. Painting the other kind
 * over an existing stairwell converts it rather than making you clear the tile first,
 * which is the one place the reference tool improves on the game and is kept.
 */
export function paintTile(tile, mode) {
    if (!tile) return false;

    if (mode === TileMode.ENTRANCE) {
        if (!tile.isEntrance) tile.isEntrance = true;
        else if (!tile.isMainEntrance) tile.isMainEntrance = true;
        else { tile.isEntrance = false; tile.isMainEntrance = false; }
        return true;
    }

    const inverted = mode === TileMode.ELEVATOR;

    if (!tile.isStairwell) {
        tile.isStairwell = true;
        tile.isInverted = inverted;
        tile.stairwellRotation = 0;
    } else if (tile.isInverted !== inverted) {
        tile.isInverted = inverted;
    } else if (tile.stairwellRotation < 270) {
        tile.stairwellRotation += 90;
    } else {
        tile.isStairwell = false;
        tile.isInverted = false;
        tile.stairwellRotation = 0;
    }

    return true;
}


/* -------------------------------------------------------------------------- */
/* Walls                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The wall between a node and its neighbour along an axis.
 *
 * Reports the low side's preset, and says whether the two halves agree -- a caller
 * drawing the wall wants the former, and one reporting on the floor wants the latter.
 */
export function getWall(model, x, y, axis) {
    const step = AXES[axis];
    if (!step || !inGrid(x, y) || !inGrid(x + step.dx, y + step.dy)) return null;

    const low = halfWallOn(nodeAt(model, x, y), axis, WALL_OFFSET);
    const high = halfWallOn(nodeAt(model, x + step.dx, y + step.dy), axis, -WALL_OFFSET);
    if (!low && !high) return null;

    return {
        preset: low?.preset ?? high.preset,
        matched: !!low && !!high && low.preset === high.preset,
    };
}

/**
 * Put a wall between a node and its neighbour, on both of them.
 *
 * The single most likely way to write a corrupt floor is to record a wall on one node
 * and not the other, which the game half-renders. Every write goes through here, and
 * here always writes both halves.
 */
export function setWall(model, x, y, axis, preset) {
    const ends = wallEnds(model, x, y, axis);
    if (!ends) return false;

    const [low, high] = ends;
    removeHalfWall(low, axis, WALL_OFFSET);
    removeHalfWall(high, axis, -WALL_OFFSET);

    const { dx, dy } = AXES[axis];
    low.walls.push({ ox: offset(dx), oy: offset(dy), preset });
    high.walls.push({ ox: offset(-dx), oy: offset(-dy), preset });
    return true;
}

/**
 * A wall's offset along one axis. Written the long way because negating a zero gives
 * -0, which compares unequal to the 0 every wall read from a file carries -- a
 * difference invisible in the JSON and visible in every test that compares two floors.
 */
const offset = (step) => (step === 0 ? 0 : step * WALL_OFFSET);

/** Take a wall out, from both of the nodes it sits between. */
export function clearWall(model, x, y, axis) {
    const ends = wallEnds(model, x, y, axis);
    if (!ends) return false;

    removeHalfWall(ends[0], axis, WALL_OFFSET);
    removeHalfWall(ends[1], axis, -WALL_OFFSET);
    return true;
}

/** The pair of nodes a wall would sit between, or null if it would leave the grid. */
function wallEnds(model, x, y, axis) {
    const step = AXES[axis];
    if (!step) return null;

    const low = nodeAt(model, x, y);
    const high = nodeAt(model, x + step.dx, y + step.dy);
    return low && high ? [low, high] : null;
}

function removeHalfWall(node, axis, sign) {
    const component = axis === AXIS_X ? 'ox' : 'oy';
    node.walls = node.walls.filter((wall) => Math.sign(wall[component]) !== Math.sign(sign));
}


/* -------------------------------------------------------------------------- */
/* Variations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Show a different variation of one address.
 *
 * The variation being left is folded back into its stored form first, so edits made to
 * it survive the switch. Then the grid is rebuilt, because which nodes exist at all
 * depends on which variations are on show.
 */
export function selectVariation(model, addressIndex, variationIndex) {
    const address = model.addresses[addressIndex];
    if (!address) return false;
    if (variationIndex < 0 || variationIndex >= address.variations.length) return false;

    captureSelectedVariation(model, addressIndex);
    address.selectedVariation = variationIndex;
    rebuildGrid(model);
    return true;
}

/** Add an empty variation to an address and show it. */
export function addVariation(model, addressIndex) {
    const address = model.addresses[addressIndex];
    if (!address) return -1;

    captureSelectedVariation(model, addressIndex);
    address.variations.push({ raw: { r_d: [] } });
    address.selectedVariation = address.variations.length - 1;
    rebuildGrid(model);
    return address.selectedVariation;
}

/** Copy the shown variation of an address and show the copy. */
export function duplicateVariation(model, addressIndex) {
    const address = model.addresses[addressIndex];
    if (!address || address.selectedVariation < 0) return -1;

    captureSelectedVariation(model, addressIndex);
    const source = address.variations[address.selectedVariation];
    address.variations.push({ raw: clone(source.raw) });
    address.selectedVariation = address.variations.length - 1;
    rebuildGrid(model);
    return address.selectedVariation;
}

/**
 * Drop a variation.
 *
 * Removing the last one is allowed: six base game addresses already have none, and the
 * grid treats such an address as covering nothing. The nodes it held become gaps and
 * are backfilled as Outside on the next rebuild.
 */
export function removeVariation(model, addressIndex, variationIndex) {
    const address = model.addresses[addressIndex];
    if (!address) return false;
    if (variationIndex < 0 || variationIndex >= address.variations.length) return false;

    if (variationIndex !== address.selectedVariation) captureSelectedVariation(model, addressIndex);
    address.variations.splice(variationIndex, 1);

    address.selectedVariation = address.variations.length === 0
        ? -1
        : Math.min(address.selectedVariation, address.variations.length - 1);

    rebuildGrid(model);
    return true;
}

/**
 * Fold the grid back into one address's selected variation.
 *
 * This is what makes a variation that is no longer on show still hold the edits made
 * while it was, and it is the same rebuild the serialiser does.
 */
function captureSelectedVariation(model, addressIndex) {
    const address = model.addresses[addressIndex];
    if (!address || address.selectedVariation < 0) return;
    address.variations[address.selectedVariation].raw = buildVariation(model, addressIndex);
}


/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The model as a blueprint the game can load.
 *
 * Every address's selected variation is rebuilt from the grid. Every other variation is
 * written back exactly as it was read, which is the difference between this and the
 * reference tool -- it writes one variation and drops the rest.
 */
export function serialiseFloor(model) {
    return {
        floorName: model.floorName,
        size: clone(model.size),
        defaultFloorHeight: model.defaultFloorHeight,
        defaultCeilingHeight: model.defaultCeilingHeight,
        a_d: model.addresses.map((address, addressIndex) => ({
            p_n: address.layoutConfiguration,
            e_c: clone(address.colour),
            vs: address.variations.map((variation, variationIndex) => (
                variationIndex === address.selectedVariation
                    ? buildVariation(model, addressIndex)
                    : clone(variation.raw)
            )),
        })),
        // Field order is the game's own -- s_r before e_l, which reads like a mistake
        // and is not one. Nothing parses JSON by key order, but matching it keeps the
        // diff between a floor the game wrote and a floor this app wrote to the lines
        // that actually changed.
        t_d: model.tiles.map((tile) => ({
            f_c: { x: tile.x, y: tile.y },
            i_e: tile.isEntrance,
            m_e: tile.isMainEntrance,
            s_t: tile.isStairwell,
            s_r: tile.stairwellRotation,
            e_l: tile.isInverted,
            e_r: tile.elevatorRotation,
        })),
    };
}

/**
 * One address's selected variation, rebuilt from whatever the grid now says is its.
 *
 * Each room emits the nodes it was read holding, in that order, skipping any that have
 * since been painted away; nodes that have arrived since follow, in grid order. That is
 * what lets an unedited floor come back out node for node as it went in, given that no
 * single traversal reproduces the order the game writes.
 *
 * A room holding no nodes is kept. 695 of the base game's 2,872 rooms are empty -- one
 * in four, and every floor has some -- so an empty room is ordinary data rather than
 * debris, and dropping them would rewrite every floor the editor opened. Removing a
 * room is something the author does on purpose, not something saving decides.
 */
function buildVariation(model, addressIndex) {
    const rooms = roomsOfAddress(model, addressIndex);
    const claimed = new Set();

    const built = rooms.map((room) => {
        const nodes = [];

        for (const key of room.order) {
            const [x, y] = key.split(',').map(Number);
            const node = nodeAt(model, x, y);
            if (!node || node.addressIndex !== addressIndex || node.roomIndex !== room.roomIndex) {
                continue;
            }
            nodes.push(saveNode(node));
            claimed.add(key);
        }

        return { room, nodes };
    });

    // Anything the grid gives this address that no room listed: painted in since the
    // floor was read, or backfilled. Grid order, since they have no order of their own.
    const byRoom = new Map(built.map((entry) => [entry.room.roomIndex, entry.nodes]));
    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            const node = nodeAt(model, x, y);
            if (!node || node.addressIndex !== addressIndex) continue;
            if (claimed.has(coordKey(x, y))) continue;

            const nodes = byRoom.get(node.roomIndex);

            // A node pointing at a room this address does not have would be dropped
            // here without a word, which is the exact failure this file exists to
            // prevent. Nothing should be able to produce one; say so if it does.
            if (!nodes) {
                throw new Error(
                    `Node (${x}, ${y}) belongs to address ${addressIndex} room `
                    + `${node.roomIndex}, which does not exist`);
            }

            nodes.push(saveNode(node));
        }
    }

    return {
        r_d: built.map((entry) => ({
            id: entry.room.id, n_d: entry.nodes, l: entry.room.preset,
        })),
    };
}

/** One node in the game's shape. `f_r` goes back out as it came in. */
function saveNode(node) {
    return {
        f_c: { x: node.x, y: node.y },
        f_h: node.height,
        f_t: node.floorType,
        f_r: node.forcedRoom,
        w_d: node.walls.map((wall) => ({
            w_o: { x: wall.ox, y: wall.oy },
            p_n: wall.preset,
        })),
    };
}


/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What is wrong with a floor, in a form the editor can show.
 *
 * All three are conditions the base game's own floors contain, so none of them is
 * fatal and none is repaired behind the author's back.
 */
export function describeIssues(model) {
    const { overlaps, gaps, wallMismatches } = model.issues;
    const notes = [];

    if (overlaps.length) {
        notes.push(`${overlaps.length} node(s) claimed by more than one address`);
    }
    if (gaps.length) {
        notes.push(`${gaps.length} node(s) had no address and were filled in as Outside`);
    }
    if (wallMismatches.length) {
        notes.push(`${wallMismatches.length} wall(s) disagree between their two sides`);
    }

    return notes;
}
