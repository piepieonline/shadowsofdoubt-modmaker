/**
 * What a piece of furniture is, read across the three levels the game splits it into.
 *
 * A room is four assets; a piece of furniture is three, and the same thing is true of
 * them -- the one an author names is not the one that decides behaviour:
 *
 *     FurnitureCluster  ->  FurnitureClass  ->  FurniturePreset
 *     the arrangement       the slot            the model
 *
 * A cluster puts down slots at tile offsets. Each slot names one class. Every preset
 * carrying that class competes for it in a uniform draw, and the winner is the model that
 * appears. So "what does this look like" is answered at the preset, "where may it stand"
 * at the class, and "what stands beside it" at the cluster, and an author changing one of
 * those three has not changed the other two.
 *
 * Nothing here touches the DOM or three.js. It reads assets and answers questions about
 * them; `furnitureView.js` draws the answers and `furnitureCreator.js` runs the pane.
 *
 * ## Whole assets, read as they are asked for
 *
 * Through `furnitureAssets.js`, which reads the author's own exported ScriptableObjects.
 * There is no trimmed copy of these in the repo any more and no regeneration step: opening
 * a piece of furniture reads its own file and the handful its fields name, and every field
 * the game has is there whether or not anything was written here to expect it.
 *
 * Which makes most of this module a translation rather than a lookup: an asset holds
 * `{ x, y, z }` vectors and integer enums, and the pane wants arrays and names.
 */
import { readAsset, readAssets, refName, refNames } from './furnitureAssets.js';
import { ownerOf, controllerOf } from './furnitureEnums.js';

/**
 * How wide a node is, in metres.
 *
 * Sub-object positions are in metres and footprints are in nodes, so drawing the two
 * together needs the conversion. `meshExport.js` carries the same number for the building
 * shell it generates, and the two are deliberately not shared: they are in different flows
 * and answer different questions, and a module imported across the two for one constant
 * would be more indirection than it buys. If the game ever changes its node size, both are
 * wrong, and this note is where the second one is named.
 */
export const NODE_METRES = 1.8;

/**
 * How tall a proxy box is drawn, in metres.
 *
 * **A convention of the view, not the game's data.** A `FurnitureClass` states its
 * footprint and whether it is `tall`, and nothing anywhere states a height -- the height
 * is in the model, which is in an asset bundle this app cannot open.
 *
 * `tall` means the piece would cover a lightswitch or block a window, so it is at least
 * window height; anything else is something you can see over. A metre and 1.8 are those
 * two readings and are not measurements. They exist so that a sub-object at y = 1.0 reads
 * as standing on a desk rather than floating in space, which is the whole job.
 */
const PROXY_HEIGHT = 0.9;
const PROXY_HEIGHT_TALL = 1.8;

const DEGREES = Math.PI / 180;

/**
 * Negation that does not produce negative zero.
 *
 * `-0` is a real value in JavaScript: it prints as `0`, serialises as `0`, and compares
 * equal to `0` with `===` -- and is *not* equal to it under `Object.is`, which is what
 * every deep comparison in a test runner uses. Mirroring an axis produces one every time
 * something sits on the origin, which is most of the time.
 */
const negate = (value) => (value === 0 ? 0 : -value);

/**
 * The same value, minus the negative zero.
 *
 * Not the same job as `negate`: this leaves the sign alone. Multiplying a node index by a
 * node width produces `-0` whenever the index is one -- which the anchor's half of a
 * centred footprint is, every time a piece is an odd number of nodes across.
 */
const plain = (value) => (value === 0 ? 0 : value);

/** Three decimals: a tenth of a millimetre, and never `-0`. */
const round = (value) => {
    const rounded = Math.round((value ?? 0) * 1000) / 1000;
    return rounded === 0 ? 0 : rounded;
};

const vector = (value) => [round(value?.x), round(value?.y), round(value?.z)];


/* -------------------------------------------------------------------------- */
/* Reading one preset                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything about one preset, as the pane shows it.
 *
 * Null for a name that cannot be read -- an asset the author's export does not hold, or a
 * type this tool has no assets for and no export folder to fall back on. The pane asks
 * `readMissing` for the reason, which already distinguishes the two.
 *
 * `placed` and `parented` are the two kinds of sub-object and are separated here rather
 * than in the view, because the difference is a fact about the data rather than a display
 * choice: a parented one hangs off a transform inside the prefab, so its position is
 * relative to something this app cannot see and is not where it would be drawn.
 */
export async function describePreset(name) {
    const document = await readAsset('FurniturePreset', name);
    if (!document) return null;

    return describeDocument(name, document, await classesOf(document));
}

/**
 * The same, for an asset already in hand -- a mod's own file, or a patched one.
 *
 * The classes it names are read here, which is the only thing this does that the pure half
 * below cannot.
 */
export async function describeAsset(name, document) {
    if (!document) return null;

    const names = refNames(document.classes);
    return describeDocument(name, document, await readAssets('FurnitureClass', names));
}

const classesOf = async (document) =>
    readAssets('FurnitureClass', refNames(document.classes));

/**
 * One preset document, and the class documents it names, as the record the pane draws.
 *
 * Pure, and separated from the reads above for that reason: what can be got wrong here is
 * a translation -- a vector read as the wrong shape, an enum as the wrong name, a default
 * as zero where the game says 99 -- and none of it needs a folder to check. Reading is the
 * half that does, and the Playwright suite covers it.
 */
export function describeDocument(name, document, classDocuments = []) {
    const subObjects = (document.subObjects ?? []).map(readSubObject);
    const classes = describeClasses(classDocuments, refNames(document.classes));

    // A shipped preset's prefab is `REF:GameObject|<name>` once references are named, and
    // a mod's own is a `PREFAB:` path. Only the first is worth unwrapping: the second is a
    // path the model reader resolves and must survive as written.
    const prefab = /^REF:/i.test(document.prefab ?? '')
        ? refName(document.prefab)
        : document.prefab ?? null;

    return {
        name,
        prefab,

        // The one thing that says two presets draw the same model. It is not a formality:
        // a third of the game's presets are not named after their own prefab.
        sharesModel: !!prefab && prefab !== name && !/^PREFAB:/i.test(prefab),

        classes,
        filters: refNames(document.allowedRoomFilters),
        universal: !!document.universalDesignStyle,

        // The game's own default is 99, which is larger than most rooms -- so an asset that
        // states nothing needs a room nothing has. Read as stated rather than as zero.
        minimumRoomSize: document.minimumRoomSize ?? 99,

        placed: subObjects.filter((sub) => !sub.parent),
        parented: subObjects.filter((sub) => sub.parent),

        interactables: (document.integratedInteractables ?? []).map((entry) => ({
            preset: refName(entry?.preset),
            controller: controllerOf(entry?.pairToController),
            owner: ownerOf(entry?.belongsTo),
        })),
    };
}

/**
 * A sub-object, as the pane holds one.
 *
 * Vectors become arrays and enums become names, so that everything downstream -- the list,
 * the view, the writer -- deals in one shape. `furniturePlan.js` is where they go back.
 */
function readSubObject(sub) {
    return {
        class: refName(sub?.preset) ?? '(unnamed)',
        ...(sub?.parent ? { parent: sub.parent } : {}),
        pos: vector(sub?.localPos),
        rot: vector(sub?.localRot),
        owner: ownerOf(sub?.belongsTo),
        ...(sub?.security ? { security: sub.security } : {}),
    };
}

/**
 * The slot classes a preset names, in the order it names them.
 *
 * A name that could not be read is kept and marked rather than dropped: a preset in a
 * class nothing can find is a preset nothing will place, which is worth saying and is
 * invisible if the row is simply absent.
 */
function describeClasses(documents, names) {
    const byName = new Map(documents.map((document) => [document.presetName ?? document.name, document]));

    return names.map((name) => {
        const document = byName.get(name);
        if (!document) return { name, missing: true };

        return {
            name,
            size: [document.objectSize?.x ?? 1, document.objectSize?.y ?? 1],
            tall: !!document.tall,
            wallPiece: !!document.wallPiece,
            minWalls: document.minimumZeroNodeWallCount ?? 0,
            maxWalls: document.maximumZeroNodeWallCount ?? 4,
            document,
        };
    });
}

/**
 * Where one node of the class's grid sits in the scene, in metres.
 *
 * **One grid, one frame.** A `FurnitureClass` writes every offset it has -- wall rules,
 * node rules, blocked access, node weights -- in the furniture's own frame, where `right` is
 * +x and `front` is +y (`CityData.GetOffsetFromDirection`). This is that frame in metres, so
 * a rule and the tile it is written on are the same point in both halves of the pane.
 *
 * **The anchor is the piece's front-right node and the body reaches back and to its left.**
 * The origin sits at the centre of the anchor node, at floor level, and a 3x1 desk covers
 * `(0,0)`, `(-1,0)` and `(-2,0)`. It is not centred on the origin, and a footprint drawn as
 * though it were puts the whole of that desk's contents on one of its three squares.
 *
 * Which way it reaches is in `GenerationController.cs:4543-4550`: the footprint loop walks
 * `objectSize.x` by `objectSize.y` from zero and lays each node down at
 * `clusterAngle + facingAngle - 180`, where every rule is read at `clusterAngle +
 * facingAngle` (`:4841`, `:5113`, `:5181`). Two further quarter turns is a negation, so
 * `(i, j)` of the loop is `(-i, -j)` of the frame the rules are in. `furnitureChain.js`
 * carries the same reading in the building flow, as `turn([i, j], quarters + 2)`.
 *
 * The shipped assets say it a second way: `2x1Sofa` states its wall rules at `(0,0)` and
 * `(-1,0)`, which are its own two nodes, and `3x1HotelDesk` blocks access on `(0,0)`,
 * `(-1,0)` and `(-2,0)`. Across the 262 classes, 313 of the 323 `blockedAccess` offsets are
 * zero or negative on both axes.
 *
 * In the scene's coordinates, so x is mirrored the way `inSceneSpace` mirrors it -- which is
 * why a piece whose nodes count down in x is drawn reaching along +x. z is not mirrored.
 */
export const footprintNode = (x, y) => [negate(x * NODE_METRES), 0, plain(y * NODE_METRES)];

/**
 * The box drawn where the model would be, in metres.
 *
 * A preset can carry several classes, and they need not agree about the footprint. The
 * largest is drawn, because a box smaller than the piece would put sub-objects outside it
 * and invite an author to move them in.
 *
 * `centre` is where that box stands, which is the middle of the block of nodes rather than
 * the origin -- see `footprintNode` for why those are not the same point.
 *
 * Null when no class is known, which is a preset with nothing to draw a box from rather
 * than a preset that is a point.
 */
export function proxyBox(preset) {
    const classes = (preset?.classes ?? []).filter((entry) => !entry.missing);
    if (!classes.length) return null;

    const across = Math.max(...classes.map((entry) => entry.size[0]));
    const deep = Math.max(...classes.map((entry) => entry.size[1]));
    const tall = classes.some((entry) => entry.tall);

    return {
        width: across * NODE_METRES,
        depth: deep * NODE_METRES,
        height: tall ? PROXY_HEIGHT_TALL : PROXY_HEIGHT,
        tiles: [across, deep],
        centre: footprintNode(-(across - 1) / 2, -(deep - 1) / 2),
        tall,
    };
}

/**
 * The nodes a mod's own model actually reaches, as bounds on the same grid a class states
 * its rules on.
 *
 * **The game never reads this.** Placement is decided from `objectSize` and nothing else, so
 * a model overhanging its declared footprint is placed anyway and then clips through
 * whatever is on the node beside it. That is the failure this answers: it is invisible in
 * the assets, invisible in the class, and obvious the moment the two are drawn together.
 *
 * The reading, which has to match `footprintNode` exactly or the overlay is a confident lie:
 *
 *  - `parseObj` already undid the writer's mirror, so a geometry's positions are in the
 *    scene's coordinates rather than the game's.
 *  - The prefab's per-mesh offset is not: it is a position in the game's space like any
 *    other, and the view mirrors x when it applies it (`furnitureView.js`, `drawModel`).
 *  - A node `(x, y)` is centred at `(−x·NODE_METRES, 0, y·NODE_METRES)` -- `footprintNode`
 *    -- so a tile spans half a node either side of that, and a point falls on the node it
 *    is nearest the centre of.
 *
 * So x comes back negated and z does not, which is `footprintNode` read the other way. The
 * nodes it names are the ones a class writes its rules at, because that is the only grid
 * either half of this pane draws.
 *
 * ## A flush model is not an overhanging one
 *
 * The two ends round *inwards* rather than both the same way, which is `lowNode` and
 * `highNode` below. A 3x1 desk modelled to fill its footprint exactly reaches 4.5 m from the
 * anchor -- the boundary between node -2 and node -3 -- and one rule for both ends puts that
 * on node -3 and reports an overhang the author does not have. Every well-made model sits
 * exactly on a boundary at both ends, so this is the ordinary case rather than an edge of one.
 *
 * A bounding box rather than a coverage test. A round table's box reaches its corner nodes
 * and the table does not, so this overstates a curved model -- which is the right way round
 * for a warning about clipping, and is why the pane's wording says "reaches into" rather
 * than "covers".
 *
 * Null when there is no model to measure: a shipped preset, whose prefab is in an asset
 * bundle this app cannot open, or one whose file was not found. Not an extent of nothing --
 * the caller draws no overlay at all rather than an empty one.
 */
export function modelExtent(loaded) {
    if (!loaded?.meshes?.length) return null;

    let minX = Infinity; let maxX = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;

    for (const mesh of loaded.meshes) {
        const positions = mesh?.geometry?.positions ?? [];

        // The offset as the view applies it: mirrored on x, taken as it is on z.
        const atX = -(mesh?.offset?.[0] ?? 0);
        const atZ = mesh?.offset?.[2] ?? 0;

        for (let i = 0; i + 2 < positions.length; i += 3) {
            const x = positions[i] + atX;
            const z = positions[i + 2] + atZ;

            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }
    }

    // Meshes with no vertices in them, which `parseObj` cannot produce but a hand-written
    // prefab pointing at an empty file could. Nothing to measure is the same answer as
    // nothing to measure it from.
    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) return null;

    // The frame's +x is the scene's −x, so the two x extremes swap on the way across -- and
    // swap which rounding they take with them, because each end still rounds towards the
    // middle of the model. z is the same axis in both and does not swap.
    return {
        minX: lowNode(-maxX),
        maxX: highNode(-minX),
        minY: lowNode(minZ),
        maxY: highNode(maxZ),
        metres: {
            across: round(maxX - minX),
            deep: round(maxZ - minZ),
        },
    };
}

/**
 * The lowest node whose tile holds this coordinate: a boundary belongs to the tile above.
 *
 * `plain` is not decoration. Both of these round towards zero from the wrong side for half
 * the inputs -- `Math.ceil(-0.4)` is `-0`, and the anchor node is exactly where that lands --
 * and a `-0` here is an index that prints as `0`, compares `===` to it, and fails every deep
 * comparison a test runner makes. See `negate` above.
 */
const lowNode = (metres) => plain(Math.floor(metres / NODE_METRES + 0.5));

/** The highest: a boundary belongs to the tile below, which is the other half of the pair. */
const highNode = (metres) => plain(Math.ceil(metres / NODE_METRES - 0.5));


/* -------------------------------------------------------------------------- */
/* Unity's coordinates, and this scene's                                       */
/* -------------------------------------------------------------------------- */

/**
 * A sub-object's place and turn, converted from the game's coordinates to three.js'.
 *
 * Here rather than in the view because it is arithmetic that is silently wrong when it is
 * wrong: a mirrored lamp is still a lamp, and the sub-objects that turn about something
 * other than Y are the minority -- so the case that would expose it is the rare one.
 *
 * ## The mirror
 *
 * The game's world is left-handed -- x right, y up, z forward -- and three's is
 * right-handed, so a position copied straight across draws the model mirrored. Negating x
 * is what the two systems actually differ by, and it is what `scene.js` does to the floor
 * for the same reason. Its own involution, so the same conversion reads back.
 *
 * ## The turn
 *
 * Two things have to hold together, and getting either alone is not enough.
 *
 * **Order.** Unity composes `Quaternion.Euler(x, y, z)` as `Ry · Rx · Rz`. In three.js
 * that composition is the Euler order `YXZ`; the default `XYZ` gives a different rotation
 * from the same three numbers, and the two agree only while two of the three are zero --
 * which is most of them, so a wrong order looks right nearly everywhere.
 *
 * **Handedness.** Conjugating a rotation by the mirror `M = diag(-1, 1, 1)` gives
 * `M R(n, θ) Mᵀ = R(det(M)·Mn, θ)`, and with `det(M) = -1` that takes the axis `n` to
 * `(nx, -ny, -nz)`. Applied to each factor of `Ry · Rx · Rz` in turn: the rotation about x
 * is unchanged, and those about y and z are negated. So the angles come across as
 * `(x, -y, -z)`.
 *
 * Returns radians, which is what three.js reads, and names the order so a caller cannot
 * apply it with the default one.
 */
export function inSceneSpace(sub) {
    const [x, y, z] = sub.pos;
    const [pitch, yaw, roll] = sub.rot;

    return {
        position: [negate(x), y, z],
        rotation: [pitch * DEGREES, negate(yaw * DEGREES), negate(roll * DEGREES)],
        order: 'YXZ',
    };
}

/**
 * The way back: a marker's place in the scene, as the numbers a file holds.
 *
 * Both halves of the conversion are their own inverse, so this is the same arithmetic read
 * the other way rather than a second derivation that could drift from the first. What it
 * is not is the same *function*: the units differ, radians in and degrees out, and a caller
 * handed one when it wanted the other gets a rotation 57 times too big without an error.
 *
 * Degrees come back in `[0, 360)`, which is the range the game's own data is written in --
 * a dragged marker that produced `-15°` where every shipped value is `345°` would make a
 * hand-edited file look unlike every other one for no reason.
 */
export function fromSceneSpace(position, rotation) {
    const degrees = (radians) => {
        const value = (radians / DEGREES) % 360;
        return round(value < 0 ? value + 360 : value);
    };

    return {
        pos: [round(negate(position[0])), round(position[1]), round(position[2])],
        rot: [degrees(rotation[0]), degrees(negate(rotation[1])), degrees(negate(rotation[2]))],
    };
}

/**
 * A tile offset in a cluster, as a point on the floor in metres.
 *
 * `footprintNode` under another name, and deliberately not a second copy of the arithmetic.
 * A cluster's placements are rotated by the cluster's angle alone
 * (`GenerationController.cs:4542`), which is the angle every rule in a class is read at --
 * so a cluster's tiles and a class's tiles are one grid, and this is that grid in metres.
 * `y` on a placement is the floor's second axis rather than a height, which is why it comes
 * back as `z`.
 */
export const tileCentre = footprintNode;


/* -------------------------------------------------------------------------- */
/* The arrangements a preset can appear in                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every cluster with a slot one of this preset's classes fills.
 *
 * Answered from the index rather than by reading again: it is a question about every
 * cluster, and the index is what having read every cluster once looks like.
 *
 * Disabled clusters are kept and marked. A cluster with `disable` set places nothing at
 * all, and an author looking at the only arrangement their preset appears in should be
 * told it is switched off rather than shown a list that quietly excludes it.
 */
export function clustersFor(index, preset) {
    const wanted = new Set((preset?.classes ?? []).map((entry) => entry.name));
    if (!wanted.size || !index) return [];

    const names = new Set();
    for (const className of wanted) {
        for (const name of index.byClass.get(className) ?? []) names.add(name);
    }

    return [...names].sort().map((name) => {
        const document = index.clusters.get(name);
        const elements = document?.clusterElements ?? [];

        return {
            name,
            disabled: !!document?.disable,
            filters: refNames(document?.allowedRoomFilters),
            slots: elements
                .map((element, position) => ({ element, position }))
                .filter(({ element }) => wanted.has(refName(element?.furnitureClass)))
                .map(({ position }) => position),
            elements: elements.length,
        };
    });
}

/**
 * One cluster as a plan drawing: a slot per element, at the tile it stands on.
 *
 * An element states one placement almost always, and a handful state two: alternates to
 * try when the first is refused. Both are returned, with `alternate` marking the ones that
 * are a fallback rather than a position, since drawing them as equals would show a cluster
 * placing two of something it places one of.
 */
export function clusterLayout(index, name) {
    const document = index?.clusters.get(name);
    if (!document) return null;

    const slots = [];

    (document.clusterElements ?? []).forEach((element, position) => {
        const places = (element?.placements ?? []).length
            ? element.placements
            : [{ x: 0, y: 0 }];

        places.forEach((place, attempt) => {
            slots.push({
                index: position,
                class: refName(element?.furnitureClass),
                x: place?.x ?? 0,
                y: place?.y ?? 0,
                facing: FACING[element?.facing ?? 0] ?? 'down',
                important: !!element?.importantToCluster,

                // Skipped unless the element before it placed. The trap worth surfacing:
                // the condition records that the previous *class* placed, so a slot
                // sharing a tile with the one before it fires whatever model won that
                // draw -- drawers inside a desk with no knee-hole.
                afterPrevious: !!element?.onlyValidIfPreviousObjectPlaced,

                alternate: attempt > 0,
            });
        });
    });

    return { name, slots, bounds: boundsOf(slots) };
}

/**
 * `FurnitureCluster.FurnitureFacing` (FurnitureCluster.cs:317).
 *
 * The one enum this module needs that `furnitureEnums.js` does not carry, and it is here
 * for the same reason those are there: `soEnums.json` holds it twice, and the copy keyed
 * on the field name `facing` is alphabetised, which swaps `up` with `left`.
 */
const FACING = ['down', 'up', 'left', 'right'];

/** The tile extent a layout covers, so a view can frame it without measuring twice. */
function boundsOf(slots) {
    if (!slots.length) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };

    return {
        minX: Math.min(...slots.map((slot) => slot.x)),
        maxX: Math.max(...slots.map((slot) => slot.x)),
        minY: Math.min(...slots.map((slot) => slot.y)),
        maxY: Math.max(...slots.map((slot) => slot.y)),
    };
}

/**
 * Slots standing on the same tile as the one before them, which is the co-located trap.
 *
 * Reported per cluster rather than per element: what an author needs to know is "this
 * arrangement pairs two things on one square", and which pair it is.
 */
export function coLocated(layout) {
    const pairs = [];

    for (const slot of layout?.slots ?? []) {
        if (!slot.afterPrevious || slot.alternate) continue;

        const previous = layout.slots.find((other) => other.index === slot.index - 1
            && !other.alternate);

        if (previous && previous.x === slot.x && previous.y === slot.y) {
            pairs.push({ tile: [slot.x, slot.y], first: previous.class, second: slot.class });
        }
    }

    return pairs;
}


/* -------------------------------------------------------------------------- */
/* What the pane says out loud                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What is worth saying about a preset before an author changes anything.
 *
 * Every one of these fails silently in game -- the object simply is not there, and the
 * only sign is a line in a log nobody reads -- which is why they are on screen rather than
 * behind a check button. The wording says what would happen, not what is set: "never
 * placed" is the fact an author can act on.
 */
export function warningsFor(preset) {
    if (!preset) return [];

    const notes = [];

    if (!preset.classes.length) {
        notes.push('This preset is in no furniture class, so no cluster has a slot it can '
            + 'fill and nothing will ever place it.');
    }

    for (const entry of preset.classes) {
        if (entry.missing) {
            notes.push(`${entry.name} could not be read, so where this may stand cannot be `
                + 'checked. It is either a class this mod has not written yet or one your '
                + 'exported ScriptableObjects folder does not hold.');
        }
    }

    if (!preset.filters.length) {
        notes.push('This preset names no room filters, so no room class admits it. A clone '
            + 'brings the donor’s filters, which are usually the wrong ones for wherever it '
            + 'is being moved to.');
    }

    if (!preset.universal) {
        notes.push('This preset is not universal to every design style, so it appears only in '
            + 'rooms whose decor matches one of its own styles. A clone brings the donor’s '
            + 'styles, and they frequently do not overlap the destination.');
    }

    if (preset.minimumRoomSize >= 99) {
        notes.push(`This preset needs a room of at least ${preset.minimumRoomSize} squares, `
            + 'which is larger than most rooms in the game. 99 is what a preset written from '
            + 'scratch is left holding when nothing states a minimum.');
    }

    if (preset.parented.length) {
        notes.push(preset.parented.length === 1
            ? 'One of its sub-objects hangs off a named transform inside the model, so where '
                + 'it really sits is not knowable here. It is listed rather than drawn.'
            : `${preset.parented.length} of its sub-objects hang off a named transform inside `
                + 'the model, so where they really sit is not knowable here. They are listed '
                + 'rather than drawn.');
    }

    return notes;
}

/**
 * What a sub-object slot is worth saying, one line, or nothing.
 *
 * A zero chance is the case this exists for, and it is not "never": the classes that state
 * one carry trait modifiers that raise it. Saying "never fills" off the chance alone would
 * be wrong about exactly the slots worth reporting.
 */
export function describeSlot(document) {
    if (!document) return null;

    const parts = [];
    const chance = document.perInstanceSpawnChance ?? 1;
    const modifiers = (document.perInstanceModifiers ?? []).length;

    if (chance !== 1) {
        parts.push(modifiers
            ? `${Math.round(chance * 100)}% before ${modifiers} trait `
                + `${modifiers === 1 ? 'rule' : 'rules'} that raise it`
            : `${Math.round(chance * 100)}% of the time`);
    }

    if (document.limitCountPerObject) {
        parts.push(`at most ${document.maxPerObject ?? 1} per object`);
    }

    return parts.length ? parts.join(', ') : null;
}

/**
 * The preset names to offer, filtered by what has been typed.
 *
 * `names` is the export folder's own listing -- see `listAssets` -- rather than the
 * generated `soAssetsByType.json`, so furniture a newer game added is offered rather than
 * being on disk and invisible. Names only: no asset is read until one is chosen, which is
 * what keeps opening the pane free.
 */
export function presetNames(names, search = '', extra = []) {
    const term = search.trim().toLowerCase();

    return [...new Set([...names, ...extra])]
        .filter((name) => !term || name.toLowerCase().includes(term))
        .sort();
}
