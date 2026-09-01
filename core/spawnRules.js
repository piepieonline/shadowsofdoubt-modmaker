/**
 * Whether a furniture cluster is offered to a room, by the gates below the room class.
 *
 * A cluster is checked twice before its contents are ever considered. The room class
 * decides whether the cluster belongs in this *kind* of room, and that half lives in
 * `flows/building/scripts/furnitureChain.js`, which reads `refs/derived/furnitureChain.json`.
 * This is the other half: the thirty-odd gates that ask where the room *is* -- its floor,
 * its district's wealth, whether the address has anyone living in it -- and they are read
 * from `refs/derived/roomCreator.json`.
 *
 * The two files share no field, which is what keeps the two halves from becoming two
 * answers to one question. See `refs/README.md`. Nothing here re-implements a gate the
 * chain file carries, and nothing there implements one of these -- with one deliberate
 * exception, `clustersFor`, which restates the room-class match and says at its own
 * docstring why it is stated rather than imported.
 *
 * ## Why an unstated context is not a refusal
 *
 * The building flow answers "what could spawn on this square" from a blueprint, which
 * cannot know the district a building landed in or the wealth the generator rolled. It
 * names those gates in `UNAPPLIED_GATES` and errs wide rather than dropping furniture that
 * really can appear.
 *
 * The room creator's author *states* that context -- they are designing a room for a
 * floor, a wealth, an address kind -- so the same gates become answerable. Not all of
 * them, and not always: an author who has not decided what floor the room is on should be
 * told what that leaves open rather than shown a list filtered on a guess. So every
 * context field may be left unstated, and a gate whose input is unstated answers
 * `unknown` and is reported, never `no`.
 *
 * Which gives the same two verdicts `checkFurniture` gives, for the same reason:
 *
 * | | |
 * |---|---|
 * | `no` | a gate the author answered says no. Sound: these are hard filters. |
 * | `possible` | nothing stated rules it out. **Not a promise** -- see `unanswered`. |
 *
 * There is deliberately no `yes`. A cluster that passes every gate still has to win a
 * `placementChance` roll against a room the generator has not built yet.
 *
 * ## What is deliberately not evaluated
 *
 * Three of the fields that look like gates are not treated as such, and one of those is
 * not for want of data -- see `ADVISORY`.
 */

/**
 * Fields that read as gates and are reported rather than applied, with what makes each
 * one unsafe to evaluate.
 *
 * ## The three address-kind flags
 *
 * `allowInCompanies`, `allowInResidential` and `allowOnStreets` look like the gate this
 * module most wants, and they are the one thing here that is left out on evidence rather
 * than for want of it.
 *
 * They are not a conjunction -- `furnitureChain.js` said so first. Nor are they a
 * selection, which is the obvious next reading: take the flag matching the address kind
 * and require it. **21 of the 399 shipped clusters set all three false, and 16 of those 21
 * are not disabled** -- every `Mailboxes*`, `StairwellWallLamps`, `StairwellWallLampsHotel`,
 * `BasementSteps`, `LobbyOutsideAddressDoor`, `TownhouseExterior`, `TownhouseExteriorInv`
 * and `CityHallExterior`. Mailboxes are in the lobby of every apartment building in the
 * game. Under a selection they could never place anywhere.
 *
 * What the 16 have in common says why: they furnish communal building space -- lobbies,
 * stairwells, the outside of an address -- which is none of the three kinds these flags
 * name. So the flags are real and their domain is larger than the fields, and a reading
 * that assumed otherwise would drop furniture the author can see in the game.
 *
 * The shipped values are deliberate, not defaults left alone: only 8 of the 399 have all
 * three true, against 236 allowing companies, 125 residential and 128 streets. **A cluster
 * authored from scratch starts with all three true**, which is the game's field default and
 * matters when one is written rather than cloned -- a clone carries its donor's values
 * through `copyFrom`.
 *
 * The rest below are not gates at all. A per-room cap bounds how many of a thing a room
 * gets rather than whether it gets one; a chance is rolled; a priority orders. They are
 * here so that a reader looking for them finds out why they are absent rather than
 * assuming an oversight.
 */
export const ADVISORY = {
    allowInCompanies: 'the three address-kind flags do not cover communal building space',
    allowInResidential: 'the three address-kind flags do not cover communal building space',
    allowOnStreets: 'the three address-kind flags do not cover communal building space',
    limitPerRoom: 'caps how many the room gets, not whether it gets one',
    maximumPerRoom: 'caps how many the room gets, not whether it gets one',
    limitPerAddress: 'caps how many the address gets, not whether it gets one',
    maximumPerAddress: 'caps how many the address gets, not whether it gets one',
    placementChance: 'rolled per attempt',
    roomPriority: 'orders the attempts, does not gate them',
    calculatedMinRoomSize: 'derived by the game from the cluster’s own footprint; what it is measured against is not established here',
    coastalOnly: 'the editor has no notion of where a block sits in the city',
    securityDoor: 'describes what the cluster places, not where it may place',
    essentialFurniture: 'describes what the cluster places, not where it may place',
};

/** The context fields a gate here can ask about. Any may be left unstated. */
export const CONTEXT = ['floor', 'wealth', 'grub', 'openPlan', 'inhabitants', 'residences', 'district'];

/** Unstated, rather than merely falsy: floor 0 and wealth 0 are answers. */
const stated = (value) => value !== null && value !== undefined;

/**
 * One cluster's gates, with the file's compression undone.
 *
 * `roomCreator.json` writes only the fields that differ from `_gateDefaults`, so a gate
 * absent from a record carries the table's value. Absent never means unset.
 */
export function gatesOf(rooms, name) {
    if (!rooms) return null;
    return { ...rooms._gateDefaults, ...(rooms.clusters?.[name]?.gates ?? {}) };
}

/**
 * Whether this cluster may be offered to a room in this context.
 *
 * @param rooms   the parsed `refs/derived/roomCreator.json`
 * @param name    the cluster's name
 * @param context any of `CONTEXT`; anything absent is unstated
 *
 * @returns `{ verdict, failures, unanswered, advisory }` -- `failures` is every gate that
 *          said no rather than only the first, because these are independent conditions on
 *          the room the author is designing and fixing one does not imply the rest. That
 *          is the opposite of `checkFurniture`, where the stages are a chain and the first
 *          failure contains the others.
 */
export function admits(rooms, name, context = {}) {
    const gates = gatesOf(rooms, name);
    if (!gates) return { verdict: 'possible', failures: [], unanswered: [], advisory: [] };

    const record = rooms.clusters?.[name] ?? {};
    const failures = [];
    const unanswered = [];

    /** Apply one gate, or record that its input was never given. */
    const check = (on, field, test) => {
        if (!on) return;
        if (!stated(context[field])) { unanswered.push(field); return; }

        const reason = test(context[field]);
        if (reason) failures.push({ gate: field, reason });
    };

    // The floor. Two gates, and a cluster may set either -- `PicnicTable` is the range
    // one, -1 to 0, which is why it cannot be patched into a room above ground.
    check(gates.limitToFloor, 'floor', (floor) => (floor === gates.allowedOnFloor
        ? null
        : `It is limited to floor ${gates.allowedOnFloor}, and this room is on ${floor}.`));

    check(gates.limitToFloorRange, 'floor', (floor) => {
        const { x: low, y: high } = gates.allowedOnFloorRange ?? {};
        return floor >= low && floor <= high
            ? null
            : `It is limited to floors ${low} to ${high}, and this room is on ${floor}.`;
    });

    // Wealth, as the district's normalised land value. The minimum always applies; the
    // maximum is inert unless `wealthLimit` is set -- read from the shipped defaults,
    // where the flag is off and the maximum sits at its widest, which is the same shape
    // as `useMaximumRoomSize` guarding `maximumRoomSize` in the chain file. An inference
    // from the data rather than from the game's source, and the one gate here most worth
    // confirming before it is relied on.
    check(gates.minimumWealth > 0, 'wealth', (wealth) => (wealth >= gates.minimumWealth
        ? null
        : `It needs a wealth of at least ${gates.minimumWealth}, and this district is ${wealth}.`));

    check(gates.wealthLimit, 'wealth', (wealth) => (wealth <= gates.maximumWealth
        ? null
        : `It is limited to a wealth of ${gates.maximumWealth} or below, and this district is ${wealth}.`));

    // Grubbiness, only when the cluster asks for it to be read.
    check(gates.useRoomGrub, 'grub', (grub) => (grub >= gates.minimumGrub && grub <= gates.maximumGrub
        ? null
        : `It needs a grubbiness between ${gates.minimumGrub} and ${gates.maximumGrub}, and this room is ${grub}.`));

    // Open plan. 1 is never in an open plan room, 2 is only in one, 0 is either.
    check(gates.allowedInOpenPlan === 1, 'openPlan', (open) => (open
        ? 'It is kept out of open plan rooms, and this room is open plan.' : null));

    check(gates.allowedInOpenPlan === 2, 'openPlan', (open) => (open
        ? null : 'It is only placed in open plan rooms, and this room is not.'));

    check(gates.skipIfNoAddressInhabitants, 'inhabitants', (any) => (any
        ? null : 'It is skipped at an address with no inhabitants, and this one has none.'));

    check(gates.useBuildingResidences, 'residences', (count) => (
        count >= gates.minimumResidences && count <= gates.maximumResidences
            ? null
            : `It needs a building with ${gates.minimumResidences} to ${gates.maximumResidences} `
                + `residences, and this one has ${count}.`));

    // Districts, by name. The two lists are written only when they have something in them.
    check(gates.limitToDistricts, 'district', (district) => {
        const allowed = record.allowedInDistricts ?? [];
        const banned = record.notAllowedInDistricts ?? [];

        if (banned.includes(district)) return `It is kept out of ${district}.`;
        if (allowed.length && !allowed.includes(district)) {
            return `It is limited to ${allowed.join(', ')}, and this room would be in ${district}.`;
        }
        if (!allowed.length && !banned.length) {
            return 'It is limited to a list of districts that is empty, so it can never place.';
        }
        return null;
    });

    const advisory = Object.keys(ADVISORY)
        .filter((field) => field in (rooms.clusters?.[name]?.gates ?? {}))
        .map((field) => ({ gate: field, value: gates[field], note: ADVISORY[field] }));

    return {
        verdict: failures.length ? 'no' : 'possible',
        failures,
        unanswered: [...new Set(unanswered)],
        advisory,
    };
}

/**
 * Every cluster this room could be offered, and why each of the rest could not.
 *
 * The room class half is not applied here -- pass `names` already narrowed to the clusters
 * whose filters reach the room, or all of them to see the whole catalogue.
 */
export function admitted(rooms, names, context = {}) {
    const yes = [];
    const no = [];

    for (const name of names) {
        const result = admits(rooms, name, context);
        (result.verdict === 'no' ? no : yes).push({ name, ...result });
    }

    return { possible: yes, refused: no };
}

/**
 * The clusters a shipped room configuration is offered, by its room class.
 *
 * This is the room-class half, and the only thing in this module that is. It is here
 * because of what the room creator's donor means: an author copying `Ballroom` is copying
 * a room they have seen furnished, and the question "what furnishes it" has a flat answer
 * that does not need a square, a floor or a blueprint. The building flow's
 * `furnitureChain.js` answers the same question through `groupFor`, but its answer is
 * bound to one node of one drawn floor -- there is nothing there to call with a
 * configuration name and get a list back.
 *
 * Two of `blockedBy`'s three gates are applied. `disable` is, because a disabled cluster
 * never places and patching it into a room writes a file the game ignores -- 55 of the 399
 * are disabled. **Room size is not**, and cannot be: `min` and `max` are measured against a
 * room the author has not drawn yet, so a cluster too big for the room they eventually
 * paint is in this list and will not place. Same shape as an unstated gate above, and the
 * same reason -- err wide rather than drop furniture that really can appear.
 *
 * @param chain         the parsed `refs/derived/furnitureChain.json`
 * @param configuration a shipped `RoomConfiguration` name
 * @returns cluster names, sorted; empty for a configuration whose class no filter names
 */
export function clustersFor(chain, configuration) {
    const roomClass = chain?.roomConfigs?.[configuration]?.roomClass;
    if (!roomClass) return [];

    const reaching = new Set();
    for (const [filter, classes] of Object.entries(chain?.filters ?? {})) {
        if (classes.includes(roomClass)) reaching.add(filter);
    }

    // An empty set is a real answer, not a failure: `Atrium` is in no filter at all, so
    // nothing is placeable in an atrium and a room copying one starts unfurnished whatever
    // it copies.
    if (!reaching.size) return [];

    return Object.entries(chain?.clusters ?? {})
        .filter(([, cluster]) => !cluster.disable
            && (cluster.filters ?? []).some((filter) => reaching.has(filter)))
        .map(([name]) => name)
        .sort();
}

/**
 * The furniture a cluster can actually resolve, which is not what it names.
 *
 * A cluster puts down slots by `FurnitureClass`, and the game then fills each from the
 * presets carrying that class whose own room filters reach the room. An element marked
 * `importantToCluster` that resolves to nothing abandons the whole cluster placement, and
 * logs one line about it -- which is the failure this exists to make visible.
 *
 * Derived rather than stored: the answer is `furnitureChain.furniture[].classes` inverted,
 * and shipping it as well as its inputs would be a second thing to keep true.
 *
 * @param chain the parsed `refs/derived/furnitureChain.json`
 * @returns `name -> [preset]`, every cluster, including the ones that resolve to nothing
 */
export function closures(chain) {
    const byClass = new Map();

    for (const [preset, furniture] of Object.entries(chain?.furniture ?? {})) {
        for (const slot of furniture.classes ?? []) {
            if (!byClass.has(slot)) byClass.set(slot, []);
            byClass.get(slot).push(preset);
        }
    }

    const out = {};
    for (const [name, cluster] of Object.entries(chain?.clusters ?? {})) {
        out[name] = [...new Set((cluster.elements ?? [])
            .flatMap((element) => byClass.get(element.class) ?? []))].sort();
    }

    return out;
}

/**
 * The elements a cluster cannot do without, and the presets each could be filled from.
 *
 * An empty list against an important class is the silent failure: the files are all valid,
 * the room builds, and the cluster is abandoned every time it is attempted.
 */
export function importantElements(chain, name) {
    const byClass = new Map();
    for (const [preset, furniture] of Object.entries(chain?.furniture ?? {})) {
        for (const slot of furniture.classes ?? []) {
            if (!byClass.has(slot)) byClass.set(slot, []);
            byClass.get(slot).push(preset);
        }
    }

    return (chain?.clusters?.[name]?.elements ?? [])
        .filter((element) => element.important)
        .map((element) => ({ class: element.class, presets: byClass.get(element.class) ?? [] }));
}

/**
 * Which room type filters are safe to join for a surface, and which would bring furniture.
 *
 * A filter is a named set of room classes and nothing about it says what it is *for*, so
 * the same one can gate wall materials and a sofa. Joining a mixed one to get its
 * wallpaper silently admits its furniture as well -- `CorporateLobby` for walls would
 * bring 18 presets with it.
 *
 * Safe means: it supplies materials for that surface, and no cluster or preset names it.
 *
 * @param rooms the parsed `refs/derived/roomCreator.json`
 * @param chain the parsed `refs/derived/furnitureChain.json`
 */
export function surfaceFilters(rooms, chain) {
    const gating = new Set();

    for (const cluster of Object.values(chain?.clusters ?? {})) {
        for (const filter of cluster.filters ?? []) gating.add(filter);
    }
    for (const preset of Object.values(chain?.furniture ?? {})) {
        for (const filter of preset.filters ?? []) gating.add(filter);
    }

    const out = { walls: { safe: [], alsoGatesFurniture: [] }, floor: { safe: [], alsoGatesFurniture: [] }, ceiling: { safe: [], alsoGatesFurniture: [] } };

    for (const [name, counts] of Object.entries(rooms?.filters ?? {})) {
        for (const surface of ['walls', 'floor', 'ceiling']) {
            if (!counts[surface]) continue;
            out[surface][gating.has(name) ? 'alsoGatesFurniture' : 'safe'].push(name);
        }
    }

    for (const surface of Object.values(out)) {
        surface.safe.sort();
        surface.alsoGatesFurniture.sort();
    }

    return out;
}

/**
 * The room configurations no lighting preset names, which get no ceiling light.
 *
 * A new configuration is always one of these until a `RoomLightingPreset` is patched to
 * accept it, and the room builds cleanly without one. 14 of the 79 shipped configurations
 * are in this state already, mostly outdoor ones -- so a donor drawn from them is not
 * evidence that the author's room needs no light.
 */
export function unlitConfigurations(rooms) {
    const lit = new Set(Object.values(rooms?.lighting ?? {}).flatMap((light) => light.rooms ?? []));
    return Object.keys(rooms?.configurations ?? {}).filter((name) => !lit.has(name)).sort();
}

/** The lighting presets that would accept a configuration, for the ones that do not. */
export function lightsFor(rooms, configuration) {
    return Object.entries(rooms?.lighting ?? {})
        .filter(([, light]) => light.rooms?.includes(configuration))
        .map(([name]) => name)
        .sort();
}
