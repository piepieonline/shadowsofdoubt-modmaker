/**
 * Reference data lives at the repo root in refs/, not in this flow: ddsContentIndex is
 * read by both flows, and keeping a copy per flow is what let the two drift apart.
 * See refs/README.md for what each file is and who writes it.
 */
import soDefaults from '../../../refs/generated/soDefaults.json' with { type: 'json' };
import soAssetsByType from '../../../refs/generated/soAssetsByType.json' with { type: 'json' };
import ddsContentIndex from '../../../refs/generated/ddsContentIndex.json' with { type: 'json' };
import soPathIds from '../../../refs/generated/soPathIds.json' with { type: 'json' };

import fieldDescriptions from '../../../refs/authored/fieldDescriptions.json' with { type: 'json' };

// The type layout and the enums are shared with the DDS flow, and composed there so the
// two cannot disagree about what a type is. See core/refs.js.
import { enums, typeLayout as gameTypeLayout } from '../../../core/refs.js';

import onlineTypes from '../../../refs/assets/index.json' with { type: 'json' };

/**
 * Built at module scope, published by the default export below: the registry installs
 * the flow's globals on every activation, because a module body runs only once.
 * See the loadRefs note in core/flowRegistry.js.
 */
const templates = {
    MurderManifest: {
        enabled: true,
        fileOrder: [],
        loadBefore: "",
        version: 1
    },
    "AnimationCurve.Keyframe": {
        inTangent: 0,
        inWeight: 0,
        outTangents: 0,
        outWeight: 0,
        time: 0,
        value: 0,
        weightedMode: 0
    },
    ...soDefaults
};

const typeMap = {
    ...soAssetsByType
};

/** The game's types, plus the manifest file, which is this tool's rather than the game's. */
const typeLayout = {
    Manifest: {
        fileOrder: {
            "Item1": "FileType", // Type of the field
            "Item2": true, // Is it an array?
            "Item3": "Files need to be loaded before they are used, so your MurderMO should generally be the last file in the list" // Description
        },
        loadBefore: {
            "Item1": "String", 
            "Item2": false,
            "Item3": "Should we wait for this manifest to have loaded before we start loading?"
        }
    },
    ...gameTypeLayout
};

const basicTypeTemplates = {
    Int32: 0,
    Single: 0,
    Boolean: false,
    String: "",
    Vector2: { x: 0, y: 0 },
    Vector3: { x: 0, y: 0, z: 0 },
    Color: { r: 0, g: 0, b: 0, a: 0 }
};

const pathIdMap = Object.keys(soPathIds).reduce((map, val) => {
    map[val] = soPathIds[val][0];
    return map;
}, {});

const ddsMap = {
    trees: ddsContentIndex.Trees,
    messages: ddsContentIndex.Messages,
    blocks: ddsContentIndex.Blocks
};

// updateAssetModel() moved to main.js: a data module should not drive the UI,
// and it has to run after main.js publishes the global surface.

export default {
    onlineTypes,
    templates,
    typeMap,
    enums,
    typeLayout,
    basicTypeTemplates,
    pathIdMap,
    fieldDescriptions,
    ddsMap,
};
