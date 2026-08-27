import { test, expect } from '@playwright/test';
import { installFsHarness, gotoFlow } from './support/harness.js';

/**
 * The painting tools.
 *
 * Applying a tool is a pure function of the model, the tool state and what was under
 * the pointer, so most of this needs no canvas: it hands `applyTool` a target and reads
 * the model afterwards. The pointer handling that turns real events into those targets
 * is driven for real at the end, because the rules it enforces -- drag repeats, except
 * for tools that cycle -- are the ones that cannot be checked any other way.
 */

async function withTools(page, body) {
    return page.evaluate(async (source) => {
        const tools = await import('/flows/building/scripts/tools.js');
        const model = await import('/flows/building/scripts/floorModel.js');

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

        // eslint-disable-next-line no-new-func
        return new Function('tools', 'model', 'build',
            `return (${source})(tools, model, build)`)(tools, model, build);
    }, body.toString());
}

const cell = (x, y, point = null) => ({ kind: 'cell', x, y, point });

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
});


/* -------------------------------------------------------------------------- */
/* Address                                                                     */
/* -------------------------------------------------------------------------- */

test('painting an address moves the node, and takes its room with it', async ({ page }) => {
    const result = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({ tool: tools.Tool.ADDRESS, addressIndex: 1 });

        const outcome = tools.applyTool(floor, state, { kind: 'cell', x: 10, y: 10 });
        const node = model.nodeAt(floor, 10, 10);
        const room = model.roomOfNode(floor, node);

        return {
            outcome,
            addressIndex: node.addressIndex,
            room: room && { preset: room.preset, id: room.id, owner: room.addressIndex },
            written: model.serialiseFloor(floor).a_d[1].vs[0].r_d,
        };
    });

    expect(result.outcome.changed).toBe(true);
    expect(result.addressIndex).toBe(1);

    // The node keeps the room it was in -- Null #1 -- but that room now belongs to the
    // address it was painted into rather than being borrowed from the one it left.
    expect(result.room).toEqual({ preset: 'Null', id: 1, owner: 1 });

    // And it is written under the Lobby, in a room of that preset and id.
    const room = result.written.find((entry) => entry.l === 'Null' && entry.id === 1);
    expect(room.n_d).toEqual([{ f_c: { x: 10, y: 10 }, f_h: 0, f_t: 0, f_r: '', w_d: [] }]);
});

test('painting the address already there changes nothing', async ({ page }) => {
    const changed = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({ tool: tools.Tool.ADDRESS, addressIndex: 0 });
        return tools.applyTool(floor, state, { kind: 'cell', x: 10, y: 10 }).changed;
    });

    expect(changed).toBe(false);
});

test('ctrl+click takes the address from under the pointer', async ({ page }) => {
    const state = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({ tool: tools.Tool.ADDRESS, addressIndex: 1 });

        // Put the Lobby somewhere, then pick from a node that is still Outside.
        tools.applyTool(floor, state, { kind: 'cell', x: 10, y: 10 });
        const outcome = tools.applyTool(floor, state, { kind: 'cell', x: 5, y: 5 }, { pick: true });

        return { addressIndex: state.addressIndex, outcome, selected: state.selectedNode };
    });

    expect(state.outcome).toEqual({ changed: false, picked: true });
    expect(state.addressIndex).toBe(0);
    expect(state.selected).toEqual({ x: 5, y: 5 });
});


/* -------------------------------------------------------------------------- */
/* Room                                                                        */
/* -------------------------------------------------------------------------- */

test('painting a room puts the node in it, creating it if the address has none', async ({ page }) => {
    const result = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({
            tool: tools.Tool.ROOM, addressIndex: 0, roomPreset: 'Kitchen', roomId: 4,
        });

        const outcome = tools.applyTool(floor, state, { kind: 'cell', x: 8, y: 8 });
        const room = model.roomOfNode(floor, model.nodeAt(floor, 8, 8));

        return {
            outcome,
            room: { preset: room.preset, id: room.id },
            rooms: model.roomsOfAddress(floor, 0).map((entry) => `${entry.preset}#${entry.id}`),
        };
    });

    expect(result.outcome.changed).toBe(true);
    expect(result.room).toEqual({ preset: 'Kitchen', id: 4 });
    expect(result.rooms).toEqual(['Null#1', 'Kitchen#4']);
});

test('painting the same room twice does not make a second one', async ({ page }) => {
    const rooms = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({
            tool: tools.Tool.ROOM, addressIndex: 0, roomPreset: 'Kitchen', roomId: 4,
        });

        tools.applyTool(floor, state, { kind: 'cell', x: 8, y: 8 });
        tools.applyTool(floor, state, { kind: 'cell', x: 9, y: 8 });
        tools.applyTool(floor, state, { kind: 'cell', x: 10, y: 8 });

        return model.roomsOfAddress(floor, 0).map((entry) => `${entry.preset}#${entry.id}`);
    });

    expect(rooms).toEqual(['Null#1', 'Kitchen#4']);
});

test('ctrl+click takes the room, and the address it belongs to', async ({ page }) => {
    const picked = await withTools(page, (tools, model, build) => {
        const floor = build();

        const paint = tools.createToolState({
            tool: tools.Tool.ROOM, addressIndex: 0, roomPreset: 'Kitchen', roomId: 4,
        });
        tools.applyTool(floor, paint, { kind: 'cell', x: 8, y: 8 });

        const state = tools.createToolState({
            tool: tools.Tool.ROOM, addressIndex: 1, roomPreset: 'Lobby', roomId: 2,
        });
        tools.applyTool(floor, state, { kind: 'cell', x: 8, y: 8 }, { pick: true });

        return { preset: state.roomPreset, id: state.roomId, addressIndex: state.addressIndex };
    });

    // Picking a room without its address would leave the two disagreeing, and the next
    // stroke would create the room again in whichever address was still selected.
    expect(picked).toEqual({ preset: 'Kitchen', id: 4, addressIndex: 0 });
});


/* -------------------------------------------------------------------------- */
/* Floor type                                                                  */
/* -------------------------------------------------------------------------- */

test('the floor type tool paints the type and the height together', async ({ page }) => {
    const node = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({
            tool: tools.Tool.FLOOR_TYPE, floorType: 2, extraHeight: 3,
        });

        tools.applyTool(floor, state, { kind: 'cell', x: 7, y: 7 });
        const painted = model.nodeAt(floor, 7, 7);
        return { floorType: painted.floorType, height: painted.height };
    });

    expect(node).toEqual({ floorType: 2, height: 3 });
});

test('ctrl+click takes the floor type and the height together', async ({ page }) => {
    const state = await withTools(page, (tools, model, build) => {
        const floor = build();

        const paint = tools.createToolState({
            tool: tools.Tool.FLOOR_TYPE, floorType: 4, extraHeight: 6,
        });
        tools.applyTool(floor, paint, { kind: 'cell', x: 7, y: 7 });

        const picker = tools.createToolState({ tool: tools.Tool.FLOOR_TYPE });
        tools.applyTool(floor, picker, { kind: 'cell', x: 7, y: 7 }, { pick: true });

        return { floorType: picker.floorType, extraHeight: picker.extraHeight };
    });

    // Picking a type without its height means the next thing painted sits at the wrong
    // level, which is why the reference takes both and so does this.
    expect(state).toEqual({ floorType: 4, extraHeight: 6 });
});


/* -------------------------------------------------------------------------- */
/* The lot margin                                                              */
/* -------------------------------------------------------------------------- */

test('the outer margin is readable but not paintable', async ({ page }) => {
    const result = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({ tool: tools.Tool.ADDRESS, addressIndex: 1 });

        const blocked = [0, 1, 2, 18, 19, 20].map((x) => (
            tools.applyTool(floor, state, { kind: 'cell', x, y: 10 })));

        // Picking from the margin is still allowed -- it is reading, not writing.
        const picker = tools.createToolState({ tool: tools.Tool.ADDRESS, addressIndex: 1 });
        const picked = tools.applyTool(floor, picker, { kind: 'cell', x: 0, y: 0 }, { pick: true });

        return {
            blocked,
            stillOutside: model.nodeAt(floor, 0, 10).addressIndex,
            picked,
            pickedAddress: picker.addressIndex,
        };
    });

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

test('the wall tool sets both halves through the model', async ({ page }) => {
    const result = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({ tool: tools.Tool.WALL, wallPreset: '16' });

        const outcome = tools.applyTool(floor, state, { kind: 'wall', x: 6, y: 6, axis: 'x' });

        return {
            outcome,
            low: model.nodeAt(floor, 6, 6).walls,
            high: model.nodeAt(floor, 7, 6).walls,
        };
    });

    expect(result.outcome.changed).toBe(true);
    expect(result.low).toEqual([{ ox: 0.5, oy: 0, preset: '16' }]);
    expect(result.high).toEqual([{ ox: -0.5, oy: 0, preset: '16' }]);
});

test('shift removes a wall, from both sides', async ({ page }) => {
    const result = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({ tool: tools.Tool.WALL, wallPreset: '16' });

        tools.applyTool(floor, state, { kind: 'wall', x: 6, y: 6, axis: 'x' });
        tools.applyTool(floor, state, { kind: 'wall', x: 6, y: 6, axis: 'x' }, { erase: true });

        return {
            low: model.nodeAt(floor, 6, 6).walls,
            high: model.nodeAt(floor, 7, 6).walls,
        };
    });

    expect(result.low).toEqual([]);
    expect(result.high).toEqual([]);
});

test('ctrl+click takes the wall preset off the floor', async ({ page }) => {
    const state = await withTools(page, (tools, model, build) => {
        const floor = build();
        model.setWall(floor, 6, 6, model.AXIS_X, '22');

        const picker = tools.createToolState({ tool: tools.Tool.WALL, wallPreset: '0' });
        const outcome = tools.applyTool(
            floor, picker, { kind: 'wall', x: 6, y: 6, axis: 'x' }, { pick: true });

        // Picking an edge with nothing on it must not set the preset to nothing.
        const empty = tools.applyTool(
            floor, picker, { kind: 'wall', x: 12, y: 12, axis: 'y' }, { pick: true });

        return { preset: picker.wallPreset, outcome: outcome.picked, empty: empty.picked };
    });

    expect(state.preset).toBe('22');
    expect(state.outcome).toBe(true);
    expect(state.empty).toBe(false);
});

test('a click on a cell paints the edge of it that was nearest', async ({ page }) => {
    const edges = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({ tool: tools.Tool.WALL, wallPreset: '7' });

        // A wall is a sliver until something is on it, so a click almost never lands on
        // one. The point is where the ray met the floor, in cell units.
        const at = (x, y, px, pz) => tools.applyTool(
            floor, state, { kind: 'cell', x, y, point: { x: px, z: pz } }).wall;

        return {
            east: at(10, 10, 10.9, 10.5),
            west: at(10, 10, 10.1, 10.5),
            north: at(10, 10, 10.5, 10.9),
            south: at(10, 10, 10.5, 10.1),
        };
    });

    // Named from the low node of the edge, so the same wall has one name from either
    // side of it.
    expect(edges.east).toEqual({ x: 10, y: 10, axis: 'x' });
    expect(edges.west).toEqual({ x: 9, y: 10, axis: 'x' });
    expect(edges.north).toEqual({ x: 10, y: 10, axis: 'y' });
    expect(edges.south).toEqual({ x: 10, y: 9, axis: 'y' });
});

test('an edge off the grid is not painted', async ({ page }) => {
    const result = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({ tool: tools.Tool.WALL, wallPreset: '7' });

        // The far side of the outermost cell: there is no node beyond it to hold the
        // other half of the wall.
        return tools.applyTool(floor, state, { kind: 'cell', x: 0, y: 5, point: { x: 0.05, z: 5.5 } });
    });

    expect(result.changed).toBe(false);
});


/* -------------------------------------------------------------------------- */
/* Tiles                                                                       */
/* -------------------------------------------------------------------------- */

test('the tile tool steps a stairwell through its cycle and off again', async ({ page }) => {
    const steps = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({
            tool: tools.Tool.TILE, tileMode: model.TileMode.STAIRWELL,
        });

        const seen = [];
        for (let i = 0; i < 6; i++) {
            tools.applyTool(floor, state, { kind: 'cell', x: 10, y: 10 });
            const tile = model.tileAt(floor, 3, 3);
            seen.push(tile.isStairwell ? `on ${tile.stairwellRotation}` : 'off');
        }
        return seen;
    });

    // off -> 0 -> 90 -> 180 -> 270 -> off, as the game's own editor does.
    expect(steps).toEqual(['on 0', 'on 90', 'on 180', 'on 270', 'off', 'on 0']);
});

test('painting an elevator over a stairwell converts it', async ({ page }) => {
    const state = await withTools(page, (tools, model, build) => {
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
        return { isStairwell: tile.isStairwell, isInverted: tile.isInverted };
    });

    // The one place the reference improves on the game: no need to clear the tile first.
    expect(state).toEqual({ isStairwell: true, isInverted: true });
});

test('the entrance cycle goes on, main, off', async ({ page }) => {
    const steps = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({
            tool: tools.Tool.TILE, tileMode: model.TileMode.ENTRANCE,
        });

        const seen = [];
        for (let i = 0; i < 4; i++) {
            tools.applyTool(floor, state, { kind: 'cell', x: 4, y: 4 });
            const tile = model.tileAt(floor, 1, 1);
            seen.push(tile.isMainEntrance ? 'main' : (tile.isEntrance ? 'entrance' : 'off'));
        }
        return seen;
    });

    expect(steps).toEqual(['entrance', 'main', 'off', 'entrance']);
});

test('a node names the tile it falls in, not one of its own', async ({ page }) => {
    const selected = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({ tool: tools.Tool.TILE });

        // Nodes 9 to 11 are all tile 3; node 12 starts tile 4.
        const inner = tools.applyTool(floor, state, { kind: 'cell', x: 11, y: 11 }).tile;
        const next = tools.applyTool(floor, state, { kind: 'cell', x: 12, y: 12 }).tile;

        return { inner, next };
    });

    expect(selected.inner).toEqual({ x: 3, y: 3 });
    expect(selected.next).toEqual({ x: 4, y: 4 });
});

test('ctrl+click on a tile selects it without cycling it', async ({ page }) => {
    const result = await withTools(page, (tools, model, build) => {
        const floor = build();
        const state = tools.createToolState({ tool: tools.Tool.TILE });

        const outcome = tools.applyTool(floor, state, { kind: 'cell', x: 10, y: 10 }, { pick: true });
        return { outcome, isStairwell: model.tileAt(floor, 3, 3).isStairwell };
    });

    expect(result.outcome.changed).toBe(false);
    expect(result.outcome.picked).toBe(true);
    expect(result.isStairwell).toBe(false);
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

        const state = toolsModule.createToolState();
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
