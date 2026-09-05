import { describe, it } from 'vitest';
import { appendFileSync } from 'node:fs';

import { readFootprints, trimToWindowFloors } from './meshExport.js';
import { loadVanillaPreset, loadVanillaBlueprint } from './buildingLibrary.js';

const BAND_NEIGHBOURS = [
    { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }, { x: -1, y: 0 },
];

const NAMES = [
    'AmericanDiner', 'BrandyNetherland', 'ChemicalPlant', 'CityHall', 'EdenTower',
    'Hotel', 'MixedIndustrial', 'OneFIfthAve', 'Park', 'ShantyTown', 'Townhouse',
    'TownhouseShops',
];

describe('what the unsealed body rule drops', () => {
    it.each(NAMES)('%s', async (name) => {
        const preset = await loadVanillaPreset(name);
        const { floors } = await readFootprints(preset, loadVanillaBlueprint);
        const { body } = trimToWindowFloors(floors);

        const lines = [];

        body.forEach((storey, floor) => {
            const below = floor > 0 ? body[floor - 1].enclosed : new Set();
            let walls = 0;
            let dropped = 0;

            for (const key of storey.enclosed) {
                const [x, y] = key.split(',').map(Number);
                for (const step of BAND_NEIGHBOURS) {
                    const across = `${x + step.x},${y + step.y}`;
                    if (storey.enclosed.has(across)) continue;
                    walls++;
                    if (below.has(across) && storey.openAir.has(across)) dropped++;
                }
            }

            if (dropped) {
                lines.push(`   floor ${floor} ${storey.blueprint} walls=${walls} `
                    + `dropped=${dropped} air=${storey.openAir.size}`);
            }
        });

        if (lines.length) appendFileSync('/tmp/diag5.txt', `${name}\n${lines.join('\n')}\n`);
    });
});
