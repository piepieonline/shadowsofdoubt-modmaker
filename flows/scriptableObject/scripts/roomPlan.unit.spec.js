/**
 * The change set a room comes to, against the game's own reference data.
 *
 * Everything here is decided before a folder is touched, which is the point of the split:
 * what the author is about to write is checkable without writing it.
 *
 * The worked example is the export server's own -- an indoor picnic area admitting one
 * bench -- because its closure is a single preset that must be patched separately or the
 * cluster resolves to nothing. Upstairs it is awkward in a second way: `PicnicTable` is
 * limited to floors -1 to 0, so a room three storeys up admits a cluster that will never be
 * placed in it, which the plan has to say rather than quietly work around.
 */
import { describe, test, expect } from 'vitest';

import {
    planRoom, refusedBy, assetNames, fullClosure, abandoned, roomRefs, roomOperations,
    sharedNames, OWNED_FIELDS,
} from './roomPlan.js';

import {
    indexMod, landAll, stemOf, withdrawOps,
} from '../../../core/soBuilder.js';

import rooms from '../../../refs/derived/roomCreator.json' with { type: 'json' };
import chain from '../../../refs/derived/furnitureChain.json' with { type: 'json' };

/** The worked example, on the ground floor, where nothing about the room is awkward. */
const picnicArea = {
    name: 'PicnicArea',
    donor: 'Atrium',
    donorRoomType: 'Atrium',
    context: { floor: 0 },
    clusters: ['PicnicTable'],
    surfaces: { walls: 'PlainWall', floor: 'WoodenFlooring', ceiling: 'PlasterCeiling' },
    lighting: ['AtriumLight'],
};

/** The same room three storeys up, which is where the floor gate refuses its furniture. */
const upstairs = { ...picnicArea, context: { floor: 3 } };

const plan = () => planRoom(picnicArea, rooms, chain);
const byFile = (result) => Object.fromEntries(result.changes.map((entry) => [entry.file, entry]));

/** A content folder holding exactly these files, in the shape `indexMod` reads. */
const folder = (...held) => indexMod({
    files: held.map((raw) => {
        const patch = Array.isArray(raw.patches);
        const name = raw.presetName ?? raw.name;

        return {
            fileName: patch ? `${name}.sodso_patch.json` : `${name}.${raw.fileType}.sodso.json`,
            file: patch ? name : `${name}.${raw.fileType}`,
            name,
            type: raw.fileType,
            patch,
            raw,
        };
    }),
});


describe('naming', () => {
    /**
     * The RoomTypePreset takes the bare name because it is the one asset that surfaces in
     * the floorplan editor's room picker. An author looking for "PicnicArea" should not
     * have to know it is spelled PicnicAreaRTP.
     */
    test('only the room type carries the bare name', () => {
        expect(assetNames('PicnicArea')).toEqual({
            roomClass: 'PicnicAreaRCP',
            filter: 'PicnicAreaRTF',
            roomType: 'PicnicArea',
            configuration: 'PicnicAreaRC',
        });
    });
});


describe('the four assets', () => {
    test('are written first, in the order they reference each other', () => {
        const { changes } = plan();

        expect(changes.slice(0, 4).map((change) => stemOf(change.file))).toEqual([
            'PicnicAreaRCP.RoomClassPreset',
            'PicnicAreaRTF.RoomTypeFilter',
            'PicnicArea.RoomTypePreset',
            'PicnicAreaRC.RoomConfiguration',
        ]);
    });

    /**
     * `fileType` and nothing else. Files this tool wrote before carried a `type` beside it,
     * which every reader ignores in favour of `fileType` -- so it said nothing, and it is
     * owned rather than written so that a save clears it back out.
     */
    test('the room class is empty, which is what makes the room admit nothing', () => {
        const file = byFile(plan())['PicnicAreaRCP.RoomClassPreset.sodso.json'];

        expect(file.content).toEqual({
            presetName: 'PicnicAreaRCP',
            fileType: 'RoomClassPreset',
            name: 'PicnicAreaRCP',
            copyFrom: null,
        });
    });

    test('the filter wraps the class, and is what everything else is admitted through', () => {
        const file = byFile(plan())['PicnicAreaRTF.RoomTypeFilter.sodso.json'];
        expect(file.content.roomClasses).toEqual(['REF:RoomClassPreset|PicnicAreaRCP']);
    });

    /**
     * The ring: forceConfiguration would point at the configuration, whose roomType points
     * back, and a linear fileOrder cannot express that. Both prior write-ups found this
     * independently, and it fails at load rather than at write.
     */
    test('the room type never forces a configuration, and never overrides floor height', () => {
        const file = byFile(plan())['PicnicArea.RoomTypePreset.sodso.json'];

        expect(file.content.forceConfiguration).toBeNull();
        expect(file.content.overrideFloorHeight).toBe(false);
        expect(file.content.copyFrom).toBe('REF:RoomTypePreset|Atrium');
    });

    test('the configuration points at both, and copies the donor', () => {
        const file = byFile(plan())['PicnicAreaRC.RoomConfiguration.sodso.json'];

        expect(file.content.copyFrom).toBe('REF:RoomConfiguration|Atrium');
        expect(file.content.roomType).toBe('REF:RoomTypePreset|PicnicArea');
        expect(file.content.roomClass).toBe('REF:RoomClassPreset|PicnicAreaRCP');
    });
});


/**
 * A file this tool wrote once is not a file it owns for ever. The pane's own note tells the
 * author to go and edit what it wrote, and a save that rebuilt each file from the plan threw
 * all of that away.
 */
describe('saving a room over itself', () => {
    const held = {
        fileType: 'RoomConfiguration',
        presetName: 'PicnicAreaRC',
        name: 'PicnicAreaRC',
        copyFrom: 'REF:RoomConfiguration|Atrium',
        roomType: 'REF:RoomTypePreset|PicnicArea',
        roomClass: 'REF:RoomClassPreset|PicnicAreaRCP',

        // Hand-typed, and nothing in the pane has a control for any of it.
        securityDoors: 2,
        useOwnership: true,
        somethingThisToolHasNeverHeardOf: 42,
    };

    const saved = () => {
        const change = plan().changes
            .find((entry) => entry.file === 'PicnicAreaRC.RoomConfiguration.sodso.json');

        return landAll([change], folder(held), { own: new Set([change.file]) })[0];
    };

    test('keeps every field the pane does not own', () => {
        const { action, content } = saved();

        expect(action).toBe('merge');
        expect(content.securityDoors).toBe(2);
        expect(content.useOwnership).toBe(true);
        expect(content.somethingThisToolHasNeverHeardOf).toBe(42);
    });

    test('still states the ones it does', () => {
        expect(saved().content.roomClass).toBe('REF:RoomClassPreset|PicnicAreaRCP');
    });

    /** The stray `type` a file written before this carries, cleared rather than left. */
    test('clears a key it owns and no longer writes', () => {
        const change = plan().changes
            .find((entry) => entry.file === 'PicnicAreaRCP.RoomClassPreset.sodso.json');

        const [landed] = landAll(
            [change],
            folder({
                fileType: 'RoomClassPreset', presetName: 'PicnicAreaRCP', name: 'PicnicAreaRCP', type: 'RoomClassPreset',
            }),
            { own: new Set([change.file]) },
        );

        expect(landed.content).not.toHaveProperty('type');
    });

    /** Somebody else's file of that name is not this room's to merge into. */
    test('is a clash when the room is not the one being edited', () => {
        const change = plan().changes
            .find((entry) => entry.file === 'PicnicAreaRC.RoomConfiguration.sodso.json');

        expect(landAll([change], folder(held), { own: new Set() })[0].action).toBe('clash');
    });

    test('owns the identity of every one of the four, and nothing else of the game’s', () => {
        for (const owned of Object.values(OWNED_FIELDS)) {
            expect(owned).toContain('fileType');
            expect(owned).toContain('copyFrom');
            expect(owned).not.toContain('securityDoors');
        }
    });
});


/**
 * The room admits by patching `allowedRoomFilters` and by nothing else.
 *
 * It used to clone a cluster whose gates refused the room, into a file of the mod's own with
 * the gate relaxed. That file came back out of the folder under its own name, which the
 * reference data has never heard of, and the next save wrote a patch aimed at it.
 */
describe('a cluster the gates refuse', () => {
    test('is patched exactly like any other', () => {
        const file = byFile(planRoom(upstairs, rooms, chain))['PicnicTable.sodso_patch.json'];

        expect(file.content).toEqual({
            name: 'PicnicTable',
            fileType: 'FurnitureCluster',
            patches: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|PicnicAreaRTF' }],
        });
    });

    test('writes no file of the mod’s own', () => {
        const { changes } = planRoom(upstairs, rooms, chain);

        expect(changes.filter((entry) => entry.type === 'FurnitureCluster')
            .every((entry) => entry.kind === 'add')).toBe(true);
        expect(byFile(planRoom(upstairs, rooms, chain))['PicnicArea_PicnicTable.FurnitureCluster.sodso.json'])
            .toBeUndefined();
    });

    /**
     * Loud, because the failure is silent: the gate is checked before the room class, so the
     * cluster is simply never placed and nothing is logged.
     */
    test('is reported, with what to do about it', () => {
        const { problems } = planRoom(upstairs, rooms, chain);
        const said = problems.find((text) => text.startsWith('PicnicTable is admitted'));

        expect(said).toContain('limited to floors -1 to 0');
        expect(said).toContain('copy PicnicTable into your mod by hand');
    });

    test('says nothing where the gates pass', () => {
        expect(refusedBy(rooms, 'PicnicTable', { floor: 0 })).toEqual([]);
        expect(plan().problems).toEqual([]);
    });

    /** Every failing gate, not the first: they are independent conditions on the room. */
    test('names the gate that refused it', () => {
        const failures = refusedBy(rooms, 'PicnicTable', { floor: 3 });

        expect(failures.map((failure) => failure.gate)).toEqual(['floor']);
    });

    /** Nothing is decided on a blank: an unstated floor answers "unknown", not "no". */
    test('is not refused when nothing has been said about where the room sits', () => {
        expect(refusedBy(rooms, 'PicnicTable', {})).toEqual([]);
    });
});


describe('the closure', () => {
    /**
     * The failure this exists to prevent: admitting a cluster does not admit its contents.
     * Without this patch PicnicTable resolves to nothing and is abandoned every time it is
     * attempted, with one debug line to say so.
     */
    test('every preset a cluster resolves to is patched too', () => {
        const file = byFile(plan())['PicnicBench.sodso_patch.json'];

        expect(file.content.fileType).toBe('FurniturePreset');
        expect(file.content.patches).toEqual([
            { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|PicnicAreaRTF' },
        ]);
    });

    test('a preset shared by two clusters is patched once', () => {
        const result = planRoom({
            ...picnicArea,
            context: {},
            clusters: ['1_ArmchairFacingTV', '3_FacingArmchairs'],
        }, rooms, chain);

        const patched = result.changes.filter((entry) => entry.type === 'FurniturePreset').map((entry) => entry.asset);
        expect(patched.length).toBe(new Set(patched).size);
        expect(patched).toContain('BrownArmchair');
    });
});


describe('surfaces and lighting', () => {
    test('patch the filter for a surface, and the light for the room', () => {
        const files = byFile(plan());

        expect(files['PlainWall.sodso_patch.json'].content.patches).toEqual([
            { op: 'add', path: '/roomClasses/-', value: 'REF:RoomClassPreset|PicnicAreaRCP' },
        ]);
        expect(files['PlainWall.sodso_patch.json'].content.fileType).toBe('RoomTypeFilter');

        expect(files['AtriumLight.sodso_patch.json'].content).toEqual({
            name: 'AtriumLight',
            fileType: 'RoomLightingPreset',
            patches: [{ op: 'add', path: '/roomCompatibility/-', value: 'REF:RoomConfiguration|PicnicAreaRC' }],
        });
    });

    test('one surface used twice is patched once', () => {
        const result = planRoom({
            ...picnicArea,
            surfaces: { walls: 'Lino', floor: 'Lino', ceiling: 'PlasterCeiling' },
        }, rooms, chain);

        expect(result.changes.filter((entry) => entry.asset === 'Lino')).toHaveLength(1);
    });
});


describe('the whole set', () => {
    /**
     * Nine files, which is the count the export server's worked example arrives at by
     * hand. The tenth here is the lighting patch, which that write-up does not mention --
     * without it the room builds cleanly and has no ceiling light.
     */
    test('is the worked example plus the light it forgot', () => {
        const { changes } = plan();

        expect(changes.map((entry) => entry.file)).toEqual([
            'PicnicAreaRCP.RoomClassPreset.sodso.json',
            'PicnicAreaRTF.RoomTypeFilter.sodso.json',
            'PicnicArea.RoomTypePreset.sodso.json',
            'PicnicAreaRC.RoomConfiguration.sodso.json',
            'PicnicTable.sodso_patch.json',
            'PicnicBench.sodso_patch.json',
            'PlainWall.sodso_patch.json',
            'WoodenFlooring.sodso_patch.json',
            'PlasterCeiling.sodso_patch.json',
            'AtriumLight.sodso_patch.json',
        ]);
    });

    /** What `commit` lists in the manifest, which names files rather than assets. */
    test('names every file in the manifest, in the same order', () => {
        const stems = plan().changes.map((entry) => stemOf(entry.file));

        expect(stems).toHaveLength(plan().changes.length);

        // A patch is named by the asset it patches and carries no type; one of the mod's
        // own is named by asset and type. The manifest names the file either way.
        expect(stems).toContain('PicnicBench');
        expect(stems).toContain('PicnicAreaRC.RoomConfiguration');
    });

    test('every reference points at something already loaded, or at the base game', () => {
        const { changes } = plan();
        const loaded = new Set();

        for (const entry of changes) {
            const stated = entry.kind === 'own' ? entry.content : { patches: entry.ops };
            const refs = JSON.stringify(stated).match(/REF:[A-Za-z]+\|[A-Za-z0-9_ ]+/g) ?? [];

            for (const ref of refs) {
                const [type, target] = ref.slice(4).split('|');

                // A reference to one of this room's own assets must already be written.
                const own = changes.some((other) => other.asset === target && other.kind === 'own');
                if (own) expect(loaded.has(target), `${entry.file} -> ${ref}`).toBe(true);
                else {
                    // Otherwise it must be a shipped asset of that type.
                    const shipped = { RoomTypePreset: chain.roomTypes, RoomConfiguration: chain.roomConfigs, FurnitureCluster: chain.clusters }[type];
                    if (shipped) expect(target in shipped || type === 'RoomTypePreset', `${entry.file} -> ${ref}`).toBe(true);
                }
            }

            if (entry.kind === 'own') loaded.add(entry.asset);
        }
    });
});


describe('what would leave the room empty', () => {
    test('says so rather than refusing to write', () => {
        const { problems } = planRoom({ name: 'Bare', donor: 'Atrium' }, rooms, chain);

        expect(problems).toEqual([
            'Nothing furnishes this room, so it will be empty.',
            "No walls material, so the room falls back to the engine's default.",
            "No floor material, so the room falls back to the engine's default.",
            "No ceiling material, so the room falls back to the engine's default.",
            'No lighting preset accepts this room, so it gets no ceiling light.',
        ]);
    });

    test('a complete room has nothing to report', () => {
        expect(plan().problems).toEqual([]);
    });

    test('rejects a name that cannot be an asset', () => {
        expect(planRoom({ ...picnicArea, name: '' }, rooms, chain).problems)
            .toContain('The room needs a name.');

        expect(planRoom({ ...picnicArea, name: '2 Rooms!' }, rooms, chain).problems)
            .toContain('"2 Rooms!" is not a usable asset name: letters, digits and underscores, starting with a letter.');
    });
});


describe('one name belonging to two of the patched types', () => {
    /**
     * The case the game's data is full of. The loader matches a patch to its target by the
     * `name` and `fileType` inside the file, so two patches of one name are fine -- but
     * they are two files, and the bare name only fits one of them.
     */
    test('puts the type in both file names, so each has one of its own', () => {
        // SecurityDoorDouble is a FurnitureCluster, a FurniturePreset, and in the closure
        // of itself -- so admitting the cluster is what pulls the preset in beside it.
        const result = planRoom({
            ...picnicArea, context: {}, clusters: ['SecurityDoorDouble'],
        }, rooms, chain);

        const files = byFile(result);

        expect(files['SecurityDoorDouble.FurnitureCluster.sodso_patch.json'].content).toEqual({
            name: 'SecurityDoorDouble',
            fileType: 'FurnitureCluster',
            patches: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|PicnicAreaRTF' }],
        });

        expect(files['SecurityDoorDouble.FurniturePreset.sodso_patch.json'].content.fileType)
            .toBe('FurniturePreset');

        // Nothing under the bare name, and nothing left colliding.
        expect(files['SecurityDoorDouble.sodso_patch.json']).toBeUndefined();
        expect(result.collided).toEqual([]);
    });

    /** The load order names files, so it has to name the ones actually written. */
    test('lists the typed stem in the load order', () => {
        const result = planRoom({
            ...picnicArea, context: {}, clusters: ['SecurityDoorDouble'],
        }, rooms, chain);

        const stems = result.changes.map((entry) => stemOf(entry.file));

        expect(stems).toContain('SecurityDoorDouble.FurnitureCluster');
        expect(stems).toContain('SecurityDoorDouble.FurniturePreset');
        expect(stems).not.toContain('SecurityDoorDouble');
    });

    /**
     * The rule is narrow on purpose: a type on every patch would rename files that have
     * never been ambiguous, leaving the copy already in an author's folder beside the new
     * one, still loaded and still admitting whatever it admits.
     */
    test('leaves an unambiguous name exactly as it was', () => {
        const files = byFile(plan());

        expect(files['PicnicBench.sodso_patch.json']).toBeTruthy();
        expect(files['PicnicBench.FurniturePreset.sodso_patch.json']).toBeUndefined();
        expect(plan().changes.map((entry) => stemOf(entry.file))).toContain('PicnicBench');
    });

    /**
     * How wide it is, pinned. 86 names belong to more than one of the four types a room
     * patches -- `BreakerBox` and `WallClock` to three of them -- and 71 clusters share one
     * with a preset in their own closure, which is the shape that needs no unusual choice
     * to reach: admitting the cluster is enough to want both patches.
     */
    test('is 86 names, not a handful', () => {
        const shared = sharedNames(rooms, chain);

        expect(shared.size).toBe(86);
        expect(shared).toContain('SecurityDoorDouble');
        expect(shared).toContain('BreakerBox');
        expect(shared).toContain('HousePlant');
        expect(shared).not.toContain('PicnicTable');
        expect(shared).not.toContain('PicnicBench');

        const selfFilling = Object.keys(chain.clusters)
            .filter((name) => chain.furniture[name])
            .filter((name) => fullClosure(chain, [name]).includes(name));

        expect(selfFilling).toHaveLength(71);
    });

    /**
     * The invariant the naming exists to keep, against every cluster in the game rather
     * than the handful known to be awkward: no two of a room's files may want one name,
     * because the second written replaces the first and the room loses it silently.
     */
    test('no cluster in the game produces two files of one name', () => {
        for (const name of Object.keys(chain.clusters)) {
            const result = planRoom({ ...picnicArea, context: {}, clusters: [name] }, rooms, chain);
            const files = result.changes.map((entry) => entry.file);

            expect(result.collided, name).toEqual([]);
            expect(new Set(files).size, name).toBe(files.length);
        }
    });
});


describe('landing on a folder that is not empty', () => {
    /**
     * The two kinds are not the same problem. An asset has an identity -- `PicnicAreaRCP`
     * is *this* room's class and a second room cannot have it -- so a file already there
     * is a name clash. A patch is a list of changes to a shipped asset, and two rooms
     * admitting one cluster genuinely both want to change it.
     */
    test('an asset already there is a clash; a patch is something to add to', () => {
        const index = folder(
            { fileType: 'RoomClassPreset', presetName: 'PicnicAreaRCP', name: 'PicnicAreaRCP' },
            {
                fileType: 'FurniturePreset',
                name: 'PicnicBench',
                patches: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|VaultRTF' }],
            },
        );

        const landed = Object.fromEntries(landAll(plan().changes, index)
            .map((item) => [item.file, item.action]));

        expect(landed['PicnicAreaRCP.RoomClassPreset.sodso.json']).toBe('clash');
        expect(landed['PicnicBench.sodso_patch.json']).toBe('append');
        expect(landed['PlainWall.sodso_patch.json']).toBe('create');
    });

    /**
     * The bug this whole split exists for: a cluster the mod declares as a file of its own
     * is not something to patch. Which of the two a patch would land on is a question of
     * load order, and the author is the one who can answer it -- in that file.
     */
    test('a cluster of the mod’s own is left alone rather than patched', () => {
        const index = folder({
            fileType: 'FurnitureCluster',
            presetName: 'PicnicTable',
            name: 'PicnicTable',
            copyFrom: 'REF:FurnitureCluster|PicnicTable',
            allowedRoomFilters: ['REF:RoomTypeFilter|PicnicAreaRTF'],
        });

        const landed = landAll(plan().changes, index)
            .find((item) => item.change.asset === 'PicnicTable');

        expect(landed.action).toBe('leave');
        expect(landed.file).toBe('PicnicTable.FurnitureCluster.sodso.json');
        expect(landed.reason).toContain('yours to make in that file');
    });
});


describe('admitting some of a cluster’s furniture but not all', () => {
    /** DinerBooth needs three classes filled, which makes it the awkward one. */
    const booth = {
        name: 'Diner', donor: 'Atrium', context: {},
        clusters: ['4_LoungeSetSmall_A'],
        surfaces: { walls: 'PlainWall', floor: 'WoodenFlooring', ceiling: 'PlasterCeiling' },
        lighting: ['AtriumLight'],
    };

    const patchedPresets = (result) => result.changes
        .filter((entry) => entry.type === 'FurniturePreset').map((entry) => entry.asset);

    test('patches only what was chosen', () => {
        const all = fullClosure(chain, ['4_LoungeSetSmall_A']);
        expect(all.length).toBeGreaterThan(3);

        const some = all.slice(0, 2);
        const result = planRoom({ ...booth, furniture: some }, rooms, chain);

        expect(patchedPresets(result)).toEqual(some.slice().sort());
    });

    test('patches the whole closure when nothing was said', () => {
        expect(patchedPresets(planRoom(booth, rooms, chain)))
            .toEqual(fullClosure(chain, ['4_LoungeSetSmall_A']));
    });

    /**
     * A preset left over from a cluster since unticked must not reach the room: the set
     * the pane holds is narrowed to what the chosen clusters can actually resolve.
     */
    test('ignores furniture no chosen cluster resolves', () => {
        const result = planRoom({
            ...booth,
            furniture: ['PicnicBench', ...fullClosure(chain, ['4_LoungeSetSmall_A'])],
        }, rooms, chain);

        expect(patchedPresets(result)).not.toContain('PicnicBench');
    });

    /**
     * Unless the room already admits it. A cluster the author copied into their own mod is
     * not in the reference data, nothing here can say what it places, and a closure that has
     * never heard of it is not grounds for withdrawing the furniture it puts down. Saving a
     * room used to do exactly that, silently.
     */
    test('keeps furniture the room already admits that nothing here resolves', () => {
        const result = planRoom({
            ...booth,
            furniture: ['PicnicBench', ...fullClosure(chain, ['4_LoungeSetSmall_A'])],
            admitted: ['PicnicBench'],
        }, rooms, chain);

        expect(patchedPresets(result)).toContain('PicnicBench');
        expect(result.problems.join(' ')).toContain('PicnicBench is already admitted');
    });

    /** An untick is still an untick: the tick is what `furniture` is. */
    test('drops one the author has taken back out, whatever the folder says', () => {
        const result = planRoom({
            ...booth,
            furniture: fullClosure(chain, ['4_LoungeSetSmall_A']),
            admitted: ['PicnicBench'],
        }, rooms, chain);

        expect(patchedPresets(result)).not.toContain('PicnicBench');
    });
});


describe('narrowing that would break a cluster', () => {
    /**
     * The silent failure this exists to make loud: an element the cluster cannot do
     * without, with nothing admitted to fill it, abandons the whole placement.
     */
    test('is reported, with what would fix it', () => {
        const starved = abandoned(chain, ['PicnicTable'], []);

        expect(starved).toEqual([{
            cluster: 'PicnicTable',
            starved: [{ class: '1x1PicnicBench', why: 'unadmitted', options: ['PicnicBench'] }],
        }]);

        const { problems } = planRoom({
            name: 'PicnicArea', donor: 'Atrium', clusters: ['PicnicTable'], furniture: [],
            surfaces: { walls: 'PlainWall', floor: 'WoodenFlooring', ceiling: 'PlasterCeiling' },
            lighting: ['AtriumLight'],
        }, rooms, chain);

        expect(problems).toContain(
            'PicnicTable needs 1x1PicnicBench, and nothing admitted fills it, so the whole '
            + 'cluster would be abandoned. Admit one of PicnicBench.');
    });

    test('is not reported when the needed preset is admitted', () => {
        expect(abandoned(chain, ['PicnicTable'], ['PicnicBench'])).toEqual([]);
    });

    /**
     * The six shipped clusters whose important element no furniture carries. No choice
     * here fixes them, so they are worded differently.
     */
    test('separates a class nothing in the game carries from one merely not admitted', () => {
        const starved = abandoned(chain, ['HiFiSystem'], fullClosure(chain, ['HiFiSystem']));

        expect(starved).toHaveLength(1);
        expect(starved[0].starved[0].why).toBe('impossible');
        expect(starved[0].starved[0].options).toEqual([]);
    });
});


describe('taking a room back out of a patch', () => {
    const refs = roomRefs('PicnicArea');
    const ours = roomOperations('PicnicArea');

    test('knows which operations are this room’s', () => {
        expect(refs).toEqual({
            filter: 'REF:RoomTypeFilter|PicnicAreaRTF',
            roomClass: 'REF:RoomClassPreset|PicnicAreaRCP',
            configuration: 'REF:RoomConfiguration|PicnicAreaRC',
        });

        expect(ours({ op: 'add', path: '/allowedRoomFilters/-', value: refs.filter })).toBe(true);
        expect(ours({ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|VaultRTF' })).toBe(false);
    });

    /**
     * The case that makes this worth doing properly: two rooms admitted the same bench,
     * and one of them changed its mind. Dropping the file would silently un-admit the
     * other room's furniture.
     */
    test('leaves another room’s operations exactly as they were', () => {
        const shared = {
            name: 'PicnicBench',
            fileType: 'FurniturePreset',
            patches: [
                { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|PicnicAreaRTF' },
                { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|PicnicAreaTwoRTF' },
            ],
        };

        const stripped = withdrawOps(shared, ours);

        expect(stripped.removed).toBe(1);
        expect(stripped.empty).toBe(false);
        expect(stripped.content.patches).toEqual([
            { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|PicnicAreaTwoRTF' },
        ]);
    });

    test('says when nothing is left, so the file and its listing can go', () => {
        const mine = {
            name: 'PicnicBench',
            fileType: 'FurniturePreset',
            patches: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|PicnicAreaRTF' }],
        };

        const stripped = withdrawOps(mine, ours);

        expect(stripped.removed).toBe(1);
        expect(stripped.empty).toBe(true);
        expect(stripped.content.patches).toEqual([]);
    });

    test('takes the room out of a surface and a light as well as a cluster', () => {
        const surface = {
            name: 'PlainWall',
            fileType: 'RoomTypeFilter',
            patches: [{ op: 'add', path: '/roomClasses/-', value: refs.roomClass }],
        };
        const light = {
            name: 'AtriumLight',
            fileType: 'RoomLightingPreset',
            patches: [{ op: 'add', path: '/roomCompatibility/-', value: refs.configuration }],
        };

        expect(withdrawOps(surface, ours).empty).toBe(true);
        expect(withdrawOps(light, ours).empty).toBe(true);
    });

    test('leaves a hand-written change alone, and keeps the file', () => {
        const mixed = {
            name: 'PicnicBench',
            fileType: 'FurniturePreset',
            patches: [
                { op: 'add', path: '/allowedRoomFilters/-', value: refs.filter },
                { op: 'replace', path: '/minimumRoomSize', value: 2 },
            ],
        };

        const stripped = withdrawOps(mixed, ours);

        expect(stripped.empty).toBe(false);
        expect(stripped.content.patches).toEqual([{ op: 'replace', path: '/minimumRoomSize', value: 2 }]);
    });
});
