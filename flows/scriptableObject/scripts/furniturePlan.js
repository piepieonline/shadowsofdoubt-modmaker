/**
 * What writing a piece of furniture comes to: three assets, and a manifest entry each.
 *
 * The room creator's `roomPlan.js`, one level down the chain and with the same shape --
 * choices in, a set of files and a list of problems out, nothing touched. Which is what
 * lets the pane show the plan before it runs it, and what lets this be tested without a
 * folder or a browser.
 *
 * ## Why three files and not one
 *
 * A preset alone is a reskin: the model joins the uniform draw for a slot it already
 * fits, alongside whatever else fills that slot. That is cheap and is sometimes what an
 * author wants, and it is not what somebody who has just moved a lamp 5 cm wants -- their
 * model would appear at a slot that some *other* preset might equally fill, and the
 * arrangement around it stays whatever it was.
 *
 * So the default is the three the game's own notes call "same furniture, different
 * arrangement": a class whose only member is this preset, and a cluster that puts that
 * class down. A one-member class has nothing else to draw, so the slot is this model or
 * nothing -- which is the transitive gate, and the only way to be sure what appears.
 *
 * ## Names
 *
 * The preset takes the bare name and the other two are suffixed, for the reason the room
 * creator gives about `RoomTypePreset`: the preset is the one an author browses -- the
 * building flow's furniture panel lists it -- and the other two are machinery.
 *
 *     MyDesk        FurniturePreset
 *     MyDeskFC      FurnitureClass
 *     MyDeskFCL     FurnitureCluster
 */
import { fileNameFor } from '../../../core/soFileName.js';
import { isNameFieldSafe } from '../../../core/strings.js';
import { WALL_RULE, BLOCKING_DIRECTION, RULE_OPTION } from '../../../core/furnitureRules.js';
import { ownerIndex, controllerIndex } from './furnitureEnums.js';

/** The suffixes the two machinery assets take. */
export const CLASS_SUFFIX = 'FC';
export const CLUSTER_SUFFIX = 'FCL';

/**
 * The fields this pane owns in each file, and therefore the only ones it may write over.
 *
 * A file this tool wrote once is not a file it owns for ever. An author edits what it wrote
 * -- the pane's own note after every write tells them to -- and a save that rebuilt the file
 * from the pane's model threw all of it away: a second slot in an arrangement, a
 * `minimumRoomSize` typed in by hand, a `customNodeWeights` this pane can read and has no
 * editor for, and any field of the game's that nothing here has heard of.
 *
 * So a save is a merge. What is on disk is the base, these keys are replaced, and everything
 * else is left exactly as it was. Listed by name rather than derived from the object about to
 * be written, because the two differ in the case that matters: a `copyFrom` that is being
 * *removed* is absent from the new object, and a merge that only overlaid present keys would
 * leave the old one behind -- which is how the self-referencing `copyFrom` would come back.
 *
 * `fileType` is in each list because it is what the loader dispatches on; it never changes,
 * and stating it keeps a hand-written file that omitted it working after a save.
 */
export const OWNED_FIELDS = {
    /*
     * `minimumRoomSize`, `universalDesignStyle` and `allowedRoomFilters` are deliberately
     * *not* here, though this does write them.
     *
     * It writes them once, for a preset with no donor, because the game's own
     * `minimumRoomSize` default is 99 and a from-scratch preset left holding it never
     * places. That is a value put in at creation, not a field this pane owns -- there is no
     * control for any of the three. Owning them would mean clearing them on every save and
     * putting back only what the pane happened to derive, which turns an author's
     * hand-typed `minimumRoomSize: 6` into whatever was read a moment ago.
     *
     * Left off the list, they survive a merge untouched, and the creation case is
     * unaffected because a file being created has nothing to merge into.
     */
    FurniturePreset: [
        'fileType', 'name', 'presetName', 'copyFrom', 'classes', 'subObjects', 'prefab',
        'integratedInteractables',
    ],

    FurnitureClass: [
        'fileType', 'name', 'presetName', 'copyFrom',
        'objectSize', 'wallRules', 'nodeRules', 'blockedAccess',
    ],

    // Everything, because a cluster is only ever written when it is being created. Once it
    // exists the pane owns nothing in it: there is no control anywhere here that writes to
    // one, and the arrangement is the author's. See `createOnly` on the planned file.
    FurnitureCluster: null,
};

/**
 * One planned file as it should land on top of whatever is already there.
 *
 * `onDisk` is the parsed file or null. The owned keys are cleared before the new ones go on,
 * so a field this save means to *remove* is removed rather than surviving underneath.
 */
export function mergeFile(entry, onDisk) {
    if (!onDisk || entry.createOnly) return entry.content;

    const owned = OWNED_FIELDS[entry.type];
    if (!owned) return entry.content;

    const merged = { ...onDisk };
    for (const field of owned) delete merged[field];

    return { ...merged, ...entry.content };
}

/**
 * What a cluster element has to state, and why every field is here.
 *
 * `clusterElements` **replaces wholesale**: a file that states the list states all of it,
 * and a field left off an element is not inherited, it is zero. That makes an incomplete
 * element quietly fatal in one specific way -- `chanceOfPlacementAttempt: 0` means never
 * place -- so the whole struct is written every time rather than the parts that differ.
 *
 * `placementScoreBoost` is 0 rather than 1. The shipped clusters are split almost evenly
 * between the two, so there is no default to copy; 0 is the neutral one, adding nothing to
 * a placement score, where a wrong 1 quietly outranks somebody else's furniture.
 */
const element = (className, { facing = 0, important = true } = {}) => ({
    onlyValidIfPreviousObjectPlaced: false,
    placements: [{ x: 0, y: 0 }],
    furnitureClass: `REF:FurnitureClass|${className}`,
    facing,
    importantToCluster: important,
    chanceOfPlacementAttempt: 1,
    placementScoreBoost: 0,
    useFovBlock: false,
    blockDirection: { x: 0, y: 0 },
    maxFOVBlockDistance: 0,
    localScale: { x: 1, y: 1, z: 1 },
    positionOffset: { x: 0, y: 0, z: 0 },
});

/**
 * A sub-object as the game serialises one.
 *
 * The reverse of `readSubObject` in modFurniture.js: the pane holds positions as arrays
 * because that is what the reference data does, and a file holds them as objects because
 * that is what Unity wrote. The two shapes meet at exactly these two functions.
 *
 * `belongsTo` goes out as its **index**. The game serialises the enum as an integer, every
 * shipped asset holds one, and so does every hand-authored file in the bank example mod. A
 * .NET JSON reader would take the member name as well, so this is not a correctness fix so
 * much as a refusal to write the only file of its type that is spelled differently.
 */
const subObject = (sub) => ({
    preset: `REF:SubObjectClassPreset|${sub.class}`,
    parent: sub.parent ?? '',
    localPos: { x: sub.pos[0], y: sub.pos[1], z: sub.pos[2] },
    localRot: { x: sub.rot[0], y: sub.rot[1], z: sub.rot[2] },
    belongsTo: ownerIndex(sub.owner),
    security: sub.security ?? 0,
});

/**
 * One integrated interactable as the game serialises one.
 *
 * The reverse of the `interactables` half of `describeDocument`, and the same three fields
 * the type has -- there is no fourth to lose.
 *
 * Both enums go out as **indices**, for the reason `subObject` gives. `pairToController` is
 * the one where that matters most: it is the id of an `InteractableController` inside the
 * prefab, and the integer is what the game reads it back as.
 */
const interactable = (entry) => ({
    preset: `REF:InteractablePreset|${entry.preset}`,
    pairToController: controllerIndex(entry.controller),
    belongsTo: ownerIndex(entry.owner),
});

/**
 * A placement, as the fields a `FurnitureClass` states it in.
 *
 * Every enum goes out as its index, which is how the game serialises them and how every
 * shipped and hand-authored asset is written -- see the note on `subObject`.
 *
 * The lists are stated whole or not at all. Each one replaces the donor's rather than
 * merging with it, so writing `wallRules` and leaving `nodeRules` off would take the
 * donor's node rules and this one's wall rules, which is a class nobody wrote.
 *
 * `objectSize` is stated for the same reason, and it is not a list. It is the field the
 * whole diagram is drawn from -- the footprint, which tiles the rules are measured against,
 * where the model overhangs -- so an author who has looked at that diagram should get the
 * class it showed. Left off, a copy silently keeps the donor's size, which is a 1x1 desk
 * where a 3x1 one was drawn.
 */
function statedRules(placement, className, classDonor) {
    const vector = ([x, y]) => ({ x, y });
    const option = (name) => Math.max(0, RULE_OPTION.indexOf(name));

    const size = placement.size ?? [1, 1];

    const wallRules = (placement.rules ?? [])
        .filter((rule) => rule.kind === 'wall')
        .map((rule) => ({
            nodeOffset: vector(rule.at ?? [0, 0]),
            wallDirection: Math.max(0, BLOCKING_DIRECTION.indexOf(rule.dir)),
            option: option(rule.gates === false ? 'canFeature' : rule.must ? 'mustFeature' : 'cantFeature'),
            tag: Math.max(0, WALL_RULE.indexOf(rule.tag)),
            ...(rule.room ? { roomType: `REF:RoomConfiguration|${rule.room}` } : {}),
            addScore: rule.score ?? 0,
        }));

    const nodeRules = (placement.rules ?? [])
        .filter((rule) => rule.kind === 'node')
        .map((rule) => ({
            offset: vector(rule.at ?? [0, 0]),
            option: option(rule.option),
            anyOccupiedTile: !!rule.any,

            // A rule about any occupied tile names no class, and one naming a class is not
            // about any tile. Writing both would be a rule the game reads twice over.
            ...(rule.any ? {} : { furnitureClass: rule.class ? `REF:FurnitureClass|${rule.class}` : null }),
            addScore: rule.score ?? 0,
        }));

    const blockedAccess = (placement.blocks ?? []).map((entry) => ({
        disabled: false,
        nodeOffset: vector(entry.at ?? [0, 0]),
        blockExteriorDiagonals: !!entry.diagonals,
        blocked: (entry.dirs ?? []).map((dir) => Math.max(0, BLOCKING_DIRECTION.indexOf(dir))),
    }));

    return {
        objectSize: { x: size[0], y: size[1] },
        wallRules,
        nodeRules,
        blockedAccess,
    };
}

/**
 * The three assets, the order they load in, and what is wrong with them.
 *
 * `choices` is what the pane holds: a name, the preset being copied, the class it is
 * mimicking, the sub-objects as edited, and the prefab if the author has one.
 *
 * Nothing here reads the folder. What is already on disk is `against`'s business, the way
 * it is in the room creator, so that the same plan can be shown before a folder is chosen
 * and checked again at the moment of writing.
 */
export function planFurniture(choices) {
    const name = (choices.name ?? '').trim();
    const className = `${name}${CLASS_SUFFIX}`;
    const clusterName = `${name}${CLUSTER_SUFFIX}`;

    const problems = [];

    if (!name) problems.push('This furniture needs a name before it can be written.');
    else if (!isNameFieldSafe(name)) {
        problems.push(`“${name}” is not a usable asset name. Letters, digits, hyphens and `
            + 'underscores only — the name is a file name and a reference, and the loader '
            + 'matches it exactly.');
    }

    /*
     * A name the mod already patches is a name that cannot also be a file of fields.
     *
     * The two are different files -- `X.sodso_patch.json` and `X.FurniturePreset.sodso.json`
     * -- so nothing collides on disk and the ordinary clash check sees nothing. What the
     * loader does with them is the problem: the patch edits the shipped `X` and the other
     * declares an `X` of the mod's own, and which one anything referring to `X` gets is a
     * question the load order answers rather than the author.
     */
    if (name && (choices.patched ?? []).includes(name)) {
        problems.push(`This mod already patches ${name}. Writing a file of fields under the `
            + 'same name would leave two assets called that — the shipped one your patch '
            + 'edits, and a new one of your own. Give this a different name.');
    }

    /*
     * A plan with no files, rather than files that must not be written.
     *
     * Everything above is about the name, and a name is what the three files are made of --
     * so there is nothing to plan until it is settled. Returning no files rather than
     * flagging them is what makes this structural: a pane that draws the plan cannot offer
     * to write one that does not exist, and it does not have to recognise a problem by its
     * wording to know that.
     *
     * The empty case is the ordinary one rather than an edge: the pane draws this on every
     * keystroke and a name starts empty. `fileNameFor` refuses an empty name by throwing,
     * which is right of it -- `.FurniturePreset.sodso.json` is not a lesser version of a
     * named file.
     */
    if (problems.length) return { files: [], order: [], problems };

    const donor = choices.donor ?? null;
    const classDonor = choices.classDonor ?? null;
    const subObjects = choices.subObjects ?? [];

    /*
     * The interactables, and the one entry that cannot be written.
     *
     * An entry whose `preset` could not be named is one whose reference did not resolve --
     * `REF:InteractablePreset|` with nothing after the bar, or a field the file left out.
     * Writing it would put `REF:InteractablePreset|null` in the file, which is a reference
     * to an asset called "null" and loads as nothing at all.
     *
     * Left out of the file rather than written broken, and said out loud below: a list that
     * silently came back one shorter than it went in is the same class of thing this whole
     * field is about.
     */
    const interactables = choices.interactables ?? [];
    const unnamed = interactables.filter((entry) => !entry?.preset).length;
    const writable = interactables.filter((entry) => entry?.preset);

    /*
     * The preset. `copyFrom` carries everything not stated -- the materials, the design
     * styles, the gates -- which is what makes this three files rather than thirty fields.
     *
     * `classes` is stated because the whole point is that this preset is the only member of
     * its own class. `subObjects` is stated because they are what was edited, and stating
     * them replaces the donor's whole, which is what an author who moved one of them means.
     */
    const preset = {
        fileType: 'FurniturePreset',
        name,
        presetName: name,
        ...(donor ? { copyFrom: `REF:FurniturePreset|${donor}` } : {}),
        classes: [`REF:FurnitureClass|${className}`],
        subObjects: subObjects.map(subObject),

        /*
         * Stated for the same reason `subObjects` is, and with the same consequence: the
         * loader's `FromJsonOverwrite` replaces a stated list rather than merging it, so
         * this is the donor's whole list as edited rather than an addition to it. Which is
         * the only way the field can be edited at all -- adding one entry by hand means
         * re-listing the donor's, and the list on screen is the donor's already resolved.
         */
        integratedInteractables: writable.map(interactable),
        ...(choices.prefab ? { prefab: choices.prefab } : {}),
    };

    /*
     * Without a donor there is nothing to inherit, and the field that bites is
     * `minimumRoomSize`: the game's own default is 99, which is larger than most rooms, so
     * a preset written from scratch and left alone never places. Stated here rather than
     * left, because a file written by this tool should not need that knowledge to work.
     */
    if (!donor) {
        preset.minimumRoomSize = choices.minimumRoomSize ?? 1;
        preset.universalDesignStyle = true;
        preset.allowedRoomFilters = (choices.filters ?? []).map((filter) => `REF:RoomTypeFilter|${filter}`);
    }

    /*
     * The class. Two shapes, and which one is written decides whether a trap fires.
     *
     * Without stated rules it is a clone: `copyFrom` and nothing else, which brings the
     * donor's whole rule set -- including `nodeRules` that still name the *donor*. That is
     * invisible in game and is the trap reported below.
     *
     * With them, the rules are written out in full and the trap is gone: a rule that named
     * the donor has been read, shown, and written back as whatever it now names. That is
     * the difference the placement editor makes, and it is why stating them is worth the
     * bytes even where nothing was changed.
     */
    const placement = choices.placement ?? null;

    /*
     * A class may never copy from itself, whatever it was asked to copy.
     *
     * `MyDeskFC` with `copyFrom: MyDeskFC` is a loop for the loader to follow and a class
     * with no rules of its own, and neither shows up before the city is generated. It is
     * reachable by an ordinary route rather than by a strange one: the preset states the
     * class this tool wrote for it, so the second time that furniture is opened, the class
     * the pane finds itself mimicking *is* the one it is about to write.
     *
     * Refused here as well as avoided in the pane, because it is a property of the file
     * rather than of how the choices were gathered -- the preset's own `copyFrom` has been
     * guarded this way from the start, and this is the same rule one level down.
     */
    const selfCopy = classDonor === className;
    const donorOfClass = selfCopy ? null : classDonor;

    const furnitureClass = {
        fileType: 'FurnitureClass',
        name: className,
        presetName: className,
        ...(donorOfClass ? { copyFrom: `REF:FurnitureClass|${donorOfClass}` } : {}),
        ...(placement ? statedRules(placement, className, donorOfClass) : {}),
    };

    /*
     * The cluster. Written from nothing rather than copied: what a cluster *is* is its
     * element list, and a copy that replaced that list has inherited only the gates --
     * which are easier to state than to explain.
     *
     * The filters are the preset's own, so the arrangement reaches the same rooms the
     * model was already admitted to. Without them the cluster is in no filter and no room
     * class admits it, which is the same silent nothing a new room class has.
     */
    const cluster = {
        fileType: 'FurnitureCluster',
        name: clusterName,
        presetName: clusterName,
        clusterElements: [element(className, { facing: choices.facing ?? 0 })],
        allowedRoomFilters: (choices.filters ?? []).map((filter) => `REF:RoomTypeFilter|${filter}`),
        minimumRoomSize: choices.minimumRoomSize ?? 1,
    };

    if (!choices.filters?.length) {
        problems.push('Nothing admits this. Neither the preset nor its cluster names a room '
            + 'filter, so no room class takes it and the generator will never place one — the '
            + 'city builds, and the object is simply not in it.');
    }

    /*
     * The trap, and the one case where it does not fire.
     *
     * A cloned class brings the donor's `nodeRules`, and those point at the *donor* -- so a
     * rule reading "keep clear of one of these" goes on meaning the original rather than
     * the copy. It is invisible in game: placements quietly fail, and nothing is logged.
     *
     * Stating the rules is what fixes it, because a stated list replaces the donor's whole
     * and every rule in it has been read and written back by name. So the warning is about
     * the clone that states nothing, not about every clone.
     */
    if (donorOfClass && !placement) {
        problems.push(`${className} copies ${donorOfClass} and states no rules of its own, so it `
            + `brings the donor’s — including node rules that still name ${donorOfClass} rather `
            + 'than the copy. That is invisible in game: placements quietly fail, and nothing '
            + 'is logged. Open Placement and the rules are written out in full instead.');
    }

    /*
     * The self-copy, refused above, leaving a class with nothing in it.
     *
     * Only reachable when the caller gave neither a donor this class could keep nor any
     * rules -- the pane states the rules in exactly this case, so this is the backstop
     * saying so rather than writing a class that decides nothing and never places.
     */
    if (selfCopy && !placement) {
        problems.push(`${className} was asked to copy itself, which cannot be written — a `
            + 'file naming itself in `copyFrom` is a loop. It has been left off, and no rules '
            + 'were stated to take its place, so this class would decide nothing and the '
            + 'piece would never be placed. Open Placement so the rules are written in full.');
    }

    if (placement) {
        const selfNaming = (placement.rules ?? [])
            .filter((rule) => rule.kind === 'node' && rule.class === donorOfClass);

        if (donorOfClass && selfNaming.length) {
            problems.push(`${selfNaming.length} node ${selfNaming.length === 1 ? 'rule names'
                : 'rules name'} ${donorOfClass}, which is the class this one was copied from `
                + 'rather than this one. That may be what you meant — a piece that keeps clear '
                + 'of the original is a real thing to want — but it is also what a clone brings '
                + 'by accident.');
        }
    }

    if (!subObjects.length && donor) {
        problems.push('This states an empty list of sub-objects, which replaces the donor’s '
            + 'rather than leaving them alone. Nothing will sit on it.');
    }

    if (unnamed) {
        problems.push(`${unnamed} integrated ${unnamed === 1 ? 'interactable names'
            : 'interactables name'} no InteractablePreset, so ${unnamed === 1 ? 'it has'
            : 'they have'} been left out of the file. A reference with nothing after the bar `
            + 'points at an asset called nothing, which loads as nothing — name '
            + `${unnamed === 1 ? 'it' : 'them'} or remove ${unnamed === 1 ? 'it' : 'them'}.`);
    }

    const files = [
        { file: fileNameFor(className, 'FurnitureClass'), asset: className, type: 'FurnitureClass', content: furnitureClass },
        { file: fileNameFor(name, 'FurniturePreset'), asset: name, type: 'FurniturePreset', content: preset },

        /*
         * The cluster, written when it is created and never again.
         *
         * There is no control anywhere in this pane that writes to a cluster -- not one --
         * so after the first write it has nothing to contribute and everything to lose. The
         * note this pane puts up says "editing the cluster is how it becomes more", and an
         * arrangement built on that invitation was then rebuilt from the one-element
         * template by the next save.
         *
         * Renaming is safe without any special case, because the file name follows the
         * name: `MyDeskFCL` becoming `NewNameFCL` is a cluster that does not exist yet, and
         * so is one this creates.
         */
        {
            file: fileNameFor(clusterName, 'FurnitureCluster'),
            asset: clusterName,
            type: 'FurnitureCluster',
            content: cluster,
            createOnly: true,
        },
    ];

    return {
        files,

        // The load order, which is dependency order: every `REF:` has to resolve to
        // something already loaded. The class before the preset that names it, and the
        // cluster last because it names the class too.
        order: files.map((entry) => entry.file.replace(/\.sodso\.json$/, '')),
        problems,
    };
}

/**
 * How each file lands against what the folder already holds.
 *
 * `write` for a name nothing has, `clash` for one something else does. There is no
 * `append` here, unlike the room creator: a room adds itself to other people's patches,
 * and a piece of furniture writes three files of its own and touches nothing else.
 */
export function against(files, existing) {
    return files.map((entry) => ({
        ...entry,
        landing: existing.has(entry.file) ? 'clash' : 'write',
    }));
}

/**
 * The names this plan would write over, less the ones that are this furniture's own.
 *
 * Saving over yourself is not a clash. `own` is the set of file names the thing being
 * edited already occupies, which the pane knows because it read them.
 */
export function collisions(files, existing, own = new Set()) {
    return files
        .map((entry) => entry.file)
        .filter((file) => existing.has(file) && !own.has(file));
}
