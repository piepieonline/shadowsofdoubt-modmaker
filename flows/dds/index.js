import { getFile, readFileContent, tryGetFile } from '../../core/fs.js';
import { assertModSelected, shouldSave, toSaveSafeJSON, writeWholeFile, writePatchAgainstVanilla } from '../../core/persistence.js';
import { createEditLoop } from '../../core/document.js';
import { decorateValueNodes, NodeKind } from '../../core/valueNodes.js';
import { createTextEditor, createSelectEditor, parseEditedValue, renderedValue, setValue } from '../../core/valueEditors.js';
import { getJSONPointer } from '../../core/jsonPointer.js';
import { GUID_PATTERN } from '../../core/guid.js';
import { addTreeElement } from './scripts/jsonTreeAdditions.js';
import { cloneTemplate, createNewFile, createFileIfNotExisting, addOrModifyStrings, ddsContentFolder, modPath } from './scripts/modFileManager.js';
import { DDS_BLOCKS_VIRTUAL, readManifest, stringsFileHandle, toReal } from './scripts/ddsManifest.js';
import { newFile, refreshPanel } from './scripts/ui.js';

export const DUMMY_KEYS = {
    'LOCALISATION_DUMMY_KEY': '_ENG Localisation_',
    'NEWSPAPER_DUMMY_KEY': '_Newspaper Article Configuration_'
};

export const LOCALISATION_MISSING_STRING = 'MISSING GUID IN dds.csv';


export async function initAndLoad(path) {
    window.stringMapping = {};
    window.moddedStringMapping = {};
    await loadI18n();
    await loadFile(path, 0);
}

export async function loadI18n() {
    function parseStringsFile(csv, source) {
        return (csv ?? '').split('\n').reduce((map, val) => {
            var lineContent = val.split(',');

            // Sanity Check each line
            if (lineContent.length < 7) return map;

            var guid = lineContent[0].replaceAll('"', '');
            var message = lineContent[2];

            if (message?.startsWith('"') && !message.endsWith('"')) {
                var i = 3;
                do {
                    message += "," + lineContent[i];
                    i++;
                } while (!lineContent[i - 1].endsWith('"'))
            }

            map[guid] = { text: message, source };
            return map;
        }, {});
    }

    window.stringMapping = parseStringsFile(
        await readFileContent(await getFile(window.dirHandleStreamingAssets, ['Strings', 'English', 'DDS', 'dds.blocks.csv'])),
        'StreamingAssets'
    );

    // Try to load the existing mod DDS file. Just skip if it's missing -- which now
    // includes a manifest pointing at a file that is not there.
    try
    {
        if (window.selectedMod != null) {
            // The mod decides where its block text lives, so follow the manifest to it
            // rather than assuming the folder the game reads it from.
            const ddsFolder = await ddsContentFolder(window.selectedMod.baseFolder);
            const manifest = await readManifest(ddsFolder);
            const handle = await stringsFileHandle(ddsFolder, toReal(manifest, DDS_BLOCKS_VIRTUAL), false);

            window.moddedStringMapping = handle
                ? parseStringsFile(await readFileContent(handle), 'Mod')
                : {};
        }
    }
    catch
    {
        // Was an implicit global, which resolved to window.moddedStringMapping in a
        // classic script but throws under module strict mode.
        window.moddedStringMapping = {};
    }
}

export async function loadFile(path, thisTreeCount, parentData = null, openTheseIds = null) {
    var data = null;
    var fileType;
    
    var vanillaDataFile = await (await (await tryGetFile(window.dirHandleStreamingAssets, path.split('/')))?.getFile())?.text();
    var patchDataFile = window.selectedMod != null ? (await (await (await tryGetFile(window.selectedMod.baseFolder, modPath(path + '_patch')))?.getFile())?.text()) : null;
    
    if (vanillaDataFile != null) {
        data = JSON.parse(vanillaDataFile);
        if (patchDataFile != null) {
            data = jsonpatch.applyPatch(data, JSON.parse(patchDataFile)).newDocument;
        }
    } else {
        data = JSON.parse(await (await (await tryGetFile(window.selectedMod.baseFolder, modPath(path)))?.getFile())?.text());
    }
    
    // Show actual text
    createDummyKeys(data);
    
    // Create json-tree
    var treeEle = addTreeElement(thisTreeCount, document.getElementById('trees'), { path, name: data.name }, { copySource, useAsTemplate, save })
    var tree = jsonTree.create(data, treeEle);

    const updateTree = createEditLoop({
        tree,
        getData: () => data,
        setData: (next) => { data = createDummyKeys(next); },
        onRebuild: () => runTreeSetup(),
        save: () => save(),
    });

    runTreeSetup();

    let fileName = path.split('/').at(-1);
    if (['tree', 'msg', 'block'].includes(fileName.split('.')[1]) && fileName.split('.')[0] != data.id) {
        alert('Filename doesn\'t match id! File will not work in game!');
    }

    if(path.endsWith(".tree")) {
        fileType = 'tree';
        let validMessageId = data.messages.find(msg => GUID_PATTERN.test(msg.msgID))?.msgID;

        if(openTheseIds) {
                
        }

        if(validMessageId)
            await loadFile(`DDS/Messages/${validMessageId}.msg`, 1, data)
    } else if(path.endsWith(".msg")) {
        fileType = 'message';
        let validBlockId = data.blocks.find(block => GUID_PATTERN.test(block.blockID))?.blockID;
        if(validBlockId)
            await loadFile(`DDS/Blocks/${validBlockId}.block`, 2, data)
    } else if(path.endsWith('.block')) {
        fileType = 'block';
    }

    function createDummyKeys(data) {
        function createDummyLocalisationKey(obj, id) {
            let value = window.moddedStringMapping[id]?.text || window.stringMapping[id]?.text || LOCALISATION_MISSING_STRING;

            if (value.startsWith('"')) {
                value = value.substring(1, value.length - 1);
            }

            obj[DUMMY_KEYS.LOCALISATION_DUMMY_KEY] = value;
        }

        if (path.includes('Blocks')) {
            createDummyLocalisationKey(data, data.id);
            for (var i = 0; i < data.replacements.length; i++) {
                createDummyLocalisationKey(data.replacements[i], data.replacements[i].replaceWithID);
            }
        }

        if (parentData?.treeType == 3) { // Newspaper
            data[DUMMY_KEYS.NEWSPAPER_DUMMY_KEY] = data.id;
        }
        return data;
    }

    async function modifyTreeElement(jsonPointer, newValue) {
        await updateTree([{ op: 'replace', path: jsonPointer, value: newValue }]);
    }

    async function runTreeSetup() {
        // Auto-expand the useful keys
        let expandedNodes = ['messages', 'blocks', 'replacements']
        tree.expand(function (node) {
            if (expandedNodes.includes(node.label)) {
                node.childNodes.forEach(child => child.expand());
                return true;
            }
        });

        // A newspaper tree names an article that is configured in a file of its own,
        // which is written the first time the tree is opened rather than on save.
        tree.findAndHandle(item => {
            return item.label === DUMMY_KEYS.NEWSPAPER_DUMMY_KEY;
        }, async item => {
            await createFileIfNotExisting('newspaper', renderedValue(item));
        });

        // Editing operations

        // What kind of editor each value gets. This flow keys enums off the field
        // name; anything else is edited as text.
        decorateValueNodes(tree, {
            resolveNode: (item, valueEl) => {
                const options = window.enums[item.label];
                if (options?.length > 0) {
                    return { kind: NodeKind.ENUM, options, currentValue: valueEl.innerText };
                }

                return {
                    kind: NodeKind.TEXT,
                    link: openTargetFor(item, valueEl),
                    // The newspaper key is a way in to the article's own file rather
                    // than part of this document: it is resolved on load and stripped
                    // on save, so there is nothing here to edit.
                    readOnly: item.label === DUMMY_KEYS.NEWSPAPER_DUMMY_KEY,
                };
            },
            render: {
                [NodeKind.ENUM]: (valueEl, item, node) => {
                    createSelectEditor(
                        valueEl, { options: node.options, selectedValue: node.currentValue },
                        async (value) => {
                            await modifyTreeElement(getJSONPointer(item), parseInt(value));
                        }
                    );
                },
                [NodeKind.TEXT]: (valueEl, item, node) => {
                    const input = createTextEditor(
                        valueEl, { readOnly: node.readOnly, link: node.link },
                        (newValue) => commitValue(item, newValue, input)
                    );
                },
            },
        });

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
                    await updateTree([{ op: 'remove', path: getJSONPointer(item) }]);
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

                if (!window.selectedMod) {
                    alert('Please select a mod to save in first');
                    throw 'Please select a mod to save in first';
                }

                if (confirm('Add Element?')) {
                    let newContent = await getTemplateForItem(item);

                    if (newContent === null) return;

                    await updateTree([{ op: 'add', path: getJSONPointer(item) + '/-', value: newContent }]);
                }
            });
        });
    }

    /**
     * The document a GUID-valued field points at, as a ➥ beside its input.
     *
     * These were the value itself: the text carried `.link-element` and a click
     * handler. An input cannot also be a link, so navigation moved out to a control of
     * its own -- which is what the case flow already did for the GUIDs it shows.
     */
    function openTargetFor(item, valueEl) {
        const guid = valueEl.innerText.replace(/"/g, '');

        switch (item.label) {
            case 'msgID':
                return { title: 'Open this message', onClick: () => loadFile(`DDS/Messages/${guid}.msg`, 1, data) };
            case 'blockID':
                return { title: 'Open this block', onClick: () => loadFile(`DDS/Blocks/${guid}.block`, 2, data) };
            case DUMMY_KEYS.NEWSPAPER_DUMMY_KEY:
                return { title: 'Open this newspaper article', onClick: () => loadFile(`DDS/Messages/${guid}.newspaper`, 2, data) };
            default:
                return null;
        }
    }

    /**
     * Store an edited value. Called on blur, with whatever the input holds.
     *
     * The localisation key is a special case: it is resolved from dds.blocks.csv for
     * display, so editing it writes to the CSV keyed by the block's GUID rather than
     * patching the JSON.
     *
     * @returns false if nothing was stored, which puts the control back.
     */
    async function commitValue(item, typed, input) {
        assertModSelected();

        const edited = parseEditedValue(typed, { isString: item.type == 'string' });
        if (!edited.ok) return false;

        const { value: parsed, raw } = edited;

        if (item.label != DUMMY_KEYS.LOCALISATION_DUMMY_KEY) {
            if (parsed || parsed === false || parsed === 0 || parsed === '' || raw === 'null') {
                await modifyTreeElement(getJSONPointer(item), parsed);
            }
            return;
        }

        item.parent.findChildren(node => ['id', 'replaceWithID'].includes(node.label), async node => {
            await addOrModifyStrings(renderedValue(node), parsed);

            // Show what was stored rather than what was typed: a line with a comma in
            // it is quoted on the way into the CSV, and a correction made at the prompt
            // is not in the control at all.
            setValue(input, parsed);

            await loadI18n();
        });
    }

    async function copySource() {
        navigator.clipboard.writeText(getSaveSafeJSON());
    }

    async function useAsTemplate() {
        newFile(fileType, data);
    }

    // Whether this document already exists in the mod. Editing base game content
    // creates a patch file the first time it is saved, which the panel should show.
    let existsInMod = vanillaDataFile ? patchDataFile != null : true;

    async function save(force) {
        assertModSelected();
        if (!shouldSave(force)) return;

        if (vanillaDataFile) {
            // Base-game content: never modified, patched at load time by the DDS Loader.
            await writePatchAgainstVanilla(
                window.selectedMod.baseFolder, modPath(path + '_patch'), vanillaDataFile, getSaveSafeJSON());
        } else {
            // Files this mod created have no vanilla counterpart.
            await writeWholeFile(window.selectedMod.baseFolder, modPath(path), getSaveSafeJSON());
        }

        // Only on the first save: rescanning the folder on every edit is wasted work.
        if (!existsInMod) {
            existsInMod = true;
            await refreshPanel();
        }
    }

    function getSaveSafeJSON() {
        return toSaveSafeJSON(data, DUMMY_KEYS);
    }
}

export async function getTemplateForItem(item) {
    switch (item.label) {
        case 'messages':
            let message = cloneTemplate('treeMessage');
            message.msgID = prompt(`Existing GUID (Or cancel to create a new file)`) || await createNewFile('message');
            message.instanceID = crypto.randomUUID();
            return message;
        case 'links':
            let treeMessageLinks = cloneTemplate('treeMessageLinks');
            treeMessageLinks.to = prompt(`Existing instanceID`) || '';
            // Read through renderedValue: by the time an element is added, the
            // instanceID it links from is an input rather than text.
            treeMessageLinks.from = renderedValue(item.parent.childNodes.find(node => node.label == 'instanceID'));
            return treeMessageLinks;
        case 'traits':
            return prompt(`Trait name`) || null;
        case 'blocks':
            let block = cloneTemplate('messageBlock');
            block.blockID = prompt(`Existing GUID (Or cancel to create a new file)`) || await createNewFile('block');
            block.instanceID = crypto.randomUUID();
            return block;
        case 'replacements':
            let replacement = cloneTemplate('blockReplacement');
            let guid = prompt(`Existing GUID (Or cancel to create a new file)`);
            if (guid) {
                replacement.replaceWithID = guid;
            } else {
                replacement.replaceWithID = crypto.randomUUID();
                await addOrModifyStrings(replacement.replaceWithID, prompt(`English Line`));
            }
            return replacement;
        case 'jobs':
            return prompt(`Job name`) || null;
        case 'triggers':
            return prompt(`Trigger index`) || null;
        default:
            return null;
    }
}
