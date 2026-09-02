/**
 * What a mod's own file amounts to, before anything reads it.
 *
 * The loader's rule is the whole subject: a file states fields over something, and a **list
 * it states replaces** what it copies rather than merging with it. Getting that backwards
 * is invisible -- the pane draws a preset either way, with the wrong sub-objects on it.
 *
 * Reading the donor needs a folder, so the read is split from the merge and lives in the
 * Playwright suite. What is here is the merge.
 */
import { describe, test, expect } from 'vitest';

import { mergeFile } from './modFurniture.js';
import { describeDocument } from './furnitureModel.js';

const file = (raw) => ({
    fileName: `${raw.name ?? 'Thing'}.FurniturePreset.sodso.json`,
    name: raw.name ?? 'Thing',
    patch: false,
    raw,
});

/** The shipped preset a mod copies, as the export folder holds it. */
const donor = {
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
            localPos: { x: -1, y: 1, z: 0 },
            localRot: { x: 0, y: 180, z: 0 },
            belongsTo: 2,
            security: 0,
        },
    ],
};

const merged = (raw, base = donor) => mergeFile('FurniturePreset', file(raw), base).document;
const read = (raw, base = donor) => describeDocument(raw.name ?? 'Thing', merged(raw, base));


describe('a file copying a shipped asset', () => {
    test('takes what it does not state from the donor', () => {
        const document = merged({ name: 'MyDesk', copyFrom: 'REF:FurniturePreset|HotelDesk' });

        expect(document.prefab).toBe('REF:GameObject|HotelFrontDesk');
        expect(document.subObjects).toHaveLength(1);
        expect(document.minimumRoomSize).toBe(4);
    });

    test('overrides a field it states', () => {
        const document = merged({ prefab: 'PREFAB:MyDeskPrefab/MyDesk' });

        expect(document.prefab).toBe('PREFAB:MyDeskPrefab/MyDesk');
        expect(document.classes).toEqual(['REF:FurnitureClass|3x1LobbyDesk']);
    });

    /**
     * The half that is easy to get backwards. Stating one sub-object states that there is
     * one, not that there is one more.
     */
    test('replaces a list it states rather than adding to it', () => {
        const document = merged({
            subObjects: [{
                preset: 'REF:SubObjectClassPreset|AshTray',
                localPos: { x: 0.5, y: 1, z: 0.25 },
                localRot: { x: 0, y: 90, z: 0 },
                belongsTo: 0,
            }],
        });

        expect(document.subObjects).toHaveLength(1);
        expect(read({
            subObjects: document.subObjects,
        }).placed[0].class).toBe('AshTray');
    });

    test('states an empty list as an empty list, not as the donor’s', () => {
        expect(merged({ subObjects: [] }).subObjects).toEqual([]);
    });

    /** A nested object merges field by field, which is Unity's own overwrite rule. */
    test('merges a nested object rather than replacing it', () => {
        const document = merged({ spawnRange: 3 }, { ...donor, spawnRange: 1 });

        expect(document.spawnRange).toBe(3);
        expect(document.presetName).toBe('HotelDesk');
    });
});


describe('a file copying nothing', () => {
    /**
     * What the game starts a file with is the type's own defaults, and
     * `FurniturePreset.minimumRoomSize` defaults to 99 -- larger than most rooms. Reading
     * an unstated minimum as 0 would make the commonest way to write an unplaceable preset
     * look fine.
     */
    test('starts from the type’s defaults, including the 99 that never places', () => {
        const document = mergeFile('FurniturePreset', file({ name: 'MyDesk' })).document;

        expect(document.minimumRoomSize).toBe(99);
        expect(document.universalDesignStyle).toBe(false);
    });

    test('keeps what the file does state', () => {
        const document = mergeFile('FurniturePreset', file({
            name: 'MyDesk',
            minimumRoomSize: 1,
            prefab: 'PREFAB:MyDeskPrefab/MyDesk',
        })).document;

        expect(document.minimumRoomSize).toBe(1);
        expect(document.prefab).toBe('PREFAB:MyDeskPrefab/MyDesk');
    });

    test('is the defaults themselves for a type nothing is known about', () => {
        expect(mergeFile('NotAType', file({ name: 'Thing' })).document).toEqual({ name: 'Thing' });
    });
});
