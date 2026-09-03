/**
 * What writing a piece of furniture comes to.
 *
 * Three assets and a load order, built from choices and nothing else -- no folder, no
 * browser -- which is what lets the pane show the plan before it runs it and lets this
 * check the parts that fail silently in game.
 *
 * Two of those are worth the most care, because neither produces an error anywhere:
 * a cluster element missing a field is a `chanceOfPlacementAttempt` of 0, which means
 * never place; and a cloned class brings node rules still pointing at the original.
 */
import { describe, test, expect } from 'vitest';

import { planFurniture, CLASS_SUFFIX, CLUSTER_SUFFIX } from './furniturePlan.js';
import { indexMod, landAll, stemOf } from '../../../core/soBuilder.js';

const data = { chain: {}, furniture: {} };

/** A content folder holding exactly these assets, in the shape `indexMod` reads. */
const folder = (...held) => indexMod({
    files: held.map((raw) => ({
        fileName: `${raw.name}.${raw.fileType}.sodso.json`,
        file: `${raw.name}.${raw.fileType}`,
        name: raw.name,
        type: raw.fileType,
        patch: false,
        raw,
    })),
});

const choices = (fields = {}) => ({
    name: 'MyDesk',
    donor: 'HotelDesk',
    classDonor: '3x1LobbyDesk',
    filters: ['Lobby'],
    subObjects: [{ class: 'Computer', pos: [-1, 1, 0.25], rot: [0, 180, 0], owner: 'person0' }],
    ...fields,
});

const assetOf = (plan, type) => plan.changes.find((entry) => entry.type === type).content;


describe('the three assets', () => {
    test('names the preset plainly and suffixes the machinery', () => {
        const plan = planFurniture(choices(), data);

        expect(plan.changes.map((entry) => entry.file)).toEqual([
            `MyDesk${CLASS_SUFFIX}.FurnitureClass.sodso.json`,
            'MyDesk.FurniturePreset.sodso.json',
            `MyDesk${CLUSTER_SUFFIX}.FurnitureCluster.sodso.json`,
        ]);
    });

    /**
     * Every `REF:` has to resolve to something already loaded, so the class goes down
     * before the preset that names it and the cluster last.
     */
    test('lists them in the order the loader can resolve', () => {
        // What `commit` puts in `fileOrder`, which is the changes in the order they are
        // planned with their suffix taken off.
        expect(planFurniture(choices(), data).changes.map((change) => stemOf(change.file))).toEqual([
            'MyDeskFC.FurnitureClass',
            'MyDesk.FurniturePreset',
            'MyDeskFCL.FurnitureCluster',
        ]);
    });

    /**
     * The whole point of writing three: a class with one member has nothing else to draw,
     * so the slot is this model or nothing.
     */
    test('makes the preset the only member of its own class', () => {
        const plan = planFurniture(choices(), data);

        expect(assetOf(plan, 'FurniturePreset').classes).toEqual(['REF:FurnitureClass|MyDeskFC']);
        expect(assetOf(plan, 'FurnitureCluster').clusterElements[0].furnitureClass)
            .toBe('REF:FurnitureClass|MyDeskFC');
    });

    test('copies the preset it was opened from rather than restating it', () => {
        expect(assetOf(planFurniture(choices(), data), 'FurniturePreset').copyFrom)
            .toBe('REF:FurniturePreset|HotelDesk');
    });

    /**
     * `belongsTo` goes out as its index. Every shipped asset holds one, and so does every
     * hand-authored file in the bank example mod; a .NET reader would take the member name
     * too, so this is a refusal to write the only file of its type spelled differently.
     */
    test('writes the sub-objects as the game serialises them', () => {
        const preset = assetOf(planFurniture(choices(), data), 'FurniturePreset');

        expect(preset.subObjects).toEqual([{
            preset: 'REF:SubObjectClassPreset|Computer',
            parent: '',
            localPos: { x: -1, y: 1, z: 0.25 },
            localRot: { x: 0, y: 180, z: 0 },
            belongsTo: 2,
            security: 0,
        }]);
    });

    test('writes nobody as the zero the game writes', () => {
        const plan = planFurniture(choices({
            subObjects: [{ class: 'Junk', pos: [0, 0, 0], rot: [0, 0, 0], owner: 'nobody' }],
        }), data);

        expect(assetOf(plan, 'FurniturePreset').subObjects[0].belongsTo).toBe(0);
    });

    test('keeps the transform a parented sub-object hangs off', () => {
        const plan = planFurniture(choices({
            subObjects: [{ class: 'DeskLamp', parent: 'TopDrawer', pos: [0, 1, 0], rot: [0, 0, 0] }],
        }), data);

        expect(assetOf(plan, 'FurniturePreset').subObjects[0].parent).toBe('TopDrawer');
    });

    /**
     * Both enums as indices, for the same reason `belongsTo` is one. `pairToController` is
     * the one that matters most: the game reads it back as an integer and looks the
     * corresponding id up among the prefab's controllers.
     */
    test('writes the integrated interactables as the game serialises them', () => {
        const preset = assetOf(planFurniture(choices({
            interactables: [
                { preset: 'HotelDesk', controller: 'A', owner: 'person0' },
                { preset: 'HidingPlace', controller: 'hidingPlace', owner: 'nobody' },
            ],
        }), data), 'FurniturePreset');

        expect(preset.integratedInteractables).toEqual([
            { preset: 'REF:InteractablePreset|HotelDesk', pairToController: 0, belongsTo: 2 },
            { preset: 'REF:InteractablePreset|HidingPlace', pairToController: 10, belongsTo: 0 },
        ]);
    });

    /**
     * `none` is 11 and not the enum's zero, which is `A`. A pairing this could not read
     * coming out as 0 would be an interactable silently attached to a real controller --
     * usually the first one the model has.
     */
    test('writes a pairing to none as the eleven the enum puts it at', () => {
        const preset = assetOf(planFurniture(choices({
            interactables: [{ preset: 'HotelDesk', controller: 'none', owner: 'nobody' }],
        }), data), 'FurniturePreset');

        expect(preset.integratedInteractables[0].pairToController).toBe(11);
    });

    /**
     * Stated even when there are none, because the field replaces the donor's rather than
     * adding to it -- so a preset the author has emptied has to say so, or the donor's list
     * comes back through `copyFrom`.
     */
    test('states an empty list rather than leaving the field off', () => {
        expect(assetOf(planFurniture(choices({ interactables: [] }), data), 'FurniturePreset')
            .integratedInteractables).toEqual([]);
    });

    /**
     * `REF:InteractablePreset|null` is a reference to an asset called nothing, and it loads
     * as nothing. Left out of the file and reported instead -- see the problems below.
     */
    test('leaves out an entry that names no interactable preset', () => {
        const preset = assetOf(planFurniture(choices({
            interactables: [
                { preset: null, controller: 'A', owner: 'nobody' },
                { preset: 'HotelDesk', controller: 'B', owner: 'nobody' },
            ],
        }), data), 'FurniturePreset');

        expect(preset.integratedInteractables).toEqual([
            { preset: 'REF:InteractablePreset|HotelDesk', pairToController: 1, belongsTo: 0 },
        ]);
    });

    /**
     * `clusterElements` replaces wholesale, and a field left off an element is zero rather
     * than inherited. `chanceOfPlacementAttempt: 0` is "never place", so an incomplete
     * element is a cluster that silently does nothing.
     */
    test('states every field of a cluster element, not only the ones that differ', () => {
        const element = assetOf(planFurniture(choices(), data), 'FurnitureCluster').clusterElements[0];

        expect(Object.keys(element).sort()).toEqual([
            'blockDirection', 'chanceOfPlacementAttempt', 'facing', 'furnitureClass',
            'importantToCluster', 'localScale', 'maxFOVBlockDistance',
            'onlyValidIfPreviousObjectPlaced', 'placementScoreBoost', 'placements',
            'positionOffset', 'useFovBlock',
        ]);

        expect(element.chanceOfPlacementAttempt).toBe(1);
        expect(element.localScale).toEqual({ x: 1, y: 1, z: 1 });
    });

    test('gives the cluster the filters that admit the preset', () => {
        expect(assetOf(planFurniture(choices(), data), 'FurnitureCluster').allowedRoomFilters)
            .toEqual(['REF:RoomTypeFilter|Lobby']);
    });
});


describe('a preset with nothing to copy', () => {
    const scratch = planFurniture(choices({ donor: null, classDonor: null }), data);

    /**
     * The game's own default is 99, which is larger than most rooms -- so a from-scratch
     * preset left alone never places. A file this tool writes should not need that
     * knowledge to work.
     */
    test('states a room size rather than inheriting the 99 that never places', () => {
        expect(assetOf(scratch, 'FurniturePreset').minimumRoomSize).toBe(1);
    });

    test('states a design style rather than inheriting none', () => {
        expect(assetOf(scratch, 'FurniturePreset').universalDesignStyle).toBe(true);
    });

    test('carries no copyFrom at all rather than an empty one', () => {
        expect(assetOf(scratch, 'FurniturePreset').copyFrom).toBeUndefined();
        expect(assetOf(scratch, 'FurnitureClass').copyFrom).toBeUndefined();
    });
});


describe('what it says is wrong', () => {
    const problemsOf = (fields) => planFurniture(choices(fields), data).problems.join(' ');

    test('refuses a name that is not a usable one', () => {
        expect(problemsOf({ name: '' })).toContain('needs a name');
        expect(problemsOf({ name: 'My Desk!' })).toContain('not a usable asset name');
    });

    /**
     * A cloned class brings the donor's node rules, and those still name the donor. It is
     * invisible in game -- placements quietly fail -- and it cannot be fixed from here,
     * because redirecting them needs the whole class asset.
     */
    test('warns that a cloned class brings rules pointing at the original', () => {
        expect(problemsOf({})).toContain('still name 3x1LobbyDesk rather than the copy');
    });

    test('says when nothing would admit it', () => {
        expect(problemsOf({ filters: [] })).toContain('no room class takes it');
    });

    /** Stating an empty list replaces the donor's rather than leaving it alone. */
    test('says when an empty sub-object list would strip the donor’s', () => {
        expect(problemsOf({ subObjects: [] })).toContain('Nothing will sit on it');
    });

    /**
     * Reported rather than written, because writing it is `REF:InteractablePreset|null` --
     * well-formed, resolving to an asset called nothing, and silent.
     */
    test('says when an interactable names no preset, and counts them', () => {
        expect(problemsOf({ interactables: [{ preset: null, controller: 'A', owner: 'nobody' }] }))
            .toContain('1 integrated interactable names no InteractablePreset');

        expect(problemsOf({
            interactables: [
                { preset: null, controller: 'A', owner: 'nobody' },
                { preset: '', controller: 'B', owner: 'nobody' },
            ],
        })).toContain('2 integrated interactables name no InteractablePreset');
    });

    /**
     * The two files do not collide on disk -- `X.sodso_patch.json` and
     * `X.FurniturePreset.sodso.json` are different names -- so the ordinary clash check
     * sees nothing. What the loader does with them is the problem: one edits the shipped
     * asset and the other declares one of the mod's own, both called `X`.
     */
    test('refuses a name this mod already patches', () => {
        expect(problemsOf({ name: 'HotelDesk', patched: ['HotelDesk'] }))
            .toContain('already patches HotelDesk');
    });

    test('says nothing about a plan with nothing wrong with it', () => {
        expect(planFurniture(choices({ classDonor: null }), data).problems).toEqual([]);
    });
});


/**
 * Stating the rules is what makes the class a class of its own rather than a clone with a
 * new name -- and it is the only way to fix the trap a clone carries.
 */
describe('a class with its rules stated', () => {
    const placement = {
        size: [3, 1],
        rules: [
            { kind: 'wall', at: [0, 0], dir: 'behind', tag: 'wall', must: true, gates: true },
            { kind: 'wall', at: [0, 1], dir: 'front', tag: 'entrance', gates: false, score: 2 },
            { kind: 'node', at: [0, 1], option: 'cantFeature', class: '2x1Sofa', gates: true },
            { kind: 'node', at: [0, -1], option: 'cantFeature', any: true, gates: true, score: 1 },
        ],
        blocks: [{ kind: 'block', at: [0, 0], dirs: ['behind', 'behindLeft'], diagonals: true }],
    };

    const stated = assetOf(planFurniture(choices({ placement }), data), 'FurnitureClass');

    test('writes the enums as the indices the game serialises', () => {
        // behind is index 2 of BlockingDirection, wall is 1 of WallRule, mustFeature is 0.
        expect(stated.wallRules[0]).toEqual({
            nodeOffset: { x: 0, y: 0 },
            wallDirection: 2,
            option: 0,
            tag: 1,
            addScore: 0,
        });
    });

    test('writes a scoring rule as canFeature with its score', () => {
        expect(stated.wallRules[1].option).toBe(2);
        expect(stated.wallRules[1].addScore).toBe(2);
    });

    test('writes a node rule naming a class, and one naming any occupied tile', () => {
        expect(stated.nodeRules[0]).toEqual({
            offset: { x: 0, y: 1 },
            option: 1,
            anyOccupiedTile: false,
            furnitureClass: 'REF:FurnitureClass|2x1Sofa',
            addScore: 0,
        });

        // A rule about any occupied tile names no class: writing both would be a rule the
        // game reads twice over.
        expect(stated.nodeRules[1].anyOccupiedTile).toBe(true);
        expect(stated.nodeRules[1].furnitureClass).toBeUndefined();
    });

    test('writes what the piece blocks, with the diagonals flag', () => {
        expect(stated.blockedAccess[0]).toEqual({
            disabled: false,
            nodeOffset: { x: 0, y: 0 },
            blockExteriorDiagonals: true,
            blocked: [2, 1],
        });
    });

    /**
     * All three lists or none. Each replaces the donor's rather than merging, so writing
     * one and leaving another off would give the donor's node rules and this one's wall
     * rules -- a class nobody wrote.
     */
    test('states all three lists, even the empty ones', () => {
        const bare = assetOf(planFurniture(choices({
            placement: { rules: [], blocks: [] },
        }), data), 'FurnitureClass');

        expect(bare.wallRules).toEqual([]);
        expect(bare.nodeRules).toEqual([]);
        expect(bare.blockedAccess).toEqual([]);
    });

    /**
     * The footprint the diagram was drawn from. Left off, the copy keeps the donor's size --
     * a 1x1 desk where a 3x1 one was shown, and nothing anywhere says so.
     */
    test('states the footprint, so a widened piece is written as widened', () => {
        expect(stated.objectSize).toEqual({ x: 3, y: 1 });
    });

    /** A placement with no size stated is one node, not nought of them. */
    test('falls back to one node rather than writing a piece of no size', () => {
        const bare = assetOf(planFurniture(choices({
            placement: { rules: [], blocks: [] },
        }), data), 'FurnitureClass');

        expect(bare.objectSize).toEqual({ x: 1, y: 1 });
    });

    /**
     * The rule an author can only reach through the editor's kind select: "will not be
     * placed if anything at all is there". `cantFeature` with `anyOccupiedTile`, and no
     * class named, because a rule about any tile is not a rule about one class.
     */
    test('writes a rule that refuses any occupied tile at all', () => {
        const written = assetOf(planFurniture(choices({
            placement: {
                rules: [{ kind: 'node', at: [1, 0], option: 'cantFeature', any: true, gates: true }],
                blocks: [],
            },
        }), data), 'FurnitureClass').nodeRules[0];

        expect(written).toEqual({
            offset: { x: 1, y: 0 },
            option: 1,
            anyOccupiedTile: true,
            addScore: 0,
        });
    });

    /** A block made in the editor carries a `kind` the writer has no business passing on. */
    test('writes a block without the tag the editor selects it by', () => {
        expect(stated.blockedAccess[0]).not.toHaveProperty('kind');
    });

    /** The trap is about a clone that states nothing, not about every clone. */
    test('drops the cloned-rules warning once the rules are stated', () => {
        const problems = planFurniture(choices({ placement }), data).problems.join(' ');

        expect(problems).not.toContain('states no rules of its own');
    });

    test('still warns when a stated rule names the class it was copied from', () => {
        const problems = planFurniture(choices({
            placement: {
                rules: [{ kind: 'node', at: [0, 1], option: 'cantFeature', class: '3x1LobbyDesk', gates: true }],
                blocks: [],
            },
        }), data).problems.join(' ');

        expect(problems).toContain('which is the class this one was copied from');
    });
});


/**
 * A class may never copy from itself.
 *
 * Reachable by the ordinary route rather than a strange one: the preset states the class
 * this tool wrote for it, so the second time that furniture is opened, the class the pane
 * finds itself mimicking *is* the one it is about to write. `MyDeskFC` with
 * `copyFrom: MyDeskFC` is a loop for the loader and a class with no rules of its own, and
 * neither shows up before the city is generated.
 */
describe('a class asked to copy itself', () => {
    const asItself = (extra) => assetOf(planFurniture(choices({
        classDonor: 'MyDeskFC', ...extra,
    }), data), 'FurnitureClass');

    test('leaves the copyFrom off rather than writing the loop', () => {
        expect(asItself({ placement: { size: [3, 1], rules: [], blocks: [] } }))
            .not.toHaveProperty('copyFrom');
    });

    /** Refusing the loop is only half of it: the rules have to come from somewhere. */
    test('keeps the rules that were stated in its place', () => {
        const written = asItself({
            placement: {
                size: [3, 1],
                rules: [{ kind: 'wall', at: [0, 0], dir: 'behind', tag: 'wall', must: true, gates: true }],
                blocks: [],
            },
        });

        expect(written.wallRules).toHaveLength(1);
        expect(written.objectSize).toEqual({ x: 3, y: 1 });
    });

    /**
     * No donor and no rules is a class that decides nothing and a piece that never places.
     * The pane states the rules in exactly this case, so this is the backstop saying so.
     */
    test('says so when there are no rules to take the copy’s place', () => {
        const problems = planFurniture(choices({ classDonor: 'MyDeskFC', placement: null }), data)
            .problems.join(' ');

        expect(problems).toContain('asked to copy itself');
        expect(problems).toContain('would decide nothing');
    });

    /** The bare-clone warning is about a real donor, so it must not fire for a dropped one. */
    test('does not also warn about bringing its own rules', () => {
        const problems = planFurniture(choices({ classDonor: 'MyDeskFC', placement: null }), data)
            .problems.join(' ');

        expect(problems).not.toContain('states no rules of its own');
    });

    /** A class of the mod's own under a different name is an ordinary donor, not a loop. */
    test('still copies another class of this mod’s', () => {
        const written = assetOf(planFurniture(choices({
            classDonor: 'OtherDeskFC', placement: null,
        }), data), 'FurnitureClass');

        expect(written.copyFrom).toBe('REF:FurnitureClass|OtherDeskFC');
    });
});


/**
 * A file this tool wrote once is not a file it owns for ever.
 *
 * An author edits what it wrote — the pane's own note after every write tells them to — and
 * a save that rebuilt the file from the pane's model threw all of it away: a second slot in
 * an arrangement, a `minimumRoomSize` typed in by hand, a `customNodeWeights` this pane can
 * read and has no editor for, and any field of the game's nothing here has heard of.
 */
describe('landing a planned file on one that is already there', () => {
    const changeFor = (type, fields = {}) => planFurniture(choices({
        placement: { size: [3, 1], rules: [], blocks: [] },
        ...fields,
    }), data).changes.find((entry) => entry.type === type);

    /** One of the pane's files saved over a file of that name it already wrote. */
    const saveOver = (type, held, fields = {}) => {
        const change = changeFor(type, fields);
        const index = held ? folder(held) : indexMod();

        return landAll([change], index, { own: new Set([change.file]) })[0];
    };

    test('is the plan itself where there is nothing to land on', () => {
        const landed = saveOver('FurniturePreset', null);

        expect(landed.action).toBe('create');
        expect(landed.content).toEqual(changeFor('FurniturePreset').content);
    });

    /** The whole point: a field with no control in this pane is one it cannot have meant. */
    test('keeps fields the pane does not own', () => {
        const { content, action } = saveOver('FurniturePreset', {
            fileType: 'FurniturePreset',
            name: 'MyDesk',
            minimumRoomSize: 6,
            lightsOnAtNight: true,
            somethingThisToolHasNeverHeardOf: 42,
        });

        expect(action).toBe('merge');
        expect(content.minimumRoomSize).toBe(6);
        expect(content.lightsOnAtNight).toBe(true);
        expect(content.somethingThisToolHasNeverHeardOf).toBe(42);
    });

    test('replaces the ones it does', () => {
        const { content } = saveOver('FurniturePreset', {
            fileType: 'FurniturePreset',
            name: 'MyDesk',
            classes: ['REF:FurnitureClass|SomethingElse'],
            subObjects: [{ preset: 'REF:SubObjectClassPreset|Old' }],
        });

        expect(content.classes).toEqual(['REF:FurnitureClass|MyDeskFC']);
        expect(content.subObjects).toEqual(changeFor('FurniturePreset').content.subObjects);
    });

    /**
     * The interactables are the pane's now, so an entry taken off in the pane has to come
     * off the file. Left unowned it would sit under the merge and come back on the next
     * save, which is the removal quietly not happening.
     */
    test('replaces the interactables rather than leaving the file’s underneath', () => {
        const { content } = saveOver('FurniturePreset', {
            fileType: 'FurniturePreset',
            name: 'MyDesk',
            integratedInteractables: [
                { preset: 'REF:InteractablePreset|Gone', pairToController: 1, belongsTo: 0 },
                { preset: 'REF:InteractablePreset|AlsoGone', pairToController: 2, belongsTo: 0 },
            ],
        }, { interactables: [{ preset: 'HotelDesk', controller: 'A', owner: 'nobody' }] });

        expect(content.integratedInteractables).toEqual([
            { preset: 'REF:InteractablePreset|HotelDesk', pairToController: 0, belongsTo: 0 },
        ]);
    });

    /**
     * The reason the owned fields are a named list rather than the keys of the object about
     * to be written. A `copyFrom` being *removed* is absent from that object, so a merge
     * that only overlaid present keys would leave the old one sitting underneath -- which is
     * how the self-referencing `copyFrom` this pane refuses to write would come back.
     */
    test('removes an owned field the plan no longer states', () => {
        const { content } = saveOver('FurnitureClass', {
            fileType: 'FurnitureClass',
            name: 'MyDeskFC',
            copyFrom: 'REF:FurnitureClass|MyDeskFC',
        }, { classDonor: 'MyDeskFC' });

        expect(content).not.toHaveProperty('copyFrom');
    });

    /** The class keeps what the placement editor reads and has no control for. */
    test('keeps the class fields the placement editor cannot edit', () => {
        const { content } = saveOver('FurnitureClass', {
            fileType: 'FurnitureClass',
            name: 'MyDeskFC',
            customNodeWeights: [{ nodeOffset: { x: 1, y: 0 }, nodeWeightModifier: -5 }],
            awayFromClasses: ['REF:FurnitureClass|1x1KitchenSink'],
            minimumNodeDistance: 2,
            tall: true,
            maximumZeroNodeWallCount: 3,
        });

        expect(content.customNodeWeights).toHaveLength(1);
        expect(content.awayFromClasses).toEqual(['REF:FurnitureClass|1x1KitchenSink']);
        expect(content.minimumNodeDistance).toBe(2);
        expect(content.tall).toBe(true);
        expect(content.maximumZeroNodeWallCount).toBe(3);

        // And still states what it does own.
        expect(content.objectSize).toEqual({ x: 3, y: 1 });
        expect(content.wallRules).toEqual([]);
    });

    /**
     * The cluster is written when it is created and never again. There is no control
     * anywhere in this pane that writes to one, so after the first write it has nothing to
     * contribute and everything to lose.
     */
    test('marks the cluster as one to create and then leave alone', () => {
        expect(changeFor('FurnitureCluster').createOnly).toBe(true);
        expect(changeFor('FurnitureClass').createOnly).toBe(false);
        expect(changeFor('FurniturePreset').createOnly).toBe(false);
    });

    test('leaves an existing cluster exactly as it is', () => {
        const held = {
            fileType: 'FurnitureCluster',
            name: 'MyDeskFCL',
            clusterElements: [{ furnitureClass: 'REF:FurnitureClass|MyDeskFC' }, { furnitureClass: 'REF:FurnitureClass|Chair' }],
        };

        expect(saveOver('FurnitureCluster', held).action).toBe('leave');
    });
});


describe('landing against a folder', () => {
    const plan = planFurniture(choices(), data);
    const asset = (name, fileType) => ({ name, fileType });

    const landing = (held, own = new Set()) => landAll(plan.changes, folder(...held), { own });

    test('marks a name something else already has', () => {
        const landed = landing([asset('MyDesk', 'FurniturePreset')]);

        expect(landed.filter((item) => item.action === 'clash').map((item) => item.file))
            .toEqual(['MyDesk.FurniturePreset.sodso.json']);
    });

    test('does not call saving over your own files a clash', () => {
        const held = [asset('MyDesk', 'FurniturePreset'), asset('MyDeskFC', 'FurnitureClass')];
        const own = new Set(plan.changes.map((change) => change.file));

        expect(landing(held, own).filter((item) => item.action === 'clash')).toEqual([]);
    });

    test('is a clash when the files belong to something else', () => {
        const landed = landing([asset('MyDeskFC', 'FurnitureClass')]);

        expect(landed.filter((item) => item.action === 'clash').map((item) => item.file))
            .toEqual(['MyDeskFC.FurnitureClass.sodso.json']);
    });
});
