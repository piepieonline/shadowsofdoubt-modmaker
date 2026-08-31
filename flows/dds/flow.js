import { WindowPolicy } from '../../core/treeWindow.js';

/**
 * DDS text content: conversation trees, messages, blocks, and the English strings
 * CSV they resolve against.
 */
export default {
    id: 'dds',
    label: 'DDS Text Content',

    // Base-game content that must not be modified, so edits become JSON Patches
    // applied at load time by the DDS Loader.
    saveStrategy: 'vanillaPatch',

    // tree -> message -> block is one drill-down, not three documents.
    windowPolicy: WindowPolicy.DRILLDOWN,

    // Fields sorted alphabetically, values separated by commas.
    treeOptions: { sortKeys: true, valueSeparator: ',' },

    // Base game content is read from StreamingAssets; edits are written to the mod.
    requiredFolders: ['streamingAssets', 'modDir'],

    template: '#flow-template-dds',
    styles: ['./flows/dds/style.css'],

    /** Loaded on activation, not at page load. See the note in the other flow. */
    async loadRefs() {
        const refs = await import('./scripts/loadRefs.js');
        const handlers = await import('./globals.js');
        return { ...refs.default, ...handlers.default };
    },

    async onFoldersConnected() {
        const { onFoldersConnected } = await import('./scripts/ui.js');
        await onFoldersConnected();
    },

    /**
     * Open a DDS document, from anywhere -- the panel, a deep link, or a case file
     * referencing it. `type` may be null: a base game GUID is recognised from the
     * reference data on its own.
     */
    async openDocument({ id, type }) {
        const { openDdsFile } = await import('./scripts/ui.js');
        await openDdsFile(id, type);
    },

    /**
     * What is open, as URL parameters, and putting it back -- across a switch to
     * another editor and across a reload.
     *
     *   open     the drill-down, one entry per level: the file each window is showing,
     *            or a bare GUID for a document whose kind is to be worked out
     *   strings  the strings CSV open beside it, if any
     */
    async sessionState() {
        const { sessionState } = await import('./scripts/ui.js');
        return sessionState();
    },

    async restoreSession(params) {
        const { restoreSession } = await import('./scripts/ui.js');
        await restoreSession(params);
    },

    /**
     * Every document here is a base game file, patched by the mod where the mod says so,
     * so there is nothing to open until the game folder is connected -- and a restore
     * that opened nothing would be written back as an empty workspace.
     */
    canRestore: () => Boolean(window.dirHandleStreamingAssets),

    /** A content folder was chosen in the shell. */
    async onModSelected(selection) {
        const { onModSelected } = await import('./scripts/ui.js');
        await onModSelected(selection);
    },
};
