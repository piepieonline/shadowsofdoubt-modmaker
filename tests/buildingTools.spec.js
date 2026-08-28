import { test, expect } from '@playwright/test';
import { installFsHarness, gotoFlow } from './support/harness.js';

/**
 * The painting tools: turning real pointer events into targets.
 *
 * What a tool does once it has a target is a pure function of the model, the tool state
 * and what was under the pointer, and is covered beside the module in
 * flows/building/scripts/tools.unit.spec.js. What is left here is the part that cannot
 * be checked any other way -- the rules the event handling enforces on a stroke, driven
 * against a real canvas.
 */

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
});


/* -------------------------------------------------------------------------- */
/* Pointer handling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Drives real pointer events against a real canvas, because what is being checked is
 * the rules the event handling enforces rather than what a tool does once called.
 */
async function withPainting(page, body) {
    return page.evaluate(async (source) => {
        const sceneModule = await import('/flows/building/scripts/scene.js');
        const toolsModule = await import('/flows/building/scripts/tools.js');
        const modelModule = await import('/flows/building/scripts/floorModel.js');

        const nodes = [];
        for (let x = 0; x < 21; x++) {
            for (let y = 0; y < 21; y++) {
                nodes.push({ f_c: { x, y }, f_h: 0, f_t: 1, f_r: '', w_d: [] });
            }
        }

        const floor = modelModule.parseFloor({
            floorName: 'Test',
            a_d: [
                { p_n: 'Outside', e_c: { r: 1, g: 0, b: 0.4, a: 1 }, vs: [{ r_d: [{ id: 1, n_d: nodes, l: 'Null' }] }] },
                { p_n: 'Lobby', e_c: { r: 1, g: 0.66, b: 0, a: 1 }, vs: [{ r_d: [{ id: 2, n_d: [], l: 'Lobby' }] }] },
            ],
            t_d: [],
        });

        const container = document.createElement('div');
        container.style.cssText = 'width: 800px; height: 600px; position: absolute; top: 0; left: 0;';
        document.body.appendChild(container);

        const scene = await sceneModule.createScene(container);
        scene.setModel(floor);
        scene.draw();

        // Paint, because what these check is the rules the event handling enforces on a
        // stroke. In the mode a floor opens in, none of them would be a stroke at all --
        // every press would be a pick, which is its own test further down.
        const state = toolsModule.createToolState({ mode: toolsModule.PaintMode.PAINT });
        const calls = [];
        const detach = toolsModule.attachPainting(scene, () => floor, state, {
            onChange: (result) => calls.push(result),
        });

        /** Dispatch a pointer event at the screen position of a cell. */
        const at = (type, x, y, options = {}) => {
            const point = scene.project(x, y);
            scene.canvas.dispatchEvent(new PointerEvent(type, {
                pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true,
                clientX: point.left, clientY: point.top, ...options,
            }));
        };

        try {
            // eslint-disable-next-line no-new-func
            return await new Function('scene', 'floor', 'state', 'at', 'calls', 'model', 'tools',
                `return (${source})(scene, floor, state, at, calls, model, tools)`)(
                scene, floor, state, at, calls, modelModule, toolsModule);
        } finally {
            detach();
            scene.dispose();
            container.remove();
        }
    }, body.toString());
}

test('a drag paints every cell it crosses', async ({ page }) => {
    const painted = await withPainting(page, (scene, floor, state, at, calls, model, tools) => {
        state.tool = tools.Tool.ADDRESS;
        state.addressIndex = 1;

        at('pointerdown', 8, 10);
        at('pointermove', 9, 10);
        at('pointermove', 10, 10);
        at('pointerup', 10, 10);

        return [8, 9, 10, 11].map((x) => model.nodeAt(floor, x, 10).addressIndex);
    });

    // The three dragged over, and not the one past the end of the stroke.
    expect(painted).toEqual([1, 1, 1, 0]);
});

test('a drag that stays in one cell paints it once', async ({ page }) => {
    const calls = await withPainting(page, (scene, floor, state, at, callsSeen, model, tools) => {
        state.tool = tools.Tool.ADDRESS;
        state.addressIndex = 1;

        at('pointerdown', 8, 10);
        at('pointermove', 8, 10, { clientX: undefined });
        at('pointermove', 8, 10);
        at('pointerup', 8, 10);

        return callsSeen.length;
    });

    expect(calls).toBe(1);
});

test('a tile is not cycled by dragging across it', async ({ page }) => {
    const result = await withPainting(page, (scene, floor, state, at, calls, model, tools) => {
        state.tool = tools.Tool.TILE;
        state.tileMode = model.TileMode.STAIRWELL;

        at('pointerdown', 10, 10);
        at('pointermove', 11, 11);
        at('pointermove', 12, 12);
        at('pointermove', 10, 10);
        at('pointerup', 10, 10);

        return {
            here: model.tileAt(floor, 3, 3).stairwellRotation,
            hereOn: model.tileAt(floor, 3, 3).isStairwell,
            neighbourOn: model.tileAt(floor, 4, 4).isStairwell,
            calls: calls.length,
        };
    });

    // One press, one step. Dragging would otherwise spin the tile through its rotations
    // as fast as pointer events arrive, and paint every tile on the way.
    expect(result.hereOn).toBe(true);
    expect(result.here).toBe(0);
    expect(result.neighbourOn).toBe(false);
    expect(result.calls).toBe(1);
});

test('nothing paints without the button held', async ({ page }) => {
    const changed = await withPainting(page, (scene, floor, state, at, calls, model, tools) => {
        state.tool = tools.Tool.ADDRESS;
        state.addressIndex = 1;

        at('pointermove', 8, 10);
        at('pointermove', 9, 10);

        return { calls: calls.length, address: model.nodeAt(floor, 8, 10).addressIndex };
    });

    expect(changed.calls).toBe(0);
    expect(changed.address).toBe(0);
});

test('a button other than the primary one is left to the camera', async ({ page }) => {
    const result = await withPainting(page, (scene, floor, state, at, calls, model, tools) => {
        state.tool = tools.Tool.ADDRESS;
        state.addressIndex = 1;

        at('pointerdown', 8, 10, { button: 2 });
        at('pointermove', 9, 10);
        at('pointerup', 9, 10, { button: 2 });

        return { calls: calls.length, address: model.nodeAt(floor, 8, 10).addressIndex };
    });

    // Right and middle drag orbit; painting them too would make the view unusable.
    expect(result.calls).toBe(0);
    expect(result.address).toBe(0);
});

test('releasing the pointer stops the stroke', async ({ page }) => {
    const painted = await withPainting(page, (scene, floor, state, at, calls, model, tools) => {
        state.tool = tools.Tool.ADDRESS;
        state.addressIndex = 1;

        at('pointerdown', 8, 10);
        at('pointerup', 8, 10);
        at('pointermove', 9, 10);
        at('pointermove', 10, 10);

        return [8, 9, 10].map((x) => model.nodeAt(floor, x, 10).addressIndex);
    });

    expect(painted).toEqual([1, 0, 0]);
});

test('an alt drag orbits and paints nothing, including the cells it crosses', async ({ page }) => {
    const result = await withPainting(page, (scene, floor, state, at, calls, model, tools) => {
        state.tool = tools.Tool.ADDRESS;
        state.addressIndex = 1;

        at('pointerdown', 8, 10, { altKey: true });
        at('pointermove', 9, 10, { altKey: true });
        at('pointermove', 10, 10, { altKey: true });
        at('pointerup', 10, 10, { altKey: true });

        // Alt let go, the same stroke paints -- so what follows is a claim about alt and
        // not about the drag having stopped working.
        at('pointerdown', 8, 12);
        at('pointerup', 8, 12);

        return {
            calls: calls.length,
            orbited: [8, 9, 10].map((x) => model.nodeAt(floor, x, 10).addressIndex),
            painted: model.nodeAt(floor, 8, 12).addressIndex,
        };
    });

    // Alt is the camera's: the scene puts orbit on alt+left drag because a trackpad has no
    // comfortable way to hold the buttons that otherwise do it, so the tools stand aside
    // for the whole gesture rather than only for the press that starts it.
    expect(result.orbited).toEqual([0, 0, 0]);
    expect(result.painted).toBe(1);
    expect(result.calls).toBe(1);
});

test('in none, a press picks and a drag does not drag the selection', async ({ page }) => {
    const result = await withPainting(page, (scene, floor, state, at, calls, model, tools) => {
        state.mode = tools.PaintMode.NONE;
        state.tool = tools.Tool.ADDRESS;
        state.addressIndex = 1;

        at('pointerdown', 8, 10);
        at('pointermove', 9, 10);
        at('pointermove', 10, 10);
        at('pointerup', 10, 10);

        return {
            calls: calls.length,
            selected: state.selectedNode,
            addressIndex: state.addressIndex,
            painted: [8, 9, 10].map((x) => model.nodeAt(floor, x, 10).addressIndex),
        };
    });

    // The press picked -- taking Outside from under it, over the Lobby that was selected
    // -- and nothing was written.
    expect(result.calls).toBe(1);
    expect(result.addressIndex).toBe(0);
    expect(result.painted).toEqual([0, 0, 0]);

    // And the selection stayed where the press put it. Following the drag would leave it
    // on whichever cell the pointer happened to stop over, which is not what holding the
    // button down meant.
    expect(result.selected).toEqual({ x: 8, y: 10 });
});

test('a flood happens on the press, and not again while the pointer moves', async ({ page }) => {
    const result = await withPainting(page, (scene, floor, state, at, calls, model, tools) => {
        // A wall down the whole floor, so the two sides of it are separate fills.
        for (let y = 0; y < 21; y++) model.setWall(floor, 10, y, model.AXIS_X, '0');

        state.mode = tools.PaintMode.FLOOD;
        state.tool = tools.Tool.ADDRESS;
        state.addressIndex = 1;

        at('pointerdown', 8, 10);
        at('pointermove', 11, 10);
        at('pointermove', 12, 10);
        at('pointerup', 12, 10);

        let filled = 0;
        for (let x = 0; x < 21; x++) {
            for (let y = 0; y < 21; y++) {
                if (model.nodeAt(floor, x, y).addressIndex === 1) filled++;
            }
        }

        return { calls: calls.length, filled, across: model.nodeAt(floor, 11, 10).addressIndex };
    });

    // One fill: the paintable columns west of the wall, 3 to 10, fifteen deep.
    expect(result.calls).toBe(1);
    expect(result.filled).toBe(120);

    // The pointer crossed the wall and nothing followed it. Repeating a fill per move
    // would have taken the far side too, and each fill would mostly undo the last.
    expect(result.across).toBe(0);
});

test('detaching stops a canvas painting twice', async ({ page }) => {
    // A flow switched away from and back would otherwise bind a second time, and every
    // click would paint once per binding.
    const calls = await withPainting(page, (scene, floor, state, at, callsSeen, model, tools) => {
        const second = tools.attachPainting(scene, () => floor, state, {
            onChange: (result) => callsSeen.push(result),
        });
        second();

        state.tool = tools.Tool.ADDRESS;
        state.addressIndex = 1;
        at('pointerdown', 8, 10);
        at('pointerup', 8, 10);

        return callsSeen.length;
    });

    expect(calls).toBe(1);
});
