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
import { saveNow, addBuilding, setOverlay, resetView } from './scripts/ui.js';

export default {
    saveBuildingFloor: saveNow,
    addBuilding,
    setBuildingOverlay: setOverlay,
    resetBuildingView: resetView,
};
