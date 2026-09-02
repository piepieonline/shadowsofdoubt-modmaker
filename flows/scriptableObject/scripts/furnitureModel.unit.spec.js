/**
 * Turning a `FurniturePreset` asset into the record the pane draws.
 *
 * Documents rather than reads. The assets come from the author's exported
 * ScriptableObjects folder, which needs a browser and a folder handle -- and
 * `test-support/refs.js` is explicit that a test wanting one belongs in the Playwright
 * suite rather than behind a fake. So what is checked here is the half that needs neither:
 * the translation from what an asset holds to what the pane wants, and the arithmetic that
 * puts a sub-object in a scene and takes it back out.
 *
 * The translation is worth this much care because every mistake in it is quiet. A vector
 * read as the wrong shape draws a lamp somewhere plausible; an enum read against the wrong
 * table names the wrong person; a default read as 0 where the game says 99 turns a preset
 * that never places into one that looks fine.
 */
import { describe, test, expect } from 'vitest';

import {
    describeDocument, proxyBox, modelExtent, clustersFor, clusterLayout, coLocated,
    warningsFor, describeSlot, inSceneSpace, fromSceneSpace, tileCentre, footprintNode,
    NODE_METRES,
} from './furnitureModel.js';

/** A shipped preset as the export folder holds one, once references are named. */
const hotelDesk = {
    presetName: 'HotelDesk',
    prefab: 'REF:GameObject|HotelFrontDesk',
    classes: ['REF:FurnitureClass|3x1LobbyDesk'],
    allowedRoomFilters: ['REF:RoomTypeFilter|Lobby'],
    universalDesignStyle: true,
    minimumRoomSize: 4,
    subObjects: [
        {
            preset: 'REF:SubObjectClassPreset|Computer',
            parent: '',
            localPos: { x: -1.023, y: 1, z: 0.266 },
            localRot: { x: 0, y: 194.729, z: 0 },
            belongsTo: 2,
            security: 0,
        },
        {
            preset: 'REF:SubObjectClassPreset|DeskLamp',
            parent: 'TopDrawer',
            localPos: { x: 0, y: 1, z: 0 },
            localRot: { x: 0, y: 0, z: 0 },
            belongsTo: 0,
            security: 1,
        },
    ],
    integratedInteractables: [
        { preset: 'REF:InteractablePreset|HotelDesk', pairToController: 0, belongsTo: 2 },
        { preset: 'REF:InteractablePreset|HidingPlace', pairToController: 10, belongsTo: 0 },
    ],
};

const lobbyDesk = {
    presetName: '3x1LobbyDesk',
    objectSize: { x: 3, y: 1 },
    tall: true,
    wallPiece: false,
    minimumZeroNodeWallCount: 0,
    maximumZeroNodeWallCount: 3,
};

const describe1 = (document, classes = [lobbyDesk]) =>
    describeDocument(document.presetName, document, classes);


describe('one preset', () => {
    test('names the model, and says when it is not named after the preset', () => {
        const preset = describe1(hotelDesk);

        expect(preset.prefab).toBe('HotelFrontDesk');
        expect(preset.sharesModel).toBe(true);
    });

    test('does not call a mod’s own prefab path a shared model', () => {
        const preset = describe1({ ...hotelDesk, prefab: 'PREFAB:MyDeskPrefab/MyDesk' });

        expect(preset.prefab).toBe('PREFAB:MyDeskPrefab/MyDesk');
        expect(preset.sharesModel).toBe(false);
    });

    test('reads the slot it fills, with its footprint', () => {
        const preset = describe1(hotelDesk);

        expect(preset.classes[0]).toMatchObject({ name: '3x1LobbyDesk', size: [3, 1], tall: true });
    });

    /**
     * A class that could not be read is kept and marked rather than dropped: a preset in a
     * class nothing can find is a preset nothing will place, and a missing row says nothing.
     */
    test('marks a class it was given no document for', () => {
        const preset = describe1(hotelDesk, []);

        expect(preset.classes).toEqual([{ name: '3x1LobbyDesk', missing: true }]);
    });

    /**
     * The split that stops the view asserting something it cannot know: a parented
     * sub-object hangs off a transform inside the model and is not where it appears.
     */
    test('separates the sub-objects it can place from the ones it cannot', () => {
        const preset = describe1(hotelDesk);

        expect(preset.placed).toHaveLength(1);
        expect(preset.parented).toHaveLength(1);
        expect(preset.parented[0].parent).toBe('TopDrawer');
    });

    test('reads a vector as the array the rest of the pane uses', () => {
        expect(describe1(hotelDesk).placed[0].pos).toEqual([-1.023, 1, 0.266]);
    });

    /** An asset spells its enums as integers. Index 2 is `person0`, not `person2`. */
    test('reads the enums an asset spells as integers', () => {
        const preset = describe1(hotelDesk);

        expect(preset.placed[0].owner).toBe('person0');
        expect(preset.interactables).toEqual([
            { preset: 'HotelDesk', controller: 'A', owner: 'person0' },
            { preset: 'HidingPlace', controller: 'hidingPlace', owner: 'nobody' },
        ]);
    });

    test('keeps a security level, and leaves a zero one off', () => {
        const preset = describe1(hotelDesk);

        expect(preset.parented[0].security).toBe(1);
        expect(preset.placed[0].security).toBeUndefined();
    });

    /**
     * The game's own default, and the commonest way to write a preset that never places.
     * Reading an unstated minimum as 0 would make it look fine.
     */
    test('reads an unstated room size as the 99 the game defaults to', () => {
        expect(describe1({ presetName: 'Thing' }).minimumRoomSize).toBe(99);
        expect(describe1({ presetName: 'Thing', minimumRoomSize: 0 }).minimumRoomSize).toBe(0);
    });
});


describe('the box drawn where the model would be', () => {
    test('is the class footprint in metres', () => {
        const box = proxyBox(describe1(hotelDesk));

        expect(box.tiles).toEqual([3, 1]);
        expect(box.width).toBeCloseTo(3 * NODE_METRES, 10);
    });

    /**
     * The bug this centre exists for: a 3x1 desk drawn as a box about the origin has its
     * three squares reaching a node and a half either side of the anchor, so every
     * sub-object in it -- all of which sit between the anchor and the far end -- lands on
     * the one square nearest the camera and the desk reads as having been packed wrong.
     */
    test('stands over the middle of the footprint, not over the anchor node', () => {
        const box = proxyBox(describe1(hotelDesk));

        // Nodes 0, -1 and -2 of the class's frame, whose middle is -1 -- and the scene
        // mirrors x, so the box stands a node along +x from the origin.
        expect(box.centre).toEqual([NODE_METRES, 0, 0]);
    });

    /** One node across is the case where the two readings agree, and most classes are it. */
    test('stands on the origin when the piece is one node', () => {
        const box = proxyBox(describe1(
            { ...hotelDesk, classes: ['REF:FurnitureClass|Small'] },
            [{ presetName: 'Small', objectSize: { x: 1, y: 1 } }]));

        expect(box.centre).toEqual([0, 0, 0]);
    });

    /**
     * A preset can be in two classes that disagree. The larger is drawn: a box smaller than
     * the piece puts sub-objects outside it, which reads as an author having misplaced them.
     */
    test('takes the largest footprint when the classes disagree', () => {
        const box = proxyBox(describe1(
            { ...hotelDesk, classes: ['REF:FurnitureClass|Small', 'REF:FurnitureClass|Wide'] },
            [
                { presetName: 'Small', objectSize: { x: 1, y: 1 } },
                { presetName: 'Wide', objectSize: { x: 4, y: 2 }, tall: true },
            ]));

        expect(box.tiles).toEqual([4, 2]);
        expect(box.tall).toBe(true);
        expect(box.centre).toEqual([1.5 * NODE_METRES, 0, -0.5 * NODE_METRES]);
    });

    test('is null when no class is known, rather than a box of nothing', () => {
        expect(proxyBox(describe1({ presetName: 'Thing', classes: [] }, []))).toBeNull();
    });
});


describe('the block of nodes a piece stands on', () => {
    /**
     * The nodes are the ones a class writes its rules at, which run negative from the
     * anchor -- `GenerationController.cs:4543` lays the footprint down two quarter turns
     * from the angle every rule is read at. The scene mirrors x, so a piece whose nodes
     * count down in x is still drawn reaching along +x; z is not mirrored and follows the
     * node straight down.
     */
    test('counts down from the anchor, and is drawn along +x and -z', () => {
        expect(footprintNode(0, 0)).toEqual([0, 0, 0]);
        expect(footprintNode(-2, -1)).toEqual([2 * NODE_METRES, 0, -NODE_METRES]);
    });

    /**
     * A cluster's placements are rotated by the cluster's angle alone, which is the angle a
     * class's rules are read at -- so they are on this grid and not a second one. Held as
     * one function rather than two that have to agree.
     */
    test('is the same grid a cluster places its slots on', () => {
        expect(tileCentre(-2, -1)).toEqual(footprintNode(-2, -1));
    });

    /**
     * The reading tied back to the game's own data, which is the whole of the evidence for
     * it. The shipped HotelDesk's placed sub-objects run from x -3.106 to -0.484, so 0.484
     * to 3.106 once mirrored into the scene. A 3x1 footprint centred on the origin covers
     * -2.7 to 2.7 and leaves the far half of the desk's load outside its own box, piled on
     * the near square; one growing from the anchor covers -0.9 to 4.5, with the load spread
     * about the middle of it.
     */
    test('covers what the shipped preset puts on the piece', () => {
        const box = proxyBox(describe1(hotelDesk));
        const load = [0.484, 1.023, 1.78, 3.106];

        const near = footprintNode(0, 0)[0] - NODE_METRES / 2;
        const far = footprintNode(-(box.tiles[0] - 1), 0)[0] + NODE_METRES / 2;

        for (const x of load) {
            expect(x).toBeGreaterThan(near);
            expect(x).toBeLessThan(far);
        }

        // Spread about the middle of the box rather than against one end of it, which is
        // what says the piece is drawn where its model is rather than a node and a half off.
        expect((load[0] + load.at(-1)) / 2).toBeCloseTo(box.centre[0], 1);
    });
});


/**
 * The nodes a mod's own model reaches into, which is the one thing about a piece of
 * furniture that nothing in the assets states and nothing in the game checks. A model
 * overhanging its declared `objectSize` is placed anyway and clips whatever is beside it,
 * and the only way to see it coming is to measure the mesh against the footprint.
 *
 * The arithmetic has to agree with `footprintNode` exactly. It is measured in metres and
 * answered in nodes, so every mistake is a whole tile.
 */
describe('the nodes a model reaches into', () => {
    /** A box of the given extent, as `readModel` hands one back. Only the corners matter. */
    const meshOf = ([x0, z0], [x1, z1], offset = [0, 0, 0]) => ({
        meshes: [{
            name: 'thing.obj',
            offset,
            geometry: { positions: [x0, 0, z0, x1, 0, z1, x0, 1, z1], indices: [0, 1, 2] },
        }],
    });

    test('is null when there is no model to measure', () => {
        expect(modelExtent(null)).toBeNull();
        expect(modelExtent({})).toBeNull();
        expect(modelExtent({ meshes: [] })).toBeNull();
    });

    /**
     * A prefab naming a file with no vertices in it. `parseObj` cannot produce one -- it
     * returns null for text with no faces -- but a hand-written prefab pointing at an empty
     * file reaches here, and Infinity as a tile offset would draw a grid that never ends.
     */
    test('is null for meshes with no vertices, rather than an infinite one', () => {
        expect(modelExtent({ meshes: [{ geometry: { positions: [], indices: [] } }] })).toBeNull();
    });

    /**
     * The case every well-made model is: built to fill its footprint exactly, so both ends
     * sit on a tile boundary. A 3x1 desk runs from -0.9 to 4.5 in the scene, and if both
     * ends rounded the same way the far end would land on node 3 and the pane would report
     * an overhang the author does not have.
     */
    test('reads a model flush with its footprint as reaching no further', () => {
        const half = NODE_METRES / 2;
        const extent = modelExtent(meshOf([-half, -half], [2 * NODE_METRES + half, half]));

        // Nodes 0, -1 and -2, which is a 3x1 class's whole footprint and no more.
        expect(extent).toMatchObject({ minX: -2, maxX: 0, minY: 0, maxY: 0 });
        expect(extent.metres).toEqual({ across: 5.4, deep: 1.8 });
    });

    /** A hair past the boundary is the overhang the whole overlay exists to show. */
    test('reads a model past the boundary as reaching the next node', () => {
        const half = NODE_METRES / 2;
        const extent = modelExtent(meshOf([-half, -half], [2 * NODE_METRES + half + 0.1, half]));

        expect(extent).toMatchObject({ minX: -3, maxX: 0 });
    });

    /**
     * Depth runs the same way across: the class's `+y` is `front`, so a model reaching back
     * from the anchor is at negative y. This is where a transcription error would put a
     * table's overhang on the wrong side of it -- drawn confidently, and wrong in the one
     * direction the author came here to check.
     */
    test('counts depth so a model reaching back is at negative y', () => {
        const half = NODE_METRES / 2;
        const extent = modelExtent(meshOf([-half, -NODE_METRES - half], [half, half]));

        expect(extent).toMatchObject({ minX: 0, maxX: 0, minY: -1, maxY: 0 });
    });

    /**
     * The prefab's own offset is a position in the game's space like any other, so x is
     * mirrored when it is applied -- the same conversion `drawModel` does in the view. Left
     * out, a mesh the prefab pushes along the desk is drawn on the wrong end of it.
     *
     * The offset is `(-1.8, 0, -1.8)` in the game's space, which is one node further into
     * the piece's own body on both axes: node `(-1, -1)` of the class's frame.
     */
    test('mirrors the prefab offset on x and takes z as it is', () => {
        const half = NODE_METRES / 2;

        const shifted = modelExtent(
            meshOf([-half, -half], [half, half], [-NODE_METRES, 0, -NODE_METRES]));

        expect(shifted).toMatchObject({ minX: -1, maxX: -1, minY: -1, maxY: -1 });
    });

    /** Several meshes are one model, and the extent is the box round all of them. */
    test('takes the whole of a model split across meshes', () => {
        const half = NODE_METRES / 2;

        const extent = modelExtent({
            meshes: [
                { offset: [0, 0, 0], geometry: { positions: [-half, 0, -half, 0, 0, 0] } },
                { offset: [0, 0, 0], geometry: { positions: [2 * NODE_METRES, 0, 0, 0, 0, 0] } },
            ],
        });

        expect(extent).toMatchObject({ minX: -2, maxX: 0, minY: 0, maxY: 0 });
    });
});


describe('the coordinate conversion', () => {
    /**
     * The game is left-handed and three.js is not, so a position copied across draws the
     * model mirrored -- every sub-object on the wrong side of the thing it sits on.
     */
    test('mirrors x and leaves height and depth alone', () => {
        expect(inSceneSpace({ pos: [1.5, 0.75, -0.25], rot: [0, 0, 0] }).position)
            .toEqual([-1.5, 0.75, -0.25]);
    });

    /**
     * Unity composes Quaternion.Euler as Ry·Rx·Rz, which three.js spells YXZ. The default
     * XYZ agrees with it only while two of the three angles are zero, so naming the order is
     * what stops this being right nearly everywhere and wrong where it matters.
     */
    test('names the Euler order Unity composes in', () => {
        expect(inSceneSpace({ pos: [0, 0, 0], rot: [0, 90, 0] }).order).toBe('YXZ');
    });

    /**
     * Mirroring x conjugates the rotation, which takes the axis (nx, ny, nz) to
     * (nx, -ny, -nz) -- so the turn about x survives and those about y and z reverse.
     */
    test('reverses the turns the mirror reverses, and keeps the one it does not', () => {
        const [x, y, z] = inSceneSpace({ pos: [0, 0, 0], rot: [90, 45, 30] }).rotation;

        expect(x).toBeCloseTo(Math.PI / 2, 10);
        expect(y).toBeCloseTo(-Math.PI / 4, 10);
        expect(z).toBeCloseTo(-Math.PI / 6, 10);
    });

    /** The shape a plan drawing would miss: tilted about x as well as turned about y. */
    test('carries a tilt stated about more than one axis', () => {
        const place = inSceneSpace({ pos: [0, 0, 0], rot: [358.391, 22.496, 3.879] });

        expect(place.rotation[0]).toBeCloseTo(358.391 * Math.PI / 180, 10);
        expect(place.rotation[1]).toBeCloseTo(-22.496 * Math.PI / 180, 10);
    });

    /**
     * The way back, which is what a dragged marker goes through before it is written. Both
     * halves are their own inverse, so a round trip has to come back exactly -- and if it
     * does not, an author who drags a lamp and drops it has moved it.
     */
    test('comes back to the numbers it started from', () => {
        const sub = { pos: [-1.023, 1, 0.266], rot: [358.391, 22.496, 3.879] };
        const place = inSceneSpace(sub);
        const back = fromSceneSpace(place.position, place.rotation);

        expect(back.pos).toEqual(sub.pos);
        for (const axis of [0, 1, 2]) expect(back.rot[axis]).toBeCloseTo(sub.rot[axis], 3);
    });

    /** Every shipped value is written in [0, 360), so a dragged one should be too. */
    test('writes an angle the way the game’s own data writes it', () => {
        expect(fromSceneSpace([0, 0, 0], [0, Math.PI / 12, 0]).rot[1]).toBe(345);
    });

    test('lays a cluster’s tiles out on the same mirrored axis', () => {
        expect(tileCentre(0, 0)).toEqual([0, 0, 0]);
        expect(tileCentre(1, 2)).toEqual([-NODE_METRES, 0, 2 * NODE_METRES]);
    });
});


/**
 * The hop nothing in the files states: a preset names classes, a cluster names classes, and
 * nothing points from one to the other. The index is what having read every cluster once
 * looks like, so these run against one built by hand.
 */
describe('the arrangements a preset appears in', () => {
    const cubicle = {
        presetName: 'OfficeCubicleX1',
        clusterElements: [
            {
                furnitureClass: 'REF:FurnitureClass|1x1OfficeCubicle',
                placements: [{ x: 0, y: 0 }],
                facing: 0,
                importantToCluster: true,
            },
            {
                furnitureClass: 'REF:FurnitureClass|1x1FilingCabinetUnderDesk',
                placements: [{ x: 0, y: 0 }],
                facing: 0,
                importantToCluster: false,
                onlyValidIfPreviousObjectPlaced: true,
            },
        ],
    };

    const index = {
        byClass: new Map([
            ['1x1OfficeCubicle', new Set(['OfficeCubicleX1'])],
            ['1x1FilingCabinetUnderDesk', new Set(['OfficeCubicleX1'])],
        ]),
        clusters: new Map([['OfficeCubicleX1', cubicle]]),
    };

    const preset = { classes: [{ name: '1x1OfficeCubicle' }] };

    test('finds every slot a cluster has for this preset’s class', () => {
        const found = clustersFor(index, preset);

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ name: 'OfficeCubicleX1', slots: [0], elements: 2 });
    });

    test('is empty for a preset no cluster has a slot for', () => {
        expect(clustersFor(index, { classes: [{ name: 'Elsewhere' }] })).toEqual([]);
    });

    /**
     * A switched-off cluster is listed and marked rather than dropped. If it is the only
     * arrangement a preset appears in, "nowhere" and "one place that is off" are different
     * problems with different fixes.
     */
    test('keeps a disabled cluster, and says so', () => {
        const off = {
            byClass: new Map([['Slot', new Set(['Off'])]]),
            clusters: new Map([['Off', { disable: true, clusterElements: [{ furnitureClass: 'REF:FurnitureClass|Slot' }] }]]),
        };

        expect(clustersFor(off, { classes: [{ name: 'Slot' }] })[0].disabled).toBe(true);
    });

    test('reads a cluster as a plan, defaulting a silent slot to the anchor facing down', () => {
        const layout = clusterLayout(index, 'OfficeCubicleX1');

        expect(layout.slots[0]).toMatchObject({ x: 0, y: 0, facing: 'down', alternate: false });
        expect(layout.slots[1].afterPrevious).toBe(true);
    });

    /**
     * An element that states two placements states a fallback, not a second thing placed --
     * so a plan must not draw them as equals.
     */
    test('marks an alternate placement as an alternate', () => {
        const alternates = {
            byClass: new Map(),
            clusters: new Map([['Two', {
                clusterElements: [{
                    furnitureClass: 'REF:FurnitureClass|Slot',
                    placements: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
                }],
            }]]),
        };

        const layout = clusterLayout(alternates, 'Two');

        expect(layout.slots.map((slot) => slot.alternate)).toEqual([false, true]);
    });

    /**
     * The trap `HOW-IT-WORKS.md` names, in the cluster it names it in: two classes on one
     * tile, the second placed only if the first was -- and the condition records the class,
     * not the model.
     */
    test('finds the two things standing on one tile', () => {
        expect(coLocated(clusterLayout(index, 'OfficeCubicleX1'))).toEqual([{
            tile: [0, 0],
            first: '1x1OfficeCubicle',
            second: '1x1FilingCabinetUnderDesk',
        }]);
    });

    test('is null for a cluster the index does not hold', () => {
        expect(clusterLayout(index, 'NotACluster')).toBeNull();
    });
});


describe('what the pane says out loud', () => {
    const warn = (fields) => warningsFor(describe1({ ...hotelDesk, ...fields })).join(' ');

    test('says when nothing will ever place it', () => {
        expect(warn({ classes: [] })).toContain('no cluster has a slot it can fill');
    });

    test('says when the minimum room size is the from-scratch default', () => {
        expect(warn({ minimumRoomSize: 99 })).toContain('at least 99 squares');
    });

    test('says when a clone brought the wrong filters or the wrong styles', () => {
        const notes = warn({ allowedRoomFilters: [], universalDesignStyle: false });

        expect(notes).toContain('no room filters');
        expect(notes).toContain('not universal to every design style');
    });

    /** A class that could not be read is not the same as a class that is not there. */
    test('says a class could not be read, and what would fix it', () => {
        const notes = warningsFor(describe1(hotelDesk, [])).join(' ');

        expect(notes).toContain('could not be read');
        expect(notes).toContain('exported ScriptableObjects folder');
    });

    test('counts the sub-objects whose position it cannot vouch for', () => {
        expect(warn({})).toContain('One of its sub-objects hangs off a named transform');

        // Two of them, to check the plural reads as a plural.
        expect(warn({ subObjects: [hotelDesk.subObjects[1], hotelDesk.subObjects[1]] }))
            .toContain('2 of its sub-objects hang off a named transform');
    });

    test('says nothing about a preset with nothing wrong with it', () => {
        expect(warningsFor(describe1({ ...hotelDesk, subObjects: [hotelDesk.subObjects[0]] })))
            .toEqual([]);
    });
});


describe('a sub-object slot', () => {
    /**
     * A zero chance is not never: the classes that state one carry trait rules that raise
     * it, so reporting "never fills" off the number alone would be wrong about exactly the
     * slots worth reporting.
     */
    test('does not read a zero chance as never when modifiers raise it', () => {
        expect(describeSlot({
            perInstanceSpawnChance: 0,
            perInstanceModifiers: [{}, {}, {}],
        })).toBe('0% before 3 trait rules that raise it');
    });

    test('says the cap where there is one', () => {
        expect(describeSlot({ limitCountPerObject: true, maxPerObject: 1 }))
            .toBe('at most 1 per object');
    });

    test('says nothing about a slot with nothing unusual about it', () => {
        expect(describeSlot({ perInstanceSpawnChance: 1 })).toBeNull();
    });

    test('is null for a class that could not be read', () => {
        expect(describeSlot(null)).toBeNull();
    });
});
