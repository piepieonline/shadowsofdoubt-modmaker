// See the note in flows/dds/flow.js: hashed by the bundler, swapped in by applyStyles.
import styleUrl from './style.css?url';

/**
 * Building floorplans: the 3D grid you paint addresses, rooms, floor types, walls and
 * tile features onto, saved as the game's floor blueprint JSON and attached to a
 * building preset.
 */
export default {
    id: 'building',
    label: 'Building Floorplans',

    // A floor blueprint the mod owns is written whole. Base game blueprints are never
    // written at all -- editing one saves a copy into the mod under the same name,
    // which shadows the original, so there is nothing to patch. See buildingLibrary.js.
    saveStrategy: 'fullFile',

    /**
     * The game folder is not needed. Floor blueprints are TextAssets inside asset
     * bundles rather than loose files in StreamingAssets, so a browser could not read
     * them from an install even with it connected -- which is why they ship with the
     * app under refs/floors/.
     */
    requiredFolders: ['modDir'],

    template: '#flow-template-building',
    styles: [styleUrl],

    /** Loaded on activation, not at page load. See the note in the other flows. */
    async loadRefs() {
        const refs = await import('./scripts/loadRefs.js');
        const handlers = await import('./globals.js');
        return { ...refs.default, ...handlers.default };
    },

    async onFoldersConnected() {
        const { onFoldersConnected } = await import('./scripts/ui.js');
        await onFoldersConnected();
    },

    /** A content folder was chosen in the shell. */
    async onModSelected(selection) {
        const { onModSelected } = await import('./scripts/ui.js');
        await onModSelected(selection);
    },

    /**
     * The floor that is open, as URL parameters, and putting it back -- across a switch
     * to another editor and across a reload.
     *
     *   building, blueprint, slot  which floor, and where it sits in its building
     *   variations                 the layout each address is showing
     *   tool                       what is being painted with
     */
    async sessionState() {
        const { sessionState } = await import('./scripts/ui.js');
        return sessionState();
    },

    async restoreSession(params) {
        const { restoreSession } = await import('./scripts/ui.js');
        await restoreSession(params);
    },

    /** Leaving: write anything pending and give back the WebGL context. */
    async suspend() {
        const { suspend } = await import('./scripts/ui.js');
        await suspend();
    },

    /**
     * What a new content folder needs in it to be a building mod: a preset named after
     * the folder, and the Floors directory that marks it as one.
     */
    async newContent(name) {
        const { scaffoldBuildingFolder } = await import('./scripts/ui.js');
        return scaffoldBuildingFolder(name);
    },
};
