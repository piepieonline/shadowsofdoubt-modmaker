/**
 * Finding rooms in a folder, including rooms this tool did not write.
 *
 * The fixtures are deliberately not all well-formed. A room somebody assembled by hand is
 * the normal case for this scanner -- the rooms most worth opening are the ones whose
 * shape nobody remembers -- so the shapes that matter are the awkward ones: no filter, a
 * shipped class, a filter shared with a second room, a patch in the format this app
 * replaced, and one carrying changes beside ours.
 *
 * What the scanner must never do is read a name. `roomPlan.js` writes `<Name>RCP` and
 * friends as a convenience for the author, and a scanner keyed on that would find only its
 * own work. Every fixture here that is meant to be found is named something else.
 */
import { describe, test, expect } from 'vitest';

import { scanRooms, reconstruct, refParts, choicesFrom } from './roomScan.js';
import rooms from '../../../refs/derived/roomCreator.json' with { type: 'json' };

/** A file as `readModAssets` shapes one. */
const asset = (name, type, raw) => ({
    file: `${name}.${type}`, type, patch: false,
    raw: { presetName: name, name, type, fileType: type, ...raw },
});

const patch = (name, fileType, patches) => ({
    file: name, type: fileType, patch: true,
    raw: { name, fileType, patches },
});

/**
 * A complete room, named nothing like the convention: `Nook` rather than `NookRC`, and a
 * class called `Alcove`. If the scanner finds this it is following references.
 */
const handWritten = [
    asset('Nook', 'RoomConfiguration', {
        copyFrom: 'REF:RoomConfiguration|Atrium',
        roomType: 'REF:RoomTypePreset|NookRoom',
        roomClass: 'REF:RoomClassPreset|Alcove',
    }),
    asset('Alcove', 'RoomClassPreset', { copyFrom: null }),
    asset('NookRoom', 'RoomTypePreset', { copyFrom: 'REF:RoomTypePreset|Atrium' }),
    asset('AlcoveThings', 'RoomTypeFilter', { roomClasses: ['REF:RoomClassPreset|Alcove'] }),
    patch('PicnicTable', 'FurnitureCluster', [
        { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|AlcoveThings' },
    ]),
    patch('PicnicBench', 'FurniturePreset', [
        { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|AlcoveThings' },
    ]),
    patch('PlainWall', 'RoomTypeFilter', [
        { op: 'add', path: '/roomClasses/-', value: 'REF:RoomClassPreset|Alcove' },
    ]),
    patch('AtriumLight', 'RoomLightingPreset', [
        { op: 'add', path: '/roomCompatibility/-', value: 'REF:RoomConfiguration|Nook' },
    ]),
];


describe('references', () => {
    test('are read apart, and anything else is not one', () => {
        expect(refParts('REF:RoomClassPreset|Alcove')).toEqual({ type: 'RoomClassPreset', name: 'Alcove' });

        // Four game assets have a space in the name, so a reference can too.
        expect(refParts('REF:FurniturePreset|OldTelevisionLarge 1'))
            .toEqual({ type: 'FurniturePreset', name: 'OldTelevisionLarge 1' });

        expect(refParts(null)).toBeNull();
        expect(refParts('Alcove')).toBeNull();
        expect(refParts({ m_FileID: 12 })).toBeNull();
    });
});


describe('a room nobody named by the convention', () => {
    const [room] = scanRooms(handWritten);

    test('is found by following its references', () => {
        expect(room.configuration).toBe('Nook');
        expect(room.roomClass).toBe('Alcove');
        expect(room.roomType).toBe('NookRoom');
        expect(room.donor).toBe('Atrium');
        expect(room.filters).toEqual(['AlcoveThings']);
    });

    test('has everything admitted to it read back', () => {
        expect(room.clusters).toEqual(['PicnicTable']);
        expect(room.presets).toEqual(['PicnicBench']);
        expect(room.surfaces).toEqual(['PlainWall']);
        expect(room.lighting).toEqual(['AtriumLight']);
    });

    test('reads as exact, because nothing was left over', () => {
        expect(room.verdict).toBe('exact');
        expect(room.unaccounted).toEqual([]);
    });

    test('comes back as the choices the pane holds', () => {
        expect(choicesFrom(room, rooms)).toEqual({
            name: 'NookRoom',
            donor: 'Atrium',
            clusters: ['PicnicTable'],
            lighting: ['AtriumLight'],
            surfaces: { walls: 'PlainWall' },
        });
    });
});


describe('a room with nothing admitted to it', () => {
    /**
     * The carbon-copy case: a configuration and a class, and nothing saying what furnishes
     * them. Not damaged -- it is one file plus a class, and what it admits is whatever its
     * donor already admits.
     */
    test('reads as identity rather than as a failure', () => {
        const [room] = scanRooms([
            asset('Bare', 'RoomConfiguration', {
                copyFrom: 'REF:RoomConfiguration|Atrium',
                roomType: 'REF:RoomTypePreset|BareRoom',
                roomClass: 'REF:RoomClassPreset|BareClass',
            }),
            asset('BareClass', 'RoomClassPreset', {}),
        ]);

        expect(room.verdict).toBe('identity');
        expect(room.clusters).toEqual([]);
    });
});


describe('what the scanner will not guess at', () => {
    test('a class the mod does not own is the base game’s, and says so', () => {
        const [room] = scanRooms([
            asset('Shared', 'RoomConfiguration', {
                roomType: 'REF:RoomTypePreset|SharedRoom',
                roomClass: 'REF:RoomClassPreset|Lobby',
            }),
        ]);

        expect(room.unaccounted[0]).toContain('Lobby is not one of this mod\'s assets');
        expect(room.unaccounted[0]).toContain('shares a room class with the base game');
    });

    test('a class named by two of the mod’s filters is reported, not chosen between', () => {
        const [room] = scanRooms([
            ...handWritten,
            asset('AlcoveExtras', 'RoomTypeFilter', { roomClasses: ['REF:RoomClassPreset|Alcove'] }),
        ]);

        expect(room.filters.sort()).toEqual(['AlcoveExtras', 'AlcoveThings']);
        expect(room.unaccounted.join(' ')).toContain('named by 2 of this mod\'s filters');
        expect(room.verdict).toBe('partial');
    });

    test('a filter carrying another class warns that the furniture reaches it too', () => {
        const files = handWritten.map((entry) => (entry.file === 'AlcoveThings.RoomTypeFilter'
            ? asset('AlcoveThings', 'RoomTypeFilter', {
                roomClasses: ['REF:RoomClassPreset|Alcove', 'REF:RoomClassPreset|Cellar'],
            })
            : entry));

        const [room] = scanRooms(files);

        expect(room.unaccounted.join(' ')).toContain('AlcoveThings also names Cellar');
        expect(room.verdict).toBe('partial');
    });

    /**
     * The older format states fields rather than operations, so there is nothing to read.
     * Reported rather than skipped, because it may be the very file admitting the
     * furniture -- a silent skip would show the author an empty room that is not empty.
     */
    test('a patch in the older format is reported when it mentions the room', () => {
        const [room] = scanRooms([
            ...handWritten,
            { file: 'OldStyle', type: 'FurnitureCluster', patch: true,
                raw: { name: 'OldStyle', fileType: 'FurnitureCluster', allowedRoomFilters: ['REF:RoomTypeFilter|AlcoveThings'] } },
        ]);

        expect(room.unaccounted.join(' ')).toContain('older whole-field format');
        expect(room.verdict).toBe('partial');
    });

    test('an old-format patch that says nothing about this room is left alone', () => {
        const [room] = scanRooms([
            ...handWritten,
            { file: 'Unrelated', type: 'FurnitureCluster', patch: true,
                raw: { name: 'Unrelated', fileType: 'FurnitureCluster', minimumRoomSize: 3 } },
        ]);

        expect(room.verdict).toBe('exact');
    });

    test('changes beside ours in the same file are counted', () => {
        const [room] = scanRooms([
            ...handWritten.filter((entry) => entry.file !== 'PicnicTable'),
            patch('PicnicTable', 'FurnitureCluster', [
                { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|AlcoveThings' },
                { op: 'replace', path: '/minimumRoomSize', value: 2 },
            ]),
        ]);

        expect(room.clusters).toEqual(['PicnicTable']);
        expect(room.unaccounted.join(' ')).toContain('carries 1 other change');
        expect(room.verdict).toBe('partial');
    });

    /**
     * A cluster shared between two of the mod's rooms is admitted to both filters from the
     * one file, which says nothing about this room that the room's own list does not
     * already say. Counting it would put a warning on the ordinary way of sharing furniture.
     */
    test('a second admission in the same file is not counted against this room', () => {
        const [room] = scanRooms([
            ...handWritten.filter((entry) => entry.file !== 'PicnicTable'),
            patch('PicnicTable', 'FurnitureCluster', [
                { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|AlcoveThings' },
                { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|SomewhereElse' },
            ]),
        ]);

        expect(room.clusters).toEqual(['PicnicTable']);
        expect(room.unaccounted).toEqual([]);
        expect(room.verdict).toBe('exact');
    });

    test('a change to the whole filter list is left uncounted the same way', () => {
        const [room] = scanRooms([
            ...handWritten.filter((entry) => entry.file !== 'PicnicTable'),
            patch('PicnicTable', 'FurnitureCluster', [
                { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|AlcoveThings' },
                { op: 'remove', path: '/allowedRoomFilters/0' },
            ]),
        ]);

        expect(room.unaccounted).toEqual([]);
        expect(room.verdict).toBe('exact');
    });

    test('a configuration naming no class can be traced no further', () => {
        const [room] = scanRooms([asset('Adrift', 'RoomConfiguration', {})]);

        expect(room.roomClass).toBeNull();
        expect(room.unaccounted[0]).toContain('does not name a room class');
        expect(room.verdict).toBe('identity');
    });
});


describe('a cloned cluster', () => {
    test('counts as admitted, the same as a patched one', () => {
        const [room] = scanRooms([
            ...handWritten,
            asset('Nook_PicnicTable', 'FurnitureCluster', {
                copyFrom: 'REF:FurnitureCluster|PicnicTable',
                allowedRoomFilters: ['REF:RoomTypeFilter|AlcoveThings'],
                limitToFloorRange: false,
            }),
        ]);

        expect(room.clusters).toContain('Nook_PicnicTable');
        expect(room.verdict).toBe('exact');
    });
});


describe('two rooms in one folder', () => {
    test('are found separately, and neither takes the other’s furniture', () => {
        const second = [
            asset('Vault', 'RoomConfiguration', {
                roomType: 'REF:RoomTypePreset|VaultRoom',
                roomClass: 'REF:RoomClassPreset|VaultClass',
            }),
            asset('VaultClass', 'RoomClassPreset', {}),
            asset('VaultThings', 'RoomTypeFilter', { roomClasses: ['REF:RoomClassPreset|VaultClass'] }),
            patch('FreestandingATM', 'FurnitureCluster', [
                { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|VaultThings' },
            ]),
        ];

        const found = scanRooms([...handWritten, ...second]);

        expect(found.map((room) => room.configuration)).toEqual(['Nook', 'Vault']);
        expect(found[0].clusters).toEqual(['PicnicTable']);
        expect(found[1].clusters).toEqual(['FreestandingATM']);
    });
});


describe('reconstruct', () => {
    test('is what scanRooms runs per configuration', () => {
        const configuration = handWritten[0];
        expect(reconstruct(handWritten, configuration)).toEqual(scanRooms(handWritten)[0]);
    });
});
