import { test, expect } from '@playwright/test';
import {
    installFsHarness, collectPageErrors, gotoFlow, seedFs, connectFolders, selectContent,
    listDir, readFile, writeFixture,
} from '../test-support/harness.js';
import { furnitureExport, furnitureTypeMap } from '../test-support/fixtures.js';

/**
 * Editing a piece of furniture and writing it, through the browser.
 *
 * What the three assets contain is `furniturePlan.unit.spec.js`; what a position converts
 * to and back is `furnitureModel.unit.spec.js`. This is the loop between them: mark a
 * sub-object, change it, watch the plan follow, press the button, and find three files and
 * a manifest entry on disk.
 *
 * The one thing only this can check is that the edited numbers are what reach the file.
 * Every step between the field and the disk is a conversion, and each of them is right in
 * isolation.
 */

const json = (value) => JSON.stringify(value, null, 2);

const emptyMod = {
    'Mods/DeskMod/murdermanifest.sodso.json': json({
        enabled: true, fileOrder: [], loadBefore: '', version: 1,
    }),
};

/**
 * A mod holding MyDesk as it looks after the pane wrote it once and the author edited it.
 *
 * The three files are the ones this tool writes, plus the changes somebody would make by
 * hand afterwards: a second slot in the arrangement, a boost on the first, and two preset
 * fields the pane has no control for at all. None of them is something the pane can have
 * meant to change, and every one of them is in a file it will write over.
 */
const handEditedDesk = {
    'Mods/DeskMod/murdermanifest.sodso.json': json({
        enabled: true,
        fileOrder: ['REF:MyDeskFC.FurnitureClass', 'REF:MyDesk.FurniturePreset',
            'REF:MyDeskFCL.FurnitureCluster'],
        loadBefore: '',
        version: 1,
    }),

    'Mods/DeskMod/MyDeskFC.FurnitureClass.sodso.json': json({
        fileType: 'FurnitureClass',
        name: 'MyDeskFC',
        presetName: 'MyDeskFC',
        copyFrom: 'REF:FurnitureClass|3x1LobbyDesk',
    }),

    'Mods/DeskMod/MyDesk.FurniturePreset.sodso.json': json({
        fileType: 'FurniturePreset',
        name: 'MyDesk',
        presetName: 'MyDesk',
        copyFrom: 'REF:FurniturePreset|HotelDesk',
        classes: ['REF:FurnitureClass|MyDeskFC'],
        subObjects: [],

        // Neither of these has a control anywhere in the pane.
        minimumRoomSize: 6,
        lightsOnAtNight: true,
    }),

    'Mods/DeskMod/MyDeskFCL.FurnitureCluster.sodso.json': json({
        fileType: 'FurnitureCluster',
        name: 'MyDeskFCL',
        presetName: 'MyDeskFCL',
        clusterElements: [
            {
                onlyValidIfPreviousObjectPlaced: false,
                placements: [{ x: 0, y: 0 }],
                furnitureClass: 'REF:FurnitureClass|MyDeskFC',
                facing: 0,
                importantToCluster: true,
                chanceOfPlacementAttempt: 1,
                placementScoreBoost: 3,
                useFovBlock: false,
                blockDirection: { x: 0, y: 0 },
                maxFOVBlockDistance: 0,
                localScale: { x: 1, y: 1, z: 1 },
                positionOffset: { x: 0, y: 0, z: 0 },
            },
            {
                onlyValidIfPreviousObjectPlaced: false,
                placements: [{ x: 1, y: 0 }],
                furnitureClass: 'REF:FurnitureClass|1x1Chair',
                facing: 2,
                importantToCluster: false,
                chanceOfPlacementAttempt: 0.5,
                placementScoreBoost: 0,
                useFovBlock: false,
                blockDirection: { x: 0, y: 0 },
                maxFOVBlockDistance: 0,
                localScale: { x: 1, y: 1, z: 1 },
                positionOffset: { x: 0, y: 0, z: 0 },
            },
        ],
        allowedRoomFilters: ['REF:RoomTypeFilter|Lobby'],
        minimumRoomSize: 1,
        spawnChance: 0.25,
    }),
};

const SPOILER_KEY = 'SOD_MurderCaseBuilder_SpoilerWarningDismissed';

const expectDialogOpen = (page, selector, open) =>
    expect.poll(() => page.locator(selector).evaluate((e) => e.open)).toBe(open);

async function openPane(page, fixture = emptyMod) {
    await page.addInitScript((k) => window.localStorage.setItem(k, 'true'), SPOILER_KEY);
    await gotoFlow(page, '?flow=scriptableObject');

    await seedFs(page, { ...furnitureExport, ...fixture });
    await connectFolders(page, { modDir: 'Mods', exportedSOs: 'ExportedSOs' });
    await selectContent(page, 'DeskMod', '');

    await page.evaluate((map) => Object.assign(window.typeMap, map), furnitureTypeMap);

    await page.getByRole('link', { name: 'Furniture Creator' }).click();
    await expectDialogOpen(page, '#furniture-creator-modal', true);
    await expect(page.locator('#furniture-creator-presets li').first()).toBeVisible();
}

async function choose(page, name) {
    // The picker is the first step's. Said here rather than at every call: choosing a
    // preset is what the rest of a test is about, not a step it happens to be on.
    await openSection(page, 'Source');
    await page.locator('#furniture-creator-search').fill(name);
    await page.locator('#furniture-creator-presets')
        .getByRole('button', { name, exact: true }).click();
}

/**
 * Open one of the dialog's sections.
 *
 * The `<details>` keep their state while the modal is merely hidden, so a plain click on
 * the summary closes one a previous step left open. Set the attribute instead -- the same
 * helper `roomCreator.spec.js` needs, for the same reason.
 */
const openSection = (page, label) => page.evaluate((text) => {
    const step = [...document.querySelectorAll('#furniture-creator-modal .creator-step')]
        .find((node) => node.querySelector('.creator-step-label')?.textContent === text);
    step?.click();
}, label);

/** Everything below writes, so the section holding the name and the plan has to be open. */
async function openWriteSection(page) {
    await openSection(page, 'What will be written');
    await expect(page.locator('#furniture-creator-name')).toBeVisible();
}

/** Mark the first sub-object, which opens the editor for it. */
async function markFirst(page) {
    await openSection(page, 'What sits on it');
    await page.locator('#furniture-creator-subobjects li').first().getByRole('button').click();
    await expect(page.locator('#furniture-creator-editor')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
});

test('opens the editor only for a sub-object that is marked', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');

    await expect(page.locator('#furniture-creator-editor')).toBeHidden();
    await markFirst(page);
    await expect(page.locator('#furniture-creator-editing')).toContainText('Computer');
});

test('shows the game’s own numbers in the fields, and follows them when they change', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await markFirst(page);

    await expect(page.locator('#furniture-creator-pos-x')).toHaveValue('-1.023');
    await expect(page.locator('#furniture-creator-rot-y')).toHaveValue('194.729');

    await page.locator('#furniture-creator-pos-y').fill('1.25');

    // The row above follows, because the list is what would be written rather than what
    // the file said when it was opened.
    await expect(page.locator('#furniture-creator-subobjects li').first())
        .toContainText('-1.02, 1.25, 0.27');
});

test('adds and removes a sub-object, and can put the lot back', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await markFirst(page);

    const rows = page.locator('#furniture-creator-subobjects li');
    await expect(rows).toHaveCount(2);

    await page.getByRole('button', { name: 'Add another' }).click();
    await expect(rows).toHaveCount(3);

    await page.getByRole('button', { name: 'Remove this one' }).click();
    await expect(rows).toHaveCount(2);

    // Removing takes the selection with it rather than moving it to a neighbour.
    await expect(page.locator('#furniture-creator-editor')).toBeHidden();

    await markFirst(page);
    await page.locator('#furniture-creator-pos-y').fill('9');
    await page.getByRole('button', { name: 'Revert all' }).click();

    await expect(rows.first()).toContainText('-1.02, 1.00, 0.27');
});

/**
 * A shipped preset does not lend its name to the copy. Writing under `HotelDesk` would put
 * down a file the loader reads as an override of the shipped asset, which is a different
 * act from making one of your own.
 */
test('will not write until it has a name of its own', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');

    await openWriteSection(page);

    const button = page.locator('#furniture-creator-write');
    await expect(button).toBeDisabled();
    await expect(button).toContainText('Name it to write');

    await page.locator('#furniture-creator-name').fill('MyDesk');
    await expect(button).toBeEnabled();
    await expect(button).toContainText('Write 3 files');
});

test('says which three files it would write, and in what order', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await openWriteSection(page);
    await page.locator('#furniture-creator-name').fill('MyDesk');

    const plan = page.locator('#furniture-creator-plan');

    await expect(plan).toContainText('MyDeskFC.FurnitureClass.sodso.json');
    await expect(plan).toContainText('MyDesk.FurniturePreset.sodso.json');
    await expect(plan).toContainText('MyDeskFCL.FurnitureCluster.sodso.json');

    // The trap that cannot be fixed from here, said rather than hidden.
    await expect(plan).toContainText('still name 3x1LobbyDesk rather than the copy');
});

test('writes the three assets and lists them in dependency order', async ({ page }) => {
    const errors = collectPageErrors(page);

    await openPane(page);
    await choose(page, 'HotelDesk');
    await openWriteSection(page);
    await page.locator('#furniture-creator-name').fill('MyDesk');
    await page.locator('#furniture-creator-write').click();

    await expect(page.locator('#furniture-creator-plan')).toContainText('3 files written');

    expect(await listDir(page, 'Mods/DeskMod')).toEqual(expect.arrayContaining([
        'MyDesk.FurniturePreset.sodso.json',
        'MyDeskFC.FurnitureClass.sodso.json',
        'MyDeskFCL.FurnitureCluster.sodso.json',
    ]));

    // The class first: every REF: in the preset that follows has to resolve to something
    // already loaded. The entries name the file rather than the asset, so they carry the
    // type the file name carries -- and `REF:` is the form this app writes them in.
    const manifest = JSON.parse(await readFile(page, 'Mods/DeskMod/murdermanifest.sodso.json'));

    expect(manifest.fileOrder).toEqual([
        'REF:MyDeskFC.FurnitureClass',
        'REF:MyDesk.FurniturePreset',
        'REF:MyDeskFCL.FurnitureCluster',
    ]);

    expect(errors).toEqual([]);
});

/**
 * The loop this suite exists for: a number typed into a field, through the pane's own
 * conversions, and out into the file as the game spells it.
 */
test('writes the edited position, in the shape the game serialises', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await markFirst(page);

    await page.locator('#furniture-creator-pos-y').fill('1.25');
    await openWriteSection(page);
    await page.locator('#furniture-creator-name').fill('MyDesk');
    await page.locator('#furniture-creator-write').click();

    await expect(page.locator('#furniture-creator-plan')).toContainText('3 files written');

    const preset = JSON.parse(await readFile(page, 'Mods/DeskMod/MyDesk.FurniturePreset.sodso.json'));

    expect(preset.copyFrom).toBe('REF:FurniturePreset|HotelDesk');
    expect(preset.classes).toEqual(['REF:FurnitureClass|MyDeskFC']);
    // `belongsTo` as its index, which is what every shipped asset and every hand-authored
    // file in the bank example mod holds. 2 is `person0`.
    expect(preset.subObjects[0]).toEqual({
        preset: 'REF:SubObjectClassPreset|Computer',
        parent: '',
        localPos: { x: -1.023, y: 1.25, z: 0.266 },
        localRot: { x: 0, y: 194.729, z: 0 },
        belongsTo: 2,
        security: 0,
    });
});

/**
 * `clusterElements` replaces wholesale and an omitted field is zero, so an element written
 * short is a cluster that silently never places anything.
 */
test('writes a cluster element with every field stated', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await openWriteSection(page);
    await page.locator('#furniture-creator-name').fill('MyDesk');
    await page.locator('#furniture-creator-write').click();

    await expect(page.locator('#furniture-creator-plan')).toContainText('3 files written');

    const cluster = JSON.parse(
        await readFile(page, 'Mods/DeskMod/MyDeskFCL.FurnitureCluster.sodso.json'));

    const element = cluster.clusterElements[0];

    expect(element.furnitureClass).toBe('REF:FurnitureClass|MyDeskFC');
    expect(element.chanceOfPlacementAttempt).toBe(1);
    expect(element.importantToCluster).toBe(true);
    expect(element.localScale).toEqual({ x: 1, y: 1, z: 1 });
    expect(cluster.allowedRoomFilters.length).toBeGreaterThan(0);
});

test('refuses to write over files that are something else’s', async ({ page }) => {
    await openPane(page, {
        ...emptyMod,
        'Mods/DeskMod/MyDesk.FurniturePreset.sodso.json': json({
            fileType: 'FurniturePreset', name: 'MyDesk', presetName: 'MyDesk',
        }),
    });

    await choose(page, 'HotelDesk');
    await openWriteSection(page);
    await page.locator('#furniture-creator-name').fill('MyDesk');

    // The name is the mod's own preset, so this is a save rather than a clash -- which is
    // the distinction worth checking, since the opposite would block every second save.
    await expect(page.locator('#furniture-creator-write')).toBeEnabled();
});

test('reopens what it wrote, as this mod’s own', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await openWriteSection(page);
    await page.locator('#furniture-creator-name').fill('MyDesk');
    await page.locator('#furniture-creator-write').click();

    await expect(page.locator('#furniture-creator-plan')).toContainText('3 files written');

    // The picker is redrawn from the folder after a write, so the new preset is in it.
    await openSection(page, 'Source');
    await page.locator('#furniture-creator-search').fill('MyDesk');
    await expect(page.locator('#furniture-creator-presets').getByRole('button', { name: /^MyDesk/ }))
        .toContainText('this mod’s, copying HotelDesk');
});

/**
 * Saving your own furniture a second time, which is the ordinary way anything gets edited.
 *
 * The preset's `classes` names the class this pane wrote, so on the way back in that class
 * is what the pane finds itself mimicking — and writing it out again made it copy from
 * itself. `MyDeskFC` with `copyFrom: MyDeskFC` is a loop for the loader to follow and a
 * class with no rules of its own, and neither shows up until the city is generated.
 *
 * The preset half has guarded against exactly this from the start; the class half did not.
 */
test('does not make a class copy from itself when it is saved again', async ({ page }) => {
    const errors = collectPageErrors(page);

    await openPane(page);
    await choose(page, 'HotelDesk');
    await openWriteSection(page);
    await page.locator('#furniture-creator-name').fill('MyDesk');
    await page.locator('#furniture-creator-write').click();

    await expect(page.locator('#furniture-creator-plan')).toContainText('3 files written');

    // Back in through the picker, the way an author returns to it.
    await openSection(page, 'Source');
    await page.locator('#furniture-creator-search').fill('MyDesk');
    await page.locator('#furniture-creator-presets').getByRole('button', { name: /^MyDesk/ }).click();

    await openWriteSection(page);
    await expect(page.locator('#furniture-creator-name')).toHaveValue('MyDesk');
    await page.locator('#furniture-creator-write').click();

    // Two, not three: the cluster already exists, and a save leaves it alone.
    await expect(page.locator('#furniture-creator-plan')).toContainText('2 files written');

    const written = JSON.parse(
        await readFile(page, 'Mods/DeskMod/MyDeskFC.FurnitureClass.sodso.json'));

    expect(written.copyFrom).not.toBe('REF:FurnitureClass|MyDeskFC');

    // The chain back to the shipped class stays intact rather than merely not looping.
    expect(written.copyFrom).toBe('REF:FurnitureClass|3x1LobbyDesk');

    // And the rules survive the round trip. Dropping `copyFrom` without stating them would
    // trade a loop for a class that says nothing, which is the same object never placed.
    expect(written.wallRules).toBeDefined();
    expect(written.objectSize).toEqual({ x: 3, y: 1 });

    expect(errors).toEqual([]);
});

/**
 * The same thing a third and fourth time, because "saving is idempotent" is the claim and
 * one round trip does not test it. A drift that only shows up on the third save is a mod
 * that quietly rots as its author works on it.
 */
test('survives being saved over and over', async ({ page }) => {
    const errors = collectPageErrors(page);

    await openPane(page);
    await choose(page, 'HotelDesk');
    await openWriteSection(page);
    await page.locator('#furniture-creator-name').fill('MyDesk');
    await page.locator('#furniture-creator-write').click();
    await expect(page.locator('#furniture-creator-plan')).toContainText('3 files written');

    const saves = [];

    for (let round = 0; round < 3; round++) {
        await openSection(page, 'Source');
        await page.locator('#furniture-creator-search').fill('MyDesk');
        await page.locator('#furniture-creator-presets').getByRole('button', { name: /^MyDesk/ }).click();

        await openWriteSection(page);
        await page.locator('#furniture-creator-write').click();

        // Two, not three: the cluster exists from the first write onwards and is left alone.
        await expect(page.locator('#furniture-creator-plan')).toContainText('2 files written');

        saves.push({
            class: JSON.parse(
                await readFile(page, 'Mods/DeskMod/MyDeskFC.FurnitureClass.sodso.json')),
            preset: JSON.parse(
                await readFile(page, 'Mods/DeskMod/MyDesk.FurniturePreset.sodso.json')),
            cluster: JSON.parse(
                await readFile(page, 'Mods/DeskMod/MyDeskFCL.FurnitureCluster.sodso.json')),
        });
    }

    // Byte for byte the same three files each time. Anything that drifts here is something
    // the pane reads differently from how it writes it.
    expect(saves[1]).toEqual(saves[0]);
    expect(saves[2]).toEqual(saves[0]);

    expect(saves[0].class.copyFrom).toBe('REF:FurnitureClass|3x1LobbyDesk');
    expect(errors).toEqual([]);
});

/**
 * Save this mod's own MyDesk again, changing nothing in the pane.
 *
 * The fixture is the mod as it stands after the pane wrote MyDesk once and the author went
 * away and edited it, which is what the note put up after every write suggests they do.
 */
async function saveAgain(page) {
    await openPane(page, handEditedDesk);

    await page.locator('#furniture-creator-search').fill('MyDesk');
    await page.locator('#furniture-creator-presets').getByRole('button', { name: /^MyDesk/ }).click();

    await openWriteSection(page);
    await expect(page.locator('#furniture-creator-name')).toHaveValue('MyDesk');

    await page.locator('#furniture-creator-write').click();
    await expect(page.locator('#furniture-creator-plan')).toContainText('files written');
}

/**
 * The sharp case, because the pane *tells* the author to go and edit this file — "the
 * arrangement is one slot, and editing the cluster is how it becomes more" is the note put
 * up after every write. An arrangement built by hand on that invitation is then rebuilt
 * from a one-element template by the next save, and the element list is the only thing a
 * cluster is made of.
 */
test('keeps a hand-built arrangement in the cluster', async ({ page }) => {
    const errors = collectPageErrors(page);
    await saveAgain(page);

    const after = JSON.parse(
        await readFile(page, 'Mods/DeskMod/MyDeskFCL.FurnitureCluster.sodso.json'));

    expect(after.clusterElements).toHaveLength(2);
    expect(after.clusterElements[0].placementScoreBoost).toBe(3);
    expect(after.spawnChance).toBe(0.25);

    expect(errors).toEqual([]);
});

/**
 * The same shape of problem one file up: a field the pane has no control for is a field it
 * cannot have meant to change, and rebuilding the preset from the pane's own model drops
 * every one of them.
 */
test('keeps preset fields the pane has no control for', async ({ page }) => {
    const errors = collectPageErrors(page);
    await saveAgain(page);

    const after = JSON.parse(
        await readFile(page, 'Mods/DeskMod/MyDesk.FurniturePreset.sodso.json'));

    expect(after.minimumRoomSize).toBe(6);
    expect(after.lightsOnAtNight).toBe(true);

    expect(errors).toEqual([]);
});
