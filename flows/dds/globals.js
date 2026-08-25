/**
 * The DDS flow's inline `onclick` surface.
 *
 * The markup drives the app through inline attributes, which resolve against the
 * global scope. This block is the complete list of what the markup depends on --
 * replacing the inline handlers with addEventListener wiring means deleting it.
 */
import {
    setIdAndLoad, loadFromGUI, newFile,
    showBrowse, updateBrowse, updateBrowseTypeahead, showReverseSearch,
    updateRSearch, updateRSearchResultsTable, showHelp, openModal, closeModal,
} from './scripts/ui.js';
import { toggleManifestPanel } from './scripts/manifestPanel.js';

Object.assign(window, {
    setIdAndLoad, loadFromGUI, newFile,
    showBrowse, updateBrowse, updateBrowseTypeahead, showReverseSearch,
    updateRSearch, updateRSearchResultsTable, showHelp, openModal, closeModal,
    toggleDdsManifestPanel: toggleManifestPanel,
});
