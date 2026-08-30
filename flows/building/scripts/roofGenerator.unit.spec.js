import { test, expect, beforeAll } from 'vitest';
import * as model from './floorModel.js';
import { generateRoof } from './roofGenerator.js';

/**
 * The roof over a storey, derived from it.
 *
 * A roof is the one thing this app writes that nobody draws, so the whole of what it is
 * worth checking is that the derivation is right: the shape of the building comes across,
 * everything that describes the storey below does not, and what comes out is a floor the
 * game will load -- every square accounted for, both halves of every wall.
 *
 * The names it writes are the game's own and are checked against the rooftops the game
 * ships, which is what `roofsTheGameShips` at the foot of this file is for. A roof naming
 * a layout configuration or a room preset the game has never heard of is a floor that
 * loads as nothing.
 */

/**
 * A storey to roof: a building that does not fill its lot, a yard beside it, two
 * addresses inside with rooms and a partition between them, node heights, and a
 * stairwell.
 *
 * Built through the model's own editing, so the walls are paired the way the app writes
 * them and the addresses are laid out the way it lays them out.
 */
function drawnFloor() {
    const floor = model.parseFloor(model.blankFloor('Tower_Floor3'));

    // A yard along one side: laid out, named, and still open air. Nothing goes over it.
    const yard = model.addAddress(floor, 'Yard', { r: 0, g: 0.5, b: 0, a: 1 });
    model.seedRoomForLayout(floor, yard, ['Yard']);
    for (let y = 3; y <= 17; y++) {
        for (let x = 3; x <= 5; x++) {
            model.setNodeAddress(floor, model.nodeAt(floor, x, y), yard);
            model.setNodeFloor(floor, model.nodeAt(floor, x, y), 0, 0);
        }
    }

    // A second address indoors, so the roof has two lots on it. The Lobby keeps the rest.
    const flat = model.addAddress(floor, 'Apartment', { r: 0, g: 0, b: 1, a: 1 });
    const living = model.addRoom(floor, flat, 'LivingRoom');
    for (let y = 11; y <= 17; y++) {
        for (let x = 6; x <= 17; x++) {
            const node = model.nodeAt(floor, x, y);
            // The address first: painting a room onto a square in another address makes
            // that room there rather than moving the square. See setNodeRoom.
            model.setNodeAddress(floor, node, flat);
            model.setNodeRoom(floor, node, flat, living.roomIndex);
            model.setNodeFloor(floor, node, 1, 3);
        }
    }

    // The building's own wall where its edge has moved in off the lot boundary, and the
    // partition between the two addresses inside it.
    for (let y = 3; y <= 17; y++) model.setWall(floor, 5, y, model.AXIS_X, '0');
    for (let x = 6; x <= 17; x++) model.setWall(floor, x, 10, model.AXIS_Y, '0');

    model.paintTile(model.tileAt(floor, 3, 3), model.TileMode.STAIRWELL);

    return model.serialiseFloor(floor);
}

/** Where every wall on a floor is, as `x,y,axis=preset` keys. */
function wallsOf(floor) {
    const keys = new Set();

    for (let y = 0; y < model.NODE_GRID; y++) {
        for (let x = 0; x < model.NODE_GRID; x++) {
            for (const axis of [model.AXIS_X, model.AXIS_Y]) {
                const wall = model.getWall(floor, x, y, axis);
                if (wall) keys.add(`${x},${y},${axis}=${wall.preset}`);
            }
        }
    }

    return keys;
}

/** The squares an address holds, as `x,y` keys. */
const squaresOf = (floor, addressIndex) => new Set(floor.nodes
    .filter((node) => node.addressIndex === addressIndex)
    .map((node) => `${node.x},${node.y}`));

let source;
let data;
let roof;

beforeAll(() => {
    source = model.parseFloor(drawnFloor());
    data = generateRoof('Tower_Floor4', model.serialiseFloor(source));
    roof = model.parseFloor(data);
});

test('a generated roof is a floor the game could load', () => {
    expect(data.floorName).toBe('Tower_Floor4');
    expect(data.t_d).toHaveLength(49);

    // Written back out unchanged is what says it is in the shape a saved floor is in,
    // rather than one that merely looks like it.
    expect(JSON.stringify(model.serialiseFloor(model.parseFloor(data)))).toBe(JSON.stringify(data));

    // Nothing missing, nothing claimed twice, no half-built walls.
    expect(model.describeIssues(roof)).toEqual([]);
    expect(roof.nodes.filter(Boolean)).toHaveLength(21 * 21);
    expect(roof.issues.wallMismatches).toHaveLength(0);
});

test('a roof covers what was indoors, one address at a time', () => {
    // One VentedRooftop per address that had roof over it, in the order they were met.
    // The division is the building's: two flats under one roof are two lots of roof.
    expect(roof.addresses.map((address) => address.layoutConfiguration))
        .toEqual(['Outside', 'VentedRooftop', 'VentedRooftop']);
    expect(roof.rooms.map((room) => room.preset)).toEqual(['Null', 'Rooftop', 'Rooftop']);

    // The Lobby is squares 6..17 x 3..10, the Apartment 6..17 x 11..17, and the roof
    // over each is exactly that. The yard has nothing over it: it is laid out and named
    // and it is still open air.
    expect(squaresOf(roof, 1)).toEqual(squaresOf(source, 1));
    expect(squaresOf(roof, 2)).toEqual(squaresOf(source, 3));
    expect(squaresOf(roof, 1).size).toBe(12 * 8);
    expect(squaresOf(roof, 2).size).toBe(12 * 7);
    expect(squaresOf(roof, 0).has('4,10')).toBe(true);
});

test('a roof is a slab where the building is and nothing anywhere else', () => {
    // floorOnly and none, which is the whole of what makes a rooftop a rooftop: a slab
    // with open sky over it, and open air off the edge of it.
    const types = new Map();
    for (const node of roof.nodes) types.set(node.floorType, (types.get(node.floorType) ?? 0) + 1);

    expect([...types.keys()].sort()).toEqual([0, 2]);
    expect(types.get(2)).toBe(12 * 15);
    expect(types.get(0)).toBe(21 * 21 - 12 * 15);

    // Flat. A step in the storey below is part of that storey's floor, not of the roof.
    expect(roof.nodes.filter((node) => node.height !== 0)).toEqual([]);
});

test('a roof is walled where its addresses meet, with NothingWall and nothing else', () => {
    const walls = [...wallsOf(roof)];

    // Every wall is a NothingWall. The storey below's exterior wall and its partition
    // both describe that storey; a roof has edges rather than walls.
    expect(walls.every((wall) => wall.endsWith('=11'))).toBe(true);

    // Where they are: around the roof, and along the line between the two lots of it.
    // Counted as pairs of neighbouring squares that disagree about which address they
    // are in -- which is what the edge of a roof is.
    const expected = new Set();
    for (let y = 0; y < model.NODE_GRID; y++) {
        for (let x = 0; x < model.NODE_GRID; x++) {
            for (const [axis, dx, dy] of [[model.AXIS_X, 1, 0], [model.AXIS_Y, 0, 1]]) {
                const here = model.nodeAt(roof, x, y);
                const next = model.nodeAt(roof, x + dx, y + dy);
                if (next && here.addressIndex !== next.addressIndex) {
                    expected.add(`${x},${y},${axis}=11`);
                }
            }
        }
    }

    expect(walls.sort()).toEqual([...expected].sort());

    // The line between the two lots of roof is one of them, so a roof of two addresses
    // is not one sheet with an invisible seam.
    expect(wallsOf(roof).has(`10,10,${model.AXIS_Y}=11`)).toBe(true);
});

test('a roof keeps the tiles of the storey below', () => {
    // A stairwell has to sit in the same tile on every storey it passes through, and the
    // roof is the last of them -- which is what Eden_Rooftop does.
    expect(roof.tiles.filter((tile) => tile.isStairwell).map((tile) => `${tile.x},${tile.y}`))
        .toEqual(['3,3']);
});

test('a roof is a storey of the same building', () => {
    const wide = model.parseFloor(model.serialiseFloor(source));
    wide.size = { x: 2, y: 2 };
    wide.defaultCeilingHeight = 51;

    const above = generateRoof('Tower_Roof', model.serialiseFloor(wide));

    expect(above.size).toEqual({ x: 2, y: 2 });
    expect(above.defaultCeilingHeight).toBe(51);
});

test('a roof over nothing is a floor with nothing on it', () => {
    // A lot with no building in it. There is nothing to stand on up there, which is a
    // floor the game will load and walk nobody across rather than an error.
    const empty = model.parseFloor(model.blankFloor('Empty'));
    for (const node of empty.nodes) model.setNodeAddress(empty, node, 0);

    const above = model.parseFloor(generateRoof('Above', model.serialiseFloor(empty)));

    expect(above.addresses.map((address) => address.layoutConfiguration)).toEqual(['Outside']);
    expect(above.nodes.filter((node) => node.floorType !== 0)).toEqual([]);
    expect(wallsOf(above).size).toBe(0);
    expect(model.describeIssues(above)).toEqual([]);
});

test('the roof of a base game floor is one the game could load', async () => {
    const from = await (await fetch('/refs/floors/blueprints/Tenement_MainFloor1.json')).json();
    const built = generateRoof('Tenement_Roof', from);
    const above = model.parseFloor(built);

    expect(model.describeIssues(above)).toEqual([]);
    expect(above.issues.wallMismatches).toHaveLength(0);
    expect(JSON.stringify(model.serialiseFloor(above))).toBe(JSON.stringify(built));

    // The building is up there and the street is not.
    const below = model.parseFloor(from);
    const indoors = below.nodes.filter((node) => !model.isOutsideNode(below, node)
        && !model.OUTDOOR_LAYOUT_CONFIGURATIONS.has(
            below.addresses[node.addressIndex].layoutConfiguration));

    expect(above.nodes.filter((node) => node.floorType === 2)).toHaveLength(indoors.length);
    expect(indoors.length).toBeGreaterThan(0);
});

test('every floor the game ships can be roofed', async () => {
    // The standard the model itself is held to: not "it works on a floor I drew" but
    // "it works on all 93 of theirs". A roof is written into a mod as the only copy of
    // itself, and a bad one shows up in the game rather than here.
    const index = await (await fetch('/refs/floors/index.json')).json();
    const broken = [];

    for (const name of index.blueprints) {
        const from = await (await fetch(`/refs/floors/blueprints/${name}.json`)).json();

        try {
            const built = generateRoof(`${name}_Roof`, from);
            const above = model.parseFloor(built);
            const issues = model.describeIssues(above);

            // Stable, whole, and paired: written back out unchanged, every square
            // accounted for, no wall with one side missing.
            if (issues.length
                || above.nodes.filter(Boolean).length !== 21 * 21
                || JSON.stringify(model.serialiseFloor(above)) !== JSON.stringify(built)) {
                broken.push({ name, issues });
            }
        } catch (error) {
            broken.push({ name, threw: String(error) });
        }
    }

    expect(broken).toEqual([]);
    expect(index.blueprints.length).toBeGreaterThan(90);
});

test('the names a roof writes are names the game has', async () => {
    // Read off the rooftops the game ships rather than asserted from the same constants
    // the generator uses, which would agree with itself and prove nothing.
    const shipped = await Promise.all(['DinerRooftop', 'ShantyTown_TowerRooftop']
        .map(async (name) => (await fetch(`/refs/floors/blueprints/${name}.json`)).json()));

    const layouts = new Set(shipped.flatMap((floor) => floor.a_d.map((address) => address.p_n)));
    const rooms = new Set(shipped.flatMap((floor) => floor.a_d
        .flatMap((address) => address.vs.flatMap((v) => v.r_d.map((room) => room.l)))));
    const walls = new Set(shipped.flatMap((floor) => floor.a_d
        .flatMap((address) => address.vs.flatMap((v) => v.r_d
            .flatMap((room) => room.n_d.flatMap((node) => node.w_d.map((wall) => wall.p_n)))))));

    expect(layouts).toContain('VentedRooftop');
    expect(rooms).toContain('Rooftop');
    expect(walls).toContain('11');

    // And the floor types: a shipped rooftop's own squares are floorOnly.
    const roofNodes = shipped[1].a_d
        .filter((address) => address.p_n === 'VentedRooftop')
        .flatMap((address) => address.vs.flatMap((v) => v.r_d.flatMap((room) => room.n_d)));

    expect(roofNodes.length).toBeGreaterThan(0);
    expect(roofNodes.every((node) => node.f_t === 2)).toBe(true);
});
