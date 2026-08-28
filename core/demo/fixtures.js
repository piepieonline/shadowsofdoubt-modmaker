/**
 * The content demo mode runs on.
 *
 * A plugins folder and a StreamingAssets folder, small enough to read in one sitting and
 * shaped like the real thing: three mods, one of which holds a case and its DDS text,
 * one of which is a building, and one of which holds nothing editable at all. That last
 * one is not padding -- loaders and utilities are most of a real plugins folder, and
 * "Nothing editable in this mod" is a state worth being able to see.
 *
 * Paths are relative to the demo root and are seeded into the Origin Private File System
 * (see demoMode.js), so nothing here ever reaches a real folder.
 *
 * A key ending in `/` is a directory to create rather than a file. `Floors/` is the
 * marker that makes a folder a building mod, and a building mod that has not saved a
 * floor yet has an empty one -- there is no file to imply it into existence.
 *
 * **The base game content below is invented.** The GUIDs and names are real ones taken
 * from `refs/generated/ddsContentIndex.json`, so the Browse list names them correctly and
 * the type lookup recognises them, but the documents are written here rather than dumped
 * from the game. Demo mode does not read a Shadows of Doubt install, so there is nothing
 * else they could be.
 */

/* -------------------------------------------------------------------------- */
/* Base game content                                                           */
/* -------------------------------------------------------------------------- */

/** A real advert tree, its message and its block. See the note above. */
export const DEMO_TREE_GUID = 'b6680143-76f0-4225-9f13-4be2ea203427';
export const DEMO_MESSAGE_GUID = '1e7022d9-5f91-4a6c-bf56-cb7ee4466ad2';
export const DEMO_BLOCK_GUID = '0024b9b0-a1e3-4d05-92c7-00d859985022';

/** The mod's own DDS content, which no reference data knows about. */
export const DEMO_MOD_TREE_GUID = '7f3a1c20-9d44-4b18-9a61-2c8e5f0b7d13';
export const DEMO_MOD_MESSAGE_GUID = '1b4e77c9-6a02-45d7-8f33-9e21c4a60b58';
export const DEMO_MOD_BLOCK_GUID = 'c2d0e841-3f76-4a95-b0c7-58ad916e2f04';
export const DEMO_REPLACEMENT_GUID = '9a58b0d3-72e1-4c46-8b29-4f0d63a51e77';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * A strings CSV.
 *
 * Three textless lines first, because the game's own files open with three and
 * parseStringsCsv holds back leading rows with nothing in the text column. A row is
 * `key,,text,,,,edited` -- seven fields, which is the least loadI18n will look at.
 */
const csv = (rows) => [
    'SHADOWS OF DOUBT STRING TABLE,,,,,,',
    ',,,,,,',
    ',,,,,,',
    ...rows.map(([key, text]) => `"${key}",,"${text}",,,,09:00 01/01/2024`),
].join('\n');

const streamingAssets = {
    'StreamingAssets/Strings/English/DDS/dds.blocks.csv': csv([
        [DEMO_BLOCK_GUID, 'Grab a Starch. Grab a moment.'],
    ]),

    [`StreamingAssets/DDS/Trees/${DEMO_TREE_GUID}.tree`]: json({
        id: DEMO_TREE_GUID,
        name: 'Ad_Starch',
        treeType: 1,
        priority: 3,
        startingMessage: 'ad-starch-open',
        messages: [
            { msgID: DEMO_MESSAGE_GUID, instanceID: 'ad-starch-open', order: 0 },
        ],
    }),

    [`StreamingAssets/DDS/Messages/${DEMO_MESSAGE_GUID}.msg`]: json({
        id: DEMO_MESSAGE_GUID,
        name: 'Ad_Starch02',
        blocks: [
            { blockID: DEMO_BLOCK_GUID, instanceID: 'ad-starch-line', alwaysDisplay: true },
        ],
    }),

    [`StreamingAssets/DDS/Blocks/${DEMO_BLOCK_GUID}.block`]: json({
        id: DEMO_BLOCK_GUID,
        name: 'Grab_a_Starch',
        replacements: [],
    }),
};

/* -------------------------------------------------------------------------- */
/* A case mod, with the DDS text that goes with it                             */
/* -------------------------------------------------------------------------- */

const CASE_MOD = 'NeonNoir';
const CASE_CONTENT = 'plugins/NeonNoirCase';
const CASE_ROOT = `Plugins/${CASE_MOD}/${CASE_CONTENT}`;

const caseMod = {
    // Mods ship a dll beside their content, and it is what makes the mod root itself
    // not a content folder -- the search has to walk past it.
    [`Plugins/${CASE_MOD}/${CASE_MOD}.dll`]: 'not a real assembly',

    [`${CASE_ROOT}/murdermanifest.sodso.json`]: json({
        enabled: true,
        fileOrder: ['REF:NeonNoirMurder'],
        loadBefore: '',
        version: 1,
    }),

    [`${CASE_ROOT}/NeonNoirMurder.sodso.json`]: json({
        fileType: 'MurderMO',
        name: 'NeonNoirMurder',
        presetName: 'NeonNoirMurder',
        notes: 'A demo case. Nothing here is written to disk.',
        baseDifficulty: 2,
        MOleads: [
            { chance: 0.5, traitModifiers: [{ mustPassForApplication: true }] },
        ],
    }),

    [`${CASE_ROOT}/IP_Matchbook.sodso.json`]: json({
        fileType: 'InteractablePreset',
        name: 'IP_Matchbook',
        presetName: 'IP_Matchbook',
        spawnable: true,
        autoName: true,
    }),

    // The mod's own conversation: a tree, its message, its block.
    [`${CASE_ROOT}/DDSContent/DDS/Trees/${DEMO_MOD_TREE_GUID}.tree`]: json({
        id: DEMO_MOD_TREE_GUID,
        name: 'NeonNoir_Doorman',
        treeType: 1,
        priority: 5,
        startingMessage: 'doorman-open',
        messages: [
            { msgID: DEMO_MOD_MESSAGE_GUID, instanceID: 'doorman-open', order: 0 },
        ],
    }),

    [`${CASE_ROOT}/DDSContent/DDS/Messages/${DEMO_MOD_MESSAGE_GUID}.msg`]: json({
        id: DEMO_MOD_MESSAGE_GUID,
        name: 'NeonNoir_DoormanGreeting',
        blocks: [
            { blockID: DEMO_MOD_BLOCK_GUID, instanceID: 'doorman-line', alwaysDisplay: true },
        ],
    }),

    [`${CASE_ROOT}/DDSContent/DDS/Blocks/${DEMO_MOD_BLOCK_GUID}.block`]: json({
        id: DEMO_MOD_BLOCK_GUID,
        name: 'NeonNoir_DoormanLine',
        replacements: [
            { replaceWithID: DEMO_REPLACEMENT_GUID, chance: 1 },
        ],
    }),

    // An override of base game content, which is the interesting half of what the file
    // panel shows: nothing else in the app says which vanilla content a mod changes.
    [`${CASE_ROOT}/DDSContent/DDS/Trees/${DEMO_TREE_GUID}.tree_patch`]:
        json([{ op: 'replace', path: '/priority', value: 7 }]),

    [`${CASE_ROOT}/DDSContent/Strings/English/DDS/dds.blocks.csv`]: csv([
        [DEMO_MOD_BLOCK_GUID, 'Members only, friend. You on the list?'],
        [DEMO_REPLACEMENT_GUID, 'Not tonight, you are not.'],
    ]),

    // Strings are not only DDS text: room and building names live in files of their own.
    [`${CASE_ROOT}/DDSContent/Strings/English/names.rooms.csv`]: csv([
        ['NeonNoirBackRoom', 'The Back Room'],
        ['NeonNoirTower', 'Neon Noir Tower'],
    ]),

    // A building in the same folder as the case. Real mods do this -- the three markers
    // compose -- and it is what makes one selection serve every flow: switching editors
    // keeps the content folder, on purpose, because a folder holds a case and its DDS
    // text and its floors together. See core/navigation.js.
    [`${CASE_ROOT}/NeonNoirTower.sodso.json`]: buildingStub('NeonNoirTower', 'Neon Noir Tower'),
    [`${CASE_ROOT}/Floors/`]: null,
};

/* -------------------------------------------------------------------------- */
/* A building mod                                                              */
/* -------------------------------------------------------------------------- */

const BUILDING_MOD = 'RooftopBar';

/**
 * A stub of a base game building: its floor list, and an instruction to take everything
 * else from the original. The blueprints it names ship with the app under refs/floors,
 * so opening a floor needs no mod file and no game install.
 *
 * Written the way buildingLibrary.js writes one -- no default-valued fields, because
 * under `copyFrom` writing a default overwrites rather than doing nothing. A floor
 * setting is spelled out in full because that is a value in its own right, not a default.
 */
function buildingStub(presetName, title) {
    const setting = (blueprint, airVentMaximumExtrusion) => ({
        floorsWithThisSetting: 1,
        blueprints: [blueprint],
        airVentMaximumExtrusion,
        controlRoomVariants: [],
        forceShowModel: false,
        forceHideModels: [],
        forceHideModelsInRooms: [],
        forceHideModelsOutside: [],
        overrideCeilingHeight: false,
        newCeilingHeight: 51,
    });

    return json({
        name: title,
        presetName,
        type: 'BuildingPreset',
        fileType: 'BuildingPreset',
        copyFrom: 'REF:BuildingPreset|AmericanDiner',
        floorLayouts: [setting('DinerFloorBeta', 0), setting('DinerRooftop', 1)],
    });
}

/** A second mod, holding a building and nothing else. */
const buildingMod = {
    [`Plugins/${BUILDING_MOD}/${BUILDING_MOD}.sodso.json`]:
        buildingStub(BUILDING_MOD, 'Rooftop Bar'),

    // Empty, and deliberately so: this mod has not saved a floor of its own yet, so the
    // directory is the only thing marking it as a building mod.
    [`Plugins/${BUILDING_MOD}/Floors/`]: null,
};

/* -------------------------------------------------------------------------- */

/** A loader with nothing to edit, which most of a real plugins folder looks like. */
const utilityMod = {
    'Plugins/ExampleLoader/ExampleLoader.dll': 'not a real assembly',
    'Plugins/ExampleLoader/config/settings.cfg': 'enabled = true',
};

/** Every path demo mode seeds, relative to the demo root. */
export const demoFiles = {
    ...streamingAssets,
    ...caseMod,
    ...buildingMod,
    ...utilityMod,
};

/** The two folders the app is handed, as paths below the demo root. */
export const DEMO_STREAMING_ASSETS = 'StreamingAssets';
export const DEMO_PLUGINS = 'Plugins';

/**
 * What to open on arrival, so demo mode lands in a populated editor rather than in the
 * empty state you would get by connecting folders and choosing nothing.
 *
 * One selection rather than one per flow, because this folder holds all three kinds of
 * content -- which is also why switching editors needs no help from demo mode. It is
 * only where you start; every mod and folder is still selectable by hand.
 */
export const DEMO_SELECTION = { modName: CASE_MOD, contentPath: CASE_CONTENT };
