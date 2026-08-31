/**
 * The mod's own assets, laid over the base game's.
 *
 * The merge is what makes every answer downstream true of the mod being edited rather
 * than only of the base game, so what these cover is the three ways an asset gets its
 * values -- cloned, patched, or from the type's defaults -- and the references between
 * them.
 *
 * The base here is the real one the app ships, because the whole point is composing with
 * it: a clone of `LargeBookcase` has to come out carrying `LargeBookcase`'s fields, and
 * that cannot be checked against a fixture standing in for it.
 */
import { describe, test, expect, beforeAll } from 'vitest';

import { loadFurnitureChain, explainFurniture } from './furnitureChain.js';
import { parseFloor } from './floorModel.js';
import { overlayChain, refName, CHAIN_TYPES } from './furnitureOverlay.js';

let base;

beforeAll(async () => { base = await loadFurnitureChain(); });

/** An asset as `readModAssets` reports one, without going near a folder. */
const asset = (type, name, raw, patch = false) => ({ type, name, file: name, patch, raw });


describe('references', () => {
    test('a REF is the name it points at, however it is written', () => {
        expect(refName('REF:FurniturePreset|LargeBookcase')).toBe('LargeBookcase');

        // `fileOrder`'s shape, and a bare name. A mod may write either, and neither is
        // ambiguous once the field it sits in has said what type it is.
        expect(refName('REF:GrandHotel')).toBe('GrandHotel');
        expect(refName('LargeBookcase')).toBe('LargeBookcase');
    });

    test('nothing is nothing', () => {
        for (const value of [null, undefined, '', '   ', 'null', 42, {}]) {
            expect(refName(value), JSON.stringify(value)).toBeNull();
        }
    });
});


describe('merging', () => {
    test('the base is never written to, and the result is always a new object', () => {
        const before = JSON.stringify(base.furniture.LargeBookcase);

        const merged = overlayChain(base, [asset('FurniturePreset', 'MySofa', {
            presetName: 'MySofa', fileType: 'FurniturePreset',
        })]);

        expect(merged).not.toBe(base);
        expect(merged.furniture).not.toBe(base.furniture);
        expect(base.furniture.MySofa).toBeUndefined();
        expect(JSON.stringify(base.furniture.LargeBookcase)).toBe(before);

        // A new object even when the mod adds nothing: the caches downstream are keyed on
        // identity, so handing the same one back would leave them answering from before.
        expect(overlayChain(base, [])).not.toBe(base);
    });

    /**
     * The trap this exists to catch.
     *
     * `FurniturePreset.minimumRoomSize` defaults to 99, so a preset written from scratch
     * without one needs a 99-square room -- larger than any room in the base game -- and
     * will never place. Reading the game's own defaults is what makes the checker say so
     * instead of calling it possible.
     */
    test('a preset written from scratch takes the game defaults, 99 and all', () => {
        const merged = overlayChain(base, [asset('FurniturePreset', 'MySofa', {
            presetName: 'MySofa', fileType: 'FurniturePreset',
        })]);

        expect(merged.furniture.MySofa).toEqual({
            classes: [],
            filters: [],
            min: 99,
            universal: false,
            onlyIn: null,
            bannedIn: null,
            onlyInBuildings: null,
        });
    });

    test('copyFrom starts from the donor, and stated fields replace its', () => {
        // The bookcase office's own preset, near enough: LargeBookcase's model in a class
        // of its own, with the room filters and design style it needs to reach an office.
        const merged = overlayChain(base, [asset('FurniturePreset', 'MyOfficeBookcase', {
            presetName: 'MyOfficeBookcase',
            fileType: 'FurniturePreset',
            copyFrom: 'REF:FurniturePreset|LargeBookcase',
            classes: ['REF:FurnitureClass|My1x1OfficeBookcase'],
            universalDesignStyle: true,
            allowedRoomFilters: ['REF:RoomTypeFilter|OfficeSpace'],
        })]);

        expect(merged.furniture.MyOfficeBookcase).toEqual({
            // Stated, so replaced outright rather than added to.
            classes: ['My1x1OfficeBookcase'],
            filters: ['OfficeSpace'],
            universal: true,

            // Not stated, so the donor's.
            min: base.furniture.LargeBookcase.min,
            onlyIn: null,
            bannedIn: null,
            onlyInBuildings: null,
        });
    });

    test('a patch starts from the shipped asset of the same name', () => {
        const merged = overlayChain(base, [asset('FurniturePreset', 'LargeBookcase', {
            presetName: 'LargeBookcase',
            fileType: 'FurniturePreset',
            allowedRoomFilters: ['REF:RoomTypeFilter|OfficeSpace'],
        }, true)]);

        expect(base.furniture.LargeBookcase.filters)
            .toEqual(['GeneralFurnishing', 'PawnShop', 'LoanShark']);

        expect(merged.furniture.LargeBookcase.filters).toEqual(['OfficeSpace']);

        // Everything it did not state is the shipped asset's.
        expect(merged.furniture.LargeBookcase.classes)
            .toEqual(base.furniture.LargeBookcase.classes);
    });

    /**
     * A mod's own slot class, which has to come out shaped exactly like a shipped one.
     *
     * The resolver gates on these fields without knowing where a record came from, so a
     * mod's class read into a different shape is gated differently -- and only on the
     * author's own content, which is the last place anyone would look. The wall rules and
     * the stairwell fold are the same code either way; these pin that the rest of the
     * shape agrees too.
     */
    describe('a mod\'s furniture class', () => {
        const slot = (raw) => overlayChain(base, [asset('FurnitureClass', 'Mine', {
            presetName: 'Mine', fileType: 'FurnitureClass', ...raw,
        })]).classes.Mine;

        test('a plain class carries only the three fields that are always there', () => {
            expect(slot({})).toEqual({ minWalls: 0, maxWalls: 4, wallPiece: false });
        });

        test('wall rules are read into the same records the shipped file holds', () => {
            expect(slot({
                wallRules: [
                    // mustFeature wallOrUpperVent behind, on the square itself.
                    { wallDirection: 2, option: 0, tag: 7 },
                    // cantFeature entrance in front of the square to the left.
                    { wallDirection: 7, option: 1, tag: 4, nodeOffset: { x: -1, y: 0 } },
                ],
            }).wallRules).toEqual([
                { dir: 'behind', tag: 'wallOrUpperVent', must: true },
                { dir: 'front', tag: 'entrance', must: false, at: [-1, 0] },
            ]);
        });

        test('a canFeature rule is dropped, because it scores rather than gates', () => {
            expect(slot({ wallRules: [{ wallDirection: 2, option: 2, tag: 1 }] }).wallRules)
                .toBeUndefined();
        });

        test('a rule this cannot answer is counted rather than passed', () => {
            // `securityDoorDivider`, which reads the floor's air ducts among other things.
            expect(slot({ wallRules: [{ wallDirection: 2, option: 0, tag: 13 }] }))
                .toEqual({ minWalls: 0, maxWalls: 4, wallPiece: false, unchecked: 1 });
        });

        test('a tag past the end of the enum counts as unreadable, not as tag zero', () => {
            expect(slot({ wallRules: [{ wallDirection: 2, option: 0, tag: 99 }] }).unchecked)
                .toBe(1);
        });

        test('entranceToRoomOfType carries the configuration it names', () => {
            expect(slot({
                wallRules: [{
                    wallDirection: 2, option: 1, tag: 10,
                    roomType: 'REF:RoomConfiguration|Lobby',
                }],
            }).wallRules).toEqual([
                { dir: 'behind', tag: 'entranceToRoomOfType', must: false, room: 'Lobby' },
            ]);
        });

        /**
         * `onlyOnStairwell` is only ever read inside the `else` of `allowedOnStairwell`
         * (`GenerationController.cs:4575-4601`), so a class that sets the second without
         * the first is barred from stairwells and its `only` is dead. The game ships one
         * exactly like this, `1x1WallLampBallroom`.
         */
        test('the stairwell fold follows the branch, not the pair of names', () => {
            expect(slot({}).stairwell).toBeUndefined();
            expect(slot({ allowedOnStairwell: true }).stairwell).toBe('allowed');
            expect(slot({ allowedOnStairwell: true, onlyOnStairwell: true }).stairwell).toBe('only');
            expect(slot({ onlyOnStairwell: true }).stairwell).toBeUndefined();
        });

        test('a 1x1 footprint is not written, and any other is', () => {
            expect(slot({ objectSize: { x: 1, y: 1 } }).size).toBeUndefined();
            expect(slot({ objectSize: { x: 3, y: 2 } }).size).toEqual([3, 2]);
        });

        test('the floor limits are written only when their flag is on', () => {
            expect(slot({ allowedOnFloor: 4 }).floor).toBeUndefined();
            expect(slot({ limitToFloor: true, allowedOnFloor: 4 }).floor).toBe(4);
            expect(slot({ limitToFloorRange: true, allowedOnFloorRange: { x: 1, y: 3 } }).floorRange)
                .toEqual([1, 3]);
        });

        test('a patch restating one half of the stairwell fold keeps the other', () => {
            const merged = overlayChain(base, [asset('FurnitureClass', 'Mine', {
                presetName: 'Mine',
                fileType: 'FurnitureClass',
                copyFrom: 'REF:FurnitureClass|1x1WallLampStairwell',
                onlyOnStairwell: false,
            })]);

            // The donor is `only`; dropping just that half leaves it merely allowed.
            expect(base.classes['1x1WallLampStairwell'].stairwell).toBe('only');
            expect(merged.classes.Mine.stairwell).toBe('allowed');
        });
    });

    /**
     * The two placement fields on a cluster element, which are stored only when they are
     * not the plain default -- see `readElement`. What matters is that the record coming
     * out of a mod's file has the same shape as the one `buildFurnitureChain.js` writes,
     * because `clusterWarnings` reads both through one convention.
     */
    describe('a cluster element\'s placement fields', () => {
        const cluster = (element) => overlayChain(base, [asset('FurnitureCluster', 'Mine', {
            presetName: 'Mine',
            fileType: 'FurnitureCluster',
            clusterElements: [{ furnitureClass: 'REF:FurnitureClass|1x1Desk', ...element }],
        })]).clusters.Mine.elements[0];

        test('a healthy element carries neither field', () => {
            expect(cluster({ chanceOfPlacementAttempt: 1, localScale: { x: 1, y: 1, z: 1 } }))
                .toEqual({ class: '1x1Desk', important: false });
        });

        test('an omitted chance is taken as 1 rather than as 0', () => {
            expect(cluster({})).toEqual({ class: '1x1Desk', important: false });
        });

        test('a stated chance below 1 is kept as the number it is', () => {
            expect(cluster({ chanceOfPlacementAttempt: 0 }).chance).toBe(0);
            expect(cluster({ chanceOfPlacementAttempt: 0.9 }).chance).toBe(0.9);
        });

        test('only the zero vector counts as a zero scale', () => {
            expect(cluster({ localScale: { x: 0, y: 0, z: 0 } }).zeroScale).toBe(true);
            expect(cluster({ localScale: { x: 1, y: 0, z: 1 } }).zeroScale).toBeUndefined();
            expect(cluster({}).zeroScale).toBeUndefined();
        });

        test('stating clusterElements replaces the donor\'s outright', () => {
            const merged = overlayChain(base, [asset('FurnitureCluster', 'Mine', {
                presetName: 'Mine',
                fileType: 'FurnitureCluster',
                copyFrom: 'REF:FurnitureCluster|OfficeCubicleX4',
                clusterElements: [{ furnitureClass: 'REF:FurnitureClass|1x1Desk' }],
            })]);

            expect(base.clusters.OfficeCubicleX4.elements.length).toBeGreaterThan(1);
            expect(merged.clusters.Mine.elements).toHaveLength(1);
        });

        test('not stating them inherits the donor\'s, chances and all', () => {
            const merged = overlayChain(base, [asset('FurnitureCluster', 'Mine', {
                presetName: 'Mine',
                fileType: 'FurnitureCluster',
                copyFrom: 'REF:FurnitureCluster|OfficeCubicleX4',
            })]);

            expect(merged.clusters.Mine.elements)
                .toEqual(base.clusters.OfficeCubicleX4.elements);

            // The donor holds a stated 0.5, so this also pins that the shipped file still
            // carries fractional chances through a clone rather than flattening them.
            expect(merged.clusters.Mine.elements.some((entry) => entry.chance === 0.5)).toBe(true);
        });
    });

    /**
     * The building gate, which is the other way an author confines a preset to their own
     * content. Folded to one nullable list exactly as `onlyIn` is, so that "no
     * restriction" and "restricted to nothing" stay different things.
     */
    describe('the building gate', () => {
        const preset = (raw) => overlayChain(base, [asset('FurniturePreset', 'Mine', {
            presetName: 'Mine', fileType: 'FurniturePreset', ...raw,
        })]).furniture.Mine;

        test('off is null, not an empty list', () => {
            expect(preset({}).onlyInBuildings).toBeNull();
            expect(preset({ OnlyAllowInBuildings: false, allowedInBuildings: ['REF:BuildingPreset|CityBank'] })
                .onlyInBuildings).toBeNull();
        });

        test('on carries the names it points at', () => {
            expect(preset({
                OnlyAllowInBuildings: true,
                allowedInBuildings: ['REF:BuildingPreset|CityBank'],
            }).onlyInBuildings).toEqual(['CityBank']);
        });

        test('on with no list is a restriction to nothing', () => {
            expect(preset({ OnlyAllowInBuildings: true }).onlyInBuildings).toEqual([]);
        });

        test('a patch inherits the shipped preset\'s', () => {
            const shipped = Object.entries(base.furniture)
                .find(([, entry]) => entry.onlyInBuildings !== null);

            expect(shipped, 'the base game should still gate something to a building').toBeDefined();

            const merged = overlayChain(base, [asset('FurniturePreset', shipped[0], {
                minimumRoomSize: 1,
            }, true)]);

            expect(merged.furniture[shipped[0]].onlyInBuildings).toEqual(shipped[1].onlyInBuildings);
        });
    });

    test('copyFrom chains through the mod itself', () => {
        const merged = overlayChain(base, [
            asset('FurnitureClass', 'MyBase', {
                presetName: 'MyBase',
                fileType: 'FurnitureClass',
                copyFrom: 'REF:FurnitureClass|1x1BookcaseLarge',
            }),
            // Copies the one above, which copies a shipped one. Listed after it here and
            // resolved by need rather than by order, so a mod whose file order is wrong
            // still merges correctly.
            asset('FurnitureClass', 'MyDerived', {
                presetName: 'MyDerived',
                fileType: 'FurnitureClass',
                copyFrom: 'REF:FurnitureClass|MyBase',
                maximumZeroNodeWallCount: 4,
            }),
        ]);

        // A clone states nothing, so it is the donor's record entire -- wall rules and all,
        // which is the half of a class most easily lost on the way through a copy.
        const shipped = base.classes['1x1BookcaseLarge'];
        expect(shipped.wallRules).toEqual([
            { dir: 'behind', tag: 'wall', must: true },
            { dir: 'front', tag: 'nothing', must: true },
        ]);
        expect(merged.classes.MyBase).toEqual(shipped);

        // The shipped minimum, through two clones, with only the maximum restated.
        expect(merged.classes.MyDerived).toEqual({ ...shipped, maxWalls: 4 });
    });

    test('a copyFrom ring falls back to the defaults rather than recursing', () => {
        const merged = overlayChain(base, [
            asset('FurnitureClass', 'A', {
                presetName: 'A', fileType: 'FurnitureClass', copyFrom: 'REF:FurnitureClass|B',
            }),
            asset('FurnitureClass', 'B', {
                presetName: 'B', fileType: 'FurnitureClass', copyFrom: 'REF:FurnitureClass|A',
                minimumZeroNodeWallCount: 2,
            }),
        ]);

        // The game's defaults for a class, which is what a file copying nothing reachable
        // ends up with. What matters is that it terminates and says something.
        expect(merged.classes.A.maxWalls).toBe(4);
        expect(merged.classes.B.minWalls).toBe(2);
    });

    /**
     * `onlyIn` and `max` are not fields. They are a flag and a list folded together when
     * the reference data was built, so a file stating either half has to be unfolded
     * against the base and folded again.
     */
    test('a flag and its list are read as the pair they are', () => {
        const only = (raw) => overlayChain(base, [asset('FurniturePreset', 'X', {
            presetName: 'X', fileType: 'FurniturePreset', ...raw,
        })]).furniture.X.onlyIn;

        // Off is no restriction at all, which is not the same as a restriction to
        // nothing -- an empty list is a preset that can never place.
        expect(only({})).toBeNull();
        expect(only({ onlyAllowInFollowing: true })).toEqual([]);
        expect(only({
            onlyAllowInFollowing: true,
            allowedInAddressesOfType: ['REF:AddressPreset|HighriseOffice'],
        })).toEqual(['HighriseOffice']);

        // Stating the list without the flag leaves it off, as the game reads it.
        expect(only({ allowedInAddressesOfType: ['REF:AddressPreset|HighriseOffice'] })).toBeNull();
    });

    test('a cluster maximum is off unless the flag says otherwise', () => {
        const max = (raw) => overlayChain(base, [asset('FurnitureCluster', 'X', {
            presetName: 'X', fileType: 'FurnitureCluster', ...raw,
        })]).clusters.X.max;

        // The game's default for a cluster is a maximum of 99, switched on.
        expect(max({})).toBe(99);
        expect(max({ useMaximumRoomSize: false })).toBeNull();
        expect(max({ maximumRoomSize: 12 })).toBe(12);
    });

    test('a cluster carries the classes of the slots it puts down', () => {
        const merged = overlayChain(base, [asset('FurnitureCluster', 'MyIsland', {
            presetName: 'MyIsland',
            fileType: 'FurnitureCluster',
            allowedRoomFilters: ['REF:RoomTypeFilter|OfficeSpace'],
            minimumRoomSize: 6,
            clusterElements: [
                { furnitureClass: 'REF:FurnitureClass|My1x1OfficeBookcase', importantToCluster: true },
                { furnitureClass: 'REF:FurnitureClass|1x1OfficeCubicle' },
            ],
        })]);

        expect(merged.clusters.MyIsland.elements).toEqual([
            { class: 'My1x1OfficeBookcase', important: true },
            { class: '1x1OfficeCubicle', important: false },
        ]);
    });

    /**
     * A patch replaces a filter's class list wholesale, so the inversion the walk reads
     * has to be recomputed from whole filters. That is why the reference data keeps
     * `filter -> classes` and inverts on load rather than shipping the inversion.
     */
    test('patching a room type filter takes the old classes off it', () => {
        expect(base.filters.OfficeSpace).toEqual(['OfficeSpace', 'EnforcerOffice']);

        const merged = overlayChain(base, [asset('RoomTypeFilter', 'OfficeSpace', {
            presetName: 'OfficeSpace',
            fileType: 'RoomTypeFilter',
            roomClasses: ['REF:RoomClassPreset|Laboratory'],
        }, true)]);

        expect(merged.filters.OfficeSpace).toEqual(['Laboratory']);
        expect(base.filters.OfficeSpace).toEqual(['OfficeSpace', 'EnforcerOffice']);
    });

    test('an address preset and its room configurations come across', () => {
        const merged = overlayChain(base, [
            asset('AddressPreset', 'MyBookcaseOffice', {
                presetName: 'MyBookcaseOffice',
                fileType: 'AddressPreset',
                copyFrom: 'REF:AddressPreset|MediumOffice',
                compatible: ['REF:LayoutConfiguration|OfficeHighrise'],
            }),
            asset('RoomConfiguration', 'MyOfficeConfig', {
                presetName: 'MyOfficeConfig',
                fileType: 'RoomConfiguration',
                roomType: 'REF:RoomTypePreset|OfficeSpace',
                roomClass: 'REF:RoomClassPreset|OfficeSpace',
            }),
        ]);

        expect(merged.addresses.MyBookcaseOffice.compatible).toEqual(['OfficeHighrise']);
        expect(merged.addresses.MyBookcaseOffice.roomConfig)
            .toEqual(base.addresses.MediumOffice.roomConfig);

        expect(merged.roomConfigs.MyOfficeConfig)
            .toEqual({ roomType: 'OfficeSpace', roomClass: 'OfficeSpace' });
    });

    test('what was applied is reported, added and patched apart', () => {
        const merged = overlayChain(base, [
            asset('FurniturePreset', 'MySofa', { presetName: 'MySofa', fileType: 'FurniturePreset' }),
            asset('FurniturePreset', 'LargeBookcase', {
                presetName: 'LargeBookcase', fileType: 'FurniturePreset',
            }, true),
            // Keeps no fields the chain reads, and is still the mod's.
            asset('RoomClassPreset', 'MyRoomClass', {
                presetName: 'MyRoomClass', fileType: 'RoomClassPreset',
            }),
        ]);

        expect(merged.applied).toEqual([
            { name: 'MySofa', type: 'FurniturePreset', patch: false },
            { name: 'LargeBookcase', type: 'FurniturePreset', patch: true },
            { name: 'MyRoomClass', type: 'RoomClassPreset', patch: false },
        ]);
    });

    test('the nine types the chain is made of are the ones read', () => {
        expect(CHAIN_TYPES.sort()).toEqual([
            'AddressPreset', 'FurnitureClass', 'FurnitureCluster', 'FurniturePreset',
            'LayoutConfiguration', 'RoomClassPreset', 'RoomConfiguration',
            'RoomTypeFilter', 'RoomTypePreset',
        ]);
    });

    test('no base, nothing to lay anything over', () => {
        expect(overlayChain(null, [])).toBeNull();
    });
});


describe('what the merge carries across untouched', () => {
    /**
     * Every block the base has, whether or not a mod can add to it.
     *
     * `walls` was left out, and it is the one block no mod contributes to -- which is
     * exactly why nothing noticed. Selecting any mod at all replaced a 27-entry table
     * with nothing, so every wall preset resolved to `{}` and every rule asking for a
     * `wall` or a `ventUpper` behind a piece failed. A mailbox or an ATM against a plain
     * wall was told it wanted one.
     *
     * Asserted over the base's own keys rather than a list, so the next block added to
     * the reference file fails here instead of quietly going missing.
     */
    test('is every block, including the one no mod can add to', () => {
        for (const assets of [[], [asset('FurniturePreset', 'Mine', { presetName: 'Mine' })]]) {
            const merged = overlayChain(base, assets);

            for (const block of Object.keys(base)) {
                expect(Object.keys(merged[block] ?? {}).length, block)
                    .toBeGreaterThanOrEqual(Object.keys(base[block]).length);
            }

            expect(Object.keys(merged.walls)).toHaveLength(27);
            expect(merged.walls['0']).toEqual({ section: 'wall' });
        }
    });

    /**
     * The symptom, end to end. A plain wall behind a mailbox satisfies its one rule, and
     * selecting a mod must not change that.
     */
    test('leaves a wall rule answering the same with a mod selected as without', async () => {
        const model = parseFloor(await (await fetch('/refs/floors/blueprints/Eden_GroundFloor.json')).json());
        const verdicts = (data) => explainFurniture(data, model, 10, 7, 'Mailboxes')
            .groups.map((group) => `${group.address}:${group.verdict}`);

        expect(verdicts(base)).toEqual(['CityHallLobby:possible', 'CorporateLobby:possible']);
        expect(verdicts(overlayChain(base, []))).toEqual(verdicts(base));

        expect(verdicts(overlayChain(base, [
            asset('FurniturePreset', 'Unrelated', { presetName: 'Unrelated' }),
        ]))).toEqual(verdicts(base));
    });
});
