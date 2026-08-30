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
 *   <Name>.BuildingPreset.sodso.json    the mod loader's, which is what this writes.
 *      in a mod
 *
 * The flow deals in bare building names throughout -- a name is what a slot belongs to,
 * what the base game index is searched by, and what `copyFrom` points at. The file it is
 * stored in carries the type as well (see core/soFileName.js), so which file a name means
 * is settled by looking in the folder rather than by spelling it out: a mod written
 * before that convention holds `<Name>.sodso.json`, that file is still what the manifest
 * names and still what the game loads, and saving a floor against it must go back into
 * it rather than beside it.
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
import { BUILDING_TYPE } from '../../../core/modFolders.js';
import { ensureListed } from '../../../core/murderManifest.js';
import { assetNameOf, fileNameFor, PRESET_SUFFIX } from '../../../core/soFileName.js';
import { pathIdMap } from '../../../core/baseAssets.js';
import { refName } from './furnitureOverlay.js';

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

/**
 * What a building's `fileType` says. From core/modFolders.js because the folder search
 * has to recognise one too -- a content folder is a building folder when its manifest
 * names a preset saying this -- and the two cannot be allowed to disagree about it.
 */
export { BUILDING_TYPE, PRESET_SUFFIX };

/** The folder a mod keeps its floors in. */
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
 * A building is a `.sodso.json` saying `fileType: "BuildingPreset"`. A folder may hold
 * several, all sharing the one Floors directory. What each one is called is the file's
 * name with its type taken off, which for a file written before that convention is the
 * whole of it.
 *
 * Every one is listed here, whether or not the mod's manifest names it. What the manifest
 * settles is whether the *folder* is offered at all (see core/modFolders.js); once an
 * author is in it, a preset the manifest has lost track of is the one thing they most
 * need to see -- and saving it puts it back in the manifest.
 */
export async function listCustomBuildings(contentFolder) {
    if (!contentFolder) return [];

    const found = [];
    for await (const entry of contentFolder.values()) {
        if (entry.kind !== 'file' || !entry.name.endsWith(PRESET_SUFFIX)) continue;

        const preset = await readJson(entry);
        if (preset?.fileType !== BUILDING_TYPE) continue;

        const stem = entry.name.slice(0, -PRESET_SUFFIX.length);

        found.push({
            // The building, not the file: the type comes off, and a file named before
            // that convention has none to come off. This is what the base game index is
            // matched against and what `copyFrom` is written with, so it has to be the
            // name and nothing else.
            name: assetNameOf(stem, BUILDING_TYPE),
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

/**
 * The file an asset of a type is stored in, or null when the mod does not hold it.
 *
 * Two names to try, and the order is the whole of it. The typed one is what this writes
 * now; the bare one is what mods written before that convention hold, and it is a file
 * the manifest already names and the game already loads. Preferring the typed name means
 * a folder holding both -- which only a hand-edited mod can be -- is read the way it is
 * written, rather than one file being read and the other written.
 *
 * Buildings are what this mostly looks for, and are what the type defaults to. A stairwell
 * is the other one, and is looked for the same way because a mod names its files the same
 * way whatever is in them.
 */
async function findPresetFile(contentFolder, name, type = BUILDING_TYPE) {
    for (const fileName of [fileNameFor(name, type), `${name}${PRESET_SUFFIX}`]) {
        const handle = await tryGetFile(contentFolder, [fileName]);
        if (handle) return { fileName, handle };
    }

    return null;
}

/** A mod's building preset, or null if the folder has no such file. */
export async function readCustomPreset(contentFolder, name) {
    const found = await findPresetFile(contentFolder, name);
    return found ? readJson(found.handle) : null;
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
/* The stairwell standing in a tile                                            */
/* -------------------------------------------------------------------------- */

/**
 * The type of the asset a building names as its stairwell, and the two the game falls
 * back to when it names none.
 *
 * The fallbacks are the game's own: a building with no `stairwellRegular` gets
 * WoodenStairwellElevator, and the tile's `e_l` swaps it for the mirrored one of the pair.
 * That flag is *only* this choice -- see parseTiles in floorModel.js.
 */
const STAIRWELL_TYPE = 'StairwellPreset';
const DEFAULT_STAIRWELL = 'WoodenStairwellElevator';
const DEFAULT_STAIRWELL_INVERTED = 'WoodenStairwellElevatorInverted';

/**
 * Whether the stairwell a tile shows carries a lift, for both of the presets a tile in
 * this building can resolve to: `{ plain, inverted }`, keyed by the tile's `e_l`.
 *
 * **Both are true unless the mod says otherwise.** `featuresElevator` defaults to true in
 * the game -- see soDefaults -- and all five StairwellPresets it ships leave it there, so
 * the only thing that can make a stairwell lift-less is a mod defining a StairwellPreset
 * of its own. This tool ships no reference data for the type because there is nothing in
 * it worth shipping: five assets that all say the same thing.
 *
 * Two answers rather than one only where the two can differ. A building that names its own
 * stairwell has named the asset for every stairwell tile in it, mirrored or not; it is the
 * fallback that `e_l` chooses between, and a mod is free to define one of that pair and
 * not the other.
 */
export async function stairwellElevators(contentFolder, preset) {
    const named = await stairwellPresetName(preset);

    if (named) {
        const carries = await featuresElevator(contentFolder, named);
        return { plain: carries, inverted: carries };
    }

    return {
        plain: await featuresElevator(contentFolder, DEFAULT_STAIRWELL),
        inverted: await featuresElevator(contentFolder, DEFAULT_STAIRWELL_INVERTED),
    };
}

/**
 * The StairwellPreset a building names, or null when it names none.
 *
 * The two shapes this file exists to reconcile, again. A mod's preset holds
 * `REF:StairwellPreset|MarbleStairwellElevator`; a dumped one holds the Unity reference
 * `{m_FileID: 18034, m_PathID: 0}`, which is a position in the game's asset files and says
 * nothing until it is looked up. `m_FileID: 0` is Unity's "no reference at all", and is
 * what 13 of the 15 buildings shipped here hold.
 *
 * An id that names something other than a stairwell, or nothing at all, is treated as
 * unset. It is not a name this can use, and guessing at one would put a preset in the tile
 * that the game never places there.
 *
 * The path id map is reached for only when there is an id to look up, which is what keeps
 * 1.6 MB of generated JSON out of the ordinary case: 13 of the 15 buildings shipped here
 * name no stairwell at all, and a mod's own preset names one in words. See
 * core/baseAssets.js.
 */
async function stairwellPresetName(preset) {
    const reference = preset?.stairwellRegular;
    if (!reference) return null;

    if (typeof reference === 'string') return refName(reference);
    if (!reference.m_FileID) return null;

    const asset = (await pathIdMap())[String(reference.m_FileID)];
    return asset?.startsWith(`${STAIRWELL_TYPE}|`) ? asset.slice(STAIRWELL_TYPE.length + 1) : null;
}

/**
 * Whether one named StairwellPreset carries a lift.
 *
 * Only the mod's own file is read. The base game's stairwells are not shipped with this
 * tool and do not need to be: every one of them says true, which is what a name with no
 * file behind it answers. A mod file that says nothing about the field answers true as
 * well -- a preset written with `copyFrom` and no opinion has not turned anything off.
 */
async function featuresElevator(contentFolder, name) {
    if (!contentFolder || !name) return true;

    const found = await findPresetFile(contentFolder, name, STAIRWELL_TYPE);
    const preset = found ? await readJson(found.handle) : null;

    // The bare file name is a name with no type in it, so a mod holding
    // `WoodenStairwellElevator.sodso.json` for something else entirely would be read here
    // as a stairwell. What the file says it is settles it.
    const isStairwell = preset?.fileType === STAIRWELL_TYPE || preset?.type === STAIRWELL_TYPE;

    return !isStairwell || preset.featuresElevator !== false;
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

    // The first floor of the setting being read. A setting is not a floor: it says "the
    // next N floors look like this", so the one after a setting covering four floors is
    // four floors further up. Counting the settings instead named a twelve storey
    // building's top floor Floor 7.
    let first = isBasement ? FIRST_BASEMENT : 0;

    // The shipped dumps always write the list, empty or not. A mod preset need not:
    // writing a stub drops any list still at its default, so a building copied from
    // another and never given basements has no basementLayouts field at all.
    (layouts ?? []).forEach((layout, layoutIndex) => {
        // Read as readFootprints reads it, so the numbering agrees with the building the
        // mesh is built from: a setting still puts one floor in the building when the
        // count is 0 or missing.
        const covers = Math.max(1, layout?.floorsWithThisSetting ?? 1);
        const storeyLabel = storeyName(isBasement, first, covers);
        first += covers;

        for (const isControlVariant of [false, true]) {
            const blueprints = isControlVariant ? layout?.controlRoomVariants : layout?.blueprints;

            (blueprints ?? []).forEach((blueprint, blueprintIndex) => {
                options.push({
                    slot: { isBasement, isControlVariant, layoutIndex, blueprintIndex },
                    // Which floors of the building this slot is one layout of, worked out
                    // here because this is where the preset is: storeysOf is handed slots
                    // and has no setting to count from.
                    storeyLabel,
                    label: slotLabel(
                        storeyLabel, blueprintIndex,
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
 *
 * A storey is named by the floors of the building it covers rather than by its place in
 * the setting list, which is `storeyLabel` on the slots enumerateSlots produced. See
 * storeyName.
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
                label: option.storeyLabel,
                options: [],
            });
        }

        byKey.get(key).options.push(option);
    }

    return [...byKey.values()].sort((a, b) => height(a) - height(b));
}

/**
 * Where a storey sits in the building, for ordering: basementLayouts[0] is one below
 * floorLayouts[0]. The settings run in the same order as the floors they cover, so
 * counting settings orders them as counting floors would.
 */
const height = (storey) => (storey.isBasement ? -(storey.layoutIndex + 1) : storey.layoutIndex);

/**
 * The storey a newly added one would sit against, or null for the first storey of all.
 *
 * A floor is added to the top of the building and a basement to the bottom -- that is
 * what appending to floorLayouts and to basementLayouts means -- so the storey a new one
 * touches is the topmost or the deepest the building already has. Storeys come lowest
 * first, so it is one end of the list or the other.
 *
 * Both ends of the same list, deliberately: a building with basements and no floors gets
 * its first floor laid against the basement directly under it, which is where the shape
 * of that building is recorded. "Floors above" and "basements below" are one stack.
 */
export function adjoiningStorey(storeys, { isBasement = false } = {}) {
    if (!storeys?.length) return null;
    return isBasement ? storeys[0] : storeys[storeys.length - 1];
}

/**
 * The blueprint a storey's layout is read from: the first ordinary one in it.
 *
 * The blueprints in a storey are alternative layouts of it that the game picks between,
 * and they are alternatives of the *same* storey -- so any of them says where that
 * storey's walls are, and the first is as good an answer as the last. A control room
 * variant is the same layout again with a control room in it, so it is only reached for
 * when a storey somehow holds nothing else.
 */
export function firstLayoutOf(storey) {
    const options = storey?.options ?? [];
    const chosen = options.find((option) => !option.slot.isControlVariant) ?? options[0];
    return chosen?.blueprint || null;
}

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

function slotLabel(storeyLabel, blueprintIndex, count, isControlVariant) {
    let label = storeyLabel;
    if (count > 1) label += ` v${blueprintIndex}`;
    if (isControlVariant) label += ' (control)';
    return label;
}

/** Basement 1 is the first below the ground floor: the floor in basement 0's place is Floor 0. */
const FIRST_BASEMENT = 1;

/**
 * What the floors one setting covers are called.
 *
 * A range where the setting covers more than one -- "Floors 5–8" -- because a setting is
 * a run of floors and not a floor. Naming it by the first alone would leave the list
 * skipping from Floor 5 to Floor 9 with nothing saying where 6, 7 and 8 went.
 */
function storeyName(isBasement, first, covers) {
    const word = isBasement ? 'Basement' : 'Floor';
    return covers > 1 ? `${word}s ${first}–${first + covers - 1}` : `${word} ${first}`;
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
 *
 * A building the mod already holds goes back into the file it came out of, under whatever
 * name that file has. Only a building reaching the folder for the first time is named
 * here, and it is named with its type. Moving an existing one would mean renaming its
 * manifest entry to match, over a save the author asked nothing of -- and a mod whose
 * files move when it is opened is worse than a mod with two naming conventions in it.
 */
export async function writeCustomPreset(contentFolder, name, preset, { alsoWritten = [] } = {}) {
    const written = pointAtModFloors(
        withoutDefaults(preset, alsoWritten),
        new Set(await listCustomBlueprints(contentFolder)));

    const existing = await findPresetFile(contentFolder, name);
    const fileName = existing?.fileName ?? fileNameFor(name, BUILDING_TYPE);

    const handle = existing?.handle ?? await getFile(contentFolder, [fileName], true);
    await writeFile(handle, `${JSON.stringify(written, null, 2)}\n`);

    // The manifest lists files, so it is the file's name that goes in it.
    await ensureListed(contentFolder, fileName.slice(0, -PRESET_SUFFIX.length));

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
