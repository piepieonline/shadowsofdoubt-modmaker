/**
 * The building flow's inline `onclick` surface.
 *
 * The shell's markup drives each flow through inline attributes, which resolve against
 * the global scope. This block is the complete list of what this flow's template
 * depends on -- the same arrangement the other two flows use.
 *
 * Exported rather than assigned so that the registry installs it alongside the
 * reference data, and takes it back down when another flow's markup replaces this one.
 */
import {
    showAddBuilding, closeAddBuilding, submitAddBuilding,
    syncPresetNameToTitle, markPresetNameEdited,
    closeAddStorey, submitAddStorey,
    chooseOverride, chooseClone, discardEdit, cancelOwnership, submitClone,
    syncCloneNameToTitle, markCloneNameEdited,
    showHelp, closeHelp,
} from './scripts/ui.js';

export default {
    showAddBuilding,
    closeAddBuilding,
    submitAddBuilding,
    syncPresetNameToTitle,
    markPresetNameEdited,
    closeAddStorey,
    submitAddStorey,
    chooseOverride,
    chooseClone,
    discardEdit,
    cancelOwnership,
    submitClone,
    syncCloneNameToTitle,
    markCloneNameEdited,
    showHelp,
    closeHelp,
};
