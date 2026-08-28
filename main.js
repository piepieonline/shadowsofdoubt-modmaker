/**
 * The shell.
 *
 * Registers every flow, connects the shared folders, and activates whichever flow the
 * URL asks for. Only the requested flow's markup, styles and reference data load.
 *
 * Switching flows swaps them in place rather than reloading, so the folders you picked
 * stay connected. Reloading would drop the directory handles from memory and, because
 * Chrome usually will not carry a File System Access grant across a reload, mean
 * re-granting them every time you switched.
 *
 * The markup still uses inline `onclick` attributes, which resolve against the global
 * scope, so each flow publishes what it needs onto `window` when it loads.
 */
import { registerFlow, activateFlow, listFlows, getFlow } from './core/flowRegistry.js';
import { restoreFolders, useFolder } from './core/folders.js';
import { initFoldersModal, activateFoldersFor, onFoldersChanged } from './core/foldersModal.js';
import { initTutorialsModal } from './core/tutorialsModal.js';
import { initModSelection, refreshMods, reapplySelection, selectContentFolder } from './core/modSelection.js';
import { isDemoMode, seedDemoFolders } from './core/demo/demoMode.js';
import { initNewContent } from './core/newContent.js';
import { initAutosave } from './core/autosave.js';
import { configureNavigation, switchFlow } from './core/navigation.js';
import ddsFlow from './flows/dds/flow.js';
import soFlow from './flows/scriptableObject/flow.js';
import buildingFlow from './flows/building/flow.js';

registerFlow(ddsFlow);
registerFlow(soFlow);
registerFlow(buildingFlow);

const DEFAULT_FLOW = soFlow.id;
const SPOILER_KEY = 'SOD_MurderCaseBuilder_SpoilerWarningDismissed';

/**
 * The old DDS Viewer was a separate site and the modding wiki links to it. Its
 * deep-link parameters are read as-is so those links keep working.
 */
function requestedFlowId() {
    const params = new URLSearchParams(location.search);
    const asked = params.get('flow');
    if (asked && getFlow(asked)) return asked;

    if (params.has('documentId') || params.get('caseEditorLink') === 'true') return ddsFlow.id;

    return DEFAULT_FLOW;
}

function buildPicker(activeId) {
    const picker = document.getElementById('flow-picker');
    picker.replaceChildren();

    for (const { id, label } of listFlows()) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = label;
        option.selected = id === activeId;
        picker.appendChild(option);
    }

    picker.addEventListener('change', () => switchFlow(picker.value));
}

/**
 * What the shell does once a flow is active, however it got there -- the picker, a
 * deep link, or one flow handing off to another.
 */
configureNavigation({
    async afterSwitch(flow) {
        // Not autoOpen: switching flows should not put a modal in the way.
        await activateFoldersFor(flow);
        // The flow that just started has not been told what is already selected.
        // A no-op if connecting the folders above already did it.
        await reapplySelection();
    },
});


function awaitSpoilerAcceptance() {
    if (localStorage.getItem(SPOILER_KEY)) return Promise.resolve();

    return new Promise((resolve) => {
        const modal = document.querySelector('#spoiler-warning-modal');
        modal.setAttribute('open', '');
        document.querySelector('#spoiler-accept').addEventListener('click', () => {
            localStorage.setItem(SPOILER_KEY, 'true');
            modal.removeAttribute('open');
            resolve();
        }, { once: true });
    });
}

// Registered before anything can connect a folder: activateFoldersFor fires this
// immediately when nothing is missing, and the flow would otherwise never be told.
onFoldersChanged(async () => {
    await window.activeFlow?.onFoldersConnected?.();
    // The plugins folder may have just changed, so the mod list has to follow.
    await refreshMods();
});

/**
 * Connect the folders demo mode invents, in place of the ones on this machine.
 *
 * Deliberately instead of restoreFolders rather than after it: a remembered handle
 * installed and then replaced would still have been read from, and the promise demo mode
 * makes is that a game install is never touched at all.
 */
async function startDemo() {
    document.documentElement.dataset.demo = '';
    document.getElementById('demo-banner').hidden = false;

    const { streamingAssets, modDir, selection } = await seedDemoFolders();
    useFolder('streamingAssets', streamingAssets);
    useFolder('modDir', modDir);

    return selection;
}

const demo = isDemoMode();
let demoSelection = null;

const flowId = requestedFlowId();
buildPicker(flowId);
initFoldersModal();
initTutorialsModal();
initModSelection();
initNewContent();
initAutosave();

if (demo) {
    demoSelection = await startDemo();
} else {
    // Reconnect anything picked previously before deciding whether to ask for folders.
    await restoreFolders();
    // Not in demo mode: the warning is about what the game's own content spoils, and
    // demo mode holds none of it. Dismissing it there would also set the preference for
    // real use, which is not a decision a demo should make.
    await awaitSpoilerAcceptance();
}

await activateFlow(flowId);
await activateFoldersFor(getFlow(flowId), { autoOpen: true });

// Last, so the flow is active and has folders: choosing a content folder is what the
// flow is told about, and it has to have somewhere to read it from first. Landing in an
// empty editor would show the least interesting state the app has.
if (demoSelection) {
    await selectContentFolder(demoSelection.modName, demoSelection.contentPath);
}
