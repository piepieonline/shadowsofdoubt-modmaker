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

    // No `newContent`: a new content folder starts empty here, as it does in the DDS
    // flow. It used to be a case -- a manifest and the preset it revolves around, chosen
    // from a dialog -- which decided what the folder was for before its author had, and
    // wrote two files to say so. The manifest arrives with the first file added to the
    // load order instead; see openManifest in index.js.

    /**
     * What is open, as URL parameters, and putting it back -- across a switch to
     * another editor and across a reload.
     *
     *   open      the documents, each as `<where it came from>:<path>`
     *   viewOnly  set by a shared link, which is for reading rather than editing
     */
    async sessionState() {
        const { sessionState } = await import('./scripts/ui.js');
        return sessionState();
    },

    async restoreSession(params) {
        const { restoreSession } = await import('./scripts/ui.js');
        await restoreSession(params);
    },

    // No `canRestore`: the base game assets shipped with this tool need no folder at
    // all, which is what a link to one relies on. A document of the mod's own arrives
    // with the mod named beside it, and waiting for that folder is the shell's rule.

    async onModSelected(selection) {
        const { onModSelected } = await import('./scripts/ui.js');
        await onModSelected(selection);
    },

    async start() {
        const { updateAssetModel } = await import('./scripts/ui.js');
        // Needs the type map, so it runs after loadRefs rather than from inside it. It
        // fills the New File dialog's type list as well as the asset explorer's, which
        // is why nothing else here has to.
        updateAssetModel();
    },
};
