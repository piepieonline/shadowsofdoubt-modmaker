import { fastElement, fastDiv } from '../../../core/dom.js';
import { createWindowShell, createTreeWindow, closeWindow, windowsChanged, WindowPolicy } from '../../../core/treeWindow.js';
import { createTextEditor, createSelectEditor, createLinkButton } from '../../../core/valueEditors.js';
import { searchSelect } from '../../../core/components/searchSelect/searchSelect.js';
import { makeCSVSafe } from '../../../core/strings.js';
import { GUID_PATTERN } from '../../../core/guid.js';
import { assetOfPath, stemFor, titleFor } from '../../../core/soFileName.js';
import { openInFlow } from '../../../core/navigation.js';
import { modFileOfAsset } from './contentList.js';
// Cyclic -- index.js imports this module -- but only called from a click handler, long
// after both have evaluated. scripts/ui.js reaches these the same way.
import { loadFile, openBaseGameAsset, useAsNewFile } from '../index.js';

const OPTION_NULL_VALUE = -1;
const OPTION_CUSTOM_VALUE = -2;
const OPTION_CUSTOM_NEW_VALUE = -3;

/**
 * Marks an option whose value is a name rather than a position.
 *
 * Every other option in these lists is an index into the base game's array for the type,
 * and that is what gets written to the file. An asset the mod defines has no such index,
 * so it carries its name instead and this is what tells the two apart. Exported because
 * index.js is what turns either into a `REF:`.
 */
export const MOD_PREFIX = 'mod:';

/** The mod's own, then the game's. Ungrouped entries -- "Custom…", "Nothing" -- stay on top. */
const MODDED_LABEL = 'Modded';
const VANILLA_LABEL = 'Vanilla';

/**
 * Sort a built `<select>` into its two sections.
 *
 * Done to the finished element rather than while building it, because what builds it is
 * `createSelectEditor` in core, which both flows share and which has no notion of a mod.
 * The options it made are moved, not remade: their values are what the document stores.
 *
 * The leading options are left where they are. "Nothing (null)" and "Custom…" are not
 * assets of either kind, and filing them under a heading would say they were.
 */
function groupOptions(list, modded, selectedValue) {
    if (!list || !modded.length) return;

    const assets = [...list.querySelectorAll('option')]
        .filter((option) => Number(option.value) >= 0);
    if (!assets.length) return;

    const vanilla = document.createElement('optgroup');
    vanilla.label = VANILLA_LABEL;
    for (const option of assets) vanilla.appendChild(option);

    const own = document.createElement('optgroup');
    own.label = MODDED_LABEL;
    for (const name of modded) {
        const option = document.createElement('option');
        option.value = MOD_PREFIX + name;
        option.text = name;
        option.selected = option.value === selectedValue;
        own.appendChild(option);
    }

    list.append(own, vanilla);
}


/**
 * These windows are independent documents keyed by path: reopening one that is
 * already open is a no-op, and each closes on its own.
 */
const WINDOW_POLICY = WindowPolicy.BY_PATH;

const MANIFEST_PATH = 'murdermanifest.sodso.json';

/** The element id a document's window has. Everything about it is derived from the path. */
export const windowIdFor = (path) => `file-window-${path.replace(/\//g, '_').replace('.json', '')}`;

/**
 * Point an open window at a file that has been renamed underneath it.
 *
 * The id, the `path` attribute the session is captured from, and the title are all the
 * path in different forms, so they move together or the window is left claiming to be a
 * file that no longer exists.
 */
export function renameTreeWindow(windowEl, newPath, fileType) {
    if (!windowEl) return;

    windowEl.id = windowIdFor(newPath);
    windowEl.setAttribute('path', newPath);

    const heading = windowEl.querySelector('.doc-title h5');
    if (heading) {
        heading.innerText = titleFor(newPath, fileType);
        heading.title = newPath;
    }

    // The window is showing a document at a path nothing else knows about yet -- the URL
    // still names the file this one was opened as, which no longer exists.
    windowsChanged();
}

/**
 * @param fileType what the document is, which titles the window and is what a copy of a
 *                 base game asset would be created as
 * @param source   where the document was read from -- see `Source` in index.js. Recorded
 *                 on the window because a path does not say, and opening it again needs
 *                 to know
 */
export function addTreeElement(path, parent, readOnly, fileType, source, editorCallbacks) {
    const id = windowIdFor(path);

    // The manifest is a navigation panel rather than an editable document, so it
    // gets a file list instead of an editor bar.
    if (path === MANIFEST_PATH) {
        const shell = createWindowShell({ id, parent, attributes: { path, source } });
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
        attributes: { path, source },
        // The type, then the name -- see core/soFileName.js. The file itself is the
        // tooltip: it is what the manifest lists and what the folder holds, which is
        // worth being able to read but is not what the document is.
        title: `<h5 title="${path}">${titleFor(path, fileType)}</h5>`,
        actions: [
            { label: 'Save', onClick: () => editorCallbacks.save(true), when: !readOnly },
            { label: 'Copy', onClick: editorCallbacks.copySource },
            // Only on the base game's assets, and only because there is nothing else to
            // do with one: it cannot be saved, so the way it gets used is by becoming
            // the copyFrom of a file the mod owns. Reaching that through the new file
            // dialog meant finding the asset again in a list of every asset there is,
            // having just been looking at it.
            {
                label: 'Use as...',
                title: 'Create a file in this mod that copies from this asset',
                onClick: () => useAsNewFile(fileType, assetOfPath(path, fileType)),
                when: readOnly,
            },
            // From the button rather than by the id captured here: renaming a preset
            // renames its window with it, so the id this was opened under is one
            // nothing answers to any more and the document could not be closed.
            {
                label: 'Close',
                onClick: (event) => deleteTree(event.currentTarget.closest('.file-window')),
            },
        ],
        // A row of their own: the first label is far longer than Save/Copy/Close, and
        // the editor bar caps button width at 100px.
        secondaryActions: [
            // Only where choosing fields means something. One of the mod's own files is
            // made of the fields it states; a patch holds the whole asset and saves what
            // has changed about it, so there is no set of fields to pick -- see
            // loadFileContent, which is where that is decided.
            {
                label: 'Select Override Fields',
                onClick: () => editorCallbacks.showSelectFieldsDialog(),
                when: !readOnly && Boolean(editorCallbacks.showSelectFieldsDialog),
                className: 'jsontree-editor-bar-field-select-button',
            },
            // Built for every document that can be edited, and hidden by the flow while
            // there is nothing for it to open -- a file the mod wrote from nothing is
            // derived from nothing, and `copyFrom` is re-pointed long after this bar was
            // built. See syncOpenBase in loadFileContent.
            //
            // Absent on a read-only asset for the reason its copyFrom row is still shown:
            // there the row is the route through, and a second one beside it would be the
            // same journey twice.
            {
                label: 'Open Base',
                title: 'Open the asset this one is copied from, or the one it overrides',
                onClick: () => editorCallbacks.openBase(),
                when: !readOnly,
                className: 'jsontree-editor-bar-open-base-button',
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

/**
 * What the current mod defines of this type, offered ahead of the base game's.
 *
 * An author writing a reference is usually pointing at something they just made, and
 * until now the only way to say so was "Custom…" and typing the name -- against a list of
 * every shipped asset of that type, none of which was the one they wanted.
 *
 * A base game asset the mod patches appears under both headings. The name is the shipped
 * one and the values behind it are the mod's, and neither of those is the whole truth on
 * its own; showing it once under each is the reading that does not have to choose.
 *
 * @param memoryKey what this field is, so the dropdown can put back the term last searched
 *                  in it. Names the field rather than this control, which is thrown away
 *                  and rebuilt on every edit to the document -- see searchSelect.
 */
export function createSOSelectElement(domNode, options, selectedSO, readOnly, onUpdateCallback, modded = [], memoryKey = null) {
    var selectedOptionMatch = selectedSO.match(/(?:REF:)?([\w-]+)\|([\w-]+).*/);
    var selectedOption = OPTION_CUSTOM_VALUE;

    let foundType = false;
    if(selectedOptionMatch) {
        const name = selectedOptionMatch[2];

        // The mod's own first, and by name: it has no index, since indices are positions
        // in the base game's list. A name in both is shown as the mod's, which is what it
        // will be once the game loads the folder.
        let foundIndex = modded.includes(name) ? MOD_PREFIX + name : options.indexOf(name);

        selectedOption = foundIndex === -1 ? OPTION_CUSTOM_VALUE : foundIndex;
        foundType = selectedOptionMatch[1];
    } else if (selectedSO == 'null') {
        selectedOption = OPTION_NULL_VALUE;
        foundType = true;
    }

    var createdNodes = createEnumSelectElement(domNode, options, selectedOption, foundType, readOnly, onUpdateCallback);

    groupOptions(createdNodes.list, modded, selectedOption);

    if(createdNodes.selectedCustomOption)
        createdNodes.selectedCustomOption.text = `Custom: ${selectedSO.replace(/"/g, "").replace("REF:", "").replace(/\w+\|/, '').trim()}`;

    var selectElement = $(domNode).find('select');

    // Searchable, through the shared control. Its options are already on the element --
    // built by createSelectEditor above, where a value is an index and the leading
    // entries mean something other than one -- so no list is passed and it adopts them.
    //
    // The dropdown is parented to #trees rather than left beside the control, and it is
    // closed before this handler runs. Both of those now belong to the control; see
    // core/components/searchSelect/searchSelect.js for why the second one matters.
    searchSelect(selectElement[0], {
        parent: document.querySelector('#trees'),
        memoryKey,
        onChange: function(value) {
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
        },
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
        // One of the mod's own is always reachable -- it is a file in the folder that is
        // already open -- where a base game asset needs somewhere to be read from.
        const ownAsset = String(selectedIndex).startsWith(MOD_PREFIX);

        if(selectedIndex == OPTION_CUSTOM_VALUE || ownAsset || window.dirHandleExportedSOPath || window.onlineTypes.includes(soFileType))
        {
            // Unclassed, as it has always been -- see createLinkButton.
            const linkButton = createLinkButton(null, () => {
                const chosen = selectList.options[selectList.selectedIndex];
                const custom = selectedIndex == OPTION_CUSTOM_VALUE;

                // The asset the field names. A custom value is the only one the list
                // does not hold, so it is the only one read from anywhere else.
                const soName = custom
                    ? selectedCustomOption.text.replace("Custom:", "").trim()
                    : chosen.innerText.trim();

                // Which of the two the author picked, when a name is on the list twice.
                // A patched base game asset appears under both headings and the text
                // cannot tell them apart -- only the value can, and the mod's carry
                // their name where the game's carry an index.
                const wantsModded = custom || String(chosen?.value ?? '').startsWith(MOD_PREFIX);

                // From the folder listing rather than by building a file name: an asset
                // is not always stored under its own name, and never under it alone.
                // See modFileOfAsset.
                const own = wantsModded ? modFileOfAsset(soFileType, soName) : null;

                if (own) {
                    loadFile(own.id, false, own.openAs ?? soFileType, own.suffix);
                } else if (custom) {
                    // Named as one of the mod's but not in the folder. Asked for by the
                    // name it would be stored under, so the answer is that it is not
                    // there rather than that some other file of that name is.
                    loadFile(stemFor(soName, soFileType), false, soFileType);
                } else {
                    // One of the base game's, wherever this copy of the tool can reach it
                    // -- the author's export if they have connected one, and what ships
                    // with the tool otherwise. Open Base goes the same way.
                    openBaseGameAsset(soFileType, soName);
                }
            }, null);
            domNode.appendChild(linkButton);
        }
    }

    return { list: selectList, selectedCustomOption };
}
