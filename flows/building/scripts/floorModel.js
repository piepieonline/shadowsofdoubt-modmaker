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

/**
 * The layout configurations that are not inside a building.
 *
 * `DataBuilder.OutdoorLayoutConfigurations` in the reference tool, and six hardcoded
 * strings there as here. The game does not ask a name: it reads `NewAddress.isOutside`
 * and each room's `IsOutside()`, neither of which survives into the saved file, so a
 * list is the only thing a tool reading a blueprint can go on. An outdoor layout the
 * game adds and this does not know about is an address that reads as indoors -- which
 * matters wherever "is this square inside the building" is being asked, so it lives with
 * the model rather than beside any one of the things asking.
 */
export const OUTDOOR_LAYOUT_CONFIGURATIONS = new Set([
    'Outside', 'Park', 'Path', 'Yard', 'FathomsYard', 'StreetFrontage',
]);

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

const clone = (value) => structuredClone(value);


/* -------------------------------------------------------------------------- */
/* The colours addresses and rooms are drawn in                                */
/* -------------------------------------------------------------------------- */

/**
 * The colours handed out to addresses and to rooms, in the order they are handed out.
 *
 * Twelve pastels, no two of them closer than 19 in CIE L*a*b*, against the 2 or so at
 * which two colours stop being one colour -- far enough apart to be told apart at a glance
 * rather than by comparison. Pastel because a floor is read as flat sheets of these with
 * labels standing on them: at full saturation it is the labels that suffer, and the
 * outline every glyph is given (see scene.js) is what has to make up the difference.
 *
 * The order is deliberately not a walk around the hue circle. Neighbours in this list sit
 * on opposite sides of it, which does two things. Two addresses created one after the
 * other never come out looking similar. And -- because rooms take this list from the back,
 * where an address takes it from the front -- the colour at slot i and the colour at slot
 * 11 - i are far apart at every position, so switching between the address tool and the
 * room tool repaints the floor into something unmistakably different rather than into a
 * near neighbour of what was there. That switch is the only thing saying which of the two
 * a click is about to paint, so it has to be impossible to miss.
 *
 * Twelve is a cycle rather than a limit, and it is the number that makes the cycle rare:
 * the base game's busiest floor has 13 addresses, and its busiest address 12 rooms, so a
 * room list never repeats a colour and an address list only just can.
 */
export const PAINT_PALETTE = [
    { r: 0.947, g: 0.585, b: 0.573, a: 1 }, // salmon
    { r: 0.518, g: 0.733, b: 0.922, a: 1 }, // sky
    { r: 0.898, g: 0.835, b: 0.422, a: 1 }, // mustard
    { r: 0.813, g: 0.708, b: 0.932, a: 1 }, // lilac
    { r: 0.544, g: 0.856, b: 0.586, a: 1 }, // mint
    { r: 0.960, g: 0.680, b: 0.792, a: 1 }, // blossom
    { r: 0.449, g: 0.791, b: 0.723, a: 1 }, // teal
    { r: 0.856, g: 0.544, b: 0.814, a: 1 }, // orchid
    { r: 0.801, g: 0.932, b: 0.708, a: 1 }, // lime
    { r: 0.584, g: 0.594, b: 0.896, a: 1 }, // periwinkle
    { r: 0.953, g: 0.726, b: 0.527, a: 1 }, // peach
    { r: 0.676, g: 0.891, b: 0.924, a: 1 }, // aqua
];

/**
 * The colour of the address in a given slot, read from the front of the palette.
 *
 * A fresh object each time. An address owns its colour -- the picker in the address panel
 * writes over it in place -- so handing out the palette entry itself would let one address
 * recolour every other address sharing it, and the palette with them.
 */
export function addressColour(index) {
    return { ...PAINT_PALETTE[index % PAINT_PALETTE.length] };
}

/**
 * The colour of the room in a given slot, read from the *back* of the palette.
 *
 * Rooms hold no colour of their own: the game's format has nowhere to put one, so this is
 * the whole of what a room is coloured by, derived from its slot every time it is drawn.
 * Slots are per address, so the third room of one address and the third room of another
 * come out the same colour -- the room overlay is there to tell apart the rooms of the
 * address being painted with, and it buys the guarantee above, that no room is ever the
 * colour the address under it would have been.
 */
export function roomColour(roomIndex) {
    return { ...PAINT_PALETTE[PAINT_PALETTE.length - 1 - (roomIndex % PAINT_PALETTE.length)] };
}

/**
 * An address's stored colour, unless it has none it can be seen by.
 *
 * A floor is drawn as flat sheets of these, so a black address is a hole in the plan
 * rather than an address, and one with no colour at all is worse -- it would take the
 * one default every other colourless address gets. Both are given their slot's palette
 * colour instead.
 *
 * This is a repair and not a display trick: the colour it lands on is written back the
 * next time the floor is saved. Nothing in the base game needs it -- all 602 of its
 * addresses carry a colour and none is black -- so what it covers is floors written
 * somewhere else.
 */
function paintableColour(stored, index) {
    if (!stored) return addressColour(index);

    const invisible = (stored.r ?? 0) === 0 && (stored.g ?? 0) === 0 && (stored.b ?? 0) === 0;
    return invisible ? addressColour(index) : clone(stored);
}


/* -------------------------------------------------------------------------- */
/* A floor to start from                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The layout and the room a blank floor's interior is, and the wall around it.
 *
 * All three are the game's own names: `Lobby` is a LayoutConfiguration and a
 * RoomTypePreset both, and `0` is DefaultWalls in the door pair table. A floor naming
 * anything the game does not have is a floor it will not load, so a starting point may
 * only use names it does.
 */
const LOBBY = 'Lobby';
const DEFAULT_WALLS = '0';

/** FloorTileType.floorAndCeiling -- an interior anyone can stand in. */
const FLOOR_AND_CEILING = 1;

/**
 * A floor to start editing, rather than an empty grid.
 *
 * The margin is what every base game floor has -- three nodes of nothing on each side,
 * the gap the city leaves between one lot and the next -- and it is not paintable, so a
 * floor without it would open with a border that could never be filled in. Inside it is
 * one room covering the whole lot, walled off from the margin: a floor that would load,
 * that can be walked into, and that is one flood fill away from being something else.
 *
 * This is where a floor with nothing under it starts. One added above a floor that has
 * already been drawn starts from that floor's walls instead -- see floorLike.
 */
export function blankFloor(floorName) {
    return startingFloor(
        floorName,
        { size: { x: 1, y: 1 }, defaultFloorHeight: 0, defaultCeilingHeight: 42 },
        (x, y) => ({ inside: isPaintable(x, y), walls: boundaryWalls(x, y) }));
}

/**
 * A floor with the walls of another and nothing else of it.
 *
 * What a floor added above an existing one starts as. A building is one shape all the
 * way up -- its exterior wall is where the model of it says it is, on every storey --
 * so a floor added on top of one that has already been drawn starts from that shape
 * rather than from the whole lot. The alternative is redrawing the same outline once
 * per storey and having the building come out wrong wherever that went slightly
 * differently.
 *
 * The walls come across; what is *in* them does not. Rooms, layout configurations,
 * node heights and every tile flag start where a blank floor starts, because those are
 * what makes one storey different from another -- copying the storey below's offices,
 * its stairwell and its street entrance up onto the next floor would be a duplicate
 * rather than a starting point, and each of them is wrong in a way that is easy to miss
 * once it is already there.
 *
 * Everything inside the walls is one Lobby, exactly as a blank floor is -- so the
 * interior partitions come through as drawn lines to fill in rather than as rooms.
 *
 * The lot size and the floor and ceiling heights are the source's: they describe the
 * building rather than the storey, and a floor that disagreed with the one below it on
 * any of them is a storey of a different building. Node heights are not -- `f_h` is a
 * step or a plinth in one storey's floor, which is content like the room it is part of.
 *
 * How much of the source comes across is the author's answer to what a new storey
 * starts as, asked when the floor is added:
 *
 * @param outline only the walls between inside and out -- the building's shell, with
 *                the interior partitions dropped. The lot's own boundary is kept: it is
 *                the edge of the plot rather than anything drawn on this storey, and a
 *                blank floor starts with it too.
 * @param tiles   the 7 x 7 tile grid: stairwells and their rotation, and the entrances.
 *                A stairwell has to sit in the same tile on every storey it passes
 *                through, so carrying it is what stops it being placed again by eye.
 */
export function floorLike(floorName, sourceData, { outline = false, tiles = false } = {}) {
    const source = parseFloor(sourceData);

    // The margin is never inside, whatever the source says. It is not paintable, so an
    // interior square there is one the editor could never reach -- and the six base game
    // floors that stop short of the full grid show that a blueprint's own idea of its
    // edges is not to be trusted.
    const insideAt = (x, y) => {
        const node = nodeAt(source, x, y);
        return isPaintable(x, y) && !!node && !isOutdoors(source, node);
    };

    /**
     * Whether a wall is part of the outline: it has different things on its two sides.
     *
     * Read from the wall's offset, which points at the neighbour it sits against. Both
     * halves of one wall answer the same, because the question is about the pair of
     * nodes rather than about either of them -- so a wall is kept on both sides or on
     * neither, and the pairs stay matched.
     */
    const isOutlineWall = (x, y, wall) => {
        const dx = Math.sign(wall.ox);
        const dy = Math.sign(wall.oy);

        return insideAt(x, y) !== insideAt(x + dx, y + dy)
            || isPaintable(x, y) !== isPaintable(x + dx, y + dy);
    };

    return startingFloor(
        floorName,
        {
            size: clone(source.size),
            defaultFloorHeight: source.defaultFloorHeight,
            defaultCeilingHeight: source.defaultCeilingHeight,
            tiles: tiles ? clone(sourceData?.t_d ?? []) : [],
        },
        (x, y) => {
            const node = nodeAt(source, x, y);
            return {
                inside: insideAt(x, y),
                // Verbatim, both halves. A wall is stored on each of the two nodes it
                // sits between, and every node is walked, so copying each node's list as
                // it stands keeps the pairs matched -- including the mismatched pairs the
                // base game itself contains, which are the source's data and not
                // something to silently repair here.
                walls: (node?.walls ?? [])
                    .filter((wall) => !outline || isOutlineWall(x, y, wall))
                    .map((wall) => ({
                        w_o: { x: wall.ox, y: wall.oy },
                        p_n: wall.preset,
                    })),
            };
        });
}

/**
 * A floor that is another floor under a different name.
 *
 * What Add layout writes. The blueprints in one floor setting are alternative layouts of
 * the *same* storey -- the game picks one when it builds the city -- so a new one is that
 * storey again, to be altered rather than drawn. Which is the opposite of floorLike's
 * reasoning and for the same reason: what makes two storeys differ is what is inside their
 * walls, so between two layouts of one storey that is exactly what has to come across.
 *
 * Everything comes: addresses with their layout configurations and colours, every room and
 * the nodes in it, node heights, tile flags, and each address's other variations. Copied
 * verbatim rather than rebuilt through the reader, so a base game floor duplicated here is
 * byte for byte the file the game shipped -- including the fields this model carries
 * without interpreting, like `f_r`, and any the game adds that it has never seen.
 *
 * The name is the one thing that changes. A floor is referred to by it, and two files
 * naming the same floor is one of them shadowing the other.
 */
export function floorCopy(floorName, sourceData) {
    return { ...clone(sourceData), floorName };
}

/**
 * Whether a square is outdoors, for the purpose of "where is this building's wall".
 *
 * Wider than isOutsideNode, which answers "is this filler": a Park or a Yard is a laid
 * out address with rooms in it, and it is still not inside the building. So the outdoor
 * layout configurations count here as well -- copying a ground floor's yard up onto the
 * next storey would put the floor above out over open air.
 */
function isOutdoors(model, node) {
    const address = model.addresses[node.addressIndex];
    if (OUTDOOR_LAYOUT_CONFIGURATIONS.has(address?.layoutConfiguration)) return true;

    return isOutsideNode(model, node);
}

/**
 * The two addresses a floor starts as, filled in by whatever decides each square.
 *
 * Built as data and put through the reader and the writer, so it comes out in exactly
 * the shape a saved floor is in -- 49 tiles included -- rather than in a second shape
 * that happens to look right.
 *
 * `dimensions.tiles` is the saved tile grid to start from, empty for the defaults. The
 * writer fills in all 49 either way; what is passed here decides which of them arrive
 * carrying a stairwell or an entrance.
 *
 * @param shape given a coordinate, whether it is inside and what walls it records
 */
function startingFloor(floorName, { tiles = [], ...dimensions }, shape) {
    const outside = [];
    const lobby = [];

    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            const { inside, walls } = shape(x, y);
            (inside ? lobby : outside).push({
                f_c: { x, y },
                f_h: 0,
                f_t: inside ? FLOOR_AND_CEILING : FLOOR_TYPE_NONE,
                f_r: '',
                w_d: walls,
            });
        }
    }

    return serialiseFloor(parseFloor({
        floorName,
        ...dimensions,
        a_d: [
            // The first two of the palette rather than the base game's own Outside red
            // and Lobby green, so that a floor started here is coloured by the same list
            // every address added to it afterwards is coloured by. The game reads this
            // field as the colour to draw the address in and nothing else.
            {
                p_n: OUTSIDE_LAYOUT,
                e_c: addressColour(0),
                vs: [{ r_d: [{ id: 1, l: OUTSIDE_ROOM, n_d: outside }] }],
            },
            {
                p_n: LOBBY,
                e_c: addressColour(1),
                vs: [{ r_d: [{ id: 2, l: LOBBY, n_d: lobby }] }],
            },
        ],
        t_d: tiles,
    }));
}

/**
 * The half-walls a node records where it meets the margin.
 *
 * Written from both sides, because both sides are walked: the node inside the boundary
 * gets its half here and the node outside it gets its half when its own turn comes. A
 * wall recorded on one side only is the corrupt floor this module exists to avoid.
 */
function boundaryWalls(x, y) {
    const walls = [];

    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        if (!inGrid(x + dx, y + dy)) continue;
        if (isPaintable(x, y) === isPaintable(x + dx, y + dy)) continue;

        walls.push({ w_o: { x: offset(dx), y: offset(dy) }, p_n: DEFAULT_WALLS });
    }

    return walls;
}


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
            colour: paintableColour(address.e_c, index),
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
        // Whether the stairwell each kind of tile resolves to carries a lift, as
        // `{ plain, inverted }`. A fact about the *building* rather than about this floor
        // -- which stairwell preset stands in a tile is the BuildingPreset's to say -- so
        // it is filled in by whoever opened the floor knowing which building that was, and
        // is null in a model parsed on its own. See buildingLibrary.stairwellElevators,
        // and tileParts for what a tile says when nobody has looked it up.
        stairwellElevators: null,
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
 *
 * What the four stairwell fields mean, because their names do not say and one of them
 * says the wrong thing:
 *
 *   s_t  the tile carries a stairwell
 *   s_r  which way it faces, in degrees off the front of the building
 *   e_l  the stairwell is the *Inverted* preset -- the mirrored one, whose steps run the
 *        other way round. It is the asset the game picks, and nothing more: it does not
 *        say the tile is a lift rather than stairs, which is what every stairwell preset
 *        the game ships turns out to carry anyway. See tileParts.
 *   e_r  nothing. It is 0 on all 4,557 tiles of the 93 base game floors shipped here, and
 *        it is written back out because a field this app does not understand is not a
 *        field for it to drop.
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
                unusedElevatorRotation: 0,
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
        tile.unusedElevatorRotation = saved_.e_r ?? 0;
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
export function outsideAddressIndex(model) {
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

    // Ids are the game's, and clash within a variation in 58 places across the base
    // game, so they identify nothing on their own -- a room is addressed by its slot.
    // A fresh one still gets an unused id, because the game does read it.
    return findOrAddRoom(model, addressIndex, OUTSIDE_ROOM).roomIndex;
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

/**
 * The room in a slot, which is how everything that is not a name refers to one.
 *
 * A room is identified by the pair (address, slot) rather than by its preset and id.
 * Both of those can be shared: 24 rooms across 13 base game floors sit in the same
 * address's variation as another room with the same preset *and* the same id, so a name
 * and a number cannot tell two rooms apart even in principle.
 */
export function roomAt(model, addressIndex, roomIndex) {
    return model.rooms.find(
        (room) => room.addressIndex === addressIndex && room.roomIndex === roomIndex) ?? null;
}

/** The room a node belongs to. */
export function roomOfNode(model, node) {
    return node ? roomAt(model, node.addressIndex, node.roomIndex) : null;
}

/** The nodes on the grid that are in one room. */
function nodesOfRoom(model, addressIndex, roomIndex) {
    return model.nodes.filter((node) => node
        && node.addressIndex === addressIndex && node.roomIndex === roomIndex);
}

/**
 * Every cell reachable from one cell without crossing a wall.
 *
 * What a flood fill fills. The spread is bounded by walls and by nothing else: what is
 * already in a cell has no say, so an enclosure made of three different rooms becomes one
 * room in a single click. That is the point of it -- the alternative, spreading only
 * through cells that match the one clicked, needs a click per room to do the same thing
 * and cannot repair an enclosure that was carved up by accident.
 *
 * A wall of any kind stops it, including a door, a window and a wall recorded on one side
 * only. A door is an opening in the game and a boundary here for the same reason a wall
 * is: it is where the author drew the edge of the room.
 *
 * The margin is not crossed either. Those nodes cannot be painted -- see isPaintable --
 * so a fill that ran into them would either write where nothing may write or leak around
 * the outside of the floor and come back in somewhere else entirely.
 *
 * Returns `{x, y}` in the order they were reached, which is arbitrary but stable.
 */
export function floodRegion(model, startX, startY) {
    if (!model || !isPaintable(startX, startY) || !nodeAt(model, startX, startY)) return [];

    const seen = new Set([coordKey(startX, startY)]);
    const region = [];
    const queue = [{ x: startX, y: startY }];

    // The seam between a cell and each of its four neighbours. A wall along x at (x, y)
    // is the one between (x, y) and (x + 1, y), so stepping the other way asks about the
    // neighbour's slot rather than this one's.
    const steps = [
        { dx: 1, dy: 0, axis: AXIS_X, wallX: 0, wallY: 0 },
        { dx: -1, dy: 0, axis: AXIS_X, wallX: -1, wallY: 0 },
        { dx: 0, dy: 1, axis: AXIS_Y, wallX: 0, wallY: 0 },
        { dx: 0, dy: -1, axis: AXIS_Y, wallX: 0, wallY: -1 },
    ];

    while (queue.length) {
        const { x, y } = queue.shift();
        region.push({ x, y });

        for (const step of steps) {
            const nextX = x + step.dx;
            const nextY = y + step.dy;

            const key = coordKey(nextX, nextY);
            if (seen.has(key)) continue;
            if (!isPaintable(nextX, nextY) || !nodeAt(model, nextX, nextY)) continue;
            if (getWall(model, x + step.wallX, y + step.wallY, step.axis)) continue;

            seen.add(key);
            queue.push({ x: nextX, y: nextY });
        }
    }

    return region;
}

/**
 * Whether a node is filler rather than part of a room anyone laid out.
 *
 * Two names for the same idea, and the game uses both: the address named Outside, and a
 * room whose preset is Null. Every square of the margin is one, as is every square no
 * address claimed -- backfillOutside puts them there. Either mark is enough, because
 * either one is the game saying there is nothing here.
 *
 * Worth being able to ask, because "not a room" is a large majority of most floors and
 * anything drawing rooms wants to leave it out.
 */
export function isOutsideNode(model, node) {
    if (!node) return false;

    const address = model.addresses[node.addressIndex];
    if (address?.layoutConfiguration === OUTSIDE_LAYOUT) return true;

    return roomOfNode(model, node)?.preset === OUTSIDE_ROOM;
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
 * the same preset in the address being painted, and adding one if it has none.
 *
 * The visible behaviour is the reference's: the square carries the name of the room it
 * was in across. What differs is that the room it ends up in is genuinely the new
 * address's -- a room of that name it already had, or a new one with an id of its own.
 */
export function setNodeAddress(model, node, addressIndex) {
    if (!node || !model.addresses[addressIndex]) return false;
    if (node.addressIndex === addressIndex) return false;

    const room = roomOfNode(model, node);
    const target = findOrAddRoom(model, addressIndex, room?.preset ?? OUTSIDE_ROOM);

    node.addressIndex = addressIndex;
    node.roomIndex = target.roomIndex;
    node.backfilled = false;
    return true;
}

/**
 * Put a node in a room, named by the slot it sits in.
 *
 * A room belongs to an address, so painting a square that belongs to a *different*
 * address cannot put it in this room -- the square would name a room its own address
 * does not have, which is the one thing the writer refuses to serialise. It goes into
 * that address's room of the same preset instead, which is added with an id of its own
 * if it is not there. Painting a stroke across an address boundary therefore makes one
 * room on the other side of it, not one per square.
 *
 * The square stays in the address it was in. Painting a room is not a way of moving one
 * -- that is what the address tool is for.
 */
export function setNodeRoom(model, node, addressIndex, roomIndex) {
    const room = roomAt(model, addressIndex, roomIndex);
    if (!node || !room) return false;

    const target = node.addressIndex === addressIndex
        ? room
        : findOrAddRoom(model, node.addressIndex, room.preset);

    if (node.roomIndex === target.roomIndex) return false;

    node.roomIndex = target.roomIndex;
    node.backfilled = false;
    return true;
}

/**
 * The room of that preset in an address, made if it has none.
 *
 * Matched on the preset alone, because an id is no longer something two rooms can be
 * expected to share: one minted here is unused across the whole floor, so keying on it
 * would match nothing and make a room per square painted. An address holding two rooms
 * of one preset -- common, and Null especially -- hands over the first of them.
 */
function findOrAddRoom(model, addressIndex, preset) {
    const existing = model.rooms.find(
        (room) => room.addressIndex === addressIndex && room.preset === preset);

    return existing ?? appendRoom(model, addressIndex, preset, nextRoomId(model));
}

/** Set a node's floor type and how far it is raised. */
export function setNodeFloor(model, node, floorType, height) {
    if (!node) return false;

    node.floorType = floorType;
    if (Number.isInteger(height)) node.height = height;
    return true;
}

/**
 * Give a floor another address, showing nothing until something is painted into it.
 *
 * It arrives holding a Null room. A square has to be in a room, so an address with none
 * is one nothing can be painted into -- and Null is what the game calls a square that
 * has not been laid out, which is exactly what a new address's are.
 *
 * And it arrives with the colour of the slot it lands in, so that adding one is a single
 * click rather than a click and a colour to choose. `colour` overrides that; nothing in
 * the app passes one, since a floor being read comes through parseFloor instead.
 */
export function addAddress(model, layoutConfiguration, colour) {
    const addressIndex = model.addresses.length;

    model.addresses.push({
        layoutConfiguration,
        colour: clone(colour) ?? addressColour(addressIndex),
        variations: [{ raw: { r_d: [] } }],
        selectedVariation: 0,
    });

    appendRoom(model, addressIndex, OUTSIDE_ROOM, nextRoomId(model));
    return addressIndex;
}

/**
 * The room an address's layout configuration is named after, if it is a room at all.
 *
 * 19 of the game's 32 LayoutConfigurations share a name with a RoomTypePreset -- Lobby,
 * Ballroom, Rooftop, Yard -- and an address of one of those almost always holds a room
 * of that name. Adding it is the difference between a new address that can be painted
 * with and one whose only room is Null.
 *
 * Only while the address is still nothing but the empty Null room it was created with,
 * which is what keeps this part of adding an address rather than a side effect of
 * renaming one: the layout is chosen in the moments after the address appears, and by
 * the time anything is in it the author is editing rather than creating.
 *
 * The preset names come from the caller. Reference data belongs to the panels; this
 * file knows what a room is and not which ones the game ships.
 */
export function seedRoomForLayout(model, addressIndex, roomPresets = []) {
    const address = model.addresses[addressIndex];
    if (!address || !roomPresets.includes(address.layoutConfiguration)) return null;

    const rooms = roomsOfAddress(model, addressIndex);
    if (rooms.length !== 1 || rooms[0].preset !== OUTSIDE_ROOM) return null;
    if (nodesOfRoom(model, addressIndex, rooms[0].roomIndex).length > 0) return null;

    return appendRoom(model, addressIndex, address.layoutConfiguration, nextRoomId(model));
}

/**
 * Take an address off the floor, and hand its squares back to Outside.
 *
 * An address is a slot -- a square names the one it belongs to by position in the list,
 * and so does every room -- so removing one shifts every address above it down by one,
 * on the addresses, the rooms, the squares and the overlaps alike. That renumbering is
 * the whole risk here: a square left naming its old slot would silently belong to a
 * different address than the one it was painted with.
 *
 * The squares it held go to the Outside address's Null room, which is where removing a
 * room sends them and what backfill puts an unclaimed square in. They are not dropped:
 * a square has to be in a room its own address has, and one that is not is the single
 * error serialising refuses to write.
 *
 * Outside itself cannot go. It is the floor's fallback -- every unclaimed square, every
 * square of a removed address and every square of a removed room ends up in it -- so a
 * floor without one has nowhere to put the things it is asked to hold.
 */
export function removeAddress(model, addressIndex) {
    if (!model.addresses[addressIndex]) return false;

    const outside = outsideAddressIndex(model);
    if (addressIndex === outside) return false;

    // Before the splice, while both indices still mean what they say. The room is found
    // or made in Outside, exactly as backfill would.
    const held = model.nodes.filter((node) => node?.addressIndex === addressIndex);
    if (held.length) {
        const fallback = findOrAddRoom(model, outside, OUTSIDE_ROOM);
        for (const node of held) {
            node.addressIndex = fallback.addressIndex;
            node.roomIndex = fallback.roomIndex;
            node.backfilled = false;
        }
    }

    model.addresses.splice(addressIndex, 1);
    model.rooms = model.rooms.filter((room) => room.addressIndex !== addressIndex);

    // An overlap is two addresses claiming one square. With one of them gone the square
    // is claimed once, so the pair goes rather than being renumbered to a survivor.
    model.issues.overlaps = model.issues.overlaps.filter(
        (overlap) => overlap.heldBy !== addressIndex && overlap.alsoClaimedBy !== addressIndex);

    const shift = (index) => (index > addressIndex ? index - 1 : index);
    for (const room of model.rooms) room.addressIndex = shift(room.addressIndex);
    for (const node of model.nodes) if (node) node.addressIndex = shift(node.addressIndex);
    for (const overlap of model.issues.overlaps) {
        overlap.heldBy = shift(overlap.heldBy);
        overlap.alsoClaimedBy = shift(overlap.alsoClaimedBy);
    }

    return true;
}

/** How many squares an address holds, which is what removing it would move to Outside. */
export function nodesOfAddress(model, addressIndex) {
    return model.nodes.filter((node) => node?.addressIndex === addressIndex);
}

/**
 * Give an address another room to paint with.
 *
 * Always another one, even when the address already has a room of that preset. Two
 * rooms of one name in an address is ordinary -- 695 of the base game's rooms are Null
 * -- and a button labelled "Add room" that sometimes adds nothing is worse than a list
 * with two rows in it.
 */
export function addRoom(model, addressIndex, preset) {
    if (!model.addresses[addressIndex]) return null;
    return appendRoom(model, addressIndex, preset, nextRoomId(model));
}

/**
 * Take a room out of an address, and put whatever was in it somewhere it can live.
 *
 * A square has to be in a room its own address has -- one that is not is the single
 * error serialising refuses to write -- so removing a room that holds squares moves
 * them rather than dropping them. They go to a Null room, which is what the game calls
 * a square that is not laid out and what backfill puts an unclaimed one in.
 *
 * Which Null room, in order: another one in this address, then the Outside address's,
 * then a new one made here. The second is what removing an address's *only* Null room
 * means -- those squares stop being this address's, exactly as if the file had never
 * covered them -- and the third is reached only when the room being removed is Outside's
 * own, where there is nowhere further to hand them to.
 *
 * Rooms are slots and a square names its room by slot, so every slot above the one
 * removed shifts down by one, on the rooms and on the squares alike.
 */
export function removeRoom(model, addressIndex, roomIndex) {
    const room = roomAt(model, addressIndex, roomIndex);
    if (!room) return false;

    const held = nodesOfRoom(model, addressIndex, roomIndex);

    if (held.length) {
        const fallback = nullRoomBesides(model, addressIndex, room)
            ?? nullRoomBesides(model, outsideAddressIndex(model), room)
            ?? appendRoom(model, addressIndex, OUTSIDE_ROOM, nextRoomId(model));

        for (const node of held) {
            node.addressIndex = fallback.addressIndex;
            node.roomIndex = fallback.roomIndex;
            node.backfilled = false;
        }
    }

    model.rooms.splice(model.rooms.indexOf(room), 1);

    for (const entry of model.rooms) {
        if (entry.addressIndex === addressIndex && entry.roomIndex > roomIndex) entry.roomIndex--;
    }
    for (const node of model.nodes) {
        if (node && node.addressIndex === addressIndex && node.roomIndex > roomIndex) {
            node.roomIndex--;
        }
    }

    return true;
}

/** A Null room of an address, other than the one on its way out. */
function nullRoomBesides(model, addressIndex, exclude) {
    return model.rooms.find((room) => room.addressIndex === addressIndex
        && room !== exclude && room.preset === OUTSIDE_ROOM) ?? null;
}

/**
 * An id no room in this floor is using.
 *
 * Floor-wide, and counted over every variation rather than the ones on show: an id has
 * to still be unused when a variation nobody is looking at comes back into view. The
 * game's own floors reuse ids freely -- 693 rooms across 70 base game floors share one
 * with another room in the same file, and only 709 distinct ids cover all 2,872 rooms it
 * ships -- so this is what rooms made *here* get, not a rule the data is held to. An id
 * that arrives in a file is left exactly as it is.
 */
export function nextRoomId(model) {
    let highest = 0;

    for (const room of model.rooms) highest = Math.max(highest, room.id ?? 0);

    for (const address of model.addresses) {
        for (const variation of address.variations) {
            for (const room of variation.raw?.r_d ?? []) highest = Math.max(highest, room.id ?? 0);
        }
    }

    return highest + 1;
}


/* -------------------------------------------------------------------------- */
/* Painting a tile                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What the tile tool is changing.
 *
 * Two of the three are cycles and one is a toggle. Inverted is a stairwell too -- the
 * mirrored preset, which is the whole of what `e_l` chooses -- but it is one fact about a
 * stairwell rather than a kind of its own, so the mode that paints it turns that fact on
 * and off and leaves the rest of the tile as it found it. See paintTile.
 */
export const TileMode = {
    STAIRWELL: 'stairwell',
    INVERTED: 'inverted',
    ENTRANCE: 'entrance',
};

/**
 * What a tile carries, one line per thing, in the order a tile is read.
 *
 * A list rather than a sentence because the three places that say it lay it out
 * differently: the status column and the hover label want one line, and the label written
 * on the tile in the view wants a line each, on a square three cells wide. Joining is the
 * caller's; what a tile *is* is here, so none of them can end up calling a stairwell
 * something the others do not.
 *
 * A stairwell is three lines, and they answer three separate questions:
 *
 *   Stairs 90°  that there is a stairwell, and which way it faces. Always "Stairs": what
 *               stands in the tile is a stairwell whatever preset it is, and the file says
 *               nothing else about it.
 *   Inverted    `e_l`, which picks the mirrored preset -- WoodenStairwellElevatorInverted
 *               rather than WoodenStairwellElevator. Its own line because it is a fact
 *               about the tile, and the one a click on the tile tool changes.
 *   Elevator    that the preset standing there carries a lift, which is a fact about the
 *               *building's* stairwell preset and not about this tile at all. Every
 *               StairwellPreset the game ships has featuresElevator true, so this is
 *               ordinarily said of every stairwell; only a mod defining its own can turn
 *               it off. See buildingLibrary.stairwellElevators.
 *
 * The middle and last are written as empty lines when they do not apply, so that the three
 * rows of a label line up across the tiles of a floor rather than sliding up under each
 * other. That is the view's need alone: the two callers that join to one line drop the
 * empties first, because "Stairs 90° ·  · " is a line with holes punched in it.
 *
 * The rotation is a figure measured from the front of the building -- see the arrow off
 * the front edge in the view -- and is said on the stairwell rather than beside it,
 * because it is the stairwell's and a tile can carry an entrance as well.
 *
 * Empty for a tile that carries nothing, which is not the same as the word "Nothing":
 * saying so is for a field that must say something, and a label over an empty tile is
 * better off not being drawn.
 *
 * @param stairwellElevators the model's, or nothing at all for a tile being read outside
 *                           any building. Absent reads as a lift, because that is what
 *                           every stairwell the game ships has.
 */
export function tileParts(tile, stairwellElevators = null) {
    if (!tile) return [];

    const parts = [];

    if (tile.isStairwell) {
        parts.push(`Stairs ${tile.stairwellRotation ?? 0}°`);
        parts.push(tile.isInverted ? 'Inverted' : '');
        parts.push(hasElevator(tile, stairwellElevators) ? 'Elevator' : '');
    }

    if (tile.isMainEntrance) parts.push('Main entrance');
    else if (tile.isEntrance) parts.push('Entrance');

    return parts;
}

/**
 * Whether the stairwell standing in this tile carries a lift.
 *
 * Two answers rather than one, because `e_l` picks between two presets when the building
 * names none of its own -- so a mod can define the mirrored one with featuresElevator off
 * and leave the other alone.
 */
const hasElevator = (tile, stairwellElevators) => (
    (tile.isInverted ? stairwellElevators?.inverted : stairwellElevators?.plain) ?? true);

/**
 * Advance a tile one step through its cycle, as the game's own FloorEditController does.
 *
 * A stairwell goes on, turns through its four rotations, and comes off again; an entrance
 * goes on, becomes the main entrance, and comes off.
 *
 * **Inverted is a toggle rather than a cycle.** A click in that mode turns the mirroring
 * on or off and changes nothing else: not the rotation, and not whether there is a
 * stairwell there at all. It used to be a third cycle -- a click on an already-inverted
 * stairwell turned it, and a fifth click took it away -- which made mirroring a stairwell
 * you had already aimed a job of counting clicks, because one click too many spun it off
 * its rotation and one more removed it.
 *
 * The two cycles therefore leave each other's fact alone, which is what makes either one
 * safe to click twice: the rotation is the stairwell cycle's and the mirroring is the
 * toggle's, and neither is an answer to the other's question. A stairwell is turned by
 * the stairwell cycle whether it is mirrored or not.
 *
 * The one thing each still does to the other's fact is at the ends, where there is no
 * stairwell for the fact to be about: a tile with nothing on it gets one, mirrored or
 * plain to match the mode -- placing is the only way into the toggle -- and a stairwell
 * cycled off clears the mirroring with it, because a tile carrying no stairwell is not
 * carrying a mirrored one.
 */
export function paintTile(tile, mode) {
    if (!tile) return false;

    if (mode === TileMode.ENTRANCE) {
        if (!tile.isEntrance) tile.isEntrance = true;
        else if (!tile.isMainEntrance) tile.isMainEntrance = true;
        else { tile.isEntrance = false; tile.isMainEntrance = false; }
        return true;
    }

    if (mode === TileMode.INVERTED) {
        if (tile.isStairwell) tile.isInverted = !tile.isInverted;
        else {
            tile.isStairwell = true;
            tile.isInverted = true;
            tile.stairwellRotation = 0;
        }
        return true;
    }

    if (!tile.isStairwell) {
        tile.isStairwell = true;
        tile.isInverted = false;
        tile.stairwellRotation = 0;
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
        // Field order is the game's own, down to `e_r` -- which means nothing to the game
        // or to this app and is written anyway, because a floor that went through this
        // editor should come back out as the file it went in as. Nothing parses JSON by
        // key order, but matching it keeps the diff between a floor the game wrote and a
        // floor this app wrote to the lines that actually changed.
        t_d: model.tiles.map((tile) => ({
            f_c: { x: tile.x, y: tile.y },
            i_e: tile.isEntrance,
            m_e: tile.isMainEntrance,
            s_t: tile.isStairwell,
            s_r: tile.stairwellRotation,
            e_l: tile.isInverted,
            e_r: tile.unusedElevatorRotation,
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
    return {
        r_d: variationNodeKeys(model, addressIndex).map(({ room, keys }) => ({
            id: room.id,
            n_d: keys.map((key) => saveNode(nodeAt(model, ...parseKey(key)))),
            l: room.preset,
        })),
    };
}

/**
 * Which nodes each of an address's rooms will be written holding, in the order they will
 * be written in.
 *
 * Split out from the serialiser because two callers need this order and they must not be
 * able to disagree about it. The other is `nodeSaveOrder`, which is what tells a divider
 * end which way round the game will build it -- an orientation read off one traversal and
 * a file written by another would put the post on the side the editor did not draw.
 */
function variationNodeKeys(model, addressIndex, { onOrphan = 'throw' } = {}) {
    const rooms = roomsOfAddress(model, addressIndex);
    const claimed = new Set();

    const built = rooms.map((room) => {
        const keys = [];

        for (const key of room.order) {
            const [x, y] = parseKey(key);
            const node = nodeAt(model, x, y);
            if (!node || node.addressIndex !== addressIndex || node.roomIndex !== room.roomIndex) {
                continue;
            }
            keys.push(key);
            claimed.add(key);
        }

        return { room, keys };
    });

    // Anything the grid gives this address that no room listed: painted in since the
    // floor was read, or backfilled. Grid order, since they have no order of their own.
    const byRoom = new Map(built.map((entry) => [entry.room.roomIndex, entry.keys]));
    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            const node = nodeAt(model, x, y);
            if (!node || node.addressIndex !== addressIndex) continue;

            const key = coordKey(x, y);
            if (claimed.has(key)) continue;

            const keys = byRoom.get(node.roomIndex);

            // A node pointing at a room this address does not have would be dropped
            // here without a word, which is the exact failure this file exists to
            // prevent. Nothing should be able to produce one; say so if it does --
            // except while drawing, which cannot take the scene down over one bad node.
            if (!keys) {
                if (onOrphan === 'skip') continue;
                throw new Error(
                    `Node (${x}, ${y}) belongs to address ${addressIndex} room `
                    + `${node.roomIndex}, which does not exist`);
            }

            keys.push(key);
        }
    }

    return built;
}

/** `coordKey` undone. */
const parseKey = (key) => key.split(',').map(Number);

/**
 * Every node on the grid, ranked by where saving will write it.
 *
 * The game builds a wall from whichever of the two nodes it sits between it reaches
 * first, and it reads a blueprint in the order the file lists it -- address by address,
 * room by room, node by node. So this order is not a detail of the format: it decides
 * which way a wall faces, and a divider end's post goes on whichever side that facing
 * makes its left. `dividerEnds.js` is the rest of that.
 *
 * Built from what saving *will* write rather than from what loading read, because an
 * author who paints a square changes it. A node with no rank -- off the grid, or orphaned
 * from its room -- sorts last, which is where saving would put it.
 */
export function nodeSaveOrder(model) {
    const rank = new Map();
    let next = 0;

    model.addresses.forEach((_, addressIndex) => {
        for (const { keys } of variationNodeKeys(model, addressIndex, { onOrphan: 'skip' })) {
            for (const key of keys) rank.set(key, next++);
        }
    });

    return rank;
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
