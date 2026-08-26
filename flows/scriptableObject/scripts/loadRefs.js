/**
 * Reference data lives at the repo root in refs/, not in this flow: ddsContentIndex is
 * read by both flows, and keeping a copy per flow is what let the two drift apart.
 * See refs/README.md for what each file is and who writes it.
 */
import soDefaults from '../../../refs/generated/soDefaults.json' with { type: 'json' };
import soTypeLayout from '../../../refs/generated/soTypeLayout.json' with { type: 'json' };
import soAssetsByType from '../../../refs/generated/soAssetsByType.json' with { type: 'json' };
import soEnums from '../../../refs/generated/soEnums.json' with { type: 'json' };
import ddsContentIndex from '../../../refs/generated/ddsContentIndex.json' with { type: 'json' };
import soPathIds from '../../../refs/generated/soPathIds.json' with { type: 'json' };

import soCustomDescriptions from '../../../refs/authored/soFieldDescriptions.json' with { type: 'json' };

import onlineTypes from '../../../refs/assets/index.json' with { type: 'json' };

/**
 * Built at module scope, published by the default export below: the registry installs
 * the flow's globals on every activation, because a module body runs only once.
 * See the loadRefs note in core/flowRegistry.js.
 */
const basicTypeLayouts = {
    Vector2: {
        x: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        y: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        }
    },
    Vector2Int: {
        x: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        y: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        }
    },
    Vector3: {
        x: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        y: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        z: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        }
    },
    Vector3Int: {
        x: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        y: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        z: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        }
    },
    Color: {
        r: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        g: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        b: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        a: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        }
    },
    AnimationCurve: {
        serializedVersion: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        m_Curve: {
            "Item1": "AnimationCurve.Keyframe",
            "Item2": true,
            "Item3": ""
        },
        m_PreInfinity: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        m_PostInfinity: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        m_RotationOrder: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        }
    },
    "AnimationCurve.Keyframe": {
        inTangent: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        inWeight: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        outTangent: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        outWeight: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        time: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        value: {
            "Item1": "Single",
            "Item2": false,
            "Item3": ""
        },
        weightedMode: {
            "Item1": "WeightedMode",
            "Item2": false,
            "Item3": ""
        },
    }
};

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

const enums = {
    Boolean: [
        'false',
        'true'
    ],
    WeightedMode: [
        'None',
        'In',
        'Out',
        'Both'
    ],
    ...soEnums
};

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
    ...basicTypeLayouts,
    ...soTypeLayout
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
    basicTypeLayouts,
    templates,
    typeMap,
    enums,
    typeLayout,
    basicTypeTemplates,
    pathIdMap,
    soCustomDescriptions,
    ddsMap,
};
