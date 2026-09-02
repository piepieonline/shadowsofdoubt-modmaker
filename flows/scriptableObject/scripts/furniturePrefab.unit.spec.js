/**
 * Reading a mod's own model: the prefab reference, the prefab file, and the `.obj`.
 *
 * The round trip is what most of this is. `meshExport.js` in the building flow writes
 * exactly this pair, and the bank example mod ships one, so a mesh written by this repo
 * and read back by this repo is a closed loop that can be checked without a browser --
 * and a mirror or a winding applied once instead of twice shows up in it immediately.
 */
import { describe, test, expect } from 'vitest';

import { prefabPathOf, meshesIn, controllersIn, parseObj } from './furniturePrefab.js';
import { modelExtent } from './furnitureModel.js';
import { placementFromAsset, tilesOf, overhangTiles } from './furnitureClass.js';
import { toObj, prefabDefinition } from '../../building/scripts/meshExport.js';


describe('a prefab reference', () => {
    test('splits into the folder and the file beside it', () => {
        expect(prefabPathOf('PREFAB:MyDeskPrefab/MyDesk')).toEqual({
            folder: 'MyDeskPrefab',
            name: 'MyDesk',
            file: 'MyDesk.sodprefab.json',
        });
    });

    /** A small mod puts the prefab beside its manifest rather than in a folder. */
    test('takes a reference with no folder as one beside the manifest', () => {
        expect(prefabPathOf('PREFAB:MyDesk')).toEqual({
            folder: null,
            name: 'MyDesk',
            file: 'MyDesk.sodprefab.json',
        });
    });

    /**
     * A shipped preset's prefab resolves to a `GameObject` name and nothing more. There is
     * no file to look for, which is the difference this returns rather than a path that
     * would fail to open.
     */
    test('is null for anything that is not a prefab path', () => {
        expect(prefabPathOf('HotelFrontDesk')).toBeNull();
        expect(prefabPathOf('TEXTURE:MyDeskPrefab/MyDesk')).toBeNull();
        expect(prefabPathOf(null)).toBeNull();
    });
});


describe('the meshes a prefab names', () => {
    test('finds the one this repo’s own writer puts in', () => {
        const prefab = JSON.parse(prefabDefinition('MyDesk', 'REF:BuildingPreset|CityBank'));

        expect(meshesIn(prefab)).toEqual([
            { mesh: 'MyDesk.obj', offset: expect.any(Array) },
        ]);
    });

    /**
     * Walked to the bottom rather than one level down. A mesh skipped for being too deep
     * is a model that appears with a piece missing and nothing saying why.
     */
    test('finds one nested further down, with the offsets accumulated', () => {
        const prefab = {
            name: 'Root',
            position: [1, 0, 0],
            children: [{
                name: 'Middle',
                position: [0, 2, 0],
                children: [{ name: 'Leaf', position: [0, 0, 3], components: [{ mesh: 'Leaf.obj' }] }],
            }],
        };

        expect(meshesIn(prefab)).toEqual([{ mesh: 'Leaf.obj', offset: [1, 2, 3] }]);
    });

    test('is empty for a prefab with no mesh in it at all', () => {
        expect(meshesIn({ name: 'Empty', children: [{ name: 'Child' }] })).toEqual([]);
    });
});


describe('the controllers a prefab declares', () => {
    /**
     * The game's own `BoardRoomTablePrefab`, transcribed from the dump.
     *
     * Two children: one holding the mesh and a collider, one holding a trigger collider and
     * the controller. Which is the shape worth pinning -- the controller is not on the node
     * with the model on it, and a reader that looked only where the mesh was would find
     * nothing.
     */
    const BOARD_ROOM_TABLE = {
        prefabType: 'prop',
        name: 'BoardRoomTable',
        children: [
            {
                name: 'BoardRoomTable_Mesh',
                components: [
                    { type: 'MeshRenderer', mesh: 'SODconferencetableFixed.obj' },
                    { type: 'BoxCollider', center: [0, 0.825, -1.8], size: [1.6, 0.05, 4.8] },
                ],
            },
            {
                name: 'HidingPlace',
                position: [0, 0.4, -1.8],
                components: [
                    { type: 'BoxCollider', size: [0.58, 0.72, 3.6], isTrigger: true },
                    { type: 'InteractableController', id: 'hidingPlace' },
                ],
            },
        ],
    };

    test('finds the one the game’s own reference prefab carries', () => {
        expect(controllersIn(BOARD_ROOM_TABLE)).toEqual([
            { id: 'hidingPlace', node: 'HidingPlace', offset: [0, 0.4, -1.8] },
        ]);
    });

    /** Walked to the bottom, and the offsets accumulate down -- as `meshesIn` does. */
    test('finds one nested further down, with the offsets accumulated', () => {
        const prefab = {
            name: 'Root',
            position: [1, 0, 0],
            children: [{
                name: 'Middle',
                position: [0, 2, 0],
                children: [{
                    name: 'Leaf',
                    position: [0, 0, 3],
                    components: [{ type: 'InteractableController', id: 'A' }],
                }],
            }],
        };

        expect(controllersIn(prefab)).toEqual([
            { id: 'A', node: 'Leaf', offset: [1, 2, 3] },
        ]);
    });

    /** Several on one node, in the order the file names them. */
    test('takes every controller on a node, in order', () => {
        const prefab = {
            name: 'Desk',
            children: [{
                name: 'Positions',
                position: [0, 1, 0],
                components: [
                    { type: 'InteractableController', id: 'A' },
                    { type: 'InteractableController', id: 'B' },
                ],
            }],
        };

        expect(controllersIn(prefab).map((one) => one.id)).toEqual(['A', 'B']);
    });

    /**
     * A controller with no id is one nothing can pair to, so it is not a choice. Left in the
     * list it would be an option that writes `none` -- an entry the game skips -- under a
     * name that looked like a real one.
     */
    test('leaves out a controller with no id on it', () => {
        const prefab = {
            name: 'Desk',
            components: [{ type: 'InteractableController' }, { type: 'BoxCollider' }],
        };

        expect(controllersIn(prefab)).toEqual([]);
    });

    test('is empty for a prefab that declares none', () => {
        expect(controllersIn(JSON.parse(prefabDefinition('MyDesk', 'REF:BuildingPreset|CityBank'))))
            .toEqual([]);
    });
});


describe('an .obj', () => {
    /** One triangle, in the shape `toObj` writes: full `v/vt/vn` corners. */
    const TRIANGLE = [
        'o Thing',
        'v 1 0 0', 'v 0 0 1', 'v 0 2 0',
        'vt 0 0', 'vt 1 0', 'vt 0 1',
        'vn 0 1 0', 'vn 0 1 0', 'vn 0 1 0',
        'f 1/1/1 2/2/2 3/3/3',
    ].join('\n');

    test('reads positions, normals, uvs and faces', () => {
        const mesh = parseObj(TRIANGLE);

        expect(mesh.positions).toHaveLength(9);
        expect(mesh.normals).toHaveLength(9);
        expect(mesh.uvs).toHaveLength(6);
        expect(mesh.indices).toHaveLength(3);
    });

    /**
     * No mirror, which is the opposite of what it looks like it should be.
     *
     * The game's world is left-handed and both an `.obj` and three.js are right-handed, so
     * the file and the scene are the *same* frame -- the game's is the odd one out, and the
     * loader is what negates x on the way into it (`modelSpace.md` §6). Mirroring here drew
     * a mod's model as its own reflection, sitting where its footprint is not.
     */
    test('reads positions and normals as written, applying no mirror', () => {
        const mesh = parseObj(['v 1 2 3', 'vn 1 0 0', 'f 1//1 1//1 1//1'].join('\n'));

        expect(mesh.positions.slice(0, 3)).toEqual([1, 2, 3]);
        expect(mesh.normals.slice(0, 3)).toEqual([1, 0, 0]);
    });

    /**
     * Winding is orientation and orientation only flips with a mirror. With none, reversing
     * this would point every face into the model -- which reads as a broken material rather
     * than as a winding problem, and is why it is pinned here rather than left to the eye.
     */
    test('winds each face the way the file names its corners', () => {
        const mesh = parseObj(['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3'].join('\n'));

        expect(mesh.indices).toEqual([0, 1, 2]);
    });

    /**
     * A mesh this repo writes, read back by this repo -- and it does **not** come back as it
     * went in. `toObj`'s meshes are built in the game's space, so its mirror is real work
     * rather than half of a pair, and reading gives the scene's coordinates: x negated,
     * wound the other way round. The two together are exactly the conversion a sub-object
     * position gets through `inSceneSpace`, which is what makes a model and the markers on
     * it agree about which way round they are.
     */
    test('reads a mesh from the building flow’s exporter into the scene’s coordinates', () => {
        const source = {
            vertices: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }, { x: 0, y: 3, z: 0 }],
            uvs: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 0, v: 1 }],
            normals: [{ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }],
            triangles: [0, 1, 2],
        };

        const mesh = parseObj(toObj(source, 'Thing'));

        // Corner by corner in draw order, which is what "the same triangle" means: the
        // vertex numbering need not survive -- a reader de-indexes in the order the file
        // names corners -- but the shape and the way round it is wound must.
        const corners = mesh.indices.map((index) => mesh.positions.slice(index * 3, index * 3 + 3));

        expect(corners).toEqual([[-1, 0, 0], [0, 3, 0], [0, 0, 2]]);
    });

    test('accepts the corner spellings an .obj may use', () => {
        const bare = parseObj(['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3'].join('\n'));
        const withUv = parseObj(['v 0 0 0', 'v 1 0 0', 'v 0 1 0',
            'vt 0 0', 'vt 1 0', 'vt 0 1', 'f 1/1 2/2 3/3'].join('\n'));
        const withNormal = parseObj(['v 0 0 0', 'v 1 0 0', 'v 0 1 0',
            'vn 0 1 0', 'f 1//1 2//1 3//1'].join('\n'));

        for (const mesh of [bare, withUv, withNormal]) expect(mesh.indices).toHaveLength(3);

        // No normals stated is no normal array, rather than a short one: three.js reads it
        // positionally, so a partial array lights the mesh from whatever lines up.
        expect(bare.normals).toBeNull();
        expect(bare.uvs).toBeNull();
        expect(withUv.uvs).toHaveLength(6);
    });

    test('counts a negative index back from the end, as the format says', () => {
        const mesh = parseObj(['v 5 5 5', 'v 1 0 0', 'v 0 1 0', 'f -3 -2 -1'].join('\n'));

        expect(mesh.positions.slice(0, 3)).toEqual([5, 5, 5]);
        expect(mesh.indices).toHaveLength(3);
    });

    test('fans a face with more than three corners', () => {
        const mesh = parseObj([
            'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'f 1 2 3 4',
        ].join('\n'));

        expect(mesh.indices).toHaveLength(6);
    });

    /** One vertex per distinct corner, however many faces name it. */
    test('shares a corner two faces state identically', () => {
        const mesh = parseObj([
            'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0',
            'f 1 2 3', 'f 1 3 4',
        ].join('\n'));

        expect(mesh.positions).toHaveLength(12);
        expect(mesh.indices).toHaveLength(6);
    });

    test('reads past what it does not draw', () => {
        const mesh = parseObj([
            '# a comment', 'mtllib thing.mtl', 'o Thing', 'g Part', 'usemtl Steel', 's off',
            'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3',
        ].join('\n'));

        expect(mesh.indices).toHaveLength(3);
    });

    /** A file with no faces is not a model of nothing; it is not an `.obj`. */
    test('is null for text with no faces in it', () => {
        expect(parseObj('v 0 0 0\nv 1 0 0')).toBeNull();
        expect(parseObj('')).toBeNull();
        expect(parseObj('<!doctype html>')).toBeNull();
    });
});


/**
 * The one check that spans both halves of the pane, and the one nothing had.
 *
 * Reading and measuring were each self-consistent while disagreeing with each other, so a
 * correctly authored model was drawn as its own reflection and reported as overhanging by
 * its whole width -- with every test in either file passing. This is the join: an `.obj`
 * authored to `modelSpace.md` §6 has to measure back onto the nodes its class declares.
 */
describe('a model authored to the spec, measured against its own footprint', () => {
    /**
     * A 3x1 desk built to fill its footprint exactly, in the right-handed space an author
     * exports: x from -0.9 to +(3 - 0.5) x 1.8, z from -0.9 to +0.9, flush to the floor.
     */
    const DESK_3X1 = [
        'o Desk',
        'v -0.9 0 -0.9', 'v 4.5 0 -0.9', 'v 4.5 0 0.9', 'v -0.9 0 0.9',
        'f 1 2 3 4',
    ].join('\n');

    test('lands on nodes 0, -1 and -2 — the whole of a 3x1 class and no more', () => {
        const extent = modelExtent({ meshes: [{ offset: [0, 0, 0], geometry: parseObj(DESK_3X1) }] });

        expect(extent).toMatchObject({ minX: -2, maxX: 0, minY: 0, maxY: 0 });
    });

    /** And so the diagram shades it and reports nothing sticking out. */
    test('overhangs nothing, and covers every tile the class does', () => {
        const extent = modelExtent({ meshes: [{ offset: [0, 0, 0], geometry: parseObj(DESK_3X1) }] });
        const placement = placementFromAsset('Desk', { objectSize: { x: 3, y: 1 } });

        expect(overhangTiles(placement, extent)).toEqual([]);

        const covered = tilesOf(placement, extent).filter((tile) => tile.covered);
        expect(covered.every((tile) => tile.inModel)).toBe(true);
        expect(covered).toHaveLength(3);
    });
});
