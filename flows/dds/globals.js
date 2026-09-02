/**
 * The DDS flow's inline `onclick` surface.
 *
 * The markup drives the app through inline attributes, which resolve against the
 * global scope. This block is the complete list of what the markup depends on --
 * replacing the inline handlers with addEventListener wiring means deleting it.
 *
 * Exported rather than assigned so that the registry installs it alongside the
 * reference data, and removes it when another flow's markup takes over.
 */
import {
    setIdAndLoad, newFile,
    showBrowse, updateBrowse, updateBrowseTypeahead, showReverseSearch,
    updateRSearch, updateRSearchResultsTable, showHelp, openModal, closeModal,
    toggleShowAllFields,
} from './scripts/ui.js';
import {
    showNewDdsFile, closeNewDdsFile, updateNewDdsFileForm, submitNewDdsFile,
} from './scripts/newFileDialog.js';
import { toggleManifestPanel } from './scripts/manifestPanel.js';

export default {
    setIdAndLoad, newFile,
    showNewDdsFile, closeNewDdsFile, updateNewDdsFileForm, submitNewDdsFile,
    showBrowse, updateBrowse, updateBrowseTypeahead, showReverseSearch,
    updateRSearch, updateRSearchResultsTable, showHelp, openModal, closeModal,
    toggleShowAllFields,
    toggleDdsManifestPanel: toggleManifestPanel,
};
