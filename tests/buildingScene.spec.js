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
/* Index arithmetic, which needs no GPU at all                                 */
/* -------------------------------------------------------------------------- */

test('every wall slot has exactly one instance, and it maps back', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { instanceOfWall } = await import('/flows/building/scripts/scene.js');
        const { AXIS_X, AXIS_Y, NODE_GRID } = await import('/flows/building/scripts/floorModel.js');

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

        return {
            count: seen.size,
            collisions,
            lowest: Math.min(...seen.keys()),
            highest: Math.max(...seen.keys()),
        };
    });

    // 20 x 21 gaps along each axis. Two walls sharing an instance would have one
    // silently painting over the other.
    expect(result.count).toBe(840);
    expect(result.collisions).toBe(0);

    // Contiguous from zero, so the mesh is exactly as big as it needs to be.
    expect(result.lowest).toBe(0);
    expect(result.highest).toBe(839);
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

test('a cell describes itself the way the reference labels one', async ({ page }) => {
    const described = await withScene(page, (scene, container, floor, sceneModule) => ({
        inside: sceneModule.describeCell(floor, 10, 10),
        margin: sceneModule.describeCell(floor, 0, 0),
    }));

    // The reference puts the room preset, its id and the coordinates on every cell.
    expect(described.inside.coordinate).toBe('10, 10');
    expect(described.inside.room).toMatch(/^\S+ #\d+$/);
    expect(typeof described.inside.address).toBe('string');
    expect(described.margin.coordinate).toBe('0, 0');
});

test('tile markers report entrances and stairwells, and nothing else', async ({ page }) => {
    const markers = await withScene(page, (scene, container, floor, sceneModule) => (
        sceneModule.tileMarkers(floor)
    ));

    expect(markers.length).toBeGreaterThan(0);

    for (const marker of markers) {
        // Only tiles that carry something are listed at all.
        expect(marker.entrance ?? marker.stairwell).not.toBeNull();

        // The centre node of a 3 x 3 tile, which is what a label is positioned over.
        expect(marker.nodeX).toBe(marker.x * 3 + 1);
        expect(marker.nodeY).toBe(marker.y * 3 + 1);
    }

    // Hotel_GroundFloor is the way into the building, so it has a main entrance.
    expect(markers.some((marker) => marker.entrance === 'main')).toBe(true);
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
