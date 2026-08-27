/**
 * Reference data lives at the repo root in refs/, not in this flow. See refs/README.md
 * for what each file is and who writes it.
 *
 * What this flow needs beyond the shared type layout is four lists of names and two
 * index-addressed tables. The two tables are the ones to be careful with: a floor
 * blueprint stores every wall as the *string form* of an index into `soDoorPairIds`, so
 * reordering it does not change what a field means -- it rewrites every wall in every
 * floor anyone has authored.
 *
 * The floors themselves are not here. They are 5 MB across 108 files and are fetched a
 * file at a time by buildingLibrary.js, in the same way refs/assets/ is.
 */
import soAssetsByType from '../../../refs/generated/soAssetsByType.json' with { type: 'json' };
import soDoorPairIds from '../../../refs/generated/soDoorPairIds.json' with { type: 'json' };

import wallPresetKinds from '../../../refs/authored/wallPresetKinds.json' with { type: 'json' };
import fieldDescriptions from '../../../refs/authored/fieldDescriptions.json' with { type: 'json' };

// Shared with the other two flows and composed in one place, so they cannot disagree
// about what a type is. See core/refs.js.
import { enums, typeLayout } from '../../../core/refs.js';

/**
 * The wall presets that can be chosen, in the game's own index order.
 *
 * Ids the table has no name for are dropped rather than shown as a number. Three exist
 * -- 28 to 30, which the reference tool calls Unknown01 to 03 -- and the 27 names that
 * *are* known are exactly the 27 DoorPairPreset assets the game has, so those three
 * name nothing. A floor referring to one still reads and writes; it just cannot be
 * picked from a list.
 */
const wallPresets = Object.entries(soDoorPairIds)
    .filter(([, name]) => !!name)
    .map(([id, name]) => ({ id, name, kind: wallPresetKinds[id] ?? 'wall' }));

/**
 * The flow's reference data, returned rather than assigned to window: the registry
 * installs it on every activation. See the loadRefs note in core/flowRegistry.js.
 */
export default {
    typeMap: soAssetsByType,
    typeLayout,
    enums,
    fieldDescriptions,

    doorPairIds: soDoorPairIds,
    wallPresetKinds,
    wallPresets,

    // The name lists the panels offer. All four are the game's own assets, so a floor
    // naming something absent from them is a floor the game will not load.
    layoutConfigurations: soAssetsByType.LayoutConfiguration ?? [],
    roomTypePresets: soAssetsByType.RoomTypePreset ?? [],
    buildingPresets: soAssetsByType.BuildingPreset ?? [],
    floorTileTypes: enums.FloorTileType ?? [],
};
