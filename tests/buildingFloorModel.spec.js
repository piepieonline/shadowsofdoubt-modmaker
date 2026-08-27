import { test, expect } from '@playwright/test';
import { installFsHarness, gotoFlow } from './support/harness.js';

/**
 * The floor model, against the base game's own 93 floors.
 *
 * A floor blueprint is the one kind of content this app writes where a mistake is
 * invisible until the game renders it, and where the file being written is the only
 * copy. So the standard here is not "it parses" but "it comes back out as it went in":
 * read all 93, write them, and compare.
 *
 * 82 of them must come back *identical*. The other 11 are floors the base game itself
 * authored oddly, and each is listed below with what it does and what that costs. If a
 * re-import of refs/floors/ changes those lists, this fails -- which is the point.
 *
 * Two further assertions sit apart from the round trip, because a model that quietly
 * dropped either would still pass a general comparison of what it wrote against what it
 * read. Both are the data-loss bugs this model exists to avoid.
 */

/**
 * Floors whose first layout variation does not cover the whole 21 x 21 grid. The model
 * fills the rest in as Outside, mirroring DataBuilder.BackfillOutside, so it writes back
 * more nodes than it read.
 */
const GAP_FLOORS = [
    'Hotel_Basement2',
    'Hotel_RooftopBar',
    'MixedIndustrial_ground01',
    'ShantyTown_Basement01',
    'ShantyTown_FirstFloor01',
    'ShantyTown_GroundFloor01',
];

/**
 * Floors where two addresses claim the same node in their first variation. A node
 * belongs to one address on a grid, so the later claim wins and the earlier address
 * writes back without it.
 */
const OVERLAP_FLOORS = [
    'CityHall_LoftFloor',
    'CityHall_SecondFloor',
    'MixedIndustrial_FirstFloor01',
    'Tenement_BasementNoShops',
    'Tenement_BasementNoShops_Control',
];

/**
 * Read every blueprint, run it through the model, and report on it. Done in one page
 * evaluation because it is 5 MB of JSON and 93 round trips; pulling each floor back
 * across the protocol boundary would dominate the run.
 */
async function roundTripAll(page) {
    return page.evaluate(async () => {
        const model = await import('/flows/building/scripts/floorModel.js');
        const index = await (await fetch('/refs/floors/index.json')).json();

        /**
         * JSON with object keys sorted, so two floors compare on their content.
         *
         * Key order is not a property worth holding the model to: the game's own
         * exports disagree with each other about it, most writing a node as
         * f_c/f_h/f_t/f_r/w_d and four writing f_r before f_t. Array order *is*
         * compared, because the order of nodes within a room is real data.
         */
        const canonical = (value) => JSON.stringify(value, (key, held) => (
            held && typeof held === 'object' && !Array.isArray(held)
                ? Object.fromEntries(Object.keys(held).sort().map((k) => [k, held[k]]))
                : held
        ));

        const results = [];

        for (const name of index.blueprints) {
            const input = await (await fetch(`/refs/floors/blueprints/${name}.json`)).json();

            let parsed;
            let output;
            try {
                parsed = model.parseFloor(input);
                output = model.serialiseFloor(parsed);
            } catch (error) {
                results.push({ name, threw: String(error) });
                continue;
            }

            // Every node the input held, and every node the output holds, keyed by
            // coordinate -- so a comparison can say which side a difference is on.
            const nodesOf = (floor) => {
                const nodes = new Map();
                floor.a_d.forEach((address, addressIndex) => {
                    const variation = address.vs[0];
                    if (!variation) return;
                    for (const room of variation.r_d) {
                        for (const node of room.n_d) {
                            nodes.set(`${node.f_c.x},${node.f_c.y}`, { addressIndex, node });
                        }
                    }
                });
                return nodes;
            };

            const before = nodesOf(input);
            const after = nodesOf(output);

            results.push({
                name,
                identical: canonical(output) === canonical(input),
                addedNodes: [...after.keys()].filter((key) => !before.has(key)).sort(),
                lostNodes: [...before.keys()].filter((key) => !after.has(key)).sort(),

                // Every node the output added, as the model wrote it -- so the test can
                // check a backfill is really an empty Outside square.
                added: [...after.entries()]
                    .filter(([key]) => !before.has(key))
                    .map(([key, entry]) => ({
                        key,
                        layout: output.a_d[entry.addressIndex].p_n,
                        floorType: entry.node.f_t,
                        height: entry.node.f_h,
                    })),

                // Variation counts per address, to catch a model that keeps the one it
                // is showing and drops the rest.
                variationsIn: input.a_d.map((address) => address.vs.length),
                variationsOut: output.a_d.map((address) => address.vs.length),

                // Non-selected variations must be untouched, whatever happens to the
                // grid. Nothing should have reached them at all.
                spareIn: canonical(input.a_d.map((a) => a.vs.slice(1))),
                spareOut: canonical(output.a_d.map((a) => a.vs.slice(1))),

                forcedRoomsIn: countForcedRooms(input),
                forcedRoomsOut: countForcedRooms(output),
            });
        }

        function countForcedRooms(floor) {
            const values = [];
            for (const address of floor.a_d) {
                for (const variation of address.vs) {
                    for (const room of variation.r_d) {
                        for (const node of room.n_d) {
                            if (node.f_r) values.push(`${node.f_c.x},${node.f_c.y}=${node.f_r}`);
                        }
                    }
                }
            }
            return values.sort();
        }

        return results;
    });
}

let results;

/**
 * All 93 round trips run once, and every test below reads the same results. The model
 * is pure, so re-running it per test would buy nothing but 5 MB of parsing each time.
 */
test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');

    results = await roundTripAll(page);
    await page.close();
});

test('every base game floor is readable', () => {
    expect(results.filter((r) => r.threw)).toEqual([]);
    expect(results).toHaveLength(93);
});

test('a floor with nothing odd about it round trips identically', () => {
    const expected = results
        .map((r) => r.name)
        .filter((name) => !GAP_FLOORS.includes(name) && !OVERLAP_FLOORS.includes(name));

    const identical = results.filter((r) => r.identical).map((r) => r.name);

    expect(identical.sort()).toEqual(expected.sort());
    expect(identical).toHaveLength(82);
});

test('a floor with missing nodes gains them as empty Outside squares, and nothing else', () => {
    const gapped = results.filter((r) => GAP_FLOORS.includes(r.name));
    expect(gapped).toHaveLength(GAP_FLOORS.length);

    for (const floor of gapped) {
        expect(floor.lostNodes, `${floor.name} lost nodes`).toEqual([]);
        expect(floor.addedNodes.length, `${floor.name} gained nothing`).toBeGreaterThan(0);

        // A backfilled node is Outside, with no floor and no height. Anything else
        // means the fill picked the wrong address or invented geometry.
        for (const node of floor.added) {
            expect(node.layout, `${floor.name} ${node.key}`).toBe('Outside');
            expect(node.floorType, `${floor.name} ${node.key}`).toBe(0);
            expect(node.height, `${floor.name} ${node.key}`).toBe(0);
        }
    }
});

test('a floor with two addresses on one node keeps the node once, and loses nothing else', () => {
    const overlapping = results.filter((r) => OVERLAP_FLOORS.includes(r.name));
    expect(overlapping).toHaveLength(OVERLAP_FLOORS.length);

    for (const floor of overlapping) {
        // The node is still on the floor -- it just belongs to one address now. So
        // nothing is added, and nothing disappears from the grid.
        expect(floor.addedNodes, `${floor.name} invented nodes`).toEqual([]);
        expect(floor.lostNodes, `${floor.name} dropped nodes from the grid`).toEqual([]);

        // But it is not identical, because one address wrote back without it.
        expect(floor.identical, `${floor.name} was expected to differ`).toBe(false);
    }
});

test('no floor is silently repaired', () => {
    // Every floor is either identical or one of the eleven listed above. A twelfth
    // means either the reference data changed or the model started rewriting things.
    const unexplained = results
        .filter((r) => !r.identical)
        .map((r) => r.name)
        .filter((name) => !GAP_FLOORS.includes(name) && !OVERLAP_FLOORS.includes(name));

    expect(unexplained).toEqual([]);
});

/**
 * The first of the two bugs this model exists to avoid. The reference tool reads vs[0],
 * ignores the rest, and writes a single variation -- so saving one of the 117 addresses
 * that have more than one deletes layouts the game picks between at random.
 */
test('an address keeps every layout variation, not just the one on show', () => {
    let multiVariation = 0;

    for (const floor of results) {
        // Never fewer. An address may gain one -- see below -- but losing one is the
        // bug, and no amount of gaining excuses it.
        floor.variationsIn.forEach((count, addressIndex) => {
            expect(floor.variationsOut[addressIndex], `${floor.name} address ${addressIndex}`)
                .toBeGreaterThanOrEqual(count);
        });

        multiVariation += floor.variationsIn.filter((count) => count > 1).length;
    }

    // The base game has 117 of them. If this number moves, the reference data changed.
    expect(multiVariation).toBe(117);
});

test('only a floor being backfilled gains a variation, and only to hold the fill', () => {
    for (const floor of results) {
        const gained = floor.variationsIn
            .map((count, addressIndex) => ({ addressIndex, count, out: floor.variationsOut[addressIndex] }))
            .filter((entry) => entry.out > entry.count);

        if (!GAP_FLOORS.includes(floor.name)) {
            expect(gained, `${floor.name} gained a variation for no reason`).toEqual([]);
            continue;
        }

        // Six base game floors leave the grid incomplete *and* write their Outside
        // address with no variations at all. The backfilled nodes have to belong to
        // an address, so Outside gets the one variation it needs and nothing more.
        for (const entry of gained) {
            expect(entry.count, `${floor.name} address ${entry.addressIndex}`).toBe(0);
            expect(entry.out, `${floor.name} address ${entry.addressIndex}`).toBe(1);
        }
    }
});

test('a variation nobody is editing is written back untouched', () => {
    for (const floor of results) {
        expect(floor.spareOut, `${floor.name}`).toBe(floor.spareIn);
    }
});

/**
 * The second. The reference tool writes f_r as "" for every node, commented "Seems to
 * be blank in real files?". It is not blank in real files.
 */
test('a node keeps its forced room', () => {
    let total = 0;

    for (const floor of results) {
        total += floor.forcedRoomsIn.length;

        if (OVERLAP_FLOORS.includes(floor.name)) {
            // An overlapping node belongs to one address once the floor is a grid, so
            // the loser's copy of it goes -- with its f_r. Nothing may be *changed* or
            // invented, which is what this checks instead.
            const kept = new Set(floor.forcedRoomsIn);
            for (const value of floor.forcedRoomsOut) {
                expect(kept.has(value), `${floor.name} invented ${value}`).toBe(true);
            }
            continue;
        }

        expect(floor.forcedRoomsOut, `${floor.name}`).toEqual(floor.forcedRoomsIn);
    }

    // 1,889 nodes across 40 floors. Stated as a number so that a model which blanked
    // them all would fail here even if it blanked them on both sides of the compare.
    expect(total).toBe(1889);
});
