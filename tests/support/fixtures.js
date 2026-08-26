/**
 * Minimal fixture content for both flows.
 *
 * GUIDs must satisfy the apps' strict pattern (see GUID_PATTERN):
 *   ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
 * i.e. a real UUID version nibble (1-5) and variant nibble (8/9/a/b). Naive
 * placeholder GUIDs like all-zeroes are rejected and the app alerts instead of loading.
 */
export const TREE_GUID = '11111111-1111-4111-8111-111111111111';
export const MSG_GUID = '22222222-2222-4222-8222-222222222222';
export const BLOCK_GUID = '33333333-3333-4333-8333-333333333333';

export const BLOCK_TEXT = 'Hello from the test block';

/** A second message on the test tree, so a hand-picked level differs from the cascade. */
export const MSG2_GUID = '66666666-6666-4666-8666-666666666666';

// A newspaper tree (treeType 3). Messages under one of these get an extra dummy key
// and trigger creation of a companion .newspaper file in the mod.
export const NEWS_TREE_GUID = '44444444-4444-4444-8444-444444444444';
export const NEWS_MSG_GUID = '55555555-5555-4555-8555-555555555555';

const json = (o) => JSON.stringify(o, null, 2);

// getStreamingAssetsDir() drops the first 3 lines as headers; loadI18n() requires
// at least 7 comma-separated fields per line and reads guid=[0], message=[2].
const ddsBlocksCsv = [
    'BLOCK CSV HEADER 1,,,,,,',
    'BLOCK CSV HEADER 2,,,,,,',
    'BLOCK CSV HEADER 3,,,,,,',
    `${BLOCK_GUID},,${BLOCK_TEXT},,,,09:00 01/01/2024`,
].join('\n');

/** Vanilla game content, mounted as the StreamingAssets directory. */
export const streamingAssets = {
    'StreamingAssets/Strings/English/DDS/dds.blocks.csv': ddsBlocksCsv,

    [`StreamingAssets/DDS/Trees/${TREE_GUID}.tree`]: json({
        id: TREE_GUID,
        name: 'TestTree',
        treeType: 1,
        // A nested object that runTreeSetup does not auto-expand, so tests can
        // expand it themselves and check it survives a tree rebuild.
        document: { background: '', fill: 1 },
        priority: 3,
        startingMessage: 'instance-1',
        messages: [
            { msgID: MSG_GUID, instanceID: 'instance-1', order: 0 },
            // Cascading opens the first; picking this one is a different state.
            { msgID: MSG2_GUID, instanceID: 'instance-1b', order: 1 },
        ],
    }),

    [`StreamingAssets/DDS/Messages/${MSG2_GUID}.msg`]: json({
        id: MSG2_GUID,
        name: 'SecondMessage',
        blocks: [],
    }),

    [`StreamingAssets/DDS/Messages/${MSG_GUID}.msg`]: json({
        id: MSG_GUID,
        name: 'TestMessage',
        blocks: [{ blockID: BLOCK_GUID, instanceID: 'instance-2', alwaysDisplay: true }],
    }),

    [`StreamingAssets/DDS/Trees/${NEWS_TREE_GUID}.tree`]: json({
        id: NEWS_TREE_GUID,
        name: 'TestNewspaper',
        treeType: 3,
        messages: [{ msgID: NEWS_MSG_GUID, instanceID: 'instance-3', order: 0 }],
    }),

    [`StreamingAssets/DDS/Messages/${NEWS_MSG_GUID}.msg`]: json({
        id: NEWS_MSG_GUID,
        name: 'TestNewspaperMessage',
        blocks: [],
    }),

    [`StreamingAssets/DDS/Blocks/${BLOCK_GUID}.block`]: json({
        id: BLOCK_GUID,
        name: 'TestBlock',
        replacements: [],
    }),
};

/**
 * A plugins folder holding one DDS mod. The content folder sits one level inside the
 * mod, which is the commonest real arrangement.
 */
export const ddsModDir = {
    'Mods/TestMod/Content/DDSContent/DDS/Trees/.keep': '',
    'Mods/TestMod/Content/DDSContent/DDS/Messages/.keep': '',
    'Mods/TestMod/Content/DDSContent/DDS/Blocks/.keep': '',
    'Mods/TestMod/Content/DDSContent/Strings/English/DDS/.keep': '',
};

/** A mod parent folder containing one case, as the ScriptableObject flow expects. */
export const soModDir = {
    'Mods/TestCase/murdermanifest.sodso.json': json({
        enabled: true,
        fileOrder: ['REF:testcase'],
        loadBefore: '',
        version: 1,
    }),
    'Mods/TestCase/testcase.sodso.json': json({
        fileType: 'MurderMO',
        name: 'testcase',
        presetName: 'testcase',
        notes: 'fixture',
        copyFrom: null,
        // Not a real MurderMO field. Present so tests have something expandable,
        // which is what the edit loop's expanded-path restoration operates on.
        nested: { alpha: 'a', beta: 'b' },
    }),
};

/**
 * A mod's own DDS content: files it adds, a patch overriding base game content, and
 * the strings its blocks resolve against.
 */
export const ddsModContent = {
    'Mods/TestMod/Content/DDSContent/DDS/Trees/aaaaaaaa-1111-4111-8111-111111111111.tree':
        json({ id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'ModTree', messages: [] }),
    'Mods/TestMod/Content/DDSContent/DDS/Messages/bbbbbbbb-2222-4222-8222-222222222222.msg':
        json({ id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'ModMessage', blocks: [] }),
    'Mods/TestMod/Content/DDSContent/DDS/Blocks/cccccccc-3333-4333-8333-333333333333.block':
        json({ id: 'cccccccc-3333-4333-8333-333333333333', name: 'ModBlock', replacements: [] }),

    // An override of base game content. Only a diff, so its name comes from the
    // generated reference data rather than from the file.
    [`Mods/TestMod/Content/DDSContent/DDS/Trees/${TREE_GUID}.tree_patch`]:
        json([{ op: 'replace', path: '/name', value: 'Patched' }]),

    'Mods/TestMod/Content/DDSContent/Strings/English/DDS/dds.blocks.csv': [
        'HEADER 1,,,,,,',
        'HEADER 2,,,,,,',
        'HEADER 3,,,,,,',
        'cccccccc-3333-4333-8333-333333333333,,Text for the mod block,,,,09:00 01/01/2024',
        'dddddddd-4444-4444-8444-444444444444,,A replacement string,,,,09:00 01/01/2024',
    ].join('\n'),

    // Strings are not only DDS text. Other names live in files of their own, some
    // under a folder for what they name and some directly under the language.
    'Mods/TestMod/Content/DDSContent/Strings/English/Evidence/evidence.names.csv':
        'ModEvidence,,A mod evidence name,,,,09:00 01/01/2024',
    'Mods/TestMod/Content/DDSContent/Strings/English/names.rooms.csv':
        'ModRoom,,A mod room name,,,,09:00 01/01/2024',
};

/**
 * A mod whose block text is quoted the way the game's own CSVs are.
 *
 * The base game writes `"guid",,"text",...`, and a mod that began as a copy of one --
 * or was written by hand to match -- has its rows in that shape. Nothing the app writes
 * is quoted, so this is the file it fails to recognise its own rows in.
 */
export const ddsQuotedStringsFixture = {
    ...streamingAssets,
    ...ddsModDir,
    ...ddsModContent,
    'Mods/TestMod/Content/DDSContent/Strings/English/DDS/dds.blocks.csv': [
        '"HEADER 1",,,,,,',
        // A column the app has no view on, and must therefore leave alone.
        `"${BLOCK_GUID}",,"An existing quoted line",,KEEP-ME,,09:00 01/01/2024`,
        // A neighbour whose text holds a comma, which is what its quotes are for.
        '"dddddddd-4444-4444-8444-444444444444",,"Wait, listen to me",,,,09:00 01/01/2024',
    ].join('\n'),
};

export const ddsFixture = { ...streamingAssets, ...ddsModDir };
export const ddsFixtureWithContent = { ...ddsFixture, ...ddsModContent };
export const soFixture = { ...soModDir };

/**
 * A mod laid out the way a ddsmanifest allows: a flat DDSContent whose CSVs are given
 * the paths the game reads them from, with no Strings tree at all. Modelled on
 * PiesVanillaRemix/plugins/BookcaseOffice, including its depth below the mod.
 */
const FLAT = 'Mods/FlatMod/plugins/BookcaseOffice/DDSContent';

export const FLAT_MOD = { mod: 'FlatMod', content: 'plugins/BookcaseOffice' };

const flatBlocksCsv = [
    'HEADER 1,,,,,,',
    'HEADER 2,,,,,,',
    'HEADER 3,,,,,,',
    `${BLOCK_GUID},,Text from the flat mod,,,,09:00 01/01/2024`,
].join('\n');

const flatFiles = {
    [`${FLAT}/DDS/Blocks/.keep`]: '',
    [`${FLAT}/jobs.csv`]: 'FlatJob,,A flat mod job,,,,09:00 01/01/2024',
};

const flatManifest = (files) => ({ [`${FLAT}/ddsmanifest.json`]: json({ enabled: true, files }) });

/** Every CSV mapped, block text included: the case BookcaseOffice itself is in. */
export const ddsManifestFixture = {
    ...streamingAssets,
    ...flatFiles,
    [`${FLAT}/dds.blocks.csv`]: flatBlocksCsv,
    ...flatManifest({
        'jobs.csv': 'Strings/English/Citizens',
        'dds.blocks.csv': 'Strings/English/DDS',
    }),
};

/** The same mod before it has any block text of its own. */
export const ddsManifestNoBlocksFixture = {
    ...streamingAssets,
    ...flatFiles,
    ...flatManifest({ 'jobs.csv': 'Strings/English/Citizens' }),
};

/**
 * A manifest naming a file the mod has not written yet.
 *
 * The file list is built from disk, so this entry appears only in the manifest panel --
 * which is the one place a declared-but-absent file can be opened from.
 */
export const ddsManifestMissingFileFixture = {
    ...streamingAssets,
    ...flatFiles,
    [`${FLAT}/dds.blocks.csv`]: flatBlocksCsv,
    ...flatManifest({
        'jobs.csv': 'Strings/English/Citizens',
        'dds.blocks.csv': 'Strings/English/DDS',
        'names.rooms.csv': 'Strings/English',
    }),
};

/** Block text declared, and not written yet: the file exists only in the manifest. */
export const ddsManifestBlocksDeclaredFixture = {
    ...streamingAssets,
    ...flatFiles,
    ...flatManifest({
        'jobs.csv': 'Strings/English/Citizens',
        'dds.blocks.csv': 'Strings/English/DDS',
    }),
};

/** Entries in two different folders, so there is no convention to copy. */
export const ddsManifestMixedFixture = {
    ...streamingAssets,
    [`${FLAT}/DDS/Blocks/.keep`]: '',
    [`${FLAT}/csv/jobs.csv`]: 'FlatJob,,A flat mod job,,,,09:00 01/01/2024',
    [`${FLAT}/other/names.rooms.csv`]: 'FlatRoom,,A flat mod room,,,,09:00 01/01/2024',
    ...flatManifest({
        'csv/jobs.csv': 'Strings/English/Citizens',
        'other/names.rooms.csv': 'Strings/English',
    }),
};

/** A manifest that cannot be parsed. The mod still has to be editable. */
export const ddsManifestBrokenFixture = {
    ...streamingAssets,
    ...flatFiles,
    [`${FLAT}/dds.blocks.csv`]: flatBlocksCsv,
    [`${FLAT}/ddsmanifest.json`]: '{ "enabled": true, "files"',
};

/** A mod with nothing scaffolded, to pin what selection does and does not create. */
export const ddsBareFixture = {
    ...streamingAssets,
    'Mods/BareMod/Content/DDSContent/.keep': '',
};


/**
 * A BepInEx plugins folder, shaped like a real one.
 *
 * Every content-folder placement below occurs in an actual install: the mod root
 * itself, a direct subfolder, under the BepInEx plugins/ convention, and deeper
 * again. Some mods hold several, some hold only DDS content, and utility mods hold
 * none at all.
 */
const manifest = (order) => json({ enabled: true, fileOrder: order, loadBefore: '', version: 1 });

export const pluginsFixture = {
    // Mod root is itself the content folder.
    'Plugins/DartTowerTest/murdermanifest.sodso.json': manifest(['REF:darttower']),
    'Plugins/DartTowerTest/darttower.sodso.json': json({ fileType: 'MurderMO', name: 'darttower' }),
    'Plugins/DartTowerTest/DDSContent/DDS/Blocks/.keep': '',

    // Several content folders as direct subfolders; one has no DDS content.
    'Plugins/AdditionalEvidence/AdditionalEvidence.dll': 'binary',
    'Plugins/AdditionalEvidence/BinPasscodes/murdermanifest.sodso.json': manifest([]),
    'Plugins/AdditionalEvidence/GroupFlyers/murdermanifest.sodso.json': manifest([]),
    'Plugins/AdditionalEvidence/GroupFlyers/DDSContent/DDS/Trees/.keep': '',

    // Under the plugins/ convention, one level down.
    'Plugins/DialogAdditions/plugins/TalkToPartner/DDSContent/DDS/Blocks/.keep': '',
    'Plugins/DialogAdditions/plugins/WhatIsYourPasscode/murdermanifest.sodso.json': manifest([]),
    'Plugins/DialogAdditions/plugins/WhatIsYourPasscode/DDSContent/DDS/Trees/.keep': '',

    // Deeper again.
    'Plugins/WhiteCollarSideJobs/plugins/Cases/test/murdermanifest.sodso.json': manifest([]),

    // A content folder with another manifest below it. Not something a real install
    // does, but it pins that the search stops at a match rather than walking on.
    'Plugins/DartTowerTest/backup/murdermanifest.sodso.json': manifest([]),

    // A loader with no editable content of its own.
    'Plugins/UnityExplorer/UnityExplorer.dll': 'binary',
    'Plugins/UnityExplorer/config/settings.cfg': 'x=1',
};


/**
 * A case content folder holding more than its manifest references: several types of
 * asset, and a patch of a base game asset the manifest does not name.
 */
export const soFolderContent = {
    'Mods/TestCase/murdermanifest.sodso.json': json({
        enabled: true, fileOrder: ['REF:testcase'], loadBefore: '', version: 1,
    }),
    'Mods/TestCase/testcase.sodso.json': json({ fileType: 'MurderMO', name: 'testcase' }),
    'Mods/TestCase/AnotherMurder.sodso.json': json({ fileType: 'MurderMO', name: 'AnotherMurder' }),
    'Mods/TestCase/IP_Note.sodso.json': json({ fileType: 'InteractablePreset', name: 'IP_Note' }),
    'Mods/TestCase/EP_Flyer.sodso.json': json({ fileType: 'EvidencePreset', name: 'EP_Flyer' }),

    // An override of a base game asset: the fields to apply over it, and nothing else.
    // No fileType, so the type has to come from the asset's name. ExCopSniper is a
    // MurderMO and nothing else, so the name settles it.
    'Mods/TestCase/ExCopSniper.sodso_patch.json': json({ notes: 'x' }),

    // Bar is six types at once, AddressPreset among them. An override made here says
    // which it is; the name would have answered RoomTypeFilter.
    'Mods/TestCase/Bar.sodso_patch.json': json({ name: 'Bar', fileType: 'AddressPreset' }),

    // Degenerate: a type the game does not have, and a name that is nobody's asset.
    'Mods/TestCase/Nonsense.sodso.json': json({ fileType: 'NotAType', name: 'Nonsense' }),
    'Mods/TestCase/NotAnAsset.sodso_patch.json': json({ notes: 'x' }),
};


/**
 * A case whose preset references a DDS tree by GUID, plus that tree's content in the
 * same folder -- the arrangement that makes following the reference meaningful.
 */
export const caseWithDdsReference = {
    ...streamingAssets,
    'Mods/TestCase/murdermanifest.sodso.json': json({
        enabled: true, fileOrder: ['REF:testcase'], loadBefore: '', version: 1,
    }),
    'Mods/TestCase/testcase.sodso.json': json({
        fileType: 'MurderMO',
        name: 'testcase',
        // A reference to DDS content, which the case editor offers to open.
        conversationTree: TREE_GUID,
    }),
    'Mods/TestCase/DDSContent/DDS/Trees/.keep': '',
    'Mods/TestCase/DDSContent/DDS/Messages/.keep': '',
    'Mods/TestCase/DDSContent/DDS/Blocks/.keep': '',
    'Mods/TestCase/DDSContent/Strings/English/DDS/.keep': '',
};

/**
 * A case whose references cover both places a ScriptableObject can be read from.
 *
 * copyFrom names a base game MurderMO, one of the types this tool ships assets for,
 * so it is read from those. denStyleOverride holds DesignStylePresets -- a type the
 * base game has seven of and that is not among the online types -- and names one the
 * game has never heard of, which is the arrangement that reads from the mod folder.
 *
 * No field the game does not have: an unknown one walks the type layout into nothing
 * and throws out of the tree's setup, which would drown out anything asserted here.
 */
export const caseWithCustomReference = {
    'Mods/TestCase/murdermanifest.sodso.json': json({
        enabled: true, fileOrder: ['REF:testcase'], loadBefore: '', version: 1,
    }),
    'Mods/TestCase/testcase.sodso.json': json({
        fileType: 'MurderMO',
        name: 'testcase',
        presetName: 'testcase',
        copyFrom: 'REF:MurderMO|Hitman',
        denStyleOverride: ['REF:DesignStylePreset|HouseStyle'],
    }),
    'Mods/TestCase/HouseStyle.sodso.json': json({
        fileType: 'DesignStylePreset',
        name: 'HouseStyle',
        presetName: 'HouseStyle',
    }),
};
