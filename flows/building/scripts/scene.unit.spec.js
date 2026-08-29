import { test, expect, beforeAll } from 'vitest';
import { instanceOfWall, describeCell, tileMarkers } from './scene.js';
import { parseFloor, AXIS_X, AXIS_Y, NODE_GRID } from './floorModel.js';

/**
 * What the floorplan view works out before it draws anything.
 *
 * The drawing and the picking need a GPU and are driven for real in
 * tests/buildingScene.spec.js. These three do not: the mapping between a wall slot and
 * an instance index is arithmetic, and describing a cell or listing a floor's tile
 * markers is a read of the model. All three are exported because the view needs them,
 * not because they are view code.
 */

let floor;

beforeAll(async () => {
    floor = parseFloor(await (await fetch('/refs/floors/blueprints/Hotel_GroundFloor.json')).json());
});


/* -------------------------------------------------------------------------- */
/* Index arithmetic, which needs no GPU at all                                 */
/* -------------------------------------------------------------------------- */

test('every wall slot has exactly one instance, and it maps back', () => {
    const seen = new Map();
    let collisions = 0;

    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID - 1; x++) {
            const index = instanceOfWall(x, y, AXIS_X);
            if (seen.has(index)) collisions++;
            seen.set(index, `${x},${y},x`);
        }
    }
    for (let y = 0; y < NODE_GRID - 1; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            const index = instanceOfWall(x, y, AXIS_Y);
            if (seen.has(index)) collisions++;
            seen.set(index, `${x},${y},y`);
        }
    }

    const result = {
        count: seen.size,
        collisions,
        lowest: Math.min(...seen.keys()),
        highest: Math.max(...seen.keys()),
    };

    // 20 x 21 gaps along each axis. Two walls sharing an instance would have one
    // silently painting over the other.
    expect(result.count).toBe(840);
    expect(result.collisions).toBe(0);

    // Contiguous from zero, so the mesh is exactly as big as it needs to be.
    expect(result.lowest).toBe(0);
    expect(result.highest).toBe(839);
});


/* -------------------------------------------------------------------------- */
/* Reading the model the view is showing                                       */
/* -------------------------------------------------------------------------- */

test('a cell describes itself the way the reference labels one', () => {
    const described = {
        inside: describeCell(floor, 10, 10),
        margin: describeCell(floor, 0, 0),
    };

    // The reference puts the room preset, its id and the coordinates on every cell.
    expect(described.inside.coordinate).toBe('10, 10');
    expect(described.inside.room).toMatch(/^\S+ #\d+$/);
    expect(typeof described.inside.address).toBe('string');
    expect(described.margin.coordinate).toBe('0, 0');
});

test('tile markers report entrances and stairwells, and nothing else', () => {
    const markers = tileMarkers(floor);

    expect(markers.length).toBeGreaterThan(0);

    for (const marker of markers) {
        // Only tiles that carry something are listed at all.
        expect(marker.entrance ?? marker.stairwell).not.toBeNull();

        // The centre node of a 3 x 3 tile, which is what a label is positioned over.
        expect(marker.nodeX).toBe(marker.x * 3 + 1);
        expect(marker.nodeY).toBe(marker.y * 3 + 1);

        // Every listed tile has something to write on it -- the filter and the wording
        // are the same question, so a marker with an empty label would be a marker for
        // a tile carrying nothing.
        expect(marker.label).not.toBe('');
    }

    // Hotel_GroundFloor is the way into the building, so it has a main entrance.
    expect(markers.some((marker) => marker.entrance === 'main')).toBe(true);
});

test('a marker is labelled with what it carries, a line at a time', () => {
    const markers = tileMarkers(floor);

    for (const marker of markers) {
        const lines = marker.label.split('\n');

        // One line per thing, and the stairwell's says which way it faces. The label is
        // turned by that rotation as well; the degrees are written out so that a label
        // lying at a quarter turn is read rather than measured.
        expect(lines).toHaveLength((marker.stairwell ? 1 : 0) + (marker.entrance ? 1 : 0));

        if (marker.stairwell) {
            expect(lines[0]).toBe(
                `${marker.stairwell === 'elevator' ? 'Elevator' : 'Stairs'} ${marker.rotation}°`);
        }
        if (marker.entrance) {
            expect(lines.at(-1)).toBe(marker.entrance === 'main' ? 'Main entrance' : 'Entrance');
        }
    }

    // Newlines rather than the status column's separator: a label is written on a square
    // three cells across, so two things on one line would run off it.
    expect(markers.some((marker) => marker.label.includes(' · '))).toBe(false);
});
