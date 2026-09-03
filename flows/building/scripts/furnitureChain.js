/**
 * What furniture could spawn on the square under the pointer.
 *
 * A floor blueprint says nothing about furniture. It says which `LayoutConfiguration` an
 * address has and which `RoomTypePreset` each of its rooms is, and the game turns that
 * into objects at city generation through a chain of five stages, each committed before
 * the next runs:
 *
 *     LayoutConfiguration -> AddressPreset -> RoomConfiguration -> RoomClassPreset
 *       -> RoomTypeFilter -> FurnitureCluster -> FurnitureClass -> FurniturePreset
 *
 * This walks the first four of those forwards from a node and reports where it lands. It
 * is a reading of the game's data, not a simulation of the generator: what comes back is
 * what *could* be placed, never what will be.
 *
 * The reference data is `refs/derived/furnitureChain.json`, written by
 * `../tools/buildFurnitureChain.js`. See refs/README.md for who owns it.
 *
 * ## Why a node has several answers
 *
 * A blueprint does not name an `AddressPreset`. It names a layout, and every preset
 * whose `compatible` list contains that layout competes for the unit at city generation,
 * scored on size, footfall and district. Which one wins is not knowable from the file --
 * and it changes the answer completely, because each preset maps the room's type to a
 * `RoomConfiguration` of its own choosing. `OfficeHighrise` is shared by `HighriseOffice`
 * and `Laboratory`, which send the same `OfficeSpace` room to `RoomConfiguration|Office`
 * and `RoomConfiguration|Laboratory` respectively, and the furniture diverges from there.
 *
 * So the result is a group per competing preset rather than one list, because collapsing
 * them would assert something the blueprint does not say.
 *
 * ## Which gates are applied
 *
 * Applied, because a blueprint records what they read:
 *
 * | Gate | Read from |
 * |---|---|
 * | `allowedRoomFilters` on clusters and presets | the room's class, via its configuration |
 * | `minimumRoomSize` / `maximumRoomSize` | the room's node count on the grid |
 * | `onlyAllowInFollowing` / `banInFollowing` | the address preset the group is for |
 * | `disable` on a cluster | the cluster |
 * | `minimum` / `maximumZeroNodeWallCount` on a class | the walls on the square itself |
 * | `wallRules` on a class | what kind of wall is on each named edge, and what is through it |
 *
 * The last two are answered per *square* rather than per room, and are what stops a list
 * of what could stand in the middle of an office offering wall pieces. The count is the
 * coarse half -- see `wallsAround` -- and the rules the fine one: 230 of the 262 classes
 * carry them, and where the count asks how many edges have a wall, a rule asks what kind
 * sits on a named edge and what lies through it. See `wallRuleFailure`.
 *
 * Not applied, and named to the reader through `UNAPPLIED_GATES` instead: district,
 * wealth, grubbiness, inhabitants, building, floor range, and design style. None is
 * recorded in a blueprint -- they are decided when the city is built, from where it landed
 * and what the generator rolled. Filtering on a guess would drop furniture that really
 * can appear here, which is the wrong way for this list to be wrong: it is read to find
 * out what an author has to work with, so it errs wide and says where it did.
 *
 * The three cluster fields `allowInResidential`, `allowInCompanies` and `allowOnStreets`
 * are deliberately not applied either, and that one is not for want of data. 106 of the
 * 399 clusters set none of the three, and 17 address presets have neither a company nor
 * a residence, so the predicate is plainly not the conjunction it looks like and no
 * reading of it could be checked without the generator's source. The room class already
 * does this work -- a bedroom cluster's filters do not reach an office -- and applying
 * the flags as an AND would have removed 4 of the 51 clusters valid in a highrise
 * office, `Easel` and `SciencePicture` among them. Left out rather than guessed.
 *
 * A class's `nodeRules`, `awayFromClasses` and `blockedAccess` are not read either, and
 * for a firmer reason than the list above: they are about furniture that has already been
 * placed. `nodeRules` search the room's cluster maps (`GenerationController.cs:5111`),
 * and `blockedAccess` is not a match at all -- it declares which node-to-node links a
 * piece blocks, and feeds a reachability veto (`:5314`). Treating it as effect-only is
 * the safe approximation: it accepts placements the game would refuse, which is the
 * direction this errs in everywhere else.
 *
 * Stage 5, the interactables a preset carries, is not walked at all. It decides what can
 * be *done* with an object rather than whether the object is there.
 */
import {
    AXIS_X, AXIS_Y, nodeAt, roomOfNode, tileForNode, getWall,
    OUTDOOR_LAYOUT_CONFIGURATIONS,
} from './floorModel.js';

import { overlayChain } from './furnitureOverlay.js';

// Through BASE_URL rather than a leading slash: the web build is mounted under the Pages
// project prefix, where a root-absolute path lands outside the site entirely.
const CHAIN_PATH = `${import.meta.env.BASE_URL}refs/derived/furnitureChain.json`;

/**
 * The gates this cannot apply, in the order an author is likely to care about them.
 *
 * Stated once here so the panel and this module cannot describe the same limitation
 * differently, and so the list is somewhere a reader of either finds it.
 */
export const UNAPPLIED_GATES = [
    'district', 'wealth', 'grubbiness', 'inhabitants', 'building', 'floor', 'design style',
];


/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

let base = null;
let chain = null;
let chainPromise = null;

/**
 * Fetch the chain data, once per page.
 *
 * 185 KB, and about 20 KB over the wire. Fetched rather than imported for the same
 * reason the floors are: it is read by one panel of one flow, and the other two flows
 * should not pay for it on load. Resolves to the data, or to null if it cannot be had --
 * a missing reference file makes the section absent, not the editor broken.
 */
export function loadFurnitureChain() {
    chainPromise ??= fetch(CHAIN_PATH)
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => { base = data; chain = data; return chain; })
        .catch(() => null);

    return chainPromise;
}

/**
 * Lay the current mod's own assets over the base game's, or take them off again.
 *
 * What the walk answers against is the data the *game* would load, which is the base
 * game's plus whatever the selected mod adds and patches -- see furnitureOverlay.js for
 * why answering without them is not merely incomplete but wrong.
 *
 * Rebuilt from the base every time rather than layered on the last merge, so deleting a
 * file from the mod takes its asset back out. The result is a new object, which is what
 * clears the caches keyed on the old one.
 *
 * Returns what was applied, for the panel to say.
 */
export function applyModOverlay(assets) {
    if (!base) return [];

    chain = overlayChain(base, assets);
    return chain?.applied ?? [];
}

/** The base game's alone, whatever a mod has added. For saying what came from where. */
export function baseFurnitureChain() {
    return base;
}

/**
 * The chain data if it has arrived, or null.
 *
 * Synchronous, because the status column is redrawn on every pointer move and cannot
 * await anything. Until the fetch lands this is null and the section is simply absent;
 * the flow redraws when it resolves.
 */
export function furnitureChain() {
    return chain;
}

/** Test seam: hand the module data directly, or clear it. */
export function setFurnitureChain(data) {
    base = data ?? null;
    chain = data ?? null;
    chainPromise = data ? Promise.resolve(data) : null;
    derived = new WeakMap();
}


/* -------------------------------------------------------------------------- */
/* Indexes and memoisation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Per-dataset indexes and answers, keyed by the data object itself.
 *
 * This runs on the pointer-move path -- the status column is redrawn every time the
 * pointer crosses a cell -- and the walk puts all 310 presets through the gates per
 * group. Caching a whole group is what makes that free, and it is safe because the data
 * is fetched once and never written.
 *
 * `groups` caches a whole group -- the resolved address preset and room, and the list
 * derived from them -- keyed by the four things it depends on. A pointer crossing a room
 * asks the identical question of every square in it, and every square of the middle of a
 * room is the same question.
 *
 * A `WeakMap` on the data rather than a plain object, so a test that swaps the dataset
 * cannot be answered from the previous one's cache.
 */
let derived = new WeakMap();

/** Shared, because a room class no filter names is common and none of these is written. */
const EMPTY = new Set();

function indexes(data) {
    let found = derived.get(data);
    if (found) return found;

    // `filters` is `RoomTypeFilter -> room classes`, the way the asset is written, and
    // every question asked of it is the other way round. Inverted here rather than in the
    // file so that a mod patching a shipped filter -- which replaces its class list
    // wholesale -- is merged as a whole filter and the inversion recomputed after. See
    // furnitureOverlay.js.
    const filtersByClass = new Map();
    for (const [filter, classes] of Object.entries(data.filters ?? {})) {
        for (const roomClass of classes) {
            let list = filtersByClass.get(roomClass);
            if (!list) filtersByClass.set(roomClass, list = new Set());
            list.add(filter);
        }
    }

    // `clusters` is `FurnitureCluster -> the classes its elements name`, and stage 4's reason
    // asks it the other way round: which clusters carry this class. Inverted here for the
    // same reason as the filters, and for one more -- `groupFor` builds a reason for every
    // preset that fails, discarding all but the one asked about, so a scan of all 399
    // clusters per failing preset is 310 scans per distinct square on the pointer-move path.
    // As a lookup it is a handful of names: 100 of the game's 261 carried classes have one
    // cluster and most have four or fewer.
    const carriersByClass = new Map();
    for (const [name, cluster] of Object.entries(data.clusters ?? {})) {
        for (const element of cluster.elements) {
            if (!element.class) continue;

            let list = carriersByClass.get(element.class);
            if (!list) carriersByClass.set(element.class, list = []);

            // Two elements of one class in one cluster is one cluster to name.
            if (!list.includes(name)) list.push(name);
        }
    }

    // The two inversions are the dataset's and are shared by every floor answered against
    // it. The group cache is **per floor**, because the answer stopped being a function of
    // the dataset alone when the wall rules landed: its key is a coordinate, and (4, 11)
    // on one blueprint is a different square from (4, 11) on another. Keyed off the model
    // rather than folded into the key, so a floor that is closed takes its cache with it.
    found = { filtersByClass, carriersByClass, groups: new WeakMap() };
    derived.set(data, found);
    return found;
}


/* -------------------------------------------------------------------------- */
/* Resolving                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What could spawn on one node.
 *
 * Returns null when there is nothing to say -- no data, no node, or a node outside every
 * address -- and otherwise a result carrying either `groups` or a `reason` it has none.
 * A reason is never an error: every one of them is a state the base game's own floors
 * are in somewhere.
 *
 *     {
 *       layout: 'OfficeHighrise', roomType: 'OfficeSpace', roomSize: 40, walls: 2,
 *       groups: [{ address, config, roomClass, forced, count, empty, offWall, classes }],
 *       reason: null,
 *     }
 */
export function furnitureAt(data, model, x, y) {
    if (!data || !model) return null;

    const node = nodeAt(model, x, y);
    if (!node) return null;

    const address = model.addresses[node.addressIndex];
    const room = roomOfNode(model, node);
    if (!address) return null;

    const layout = address.layoutConfiguration;
    const roomType = room?.preset ?? null;
    const roomSize = roomNodeCount(model, node.addressIndex, node.roomIndex);
    const walls = wallsAround(model, x, y);

    const base = { layout, roomType, roomSize, walls, groups: [], reason: null };

    // Outside is not an address the game furnishes -- it is where a square no address
    // claims lives. Said plainly rather than run through the chain to reach an empty
    // list, which would read as "nothing fits here" instead of "this is not a room".
    if (OUTDOOR_LAYOUT_CONFIGURATIONS.has(layout)) {
        return { ...base, reason: `${layout} is an outdoor layout, and is not furnished from a room class.` };
    }

    if (!roomType) return { ...base, reason: 'This square is in no room.' };

    const competing = Object.keys(data.addresses ?? {})
        .filter((preset) => data.addresses[preset].compatible?.includes(layout))
        .sort();

    // The game logs `No address preset shortlist for …` here and falls back to its lobby
    // preset. Which preset that is comes from the generator rather than from any field
    // in this data, so it is named as a fallback and not resolved.
    if (competing.length === 0) {
        return {
            ...base,
            reason: `No address preset is compatible with ${layout}, so the game falls back to its lobby preset.`,
        };
    }

    const cache = indexes(data);
    const groups = [];

    let memo = cache.groups.get(model);
    if (!memo) cache.groups.set(model, memo = new Map());

    for (const preset of competing) {
        // Keyed on everything the answer depends on, which since the wall rules landed
        // includes the square itself: two squares with one wall each may have a doorway
        // and a solid wall respectively, and 230 of the 262 classes tell those apart.
        //
        // That gives up what this memo was originally for -- the middle of a room worked
        // out once however far the pointer is dragged across it -- and it has to. The
        // saving was never what made the walk affordable: the panel hangs off the
        // *selected* square rather than the hovered one, so this runs on a click. What is
        // left is still worth having, because `explainFurniture` calls `furnitureAt`
        // again for the same square.
        //
        // Stringified as an array rather than joined with a separator, because a mod
        // may name an asset anything at all, and the four parts are short enough that
        // escaping them costs nothing. `meshExport.js` has the same problem over inputs
        // far too large to re-escape, and joins on `\u0000` instead.
        const key = JSON.stringify([preset, roomType, roomSize, walls, x, y]);

        let group = memo.get(key);
        if (group === undefined) {
            group = groupFor(data, cache, preset, roomType, roomSize, walls, model, x, y);
            memo.set(key, group);
        }

        if (group) groups.push(group);
    }

    if (groups.length === 0) {
        return {
            ...base,
            reason: `No address preset on ${layout} configures a ${roomType}, so the game leaves it unfurnished.`,
        };
    }

    return { ...base, groups };
}

/**
 * One competing address preset's answer for this room.
 *
 * Null when the preset does not configure this room type at all: `GenerateRoomConfigs`
 * matches the address preset's `roomConfig` list against the room by `roomType`, falls
 * back to the type's own `forceConfiguration`, and failing both logs `Unable to find room
 * for … setting as null` and hands the room a dead `nullConfig`. A group for that would
 * be a heading over an empty list.
 *
 * The list of what could spawn is **derived from `checkFurniture`** rather than worked
 * out alongside it: every one of the game's furniture presets is put through the same
 * walk that answers "why not this one", and the ones that come back `possible` are the
 * list. There is one implementation of the gates, so the list and the verdict cannot
 * disagree -- see the note on `checkFurniture`.
 */
function groupFor(data, cache, preset, roomType, roomSize, walls, model, x, y) {
    const config = configFor(data, preset, roomType);
    if (!config) return null;

    const roomClass = data.roomConfigs[config.name]?.roomClass ?? null;
    if (!roomClass) return null;

    // Which `RoomTypeFilter`s name this class. Both clusters and furniture presets gate
    // on filters rather than on classes directly, so this one set is what both are tested
    // against, and it is built once per dataset rather than once per group.
    const filters = cache.filtersByClass.get(roomClass) ?? EMPTY;

    // Every slot class some placeable cluster names, before the square has its say. The
    // cluster stage in one set: what arrangements could be attempted in a room of this
    // class and size, expressed as the slots they would put down.
    // Counted alongside, because "no cluster reaches this room" and "clusters reach it and
    // none has a slot of your class" are different failures with different fixes, and a
    // slot set that is empty cannot tell them apart -- a cluster whose every element names
    // no class contributes nothing to `slots` while still being placeable here.
    let clusterCount = 0;

    // And the ones a filter reaches that this room is the wrong *size* for, kept apart from
    // the ones no filter reaches at all. `clusterCount` alone cannot tell those two apart
    // either, and they are opposite fixes -- widen a filter, or change the room -- so a
    // room that comes to nothing has to say which of them it is. See `unfurnishedReason`.
    const sized = [];

    const slots = new Set();
    for (const cluster of Object.values(data.clusters ?? {})) {
        const gate = blockedBy(cluster, filters, roomSize);

        if (gate) {
            if (gate === 'size') sized.push(sizeBound(cluster, roomSize));
            continue;
        }

        clusterCount++;
        for (const element of cluster.elements) if (element.class) slots.add(element.class);
    }

    const group = {
        address: preset,
        config: config.name,
        forced: config.forced,
        roomClass,
        filters,
        slots,
        clusterCount,

        // Carried so the sentence can be built from the group alone, by the panel as well
        // as by the walk -- the panel has no `square` and would otherwise have to be handed
        // the size separately or word the same fact its own way.
        roomSize,
        sizedOut: sized.length,
        sizeBounds: [...new Set(sized)],
    };

    // The grid and the coordinate travel with the square because stage 6 reads the walls
    // around it, the rooms through them and the tiles under them, none of which a summary
    // of the square could carry: a rule reaches three squares out, and what it finds there
    // is the blueprint's. The room comes along because a footprint is tested against it by
    // identity rather than by name -- two rooms of one preset are two rooms.
    const square = {
        roomType, roomSize, walls, model, x, y, room: roomOfNode(model, nodeAt(model, x, y)),
    };

    // The whole catalogue through the one walk. 310 presets against a handful of cheap
    // tests, once per distinct square -- see the memo in `furnitureAt`.
    const byClass = new Map();
    const seen = new Set();

    for (const name of Object.keys(data.furniture ?? {})) {
        const check = checkFurniture(data, group, square, name);
        if (check.verdict !== 'possible') continue;

        seen.add(name);
        for (const slot of check.classes) {
            if (!byClass.has(slot)) byClass.set(slot, []);
            byClass.get(slot).push({ name, universal: data.furniture[name].universal });
        }
    }

    const rows = [...byClass.keys()].sort().map((slot) => ({
        name: slot,
        wallPiece: !!data.classes?.[slot]?.wallPiece,
        presets: byClass.get(slot).sort((a, b) => a.name.localeCompare(b.name)),
    }));

    return { ...group, classes: rows, count: seen.size, ...slotTally(data, group, square, byClass) };
}

/**
 * The slots that came to nothing, counted by why.
 *
 * Four different states, and only one of them is about the furniture:
 *
 * - `offWall.needsWall` / `needsOpen` -- the square has the wrong number of walls for the
 *   class. Fixed by selecting a different square, not by changing anything.
 * - `offWall.wrongWalls` -- the count is right and the walls themselves are not: the class
 *   wants a solid wall behind it and this square's is a doorway. Also fixed by a different
 *   square, but a different fact about this one, so counted apart from the other two.
 * - `empty` -- the class fits the square and no furniture can fill it here. That is the
 *   transitive gate: an empty pool on an element marked `importantToCluster` aborts the
 *   whole cluster it is in.
 * - `unchecked` -- the class carries a rule this cannot read, so it is neither ruled in
 *   nor out. `securityDoorDivider`, and only the two security door classes.
 *
 * Derived from the same facts `checkFurniture` reads, in the same order, so a slot cannot
 * be counted under one heading here and reported under another there.
 */
function slotTally(data, group, square, byClass) {
    let empty = 0;
    let unchecked = 0;
    const offWall = { needsWall: 0, needsOpen: 0, wrongWalls: 0 };

    for (const slot of group.slots) {
        const geometry = data.classes?.[slot];

        if (geometry && square.walls < geometry.minWalls) { offWall.needsWall++; continue; }
        if (geometry && square.walls > geometry.maxWalls) { offWall.needsOpen++; continue; }

        if (wallRuleFailure(data, group, square, slot)) { offWall.wrongWalls++; continue; }

        if (geometry?.unchecked) unchecked++;
        if (!byClass.has(slot)) empty++;
    }

    return { empty, unchecked, offWall };
}

/**
 * Whether one named furniture preset could spawn on one square, per competing address.
 *
 * The same walk `furnitureAt` derives its list from, run over one preset instead of all
 * of them -- so a preset this reports `possible` is one that list contains, necessarily
 * rather than by agreement. The unit suite asserts exactly that over every base game
 * floor.
 *
 * Null when there is nothing to say. Otherwise the square's facts, and either a `reason`
 * that is the square's rather than the preset's -- it is outdoors, in no room, or in a
 * unit no address preset configures -- or a verdict per address preset competing for it:
 *
 *     {
 *       layout, roomType, roomSize, walls, reason: null,
 *       preset: 'LargeBookcase',
 *       groups: [{ address, config, roomClass, verdict, stage, reason, classes }],
 *     }
 *
 * A square-level reason is a `no` for every address preset at once, which is why it is
 * reported once rather than repeated per group.
 */
export function explainFurniture(data, model, x, y, name) {
    const at = furnitureAt(data, model, x, y);
    if (!at) return null;

    const square = {
        roomType: at.roomType,
        roomSize: at.roomSize,
        walls: at.walls,
        model,
        x,
        y,
        room: roomOfNode(model, nodeAt(model, x, y)),
    };

    if (at.reason) return { ...at, preset: name, groups: [] };

    const groups = at.groups.map((group) => {
        const check = checkFurniture(data, group, square, name);

        return {
            address: group.address,
            config: group.config,
            forced: group.forced,
            roomClass: group.roomClass,
            ...check,
        };
    });

    return { ...at, preset: name, groups };
}

/**
 * Every furniture preset the reference data knows, for something to choose from.
 *
 * The same array every time it is asked of the same data, so a caller building something
 * out of 310 names can tell whether it needs to build it again. The status column is
 * redrawn on every pointer move and the list is the same on all of them.
 */
export function furniturePresetNames(data) {
    if (!data) return [];

    const cache = indexes(data);
    cache.names ??= Object.keys(data.furniture ?? {}).sort();
    return cache.names;
}

/**
 * The same names, split into the mod's own and the base game's.
 *
 * The mod's come first wherever these are offered. An author reaching for this list is
 * usually asking about something they just wrote, and their own six presets should not be
 * somewhere below the three hundred they did not.
 *
 * A preset a `.sodso_patch.json` alters counts as the mod's rather than the base game's.
 * It is a shipped name, but it no longer holds shipped values -- and since the whole point
 * of the list is to ask why something does or does not place, the honest section for it is
 * the one that says the answer depends on the mod's file.
 *
 * `applied` is what `overlayChain` recorded merging, which is the only account of where a
 * record came from: the merged chain is name-keyed and a mod's preset is indistinguishable
 * from a shipped one once it is in there. Without an overlay it is absent, and everything
 * is the base game's -- which is the right answer for a page with no mod selected.
 *
 * Cached on the data like `furniturePresetNames`, and for the same reason.
 */
export function furniturePresetSections(data) {
    if (!data) return { modded: [], vanilla: [] };

    const cache = indexes(data);
    if (cache.sections) return cache.sections;

    const fromMod = new Set(
        (data.applied ?? [])
            .filter((asset) => asset.type === 'FurniturePreset')
            .map((asset) => asset.name)
    );

    const modded = [];
    const vanilla = [];
    for (const name of furniturePresetNames(data)) {
        (fromMod.has(name) ? modded : vanilla).push(name);
    }

    cache.sections = { modded, vanilla };
    return cache.sections;
}

/**
 * A preset by name, however it was typed, or null.
 *
 * Case-insensitive because this answers a text field: a name matched against a list the
 * app is showing should not depend on which case it was typed in, and every one of these
 * names is `CamelCase` with no two differing only by case.
 */
export function findFurniturePreset(data, typed) {
    const wanted = typed?.trim().toLowerCase();
    if (!wanted) return null;

    return furniturePresetNames(data).find((name) => name.toLowerCase() === wanted) ?? null;
}


/* -------------------------------------------------------------------------- */
/* What is wrong with the mod's own assets                                     */
/* -------------------------------------------------------------------------- */

/**
 * Problems in the mod's own furniture assets, independent of any square.
 *
 * Everything else in this file answers "what about *here*". These do not: they are
 * properties of what the mod ships, true before a square is picked and still true after,
 * and a reader who never selects the right cell would otherwise never see them.
 *
 * **Only the mod's own.** A shipped cluster with an odd element is the base game's
 * business, and an author cannot act on it. `applied` is what `overlayChain` recorded
 * merging, which is the only record of what came from where -- without an overlay this is
 * empty, which is the right answer for a page with no mod selected.
 *
 * The two element checks run over what the mod **patched** as well as what it wrote, and
 * that is a caveat kept deliberately: a `.sodso_patch.json` that does not state
 * `clusterElements` inherits the shipped ones, so patching either of the two base clusters
 * that hold a zero chance reports it. The warning is still true of the patched cluster --
 * it does have an element that never places -- and the alternative is tracking which
 * fields a patch stated all the way through the merge for a case worth two clusters.
 *
 * `cityWideWarning` is the other way round and runs only over what the mod wrote, for
 * reasons that are its own rather than this trade-off's. See `ownedByMod`.
 *
 * Returns a flat list, most severe first:
 *
 *     [{ cluster: 'BankLobbyDesks', severity: 'blocks' | 'degrades', text: '…' }]
 */
export function clusterWarnings(data) {
    if (!data) return [];

    const cache = indexes(data);
    if (cache.warnings) return cache.warnings;

    const mod = ownedByMod(data);
    const warnings = [];

    for (const name of mod.touched) {
        const cluster = data.clusters?.[name];
        if (!cluster) continue;

        warnings.push(...elementWarnings(name, cluster));

        // Written by the mod, not merely patched by it -- see `ownedByMod`.
        if (!mod.clusters.has(name)) continue;

        const reach = cityWideWarning(data, mod, name, cluster);
        if (reach) warnings.push(reach);
    }

    // `blocks` before `degrades`, and stable within each: the list is read top-down and
    // the thing that stops furniture appearing at all outranks the thing that thins it.
    const rank = { blocks: 0, degrades: 1 };
    cache.warnings = warnings.sort((a, b) => rank[a.severity] - rank[b.severity]);

    return cache.warnings;
}

/**
 * The names the mod contributed, by the types these checks are about.
 *
 * `touched` is every cluster the mod reached, written or patched, and is what the element
 * checks run over: a patch that does not state `clusterElements` inherits the shipped ones,
 * and the warning is still true of the cluster the game will load.
 *
 * The other three are what the mod **wrote**, patches excluded, and that is what the
 * city-wide check runs over instead. A patched shipped asset is one an author can act on
 * only within the base game's reach: the cluster was city-wide before they touched it, the
 * preset filling it is in every other room already, and the remedy -- confine the preset to
 * an address type or a building -- would take a shipped preset out of the city rather than
 * keep the mod's own furniture in. See `cityWideWarning`.
 */
function ownedByMod(data) {
    const touched = new Set();

    const clusters = new Set();
    const furniture = new Set();
    const roomClasses = new Set();

    for (const asset of data.applied ?? []) {
        if (asset.type === 'FurnitureCluster') touched.add(asset.name);
        if (asset.patch) continue;

        if (asset.type === 'FurnitureCluster') clusters.add(asset.name);
        if (asset.type === 'FurniturePreset') furniture.add(asset.name);
        if (asset.type === 'RoomClassPreset') roomClasses.add(asset.name);
    }

    return { touched, clusters, furniture, roomClasses };
}

/**
 * Elements that cannot do what the author meant, whatever room they land in.
 *
 * Both are uninitialised defaults rather than choices. A zero chance is the commoner of
 * the two and the harder to see, because the cluster still places -- just without that
 * piece, or not at all when the piece was required.
 *
 * A fractional chance is left alone. 16 of the base game's 18 stated chances are a
 * deliberate 0.5, 0.8 or 0.9, so "not 1" is not a defect and only "0" is.
 */
function elementWarnings(name, cluster) {
    const found = [];

    cluster.elements.forEach((element, index) => {
        const where = element.class ? `its ${element.class} element` : `element ${index}`;

        if (element.chance === 0) {
            found.push({
                cluster: name,
                severity: element.important ? 'blocks' : 'degrades',
                text: element.important
                    ? `${name} has a chanceOfPlacementAttempt of 0 on ${where}, which is `
                        + 'important to the cluster — so it is never attempted and the whole '
                        + 'cluster fails. This is almost always a field that should be 1.'
                    : `${name} has a chanceOfPlacementAttempt of 0 on ${where}, so that piece `
                        + 'is never attempted. This is almost always a field that should be 1.',
            });
        }

        if (element.zeroScale) {
            found.push({
                cluster: name,
                severity: 'blocks',
                text: `${name} has a localScale of 0,0,0 on ${where}, so it is placed correctly, `
                    + 'counts against every limit, and is rendered at no size at all. This is '
                    + 'almost always a field that should be 1,1,1.',
            });
        }
    });

    return found;
}

/**
 * A cluster that will turn up in rooms the mod does not own.
 *
 * Room filters are city-wide. A cluster allowed in `CorporateLobby` is offered to every
 * corporate lobby there is, not to the one building the mod ships -- which is how a set of
 * reception desks ends up across dozens of unrelated rooms.
 *
 * The remedy is on the **preset**, not the cluster: `onlyAllowInFollowing` with
 * `allowedInAddressesOfType`, or `OnlyAllowInBuildings` with `allowedInBuildings`. So the
 * question asked is whether any of the mod's own presets that could fill this cluster sets
 * either, and the warning is raised only when none does.
 *
 * ## What it does not fire on, and why
 *
 * **A room class the mod wrote itself.** A cluster whose filters reach nothing but the
 * mod's own classes reaches nothing but the mod's own rooms, however city-wide the
 * mechanism is -- the class is in no building but theirs, so there is no other room for it
 * to turn up in. That is the arrangement working, and it is the shape every custom room in
 * a mod is in: a `RoomClassPreset`, a `RoomTypeFilter` naming it, and a cluster gated on
 * that filter. Warned about, the check fired on the correct case more often than on the
 * defect. So the reach is counted over base game classes only, and the sentence names those
 * rather than every class the filters touch -- they are the rooms the author did not mean.
 *
 * **A cluster the mod only patched.** See `ownedByMod`: it was city-wide before the patch,
 * and the fix offered would be one the author cannot make without taking a shipped preset
 * out of the rest of the city.
 *
 * **A cluster whose slots only shipped furniture fills.** City-wide too, but the advice
 * would again be to gate the base game's presets. Silent rather than unhelpful.
 *
 * A cluster reaching no room class at all -- no filters, or filters naming nothing -- is
 * left alone here as well. It places nowhere, which is a different problem from placing too
 * widely and is not one this check is written to find.
 */
function cityWideWarning(data, mod, name, cluster) {
    const classes = new Set();
    for (const filter of cluster.filters) {
        for (const roomClass of data.filters?.[filter] ?? []) classes.add(roomClass);
    }

    const vanilla = [...classes].filter((roomClass) => !mod.roomClasses.has(roomClass)).sort();
    if (vanilla.length === 0) return null;

    const slots = new Set(cluster.elements.map((element) => element.class).filter(Boolean));
    if (slots.size === 0) return null;

    const filling = [...mod.furniture].filter((preset) =>
        data.furniture[preset]?.classes?.some((slot) => slots.has(slot)));

    if (filling.length === 0) return null;
    if (filling.some((preset) => isGated(data.furniture[preset]))) return null;

    const one = filling.length === 1;

    return {
        cluster: name,
        severity: 'degrades',
        text: `${name} is gated only by room filters, so it reaches every ${and(vanilla)} in the `
            + `city rather than just this mod's building. ${and(filling.sort())} `
            + `${one ? 'fills' : 'fill'} its slots and ${one ? 'sets' : 'set'} neither `
            + 'allowedInAddressesOfType nor allowedInBuildings.',
    };
}

/**
 * Whether a preset is confined to particular address types or buildings.
 *
 * `!= null` rather than `!== null`: both fields are written as an explicit null by the
 * builder when the gate is off, but a record from `soDefaults` or an older reference file
 * may simply not carry them, and an absent gate is an ungated preset either way.
 */
const isGated = (preset) =>
    !!preset && (preset.onlyIn != null || preset.onlyInBuildings != null);


/* -------------------------------------------------------------------------- */
/* The walk                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether one furniture preset could spawn on this square, and if not, the reason.
 *
 * **This is the only place the gates are written.** What could spawn here is this run
 * over every preset and the `possible` ones kept; why one thing cannot is this run over
 * that one. Two implementations of eight gates would drift, and would drift silently --
 * the list saying one thing and the verdict another, with nothing to catch it.
 *
 * Two states, because the data supports exactly two:
 *
 * | | |
 * |---|---|
 * | `no` | a gate this square answers says no. Sound: every gate here is a hard filter, so nothing that fails one can appear. |
 * | `possible` | nothing in the blueprint rules it out. **Not a promise** -- see `UNAPPLIED_GATES`, and the note at the top of this file. |
 *
 * There is deliberately no `yes`. A blueprint cannot know the district a building landed
 * in, the decor style the generator rolled for the room, or whether a cluster's
 * `placementChance` came up, so the strongest honest verdict is that nothing here forbids
 * it.
 *
 * ## The order is the chain's, and the first failure is the answer
 *
 * A preset that fails four gates fails the first one for a reason that contains the
 * others: `LargeBookcase` cannot reach an office because its room filters do not cover
 * `OfficeSpace`, and *therefore* no office cluster has a slot it can fill. Reporting both
 * says the same thing twice and buries the one an author can act on. So the walk runs
 * down the game's own chain and stops:
 *
 * | Order | Stage | Gate |
 * |---|---|---|
 * | 1 | `addressType` | `onlyAllowInFollowing` / `banInFollowing` against the preset claiming the unit |
 * | 2 | `roomClass` | `allowedRoomFilters` against the room's class |
 * | 3 | `roomSize` | `minimumRoomSize` against the room's square count |
 * | 4 | `cluster` | is any class it can fill named by a cluster placeable in this room |
 * | 5 | `square` | does this square have the right *number* of walls for any of those classes |
 * | 6 | `wallRules` | are the walls it has the right *kind*, in the right places, at some rotation |
 *
 * Which is the address level first, exactly as the chain resolves: stages 1 to 3 are
 * about whether it belongs in this *room* at all, and 4 to 6 about whether there is a
 * slot for it on this *square*.
 *
 * 5 and 6 are one gate in the game and two here, ordered coarse before fine for the same
 * reason the rest of the list is ordered: "this square has no walls and that needs one"
 * is a plainer thing to be told than which of its edges is the wrong kind, and a class
 * that fails the count would fail the rules for a reason that merely restates it.
 *
 * `group` and `square` come from `groupFor`, which resolves the address preset and the
 * room once for the whole catalogue rather than once per preset.
 */
export function checkFurniture(data, group, square, name) {
    const furniture = data?.furniture?.[name];

    // A mod's own preset, or one from a game newer than this reference data. Not a
    // failure of any gate -- there is nothing to put through them.
    if (!furniture) {
        return no('unknown', `The base game has no furniture preset called ${name}.`);
    }

    // 1. The address. Which preset claims the unit is decided before any room is
    //    furnished, so a preset shut out of this address type never reaches a room.
    if (furniture.onlyIn && !furniture.onlyIn.includes(group.address)) {
        return no('addressType', furniture.onlyIn.length === 0
            ? 'It is limited to a list of address types that is empty, so it can never place.'
            : `It is limited to ${and(furniture.onlyIn)}, and this unit would be ${group.address}.`);
    }

    if (furniture.bannedIn?.includes(group.address)) {
        return no('addressType', `It is banned from ${group.address}, which is what this unit would be.`);
    }

    // 2. The room's class, which is what every filter below the address keys off.
    if (!furniture.filters.some((filter) => group.filters.has(filter))) {
        return no('roomClass', furniture.filters.length === 0
            ? `It lists no room filters at all, so it cannot reach ${group.roomClass}.`
            : `Its room filters (${and(furniture.filters)}) do not cover ${group.roomClass}.`);
    }

    // 3. The room's size.
    if (square.roomSize < furniture.min) {
        return no('roomSize', `It needs a room of at least ${furniture.min} squares, and this `
            + `${square.roomType} has ${square.roomSize}.`);
    }

    // 4. A slot to sit in. Furniture is placed into slots that clusters put down, so a
    //    preset whose classes no placeable cluster names has nowhere to go however well
    //    it suits the room.
    const onClusters = furniture.classes.filter((slot) => group.slots.has(slot));

    if (onClusters.length === 0) return no('cluster', clusterReason(data, group, square, furniture));

    // 5. This square, by the count of its walls. The coarser half of the square gate, and
    //    first because "this square has no wall and that needs one" is a plainer thing to
    //    be told than which edge of it is wrong.
    const fits = onClusters.filter((slot) => wallsSuit(data.classes?.[slot], square.walls));
    if (fits.length === 0) return no('square', wallReason(data, onClusters, square));

    // 6. This square, by what is actually on its edges. Every class that got here has the
    //    right number of walls and may still want a different kind in a different place --
    //    a bookcase against a doorway is the case this catches and the count cannot.
    const failures = new Map();
    const suits = fits.filter((slot) => {
        const failure = wallRuleFailure(data, group, square, slot);
        if (failure) failures.set(slot, failure);
        return !failure;
    });

    if (suits.length === 0) return no('wallRules', ruleReason(data, fits, failures));

    return { verdict: 'possible', classes: suits };
}

const no = (stage, reason) => ({ verdict: 'no', stage, reason });

/** A list as prose, because these are read as sentences rather than scanned. */
const and = (names) => (names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * Why a preset the room otherwise suits has nowhere in it to stand.
 *
 * This is stage 4, and it is the one reason in the walk that was read as saying something
 * it does not. "No furniture cluster placeable in a BankATMVestibuleRCP has a slot of its
 * class" makes the *cluster* the subject, so it reads as "no cluster reaches this room" --
 * a room-filter problem -- when what it means is that clusters reach the room fine and put
 * down slots of other classes than this preset's. Those are opposite fixes: widen a
 * cluster's `allowedRoomFilters`, or add a class to the preset. So they are said
 * separately, off `clusterCount` rather than off an empty slot set, which cannot tell them
 * apart.
 *
 * The mistake that prompted this was a `FreestandingATM` listing only `1x1FreestandingATM`
 * in a room whose cluster put down `FreestandingATMBankFC` -- the preset's own class was
 * named in the reason and the one it needed was named nowhere at all.
 *
 * The class-mismatch case then names what the room *does* put down, because that is the
 * fact the author needs and the one place it is ever shown: a slot class nothing fills is
 * counted in the group listing but never named there, so a mod's own class sitting empty in
 * its own room was invisible from every panel.
 *
 * ## And then which file to open
 *
 * Naming the mismatch still left the reader to find the lever themselves. The clusters that
 * *would* have given the preset a home are the ones `groupFor` threw away -- so nothing
 * downstream could name them, and the author was told a slot of their class is missing
 * without being told who was supposed to put one down.
 *
 * `carrierHint` goes back for them. It is the same scan `groupFor` does, kept instead of
 * discarded and asked the opposite question: not which clusters reach this room, but which
 * clusters carry this class and what stopped each of them here. That turns the reason from
 * a diagnosis into an edit -- a cluster to open, and the two ends of the filter between it
 * and this room, either of which closes the gap.
 */
function clusterReason(data, group, square, furniture) {
    // A from-scratch `.sodso.json` gets `[]` here from the game's own defaults, so this is
    // an unstated field rather than an exotic state -- and it is a preset that can never
    // place in any room, which is worth saying outright rather than as a slot mismatch.
    if (furniture.classes.length === 0) {
        return 'It lists no furniture classes at all, so there is no slot it could ever fill.';
    }

    const its = furniture.classes.length === 1
        ? `its class ${furniture.classes[0]}`
        : `any of its classes (${and(furniture.classes)})`;

    // A room that comes to nothing comes to nothing whatever this preset lists, so it is
    // said in the room's own terms and shared with the panel, which reaches the same state
    // from the other side.
    const unfurnished = unfurnishedReason(group);
    if (unfurnished) return unfurnished;

    const count = group.slots.size;

    // `${roomClass} rooms` rather than `a ${roomClass}` throughout, here and there. An
    // article would have to be guessed from the name -- and the vowel rule that gets `an
    // Atrium` right gets `a Utility` wrong -- while the plural is exact for any name a mod
    // invents. It also says the true thing: a room filter names a class city-wide, not this
    // one room.
    //
    // Placeable clusters, none of whose elements names a class. Not a state the base game
    // is in anywhere, and one a mod reaches by writing `clusterElements` without a
    // `furnitureClass` on any of them.
    if (count === 0) {
        return group.clusterCount === 1
            ? `The one cluster placeable in ${group.roomClass} rooms puts down no furniture `
                + 'slots at all.'
            : `The ${group.clusterCount} clusters placeable in ${group.roomClass} rooms put down `
                + 'no furniture slots at all.';
    }

    const head = `Clusters are placeable in ${group.roomClass} rooms, but ${count === 1
        ? 'the one slot class they put down is not'
        : `none of the ${count} slot classes they put down is`} ${its}.`;

    const hint = missingSlotHint(data, group, square, furniture);
    return hint ? `${head} ${hint}` : head;
}

/**
 * Why a room gets no furniture at all, or null if it gets some.
 *
 * Two states, and the sentence used to say the first of them for both. "No furniture cluster
 * is placeable in BankArchivesRCP rooms" is read -- correctly, given the words -- as *no
 * cluster names this class*, which sends the author to their `RoomTypeFilter` to widen
 * something that is already wide enough. The bank archive that prompted this had four
 * clusters patched onto its filter and reaching it fine; the room is 213 squares and every
 * bookcase cluster in the game stops at 99 (`useMaximumRoomSize`, `GenerationController.cs`
 * :3463). The filter was never the problem, and the reason named it anyway.
 *
 * So the size case is said as a size: how many clusters reach the class, what they want,
 * and what this room is. The fix that follows from it is the room's shape or the cluster's
 * bound, neither of which the old sentence pointed at.
 *
 * Exported because the panel says the same thing when a group opens onto nothing, and two
 * wordings of one fact is how the misreading above got in.
 */
export function unfurnishedReason(group) {
    if (group.clusterCount > 0) return null;

    if (group.sizedOut === 0) {
        return `No furniture cluster is placeable in ${group.roomClass} rooms, so nothing is `
            + 'furnished there at all.';
    }

    const many = group.sizedOut > 1;

    // "Reach" rather than "is placeable in", which the sentences below this one use of a
    // cluster that clears every gate. These clear the filter and fail the next one, and
    // calling both the same thing is what put the reader in the wrong file.
    const who = many
        ? `${group.sizedOut} furniture clusters reach ${group.roomClass} rooms`
        : `One furniture cluster reaches ${group.roomClass} rooms`;

    // The bound quoted only when every cluster agrees on it, for the reason `carrierHint`
    // gives: clusters wanting different sizes have no single number between them, and
    // quoting one of them attaches it to all of them.
    return group.sizeBounds.length === 1
        ? `${who}, but ${many ? 'they all need' : 'it needs'} a room of ${group.sizeBounds[0]}, `
            + `and this one has ${group.roomSize}. Nothing is furnished here at all.`
        : `${who}, but no room of ${group.roomSize} squares is the size `
            + `${many ? 'any of them wants' : 'it wants'}. Nothing is furnished here at all.`;
}

/**
 * What to say after the mismatch: who was supposed to put this slot down.
 *
 * Three answers, and which one is right is a fact about the data rather than a preference:
 *
 * 1. **Clusters carry the class and are blocked here.** The ordinary case, and the only one
 *    with an edit at the end of it. `carrierHint` names them and the gate.
 * 2. **Nothing carries the class anywhere.** No filter reaches a cluster that does not
 *    exist, so the fix is a cluster rather than a filter -- the opposite instruction, and
 *    worth saying outright rather than leaving the reader to widen filters forever. Two base
 *    game presets are in this state (`SupermarketSignStarch` and `SupermarketSignSynthBeef`,
 *    both on the one class no cluster names), and a mod reaches it by writing a preset
 *    against a class before writing anything to put one down. `slotHint` still runs here and
 *    earns its keep: with no cluster to open, the nearest slot the room *does* put down is
 *    the whole lead, and for `1x1SupermarketShelvingSign` it finds the
 *    `1x1SupermarketShelvingBackward` the room is already full of.
 * 3. **Carriers exist and none is blocked.** Unreachable: a carrier that fits puts its class
 *    into `group.slots`, which makes stage 4's `onClusters` non-empty and this reason never
 *    runs. Handled by falling through to `slotHint` rather than by asserting, because the
 *    cost of being wrong is a weaker sentence and the cost of the alternative is a thrown
 *    error on a panel.
 */
function missingSlotHint(data, group, square, furniture) {
    const carriers = carriersOf(data, group, square, furniture);
    const blocked = carriers.filter((carrier) => carrier.gate);

    if (blocked.length > 0) return carrierHint(data, group, square, blocked);
    if (carriers.length > 0) return slotHint(data, group, furniture);

    const one = furniture.classes.length === 1;
    const orphan = `No cluster anywhere puts down ${one ? 'that slot' : 'any of those slots'}, `
        + `so widening a filter would not help: what is missing is a cluster with an element `
        + `of ${one ? 'that class' : 'one of those classes'}.`;

    const lead = slotHint(data, group, furniture);
    return lead ? `${orphan} ${lead}` : orphan;
}

/** How many carrier clusters a reason names in full before it counts the rest. */
const NAMED_CLUSTERS = 2;

/** How many filters a reason names in full before it counts them instead. */
const NAMED_FILTERS = 4;

/**
 * The gates in the order the reason would rather talk about them.
 *
 * `filters` first because it is the one an author can act on from either end and the one
 * they most often hit. `disable` last because there is no edit at the end of it: a cluster
 * the game ships switched off is not a mistake the reader made.
 */
const GATE_RANK = { filters: 0, size: 1, disable: 2 };

/**
 * Every cluster whose elements name a class this preset could fill, and what stopped each.
 *
 * Off `carriersByClass` rather than a scan, because this runs for every preset that fails
 * stage 4 and most of those answers are thrown away -- see the note in `indexes`.
 *
 * The mod's own clusters sort ahead of the base game's within a gate, for the same reason
 * `slotHint` prefers a mod's own classes: an author whose preset will not place has almost
 * always written the cluster themselves, and it is the one they can edit without patching
 * anything shipped.
 */
function carriersOf(data, group, square, furniture) {
    const { carriersByClass } = indexes(data);
    const mine = modNames(data, 'FurnitureCluster');

    // By cluster rather than by class: one cluster carrying both of a preset's classes is
    // one name in the sentence, and the classes it carries are what `carrierHint` names when
    // there is only one of each to name.
    const carried = new Map();
    for (const wanted of furniture.classes) {
        for (const name of carriersByClass.get(wanted) ?? []) {
            let slots = carried.get(name);
            if (!slots) carried.set(name, slots = new Set());
            slots.add(wanted);
        }
    }

    const found = [];
    for (const [name, slots] of carried) {
        const cluster = data.clusters[name];

        found.push({
            name,
            cluster,
            slots: [...slots].sort(),
            gate: blockedBy(cluster, group.filters, square.roomSize),
            mine: mine.has(name),
        });
    }

    return found.sort((a, b) => (GATE_RANK[a.gate] ?? 3) - (GATE_RANK[b.gate] ?? 3)
        || Number(b.mine) - Number(a.mine)
        || a.name.localeCompare(b.name));
}

/**
 * The clusters that carry this class, and the one edit that would let the best of them in.
 *
 * Only the leading gate is described. Carriers blocked three different ways would need
 * three sentences to say three things the reader has to try in turn, when any one of them
 * ends the problem -- so the reason picks the gate with the best fix and names the carriers
 * sharing it, which is one instruction rather than a menu.
 */
function carrierHint(data, group, square, blocked) {
    const gate = blocked[0].gate;
    const sharing = blocked.filter((carrier) => carrier.gate === gate);

    const named = sharing.slice(0, NAMED_CLUSTERS);
    const rest = sharing.length - named.length;
    const many = sharing.length > 1;

    const who = and(rest === 0
        ? named.map((carrier) => carrier.name)
        : [...named.map((carrier) => carrier.name), `${rest} other cluster${rest === 1 ? '' : 's'}`]);

    // The exact slot only when one carrier names one, which is when it is unambiguous. Two
    // carriers of different classes would need the pairing spelled out to mean anything, and
    // the reason above has already named every class the preset lists.
    const slot = !many && named[0].slots.length === 1
        ? `a ${named[0].slots[0]} slot`
        : 'a slot it could fill';

    const puts = `${who} would put down ${slot}`;

    if (gate === 'disable') {
        return `${puts}, but ${many ? 'are' : 'is'} disabled and ${many ? 'place' : 'places'} `
            + 'nowhere at all.';
    }

    if (gate === 'size') {
        // Over every carrier the sentence refers to, named or counted, and quoted only when
        // they agree. Clusters with different bounds have no single number between them, and
        // quoting one of them would attach it to all of them.
        const bounds = new Set(sharing.map((carrier) => sizeBound(carrier.cluster, square.roomSize)));

        return bounds.size === 1
            ? `${puts}, but ${many ? 'need' : 'needs'} a room of ${[...bounds][0]}, and this `
                + `${group.roomClass} has ${square.roomSize}.`
            : `${puts}, but no room of ${square.roomSize} squares is the size `
                + `${many ? 'they want' : 'it wants'}.`;
    }

    // Over every carrier sharing the gate rather than the two named, because "placeable only
    // in these rooms" is a claim about all of them and the ones counted are still blocked by
    // the same filters. Adding the room class to any one of them is the fix.
    const allowed = [...new Set(sharing.flatMap((carrier) => carrier.cluster.filters))].sort();

    // "The rooms X names" rather than "X rooms", which the sentence above uses of a room
    // class. These are filters, and a filter is not the room -- writing both the same way
    // invites the reader to look for a room class by the filter's name and find nothing.
    const where = allowed.length <= NAMED_FILTERS
        ? `${many ? 'are' : 'is'} placeable only in the rooms the ${and(allowed)} `
            + `filter${allowed.length === 1 ? ' names' : 's name'}`
        : `${many ? 'are' : 'is'} placeable only in rooms named by ${allowed.length} filters, `
            + `none of which names ${group.roomClass}`;

    const target = allowed.length === 1 ? 'that filter' : 'one of those filters';

    // A mod's own filter over a bare description of one, when the mod has a filter that
    // already names this room class. It is the end of the edit an author can make without
    // touching a shipped asset, and by stage 4 there is always at least one filter naming the
    // class -- an empty `group.filters` fails stage 2 first, so this is never a room with
    // nothing to offer.
    //
    // Named as "the X filter" because a filter and the class it names are routinely the same
    // word -- `Industrial` is both -- and this sentence has a room class in it already. Left
    // bare, the two halves of the fix read as the same edit twice.
    const ours = [...modNames(data, 'RoomTypeFilter')]
        .filter((name) => group.filters.has(name))
        .sort();

    const adding = ours.length > 0
        ? `the ${ours[0]} filter`
        : `a filter naming ${group.roomClass}`;

    // "That cluster's" rather than "its": the nearest noun by the time the reader gets here
    // is a filter, and filters have no `allowedRoomFilters` to add anything to.
    return `${puts}, but ${where}. Add ${group.roomClass} to the roomClasses of ${target}, `
        + `or add ${adding} to ${many ? "those clusters'" : "that cluster's"} allowedRoomFilters.`;
}

/** Which end of a cluster's size range this room falls outside, as the clause that says so. */
function sizeBound(cluster, roomSize) {
    return roomSize < cluster.min
        ? `at least ${cluster.min} squares`
        : `no more than ${cluster.max} squares`;
}

/** How many slot classes a reason will name in full before it summarises instead. */
const NAMED_SLOTS = 5;

/**
 * Which of the room's slot classes to put in front of the reader.
 *
 * **Reached only when no cluster anywhere carries the preset's class** -- see
 * `missingSlotHint`. Where a carrier exists it is named instead, because a cluster to open
 * and a gate to widen beat any amount of describing what the room has instead. What is left
 * is the case with no cluster to name at all, and there this is the only lead going: the
 * class the author should probably have listed is very likely one of the ones already being
 * put down a few feet away.
 *
 * Three sources, in the order of how much they are worth, and only the first that answers:
 *
 * 1. **The mod's own classes.** An author whose preset will not place in their own room has
 *    almost always written the class themselves and named it differently on the preset.
 *    `applied` is the only record of what came from where, so without an overlay this source
 *    is simply absent -- which is right for a page with no mod selected, where every class is
 *    the base game's and none is a lead.
 * 2. **All of them**, when the room puts down few enough to read. Nothing is hidden and
 *    nothing is guessed, which is the best answer available; it is not the first because a
 *    mod's own class among four is still the one to look at.
 * 3. **The nearest by name.** A guess, and worded as one. `sharedPrefix` is deliberately
 *    strict enough to return nothing rather than offer a coincidence, in which case the count
 *    in the sentence above stands alone. It earns its place on the base game's own orphan:
 *    `1x1SupermarketShelvingSign` against the `1x1SupermarketShelvingBackward` the room is
 *    full of.
 */
function slotHint(data, group, furniture) {
    const slots = [...group.slots].sort();

    const mine = modNames(data, 'FurnitureClass');
    const own = slots.filter((slot) => mine.has(slot));
    if (own.length > 0) {
        if (own.length <= 3) {
            // "Among them" needs a them. A room whose clusters put down one slot class is
            // exactly the shape a mod's own small room is in, so it is not a corner.
            const among = slots.length === 1 ? 'the one they put down' : 'among them';
            return `This mod's own ${and(own)} ${own.length === 1 ? 'is' : 'are'} ${among}.`;
        }

        return `${own.length} of them are this mod's own classes, including ${and(own.slice(0, 3))}.`;
    }

    if (slots.length <= NAMED_SLOTS) {
        return `${slots.length === 1 ? 'That is' : 'Those are'} ${and(slots)}.`;
    }

    const nearest = slots
        .map((slot) => ({
            slot,
            shared: Math.max(...furniture.classes.map((listed) => sharedPrefix(listed, slot))),
        }))
        .filter((entry) => entry.shared > 0)
        .sort((a, b) => b.shared - a.shared || a.slot.localeCompare(b.slot))[0];

    return nearest ? `The nearest by name is ${nearest.slot}.` : null;
}

/**
 * The names the mod defined of one type, memoised on the dataset like the rest.
 *
 * `applied` is the only record of what came from where, so without an overlay every one of
 * these is empty -- which is the right answer for a page with no mod selected, where
 * nothing is the author's and no name is a lead.
 */
function modNames(data, type) {
    const cache = indexes(data);
    cache.modNames ??= new Map();

    let names = cache.modNames.get(type);
    if (!names) {
        names = new Set((data.applied ?? [])
            .filter((asset) => asset.type === type)
            .map((asset) => asset.name));

        cache.modNames.set(type, names);
    }

    return names;
}

/**
 * The size a class name leads with, which is not part of what it is.
 *
 * `3x1IndustrialMachine` and `3x2IndustrialMachine` are the same thing in two footprints,
 * and 244 of the game's 262 classes carry one of these -- so comparing names without
 * dropping it makes every pair look 3 characters alike and the real match no closer.
 */
const SIZE_PREFIX = /^\d+x\d+/;

/**
 * How much two slot class names start out the same, or 0 if not enough to mean anything.
 *
 * A shared *head* rather than any shared run, because the head is the noun: `1x1Kitchenette`
 * and `1x1KitchenSink` share a real seven characters, while `2x1SofaAgainstWall` and
 * `1x1DeskAgainstWall` share eleven that say only that both stand against a wall. The two
 * thresholds are what keep the coincidences out -- long enough to be a word, and most of
 * the shorter name rather than an incidental head of a longer one. Over the base game's
 * data they leave 9 in 10 of these failures with no name offered at all, which is the right
 * way round: a wrong lead costs more than no lead.
 */
function sharedPrefix(left, right) {
    const a = left.replace(SIZE_PREFIX, '').toLowerCase();
    const b = right.replace(SIZE_PREFIX, '').toLowerCase();

    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;

    return shared >= 5 && shared >= Math.min(a.length, b.length) / 2 ? shared : 0;
}

/** Whether a slot class's wall rule is satisfied by a square with this many walls. */
function wallsSuit(geometry, walls) {
    if (!geometry) return true;
    return walls >= geometry.minWalls && walls <= geometry.maxWalls;
}


/* -------------------------------------------------------------------------- */
/* Wall rules                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `CityData.GetOffsetFromDirection` (CityData.cs:643), as the vectors it returns.
 *
 * `front` is +y and `right` is +x, so the four cardinals are the axes and the four
 * diagonals their sums. `none` is the zero vector, which is not an edge of anything.
 */
const DIRECTION_OFFSET = {
    none: [0, 0],
    front: [0, 1], behind: [0, -1], left: [-1, 0], right: [1, 0],
    frontLeft: [-1, 1], frontRight: [1, 1], behindLeft: [-1, -1], behindRight: [1, -1],
};

/** The four angles a cluster is tried at -- `CityData.angleArrayX4`, as quarter turns. */
const QUARTER_TURNS = [0, 1, 2, 3];

/**
 * A vector turned clockwise by quarter turns, which is what the generator applies to both
 * halves of a rule.
 *
 * `Toolbox.RotateVector2CW(v, clusterAngle + facingAngle)` at `GenerationController.cs:4841`
 * and `:4843`. Which way round it turns does not actually matter here, and that is worth
 * saying rather than leaving as luck: both the node offset and the wall direction are
 * turned by the *same* angle, so the geometry between them is preserved either way, and
 * the four angles are tried as a set. A clockwise convention read as anticlockwise would
 * visit the same four configurations in a different order.
 */
const turn = ([x, y], quarters) => {
    switch (quarters & 3) {
        case 1: return [y, -x];
        case 2: return [-x, -y];
        case 3: return [-y, x];
        default: return [x, y];
    }
};

/**
 * The wall on one edge of a node, named the way `wallDict` names it.
 *
 * The generator halves the rotated direction vector and snaps it to the nearest half
 * (`:4843-4844`), then looks it up in a dictionary keyed on `NewWall.wallOffset`. That
 * dictionary only ever holds the four cardinal half-offsets, so a diagonal or a `none`
 * lands in the no-wall branch however the floor is built -- which is not a quirk to work
 * around but the thing nine of the game's rules are written on. See `wallRulesOf`.
 *
 * Null for "no wall here", which the tag `nothing` is the only one to be satisfied by.
 */
function wallOn(model, x, y, [dx, dy]) {
    if (dx === 0 && dy === 1) return getWall(model, x, y, AXIS_Y);
    if (dx === 0 && dy === -1) return getWall(model, x, y - 1, AXIS_Y);
    if (dx === 1 && dy === 0) return getWall(model, x, y, AXIS_X);
    if (dx === -1 && dy === 0) return getWall(model, x - 1, y, AXIS_X);

    return null;
}

/**
 * What each tag asks of the wall it found, mirroring the switch at
 * `GenerationController.cs:4864-4980`.
 *
 * Ten read `sectionClass` alone, two more add `divider`, one reads `isFence`, and the two
 * that look past the wall ask about the node on its other side. `nothing` is here as an
 * explicit false because that is what the generator does with it (`:4907`): a wall that
 * exists never satisfies it, however little of a wall it is. The tag is satisfied by the
 * *absence* of a wall, which is handled before any of these is reached.
 *
 * `securityDoorDivider` and `lightswitch` are absent because their rules never arrive --
 * they are dropped when the reference file is built, and counted as `unchecked`.
 */
const TAG_TESTS = {
    nothing: () => false,
    wall: (wall) => wall.section === 'wall',
    window: (wall) => wall.section === 'window',
    windowLarge: (wall) => wall.section === 'windowLarge',
    entrance: (wall) => wall.section === 'entrance',
    ventUpper: (wall) => wall.section === 'ventUpper',
    ventLower: (wall) => wall.section === 'ventLower',
    ventTop: (wall) => wall.section === 'ventTop',
    wallOrUpperVent: (wall) => wall.section === 'wall' || wall.section === 'ventUpper',
    anyWindow: (wall) => wall.section === 'window' || wall.section === 'windowLarge',
    entranceDoorOnly: (wall) => wall.section === 'entrance' && !wall.divider,
    entraceDivider: (wall) => wall.section === 'entrance' && !!wall.divider,
    fence: (wall) => !!wall.fence,

    // Both look at the node on the other side of the wall, which a blueprint has: an
    // entrance into a different address (`:4902`), and one into a room the address preset
    // in hand configures as the named `RoomConfiguration` (`:4895`).
    addressEntrance: (wall, across) => wall.section === 'entrance'
        && across.node != null && across.node.addressIndex !== across.from.addressIndex,

    entranceToRoomOfType: (wall, across, rule) => wall.section === 'entrance'
        && across.config === rule.room,
};

/**
 * Whether every one of a class's wall rules holds at this square, at some rotation.
 *
 * The rotation is not a search the generator performs and this one does not either -- it
 * is four cases that all exist. Facing is authored per cluster element and fixed, and the
 * four orientations come from the cluster angle iterating `angleArrayX4` (`:4453`); since
 * every facing is itself one of those four angles (`:5502`), `clusterAngle + facingAngle`
 * ranges over exactly the same set whatever the facing. So "is there an angle at which
 * this class's rules hold on this square" is the whole question, and it needs no knowledge
 * of which cluster element brought the class here.
 *
 * `canFaceDiagonally` is carried on a class and deliberately not read. It is not an angle
 * the placement loop tries -- that loop iterates `angleArrayX4` and nothing else -- so
 * reading it here would test four rotations the game never evaluates rules at. Thirteen
 * classes set it.
 *
 * Returns the rule that failed at the *best* rotation, or null if some rotation works.
 * Best is the one that got furthest, because that is the rule an author can act on: a
 * class with four rules failing its first at three angles and its last at the fourth is
 * blocked by the last.
 *
 * ## The three states a rule can be in
 *
 * From `:4846-5082`, and the middle one is the one an obvious implementation gets wrong:
 *
 * | | `mustFeature` | `cantFeature` |
 * |---|---|---|
 * | offset node is not on the grid | fails | **fails** |
 * | node is there, no wall on that edge | holds only for `nothing` | rejects only for `nothing` |
 * | a wall is there | the tag decides | the tag decides |
 *
 * A `cantFeature` rule cannot be used to mean "the edge of the room is fine": `if (flag7
 * || !flag8)` at `:5092` rejects on a missing node as surely as on a matching wall. 88 of
 * the game's classes have rules that reach a neighbouring node, so this is not a corner.
 *
 * **A node counts as being there if it is on the grid.** The generator asks `nodeMap`,
 * which holds the nodes the city actually built -- and outside a building's footprint, on
 * a floor above the ground, there are none. A blueprint cannot tell the difference between
 * a square that is outside the building and one that is merely unpainted, so this takes
 * every square of the 21x21 as a node. That errs wide, which is the direction this whole
 * module errs in: a rule that should have failed passes, rather than furniture that can
 * really appear here being dropped from the list.
 */
function wallRuleFailure(data, group, square, slot) {
    const geometry = data.classes?.[slot];
    if (!geometry || !square.model) return null;

    const rules = geometry.wallRules ?? EMPTY_RULES;
    if (!rules.length && !needsFootprintCheck(geometry)) return null;

    let best = null;
    let bestReached = -1;

    for (const quarters of QUARTER_TURNS) {
        let reached = 0;
        let failed = footprintFailure(data, square, geometry, quarters);

        if (!failed) {
            for (const rule of rules) {
                if (!ruleHolds(data, group, square, rule, quarters)) { failed = { rule }; break; }
                reached++;
            }
        }

        if (!failed) return null;
        if (reached > bestReached) { bestReached = reached; best = failed; }
    }

    return best;
}

const EMPTY_RULES = [];

/**
 * Whether a class has anything for the footprint pass to say no about.
 *
 * Every class occupies at least one node, so this is never vacuously true -- but a 1x1
 * that occupies its tile, allows itself on a stairwell and wants no ceiling still has the
 * doorway and window checks to answer, and a class with none of those has only its own
 * node's existence, which stage 1 already established.
 */
const needsFootprintCheck = (geometry) => geometry.size != null
    || geometry.occupiesTile !== false || geometry.tall || geometry.wallPiece
    || geometry.needsCeiling || !geometry.noFloor || geometry.stairwell !== 'allowed';

/**
 * The footprint pass: every node a piece would cover, at one rotation.
 *
 * `GenerationController.cs:4545-4752` walks `objectSize.x` by `objectSize.y` and tests
 * each node it lands on. Every one of them must exist, and must be in the same room as
 * the anchor -- `newNode3.room != room` at `:4570`, which is stricter than fitting inside
 * the room, because a footprint that crosses into the next room fails even where both
 * rooms are large enough.
 *
 * The footprint is laid out at `clusterAngle + facingAngle - 180` (`:4543`) where the wall
 * rules use `clusterAngle + facingAngle`, so within one rotation of this loop it is turned
 * two further quarters. That is not a detail worth deriving twice: it is why a 3x1 piece
 * extends the way it does relative to the edge its rules name.
 *
 * The per-node gates are the ones a blueprint answers. Left out, because they read
 * generation state: `ceilingPiece` (air ducts and vents), `windowPiece` (a window already
 * spoken for), `tall` against air ducts, `allowLightswitch`, and `allowNewFurniture`.
 */
function footprintFailure(data, square, geometry, quarters) {
    const [w, h] = geometry.size ?? [1, 1];

    for (let i = 0; i < w; i++) {
        for (let j = 0; j < h; j++) {
            const [ox, oy] = turn([i, j], quarters + 2);
            const x = square.x + Math.round(ox);
            const y = square.y + Math.round(oy);

            const node = nodeAt(square.model, x, y);
            if (!node) return { covers: 'missing', x, y };

            const failure = nodeFailure(data, square, geometry, node, x, y);
            if (failure) return failure;
        }
    }

    return null;
}

/**
 * One node of a footprint, against the flags that bar a class from a square outright.
 *
 * These are not rules a class states about its surroundings but properties of the square
 * itself, and each is one line of the placement loop:
 *
 * | Gate | Refuses | Line |
 * |---|---|---|
 * | not `allowedOnStairwell` | a stairwell tile, **or any square orthogonally beside one** | `:4575-4591` |
 * | `onlyOnStairwell` | anything but a stairwell tile | `:4597` |
 * | not `allowIfNoFloor` | a square with no floor | `:4602` |
 * | `requiresCeiling` | a square with no ceiling | `:4633` |
 * | `occupiesTile` | a square carrying a doorway that is not a divider | `:4663` |
 * | `tall` or `wallPiece` | a square carrying a window of either size | `:4667` |
 *
 * The stairwell one reaches a square further than its name suggests, and the last two are
 * the widest of the six: 179 classes occupy their tile and 80 are tall.
 */
function nodeFailure(data, square, geometry, node, x, y) {
    if (roomOfNode(square.model, node) !== square.room) return { covers: 'otherRoom', x, y };

    const tile = tileForNode(square.model, x, y);

    if (geometry.stairwell == null) {
        if (tile?.isStairwell) return { square: 'stairwell', x, y };

        for (const [dx, dy] of ORTHOGONAL) {
            if (tileForNode(square.model, x + dx, y + dy)?.isStairwell) {
                return { square: 'besideStairwell', x, y };
            }
        }
    } else if (geometry.stairwell === 'only' && !tile?.isStairwell) {
        return { square: 'offStairwell', x, y };
    }

    if (!geometry.noFloor && !HAS_FLOOR.has(node.floorType)) return { square: 'noFloor', x, y };
    if (geometry.needsCeiling && !HAS_CEILING.has(node.floorType)) return { square: 'noCeiling', x, y };

    const edges = edgesOf(square.model, x, y).map((wall) => data.walls?.[wall.preset] ?? {});

    if (geometry.occupiesTile !== false
        && edges.some((wall) => wall.section === 'entrance' && !wall.divider)) {
        return { square: 'doorway', x, y };
    }

    if ((geometry.tall || geometry.wallPiece)
        && edges.some((wall) => wall.section === 'window' || wall.section === 'windowLarge')) {
        return { square: 'window', x, y };
    }

    return null;
}

const ORTHOGONAL = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Which `FloorTileType`s count as having a floor and a ceiling.
 *
 * `NewNode.HasValidFloor` and `HasValidCeiling` are not in the source served with
 * `GenerationController.cs`, so these are read off the enum
 * (`none, floorAndCeiling, floorOnly, CeilingOnly, noneButIndoors`) rather than off the
 * methods: a floor is the two named for one, a ceiling likewise. Every base game blueprint
 * uses only `none` and `floorAndCeiling`, so the middle three are reachable by an author
 * and not by anything shipped -- which is exactly when a wrong reading would go unnoticed,
 * and why it is written down here as an inference rather than a fact.
 */
const HAS_FLOOR = new Set([1, 2]);
const HAS_CEILING = new Set([1, 3]);

/** The walls on a node's four edges, the ones that are there. */
const edgesOf = (model, x, y) => [
    getWall(model, x, y, AXIS_X),
    getWall(model, x - 1, y, AXIS_X),
    getWall(model, x, y, AXIS_Y),
    getWall(model, x, y - 1, AXIS_Y),
].filter(Boolean);

/** One rule at one rotation. See the table on `wallRuleFailure`. */
function ruleHolds(data, group, square, rule, quarters) {
    const [ox, oy] = turn(rule.at ?? [0, 0], quarters);
    const x = square.x + Math.round(ox);
    const y = square.y + Math.round(oy);

    const node = nodeAt(square.model, x, y);
    if (!node) return false;

    const direction = turn(DIRECTION_OFFSET[rule.dir] ?? [0, 0], quarters);
    const wall = wallOn(square.model, x, y, direction);

    const met = wall
        ? !!TAG_TESTS[rule.tag]?.(
            data.walls?.[wall.preset] ?? {}, across(data, group, square.model, node, x, y, direction), rule)
        : rule.tag === 'nothing';

    return rule.must ? met : !met;
}

/**
 * The node on the other side of a wall, and what the address preset in hand calls its
 * room.
 *
 * Only the two tags that look past the wall ask for this, and both of them are about a
 * doorway: what is through it, and whether through it is somewhere else. The room is
 * given as a `RoomConfiguration` rather than as a `RoomTypePreset`, because that is what
 * the game compares (`foundWall.otherWall.node.room.preset`) -- and which configuration a
 * room type maps to is the address preset's choice, which is why this is resolved per
 * group rather than once per square.
 */
function across(data, group, model, from, x, y, [dx, dy]) {
    const node = nodeAt(model, x + dx, y + dy);
    const room = node ? roomOfNode(model, node) : null;

    return { from, node, config: room ? configFor(data, group.address, room.preset)?.name : null };
}

/**
 * Why none of a preset's slot classes suits this square.
 *
 * The nearest class is named rather than all of them. Every one of these failed, but they
 * failed by different margins, and the useful thing is the smallest change that would
 * help -- which is a square with one more wall far more often than it is a list.
 */
function wallReason(data, slots, square) {
    const rules = slots.map((slot) => ({ slot, ...data.classes[slot] }));

    const needMore = rules.filter((rule) => square.walls < rule.minWalls)
        .sort((a, b) => a.minWalls - b.minWalls)[0];

    // Preferred over the other direction: a class wanting a square clear of walls is
    // seven of the game's 262, and a class wanting one against a wall is 166.
    if (needMore) {
        return `Its slot class ${needMore.slot} needs a square touching at least `
            + `${walls(needMore.minWalls)}, and this one has ${walls(square.walls)}.`;
    }

    const needOpen = rules.filter((rule) => square.walls > rule.maxWalls)
        .sort((a, b) => b.maxWalls - a.maxWalls)[0];

    return `Its slot class ${needOpen.slot} needs a square touching at most `
        + `${walls(needOpen.maxWalls)}, and this one has ${walls(square.walls)}.`;
}

const walls = (count) => (count === 1 ? '1 wall' : `${count} walls`);

/**
 * What each tag is called when a rule is read back to someone.
 *
 * The game's spelling would be the safer choice for anything an author greps for, and it
 * is the wrong one here: these appear inside a sentence about a square someone is looking
 * at, and `wallOrUpperVent` in the middle of one reads as a variable name rather than as
 * the thing it describes. The class and the direction are still named exactly, so a rule
 * is findable from its reason.
 *
 * `entranceToRoomOfType` is absent because it is written with the room it names.
 */
const TAG_PROSE = {
    nothing: 'nothing at all',
    wall: 'a solid wall',
    window: 'a window',
    windowLarge: 'a large window',
    entrance: 'a doorway',
    ventUpper: 'an upper vent',
    ventLower: 'a lower vent',
    ventTop: 'a top vent',
    wallOrUpperVent: 'a solid wall or an upper vent',
    anyWindow: 'a window of any size',
    entranceDoorOnly: 'a doorway that is not a divider',
    entraceDivider: 'a divider',
    fence: 'a fence',
    addressEntrance: 'a doorway into another address',
};

/**
 * Where a rule looks, in the *furniture's* frame rather than the floor's.
 *
 * Both halves of a rule are turned by the same angle, so a rule that says `behind` says it
 * about whichever way the piece ends up facing. Naming a compass direction on the grid
 * would be naming one of the four rotations the check tried, which is not a fact about the
 * blueprint and not something an author can act on.
 */
const DIRECTION_PROSE = {
    none: 'on', front: 'in front of', behind: 'behind', left: 'to the left of',
    right: 'to the right of', frontLeft: 'diagonally in front-left of',
    frontRight: 'diagonally in front-right of', behindLeft: 'diagonally behind-left of',
    behindRight: 'diagonally behind-right of',
};

/**
 * Why none of a preset's slot classes suits this square's actual walls.
 *
 * Two sentences, and the split is the point. The first is the verdict and is about the
 * class: it cannot be turned any way that works here. The second is the nearest miss, and
 * is offered as that rather than as *the* reason -- a class with four rules typically
 * fails a different one at each rotation, so singling one out and calling it the blocker
 * would be false. What "nearest" means is the rotation that satisfied the most rules
 * before one failed, which is the one an author is closest to fixing.
 *
 * One class, for the same reason `wallReason` names one: every one of them failed, and
 * six paragraphs are read as a wall of text rather than as something to act on. The first
 * in name order, so the sentence is stable rather than depending on iteration order.
 */
function ruleReason(data, slots, failures) {
    const slot = [...slots].sort()[0];
    const failure = failures.get(slot);

    const verdict = `Its slot class ${slot} cannot be placed on this square any way round.`;

    if (!failure) return verdict;

    // A square the class is barred from outright, which is a plainer thing to say than a
    // rule and is said on its own: no rotation is going to help, and the offer of a
    // "closest it comes" would read as though one might.
    if (failure.square) return `${verdict} ${SQUARE_PROSE[failure.square]}`;

    if (failure.covers) {
        const size = data.classes?.[slot]?.size;
        const shape = size ? `${size[0]}x${size[1]}` : 'its';

        return `${verdict} It covers ${shape} squares, and every way round, one of them `
            + `${failure.covers === 'missing' ? 'is off the floor' : 'is in another room'}.`;
    }

    const { rule } = failure;
    const where = `${DIRECTION_PROSE[rule.dir] ?? 'beside'}${rule.at ? ` ${offsetProse(rule.at)}` : ' it'}`;

    const wants = rule.tag === 'entranceToRoomOfType'
        ? `a doorway into a ${rule.room}`
        : (TAG_PROSE[rule.tag] ?? rule.tag);

    return `${verdict} The closest it comes still ${rule.must
        ? `wants ${wants} ${where}`
        : `has ${wants} ${where}`}.`;
}

/**
 * The six ways a square bars a class regardless of how it is turned.
 *
 * Written as whole sentences rather than as fragments to slot into one, because they are
 * about different things -- a tile, a floor, an edge -- and a frame that fitted all six
 * would fit none of them well.
 */
const SQUARE_PROSE = {
    stairwell: 'It is not allowed on a stairwell tile.',
    besideStairwell: 'It is not allowed on a stairwell tile, nor on any square beside one.',
    offStairwell: 'It is only allowed on a stairwell tile.',
    noFloor: 'This square has no floor, and it needs one.',
    noCeiling: 'This square has no ceiling, and it needs one.',
    doorway: 'It takes up the whole square, and this one has a doorway on it.',
    window: 'It is tall enough to cover a window, and this square has one.',
};

/**
 * A rule's node offset, in the furniture's frame and in the terms the asset states it.
 *
 * `+y` is in front of the piece and `+x` is to its right, matching `GetOffsetFromDirection`
 * -- so a rule written `(-2, 0)` reaches two squares to the piece's left whichever way it
 * ends up facing. Unrotated for the same reason the directions are: the offset in the file
 * is the thing an author can go and edit.
 */
function offsetProse([x, y]) {
    const parts = [];
    const count = (n) => `${Math.abs(n)} ${Math.abs(n) === 1 ? 'square' : 'squares'}`;

    if (y) parts.push(`${count(y)} ${y > 0 ? 'in front' : 'behind'}`);
    if (x) parts.push(`${count(x)} to ${x > 0 ? 'its right' : 'its left'}`);

    return parts.length ? `the square ${parts.join(' and ')}` : 'it';
}


/* -------------------------------------------------------------------------- */

/** The `RoomConfiguration` an address preset gives this room type, and how it got there. */
function configFor(data, preset, roomType) {
    for (const name of data.addresses[preset].roomConfig ?? []) {
        if (data.roomConfigs[name]?.roomType === roomType) return { name, forced: false };
    }

    const forced = data.roomTypes?.[roomType];
    return forced && data.roomConfigs[forced] ? { name: forced, forced: true } : null;
}

/**
 * Which gate stops a cluster being attempted in a room of this class and size, or null if
 * none does.
 *
 * Written as the gate rather than as a boolean because stage 4 has to name the fix, and
 * the three answer to different ones: a filter can be widened from either end, a size
 * cannot be argued with, and `disable` is a cluster switched off. Telling an author to
 * edit a filter when the block is the room's size would be the same class of mistake the
 * note on `clusterReason` describes -- a true sentence read as the wrong instruction.
 *
 * The one implementation, read by `groupFor` for the clusters a room is given and by
 * `carriersOf` for the gate one carrier is stopped at, so the set and the reason cannot
 * disagree about which of them fit. `groupFor` used to ask a boolean wrapper instead, and
 * threw away the gate it had already computed -- which is why a room that came to nothing
 * could not say whether the filters or the size did it.
 */
function blockedBy(cluster, filters, roomSize) {
    if (cluster.disable) return 'disable';
    if (!cluster.filters.some((filter) => filters.has(filter))) return 'filters';
    if (roomSize < cluster.min) return 'size';
    if (cluster.max !== null && roomSize > cluster.max) return 'size';
    return null;
}

/**
 * How many of a square's four edges carry a wall.
 *
 * This is what `minimumZeroNodeWallCount` and `maximumZeroNodeWallCount` are counts of,
 * and it is the one placement rule on a `FurnitureClass` a blueprint can answer. 166 of
 * the game's 262 classes need at least one wall -- every wall piece, and everything that
 * stands against one like a bookcase or a bed -- and 15 need two, which is a corner.
 * Seven need *none*, so a square with walls loses those in turn.
 *
 * **Every wall counts, blanks among them.** The game compares against
 * `newNode.walls.Count` raw (`GenerationController.cs:4559`, and `:4400` for the cluster's
 * own bounds), and `NothingWall`, `NothingEntrance` and the three dividers are ordinary
 * `DoorPairPreset`s that get no special handling anywhere in that file. A square beside a
 * blank is against a wall as far as this count is concerned, however little there is to
 * see. So an edge is counted when it carries anything at all, and only an edge with no
 * wall on it is not a wall.
 *
 * `wallPresetKinds.json` says a divider is a blank, which is right for drawing one and
 * wrong for counting it -- so this does not read that table. What a wall *looks like* and
 * whether the generator has one to work with are different questions, and the second is
 * the only one asked here.
 *
 * Cheap enough for the pointer path: four lookups, and the answer is part of the memo key
 * rather than being asked again per class.
 */
function wallsAround(model, x, y) {
    return edgesOf(model, x, y).length;
}

/**
 * How many squares on the grid a room covers, which is what the game calls its size.
 *
 * `minimumRoomSize` and `maximumRoomSize` are both counts of nodes. Read off the grid
 * rather than off the room, because the grid is where painting has taken effect and the
 * room's own node list is rebuilt from it.
 */
function roomNodeCount(model, addressIndex, roomIndex) {
    let count = 0;
    for (const node of model.nodes) {
        if (node && node.addressIndex === addressIndex && node.roomIndex === roomIndex) count++;
    }
    return count;
}
