/**
 * The shell.
 *
 * Registers every flow, connects the shared folders, and activates whichever flow the
 * URL asks for. Only the requested flow's markup, styles and reference data load.
 *
 * The URL says more than which flow: the mod and content folder, and what that flow has
 * open. See core/urlState.js. Putting it back is the last thing startup does, and can
 * have to wait -- for the mod folder, whose grant Chrome usually will not carry across a
 * reload.
 *
 * Switching flows swaps them in place rather than reloading, so the folders you picked
 * stay connected. Reloading would drop the directory handles from memory and, because
 * Chrome usually will not carry a File System Access grant across a reload, mean
 * re-granting them every time you switched.
 *
 * The markup still uses inline `onclick` attributes, which resolve against the global
 * scope, so each flow publishes what it needs onto `window` when it loads.
 */
// First, and for its side effects: publishes jQuery, select2, idbKeyval, jsonpatch and
// jsonTree as globals, which is what the markup and several core modules still expect.
// See the file for why they are still globals.
import './core/vendorGlobals.js';

/*
 * Every stylesheet the shell loads, in cascade order. This order is load-bearing and is
 * the order the markup used to declare -- the app's own rules come after the libraries'
 * so they can correct them by position rather than by specificity.
 *
 * Kept as one list rather than split between here and <link> tags in index.html. A linked
 * sheet applies when the markup is parsed and an imported one when its module runs, so any
 * split puts all of the imports after all of the links whatever the intended order. Doing
 * that by accident put Pico after core/chrome.css and changed the size of every button.
 *
 * A flow's own stylesheet is added on activation, after all of these. See applyStyles.
 */
import 'select2/dist/css/select2.min.css';
import './libs/jsonTree/jsonTree.css';
import '@picocss/pico/css/pico.red.min.css';
import './core/chrome.css';
// The frame the two document editors share. Loaded here rather than per flow: both of
// them want it, and a flow's own stylesheet comes after it.
import './core/documentFlow.css';
// After Pico, which is where the search field's icon inset comes from, and after select2's
// own stylesheet. Both are what this corrects.
import './core/components/searchSelect/searchSelect.css';

import { registerFlow, activateFlow, listFlows, getFlow } from './core/flowRegistry.js';
import { folderHandle, restoreFolders, useFolder } from './core/folders.js';
import { initFoldersModal, activateFoldersFor, onFoldersChanged } from './core/foldersModal.js';
import { initTutorialsModal } from './core/tutorialsModal.js';
import { initModSelection, refreshMods, reapplySelection, selectContentFolder } from './core/modSelection.js';
import { isDemoMode, seedDemoFolders } from './core/demo/demoMode.js';
import { initNewContent } from './core/newContent.js';
import { initBarMenus } from './core/barMenu.js';
import { initAutosave } from './core/autosave.js';
import { initUpdateBanner } from './core/updateBanner.js';
import { initBuildVersion } from './core/buildVersion.js';
import { configureNavigation, switchFlow } from './core/navigation.js';
import { beginRestore, initUrlState, readUrlState, whileRestoring } from './core/urlState.js';
import ddsFlow from './flows/dds/flow.js';
import soFlow from './flows/scriptableObject/flow.js';
import buildingFlow from './flows/building/flow.js';

registerFlow(ddsFlow);
registerFlow(soFlow);
registerFlow(buildingFlow);

const DEFAULT_FLOW = soFlow.id;
const SPOILER_KEY = 'SOD_MurderCaseBuilder_SpoilerWarningDismissed';

/** The editor the URL asks for, or the default when it names one that is not here. */
const requestedFlowId = (asked) => (asked && getFlow(asked) ? asked : DEFAULT_FLOW);

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
    // And the folder that just arrived may be the one the URL was waiting for.
    await tryRestore();
});

/**
 * What the URL asked for, read once at startup.
 *
 * Kept rather than re-read: putting it back can have to wait for a folder, and by then
 * the address bar may have been written over -- with, at worst, the empty workspace that
 * waiting for the folder looks like.
 */
const saved = readUrlState();

let pending = true;

/**
 * Put back what the URL named, once everything it needs is there.
 *
 * The mod folder is core's condition, because the mod list is read from it and nothing
 * can be selected until it is connected. What the flow's own parameters need is the
 * flow's to say -- the DDS flow reads base game files and cannot open anything without
 * the game folder, while the ScriptableObject flow can show base game assets with no
 * folder at all, which is the case a link to one relies on.
 */
async function tryRestore() {
    if (!pending) return;

    const flow = getFlow(flowId);

    if (saved.mod && !folderHandle('modDir')) return;
    if (flow.canRestore && !await flow.canRestore(saved.params)) return;

    pending = false;

    await whileRestoring(async () => {
        // The selection first: applying it is what the flow reacts to by rebuilding its
        // panels and closing documents, which would otherwise wipe what came back.
        if (saved.mod) await selectContentFolder(saved.mod, saved.content ?? '');
        await flow.restoreSession?.(saved.params);
    });
}

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
    // The banner is only visible while the header is on screen; the tab title says the
    // same thing everywhere else, including a tab left open next to a real one.
    document.title = `DEMO - ${document.title}`;

    const { streamingAssets, modDir, selection } = await seedDemoFolders();
    useFolder('streamingAssets', streamingAssets);
    useFolder('modDir', modDir);

    return selection;
}

const demo = isDemoMode();
let demoSelection = null;

const flowId = requestedFlowId(saved.flow);

// Before anything that could publish a selection or open a document: until what the URL
// asked for has been put back, nothing else may describe the page. Held across a folder
// prompt if it comes to that, and given up if the author switches editor or chooses a
// mod in the meantime.
beginRestore(() => { pending = false; });

buildPicker(flowId);
initUrlState();
initFoldersModal();
initTutorialsModal();
initModSelection();
initNewContent();
initAutosave();
// Early, and before anything that can wait: the main process starts the update check as
// the window is created, so the answer can be in flight already. Nothing on the web,
// where there is no such check and no banner. See core/updateBanner.js.
initUpdateBanner();
// Nothing waits on this and nothing else reads it, but it is the line a bug report is
// written from, so it should be there before anything can go wrong rather than after.
initBuildVersion();
// Before any flow is mounted, and never again: the menus belong to whichever flow is on
// screen, and this is bound to the document rather than to any of them.
initBarMenus();

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
//
// Not when the URL names one. A demo tab that has been worked in is worth coming back to
// as it was, and the opening selection is only a stand-in for having none.
if (demoSelection && !saved.mod) {
    await selectContentFolder(demoSelection.modName, demoSelection.contentPath);
}

// Whatever the folders left connected, this is the first chance to put the URL back.
// A folder that has to be re-granted arrives later, through onFoldersChanged above.
await tryRestore();
