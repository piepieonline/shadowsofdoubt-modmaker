import { test, expect } from '@playwright/test';
import { installFsHarness, gotoFlow } from './support/harness.js';

/**
 * The floorplan view.
 *
 * WebGL runs in headless Chromium through SwiftShader, so this can be driven for real
 * rather than mocked. What it is worth driving is a narrow list, and it is narrow on
 * purpose: asserting on the result of a raycast against an `InstancedMesh` would be
 * testing three.js, and asserting on pixels would be testing SwiftShader. What belongs
 * here is the layer this app actually wrote -- that a canvas appears and tracks its
 * container, that the mapping between an instance index and a floor coordinate is the
 * same in both directions, and that a point on screen resolves to the cell that is
 * really there.
 *
 * The last of those is the one that matters, because every painting tool is built on
 * it. It is checked as a round trip: project a cell to a screen point, pick at that
 * point, and get the same cell back.
 */

/**
 * Mount a scene in a sized container and run a body against it.
 *
 * The container is given an explicit size because a detached test page has no layout
 * to inherit one from, and a canvas of zero by zero makes every projection NaN.
 */
async function withScene(page, body, arg) {
    return page.evaluate(async ({ source, arg: passed }) => {
        const sceneModule = await import('/flows/building/scripts/scene.js');
        const { parseFloor } = await import('/flows/building/scripts/floorModel.js');

        const container = document.createElement('div');
        container.style.cssText = 'width: 640px; height: 480px; position: absolute; top: 0; left: 0;';
        document.body.appendChild(container);

        const floor = parseFloor(await (await fetch('/refs/floors/blueprints/Hotel_GroundFloor.json')).json());

        const scene = await sceneModule.createScene(container);
        scene.setModel(floor);
        scene.draw();

        try {
            // eslint-disable-next-line no-new-func
            return await new Function('scene', 'container', 'floor', 'sceneModule', 'arg',
                `return (${source})(scene, container, floor, sceneModule, arg)`)(
                scene, container, floor, sceneModule, passed);
        } finally {
            scene.dispose();
            container.remove();
        }
    }, { source: body.toString(), arg });
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
});


/* -------------------------------------------------------------------------- */
/* The canvas                                                                  */
/* -------------------------------------------------------------------------- */

test('a canvas appears, sized to its container', async ({ page }) => {
    const size = await withScene(page, (scene, container) => ({
        isCanvas: scene.canvas.tagName,
        inContainer: scene.canvas.parentElement === container,
        width: scene.canvas.width,
        height: scene.canvas.height,
        cssWidth: scene.canvas.clientWidth,
        cssHeight: scene.canvas.clientHeight,
    }));

    expect(size.isCanvas).toBe('CANVAS');
    expect(size.inContainer).toBe(true);
    expect(size.cssWidth).toBe(640);
    expect(size.cssHeight).toBe(480);

    // The backing store is scaled by the device pixel ratio, so it is at least the CSS
    // size and a whole multiple of it.
    expect(size.width).toBeGreaterThanOrEqual(640);
    expect(size.height).toBeGreaterThanOrEqual(480);
});

test('the view follows its container when that changes size', async ({ page }) => {
    const after = await withScene(page, async (scene, container) => {
        container.style.width = '320px';
        container.style.height = '200px';

        // ResizeObserver fires off a frame; give it one.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        return {
            cssWidth: scene.canvas.clientWidth,
            cssHeight: scene.canvas.clientHeight,
            aspect: scene._internals.camera.aspect,
        };
    });

    expect(after.cssWidth).toBe(320);
    expect(after.cssHeight).toBe(200);
    // A camera left at the old aspect ratio would stretch the floor.
    expect(after.aspect).toBeCloseTo(320 / 200, 3);
});

test('the floor is actually drawn', async ({ page }) => {
    const drawn = await withScene(page, (scene) => {
        scene.draw();

        // Read the framebuffer rather than trusting that render() was called: an empty
        // scene, a camera pointing the wrong way and a failed context all still return.
        const pixels = scene.canvas.toDataURL();
        const context = scene._internals.renderer.getContext();

        return {
            bytes: pixels.length,
            lost: context.isContextLost(),
            cellCount: scene._internals.cells.count,
            wallCount: scene._internals.walls.count,
        };
    });

    expect(drawn.lost).toBe(false);
    expect(drawn.bytes).toBeGreaterThan(1000);

    // One instance per node and one per wall slot -- 441 and 840.
    expect(drawn.cellCount).toBe(441);
    expect(drawn.wallCount).toBe(840);
});


/* -------------------------------------------------------------------------- */
/* Hit-testing, which every tool is built on                                   */
/* -------------------------------------------------------------------------- */

test('a point on screen resolves to the cell that is there', async ({ page }) => {
    const round = await withScene(page, (scene) => {
        const checked = [];
        const missed = [];

        // Spread across the grid, including the outer margin and all four corners, so
        // a mapping that is right in the middle and wrong at the edge fails here.
        for (let x = 0; x < 21; x += 2) {
            for (let y = 0; y < 21; y += 2) {
                const at = scene.project(x, y);
                if (!at) { missed.push(`${x},${y} did not project`); continue; }

                const hit = scene.cellAt({ clientX: at.left, clientY: at.top });
                if (!hit) { missed.push(`${x},${y} hit nothing`); continue; }

                checked.push(`${x},${y}`);
                if (hit.x !== x || hit.y !== y) {
                    missed.push(`${x},${y} resolved to ${hit.x},${hit.y}`);
                }
            }
        }

        return { checked: checked.length, missed };
    });

    expect(round.missed).toEqual([]);
    expect(round.checked).toBe(121);
});

test('a point off the floor resolves to nothing', async ({ page }) => {
    const hit = await withScene(page, (scene) => scene.cellAt({ clientX: 2, clientY: 2 }));

    // The top-left of the view is sky. A tool that painted there would paint whatever
    // cell happened to be first in the buffer.
    expect(hit).toBeNull();
});

/**
 * Wall tests use a floor with no walls in it, so that the only thing standing up is the
 * one the test put there and nothing else can be in the way of it.
 */
async function withBareFloor(page, body, arg) {
    return page.evaluate(async ({ source, arg: passed }) => {
        const sceneModule = await import('/flows/building/scripts/scene.js');
        const modelModule = await import('/flows/building/scripts/floorModel.js');

        const nodes = [];
        for (let x = 0; x < 21; x++) {
            for (let y = 0; y < 21; y++) {
                nodes.push({ f_c: { x, y }, f_h: 0, f_t: 1, f_r: '', w_d: [] });
            }
        }

        const floor = modelModule.parseFloor({
            floorName: 'Bare',
            a_d: [{ p_n: 'Outside', e_c: { r: 1, g: 0, b: 0.4, a: 1 }, vs: [{ r_d: [{ id: 1, n_d: nodes, l: 'Null' }] }] }],
            t_d: [],
        });

        const container = document.createElement('div');
        container.style.cssText = 'width: 800px; height: 600px; position: absolute; top: 0; left: 0;';
        document.body.appendChild(container);

        const scene = await sceneModule.createScene(container);
        scene.setModel(floor);

        try {
            // eslint-disable-next-line no-new-func
            return await new Function('scene', 'floor', 'model', 'sceneModule', 'arg',
                `return (${source})(scene, floor, model, sceneModule, arg)`)(
                scene, floor, modelModule, sceneModule, passed);
        } finally {
            scene.dispose();
            container.remove();
        }
    }, { source: body.toString(), arg });
}

test('a wall is picked in preference to the cells it stands between', async ({ page }) => {
    const result = await withBareFloor(page, (scene, floor, model) => {
        model.setWall(floor, 10, 10, model.AXIS_X, '16');
        scene.refresh();
        scene.draw();

        const at = scene.projectWall(10, 10, model.AXIS_X);
        const picked = scene.pickAt({ clientX: at.left, clientY: at.top });

        // A cell well away from any wall still picks as a cell.
        const open = scene.project(3, 3);
        const cell = scene.pickAt({ clientX: open.left, clientY: open.top });

        return {
            picked: picked && { kind: picked.kind, x: picked.x, y: picked.y, axis: picked.axis },
            cell: cell && { kind: cell.kind, x: cell.x, y: cell.y },
        };
    });

    // A wall stands above the two cells it sits between, so aiming at it must not fall
    // through to the floor behind.
    expect(result.picked).toEqual({ kind: 'wall', x: 10, y: 10, axis: 'x' });
    expect(result.cell).toEqual({ kind: 'cell', x: 3, y: 3 });
});

test('a wall under a screen point reports its own coordinates', async ({ page }) => {
    const found = await withBareFloor(page, (scene, floor, model) => {
        // A y-axis wall, which is the block of instances the arithmetic is most likely
        // to get wrong -- it is offset past all 420 of the x-axis ones.
        model.setWall(floor, 8, 12, model.AXIS_Y, '11');
        scene.refresh();
        scene.draw();

        const at = scene.projectWall(8, 12, model.AXIS_Y);
        const hit = scene.wallAt({ clientX: at.left, clientY: at.top });

        return hit && { x: hit.x, y: hit.y, axis: hit.axis };
    });

    expect(found).toEqual({ x: 8, y: 12, axis: 'y' });
});

/**
 * What a wall is drawn as. The four kinds differ by where the opening touches:
 * a window is framed all round, a door reaches the floor, a blank reaches the top.
 *
 * Read off the instance matrices rather than off pixels, because the question is what
 * geometry was placed -- reading pixels would be testing SwiftShader's rasteriser.
 */
async function shapeOf(page, preset) {
    return withBareFloor(page, (scene, floor, model, sceneModule, wanted) => {
        // Set the kinds table the way the flow's reference data does.
        model.setWall(floor, 10, 10, model.AXIS_X, wanted);
        scene.refresh();

        const parts = scene._internals.wallParts;
        const slot = sceneModule.instanceOfWall(10, 10, model.AXIS_X);

        const matrix = new scene._internals.THREE.Matrix4();
        const pieces = [];

        for (let part = 0; part < 4; part++) {
            parts.getMatrixAt(slot * 4 + part, matrix);

            // Read straight off the matrix rather than through decompose: these are
            // scale-and-translate only, so the diagonal *is* the size, and decompose
            // divides by it -- which for the zero matrix an unused piece carries is a
            // division by zero rather than an answer.
            const e = matrix.elements;
            const [scaleY, scaleZ] = [e[5], e[10]];
            const [alongPosition, upPosition] = [e[14], e[13]];

            if (e[0] === 0 && scaleY === 0 && scaleZ === 0) continue;

            // An x-axis wall runs along z, so its length is the z scale and where it
            // sits along the wall is z. Rounded: these are exact fractions of a cell.
            pieces.push({
                along: Number(scaleZ.toFixed(3)),
                rise: Number(scaleY.toFixed(3)),
                offsetAlong: Number((alongPosition - 10.5).toFixed(3)),
                offsetUp: Number((upPosition - 0.275).toFixed(3)),
            });
        }

        return pieces;
    }, preset);
}

test('a solid wall is drawn as one piece filling the slot', async ({ page }) => {
    await page.evaluate(() => { window.wallPresetKinds = { 0: 'wall' }; });
    const pieces = await shapeOf(page, '0');

    expect(pieces).toEqual([{ along: 1, rise: 0.55, offsetAlong: 0, offsetUp: 0 }]);
});

test('a window is drawn as a frame all the way around its opening', async ({ page }) => {
    await page.evaluate(() => { window.wallPresetKinds = { 16: 'window' }; });
    const pieces = await shapeOf(page, '16');

    // Two jambs the full height, then a lintel and a sill across the gap between them.
    expect(pieces).toEqual([
        { along: 0.25, rise: 0.55, offsetAlong: -0.375, offsetUp: 0 },
        { along: 0.25, rise: 0.55, offsetAlong: 0.375, offsetUp: 0 },
        { along: 0.5, rise: 0.138, offsetAlong: 0, offsetUp: 0.206 },
        { along: 0.5, rise: 0.138, offsetAlong: 0, offsetUp: -0.206 },
    ]);
});

test('a door is drawn as an opening reaching the floor', async ({ page }) => {
    await page.evaluate(() => { window.wallPresetKinds = { 7: 'door' }; });
    const pieces = await shapeOf(page, '7');

    // The window's frame without its sill: two jambs and a lintel, nothing underneath.
    expect(pieces).toEqual([
        { along: 0.25, rise: 0.55, offsetAlong: -0.375, offsetUp: 0 },
        { along: 0.25, rise: 0.55, offsetAlong: 0.375, offsetUp: 0 },
        { along: 0.5, rise: 0.138, offsetAlong: 0, offsetUp: 0.206 },
    ]);
});

test('a blank is drawn as an opening reaching the top', async ({ page }) => {
    await page.evaluate(() => { window.wallPresetKinds = { 11: 'blank' }; });
    const pieces = await shapeOf(page, '11');

    // The other way up from a door: two jambs and a sill, open above.
    expect(pieces).toEqual([
        { along: 0.25, rise: 0.55, offsetAlong: -0.375, offsetUp: 0 },
        { along: 0.25, rise: 0.55, offsetAlong: 0.375, offsetUp: 0 },
        { along: 0.5, rise: 0.138, offsetAlong: 0, offsetUp: -0.206 },
    ]);
});

/**
 * The dividers, which are blanks with something more specific drawn for them, and the
 * entrance that is drawn at the same height as one.
 *
 * A divider is a run of partition rather than one wall, so two things have to be
 * readable: that it spans, and where a run of it ends. The rail is the first -- a lintel
 * across the whole wall rather than an opening's width, so that neighbouring dividers
 * join into one line -- and a post at one end is the second.
 *
 * The rail runs along the top: a band at the floor is read as part of the floor, and at
 * this camera angle is very nearly under it. The posts are a blank's own jambs, so half
 * of what a blank has is the whole of the difference between the two ends.
 *
 * The rail's rise is 0.35 of the wall's 0.55, which is 0.1925 -- exactly on the boundary
 * shapeOf's three decimal places round at. An instance matrix is a Float32Array, so what
 * is read back is a shade under that rather than a shade over, and it rounds down. Every
 * other figure here is far enough from a boundary for the two to agree.
 */
const RAIL = { along: 1, rise: 0.192, offsetAlong: 0, offsetUp: 0.179 };
const POST_LEFT = { along: 0.25, rise: 0.55, offsetAlong: -0.375, offsetUp: 0 };
const POST_RIGHT = { along: 0.25, rise: 0.55, offsetAlong: 0.375, offsetUp: 0 };

/** The kinds table as the reference data has it: all four of these are blanks. */
const asBlanks = (page) => page.evaluate(() => {
    window.wallPresetKinds = { 4: 'blank', 5: 'blank', 6: 'blank', 10: 'blank' };
});

test('a divider middle is drawn as a rail across the whole wall, with no posts', async ({ page }) => {
    // The kinds table calls it a blank; the specific shape is what wins over that.
    await asBlanks(page);

    expect(await shapeOf(page, '4')).toEqual([RAIL]);
});

test('the two divider ends are drawn on opposite sides of each other', async ({ page }) => {
    await asBlanks(page);

    // Which of the two is drawn at the near end depends on which side of the wall the
    // parent room is -- see dividerEnds.js -- so what is fixed is only that they differ.
    // On a floor of one room the parent falls to the low node, which puts EndRight's post
    // at the near end of a wall along x.
    const [left, right] = [await shapeOf(page, '5'), await shapeOf(page, '6')];

    expect([left, right]).toContainEqual([POST_LEFT, RAIL]);
    expect([left, right]).toContainEqual([POST_RIGHT, RAIL]);
    expect(left).not.toEqual(right);
});

/**
 * The same preset, on the two axes, drawn *opposite* ways round.
 *
 * Two things are going on and they must not be confused. The scene mirrors the floor's x
 * axis, so a piece offset along a wall on that axis moves the opposite way to one on a
 * wall that does not -- `placePart` undoes that, and this is what proves it still does.
 *
 * On top of it, the game's own rule genuinely does mirror between the axes: with the
 * parent on the same side, a wall along x has its left end at high y while a wall along y
 * has its left end at low x. So reading both back in the floor's own coordinates, the
 * same preset lands on opposite ends of the two walls. That is not the mirror leaking --
 * it is the rule, and a view that drew them alike would be hiding it.
 */
test('an asymmetric preset is drawn mirrored between the axes, as the rule has it',
    async ({ page }) => {
    await asBlanks(page);

    const post = await withBareFloor(page, (scene, floor, model, sceneModule) => {
        model.setWall(floor, 10, 10, model.AXIS_X, '5');
        model.setWall(floor, 10, 10, model.AXIS_Y, '5');
        scene.refresh();

        const parts = scene._internals.wallParts;
        const matrix = new scene._internals.THREE.Matrix4();

        // The post is the shape's first piece, and both walls have their middle at 10.5
        // along themselves: the x-axis one runs along z, the y-axis one along x.
        const offsetOf = (axis) => {
            parts.getMatrixAt(sceneModule.instanceOfWall(10, 10, axis) * 4, matrix);
            const e = matrix.elements;

            // Read back through the mirror for the wall that lies on the mirrored axis,
            // so both answers are in the floor's own coordinates.
            const at = axis === model.AXIS_X ? e[14] : model.NODE_GRID - e[12];
            return Number((at - 10.5).toFixed(3));
        };

        return { x: offsetOf(model.AXIS_X), y: offsetOf(model.AXIS_Y) };
    });

    expect(post).toEqual({ x: 0.375, y: -0.375 });
});

test('a nothing entrance is drawn as a threshold at a divider\'s height', async ({ page }) => {
    await asBlanks(page);

    // The rail at the same height, across the middle of the wall alone: a way through
    // marked where you pass it, rather than a hole in a wall.
    expect(await shapeOf(page, '10')).toEqual([
        { ...RAIL, along: 0.5 },
    ]);
});

test('a divider is coloured as a door rather than as the blank it is', async ({ page }) => {
    // The kinds table as the reference data has it, for the two kinds compared against
    // as well as for the dividers.
    await page.evaluate(() => {
        window.wallPresetKinds = { 4: 'blank', 5: 'blank', 6: 'blank', 7: 'door', 11: 'blank' };
    });

    const colours = await withBareFloor(page, (scene, floor, model, sceneModule) => {
        const colourOf = (preset) => {
            model.setWall(floor, 10, 10, model.AXIS_X, preset);
            scene.refresh();

            const at = sceneModule.instanceOfWall(10, 10, model.AXIS_X) * 4 * 3;
            const array = scene._internals.wallParts.instanceColor.array;
            return [...array.slice(at, at + 3)].map((value) => Number(value.toFixed(3)));
        };

        // A door, a blank, and the three dividers -- which the kinds table calls blanks.
        return {
            door: colourOf('7'),
            blank: colourOf('11'),
            dividers: ['4', '5', '6'].map(colourOf),
        };
    });

    // The dark grey of a blank says "nothing here", which a divider is not: it is a thing
    // to see over and step past, and it reads with the openings you pass through.
    expect(colours.door).not.toEqual(colours.blank);
    for (const divider of colours.dividers) expect(divider).toEqual(colours.door);
});

test('a preset the kinds table has never heard of is drawn as a solid wall', async ({ page }) => {
    await page.evaluate(() => { window.wallPresetKinds = {}; });
    const pieces = await shapeOf(page, '29');

    // Ids 28 to 30 name nothing the game has, so a floor referring to one is already
    // saying something that cannot be interpreted. A box claims least about it.
    expect(pieces).toEqual([{ along: 1, rise: 0.55, offsetAlong: 0, offsetUp: 0 }]);
});

test('a wall is hit where it looks solid, including across a window\'s opening', async ({ page }) => {
    const hit = await withBareFloor(page, (scene, floor, model) => {
        window.wallPresetKinds = { 16: 'window' };
        model.setWall(floor, 10, 10, model.AXIS_X, '16');
        scene.refresh();
        scene.draw();

        // Dead centre of the wall, which for a window is the middle of the hole.
        const at = scene.projectWall(10, 10, model.AXIS_X);
        const picked = scene.pickAt({ clientX: at.left, clientY: at.top });

        return {
            picked: picked && { kind: picked.kind, x: picked.x, y: picked.y, axis: picked.axis },
            proxyDrawn: scene._internals.walls.visible,
        };
    });

    // Aiming at the middle of a window has to select the window. Without a solid proxy
    // the ray would pass through the opening and find the floor beyond it.
    expect(hit.picked).toEqual({ kind: 'wall', x: 10, y: 10, axis: 'x' });

    // And the proxy is never drawn -- three checks visibility when rendering and layers
    // when raycasting, which is what lets one mesh do the hit-testing for another.
    expect(hit.proxyDrawn).toBe(false);
});

test('every wall slot can be aimed at, on both axes', async ({ page }) => {
    // The arithmetic behind instanceOfWall is checked directly elsewhere; this is that
    // the geometry agrees with it, which is what a painting tool depends on.
    const result = await withBareFloor(page, (scene, floor, model) => {
        const wrong = [];
        let checked = 0;

        for (const [x, y, axis] of [
            [3, 3, 'x'], [3, 3, 'y'], [10, 10, 'x'], [10, 10, 'y'],
            [17, 17, 'x'], [17, 17, 'y'], [0, 0, 'x'], [19, 20, 'x'], [20, 19, 'y'],
        ]) {
            model.setWall(floor, x, y, axis, '0');
            scene.refresh();

            const at = scene.projectWall(x, y, axis);
            const hit = scene.wallAt({ clientX: at.left, clientY: at.top });
            checked++;

            if (!hit || hit.x !== x || hit.y !== y || hit.axis !== axis) {
                wrong.push(`${x},${y},${axis} -> ${hit ? `${hit.x},${hit.y},${hit.axis}` : 'nothing'}`);
            }

            model.clearWall(floor, x, y, axis);
        }

        return { wrong, checked };
    });

    expect(result.wrong).toEqual([]);
    expect(result.checked).toBe(9);
});


/* -------------------------------------------------------------------------- */
/* Overlays and labels                                                         */
/* -------------------------------------------------------------------------- */

test('changing overlay recolours the floor', async ({ page }) => {
    const colours = await withScene(page, (scene, container, floor, sceneModule) => {
        const read = () => {
            const array = scene._internals.cells.instanceColor.array;
            // A handful of cells, as a fingerprint of the whole buffer.
            return [0, 100, 220, 440].map((i) => array.slice(i * 3, i * 3 + 3).join(','));
        };

        scene.setOverlay(sceneModule.Overlay.ADDRESS);
        const byAddress = read();

        scene.setOverlay(sceneModule.Overlay.FLOOR_TYPE);
        const byFloorType = read();

        scene.setOverlay(sceneModule.Overlay.ROOM);
        const byRoom = read();

        return { byAddress, byFloorType, byRoom, mode: scene.overlay };
    });

    expect(colours.mode).toBe('room');
    expect(colours.byFloorType).not.toEqual(colours.byAddress);
    expect(colours.byRoom).not.toEqual(colours.byAddress);
});


/*
 * The floor type overlay, which is the one that draws shapes rather than only colours.
 *
 * Five colours are five things to memorise. Two facts -- is there something to stand on,
 * is there something overhead -- are what the enum's own names are made of, so they are
 * what is drawn: a solid slab or a see-through one, with or without a square floating
 * over it. What is checked here is that the pairing is right and that it happens in this
 * overlay and no other.
 */

/**
 * Where a square is drawn and how big, per mesh.
 *
 * Serialised into the page with the test body, so it takes THREE rather than importing
 * one and spells out the constants it needs: 21 nodes to a side, and a slab 0.08 tall.
 *
 * Read straight off the matrix rather than through `decompose`, which reports a scale of
 * 1 for a matrix scaled to nothing -- three treats a degenerate basis as unit rather than
 * as zero, and "scaled to nothing" is exactly how a square that is not drawn is stored.
 * These are scale and translation only, so the elements are the answer: 0 and 5 are the
 * x and y scale, 13 the height of the middle.
 */
const READ_SQUARE = `(THREE, mesh, x, y) => {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(y * 21 + x, matrix);

    const te = matrix.elements;
    const middle = te[13];
    const height = te[5] * 0.08;

    return {
        drawn: te[0] > 0,
        middle,
        top: middle + height / 2,
        bottom: middle - height / 2,
    };
}`;

test('the floor type overlay draws each square by what it has under and over it', async ({ page }) => {
    const drawn = await withScene(page, async (scene, container, floor, sceneModule, arg) => {
        const { setNodeFloor, nodeAt } = await import('/flows/building/scripts/floorModel.js');
        const { THREE, cells, ghostCells, ceilingCaps } = scene._internals;

        // eslint-disable-next-line no-new-func
        const read = new Function(`return ${arg.readSquare}`)();

        // The Hotel's ground floor carries four of the five types where they are named
        // below. CeilingOnly is the one it has none of -- 254 nodes in the whole base
        // game are one -- so a square is made into one rather than left untested.
        setNodeFloor(floor, nodeAt(floor, 9, 5), 3, 0);

        const at = (x, y) => ({
            solid: read(THREE, cells, x, y).drawn,
            ghost: read(THREE, ghostCells, x, y).drawn,
            cap: read(THREE, ceilingCaps, x, y).drawn,
        });

        const sample = () => ({
            none: at(0, 0),
            floorAndCeiling: at(8, 5),
            floorOnly: at(10, 5),
            ceilingOnly: at(9, 5),
            noneButIndoors: at(4, 10),
        });

        scene.setOverlay(sceneModule.Overlay.FLOOR_TYPE);

        const byType = sample();
        const meshes = { ghost: ghostCells.visible, caps: ceilingCaps.visible };
        const lid = read(THREE, ceilingCaps, 8, 5).middle;

        scene.setOverlay(sceneModule.Overlay.ADDRESS);

        return {
            byType,
            meshes,
            lid,
            byAddress: sample(),
            elsewhere: { ghost: ghostCells.visible, caps: ceilingCaps.visible },
            transparent: ghostCells.material.transparent,
            opacity: ghostCells.material.opacity,
        };
    }, { readSquare: READ_SQUARE });

    // Solid where there is something to stand on, see-through where there is not; a
    // square overhead where the type says there is a ceiling. Exactly one of solid and
    // ghost draws each square, whichever way round.
    expect(drawn.byType).toEqual({
        none: { solid: false, ghost: true, cap: false },
        floorAndCeiling: { solid: true, ghost: false, cap: true },
        floorOnly: { solid: true, ghost: false, cap: false },
        ceilingOnly: { solid: false, ghost: true, cap: true },

        // Drawn exactly as `none` is. Where the game counts the square as being is not a
        // thing the view can show, and the colour is what tells the two apart.
        noneButIndoors: { solid: false, ghost: true, cap: false },
    });

    // Clear of the walls, which stand 0.55 and are the tallest thing in the scene.
    expect(drawn.lid).toBeGreaterThan(0.55);

    // Only here. The address and room overlays are read as flat sheets of colour, and a
    // floor half of which is see-through with squares hanging over it is not one.
    expect(drawn.meshes).toEqual({ ghost: true, caps: true });
    expect(drawn.elsewhere).toEqual({ ghost: false, caps: false });
    for (const square of Object.values(drawn.byAddress)) {
        expect(square).toEqual({ solid: true, ghost: false, cap: false });
    }

    // See-through enough to read the grid and the walls through, or it says nothing.
    expect(drawn.transparent).toBe(true);
    expect(drawn.opacity).toBeLessThan(0.5);
});

test('a raised square stands on a plinth, and only in the overlay that paints one', async ({ page }) => {
    const raised = await withScene(page, async (scene, container, floor, sceneModule, arg) => {
        const { THREE, cells, ghostCells, cellHits } = scene._internals;

        // eslint-disable-next-line no-new-func
        const read = new Function(`return ${arg.readSquare}`)();

        scene.setOverlay(sceneModule.Overlay.FLOOR_TYPE);

        // 5,9 is the Hotel's tallest square: f_h 51 against a ceiling of 45. It is also
        // noneButIndoors, so the mesh drawing it is the see-through one -- height and type
        // are independent, and a square with nothing to stand on can still be up in the
        // air. 8,5 is at the floor's own level, which every square on all but 71 base game
        // floors is.
        const tall = read(THREE, ghostCells, 5, 9);
        const flat = read(THREE, cells, 8, 5);
        const hit = read(THREE, cellHits, 5, 9);

        scene.setOverlay(sceneModule.Overlay.ADDRESS);
        const elsewhere = read(THREE, cells, 5, 9);

        return { tall, flat, hit, elsewhere };
    }, { readSquare: READ_SQUARE });

    // A slab at the floor's own level rests on nothing and is a slab thick, which is what
    // every square was before heights were drawn at all.
    expect(raised.flat.bottom).toBeCloseTo(0, 5);
    expect(raised.flat.top).toBeCloseTo(0.08, 5);

    // 51/45 of a ceiling, drawn as that much of a wall's height. Above the walls, which
    // is honest: it is the tallest thing on the floor.
    expect(raised.tall.top).toBeGreaterThan(0.55);

    // A plinth reaching the floor rather than a slab hovering over a gap, so that what is
    // drawn is what a ray meets and a click near its edge cannot fall through it.
    expect(raised.tall.bottom).toBeCloseTo(0, 5);

    // What a ray hits is exactly what is drawn.
    expect(raised.hit.top).toBeCloseTo(raised.tall.top, 5);
    expect(raised.hit.bottom).toBeCloseTo(raised.tall.bottom, 5);

    // Flat everywhere else: a floor being read for its addresses is a sheet of colour.
    expect(raised.elsewhere.top).toBeCloseTo(0.08, 5);
});

test('every square can still be aimed at in the floor type overlay, floor or none', async ({ page }) => {
    const round = await withScene(page, async (scene, container, floor, sceneModule) => {
        const { setNodeFloor, nodeAt } = await import('/flows/building/scripts/floorModel.js');
        scene.setOverlay(sceneModule.Overlay.FLOOR_TYPE);

        // One square of each type, made rather than found: the Hotel has all five between
        // them, but its noneButIndoors ones sit behind its raised block, and a square
        // genuinely standing in front of another is not the thing being tested here. So a
        // row in the open is painted with the five, and 5,9 -- the tallest square on the
        // floor, with nothing in front of it -- is added for the height.
        const row = [[8, 5], [9, 5], [10, 5], [11, 5], [12, 5]];
        row.forEach(([x, y], type) => setNodeFloor(floor, nodeAt(floor, x, y), type, 0));
        scene.refresh();

        const checked = [];
        for (const [x, y] of [...row, [5, 9]]) {
            const at = scene.project(x, y);
            if (!at) { checked.push({ x, y, at: null }); continue; }

            const picked = scene.pickAt({ clientX: at.left, clientY: at.top });
            checked.push({
                x, y, kind: picked?.kind ?? null, got: picked ? [picked.x, picked.y] : null,
            });
        }

        return checked;
    });

    // Projecting a square and picking at the result gives that square back, whatever it
    // is made of and however high it stands. That round trip is what every painting tool
    // is built on.
    for (const cell of round) {
        expect({ at: [cell.x, cell.y], got: cell.got }).toEqual(
            { at: [cell.x, cell.y], got: [cell.x, cell.y] });
        expect(cell.kind).toBe('cell');
    }
});

test('the tile squares cover a tile each, clear of the walls, and only when asked', async ({ page }) => {
    const overlay = await withScene(page, (scene) => {
        const { THREE, tileOverlay } = scene._internals;

        const visibleAtFirst = tileOverlay.visible;
        scene.setTileOverlay(true);
        const shown = tileOverlay.visible;

        // Closing the floor takes the squares with it, whatever the tool is set to.
        scene.setModel(null);
        const withoutFloor = tileOverlay.visible;

        const matrix = new THREE.Matrix4();
        const position = new THREE.Vector3();
        const centres = [];

        for (const index of [0, 1, tileOverlay.count - 1]) {
            tileOverlay.getMatrixAt(index, matrix);
            centres.push(position.setFromMatrixPosition(matrix).toArray());
        }

        tileOverlay.geometry.computeBoundingBox();
        const box = tileOverlay.geometry.boundingBox;

        return {
            visibleAtFirst,
            shown,
            withoutFloor,
            count: tileOverlay.count,
            centres,
            width: box.max.x - box.min.x,
            depth: box.max.z - box.min.z,
            transparent: tileOverlay.material.transparent,
            opacity: tileOverlay.material.opacity,
        };
    });

    // Off until the tile tool asks for it: every other tool paints a cell, and 49 sheets
    // over the floor would be in the way of reading the thing being painted.
    expect(overlay.visibleAtFirst).toBe(false);
    expect(overlay.shown).toBe(true);
    expect(overlay.withoutFloor).toBe(false);

    // One square per tile of the 7 x 7 grid.
    expect(overlay.count).toBe(49);

    // A tile is 3 x 3 cells, and a square is nearly that -- short of it by enough that
    // the seam between two tiles is still visible.
    expect(overlay.width).toBeCloseTo(3 * 0.94, 5);
    expect(overlay.depth).toBeCloseTo(3 * 0.94, 5);

    // Above the walls, which stand 0.55 and are the tallest thing in the scene. A square
    // level with them would be sliced by every wall crossing it.
    for (const [, height] of overlay.centres) expect(height).toBeGreaterThan(0.55);

    // Neighbouring tiles are three cells apart, and the x axis is mirrored -- the floor's
    // coordinates are left-handed and the scene's are not. See mirrorX.
    const [first, second] = overlay.centres;
    expect(second[0] - first[0]).toBeCloseTo(-3, 5);
    expect(first[2]).toBeCloseTo(second[2], 5);

    // See-through, or it hides the floor it is being read against.
    expect(overlay.transparent).toBe(true);
    expect(overlay.opacity).toBeLessThan(0.5);
});


/*
 * What is written on the tile squares.
 *
 * The words themselves are tileParts', and unit-tested there and in scene.unit.spec.js;
 * what needs a scene is where they end up -- one label per tile that carries something,
 * over the right square, lying in the floor, turned the way its stairwell faces, and on
 * screen only while the squares they are written on are.
 *
 * Nothing here waits for a glyph. Laying text out is asynchronous -- a font to fetch and
 * an atlas to build -- but every property asserted on is set the moment the model is
 * read, so this tests the app's own work rather than troika's or the network's.
 */

test('every tile that carries something is labelled with it, over its own square', async ({ page }) => {
    const labels = await withScene(page, async (scene, container, floor) => {
        const { tileMarkers } = await import('/flows/building/scripts/scene.js');
        const { tileLabels, tileOverlay, THREE } = scene._internals;

        const markers = tileMarkers(floor);
        const at = (x, y) => tileLabels.children[y * 7 + x];

        // Where each label sits against the square it belongs to. The squares are one
        // mesh of 49 instances and the labels are 49 objects, indexed the same way, so
        // this is what says the two indexings agree.
        const matrix = new THREE.Matrix4();
        const square = new THREE.Vector3();
        const offsets = markers.map((marker) => {
            tileOverlay.getMatrixAt(marker.y * 7 + marker.x, matrix);
            square.setFromMatrixPosition(matrix);

            const label = at(marker.x, marker.y);
            return {
                sideways: Math.hypot(label.position.x - square.x, label.position.z - square.z),
                above: label.position.y - square.y,
            };
        });

        return {
            count: tileLabels.children.length,
            markers: markers.map((marker) => ({ x: marker.x, y: marker.y, label: marker.label })),
            written: markers.map((marker) => at(marker.x, marker.y).text),
            shown: markers.map((marker) => at(marker.x, marker.y).visible),
            offsets,

            // Every slot the floor had nothing to say about.
            empty: tileLabels.children.filter((label) => label.visible).length,

            // A label is as wide as the square it is on, so a long one wraps rather than
            // running into the next tile.
            maxWidth: at(markers[0].x, markers[0].y).maxWidth,
            fontSize: at(markers[0].x, markers[0].y).fontSize,
        };
    });

    // The floor is the Hotel's ground floor, which is the way into the building.
    expect(labels.count).toBe(49);
    expect(labels.markers.length).toBeGreaterThan(0);
    expect(labels.markers.some((marker) => marker.label === 'Main entrance')).toBe(true);
    // Three rows for a stairwell, the middle one empty on the tile whose stairwell is not
    // the mirrored preset. The Hotel's ground floor has one of each.
    expect(labels.markers.some((marker) => marker.label === 'Stairs 90°\n\nElevator')).toBe(true);
    expect(labels.markers.some((marker) => marker.label === 'Stairs 90°\nInverted\nElevator'))
        .toBe(true);

    // What the model said is what is written, on the tile it was said about.
    expect(labels.written).toEqual(labels.markers.map((marker) => marker.label));
    expect(labels.shown.every(Boolean)).toBe(true);

    // Only the tiles carrying something: 49 labels reading "Nothing" would be a floor
    // nobody could read.
    expect(labels.empty).toBe(labels.markers.length);

    // Over the middle of its own square, and just clear of it -- text at exactly the
    // square's height z-fights the sheet it is written on.
    for (const offset of labels.offsets) {
        expect(offset.sideways).toBeCloseTo(0, 5);
        expect(offset.above).toBeGreaterThan(0);
        expect(offset.above).toBeLessThan(0.1);
    }

    // A tile is three cells across; the label may take nearly all of it and no more.
    expect(labels.maxWidth).toBeLessThan(3);
    expect(labels.maxWidth).toBeGreaterThan(2);
    expect(labels.fontSize).toBeLessThan(0.5);
});

test('a label lies in the floor, and turns with the stairwell it names', async ({ page }) => {
    const turned = await withScene(page, async (scene, container, floor) => {
        const { paintTile, tileAt, TileMode } = await import('/flows/building/scripts/floorModel.js');
        const { tileLabels, THREE } = scene._internals;

        const label = tileLabels.children[3 * 7 + 3];

        /**
         * Where the label's own axes point in the scene, which is the whole of what an
         * orientation means here: which way the words run, which way is up in them, and
         * which way the surface they are written on faces.
         */
        const facing = () => {
            label.updateMatrixWorld(true);

            // Rounded, because a quarter turn is a cosine and a cosine of a right angle
            // is 6e-17 rather than 0. And zero rather than -0: the two are equal to ===
            // and not to a deep comparison, so an axis that lands on one is an axis that
            // fails an assertion about which way it points.
            const tidy = (component) => (Math.round(component * 1e6) / 1e6) || 0;
            const basis = (axis) => axis.applyQuaternion(label.quaternion).toArray().map(tidy);

            return {
                reads: basis(new THREE.Vector3(1, 0, 0)),
                up: basis(new THREE.Vector3(0, 1, 0)),
                faces: basis(new THREE.Vector3(0, 0, 1)),
            };
        };

        const seen = {};
        const tile = tileAt(floor, 3, 3);

        // A tile with nothing on it, then a stairwell stepped through its four rotations.
        // paintTile is the tile tool's own cycle: on at 0, then a quarter at a time.
        seen.bare = { ...facing(), text: label.text, visible: label.visible };

        for (const rotation of [0, 90, 180, 270]) {
            paintTile(tile, TileMode.STAIRWELL);
            scene.refresh();
            seen[rotation] = { ...facing(), text: label.text, visible: label.visible };
            if (tile.stairwellRotation !== rotation) seen[rotation].mismatch = tile.stairwellRotation;
        }

        // One more step takes the stairwell off again.
        paintTile(tile, TileMode.STAIRWELL);
        scene.refresh();
        seen.cleared = { ...facing(), text: label.text, visible: label.visible };

        return seen;
    });

    // A tile carrying nothing is not written on, and a tile that stops carrying anything
    // stops being written on.
    expect(turned.bare.text).toBe('');
    expect(turned.bare.visible).toBe(false);
    expect(turned.cleared.text).toBe('');
    expect(turned.cleared.visible).toBe(false);

    for (const rotation of [0, 90, 180, 270]) {
        expect(turned[rotation].mismatch).toBeUndefined();
        expect(turned[rotation].text).toBe(`Stairs ${rotation}°\n\nElevator`);
        expect(turned[rotation].visible).toBe(true);

        // Written on the floor at every rotation: the surface faces straight up, so
        // turning it is a turn in the floor rather than a tilt out of it.
        expect(turned[rotation].faces).toEqual([0, 1, 0]);
    }

    /*
     * At 0 the words run along the scene's +x and stand up its -z: upside down in the
     * default view, where the camera stands off the y = 0 edge looking back along +z.
     *
     * Which is the turn doing its job rather than failing at it. A label is upright to
     * whoever the stairs open onto, and a stairwell at 0 opens on the floor's +y -- away
     * from the front -- so this one is read from the far side. See paintTileLabels, and
     * the base game's own floors that the direction is taken from.
     */
    expect(turned[0].reads).toEqual([1, 0, 0]);
    expect(turned[0].up).toEqual([0, 0, -1]);

    /*
     * Each quarter turns the top of the words a quarter, against the sense of the number
     * in the file: positions here are mirrored, and reflecting one axis reverses every
     * rotation about the vertical. See mirrorX.
     *
     * 180 is the one that reads upright in the default view. Those stairs open on the
     * floor's -y, which is the edge the camera stands off.
     */
    expect(turned[90].up).toEqual([1, 0, 0]);
    expect(turned[180].up).toEqual([0, 0, 1]);
    expect(turned[270].up).toEqual([-1, 0, 0]);

    // And the words stay square to their own top: a turned label is read sideways, not
    // letter by letter down the tile.
    expect(turned[90].reads).toEqual([0, 0, 1]);
    expect(turned[180].reads).toEqual([-1, 0, 0]);
    expect(turned[270].reads).toEqual([0, 0, -1]);
});

test('the labels come and go with the squares they are written on', async ({ page }) => {
    const shown = await withScene(page, (scene) => {
        const { tileLabels, tileOverlay } = scene._internals;

        const before = { labels: tileLabels.visible, squares: tileOverlay.visible };

        scene.setTileOverlay(true);
        const asked = { labels: tileLabels.visible, squares: tileOverlay.visible };

        // Closing the floor takes both off screen, whatever the tool is set to.
        scene.setModel(null);
        const closed = { labels: tileLabels.visible, squares: tileOverlay.visible };

        scene.setTileOverlay(false);
        const dropped = { labels: tileLabels.visible, squares: tileOverlay.visible };

        return { before, asked, closed, dropped };
    });

    // A label is what its square is for, so the two are never one without the other.
    expect(shown.before).toEqual({ labels: false, squares: false });
    expect(shown.asked).toEqual({ labels: true, squares: true });
    expect(shown.closed).toEqual({ labels: false, squares: false });
    expect(shown.dropped).toEqual({ labels: false, squares: false });
});

test('a room is outlined where the room beside it changes, and Outside is not a room', async ({ page }) => {
    const edges = await withScene(page, (scene, container, floor) => {
        // 21 nodes to a side. Written out rather than imported, because the body of a
        // withScene test is serialised and cannot close over one.
        const GRID = 21;

        const { roomEdges } = scene._internals;
        const instances = roomEdges.instanceMatrix.array;

        // A strip is centred on the seam it covers, and no two seams share a centre, so
        // the centre alone names one. The scene mirrors x; this puts it back into the
        // floor's own units, which is what the model below is in.
        const drawn = new Map();

        for (let i = 0; i < roomEdges.count; i++) {
            const at = i * 16;
            const scaleX = instances[at];
            const scaleZ = instances[at + 10];
            if (scaleX === 0 && scaleZ === 0) continue;

            drawn.set(`${GRID - instances[at + 12]},${instances[at + 14]}`, {
                height: instances[at + 13],
                long: Math.max(scaleX, scaleZ),
                thick: Math.min(scaleX, scaleZ),
            });
        }

        /*
         * The same question the scene asks, asked independently: which room is here, and
         * nothing for the filler. Either mark counts -- the address named Outside, or a
         * room whose preset is Null.
         */
        const roomOf = (x, y) => {
            if (x < 0 || y < 0 || x >= GRID || y >= GRID) return null;

            const node = floor.nodes[y * GRID + x];
            if (!node) return null;

            const address = floor.addresses[node.addressIndex];
            if (address?.layoutConfiguration === 'Outside') return null;

            const room = floor.rooms.find((entry) => entry.addressIndex === node.addressIndex
                && entry.roomIndex === node.roomIndex);
            if (!room || room.preset === 'Null') return null;

            return `${node.addressIndex}:${node.roomIndex}`;
        };

        // One seam of each kind the rule has to tell apart. The seam to the right of
        // (x, y) is the vertical one centred at (x + 1, y + 0.5).
        const cases = {
            sameRoom: null, twoRooms: null, roomAndOutside: null, bothOutside: null,
        };

        for (let y = 0; y < GRID; y++) {
            for (let x = 0; x < GRID - 1; x++) {
                const here = roomOf(x, y);
                const beside = roomOf(x + 1, y);
                const seam = `${x + 1},${y + 0.5}`;

                if (here && here === beside) cases.sameRoom ??= seam;
                else if (here && beside) cases.twoRooms ??= seam;
                else if (here || beside) cases.roomAndOutside ??= seam;
                else cases.bothOutside ??= seam;
            }
        }

        return {
            total: drawn.size,
            found: Object.fromEntries(
                Object.entries(cases).map(([name, seam]) => [name, seam !== null])),
            drawn: Object.fromEntries(
                Object.entries(cases).map(([name, seam]) => [name, drawn.has(seam)])),
            strip: drawn.get(cases.twoRooms),
        };
    });

    // The fixture has to contain all four for the assertions under it to mean anything --
    // a floor of one room would pass most of them by drawing nothing at all.
    expect(edges.found).toEqual({
        sameRoom: true, twoRooms: true, roomAndOutside: true, bothOutside: true,
    });

    // The whole rule. Two rooms meeting is a boundary and so is a room against the open
    // air; one room with itself is not, and neither is Outside with more Outside -- which
    // is what keeps the margin and every unclaimed square bare.
    expect(edges.drawn).toEqual({
        sameRoom: false, twoRooms: true, roomAndOutside: true, bothOutside: false,
    });

    // Wide enough to read: a strip, not a hairline. Long enough to overlap the strip it
    // meets at a corner, so a corner is filled rather than notched.
    expect(edges.strip.thick).toBeCloseTo(0.09, 5);
    expect(edges.strip.long).toBeCloseTo(1.09, 5);

    // Just clear of the cells, and never more than the mesh holds: 441 cells with a seam
    // to the right and below, plus the two sides with nothing beyond them.
    expect(edges.strip.height).toBeCloseTo(0.09, 5);
    expect(edges.total).toBeGreaterThan(0);
    expect(edges.total).toBeLessThanOrEqual(21 * 21 * 2 + 21 * 2);
});

/* -------------------------------------------------------------------------- */
/* The camera                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Driving the camera without a mouse.
 *
 * Every camera gesture wants a button held down through a drag, and a Mac trackpad has
 * no comfortable way to hold the two buttons that orbit -- so the keys are not a
 * convenience here, they are the way the view is reachable at all on that hardware. That
 * makes them worth checking properly.
 *
 * Read through spherical coordinates rather than the raw position, because that is what
 * the three moves are: orbit turns theta and phi, zoom changes the radius, pan moves the
 * point all three are measured from. Asserting on x, y and z would test the arithmetic
 * that converts between them, which is three.js's.
 */
const CAMERA_PROBE = `
    const { camera, controls } = scene._internals;

    const read = () => {
        const offset = camera.position.clone().sub(controls.target);
        return {
            distance: offset.length(),
            theta: Math.atan2(offset.x, offset.z),
            height: camera.position.y,
            target: controls.target.toArray(),
        };
    };

    const key = (name, options = {}) => scene.canvas.dispatchEvent(new KeyboardEvent(
        'keydown', { key: name, bubbles: true, cancelable: true, ...options }));
`;

/** Run a body with `read` and `key` already in scope. See CAMERA_PROBE. */
async function withCamera(page, body) {
    return withScene(page, `(scene) => { ${CAMERA_PROBE} return (${body.toString()})(scene, read, key); }`);
}

/**
 * The turn from one azimuth to another, the short way round.
 *
 * The camera starts looking straight down -z, which is exactly where atan2 cuts its range
 * -- so a press to either side of the start reads as most of a whole turn apart rather
 * than as the sixteenth of one it is. Subtracting the two angles would compare where the
 * cut fell, not where the camera went.
 */
const turn = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

test('left and right orbit opposite ways, and move nothing else', async ({ page }) => {
    const moved = await withCamera(page, (scene, read, key) => {
        const start = read();
        key('ArrowLeft');
        const left = read();
        key('ArrowRight');
        key('ArrowRight');
        return { start, left, right: read() };
    });

    // One press left, then two right, so the second leg is twice the first and the other
    // way about. Checked against itself rather than against the step the scene uses,
    // which is a number this has no business knowing.
    const leftStep = turn(moved.start.theta, moved.left.theta);
    const rightStep = turn(moved.left.theta, moved.right.theta) / 2;

    expect(leftStep).toBeLessThan(0);
    expect(rightStep).toBeCloseTo(-leftStep, 9);

    // Orbiting is a turn about the target, so neither of those moves.
    expect(moved.left.distance).toBeCloseTo(moved.start.distance, 6);
    expect(moved.right.distance).toBeCloseTo(moved.start.distance, 6);
    expect(moved.right.target).toEqual(moved.start.target);
});

test('up climbs and down descends, and neither goes past the end of the arc', async ({ page }) => {
    const arc = await withCamera(page, (scene, read, key) => {
        const start = read();
        key('ArrowUp');
        const up = read();
        key('ArrowDown');
        key('ArrowDown');
        const down = read();

        // Far more presses than the arc is long, so both ends are reached and held.
        for (let i = 0; i < 200; i++) key('ArrowUp');
        const overhead = read();

        for (let i = 0; i < 400; i++) key('ArrowDown');
        return { start, up, down, overhead, underneath: read() };
    });

    expect(arc.up.height).toBeGreaterThan(arc.start.height);
    expect(arc.down.height).toBeLessThan(arc.up.height);

    // Straight down is a degenerate spherical angle: phi of zero has no direction to it,
    // and a camera that reached it would have nothing left to orbit about.
    expect(arc.overhead.height).toBeGreaterThan(0);
    expect(Number.isFinite(arc.overhead.theta)).toBe(true);
    expect(arc.overhead.distance).toBeCloseTo(arc.start.distance, 6);

    // The floor is a plane, so the far end stops above it rather than passing under and
    // losing the model. maxPolarAngle is 0.48 of a half turn, short of level.
    expect(arc.underneath.height).toBeGreaterThan(arc.underneath.target[1]);
    expect(arc.underneath.distance).toBeCloseTo(arc.start.distance, 6);
});

test('minus and plus zoom, and stop at both ends', async ({ page }) => {
    const zoom = await withCamera(page, (scene, read, key) => {
        const start = read();
        key('-');
        const out = read();
        key('=');
        key('=');
        const back = read();

        for (let i = 0; i < 200; i++) key('-');
        const furthest = read();

        for (let i = 0; i < 400; i++) key('=');
        return { start, out, back, furthest, nearest: read() };
    });

    expect(zoom.out.distance).toBeGreaterThan(zoom.start.distance);
    expect(zoom.back.distance).toBeLessThan(zoom.out.distance);

    // Zoom slides along the line to the target, so the target and the angle stay put.
    expect(zoom.out.target).toEqual(zoom.start.target);
    expect(turn(zoom.start.theta, zoom.out.theta)).toBeCloseTo(0, 9);

    // The bounds the scene sets. Without them a zoom in carries on through the floor and
    // a zoom out loses the building somewhere past the far plane.
    expect(zoom.furthest.distance).toBeCloseTo(80, 4);
    expect(zoom.nearest.distance).toBeCloseTo(4, 4);
});

test('the shifted arrows pan, taking the target with them', async ({ page }) => {
    const panned = await withCamera(page, (scene, read, key) => {
        const start = read();
        key('ArrowRight', { shiftKey: true });
        const right = read();
        key('ArrowLeft', { shiftKey: true });
        return { start, right, back: read() };
    });

    // Panning moves what the camera looks at. Moving only the eye would swing the view,
    // which is the other gesture entirely.
    expect(panned.right.target).not.toEqual(panned.start.target);
    expect(panned.right.distance).toBeCloseTo(panned.start.distance, 6);

    // And the opposite arrow undoes it, which is the same claim as the step being a
    // direction rather than a drift.
    panned.back.target.forEach((component, axis) => {
        expect(component).toBeCloseTo(panned.start.target[axis], 6);
    });
});

test('a camera key with a command modifier on it is left to the browser', async ({ page }) => {
    const held = await withCamera(page, (scene, read, key) => {
        const start = read();

        // Each of the three the handler stands aside for, and one it acts on, so a test
        // that stopped working entirely would not look like a pass.
        const handled = [
            key('ArrowLeft', { ctrlKey: true }),
            key('ArrowLeft', { metaKey: true }),
            key('ArrowLeft', { altKey: true }),
        ];

        const after = read();
        key('ArrowLeft');

        return { start, after, moved: read(), handled };
    });

    // Not handled, so not consumed either: cmd+arrow is a browser navigation and ctrl+
    // arrow moves a caret, and the view swallowing them would be a bug of its own.
    expect(held.handled).toEqual([true, true, true]);
    expect(turn(held.start.theta, held.after.theta)).toBeCloseTo(0, 9);
    expect(turn(held.start.theta, held.moved.theta)).not.toBeCloseTo(0, 9);
});

test('alt lends the left button to the camera, and only for that press', async ({ page }) => {
    const buttons = await withScene(page, (scene) => {
        const { THREE, controls } = scene._internals;

        // A whole gesture each way round, so the second press starts from where a real
        // one would rather than from the middle of the first.
        const press = (options) => {
            for (const [type, buttons] of [['pointerdown', 1], ['pointerup', 0]]) {
                scene.canvas.dispatchEvent(new PointerEvent(type, {
                    pointerId: 1, button: 0, buttons, bubbles: true,
                    clientX: 10, clientY: 10, ...options,
                }));
            }
        };

        press({ altKey: true });
        const withAlt = controls.mouseButtons.LEFT === THREE.MOUSE.ROTATE;

        press({});
        return { withAlt, without: controls.mouseButtons.LEFT };
    });

    // Held, the left button orbits; let go, it goes back to the tools -- which is what a
    // mouse action of null means to OrbitControls.
    expect(buttons.withAlt).toBe(true);
    expect(buttons.without).toBe(null);
});

test('the view can be focused, and a press focuses it', async ({ page }) => {
    const focus = await withScene(page, (scene) => {
        const before = document.activeElement === scene.canvas;

        scene.canvas.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 1, button: 0, buttons: 1, bubbles: true, clientX: 10, clientY: 10,
        }));

        return { before, after: document.activeElement === scene.canvas, tabIndex: scene.canvas.tabIndex };
    });

    // The keys are the canvas's rather than the window's, so that an arrow in a text
    // field stays that field's. Clicking the view is what hands them over.
    expect(focus.tabIndex).toBe(0);
    expect(focus.before).toBe(false);
    expect(focus.after).toBe(true);
});

test('the view can be framed again after being moved', async ({ page }) => {
    const positions = await withScene(page, (scene) => {
        const camera = scene._internals.camera;
        const before = camera.position.toArray();

        camera.position.set(0, 2, 0);
        scene.resetView();

        return { before, after: camera.position.toArray() };
    });

    // Compared loosely: the orbit controls recompute the position through spherical
    // coordinates, so it comes back to the same place and not to the same bits.
    positions.after.forEach((component, axis) => {
        expect(component).toBeCloseTo(positions.before[axis], 6);
    });
});

test('disposing gives back the canvas and the context', async ({ page }) => {
    const after = await page.evaluate(async () => {
        const sceneModule = await import('/flows/building/scripts/scene.js');
        const { parseFloor } = await import('/flows/building/scripts/floorModel.js');

        const container = document.createElement('div');
        container.style.cssText = 'width: 400px; height: 300px;';
        document.body.appendChild(container);

        const scene = await sceneModule.createScene(container);
        scene.setModel(parseFloor({ a_d: [], t_d: [] }));
        scene.draw();

        scene.dispose();
        const result = { children: container.childElementCount };
        container.remove();
        return result;
    });

    // A flow that is switched away from and back must not leave contexts behind: a
    // browser drops the oldest once about sixteen are live.
    expect(after.children).toBe(0);
});


/*
 * The mark on the selected square.
 *
 * Which square is selected is the tools' state, so the scene is told rather than working
 * it out -- the same arrangement as the tile overlay. What is worth driving here is that
 * being told puts the mark on the right square, that clearing it takes the mark away, and
 * that it follows a square whose top surface moves.
 */

test('the selected square is marked, and clearing the selection unmarks it', async ({ page }) => {
    const shown = await withScene(page, async (scene) => {
        const mark = scene._internals.selectionMark;
        const before = mark.visible;

        scene.setSelected({ x: 10, y: 11 });

        // Laying out a glyph is asynchronous -- a font to fetch and an atlas to build --
        // and where the mark ends up depends on the glyph, see centreMarkInk. Waiting for
        // it is what makes this a test of where the mark lands rather than of how fast a
        // font arrives.
        //
        // Polled rather than awaited through `mark.sync(resolve)`: troika does not call
        // back when it has nothing to do, and the scene has already asked for this very
        // layout, so a second request can be answered by doing nothing at all and the
        // promise never settles. The frame after is for the scene's own callback, which
        // is what applies the correction.
        for (let waited = 0; waited < 100 && !mark.textRenderInfo; waited++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const bounds = mark.textRenderInfo.visibleBounds;
        const ink = new scene._internals.THREE.Vector3(0, (bounds[1] + bounds[3]) / 2, 0);
        mark.localToWorld(ink);

        const on = { visible: mark.visible, text: mark.text, ink: { x: ink.x, z: ink.z } };

        scene.setSelected(null);
        return { before, on, off: mark.visible };
    });

    // Nothing is selected until something is clicked.
    expect(shown.before).toBe(false);

    expect(shown.on.visible).toBe(true);
    expect(shown.on.text).toBe('*');

    // The asterisk's *ink* is on the square's centre, which is the thing being claimed.
    // Its position is not: troika lays a glyph out in a box a whole line tall and an
    // asterisk sits in the top of it, so a mark positioned on the centre draws above it.
    //
    // x is mirrored the way everything else in the scene is -- see mirrorX -- and z is
    // not, so the two are asserted separately rather than as a pair that could both be
    // wrong in the same direction.
    expect(shown.on.ink.z).toBeCloseTo(11.5, 4);
    expect(shown.on.ink.x).toBeCloseTo(21 - 10.5, 4);

    expect(shown.off).toBe(false);
});

test('closing the floor takes the mark off with it', async ({ page }) => {
    const shown = await withScene(page, (scene) => {
        const mark = scene._internals.selectionMark;

        scene.setSelected({ x: 10, y: 11 });
        const open = mark.visible;

        // What closeFloor does. refresh() draws nothing without a model and so cannot
        // take the mark down from inside its own guard -- setModel is what has to.
        scene.setModel(null);

        return { open, closed: mark.visible };
    });

    expect(shown.open).toBe(true);
    expect(shown.closed).toBe(false);
});

test('the mark rides the square it is on when the floor under it changes', async ({ page }) => {
    const heights = await withScene(page, async (scene, container, floor, sceneModule) => {
        const model = await import('/flows/building/scripts/floorModel.js');
        const mark = scene._internals.selectionMark;

        scene.setSelected({ x: 10, y: 11 });
        const flat = mark.position.y;

        // Raise the square, in the overlay that draws raised squares raised. A mark left
        // at the old height would be buried in the plinth the square now stands on.
        scene.setOverlay(sceneModule.Overlay.FLOOR_TYPE);
        model.setNodeFloor(floor, model.nodeAt(floor, 10, 11), 1, 20);
        scene.refresh();

        return { flat, raised: mark.position.y };
    });

    expect(heights.raised).toBeGreaterThan(heights.flat);
});
