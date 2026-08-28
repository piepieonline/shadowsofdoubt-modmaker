/**
 * Buildings, the floor slots they have, and where a blueprint is read from.
 *
 * A floor blueprint is not content on its own -- the game never loads one except
 * through a building that names it. So editing a floor means knowing which building
 * refers to it, in which slot, and writing the building back when that changes.
 *
 * Two shapes of the same thing, which is the awkward part:
 *
 *   refs/floors/buildings/<Name>.json   the base game's, dumped out of the game. Unity
 *                                       asset references (`{m_FileID, m_PathID}`),
 *                                       enums as integers, every field present.
 *   <Name>.sodso.json in a mod          the mod loader's, which is what this writes.
 *
 * The two agree on the fields that matter here -- floorLayouts and basementLayouts are
 * plain data in both -- so a slot list can be read from either. Only the mod loader's
 * shape is ever written.
 *
 * **Base game presets are never written to.** Saving a floor against one creates a stub
 * of the same name in the mod, carrying `copyFrom: "REF:BuildingPreset|<name>"` and its
 * floor list and nothing else. That is what lets a custom floor reuse a base game
 * building's existing prefab, mesh and window data -- and so what makes generating a
 * mesh optional rather than a prerequisite for getting a floor into the game.
 *
 * Which is also why a stub is written **without its default-valued fields**. `copyFrom`
 * means "start from that asset and apply what follows", so a field written at its
 * default is not a no-op -- it overwrites whatever the base game building had with
 * nothing. A stub carrying the full template would name a building to copy and then
 * blank its prefab, its height and its window data in the same breath. This is the one
 * place the flow departs from how the ScriptableObject flow writes a new file, and the
 * reason is `copyFrom`.
 *
 * Every preset written here is also named in the mod's `murdermanifest.sodso.json`,
 * which is what makes the loader read it at all. See core/murderManifest.js.
 */
import { readFileContent, tryGetFile, tryGetFolder, getFile, getFolder, writeFile } from '../../../core/fs.js';
import { ensureListed } from '../../../core/murderManifest.js';

/**
 * The game's own default for every BuildingPreset field, which is what "default-valued"
 * is measured against.
 *
 * Imported here rather than in loadRefs.js because nothing under flows/building is
 * reached from main.js -- the whole flow is dynamically imported on activation -- so
 * this costs nothing at page load. See the note in core/refs.js about what that rule
 * is protecting.
 */
import soDefaults from '../../../refs/generated/soDefaults.json' with { type: 'json' };

export const BUILDING_TYPE = 'BuildingPreset';
export const PRESET_SUFFIX = '.sodso.json';

/** The folder a mod keeps its floors in, and the marker core/modFolders.js looks for. */
export const FLOORS_DIR = 'Floors';

/**
 * How a preset points at a floor the mod holds: the prefix, the path, then the name.
 *
 * `FLOOR:Floors/GrandHotel_Lobby` -- no extension, and the path is relative to the folder
 * the preset is in. A blueprint named without it is one the game resolves out of its own
 * assets, which is what every base game name in a floor list is.
 *
 * So the prefix is not decoration: a floor the mod holds and does not spell out this way
 * is a floor the game never reads, whatever it is called. That includes a floor named
 * after a base game one -- the mod's copy does not shadow the original by sharing its
 * name, it has to be pointed at.
 */
const FLOOR_REF = 'FLOOR:';

/**
 * The floor a stored blueprint entry names, whichever form it is in.
 *
 * Everything that reads a floor list goes through this, so the rest of the flow only ever
 * deals in bare names -- which is what a slot is labelled with, what a floor is resolved
 * by, and what one is saved as.
 *
 * The prefix and the path are taken off and nothing else is. An entry in some other shape
 * is not something to guess at: it comes back as it was, is looked for under that name,
 * and fails to open with the name it actually holds rather than one invented here.
 */
export function blueprintName(entry) {
    if (!entry) return '';

    const value = String(entry);
    if (!value.toUpperCase().startsWith(FLOOR_REF)) return value;

    const path = value.slice(FLOOR_REF.length);
    return path.slice(path.lastIndexOf('/') + 1);
}

/** Where the base game's copies live, shipped with the app. */
const REF_ROOT = '/refs/floors';

/**
 * Fields a stub always states, however ordinary their values.
 *
 * The first four are what identify the file to the mod loader, and dropping any of them
 * leaves an asset it cannot place. `copyFrom` is the whole point of a stub.
 */
const ALWAYS_WRITTEN = ['name', 'presetName', 'type', 'fileType', 'copyFrom'];


/* -------------------------------------------------------------------------- */
/* The base game's copies                                                      */
/* -------------------------------------------------------------------------- */

let indexPromise = null;

/** Which blueprints and buildings ship with the app. Fetched once per page. */
export function loadFloorIndex() {
    indexPromise ??= fetch(`${REF_ROOT}/index.json`).then((response) => response.json());
    return indexPromise;
}

/** A base game building preset, in the game's dumped shape. */
export async function loadVanillaPreset(name) {
    const response = await fetch(`${REF_ROOT}/buildings/${encodeURIComponent(name)}.json`);
    return response.ok ? response.json() : null;
}

/** A base game floor blueprint. */
export async function loadVanillaBlueprint(name) {
    const response = await fetch(`${REF_ROOT}/blueprints/${encodeURIComponent(name)}.json`);
    return response.ok ? response.json() : null;
}


/* -------------------------------------------------------------------------- */
/* A mod's own buildings                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The buildings a content folder defines.
 *
 * A building is a `<Name>.sodso.json` saying `fileType: "BuildingPreset"`. A folder may
 * hold several, all sharing the one Floors directory -- which is why the directory is
 * what marks the folder rather than any one preset being.
 */
export async function listCustomBuildings(contentFolder) {
    if (!contentFolder) return [];

    const found = [];
    for await (const entry of contentFolder.values()) {
        if (entry.kind !== 'file' || !entry.name.endsWith(PRESET_SUFFIX)) continue;

        const preset = await readJson(entry);
        if (preset?.fileType !== BUILDING_TYPE) continue;

        found.push({
            name: entry.name.slice(0, -PRESET_SUFFIX.length),
            isCustom: true,
            preset,
        });
    }

    return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every building that can be opened: the mod's own first, then the base game's.
 *
 * A mod building shadows a base game one of the same name, because that is exactly what
 * a stub is -- the same building, with this mod's floors in it.
 */
export async function listBuildings(contentFolder) {
    const custom = await listCustomBuildings(contentFolder);
    const taken = new Set(custom.map((entry) => entry.name));

    const index = await loadFloorIndex();
    const vanilla = index.buildings
        .filter((name) => !taken.has(name))
        .map((name) => ({ name, isCustom: false, preset: null }));

    return [...custom, ...vanilla];
}

/** A mod's building preset, or null if the folder has no such file. */
export async function readCustomPreset(contentFolder, name) {
    const handle = await tryGetFile(contentFolder, [`${name}${PRESET_SUFFIX}`]);
    return handle ? readJson(handle) : null;
}

/**
 * A building's preset, whether the mod defines it or the base game does.
 *
 * `isCustom` is what the caller needs before saving: a base game preset has to become a
 * stub first, because the copy shipped with the app is not a file anyone can write to.
 */
export async function loadPreset(contentFolder, name) {
    const custom = await readCustomPreset(contentFolder, name);
    if (custom) return { preset: custom, isCustom: true };

    const vanilla = await loadVanillaPreset(name);
    return vanilla ? { preset: vanilla, isCustom: false } : null;
}


/* -------------------------------------------------------------------------- */
/* Floor slots                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every slot a building has a floor in.
 *
 * A building's floors are grouped into settings -- "the next 4 floors all look like
 * this" -- and each setting holds a list of blueprints the game picks between, plus a
 * second list of variants featuring a control room. So one slot is four coordinates:
 * above or below ground, which setting, ordinary or control, and which of that list.
 */
export function enumerateSlots(preset) {
    if (!preset) return [];

    return [
        ...slotsIn(preset.floorLayouts, false),
        ...slotsIn(preset.basementLayouts, true),
    ];
}

function slotsIn(layouts, isBasement) {
    const options = [];

    // The shipped dumps always write the list, empty or not. A mod preset need not:
    // writing a stub drops any list still at its default, so a building copied from
    // another and never given basements has no basementLayouts field at all.
    (layouts ?? []).forEach((layout, layoutIndex) => {
        for (const isControlVariant of [false, true]) {
            const blueprints = isControlVariant ? layout?.controlRoomVariants : layout?.blueprints;

            (blueprints ?? []).forEach((blueprint, blueprintIndex) => {
                options.push({
                    slot: { isBasement, isControlVariant, layoutIndex, blueprintIndex },
                    label: slotLabel(
                        isBasement, layoutIndex, blueprintIndex,
                        (blueprints ?? []).length, isControlVariant),
                    // The name, not the entry. A slot is opened, labelled and saved by
                    // the floor it names; how the preset spells that out is settled when
                    // the preset is written. See blueprintName.
                    blueprint: blueprintName(blueprint),
                });
            });
        }
    });

    return options;
}

/**
 * A building's slots grouped into storeys, lowest first.
 *
 * A storey is one floor setting: the blueprints in it are alternative layouts of the
 * same storey, which the game picks between when it builds the city, plus the variants
 * of those featuring a control room. So "the floor above" is the next setting, not the
 * next blueprint -- stepping through the slot list one at a time would walk sideways
 * through a storey's own layouts and call it climbing.
 *
 * Basements come first and deepest first, because basementLayouts[0] is the one just
 * below the ground floor and each after it is further down. That is the order they are
 * in in the building, which is what up and down have to mean.
 */
export function storeysOf(slots) {
    const byKey = new Map();

    for (const option of slots ?? []) {
        const { isBasement, layoutIndex } = option.slot;
        const key = `${isBasement ? 'b' : 'f'}${layoutIndex}`;

        if (!byKey.has(key)) {
            byKey.set(key, {
                key,
                isBasement,
                layoutIndex,
                label: `${isBasement ? 'Basement' : 'Floor'} ${layoutIndex}`,
                options: [],
            });
        }

        byKey.get(key).options.push(option);
    }

    return [...byKey.values()].sort((a, b) => height(a) - height(b));
}

/** Where a storey sits in the building: basement 0 is one below floor 0. */
const height = (storey) => (storey.isBasement ? -(storey.layoutIndex + 1) : storey.layoutIndex);

/**
 * Whether two slots are the same place in a building.
 *
 * Compared field by field rather than by the blueprint in them, because nothing stops a
 * building listing one blueprint in two slots -- so the name does not say which of them
 * is open.
 */
export const sameSlot = (a, b) => !!a && !!b
    && !!a.isBasement === !!b.isBasement
    && !!a.isControlVariant === !!b.isControlVariant
    && a.layoutIndex === b.layoutIndex
    && a.blueprintIndex === b.blueprintIndex;

function slotLabel(isBasement, layoutIndex, blueprintIndex, count, isControlVariant) {
    let label = `${isBasement ? 'Basement' : 'Floor'} ${layoutIndex}`;
    if (count > 1) label += ` v${blueprintIndex}`;
    if (isControlVariant) label += ' (control)';
    return label;
}

/**
 * Point a slot at a floor, adding the setting or the list entry if it is not there yet.
 *
 * Returns where the floor actually landed, which is not always where it was asked to
 * go: a slot with `layoutIndex: -1` means "a new setting", and one past the end of a
 * blueprint list appends rather than leaving a hole.
 */
export function setBlueprint(preset, slot, floorName) {
    const key = slot.isBasement ? 'basementLayouts' : 'floorLayouts';
    const layouts = preset[key] ?? (preset[key] = []);

    const resolved = { ...slot };

    if (!(resolved.layoutIndex >= 0 && resolved.layoutIndex < layouts.length)) {
        layouts.push(newFloorSetting());
        resolved.layoutIndex = layouts.length - 1;
        resolved.isControlVariant = false;
        resolved.blueprintIndex = 0;
    }

    const layout = layouts[resolved.layoutIndex];
    const listKey = resolved.isControlVariant ? 'controlRoomVariants' : 'blueprints';
    const blueprints = layout[listKey] ?? (layout[listKey] = []);

    if (resolved.blueprintIndex >= 0 && resolved.blueprintIndex < blueprints.length) {
        blueprints[resolved.blueprintIndex] = floorName;
    } else {
        blueprints.push(floorName);
        resolved.blueprintIndex = blueprints.length - 1;
    }

    return resolved;
}

/**
 * Take a floor out of the slot it sits in.
 *
 * A setting left holding no blueprints at all goes with it. `floorsWithThisSetting`
 * means "the next N floors look like this", so an empty setting is not a floor with
 * nothing in it -- it is N floors of the building silently shifted onto the setting
 * after it. One that still has a control room variant is kept: it is a setting with
 * something in it, and dropping it would take that away too.
 *
 * Returns whether anything was there to remove.
 */
export function removeBlueprint(preset, slot) {
    const layouts = preset?.[slot?.isBasement ? 'basementLayouts' : 'floorLayouts'];
    const layout = layouts?.[slot?.layoutIndex];
    if (!layout) return false;

    const listKey = slot.isControlVariant ? 'controlRoomVariants' : 'blueprints';
    const blueprints = layout[listKey];
    if (!blueprints || slot.blueprintIndex < 0 || slot.blueprintIndex >= blueprints.length) {
        return false;
    }

    blueprints.splice(slot.blueprintIndex, 1);

    const empty = (layout.blueprints ?? []).length === 0
        && (layout.controlRoomVariants ?? []).length === 0;
    if (empty) layouts.splice(slot.layoutIndex, 1);

    return true;
}

/** A floor setting at the game's defaults, for a slot that did not exist before. */
function newFloorSetting() {
    return {
        floorsWithThisSetting: 1,
        blueprints: [],
        airVentMaximumExtrusion: 0,
        controlRoomVariants: [],
        forceShowModel: false,
        forceHideModels: [],
        forceHideModelsInRooms: [],
        forceHideModelsOutside: [],
        overrideCeilingHeight: false,
        newCeilingHeight: 51,
    };
}


/* -------------------------------------------------------------------------- */
/* Reading a floor                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The blueprint a name refers to: the mod's copy if it has one, the base game's
 * otherwise.
 *
 * That order is what makes editing a base game floor work at all. A floor saved into
 * the mod keeps the name the building already refers to, so the building needs no
 * change and the mod's copy simply shadows the original.
 */
export async function resolveBlueprint(contentFolder, blueprintName) {
    if (!blueprintName) return null;

    const custom = await readCustomBlueprint(contentFolder, blueprintName);
    if (custom) return { data: custom, isCustom: true };

    const vanilla = await loadVanillaBlueprint(blueprintName);
    return vanilla ? { data: vanilla, isCustom: false } : null;
}

/** A blueprint the mod holds, or null. */
export async function readCustomBlueprint(contentFolder, name) {
    const floors = await tryGetFolder(contentFolder, [FLOORS_DIR]);
    if (!floors) return null;

    const handle = await tryGetFile(floors, [`${name}.json`]);
    return handle ? readJson(handle) : null;
}

/** The blueprints the mod holds, by name. */
export async function listCustomBlueprints(contentFolder) {
    const floors = await tryGetFolder(contentFolder, [FLOORS_DIR]);
    if (!floors) return [];

    const names = [];
    for await (const entry of floors.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
            names.push(entry.name.slice(0, -'.json'.length));
        }
    }

    return names.sort((a, b) => a.localeCompare(b));
}


/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A stub of a base game building: its name, its floors, and an instruction to take
 * everything else from the original.
 *
 * Seeded from the source's floor list alone rather than from the whole preset. The
 * base game's copy is a *dump*, so its prefab is `{m_FileID: 66256}` and its scene
 * profile an integer -- neither is what the mod loader reads, and both differ from
 * their defaults, so a stub seeded from the whole thing would carry them out into the
 * mod. Floor settings are plain data in both shapes and are the only part that
 * transfers cleanly.
 *
 * `presetName` is what the building is: it names the file, it is what a `REF:` string
 * points at, and it is the key its readable name is stored against -- so it has to be
 * safe as an identifier and as a file name. `title` is the readable name, and defaults
 * to the preset name for the stubs nobody titled.
 */
export function stubFor(presetName, sourcePreset, { copyFrom = presetName, title = presetName } = {}) {
    return {
        name: title,
        presetName,
        type: BUILDING_TYPE,
        fileType: BUILDING_TYPE,
        copyFrom: copyFrom ? `REF:${BUILDING_TYPE}|${copyFrom}` : null,
        floorLayouts: clone(sourcePreset?.floorLayouts ?? []),
        basementLayouts: clone(sourcePreset?.basementLayouts ?? []),
    };
}

/**
 * A preset with every field that is already the game's default left out.
 *
 * See the note at the top of the file: under `copyFrom`, writing a default is not the
 * same as writing nothing. It overwrites.
 *
 * One consequence worth knowing: a building whose floor list is emptied writes no
 * floor list at all, so the copied-from building's floors stay. Clearing a building's
 * floors is not something this can express, and the reference tool cannot either.
 *
 * `alsoWritten` is for a caller that has *decided* a field, default or not. Generating a
 * mesh is the one: `floorCount: 1` and `sortedWindows: []` are both the game's defaults,
 * so a one-storey building, or one whose floors have no exterior windows, would drop
 * exactly the two fields it just computed and keep the copied-from building's instead --
 * a model of this building lit through another building's windows.
 */
export function withoutDefaults(preset, alsoWritten = []) {
    const defaults = soDefaults[BUILDING_TYPE] ?? {};
    const kept = {};

    for (const [field, value] of Object.entries(preset)) {
        if (ALWAYS_WRITTEN.includes(field) || alsoWritten.includes(field)) {
            kept[field] = value;
            continue;
        }
        if (field in defaults && same(value, defaults[field])) continue;
        kept[field] = value;
    }

    return kept;
}

/**
 * Write a building into the mod, dropping its default-valued fields, and list it in the
 * mod's manifest.
 *
 * Overwrites: the caller has the preset that was read, so this is the same file going
 * back rather than a second one appearing.
 *
 * The manifest entry is here rather than beside the dialog that adds a building because
 * this is the one place a building preset reaches the mod's folder: adding a building
 * comes through here, and so does the stub written the first time a floor is saved
 * against a base game building. A preset the manifest does not name is not loaded, so
 * one written through either path and left unlisted is a building the game never sees.
 * Listing it is idempotent -- every later save finds it named already and writes
 * nothing.
 *
 * The preset is written first. If listing then fails the building is still on disk to be
 * listed by hand, which is the recoverable half of the two.
 */
export async function writeCustomPreset(contentFolder, name, preset, { alsoWritten = [] } = {}) {
    const written = pointAtModFloors(
        withoutDefaults(preset, alsoWritten),
        new Set(await listCustomBlueprints(contentFolder)));

    const handle = await getFile(contentFolder, [`${name}${PRESET_SUFFIX}`], true);
    await writeFile(handle, `${JSON.stringify(written, null, 2)}\n`);

    await ensureListed(contentFolder, name);

    return handle;
}

/**
 * Spell out every blueprint the mod holds as a `FLOOR:` reference to the mod's own copy.
 *
 * Here rather than in `setBlueprint`, because which floors the mod holds is not something
 * a slot knows and not something that stays true: a floor is written before the building
 * that names it, and a floor deleted from the mod leaves a building still pointing at it.
 * Settling it at the moment the file is written means the answer is the one that was true
 * when it was written, for every slot rather than the one being changed.
 *
 * Three cases, and the third is why this reads before it writes:
 *
 *   the mod holds it       point at the mod's copy
 *   the base game holds it leave it exactly as it is -- the game resolves its own
 *   it pointed at the mod, spell it back down to a bare name, so a floor deleted from
 *   which no longer holds it   the mod uncovers the base game's rather than pointing
 *                              at a file that is not there
 *
 * Anything in a shape this does not recognise is passed through untouched. A preset may
 * have been written by another tool, and a reference form nobody here knows about is not
 * something to normalise away.
 *
 * The preset is copied down to the lists being changed rather than edited: the caller
 * still holds the one it passed in, and it goes on working in bare names.
 */
function pointAtModFloors(preset, held) {
    const point = (entry) => {
        const name = blueprintName(entry);

        if (held.has(name)) return `${FLOOR_REF}${FLOORS_DIR}/${name}`;
        return name === entry ? entry : name;
    };

    const repoint = (layouts) => layouts?.map((layout) => {
        const rewritten = { ...layout };

        if (layout?.blueprints) rewritten.blueprints = layout.blueprints.map(point);
        if (layout?.controlRoomVariants) {
            rewritten.controlRoomVariants = layout.controlRoomVariants.map(point);
        }

        return rewritten;
    });

    const written = { ...preset };
    if (written.floorLayouts) written.floorLayouts = repoint(written.floorLayouts);
    if (written.basementLayouts) written.basementLayouts = repoint(written.basementLayouts);

    return written;
}

/**
 * Write a floor into the mod's Floors folder, creating it if this is the first.
 *
 * Compact, as the game writes them -- a blueprint is 60 KB of coordinates and nobody
 * reads it as text.
 */
export async function writeCustomBlueprint(contentFolder, name, floorData) {
    const floors = await getFolder(contentFolder, [FLOORS_DIR], true);
    const handle = await getFile(floors, [`${name}.json`], true);
    await writeFile(handle, `${JSON.stringify(floorData)}\n`);
    return handle;
}

/**
 * Delete a floor the mod holds.
 *
 * Only ever the mod's own copy. A base game blueprint of the same name is a URL this app
 * fetched, so deleting the mod's file uncovers the original rather than removing
 * anything -- which is what makes "delete" on a floor that shadows a base game one mean
 * "stop overriding it".
 *
 * @returns whether there was a file to delete
 */
export async function deleteCustomBlueprint(contentFolder, name) {
    const floors = await tryGetFolder(contentFolder, [FLOORS_DIR]);
    if (!floors) return false;

    if (!(await tryGetFile(floors, [`${name}.json`]))) return false;

    await floors.removeEntry(`${name}.json`);
    return true;
}

/**
 * Make a building the mod owns.
 *
 * With `copyFrom` naming a base game building it is a stub of that one; without, it is
 * a building of its own, which needs a mesh generating before the game can show it.
 *
 * Named by its preset name, file included. The `title` is the readable name and is not
 * an identifier -- it may hold spaces and punctuation, and the game reads it from a
 * strings CSV rather than from here. Writing that row is the caller's, because it is
 * DDS content and this file is about buildings.
 */
export async function createCustomBuilding(contentFolder, presetName, { copyFrom = null, title = presetName } = {}) {
    const preset = stubFor(
        presetName, copyFrom ? await loadVanillaPreset(copyFrom) : null, { copyFrom, title });

    await writeCustomPreset(contentFolder, presetName, preset);
    await getFolder(contentFolder, [FLOORS_DIR], true);

    return { name: presetName, isCustom: true, preset };
}

/**
 * The building a floor should be saved against, creating the stub if it is still the
 * base game's.
 *
 * This is the step that keeps base game presets read-only: whatever the author had
 * open, what gets written is always the mod's own copy.
 */
export async function presetForSaving(contentFolder, name) {
    const existing = await readCustomPreset(contentFolder, name);
    if (existing) return { preset: existing, created: false };

    return { preset: stubFor(name, await loadVanillaPreset(name)), created: true };
}


/* -------------------------------------------------------------------------- */

async function readJson(handle) {
    try {
        return JSON.parse(await readFileContent(handle));
    } catch {
        // A file that will not parse is not a building. Callers list what they can
        // rather than failing the whole folder over one bad file.
        return null;
    }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Deep equality by value, which is all that comparing against a default needs. */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
