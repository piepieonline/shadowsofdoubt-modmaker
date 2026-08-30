/**
 * Divider ends place themselves, and a run flips when one end is replaced.
 *
 * The thing under test is not "does the post land where the game puts it" -- nobody knows
 * where the game puts it, which is why this module exists. It is that the editor writes
 * a *coherent* run: one left, one right, the pair swapping together, and the same answer
 * whichever end the author starts from.
 */
import { describe, expect, test } from 'vitest';
import {
    AXIS_X, AXIS_Y, getWall, setWall, parseFloor,
} from './floorModel.js';
import {
    DIVIDER_CENTRE, DIVIDER_END, DIVIDER_END_LEFT, DIVIDER_END_RIGHT,
    dividerPostAtLowEnd, dividerRun, isDivider, isDividerEnd, parentIsLowNode,
    placeDividerEnd,
} from './dividerEnds.js';

/**
 * A floor with nothing on it but the nodes every wall needs on both sides.
 *
 * One address over the whole grid, which is the smallest thing that can hold a wall
 * anywhere: a wall needs a node on each side of it, and the edge of the grid is where
 * placing has to refuse.
 */
const floor = () => {
    const nodes = [];
    for (let x = 0; x < 21; x++) {
        for (let y = 0; y < 21; y++) nodes.push({ f_c: { x, y }, f_h: 0, f_t: 0, f_r: '', w_d: [] });
    }

    return parseFloor({
        floorName: 'Test',
        size: { x: 1, y: 1 },
        defaultFloorHeight: 0,
        defaultCeilingHeight: 42,
        a_d: [{
            p_n: 'Lobby',
            e_c: { r: 1, g: 0.66, b: 0, a: 1 },
            vs: [{ r_d: [{ id: 1, n_d: nodes, l: 'Lobby' }] }],
        }],
        t_d: [],
    });
};

/** The presets along a run, low end first, as the file would read them. */
const presetsAlong = (model, walls, axis) =>
    walls.map(([x, y]) => getWall(model, x, y, axis)?.preset ?? null);

describe('what counts as a divider', () => {
    test('the two ends are ends, and the centre is not', () => {
        expect(isDividerEnd(DIVIDER_END_LEFT)).toBe(true);
        expect(isDividerEnd(DIVIDER_END_RIGHT)).toBe(true);
        expect(isDividerEnd(DIVIDER_CENTRE)).toBe(false);
    });

    test('all three are dividers, and an ordinary wall is not', () => {
        expect(isDivider(DIVIDER_CENTRE)).toBe(true);
        expect(isDivider(DIVIDER_END_LEFT)).toBe(true);
        expect(isDivider('0')).toBe(false);
    });
});

describe('finding the run a wall belongs to', () => {
    // A wall along x separates two cells side by side, so a run of them extends along y.
    test('a run along x is walked in y', () => {
        const model = floor();
        setWall(model, 6, 15, AXIS_X, DIVIDER_END_LEFT);
        setWall(model, 6, 16, AXIS_X, DIVIDER_CENTRE);
        setWall(model, 6, 17, AXIS_X, DIVIDER_END_RIGHT);

        expect(dividerRun(model, 6, 16, AXIS_X)).toEqual([
            { x: 6, y: 15 }, { x: 6, y: 16 }, { x: 6, y: 17 },
        ]);
    });

    test('a run along y is walked in x', () => {
        const model = floor();
        setWall(model, 9, 5, AXIS_Y, DIVIDER_END_LEFT);
        setWall(model, 10, 5, AXIS_Y, DIVIDER_CENTRE);
        setWall(model, 11, 5, AXIS_Y, DIVIDER_END_RIGHT);

        expect(dividerRun(model, 10, 5, AXIS_Y)).toEqual([
            { x: 9, y: 5 }, { x: 10, y: 5 }, { x: 11, y: 5 },
        ]);
    });

    test('a wall that is not a divider yet still reports the run it would join', () => {
        const model = floor();
        setWall(model, 6, 15, AXIS_X, DIVIDER_CENTRE);

        // Nothing at (6, 16) at all, and it still comes back as part of the run -- the
        // first end of a new run has to be placeable before it exists.
        expect(dividerRun(model, 6, 16, AXIS_X)).toEqual([{ x: 6, y: 15 }, { x: 6, y: 16 }]);
    });

    /**
     * An end stops the walk, and is part of what it stopped at.
     *
     * It has to be: the ordinary run is a left, a centre and a right, and walking out
     * from the centre must reach both ends or a three-wall run would read as one wall.
     * The cost is at a seam where two runs abut -- four dividers in a line, ends touching
     * in the middle -- which reads as one run overlapping the shared end rather than as
     * two. Telling those apart needs the orientation nobody here has, so the generous
     * reading is the one taken; it means placing an end near a seam settles the whole
     * line rather than half of it.
     */
    test('the walk stops at the end it reaches, and includes it', () => {
        const model = floor();
        setWall(model, 6, 15, AXIS_X, DIVIDER_END_LEFT);
        setWall(model, 6, 16, AXIS_X, DIVIDER_CENTRE);
        setWall(model, 6, 17, AXIS_X, DIVIDER_END_RIGHT);
        setWall(model, 6, 18, AXIS_X, DIVIDER_CENTRE);

        // Walked from the centre: both ends are reached, and 18 beyond the right is not.
        expect(dividerRun(model, 6, 16, AXIS_X)).toEqual([
            { x: 6, y: 15 }, { x: 6, y: 16 }, { x: 6, y: 17 },
        ]);
    });

    test('an ordinary wall breaks a run', () => {
        const model = floor();
        setWall(model, 6, 15, AXIS_X, DIVIDER_CENTRE);
        setWall(model, 6, 16, AXIS_X, '0');
        setWall(model, 6, 17, AXIS_X, DIVIDER_CENTRE);

        expect(dividerRun(model, 6, 15, AXIS_X)).toEqual([{ x: 6, y: 15 }]);
    });
});

/**
 * A floor split into two rooms, so the parent side is decided by cyclePriority.
 *
 * Columns 0..6 are a Lobby (cyclePriority 3) and 7..20 a LivingRoom (10), so a wall along
 * x at x = 6 has the low node in the Lobby and the high node in the higher-priority room.
 * `swap` puts them the other way round, which is the only difference that matters.
 */
const splitFloor = ({ swap = false } = {}) => {
    const left = []; const right = [];
    for (let x = 0; x < 21; x++) {
        for (let y = 0; y < 21; y++) {
            const node = { f_c: { x, y }, f_h: 0, f_t: 0, f_r: '', w_d: [] };
            (x <= 6 ? left : right).push(node);
        }
    }

    return parseFloor({
        floorName: 'Split',
        size: { x: 1, y: 1 },
        defaultFloorHeight: 0,
        defaultCeilingHeight: 42,
        a_d: [{
            p_n: 'Lobby',
            e_c: { r: 1, g: 0.66, b: 0, a: 1 },
            vs: [{
                r_d: [
                    { id: 1, n_d: left, l: swap ? 'LivingRoom' : 'Lobby' },
                    { id: 2, n_d: right, l: swap ? 'Lobby' : 'LivingRoom' },
                ],
            }],
        }],
        t_d: [],
    });
};

/** Put a divider end back where one just like it was, which is what the tool's erase
 *  and replace does: the flip is a toggle off what was actually there. */
const replace = (model, x, y, axis) => placeDividerEnd(model, x, y, axis,
    { insteadOf: getWall(model, x, y, axis)?.preset ?? null });

/** Where each end's post lands, as ends of the run: [low wall, high wall]. */
const posts = (model, walls, axis) =>
    walls.map(([x, y]) => dividerPostAtLowEnd(model, x, y, axis, getWall(model, x, y, axis)?.preset));

describe('which side the parent is on', () => {
    test('the higher cyclePriority room parents, whichever side it is', () => {
        expect(parentIsLowNode(splitFloor(), 6, 10, AXIS_X)).toBe(false);
        expect(parentIsLowNode(splitFloor({ swap: true }), 6, 10, AXIS_X)).toBe(true);
    });

    // Two nodes of the same room tie on preset and on id alike, and the game decides by
    // the order it built the two walls in, which a blueprint does not record.
    test('the same room on both sides is a tie, and settles low', () => {
        expect(parentIsLowNode(floor(), 6, 10, AXIS_X)).toBe(true);
    });

    test('a real room parents a null one', () => {
        const model = splitFloor();
        // Column 21 does not exist, so the high side of x = 20 has no room at all.
        expect(parentIsLowNode(model, 20, 10, AXIS_X)).toBe(true);
    });
});

describe('placing a divider end', () => {
    test('both posts land on the outer ends of the run', () => {
        const model = splitFloor();
        setWall(model, 6, 16, AXIS_X, DIVIDER_CENTRE);

        placeDividerEnd(model, 6, 15, AXIS_X);
        placeDividerEnd(model, 6, 17, AXIS_X);

        // The low end's post at the low end, the high end's at the high end.
        expect(posts(model, [[6, 15], [6, 17]], AXIS_X)).toEqual([true, false]);
    });

    // The ids are not the invariant -- where the posts land is. Which id produces that
    // depends on the parent side, so the same run flips its ids when the rooms swap.
    test('the ids follow the parent side, and reverse when the rooms do', () => {
        const near = splitFloor();
        placeDividerEnd(near, 6, 15, AXIS_X);

        const swapped = splitFloor({ swap: true });
        placeDividerEnd(swapped, 6, 15, AXIS_X);

        expect(getWall(near, 6, 15, AXIS_X).preset).toBe(DIVIDER_END_LEFT);
        expect(getWall(swapped, 6, 15, AXIS_X).preset).toBe(DIVIDER_END_RIGHT);
    });

    test('the same run comes out the same way round whichever end is placed first', () => {
        const forward = splitFloor();
        setWall(forward, 6, 16, AXIS_X, DIVIDER_CENTRE);
        placeDividerEnd(forward, 6, 15, AXIS_X);
        placeDividerEnd(forward, 6, 17, AXIS_X);

        const backward = splitFloor();
        setWall(backward, 6, 16, AXIS_X, DIVIDER_CENTRE);
        placeDividerEnd(backward, 6, 17, AXIS_X);
        placeDividerEnd(backward, 6, 15, AXIS_X);

        const read = (m) => [[6, 15], [6, 16], [6, 17]]
            .map(([x, y]) => getWall(m, x, y, AXIS_X).preset);
        expect(read(forward)).toEqual(read(backward));
    });

    test('a run along the other axis puts its posts outward too', () => {
        const model = floor();
        setWall(model, 10, 5, AXIS_Y, DIVIDER_CENTRE);

        placeDividerEnd(model, 9, 5, AXIS_Y);
        placeDividerEnd(model, 11, 5, AXIS_Y);

        expect(posts(model, [[9, 5], [11, 5]], AXIS_Y)).toEqual([true, false]);
    });

    test('a lone divider end puts its post at its own low end', () => {
        const model = splitFloor();
        placeDividerEnd(model, 6, 15, AXIS_X);

        expect(dividerPostAtLowEnd(model, 6, 15, AXIS_X,
            getWall(model, 6, 15, AXIS_X).preset)).toBe(true);
    });

    test('an end dropped into the middle of a run takes the end it is nearer', () => {
        const model = splitFloor();
        for (const y of [14, 15, 16, 17]) setWall(model, 6, y, AXIS_X, DIVIDER_CENTRE);

        // (6, 16) is nearer the high end of 14..17, so its post goes to the high end.
        placeDividerEnd(model, 6, 16, AXIS_X);
        expect(dividerPostAtLowEnd(model, 6, 16, AXIS_X,
            getWall(model, 6, 16, AXIS_X).preset)).toBe(false);
    });

    test('a wall off the grid is not written, and reports so', () => {
        expect(placeDividerEnd(floor(), 20, 15, AXIS_X)).toBe(false);
    });

    test('a run disagreeing with itself is made coherent', () => {
        const model = splitFloor();

        // Both ends the same preset, which is a shape no base game floor has.
        setWall(model, 6, 15, AXIS_X, DIVIDER_END_LEFT);
        setWall(model, 6, 16, AXIS_X, DIVIDER_CENTRE);
        setWall(model, 6, 17, AXIS_X, DIVIDER_END_LEFT);

        placeDividerEnd(model, 6, 15, AXIS_X);

        expect(posts(model, [[6, 15], [6, 17]], AXIS_X)).toEqual([true, false]);
    });

    test('a centre in the run is left alone', () => {
        const model = splitFloor();
        setWall(model, 6, 16, AXIS_X, DIVIDER_CENTRE);

        placeDividerEnd(model, 6, 15, AXIS_X);

        expect(getWall(model, 6, 16, AXIS_X).preset).toBe(DIVIDER_CENTRE);
    });
});

/*
 * Flipping is the escape hatch for the case the rule cannot decide -- a wall with the
 * same room on both sides, where the game settles it by something a blueprint does not
 * record. It turns the run round, which is the whole of the control available there.
 */
describe('flipping a run', () => {
    test('flipping puts both posts inward, not just the one placed', () => {
        const model = splitFloor();
        setWall(model, 6, 16, AXIS_X, DIVIDER_CENTRE);
        placeDividerEnd(model, 6, 15, AXIS_X);
        placeDividerEnd(model, 6, 17, AXIS_X);

        replace(model, 6, 15, AXIS_X);

        expect(posts(model, [[6, 15], [6, 17]], AXIS_X)).toEqual([false, true]);
    });

    test('flipping from the high end gives the same run as flipping from the low', () => {
        const fromLow = splitFloor();
        const fromHigh = splitFloor();
        for (const model of [fromLow, fromHigh]) {
            setWall(model, 6, 16, AXIS_X, DIVIDER_CENTRE);
            placeDividerEnd(model, 6, 15, AXIS_X);
            placeDividerEnd(model, 6, 17, AXIS_X);
        }

        replace(fromLow, 6, 15, AXIS_X);
        replace(fromHigh, 6, 17, AXIS_X);

        const read = (m) => [[6, 15], [6, 17]].map(([x, y]) => getWall(m, x, y, AXIS_X).preset);
        expect(read(fromLow)).toEqual(read(fromHigh));
    });

    test('flipping twice is where it started', () => {
        const model = splitFloor();
        setWall(model, 6, 16, AXIS_X, DIVIDER_CENTRE);
        placeDividerEnd(model, 6, 15, AXIS_X);
        placeDividerEnd(model, 6, 17, AXIS_X);

        replace(model, 6, 15, AXIS_X);
        replace(model, 6, 15, AXIS_X);

        expect(posts(model, [[6, 15], [6, 17]], AXIS_X)).toEqual([true, false]);
    });
});

describe('what the wall tool paints', () => {
    test('the piece is not an id, so nothing can write it as one', () => {
        expect(isDividerEnd(DIVIDER_END)).toBe(false);
        expect(isDivider(DIVIDER_END)).toBe(false);
    });
});
