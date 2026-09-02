/**
 * Derives refs/derived/furnitureChain.json from a dump of the game's ScriptableObjects.
 *
 *   node buildFurnitureChain.js http://192.168.2.70:8080
 *   node buildFurnitureChain.js /path/to/export
 *
 * The source is a folder per type holding one JSON file per asset, either on disk or
 * behind an HTTP server that indexes directories. Twelve of those types describe how the
 * game decides what furniture a room gets; this reads them, resolves their cross
 * references, throws away every field the editor does not read, and writes what is left as
 * two files.
 *
 * The trimming is the point. The twelve types are 1,452 files and 8 MB, which is not
 * something a hover can wait on; what survives is 233 KB of chain, 21 KB over the wire,
 * fetched once per page, with 124 KB beside it for the room creator.
 *
 * The two files are read by two different panes and compose rather than overlap:
 *
 * | File | Read by | Answers |
 * |---|---|---|
 * | `furnitureChain.json` | the building flow's furniture panel | what could spawn on a square |
 * | `roomCreator.json` | the room creator | what a room admits, given where it sits |
 *
 * A field belongs to exactly one of them. Writing one into two would be two answers to one
 * question about the game, with nothing to say which was right -- the duplication
 * `refs/README.md` exists to prevent, and what the reference-data tests pin.
 *
 * **There is no third file.** The furniture creator used to read one and now reads the
 * author's own exported ScriptableObjects an asset at a time: a trim has to anticipate
 * every question, that one had to be widened three times in a day, and the pane it served
 * is opened deliberately rather than on every pointer move. See
 * `flows/scriptableObject/scripts/furnitureAssets.js`.
 *
 * Where a field's meaning comes from the game's own code, the comment cites it by line in
 * `GenerationController.cs`, which is served at the root of the dump alongside
 * `enums.json`. Anything about furniture placement that reads as a judgement call should
 * be checked there before it is trusted -- one already turned out to be wrong.
 *
 * References in the dump are `{m_FileID, m_PathID}` and are resolved through
 * refs/generated/soPathIds.json, which is the generator's map of Unity pathID to asset
 * name. 149 of the 10,296 references in these nine types resolve to nothing: they are
 * prefabs, sprites and materials, which are not ScriptableObjects and so are not in that
 * map. None of them is a reference this reads.
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = join(ROOT, 'refs', 'derived', 'furnitureChain.json');
const OUT_ROOMS = join(ROOT, 'refs', 'derived', 'roomCreator.json');

/**
 * The twelve types the two files are made of. Anything not here is not read.
 *
 * `MaterialGroupPreset` and `RoomLightingPreset` are the room creator's alone: materials
 * and lighting are gated on the room the same way furniture is, and neither is reachable
 * from a square, so the building flow's walk never wanted them.
 *
 */
const TYPES = [
    'AddressPreset', 'RoomConfiguration', 'RoomTypePreset', 'RoomTypeFilter',
    'FurnitureCluster', 'FurnitureClass', 'FurniturePreset', 'RoomClassPreset',
    'LayoutConfiguration', 'DoorPairPreset',
    'MaterialGroupPreset', 'RoomLightingPreset',
];

// The enums and the wall-rule reader are shared with `furnitureOverlay.js`, which reads a
// mod's `FurnitureClass` files into the same shape. See that module on why the enums are
// not taken from `soEnums.json`.
import { WALL_SECTION_CLASS, wallRulesOf, stairwellOf } from '../../../core/furnitureRules.js';


/* -------------------------------------------------------------------------- */
/* Reading the dump                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every asset of one type, as `name -> object`.
 *
 * An HTTP source is read through the directory listing `http-server` generates, which is
 * the shape the export happens to be served in. Only the hrefs ending `.json` are taken,
 * so the parent-directory link and the footer are skipped without parsing the HTML.
 *
 * ## Where a file is and what it is called are two different strings
 *
 * Four of the game's assets have a space in the name -- `OldTelevisionLarge 1`,
 * `DrinksCoolersX2 1`, `MarketStandX2 2` and `SupermarketFrigeUnitsX3 2` -- and an href is
 * percent-encoded, so the listing calls the first of those `OldTelevisionLarge%201.json`.
 * Naming the asset from the href verbatim put that encoding into the reference data, where
 * it is a preset no lookup can match: `checkFurniture` answers "the base game has no
 * furniture preset called OldTelevisionLarge 1", a mod's patch of it never overlays onto
 * the base record, and the pickers show the escape to the author.
 *
 * The disk branch never had the problem, because `readdir` gives the name as it is. Which
 * made this worse than a wrong name -- the file's contents depended on which source the
 * tool was run against, so two runs of one tool disagreed about what the game contains.
 *
 * Hence the pair. `at` is the href, untouched, because that is what addresses the file and
 * re-encoding a decoded name is not guaranteed to reproduce it. `name` is what the asset
 * is called. On disk the two are the same string.
 */
async function readType(source, type) {
    const files = source.startsWith('http')
        ? await listOverHttp(source, type)
        : (await readdir(join(source, type)))
            .filter((file) => file.endsWith('.json'))
            .map((file) => ({ at: file, name: file }));

    const assets = {};

    // Sequential over HTTP on purpose: this runs once, by hand, against a server on
    // someone's desk. 1,354 requests at a time is not a courtesy it needs extending.
    for (const { at, name } of files) {
        const body = source.startsWith('http')
            ? await (await fetch(`${source}/${type}/${at}`)).text()
            : await readFile(join(source, type, at), 'utf8');

        assets[name.replace(/\.json$/, '')] = JSON.parse(body);
    }

    return assets;
}

async function listOverHttp(source, type) {
    const html = await (await fetch(`${source}/${type}/`)).text();
    return [...html.matchAll(/href="\.\/([^"]+\.json)"/g)]
        .map((match) => ({ at: match[1], name: decodeURIComponent(match[1]) }));
}


/* -------------------------------------------------------------------------- */
/* Resolving references                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A `{m_FileID, m_PathID}` as the asset's name, or null.
 *
 * `m_FileID` is what carries the pathID in this dump, and `soPathIds` keys on it. Its
 * values are `Type|Name` and the type is dropped: everything read here is already known
 * to be of one type by the field it came out of, and a bare name is what the editor
 * shows and what a blueprint stores.
 *
 * A pathID of 0 is Unity's null reference and is the common case -- most of these
 * fields are optional -- so it is not worth reporting.
 */
const nameOf = (pathIds) => (reference) => {
    if (!reference?.m_FileID) return null;
    const entry = pathIds[String(reference.m_FileID)];
    return entry?.length ? entry[0].slice(entry[0].indexOf('|') + 1) : null;
};

const namesOf = (name) => (list) => (list ?? []).map(name).filter(Boolean);

/**
 * A cluster element's placement chance.
 *
 * Absent is 1, matching `readElement` in furnitureOverlay.js so that one convention holds
 * whichever route a record arrived by. Every one of the 1,139 shipped elements states the
 * field, so this default never fires on the base game -- it is here to keep the two
 * readers honest rather than to handle a case the dump contains.
 */
const chanceOf = (element) => element?.chanceOfPlacementAttempt ?? 1;

/**
 * Whether an element's scale is the zero vector.
 *
 * Feeds `scaleMultiplier` at `FurnitureLocation.cs:217`: the furniture is placed
 * correctly, counts against every limit, and is rendered at no size at all. Absent is not
 * zero -- an element that omits the field is not making this mistake -- so only a stated
 * `{0,0,0}` counts.
 */
function isZeroScale(scale) {
    if (!scale) return false;
    return scale.x === 0 && scale.y === 0 && scale.z === 0;
}



/* -------------------------------------------------------------------------- */
/* Trimming                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What each type is reduced to.
 *
 * Every field here is one `furnitureChain.js` filters on or displays. Fields that gate
 * on something a floor blueprint does not record -- district, wealth, grubbiness,
 * inhabitants, design style -- are kept anyway where the resolver reports them as
 * unapplied, and dropped where it does not: an author cannot act on a gate they are not
 * told about, and a field nothing reads is one nobody can tell has gone stale.
 */
function trim(data, name, names) {
    const chain = {
        /**
         * `compatible` is what a blueprint's layout configuration is matched against,
         * and `roomConfig` is the list walked to turn a room type into a room class.
         * The company and residence flags are not filtered on -- see the note on
         * address kinds in furnitureChain.js -- but say which kind of unit a preset is,
         * which is what tells a reader why two presets on one layout differ so much.
         */
        addresses: {},

        /** The `roomType -> roomClass` hop, which is where the whole chain turns. */
        roomConfigs: {},

        /** `forceConfiguration`, the fallback when no address preset maps the type. */
        roomTypes: {},

        /**
         * `RoomTypeFilter` to the room classes it names.
         *
         * Kept the way the asset is written rather than inverted to `class -> filters`,
         * which is the only form anything asks for. A mod may patch a shipped filter, and
         * a patch replaces a list wholesale -- so the inversion has to be recomputed from
         * whole filters after the mod's are merged in, and cannot be if the base has
         * already been folded the other way. `furnitureChain.js` inverts it on load.
         */
        filters: {},

        /** The clusters, and the classes their elements name. */
        clusters: {},

        /** The presets, and the classes each can fill. */
        furniture: {},

        /**
         * The slot classes, and everything about them a blueprint can check.
         *
         * `minimumZeroNodeWallCount` / `maximumZeroNodeWallCount` are how many walls the
         * node a class sits on must have. 166 of the 262 classes need at least one wall
         * and 15 need two, which are exactly the corner pieces: `1x1CornerArmchair`,
         * `1x1SecurityCameraLeftCorner` and their kind.
         *
         * `wallRules` is the finer version of the same question and the reason this file
         * grew: 233 classes carry them, and where the count asks *how many* edges have a
         * wall, a rule asks what kind of wall sits on a named edge. A blueprint records
         * that, so it is answerable -- see `wallRulesOf`.
         *
         * `wallPiece` is carried to say *why* rather than to filter: every class that
         * sets it already has a minimum of 1, so it changes no answer. A picture hung on
         * a wall and a bookcase standing against one are both excluded from the middle
         * of a room, and only one of them is worth calling a wall piece.
         *
         * The stairwell, floor and footprint fields below are the rest of what a
         * blueprint can answer. Each is written only when it says something -- the
         * defaults are `stairwell` absent meaning barred from stairwell tiles and their
         * neighbours (`GenerationController.cs:4575-4596`), `noFloor` absent meaning a
         * floorless node is refused, and `size` absent meaning 1x1.
         *
         * `nodeRules`, `awayFromClasses` and `blockedAccess` are still not carried. The
         * first two are about what has already been placed nearby, and `blockedAccess`
         * declares what a piece blocks rather than what it needs -- it feeds a
         * reachability veto (`:5314`), not a match.
         */
        classes: {},

        /**
         * What each wall preset is, for the wall rules to be read against.
         *
         * Keyed on the `DoorPairPreset` id, which is what a blueprint stores in an edge.
         * Three fields, because between them they answer every tag the game checks:
         * `sectionClass` for the ten that name one, `divider` for `entranceDoorOnly` and
         * `entraceDivider`, `isFence` for `fence` (`:4864-4980`).
         *
         * The asset's facts, not the predicates over them. Which tags a preset satisfies
         * is the generator's rule and lives with the resolver that mirrors the switch; a
         * preset is only ever a section class and two flags. `divider` and `fence` are
         * written only when true.
         *
         * This is not `refs/authored/wallPresetKinds.json` and does not replace it. That
         * table says what a wall looks like, for drawing it; this says what the generator
         * sees. They disagree about dividers, and both are right about their own question
         * -- see `wallsAround` in furnitureChain.js.
         */
        walls: {},
    };

    for (const [preset, furnitureClass] of Object.entries(data.FurnitureClass)) {
        const { rules, unchecked } = wallRulesOf(furnitureClass, name);
        const size = furnitureClass.objectSize ?? {};
        const range = furnitureClass.allowedOnFloorRange ?? {};
        const stairwell = stairwellOf(
            furnitureClass.allowedOnStairwell, furnitureClass.onlyOnStairwell);

        chain.classes[preset] = {
            minWalls: furnitureClass.minimumZeroNodeWallCount ?? 0,
            maxWalls: furnitureClass.maximumZeroNodeWallCount ?? 4,
            wallPiece: !!furnitureClass.wallPiece,

            ...(rules.length ? { wallRules: rules } : {}),
            ...(unchecked ? { unchecked } : {}),

            // The footprint, which every node of must be in the same room as the anchor
            // -- `newNode3.room != room` at `:4570`, checked per node rather than as an
            // area. 52 of the 262 are bigger than 1x1, up to the 6x6 of a fairground ride.
            ...((size.x ?? 1) === 1 && (size.y ?? 1) === 1
                ? {} : { size: [size.x ?? 1, size.y ?? 1] }),

            // Two fields folded to one, because the game reads them as one decision --
            // see `stairwellOf`. Absent is the default and the strictest case.
            ...(stairwell ? { stairwell } : {}),

            ...(furnitureClass.allowIfNoFloor ? { noFloor: true } : {}),
            ...(furnitureClass.canFaceDiagonally ? { diagonal: true } : {}),
            ...(furnitureClass.requiresCeiling ? { needsCeiling: true } : {}),

            // Two flags that bar a piece from a square by what is on its edges rather
            // than by a rule it states. `occupiesTile` refuses a square carrying a
            // doorway that is not a divider (`:4663`), and `tall` or `wallPiece` refuses
            // one carrying a window of either size (`:4667`) -- a bookcase would stand in
            // front of it.
            //
            // `occupiesTile` is the one field here whose game default is **true**, so it
            // is written when false and absent means "occupies". Written the other way
            // round it would need a name like `freeTile` that no asset uses.
            ...(furnitureClass.occupiesTile === false ? { occupiesTile: false } : {}),
            ...(furnitureClass.tall ? { tall: true } : {}),

            // The floor a class is confined to, which the editor knows for a blueprint
            // placed in a building and not otherwise. `:4322` compares the room's first
            // node's `z`; `:4334` the same against a range.
            ...(furnitureClass.limitToFloor ? { floor: furnitureClass.allowedOnFloor ?? 0 } : {}),
            ...(furnitureClass.limitToFloorRange
                ? { floorRange: [range.x ?? 0, range.y ?? 0] } : {}),
        };
    }

    for (const wall of Object.values(data.DoorPairPreset)) {
        chain.walls[String(wall.id)] = {
            section: WALL_SECTION_CLASS[wall.sectionClass ?? 0],
            ...(wall.divider ? { divider: true } : {}),
            ...(wall.isFence ? { fence: true } : {}),
        };
    }

    for (const [preset, address] of Object.entries(data.AddressPreset)) {
        chain.addresses[preset] = {
            compatible: names(address.compatible),
            roomConfig: names(address.roomConfig),
            company: !!name(address.company),
            residence: !!name(address.residence),
        };
    }

    for (const [preset, config] of Object.entries(data.RoomConfiguration)) {
        chain.roomConfigs[preset] = {
            roomType: name(config.roomType),
            roomClass: name(config.roomClass),
        };
    }

    // Only the ones that have a fallback. 47 room types, and the entry exists to answer
    // "and if nothing matched?" -- a null for the ones where the answer is "nothing" is
    // a third of the file saying the same thing.
    for (const [preset, type] of Object.entries(data.RoomTypePreset)) {
        const forced = name(type.forceConfiguration);
        if (forced) chain.roomTypes[preset] = forced;
    }

    for (const [preset, filter] of Object.entries(data.RoomTypeFilter)) {
        chain.filters[preset] = names(filter.roomClasses);
    }

    for (const [preset, cluster] of Object.entries(data.FurnitureCluster)) {
        chain.clusters[preset] = {
            disable: !!cluster.disable,
            filters: names(cluster.allowedRoomFilters),
            min: cluster.minimumRoomSize ?? 0,

            // `maximumRoomSize` is only read when `useMaximumRoomSize` is set, and 99
            // is what the ones that do not use it are left holding. Folded to null so
            // the app has one thing to test rather than two.
            max: cluster.useMaximumRoomSize ? (cluster.maximumRoomSize ?? null) : null,

            elements: (cluster.clusterElements ?? []).map((element) => ({
                class: name(element.furnitureClass),
                important: !!element.importantToCluster,

                // Both carried only when they are not the plain default, which is what
                // keeps this file the size it is: 1,139 elements across the 399
                // clusters, and writing both unconditionally would add 32 KB to 181 KB
                // to say "normal" over and over. 18 elements state a chance and none
                // states a zero scale, so these keys are rare rather than absent.
                //
                // Absent means `chance` 1 and a non-zero scale. **Not** the same as
                // meaning healthy: 16 of those 18 are a deliberate 0.5, 0.8 or 0.9, and
                // only the two at 0 are a mistake. Storing the number and judging it
                // elsewhere is the point -- `clusterWarnings` in furnitureChain.js holds
                // the rule for what counts as broken, and holds it once.
                //
                // `readElement` in furnitureOverlay.js reads a mod's file to the same
                // convention, so a record means the same thing whichever route it took.
                ...(chanceOf(element) === 1 ? {} : { chance: chanceOf(element) }),
                ...(isZeroScale(element.localScale) ? { zeroScale: true } : {}),
            })),
        };
    }

    for (const [preset, furniture] of Object.entries(data.FurniturePreset)) {
        chain.furniture[preset] = {
            classes: names(furniture.classes),
            filters: names(furniture.allowedRoomFilters),
            min: furniture.minimumRoomSize ?? 0,

            // Design style is not known from a blueprint, so this is not filtered on.
            // It is carried because a preset that is not universal is one whose
            // appearance depends on a decor style nothing here can see, and saying so
            // beside the name is cheaper than a reader discovering it in game.
            universal: !!furniture.universalDesignStyle,

            // The address gate, which *is* known: the resolver already has an address
            // preset in hand for every group it builds. Null rather than an empty list
            // when the gate is off, so "no restriction" and "restricted to nothing" are
            // different things -- the second is a preset that can never place.
            onlyIn: furniture.onlyAllowInFollowing ? names(furniture.allowedInAddressesOfType) : null,
            bannedIn: furniture.banInFollowing ? names(furniture.bannedInAddressesOfType) : null,

            // The building gate, folded the same way, and **not** filtered on: a
            // blueprint does not know which building it is in, which is why `building`
            // is named in UNAPPLIED_GATES. It is carried because it is one of the two
            // ways an author confines a preset to their own content, and a cluster whose
            // presets set neither reaches every room of that class in the city. Read by
            // `clusterWarnings`, not by the walk.
            //
            // `OnlyAllowInBuildings` is capitalised in the dump where its three siblings
            // are not. That is the game's spelling, not a typo here.
            onlyInBuildings: furniture.OnlyAllowInBuildings
                ? names(furniture.allowedInBuildings) : null,
        };
    }

    return chain;
}


/* -------------------------------------------------------------------------- */
/* The room creator's half                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a room admits, for the room creator modal -- and **only what furnitureChain.json
 * does not already say**.
 *
 * The two files compose rather than overlap. The building flow asks what could spawn on a
 * square and filters on the handful of gates a blueprint answers; the room creator asks
 * what a room admits when the author has stated the floor, the wealth and the address
 * kind, so it needs the other thirty-odd gates, the materials, and the lighting. Writing
 * a field into both would be two answers to one question about the game, which is the
 * duplication `refs/README.md` exists to prevent -- so `disable`, the room-size bounds and
 * everything under `classes` that the walk already carries are deliberately absent here.
 *
 * Read it joined: a cluster is `furnitureChain.clusters[name]` merged with
 * `roomCreator.clusters[name].gates`, and a name that misses in either is a bug in this
 * tool rather than a gap in the game.
 *
 * ## Why the defaults are computed rather than declared
 *
 * A gate block states only the values that differ from `_gateDefaults`, which is what
 * keeps 399 clusters to a quarter of what they would otherwise cost -- most clusters set
 * most gates to the same thing. The defaults are the **most common value of each field
 * across the shipped assets**, not the game's own field defaults, which are not in the
 * dump. So they are a compression table and nothing more: absent means "whatever
 * `_gateDefaults` says", never "the game's default" or "unset". A reader that wants a
 * gate's value takes the record's if it has one and the table's otherwise.
 */
function rooms(data, name, names) {
    /** The most common value of `field` across `assets`, as the key to compress against. */
    const commonest = (assets, field) => {
        const counts = new Map();
        for (const asset of assets) {
            const key = JSON.stringify(asset[field]);
            if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const best = [...counts].sort((a, b) => b[1] - a[1])[0];
        return best ? JSON.parse(best[0]) : null;
    };

    /** Only the fields whose value differs from the table. */
    const differing = (asset, fields, defaults) => {
        const out = {};
        for (const field of fields) {
            if (JSON.stringify(asset[field]) !== JSON.stringify(defaults[field])) {
                out[field] = asset[field];
            }
        }
        return out;
    };

    const table = (assets, fields) =>
        Object.fromEntries(fields.map((field) => [field, commonest(assets, field)]));

    /*
     * Clusters. Every gate `GenerationController` checks before the room-class whitelist,
     * less the four furnitureChain.json already carries. `minimumRoomSize` and its
     * siblings are its `min`/`max`; `disable` is its `disable`.
     */
    const CLUSTER_GATES = [
        'limitToFloor', 'allowedOnFloor', 'limitToFloorRange', 'allowedOnFloorRange',
        'minimumWealth', 'wealthLimit', 'maximumWealth',
        'useRoomGrub', 'minimumGrub', 'maximumGrub',
        'allowedInOpenPlan', 'allowInCompanies', 'allowInResidential', 'allowOnStreets',
        'skipIfNoAddressInhabitants', 'onlySkipNoInhabitantsIfResidenceOrCompany',
        'useBuildingResidences', 'minimumResidences', 'maximumResidences',
        'limitPerRoom', 'maximumPerRoom', 'limitPerAddress', 'maximumPerAddress',
        'limitToDistricts', 'coastalOnly', 'securityDoor', 'essentialFurniture',
        'placementChance', 'roomPriority', 'calculatedMinRoomSize',
    ];

    const clusterAssets = Object.values(data.FurnitureCluster);
    const gateDefaults = table(clusterAssets, CLUSTER_GATES);

    const clusters = {};
    for (const [preset, cluster] of Object.entries(data.FurnitureCluster)) {
        const gates = differing(cluster, CLUSTER_GATES, gateDefaults);
        const record = {};

        if (Object.keys(gates).length) record.gates = gates;

        // Names rather than counts: a district gate is read against the district a
        // building landed in, which the author states by name or not at all.
        const allowed = names(cluster.allowedInDistricts);
        const banned = names(cluster.notAllowedInDistricts);
        if (allowed.length) record.allowedInDistricts = allowed;
        if (banned.length) record.notAllowedInDistricts = banned;

        if (Object.keys(record).length) clusters[preset] = record;
    }

    /*
     * Furniture. `universal` is already in the chain file; the list behind it is not, and
     * it is what says *which* styles when the flag is false -- 79 of 310 need it.
     */
    const furniture = {};
    for (const [preset, item] of Object.entries(data.FurniturePreset)) {
        const record = {};

        if (!item.universalDesignStyle) record.designStyles = names(item.designStyles);
        if (item.minimumWealth) record.minimumWealth = item.minimumWealth;
        if (item.allowedInOpenPlan) record.openPlan = item.allowedInOpenPlan;

        if (Object.keys(record).length) furniture[preset] = record;
    }

    /*
     * Classes. The per-room and per-address caps, and the ceiling rules. The floor limits
     * and the wall counts are the chain file's `floor`, `floorRange`, `minWalls` and
     * `maxWalls` and are not repeated.
     */
    const CLASS_LIMITS = [
        'limitPerRoom', 'maximumNumberPerRoom', 'limitPerAddress', 'maximumNumberPerAddress',
        'requiresCeiling', 'blocksCeiling', 'skipIfNoAddressInhabitants',
    ];

    const classAssets = Object.values(data.FurnitureClass);
    const classDefaults = table(classAssets, CLASS_LIMITS);

    const classes = {};
    for (const [preset, furnitureClass] of Object.entries(data.FurnitureClass)) {
        const record = differing(furnitureClass, CLASS_LIMITS, classDefaults);
        if (Object.keys(record).length) classes[preset] = record;
    }

    /*
     * Filters, by how many material groups of each surface name them. This is the whole
     * of what rule 4 needs: a filter with materials that no cluster or preset also names
     * is safe to join for surfaces, and one that gates furniture as well is not. Which of
     * the two a filter is stays out of this file -- it is answerable from the chain
     * file's `clusters` and `furniture`, and shipping the answer beside its inputs would
     * be a second thing to keep true.
     */
    const SURFACE = ['walls', 'floor', 'ceiling'];
    const filters = {};

    for (const group of Object.values(data.MaterialGroupPreset)) {
        const surface = SURFACE[group.materialType];
        if (!surface) continue;

        for (const filter of names(group.allowedRoomFilters)) {
            filters[filter] ??= {};
            filters[filter][surface] = (filters[filter][surface] ?? 0) + 1;
        }
    }

    /*
     * Configurations, as the fields a new one inherits when it copies a donor. The room
     * creator shows these beside the donor's name, because they are what the author is
     * choosing and nothing else in the app displays them.
     */
    const INHERITED = [
        'forceOutside', 'canBeOpenPlan', 'useMainLights', 'useLightSwitches',
        'lightsOnAtStart', 'wellLit', 'cleanness', 'decorSetting', 'securityDoors',
        'securityLevel', 'useOwnership', 'allowBugs', 'allowMuggings',
        'allowPersonalAffects', 'overrideMaxFurnitureClusters', 'overridenMaxFurniture',
        'chanceOfCeilingFans',
    ];

    const configurations = Object.fromEntries(Object.entries(data.RoomConfiguration).map(
        ([preset, config]) => [preset, Object.fromEntries(
            INHERITED.map((field) => [field, config[field]]))]));

    /*
     * Lighting. A `RoomConfiguration` no preset here names gets no ceiling light, and the
     * room builds cleanly without one -- which is why this is in the file at all.
     */
    const lighting = Object.fromEntries(Object.entries(data.RoomLightingPreset).map(
        ([preset, light]) => [preset, {
            rooms: names(light.roomCompatibility),
            min: light.minimumRoomSize ?? 0,
            max: light.maximumRoomSize ?? null,
            designStyles: names(light.designStyleCompatibility),
            stairwell: light.stairwellRule ?? 0,
            frequency: light.frequency ?? 1,
            ...(light.disable ? { disable: true } : {}),
        }]));

    return {
        _gateDefaults: gateDefaults,
        _classDefaults: classDefaults,
        clusters, furniture, classes, filters, configurations, lighting,
    };
}


/* -------------------------------------------------------------------------- */

const source = (process.argv[2] ?? 'http://192.168.2.70:8080').replace(/\/$/, '');

const pathIds = JSON.parse(
    await readFile(join(ROOT, 'refs', 'generated', 'soPathIds.json'), 'utf8'));

const name = nameOf(pathIds);
const names = namesOf(name);

const data = {};
for (const type of TYPES) {
    data[type] = await readType(source, type);
    console.log(`${type}: ${Object.keys(data[type]).length}`);
}

const chain = trim(data, name, names);
const roomCreator = rooms(data, name, names);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(chain)}\n`);
await writeFile(OUT_ROOMS, `${JSON.stringify(roomCreator)}\n`);

console.log(`\nWrote ${OUT}`);
const classes = Object.values(chain.classes);

console.log([
    `${Object.keys(chain.addresses).length} address presets`,
    `${Object.keys(chain.roomConfigs).length} room configurations`,
    `${Object.keys(chain.clusters).length} clusters`,
    `${Object.keys(chain.classes).length} classes`,
    `${Object.keys(chain.furniture).length} furniture presets`,
    `${Object.keys(chain.walls).length} wall presets`,
].join(', '));

// Said out loud because both numbers are a claim about the game's data that the unit
// suite pins, and a regeneration that quietly halves either is the failure this file is
// most exposed to.
console.log([
    `${classes.filter((entry) => entry.wallRules).length} classes carry wall rules`,
    `${classes.reduce((total, entry) => total + (entry.wallRules?.length ?? 0), 0)} rules`,
    `${classes.reduce((total, entry) => total + (entry.unchecked ?? 0), 0)} dropped as unreadable`,
].join(', '));

console.log(`\nWrote ${OUT_ROOMS}`);
console.log([
    `${Object.keys(roomCreator.clusters).length} clusters carry a non-default gate`,
    `${Object.keys(roomCreator.furniture).length} presets carry a style or wealth limit`,
    `${Object.keys(roomCreator.filters).length} filters supply materials`,
    `${Object.keys(roomCreator.lighting).length} lighting presets`,
].join(', '));

// The count the lighting step rests on: a configuration no preset names gets no ceiling
// light, silently, and the modal has to say so before the author picks that donor.
const lit = new Set(Object.values(roomCreator.lighting).flatMap((light) => light.rooms));
const unlit = Object.keys(roomCreator.configurations).filter((preset) => !lit.has(preset));
console.log(`${unlit.length} of ${Object.keys(roomCreator.configurations).length} room configurations have no light: ${unlit.join(', ')}`);
