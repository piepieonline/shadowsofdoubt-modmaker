/**
 * Patches that do nothing but let a room use something.
 *
 * Building one room writes a great many files, and almost none of them are about that
 * room. A room admits furniture by patching every cluster and every preset in its closure
 * to name the room's filter, its surfaces by patching each material filter to name the
 * room's class, and its lighting by patching each light to name the configuration -- see
 * `roomPlan.js`. Thirty rooms' worth of that buries the six files an author actually
 * writes, and the panel is where they go looking for them.
 *
 * So the file panel offers to leave them out. What makes a file safe to leave out is that
 * it says nothing except "this room may use me": the moment a patch carries anything
 * else, it is somebody's decision and belongs on the screen. That is the whole rule here,
 * and it is why this asks what a patch does rather than what it is called -- the suffix
 * convention in `roomPlan.js` is a convenience for the author, and a room somebody
 * assembled by hand has none. Same reasoning as `roomScan.js`.
 *
 * Two kinds, because they are two questions an author asks separately:
 *
 * | | What it covers |
 * |---|---|
 * | `furniture` | a `FurnitureCluster` or `FurniturePreset` admitted through `allowedRoomFilters` |
 * | `surfaces` | a `RoomTypeFilter` admitting a room class, a `RoomLightingPreset` admitting a configuration |
 *
 * Nothing here hides a file the mod *defines*. An asset of the mod's own states its whole
 * self -- a cloned cluster carries its `copyFrom` and its contents -- so it is not a
 * permission and never matches; only the patch form is asked about. See `contentList.js`,
 * which asks this of patches alone.
 */
import { ENVELOPE_KEYS } from '../../../core/patchFormat.js';

/**
 * The field a permission is granted through, by the type granting it, by the kind of
 * permission it is.
 *
 * A type appears once. Both halves of a room's furniture are admitted through the same
 * field, which is the field's job -- what differs is the type being let in.
 */
const GRANTS = {
    furniture: {
        FurnitureCluster: 'allowedRoomFilters',
        FurniturePreset: 'allowedRoomFilters',
    },
    surfaces: {
        RoomTypeFilter: 'roomClasses',
        RoomLightingPreset: 'roomCompatibility',
    },
};

/** The kinds the panel can be asked to leave out, in the order it offers them. */
export const PERMISSION_KINDS = Object.keys(GRANTS);

/**
 * Whether a path names `field` -- the whole of it, or an element of it.
 *
 * Path-based rather than keyed on `op`, so a patch that *takes* a room's permission away
 * counts as one too. It says no more about the file than the one that granted it, and an
 * author reading a list of what their mod does has the same interest in seeing neither.
 */
const touches = (path, field) => typeof path === 'string'
    && (path === `/${field}` || path.startsWith(`/${field}/`));

/** The kind of permission this type grants, and the field it grants it through. */
function grantOf(type) {
    for (const [kind, types] of Object.entries(GRANTS)) {
        if (type in types) return [kind, types[type]];
    }

    return [null, null];
}

/**
 * Every operation grants the permission, and there is at least one that does.
 *
 * The empty list is not a permission. `[].every()` is true, and a patch carrying no
 * operations modifies nothing at all -- which is a file worth seeing, since something
 * about it is wrong.
 */
const operationsOnly = (patches, field) =>
    patches.length > 0 && patches.every((operation) => touches(operation?.path, field));

/**
 * The whole-field format, which states fields rather than operations: the one field, and
 * nothing beside it.
 *
 * The keys naming the target are not fields of the asset -- see ENVELOPE_KEYS -- so a
 * patch is read as what it states about the object, exactly as `mergeOldFormat` reads it.
 */
function fieldsOnly(parsed, field) {
    const stated = Object.keys(parsed).filter((key) => !ENVELOPE_KEYS.includes(key));

    return stated.length === 1 && stated[0] === field;
}

/**
 * Which kind of permission a patch is, or null if it is anything more than one.
 *
 * @param parsed the patch file, in either format
 * @param type   the type it patches, as `contentList.js` worked it out -- which is not
 *               always `parsed.fileType`: a patch written by hand carries none, and the
 *               asset's name is what settles it
 */
export function permissionOnly(parsed, type) {
    if (!parsed || typeof parsed !== 'object' || !type) return null;

    const [kind, field] = grantOf(type);
    if (!field) return null;

    const only = Array.isArray(parsed.patches)
        ? operationsOnly(parsed.patches, field)
        : fieldsOnly(parsed, field);

    return only ? kind : null;
}
