import { fastElement, fastDiv } from '../../../core/dom.js';
import { createWindowShell, createTreeWindow, closeWindow, WindowPolicy } from '../../../core/treeWindow.js';
import { createTextEditor, createSelectEditor, createLinkButton } from '../../../core/valueEditors.js';
import { makeCSVSafe } from '../../../core/strings.js';
import { GUID_PATTERN } from '../../../core/guid.js';
import { openInFlow } from '../../../core/navigation.js';
// Cyclic -- index.js imports this module -- but only called from a click handler, long
// after both have evaluated. scripts/ui.js reaches these the same way.
import { loadFile, loadFileFromFolder, loadFileFromOnlineRepo } from '../index.js';

const OPTION_NULL_VALUE = -1;
const OPTION_CUSTOM_VALUE = -2;
const OPTION_CUSTOM_NEW_VALUE = -3;


/**
 * These windows are independent documents keyed by path: reopening one that is
 * already open is a no-op, and each closes on its own.
 */
const WINDOW_POLICY = WindowPolicy.BY_PATH;

const MANIFEST_PATH = 'murdermanifest.sodso.json';

export function addTreeElement(path, parent, readOnly, editorCallbacks) {
    const id = `file-window-${path.replace(/\//g, '_').replace('.json', '')}`;

    // The manifest is a navigation panel rather than an editable document, so it
    // gets a file list instead of an editor bar.
    if (path === MANIFEST_PATH) {
        const shell = createWindowShell({ id, parent, attributes: { path } });
        if (!shell) return false;

        const filesOrderList = fastDiv('files-order');
        parent.appendChild(filesOrderList);
        filesOrderList.appendChild(fastElement('ul'));
        shell.treeEl.classList.add('hidden');
        return shell.treeEl;
    }

    const window_ = createTreeWindow({
        id,
        parent,
        attributes: { path },
        title: `<h5 title="${path}">${path.split('.')[0]}</h5>`,
        actions: [
            { label: 'Save', onClick: () => editorCallbacks.save(true), when: !readOnly },
            { label: 'Copy', onClick: editorCallbacks.copySource },
            { label: 'Close', onClick: () => deleteTree(document.getElementById(id)) },
        ],
        // Its own row: the label is far longer than the others, and the editor bar
        // caps button width at 100px.
        secondaryActions: [
            {
                label: 'Select Override Fields',
                onClick: editorCallbacks.showSelectFieldsDialog,
                when: !readOnly,
                className: 'jsontree-editor-bar-field-select-button',
            },
        ],
    });

    // BY_PATH policy: already open is a no-op, not an error.
    if (!window_) return false;

    return window_.treeEl;
}

export function deleteTree(treeEleToClose) {
    closeWindow(treeEleToClose);
}

export function createInputElement(domNode, readOnly, onUpdateCallback) {
    const initialValue = domNode.innerText.replace(/"/g, '');

    // A GUID here is a reference to DDS content, so offer to go and edit it.
    const link = GUID_PATTERN.test(initialValue)
        ? { title: 'Open in the DDS editor', onClick: () => openDdsDocument(initialValue) }
        : null;

    return createTextEditor(domNode, { readOnly, link }, onUpdateCallback);
}

/** Hand a GUID to the DDS flow, working out what kind of document it names. */
async function openDdsDocument(guid) {
    // The reference data knows base game content; a mod's own GUIDs are not in it,
    // and the DDS flow works the type out when it loads the file.
    let documentType = null;

    if(window.ddsMap.trees.indexOf(guid) != -1) documentType = 'tree';
    else if(window.ddsMap.messages.indexOf(guid) != -1) documentType = 'message';
    else if(window.ddsMap.blocks.indexOf(guid) != -1) documentType = 'block';

    // Same app now, and the same content folder either side of the switch.
    await openInFlow('dds', { id: guid, type: documentType });
}

export function createSOSelectElement(domNode, options, selectedSO, readOnly, onUpdateCallback) {
    var selectedOptionMatch = selectedSO.match(/(?:REF:)?([\w-]+)\|([\w-]+).*/);
    var selectedOption = OPTION_CUSTOM_VALUE;

    let foundType = false;
    if(selectedOptionMatch) {
        let foundIndex = options.indexOf(selectedOptionMatch[2]);
        selectedOption = foundIndex >= 0 ? foundIndex : OPTION_CUSTOM_VALUE;
        foundType = selectedOptionMatch[1];
    } else if (selectedSO == 'null') {
        selectedOption = OPTION_NULL_VALUE;
        foundType = true;
    }

    var createdNodes = createEnumSelectElement(domNode, options, selectedOption, foundType, readOnly, onUpdateCallback);

    if(createdNodes.selectedCustomOption)
        createdNodes.selectedCustomOption.text = `Custom: ${selectedSO.replace(/"/g, "").replace("REF:", "").replace(/\w+\|/, '').trim()}`;

    var selectElement = $(domNode).find('select');

    // Инициализация select2
    selectElement.select2({dropdownParent: $('#trees')});

    // Синхронизация select2 и обычного select
    selectElement.on('change', function() {
        // Closed here, before anything that rebuilds the tree.
        //
        // While its dropdown is open select2 binds a scroll handler to every scrollable
        // ancestor that puts the scroll position back where it was -- that is how it
        // keeps the document still under an open dropdown -- and unbinds them when it
        // closes. Choosing an option rebuilds the tree, which takes this <select> away
        // before select2 gets that far, so the handler is left bound to the container,
        // which is not rebuilt. Every attempt to scroll the document is then snapped
        // back, for as long as the file stays open.
        selectElement.select2('close');

        let value = selectElement[0].value;
        let newCustomValue;
        if(value == OPTION_CUSTOM_NEW_VALUE)
        {
            let res = prompt('Enter prefab name', '');

            if (res === null) {
                return;
            }

            if ((res != 'null' && res !== null)) {
                res = makeCSVSafe(res);
            }

            newCustomValue = JSON.parse(res);
        }
        onUpdateCallback(value, newCustomValue);
    });

    return createdNodes;
}

export function createEnumSelectElement(domNode, options, selectedIndex, soFileType, readOnly, onUpdateCallback) {
    // A plain enum is just its options. A ScriptableObject reference can also be
    // nothing at all, or something this mod made that the base game has never heard
    // of, so those get entries of their own ahead of the list.
    const leadingOptions = soFileType
        ? [
            { value: OPTION_CUSTOM_NEW_VALUE, text: 'Custom...' },
            // Only shown while it is what the field holds: there is nothing to name
            // otherwise.
            ...(selectedIndex === OPTION_CUSTOM_VALUE || selectedIndex === OPTION_CUSTOM_NEW_VALUE
                ? [{ value: OPTION_CUSTOM_VALUE, text: 'Custom:' }]
                : []),
            { value: OPTION_NULL_VALUE, text: 'Nothing (null)' },
        ]
        : [];

    const { list: selectList, leading } = createSelectEditor(
        domNode,
        { options, selectedValue: selectedIndex, readOnly, leadingOptions },
        async (value) => {
            let newCustomValue;
            if(value == OPTION_CUSTOM_NEW_VALUE)
            {
                let res = prompt('Enter prefab name', '');

                if (res === null) {
                    return;
                }

                if ((res != 'null' && res !== null)) {
                    res = makeCSVSafe(res);
                }

                newCustomValue = JSON.parse(res);
            }
            onUpdateCallback(value, newCustomValue);
        }
    );

    const selectedCustomOption = leading[OPTION_CUSTOM_VALUE];

    if(soFileType) {
        if(selectedIndex == OPTION_CUSTOM_VALUE || window.dirHandleExportedSOPath || window.onlineTypes.includes(soFileType))
        {
            // Unclassed, as it has always been -- see createLinkButton.
            const linkButton = createLinkButton(null, () => {
                if(selectedIndex == OPTION_CUSTOM_VALUE) {
                    // Custom files load from the mod folder
                    const soName = selectedCustomOption.text.replace("Custom:", "").trim();
                    loadFile(soName, false);
                } else if(window.dirHandleExportedSOPath) {
                    // If we have loaded the game files locally, use those
                    const soName = selectList[selectList.selectedIndex].innerText.trim();
                    loadFileFromFolder(soFileType + '/' + soName + ".json", window.dirHandleExportedSOPath, true, soFileType);
                } else {
                    // Get the game files that are shared as part of this repo
                    const soName = selectList[selectList.selectedIndex].innerText.trim();
                    loadFileFromOnlineRepo(soFileType + '/' + soName + ".json", soFileType);
                }
            }, null);
            domNode.appendChild(linkButton);
        }
    }

    return { list: selectList, selectedCustomOption };
}
