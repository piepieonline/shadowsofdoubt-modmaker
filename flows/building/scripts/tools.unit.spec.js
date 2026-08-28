import { test, expect } from 'vitest';
import * as tools from './tools.js';
import * as model from './floorModel.js';

/**
 * The painting tools.
 *
 * Applying a tool is a pure function of the model, the tool state and what was under
 * the pointer, so most of this needs no canvas: it hands `applyTool` a target and reads
 * the model afterwards. The pointer handling that turns real events into those targets
 * is driven for real in tests/buildingTools.spec.js, because the rules it enforces --
 * drag repeats, except for tools that cycle -- are the ones that cannot be checked any
 * other way.
 */

/** A floor with an Outside covering everything and an empty Lobby. */
const build = () => {
    const nodes = [];
    for (let x = 0; x < 21; x++) {
        for (let y = 0; y < 21; y++) {
            nodes.push({ f_c: { x, y }, f_h: 0, f_t: 0, f_r: '', w_d: [] });
        }
    }

    return model.parseFloor({
        floorName: 'Test',
        size: { x: 1, y: 1 },
        defaultCeilingHeight: 42,
        a_d: [
            {
                p_n: 'Outside', e_c: { r: 1, g: 0, b: 0.4, a: 1 },
                vs: [{ r_d: [{ id: 1, n_d: nodes, l: 'Null' }] }],
            },
            {
                p_n: 'Lobby', e_c: { r: 1, g: 0.66, b: 0, a: 1 },
                vs: [{ r_d: [{ id: 2, n_d: [], l: 'Lobby' }] }],
            },
        ],
        t_d: [],
    });
};


/* -------------------------------------------------------------------------- */
/* Address                                                                     */
/* -------------------------------------------------------------------------- */

test('painting an address moves the node, and takes its room with it', () => {
    const floor = build();
    const state = tools.createToolState({ tool: tools.Tool.ADDRESS, addressIndex: 1 });

    const outcome = tools.applyTool(floor, state, { kind: 'cell', x: 10, y: 10 });
    const node = model.nodeAt(floor, 10, 10);
    const room = model.roomOfNode(floor, node);

    const result = {
        outcome,
        addressIndex: node.addressIndex,
        room: room && { preset: room.preset, id: room.id, owner: room.addressIndex },
        written: model.serialiseFloor(floor).a_d[1].vs[0].r_d,
    };

    expect(result.outcome.changed).toBe(true);
    expect(result.addressIndex).toBe(1);

    // The node keeps the *kind* of room it was in -- Null -- but that room belongs to
    // the address it was painted into rather than being borrowed from the one it left,
    // and so has an id of its own rather than the one it would be borrowing with it.
    expect(result.room).toEqual({ preset: 'Null', id: 3, owner: 1 });

    // And it is written under the Lobby, in a room of that preset and id.
    const written = result.written.find((entry) => entry.l === 'Null' && entry.id === 3);
    expect(written.n_d).toEqual([{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 0, f_r: '', w_d: [] }]);
});

test('painting the address already there changes nothing', () => {
    const floor = build();
    const state = tools.createToolState({ tool: tools.Tool.ADDRESS, addressIndex: 0 });
    const changed = tools.applyTool(floor, state, { kind: 'cell', x: 10, y: 10 }).changed;

    expect(changed).toBe(false);
});

test('ctrl+click takes the address from under the pointer', () => {
    const floor = build();
    const state = tools.createToolState({ tool: tools.Tool.ADDRESS, addressIndex: 1 });

    // Put the Lobby somewhere, then pick from a node that is still Outside.
    tools.applyTool(floor, state, { kind: 'cell', x: 10, y: 10 });
    const outcome = tools.applyTool(floor, state, { kind: 'cell', x: 5, y: 5 }, { pick: true });

    const result = { addressIndex: state.addressIndex, outcome, selected: state.selectedNode };

    expect(result.outcome).toEqual({ changed: false, picked: true });
    expect(result.addressIndex).toBe(0);
    expect(result.selected).toEqual({ x: 5, y: 5 });
});


/* -------------------------------------------------------------------------- */
/* Room                                                                        */
/* -------------------------------------------------------------------------- */

/** A room of an address, and a tool state set to paint with it. */
const painting = (floor, addressIndex, preset) => {
    const room = model.addRoom(floor, addressIndex, preset);
    return tools.createToolState({
        tool: tools.Tool.ROOM, addressIndex, roomIndex: room.roomIndex,
    });
};

test('painting a room puts the node in it', () => {
    const floor = build();
    const state = painting(floor, 0, 'Kitchen');

    const outcome = tools.applyTool(floor, state, { kind: 'cell', x: 8, y: 8 });
    const room = model.roomOfNode(floor, model.nodeAt(floor, 8, 8));

    const result = {
        outcome,
        room: { preset: room.preset, id: room.id },
        rooms: model.roomsOfAddress(floor, 0).map((entry) => `${entry.preset}#${entry.id}`),
    };

    expect(result.outcome.changed).toBe(true);

    // Id 3, not 2: ids are minted against the whole floor, and the Lobby -- another
    // address entirely -- already holds id 2.
    expect(result.room).toEqual({ preset: 'Kitchen', id: 3 });
    expect(result.rooms).toEqual(['Null#1', 'Kitchen#3']);
});

test('painting the same room twice does not make a second one', () => {
    const floor = build();
    const state = painting(floor, 0, 'Kitchen');

    tools.applyTool(floor, state, { kind: 'cell', x: 8, y: 8 });
    tools.applyTool(floor, state, { kind: 'cell', x: 9, y: 8 });
    tools.applyTool(floor, state, { kind: 'cell', x: 10, y: 8 });

    const rooms = model.roomsOfAddress(floor, 0).map((entry) => `${entry.preset}#${entry.id}`);

    expect(rooms).toEqual(['Null#1', 'Kitchen#3']);
});

test('painting a room across an address boundary makes one room, not one per square', () => {
    const floor = build();
    const kitchen = painting(floor, 0, 'Kitchen');

    // Two squares moved into the Lobby, then painted with a room the Outside holds.
    const address = tools.createToolState({ tool: tools.Tool.ADDRESS, addressIndex: 1 });
    tools.applyTool(floor, address, { kind: 'cell', x: 8, y: 8 });
    tools.applyTool(floor, address, { kind: 'cell', x: 9, y: 8 });

    tools.applyTool(floor, kitchen, { kind: 'cell', x: 8, y: 8 });
    tools.applyTool(floor, kitchen, { kind: 'cell', x: 9, y: 8 });

    const node = model.nodeAt(floor, 8, 8);
    const result = {
        addressIndex: node.addressIndex,
        room: model.roomOfNode(floor, node),
        alsoRoom: model.roomOfNode(floor, model.nodeAt(floor, 9, 8)),
        rooms: model.roomsOfAddress(floor, 1).map((entry) => `${entry.preset}#${entry.id}`),
    };

    // A room belongs to an address, so the Lobby gets a Kitchen of its own rather than
    // the square being written under a room its address does not have. Both squares land
    // in that one room, and the square stays in the address it was painted into.
    expect(result.addressIndex).toBe(1);
    expect(result.room.preset).toBe('Kitchen');
    expect(result.room).toBe(result.alsoRoom);

    // Null#4 is where the address tool put the squares; Kitchen#5 is the new room. Both
    // ids are unused elsewhere in the floor rather than copied from the Outside's.
    expect(result.rooms).toEqual(['Lobby#2', 'Null#4', 'Kitchen#5']);
});

test('painting with a room slot the address does not have changes nothing', () => {
    const floor = build();
    const state = tools.createToolState({
        tool: tools.Tool.ROOM, addressIndex: 0, roomIndex: 7,
    });

    const outcome = tools.applyTool(floor, state, { kind: 'cell', x: 8, y: 8 });

    // An address whose rooms have all been removed has nothing to paint with. That is a
    // click that does nothing, not a room invented to receive it.
    expect(outcome.changed).toBe(false);
    expect(model.roomsOfAddress(floor, 0).length).toBe(1);
});

test('ctrl+click takes the room, and the address it belongs to', () => {
    const floor = build();

    const paint = painting(floor, 0, 'Kitchen');
    tools.applyTool(floor, paint, { kind: 'cell', x: 8, y: 8 });

    const state = tools.createToolState({
        tool: tools.Tool.ROOM, addressIndex: 1, roomIndex: 0,
    });
    tools.applyTool(floor, state, { kind: 'cell', x: 8, y: 8 }, { pick: true });

    const picked = {
        addressIndex: state.addressIndex,
        roomIndex: state.roomIndex,
        room: model.roomAt(floor, state.addressIndex, state.roomIndex),
    };

    // Picking a room without its address would leave the two disagreeing: a slot means
    // nothing except within the address it is a slot of, so the next stroke would paint
    // whichever room of the old address sat in that position.
    expect(picked.addressIndex).toBe(0);
    expect(picked.roomIndex).toBe(paint.roomIndex);
    expect(picked.room.preset).toBe('Kitchen');
});

test('ctrl+click on an address takes the room under it too', () => {
    const floor = build();

    const kitchen = painting(floor, 0, 'Kitchen');
    tools.applyTool(floor, kitchen, { kind: 'cell', x: 8, y: 8 });

    // Selected: the Lobby, and its only room. Picked: a square of the Outside.
    const state = tools.createToolState({
        tool: tools.Tool.ADDRESS, addressIndex: 1, roomIndex: 0,
    });
    tools.applyTool(floor, state, { kind: 'cell', x: 8, y: 8 }, { pick: true });

    const picked = model.roomAt(floor, state.addressIndex, state.roomIndex);

    // Slot 0 of the Lobby is its Lobby room and slot 0 of the Outside is Null, so a
    // selection left where it was would silently mean something else.
    expect(state.addressIndex).toBe(0);
    expect(picked.preset).toBe('Kitchen');
});


/* -------------------------------------------------------------------------- */
/* Floor type                                                                  */
/* -------------------------------------------------------------------------- */

test('the floor type tool paints the type and the height together', () => {
    const floor = build();
    const state = tools.createToolState({
        tool: tools.Tool.FLOOR_TYPE, floorType: 2, extraHeight: 3,
    });

    tools.applyTool(floor, state, { kind: 'cell', x: 7, y: 7 });
    const painted = model.nodeAt(floor, 7, 7);
    const node = { floorType: painted.floorType, height: painted.height };

    expect(node).toEqual({ floorType: 2, height: 3 });
});

test('ctrl+click takes the floor type and the height together', () => {
    const floor = build();

    const paint = tools.createToolState({
        tool: tools.Tool.FLOOR_TYPE, floorType: 4, extraHeight: 6,
    });
    tools.applyTool(floor, paint, { kind: 'cell', x: 7, y: 7 });

    const picker = tools.createToolState({ tool: tools.Tool.FLOOR_TYPE });
    tools.applyTool(floor, picker, { kind: 'cell', x: 7, y: 7 }, { pick: true });

    const state = { floorType: picker.floorType, extraHeight: picker.extraHeight };

    // Picking a type without its height means the next thing painted sits at the wrong
    // level, which is why the reference takes both and so does this.
    expect(state).toEqual({ floorType: 4, extraHeight: 6 });
});


/* -------------------------------------------------------------------------- */
/* Flood fill                                                                  */
/* -------------------------------------------------------------------------- */

/*
 * Several of these box in the cells from 8 to 10 on both axes, so that a fill started
 * inside has somewhere to stop. Two different presets, because a wall of any kind is a
 * boundary and which one it is never comes into it.
 */
const boxIn = (floor) => {
    for (let y = 8; y <= 10; y++) {
        model.setWall(floor, 7, y, 'x', '0');
        model.setWall(floor, 10, y, 'x', '7');
    }
    for (let x = 8; x <= 10; x++) {
        model.setWall(floor, x, 7, 'y', '0');
        model.setWall(floor, x, 10, 'y', '7');
    }
};

test('a flood fills the walled area it was started in, and stops there', () => {
    const floor = build();
    boxIn(floor);

    const state = tools.createToolState({
        tool: tools.Tool.ADDRESS, addressIndex: 1, mode: tools.PaintMode.FLOOD,
    });

    const outcome = tools.applyTool(floor, state, { kind: 'cell', x: 9, y: 9 });

    const inside = [];
    for (let y = 8; y <= 10; y++) {
        for (let x = 8; x <= 10; x++) inside.push(model.nodeAt(floor, x, y).addressIndex);
    }

    const result = {
        outcome,
        inside,
        // Just outside each of the four walls.
        outside: [
            model.nodeAt(floor, 7, 9).addressIndex,
            model.nodeAt(floor, 11, 9).addressIndex,
            model.nodeAt(floor, 9, 7).addressIndex,
            model.nodeAt(floor, 9, 11).addressIndex,
        ],
    };

    // Nine cells, and every one of them written.
    expect(result.outcome.changed).toBe(true);
    expect(result.outcome.filled).toBe(9);
    expect(result.inside).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);

    // The walls held on all four sides.
    expect(result.outside).toEqual([0, 0, 0, 0]);
});

test('a flood does not care what is already in the cells it crosses', () => {
    const floor = build();
    boxIn(floor);

    // Three rooms inside one enclosure, which is the mess a flood is for.
    tools.applyTool(floor, painting(floor, 0, 'Kitchen'), { kind: 'cell', x: 8, y: 8 });
    tools.applyTool(floor, painting(floor, 0, 'Bathroom'), { kind: 'cell', x: 10, y: 10 });

    const flood = painting(floor, 0, 'Lounge');
    flood.mode = tools.PaintMode.FLOOD;
    const outcome = tools.applyTool(floor, flood, { kind: 'cell', x: 9, y: 9 });

    const presets = [[8, 8], [10, 10], [9, 9]].map(([x, y]) => {
        const found = model.roomOfNode(floor, model.nodeAt(floor, x, y));
        return `${found.preset}#${found.id}`;
    });

    expect(outcome.filled).toBe(9);

    // All three, whatever they were before. The alternative -- spreading only through
    // cells matching the one clicked -- would have left the first two alone.
    expect(presets).toEqual(['Lounge#5', 'Lounge#5', 'Lounge#5']);
});

test('a flood on an open floor stops at the margin, not at the grid', () => {
    const floor = build();
    const state = tools.createToolState({
        tool: tools.Tool.ADDRESS, addressIndex: 1, mode: tools.PaintMode.FLOOD,
    });

    const outcome = tools.applyTool(floor, state, { kind: 'cell', x: 10, y: 10 });

    const result = {
        outcome,
        corner: model.nodeAt(floor, 3, 3).addressIndex,
        margin: model.nodeAt(floor, 2, 2).addressIndex,
        edge: model.nodeAt(floor, 0, 10).addressIndex,
    };

    // The paintable square is 15 x 15. Nothing walls this floor, so the fill runs to the
    // margin on every side and no further -- those nodes are the game's to build.
    expect(result.outcome.filled).toBe(225);
    expect(result.corner).toBe(1);
    expect(result.margin).toBe(0);
    expect(result.edge).toBe(0);
});

test('a flood started on the margin paints nothing at all', () => {
    const floor = build();
    const state = tools.createToolState({
        tool: tools.Tool.ADDRESS, addressIndex: 1, mode: tools.PaintMode.FLOOD,
    });

    const outcome = tools.applyTool(floor, state, { kind: 'cell', x: 0, y: 0 });

    expect(outcome.changed).toBe(false);
    expect(outcome.blocked).toBe('margin');
});

test('flood leaves the wall and tile tools alone', () => {
    const floor = build();

    const wall = tools.createToolState({
        tool: tools.Tool.WALL, wallPreset: '3', mode: tools.PaintMode.FLOOD,
    });
    tools.applyTool(floor, wall, { kind: 'wall', x: 9, y: 9, axis: 'x' });

    const tile = tools.createToolState({
        tool: tools.Tool.TILE, tileMode: model.TileMode.ENTRANCE, mode: tools.PaintMode.FLOOD,
    });
    tools.applyTool(floor, tile, { kind: 'cell', x: 10, y: 10 });

    const result = {
        // One wall, not every wall in the enclosure.
        painted: model.getWall(floor, 9, 9, 'x')?.preset ?? null,
        neighbour: model.getWall(floor, 9, 10, 'x')?.preset ?? null,
        // One tile stepped, not all 49.
        tile: model.tileAt(floor, 3, 3).isEntrance,
        other: model.tileAt(floor, 4, 4).isEntrance,
    };

    // A wall is an edge rather than an area and a tile click cycles rather than sets, so
    // neither is a thing a fill could mean. Both go on behaving as they do in paint.
    expect(result.painted).toBe('3');
    expect(result.neighbour).toBe(null);
    expect(result.tile).toBe(true);
    expect(result.other).toBe(false);
});


/* -------------------------------------------------------------------------- */
/* The lot margin                                                              */
/* -------------------------------------------------------------------------- */

test('the outer margin is readable but not paintable', () => {
    const floor = build();
    const state = tools.createToolState({ tool: tools.Tool.ADDRESS, addressIndex: 1 });

    const blocked = [0, 1, 2, 18, 19, 20].map((x) => (
        tools.applyTool(floor, state, { kind: 'cell', x, y: 10 })));

    // Picking from the margin is still allowed -- it is reading, not writing.
    const picker = tools.createToolState({ tool: tools.Tool.ADDRESS, addressIndex: 1 });
    const picked = tools.applyTool(floor, picker, { kind: 'cell', x: 0, y: 0 }, { pick: true });

    const result = {
        blocked,
        stillOutside: model.nodeAt(floor, 0, 10).addressIndex,
        picked,
        pickedAddress: picker.addressIndex,
    };

    // The game builds the margin between one lot and the next itself.
    for (const outcome of result.blocked) {
        expect(outcome.changed).toBe(false);
        expect(outcome.blocked).toBe('margin');
    }
    expect(result.stillOutside).toBe(0);

    expect(result.picked.picked).toBe(true);
    expect(result.pickedAddress).toBe(0);
});


/* -------------------------------------------------------------------------- */
/* Walls                                                                       */
/* -------------------------------------------------------------------------- */

test('the wall tool sets both halves through the model', () => {
    const floor = build();
    const state = tools.createToolState({ tool: tools.Tool.WALL, wallPreset: '16' });

    const outcome = tools.applyTool(floor, state, { kind: 'wall', x: 6, y: 6, axis: 'x' });

    const result = {
        outcome,
        low: model.nodeAt(floor, 6, 6).walls,
        high: model.nodeAt(floor, 7, 6).walls,
    };

    expect(result.outcome.changed).toBe(true);
    expect(result.low).toEqual([{ ox: 0.5, oy: 0, preset: '16' }]);
    expect(result.high).toEqual([{ ox: -0.5, oy: 0, preset: '16' }]);
});

test('shift removes a wall, from both sides', () => {
    const floor = build();
    const state = tools.createToolState({ tool: tools.Tool.WALL, wallPreset: '16' });

    tools.applyTool(floor, state, { kind: 'wall', x: 6, y: 6, axis: 'x' });
    tools.applyTool(floor, state, { kind: 'wall', x: 6, y: 6, axis: 'x' }, { erase: true });

    const result = {
        low: model.nodeAt(floor, 6, 6).walls,
        high: model.nodeAt(floor, 7, 6).walls,
    };

    expect(result.low).toEqual([]);
    expect(result.high).toEqual([]);
});

test('ctrl+click takes the wall preset off the floor', () => {
    const floor = build();
    model.setWall(floor, 6, 6, model.AXIS_X, '22');

    const picker = tools.createToolState({ tool: tools.Tool.WALL, wallPreset: '0' });
    const outcome = tools.applyTool(
        floor, picker, { kind: 'wall', x: 6, y: 6, axis: 'x' }, { pick: true });

    // Picking an edge with nothing on it must not set the preset to nothing.
    const empty = tools.applyTool(
        floor, picker, { kind: 'wall', x: 12, y: 12, axis: 'y' }, { pick: true });

    const state = { preset: picker.wallPreset, outcome: outcome.picked, empty: empty.picked };

    expect(state.preset).toBe('22');
    expect(state.outcome).toBe(true);
    expect(state.empty).toBe(false);
});

test('a click on a cell paints the edge of it that was nearest', () => {
    const floor = build();
    const state = tools.createToolState({ tool: tools.Tool.WALL, wallPreset: '7' });

    // A wall is a sliver until something is on it, so a click almost never lands on
    // one. The point is where the ray met the floor, in cell units.
    const at = (x, y, px, pz) => tools.applyTool(
        floor, state, { kind: 'cell', x, y, point: { x: px, z: pz } }).wall;

    const edges = {
        east: at(10, 10, 10.9, 10.5),
        west: at(10, 10, 10.1, 10.5),
        north: at(10, 10, 10.5, 10.9),
        south: at(10, 10, 10.5, 10.1),
    };

    // Named from the low node of the edge, so the same wall has one name from either
    // side of it.
    expect(edges.east).toEqual({ x: 10, y: 10, axis: 'x' });
    expect(edges.west).toEqual({ x: 9, y: 10, axis: 'x' });
    expect(edges.north).toEqual({ x: 10, y: 10, axis: 'y' });
    expect(edges.south).toEqual({ x: 10, y: 9, axis: 'y' });
});

test('an edge off the grid is not painted', () => {
    const floor = build();
    const state = tools.createToolState({ tool: tools.Tool.WALL, wallPreset: '7' });

    // The far side of the outermost cell: there is no node beyond it to hold the
    // other half of the wall.
    const result = tools.applyTool(floor, state, { kind: 'cell', x: 0, y: 5, point: { x: 0.05, z: 5.5 } });

    expect(result.changed).toBe(false);
});


/* -------------------------------------------------------------------------- */
/* Tiles                                                                       */
/* -------------------------------------------------------------------------- */

test('the tile tool steps a stairwell through its cycle and off again', () => {
    const floor = build();
    const state = tools.createToolState({
        tool: tools.Tool.TILE, tileMode: model.TileMode.STAIRWELL,
    });

    const steps = [];
    for (let i = 0; i < 6; i++) {
        tools.applyTool(floor, state, { kind: 'cell', x: 10, y: 10 });
        const tile = model.tileAt(floor, 3, 3);
        steps.push(tile.isStairwell ? `on ${tile.stairwellRotation}` : 'off');
    }

    // off -> 0 -> 90 -> 180 -> 270 -> off, as the game's own editor does.
    expect(steps).toEqual(['on 0', 'on 90', 'on 180', 'on 270', 'off', 'on 0']);
});

test('painting an elevator over a stairwell converts it', () => {
    const floor = build();
    const stairs = tools.createToolState({
        tool: tools.Tool.TILE, tileMode: model.TileMode.STAIRWELL,
    });
    tools.applyTool(floor, stairs, { kind: 'cell', x: 10, y: 10 });

    const lift = tools.createToolState({
        tool: tools.Tool.TILE, tileMode: model.TileMode.ELEVATOR,
    });
    tools.applyTool(floor, lift, { kind: 'cell', x: 10, y: 10 });

    const tile = model.tileAt(floor, 3, 3);
    const state = { isStairwell: tile.isStairwell, isInverted: tile.isInverted };

    // The one place the reference improves on the game: no need to clear the tile first.
    expect(state).toEqual({ isStairwell: true, isInverted: true });
});

test('the entrance cycle goes on, main, off', () => {
    const floor = build();
    const state = tools.createToolState({
        tool: tools.Tool.TILE, tileMode: model.TileMode.ENTRANCE,
    });

    const steps = [];
    for (let i = 0; i < 4; i++) {
        tools.applyTool(floor, state, { kind: 'cell', x: 4, y: 4 });
        const tile = model.tileAt(floor, 1, 1);
        steps.push(tile.isMainEntrance ? 'main' : (tile.isEntrance ? 'entrance' : 'off'));
    }

    expect(steps).toEqual(['entrance', 'main', 'off', 'entrance']);
});

test('a node names the tile it falls in, not one of its own', () => {
    const floor = build();
    const state = tools.createToolState({ tool: tools.Tool.TILE });

    // Nodes 9 to 11 are all tile 3; node 12 starts tile 4.
    const inner = tools.applyTool(floor, state, { kind: 'cell', x: 11, y: 11 }).tile;
    const next = tools.applyTool(floor, state, { kind: 'cell', x: 12, y: 12 }).tile;

    const selected = { inner, next };

    expect(selected.inner).toEqual({ x: 3, y: 3 });
    expect(selected.next).toEqual({ x: 4, y: 4 });
});

test('ctrl+click on a tile selects it without cycling it', () => {
    const floor = build();
    const state = tools.createToolState({ tool: tools.Tool.TILE });

    const outcome = tools.applyTool(floor, state, { kind: 'cell', x: 10, y: 10 }, { pick: true });
    const result = { outcome, isStairwell: model.tileAt(floor, 3, 3).isStairwell };

    expect(result.outcome.changed).toBe(false);
    expect(result.outcome.picked).toBe(true);
    expect(result.isStairwell).toBe(false);
});
