import { test, expect } from '@playwright/test';
import { installFsHarness, gotoFlow } from './support/harness.js';

/**
 * Editing a floor: walls, and layout variations.
 *
 * The round trip in buildingFloorModel.spec.js proves the model can read the base game
 * and write it back. It says nothing about what happens once something is changed,
 * which is what this covers.
 *
 * Walls get the most attention because a wall is stored on *both* of the nodes it sits
 * between, and writing one side only produces a wall the game half-renders -- a fault
 * invisible in the editor, invisible in the JSON unless you know to look, and visible
 * only once the floor is loaded in the game. It is the single most likely way for this
 * flow to emit a corrupt floor.
 */

/** Run a function against a freshly built model and return whatever it reports. */
async function withModel(page, body) {
    return page.evaluate(async (source) => {
        const model = await import('/flows/building/scripts/floorModel.js');

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

        // eslint-disable-next-line no-new-func
        return new Function('model', 'blankFloor', `return (${source})(model, blankFloor)`)(
            model, blankFloor);
    }, body.toString());
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
});


/* -------------------------------------------------------------------------- */
/* Walls                                                                       */
/* -------------------------------------------------------------------------- */

test('a wall is written to both of the nodes it sits between', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
        const floor = model.parseFloor(blankFloor());
        model.setWall(floor, 5, 5, model.AXIS_X, '7');

        return {
            low: model.nodeAt(floor, 5, 5).walls,
            high: model.nodeAt(floor, 6, 5).walls,
            untouchedAbove: model.nodeAt(floor, 5, 6).walls,
        };
    });

    // Opposite offsets, same preset. The pair is the wall.
    expect(result.low).toEqual([{ ox: 0.5, oy: 0, preset: '7' }]);
    expect(result.high).toEqual([{ ox: -0.5, oy: 0, preset: '7' }]);
    expect(result.untouchedAbove).toEqual([]);
});

test('a wall on the y axis is written the same way', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
        const floor = model.parseFloor(blankFloor());
        model.setWall(floor, 5, 5, model.AXIS_Y, '16');

        return { low: model.nodeAt(floor, 5, 5).walls, high: model.nodeAt(floor, 5, 6).walls };
    });

    expect(result.low).toEqual([{ ox: 0, oy: 0.5, preset: '16' }]);
    expect(result.high).toEqual([{ ox: 0, oy: -0.5, preset: '16' }]);
});

test('a wall offset is never a negative zero', async ({ page }) => {
    // -0 and 0 are the same number to look at, serialise to the same JSON, and compare
    // unequal. A wall carrying one would make a floor differ from itself.
    const signs = await withModel(page, (model, blankFloor) => {
        const floor = model.parseFloor(blankFloor());
        model.setWall(floor, 5, 5, model.AXIS_X, '7');
        model.setWall(floor, 8, 8, model.AXIS_Y, '7');

        const all = [
            ...model.nodeAt(floor, 5, 5).walls, ...model.nodeAt(floor, 6, 5).walls,
            ...model.nodeAt(floor, 8, 8).walls, ...model.nodeAt(floor, 8, 9).walls,
        ];

        return all.flatMap((wall) => [Object.is(wall.ox, -0), Object.is(wall.oy, -0)]);
    });

    expect(signs.every((isNegativeZero) => isNegativeZero === false)).toBe(true);
});

test('painting over a wall replaces it rather than stacking on it', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
        const floor = model.parseFloor(blankFloor());
        model.setWall(floor, 5, 5, model.AXIS_X, '7');
        model.setWall(floor, 5, 5, model.AXIS_X, '16');

        return {
            low: model.nodeAt(floor, 5, 5).walls,
            high: model.nodeAt(floor, 6, 5).walls,
        };
    });

    expect(result.low).toEqual([{ ox: 0.5, oy: 0, preset: '16' }]);
    expect(result.high).toEqual([{ ox: -0.5, oy: 0, preset: '16' }]);
});

test('a wall on one axis leaves the other axis alone', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
        const floor = model.parseFloor(blankFloor());
        model.setWall(floor, 5, 5, model.AXIS_X, '7');
        model.setWall(floor, 5, 5, model.AXIS_Y, '16');
        model.setWall(floor, 5, 5, model.AXIS_X, '11');

        return model.nodeAt(floor, 5, 5).walls;
    });

    // Replacing the x wall must not disturb the y wall sharing the node.
    expect(result).toEqual([
        { ox: 0, oy: 0.5, preset: '16' },
        { ox: 0.5, oy: 0, preset: '11' },
    ]);
});

test('clearing a wall clears both halves', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
        const floor = model.parseFloor(blankFloor());
        model.setWall(floor, 5, 5, model.AXIS_X, '7');
        model.clearWall(floor, 5, 5, model.AXIS_X);

        return {
            low: model.nodeAt(floor, 5, 5).walls,
            high: model.nodeAt(floor, 6, 5).walls,
            reported: model.getWall(floor, 5, 5, model.AXIS_X),
        };
    });

    expect(result.low).toEqual([]);
    expect(result.high).toEqual([]);
    expect(result.reported).toBeNull();
});

test('a wall off the edge of the grid is refused rather than half written', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
        const floor = model.parseFloor(blankFloor());

        return {
            written: model.setWall(floor, 20, 5, model.AXIS_X, '7'),
            walls: model.nodeAt(floor, 20, 5).walls,
            cleared: model.clearWall(floor, 5, 20, model.AXIS_Y),
        };
    });

    expect(result.written).toBe(false);
    expect(result.walls).toEqual([]);
    expect(result.cleared).toBe(false);
});

test('a wall whose halves disagree is reported rather than repaired', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
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

        return {
            mismatches: floor.issues.wallMismatches,
            disagreeing: model.getWall(floor, 5, 5, model.AXIS_X),
            lonely: model.getWall(floor, 9, 9, model.AXIS_X),
            keptLow: model.nodeAt(floor, 5, 5).walls,
            keptHigh: model.nodeAt(floor, 6, 5).walls,
        };
    });

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

test('a backfilled node is given its half of the wall facing it', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
        const source = blankFloor();
        const nodes = source.a_d[0].vs[0].r_d[0].n_d;

        // Take (5, 5) out of the file, and have its neighbour record a wall facing it.
        const neighbour = nodes.find((n) => n.f_c.x === 6 && n.f_c.y === 5);
        neighbour.w_d = [{ w_o: { x: -0.5, y: 0 }, p_n: '7' }];
        source.a_d[0].vs[0].r_d[0].n_d = nodes.filter(
            (n) => !(n.f_c.x === 5 && n.f_c.y === 5));

        const floor = model.parseFloor(source);

        return {
            gaps: floor.issues.gaps,
            backfilled: model.nodeAt(floor, 5, 5).backfilled,
            walls: model.nodeAt(floor, 5, 5).walls,
            mismatches: floor.issues.wallMismatches,
        };
    });

    expect(result.gaps).toEqual([{ x: 5, y: 5 }]);
    expect(result.backfilled).toBe(true);

    // Its half of the neighbour's wall, pointing back at the neighbour. Without this
    // the floor would load with half a wall at (5, 5).
    expect(result.walls).toEqual([{ ox: 0.5, oy: 0, preset: '7' }]);
    expect(result.mismatches).toEqual([]);
});


/* -------------------------------------------------------------------------- */
/* Variations                                                                  */
/* -------------------------------------------------------------------------- */

test('selecting a variation changes what the grid shows', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
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

        return { first, second, selected: floor.addresses[1].selectedVariation };
    });

    // Variation 0: the Lobby holds (10, 10) and Outside holds (11, 11).
    expect(result.first).toEqual({ at1010: 1, at1111: 0 });
    // Variation 1: the other way round.
    expect(result.second).toEqual({ at1010: 0, at1111: 1 });
    expect(result.selected).toBe(1);
});

test('an edit survives switching variation and coming back', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
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
        return {
            heightNow: model.nodeAt(floor, 10, 10).height,
            written: written.a_d[1].vs.map((v) => v.r_d[0].n_d.map((n) => [n.f_c.x, n.f_c.y, n.f_h])),
        };
    });

    expect(result.heightNow).toBe(7);
    expect(result.written).toEqual([
        [[10, 10, 7]],
        [[11, 11, 0]],
    ]);
});

test('duplicating a variation leaves the original alone', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
        const source = blankFloor();
        source.a_d[1].vs = [
            { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 3, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
        ];

        const floor = model.parseFloor(source);
        const copy = model.duplicateVariation(floor, 1);
        model.nodeAt(floor, 10, 10).height = 9;

        const written = model.serialiseFloor(floor);
        return {
            copy,
            count: floor.addresses[1].variations.length,
            heights: written.a_d[1].vs.map((v) => v.r_d[0].n_d[0].f_h),
        };
    });

    expect(result.copy).toBe(1);
    expect(result.count).toBe(2);
    // The copy took the edit; the original kept what it had.
    expect(result.heights).toEqual([3, 9]);
});

test('adding a variation gives an address an empty layout to paint into', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
        const source = blankFloor();
        source.a_d[1].vs = [
            { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
        ];

        const floor = model.parseFloor(source);
        const added = model.addVariation(floor, 1);

        return {
            added,
            // The Lobby now covers nothing, so the node falls back to Outside.
            ownerOf1010: model.nodeAt(floor, 10, 10).addressIndex,
            backfilled: model.nodeAt(floor, 10, 10).backfilled,
            gaps: floor.issues.gaps.length,
            stillWritten: model.serialiseFloor(floor).a_d[1].vs[0].r_d[0].n_d.length,
        };
    });

    expect(result.added).toBe(1);
    expect(result.ownerOf1010).toBe(0);

    // Outside's own layout already covered that node, so it is Outside's real node
    // rather than an invented one -- no gap opened, and nothing needed filling in.
    expect(result.backfilled).toBe(false);
    expect(result.gaps).toBe(0);

    // The layout that is no longer on show still holds its node.
    expect(result.stillWritten).toBe(1);
});

test('removing a variation drops that layout and nothing else', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
        const source = blankFloor();
        source.a_d[1].vs = [
            { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
            { r_d: [{ id: 3, n_d: [{ f_c: { x: 11, y: 11 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
        ];

        const floor = model.parseFloor(source);
        model.removeVariation(floor, 1, 0);

        const written = model.serialiseFloor(floor);
        return {
            count: floor.addresses[1].variations.length,
            selected: floor.addresses[1].selectedVariation,
            remaining: written.a_d[1].vs.map((v) => v.r_d[0].n_d.map((n) => [n.f_c.x, n.f_c.y])),
        };
    });

    expect(result.count).toBe(1);
    expect(result.selected).toBe(0);
    // What survives is the layout that was not removed.
    expect(result.remaining).toEqual([[[11, 11]]]);
});

test('an address stripped of its last variation covers nothing', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
        const source = blankFloor();
        source.a_d[1].vs = [
            { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
        ];

        const floor = model.parseFloor(source);
        model.removeVariation(floor, 1, 0);

        return {
            selected: floor.addresses[1].selectedVariation,
            ownerOf1010: model.nodeAt(floor, 10, 10).addressIndex,
            variationsWritten: model.serialiseFloor(floor).a_d[1].vs.length,
        };
    });

    // Six base game addresses are already in this state, so it has to be representable
    // rather than prevented.
    expect(result.selected).toBe(-1);
    expect(result.ownerOf1010).toBe(0);
    expect(result.variationsWritten).toBe(0);
});

test('two addresses on one node are reported, and the node belongs to one of them', async ({ page }) => {
    const result = await withModel(page, (model, blankFloor) => {
        const source = blankFloor();

        // Outside already covers the whole grid; the Lobby claims one of its nodes too.
        source.a_d[1].vs = [
            { r_d: [{ id: 2, n_d: [{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 1, f_r: '', w_d: [] }], l: 'Lobby' }] },
        ];

        const floor = model.parseFloor(source);
        return {
            overlaps: floor.issues.overlaps,
            owner: model.nodeAt(floor, 10, 10).addressIndex,
            issues: model.describeIssues(floor),
        };
    });

    expect(result.overlaps).toEqual([
        { x: 10, y: 10, heldBy: 0, alsoClaimedBy: 1 },
    ]);
    // Later claim wins, matching what the reference tool renders.
    expect(result.owner).toBe(1);
    expect(result.issues).toEqual(['1 node(s) claimed by more than one address']);
});
