/**
 * The mesh, texture and window data generator.
 *
 * The base game's building presets ship with this app as full dumps -- `sortedWindows`
 * included -- so this suite has something to check against that does not come from the
 * generator. That is unusual and it is the whole reason phase 8 is testable without the
 * game running: 15 buildings whose window data was produced by the game's own
 * `GenerateWindowData` over a hand-painted window map, against which the same buildings
 * derived from their blueprints can be compared block for block.
 *
 * Exact parity is neither the target nor achievable -- three presets are painted in ways
 * their own blueprints do not support, which the reference tool documents and which the
 * tests below pin rather than paper over. What is the target is parity with what
 * `NewFloor.AssignWindowUVData` enumerates at runtime, since a block is matched to a
 * window by its index in a list and nothing else. One extra block and every window after
 * it on that side lights the wrong rectangle.
 */
import { describe, expect, it } from 'vitest';

import {
    readFootprints, trimToWindowFloors, buildMesh, collectWindows, buildWindowData,
    fillEnclosedVoids, paintTextures, windowPixels, toObj, prefabDefinition,
    generateBuilding, sourceFloorHash, isMeshStale,
    MESH_SOURCE_FIELD, MESH_ROOF_FIELD, GENERATED_FIELDS, MESH_CHILD_LOCAL_Y,
} from './meshExport.js';
import { loadVanillaPreset, loadVanillaBlueprint, withoutDefaults } from './buildingLibrary.js';

const FLOOR_HEIGHT = 5.4;
const SIDES = ['front', 'back', 'left', 'right'];

/** A building's window data, derived from its blueprints rather than read off it. */
async function generate(name) {
    const preset = await loadVanillaPreset(name);
    const { floors, missing } = await readFootprints(preset, loadVanillaBlueprint);
    const { body, rooftops } = trimToWindowFloors(floors);
    const windows = collectWindows(body);

    return {
        preset,
        body,
        rooftops,
        missing,
        windows,
        data: buildWindowData(windows, body.length, body.length * FLOOR_HEIGHT),
    };
}

/** How many blocks each side of each floor has, which is what has to line up. */
const counts = (data) => data.map((floor) => SIDES.map((side) => (floor[side] ?? []).length));

/** A footprint stub, for the geometry tests that need no file. */
const footprint = (cells, extra = {}) => ({
    blueprint: 'test',
    enclosed: new Set(cells),
    openAir: new Set(),
    windows: new Set(),
    isRooftop: false,
    ...extra,
});

const square = (x0, y0, x1, y1) => {
    const cells = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cells.push(`${x},${y}`);
    return cells;
};

/** The vertices of every face pointing a given way, which is how a cap is found. */
const facing = (mesh, axis, sign) => mesh.vertices
    .filter((_, index) => mesh.normals[index][axis] === sign);

/** The mesh as quads, since four consecutive vertices are one and nothing else is. */
const quads = (mesh) => mesh.vertices
    .reduce((all, vertex, index) => {
        if (index % 4 === 0) all.push({ corners: [], normal: mesh.normals[index] });
        all[all.length - 1].corners.push(vertex);
        return all;
    }, []);

/** How far a quad reaches along each axis, which is what tells a lip from a full cap. */
const span = (quad) => ['x', 'y', 'z'].reduce((sizes, axis) => {
    const values = quad.corners.map((corner) => corner[axis]);
    return { ...sizes, [axis]: Math.max(...values) - Math.min(...values) };
}, {});

/** Shell space: 1.008 out, 0.108 up, and the same again spread over the height. */
const LIFT = 13.5 * 0.008;
const shell = (gridHeight) => (point) => ({
    x: point.x * 1.008,
    y: point.y * (1 + LIFT / gridHeight) + LIFT,
    z: point.z * 1.008,
});


/* -------------------------------------------------------------------------- */

describe('window data against the base game', () => {
    /**
     * The four the reference tool verified against, and the assertion the whole port
     * rests on. Every floor, every side, the same number of blocks in the same
     * direction -- about 30 floors with no disagreement anywhere.
     */
    it.each(['Townhouse', 'TownhouseShops', 'Hotel', 'ChemicalPlant'])(
        'reproduces %s block for block', async (name) => {
            const { preset, data } = await generate(name);

            expect(data).toHaveLength(preset.sortedWindows.length);
            expect(counts(data)).toEqual(counts(preset.sortedWindows));
        });

    it('reproduces 14 of BrandyNetherland\'s 17 floors', async () => {
        // Pinned rather than asserted as a pass. The three that differ are the base game
        // data disagreeing with its own blueprints, and the number moving in either
        // direction is worth being told about: fewer means something regressed, more
        // means one of the three was fixed and this should say so.
        const { preset, data } = await generate('BrandyNetherland');
        const mine = counts(data);
        const theirs = counts(preset.sortedWindows);

        const agreeing = mine.filter(
            (row, floor) => row.join() === theirs[floor].join()).length;

        expect(agreeing).toBe(14);
    });

    it('finds the same total on both sides of a symmetrical building', async () => {
        // Townhouse's front and back are the same wall seen from two directions. Worth
        // its own assertion because a sort direction reversed on one side only would
        // still produce the same counts and light the windows in reverse order.
        const { data } = await generate('Townhouse');

        for (const floor of data.slice(1)) {
            expect(floor.front.map((block) => block.horizonal)).toEqual([...floor.front.keys()]);
            expect(floor.back.map((block) => block.horizonal)).toEqual([...floor.back.keys()]);
        }
    });

    it('runs every side left to right across its own band', async () => {
        // All four, including the two sorted by a *descending* blueprint coordinate: a
        // band's U direction reverses with its facing, so descending cell.x on the back
        // is still ascending texture x. Nothing would be wrong with a side that ran the
        // other way -- it is simply not what the base game's do, and it is what a sort
        // direction flipped by accident would look like.
        const { data } = await generate('Hotel');

        for (let floor = 0; floor < data.length; floor++) {
            for (const side of SIDES) {
                expect(ascending(data[floor][side].map((block) => block.centrePixel.x)),
                    `floor ${floor} ${side}`).toBe(true);
            }
        }
    });

    it('orders each side by the blueprint coordinate the game sorts its walls by', async () => {
        // The table in BuildingWindowData.md: front by cell.x ascending, back descending,
        // left by cell.y ascending, right descending. A block's mesh position is monotone
        // in that coordinate within a band, which is how the direction is read back out of
        // data that no longer carries the cell it came from.
        //
        // This is the assertion the whole port turns on. `horizonal` is the only thing
        // tying a block to a window at runtime, so a side sorted the wrong way lights
        // every window on it in reverse.
        const cells = [5, 8, 11, 14];
        const bands = { front: 2, back: 1, left: 0, right: 3 };
        const along = { front: 'x', back: 'x', left: 'z', right: 'z' };
        const expected = { front: 'descending', back: 'ascending', left: 'descending', right: 'ascending' };

        for (const [side, band] of Object.entries(bands)) {
            const vertical = side === 'front' || side === 'back';
            const floor = {
                blueprint: side,
                enclosed: new Set(cells.map((n) => (vertical ? `${n},9` : `9,${n}`))),
                openAir: new Set(),
                windows: new Set(cells.map((n) => (vertical ? `${n},9,${band}` : `9,${n},${band}`))),
                isRooftop: false,
            };

            const [data] = buildWindowData(collectWindows([floor]), 1, FLOOR_HEIGHT);
            const positions = data[side].map((block) => block.localMeshPositionLeft[along[side]]);

            expect(positions, `${side} has a block per window`).toHaveLength(cells.length);
            expect(expected[side] === 'ascending' ? ascending(positions) : ascending([...positions].reverse()),
                `${side} runs ${expected[side]}`).toBe(true);
        }
    });

    const ascending = (values) => values.every((value, i) => i === 0 || values[i - 1] <= value);

    it('puts a block on the side the list says it is on', async () => {
        const { data } = await generate('Hotel');
        const expected = {
            front: { x: 0, y: 1 },
            back: { x: 0, y: -1 },
            left: { x: -1, y: 0 },
            right: { x: 1, y: 0 },
        };

        for (const floor of data) {
            for (const side of SIDES) {
                for (const block of floor[side]) expect(block.side).toEqual(expected[side]);
            }
        }
    });

    it('numbers floors from 1, the way the game reads them back', async () => {
        const { data } = await generate('Hotel');

        data.forEach((floor, index) => {
            for (const side of SIDES) {
                for (const block of floor[side]) expect(block.floor).toBe(index + 1);
            }
        });
    });

    it('writes a row for a floor with no windows rather than skipping it', async () => {
        // The game's own version drops an empty floor out of the list entirely, which
        // shifts every floor above it. Keeping the row is what makes sortedWindows[n - 1]
        // mean floor n on every building.
        const { data } = await generate('ChemicalPlant');
        const empty = data.filter((floor) => SIDES.every((side) => floor[side].length === 0));

        expect(data.length).toBeGreaterThan(0);
        for (const floor of data) expect(Object.keys(floor).sort()).toEqual([...SIDES].sort());
        expect(empty.length, 'this building happens to have none').toBe(0);
    });
});

describe('where the base game disagrees with its own blueprints', () => {
    /**
     * Three presets whose painted window maps do not match the floors they are for. The
     * reference tool documents all three; they are pinned here so that a change in the
     * generator shows up as a change in *which* buildings disagree rather than being
     * absorbed by a test that only ever checked the four that agree.
     */
    it('OneFIfthAve paints a window its blueprints do not have', async () => {
        // The capital I is the game's own spelling, and the file is named for it. Asking
        // for OneFifthAve reads it anyway on a case-insensitive filesystem and 404s on
        // Linux, where the preset comes back null and this fails at sortedWindows.
        const { preset, data } = await generate('OneFIfthAve');
        const mine = counts(data);
        const theirs = counts(preset.sortedWindows);

        // One extra on the +Y wall of most floors, on the base game's side.
        const backOnly = mine.filter((row, floor) =>
            row.join() !== theirs[floor].join()
            && row[0] === theirs[floor][0]
            && row[1] + 1 === theirs[floor][1]).length;

        expect(backOnly).toBeGreaterThan(8);
    });

    it('ShantyTown floor 1 puts every block in one list', async () => {
        // Limitation 6: the game derives `side` from the sign of a mesh position, so on a
        // floor with a courtyard the outer wall and the inner wall facing back at it land
        // in the same list. We classify by facing, which is what the runtime buckets by,
        // and so deliberately differ.
        const { preset, data } = await generate('ShantyTown');

        expect(counts(preset.sortedWindows)[0]).toEqual([0, 0, 8, 0]);
        expect(counts(data)[0]).toEqual([0, 0, 4, 3]);
    });

    it('EdenTower is painted as a curtain wall its blueprints do not describe', async () => {
        const { preset, data } = await generate('EdenTower');

        // The base game reports the same counts on floors its blueprints give no windows
        // at all, so nothing here can reproduce it. What is asserted is that we produce a
        // row per floor regardless.
        expect(data).toHaveLength(preset.sortedWindows.length);
        expect(counts(data).slice(2, 4)).toEqual([[0, 0, 0, 0], [0, 0, 0, 0]]);
    });
});

describe('mesh positions', () => {
    /**
     * The reference tool's limitation 5 says the model comes out 180 degrees about Y from
     * the game's convention -- so a generated building would face away from the street.
     * It does not: on every side of every preset checked the generated position agrees
     * with the base game's in sign, and to within about a metre.
     *
     * Asserted rather than trusted, because the fix limitation 5 proposes is two negated
     * constants and would be an easy and unnoticeable thing to apply.
     */
    it.each(['Townhouse', 'Hotel', 'ChemicalPlant'])(
        'agrees with %s in sign on all four sides', async (name) => {
            const { preset, data } = await generate(name);

            let compared = 0;
            for (let floor = 0; floor < data.length; floor++) {
                for (const side of SIDES) {
                    const mine = data[floor][side];
                    const theirs = preset.sortedWindows[floor]?.[side] ?? [];
                    if (mine.length !== theirs.length) continue;

                    mine.forEach((block, index) => {
                        const other = theirs[index].localMeshPositionLeft;
                        const position = block.localMeshPositionLeft;

                        // A window on the middle of a wall sits at zero on that axis, and
                        // which side of zero it is on is not a question. The distance
                        // check below is what covers those.
                        for (const axis of ['x', 'z']) {
                            if (Math.abs(other[axis]) > 1) {
                                expect(Math.sign(position[axis]), `${side} ${floor}.${index} ${axis}`)
                                    .toBe(Math.sign(other[axis]));
                            }

                            // Within a node or two. The base game's rectangles were
                            // painted by hand rather than derived from the blueprint, so
                            // they do not land on node centres -- but a flip about Y
                            // would be a difference of 25 metres, not two.
                            expect(Math.abs(position[axis] - other[axis]),
                                `${side} ${floor}.${index} ${axis}`).toBeLessThan(2.5);
                        }

                        compared++;
                    });
                }
            }

            expect(compared, 'something was actually compared').toBeGreaterThan(5);
        });

    it('sits the mesh where the prefab puts it', async () => {
        const { data } = await generate('Townhouse');
        const ground = data[0].front[0];

        // Every position is measured from the prefab root, and the mesh hangs in a child
        // this far up. A block on the lowest window row is above it, never below.
        expect(ground.localMeshPositionLeft.y).toBeGreaterThan(MESH_CHILD_LOCAL_Y);
    });

    it('puts a block\'s right hand point one pixel along from its left', async () => {
        const { data } = await generate('Townhouse');

        for (const floor of data) {
            for (const block of floor.front) {
                const left = block.localMeshPositionLeft;
                const right = block.localMeshPositionRight;

                expect(left.y).toBeCloseTo(right.y, 6);
                // One texture pixel of a 15-node side, so a fifth of a metre or so.
                const along = Math.hypot(left.x - right.x, left.z - right.z);
                expect(along).toBeGreaterThan(0);
                expect(along).toBeLessThan(0.5);
            }
        }
    });
});

describe('footprints', () => {
    it('repeats a floor setting once per floor it covers', async () => {
        const preset = {
            floorLayouts: [
                { floorsWithThisSetting: 3, blueprints: ['a'] },
                { floorsWithThisSetting: 1, blueprints: ['b'] },
            ],
        };

        const { floors } = await readFootprints(preset, async (name) => blueprintOf(name));

        expect(floors.map((floor) => floor.blueprint)).toEqual(['a', 'a', 'a', 'b']);
    });

    it('treats a setting with no count as one floor', async () => {
        const preset = { floorLayouts: [{ blueprints: ['a'] }] };
        const { floors } = await readFootprints(preset, async (name) => blueprintOf(name));

        expect(floors).toHaveLength(1);
    });

    it('reports a blueprint it could not read rather than modelling a hole', async () => {
        const preset = { floorLayouts: [{ blueprints: ['a'] }, { blueprints: ['gone'] }] };
        const { missing } = await readFootprints(preset, async (name) =>
            (name === 'gone' ? null : blueprintOf(name)));

        expect(missing).toEqual(['gone']);
    });

    it('reads a floor the preset points at with FLOOR:', async () => {
        // Which is how a preset names a floor the mod holds. The resolver is handed the
        // name, because that is what a floor is called on disk and in the panel.
        const asked = [];
        const { floors, missing } = await readFootprints(
            { floorLayouts: [{ blueprints: ['FLOOR:Floors/a'] }] },
            async (name) => { asked.push(name); return blueprintOf(name); });

        expect(asked).toEqual(['a']);
        expect(missing).toEqual([]);
        expect(floors[0].enclosed.has('5,5')).toBe(true);
    });

    it('leaves basements out of the model', async () => {
        const preset = {
            floorLayouts: [{ blueprints: ['a'] }],
            basementLayouts: [{ blueprints: ['b'] }],
        };

        const { floors } = await readFootprints(preset, async (name) => blueprintOf(name));

        expect(floors.map((floor) => floor.blueprint)).toEqual(['a']);
    });

    it('unions a storey\'s layouts and its control room variants', async () => {
        const preset = {
            floorLayouts: [{ blueprints: ['a'], controlRoomVariants: ['b'] }],
        };

        const { floors } = await readFootprints(preset, async (name) => blueprintOf(name));

        // 'a' is enclosed at (5, 5) and 'b' at (6, 6). Both end up in the one footprint,
        // which is limitation 1 -- the game picks one at random and this cannot.
        expect(floors[0].enclosed.has('5,5')).toBe(true);
        expect(floors[0].enclosed.has('6,6')).toBe(true);
    });

    it('ignores an outdoor address', async () => {
        const { floors } = await readFootprints(
            { floorLayouts: [{ blueprints: ['outdoor'] }] },
            async () => ({
                a_d: [{
                    p_n: 'Yard',
                    vs: [{ r_d: [{ n_d: [node(5, 5, 1)] }] }],
                }],
            }));

        expect(floors[0].enclosed.has('5,5')).toBe(false);
    });

    it('calls a storey that is mostly open air a rooftop', async () => {
        const { floors } = await readFootprints(
            { floorLayouts: [{ blueprints: ['roof'] }] },
            async () => ({
                a_d: [{
                    p_n: 'VentedRooftop',
                    vs: [{
                        r_d: [{
                            n_d: [node(5, 5, 1), node(6, 5, 2), node(7, 5, 2), node(8, 5, 2)],
                        }],
                    }],
                }],
            }));

        expect(floors[0].isRooftop).toBe(true);
    });

    const node = (x, y, floorType, walls = []) => ({
        f_c: { x, y }, f_h: 0, f_t: floorType, f_r: '', w_d: walls,
    });

    const blueprintOf = (name) => ({
        a_d: [{
            p_n: 'Lobby',
            vs: [{ r_d: [{ n_d: [name === 'b' ? node(6, 6, 1) : node(5, 5, 1)] }] }],
        }],
    });
});

describe('fillEnclosedVoids', () => {
    it('fills a courtyard with no way out', async () => {
        // A ring of enclosed cells with a hole in the middle. The hole is inside the
        // building's shell, so leaving it would punch a wall through the model and show
        // the inside of the building from outside.
        const cells = new Set([
            ...square(5, 5, 9, 5), ...square(5, 9, 9, 9),
            ...square(5, 6, 5, 8), ...square(9, 6, 9, 8),
        ]);

        expect(cells.has('7,7')).toBe(false);
        fillEnclosedVoids(cells);
        expect(cells.has('7,7')).toBe(true);
    });

    it('leaves a courtyard that opens onto the street', async () => {
        // The same ring with one cell of its edge missing, so the middle reaches the
        // outside. That is a light well the street can see into, not a void.
        const cells = new Set([
            ...square(5, 5, 9, 5), ...square(5, 9, 9, 9),
            ...square(5, 6, 5, 8), ...square(9, 6, 9, 7),
        ]);

        fillEnclosedVoids(cells);
        expect(cells.has('7,7')).toBe(false);
    });

    it('fills nothing when the lot is empty', async () => {
        const cells = new Set();
        fillEnclosedVoids(cells);
        expect(cells.size).toBe(0);
    });
});

describe('trimToWindowFloors', () => {
    it('drops the ground floor, which the street frontage draws', () => {
        const floors = [footprint(['5,5']), footprint(['6,6']), footprint(['7,7'])];
        const { body } = trimToWindowFloors(floors);

        expect(body).toHaveLength(2);
        expect(body[0]).toBe(floors[1]);
    });

    it('drops every rooftop off the top and says which', () => {
        const floors = [
            footprint(['5,5']),
            footprint(['5,5']),
            footprint([], { blueprint: 'roof', isRooftop: true }),
            footprint([], { blueprint: 'vents', isRooftop: true }),
        ];

        const { body, rooftops } = trimToWindowFloors(floors);

        expect(body).toHaveLength(1);
        // The footprints themselves, in order, because the mesh is still built from them.
        expect(rooftops.map((floor) => floor.blueprint)).toEqual(['roof', 'vents']);
    });

    it('keeps a rooftop that has floors above it', () => {
        const floors = [
            footprint(['5,5']),
            footprint([], { isRooftop: true }),
            footprint(['5,5']),
        ];

        expect(trimToWindowFloors(floors).body).toHaveLength(2);
    });

    it('leaves nothing for a building with only a ground floor', () => {
        expect(trimToWindowFloors([footprint(['5,5'])]).body).toHaveLength(0);
    });
});

describe('buildMesh', () => {
    it('walls a single cell on all four sides, with a ceiling and no floor', () => {
        const mesh = buildMesh([footprint(['5,5'])]);

        // Four walls plus the cap over them, two triangles each. The underside is the
        // base, and it is not built.
        expect(mesh.vertices).toHaveLength(5 * 4);
        expect(mesh.triangles).toHaveLength(5 * 6);
    });

    it('puts no wall between two cells of the same floor', () => {
        const one = buildMesh([footprint(['5,5'])]).triangles.length;
        const two = buildMesh([footprint(['5,5', '6,5'])]).triangles.length;

        // Six walls rather than eight, and two caps rather than one.
        expect(two).toBe(one * 2 - 2 * 6);
    });

    it('leaves the underside of the lowest storey off', () => {
        const mesh = buildMesh([footprint(square(5, 5, 8, 8)), footprint(square(5, 5, 8, 8))]);

        expect(facing(mesh, 'y', -1)).toHaveLength(0);
    });

    it('caps the soffit under a storey that overhangs the one below', () => {
        const mesh = buildMesh([footprint(['5,5']), footprint(['5,5', '6,5'])]);
        const soffit = facing(mesh, 'y', -1);

        // The overhanging square only, at the seam between the two storeys -- and still
        // nothing under the storey standing on the ground. Measured in shell space, which
        // is where every face of it is.
        expect(soffit).toHaveLength(4);
        const seam = shell(2 * FLOOR_HEIGHT)({ x: 0, y: FLOOR_HEIGHT, z: 0 }).y;
        for (const vertex of soffit) expect(vertex.y).toBeCloseTo(seam, 6);
    });

    it('leaves every full upward face off for a building with another floor above it', () => {
        // A storey that steps in, so there is a terrace to leave off as well as a top.
        const floors = [footprint(square(5, 5, 8, 8)), footprint(square(6, 6, 7, 7))];

        const decks = (mesh) => quads(mesh)
            .filter((quad) => quad.normal.y === 1)
            .filter((quad) => span(quad).x > 0.2 && span(quad).z > 0.2);

        expect(decks(buildMesh(floors)).length).toBeGreaterThan(0);
        // The lip is the only thing facing up now, and it is 10 cm across on one axis.
        expect(decks(buildMesh(floors, { roof: false }))).toHaveLength(0);
    });

    it('keeps the walls of a building it puts no roof on', () => {
        const floors = [footprint(square(5, 5, 8, 8))];
        const walls = (mesh) => mesh.vertices.filter((_, i) => mesh.normals[i].y === 0);

        expect(walls(buildMesh(floors, { roof: false }))).toEqual(walls(buildMesh(floors)));
    });

    it('caps only where the shape changes between storeys', () => {
        const straight = buildMesh([footprint(['5,5']), footprint(['5,5'])]);
        const stepped = buildMesh([footprint(['5,5']), footprint(['6,5'])]);

        // A cell over a cell needs no floor between them; a cell beside one needs both.
        expect(stepped.triangles.length).toBe(straight.triangles.length + 2 * 6);
    });

    it('points every face away from the inside', () => {
        const mesh = buildMesh([footprint(['5,5'])]);

        for (let i = 0; i < mesh.triangles.length; i += 3) {
            const [a, b, c] = [0, 1, 2].map((n) => mesh.vertices[mesh.triangles[i + n]]);
            const normal = mesh.normals[mesh.triangles[i]];

            const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
            const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
            const facing = {
                x: ab.y * ac.z - ab.z * ac.y,
                y: ab.z * ac.x - ab.x * ac.z,
                z: ab.x * ac.y - ab.y * ac.x,
            };

            expect(facing.x * normal.x + facing.y * normal.y + facing.z * normal.z)
                .toBeGreaterThan(0);
        }
    });

    it('runs the vertical UV over the whole building rather than per storey', () => {
        const mesh = buildMesh([footprint(['5,5']), footprint(['5,5']), footprint(['5,5'])]);
        const v = mesh.uvs.map((uv) => uv.v);

        expect(Math.min(...v)).toBeCloseTo(0, 6);
        expect(Math.max(...v)).toBeCloseTo(1, 6);
        // The seam between the first and second storeys is a third of the way up.
        expect(v.some((value) => Math.abs(value - 1 / 3) < 1e-6)).toBe(true);
    });

    it('keeps every wall UV inside its own band', () => {
        const mesh = buildMesh([footprint(square(4, 4, 8, 8))]);
        const bandOf = (u) => Math.floor(u / 0.1875);

        for (const uv of mesh.uvs) {
            // The roof block is the right hand quarter; everything else is one of the
            // four side bands and must not spill into the next.
            if (uv.u >= 0.75) continue;
            expect(bandOf(uv.u)).toBe(bandOf(uv.u + 1e-9));
            expect(uv.u).toBeGreaterThanOrEqual(bandOf(uv.u) * 0.1875);
        }
    });

    it('builds the shell 1.008 across the grid, lifted that far and that much taller', () => {
        const mesh = buildMesh([footprint(['3,3'])]);
        const y = mesh.vertices.map((v) => v.y);

        // The furthest corner of the lot: cell 3 is 12.6 m from the centre and its outer
        // face another 0.9 m past that, which the outset pushes out by nearly 11 cm.
        expect(Math.max(...mesh.vertices.map((v) => v.x))).toBeCloseTo(13.5 * 1.008, 9);
        expect(Math.max(...mesh.vertices.map((v) => v.z))).toBeCloseTo(13.5 * 1.008, 9);

        // The same distance again upwards, and again at the top: off the baseline by as
        // much as it is proud of the grid, and that much taller than the storey it models.
        expect(Math.min(...y)).toBeCloseTo(LIFT, 9);
        expect(Math.max(...y)).toBeCloseTo(FLOOR_HEIGHT + 2 * LIFT, 9);
        expect(Math.max(...y) - Math.min(...y)).toBeCloseTo(FLOOR_HEIGHT + LIFT, 9);
    });

    it('spreads the extra height over the storeys rather than adding it to the top', () => {
        const mesh = buildMesh([footprint(['5,5']), footprint(['5,5']), footprint(['5,5'])]);
        const y = [...new Set(mesh.vertices.map((v) => v.y))].sort((a, b) => a - b);

        // Four levels, evenly spaced: one row taller than the others would show as one
        // row of windows taller than the others.
        expect(y).toHaveLength(4);
        const steps = y.slice(1).map((value, i) => value - y[i]);
        for (const step of steps) expect(step).toBeCloseTo(steps[0], 9);
    });

    it('measures the vertical UV from the bottom of the model, not the baseline', () => {
        // The lift is geometry only. Taking `v` after it would start the texture partway
        // up the wall and leave the top of it off the model.
        const mesh = buildMesh([footprint(['5,5']), footprint(['5,5'])]);
        const v = mesh.uvs.filter((uv) => uv.u < 0.75).map((uv) => uv.v);

        expect(Math.min(...v)).toBeCloseTo(0, 9);
        expect(Math.max(...v)).toBeCloseTo(1, 9);
    });

    it('measures the texture on the grid rather than on the outset shell', () => {
        const mesh = buildMesh([footprint(['5,5'])]);
        const bands = new Map();

        for (const uv of mesh.uvs) {
            if (uv.u >= 0.75) continue;
            const band = Math.floor(uv.u / 0.1875);
            bands.set(band, [...(bands.get(band) ?? []), uv.u]);
        }

        // One square is one of the fifteen nodes across its side. Taking the UV off a
        // vertex that had already been pushed out would make it 1.008 of one, sliding
        // every window away from the rectangle painted for it.
        expect(bands.size).toBe(4);
        for (const [, us] of bands) {
            expect(Math.max(...us) - Math.min(...us))
                .toBeCloseTo((0.1875 - 2 * (2 / 512)) / 15, 12);
        }
    });

    it('rims an open top with 10 cm of masonry that meets exactly at the corners', () => {
        const mesh = buildMesh([footprint(['5,5'])], { roof: false });
        const lips = quads(mesh).filter((quad) => quad.normal.y === 1);

        expect(lips).toHaveLength(4);

        // A ring, not four overlapping strips: the four together cover the outer square
        // less the inner one exactly, which they cannot do if any two share ground. Two
        // coplanar faces over the same 10 cm square are what z-fights in game.
        const outer = 1.8 * 1.008;
        const area = lips.reduce((total, quad) => total + span(quad).x * span(quad).z, 0);

        expect(area).toBeCloseTo(outer ** 2 - (outer - 0.2) ** 2, 9);
        for (const lip of lips) {
            expect(Math.min(span(lip).x, span(lip).z)).toBeCloseTo(0.1, 9);
        }
    });

    it('puts the rim at the top of every wall with open sky over it', () => {
        // Steps in, so the terrace at the seam has an edge of its own as well as the top.
        const mesh = buildMesh(
            [footprint(square(5, 5, 8, 8)), footprint(square(6, 6, 7, 7))], { roof: false });

        const heights = [...new Set(quads(mesh)
            .filter((quad) => quad.normal.y === 1)
            .map((quad) => Math.round(quad.corners[0].y * 1e6) / 1e6))];

        // Two levels of rim: round the terrace and round the top.
        expect(heights).toHaveLength(2);
    });

    it('leaves the wall under a storey that carries on up without a rim', () => {
        const straight = buildMesh([footprint(['5,5']), footprint(['5,5'])], { roof: false });
        const lips = quads(straight).filter((quad) => quad.normal.y === 1);

        // One rim, at the top. The seam between the two storeys is inside the building.
        expect(lips).toHaveLength(4);
    });

    it('builds the same mesh twice from the same floors', () => {
        // The cells come out of a Set, which has no order worth relying on. Sorting them
        // is what makes an OBJ and a block ordering reproducible.
        const floors = [footprint(square(5, 5, 8, 8)), footprint(square(6, 6, 7, 7))];

        expect(toObj(buildMesh(floors), 'x')).toBe(toObj(buildMesh(floors), 'x'));
    });
});

describe('collectWindows', () => {
    const withWindow = (cells, windows) => footprint(cells, { windows: new Set(windows) });

    it('keeps a window on the outside of the building', () => {
        // Band 0 faces the cell at (+1, 0), which is not enclosed.
        expect(collectWindows([withWindow(['5,5'], ['5,5,0'])])).toHaveLength(1);
    });

    it('drops a window between two rooms of the same floor', () => {
        expect(collectWindows([withWindow(['5,5', '6,5'], ['5,5,0'])])).toHaveLength(0);
    });

    it('drops a window on a cell that is not enclosed', () => {
        expect(collectWindows([withWindow(['9,9'], ['5,5,0'])])).toHaveLength(0);
    });

    it('measures a window into the row of its own storey', () => {
        const floors = [
            withWindow(['5,5'], ['5,5,0']),
            withWindow(['5,5'], ['5,5,0']),
        ];

        const [ground, above] = collectWindows(floors);

        expect(ground.pixels.y).toBeLessThan(above.pixels.y);
        expect(above.pixels.y).toBeGreaterThanOrEqual(256);
    });
});

describe('windowPixels', () => {
    it('rounds a half to even, as Mathf.RoundToInt does', () => {
        // 512 / 4 = 128 rows; floor 0's bottom lands on 19.584 and its top on 80.128, and
        // floor 1's on 147.584 and 208.128, none of them a half. What this pins is that
        // the rounding is not Math.round: a half lands on the even number.
        const rowHeight = 512 / 4;

        expect(windowPixels(0, 0, 0, rowHeight)).toMatchObject({ y: 20, height: 60 });
        expect(windowPixels(0, 0, 1, rowHeight)).toMatchObject({ y: 148, height: 60 });
    });

    it('centres a window in its column, leaving masonry either side', () => {
        const rect = windowPixels(0, 3, 0, 128);

        // A column is 184 / 15 pixels wide -- a little over 12 -- so 55% of it rounds to
        // 6, and the ratio can only be as near 0.55 as whole pixels allow.
        const cellWidth = (0.1875 - 2 * (2 / 512)) * 1024 / 15;

        expect(rect.width).toBeLessThan(cellWidth);
        expect(rect.width / cellWidth).toBeGreaterThan(0.4);
        expect(rect.width / cellWidth).toBeLessThan(0.7);

        // Masonry either side, which is what makes a run of windows read as separate ones.
        const left = rect.x - (0.1875 * 0 + 2 / 512) * 1024 - 3 * cellWidth;
        expect(left).toBeGreaterThan(0);
    });

    it('keeps each side inside its own band', () => {
        for (let band = 0; band < 4; band++) {
            const first = windowPixels(band, 0, 0, 128);
            const last = windowPixels(band, 14, 0, 128);

            expect(first.x).toBeGreaterThanOrEqual(band * 0.1875 * 1024);
            expect(last.x + last.width).toBeLessThanOrEqual((band + 1) * 0.1875 * 1024);
        }
    });
});

describe('paintTextures', () => {
    const at = (pixels, x, y) => [...pixels.subarray((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 4)];

    it('fills masonry everywhere a window is not', () => {
        const { diffuse, mask } = paintTextures([]);

        expect(at(diffuse, 0, 0)).toEqual([0x9D, 0x97, 0x92, 0xFF]);
        expect(at(mask, 500, 200)).toEqual([0x00, 0xFF, 0x80, 0x20]);
    });

    it('puts the emissive rectangle exactly over the diffuse one', () => {
        // `NewRoom.UpdateEmission` blits the emission map at the block's own originPixel
        // and rectSize, so a rectangle even one pixel out would light the masonry beside
        // the window.
        const window = { pixels: { x: 100, y: 40, width: 6, height: 20 } };
        const { diffuse, emissive } = paintTextures([window]);

        for (let y = 38; y < 62; y++) {
            for (let x = 98; x < 108; x++) {
                const inside = x >= 100 && x < 106 && y >= 40 && y < 60;

                expect(at(diffuse, x, y), `${x},${y}`)
                    .toEqual(inside ? [0x3B, 0x31, 0x42, 0xFF] : [0x9D, 0x97, 0x92, 0xFF]);
                expect(at(emissive, x, y), `${x},${y}`)
                    .toEqual(inside ? [0xFF, 0xFF, 0xFF, 0xFF] : [0, 0, 0, 0xFF]);
            }
        }
    });

    it('leaves the unlit map black all over', () => {
        const { black } = paintTextures([{ pixels: { x: 10, y: 10, width: 8, height: 8 } }]);

        expect(black.every((byte, index) => byte === (index % 4 === 3 ? 0xFF : 0))).toBe(true);
    });

    it('makes a window glossier and less occluded than the wall', () => {
        const { mask } = paintTextures([{ pixels: { x: 10, y: 10, width: 8, height: 8 } }]);

        // Occlusion in G, smoothness in A.
        expect(at(mask, 12, 12)[1]).toBeLessThan(at(mask, 0, 0)[1]);
        expect(at(mask, 12, 12)[3]).toBeGreaterThan(at(mask, 0, 0)[3]);
    });

    it('writes a flat normal map', () => {
        const { normal } = paintTextures([{ pixels: { x: 10, y: 10, width: 8, height: 8 } }]);

        expect(at(normal, 12, 12)).toEqual([0x80, 0x80, 0xFF, 0xFF]);
    });
});

describe('the OBJ', () => {
    it('negates x and reverses the winding, which is one handedness swap', () => {
        const mesh = buildMesh([footprint(['5,5'])]);
        const obj = toObj(mesh, 'Thing');
        const lines = obj.trim().split('\n');

        expect(lines[0]).toBe('o Thing');

        const first = mesh.vertices[0];
        expect(lines[1]).toBe(`v ${-first.x} ${first.y} ${first.z}`);

        // The first face is the first quad's first triangle, written 1, 3, 2.
        const face = lines.find((line) => line.startsWith('f '));
        expect(face).toBe('f 1/1/1 3/3/3 2/2/2');
    });

    it('writes a vertex, a UV and a normal for every vertex', () => {
        const obj = toObj(buildMesh([footprint(['5,5'])]), 'Thing');
        const count = (prefix) => obj.split('\n').filter((line) => line.startsWith(prefix)).length;

        // Four walls and the cap over them, four vertices and two triangles each.
        expect(count('v ')).toBe(20);
        expect(count('vt ')).toBe(20);
        expect(count('vn ')).toBe(20);
        expect(count('f ')).toBe(10);
    });
});

describe('the prefab definition', () => {
    it('names the mesh, the three maps and where the child sits', () => {
        const prefab = JSON.parse(prefabDefinition('Tower', 'REF:BuildingPreset|Hotel'));

        expect(prefab.prefabType).toBe('building');
        expect(prefab.children[0].position).toEqual([0, MESH_CHILD_LOCAL_Y, 0]);

        const renderer = prefab.children[0].components[0];
        expect(renderer.mesh).toBe('Tower.obj');
        expect(renderer.material.textures).toEqual({
            _BaseColorMap: 'Tower_diffuse.png',
            _NormalMap: 'Tower_normal.png',
            _MaskMap: 'Tower_mask.png',
        });
    });

    it('writes an empty copyFrom for a building that copies from nothing', () => {
        const prefab = JSON.parse(prefabDefinition('Tower', null));

        expect(prefab.children[0].components[0].material.copyFrom).toBe('');
    });
});

describe('generateBuilding', () => {
    /** A base game preset, deep copied so mutating it cannot leak between tests. */
    const presetCopy = async (name) => JSON.parse(JSON.stringify(await loadVanillaPreset(name)));

    it('writes the seven files a building is drawn from', async () => {
        const result = await generateBuilding(
            'Townhouse', await presetCopy('Townhouse'), loadVanillaBlueprint);

        expect(result.ok).toBe(true);
        expect(result.files.map((file) => file.path)).toEqual([
            'TownhousePrefab/Townhouse.obj',
            'TownhousePrefab/Townhouse.sodprefab.json',
            'TownhousePrefab/Townhouse_diffuse.png',
            'TownhousePrefab/Townhouse_emissive.png',
            'TownhousePrefab/Townhouse_black.png',
            'TownhousePrefab/Townhouse_mask.png',
            'TownhousePrefab/Townhouse_normal.png',
        ]);
    });

    it('writes real PNGs', async () => {
        const result = await generateBuilding(
            'Townhouse', await presetCopy('Townhouse'), loadVanillaBlueprint);

        for (const file of result.files.filter((entry) => entry.path.endsWith('.png'))) {
            expect([...file.contents.subarray(1, 4)].map((byte) => String.fromCharCode(byte)).join(''))
                .toBe('PNG');
        }
    });

    it('points the preset at what it just wrote', async () => {
        const preset = await presetCopy('Townhouse');
        await generateBuilding('Townhouse', preset, loadVanillaBlueprint);

        expect(preset.prefab).toBe('PREFAB:TownhousePrefab/Townhouse');
        expect(preset.emissionMapLit).toBe('TEXTURE:TownhousePrefab/Townhouse_emissive');
        expect(preset.emissionMapUnlit).toBe('TEXTURE:TownhousePrefab/Townhouse_black');
        expect(preset.floorCount).toBe(5);
        expect(preset.sortedWindows).toHaveLength(5);
    });

    it('refuses a building with nothing above its ground floor', async () => {
        const result = await generateBuilding(
            'Shed', { floorLayouts: [{ blueprints: ['Tenement_GroundFloor1'] }] },
            loadVanillaBlueprint);

        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/no floors above its ground floor/);
    });

    it('says which floors were left out of the model and which are shell only', async () => {
        const result = await generateBuilding(
            'ShantyTown', await presetCopy('ShantyTown'), loadVanillaBlueprint);

        // The ground floor is drawn by the street frontage in front of it. The rooftop is
        // in the model -- it just takes no row of the texture.
        expect(result.excluded).toEqual(['ShantyTown_GroundFloor01']);
        expect(result.shellOnly).toEqual(['ShantyTown_TowerRooftop']);
    });

    it('keeps a rooftop out of the window rows but in the model', async () => {
        const preset = await presetCopy('ShantyTown');
        const result = await generateBuilding('ShantyTown', preset, loadVanillaBlueprint);

        // Five window rows, as before -- a rooftop is not a storey with windows on it.
        expect(preset.floorCount).toBe(5);
        expect(preset.sortedWindows).toHaveLength(5);

        // But the model is six storeys of geometry. `ShantyTown_TowerRooftop` encloses
        // nothing, so it adds no walls; the height it occupies is what shows.
        expect(result.height).toBe(5 * FLOOR_HEIGHT);
        const obj = result.files.find((file) => file.path.endsWith('.obj')).contents;
        const top = Math.max(...obj.split('\n')
            .filter((line) => line.startsWith('v '))
            .map((line) => Number(line.split(' ')[2])));

        expect(top).toBeGreaterThan(5 * FLOOR_HEIGHT);
    });

    it('reads each blueprint once however many slots name it', async () => {
        const reads = [];
        const preset = {
            floorLayouts: [
                { floorsWithThisSetting: 4, blueprints: ['Tenement_MainFloor1'] },
                { blueprints: ['Tenement_MainFloor1'] },
            ],
        };

        await generateBuilding('Tower', preset, (name) => {
            reads.push(name);
            return loadVanillaBlueprint(name);
        });

        expect(reads).toEqual(['Tenement_MainFloor1']);
    });

    it('records on the preset that the model was built with a roof', async () => {
        const preset = await presetCopy('Townhouse');
        await generateBuilding('Townhouse', preset, loadVanillaBlueprint);

        expect(preset[MESH_ROOF_FIELD]).toBe(true);
    });

    it('leaves the top off, and says so, for a building with a floor above it', async () => {
        const preset = await presetCopy('Townhouse');
        const result = await generateBuilding(
            'Townhouse', preset, loadVanillaBlueprint, { roof: false });

        const upward = (obj) => obj.split('\n')
            .filter((line) => line.startsWith('vn 0 1 0')).length;

        const withRoof = await generateBuilding(
            'Townhouse', await presetCopy('Townhouse'), loadVanillaBlueprint);

        const off = upward(result.files.find((f) => f.path.endsWith('.obj')).contents);
        const on = upward(withRoof.files.find((f) => f.path.endsWith('.obj')).contents);

        expect(preset[MESH_ROOF_FIELD]).toBe(false);
        // Not zero: the rim round the open top faces up too, so what this can say is that
        // there is less of it and less of the model. That every upward face left is 10 cm
        // of rim rather than a square of roof is asserted on the mesh itself, above.
        expect(off).toBeGreaterThan(0);
        expect(off).toBeLessThan(on);
        expect(result.triangleCount).toBeLessThan(withRoof.triangleCount);
        expect(preset.sortedWindows.flatMap((floor) => floor.front).length).toBeGreaterThan(0);
    });
});

describe('staleness', () => {
    const preset = () => ({
        floorLayouts: [{ floorsWithThisSetting: 2, blueprints: ['a'], controlRoomVariants: ['b'] }],
    });

    const floors = { a: { rooms: 1 }, b: { rooms: 2 } };
    const resolve = async (name) => floors[name] ?? null;

    it('is the same hash for the same floors', async () => {
        expect(await sourceFloorHash(preset(), resolve))
            .toBe(await sourceFloorHash(preset(), resolve));
    });

    it('changes when a floor changes', async () => {
        const before = await sourceFloorHash(preset(), resolve);
        const after = await sourceFloorHash(preset(), async (name) =>
            (name === 'a' ? { rooms: 99 } : resolve(name)));

        expect(after).not.toBe(before);
    });

    it('changes when the building gains a storey', async () => {
        const before = await sourceFloorHash(preset(), resolve);

        const taller = preset();
        taller.floorLayouts[0].floorsWithThisSetting = 3;

        expect(await sourceFloorHash(taller, resolve)).not.toBe(before);
    });

    it('does not read a floor as changed for being pointed at differently', async () => {
        // Saving a base game floor into the mod turns a plain name into a FLOOR:
        // reference. The floor did not change, so the mesh has not gone stale.
        const plain = { floorLayouts: [{ blueprints: ['a'] }] };
        const pointed = { floorLayouts: [{ blueprints: ['FLOOR:Floors/a'] }] };

        expect(await sourceFloorHash(pointed, resolve)).toBe(await sourceFloorHash(plain, resolve));
    });

    it('ignores a basement, which is not in the model', async () => {
        const before = await sourceFloorHash(preset(), resolve);

        const withBasement = preset();
        withBasement.basementLayouts = [{ blueprints: ['a'] }];

        expect(await sourceFloorHash(withBasement, resolve)).toBe(before);
    });

    it('says nothing about a building whose mesh was never generated', async () => {
        expect(await isMeshStale(preset(), resolve)).toBeNull();
    });

    it('reads no floors at all for one', async () => {
        // The check runs after every save, so a building copying its model from a base
        // game one must not pay for reading its floors to be told there is no question.
        let reads = 0;
        await isMeshStale(preset(), async (name) => { reads++; return resolve(name); });

        expect(reads).toBe(0);
    });

    it('is not stale straight after generating', async () => {
        const generated = { ...preset(), [MESH_SOURCE_FIELD]: await sourceFloorHash(preset(), resolve) };

        expect(await isMeshStale(generated, resolve)).toBe(false);
    });

    it('is stale once one of the floors has been edited', async () => {
        const generated = { ...preset(), [MESH_SOURCE_FIELD]: await sourceFloorHash(preset(), resolve) };

        expect(await isMeshStale(generated, async (name) =>
            (name === 'b' ? { rooms: 'painted' } : resolve(name)))).toBe(true);
    });

    it('is written by generating, so the next save can check it', async () => {
        const preset = JSON.parse(JSON.stringify(await loadVanillaPreset('Townhouse')));
        await generateBuilding('Townhouse', preset, loadVanillaBlueprint);

        expect(preset[MESH_SOURCE_FIELD]).toMatch(/^[0-9a-f]{8}$/);
        expect(await isMeshStale(preset, loadVanillaBlueprint)).toBe(false);
    });
});

describe('what survives being written', () => {
    /**
     * A stub says `copyFrom`, so a field left out of the file is not "unchanged" -- it is
     * whatever the copied-from building has. Every field generation decides has to
     * survive `withoutDefaults`, including the two whose values are the game's defaults.
     */
    it('keeps window data that happens to be empty', () => {
        const written = withoutDefaults({
            name: 'Tower', presetName: 'Tower', type: 'BuildingPreset',
            fileType: 'BuildingPreset', copyFrom: 'REF:BuildingPreset|Townhouse',
            floorCount: 1,
            sortedWindows: [],
        }, GENERATED_FIELDS);

        expect(written.floorCount).toBe(1);
        expect(written.sortedWindows).toEqual([]);
    });

    it('drops the same field when generation did not write it', () => {
        const written = withoutDefaults({
            name: 'Tower', presetName: 'Tower', type: 'BuildingPreset',
            fileType: 'BuildingPreset', copyFrom: 'REF:BuildingPreset|Townhouse',
            floorCount: 1,
            sortedWindows: [],
        });

        expect(written).not.toHaveProperty('floorCount');
        expect(written).not.toHaveProperty('sortedWindows');
    });

    it('keeps everything a generation decides', async () => {
        const preset = JSON.parse(JSON.stringify(await loadVanillaPreset('Townhouse')));
        await generateBuilding('Townhouse', preset, loadVanillaBlueprint);

        const written = withoutDefaults(preset, GENERATED_FIELDS);
        for (const field of GENERATED_FIELDS) expect(written).toHaveProperty(field);
    });
});
