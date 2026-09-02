import { test, expect } from '@playwright/test';
import {
    installFsHarness, collectPageErrors, gotoFlow, seedFs, connectFolders, selectContent,
    readFile,
} from '../test-support/harness.js';
import { furnitureExport, furnitureTypeMap } from '../test-support/fixtures.js';

/**
 * A mod's own furniture: its presets in the picker, and its model in the view.
 *
 * The base game's 310 presets each name a Unity prefab inside an asset bundle, so none of
 * them can ever be drawn for real -- which means every one of these needs a mod folder
 * with a `.sodprefab.json` and an `.obj` in it. That pair is the same one `meshExport.js`
 * writes for a building shell and the same one the bank example mod ships.
 *
 * The parsing is `furniturePrefab.unit.spec.js`. This is the pane finding the files,
 * saying what it drew, and saying which file it could not find when it could not.
 */

const json = (value) => JSON.stringify(value, null, 2);

/** A unit cube, wound the way the game's own exporter writes one. */
const CUBE = [
    'o MyDesk',
    'v -0.5 0 -0.5', 'v 0.5 0 -0.5', 'v 0.5 0 0.5', 'v -0.5 0 0.5',
    'v -0.5 1 -0.5', 'v 0.5 1 -0.5', 'v 0.5 1 0.5', 'v -0.5 1 0.5',
    'f 1 3 2', 'f 1 4 3',
    'f 5 6 7', 'f 5 7 8',
    'f 1 6 5', 'f 1 2 6',
    'f 2 7 6', 'f 2 3 7',
    'f 3 8 7', 'f 3 4 8',
    'f 4 5 8', 'f 4 1 5',
].join('\n');

/**
 * The mesh, and two places a citizen can be put.
 *
 * The controller children are the shape the game's own `BoardRoomTablePrefab` has: a node
 * with a `position` and an `InteractableController` component naming an `InteractableID`.
 * They are what `pairToController` resolves against, and they are the only reason this pane
 * can offer a real list of ids rather than the enum's 32.
 */
const PREFAB = json({
    prefabType: 'furniture',
    name: 'MyDesk',
    children: [
        {
            name: 'MyDesk_Mesh',
            position: [0, 0, 0],
            components: [{ type: 'MeshRenderer', mesh: 'MyDesk.obj', material: { name: 'MyDesk' } }],
        },
        {
            name: 'WorkPosition',
            position: [0, 0.9, -0.5],
            components: [{ type: 'InteractableController', id: 'A' }],
        },
        {
            name: 'Underneath',
            position: [0, 0.4, -0.2],
            components: [{ type: 'InteractableController', id: 'hidingPlace' }],
        },
    ],
});

/** A mod with one furniture preset of its own, its prefab, and its mesh. */
const modWithModel = {
    'Mods/DeskMod/murdermanifest.sodso.json': json({
        enabled: true, fileOrder: ['REF:MyDesk'], loadBefore: '', version: 1,
    }),
    'Mods/DeskMod/MyDesk.FurniturePreset.sodso.json': json({
        fileType: 'FurniturePreset',
        name: 'MyDesk',
        presetName: 'MyDesk',
        copyFrom: 'REF:FurniturePreset|HotelDesk',
        prefab: 'PREFAB:MyDeskPrefab/MyDesk',
    }),
    'Mods/DeskMod/MyDeskPrefab/MyDesk.sodprefab.json': PREFAB,
    'Mods/DeskMod/MyDeskPrefab/MyDesk.obj': CUBE,
};

/** The same mod with the mesh never written, which is what a half-finished one looks like. */
const modMissingMesh = {
    ...modWithModel,
    'Mods/DeskMod/MyDeskPrefab/MyDesk.obj': undefined,
};

/**
 * A slab wider than the 3x1 slot it is in, which is the mistake the overlay exists to catch.
 *
 * Written the way an author exports one: a right-handed `.obj`, not pre-mirrored. A 3x1
 * class's footprint in that space runs from -0.9 to +4.5 on x (`modelSpace.md` §6), so a
 * slab reaching 5.0 is a node past its own class — and nothing in the game will ever say so.
 */
const WIDE_SLAB = [
    'o MyDesk',
    'v -0.9 0 -0.9', 'v 5.0 0 -0.9', 'v 5.0 0 0.9', 'v -0.9 0 0.9',
    'f 1 2 3 4',
].join('\n');

const modWithWideModel = {
    ...modWithModel,
    'Mods/DeskMod/MyDeskPrefab/MyDesk.obj': WIDE_SLAB,
};

const SPOILER_KEY = 'SOD_MurderCaseBuilder_SpoilerWarningDismissed';

const expectDialogOpen = (page, selector, open) =>
    expect.poll(() => page.locator(selector).evaluate((e) => e.open)).toBe(open);

/**
 * Open one of the dialog's sections.
 *
 * The `<details>` keep their state while the modal is merely hidden, so a plain click on
 * the summary closes one a previous step left open. Set the attribute instead.
 */
const openSection = (page, label) => page.evaluate((text) => {
    const step = [...document.querySelectorAll('#furniture-creator-modal .creator-step')]
        .find((node) => node.querySelector('.creator-step-label')?.textContent === text);
    step?.click();
}, label);

async function openWith(page, fixture) {
    await page.addInitScript((k) => window.localStorage.setItem(k, 'true'), SPOILER_KEY);
    await gotoFlow(page, '?flow=scriptableObject');

    await seedFs(page, {
        ...furnitureExport,
        ...Object.fromEntries(Object.entries(fixture).filter(([, value]) => value !== undefined)),
    });

    await connectFolders(page, { modDir: 'Mods', exportedSOs: 'ExportedSOs' });
    await selectContent(page, 'DeskMod', '');

    await page.evaluate((map) => Object.assign(window.typeMap, map), furnitureTypeMap);

    await page.getByRole('link', { name: 'Furniture Creator' }).click();
    await expectDialogOpen(page, '#furniture-creator-modal', true);
    await expect(page.locator('#furniture-creator-presets li').first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
});

/**
 * The mod's own first and marked. They are what an author opened the pane to look at, and
 * burying them alphabetically among 310 shipped presets is burying them.
 */
test('lists the mod’s own presets first, and says where they came from', async ({ page }) => {
    await openWith(page, modWithModel);

    const first = page.locator('#furniture-creator-presets li').first();
    await expect(first).toContainText('MyDesk');
    await expect(first).toContainText('this mod’s, copying HotelDesk');
});

test('takes from the donor what the file does not state', async ({ page }) => {
    await openWith(page, modWithModel);

    await page.locator('#furniture-creator-presets').getByRole('button', { name: /^MyDesk/ }).click();

    // The file states only a prefab, so the slot and the sub-objects are HotelDesk's.
    await expect(page.locator('#furniture-creator-summary')).toContainText('3x1LobbyDesk');
    await expect(page.locator('#furniture-creator-subobjects li')).toHaveCount(2);
});

test('draws the mod’s own model instead of the box, and says it did', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openWith(page, modWithModel);

    await page.locator('#furniture-creator-presets').getByRole('button', { name: /^MyDesk/ }).click();

    await expect(page.locator('#furniture-creator-summary'))
        .toContainText('Drawn from this mod’s own model');
    await expect(page.locator('#furniture-creator-summary')).toContainText('MyDesk.obj');

    // The box is scaffolding for reading positions against; once there is a real shape to
    // read them against, the scaffolding is in the way.
    const drawn = await page.evaluate(async () => {
        const module = await import('/flows/scriptableObject/scripts/furnitureCreator.js');
        return module.furnitureCreatorState().model?.meshes?.length ?? 0;
    });

    expect(drawn).toBe(1);
    expect(errors).toEqual([]);
});

/**
 * The one thing about a piece of furniture that nothing in the game checks.
 *
 * Placement is decided from `objectSize` alone, so a model wider than its class is placed
 * anyway and then clips whatever the generator stood beside it. Nothing is logged and no
 * placement fails — the only way to see it coming is to measure the mesh against the
 * footprint, which needs both, and the placement diagram is the only place that has both.
 */
test('marks where the model overhangs the footprint its class declares', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openWith(page, modWithWideModel);

    await page.locator('#furniture-creator-presets').getByRole('button', { name: /^MyDesk/ }).click();

    // The model has to have arrived before the diagram can measure it.
    await expect(page.locator('#furniture-creator-summary'))
        .toContainText('Drawn from this mod’s own model');

    await openSection(page, 'Placement');

    // 3x1LobbyDesk covers 0,0 back to -2,0. The slab reaches 5.0 m, a node past that.
    await expect(page.locator('.placement-tile-overhang')).toHaveCount(1);

    const notes = page.locator('#furniture-creator-placement-notes');
    await expect(notes).toContainText('4 × 1 nodes');
    await expect(notes).toContainText('reaches into the tile -3, 0');

    // Not a rule being broken. A note that read as one would send an author looking for the
    // setting that is wrong, and there is not one.
    await expect(notes).toContainText('never the mesh');

    expect(errors).toEqual([]);
});

/** The ordinary case: a model inside its own footprint says so and marks nothing. */
test('says nothing overhangs when the model fits its class', async ({ page }) => {
    await openWith(page, modWithModel);

    await page.locator('#furniture-creator-presets').getByRole('button', { name: /^MyDesk/ }).click();
    await expect(page.locator('#furniture-creator-summary'))
        .toContainText('Drawn from this mod’s own model');

    await openSection(page, 'Placement');

    await expect(page.locator('#furniture-creator-placement-notes')).toContainText('Nothing overhangs');
    await expect(page.locator('.placement-tile-overhang')).toHaveCount(0);
});

/**
 * The plan's rule, and the one place this pane deliberately shows less rather than more: a
 * box where a model was expected reads as the model being wrong rather than absent, so a
 * preset pointing at a prefab it has not got gets neither, and the file that could not be
 * found is named.
 */
test('names the file it could not find, and draws nothing in its place', async ({ page }) => {
    await openWith(page, modMissingMesh);

    await page.locator('#furniture-creator-presets').getByRole('button', { name: /^MyDesk/ }).click();

    const summary = page.locator('#furniture-creator-summary');
    await expect(summary).toContainText('MyDesk.obj, named by MyDesk.sodprefab.json');
    await expect(summary).toContainText('is not in the content folder');
    await expect(summary).not.toContainText('scaffolding to read the positions against');
});

/* -------------------------------------------------------------------------- */
/* What is built into it                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Stage 5 of the chain, and the one half of it a prefab has to answer.
 *
 * `pairToController` names an `InteractableController` inside the prefab, and that
 * controller is what supplies the interactable's position. For a shipped preset the prefab
 * is inside an asset bundle nothing here can open, so which ids exist is unknowable; for a
 * `.sodprefab.json` it is simply in the file. That difference is the whole gate on editing.
 *
 * `MyDesk` copies `HotelDesk`, which pairs the same preset to `A` and `B` — and this
 * prefab has `A` and `hidingPlace`. So the list arrives with one pairing that works and one
 * that does not, which is exactly the state an author cloning a shipped preset lands in.
 */
const openInteractables = async (page, name = /^MyDesk/) => {
    await page.locator('#furniture-creator-presets').getByRole('button', { name }).click();
    await openSection(page, 'What is built into it');
};

test('lists what the donor built in, and marks the pairing this prefab cannot make', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openWith(page, modWithModel);

    await openInteractables(page);

    // The model has to have arrived: the controllers are read with it.
    await expect(page.locator('#furniture-creator-summary'))
        .toContainText('Drawn from this mod’s own model');

    const rows = page.locator('#furniture-creator-interactables li');
    await expect(rows).toHaveCount(2);

    // A is in the prefab, so the row says where in the model it stands.
    await expect(rows.first()).toContainText('HotelDesk');
    await expect(rows.first()).toContainText('at A');
    await expect(rows.first()).toContainText('0.00, 0.90, -0.50');

    // B is not, and that is silent in game: one log line, and the thing at the origin.
    const notes = page.locator('#furniture-creator-interactable-notes');
    await expect(notes).toContainText('B is not a controller in MyDesk');
    await expect(notes).toContainText('at the model’s origin');

    expect(errors).toEqual([]);
});

/** The ids the prefab has, and nothing else — plus `none`, which is the game's own skip. */
test('offers the controllers the prefab declares, and says which are not in it', async ({ page }) => {
    await openWith(page, modWithModel);
    await openInteractables(page);

    await expect(page.locator('#furniture-creator-summary'))
        .toContainText('Drawn from this mod’s own model');

    await page.locator('#furniture-creator-interactables li').first().getByRole('button').click();

    const options = page.locator('#furniture-creator-interactable-controller option');
    await expect(options).toHaveText([
        'none — skip this entry',
        'A',
        'hidingPlace',
    ]);

    // The second entry's own id is kept on the list even though the prefab has not got it,
    // so opening a broken pairing shows what it is paired to rather than rewriting it.
    await page.locator('#furniture-creator-interactables li').nth(1).getByRole('button').click();
    await expect(options).toHaveText([
        'none — skip this entry',
        'A',
        'hidingPlace',
        'B — not in this prefab',
    ]);
});

/**
 * The round trip, which is the point of all of it: change a pairing, add one, save, and
 * read the file back.
 *
 * `integratedInteractables` replaces the donor's wholesale rather than adding to it, so the
 * file has to state every entry — including the one that was only ever inherited.
 */
test('writes the edited interactables into the preset file', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openWith(page, modWithModel);

    await openInteractables(page);
    await expect(page.locator('#furniture-creator-summary'))
        .toContainText('Drawn from this mod’s own model');

    // Repair the pairing the donor left broken: B is not in this prefab, hidingPlace is.
    await page.locator('#furniture-creator-interactables li').nth(1).getByRole('button').click();
    await page.locator('#furniture-creator-interactable-preset').fill('HidingPlace');
    await page.locator('#furniture-creator-interactable-controller').selectOption('hidingPlace');
    await page.locator('#furniture-creator-interactable-owner').selectOption('nobody');

    await expect(page.locator('#furniture-creator-interactable-notes'))
        .not.toContainText('is not a controller');

    await openSection(page, 'What will be written');
    await page.locator('#furniture-creator-name').fill('MyDesk');
    await page.locator('#furniture-creator-write').click();

    await expect(page.locator('#furniture-creator-plan')).toContainText('files written');

    const written = JSON.parse(
        await readFile(page, 'Mods/DeskMod/MyDesk.FurniturePreset.sodso.json'));

    // Both, as indices. A is 0, hidingPlace is 10, person0 is 2 and nobody is 0.
    expect(written.integratedInteractables).toEqual([
        { preset: 'REF:InteractablePreset|HotelDesk', pairToController: 0, belongsTo: 2 },
        { preset: 'REF:InteractablePreset|HidingPlace', pairToController: 10, belongsTo: 0 },
    ]);

    expect(errors).toEqual([]);
});

test('adds one on the first controller nothing is paired to', async ({ page }) => {
    await openWith(page, modWithModel);
    await openInteractables(page);

    await expect(page.locator('#furniture-creator-summary'))
        .toContainText('Drawn from this mod’s own model');

    await page.getByRole('button', { name: 'Add another' }).click();

    await expect(page.locator('#furniture-creator-interactables li')).toHaveCount(3);

    // A is taken by the donor's first entry, so the new one lands on hidingPlace.
    await expect(page.locator('#furniture-creator-interactable-controller'))
        .toHaveValue('hidingPlace');

    // Unnamed until something is typed, and the plan refuses to write it as it is: a
    // reference with nothing after the bar points at an asset called nothing.
    await openSection(page, 'What will be written');
    await page.locator('#furniture-creator-name').fill('MyDesk');

    await expect(page.locator('#furniture-creator-plan'))
        .toContainText('1 integrated interactable names no InteractablePreset');
});

/**
 * A preset carrying none has none to mark, so without a button reachable with nothing
 * marked the first one could never be written. This is that dead end, checked.
 */
test('can put the first one on a preset that carries none', async ({ page }) => {
    await openWith(page, {
        ...modWithModel,
        'Mods/DeskMod/MyDesk.FurniturePreset.sodso.json': json({
            fileType: 'FurniturePreset',
            name: 'MyDesk',
            presetName: 'MyDesk',
            copyFrom: 'REF:FurniturePreset|LargeBookcase',
            prefab: 'PREFAB:MyDeskPrefab/MyDesk',
        }),
    });

    await openInteractables(page);
    await expect(page.locator('#furniture-creator-summary'))
        .toContainText('Drawn from this mod’s own model');

    await expect(page.locator('#furniture-creator-interactables'))
        .toContainText('Nothing is built into this one');

    await page.getByRole('button', { name: 'Add an interactable' }).click();

    await expect(page.locator('#furniture-creator-interactable-controller')).toHaveValue('A');
    await expect(page.locator('#furniture-creator-interactable-editor')).toBeVisible();
});

/**
 * The gate, from the other side. A shipped preset's prefab is a Unity `GameObject` in an
 * asset bundle, so the ids it carries cannot be read and the list has to say so rather than
 * offering a picker that would be guessing.
 */
test('leaves a shipped preset’s interactables read-only, and says why', async ({ page }) => {
    await openWith(page, modWithModel);

    await page.locator('#furniture-creator-search').fill('HotelDesk');
    await openInteractables(page, /^HotelDesk/);

    await expect(page.locator('#furniture-creator-interactables li')).toHaveCount(2);

    await expect(page.locator('#furniture-creator-interactable-notes'))
        .toContainText('asset bundle this app cannot open');

    // No way in: neither the Add button nor the fields on a marked row.
    await expect(page.getByRole('button', { name: 'Add another' })).toBeHidden();

    await page.locator('#furniture-creator-interactables li').first().getByRole('button').click();
    await expect(page.locator('#furniture-creator-interactable-controller')).toBeDisabled();
    await expect(page.locator('#furniture-creator-interactable-preset')).toBeDisabled();
});

/**
 * Read-only is not the same as unchecked.
 *
 * Whether two entries share a controller, and whether the class assigns as many owners as
 * the list asks for, are questions about the files rather than about the model — so they
 * are answerable for a shipped preset, and worth answering while somebody is deciding
 * whether to clone it. Only the "is this controller in the prefab" half needs a prefab.
 */
test('still checks a shipped preset for the faults that are not about the model', async ({ page }) => {
    await openWith(page, {
        ...modWithModel,

        // Two entries on one controller, and a third owner the class does not assign:
        // 3x1LobbyDesk sets assignBelongsToOwners to 2, and this asks for person2.
        'ExportedSOs/FurniturePreset/LargeBookcase.json': json({
            presetName: 'LargeBookcase',
            prefab: 'REF:GameObject|LargeBookcase',
            classes: ['REF:FurnitureClass|3x1LobbyDesk'],
            allowedRoomFilters: ['REF:RoomTypeFilter|Lounge'],
            universalDesignStyle: true,
            minimumRoomSize: 4,
            subObjects: [],
            integratedInteractables: [
                { preset: 'REF:InteractablePreset|HotelDesk', pairToController: 0, belongsTo: 2 },
                { preset: 'REF:InteractablePreset|Lean', pairToController: 0, belongsTo: 4 },
            ],
        }),
    });

    await page.locator('#furniture-creator-search').fill('LargeBookcase');
    await openInteractables(page, /^LargeBookcase/);

    const notes = page.locator('#furniture-creator-interactable-notes');

    await expect(notes).toContainText('asset bundle this app cannot open');
    await expect(notes).toContainText('A has more than one interactable paired to it');
    await expect(notes).toContainText('asks for 3 owners, and 3x1LobbyDesk assigns 2');
    await expect(notes).toContainText('Could not find interactable owner for index 2');

    // The half that does need a prefab is not guessed at.
    await expect(notes).not.toContainText('is not a controller in');
});

/**
 * The mesh is not what a pairing needs — the controllers are in the prefab, which parsed.
 * Gating on the `.obj` would be this pane refusing to do the one thing only it can, for a
 * file that has nothing to do with the question.
 */
test('can still edit the interactables when the mesh is missing', async ({ page }) => {
    await openWith(page, modMissingMesh);
    await openInteractables(page);

    await expect(page.locator('#furniture-creator-summary'))
        .toContainText('is not in the content folder');

    await expect(page.getByRole('button', { name: 'Add another' })).toBeVisible();

    await page.locator('#furniture-creator-interactables li').first().getByRole('button').click();
    await expect(page.locator('#furniture-creator-interactable-controller')).toBeEnabled();
});

/** What ends up in the scene is `furnitureView.spec.js`; this is the pane reading it. */

test('still says a shipped preset’s box is a box', async ({ page }) => {
    await openWith(page, modWithModel);

    await page.locator('#furniture-creator-search').fill('LargeBookcase');
    await page.locator('#furniture-creator-presets')
        .getByRole('button', { name: 'LargeBookcase', exact: true }).click();

    await expect(page.locator('#furniture-creator-summary'))
        .toContainText('scaffolding to read the positions against');
});


/* -------------------------------------------------------------------------- */
/* Patches                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The shipped asset a patch edits, as the export folder holds it.
 *
 * Cut to the fields the pane reads, which is all a patch needs to apply against: what
 * matters is that it is a *whole* asset with real indices, so `/subObjects/0/...` means
 * something. `FurniturePreset` is not one of the nine types this tool ships, so an export
 * folder is the only way to have one.
 */
const shippedHotelDesk = json({
    presetName: 'HotelDesk',
    prefab: 'REF:GameObject|HotelFrontDesk',
    classes: ['REF:FurnitureClass|3x1LobbyDesk'],
    allowedRoomFilters: ['REF:RoomTypeFilter|Lobby'],
    universalDesignStyle: true,
    minimumRoomSize: 4,
    subObjects: [{
        preset: 'REF:SubObjectClassPreset|Computer',
        parent: '',
        localPos: { x: -1.023, y: 1, z: 0.266 },
        localRot: { x: 0, y: 194.729, z: 0 },
        belongsTo: 2,
        security: 0,
    }],
    integratedInteractables: [
        { preset: 'REF:InteractablePreset|HotelDesk', pairToController: 0, belongsTo: 2 },
    ],
});

/** A mod that patches a shipped preset, moving the thing on top of it up 40 cm. */
const modWithPatch = {
    'Mods/DeskMod/murdermanifest.sodso.json': json({
        enabled: true, fileOrder: ['REF:HotelDesk'], loadBefore: '', version: 1,
    }),
    'Mods/DeskMod/HotelDesk.FurniturePreset.sodso_patch.json': json({
        name: 'HotelDesk',
        fileType: 'FurniturePreset',
        patches: [{ op: 'replace', path: '/subObjects/0/localPos/y', value: 1.4 }],
    }),
    'ExportedSOs/FurniturePreset/HotelDesk.json': shippedHotelDesk,
};

/**
 * The same, with no export folder connected.
 *
 * The state an author is in before they have exported the game's ScriptableObjects, which
 * is the one case the pane cannot read anything in -- and has to say so rather than
 * showing an empty preset.
 */
async function openWithoutExport(page, fixture) {
    await page.addInitScript((k) => window.localStorage.setItem(k, 'true'), SPOILER_KEY);
    await gotoFlow(page, '?flow=scriptableObject');

    await seedFs(page, fixture);
    await connectFolders(page, { modDir: 'Mods' });
    await selectContent(page, 'DeskMod', '');

    await page.evaluate((map) => Object.assign(window.typeMap, map), furnitureTypeMap);

    await page.getByRole('link', { name: 'Furniture Creator' }).click();
    await expectDialogOpen(page, '#furniture-creator-modal', true);
    await expect(page.locator('#furniture-creator-presets li').first()).toBeVisible();
}

async function openWithExport(page, fixture) {
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

/**
 * The whole point of reading the export: the numbers on screen are the ones that will be
 * in play, rather than the shipped ones the patch is about to change.
 */
test('applies a patch to the asset it patches, and shows the result', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openWithExport(page, modWithPatch);

    await page.locator('#furniture-creator-presets')
        .getByRole('button', { name: /^HotelDesk/ }).click();

    await expect(page.locator('#furniture-creator-summary'))
        .toContainText('as this mod patches it, not as the game ships it');

    // 1.4, not the 1.0 the shipped asset holds.
    await expect(page.locator('#furniture-creator-subobjects li').first())
        .toContainText('-1.02, 1.40, 0.27');

    // Read off the whole asset, where the enums are integers.
    await expect(page.locator('#furniture-creator-subobjects li').first())
        .toContainText('person0');

    expect(errors).toEqual([]);
});

test('says what it needs when there is no asset to apply a patch to', async ({ page }) => {
    await openWithoutExport(page, {
        'Mods/DeskMod/murdermanifest.sodso.json': json({
            enabled: true, fileOrder: ['REF:HotelDesk'], loadBefore: '', version: 1,
        }),
        'Mods/DeskMod/HotelDesk.FurniturePreset.sodso_patch.json': json({
            name: 'HotelDesk', fileType: 'FurniturePreset', patches: [],
        }),
    });

    await page.locator('#furniture-creator-presets')
        .getByRole('button', { name: /^HotelDesk/ }).click();

    await expect(page.locator('#furniture-creator-summary'))
        .toContainText('exported ScriptableObjects folder');
    await expect(page.locator('#furniture-creator-subobjects li')).toHaveCount(0);
});

/**
 * Two files for one asset name: the patch edits the shipped `HotelDesk` and a file of
 * fields would declare one of the mod's own. They do not collide on disk, so nothing else
 * would catch it.
 */
test('will not write a file of fields under a name it already patches', async ({ page }) => {
    await openWithExport(page, modWithPatch);

    await page.locator('#furniture-creator-presets')
        .getByRole('button', { name: /^HotelDesk/ }).click();

    await openSection(page, 'What will be written');

    // The name is not pre-filled from a patch, unlike a file of fields.
    await expect(page.locator('#furniture-creator-name')).toHaveValue('');

    await page.locator('#furniture-creator-name').fill('HotelDesk');

    await expect(page.locator('#furniture-creator-plan')).toContainText('already patches HotelDesk');
    await expect(page.locator('#furniture-creator-write')).toBeDisabled();
});
