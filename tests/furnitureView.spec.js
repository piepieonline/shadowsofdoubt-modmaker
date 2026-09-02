import { test, expect } from '@playwright/test';
import { installFsHarness, collectPageErrors, gotoFlow } from '../test-support/harness.js';

/**
 * The furniture creator's 3D pane, built directly rather than through the modal.
 *
 * The same shape as `buildingScene.spec.js` and for the same reason: what is being tested
 * is what ends up in the scene, and reaching that through a dialog would test the dialog
 * as well and report a failure in either as a failure in both.
 *
 * It also covers `core/viewer3d.js`'s second caller. The floorplan proves the extraction
 * did not break the view it came out of; this proves the parts that were made optional --
 * the left button, the near plane, the distances -- work when they are set the other way.
 */

/**
 * A preset with two sub-objects it can place and one it cannot, in a 3x1 slot.
 *
 * The shapes the view distinguishes, and no more: a marker it can position, a marker it
 * cannot, and a footprint bigger than one tile. Written as documents because that is what
 * the pane reads -- whole assets out of the author's export -- so the translation under
 * test here is the same one the app does.
 */
const DESK = {
    name: 'HotelDesk',
    preset: {
        presetName: 'HotelDesk',
        classes: ['REF:FurnitureClass|3x1LobbyDesk'],
        subObjects: [
            {
                preset: 'REF:SubObjectClassPreset|Computer',
                parent: '',
                localPos: { x: -1.023, y: 1, z: 0.266 },
                localRot: { x: 0, y: 194.729, z: 0 },
                belongsTo: 2,
            },
            {
                preset: 'REF:SubObjectClassPreset|DeskItemOffice',
                parent: '',
                localPos: { x: -1.78, y: 1, z: 0.141 },
                localRot: { x: 0, y: 175.07, z: 0 },
                belongsTo: 2,
            },
            {
                preset: 'REF:SubObjectClassPreset|DeskLamp',
                parent: 'TopDrawer',
                localPos: { x: 0.132, y: 0.751, z: -0.06 },
                localRot: { x: 0, y: 0, z: 0 },
                belongsTo: 0,
            },
        ],
    },
    classes: [{ presetName: '3x1LobbyDesk', objectSize: { x: 3, y: 1 }, tall: true }],
};

/** The same, with every sub-object parented -- so nothing is drawn until asked. */
const SOFA = {
    name: 'BrownSofaSmall',
    preset: {
        presetName: 'BrownSofaSmall',
        classes: ['REF:FurnitureClass|2x1Sofa'],
        subObjects: [
            {
                preset: 'REF:SubObjectClassPreset|DeskLamp',
                parent: 'SmallSofaSideTable1',
                localPos: { x: 0.132, y: 0.751, z: -0.06 },
                localRot: { x: 0, y: 0, z: 0 },
                belongsTo: 0,
            },
        ],
    },
    classes: [{ presetName: '2x1Sofa', objectSize: { x: 2, y: 1 } }],
};

/** A one-node piece, which is what most of the game's classes are. */
const BOOKCASE = {
    name: 'LargeBookcase',
    preset: {
        presetName: 'LargeBookcase',
        classes: ['REF:FurnitureClass|1x1BookcaseLarge'],
        subObjects: [
            {
                preset: 'REF:SubObjectClassPreset|Book',
                parent: '',
                localPos: { x: -0.2, y: 1.4, z: 0.1 },
                localRot: { x: 0, y: 0, z: 0 },
                belongsTo: 0,
            },
        ],
    },
    classes: [{ presetName: '1x1BookcaseLarge', objectSize: { x: 1, y: 1 }, tall: true }],
};

/**
 * Mount a view in a sized container and run a body against it.
 *
 * The container is given an explicit size because a detached test page has no layout to
 * inherit one from, and a canvas of zero by zero makes every projection NaN.
 */
async function withView(page, body, asset = DESK, loaded = null) {
    return page.evaluate(async ({ source, asset: document_, loaded: model_ }) => {
        const viewModule = await import('/flows/scriptableObject/scripts/furnitureView.js');
        const model = await import('/flows/scriptableObject/scripts/furnitureModel.js');

        const container = document.createElement('div');
        container.style.cssText = 'width: 640px; height: 480px; position: absolute; top: 0; left: 0;';
        document.body.appendChild(container);

        // Built from a document rather than read from a folder. What is being tested is
        // what ends up in the scene, and reading is `furnitureCreator.spec.js`'s subject --
        // a view spec that also needed an export folder would report a failure in either
        // as a failure in both.
        const preset = document_
            ? model.describeDocument(document_.name, document_.preset, document_.classes)
            : null;

        const view = await viewModule.createFurnitureView(container);
        view.show(preset, model_);

        try {
            // eslint-disable-next-line no-new-func
            return await new Function('view', 'preset', 'model', 'container',
                `return (${source})(view, preset, model, container)`)(view, preset, model, container);
        } finally {
            view.dispose();
            container.remove();
        }
    }, { source: body.toString(), asset, loaded });
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
});

test('draws a marker per placed sub-object and a tile per node of the footprint', async ({ page }) => {
    const errors = collectPageErrors(page);

    const counts = await withView(page, (view) => ({
        markers: view._internals.markers.children.length,
        tiles: view._internals.footprint.children.length,
        proxy: view._internals.proxy.children.length,
    }));

    // Two it can place, a 3x1 slot, and one wireframe box.
    expect(counts).toEqual({ markers: 2, tiles: 3, proxy: 1 });
    expect(errors).toEqual([]);
});

/**
 * The footprint under the markers rather than beside them.
 *
 * A 3x1 desk stands on the anchor node and the two beyond it, and its sub-objects are
 * written relative to that same anchor. Drawing the tiles centred on the origin instead --
 * which is what this pane did -- shifts them a node and a half back, so every one of the
 * desk's markers lands on the tile nearest the camera and the box it is in ends level with
 * the desk's own middle. Checked in the scene because the mistake was in the drawing.
 */
test('lays the footprint under the sub-objects, not a node and a half behind them', async ({ page }) => {
    const drawn = await withView(page, (view) => ({
        tiles: view._internals.footprint.children.map((tile) => tile.position.x).sort((a, b) => a - b),
        markers: view._internals.markers.children.map((group) => group.position.x),
        proxy: view._internals.proxy.children[0].position.x,
    }));

    // Three nodes of 1.8, starting on the anchor and reaching along +x.
    expect(drawn.tiles).toEqual([0, 1.8, 3.6]);

    // The box over the middle of them, and both markers inside it rather than on its edge.
    expect(drawn.proxy).toBeCloseTo(1.8, 6);
    for (const x of drawn.markers) {
        expect(x).toBeGreaterThan(-0.9);
        expect(x).toBeLessThan(4.5);
    }
});

/**
 * The camera follows, because the piece no longer stands on the origin. Without this a 3x1
 * desk is drawn off to one side of the view and a 4x2 food truck mostly out of it.
 */
test('points the camera at the middle of the piece, from far enough back to see it', async ({ page }) => {
    const aimed = await withView(page, (view) => {
        const { camera, controls } = view._internals.viewer;
        return {
            target: [controls.target.x, controls.target.y, controls.target.z],
            distance: camera.position.distanceTo(controls.target),
        };
    });

    // Over the middle node of the three, at the same waist height as ever.
    expect(aimed.target[0]).toBeCloseTo(1.8, 6);
    expect(aimed.target[1]).toBeCloseTo(0.7, 6);
    expect(aimed.target[2]).toBeCloseTo(0, 6);

    // Far enough that 5.4 metres of desk fits the 45 degrees the camera has, with a margin.
    expect(aimed.distance).toBeCloseTo((5.4 / 2) / Math.tan(22.5 * Math.PI / 180) * 1.15, 3);
});

/**
 * 210 of the game's 262 classes are a single node, where the anchor and the middle are the
 * same point. Nothing about the view of one should have moved.
 */
test('leaves a one-node piece framed exactly where it was', async ({ page }) => {
    const aimed = await withView(page, (view) => {
        const { camera, controls } = view._internals.viewer;
        return {
            eye: [camera.position.x, camera.position.y, camera.position.z],
            target: [controls.target.x, controls.target.y, controls.target.z],
        };
    }, BOOKCASE);

    // Close rather than equal: OrbitControls rewrites the camera out of a spherical on
    // every update, so the numbers it hands back are never quite the ones it was given.
    for (const [axis, at] of [[0, 2.6], [1, 2], [2, 3.4]]) {
        expect(aimed.eye[axis]).toBeCloseTo(at, 6);
    }

    for (const [axis, at] of [[0, 0], [1, 0.7], [2, 0]]) {
        expect(aimed.target[axis]).toBeCloseTo(at, 6);
    }
});

/**
 * The mirror and the Euler order, checked against the scene rather than against the
 * arithmetic -- `furnitureModel.unit.spec.js` covers the conversion itself, and this is
 * that conversion having survived being applied.
 */
test('places a marker where the game says, mirrored into the scene', async ({ page }) => {
    const place = await withView(page, (view, preset) => {
        const marker = view._internals.markers.children[0];
        return {
            stated: preset.placed[0].pos,
            drawn: [marker.position.x, marker.position.y, marker.position.z],
            order: marker.rotation.order,
            yaw: marker.rotation.y,
        };
    });

    expect(place.stated).toEqual([-1.023, 1, 0.266]);
    expect(place.drawn[0]).toBeCloseTo(1.023, 6);
    expect(place.drawn[1]).toBeCloseTo(1, 6);
    expect(place.drawn[2]).toBeCloseTo(0.266, 6);

    // Unity composes Ry·Rx·Rz; the default XYZ would be a different rotation from the
    // same three numbers.
    expect(place.order).toBe('YXZ');
    expect(place.yaw).toBeCloseTo(-194.729 * Math.PI / 180, 6);
});

test('draws nothing for the sub-objects it cannot place until asked', async ({ page }) => {
    const counts = await withView(page, async (view) => {
        const before = view._internals.markers.children.length;
        view.setParentedVisible(true);
        const after = view._internals.markers.children.length;
        view.setParentedVisible(false);
        return { before, after, off: view._internals.markers.children.length };
    }, SOFA);

    // Every one of this one's sub-objects hangs off a transform inside the model.
    expect(counts).toEqual({ before: 0, after: 1, off: 0 });
});

test('marks the sub-object under the pointer, and colours it apart', async ({ page }) => {
    const result = await withView(page, (view) => {
        const marker = view._internals.markers.children[1];
        const entry = marker.userData.subObject;

        const before = marker.children[0].material.color.getHex();
        view.select({ index: entry.index, parented: entry.parented });
        const after = marker.children[0].material.color.getHex();

        const others = view._internals.markers.children
            .filter((group) => group !== marker)
            .map((group) => group.children[0].material.color.getHex());

        return { before, after, others: [...new Set(others)] };
    });

    expect(result.after).not.toBe(result.before);
    expect(result.others).toEqual([result.before]);
});

/* -------------------------------------------------------------------------- */
/* Integrated interactables                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A desk that carries three, and a prefab that can place two of them.
 *
 * `A` and `hidingPlace` are in the prefab; `B` is not, which is the ordinary state of a
 * preset cloned from a shipped one -- the donor's list names controllers the new model has
 * no equivalent of. Nothing is drawn for it, because the game creates it at the origin by
 * a path that logs about having failed, and a marker there would read as a measurement.
 */
const BUILT_IN = {
    ...DESK,
    preset: {
        ...DESK.preset,
        integratedInteractables: [
            { preset: 'REF:InteractablePreset|HotelDesk', pairToController: 0, belongsTo: 2 },
            { preset: 'REF:InteractablePreset|HotelDesk', pairToController: 1, belongsTo: 3 },
            { preset: 'REF:InteractablePreset|HidingPlace', pairToController: 10, belongsTo: 0 },
        ],
    },
};

/** As `readModel` hands one back, with no mesh: the controllers are the prefab's. */
const WITH_CONTROLLERS = {
    name: 'MyDesk',
    controllers: [
        { id: 'A', node: 'WorkPosition', offset: [0.4, 0.9, -0.5] },
        { id: 'hidingPlace', node: 'Underneath', offset: [0, 0.4, -0.2] },
    ],
};

test('draws a marker only for the interactables the prefab can place', async ({ page }) => {
    const errors = collectPageErrors(page);

    const drawn = await withView(page, (view) => ({
        count: view._internals.interactables.children.length,
        ids: view._internals.interactables.children.map((one) => one.userData.interactable.id),
    }), BUILT_IN, WITH_CONTROLLERS);

    // Three entries, two controllers. `B` is not in the prefab and gets nothing.
    expect(drawn).toEqual({ count: 2, ids: ['A', 'hidingPlace'] });
    expect(errors).toEqual([]);
});

/**
 * Mirrored on x exactly as a mesh offset is. The prefab's positions are in the game's
 * left-handed space like everything else the game writes, and this scene is the other
 * handedness -- a marker copied straight across sits on the wrong side of the desk.
 */
test('puts an interactable where its controller is, mirrored into the scene', async ({ page }) => {
    const place = await withView(page, (view) => {
        const marker = view._internals.interactables.children[0];
        return [marker.position.x, marker.position.y, marker.position.z];
    }, BUILT_IN, WITH_CONTROLLERS);

    expect(place[0]).toBeCloseTo(-0.4, 6);
    expect(place[1]).toBeCloseTo(0.9, 6);
    expect(place[2]).toBeCloseTo(-0.5, 6);
});

/** Nothing to place them against means nothing drawn, rather than a heap at the origin. */
test('draws none of them when no prefab was read', async ({ page }) => {
    const count = await withView(page, (view) =>
        view._internals.interactables.children.length, BUILT_IN);

    expect(count).toBe(0);
});

/**
 * The index a marker carries is its place in the preset's list, not its place among the
 * markers.
 *
 * Those differ exactly when an entry could not be drawn, which is the case this view has to
 * get right: `B` is second in the list and has no marker, so `hidingPlace` is the second
 * marker and the *third* entry. Reporting the marker's own position would mark the wrong
 * row in the pane whenever a pairing was broken -- which is when an author is looking.
 */
test('identifies a marker by its place in the list, not among the markers', async ({ page }) => {
    const indices = await withView(page, (view) =>
        view._internals.interactables.children.map((one) => one.userData.interactable.index),
    BUILT_IN, WITH_CONTROLLERS);

    expect(indices).toEqual([0, 2]);
});

test('marks an interactable apart, and apart from a marked sub-object', async ({ page }) => {
    const result = await withView(page, (view) => {
        const marker = view._internals.interactables.children[1];

        const before = marker.material.color.getHex();
        view.selectInteractable(marker.userData.interactable.index);
        const after = marker.material.color.getHex();

        const others = view._internals.interactables.children
            .filter((one) => one !== marker)
            .map((one) => one.material.color.getHex());

        // A sub-object and an interactable are different colours unmarked, so neither can
        // be read as the other.
        const subObject = view._internals.markers.children[0].children[0].material.color.getHex();

        return { before, after, others: [...new Set(others)], subObject };
    }, BUILT_IN, WITH_CONTROLLERS);

    expect(result.after).not.toBe(result.before);
    expect(result.others).toEqual([result.before]);
    expect(result.subObject).not.toBe(result.before);
});

test('takes a preset with no class as having no box rather than a box of nothing', async ({ page }) => {
    const counts = await withView(page, (view, preset, model) => {
        view.show({ ...preset, classes: [], placed: preset.placed, parented: [] });
        return {
            proxy: view._internals.proxy.children.length,
            tiles: view._internals.footprint.children.length,
            markers: view._internals.markers.children.length,
        };
    });

    expect(counts.proxy).toBe(0);
    expect(counts.tiles).toBe(0);
    expect(counts.markers).toBe(2);
});

/**
 * The left button is the one thing the extraction had to make optional. The floorplan
 * withholds it from the camera because a drag paints; here there is nothing to paint, and
 * a view whose obvious drag does nothing reads as broken.
 */
test('gives the left button to the camera, unlike the floorplan', async ({ page }) => {
    const buttons = await withView(page, (view) => {
        const { controls, THREE } = view._internals.viewer;
        return { left: controls.mouseButtons.LEFT, rotate: THREE.MOUSE.ROTATE };
    });

    expect(buttons.left).toBe(buttons.rotate);
});

test('lets go of the GPU when it is disposed', async ({ page }) => {
    const gone = await page.evaluate(async () => {
        const viewModule = await import('/flows/scriptableObject/scripts/furnitureView.js');

        const container = document.createElement('div');
        container.style.cssText = 'width: 320px; height: 240px; position: absolute;';
        document.body.appendChild(container);

        const view = await viewModule.createFurnitureView(container);
        const canvas = view.canvas;

        view.dispose();
        const removed = !canvas.isConnected;
        container.remove();

        return removed;
    });

    expect(gone).toBe(true);
});
