/**
 * The files a room comes to, worked out before any of them is written.
 *
 * A room is four assets and a patch per thing admitted, and a half-written set is a mod
 * that will not load. So the whole set is decided here, as data, and `writeRoom` in
 * `roomCreator.js` is the only part that touches a folder. That split is what lets the
 * pane show the author exactly what it is about to do, and lets the decision be tested
 * without a filesystem.
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
 * ## Naming
 *
 * The `RoomTypePreset` takes the bare room name and the other three take suffixes. It is
 * the only one of the four that surfaces where an author browses -- the floorplan editor's
 * room picker lists it, and a blueprint stores it as a plain string -- so it is the only
 * one whose name is read by a human in normal use. This diverges from the templates on the
 * export server, which suffix all four.
 */
import { PATCH_SUFFIX, PRESET_SUFFIX, stemFor, patchFileNameFor } from '../../../core/soFileName.js';
import { admits, closures, importantElements } from '../../../core/spawnRules.js';

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
 * The gate fields to turn off when a cluster is cloned because that gate refused it.
 *
 * Only the conflicting gate is relaxed. Patching the gate on the shipped asset would
 * change every vanilla room the cluster already appears in; relaxing every gate on the
 * clone would admit it to rooms its author never meant it for.
 */
const RELAXATIONS = {
    floor: { limitToFloor: false, limitToFloorRange: false },
    wealth: { minimumWealth: 0, wealthLimit: false },
    grub: { useRoomGrub: false },
    openPlan: { allowedInOpenPlan: 0 },
    inhabitants: { skipIfNoAddressInhabitants: false },
    residences: { useBuildingResidences: false },
    district: { limitToDistricts: false },
};

/**
 * Whether a cluster can be patched where it stands, or has to be cloned.
 *
 * A cluster whose every gate passes for this room takes one patch adding the room's filter
 * to its `allowedRoomFilters`, which is additive and changes nothing else. One that fails a
 * gate cannot: the gate is checked before the room-class whitelist, so the patch would be
 * ignored, and editing the gate on the shipped asset would move every vanilla room the
 * cluster already appears in.
 */
export function decideCluster(rooms, name, context) {
    const { failures } = admits(rooms, name, context);
    if (!failures.length) return { name, action: 'patch', relax: {} };

    const relax = {};
    for (const failure of failures) Object.assign(relax, RELAXATIONS[failure.gate] ?? {});

    return { name, action: 'clone', relax, because: failures };
}

/**
 * Every file the room comes to, in load order.
 *
 * @param choices `{ name, donor, donorRoomType, context, clusters, surfaces, lighting }`
 * @param rooms   the parsed `refs/derived/roomCreator.json`
 * @param chain   the parsed `refs/derived/furnitureChain.json`
 *
 * @returns `{ files, order, problems, collided }` -- `files` in dependency order, `order`
 *          the `fileOrder` entries for them, `problems` what would leave the room built
 *          and wrong, and `collided` the assets whose patches want one file name, which is
 *          the one thing here that stops a write outright.
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

    const files = [];

    const asset = (assetName, type, content) => files.push({
        kind: 'asset',
        asset: assetName,
        type,
        file: `${stemFor(assetName, type)}${PRESET_SUFFIX}`,
        entry: stemFor(assetName, type),
        content: {
            presetName: assetName, fileType: type, name: assetName, type, ...content,
        },
    });

    // A name belonging to two of the patched types takes the type in its file name, so
    // this room's change to each has a file of its own. The `name`/`fileType` inside are
    // what the loader matches on and are the same either way.
    const shared = sharedNames(rooms, chain);

    const patch = (assetName, type, patches) => {
        const file = patchFileOf(shared, assetName, type);

        files.push({
            kind: 'patch',
            asset: assetName,
            type,
            file,
            entry: file.slice(0, -PATCH_SUFFIX.length),
            content: { name: assetName, fileType: type, patches },
        });
    };

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

    // What the author admitted, or everything these clusters could resolve when they have
    // not narrowed it. Intersected with the closure rather than trusted: a preset left
    // over from a cluster since unticked must not be patched into the room.
    const closure = closures(chain);
    const reachable = new Set(fullClosure(chain, clusters));
    const chosen = choices.furniture
        ? new Set(choices.furniture.filter((preset) => reachable.has(preset)))
        : reachable;

    const needed = new Set();

    for (const clusterName of clusters) {
        const decision = decideCluster(rooms, clusterName, context);

        if (decision.action === 'patch') {
            patch(clusterName, 'FurnitureCluster', [
                { op: 'add', path: '/allowedRoomFilters/-', value: filterRef },
            ]);
        } else {
            // `clusterElements` is deliberately not restated. The reference data holds a
            // trimmed element -- its class and whether it is important, not its placement,
            // facing or offsets -- so restating one would be writing a cluster whose
            // contents this tool made up. An unstated list is the donor's, through
            // `copyFrom`. See the note in ROOM-CREATOR-PLAN.md: the export server's own
            // template restates them, and why is not established.
            asset(`${named.roomType}_${clusterName}`, 'FurnitureCluster', {
                copyFrom: `REF:FurnitureCluster|${clusterName}`,
                allowedRoomFilters: [filterRef],
                ...decision.relax,
            });
        }

        for (const preset of closure[clusterName] ?? []) if (chosen.has(preset)) needed.add(preset);
    }

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
    for (const entry of files) {
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

    return { files, order: files.map((entry) => entry.entry), problems, collided };
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
 * A patch with this room taken out of it, for furniture the author has unticked.
 *
 * The whole file is not deleted unless it is left with nothing: another room, or the
 * author by hand, may have added to the same shipped asset, and their operations are none
 * of this room's business.
 *
 * @returns `{ content, removed, empty }` -- `empty` when the file has no operations left
 *          and should go, along with its entry in the manifest.
 */
export function withoutRoom(existing, refs) {
    const ours = new Set(Object.values(refs));
    const patches = Array.isArray(existing?.patches) ? existing.patches : [];
    const kept = patches.filter((operation) => !ours.has(operation?.value));

    return {
        content: { ...existing, patches: kept },
        removed: patches.length - kept.length,
        empty: kept.length === 0,
    };
}

/**
 * What a file already in the folder means for writing this room.
 *
 * The two kinds are not the same problem. One of the mod's own assets is a thing with an
 * identity -- `PicnicAreaRCP` is *this* room's class, and a second room cannot have it --
 * so a file already there is a name clash and the author has to resolve it.
 *
 * A patch is the opposite. It is a list of changes to a shipped asset, and two rooms
 * admitting the same cluster genuinely both want to change it: the second adds its own
 * filter beside the first's. Replacing the file would silently un-admit the first room's
 * furniture, which is the bug this exists to make impossible.
 *
 * @returns `{ content, added }` for a patch to write back, or `{ reason }` for one that
 *          cannot be merged.
 */
export function mergePatch(existing, planned) {
    if (!Array.isArray(existing?.patches)) {
        // The format this app replaced states fields rather than operations. Appending an
        // operation to it would produce a file that is half one format and half the other,
        // and converting it needs the base asset, which is not always readable.
        return { reason: `${planned.name} is written in the older whole-field format, so this room's change cannot be added to it` };
    }

    if (existing.fileType && planned.fileType && existing.fileType !== planned.fileType) {
        return { reason: `${planned.name} patches a ${existing.fileType} and this room needs it to patch a ${planned.fileType}` };
    }

    const has = (operation) => existing.patches.some((each) => each?.op === operation.op
        && each?.path === operation.path
        && JSON.stringify(each?.value) === JSON.stringify(operation.value));

    // Idempotent on purpose: writing the same room twice should be a no-op on its patches
    // rather than a file with the same operation in it twice.
    const missing = planned.patches.filter((operation) => !has(operation));

    return {
        content: { ...existing, patches: [...existing.patches, ...missing] },
        added: missing.length,
    };
}

/**
 * How each planned file lands against what is already in the folder.
 *
 * @param existing `Set` of file names already present
 * @returns each file tagged `write`, `append`, or `clash`
 */
export function against(files, existing) {
    return files.map((entry) => {
        if (!existing.has(entry.file)) return { ...entry, landing: 'write' };
        return { ...entry, landing: entry.kind === 'patch' ? 'append' : 'clash' };
    });
}

/**
 * The asset files that would have to be overwritten, which is what blocks a write.
 *
 * `own` is the files the room being edited already has. Rewriting its own class or its own
 * configuration is the whole of what saving an edit means, so those are not clashes -- a
 * clash is somebody *else's* asset standing where this room's would go.
 */
export function collisions(files, existing, own = new Set()) {
    const present = existing instanceof Set ? existing : new Set(existing);

    return files
        .filter((entry) => entry.kind === 'asset' && present.has(entry.file) && !own.has(entry.file))
        .map((entry) => entry.file);
}
