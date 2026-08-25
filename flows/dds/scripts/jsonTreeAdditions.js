import { capitalizeFirstLetter } from '../../../core/strings.js';
import { createTreeWindow, closeFromDepth, WindowPolicy } from '../../../core/treeWindow.js';

/** These windows are levels of a drill-down: tree -> message -> block. */
const WINDOW_POLICY = WindowPolicy.DRILLDOWN;
export const WINDOW_DEPTHS = 3;

const windowId = (depth) => `file-window-${depth}`;

/** Map a file extension to the document type it represents. */
const FILE_TYPES = { tree: 'tree', msg: 'message', block: 'block' };

export function addTreeElement(thisTreeCount, parentElement, fileData, editorCallbacks) {
    // Drill-down policy: opening a level closes it and everything below, because
    // what is below only exists as a consequence of what is above.
    deleteTree(thisTreeCount);

    const [, fileId, extension] = fileData.path.match(/.*\/(.*)\.(\w+)/);
    const fileType = FILE_TYPES[extension];

    const { treeEl } = createTreeWindow({
        id: windowId(thisTreeCount),
        parent: parentElement,
        // Recorded so the open set can be captured and restored across a flow switch.
        attributes: { path: fileData.path },
        title: `
            <h2>${capitalizeFirstLetter(fileType)}: ${fileData.name}</h2>
            <h3>${fileId}
                <span class="copy-icon" title="Copy GUID">📄<span>📄</span></span>
                <span class="fav-icon" title="Save to favourites"></span>
            </h3>`,
        actions: [
            { label: 'Save', onClick: () => editorCallbacks.save(true) },
            { label: 'Use As Template', onClick: editorCallbacks.useAsTemplate },
            { label: 'Copy Source', onClick: editorCallbacks.copySource },
            { label: 'Close', onClick: () => deleteTree(thisTreeCount) },
        ],
        onTitleReady: (titleEl) => {
            titleEl.querySelector('.copy-icon').addEventListener('click', () => {
                navigator.clipboard.writeText(fileId);
            });

            const favIcon = titleEl.querySelector('.fav-icon');
            const isFav = JSON.parse(localStorage.getItem('favs')).some((f) => f.guid === fileId);
            favIcon.innerText = isFav ? '❤' : '♡';
            favIcon.addEventListener('click', () => {
                favIcon.innerText = window.toggleFav(fileId, fileType) ? '❤' : '♡';
            });
        },
    });

    return treeEl;
}

/** Close this level and every level below it. */
export function deleteTree(thisTreeCount) {
    closeFromDepth(thisTreeCount, WINDOW_DEPTHS, windowId);
}
