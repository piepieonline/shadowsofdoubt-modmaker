/**
 * The ScriptableObject flow's inline `onclick` surface. See flows/dds/globals.js.
 */
import {
    toggleManifestPanel, shareOpen, enableAssetOnlyMode, toggleEditMode, toggleDefaultValues,
    updateNewFileCopyFrom, newFileMode, setNewFileMode, updateNewFileSubmitState,
    updateSelectAllCopyFrom, filterFilePanel,
} from './scripts/ui.js';
import { cancelNewCasePopup } from './index.js';

export default {
    toggleManifestPanel, shareOpen, enableAssetOnlyMode, toggleEditMode, toggleDefaultValues,
    updateNewFileCopyFrom, newFileMode, setNewFileMode, updateNewFileSubmitState,
    updateSelectAllCopyFrom, filterFilePanel,
    cancelNewCasePopup,
};
