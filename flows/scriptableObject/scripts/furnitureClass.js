/**
 * Where a piece of furniture may stand, as a grid of tiles with rules on them.
 *
 * A `FurnitureClass` is the middle level of the chain and is the one that decides
 * placement. It says how big the piece is, what must and must not be on the walls around
 * it, what must and must not already be standing nearby, and which ways through the room
 * it closes off once it is there. All of that is written as offsets from one anchor tile,
 * which makes it a diagram -- and reading it as a list of `{offset, direction, tag}` rows
 * is why it is hard to author by hand.
 *
 * Nothing here draws. It turns the two reference files into a grid the view walks, and
 * answers what a rule means in words; `furnitureClassView.js` renders it.
 *
 * ## The frame
 *
 * Every offset and direction is in the *furniture's own* frame, before the generator turns
 * it. `front` is +y and `right` is +x -- `CityData.GetOffsetFromDirection` -- so the piece
 * faces up the diagram and its rules are drawn where they are written.
 *
 * The generator tries all four quarter turns and takes any that fits
 * (`GenerationController.cs:4841`), turning the offset and the direction by the same angle.
 * So the diagram is one of four readings, and the one the author wrote. Saying which way
 * up matters: a rule that names `behind` is about the piece's back, not about north.
 *
 * ## Which nodes the piece is on
 *
 * The **negative** ones. The footprint loop walks `objectSize` from zero and lays each node
 * down at `clusterAngle + facingAngle - 180` (`:4543-4550`) where every rule here is read at
 * `clusterAngle + facingAngle`, and two further quarter turns is a negation -- so `(i, j)` of
 * that loop is `(-i, -j)` on this grid. The anchor is the piece's front-right node and a 3x1
 * desk covers `(0,0)`, `(-1,0)`, `(-2,0)`.
 *
 * The assets agree: `2x1Sofa` states its wall rules at `(0,0)` and `(-1,0)`, its own two
 * nodes, and 313 of the 323 `blockedAccess` offsets across the 262 classes are zero or
 * negative on both axes. Drawn the other way the shading and the rules come apart, and every
 * rule a class writes about itself lands outside its own footprint.
 *
 * ## Where the rules come from
 *
 * The asset, whole. There is one reader -- `placementFromAsset` -- and everything goes
 * through it: the game's own class out of the author's export, a mod's own out of the
 * content folder, a patched one out of both. A class *is* its rules, so there was never a
 * useful trim of one, which is why the derived copy this used to read is gone.
 */
import { readAsset, refName } from './furnitureAssets.js';
import { WALL_RULE, BLOCKING_DIRECTION, RULE_OPTION } from '../../../core/furnitureRules.js';

/**
 * `CityData.GetOffsetFromDirection` (CityData.cs:643).
 *
 * The same table `furnitureChain.js` keeps for the same reason, and it has to stay the
 * same table: a rule names an edge by direction, and a direction is only a vector once
 * this says so. `front` is +y and `right` is +x, so the cardinals are the axes and the
 * diagonals their sums.
 */
export const DIRECTION_OFFSET = {
    none: [0, 0],
    front: [0, 1], behind: [0, -1], left: [-1, 0], right: [1, 0],
    frontLeft: [-1, 1], frontRight: [1, 1], behindLeft: [-1, -1], behindRight: [1, -1],
};

/** The four edges of a tile, in the order they read round it. */
export const EDGES = ['front', 'right', 'behind', 'left'];

/**
 * What each wall tag means, in the words an author would use.
 *
 * `WALL_RULE` in the building flow is the list; this is what the names are for. A tag is
 * the whole of what a rule says, and 17 of them is more than anyone holds in their head --
 * `wallOrUpperVent` and `ventTop` are not guessable from their spelling.
 */
export const TAG_MEANING = {
    nothing: 'no wall at all — open to the next tile',
    wall: 'a solid wall',
    window: 'a window',
    windowLarge: 'a full-height window',
    anyWindow: 'a window of either size',
    entrance: 'a doorway of any kind',
    entranceDoorOnly: 'a doorway with a door in it, not an open divider',
    entraceDivider: 'an open divider between two rooms',
    entranceToRoomOfType: 'a doorway leading to a particular kind of room',
    addressEntrance: 'the door into the address',
    ventUpper: 'an upper air vent',
    ventLower: 'a lower air vent',
    ventTop: 'a vent at the top of the wall',
    wallOrUpperVent: 'either a solid wall or an upper vent',
    fence: 'a fence',
    securityDoorDivider: 'a security door — decided from the room, the address through it '
        + 'and the building’s air ducts, so it cannot be checked here',
    lightswitch: 'a lightswitch, which is an object placed later rather than part of the wall',
};

/**
 * Everything about where one class may stand, as a grid.
 *
 * Null for a name that cannot be read -- an asset the export folder does not hold, or no
 * export folder at all. A class with *no rules* is a different thing and comes back as an
 * empty grid with a footprint, because "anywhere its footprint fits" is a real and common
 * answer: most of the game's classes say little more than that.
 */
export async function describePlacement(name) {
    const document = await readAsset('FurnitureClass', name);
    return document ? placementFromAsset(name, document, null) : null;
}


/* -------------------------------------------------------------------------- */
/* A class the reference data does not have                                    */
/* -------------------------------------------------------------------------- */

/**
 * A whole `FurnitureClass` asset as the same grid `describePlacement` produces.
 *
 * The reference data only has the game's own classes, and a mod that authors furniture
 * properly authors a class of its own -- which is the case placement mode exists for. So
 * this reads one from the file instead: a mod's own, a shipped one with a patch applied,
 * or anything else that arrives as a whole asset.
 *
 * `donor` is the placement a `copyFrom` names, already resolved, or null. It is what the
 * loader's rule needs: a list the file states **replaces** the donor's, and one it does not
 * state is the donor's. Both halves matter here -- the bank's own lobby desk states
 * `wallRules` and an empty `nodeRules`, which means its own walls and *no* node rules
 * rather than the donor's.
 *
 * Enums arrive as integers, which is how the game serialises them and how every
 * hand-authored mod file writes them. Names are taken as they are, so a file written by
 * hand either way reads the same.
 */
export function placementFromAsset(name, raw, donor = null) {
    const stated = (field) => raw != null && Object.hasOwn(raw, field);

    const size = stated('objectSize')
        ? [raw.objectSize?.x ?? 1, raw.objectSize?.y ?? 1]
        : donor?.size ?? [1, 1];

    const donorRules = donor?.rules ?? [];

    const rules = [
        ...(stated('wallRules')
            ? (raw.wallRules ?? []).map(readWallRule)
            : donorRules.filter((rule) => rule.kind === 'wall')),

        ...(stated('nodeRules')
            ? (raw.nodeRules ?? []).map(readNodeRule)
            : donorRules.filter((rule) => rule.kind === 'node')),
    ];

    const blocks = stated('blockedAccess')
        ? (raw.blockedAccess ?? [])
            .filter((entry) => !entry.disabled)
            .map((entry) => ({
                // The same tag the rules carry, so one selection can hold either. A block
                // is not a rule -- it says nothing about where the piece may stand -- but
                // it is written at an offset and drawn on the same grid, and the editor
                // turns one into the other.
                kind: 'block',
                at: [entry.nodeOffset?.x ?? 0, entry.nodeOffset?.y ?? 0],
                dirs: (entry.blocked ?? []).map(directionName).filter((dir) => dir !== 'none'),
                diagonals: !!entry.blockExteriorDiagonals,
            }))
        : donor?.blocks ?? [];

    const weights = stated('customNodeWeights')
        ? (raw.customNodeWeights ?? [])
            .filter((entry) => !entry.disabled)
            .map((entry) => ({
                at: [entry.nodeOffset?.x ?? 0, entry.nodeOffset?.y ?? 0],
                weight: entry.nodeWeightModifier ?? 0,
            }))
        : donor?.weights ?? [];

    const away = stated('awayFromClasses')
        ? ((raw.awayFromClasses ?? []).length
            ? {
                classes: (raw.awayFromClasses ?? []).map(refName).filter(Boolean),
                distance: raw.minimumNodeDistance ?? 0,
            }
            : null)
        : donor?.away ?? null;

    const record = {
        name,
        size,
        tall: stated('tall') ? !!raw.tall : !!donor?.tall,
        wallPiece: stated('wallPiece') ? !!raw.wallPiece : !!donor?.wallPiece,
        minWalls: stated('minimumZeroNodeWallCount')
            ? raw.minimumZeroNodeWallCount ?? 0 : donor?.minWalls ?? 0,
        maxWalls: stated('maximumZeroNodeWallCount')
            ? raw.maximumZeroNodeWallCount ?? 4 : donor?.maxWalls ?? 4,
        rules,
        blocks,
        weights,
        away,

        // Which file this came out of rather than the reference data. The pane says so:
        // rules read from a mod's own class are the ones that will be in play, and rules
        // inherited from a donor are not written in that file at all.
        fromAsset: true,
    };

    return { ...record, bounds: boundsOf(record) };
}

/**
 * The enum tables, read from either spelling.
 *
 * A whole asset holds the integer. A file somebody typed may hold the name, and there is
 * no reason to refuse it -- the game's own reader would not.
 *
 * The tables are `core/furnitureRules.js`'s, which is where they were recovered from a
 * decompiled source and where the reason not to take them from `soEnums.json` is written
 * down. A second transcription of a 17-member index-addressed enum is the failure that
 * module exists to prevent.
 */
const named = (table, value, fallback) =>
    (typeof value === 'string' ? value : table[value ?? 0] ?? fallback);

const directionName = (value) => named(BLOCKING_DIRECTION, value, 'none');
const tagName = (value) => named(WALL_RULE, value, 'wall');
const optionName = (value) => named(RULE_OPTION, value, 'mustFeature');

function readWallRule(rule) {
    const option = optionName(rule?.option);

    return {
        kind: 'wall',
        at: [rule?.nodeOffset?.x ?? 0, rule?.nodeOffset?.y ?? 0],
        dir: directionName(rule?.wallDirection),
        tag: tagName(rule?.tag),
        must: option === 'mustFeature',
        room: refName(rule?.roomType),
        score: rule?.addScore ?? 0,
        gates: option !== 'canFeature',
    };
}

function readNodeRule(rule) {
    const option = optionName(rule?.option);

    return {
        kind: 'node',
        at: [rule?.offset?.x ?? 0, rule?.offset?.y ?? 0],
        option,
        class: rule?.anyOccupiedTile ? null : refName(rule?.furnitureClass),
        any: !!rule?.anyOccupiedTile,
        score: rule?.addScore ?? 0,
        gates: option !== 'canFeature',
    };
}


/**
 * The tiles the diagram has to cover.
 *
 * Sized to what the class actually uses rather than fixed, with a tile of margin so an
 * edge rule on the outermost tile has something to point at. 210 of the 262 classes are
 * 1x1 with rules only on their own tile, and a fixed 5x5 would spend most of its area
 * saying nothing about them.
 *
 * A rule's own edge counts as well as its tile: a rule on the tile at `[0, 1]` naming
 * `front` is about the boundary above it, which is a tile further out again.
 *
 * Exported because it has to be recomputed, not only produced. A placement is edited in
 * place -- a rule dragged out to a far tile, a footprint widened -- and bounds that were
 * right when the asset was read are a grid the new rule is drawn outside of, which reads as
 * the edit having been dropped.
 */
export function boundsOf(placement) {
    const { size, rules = [], blocks = [], weights = [] } = placement ?? {};

    // The far corner of the footprint is negative on both axes -- see the note at the top of
    // this file. A grid sized to `+(size - 1)` leaves a 3x1 desk's own two far nodes off the
    // diagram entirely, and with them every rule the class writes about them.
    const xs = [0, -((size?.[0] ?? 1) - 1)];
    const ys = [0, -((size?.[1] ?? 1) - 1)];

    const include = ([x, y]) => { xs.push(x); ys.push(y); };

    for (const rule of rules) {
        include(rule.at);
        if (rule.kind === 'wall') {
            const [dx, dy] = DIRECTION_OFFSET[rule.dir] ?? [0, 0];
            include([rule.at[0] + dx, rule.at[1] + dy]);
        }
    }

    for (const entry of blocks) include(entry.at);
    for (const entry of weights) include(entry.at);

    // At least 3x3 around the anchor. A diagram that is one tile is not a diagram, and the
    // ring around the piece is what an author is checking even when nothing is written on
    // it.
    return {
        minX: Math.min(-1, ...xs),
        maxX: Math.max(1, ...xs),
        minY: Math.min(-1, ...ys),
        maxY: Math.max(1, ...ys),
    };
}

/**
 * The bounds actually drawn: what the class uses, and what its model reaches into.
 *
 * The union rather than the class's own, because the overhang is the thing worth seeing and
 * a tile outside the grid cannot be marked. `extent` is `modelExtent`'s answer or null, and
 * null is the ordinary case -- a shipped preset's model is in an asset bundle this app
 * cannot open, so there is nothing to measure and the grid is the class's own.
 */
export function gridBounds(placement, extent = null) {
    const bounds = placement?.bounds ?? boundsOf(placement);
    if (!extent) return bounds;

    return {
        minX: Math.min(bounds.minX, extent.minX),
        maxX: Math.max(bounds.maxX, extent.maxX),
        minY: Math.min(bounds.minY, extent.minY),
        maxY: Math.max(bounds.maxY, extent.maxY),
    };
}

/**
 * Every tile of the grid, in reading order: top row first, left to right.
 *
 * `extent` marks where the model reaches, which is not where the piece is allowed to stand.
 * Two flags rather than one: `inModel` is the whole of the mesh's footprint and `overhang`
 * is the part of it the class does not declare, which is the part that clips.
 */
export function tilesOf(placement, extent = null) {
    if (!placement) return [];

    const { size } = placement;
    const bounds = gridBounds(placement, extent);
    const tiles = [];

    const reaches = (x, y) => !!extent
        && x >= extent.minX && x <= extent.maxX && y >= extent.minY && y <= extent.maxY;

    for (let y = bounds.maxY; y >= bounds.minY; y--) {
        for (let x = bounds.minX; x <= bounds.maxX; x++) {
            // The tiles the piece itself stands on. The anchor is one corner of the
            // footprint rather than its middle, which is where the game puts it, and the
            // body reaches back and to its left from there.
            const covered = x <= 0 && x > -size[0] && y <= 0 && y > -size[1];

            tiles.push({
                x,
                y,
                covered,
                anchor: x === 0 && y === 0,
                inModel: reaches(x, y),
                overhang: reaches(x, y) && !covered,
                rules: placement.rules.filter((rule) => rule.at[0] === x && rule.at[1] === y),
                blocks: placement.blocks.filter((entry) => entry.at[0] === x && entry.at[1] === y),
                weight: placement.weights.find((entry) => entry.at[0] === x && entry.at[1] === y),
            });
        }
    }

    return tiles;
}

/**
 * One rule as a sentence.
 *
 * The pane draws a mark and this says what the mark means, so the two cannot describe the
 * same rule differently. Written as what would happen rather than as what is set: "will
 * not be placed unless" is the thing an author can act on, where "mustFeature: wall" is
 * the thing they already read in the file and came here to understand.
 */
export function explainRule(rule) {
    const where = rule.at[0] === 0 && rule.at[1] === 0
        ? 'on its own tile'
        : `on the tile at ${rule.at[0]}, ${rule.at[1]}`;

    if (rule.kind === 'node') {
        const what = rule.any ? 'anything at all' : rule.class ?? 'nothing named';

        if (rule.option === 'canFeature') {
            return `Prefers ${what} ${where} — worth ${rule.score} to the placement score, `
                + 'and never a reason to refuse one.';
        }

        return rule.option === 'mustFeature'
            ? `Will not be placed unless ${what} is already there ${where}.`
            : `Will not be placed if ${what} is already there ${where}.`;
    }

    const edge = rule.dir === 'none' ? 'no particular edge' : `its ${spell(rule.dir)} edge`;
    const tag = TAG_MEANING[rule.tag] ?? rule.tag;
    const room = rule.room ? ` (${rule.room})` : '';

    if (!rule.gates) {
        return `Prefers ${tag}${room} on ${edge} ${where} — worth ${rule.score} to the `
            + 'placement score, and never a reason to refuse a spot.';
    }

    const sentence = rule.must
        ? `Will not be placed unless there is ${tag}${room} on ${edge} ${where}.`
        : `Will not be placed if there is ${tag}${room} on ${edge} ${where}.`;

    return rule.unreadable
        ? `${sentence} This one cannot be checked outside the game.`
        : sentence;
}

/** What one blocked-access entry closes off, in words. */
export function explainBlock(entry) {
    const where = entry.at[0] === 0 && entry.at[1] === 0
        ? 'its own tile'
        : `the tile at ${entry.at[0]}, ${entry.at[1]}`;

    const dirs = entry.dirs.map(spell);
    const list = dirs.length < 2
        ? dirs[0] ?? 'nothing'
        : `${dirs.slice(0, -1).join(', ')} and ${dirs[dirs.length - 1]}`;

    return `Closes the way out of ${where} to the ${list}`
        + `${entry.diagonals ? ', and the diagonals on the tiles next to it' : ''}. `
        + 'Nothing about where this may stand — it is what standing here does to the room, '
        + 'and a room whose furniture is all placed correctly can still be one nobody can '
        + 'walk through.';
}

/** A direction as two words rather than as one camel-cased one. */
const spell = (dir) => dir.replace(/([A-Z])/g, (letter) => ` ${letter.toLowerCase()}`);

/**
 * How big the piece is, and which way it reaches.
 *
 * Said in words beside the diagram because the shading alone does not answer the question an
 * author asks about a 3x1 table -- which end is the far end. The anchor is the front-right
 * node of the footprint and the piece grows along −x and −y from it, so the far tile is the
 * one named here, and it is the tile whose outer edges a blocking entry would go on.
 */
export function explainFootprint(placement) {
    if (!placement) return null;

    const [across, deep] = placement.size;
    if (across === 1 && deep === 1) {
        return 'One node. It stands on the anchor tile and nothing else.';
    }

    const far = `${-(across - 1)}, ${-(deep - 1)}`;

    return `${across} × ${deep} nodes. The anchor is the front-right corner and the piece `
        + `reaches back and to its left, out to the tile at ${far} — so that is the far end, `
        + 'and its outer edges are the ones a way out would be closed on. That is why a '
        + 'class writes rules about itself at negative offsets.';
}

/**
 * The tiles a model reaches into that its class does not declare, in reading order.
 *
 * The fact, apart from the sentence about it. The pane colours the note by whether there is
 * an overhang, and asking this is how it knows -- matching on the wording of `explainExtent`
 * would be the pane recognising a problem by how it was phrased, which is the coupling the
 * plan pane is careful to avoid for the same reason.
 *
 * Empty for a model inside its footprint, and empty when there is no model at all: an
 * overhang nobody can measure is not one worth reporting.
 */
export function overhangTiles(placement, extent) {
    if (!placement || !extent) return [];

    const [across, deep] = placement.size;
    const outside = [];

    for (let y = extent.maxY; y >= extent.minY; y--) {
        for (let x = extent.minX; x <= extent.maxX; x++) {
            if (x > 0 || x <= -across || y > 0 || y <= -deep) outside.push([x, y]);
        }
    }

    return outside;
}

/**
 * What a mod's own model measures against what its class declares.
 *
 * Null when there is nothing to compare: no model read, which is every shipped preset. The
 * game decides placement from `objectSize` alone and never looks at the mesh, so an overhang
 * is not a rule being broken -- it is a piece the generator will happily stand next to
 * something it then clips through. Worth saying in exactly those terms, or the note reads as
 * a validation failure the author has to fix rather than a choice they have to make.
 */
export function explainExtent(placement, extent) {
    if (!placement || !extent) return null;

    const [across, deep] = placement.size;
    const wide = extent.maxX - extent.minX + 1;
    const tall = extent.maxY - extent.minY + 1;

    const measured = `Its model measures ${extent.metres.across} × ${extent.metres.deep} m, `
        + `which is ${wide} × ${tall} nodes`;

    const outside = overhangTiles(placement, extent).map(([x, y]) => `${x}, ${y}`);

    if (!outside.length) {
        return `${measured} — inside the ${across} × ${deep} this class declares. Nothing `
            + 'overhangs.';
    }

    const list = outside.length > 6
        ? `${outside.slice(0, 6).join('; ')} and ${outside.length - 6} more`
        : outside.join('; ');

    return `${measured}, and this class declares ${across} × ${deep}. The model reaches into `
        + `${outside.length === 1 ? 'the tile' : 'tiles'} ${list}, which it does not own. `
        + 'The generator checks the declared size and never the mesh, so it will stand this '
        + 'against something on those tiles and the two will clip. Widen the footprint if the '
        + 'piece really is that big, or close those ways out so nothing is put there.';
}

/**
 * What the class says about walls without naming an edge.
 *
 * The count is the coarse half of the same question the rules ask finely, and it is worth
 * saying in the same place: 166 of the 262 classes need at least one wall and 15 need two,
 * which are the corner pieces.
 */
export function explainWallCount(placement) {
    if (!placement) return null;

    const { minWalls, maxWalls } = placement;
    if (minWalls === 0 && maxWalls >= 4) return null;

    if (minWalls === maxWalls) {
        return `Its tile must have exactly ${minWalls} of its four edges walled.`;
    }

    if (maxWalls >= 4) return `Its tile must have at least ${minWalls} of its four edges walled.`;
    if (minWalls === 0) return `Its tile must have no more than ${maxWalls} of its four edges walled.`;

    return `Its tile must have between ${minWalls} and ${maxWalls} of its four edges walled.`;
}
