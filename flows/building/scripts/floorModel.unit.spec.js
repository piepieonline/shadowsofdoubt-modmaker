import { test, expect, beforeAll } from 'vitest';
import * as model from './floorModel.js';

/**
 * The floor model: against the base game's own 93 floors, and under editing.
 *
 * A floor blueprint is the one kind of content this app writes where a mistake is
 * invisible until the game renders it, and where the file being written is the only
 * copy. So the standard here is not "it parses" but "it comes back out as it went in":
 * read all 93, write them, and compare.
 *
 * 82 of them must come back *identical*. The other 11 are floors the base game itself
 * authored oddly, and each is listed below with what it does and what that costs. If a
 * re-import of refs/floors/ changes those lists, this fails -- which is the point.
 *
 * Two further assertions sit apart from the round trip, because a model that quietly
 * dropped either would still pass a general comparison of what it wrote against what it
 * read. Both are the data-loss bugs this model exists to avoid.
 *
 * The round trip says nothing about what happens once something is *changed*, which the
 * Walls and Variations sections below cover. Walls get the most attention because a wall
 * is stored on *both* of the nodes it sits between, and writing one side only produces a
 * wall the game half-renders -- a fault invisible in the editor, invisible in the JSON
 * unless you know to look, and visible only once the floor is loaded in the game. It is
 * the single most likely way for this flow to emit a corrupt floor.
 */

/**
 * Floors whose first layout variation does not cover the whole 21 x 21 grid. The model
 * fills the rest in as Outside, mirroring DataBuilder.BackfillOutside, so it writes back
 * more nodes than it read.
 */
const GAP_FLOORS = [
    'Hotel_Basement2',
    'Hotel_RooftopBar',
    'MixedIndustrial_ground01',
    'ShantyTown_Basement01',
    'ShantyTown_FirstFloor01',
    'ShantyTown_GroundFloor01',
];

/**
 * Floors where two addresses claim the same node in their first variation. A node
 * belongs to one address on a grid, so the later claim wins and the earlier address
 * writes back without it.
 */
const OVERLAP_FLOORS = [
    'CityHall_LoftFloor',
    'CityHall_SecondFloor',
    'MixedIndustrial_FirstFloor01',
    'Tenement_BasementNoShops',
    'Tenement_BasementNoShops_Control',
];

/**
 * JSON with object keys sorted, so two floors compare on their content.
 *
 * Key order is not a property worth holding the model to: the game's own exports
 * disagree with each other about it, most writing a node as f_c/f_h/f_t/f_r/w_d and four
 * writing f_r before f_t. Array order *is* compared, because the order of nodes within a
 * room is real data.
 */
const canonical = (value) => JSON.stringify(value, (key, held) => (
    held && typeof held === 'object' && !Array.isArray(held)
        ? Object.fromEntries(Object.keys(held).sort().map((k) => [k, held[k]]))
        : held
));

function countForcedRooms(floor) {
    const values = [];
    for (const address of floor.a_d) {
        for (const variation of address.vs) {
            for (const room of variation.r_d) {
                for (const node of room.n_d) {
                    if (node.f_r) values.push(`${node.f_c.x},${node.f_c.y}=${node.f_r}`);
                }
            }
        }
    }
    return values.sort();
}

/** Read every blueprint, run it through the model, and report on it. */
async function roundTripAll() {
    const index = await (await fetch('/refs/floors/index.json')).json();
    const results = [];

    for (const name of index.blueprints) {
        const input = await (await fetch(`/refs/floors/blueprints/${name}.json`)).json();

        let parsed;
        let output;
        try {
            parsed = model.parseFloor(input);
            output = model.serialiseFloor(parsed);
        } catch (error) {
            results.push({ name, threw: String(error) });
            continue;
        }

        // Every node the input held, and every node the output holds, keyed by
        // coordinate -- so a comparison can say which side a difference is on.
        const nodesOf = (floor) => {
            const nodes = new Map();
            floor.a_d.forEach((address, addressIndex) => {
                const variation = address.vs[0];
                if (!variation) return;
                for (const room of variation.r_d) {
                    for (const node of room.n_d) {
                        nodes.set(`${node.f_c.x},${node.f_c.y}`, { addressIndex, node });
                    }
                }
            });
            return nodes;
        };

        const before = nodesOf(input);
        const after = nodesOf(output);

        results.push({
            name,
            identical: canonical(output) === canonical(input),
            addedNodes: [...after.keys()].filter((key) => !before.has(key)).sort(),
            lostNodes: [...before.keys()].filter((key) => !after.has(key)).sort(),

            // Every node the output added, as the model wrote it -- so the test can
            // check a backfill is really an empty Outside square.
            added: [...after.entries()]
                .filter(([key]) => !before.has(key))
                .map(([key, entry]) => ({
                    key,
                    layout: output.a_d[entry.addressIndex].p_n,
                    floorType: entry.node.f_t,
                    height: entry.node.f_h,
                })),

            // Variation counts per address, to catch a model that keeps the one it
            // is showing and drops the rest.
            variationsIn: input.a_d.map((address) => address.vs.length),
            variationsOut: output.a_d.map((address) => address.vs.length),

            // Non-selected variations must be untouched, whatever happens to the
            // grid. Nothing should have reached them at all.
            spareIn: canonical(input.a_d.map((a) => a.vs.slice(1))),
            spareOut: canonical(output.a_d.map((a) => a.vs.slice(1))),

            forcedRoomsIn: countForcedRooms(input),
            forcedRoomsOut: countForcedRooms(output),
        });
    }

    return results;
}

let results;

/**
 * All 93 round trips run once, and every test below reads the same results. The model
 * is pure, so re-running it per test would buy nothing but 5 MB of parsing each time.
 */
beforeAll(async () => { results = await roundTripAll(); });

test('every base game floor is readable', () => {
    expect(results.filter((r) => r.threw)).toEqual([]);
    expect(results).toHaveLength(93);
});

test('a floor with nothing odd about it round trips identically', () => {
    const expected = results
        .map((r) => r.name)
        .filter((name) => !GAP_FLOORS.includes(name) && !OVERLAP_FLOORS.includes(name));

    const identical = results.filter((r) => r.identical).map((r) => r.name);

    expect(identical.sort()).toEqual(expected.sort());
    expect(identical).toHaveLength(82);
});

test('a floor with missing nodes gains them as empty Outside squares, and nothing else', () => {
    const gapped = results.filter((r) => GAP_FLOORS.includes(r.name));
    expect(gapped).toHaveLength(GAP_FLOORS.length);

    for (const floor of gapped) {
        expect(floor.lostNodes, `${floor.name} lost nodes`).toEqual([]);
        expect(floor.addedNodes.length, `${floor.name} gained nothing`).toBeGreaterThan(0);

        // A backfilled node is Outside, with no floor and no height. Anything else
        // means the fill picked the wrong address or invented geometry.
        for (const node of floor.added) {
            expect(node.layout, `${floor.name} ${node.key}`).toBe('Outside');
            expect(node.floorType, `${floor.name} ${node.key}`).toBe(0);
            expect(node.height, `${floor.name} ${node.key}`).toBe(0);
        }
    }
});

test('a floor with two addresses on one node keeps the node once, and loses nothing else', () => {
    const overlapping = results.filter((r) => OVERLAP_FLOORS.includes(r.name));
    expect(overlapping).toHaveLength(OVERLAP_FLOORS.length);

    for (const floor of overlapping) {
        // The node is still on the floor -- it just belongs to one address now. So
        // nothing is added, and nothing disappears from the grid.
        expect(floor.addedNodes, `${floor.name} invented nodes`).toEqual([]);
        expect(floor.lostNodes, `${floor.name} dropped nodes from the grid`).toEqual([]);

        // But it is not identical, because one address wrote back without it.
        expect(floor.identical, `${floor.name} was expected to differ`).toBe(false);
    }
});

test('no floor is silently repaired', () => {
    // Every floor is either identical or one of the eleven listed above. A twelfth
    // means either the reference data changed or the model started rewriting things.
    const unexplained = results
        .filter((r) => !r.identical)
        .map((r) => r.name)
        .filter((name) => !GAP_FLOORS.includes(name) && !OVERLAP_FLOORS.includes(name));

    expect(unexplained).toEqual([]);
});

/**
 * The first of the two bugs this model exists to avoid. The reference tool reads vs[0],
 * ignores the rest, and writes a single variation -- so saving one of the 117 addresses
 * that have more than one deletes layouts the game picks between at random.
 */
test('an address keeps every layout variation, not just the one on show', () => {
    let multiVariation = 0;

    for (const floor of results) {
        // Never fewer. An address may gain one -- see below -- but losing one is the
        // bug, and no amount of gaining excuses it.
        floor.variationsIn.forEach((count, addressIndex) => {
            expect(floor.variationsOut[addressIndex], `${floor.name} address ${addressIndex}`)
                .toBeGreaterThanOrEqual(count);
        });

        multiVariation += floor.variationsIn.filter((count) => count > 1).length;
    }

    // The base game has 117 of them. If this number moves, the reference data changed.
    expect(multiVariation).toBe(117);
});

test('only a floor being backfilled gains a variation, and only to hold the fill', () => {
    for (const floor of results) {
        const gained = floor.variationsIn
            .map((count, addressIndex) => ({ addressIndex, count, out: floor.variationsOut[addressIndex] }))
            .filter((entry) => entry.out > entry.count);

        if (!GAP_FLOORS.includes(floor.name)) {
            expect(gained, `${floor.name} gained a variation for no reason`).toEqual([]);
            continue;
        }

        // Six base game floors leave the grid incomplete *and* write their Outside
        // address with no variations at all. The backfilled nodes have to belong to
        // an address, so Outside gets the one variation it needs and nothing more.
        for (const entry of gained) {
            expect(entry.count, `${floor.name} address ${entry.addressIndex}`).toBe(0);
            expect(entry.out, `${floor.name} address ${entry.addressIndex}`).toBe(1);
        }
    }
});

test('a variation nobody is editing is written back untouched', () => {
    for (const floor of results) {
        expect(floor.spareOut, `${floor.name}`).toBe(floor.spareIn);
    }
});

/**
 * The second. The reference tool writes f_r as "" for every node, commented "Seems to
 * be blank in real files?". It is not blank in real files.
 */
test('a node keeps its forced room', () => {
    let total = 0;

    for (const floor of results) {
        total += floor.forcedRoomsIn.length;

        if (OVERLAP_FLOORS.includes(floor.name)) {
            // An overlapping node belongs to one address once the floor is a grid, so
            // the loser's copy of it goes -- with its f_r. Nothing may be *changed* or
            // invented, which is what this checks instead.
            const kept = new Set(floor.forcedRoomsIn);
            for (const value of floor.forcedRoomsOut) {
                expect(kept.has(value), `${floor.name} invented ${value}`).toBe(true);
            }
            continue;
        }

        expect(floor.forcedRoomsOut, `${floor.name}`).toEqual(floor.forcedRoomsIn);
    }

    // 1,889 nodes across 40 floors. Stated as a number so that a model which blanked
    // them all would fail here even if it blanked them on both sides of the compare.
    expect(total).toBe(1889);
});


/* -------------------------------------------------------------------------- */
/* A floor to edit                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A floor with one address covering the whole grid, and a second covering
 * nothing. Small enough to reason about, real enough to serialise.
 */
const blankFloor = ({ cover = true } = {}) => {
    const nodes = [];
    if (cover) {
        for (let x = 0; x < 21; x++) {
            for (let y = 0; y < 21; y++) {
                nodes.push({
                    f_c: { x, y }, f_h: 0, f_t: 0, f_r: '', w_d: [],
                });
            }
        }
    }

    return {
        floorName: 'Test',
        size: { x: 1, y: 1 },
        defaultFloorHeight: 0,
        defaultCeilingHeight: 42,
        a_d: [
            {
                p_n: 'Outside',
                e_c: { r: 1, g: 0, b: 0.4, a: 1 },
                vs: [{ r_d: [{ id: 1, n_d: nodes, l: 'Null' }] }],
            },
            {
                p_n: 'Lobby',
                e_c: { r: 1, g: 0.66, b: 0, a: 1 },
                vs: [{ r_d: [{ id: 2, n_d: [], l: 'Lobby' }] }],
            },
        ],
        t_d: [],
    };
};


/* -------------------------------------------------------------------------- */
/* Walls                                                                       */
/* -------------------------------------------------------------------------- */

test('a wall is written to both of the nodes it sits between', () => {
    const floor = model.parseFloor(blankFloor());
    model.setWall(floor, 5, 5, model.AXIS_X, '7');

    const result = {
        low: model.nodeAt(floor, 5, 5).walls,
        high: model.nodeAt(floor, 6, 5).walls,
        untouchedAbove: model.nodeAt(floor, 5, 6).walls,
    };

    // Opposite offsets, same preset. The pair is the wall.
    expect(result.low).toEqual([{ ox: 0.5, oy: 0, preset: '7' }]);
    expect(result.high).toEqual([{ ox: -0.5, oy: 0, preset: '7' }]);
    expect(result.untouchedAbove).toEqual([]);
});

test('a wall on the y axis is written the same way', () => {
    const floor = model.parseFloor(blankFloor());
    model.setWall(floor, 5, 5, model.AXIS_Y, '16');

    const result = { low: model.nodeAt(floor, 5, 5).walls, high: model.nodeAt(floor, 5, 6).walls };

    expect(result.low).toEqual([{ ox: 0, oy: 0.5, preset: '16' }]);
    expect(result.high).toEqual([{ ox: 0, oy: -0.5, preset: '16' }]);
});

test('a wall offset is never a negative zero', () => {
    // -0 and 0 are the same number to look at, serialise to the same JSON, and compare
    // unequal. A wall carrying one would make a floor differ from itself.
    const floor = model.parseFloor(blankFloor());
    model.setWall(floor, 5, 5, model.AXIS_X, '7');
    model.setWall(floor, 8, 8, model.AXIS_Y, '7');

    const all = [
        ...model.nodeAt(floor, 5, 5).walls, ...model.nodeAt(floor, 6, 5).walls,
        ...model.nodeAt(floor, 8, 8).walls, ...model.nodeAt(floor, 8, 9).walls,
    ];

    const signs = all.flatMap((wall) => [Object.is(wall.ox, -0), Object.is(wall.oy, -0)]);

    expect(signs.every((isNegativeZero) => isNegativeZero === false)).toBe(true);
});

test('painting over a wall replaces it rather than stacking on it', () => {
    const floor = model.parseFloor(blankFloor());
    model.setWall(floor, 5, 5, model.AXIS_X, '7');
    model.setWall(floor, 5, 5, model.AXIS_X, '16');

    const result = {
        low: model.nodeAt(floor, 5, 5).walls,
        high: model.nodeAt(floor, 6, 5).walls,
    };

    expect(result.low).toEqual([{ ox: 0.5, oy: 0, preset: '16' }]);
    expect(result.high).toEqual([{ ox: -0.5, oy: 0, preset: '16' }]);
});

test('a wall on one axis leaves the other axis alone', () => {
    const floor = model.parseFloor(blankFloor());
    model.setWall(floor, 5, 5, model.AXIS_X, '7');
    model.setWall(floor, 5, 5, model.AXIS_Y, '16');
    model.setWall(floor, 5, 5, model.AXIS_X, '11');

    const result = model.nodeAt(floor, 5, 5).walls;

    // Replacing the x wall must not disturb the y wall sharing the node.
    expect(result).toEqual([
        { ox: 0, oy: 0.5, preset: '16' },
        { ox: 0.5, oy: 0, preset: '11' },
    ]);
});

test('clearing a wall clears both halves', () => {
    const floor = model.parseFloor(blankFloor());
    model.setWall(floor, 5, 5, model.AXIS_X, '7');
    model.clearWall(floor, 5, 5, model.AXIS_X);

    const result = {
        low: model.nodeAt(floor, 5, 5).walls,
        high: model.nodeAt(floor, 6, 5).walls,
        reported: model.getWall(floor, 5, 5, model.AXIS_X),
    };

    expect(result.low).toEqual([]);
    expect(result.high).toEqual([]);
    expect(result.reported).toBeNull();
});

test('a wall off the edge of the grid is refused rather than half written', () => {
    const floor = model.parseFloor(blankFloor());

    const result = {
        written: model.setWall(floor, 20, 5, model.AXIS_X, '7'),
        walls: model.nodeAt(floor, 20, 5).walls,
        cleared: model.clearWall(floor, 5, 20, model.AXIS_Y),
    };

    expect(result.written).toBe(false);
    expect(result.walls).toEqual([]);
    expect(result.cleared).toBe(false);
});

test('a wall whose halves disagree is reported rather than repaired', () => {
    const source = blankFloor();

    // Two halves naming different presets, which is what 582 wall halves across 30
    // base game floors do. Reading must not quietly pick one.
    const nodes = source.a_d[0].vs[0].r_d[0].n_d;
    const at = (x, y) => nodes.find((n) => n.f_c.x === x && n.f_c.y === y);
    at(5, 5).w_d = [{ w_o: { x: 0.5, y: 0 }, p_n: '7' }];
    at(6, 5).w_d = [{ w_o: { x: -0.5, y: 0 }, p_n: '16' }];

    // And a half with nothing facing it at all.
    at(9, 9).w_d = [{ w_o: { x: 0.5, y: 0 }, p_n: '11' }];

    const floor = model.parseFloor(source);

    const result = {
        mismatches: floor.issues.wallMismatches,
        disagreeing: model.getWall(floor, 5, 5, model.AXIS_X),
        lonely: model.getWall(floor, 9, 9, model.AXIS_X),
        keptLow: model.nodeAt(floor, 5, 5).walls,
        keptHigh: model.nodeAt(floor, 6, 5).walls,
    };

    expect(result.mismatches).toEqual([
        { x: 5, y: 5, axis: 'x', low: '7', high: '16' },
        { x: 9, y: 9, axis: 'x', low: '11', high: null },
    ]);

    expect(result.disagreeing).toEqual({ preset: '7', matched: false });
    expect(result.lonely).toEqual({ preset: '11', matched: false });

    // Both halves survive reading exactly as they were written.
    expect(result.keptLow).toEqual([{ ox: 0.5, oy: 0, preset: '7' }]);
    expect(result.keptHigh).toEqual([{ ox: -0.5, oy: 0, preset: '16' }]);
});

test('a backfilled node is given its half of the wall facing it', () => {
    const source = blankFloor();
    const nodes = source.a_d[0].vs[0].r_d[0].n_d;

    // Take (5, 5) out of the file, and have its neighbour record a wall facing it.
    const neighbour = nodes.find((n) => n.f_c.x === 6 && n.f_c.y === 5);
    neighbour.w_d = [{ w_o: { x: -0.5, y: 0 }, p_n: '7' }];
    source.a_d[0].vs[0].r_d[0].n_d = nodes.filter(
        (n) => !(n.f_c.x === 5 && n.f_c.y === 5));

    const floor = model.parseFloor(source);

    const result = {
        gaps: floor.issues.gaps,
        backfilled: model.nodeAt(floor, 5, 5).backfilled,
        walls: model.nodeAt(floor, 5, 5).walls,
        mismatches: floor.issues.wallMismatches,
    };

    expect(result.gaps).toEqual([{ x: 5, y: 5 }]);
    expect(result.backfilled).toBe(true);

    // Its half of the neighbour's wall, pointing back at the neighbour. Without this
    // the floor would load with half a wall at (5, 5).
    expect(result.walls).toEqual([{ ox: 0.5, oy: 0, preset: '7' }]);
    expect(result.mismatches).toEqual([]);
});


/* -------------------------------------------------------------------------- */
/* Rooms                                                                       */
/* -------------------------------------------------------------------------- */

/*
 * Adding, removing and numbering rooms.
 *
 * The one invariant underneath all of these: every square names a room its own address
 * has. A square that does not is the single condition serialising refuses to write, so
 * each of these ends by writing the floor out -- a model that loses a square, or leaves
 * one pointing at a slot that has moved, fails there rather than in the game.
 */

test('a room added by hand takes an id no room in the floor is using', () => {
    const floor = model.parseFloor(blankFloor());

    // The Outside holds id 1 and the Lobby id 2, in a different address entirely.
    const first = model.addRoom(floor, 0, 'Kitchen');
    const second = model.addRoom(floor, 0, 'Kitchen');

    const result = {
        ids: [first.id, second.id],
        slots: [first.roomIndex, second.roomIndex],
        rooms: model.roomsOfAddress(floor, 0).map((room) => `${room.preset}#${room.id}`),
    };

    // Counted across the floor rather than the address: an id the Lobby is using is not
    // free for the Outside to take.
    expect(result.ids).toEqual([3, 4]);

    // Two rooms of one name in an address is ordinary -- 695 of the base game's rooms
    // are Null -- so a second Kitchen is a second room, not the first one again.
    expect(result.slots).toEqual([1, 2]);
    expect(result.rooms).toEqual(['Null#1', 'Kitchen#3', 'Kitchen#4']);
});

test('an id is not reused from a layout variation nobody is looking at', () => {
    const source = blankFloor();
    source.a_d[1].vs = [
        { r_d: [{ id: 2, n_d: [], l: 'Lobby' }] },
        { r_d: [{ id: 40, n_d: [], l: 'Lobby' }] },
    ];

    const floor = model.parseFloor(source);
    const added = model.addRoom(floor, 0, 'Kitchen');

    // Variation 1 is not on the grid, and its rooms are still rooms of this floor. An
    // id taken from under one is an id that clashes the moment it is shown again.
    expect(added.id).toBe(41);
});

test('a new address arrives with a Null room, so something can be painted into it', () => {
    const floor = model.parseFloor(blankFloor());
    const index = model.addAddress(floor, 'Outside', { r: 0, g: 1, b: 1, a: 1 });

    const rooms = model.roomsOfAddress(floor, index).map((room) => `${room.preset}#${room.id}`);

    expect(index).toBe(2);
    expect(rooms).toEqual(['Null#3']);
});

test('an address is given the room its layout is named after, once', () => {
    const floor = model.parseFloor(blankFloor());
    const index = model.addAddress(floor, 'Outside', { r: 0, g: 1, b: 1, a: 1 });

    // Outside is not the name of a room preset, so nothing is added for it.
    const beforeNaming = model.seedRoomForLayout(floor, index, ['Lobby', 'Ballroom']);

    floor.addresses[index].layoutConfiguration = 'Lobby';
    const seeded = model.seedRoomForLayout(floor, index, ['Lobby', 'Ballroom']);

    // Renaming an address that is no longer bare leaves its rooms alone.
    floor.addresses[index].layoutConfiguration = 'Ballroom';
    const again = model.seedRoomForLayout(floor, index, ['Lobby', 'Ballroom']);

    const rooms = model.roomsOfAddress(floor, index).map((room) => `${room.preset}#${room.id}`);

    expect(beforeNaming).toBe(null);
    expect(seeded.preset).toBe('Lobby');
    expect(again).toBe(null);
    expect(rooms).toEqual(['Null#3', 'Lobby#4']);
});

test('an address that has been painted into is not seeded', () => {
    const floor = model.parseFloor(blankFloor());
    const index = model.addAddress(floor, 'Lobby', { r: 0, g: 1, b: 1, a: 1 });

    model.setNodeAddress(floor, model.nodeAt(floor, 10, 10), index);
    const seeded = model.seedRoomForLayout(floor, index, ['Lobby']);

    // The seed is part of adding an address, not a thing that happens to one being
    // edited: a square in it is proof it is past being created.
    expect(seeded).toBe(null);
});

test('removing a room hands its squares to the address’s Null room', () => {
    const floor = model.parseFloor(blankFloor());

    const kitchen = model.addRoom(floor, 0, 'Kitchen');
    model.setNodeRoom(floor, model.nodeAt(floor, 10, 10), 0, kitchen.roomIndex);
    model.setNodeRoom(floor, model.nodeAt(floor, 11, 10), 0, kitchen.roomIndex);

    const removed = model.removeRoom(floor, 0, kitchen.roomIndex);
    const written = model.serialiseFloor(floor).a_d[0].vs[0].r_d;

    const result = {
        removed,
        rooms: model.roomsOfAddress(floor, 0).map((room) => `${room.preset}#${room.id}`),
        room: model.roomOfNode(floor, model.nodeAt(floor, 10, 10)),
        written: written.map((room) => `${room.l}#${room.id}`),
        squares: written[0].n_d.length,
    };

    expect(result.removed).toBe(true);
    expect(result.rooms).toEqual(['Null#1']);
    expect(result.room.preset).toBe('Null');

    // The whole grid is the Outside's, and every one of its squares is still written --
    // the two that were in the Kitchen among them.
    expect(result.written).toEqual(['Null#1']);
    expect(result.squares).toBe(441);
});

test('removing a room renumbers the slots above it, on the rooms and the squares alike', () => {
    const floor = model.parseFloor(blankFloor());

    const kitchen = model.addRoom(floor, 0, 'Kitchen');
    const bathroom = model.addRoom(floor, 0, 'Bathroom');
    model.setNodeRoom(floor, model.nodeAt(floor, 10, 10), 0, bathroom.roomIndex);

    model.removeRoom(floor, 0, kitchen.roomIndex);

    const result = {
        slots: model.roomsOfAddress(floor, 0).map((room) => [room.preset, room.roomIndex]),
        node: model.nodeAt(floor, 10, 10).roomIndex,
        room: model.roomOfNode(floor, model.nodeAt(floor, 10, 10)).preset,
        // A square pointing at a slot that has moved would be dropped here, or throw.
        written: model.serialiseFloor(floor).a_d[0].vs[0].r_d.map((room) => room.l),
    };

    expect(result.slots).toEqual([['Null', 0], ['Bathroom', 1]]);
    expect(result.node).toBe(1);
    expect(result.room).toBe('Bathroom');
    expect(result.written).toEqual(['Null', 'Bathroom']);
});

test('removing an address’s only Null room gives its squares back to the Outside', () => {
    const source = blankFloor();

    // The Lobby covers one square, in a Null room of its own.
    source.a_d[1].vs = [
        { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Null' }] },
    ];

    const floor = model.parseFloor(source);
    model.removeRoom(floor, 1, 0);

    const node = model.nodeAt(floor, 10, 10);
    const result = {
        addressIndex: node.addressIndex,
        room: model.roomOfNode(floor, node),
        lobbyRooms: model.roomsOfAddress(floor, 1).length,
        written: model.serialiseFloor(floor).a_d[1].vs[0].r_d,
    };

    // There is nowhere in the Lobby left to put them, so they stop being the Lobby's --
    // the same place a square no address claimed ends up.
    expect(result.addressIndex).toBe(0);
    expect(result.room.preset).toBe('Null');
    expect(result.lobbyRooms).toBe(0);
    expect(result.written).toEqual([]);
});

test('an empty room is removed without moving anything', () => {
    const floor = model.parseFloor(blankFloor());
    model.addRoom(floor, 1, 'Kitchen');

    const result = {
        removed: model.removeRoom(floor, 1, 1),
        missing: model.removeRoom(floor, 1, 9),
        rooms: model.roomsOfAddress(floor, 1).map((room) => room.preset),
    };

    expect(result.removed).toBe(true);
    // A slot that is not there is not an error to report; there is nothing to remove.
    expect(result.missing).toBe(false);
    expect(result.rooms).toEqual(['Lobby']);
});


/* -------------------------------------------------------------------------- */
/* Variations                                                                  */
/* -------------------------------------------------------------------------- */

test('selecting a variation changes what the grid shows', () => {
    const source = blankFloor();

    // The Lobby address gets two layouts: one claiming (10, 10), one claiming
    // (11, 11). Only the selected one is on the grid.
    source.a_d[1].vs = [
        { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
        { r_d: [{ id: 3, n_d: [{ f_c: { x: 11, y: 11 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
    ];

    const floor = model.parseFloor(source);
    const first = {
        at1010: model.nodeAt(floor, 10, 10).addressIndex,
        at1111: model.nodeAt(floor, 11, 11).addressIndex,
    };

    model.selectVariation(floor, 1, 1);
    const second = {
        at1010: model.nodeAt(floor, 10, 10).addressIndex,
        at1111: model.nodeAt(floor, 11, 11).addressIndex,
    };

    const result = { first, second, selected: floor.addresses[1].selectedVariation };

    // Variation 0: the Lobby holds (10, 10) and Outside holds (11, 11).
    expect(result.first).toEqual({ at1010: 1, at1111: 0 });
    // Variation 1: the other way round.
    expect(result.second).toEqual({ at1010: 0, at1111: 1 });
    expect(result.selected).toBe(1);
});

test('an edit survives switching variation and coming back', () => {
    const source = blankFloor();
    source.a_d[1].vs = [
        { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
        { r_d: [{ id: 3, n_d: [{ f_c: { x: 11, y: 11 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
    ];

    const floor = model.parseFloor(source);

    // Change something in variation 0, then leave and return.
    model.nodeAt(floor, 10, 10).height = 7;
    model.selectVariation(floor, 1, 1);
    model.selectVariation(floor, 1, 0);

    const written = model.serialiseFloor(floor);
    const result = {
        heightNow: model.nodeAt(floor, 10, 10).height,
        written: written.a_d[1].vs.map((v) => v.r_d[0].n_d.map((n) => [n.f_c.x, n.f_c.y, n.f_h])),
    };

    expect(result.heightNow).toBe(7);
    expect(result.written).toEqual([
        [[10, 10, 7]],
        [[11, 11, 0]],
    ]);
});

test('duplicating a variation leaves the original alone', () => {
    const source = blankFloor();
    source.a_d[1].vs = [
        { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 3, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
    ];

    const floor = model.parseFloor(source);
    const copy = model.duplicateVariation(floor, 1);
    model.nodeAt(floor, 10, 10).height = 9;

    const written = model.serialiseFloor(floor);
    const result = {
        copy,
        count: floor.addresses[1].variations.length,
        heights: written.a_d[1].vs.map((v) => v.r_d[0].n_d[0].f_h),
    };

    expect(result.copy).toBe(1);
    expect(result.count).toBe(2);
    // The copy took the edit; the original kept what it had.
    expect(result.heights).toEqual([3, 9]);
});

test('adding a variation gives an address an empty layout to paint into', () => {
    const source = blankFloor();
    source.a_d[1].vs = [
        { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
    ];

    const floor = model.parseFloor(source);
    const added = model.addVariation(floor, 1);

    const result = {
        added,
        // The Lobby now covers nothing, so the node falls back to Outside.
        ownerOf1010: model.nodeAt(floor, 10, 10).addressIndex,
        backfilled: model.nodeAt(floor, 10, 10).backfilled,
        gaps: floor.issues.gaps.length,
        stillWritten: model.serialiseFloor(floor).a_d[1].vs[0].r_d[0].n_d.length,
    };

    expect(result.added).toBe(1);
    expect(result.ownerOf1010).toBe(0);

    // Outside's own layout already covered that node, so it is Outside's real node
    // rather than an invented one -- no gap opened, and nothing needed filling in.
    expect(result.backfilled).toBe(false);
    expect(result.gaps).toBe(0);

    // The layout that is no longer on show still holds its node.
    expect(result.stillWritten).toBe(1);
});

test('removing a variation drops that layout and nothing else', () => {
    const source = blankFloor();
    source.a_d[1].vs = [
        { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
        { r_d: [{ id: 3, n_d: [{ f_c: { x: 11, y: 11 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
    ];

    const floor = model.parseFloor(source);
    model.removeVariation(floor, 1, 0);

    const written = model.serialiseFloor(floor);
    const result = {
        count: floor.addresses[1].variations.length,
        selected: floor.addresses[1].selectedVariation,
        remaining: written.a_d[1].vs.map((v) => v.r_d[0].n_d.map((n) => [n.f_c.x, n.f_c.y])),
    };

    expect(result.count).toBe(1);
    expect(result.selected).toBe(0);
    // What survives is the layout that was not removed.
    expect(result.remaining).toEqual([[[11, 11]]]);
});

test('an address stripped of its last variation covers nothing', () => {
    const source = blankFloor();
    source.a_d[1].vs = [
        { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
    ];

    const floor = model.parseFloor(source);
    model.removeVariation(floor, 1, 0);

    const result = {
        selected: floor.addresses[1].selectedVariation,
        ownerOf1010: model.nodeAt(floor, 10, 10).addressIndex,
        variationsWritten: model.serialiseFloor(floor).a_d[1].vs.length,
    };

    // Six base game addresses are already in this state, so it has to be representable
    // rather than prevented.
    expect(result.selected).toBe(-1);
    expect(result.ownerOf1010).toBe(0);
    expect(result.variationsWritten).toBe(0);
});

test('two addresses on one node are reported, and the node belongs to one of them', () => {
    const source = blankFloor();

    // Outside already covers the whole grid; the Lobby claims one of its nodes too.
    source.a_d[1].vs = [
        { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
    ];

    const floor = model.parseFloor(source);
    const result = {
        overlaps: floor.issues.overlaps,
        owner: model.nodeAt(floor, 10, 10).addressIndex,
        issues: model.describeIssues(floor),
    };

    expect(result.overlaps).toEqual([
        { x: 10, y: 10, heldBy: 0, alsoClaimedBy: 1 },
    ]);
    // Later claim wins, matching what the reference tool renders.
    expect(result.owner).toBe(1);
    expect(result.issues).toEqual(['1 node(s) claimed by more than one address']);
});


/* -------------------------------------------------------------------------- */
/* A floor to start from                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What Add floor writes.
 *
 * It has to be a floor the game will load and the editor will open, which is a stricter
 * thing than an empty grid: every node accounted for, both halves of every wall, and the
 * margin the city puts between one lot and the next.
 */
function readBlankFloor() {
    const m = model;
    const data = m.blankFloor('MyTower_Floor1');
    const built = m.parseFloor(data);

    let walls = 0;
    for (let y = 0; y < m.NODE_GRID; y++) {
        for (let x = 0; x < m.NODE_GRID; x++) {
            if (m.getWall(built, x, y, m.AXIS_X)) walls++;
            if (m.getWall(built, x, y, m.AXIS_Y)) walls++;
        }
    }

    const at = (x, y) => {
        const node = m.nodeAt(built, x, y);
        return { outside: m.isOutsideNode(built, node), floorType: node.floorType };
    };

    return {
        data,
        issues: m.describeIssues(built),
        nodes: built.nodes.filter(Boolean).length,
        addresses: built.addresses.map((a) => a.layoutConfiguration),
        rooms: built.rooms.map((r) => r.preset),
        walls,
        mismatches: built.issues.wallMismatches.length,
        margin: at(0, 0),
        edgeOfMargin: at(2, 10),
        interior: at(10, 10),
        firstPaintable: at(3, 3),
        // Written back out unchanged is what says the file is in the shape a saved
        // floor is in, rather than one that merely looks like it.
        stable: JSON.stringify(m.serialiseFloor(m.parseFloor(data))) === JSON.stringify(data),
    };
}

let blank;

beforeAll(() => { blank = readBlankFloor(); });

test('a new floor is a floor the game could load', () => {
    expect(blank.data.floorName).toBe('MyTower_Floor1');
    expect(blank.data.t_d).toHaveLength(49);
    expect(blank.stable).toBe(true);

    // Nothing missing, nothing claimed twice, no half-built walls -- the three things
    // the model reports on a floor it was handed.
    expect(blank.issues).toEqual([]);
    expect(blank.nodes).toBe(21 * 21);
    expect(blank.mismatches).toBe(0);
});

test('a new floor is a lobby inside the margin the city leaves', () => {
    expect(blank.addresses).toEqual(['Outside', 'Lobby']);
    expect(blank.rooms).toEqual(['Null', 'Lobby']);

    // The outer three nodes on each side are not paintable, so a floor without them
    // would open with a border nothing could ever fill in.
    expect(blank.margin).toEqual({ outside: true, floorType: 0 });
    expect(blank.edgeOfMargin).toEqual({ outside: true, floorType: 0 });

    // floorAndCeiling: somewhere that can be walked into, rather than a marked-out
    // area with no floor in it.
    expect(blank.interior).toEqual({ outside: false, floorType: 1 });
    expect(blank.firstPaintable).toEqual({ outside: false, floorType: 1 });
});

test('a new floor is walled where the lobby meets the outside', () => {
    // The 15 x 15 interior has a 15-node side on each of four sides, and a wall belongs
    // to both of the nodes it sits between -- so 60 walls, each matched.
    expect(blank.walls).toBe(60);
});
