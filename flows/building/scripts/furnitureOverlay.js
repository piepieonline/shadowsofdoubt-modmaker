/**
 * The current mod's own furniture assets, merged over the base game's.
 *
 * Everything in `furnitureChain.js` reads one object: address presets, room
 * configurations, filters, clusters, classes and furniture, all keyed by name. That
 * object is the base game's, shipped as `refs/derived/furnitureChain.json` -- so without
 * this, every answer it gives about a mod is wrong, and wrong in the direction that
 * matters: a mod's own cluster makes furniture placeable that the walk calls impossible,
 * and its own address preset is a whole competing answer the walk never shows.
 *
 * "No" is only sound against the data it was asked of. This is what makes that data the
 * one the game will actually load.
 *
 * Nothing downstream changes. The walk is name-keyed throughout, so merging is a matter
 * of producing the same object with more in it -- and `furnitureChain.js` memoises on
 * the object's identity, so a fresh merge invalidates its caches by existing.
 *
 * ## What is read
 *
 * The **selected content folder only** -- `window.selectedMod.baseFolder`, which is where
 * every other read in this flow looks. Not the other content folders of the same mod, not
 * other mods, and not the load order between them.
 *
 * And only what the game would load. A `.sodso.json` is loaded because the mod's
 * `murdermanifest.sodso.json` names it in `fileOrder`, not because it is in the folder --
 * so a file that is not listed is reported rather than merged, which is the one failure
 * mode that otherwise shows up as a building silently missing from the city.
 *
 * ## Three ways an asset gets its values
 *
 * | Written as | Starts from |
 * |---|---|
 * | `<Name>.sodso.json` with `copyFrom` | the donor's record, resolved first |
 * | `<Name>.sodso_patch.json` | the shipped asset of that name |
 * | `<Name>.sodso.json` with no `copyFrom` | the type's defaults, from `soDefaults.json` |
 *
 * All three are the same operation -- a base record, with the fields the file states laid
 * over it -- which is why one `read*` per type serves all of them.
 *
 * The defaults are the game's own rather than anything written here, and that is
 * load-bearing: `FurniturePreset.minimumRoomSize` defaults to **99**, so a preset written
 * from scratch without one needs a 99-square room and will never place. Guessing 0 would
 * have made every from-scratch mod preset look fine.
 *
 * A list a file states **replaces** the base's rather than adding to it, which is the mod
 * loader's own rule for both `copyFrom` and patches -- see `HOW-IT-WORKS.md` on
 * `clusterElements` and `integratedInteractables`.
 *
 * ## A patch states fields; the current format does not
 *
 * That table is written in terms of the fields a file states, and a `.sodso_patch.json` no
 * longer states any: it holds a list of operations against the shipped asset's serialised
 * form -- see core/patchFormat.js. Read as a file of fields it states nothing, which every
 * reader here dutifully reported as "unchanged from the base game", so a patch had no
 * effect on any answer and the panel said it had been applied.
 *
 * So a patch in that format is turned back into the fields it states before it reaches the
 * merge, by applying it to the asset it patches and keeping the top-level fields that came
 * out different -- see `statedByPatch`. Everything below it is then unchanged, which is the
 * point: the merge already knows what to do with a file that states a field, including that
 * a patch's base may be another of the mod's own assets rather than the shipped one.
 */
import { readFileContent } from '../../../core/fs.js';
import { MANIFEST_FILE, isListed } from '../../../core/murderManifest.js';
import { readBaseAsset } from '../../../core/baseAssets.js';
import { applyPatches, isPatchFormat } from '../../../core/patchFormat.js';

import soDefaults from '../../../refs/generated/soDefaults.json' with { type: 'json' };

// Shared with `../tools/buildFurnitureChain.js`, which reads the game's own assets into
// the same records. The two readers must not drift -- see `readClass`.
import { wallRulesOf, stairwellOf } from '../../../core/furnitureRules.js';

/** What the mod loader calls a file of each kind. */
const PRESET_SUFFIX = '.sodso.json';
const PATCH_SUFFIX = '.sodso_patch.json';

/**
 * The nine types the chain is made of, and where each lands in the merged object.
 *
 * A file of any other type is skipped rather than reported: a mod holds companies,
 * occupations and murder presets too, and none of them is missing from anything.
 *
 * `DoorPairPreset` is the tenth type the reference file carries and is deliberately not
 * here. A blueprint stores a wall as an *index* into the game's list of them, so a mod's
 * own wall preset has no index this editor could know -- the whole wall system in this
 * flow is the base game's list, from `soDoorPairIds.json` outwards, and merging one type
 * of it while the rest stayed fixed would produce a wall nothing could refer to.
 */
const READERS = {
    FurniturePreset: { into: 'furniture', read: readFurniture },
    FurnitureClass: { into: 'classes', read: readClass },
    FurnitureCluster: { into: 'clusters', read: readCluster },
    AddressPreset: { into: 'addresses', read: readAddress },
    RoomConfiguration: { into: 'roomConfigs', read: readRoomConfig },
    RoomTypeFilter: { into: 'filters', read: readFilter },

    // Carried so a mod's own can be referred to, and because a room type may name a
    // forced configuration. Neither has a record of its own beyond that.
    RoomTypePreset: { into: 'roomTypes', read: readRoomType },
    RoomClassPreset: { into: null, read: null },
    LayoutConfiguration: { into: null, read: null },
};

export const CHAIN_TYPES = Object.keys(READERS);


/* -------------------------------------------------------------------------- */
/* Reading the folder                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every chain asset the mod defines, and the ones the game would not load.
 *
 * Returns `{ assets, unlisted, unresolved, manifest }`. `assets` are in no particular
 * order -- `copyFrom` is resolved by need rather than by file order, so a mod whose
 * `fileOrder` is wrong still merges correctly here. That is deliberate: the load order
 * matters to the game and this is not pretending to be the loader, only to know what it
 * would read.
 *
 * `unresolved` is the patches that could not be read, which is a report rather than a
 * silence on purpose -- see `resolvePatches`.
 *
 * A folder that cannot be read, or a file that will not parse, yields nothing rather than
 * throwing. A mod half-written is the normal state of one being written.
 */
export async function readModAssets(contentFolder) {
    const empty = { assets: [], unlisted: [], unresolved: [], manifest: null };
    if (!contentFolder) return empty;

    let manifest = null;
    const assets = [];
    const unlisted = [];

    try {
        for await (const entry of contentFolder.values()) {
            if (entry.kind !== 'file') continue;

            if (entry.name === MANIFEST_FILE) {
                manifest = await readJson(entry);
                continue;
            }

            const patch = entry.name.endsWith(PATCH_SUFFIX);
            const suffix = patch ? PATCH_SUFFIX : PRESET_SUFFIX;
            if (!patch && !entry.name.endsWith(PRESET_SUFFIX)) continue;

            const raw = await readJson(entry);
            const type = raw?.fileType ?? raw?.type;
            if (!READERS[type]) continue;

            assets.push({
                // `presetName` is what the asset calls itself and what everything refers
                // to it by. The file name is what the manifest lists.
                name: raw.presetName ?? raw.name ?? entry.name.slice(0, -suffix.length),
                file: entry.name.slice(0, -suffix.length),
                type,
                patch,
                raw,
            });
        }
    } catch {
        // A folder that went away between being chosen and being read.
        return empty;
    }

    // The manifest decides what the game reads. A mod with no manifest at all loads
    // nothing, which is a state worth reporting rather than one to paper over by
    // pretending every file counts.
    const listed = [];
    for (const asset of assets) {
        if (isListed(manifest, asset.file)) listed.push(asset);
        else unlisted.push(asset);
    }

    // Only the listed ones. Reading a base asset per patch costs a file read or a fetch,
    // and a patch the game never loads has nothing to say about what spawns anywhere.
    const { resolved, unresolved } = await resolvePatches(listed);

    return { assets: resolved, unlisted, unresolved, manifest };
}

async function readJson(handle) {
    try {
        return JSON.parse(await readFileContent(handle));
    } catch {
        // A file half-written, or one that is not JSON at all. A mod being edited is
        // full of those, and one of them is not a reason to read none of the others.
        return null;
    }
}


/* -------------------------------------------------------------------------- */
/* Patches, as the fields they state                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every operation-format patch turned back into a file of fields, and the ones that could
 * not be.
 *
 * A patch that cannot be resolved is **left out of `assets` and reported** rather than
 * merged as though it stated nothing. Merging it would be the bug this exists to fix
 * wearing a different hat: the walk would answer against the shipped values, `applied`
 * would count the patch, and the panel would say it had been taken into account. An answer
 * that is wrong is worth less than no answer, and this column already says where it is
 * blind -- see the note on `UNAPPLIED_GATES`.
 *
 * There are two ways it happens, and only one of them is the author's mistake:
 *
 * - **The asset is out of reach.** `refs/assets/` ships nine types and none of them is in
 *   this chain, so a furniture patch is readable only against a connected export of the
 *   author's own ScriptableObjects. The editor refuses to open or create a patch without
 *   one, so a patch authored here always has it; a hand-written one, or a mod opened on
 *   another machine, may not.
 * - **An operation will not apply.** Almost always the base having moved on -- the patch
 *   was written against one version of the game and is being read against another. The
 *   ScriptableObject editor refuses to open it for the same reason and says the same thing.
 */
async function resolvePatches(assets) {
    const resolved = [];
    const unresolved = [];

    for (const asset of assets) {
        if (!asset.patch || !isPatchFormat(asset.raw)) {
            resolved.push(asset);
            continue;
        }

        // The file as it is written, so the panel can name it without knowing how a patch
        // is spelt. It draws what it is handed and reaches for nothing itself.
        const path = asset.file + PATCH_SUFFIX;

        const { document: base, reason } = await readBaseAsset(asset.type, asset.name);

        if (!base) {
            unresolved.push({ ...asset, path, reason });
            continue;
        }

        const { document, failed } = applyPatches(base, asset.raw.patches);

        if (!document) {
            unresolved.push({
                ...asset,
                path,
                reason: `change ${failed.index + 1} (${failed.op.op} ${failed.op.path}) could `
                    + `not be made: ${failed.reason}`,
            });
            continue;
        }

        resolved.push({ ...asset, raw: statedByPatch(base, document) });
    }

    return { resolved, unresolved };
}

/**
 * The top-level fields a patch changed, which is the shape every reader below expects.
 *
 * The whole field, not the part of it an operation named. An operation may reach deep into
 * an array -- `/clusterElements/[name=Desk]/chanceOfPlacementAttempt` -- and there is no
 * partial form for that: the value the game's object ends up holding is the whole
 * `clusterElements` array with one element altered, and a list a file states replaces the
 * base's outright. So the changed array goes through whole and the existing rule covers it.
 *
 * Trimmed to what changed rather than passed through entire, and that is the load-bearing
 * part. A resolved patch is a *complete* document, and a complete document states every
 * field -- which would make a patch override a mod's own `.sodso.json` of the same name
 * field for field, and override what a `copyFrom` inherited, neither of which a patch says.
 * Cut to the difference, it says exactly what it changed and the merge does the rest.
 *
 * A field the patch *removed* outright reads as unstated, so the base's value stands. That
 * is not a compromise: a serialised document missing a field leaves the live object's own
 * value alone, which is the same answer.
 *
 * Compared by serialising, which is sound here and would not be in general: `applyPatches`
 * clones the base and mutates the clone, so an untouched subtree is byte-identical to the
 * one it came from, and a key order that differs is an object an operation rebuilt.
 */
function statedByPatch(base, document) {
    const stated = {};

    for (const [field, value] of Object.entries(document)) {
        if (JSON.stringify(base[field]) !== JSON.stringify(value)) stated[field] = value;
    }

    return stated;
}


/* -------------------------------------------------------------------------- */
/* Merging                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The base game's chain with the mod's assets laid over it.
 *
 * Returns a new object, always -- `furnitureChain.js` keys its caches on identity, so
 * handing back the base unchanged when a mod defines nothing would be right but handing
 * back a *mutated* base would poison every answer for the life of the page. Nothing here
 * writes to `base`.
 *
 * `applied` is what the panel says: how many of the mod's assets reached the chain, and
 * of what.
 */
export function overlayChain(base, assets) {
    if (!base) return null;

    const merged = {
        addresses: { ...base.addresses },
        roomConfigs: { ...base.roomConfigs },
        roomTypes: { ...base.roomTypes },
        filters: { ...base.filters },
        clusters: { ...base.clusters },
        furniture: { ...base.furniture },
        classes: { ...base.classes },

        // Carried across untouched, and the one block here a mod can never add to:
        // `DoorPairPreset` is deliberately absent from `READERS`, because a blueprint
        // stores a wall as an index into the game's own list and a mod's own has no
        // index this editor could know.
        //
        // Copied all the same rather than left out. Leaving it out is what this used to
        // do, and every wall preset then resolved to `{}` the moment any mod was
        // selected -- so `section` was undefined, every `wallOrUpperVent` rule failed,
        // and a mailbox or an ATM against a plain wall was reported as wanting one. The
        // wall *count* was unaffected, which is what made it read as the count being
        // wrong rather than the table being gone.
        walls: { ...base.walls },
    };

    if (!assets?.length) return { ...merged, applied: [] };

    const byName = new Map();
    for (const asset of assets) byName.set(`${asset.type}|${asset.name}`, asset);

    const resolving = new Set();
    const applied = [];

    /**
     * One asset's record, with whatever it copies from resolved first.
     *
     * Recursive because `copyFrom` chains: a mod preset may clone another of its own,
     * which clones a shipped one. `resolving` is the cycle guard -- a file copying
     * itself, directly or round a ring, falls back to the type's defaults rather than
     * recursing until the stack gives out.
     */
    function recordFor(asset) {
        const { into, read } = READERS[asset.type];
        if (!into || !read) return null;

        const key = `${asset.type}|${asset.name}`;
        if (resolving.has(key)) return read(asset.raw, defaultsFor(asset.type, read));

        resolving.add(key);
        try {
            return read(asset.raw, baseRecordFor(asset, into, read));
        } finally {
            resolving.delete(key);
        }
    }

    /** What an asset's own fields are laid over. */
    function baseRecordFor(asset, into, read) {
        // A patch has no `copyFrom`; its base is the asset it is patching, which is
        // whatever is in the chain under that name -- shipped, or another of the mod's.
        if (asset.patch) return merged[into][asset.name] ?? defaultsFor(asset.type, read);

        const donor = refName(asset.raw.copyFrom);
        if (!donor) return defaultsFor(asset.type, read);

        // The donor may itself be the mod's, and may not have been merged yet.
        const own = byName.get(`${asset.type}|${donor}`);
        if (own) return recordFor(own) ?? defaultsFor(asset.type, read);

        return merged[into][donor] ?? defaultsFor(asset.type, read);
    }

    for (const asset of assets) {
        const { into } = READERS[asset.type];

        // A `RoomClassPreset` and a `LayoutConfiguration` keep no fields the chain reads
        // -- they are identities, referred to by name from the records that do. Merging
        // one is a no-op, and counting it is still right: it is the mod's, and it is why
        // some other record's reference resolves.
        if (into) merged[into][asset.name] = recordFor(asset);

        applied.push({ name: asset.name, type: asset.type, patch: asset.patch });
    }

    return { ...merged, applied };
}

/**
 * The game's own defaults for a type, in the shape the chain keeps.
 *
 * Read through the same `read*` the files go through, so a default and a stated value
 * cannot be interpreted differently. `soDefaults.json` is the generator's dump of what a
 * new ScriptableObject of each type holds.
 */
const defaultsCache = new Map();

function defaultsFor(type, read) {
    if (!defaultsCache.has(type)) {
        defaultsCache.set(type, read(soDefaults[type] ?? {}, read({}, EMPTY_RECORD)));
    }
    return defaultsCache.get(type);
}

/** What a type with no defaults at all falls back to. Every reader tolerates it. */
const EMPTY_RECORD = {};


/* -------------------------------------------------------------------------- */
/* References                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The name a mod's reference points at.
 *
 * A mod writes `REF:FurniturePreset|LargeBookcase`, where the dump this app's reference
 * data came from wrote a Unity pathID. Both end up as a bare name, which is why the
 * merged object needs no other reconciling.
 *
 * A reference with no type -- `REF:Something`, which is the shape `fileOrder` uses -- is
 * taken as the name, and a bare string as itself: a mod may write either, and neither is
 * ambiguous once the field it sits in has already said what type it is.
 */
export function refName(value) {
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === 'null') return null;

    const withoutPrefix = trimmed.replace(/^REF:/i, '');
    const bar = withoutPrefix.indexOf('|');

    const name = bar >= 0 ? withoutPrefix.slice(bar + 1) : withoutPrefix;
    return name.trim() || null;
}

const refNames = (value) => (Array.isArray(value) ? value.map(refName).filter(Boolean) : []);

/** Whether a file states a field at all, which is what decides if it overrides. */
const states = (raw, field) => raw != null && Object.hasOwn(raw, field);


/* -------------------------------------------------------------------------- */
/* One reader per type                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Each of these takes the raw JSON of a file and the record its values lay over, and
 * produces a record of the shape `buildFurnitureChain.js` writes. A field the file does
 * not state is the base's; one it does replaces the base's outright, list or not.
 *
 * The pairs are the fiddly part. `onlyIn` is not a field -- it is
 * `onlyAllowInFollowing ? allowedInAddressesOfType : null`, folded that way when the
 * reference data was built -- so a file stating either half has to be read against the
 * base *unfolded* and folded again.
 */
function readFurniture(raw, base) {
    const only = pairing(raw, 'onlyAllowInFollowing', 'allowedInAddressesOfType', base?.onlyIn);
    const banned = pairing(raw, 'banInFollowing', 'bannedInAddressesOfType', base?.bannedIn);

    return {
        classes: states(raw, 'classes') ? refNames(raw.classes) : (base?.classes ?? []),
        filters: states(raw, 'allowedRoomFilters')
            ? refNames(raw.allowedRoomFilters) : (base?.filters ?? []),
        min: states(raw, 'minimumRoomSize') ? Number(raw.minimumRoomSize) : (base?.min ?? 0),
        universal: states(raw, 'universalDesignStyle')
            ? !!raw.universalDesignStyle : !!base?.universal,
        onlyIn: only,
        bannedIn: banned,

        // The other half of "confine this to my own content". Not a gate -- see the note
        // in buildFurnitureChain.js -- but the difference between a preset an author has
        // pinned to their building and one that will turn up city-wide.
        onlyInBuildings: pairing(
            raw, 'OnlyAllowInBuildings', 'allowedInBuildings', base?.onlyInBuildings),
    };
}

/**
 * A flag and its list, back into the one nullable list the chain keeps.
 *
 * Null when the flag is off, which is "no restriction" -- as against an empty list, which
 * is a restriction to nothing and is a preset that can never place. The two have to stay
 * distinguishable; see `checkFurniture`, which says so in as many words.
 */
function pairing(raw, flagField, listField, baseList) {
    const on = states(raw, flagField) ? !!raw[flagField] : baseList !== null && baseList !== undefined;
    if (!on) return null;

    return states(raw, listField) ? refNames(raw[listField]) : (baseList ?? []);
}

/**
 * A mod's `FurnitureClass`, in the shape `buildFurnitureChain.js` writes.
 *
 * Field for field with the `classes` block of that file, and it has to stay that way: a
 * mod's class that came out shaped differently from a shipped one would be gated
 * differently by the resolver, and only on the author's own content -- the last place it
 * would be noticed. The wall rules and the stairwell fold are literally the same code,
 * imported from `furnitureRules.js`; the rest is mirrored here because the merge semantics
 * differ, a field a file does not state being the base's rather than the game's default.
 *
 * The optional keys are written only when they say something, so that a record built here
 * and one built there compare equal. Absent means the game's default in both.
 */
function readClass(raw, base) {
    const rules = states(raw, 'wallRules') ? wallRulesOf(raw, refName) : null;
    const wallRules = rules ? rules.rules : (base?.wallRules ?? null);
    const unchecked = rules ? rules.unchecked : (base?.unchecked ?? 0);

    const size = states(raw, 'objectSize')
        ? [Number(raw.objectSize?.x ?? 1), Number(raw.objectSize?.y ?? 1)]
        : (base?.size ?? null);

    // Both halves of the fold, each from the file if it states it and from the base
    // otherwise -- a file may restate one and leave the other alone.
    const stairwell = stairwellOf(
        states(raw, 'allowedOnStairwell') ? !!raw.allowedOnStairwell : base?.stairwell != null,
        states(raw, 'onlyOnStairwell') ? !!raw.onlyOnStairwell : base?.stairwell === 'only');

    const range = states(raw, 'allowedOnFloorRange')
        ? [Number(raw.allowedOnFloorRange?.x ?? 0), Number(raw.allowedOnFloorRange?.y ?? 0)]
        : (base?.floorRange ?? null);

    const onFloor = states(raw, 'limitToFloor')
        ? !!raw.limitToFloor : base?.floor !== undefined;

    const inRange = states(raw, 'limitToFloorRange')
        ? !!raw.limitToFloorRange : base?.floorRange !== undefined;

    return {
        minWalls: states(raw, 'minimumZeroNodeWallCount')
            ? Number(raw.minimumZeroNodeWallCount) : (base?.minWalls ?? 0),
        maxWalls: states(raw, 'maximumZeroNodeWallCount')
            ? Number(raw.maximumZeroNodeWallCount) : (base?.maxWalls ?? 4),
        wallPiece: states(raw, 'wallPiece') ? !!raw.wallPiece : !!base?.wallPiece,

        ...(wallRules?.length ? { wallRules } : {}),
        ...(unchecked ? { unchecked } : {}),
        ...(size && (size[0] !== 1 || size[1] !== 1) ? { size } : {}),
        ...(stairwell ? { stairwell } : {}),

        ...(states(raw, 'allowIfNoFloor') ? !!raw.allowIfNoFloor : base?.noFloor)
            ? { noFloor: true } : {},
        ...(states(raw, 'canFaceDiagonally') ? !!raw.canFaceDiagonally : base?.diagonal)
            ? { diagonal: true } : {},
        ...(states(raw, 'requiresCeiling') ? !!raw.requiresCeiling : base?.needsCeiling)
            ? { needsCeiling: true } : {},
        ...(states(raw, 'tall') ? !!raw.tall : base?.tall)
            ? { tall: true } : {},

        // The one field whose game default is true, so it is written when false and its
        // absence means "occupies" -- see the note in buildFurnitureChain.js.
        ...(states(raw, 'occupiesTile') ? !!raw.occupiesTile : base?.occupiesTile !== false)
            ? {} : { occupiesTile: false },

        ...(onFloor
            ? { floor: states(raw, 'allowedOnFloor') ? Number(raw.allowedOnFloor) : (base?.floor ?? 0) }
            : {}),
        ...(inRange ? { floorRange: range ?? [0, 0] } : {}),
    };
}

function readCluster(raw, base) {
    // `max` is `useMaximumRoomSize ? maximumRoomSize : null`, folded the same way
    // `onlyIn` is. Null is "no maximum" and 99 is a maximum that happens to be large.
    const useMax = states(raw, 'useMaximumRoomSize')
        ? !!raw.useMaximumRoomSize
        : base?.max !== null && base?.max !== undefined;

    const max = states(raw, 'maximumRoomSize') ? Number(raw.maximumRoomSize) : (base?.max ?? 99);

    return {
        disable: states(raw, 'disable') ? !!raw.disable : !!base?.disable,
        filters: states(raw, 'allowedRoomFilters')
            ? refNames(raw.allowedRoomFilters) : (base?.filters ?? []),
        min: states(raw, 'minimumRoomSize') ? Number(raw.minimumRoomSize) : (base?.min ?? 0),
        max: useMax ? max : null,
        elements: states(raw, 'clusterElements')
            ? (raw.clusterElements ?? []).map(readElement)
            : (base?.elements ?? []),
    };
}

/**
 * One cluster element, in the shape `buildFurnitureChain.js` writes.
 *
 * The two placement fields are stored the way that file stores them -- omitted when they
 * are the plain default -- so one record shape comes out of both routes and
 * `clusterWarnings` needs to know only one convention.
 *
 * **An absent `chanceOfPlacementAttempt` is taken as 1, and that is a deliberate limit.**
 * Whether the loader leaves an absent float at C#'s `0f` or the class initialises it to
 * `1f` is not something this repo can establish, and the two readings disagree about every
 * hand-written element that omits the field. Reading absent as 0 would report those as
 * broken, and a warning that fires on correct files is worse than one that misses: it
 * teaches the reader to ignore the section. So only a **stated** 0 is reported, which is
 * the form every file the game or the editor writes would use anyway.
 */
function readElement(element) {
    const chance = Number(element?.chanceOfPlacementAttempt ?? 1);
    const scale = element?.localScale;

    return {
        class: refName(element?.furnitureClass),
        important: !!element?.importantToCluster,
        ...(chance === 1 ? {} : { chance }),
        ...(scale && scale.x === 0 && scale.y === 0 && scale.z === 0 ? { zeroScale: true } : {}),
    };
}

function readAddress(raw, base) {
    return {
        compatible: states(raw, 'compatible') ? refNames(raw.compatible) : (base?.compatible ?? []),
        roomConfig: states(raw, 'roomConfig') ? refNames(raw.roomConfig) : (base?.roomConfig ?? []),
        company: states(raw, 'company') ? !!refName(raw.company) : !!base?.company,
        residence: states(raw, 'residence') ? !!refName(raw.residence) : !!base?.residence,
    };
}

function readRoomConfig(raw, base) {
    return {
        roomType: states(raw, 'roomType') ? refName(raw.roomType) : (base?.roomType ?? null),
        roomClass: states(raw, 'roomClass') ? refName(raw.roomClass) : (base?.roomClass ?? null),
    };
}

/** A `RoomTypeFilter` is its list of room classes and nothing else. */
function readFilter(raw, base) {
    return states(raw, 'roomClasses') ? refNames(raw.roomClasses) : (base ?? []);
}

/** A `RoomTypePreset` is kept only for its fallback configuration. */
function readRoomType(raw, base) {
    return states(raw, 'forceConfiguration')
        ? refName(raw.forceConfiguration)
        : (typeof base === 'string' ? base : null);
}
