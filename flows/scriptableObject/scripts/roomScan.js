/**
 * Finding the rooms a mod already holds, and working out what they admit.
 *
 * Nothing a room is made of records that it is a room. Four assets and a scatter of
 * patches sit in the folder alongside everything else, and what makes them one thing is
 * the references between them. So this follows those references and never reads a name:
 * a room this tool wrote and a room somebody assembled by hand are the same shape to it,
 * and the suffix convention in `roomPlan.js` is a convenience for the author rather than
 * something to key on.
 *
 * That is the whole design. A scanner that looked for `*RCP` would find only its own work,
 * which is the opposite of useful -- the rooms most worth opening are the ones somebody
 * else built and cannot remember the shape of.
 *
 * ## What it cannot know
 *
 * Plenty, and it says so rather than guessing. A room whose class sits in two filters, a
 * patch written in the format this app replaced, an operation no version of this tool
 * emits -- each comes back in `unaccounted` with a sentence about it. `verdict` sums that
 * up in one word:
 *
 * | | |
 * |---|---|
 * | `exact` | every file that touches this room was understood |
 * | `partial` | the room was reconstructed, and something beside it was not understood |
 * | `identity` | the four assets are there and nothing says what furnishes them |
 *
 * An `identity` verdict is the normal state of a carbon-copy room -- a `RoomTypePreset`
 * that forces a shipped configuration, which is one file and admits whatever that
 * configuration already admits. It is not a damaged room.
 */

/** `REF:Type|Name` as its parts, or null for anything else. */
export function refParts(value) {
    if (typeof value !== 'string') return null;

    const match = /^REF:([A-Za-z]+)\|(.+)$/.exec(value.trim());
    return match ? { type: match[1], name: match[2] } : null;
}

/** The name a `REF:` points at, when it is of this type. */
const refTo = (value, type) => {
    const parts = refParts(value);
    return parts && parts.type === type ? parts.name : null;
};

/**
 * Whether an operation touches `allowedRoomFilters` at all, whichever filter it names.
 *
 * A cluster is let into as many filters as the author wants it in, and every one of those
 * beside this room's is a room somewhere else in the mod. That is the field doing its job,
 * so none of it is counted as something left unaccounted for -- see the count below.
 */
const touchesFilters = (operation) => typeof operation?.path === 'string'
    && (operation.path === '/allowedRoomFilters'
        || operation.path.startsWith('/allowedRoomFilters/'));

/**
 * The rooms a folder holds.
 *
 * A room is a `RoomConfiguration` the mod owns. That is the one asset the running game
 * reads and the one every other part of the room points at or is pointed at by, so it is
 * the only sound thing to enumerate from.
 *
 * @param files `[{ file, type, patch, raw }]`, as read from the content folder
 */
export function scanRooms(files) {
    return files
        .filter((entry) => !entry.patch && entry.type === 'RoomConfiguration')
        .map((entry) => reconstruct(files, entry))
        .sort((a, b) => a.configuration.localeCompare(b.configuration));
}

/**
 * What one room is made of, and what could not be accounted for.
 *
 * Walks outwards from the configuration: to its class, to whichever filters name that
 * class, and to everything admitted through those filters.
 */
export function reconstruct(files, configuration) {
    const raw = configuration.raw ?? {};
    const name = raw.presetName ?? raw.name ?? configuration.file;

    const unaccounted = [];
    const owns = (type, assetName) => files.some((entry) => !entry.patch && entry.type === type
        && (entry.raw?.presetName ?? entry.raw?.name) === assetName);

    const roomClass = refTo(raw.roomClass, 'RoomClassPreset');
    const roomType = refTo(raw.roomType, 'RoomTypePreset');
    const donor = refTo(raw.copyFrom, 'RoomConfiguration');

    if (!roomClass) {
        unaccounted.push(`${name} does not name a room class, so nothing can be traced from it.`);
    } else if (!owns('RoomClassPreset', roomClass)) {
        // Legal, and worth saying: the room reuses a shipped class, so it already admits
        // whatever that class admits and adding to it would move every vanilla room too.
        unaccounted.push(`${roomClass} is not one of this mod's assets, so this room shares a `
            + 'room class with the base game and what furnishes it is not this room\'s to change.');
    }

    // Every filter of the mod's that names this class. More than one is legal and is the
    // author's business; it is reported because a patch admitting something to one of
    // them admits it to this room and this tool cannot say which was meant.
    const filters = !roomClass ? [] : files
        .filter((entry) => !entry.patch && entry.type === 'RoomTypeFilter'
            && (entry.raw?.roomClasses ?? []).some((value) => refTo(value, 'RoomClassPreset') === roomClass))
        .map((entry) => entry.raw?.presetName ?? entry.raw?.name ?? entry.file);

    if (roomClass && filters.length > 1) {
        unaccounted.push(`${roomClass} is named by ${filters.length} of this mod's filters `
            + `(${filters.join(', ')}), so what reaches this room is the union of all of them.`);
    }

    // A filter carrying other classes admits this room's furniture to those too.
    for (const filter of filters) {
        const entry = files.find((item) => !item.patch && item.type === 'RoomTypeFilter'
            && (item.raw?.presetName ?? item.raw?.name) === filter);

        const classes = (entry?.raw?.roomClasses ?? []).map((value) => refTo(value, 'RoomClassPreset'));
        const others = classes.filter((each) => each && each !== roomClass);

        if (others.length) {
            unaccounted.push(`${filter} also names ${others.join(', ')}, so anything admitted `
                + 'through it reaches those rooms as well.');
        }
    }

    const filterRefs = new Set(filters.map((filter) => `REF:RoomTypeFilter|${filter}`));
    const classRef = `REF:RoomClassPreset|${roomClass}`;
    const configRef = `REF:RoomConfiguration|${name}`;

    /** An operation letting something into this room: through a filter, its class, or itself. */
    const admitsThisRoom = (operation) => operation?.op === 'add' && (
        (operation.path === '/allowedRoomFilters/-' && filterRefs.has(operation.value))
        || (operation.path === '/roomClasses/-' && operation.value === classRef)
        || (operation.path === '/roomCompatibility/-' && operation.value === configRef));

    const clusters = new Set();
    const presets = new Set();
    const surfaces = new Set();
    const lighting = new Set();

    for (const entry of files) {
        if (entry === configuration) continue;

        if (entry.patch) {
            // A patch in the format this app replaced states fields rather than
            // operations, so there is nothing to read here. Reported, not skipped -- it
            // may be the very file that admits this room's furniture.
            if (!Array.isArray(entry.raw?.patches)) {
                if (touchesText(entry.raw, roomClass, name)) {
                    unaccounted.push(`${entry.file} mentions this room but is written in the older `
                        + 'whole-field format, so what it does cannot be read here.');
                }
                continue;
            }

            const mine = entry.raw.patches.filter(admitsThisRoom);

            if (!mine.length) continue;

            for (const operation of mine) {
                if (operation.path === '/allowedRoomFilters/-') {
                    (entry.raw.fileType === 'FurnitureCluster' ? clusters : presets).add(entry.raw.name ?? entry.file);
                }
                if (operation.path === '/roomClasses/-') surfaces.add(entry.raw.name ?? entry.file);
                if (operation.path === '/roomCompatibility/-') lighting.add(entry.raw.name ?? entry.file);
            }

            // Anything else in a file that touches this room is somebody's decision this
            // tool did not make and must not quietly drop. Other admissions are the
            // exception: a cluster let into a second filter is the ordinary way of sharing
            // furniture, it does nothing to this room, and counting it only says that the
            // file is used twice -- true, and no help to somebody reading this room.
            const rest = entry.raw.patches
                .filter((operation) => !admitsThisRoom(operation) && !touchesFilters(operation))
                .length;
            if (rest > 0) {
                unaccounted.push(`${entry.file} carries ${rest} other `
                    + `${rest === 1 ? 'change' : 'changes'} beside the one admitting this room.`);
            }

            continue;
        }

        // One of the mod's own clusters admitted only to this room is a clone, which is
        // what the writer produces when a shipped cluster's gates conflict.
        if (entry.type === 'FurnitureCluster') {
            const admits = (entry.raw?.allowedRoomFilters ?? []).some((value) => filterRefs.has(value));
            if (admits) clusters.add(entry.raw?.presetName ?? entry.raw?.name ?? entry.file);
        }
    }

    const verdict = decide({ filters, clusters, presets, surfaces, lighting, unaccounted });

    return {
        configuration: name,
        file: configuration.file,
        roomType,
        roomClass,
        donor,
        filters,
        clusters: [...clusters].sort(),
        presets: [...presets].sort(),
        surfaces: [...surfaces].sort(),
        lighting: [...lighting].sort(),
        unaccounted,
        verdict,
    };
}

function decide({ filters, clusters, surfaces, lighting, unaccounted }) {
    const nothingAdmitted = !filters.length
        || (!clusters.size && !surfaces.size && !lighting.size);

    if (nothingAdmitted) return 'identity';
    return unaccounted.length ? 'partial' : 'exact';
}

/** Whether an unreadable file mentions the room at all, so it is worth reporting. */
function touchesText(raw, roomClass, configuration) {
    const text = JSON.stringify(raw ?? {});
    return (roomClass && text.includes(roomClass)) || text.includes(configuration);
}

/**
 * A reconstructed room as the choices the pane holds.
 *
 * Surfaces come back keyed by which surface they supply, which the file itself does not
 * say -- a `RoomTypeFilter` patch looks the same whether it was picked for walls or for a
 * floor. The reference data is what settles it, and a filter that supplies more than one
 * surface is put against the first it fits, which is a guess and is left to the author to
 * correct.
 */
export function choicesFrom(room, rooms) {
    const surfaces = {};

    for (const filter of room.surfaces) {
        for (const surface of ['walls', 'floor', 'ceiling']) {
            if (rooms?.filters?.[filter]?.[surface] && !surfaces[surface]) {
                surfaces[surface] = filter;
                break;
            }
        }
    }

    return {
        name: room.roomType ?? room.configuration,
        donor: room.donor ?? '',
        clusters: room.clusters,
        lighting: room.lighting,
        surfaces,
    };
}
