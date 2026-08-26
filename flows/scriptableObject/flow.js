import { WindowPolicy } from '../../core/treeWindow.js';

/**
 * ScriptableObject case files: murder cases and the presets they reference,
 * described by the game's own type layout.
 */
export default {
    id: 'scriptableObject',
    label: 'Cases & ScriptableObjects',

    // These files belong to the mod, so they are written whole.
    saveStrategy: 'fullFile',

    // Independent documents keyed by path; reopening one is a no-op.
    windowPolicy: WindowPolicy.BY_PATH,

    // Fields in the game's serialisation order, values separated by a non-breaking
    // space. This flow had forked jsonTree to change both.
    treeOptions: { sortKeys: false, valueSeparator: '&nbsp;' },

    // Assets can be browsed online without any folder; editing needs the mod folder.
    requiredFolders: ['modDir'],

    template: '#flow-template-scriptableObject',
    styles: ['./flows/scriptableObject/new_style.css'],

    /**
     * Loaded on activation, not at page load. Importing either flow's UI eagerly
     * would run its startup against markup that is not mounted.
     */
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
     * A new content folder is a new case here, so this asks what kind before the
     * shell creates it.
     */
    async newContent(name) {
        const { newContent } = await import('./scripts/ui.js');
        return newContent(name);
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

    async onModSelected(selection) {
        const { onModSelected } = await import('./scripts/ui.js');
        await onModSelected(selection);
    },

    async start() {
        const { startFlow, updateAssetModel } = await import('./scripts/ui.js');
        // Needs the type map, so it runs after loadRefs rather than from inside it.
        updateAssetModel(true, false);
        startFlow();
    },
};
