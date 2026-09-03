/**
 * The changes a room comes to, worked out before any of them is written.
 *
 * A room is four assets and a patch per thing admitted, and a half-written set is a mod
 * that will not load. So the whole set is decided here, as data, and `core/soBuilder.js`
 * decides where each one lands and is the only part that touches a folder. That split is
 * what lets the pane show the author exactly what it is about to do, and lets the decision
 * be tested without a filesystem.
 *
 * ## Load order is dependency order
 *
 * `fileOrder` is linear and every `REF:` in a file must already have loaded, so the four
 * assets go first in the order they reference each other, then everything that references
 * them:
 *
 *     RCP -> RTF -> RTP -> RC -> clusters -> closure presets -> surfaces -> lighting
 *
 * **The `RoomTypePreset` must not set `forceConfiguration`.** It would point at the
 * `RoomConfiguration`, whose `roomType` points back, and a linear order cannot express the
 * ring -- the loader fails with `<name> failed to load, <ref> doesn't exist!`. On a
 * hand-built floor nothing needs it: the node's own forced-room reference names the
 * configuration directly.
 *
 * ## What a room may write, and what it may not
 *
 * Its own four assets, and one additive operation on each shipped asset it admits:
 * `allowedRoomFilters` for furniture, `roomClasses` for a surface filter,
 * `roomCompatibility` for a light. Nothing else, ever.
 *
 * This used to do more. A cluster whose gates refuse the room -- `PicnicTable` is limited
 * to floors -1 to 0, so a room three storeys up cannot have one -- was cloned into a file
 * of the mod's own with the offending gate relaxed. It was the right shape and the wrong
 * thing: the clone came back out of the folder under its own name, which the reference data
 * has never heard of, and the next save wrote a patch aimed at the mod's own file. So the
 * relaxing is the author's now. The room says which gate refuses what, and copying the
 * cluster to relax it is a thing they do by hand and keep.
 *
 * ## Naming
 *
 * The `RoomTypePreset` takes the bare room name and the other three take suffixes. It is
 * the only one of the four that surfaces where an author browses -- the floorplan editor's
 * room picker lists it, and a blueprint stores it as a plain string -- so it is the only
 * one whose name is read by a human in normal use. This diverges from the templates on the
 * export server, which suffix all four.
 */
import { patchFileNameFor } from '../../../core/soFileName.js';
import { admits, closures, importantElements } from '../../../core/spawnRules.js';
import { addTo, ownAsset } from '../../../core/soBuilder.js';

/**
 * The four types a room patches, and where the reference data lists each one's names.
 *
 * Only these four. Whether a name is ambiguous is a question about the assets this tool
 * would ever write a patch for -- a `FurnitureCluster` called `Bar` and an `AddressPreset`
 * called `Bar` never contend for a file here, because a room has no reason to patch an
 * address.
 */
const PATCHED_TYPES = [
    ['FurnitureCluster', (rooms, chain) => chain?.clusters],
    ['FurniturePreset', (rooms, chain) => chain?.furniture],
    ['RoomTypeFilter', (rooms, chain) => chain?.filters],
    ['RoomLightingPreset', (rooms) => rooms?.lighting],
];

/**
 * The names that belong to more than one of the types a room patches.
 *
 * 86 of them, and not a curiosity: `SecurityDoorDouble` is a cluster and the preset that
 * fills its own most important slot, so admitting that one cluster wants both patches at
 * once. 71 clusters are in exactly that state and only four of the game's 76 furnishable
 * configurations are free of it. `BreakerBox` and `WallClock` name three of the four types.
 *
 * Derived rather than listed, so a game update that makes another name ambiguous is
 * followed by the naming rather than quietly breaking it.
 */
export function sharedNames(rooms, chain) {
    const counts = new Map();

    for (const [, where] of PATCHED_TYPES) {
        for (const name of Object.keys(where(rooms, chain) ?? {})) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    }

    return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

/** What a patch of one of the room's targets is called, given those names. */
export const patchFileOf = (shared, name, type) => patchFileNameFor(name, type, shared.has(name));

/**
 * The furniture a set of clusters could resolve, which is what admitting all of them
 * would let in. The default when an author has not narrowed it.
 */
export function fullClosure(chain, clusters) {
    const closure = closures(chain);
    return [...new Set(clusters.flatMap((name) => closure[name] ?? []))].sort();
}

/**
 * Clusters that would be abandoned by the furniture chosen, and why.
 *
 * A cluster puts down a slot per element, and an element marked `importantToCluster`
 * that resolves to no preset abandons the **whole cluster placement** -- not just that
 * slot. There is no error; one debug line is logged. So narrowing the furniture is not a
 * safe operation to do quietly: unticking the only chair a booth can use loses the booth,
 * the table and everything else in it.
 *
 * Two ways to arrive here, and the caller says which:
 *
 * - `unadmitted` -- presets exist for that class and none was chosen. The author's doing,
 *   and undone by ticking one of them.
 * - `impossible` -- the base game has no preset carrying that class at all. Six shipped
 *   clusters are already in this state and no choice here fixes them.
 */
export function abandoned(chain, clusters, furniture) {
    const chosen = new Set(furniture);
    const out = [];

    for (const name of clusters) {
        const starved = importantElements(chain, name)
            .filter((element) => !element.presets.some((preset) => chosen.has(preset)))
            .map((element) => ({
                class: element.class,
                why: element.presets.length ? 'unadmitted' : 'impossible',
                options: element.presets,
            }));

        if (starved.length) out.push({ cluster: name, starved });
    }

    return out;
}

/** A list as prose, matching how the furniture checker reads its own. */
const and = (names) => (names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** What each of the four is called, given the room's name. */
export const assetNames = (name) => ({
    roomClass: `${name}RCP`,
    filter: `${name}RTF`,
    roomType: name,
    configuration: `${name}RC`,
});

/**
 * The fields this pane owns in each of the room's four assets, and therefore the only ones a
 * save may write over.
 *
 * A file this tool wrote once is not a file it owns for ever -- the pane's own note tells
 * the author to go and edit what it wrote. So a save is a merge: what is on disk is the
 * base, these keys are replaced, and everything else is left exactly as it was, including
 * fields nothing here has heard of. See the note on `mergeOwned` in `core/soBuilder.js` for
 * why the list is written out rather than taken from the object being saved.
 *
 * `overrideFloorHeight` and `forceConfiguration` are owned rather than merely written once.
 * Both have to stay as they are whatever a donor carries -- see the ring above, and the note
 * on the room type below -- so a save has to be able to put them back.
 *
 * `type` is owned and no longer written. Files this tool made before carry a `type` beside
 * `fileType`; every reader takes `fileType` first, so the stray key says nothing, and owning
 * it means a save clears it out rather than leaving it there to be read as a claim.
 */
const IDENTITY = ['fileType', 'type', 'name', 'presetName', 'copyFrom'];

export const OWNED_FIELDS = {
    RoomClassPreset: IDENTITY,
    RoomTypeFilter: [...IDENTITY, 'roomClasses'],
    RoomTypePreset: [...IDENTITY, 'overrideFloorHeight', 'forceConfiguration'],
    RoomConfiguration: [...IDENTITY, 'roomType', 'roomClass'],
};

/**
 * The gates that refuse a cluster where this room sits, if any.
 *
 * Refusing does not stop the room admitting it. The patch is additive and says nothing
 * about the gates, so it is harmless where it is inert and correct the moment the author
 * states a floor or a wealth that suits -- and the context is design intent that is written
 * nowhere, so a room reopened tomorrow has forgotten what it was.
 *
 * What it does do is say so, loudly, because the failure is otherwise silent: the gate is
 * checked before the room-class whitelist, so a refused cluster is simply never placed and
 * nothing is logged.
 */
export const refusedBy = (rooms, name, context) => admits(rooms, name, context).failures;

/**
 * Every change the room comes to, in load order.
 *
 * @param choices `{ name, donor, donorRoomType, context, clusters, furniture, admitted,
 *                surfaces, lighting }`
 * @param rooms   the parsed `refs/derived/roomCreator.json`
 * @param chain   the parsed `refs/derived/furnitureChain.json`
 *
 * @returns `{ changes, problems, collided }` -- `changes` in dependency order for
 *          `core/soBuilder.js` to land, `problems` what would leave the room built and
 *          wrong, and `collided` the assets whose patches want one file name, which is the
 *          one thing here that stops a write outright.
 */
export function planRoom(choices, rooms, chain) {
    const { name, donor, context = {}, clusters = [], surfaces = {}, lighting = [] } = choices;
    const problems = [];

    if (!name) problems.push('The room needs a name.');
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name ?? '')) {
        if (name) problems.push(`"${name}" is not a usable asset name: letters, digits and underscores, starting with a letter.`);
    }
    if (!donor) problems.push('The room needs a configuration to copy.');

    const named = assetNames(name || 'Room');
    const filterRef = `REF:RoomTypeFilter|${named.filter}`;
    const classRef = `REF:RoomClassPreset|${named.roomClass}`;

    const changes = [];

    const asset = (assetName, type, content) => changes.push(ownAsset({
        asset: assetName,
        type,
        owns: OWNED_FIELDS[type],
        content: { presetName: assetName, fileType: type, name: assetName, ...content },
    }));

    // A name belonging to two of the patched types takes the type in its file name, so
    // this room's change to each has a file of its own. The `name`/`fileType` inside are
    // what the loader matches on and are the same either way.
    const shared = sharedNames(rooms, chain);

    const patch = (assetName, type, ops) => changes.push(addTo({
        asset: assetName, type, ops, shared: shared.has(assetName),
    }));

    /* The four. Order is the order they reference each other. */

    // Empty on purpose: an empty class is in no filter, so it admits nothing until
    // something is added back. That is the whole trick the room is built on.
    asset(named.roomClass, 'RoomClassPreset', { copyFrom: null });

    asset(named.filter, 'RoomTypeFilter', { copyFrom: null, roomClasses: [classRef] });

    // `forceConfiguration` stays null -- see the ring above. `overrideFloorHeight` is
    // forced off because inheriting it from a donor overwrites the per-node floor heights
    // the author drew.
    asset(named.roomType, 'RoomTypePreset', {
        copyFrom: choices.donorRoomType ? `REF:RoomTypePreset|${choices.donorRoomType}` : null,
        overrideFloorHeight: false,
        forceConfiguration: null,
    });

    asset(named.configuration, 'RoomConfiguration', {
        copyFrom: donor ? `REF:RoomConfiguration|${donor}` : null,
        roomType: `REF:RoomTypePreset|${named.roomType}`,
        roomClass: classRef,
    });

    /* The clusters, and then everything they need in order to resolve furniture. */

    /*
     * What the author admitted, or everything these clusters could resolve when they have
     * not narrowed it.
     *
     * Narrowed rather than trusted, because a preset left over from a cluster since
     * unticked must not be patched into the room. Narrowed against what this room *already*
     * admits as well as against the closure, which is the difference between an untick and
     * a name this tool cannot account for: a cluster the author copied into their own mod by
     * hand is not in the reference data, nothing here can resolve what is in it, and a
     * closure that has never heard of it is not grounds for withdrawing the furniture it
     * places. An untick still removes, because the tick is what `choices.furniture` is.
     */
    const closure = closures(chain);
    const reachable = new Set(fullClosure(chain, clusters));
    const already = new Set(choices.admitted ?? []);

    const chosen = choices.furniture
        ? new Set(choices.furniture.filter((preset) => reachable.has(preset) || already.has(preset)))
        : reachable;

    const needed = new Set();
    const refused = [];

    for (const clusterName of clusters) {
        const failures = refusedBy(rooms, clusterName, context);
        if (failures.length) refused.push({ cluster: clusterName, failures });

        patch(clusterName, 'FurnitureCluster', [
            { op: 'add', path: '/allowedRoomFilters/-', value: filterRef },
        ]);

        for (const preset of closure[clusterName] ?? []) if (chosen.has(preset)) needed.add(preset);
    }

    // Furniture this room admits that nothing here resolves. Kept for the reason above, and
    // said out loud below rather than carried silently.
    const unexplained = [...already].filter((preset) => chosen.has(preset) && !needed.has(preset));
    for (const preset of unexplained) needed.add(preset);

    // One patch per preset in the closure. Admitting a cluster does not admit its
    // contents: the game re-filters furniture on the room class independently, and an
    // important element that resolves to nothing abandons the whole cluster silently.
    for (const preset of [...needed].sort()) {
        patch(preset, 'FurniturePreset', [
            { op: 'add', path: '/allowedRoomFilters/-', value: filterRef },
        ]);
    }

    /* Surfaces and lighting: the floor a new room class does not have. */

    const chosenSurfaces = [...new Set(['walls', 'floor', 'ceiling']
        .map((surface) => surfaces[surface]).filter(Boolean))];

    for (const filter of chosenSurfaces) {
        // The filter, not the material presets: here the whole material family is wanted,
        // which is the opposite of the furniture case.
        patch(filter, 'RoomTypeFilter', [
            { op: 'add', path: '/roomClasses/-', value: classRef },
        ]);
    }

    for (const light of lighting) {
        patch(light, 'RoomLightingPreset', [
            { op: 'add', path: '/roomCompatibility/-', value: `REF:RoomConfiguration|${named.configuration}` },
        ]);
    }

    /* Two of the room's files wanting one name, which the naming above exists to stop. */

    // An invariant rather than an expected outcome: `sharedNames` puts the type into the
    // file name of everything ambiguous, so nothing should reach here. It is checked
    // because the failure it guards is silent and expensive -- two files of one name are
    // written in order, the second replaces the first, and the room quietly loses an
    // admission the plan said it had.
    const byFile = new Map();
    for (const entry of changes) {
        if (!byFile.has(entry.file)) byFile.set(entry.file, []);
        byFile.get(entry.file).push(entry);
    }

    const collided = [...byFile.values()]
        .filter((group) => group.length > 1)
        .map((group) => ({
            file: group[0].file,
            asset: group[0].asset,
            types: [...new Set(group.map((entry) => entry.type))].sort(),
        }));

    for (const entry of collided) {
        problems.push(`${entry.asset} is ${and(entry.types)} at once and both would be written to `
            + `${entry.file}, so only one would survive. Nothing has been written. This is not `
            + 'meant to be reachable and is worth reporting.');
    }

    /* What would leave the room built and empty. */

    if (!clusters.length) problems.push('Nothing furnishes this room, so it will be empty.');

    // Loud, because the failure it describes is silent: the cluster is attempted, finds
    // nothing for a slot it cannot do without, and is abandoned whole.
    for (const entry of abandoned(chain, clusters, chosen)) {
        const missing = entry.starved.filter((slot) => slot.why === 'unadmitted');
        const never = entry.starved.filter((slot) => slot.why === 'impossible');

        if (missing.length) {
            problems.push(`${entry.cluster} needs ${and(missing.map((slot) => slot.class))}, and `
                + 'nothing admitted fills it, so the whole cluster would be abandoned. Admit one of '
                + `${and([...new Set(missing.flatMap((slot) => slot.options))])}.`);
        }

        if (never.length) {
            problems.push(`${entry.cluster} needs ${and(never.map((slot) => slot.class))}, which no `
                + 'furniture in the game carries, so it can never place whatever is admitted.');
        }
    }

    for (const surface of ['walls', 'floor', 'ceiling']) {
        if (!surfaces[surface]) {
            problems.push(`No ${surface} material, so the room falls back to the engine's default.`);
        }
    }

    if (!lighting.length) problems.push('No lighting preset accepts this room, so it gets no ceiling light.');

    /*
     * The clusters this room admits that will not be placed in it, and what to do about it.
     *
     * Said per cluster rather than gathered, because the gate and the answer differ: a floor
     * limit is a different sentence from a wealth minimum, and the author has to relax the
     * one that refused this one.
     */
    for (const entry of refused) {
        problems.push(`${entry.cluster} is admitted, but where this room sits it is refused: `
            + `${entry.failures.map((failure) => failure.reason).join(' ')} The patch admitting it `
            + 'is written either way and is harmless, and does nothing on its own — the gate is '
            + `checked first. To place it here, copy ${entry.cluster} into your mod by hand and `
            + 'relax that on the copy; changing it on the shipped one would move it in every '
            + 'vanilla room too.');
    }

    if (unexplained.length) {
        problems.push(`${and(unexplained)} ${unexplained.length === 1 ? 'is' : 'are'} already `
            + `admitted to this room and nothing here resolves ${unexplained.length === 1 ? 'it' : 'them'} `
            + '— a cluster of your own places furniture this tool cannot read. Left exactly as it '
            + 'is rather than withdrawn.');
    }

    return { changes, problems, collided };
}

/**
 * The three references that mark a patch operation as this room's.
 *
 * Everything the room adds to somebody else's asset adds one of these, and nothing else
 * in the folder has a reason to. So a patch carrying one is a patch this room wrote, and
 * a patch carrying none is somebody's else's business even if it sits on the same asset.
 */
export function roomRefs(name) {
    const named = assetNames(name);

    return {
        filter: `REF:RoomTypeFilter|${named.filter}`,
        roomClass: `REF:RoomClassPreset|${named.roomClass}`,
        configuration: `REF:RoomConfiguration|${named.configuration}`,
    };
}

/**
 * Whether one operation in somebody else's patch is this room's.
 *
 * Everything the room adds names one of the three references above, so a patch carrying one
 * is a patch this room wrote and a patch carrying none is somebody else's business even if
 * it sits on the same asset. That is what `takeOut` asks of each operation when the author
 * unticks something.
 */
export function roomOperations(name) {
    const ours = new Set(Object.values(roomRefs(name)));
    return (operation) => ours.has(operation?.value);
}
