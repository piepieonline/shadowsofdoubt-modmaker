/**
 * Where a change to a ScriptableObject lands, and what happens to the file it lands on.
 *
 * Both creators write through this, so the rows below are the whole of what either of them
 * can do to a folder. Three of them are bugs that had already happened:
 *
 * - an addition aimed at an asset the mod declares as a file of its own, which used to be
 *   written as a patch and would apply or not depending on the load order;
 * - a save that rebuilt one of this tool's own files from its model, throwing away every
 *   field it has no control for;
 * - a file that will not parse, merged into as though it were empty.
 */
import { describe, test, expect } from 'vitest';

import {
    addTo, commit, indexMod, landAll, mergeOps, mergeOwned, ownAsset, stemOf, takeOut, withdrawOps,
} from './soBuilder.js';

import { MANIFEST_FILE } from './murderManifest.js';

/** One file as `readModFiles` reports it. */
const asset = (name, fileType, raw = {}) => ({
    fileName: `${name}.${fileType}.sodso.json`,
    file: `${name}.${fileType}`,
    name,
    type: fileType,
    patch: false,
    raw: { presetName: name, name, fileType, ...raw },
});

const patchFile = (name, fileType, patches, fileName = `${name}.sodso_patch.json`) => ({
    fileName,
    file: fileName.replace('.sodso_patch.json', ''),
    name,
    type: fileType,
    patch: true,
    raw: { name, fileType, patches },
});

const folder = (files = [], unreadable = []) => indexMod({
    files,
    unreadable,
    present: [...files.map((entry) => entry.fileName), ...unreadable],
});

const admit = (name, type) => addTo({
    asset: name,
    type,
    ops: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|NookRTF' }],
});

const mine = (operation) => operation?.value === 'REF:RoomTypeFilter|NookRTF';

const land = (change, index, own = new Set()) => landAll([change], index, { own })[0];


describe('a file of the flow’s own', () => {
    const change = () => ownAsset({
        asset: 'NookRC',
        type: 'RoomConfiguration',
        owns: ['fileType', 'name', 'presetName', 'copyFrom', 'roomClass'],
        content: {
            fileType: 'RoomConfiguration', name: 'NookRC', presetName: 'NookRC', roomClass: 'REF:RoomClassPreset|NookRCP',
        },
    });

    test('is created where the folder has nothing', () => {
        const wanted = change();
        const landed = land(wanted, folder());

        expect(landed.action).toBe('create');
        expect(landed.file).toBe('NookRC.RoomConfiguration.sodso.json');
        expect(landed.content).toBe(wanted.content);
    });

    /** The whole point of owning fields by name: everything else is somebody's decision. */
    test('keeps what it does not own when it is the flow’s to save', () => {
        const held = asset('NookRC', 'RoomConfiguration', {
            copyFrom: 'REF:RoomConfiguration|Atrium',
            securityDoors: 2,
            somethingNothingHereHasHeardOf: 42,
        });

        const landed = land(change(), folder([held]), new Set([held.fileName]));

        expect(landed.action).toBe('merge');
        expect(landed.content.securityDoors).toBe(2);
        expect(landed.content.somethingNothingHereHasHeardOf).toBe(42);
        expect(landed.content.roomClass).toBe('REF:RoomClassPreset|NookRCP');
    });

    /**
     * An owned field the save no longer states is removed rather than left underneath. That
     * is why the list is written out by name and not taken from the object being written: a
     * `copyFrom` being removed is absent from that object.
     */
    test('clears an owned field the change no longer states', () => {
        const held = asset('NookRC', 'RoomConfiguration', { copyFrom: 'REF:RoomConfiguration|Atrium' });
        const landed = land(change(), folder([held]), new Set([held.fileName]));

        expect(landed.content).not.toHaveProperty('copyFrom');
    });

    test('is a clash when the file is not the flow’s to save', () => {
        const landed = land(change(), folder([asset('NookRC', 'RoomConfiguration')]));

        expect(landed.action).toBe('clash');
        expect(landed.reason).toContain('belongs to something else');
    });

    /**
     * A file whose contents name something else is not this flow's, whatever it is called.
     * Merging into it on the strength of the name is how a save replaces somebody's work
     * while reporting that it saved.
     */
    test('is a clash when a file of that name declares another asset', () => {
        const impostor = {
            ...asset('Something', 'RoomConfiguration'),
            fileName: 'NookRC.RoomConfiguration.sodso.json',
        };

        const landed = land(change(), folder([impostor]), new Set([impostor.fileName]));

        expect(landed.action).toBe('clash');
    });

    /** Written once and never again: after that the flow owns nothing in it. */
    test('is left alone once it exists when it is create-only', () => {
        const cluster = ownAsset({
            asset: 'MyDeskFCL',
            type: 'FurnitureCluster',
            content: { fileType: 'FurnitureCluster', name: 'MyDeskFCL' },
            createOnly: true,
        });

        const held = asset('MyDeskFCL', 'FurnitureCluster', { clusterElements: [{}, {}] });

        expect(land(cluster, folder(), new Set()).action).toBe('create');
        expect(land(cluster, folder([held]), new Set([held.fileName])).action).toBe('leave');
    });

    /** Merging into a file this cannot read would silently drop all of it. */
    test('refuses a file that will not parse', () => {
        const landed = land(change(), folder([], ['NookRC.RoomConfiguration.sodso.json']));

        expect(landed.action).toBe('refuse');
        expect(landed.reason).toContain('will not parse');
    });
});


describe('an addition to somebody else’s asset', () => {
    test('is a new patch where the folder has nothing', () => {
        const landed = land(admit('PicnicTable', 'FurnitureCluster'), folder());

        expect(landed.action).toBe('create');
        expect(landed.file).toBe('PicnicTable.sodso_patch.json');
        expect(landed.content).toEqual({
            name: 'PicnicTable',
            fileType: 'FurnitureCluster',
            patches: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|NookRTF' }],
        });
    });

    /**
     * Two rooms admitting one cluster genuinely both want to change it. Replacing the file
     * would silently un-admit the first room's furniture.
     */
    test('is added to a patch that is already there', () => {
        const held = patchFile('PicnicTable', 'FurnitureCluster', [
            { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|VaultRTF' },
        ]);

        const landed = land(admit('PicnicTable', 'FurnitureCluster'), folder([held]));

        expect(landed.action).toBe('append');
        expect(landed.added).toBe(1);
        expect(landed.content.patches).toHaveLength(2);
    });

    /**
     * The bug this module was written for. A mod that declares `PicnicTable` *and* patches
     * it is asking the load order which of the two the patch lands on, and the load order is
     * a list the author maintains by hand.
     */
    test('is left to the author when the mod declares that asset itself', () => {
        const held = asset('PicnicTable', 'FurnitureCluster', {
            copyFrom: 'REF:FurnitureCluster|PicnicTable',
            allowedRoomFilters: [],
        });

        const landed = land(admit('PicnicTable', 'FurnitureCluster'), folder([held]));

        expect(landed.action).toBe('leave');
        expect(landed.file).toBe(held.fileName);
        expect(landed.reason).toContain('load order');
    });

    /**
     * Names belonging to two types are the ordinary case in this game's data, so the asset
     * and the patch are looked up by both. A declared cluster says nothing about a preset of
     * the same name.
     */
    test('still patches a preset whose name the mod declares as a cluster', () => {
        const held = asset('SecurityDoorDouble', 'FurnitureCluster');
        const landed = land(admit('SecurityDoorDouble', 'FurniturePreset'), folder([held]));

        expect(landed.action).toBe('create');
    });

    /**
     * The patch is landed on under whatever it is called rather than under the name this
     * change would have given a new one. Otherwise a folder holding the other spelling gets
     * a second file admitting the same thing, and taking the room back out later would find
     * only one of them.
     */
    test('lands on an existing patch whatever it is named', () => {
        const held = patchFile(
            'BreakerBox', 'FurnitureCluster', [],
            'BreakerBox.FurnitureCluster.sodso_patch.json',
        );

        const landed = land(addTo({
            asset: 'BreakerBox', type: 'FurnitureCluster', ops: [], shared: false,
        }), folder([held]));

        expect(landed.file).toBe('BreakerBox.FurnitureCluster.sodso_patch.json');
    });

    test('refuses a patch written in the format this app replaced', () => {
        const older = {
            fileName: 'PicnicTable.sodso_patch.json',
            file: 'PicnicTable',
            name: 'PicnicTable',
            type: 'FurnitureCluster',
            patch: true,
            raw: { name: 'PicnicTable', fileType: 'FurnitureCluster', allowedRoomFilters: [] },
        };

        const landed = land(admit('PicnicTable', 'FurnitureCluster'), folder([older]));

        expect(landed.action).toBe('refuse');
        expect(landed.reason).toContain('older whole-field format');
    });

    /** A name that turned out to be ambiguous after all, rather than a merge gone wrong. */
    test('refuses a file of that name holding something else', () => {
        const held = patchFile('BreakerBox', 'FurniturePreset', []);
        const landed = land(admit('BreakerBox', 'FurnitureCluster'), folder([held]));

        expect(landed.action).toBe('refuse');
        expect(landed.reason).toContain('patches something else');
    });
});


describe('taking a flow’s own operations back out', () => {
    test('leaves a patch that is not there', () => {
        const landed = land(takeOut({ asset: 'PicnicTable', type: 'FurnitureCluster', ours: mine }), folder());

        expect(landed.action).toBe('leave');
    });

    test('keeps everybody else’s and writes the rest back', () => {
        const held = patchFile('PicnicTable', 'FurnitureCluster', [
            { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|NookRTF' },
            { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|VaultRTF' },
        ]);

        const landed = land(takeOut({ asset: 'PicnicTable', type: 'FurnitureCluster', ours: mine }), folder([held]));

        expect(landed.action).toBe('append');
        expect(landed.removed).toBe(1);
        expect(landed.content.patches).toEqual([
            { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|VaultRTF' },
        ]);
    });

    /** A patch saying nothing is a puzzle for whoever reads the folder next. */
    test('drops a file left with nothing in it', () => {
        const held = patchFile('PicnicTable', 'FurnitureCluster', [
            { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|NookRTF' },
        ]);

        const landed = land(takeOut({ asset: 'PicnicTable', type: 'FurnitureCluster', ours: mine }), folder([held]));

        expect(landed.action).toBe('delete');
    });

    test('leaves a patch holding none of this flow’s operations', () => {
        const held = patchFile('PicnicTable', 'FurnitureCluster', [
            { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|VaultRTF' },
        ]);

        expect(land(takeOut({ asset: 'PicnicTable', type: 'FurnitureCluster', ours: mine }), folder([held])).action)
            .toBe('leave');
    });

    /** A mod's own asset is never edited from here, in either direction. */
    test('leaves an asset the mod declares alone', () => {
        const held = asset('PicnicTable', 'FurnitureCluster', { allowedRoomFilters: ['REF:RoomTypeFilter|NookRTF'] });

        expect(land(takeOut({ asset: 'PicnicTable', type: 'FurnitureCluster', ours: mine }), folder([held])).action)
            .toBe('leave');
    });
});


describe('the merges, on their own', () => {
    test('an owned merge with nothing to merge into is the content itself', () => {
        const content = { fileType: 'X', name: 'Y' };

        expect(mergeOwned(null, content, ['name'])).toBe(content);
        expect(mergeOwned({ a: 1 }, content, null)).toBe(content);
    });

    test('adding the same operation twice changes nothing', () => {
        const ops = [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|NookRTF' }];
        const once = mergeOps({ name: 'X', fileType: 'FurnitureCluster', patches: [] }, ops);
        const twice = mergeOps(once.content, ops);

        expect(once.added).toBe(1);
        expect(twice.added).toBe(0);
        expect(twice.content.patches).toEqual(once.content.patches);
    });

    test('carries every other key of the file through untouched', () => {
        const merged = mergeOps({ name: 'X', fileType: 'FurnitureCluster', patches: [], note: 'keep me' }, []);

        expect(merged.content.note).toBe('keep me');
    });

    test('withdrawing from a file with no operations at all removes nothing', () => {
        expect(withdrawOps({ name: 'X' }, mine)).toEqual({
            content: { name: 'X', patches: [] }, removed: 0, empty: true,
        });
    });
});


describe('the manifest names files rather than assets', () => {
    test('and names them without their suffix', () => {
        expect(stemOf('PicnicTable.sodso_patch.json')).toBe('PicnicTable');
        expect(stemOf('NookRC.RoomConfiguration.sodso.json')).toBe('NookRC.RoomConfiguration');
        expect(stemOf('murdermanifest.sodso.json')).toBe('murdermanifest');
    });
});


/**
 * A directory handle enough like the real one for `core/fs.js`.
 *
 * Written here rather than mocked, because what is being checked is the order the folder is
 * touched in: every file before the manifest, so a failure part way through leaves assets
 * the loader never reaches rather than a load order naming files that are not there.
 */
function fakeFolder(initial = {}) {
    const files = new Map(Object.entries(initial));
    const touched = [];

    const handleFor = (name) => ({
        getFile: async () => ({ text: async () => files.get(name), size: (files.get(name) ?? '').length }),
        createWritable: async () => ({
            write: async (contents) => { files.set(name, contents); touched.push(name); },
            seek: () => {},
            close: async () => {},
        }),
    });

    return {
        files,
        touched,

        async getFileHandle(name, { create } = {}) {
            if (!files.has(name) && !create) {
                throw Object.assign(new Error('no such file'), { name: 'NotFoundError' });
            }

            if (!files.has(name)) files.set(name, '');
            return handleFor(name);
        },

        async removeEntry(name) {
            if (!files.delete(name)) throw Object.assign(new Error('no such file'), { name: 'NotFoundError' });
            touched.push(`-${name}`);
        },
    };
}

const read = (dir, name) => JSON.parse(dir.files.get(name));


describe('committing what landed', () => {
    const changes = () => [
        ownAsset({
            asset: 'NookRCP',
            type: 'RoomClassPreset',
            owns: ['fileType', 'name'],
            content: { fileType: 'RoomClassPreset', name: 'NookRCP' },
        }),
        admit('PicnicTable', 'FurnitureCluster'),
    ];

    test('writes every file, then the manifest, and lists what it wrote', async () => {
        const dir = fakeFolder();
        const result = await commit(dir, landAll(changes(), folder()));

        expect(result.written).toHaveLength(2);
        expect(dir.touched).toEqual([
            'NookRCP.RoomClassPreset.sodso.json',
            'PicnicTable.sodso_patch.json',
            MANIFEST_FILE,
        ]);

        expect(read(dir, MANIFEST_FILE).fileOrder).toEqual([
            'REF:NookRCP.RoomClassPreset',
            'REF:PicnicTable',
        ]);
    });

    /**
     * A flow that wrote half a room would leave a mod that does not load, and the half it
     * wrote is the half that makes the rest unmergeable.
     */
    test('writes nothing at all when one change cannot be made', async () => {
        const dir = fakeFolder();
        const held = asset('NookRCP', 'RoomClassPreset');
        const result = await commit(dir, landAll(changes(), folder([held])));

        expect(result.refused).toHaveLength(1);
        expect(dir.touched).toEqual([]);
        expect(dir.files.size).toBe(0);
    });

    test('leaves a file it was told to leave, and does not list it', async () => {
        const dir = fakeFolder();
        const held = asset('PicnicTable', 'FurnitureCluster');
        const result = await commit(dir, landAll(changes(), folder([held])));

        expect(result.left.map((item) => item.file)).toEqual(['PicnicTable.FurnitureCluster.sodso.json']);
        expect(dir.files.has('PicnicTable.FurnitureCluster.sodso.json')).toBe(false);
        expect(read(dir, MANIFEST_FILE).fileOrder).toEqual(['REF:NookRCP.RoomClassPreset']);
    });

    /** A file that has gone must stop being named, or the loader goes looking for it. */
    test('removes an emptied patch and takes its listing with it', async () => {
        const dir = fakeFolder({
            'murdermanifest.sodso.json': JSON.stringify({
                enabled: true, fileOrder: ['REF:PicnicTable'], loadBefore: '', version: 1,
            }),
            'PicnicTable.sodso_patch.json': '{}',
        });

        const held = patchFile('PicnicTable', 'FurnitureCluster', [
            { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|NookRTF' },
        ]);

        const landed = landAll(
            [takeOut({ asset: 'PicnicTable', type: 'FurnitureCluster', ours: mine })],
            folder([held]),
        );

        const result = await commit(dir, landed);

        expect(result.removed).toHaveLength(1);
        expect(dir.files.has('PicnicTable.sodso_patch.json')).toBe(false);
        expect(read(dir, MANIFEST_FILE).fileOrder).toEqual([]);
    });

    /** The manifest is the author's file too: unreadable is left alone rather than replaced. */
    test('says so and stops when the manifest will not parse', async () => {
        const dir = fakeFolder({ 'murdermanifest.sodso.json': 'not json' });
        const result = await commit(dir, landAll(changes(), folder()));

        expect(result.malformed).toBe(true);
        expect(dir.files.get('murdermanifest.sodso.json')).toBe('not json');
        expect(result.written).toHaveLength(2);
    });
});
