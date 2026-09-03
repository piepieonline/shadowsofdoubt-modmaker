/**
 * Turning a storey into the roof over it.
 *
 * `DataBuilder.GenerateRoof` in the reference tool, and the same idea: a roof is not
 * drawn, it is derived. Where the storey below is indoors there is something to stand on
 * and open sky above it; everywhere else there is nothing at all. So the shape of the
 * building is the whole of the input, and every field the roof carries follows from it.
 *
 * What the game's own rooftops look like is what this is checked against --
 * `DinerRooftop`, `ShantyTown_TowerRooftop` and `Eden_Rooftop` in `refs/floors/`:
 *
 *   - one `VentedRooftop` address per address that was indoors, each holding a single
 *     `Rooftop` room. The division survives because it is the building's: two apartments
 *     under one roof are two lots of roof, and the game reads an address as a place.
 *   - `floorOnly` where the roof is, `none` everywhere else. That pairing is the whole
 *     of what makes a rooftop a rooftop: a slab with nothing overhead.
 *   - `NothingWall` between squares belonging to different addresses, and no other wall
 *     anywhere. A roof has edges rather than walls, and `NothingWall` is what the game
 *     uses to divide open air it can still walk between.
 *
 * The interior walls, the rooms and their presets, the layout configurations and the node
 * heights all go: they describe the storey below, and none of them is a thing a roof has.
 * The tiles stay -- a stairwell that reaches the top storey reaches the roof, which is
 * what `Eden_Rooftop` shows, and an author who wants no way up deletes one tile.
 *
 * Nothing here knows about the editor. It takes a saved floor and gives back a saved
 * floor, so it is tested against the 93 the game ships without a page existing.
 */
import {
    NODE_GRID, AXIS_X, AXIS_Y,
    parseFloor, serialiseFloor, setWall, nodeAt, isOutsideNode, addressColour,
    OUTDOOR_LAYOUT_CONFIGURATIONS,
} from './floorModel.js';

/** The game's own names. A roof naming anything else is a floor it will not load. */
const ROOF_LAYOUT = 'VentedRooftop';
const ROOF_ROOM = 'Rooftop';
const OUTSIDE_LAYOUT = 'Outside';
const OUTSIDE_ROOM = 'Null';

/** FloorTileType: a slab with nothing overhead, and nothing at all. */
const FLOOR_ONLY = 2;
const FLOOR_TYPE_NONE = 0;

/**
 * `NothingWall`, as the string index a blueprint stores a wall preset by -- see
 * `refs/generated/soDoorPairIds.json`. A wall that is not there, which is what the edge
 * of a roof is: it divides one address from the next without standing between them.
 */
const NOTHING_WALL = '11';

/**
 * The roof over a floor, as a floor of its own.
 *
 * @param floorName  what the new floor is called, which is how the building refers to it
 * @param sourceData the storey below, as a saved blueprint
 */
export function generateRoof(floorName, sourceData) {
    const source = parseFloor(sourceData);

    // Which of the source's addresses have roof over them, in the order they are met, so
    // that the new floor's addresses run in the same order as the old one's.
    const roofAddresses = [];
    const roofIndexOf = new Map();

    for (const node of source.nodes) {
        if (!node || !isIndoors(source, node)) continue;
        if (roofIndexOf.has(node.addressIndex)) continue;

        roofIndexOf.set(node.addressIndex, roofAddresses.length);
        roofAddresses.push([]);
    }

    // Address 0 is Outside, as it is on every floor the game ships and on every floor
    // this app writes. Everything that is not roof is in it.
    const outside = [];
    let roomId = 1;

    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            const node = nodeAt(source, x, y);
            const roof = node && isIndoors(source, node) ? roofIndexOf.get(node.addressIndex) : null;

            // Walls are put on afterwards, through the model, so that both halves of
            // each are written by the one thing that knows how a wall is stored.
            const built = {
                f_c: { x, y },
                f_h: 0,
                f_t: roof == null ? FLOOR_TYPE_NONE : FLOOR_ONLY,
                f_r: '',
                w_d: [],
            };

            if (roof == null) outside.push(built);
            else roofAddresses[roof].push(built);
        }
    }

    const roof = parseFloor({
        floorName,
        // The lot and the heights describe the building rather than the storey, so the
        // roof is the same building as what it covers.
        size: clone(source.size),
        defaultFloorHeight: source.defaultFloorHeight,
        defaultCeilingHeight: source.defaultCeilingHeight,
        a_d: [
            {
                p_n: OUTSIDE_LAYOUT,
                e_c: addressColour(0),
                vs: [{ r_d: [{ id: roomId++, l: OUTSIDE_ROOM, n_d: outside }] }],
            },
            ...roofAddresses.map((nodes, index) => ({
                p_n: ROOF_LAYOUT,
                e_c: addressColour(index + 1),
                vs: [{ r_d: [{ id: roomId++, l: ROOF_ROOM, n_d: nodes }] }],
            })),
        ],
        // Verbatim: a stairwell has to sit in the same tile on every storey it passes
        // through, and the roof is the last of them.
        t_d: clone(sourceData?.t_d ?? []),
    });

    edgeWalls(roof);

    return serialiseFloor(roof);
}

/**
 * Whether a square is under roof: inside the building, rather than merely inside the lot.
 *
 * The same question `floorLike` asks about where a building's wall is, and answered the
 * same way -- a Park or a Yard is laid out and named and is still open air, so nothing
 * goes over it.
 */
function isIndoors(model, node) {
    if (isOutsideNode(model, node)) return false;

    const address = model.addresses[node.addressIndex];
    return !OUTDOOR_LAYOUT_CONFIGURATIONS.has(address?.layoutConfiguration);
}

/**
 * `NothingWall` wherever two neighbouring squares belong to different addresses.
 *
 * Every wall on the roof and no others: the edge where it meets the open air, and the
 * lines between one lot of roof and the next. Each is written through `setWall`, which
 * puts a half on each of the two squares it sits between -- a wall recorded on one side
 * only is the corrupt floor the model exists to avoid.
 *
 * Walked as pairs rather than as neighbours, once per wall rather than twice: `setWall`
 * writes both sides, so meeting the same wall again from the other square would be the
 * same wall written a second time.
 */
function edgeWalls(model) {
    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            const here = nodeAt(model, x, y);

            for (const [axis, dx, dy] of [[AXIS_X, 1, 0], [AXIS_Y, 0, 1]]) {
                const next = nodeAt(model, x + dx, y + dy);
                if (!here || !next || here.addressIndex === next.addressIndex) continue;

                setWall(model, x, y, axis, NOTHING_WALL);
            }
        }
    }
}

const clone = (value) => structuredClone(value);
