/**
 * The ScriptableObject flow's inline `onclick` surface. See flows/dds/globals.js.
 */
import {
    toggleManifestPanel, shareOpen, enableAssetOnlyMode, toggleEditMode, toggleDefaultValues,
    updateNewFileCopyFrom, newFileMode, setNewFileMode, updateNewFileSubmitState,
    updateSelectAllCopyFrom, filterFilePanel, toggleFileFilter, showHelp, closeHelp,
} from './scripts/ui.js';
import { cancelNewCasePopup } from './index.js';
import {
    openRoomCreator, closeRoomCreator, roomCreatorChanged, writeRoom, openExistingRoom,
    copyDonorFurniture,
} from './scripts/roomCreator.js';
import {
    startFieldSummary, cancelFieldSummary, closeFieldSummary, filterFieldSummary,
} from './scripts/fieldSummary.js';

export default {
    toggleManifestPanel, shareOpen, enableAssetOnlyMode, toggleEditMode, toggleDefaultValues,
    updateNewFileCopyFrom, newFileMode, setNewFileMode, updateNewFileSubmitState,
    updateSelectAllCopyFrom, filterFilePanel, toggleFileFilter, showHelp, closeHelp,
    cancelNewCasePopup,
    openRoomCreator, closeRoomCreator, roomCreatorChanged, writeRoom, openExistingRoom,
    copyDonorFurniture,
    startFieldSummary, cancelFieldSummary, closeFieldSummary, filterFieldSummary,
};
