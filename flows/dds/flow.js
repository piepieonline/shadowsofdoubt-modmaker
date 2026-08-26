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
    styles: ['./flows/dds/jsontree_overrides.css', './flows/dds/style.css'],

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
     * referencing it. `type` may be null: loadFromGUI recognises base game GUIDs
     * from the reference data on its own.
     */
    async openDocument({ id, type }) {
        const { openDdsFile } = await import('./scripts/ui.js');
        await openDdsFile(id, type);
    },

    /** Remember and restore what is open across a switch to another editor. */
    async captureSession() {
        const { captureSession } = await import('./scripts/ui.js');
        return captureSession();
    },

    async restoreSession(state) {
        const { restoreSession } = await import('./scripts/ui.js');
        await restoreSession(state);
    },

    /** A content folder was chosen in the shell. */
    async onModSelected(selection) {
        const { onModSelected } = await import('./scripts/ui.js');
        await onModSelected(selection);
    },

    async start() {
        if (window?.queryParams?.caseEditorLink === 'true') {
            document.querySelector('#path-to-read').value = window.queryParams.documentId;
            if (window.queryParams.documentType != 'unknown') {
                document.querySelector('#select-guid-type').value = window.queryParams.documentType;
            }
        }
    },
};
