import { describe, it, expect } from 'vitest';
import { permissionOnly, PERMISSION_KINDS } from './roomPermissions.js';

/**
 * Which patches say nothing but "this room may use me".
 *
 * The file panel offers to leave these out, so what is decided here is which files an
 * author stops being shown -- and a file dropped from the browser is indistinguishable
 * from a file that is not in the folder. The bar is therefore that the patch does
 * *nothing else at all*: the moment it carries a second change, it is somebody's decision
 * and belongs on the screen.
 */

const admits = (path) => ({ op: 'add', path, value: 'REF:RoomTypeFilter|MyRoomRTF' });

describe('permissionOnly', () => {
    it('names a furniture patch that only admits a room', () => {
        const patch = { name: 'Bench', fileType: 'FurniturePreset', patches: [admits('/allowedRoomFilters/-')] };

        expect(permissionOnly(patch, 'FurniturePreset')).toBe('furniture');
        expect(permissionOnly({ ...patch, fileType: 'FurnitureCluster' }, 'FurnitureCluster'))
            .toBe('furniture');
    });

    it('names a surface or a light admitting a room', () => {
        // The other two thirds of what building a room writes: a material filter told to
        // cover the new class, and a light told the new configuration is compatible.
        expect(permissionOnly({ patches: [admits('/roomClasses/-')] }, 'RoomTypeFilter'))
            .toBe('surfaces');
        expect(permissionOnly({ patches: [admits('/roomCompatibility/-')] }, 'RoomLightingPreset'))
            .toBe('surfaces');
    });

    it('offers the two kinds the panel lists', () => {
        expect(PERMISSION_KINDS).toEqual(['furniture', 'surfaces']);
    });

    it('keeps a patch that changes anything besides the permission', () => {
        // The whole rule. This one admits the room *and* moves the preset's spawn chance,
        // which is an edit its author made and would go looking for.
        const patch = {
            fileType: 'FurniturePreset',
            patches: [admits('/allowedRoomFilters/-'), { op: 'replace', path: '/spawnChance', value: 2 }],
        };

        expect(permissionOnly(patch, 'FurniturePreset')).toBeNull();
    });

    it('counts every operation on the field, not just the first', () => {
        // A room's furniture is routinely admitted to more than one of a mod's filters,
        // and a cluster shared between two rooms carries a second add.
        const patch = {
            fileType: 'FurnitureCluster',
            patches: [admits('/allowedRoomFilters/-'), admits('/allowedRoomFilters/-')],
        };

        expect(permissionOnly(patch, 'FurnitureCluster')).toBe('furniture');
    });

    it('counts taking a permission away as one too', () => {
        // It says no more about the file than the add that granted it, and this is the
        // shape a room that has been unpicked leaves behind.
        const patch = {
            fileType: 'FurniturePreset',
            patches: [{ op: 'remove', path: '/allowedRoomFilters/0' }],
        };

        expect(permissionOnly(patch, 'FurniturePreset')).toBe('furniture');
    });

    it('keeps a patch that carries no operations at all', () => {
        // It modifies nothing, which is not the same as modifying only the one field --
        // and something about a patch that does nothing is worth an author seeing.
        expect(permissionOnly({ fileType: 'FurniturePreset', patches: [] }, 'FurniturePreset'))
            .toBeNull();
    });

    it('reads the whole-field format by the fields it states', () => {
        // The format this app replaced: fields written over the asset rather than
        // operations. The keys naming the target are the patch's, not the object's.
        expect(permissionOnly({
            name: 'Bench',
            fileType: 'FurniturePreset',
            allowedRoomFilters: ['REF:RoomTypeFilter|MyRoomRTF'],
        }, 'FurniturePreset')).toBe('furniture');

        expect(permissionOnly({
            name: 'Bench',
            fileType: 'FurniturePreset',
            allowedRoomFilters: ['REF:RoomTypeFilter|MyRoomRTF'],
            spawnChance: 2,
        }, 'FurniturePreset')).toBeNull();
    });

    it('reads the type it is given rather than the one the file states', () => {
        // A patch written by hand carries no fileType, and the panel recovers it from the
        // asset's name. That answer is the one to judge the operations against.
        expect(permissionOnly({ patches: [admits('/allowedRoomFilters/-')] }, 'FurniturePreset'))
            .toBe('furniture');

        // And the field has to belong to the type: a MurderMO has no room to admit
        // anything to, whatever a path in it happens to be called.
        expect(permissionOnly({ patches: [admits('/allowedRoomFilters/-')] }, 'MurderMO')).toBeNull();
    });

    it('does not confuse the two kinds of permission', () => {
        // Each type grants through one field. A furniture patch reaching for /roomClasses
        // is doing something this does not understand, so it stays on the screen.
        expect(permissionOnly({ patches: [admits('/roomClasses/-')] }, 'FurniturePreset')).toBeNull();
        expect(permissionOnly({ patches: [admits('/allowedRoomFilters/-')] }, 'RoomTypeFilter'))
            .toBeNull();
    });

    it('is not fooled by a field whose name starts the same way', () => {
        expect(permissionOnly({ patches: [admits('/allowedRoomFiltersOverride')] }, 'FurniturePreset'))
            .toBeNull();
    });

    it('answers nothing for what it cannot read', () => {
        expect(permissionOnly(null, 'FurniturePreset')).toBeNull();
        expect(permissionOnly({ patches: [admits('/allowedRoomFilters/-')] }, null)).toBeNull();
        expect(permissionOnly({ patches: [{ op: 'add' }] }, 'FurniturePreset')).toBeNull();
    });
});
