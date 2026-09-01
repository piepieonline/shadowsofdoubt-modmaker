/**
 * The file set a room comes to, against the game's own reference data.
 *
 * Everything here is decided before a folder is touched, which is the point of the split:
 * what the author is about to write is checkable without writing it.
 *
 * The worked example is the export server's own -- an indoor picnic area admitting one
 * bench -- because it is awkward in the two ways that matter. `PicnicTable` conflicts on a
 * gate, so it exercises the clone path, and its closure is a single preset that must be
 * patched separately or the cluster resolves to nothing.
 */
import { describe, test, expect } from 'vitest';

import {
    planRoom, decideCluster, assetNames, collisions, mergePatch, against, fullClosure, abandoned,
    roomRefs, withoutRoom, sharedNames,
} from './roomPlan.js';

import rooms from '../../../refs/derived/roomCreator.json' with { type: 'json' };
import chain from '../../../refs/derived/furnitureChain.json' with { type: 'json' };

/** The worked example: a picnic area three storeys up, which is what forces the clone. */
const picnicArea = {
    name: 'PicnicArea',
    donor: 'Atrium',
    donorRoomType: 'Atrium',
    context: { floor: 3 },
    clusters: ['PicnicTable'],
    surfaces: { walls: 'PlainWall', floor: 'WoodenFlooring', ceiling: 'PlasterCeiling' },
    lighting: ['AtriumLight'],
};

const plan = () => planRoom(picnicArea, rooms, chain);
const byFile = (result) => Object.fromEntries(result.files.map((entry) => [entry.file, entry]));


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
        const { order } = plan();

        expect(order.slice(0, 4)).toEqual([
            'PicnicAreaRCP.RoomClassPreset',
            'PicnicAreaRTF.RoomTypeFilter',
            'PicnicArea.RoomTypePreset',
            'PicnicAreaRC.RoomConfiguration',
        ]);
    });

    test('the room class is empty, which is what makes the room admit nothing', () => {
        const file = byFile(plan())['PicnicAreaRCP.RoomClassPreset.sodso.json'];

        expect(file.content).toEqual({
            presetName: 'PicnicAreaRCP',
            fileType: 'RoomClassPreset',
            name: 'PicnicAreaRCP',
            type: 'RoomClassPreset',
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


describe('patch or clone', () => {
    test('a cluster whose gates all pass is patched where it stands', () => {
        // On the ground floor PicnicTable's floor range -1..0 admits the room.
        expect(decideCluster(rooms, 'PicnicTable', { floor: 0 })).toEqual({
            name: 'PicnicTable', action: 'patch', relax: {},
        });
    });

    test('a cluster refused by a gate is cloned, relaxing only that gate', () => {
        const decision = decideCluster(rooms, 'PicnicTable', { floor: 3 });

        expect(decision.action).toBe('clone');
        expect(decision.relax).toEqual({ limitToFloor: false, limitToFloorRange: false });

        // Nothing else is touched: relaxing every gate would admit it to rooms its author
        // never meant it for.
        expect(decision.relax.minimumWealth).toBeUndefined();
        expect(decision.relax.allowedInOpenPlan).toBeUndefined();
    });

    test('the clone is the room’s own, and admits only the room’s filter', () => {
        const file = byFile(plan())['PicnicArea_PicnicTable.FurnitureCluster.sodso.json'];

        expect(file.content.copyFrom).toBe('REF:FurnitureCluster|PicnicTable');
        expect(file.content.allowedRoomFilters).toEqual(['REF:RoomTypeFilter|PicnicAreaRTF']);
        expect(file.content.limitToFloorRange).toBe(false);
    });

    /**
     * Not restated, because the reference data holds a trimmed element -- its class and
     * whether it matters, not its placement, facing or offsets. Writing one from that
     * would be inventing the cluster's contents. An unstated list is the donor's.
     */
    test('the clone does not restate cluster elements it cannot know', () => {
        const file = byFile(plan())['PicnicArea_PicnicTable.FurnitureCluster.sodso.json'];
        expect(file.content.clusterElements).toBeUndefined();
    });

    test('a patched cluster only ever adds, so vanilla rooms are untouched', () => {
        const ground = planRoom({ ...picnicArea, context: { floor: 0 } }, rooms, chain);
        const file = byFile(ground)['PicnicTable.sodso_patch.json'];

        expect(file.content).toEqual({
            name: 'PicnicTable',
            fileType: 'FurnitureCluster',
            patches: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|PicnicAreaRTF' }],
        });
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

        const patched = result.files.filter((entry) => entry.type === 'FurniturePreset').map((entry) => entry.asset);
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

        expect(result.files.filter((entry) => entry.asset === 'Lino')).toHaveLength(1);
    });
});


describe('the whole set', () => {
    /**
     * Nine files, which is the count the export server's worked example arrives at by
     * hand. The tenth here is the lighting patch, which that write-up does not mention --
     * without it the room builds cleanly and has no ceiling light.
     */
    test('is the worked example plus the light it forgot', () => {
        const { files } = plan();

        expect(files.map((entry) => entry.file)).toEqual([
            'PicnicAreaRCP.RoomClassPreset.sodso.json',
            'PicnicAreaRTF.RoomTypeFilter.sodso.json',
            'PicnicArea.RoomTypePreset.sodso.json',
            'PicnicAreaRC.RoomConfiguration.sodso.json',
            'PicnicArea_PicnicTable.FurnitureCluster.sodso.json',
            'PicnicBench.sodso_patch.json',
            'PlainWall.sodso_patch.json',
            'WoodenFlooring.sodso_patch.json',
            'PlasterCeiling.sodso_patch.json',
            'AtriumLight.sodso_patch.json',
        ]);
    });

    test('names every file in the manifest, in the same order', () => {
        const { files, order } = plan();
        expect(order).toHaveLength(files.length);

        // A patch is named by the asset it patches and carries no type; one of the mod's
        // own is named by asset and type. The manifest names the file either way.
        expect(order).toContain('PicnicBench');
        expect(order).toContain('PicnicArea_PicnicTable.FurnitureCluster');
    });

    test('every reference points at something already loaded, or at the base game', () => {
        const { files } = plan();
        const loaded = new Set();

        for (const entry of files) {
            const refs = JSON.stringify(entry.content).match(/REF:[A-Za-z]+\|[A-Za-z0-9_ ]+/g) ?? [];

            for (const ref of refs) {
                const [type, target] = ref.slice(4).split('|');

                // A reference to one of this room's own assets must already be written.
                const own = files.some((other) => other.asset === target && other.kind === 'asset');
                if (own) expect(loaded.has(target), `${entry.file} -> ${ref}`).toBe(true);
                else {
                    // Otherwise it must be a shipped asset of that type.
                    const shipped = { RoomTypePreset: chain.roomTypes, RoomConfiguration: chain.roomConfigs, FurnitureCluster: chain.clusters }[type];
                    if (shipped) expect(target in shipped || type === 'RoomTypePreset', `${entry.file} -> ${ref}`).toBe(true);
                }
            }

            if (entry.kind === 'asset') loaded.add(entry.asset);
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

        expect(result.order).toContain('SecurityDoorDouble.FurnitureCluster');
        expect(result.order).toContain('SecurityDoorDouble.FurniturePreset');
        expect(result.order).not.toContain('SecurityDoorDouble');
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
        expect(plan().order).toContain('PicnicBench');
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
            const files = result.files.map((entry) => entry.file);

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
        const { files } = plan();
        const existing = new Set([
            'PicnicAreaRCP.RoomClassPreset.sodso.json',
            'PicnicBench.sodso_patch.json',
        ]);

        const landed = Object.fromEntries(against(files, existing).map((entry) => [entry.file, entry.landing]));

        expect(landed['PicnicAreaRCP.RoomClassPreset.sodso.json']).toBe('clash');
        expect(landed['PicnicBench.sodso_patch.json']).toBe('append');
        expect(landed['PlainWall.sodso_patch.json']).toBe('write');
    });

    test('only the assets block the write', () => {
        const { files } = plan();

        expect(collisions(files, ['PicnicBench.sodso_patch.json'])).toEqual([]);
        expect(collisions(files, ['PicnicAreaRCP.RoomClassPreset.sodso.json']))
            .toEqual(['PicnicAreaRCP.RoomClassPreset.sodso.json']);
    });
});


describe('adding this room to a patch another room wrote', () => {
    const theirs = {
        name: 'PicnicBench',
        fileType: 'FurniturePreset',
        patches: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|VaultRTF' }],
    };

    const ours = {
        name: 'PicnicBench',
        fileType: 'FurniturePreset',
        patches: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|PicnicAreaRTF' }],
    };

    test('keeps theirs and appends ours', () => {
        const merged = mergePatch(theirs, ours);

        expect(merged.added).toBe(1);
        expect(merged.content.patches).toEqual([
            { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|VaultRTF' },
            { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|PicnicAreaRTF' },
        ]);
    });

    test('carries every other key of theirs through untouched', () => {
        const merged = mergePatch({ ...theirs, note: 'do not lose me' }, ours);
        expect(merged.content.note).toBe('do not lose me');
    });

    test('writing the same room twice changes nothing', () => {
        const once = mergePatch(theirs, ours);
        const twice = mergePatch(once.content, ours);

        expect(twice.added).toBe(0);
        expect(twice.content.patches).toEqual(once.content.patches);
    });

    /**
     * The older format states fields rather than operations. Appending one would leave a
     * file that is half each, and converting needs the base asset, which is not always
     * readable. Refused with a sentence rather than merged badly.
     */
    test('refuses a patch written in the format this app replaced', () => {
        const older = { name: 'PicnicBench', fileType: 'FurniturePreset', allowedRoomFilters: [] };

        expect(mergePatch(older, ours).reason).toContain('older whole-field format');
        expect(mergePatch(older, ours).content).toBeUndefined();
    });

    test('refuses a patch of a different type under the same name', () => {
        const other = { name: 'PicnicBench', fileType: 'FurnitureCluster', patches: [] };

        expect(mergePatch(other, ours).reason)
            .toBe('PicnicBench patches a FurnitureCluster and this room needs it to patch a FurniturePreset');
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

    test('patches only what was chosen', () => {
        const all = fullClosure(chain, ['4_LoungeSetSmall_A']);
        expect(all.length).toBeGreaterThan(3);

        const some = all.slice(0, 2);
        const result = planRoom({ ...booth, furniture: some }, rooms, chain);
        const patched = result.files.filter((f) => f.type === 'FurniturePreset').map((f) => f.asset);

        expect(patched).toEqual(some.slice().sort());
    });

    test('patches the whole closure when nothing was said', () => {
        const result = planRoom(booth, rooms, chain);
        const patched = result.files.filter((f) => f.type === 'FurniturePreset').map((f) => f.asset);

        expect(patched).toEqual(fullClosure(chain, ['4_LoungeSetSmall_A']));
    });

    /**
     * A preset left over from a cluster since unticked must not reach the room: the set
     * the pane holds is intersected with what the chosen clusters can actually resolve.
     */
    test('ignores furniture no chosen cluster resolves', () => {
        const result = planRoom({ ...booth, furniture: ['PicnicBench', ...fullClosure(chain, ['4_LoungeSetSmall_A'])] }, rooms, chain);
        const patched = result.files.filter((f) => f.type === 'FurniturePreset').map((f) => f.asset);

        expect(patched).not.toContain('PicnicBench');
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

    test('knows which operations are this room’s', () => {
        expect(refs).toEqual({
            filter: 'REF:RoomTypeFilter|PicnicAreaRTF',
            roomClass: 'REF:RoomClassPreset|PicnicAreaRCP',
            configuration: 'REF:RoomConfiguration|PicnicAreaRC',
        });
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

        const stripped = withoutRoom(shared, refs);

        expect(stripped.removed).toBe(1);
        expect(stripped.empty).toBe(false);
        expect(stripped.content.patches).toEqual([
            { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|PicnicAreaTwoRTF' },
        ]);
    });

    test('says when nothing is left, so the file and its listing can go', () => {
        const ours = {
            name: 'PicnicBench',
            fileType: 'FurniturePreset',
            patches: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|PicnicAreaRTF' }],
        };

        const stripped = withoutRoom(ours, refs);

        expect(stripped.removed).toBe(1);
        expect(stripped.empty).toBe(true);
        expect(stripped.content.patches).toEqual([]);
    });

    test('takes the room out of a surface and a light as well as a cluster', () => {
        const surface = { name: 'PlainWall', fileType: 'RoomTypeFilter',
            patches: [{ op: 'add', path: '/roomClasses/-', value: refs.roomClass }] };
        const light = { name: 'AtriumLight', fileType: 'RoomLightingPreset',
            patches: [{ op: 'add', path: '/roomCompatibility/-', value: refs.configuration }] };

        expect(withoutRoom(surface, refs).empty).toBe(true);
        expect(withoutRoom(light, refs).empty).toBe(true);
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

        const stripped = withoutRoom(mixed, refs);

        expect(stripped.empty).toBe(false);
        expect(stripped.content.patches).toEqual([{ op: 'replace', path: '/minimumRoomSize', value: 2 }]);
    });

    /** Saving a room over itself is not a clash -- its own assets are what is being saved. */
    test('a room’s own assets stop being collisions while it is the one being saved', () => {
        const { files } = plan();
        const existing = files.filter((f) => f.kind === 'asset').map((f) => f.file);

        expect(collisions(files, existing)).toEqual(existing);
        expect(collisions(files, existing, new Set(existing))).toEqual([]);
    });
});
