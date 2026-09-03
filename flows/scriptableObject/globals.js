/**
 * The ScriptableObject flow's inline `onclick` surface. See flows/dds/globals.js.
 */
import {
    toggleManifestPanel, shareOpen, enableAssetOnlyMode, toggleEditMode, toggleDefaultValues,
    updateNewFileCopyFrom, newFileMode, setNewFileMode, updateNewFileSubmitState,
    updateSelectAllCopyFrom, filterFilePanel, toggleFileFilter, showHelp, closeHelp,
} from './scripts/ui.js';
import {
    openRoomCreator, closeRoomCreator, roomCreatorChanged, writeRoom, openExistingRoom,
    copyDonorFurniture,
} from './scripts/roomCreator.js';
import {
    openFurnitureCreator, closeFurnitureCreator, furnitureCreatorChanged,
    toggleParentedSubObjects, resetFurnitureView, furnitureSubObjectChanged,
    furnitureDragModeChanged, addFurnitureSubObject,
    revertFurnitureEdits, furnitureNameChanged, writeFurniture,
    furnitureClassChanged, placementRuleChanged, placementSizeChanged,
    addPlacementRule, removePlacementRule, revertPlacementEdits, findWhereItAppears,
    furnitureInteractableChanged, addFurnitureInteractable,
} from './scripts/furnitureCreator.js';
import {
    startFieldSummary, cancelFieldSummary, closeFieldSummary, filterFieldSummary,
} from './scripts/fieldSummary.js';

export default {
    toggleManifestPanel, shareOpen, enableAssetOnlyMode, toggleEditMode, toggleDefaultValues,
    updateNewFileCopyFrom, newFileMode, setNewFileMode, updateNewFileSubmitState,
    updateSelectAllCopyFrom, filterFilePanel, toggleFileFilter, showHelp, closeHelp,
    openRoomCreator, closeRoomCreator, roomCreatorChanged, writeRoom, openExistingRoom,
    copyDonorFurniture,
    openFurnitureCreator, closeFurnitureCreator, furnitureCreatorChanged,
    toggleParentedSubObjects, resetFurnitureView, furnitureSubObjectChanged,
    furnitureDragModeChanged, addFurnitureSubObject,
    revertFurnitureEdits, furnitureNameChanged, writeFurniture,
    furnitureClassChanged, placementRuleChanged, placementSizeChanged,
    addPlacementRule, removePlacementRule, revertPlacementEdits, findWhereItAppears,
    furnitureInteractableChanged, addFurnitureInteractable,
    startFieldSummary, cancelFieldSummary, closeFieldSummary, filterFieldSummary,
};
