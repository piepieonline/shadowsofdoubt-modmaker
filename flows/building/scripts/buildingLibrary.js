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
 */
import { readFileContent, tryGetFile, tryGetFolder, getFile, getFolder, writeFile } from '../../../core/fs.js';

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
                    blueprint,
                });
            });
        }
    });

    return options;
}

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
 */
export function stubFor(name, sourcePreset, { copyFrom = name } = {}) {
    return {
        name,
        presetName: name,
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
 */
export function withoutDefaults(preset) {
    const defaults = soDefaults[BUILDING_TYPE] ?? {};
    const kept = {};

    for (const [field, value] of Object.entries(preset)) {
        if (ALWAYS_WRITTEN.includes(field)) {
            kept[field] = value;
            continue;
        }
        if (field in defaults && same(value, defaults[field])) continue;
        kept[field] = value;
    }

    return kept;
}

/**
 * Write a building into the mod, dropping its default-valued fields.
 *
 * Overwrites: the caller has the preset that was read, so this is the same file going
 * back rather than a second one appearing.
 */
export async function writeCustomPreset(contentFolder, name, preset) {
    const handle = await getFile(contentFolder, [`${name}${PRESET_SUFFIX}`], true);
    await writeFile(handle, `${JSON.stringify(withoutDefaults(preset), null, 2)}\n`);
    return handle;
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
 * Make a building the mod owns.
 *
 * With `copyFrom` naming a base game building it is a stub of that one; without, it is
 * a building of its own, which needs a mesh generating before the game can show it.
 */
export async function createCustomBuilding(contentFolder, name, { copyFrom = null } = {}) {
    const preset = stubFor(name, copyFrom ? await loadVanillaPreset(copyFrom) : null, { copyFrom });

    await writeCustomPreset(contentFolder, name, preset);
    await getFolder(contentFolder, [FLOORS_DIR], true);

    return { name, isCustom: true, preset };
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
