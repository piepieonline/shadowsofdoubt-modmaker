/**
 * The ScriptableObject flow's inline `onclick` surface. See flows/dds/globals.js.
 */
import {
    toggleManifestPanel, shareOpen, enableAssetOnlyMode, toggleEditMode, toggleDefaultValues,
    updateAssetModel, updateNewFileCopyFrom, newFileMode, setNewFileMode, updateNewFileSubmitState,
    updateSelectAllCopyFrom, loadExportedSOs,
} from './scripts/ui.js';
import { cancelNewCasePopup } from './index.js';

Object.assign(window, {
    toggleManifestPanel, shareOpen, enableAssetOnlyMode, toggleEditMode, toggleDefaultValues,
    updateAssetModel, updateNewFileCopyFrom, newFileMode, setNewFileMode, updateNewFileSubmitState,
    updateSelectAllCopyFrom, loadExportedSOs,
    cancelNewCasePopup,
});
