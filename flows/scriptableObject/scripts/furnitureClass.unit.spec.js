/**
 * Where a class may stand, read as a grid, against the game's own data.
 *
 * The rules are index-addressed in the files and named by the time they get here, so the
 * risks are the ones a diagram makes visible: a direction pointing the wrong way, a rule
 * drawn on the wrong tile, or a gate quietly shown as a preference. Each of those draws
 * something that looks entirely reasonable and is wrong, which is why the geometry is
 * pinned rather than eyeballed.
 */
import { describe, test, expect } from 'vitest';

import {
    placementFromAsset, tilesOf, boundsOf, gridBounds, explainRule, explainBlock,
    explainWallCount, explainFootprint, explainExtent, DIRECTION_OFFSET, EDGES, TAG_MEANING,
} from './furnitureClass.js';

import { WALL_RULE } from '../../../core/furnitureRules.js';

/** A class as the export folder holds one: enums as integers, references named. */
const lobbyDesk = {
    presetName: '3x1LobbyDesk',
    objectSize: { x: 3, y: 1 },
    tall: true,
    minimumZeroNodeWallCount: 0,
    maximumZeroNodeWallCount: 3,
    wallRules: [
        { nodeOffset: { x: 0, y: 1 }, wallDirection: 0, option: 0, tag: 0, addScore: 0 },
    ],
    nodeRules: [
        { offset: { x: 0, y: 1 }, option: 1, anyOccupiedTile: false,
            furnitureClass: 'REF:FurnitureClass|2x1Sofa', addScore: 0 },
    ],
    blockedAccess: [
        { disabled: false, nodeOffset: { x: 0, y: 0 },
            blockExteriorDiagonals: false, blocked: [4, 5, 2] },
    ],
    awayFromClasses: ['REF:FurnitureClass|1x1KitchenSink'],
    minimumNodeDistance: 1.2,
};

const placement = (raw, donor = null) => placementFromAsset(raw.presetName ?? 'Thing', raw, donor);


describe('the frame the rules are written in', () => {
    /**
     * `CityData.GetOffsetFromDirection`. This table has to be the same one the building
     * flow's walk uses, because a rule names an edge by direction and a direction is only
     * a vector once one of them says so.
     */
    test('has front up and right along x, with the diagonals their sums', () => {
        expect(DIRECTION_OFFSET.front).toEqual([0, 1]);
        expect(DIRECTION_OFFSET.right).toEqual([1, 0]);
        expect(DIRECTION_OFFSET.frontRight).toEqual([1, 1]);
        expect(DIRECTION_OFFSET.behindLeft).toEqual([-1, -1]);
    });

    test('names the four edges of a tile and no more', () => {
        expect(EDGES).toEqual(['front', 'right', 'behind', 'left']);
    });

    /** Every tag the game has needs words, or a diagram shows a name nobody can act on. */
    test('has a meaning for every wall tag the game declares', () => {
        for (const tag of WALL_RULE) expect(TAG_MEANING[tag], tag).toBeTruthy();
    });
});


describe('one class as a grid', () => {
    test('reads the rules that gate and the ones that only score', () => {
        const read = placement({
            ...lobbyDesk,
            wallRules: [
                ...lobbyDesk.wallRules,
                { nodeOffset: { x: 0, y: 0 }, wallDirection: 2, option: 2, tag: 4, addScore: 2 },
            ],
        });

        const kinds = read.rules.map((rule) => `${rule.kind}:${rule.gates}`);

        expect(kinds).toContain('wall:true');
        expect(kinds).toContain('wall:false');
    });

    test('carries what a class blocks once it is there', () => {
        expect(placement(lobbyDesk).blocks[0].dirs).toEqual(['left', 'right', 'behind']);
    });

    test('carries the distance it keeps from other classes', () => {
        expect(placement(lobbyDesk).away).toEqual({
            classes: ['1x1KitchenSink'],
            distance: 1.2,
        });
    });

    /** A class with no rules is not a broken read: most of the game's are like this. */
    test('is a grid and a footprint for a class that states no rules', () => {
        const read = placement({ presetName: 'Plain' });

        expect(read.rules).toEqual([]);
        expect(read.size).toEqual([1, 1]);
    });
});


/**
 * A class the reference data does not have, which is the case placement mode is most
 * useful for: a mod that authors furniture properly authors a class of its own.
 *
 * The shape here is the bank example mod's `3x1BankLobbyDesk` -- `copyFrom` a shipped
 * class, its own `wallRules`, and an explicitly empty `nodeRules`, with every enum written
 * as the integer the game serialises.
 */
describe('a class read from a file', () => {
    const donor = () => placement(lobbyDesk);

    const asset = {
        presetName: 'MyDesk',
        copyFrom: 'REF:FurnitureClass|3x1LobbyDesk',
        wallRules: [
            { nodeOffset: { x: 0, y: 1 }, wallDirection: 2, option: 0, tag: 1, roomType: null, addScore: 0 },
        ],
        nodeRules: [],
    };

    test('reads the enums the game writes as integers', () => {
        const placement = placementFromAsset('MyDesk', asset, donor());
        const rule = placement.rules[0];

        expect(rule.dir).toBe('behind');
        expect(rule.tag).toBe('wall');
        expect(rule.must).toBe(true);
        expect(rule.at).toEqual([0, 1]);
    });

    /** A file may reasonably have been typed by hand with names instead. */
    test('reads the same rule written with names', () => {
        const placement = placementFromAsset('MyDesk', {
            wallRules: [{
                nodeOffset: { x: 0, y: 1 }, wallDirection: 'behind',
                option: 'mustFeature', tag: 'wall', addScore: 0,
            }],
        }, null);

        expect(placement.rules[0]).toMatchObject({ dir: 'behind', tag: 'wall', must: true });
    });

    /**
     * The loader's rule, and the half that is easy to get backwards: a stated list
     * replaces the donor's, so an empty one means none rather than the donor's.
     */
    test('takes a stated list whole, empty or not', () => {
        const placement = placementFromAsset('MyDesk', asset, donor());

        expect(placement.rules.filter((rule) => rule.kind === 'wall')).toHaveLength(1);
        expect(placement.rules.filter((rule) => rule.kind === 'node')).toHaveLength(0);
    });

    test('takes a list it does not state from the donor', () => {
        const base = donor();
        const placement = placementFromAsset('MyDesk', { presetName: 'MyDesk' }, base);

        expect(placement.rules).toHaveLength(base.rules.length);
        expect(placement.size).toEqual(base.size);
    });

    test('reads what it blocks, and what it keeps away from', () => {
        const placement = placementFromAsset('MyDesk', {
            blockedAccess: [{
                disabled: false, nodeOffset: { x: 0, y: 0 },
                blockExteriorDiagonals: true, blocked: [2, 6],
            }],
            awayFromClasses: ['REF:FurnitureClass|1x1Chair'],
            minimumNodeDistance: 2,
        }, null);

        // Tagged like a rule so one selection can hold either: a block is not a rule, but
        // it is written at an offset and drawn on the same grid, and the editor turns one
        // into the other.
        expect(placement.blocks[0]).toEqual({
            kind: 'block', at: [0, 0], dirs: ['behind', 'frontLeft'], diagonals: true,
        });

        expect(placement.away).toEqual({ classes: ['1x1Chair'], distance: 2 });
    });

    test('drops a switched-off block rather than drawing it as live', () => {
        const placement = placementFromAsset('MyDesk', {
            blockedAccess: [{ disabled: true, nodeOffset: { x: 0, y: 0 }, blocked: [2] }],
        }, null);

        expect(placement.blocks).toEqual([]);
    });

    test('says every placement now comes from an asset', () => {
        expect(placementFromAsset('MyDesk', asset, donor()).fromAsset).toBe(true);
    });

    /** A class written from nothing is a real thing to write, and draws as an empty grid. */
    test('reads a class that states nothing and copies nothing', () => {
        const placement = placementFromAsset('MyDesk', { presetName: 'MyDesk' }, null);

        expect(placement.rules).toEqual([]);
        expect(placement.size).toEqual([1, 1]);
        expect(placement.bounds).toEqual({ minX: -1, maxX: 1, minY: -1, maxY: 1 });
    });
});


describe('the grid it is drawn on', () => {
    const grid = (raw) => placement({ presetName: 'Thing', ...raw });

    /**
     * At least 3x3 around the anchor. A diagram that is one tile is not a diagram, and the
     * ring around the piece is what an author checks even when nothing is written on it.
     */
    test('is never smaller than the ring around the anchor', () => {
        expect(grid({ objectSize: { x: 1, y: 1 } }).bounds).toEqual({ minX: -1, maxX: 1, minY: -1, maxY: 1 });
    });

    /** Which reaches back and to the left of the anchor, not forward and right of it. */
    test('covers the whole footprint of a piece bigger than one tile', () => {
        const bounds = grid({ objectSize: { x: 3, y: 2 } }).bounds;

        expect(bounds.minX).toBeLessThanOrEqual(-2);
        expect(bounds.minY).toBeLessThanOrEqual(-1);
    });

    /**
     * A rule on the outermost tile names an edge, and that edge is a boundary with the
     * tile beyond it -- so the grid has to reach one further or the rule points off it.
     */
    test('reaches past a rule to the edge that rule names', () => {
        const bounds = grid({
            wallRules: [{ nodeOffset: { x: 0, y: 2 }, wallDirection: 7, option: 0, tag: 1 }],
        }).bounds;

        expect(bounds.maxY).toBeGreaterThanOrEqual(3);
    });

    /**
     * The nodes run **negative** from the anchor: the game lays a footprint down two quarter
     * turns from the angle it reads every rule at (`GenerationController.cs:4543`), and the
     * shipped `2x1Sofa` states its own wall rules at `(0,0)` and `(-1,0)` to match. Drawn the
     * other way, every rule a class writes about itself falls outside its own shading.
     */
    test('marks the tiles the piece stands on, and the one it is measured from', () => {
        const tiles = tilesOf(grid({ objectSize: { x: 2, y: 1 } }));

        const covered = tiles.filter((tile) => tile.covered).map((tile) => [tile.x, tile.y]);
        expect(covered).toEqual([[-1, 0], [0, 0]]);

        expect(tiles.filter((tile) => tile.anchor)).toHaveLength(1);
    });

    /**
     * The check that would have caught the grid being drawn the wrong way round.
     *
     * A class states rules about the nodes it stands on -- the shipped `2x1Sofa` asks for a
     * wall behind both of its own two, at `(0,0)` and `(-1,0)`. So its rules must land on
     * shaded tiles. Drawn with the footprint running positive, both fell on bare tiles
     * outside the piece and the diagram was wrong about every class bigger than one node,
     * while every assertion above went on passing: each half was self-consistent.
     */
    test('lands a class’s rules about its own nodes on tiles it stands on', () => {
        const tiles = tilesOf(grid({
            objectSize: { x: 2, y: 1 },
            wallRules: [
                { nodeOffset: { x: 0, y: 0 }, wallDirection: 2, option: 0, tag: 1 },
                { nodeOffset: { x: -1, y: 0 }, wallDirection: 2, option: 0, tag: 1 },
            ],
        }));

        const withRules = tiles.filter((tile) => tile.rules.length);

        expect(withRules).toHaveLength(2);
        for (const tile of withRules) expect(tile.covered).toBe(true);
    });

    /** Top row first, left to right — the order a plan is read in, not the order stored. */
    test('walks the tiles in reading order', () => {
        const tiles = tilesOf(grid({}));

        expect([tiles[0].x, tiles[0].y]).toEqual([-1, 1]);
        expect([tiles[8].x, tiles[8].y]).toEqual([1, -1]);
    });

    test('puts each rule on the tile it names', () => {
        const read = grid({
            wallRules: [{ nodeOffset: { x: 1, y: 0 }, wallDirection: 2, option: 0, tag: 1 }],
        });

        const tile = tilesOf(read).find((entry) => entry.x === 1 && entry.y === 0);
        expect(tile.rules).toHaveLength(1);
    });

    /**
     * A placement is edited in place -- a rule dragged out to a far tile, a footprint
     * widened -- and bounds computed when the asset was read are a grid the edit is drawn
     * outside of. Which reads as the edit having been dropped, in the one pane whose job is
     * to show it.
     */
    test('recomputes from a placement that has been edited', () => {
        const read = grid({ objectSize: { x: 1, y: 1 } });
        expect(read.bounds.maxY).toBe(1);

        read.rules.push({ kind: 'node', at: [0, 4], option: 'cantFeature', any: true });
        expect(boundsOf(read).maxY).toBe(4);

        read.size = [3, 1];
        expect(boundsOf(read).minX).toBe(-2);
    });
});


/**
 * The model against the footprint. Nothing in the game reads this -- placement is decided
 * from `objectSize` alone -- so an overhang is a piece the generator will stand next to
 * something and then clip through, which is invisible until the two are drawn together.
 */
describe('where the model reaches against what the class declares', () => {
    const grid = (raw) => placement({ presetName: 'Thing', ...raw });
    const extent = (bounds) => ({ metres: { across: 5.4, deep: 1.8 }, ...bounds });

    test('leaves the grid alone when there is no model to measure', () => {
        const read = grid({ objectSize: { x: 1, y: 1 } });
        expect(gridBounds(read, null)).toEqual(read.bounds);
    });

    /** A tile outside the grid cannot be marked, so the grid has to reach the overhang. */
    test('grows the grid to reach an overhang', () => {
        const read = grid({ objectSize: { x: 1, y: 1 } });
        const bounds = gridBounds(read, extent({ minX: -3, maxX: 0, minY: 0, maxY: 0 }));

        expect(bounds.minX).toBe(-3);
    });

    /**
     * Two flags, not one. The mesh's whole footprint is `inModel`; the part the class does
     * not declare is `overhang`, and only that part is the problem.
     *
     * `modelExtent` answers in the same negative-from-the-anchor frame the footprint is in,
     * so a 3-node model on a 2-node class overhangs the third node *behind* the anchor.
     */
    test('marks only the tiles the model reaches and the class does not own', () => {
        const tiles = tilesOf(
            grid({ objectSize: { x: 2, y: 1 } }),
            extent({ minX: -2, maxX: 0, minY: 0, maxY: 0 }));

        const at = (x, y) => tiles.find((tile) => tile.x === x && tile.y === y);

        expect(at(0, 0)).toMatchObject({ covered: true, inModel: true, overhang: false });
        expect(at(-1, 0)).toMatchObject({ covered: true, inModel: true, overhang: false });
        expect(at(-2, 0)).toMatchObject({ covered: false, inModel: true, overhang: true });
        expect(at(1, 0)).toMatchObject({ inModel: false, overhang: false });
    });

    test('says nothing overhangs when the model is inside the footprint', () => {
        const said = explainExtent(
            grid({ objectSize: { x: 3, y: 1 } }),
            extent({ minX: -2, maxX: 0, minY: 0, maxY: 0 }));

        expect(said).toContain('Nothing overhangs');
    });

    /**
     * The wording is the point. An overhang is not a rule being broken, and a note that
     * reads as a validation failure sends an author looking for the setting that is wrong.
     */
    test('names the tiles it overhangs onto, and says the generator never checks', () => {
        const said = explainExtent(
            grid({ objectSize: { x: 1, y: 1 } }),
            extent({ minX: -2, maxX: 0, minY: 0, maxY: 0 }));

        expect(said).toContain('-1, 0');
        expect(said).toContain('-2, 0');
        expect(said).toContain('never the mesh');
    });

    test('is null when there is no model, which is every shipped preset', () => {
        expect(explainExtent(grid({}), null)).toBeNull();
    });
});


/**
 * Which end of a 3x1 table is the far end. The shading says three tiles are covered; it
 * does not say which one an author would close a way out on.
 */
describe('the footprint in words', () => {
    const grid = (raw) => placement({ presetName: 'Thing', ...raw });

    test('says a one-node piece stands on the anchor and nothing else', () => {
        expect(explainFootprint(grid({ objectSize: { x: 1, y: 1 } })))
            .toContain('stands on the anchor tile');
    });

    test('names the far tile of a piece bigger than one node', () => {
        const said = explainFootprint(grid({ objectSize: { x: 3, y: 1 } }));

        expect(said).toContain('3 × 1');
        expect(said).toContain('-2, 0');
    });
});


/**
 * The words are the diagram's other half: a mark says which rule and this says what it
 * does. Written as what would happen rather than as what is set, because "mustFeature:
 * wall" is what the author already read in the file and came here to understand.
 */
describe('what a rule says', () => {
    test('reads a gate as a refusal', () => {
        const rule = { kind: 'wall', at: [0, 0], dir: 'behind', tag: 'wall', must: true, gates: true };

        expect(explainRule(rule)).toBe(
            'Will not be placed unless there is a solid wall on its behind edge on its own tile.');
    });

    test('reads the other kind of gate the other way round', () => {
        const rule = { kind: 'wall', at: [0, 1], dir: 'front', tag: 'window', must: false, gates: true };

        expect(explainRule(rule)).toContain('Will not be placed if there is a window');
        expect(explainRule(rule)).toContain('on the tile at 0, 1');
    });

    /** A scoring rule never refuses, so it must not read like one that does. */
    test('reads a preference as a preference, and says it never refuses', () => {
        const rule = { kind: 'wall', at: [0, 0], dir: 'behind', tag: 'entrance', gates: false, score: 1 };

        expect(explainRule(rule)).toContain('Prefers');
        expect(explainRule(rule)).toContain('never a reason to refuse');
    });

    /** A gate the app cannot check is not a gate that does not matter. */
    test('says when a gate cannot be checked outside the game', () => {
        const rule = {
            kind: 'wall', at: [0, 0], dir: 'left', tag: 'lightswitch',
            must: true, gates: true, unreadable: true,
        };

        expect(explainRule(rule)).toContain('cannot be checked outside the game');
    });

    test('reads a node rule as being about what is already there', () => {
        const rule = { kind: 'node', at: [0, 1], option: 'cantFeature', class: '2x1Sofa', gates: true };

        expect(explainRule(rule)).toBe(
            'Will not be placed if 2x1Sofa is already there on the tile at 0, 1.');
    });

    test('reads the any-occupied-tile flag as anything at all', () => {
        const rule = { kind: 'node', at: [0, -1], option: 'cantFeature', any: true, gates: true };

        expect(explainRule(rule)).toContain('anything at all');
    });

    /**
     * Blocked access is an effect rather than a rule, and reading it as a placement gate is
     * the mistake worth writing a sentence to prevent.
     */
    test('says that blocking is what standing here does, not where it may stand', () => {
        const line = explainBlock({ at: [0, 0], dirs: ['behind', 'behindLeft'], diagonals: true });

        expect(line).toContain('Nothing about where this may stand');
        expect(line).toContain('behind and behind left');
        expect(line).toContain('diagonals on the tiles next to it');
    });

    test('says nothing about a wall count that rules nothing out', () => {
        expect(explainWallCount({ minWalls: 0, maxWalls: 4 })).toBeNull();
    });

    test('reads the wall count the way the corner pieces need it', () => {
        expect(explainWallCount({ minWalls: 2, maxWalls: 4 }))
            .toBe('Its tile must have at least 2 of its four edges walled.');
        expect(explainWallCount({ minWalls: 1, maxWalls: 3 }))
            .toBe('Its tile must have between 1 and 3 of its four edges walled.');
    });
});
