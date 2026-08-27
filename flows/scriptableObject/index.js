import { tryGetFile } from '../../core/fs.js';
import { assertModSelected, shouldSave, toSaveSafeJSON, writeWholeFile } from '../../core/persistence.js';
import { createEditLoop } from '../../core/document.js';
import { decorateValueNodes, NodeKind } from '../../core/valueNodes.js';
import { getJSONPointer } from '../../core/jsonPointer.js';
import { describeField, fieldPath, resolveField } from '../../core/typeHints.js';
import { parseEditedValue } from '../../core/valueEditors.js';
import { fastElement } from '../../core/dom.js';
import { addTreeElement, deleteTree, createInputElement, createSOSelectElement, createEnumSelectElement } from './scripts/jsonTreeAdditions.js';
import { cloneTemplate, createFileIfNotExisting, createOverrideIfNotExisting } from './scripts/modFileManager.js';
import { setNewFileMode, updateNewFileCopyFrom } from './scripts/ui.js';
import { NEW_SUFFIX } from './scripts/contentList.js';

export const DUMMY_KEYS = {
    'LOCALISATION_DUMMY_KEY': '_ENG Localisation_',
    'NEWSPAPER_DUMMY_KEY': '_Newspaper Article Configuration_'
};

export async function initAndLoad(path) {
    let openWindows = document.querySelectorAll('.file-window');
    for(let i = openWindows.length - 1; i >= 0; i--) {
        deleteTree(openWindows[i]);
    }
    await loadFile(path, false);
}

/**
 * Open a file in the content folder by name. `suffix` says which of the two files
 * that name can stand for; everything but the file panel means the mod's own asset.
 */
export async function loadFile(path, readOnly, type, suffix = NEW_SUFFIX) {
    loadFileFromFolder(path + suffix, window.selectedMod.baseFolder, readOnly, type);
}

export async function loadFileFromFolder(path, folderHandle, readOnly, type) {
    let loadedFile = await tryGetFile(folderHandle, path.split('/'));
    let loadedFileContent = await (await (loadedFile)?.getFile())?.text();
    loadFileContent(path, loadedFileContent, readOnly, type);
}

/**
 * The base game assets shipped with this tool, for looking at without the game files.
 *
 * Resolved against this module rather than the page: these used to be fetched from
 * `data/`, which was right while this flow was a site of its own and has pointed at
 * nothing since it became a flow served from the repo root. The fetch 404ed and the
 * error page was handed to JSON.parse.
 *
 * They now live in refs/assets/ with the rest of the generated reference data. Fetched
 * rather than imported: it is 12 MB across 1500 files, and one is read at a time.
 */
const ASSET_DATA = new URL('../../refs/assets/', import.meta.url);

export async function loadFileFromOnlineRepo(path, type) {
    const response = await fetch(new URL(path, ASSET_DATA));

    if (!response.ok) {
        alert(`${path} is not among the base game assets included with this tool`);
        return;
    }

    loadFileContent(path, await response.text(), true, type);
}

export async function loadFileContent(path, loadedFile, readOnly, type) {
    if(!loadedFile) {
        alert(`${path} doesn't exist or is a vanilla asset - create it in the manifest first`);
        return;
    }

    const isManifestFile = path === 'murdermanifest.sodso.json';

    // Manifest Frame
    // By id, not by position: the file list is a div in this panel too, and it now
    // comes first.
    let DOMtarget = isManifestFile ? document.getElementById('manifest_content_tree') : document.getElementById('trees');

    let treeEle = addTreeElement(path, DOMtarget, readOnly, { copySource, save, showSelectFieldsDialog });

    if(!treeEle) return;

    var rawTextData = loadedFile;
    
    // Strip whitespace
    var data = JSON.parse(rawTextData);
    // Replace Unity references with string refs
    rawTextData = JSON.stringify(data).replaceAll(/({"m_FileID.*?(\d+).*?})/g, (rawMatch, fullMatch, id) => {
        return window.pathIdMap[id] ? `"REF:${window.pathIdMap[id]}"` : null;
    });
    
    data = JSON.parse(rawTextData);

    let fileType = data.fileType || type || "Manifest";

    // Show actual text
    // createDummyKeys(data);

    // Create json-tree
    var tree = jsonTree.create(data, treeEle);

    // Declared here rather than inside runTreeSetup: runTreeSetup assigns
    // tree.updateTree at its top, and runs repeatedly as the tree is rebuilt.
    const updateTree = createEditLoop({
        tree,
        getData: () => data,
        setData: (next) => { data = createDummyKeys(next); },
        onRebuild: () => runTreeSetup(),
        save: () => save(),
        afterRebuild: () => markDefaultValues(),
    });

    runTreeSetup();
    markDefaultValues();

    if(isManifestFile) {
        document.querySelector('#manifest_add_item_button').onclick = () => { tree.addNewArrayElement(['Manifest', 'fileOrder'], '/fileOrder') };
    }

    function createDummyKeys(data) {
        return data;
    }

    /**
     * The game's name for the type a path lands on, or undefined if the layout does not
     * describe it.
     *
     * This was `mapSplitPath`, a recursion that mutated the array it was handed and threw
     * on an unknown type. It also carried a branch returning `window.typeMap[type]` -- the
     * list of asset *names* where a type name was expected -- reachable only by a path
     * continuing past a reference, which cannot happen: a reference is a leaf string.
     */
    function typeAtPath(splitPath) {
        // The document's own `type` field names the file's type rather than holding a
        // value of one, so the layout has nothing to say about it.
        if (splitPath.length === 2 && splitPath[0] === fileType && splitPath[1] === 'type') {
            return 'FileType';
        }

        return resolveField(splitPath, window.typeLayout)?.type;
    }

    async function runTreeSetup() {
        // Nasty, but this code is shocking anyway
        tree.addNewArrayElement = addNewArrayElement;
        tree.updateTree = updateTree;

        // If we are rebuilding the manifest tree, empty out the buttons from the visual manifest panel
        if(isManifestFile) {
            document.querySelector('#manifest_panel .files-order ul').replaceChildren();
        }

        // What this field is for, if anything says. The lookup used to hop exactly one
        // level up the path, so anything deeper than a type's own field fell into a bare
        // catch and quietly had no tooltip at all -- and the two halves of it disagreed on
        // an array element, one keyed by path and the other by label.
        //
        // This pass also used to assign pathToItem and pathToItemGeneric to every node.
        // Nothing read them: core/document.js identifies nodes by JSON Pointer, and the
        // split-path form the tooltip wanted is fieldPath() in core/typeHints.js.
        tree.findAndHandle(() => true, item => {
            const labelEle = item.el.querySelector('.jsontree_label');
            if (!labelEle) return;

            labelEle.title = describeField([fileType, ...fieldPath(item)], {
                typeLayout: window.typeLayout,
                descriptions: window.fieldDescriptions,
            });
        });

        // Auto-expand the useful keys
        let expandedNodes = ['fileOrder', 'blocks', 'replacements'];
        tree.expand(function (node) {
            if (expandedNodes.includes(node.label)) {
                node.childNodes.forEach(child => child.expand !== undefined && child.expand());
                return true;
            }
        });

        // Links for trees and blocks
        tree.findAndHandle(item => {
            // return item.el.querySelector('.jsontree_value_string')?.innerText?.includes("REF:");
            var typeMatch = item.el.querySelector('.jsontree_value_string')?.innerText?.match(/REF:(\w+)/)
            return typeMatch && !window.typeMap[typeMatch[1]];
        }, async item => {
            var ele = item.el.querySelector('.jsontree_value_string');
            const refPath = ele.innerText.replace(/"/g, "").replace("REF:", "").replace(/\w+\|/, '');

            if(!ele.classList.contains('link-element')) {
                ele.classList.add('link-element')
    
                ele.addEventListener('click', () => {
                    loadFile(refPath, false);
                }); 
            }

            if (isManifestFile && !item.isComplex) {
                let ul = document.querySelector('#manifest_panel .files-order ul');
                let li = fastElement("li");
                let file_link = fastElement("button", "secondary");
                file_link.setAttribute('type', 'submit');
                file_link.innerText = ele.innerText.replace(/REF:|"|'/g, '');
                // The button truncates a name too long for the panel, so the whole of
                // it has to be readable somewhere. The DDS flow's entries do the same.
                file_link.title = file_link.innerText;
                file_link.addEventListener('click', () => {
                    loadFile(refPath, false);
                });
                li.appendChild(file_link);
                ul.appendChild(li);
            }
        });

        // What kind of editor each value gets. This flow walks the game's type
        // layout, which can resolve a node to an enum, a reference to another
        // ScriptableObject, or something the user must not edit.
        decorateValueNodes(tree, {
            resolveNode: (item, valueEl) => {
                const splitPath = [fileType, ...fieldPath(item)];
                let mappedType = typeAtPath(splitPath);

                // copyFrom points at another file of this same type.
                if (splitPath.at(-1) === 'copyFrom') mappedType = fileType;

                let currentValue = valueEl.innerText;
                if (currentValue === 'false') currentValue = 0;
                if (currentValue === 'true') currentValue = 1;

                if (mappedType && window.enums[mappedType]?.length > 0) {
                    return { kind: NodeKind.ENUM, options: window.enums[mappedType], currentValue };
                }
                if (window.typeMap[mappedType]) {
                    return { kind: NodeKind.REFERENCE, type: mappedType, currentValue };
                }
                if (mappedType === 'FileType') {
                    return { kind: NodeKind.READ_ONLY };
                }
                // fileType names the document's own type and is set at creation.
                return { kind: NodeKind.TEXT, readOnly: readOnly || splitPath.at(-1) === 'fileType' };
            },
            render: {
                [NodeKind.ENUM]: (valueEl, item, node) => {
                    createEnumSelectElement(
                        valueEl, node.options, node.currentValue, false, readOnly,
                        async (selectedIndex) => {
                            await updateTree([{
                                op: 'replace',
                                path: getJSONPointer(item),
                                value: parseInt(selectedIndex),
                            }]);
                        }
                    );
                },
                [NodeKind.REFERENCE]: (valueEl, item, node) => {
                    createSOSelectElement(
                        valueEl, window.typeMap[node.type], node.currentValue, readOnly,
                        async (selectedIndex, customValue) => {
                            let value;
                            if (selectedIndex == -1) {
                                value = null;
                            } else if (selectedIndex >= 0) {
                                value = `REF:${node.type}|${window.typeMap[node.type][selectedIndex]}`;
                            } else {
                                value = `REF:${node.type}|${customValue}`;
                            }
                            await updateTree([{
                                op: 'replace',
                                path: getJSONPointer(item),
                                value,
                            }]);
                        }
                    );
                },
                [NodeKind.TEXT]: (valueEl, item, node) => {
                    createInputElement(valueEl, node.readOnly, async (typed) => {
                        assertModSelected();

                        // Returning false puts the control back: see createTextEditor.
                        const edited = parseEditedValue(typed, { isString: item.type == 'string' });
                        if (!edited.ok) return false;

                        const { value: parsed, raw } = edited;
                        if (parsed || parsed === false || parsed === 0 || parsed === '' || raw === 'null') {
                            await updateTree([{
                                op: 'replace',
                                path: getJSONPointer(item),
                                value: parsed,
                            }]);
                        }
                    });
                },
            },
        });

        if(!readOnly) {
            // Removing element
            tree.findAndHandle(item => {
                return item.parent.type === 'array';
            }, item => {
                var ele = item.el.querySelector('.jsontree_label');
                ele.addEventListener('contextmenu', async (e) => {
                    e.preventDefault();

                    if (!window.selectedMod) {
                        alert('Please select a mod to save in first');
                        throw 'Please select a mod to save in first';
                    }

                    if (confirm('Remove Element?')) {
                        updateTree([
                            {
                                op: 'remove',
                                path: getJSONPointer(item)
                            }
                        ]);
                    }
                });
            });

            // Adding element
            tree.findAndHandle(item => {
                return item.type === 'array';
            }, item => {
                var ele = item.el.querySelector('.jsontree_label');
                ele.addEventListener('contextmenu', async (e) => {
                    e.preventDefault();
                    addNewArrayElement([fileType, ...fieldPath(item)], getJSONPointer(item));
                });
            });
        }

        async function addNewArrayElement(splitPath, addToPath) {
            if (!window.selectedMod) {
                alert('Please select a mod to save in first');
                throw 'Please select a mod to save in first';
            }
            let mappedType = typeAtPath(splitPath);

            let newContent;
            if(window.typeMap[mappedType])
                newContent = `REF:${mappedType}|${window.typeMap[mappedType][0]}`;
            else
                newContent = await getTemplateForItem(mappedType);

            if (newContent === null) return;

            updateTree([
                {
                    op: 'add',
                    path: addToPath + '/-',
                    value: newContent
                }
            ]);
        }

    }

    async function copySource() {
        navigator.clipboard.writeText(getSaveSafeJSON());
    }

    async function save(force) {
        assertModSelected();
        if (!shouldSave(force)) return;
        await writeWholeFile(window.selectedMod.baseFolder, path.split('/'), getSaveSafeJSON());
    }

    async function showSelectFieldsDialog() {
        let fieldList = document.querySelector('#select-fields-modal-field-list');
        fieldList.replaceChildren();
        document.querySelector('#select-fields-modal').setAttribute("open", "");

        let hiddenFields = ['presetName', 'copyFrom', 'name', 'type'];
        let dataToShow = Object.keys(window.templates[data.fileType]).filter(el => !hiddenFields.includes(el));
        let currentFields = Object.keys(data).filter(el => !hiddenFields.includes(el));

        let isSelectAllChecked = false;
        let isSelectAllIndeterminate  = false;

        dataToShow.forEach(key => {
            let li = document.createElement('li');
            let label = document.createElement('label');
			let checkbox = document.createElement("input");
			checkbox.type = 'checkbox';
			checkbox.value = key;

            if(currentFields.includes(key)) {
                checkbox.setAttribute('checked', true);
                isSelectAllChecked = true;
            } else {
                if(isSelectAllChecked) isSelectAllIndeterminate = true;
            }

            label.appendChild(checkbox)
            label.innerHTML += key;
			li.appendChild(label);
			fieldList.appendChild(li);

            // TODO: Not working?
            /*
            checkbox.addEventListener('change', () => {
                document.querySelector('#select-fields-modal-select-all').indeterminate = true;
                console.log('asd')
            });
            */
		});

        // Setup the Select all option
        if(isSelectAllIndeterminate) {
            document.querySelector('#select-fields-modal-select-all').indeterminate = true;
            document.querySelector('#select-fields-modal-select-all').checked = false;
        } else {
            document.querySelector('#select-fields-modal-select-all').indeterminate = false;
            document.querySelector('#select-fields-modal-select-all').checked = isSelectAllChecked;
        }

        // We only want the one handler
        document.querySelector('#select-fields-submit-button').onclick = () => {
            let patches = [];

            fieldList.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
                // If it's currently included, but unchecked, delete it
                if(currentFields.includes(checkbox.value) && !checkbox.checked) {
                    patches.push({
                        op: 'remove',
                        path: '/' + checkbox.value
                    });
                }
                // If it's not currently included, but is now checked, add it with the default value
                else if(!currentFields.includes(checkbox.value) && checkbox.checked) {
                    patches.push({
                        op: 'add',
                        path: '/' + checkbox.value,
                        value: window.templates[data.fileType][checkbox.value]
                    });
                }
            });
            
            tree.updateTree(patches);
            document.querySelector('#select-fields-modal').removeAttribute('open');
        }
    }

    function getSaveSafeJSON() {
        return toSaveSafeJSON(data, DUMMY_KEYS);
    }

    function markDefaultValues()
    {
        tree.findAndHandle(item => {
            return item.parent.isRoot;
        }, item => {
            let itemLabel = item.label;
            if(fileType in window.templates && itemLabel in window.templates[fileType] && JSON.stringify(data[itemLabel]) === JSON.stringify(window.templates[fileType][itemLabel]))
            {
                item.el.classList.add('default-value-node');
            }
        });
    }
}

export async function getTemplateForItem(templateName) {
    let newTemplate = 'PLACEHOLDER';

    if(templateName === "FileType")
    {
        let { name, type, copyFrom, mode } = await showNewFilePopup();
        closeNewFilePopup();

        if(name == null || type == null)
        {
            console.log("cancelled");
            return null;
        }

        // An override is named after the asset it overrides -- that pairing is the
        // whole of what makes it an override -- so the dropdown names the file and
        // the File Name field has no say in it.
        const overriding = mode === 'override';
        const fileName = overriding ? copyFrom : name;

        if (overriding) {
            // Not a template: every field a patch carries is a field it overrides, so
            // a new one carries as little as it can get away with.
            await createOverrideIfNotExisting(fileName, type, window.selectedMod.baseFolder);
        } else {
            await createFileIfNotExisting(fileName, type, window.selectedMod.baseFolder, (content) => {
                content.name = fileName;
                content.presetName = fileName;
                content.type = type;
                content.copyFrom = copyFrom ? `REF:${type}|${copyFrom}` : null;
                return content;
            });
        }

        // The folder has a new file in it.
        const { refreshPanel } = await import('./scripts/ui.js');
        await refreshPanel();

        return `REF:${fileName}`;
    }

    newTemplate = cloneTemplate(templateName);
    return newTemplate;
}

/**
 * Creates a promise that is pending while the new case modal is open, and resolves to
 * null if it is dismissed. Dismissing used to leave the promise pending for good,
 * which now matters: the caller has a folder waiting to be laid out.
 */
export async function showNewCasePopup() {
    let popupPromise = new Promise((resolve) => {
        window.newCasePromiseResolve = (type) => resolve(type == null ? null : { type });
    });

    document.querySelector('#new-case-modal').toggleAttribute('open', true);

    return popupPromise;
}

export function cancelNewCasePopup() {
    window.newCasePromiseResolve?.(null);
    closeNewCasePopup();
}

export function closeNewCasePopup() {
    document.querySelector('#new-case-modal').toggleAttribute('open', false);
}

// Creates a promise that is pending while the new file model is open
export async function showNewFilePopup() {
    let popupPromise = new Promise((resolve, reject) => {
        window.newFilePromiseResolve = (name, type, copyFrom, mode) =>
            resolve({ name, type, copyFrom: (copyFrom === 'None' ? null : copyFrom), mode });
        window.newFilePromiseReject = () => reject({ name: null, type: null, copyFrom: null, mode: null });
    });

    // Opening is the only point at which the file type is known to be settled, so the
    // list is filled here rather than left empty until the type select is touched.
    updateNewFileCopyFrom();
    setNewFileMode('copy');

    document.querySelector('#new-file-modal').toggleAttribute('open', true);

    return popupPromise;
}

export function closeNewFilePopup() {
    document.querySelector('#new-file-modal').toggleAttribute('open', false);
    document.querySelector('#new-file-modal-file-name').value = '';
}

export function deepReplace (obj, keyName, replacer) {
    if(obj.hasOwnProperty(keyName)) {
        return replacer(obj[keyName]);
    } else {
        let keys = Object.keys(obj);
        // ki/i were undeclared, so they leaked to the global scope and would throw
        // under module strict mode.
        for (let ki = 0; ki < keys.length; ki++) {
            let key = keys[ki];
            if (Array.isArray(obj[keys[ki]])) {
                for (let i = 0; i < obj[key].length; i++) {
                    obj[key][i] = deepReplace(obj[key][i], keyName, replacer)
                }
            } else if (typeof obj[key] === "object") {
                obj[key] = deepReplace(obj[key], keyName, replacer);
            }
        }
    }

    return obj;
}
