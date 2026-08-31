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
        // An enum inside an array, two levels down. Resolving this is what the flow
        // could not do while enums were keyed by field name: every element of an array
        // is labelled by its index, so `triggers` never matched.
        participantA: { connection: 15, triggers: [12, 3] },
        triggerPoint: 6,
        // A Boolean, which the layout types and refs/authored/basicEnums.json makes a
        // dropdown. It must not be stored as an enum index.
        stopMovement: true,
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
        // A real field four levels deep: MurderMO -> MOleads (MurderLeadItem) ->
        // traitModifiers (MurdererModifierRule) -> mustPassForApplication, which the
        // game documents. The tooltip lookup used to hop exactly one level, so anything
        // this deep silently had none.
        MOleads: [{ chance: 0.5, traitModifiers: [{ mustPassForApplication: true }] }],
    }),
};

/**
 * The same case, plus three more MurderMOs covering what a reference field has to decide
 * about the mod's own content.
 *
 * `copyFrom` on a MurderMO points at another MurderMO -- see index.js, where copyFrom is
 * typed as the document's own type -- so one field exercises all three at once:
 *
 * | | |
 * |---|---|
 * | `MyOtherMO` | the mod's own, listed. Offered under Modded. |
 * | `ExCopSniper` | a patch of a base game asset, listed. Under Modded *and* still under Vanilla, since the name is the shipped one and the values are the mod's. |
 * | `ForgottenMO` | the mod's own, absent from `fileOrder`. Not offered at all: the game would never load it, so a reference to it resolves for its author and for nobody else. |
 *
 * `SameName` is the awkward one, and it is two tests in one file. It is a `MurderPreset`
 * that calls itself `testcase` -- the same name as the document being edited, which is a
 * `MurderMO`. Hundreds of the game's own names belong to more than one type, so a document
 * has to be kept out of its own lists by name *and* type, not by name: this one must still
 * be offered to `compatibleWith`, which points at MurderPresets.
 *
 * Its file is called something else again, which is the other half. A `REF:` resolves
 * against `presetName`, not against what the file is called, and only a mod written by
 * hand ever has the two disagree -- this app renames the file with the preset.
 */
export const soModDirWithAssets = {
    ...soModDir,
    'Mods/TestCase/murdermanifest.sodso.json': json({
        enabled: true,
        fileOrder: ['REF:testcase', 'REF:MyOtherMO', 'REF:ExCopSniper', 'REF:SameName'],
        loadBefore: '',
        version: 1,
    }),
    'Mods/TestCase/SameName.sodso.json': json({
        fileType: 'MurderPreset', name: 'testcase', presetName: 'testcase',
    }),
    'Mods/TestCase/MyOtherMO.sodso.json': json({
        fileType: 'MurderMO', name: 'MyOtherMO', presetName: 'MyOtherMO', copyFrom: null,
    }),
    // A patch as createOverrideIfNotExisting writes one: the name it overrides, and the
    // type, since a patch is a diff and cannot be typed from its contents.
    'Mods/TestCase/ExCopSniper.sodso_patch.json': json({
        name: 'ExCopSniper', fileType: 'MurderMO',
    }),
    'Mods/TestCase/ForgottenMO.sodso.json': json({
        fileType: 'MurderMO', name: 'ForgottenMO', presetName: 'ForgottenMO', copyFrom: null,
    }),
    // The document under test gains a MurderPreset reference, which is the field the
    // same-name-different-type case is read through.
    'Mods/TestCase/testcase.sodso.json': json({
        fileType: 'MurderMO',
        name: 'testcase',
        presetName: 'testcase',
        notes: 'fixture',
        copyFrom: null,
        compatibleWith: [null],
        nested: { alpha: 'a', beta: 'b' },
        MOleads: [{ chance: 0.5, traitModifiers: [{ mustPassForApplication: true }] }],
    }),
};

export const soFixtureWithAssets = { ...soModDirWithAssets };

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

/** A block said by the tree's *second* message, and nowhere else. */
export const BLOCK2_GUID = '77777777-7777-4777-8777-777777777777';
export const BLOCK2_TEXT = 'A line only the second message says';

/**
 * Content laid out so that the way to a line is not the way the cascade goes.
 *
 * Opening a tree cascades into its first message and that message's first block. Here the
 * searched line is in a block under the *second* message, so a drill-down that lands on
 * it is one that followed the reverse index rather than the cascade -- which is the whole
 * of what the reverse search has to get right.
 */
export const ddsReverseSearchFixture = {
    ...streamingAssets,
    ...ddsModDir,

    'StreamingAssets/Strings/English/DDS/dds.blocks.csv': [
        ddsBlocksCsv,
        `${BLOCK2_GUID},,${BLOCK2_TEXT},,,,09:00 01/01/2024`,
    ].join('\n'),

    [`StreamingAssets/DDS/Messages/${MSG2_GUID}.msg`]: json({
        id: MSG2_GUID,
        name: 'SecondMessage',
        blocks: [{ blockID: BLOCK2_GUID, instanceID: 'instance-4', alwaysDisplay: true }],
    }),

    [`StreamingAssets/DDS/Blocks/${BLOCK2_GUID}.block`]: json({
        id: BLOCK2_GUID,
        name: 'SecondBlock',
        replacements: [],
    }),
};

export const ddsFixture = { ...streamingAssets, ...ddsModDir };
export const ddsFixtureWithContent = { ...ddsFixture, ...ddsModContent };
export const soFixture = { ...soModDir };

/** The GUIDs of the mod's own content above, for tests that follow one to another. */
export const MOD_TREE_GUID = 'aaaaaaaa-1111-4111-8111-111111111111';
export const MOD_MSG_GUID = 'bbbbbbbb-2222-4222-8222-222222222222';
export const MOD_BLOCK_GUID = 'cccccccc-3333-4333-8333-333333333333';

/**
 * The same mod, wired up the way DDS content actually nests: the tree holds the message,
 * the message holds the block, and the block's line is already in the mod's CSV.
 *
 * `ddsModContent` leaves those arrays empty, which is what a fresh document looks like and
 * is right for the tests that list the folder. This one exists for the tests that have to
 * follow a link -- deleting a message and being told which tree was using it.
 */
export const ddsLinkedContent = {
    ...ddsFixtureWithContent,
    [`Mods/TestMod/Content/DDSContent/DDS/Trees/${MOD_TREE_GUID}.tree`]: json({
        id: MOD_TREE_GUID,
        name: 'ModTree',
        messages: [{ msgID: MOD_MSG_GUID, instanceID: 'mod-instance-1', order: 0 }],
    }),
    [`Mods/TestMod/Content/DDSContent/DDS/Messages/${MOD_MSG_GUID}.msg`]: json({
        id: MOD_MSG_GUID,
        name: 'ModMessage',
        blocks: [{ blockID: MOD_BLOCK_GUID, instanceID: 'mod-instance-2', alwaysDisplay: true }],
    }),
};

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
    'Plugins/AdditionalEvidence/GroupFlyers/DDSContent/DDS/Trees/.keep': '',

    // Under the plugins/ convention, one level down.
    'Plugins/DialogAdditions/plugins/TalkToPartner/DDSContent/DDS/Blocks/.keep': '',
    'Plugins/DialogAdditions/plugins/WhatIsYourPasscode/murdermanifest.sodso.json': manifest([]),
    'Plugins/DialogAdditions/plugins/WhatIsYourPasscode/DDSContent/DDS/Trees/.keep': '',

    // Deeper again. It holds a building preset the manifest does not name, which is a
    // file the loader never reads -- so this folder is a case and not a building.
    'Plugins/WhiteCollarSideJobs/plugins/Cases/test/murdermanifest.sodso.json': manifest([]),
    'Plugins/WhiteCollarSideJobs/plugins/Cases/test/SideTower.sodso.json':
        json({ fileType: 'BuildingPreset', name: 'SideTower' }),

    // A building mod: no DDSContent, just a manifest naming a preset named after the
    // building, and the floors it uses. Listed in lowercase, as mods in the wild do, so
    // finding the preset cannot be a case-sensitive match on the entry.
    'Plugins/TallTower/murdermanifest.sodso.json': manifest(['REF:talltower']),
    'Plugins/TallTower/TallTower.sodso.json': json({ fileType: 'BuildingPreset', name: 'TallTower' }),
    'Plugins/TallTower/Floors/TallTower_GroundFloor.json': json({ floorName: 'TallTower_GroundFloor' }),

    // A mod holding both a case and a building, to pin that the markers compose.
    'Plugins/AdditionalEvidence/GroupFlyers/murdermanifest.sodso.json': manifest(['REF:FlyerTower']),
    'Plugins/AdditionalEvidence/GroupFlyers/FlyerTower.sodso.json':
        json({ fileType: 'BuildingPreset', name: 'FlyerTower' }),
    'Plugins/AdditionalEvidence/GroupFlyers/Floors/Flyer_Roof.json': json({ floorName: 'Flyer_Roof' }),

    // A building mod from before this app listed the presets it wrote: a preset and its
    // floors, and nothing naming either. The game does not load it and neither do we.
    'Plugins/UnlistedTower/UnlistedTower.sodso.json':
        json({ fileType: 'BuildingPreset', name: 'UnlistedTower' }),
    'Plugins/UnlistedTower/Floors/UnlistedTower_Ground.json': json({ floorName: 'UnlistedTower_Ground' }),

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
 *
 * Both file naming conventions are represented, because a real folder holds both. Most
 * of these are `<name>.sodso.json`, which is what mods written before the type joined
 * the file name look like and what this app must go on reading and writing in place.
 * `EP_Flyer` is the shape this app writes now -- see core/soFileName.js -- and it is
 * there so that the panel is exercised on a file whose name is not what it is called.
 */
export const soFolderContent = {
    'Mods/TestCase/murdermanifest.sodso.json': json({
        enabled: true, fileOrder: ['REF:testcase'], loadBefore: '', version: 1,
    }),
    'Mods/TestCase/testcase.sodso.json': json({ fileType: 'MurderMO', name: 'testcase' }),
    'Mods/TestCase/AnotherMurder.sodso.json': json({ fileType: 'MurderMO', name: 'AnotherMurder' }),
    // The one asset here written as this app writes them, name and presetName together,
    // so that renaming it can be exercised against this folder.
    'Mods/TestCase/IP_Note.sodso.json': json({
        fileType: 'InteractablePreset', name: 'IP_Note', presetName: 'IP_Note',
    }),
    'Mods/TestCase/EP_Flyer.EvidencePreset.sodso.json': json({
        fileType: 'EvidencePreset', name: 'EP_Flyer', presetName: 'EP_Flyer',
    }),

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
 * The same case, plus the litter that building one room leaves in a content folder.
 *
 * A room admits its furniture by patching every cluster and preset in its closure, its
 * surfaces by patching each material filter, and its lighting by patching each light --
 * see flows/scriptableObject/scripts/roomPlan.js. None of those files is about the room,
 * and a mod with a few rooms in it has more of them than of everything else put together,
 * which is what the panel's filter exists to put out of the way.
 *
 * Two that must survive it, because neither is only a permission: a patch that admits the
 * room *and* changes something, and a cluster the mod defines rather than patches.
 */
export const caseWithRoomPermissions = {
    ...soFolderContent,

    'Mods/TestCase/DeskChair.sodso_patch.json': json({
        name: 'DeskChair',
        fileType: 'FurniturePreset',
        patches: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|MyRoomRTF' }],
    }),
    'Mods/TestCase/DeskCluster.sodso_patch.json': json({
        name: 'DeskCluster',
        fileType: 'FurnitureCluster',
        patches: [{ op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|MyRoomRTF' }],
    }),

    'Mods/TestCase/ConcreteWalls.sodso_patch.json': json({
        name: 'ConcreteWalls',
        fileType: 'RoomTypeFilter',
        patches: [{ op: 'add', path: '/roomClasses/-', value: 'REF:RoomClassPreset|MyRoomRCP' }],
    }),
    'Mods/TestCase/StripLight.sodso_patch.json': json({
        name: 'StripLight',
        fileType: 'RoomLightingPreset',
        patches: [{ op: 'add', path: '/roomCompatibility/-', value: 'REF:RoomConfiguration|MyRoomRC' }],
    }),

    // Admits the room and moves the preset's spawn chance. The second is an edit its
    // author made and would go looking for, so the file is not the filter's to hide.
    'Mods/TestCase/BookShelf.sodso_patch.json': json({
        name: 'BookShelf',
        fileType: 'FurniturePreset',
        patches: [
            { op: 'add', path: '/allowedRoomFilters/-', value: 'REF:RoomTypeFilter|MyRoomRTF' },
            { op: 'replace', path: '/spawnChance', value: 2 },
        ],
    }),

    // The mod's own cluster, which states its whole self. A clone is what the room writer
    // produces when a shipped cluster's gates conflict -- it is content, not a permission.
    'Mods/TestCase/MyRoom_Desks.FurnitureCluster.sodso.json': json({
        fileType: 'FurnitureCluster',
        name: 'MyRoom_Desks',
        presetName: 'MyRoom_Desks',
        copyFrom: 'REF:FurnitureCluster|DeskCluster',
        allowedRoomFilters: ['REF:RoomTypeFilter|MyRoomRTF'],
    }),
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
 * compatibleWith names a base game MurderPreset, one of the types this tool ships assets
 * for, so it is read from those. denStyleOverride holds DesignStylePresets -- a type the
 * base game has seven of and that is not among the online types -- and names one the
 * game has never heard of, which is the arrangement that reads from the mod folder.
 *
 * Neither is copyFrom, which the flow reaches through the Open Base button as well as
 * through the row, and which has tests of its own for both.
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
        compatibleWith: ['REF:MurderPreset|Hitman'],
        denStyleOverride: ['REF:DesignStylePreset|HouseStyle'],
    }),
    'Mods/TestCase/HouseStyle.sodso.json': json({
        fileType: 'DesignStylePreset',
        name: 'HouseStyle',
        presetName: 'HouseStyle',
    }),
};
