import { getFile, readFileContent, tryGetFile } from '../../core/fs.js';
import { assertModSelected, shouldSave, toSaveSafeJSON, writeWholeFile, writePatchAgainstVanilla } from '../../core/persistence.js';
import { createEditLoop, expandDefaultsOnce } from '../../core/document.js';
import { decorateArrayNodes } from '../../core/arrayControls.js';
import { decorateValueNodes, NodeKind } from '../../core/valueNodes.js';
import { createTextEditor, createSelectEditor, parseEditedValue, renderedValue, setValue } from '../../core/valueEditors.js';
import { getJSONPointer } from '../../core/jsonPointer.js';
import { describeField, fieldPath, resolveField } from '../../core/typeHints.js';
import { GUID_PATTERN } from '../../core/guid.js';
import { searchSelect } from '../../core/components/searchSelect/searchSelect.js';
import { addTreeElement } from './scripts/jsonTreeAdditions.js';
import { assetTypeOfField } from './scripts/assetFields.js';
import { instanceOptions, isGeneratedId, isInstanceReference } from './scripts/instances.js';
import { canBuildElement, elementTypeAt, newElement } from './scripts/elementTemplates.js';
import { Relevance, optionFilterFor, relevanceOf } from './scripts/treeViews.js';
import { newspaperOptions, unnamedValueOption } from './scripts/newspaperFields.js';
// The mod's own assets, by type. This is the case flow's listing of the content folder --
// the same folder, listed the same way -- rather than a second walk of it that could
// disagree; see the note on refreshing it in scripts/ui.js.
import { moddedNamesOfType } from '../scriptableObject/scripts/contentList.js';
import { createNewFile, createFileIfNotExisting, addOrModifyStrings, modPath } from './scripts/modFileManager.js';
import { DDS_BLOCKS_VIRTUAL, ddsContentFolder, readManifest, stringsFileHandle, toReal } from '../../core/ddsManifest.js';
import { applyViewVisibility, newFile, refreshPanel } from './scripts/ui.js';
import { parseJSON } from '../../core/jsonNumbers.js';

export const DUMMY_KEYS = {
    'LOCALISATION_DUMMY_KEY': '_ENG Localisation_',
    'NEWSPAPER_DUMMY_KEY': '_Newspaper Article Configuration_'
};

export const LOCALISATION_MISSING_STRING = 'MISSING GUID IN dds.csv';

/**
 * What the game calls each kind of DDS document, so `refs/generated/soTypeLayout.json`
 * can be walked from the right root.
 *
 * These are ordinary serialised game types; nothing about DDS content needs a reference
 * table of its own. Note the layout has no inheritance metadata, so `name` and `id` --
 * which every one of these inherits from `DDSComponent` -- resolve to nothing. See
 * refs/README.md.
 */
const ROOT_TYPES = {
    tree: 'DDSTreeSave',
    msg: 'DDSMessageSave',
    block: 'DDSBlockSave',
    newspaper: 'NewspaperArticle',
};


export async function initAndLoad(path, openTheseIds = null) {
    window.stringMapping = {};
    window.moddedStringMapping = {};
    await loadI18n();
    await loadFile(path, 0, null, openTheseIds);
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

/**
 * Which document to open at the level below this one: the one asked for, if this
 * document really holds it, and otherwise the first -- which is what opening a document
 * has always cascaded into.
 *
 * A route is asked for by whatever knows where it is going, the reverse search above
 * all. It is read out of the generated index, which describes the base game: a mod patch
 * can have taken the link out from under it since, and opening a message this tree no
 * longer holds would be a drill-down describing nothing.
 *
 * @param elements the array the level below is chosen from, `messages` or `blocks`
 * @param key      the field of an element holding the GUID, `msgID` or `blockID`
 */
function childToOpen(elements, key, requested) {
    const ids = (elements ?? [])
        .map((element) => element[key])
        .filter((id) => GUID_PATTERN.test(id));

    return ids.includes(requested) ? requested : ids[0];
}

export async function loadFile(path, thisTreeCount, parentData = null, openTheseIds = null) {
    var data = null;
    var fileType;

    // Read before the tree is built, not after: runTreeSetup() needs it, and the
    // fileType below is assigned further down -- it was `undefined` for the whole of the
    // first setup pass, and never covered `.newspaper` at all.
    const rootType = ROOT_TYPES[path.split('.').at(-1)];

    var vanillaDataFile = await (await (await tryGetFile(window.dirHandleStreamingAssets, path.split('/')))?.getFile())?.text();
    var patchDataFile = window.selectedMod != null ? (await (await (await tryGetFile(window.selectedMod.baseFolder, modPath(path + '_patch')))?.getFile())?.text()) : null;
    
    if (vanillaDataFile != null) {
        data = parseJSON(vanillaDataFile);
        if (patchDataFile != null) {
            data = jsonpatch.applyPatch(data, parseJSON(patchDataFile)).newDocument;
        }
    } else {
        data = parseJSON(await (await (await tryGetFile(window.selectedMod.baseFolder, modPath(path)))?.getFile())?.text());
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

    // What this document is arrived at showing. Per open document, and only the first
    // time: after that, what is open is what the author left open -- which is the whole
    // of what createEditLoop's snapshot is for. See core/document.js.
    const openDefaultNodes = expandDefaultsOnce(['messages', 'blocks', 'replacements']);

    runTreeSetup();

    let fileName = path.split('/').at(-1);
    if (['tree', 'msg', 'block'].includes(fileName.split('.')[1]) && fileName.split('.')[0] != data.id) {
        alert('Filename doesn\'t match id! File will not work in game!');
    }

    if(path.endsWith(".tree")) {
        fileType = 'tree';
        // The rest of the route belongs to the levels below this one.
        const messageId = childToOpen(data.messages, 'msgID', openTheseIds?.[0]);

        if(messageId)
            await loadFile(`DDS/Messages/${messageId}.msg`, 1, data, openTheseIds?.slice(1))
    } else if(path.endsWith(".msg")) {
        fileType = 'message';
        const blockId = childToOpen(data.blocks, 'blockID', openTheseIds?.[0]);

        if(blockId)
            await loadFile(`DDS/Blocks/${blockId}.block`, 2, data)
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
        // What each field is for, from the same reference data and the same resolver the
        // case flow uses. Most DDS fields have no description written for them yet; those
        // get no tooltip rather than an empty one.
        tree.findAndHandle(() => true, item => {
            const labelEle = item.el.querySelector('.jsontree_label');
            if (!labelEle) return;

            labelEle.title = describeField([rootType, ...fieldPath(item)], {
                typeLayout: window.typeLayout,
                descriptions: window.fieldDescriptions,
            });
        });

        // What a tree of this kind actually reads. The six kinds of DDS tree barely share
        // a format -- a document is a page with elements on it, a conversation is two
        // citizens and a branch graph -- and the fields the other five need are noise in
        // front of an author working on the sixth. See scripts/treeViews.js.
        //
        // Marked on every rebuild rather than decided once: `treeType` is a dropdown in
        // this very tree, so changing it re-renders straight into the new view. Taking the
        // rows off the screen is the switch's job, which is why the answer is applied
        // rather than assumed -- a document opened under a switch that is already on has
        // to arrive where every other open document already is.
        const treeType = viewType();
        tree.findAndHandle(() => true, item => {
            const field = resolveField([rootType, ...fieldPath(item)], window.typeLayout);
            item.el.classList.toggle(
                'dds-irrelevant-node',
                relevanceOf(field, treeType) === Relevance.HIDDEN
            );
        });

        applyViewVisibility();

        openDefaultNodes(tree);

        // A newspaper tree names an article that is configured in a file of its own,
        // which is written the first time the tree is opened rather than on save.
        tree.findAndHandle(item => {
            return item.label === DUMMY_KEYS.NEWSPAPER_DUMMY_KEY;
        }, async item => {
            await createFileIfNotExisting('newspaper', renderedValue(item));
        });

        // Editing operations

        // What kind of editor each value gets. This walks the game's type layout, as the
        // case flow does; anything it cannot place is edited as text.
        //
        // It used to look the field's *name* up in a flat table of enums, which could not
        // reach an array's elements -- those are labelled by index, so a participant's
        // `triggers` were typed as raw numbers however carefully the table listed them.
        decorateValueNodes(tree, {
            resolveNode: (item, valueEl) => {
                const field = resolveField([rootType, ...fieldPath(item)], window.typeLayout);
                const type = field?.type;

                // Unquoted: jsonTree renders a string with its quotes, and what the
                // document holds -- and what a list is matched against -- is the bare
                // value inside them.
                const currentValue = valueEl.innerText.replace(/"/g, '');

                // A string that names one of the game's assets. Typed `String` by the
                // layout like any other, so the field it sits in is what says so.
                const assetType = assetTypeOfField(field, item.parent?.type === 'array');
                if (assetType) {
                    return {
                        kind: NodeKind.REFERENCE,
                        currentValue,
                        placeholder: `Name a ${assetType}`,
                        // The mod's own first, as the case flow offers them: an author
                        // writing a trait condition is often naming something they just
                        // made. A base game asset the mod patches is under both headings,
                        // and both readings are true.
                        groups: [
                            { label: 'Modded', options: moddedNamesOfType(assetType) },
                            { label: 'Vanilla', options: window.typeMap?.[assetType] ?? [] },
                        ],
                    };
                }

                // A string that names a message *in this tree*, by the instanceID the
                // editor gave it. Read from the document rather than from the rendered
                // tree: what the list offers is where each message sits, and a GUID on
                // screen says nothing about which one it is.
                if (isInstanceReference(field)) {
                    return {
                        kind: NodeKind.REFERENCE,
                        currentValue,
                        placeholder: 'Choose a message in this tree',
                        options: instanceOptions(data),
                    };
                }

                // The two newspaper fields, which the game reads as numbers and this
                // editor offers as lists. Asked before the enum lookup below, because the
                // layout types them `Int32` and no enum answers to that -- so they were a
                // box wanting a number that nothing on screen explained. See
                // scripts/newspaperFields.js, and the note there on why the game's own
                // `Category` enum is the wrong list for one of them.
                const newspaperList = newspaperOptions(field);
                if (newspaperList) {
                    return {
                        kind: NodeKind.ENUM,
                        options: newspaperList,
                        currentValue: valueEl.innerText,
                        leadingOptions: unnamedValueOption(newspaperList, valueEl.innerText),
                    };
                }

                const options = window.enums[type];
                if (options?.length > 0) {
                    // A boolean is an enum of ['false', 'true'], so it picks the control
                    // up along with everything else -- but it is not stored as an index,
                    // and the value on screen reads 'true' rather than 1.
                    const isBoolean = type === 'Boolean';
                    const rendered = valueEl.innerText;
                    return {
                        kind: NodeKind.ENUM,
                        options,
                        isBoolean,
                        currentValue: isBoolean ? options.indexOf(rendered) : rendered,
                        // A field can be an enum without every value of that enum being
                        // valid in it: which trigger points a tree may have is decided by
                        // what kind of tree it is. See scripts/treeViews.js.
                        include: optionFilterFor(field, viewType()),
                    };
                }

                return {
                    kind: NodeKind.TEXT,
                    link: openTargetFor(item, valueEl),
                    readOnly:
                        // The newspaper key is a way in to the article's own file rather
                        // than part of this document: it is resolved on load and stripped
                        // on save, so there is nothing here to edit.
                        item.label === DUMMY_KEYS.NEWSPAPER_DUMMY_KEY
                        // An instanceID is what the links and startingMessage point at.
                        // Shown, because a document is worth being able to read whole,
                        // and because it is still what a link pasted from elsewhere has
                        // to be matched against -- but not editable. See scripts/instances.js.
                        || isGeneratedId(field),
                };
            },
            render: {
                [NodeKind.ENUM]: (valueEl, item, node) => {
                    createSelectEditor(
                        valueEl,
                        {
                            options: node.options,
                            selectedValue: node.currentValue,
                            // Part of the list, for a field whose valid values depend on
                            // what kind of tree it is in.
                            include: node.include ?? null,
                            // The entry a file needs when it holds a number this list has
                            // no name for -- a runtime-written newspaper context.
                            leadingOptions: node.leadingOptions ?? [],
                        },
                        async (value) => {
                            // Every other enum is stored as its index; a boolean is
                            // stored as a boolean, and writing 1 into one would be a
                            // document the game cannot read back.
                            await modifyTreeElement(
                                getJSONPointer(item),
                                node.isBoolean ? value === '1' : parseInt(value)
                            );
                        }
                    );
                },
                // A value chosen from a list rather than typed: an asset of the game's, or
                // a message of this tree's. What the list holds is decided above; all this
                // does is put it on the screen and store what was picked.
                [NodeKind.REFERENCE]: (valueEl, item, node) => {
                    const list = document.createElement('select');
                    valueEl.replaceChildren(list);

                    searchSelect(list, {
                        // The row of open documents, which is positioned and scrolls with
                        // the control. See core/components/searchSelect/searchSelect.js.
                        parent: document.querySelector('#trees'),
                        groups: node.groups ?? null,
                        options: node.options ?? null,
                        value: node.currentValue,
                        // A value that is on no list is still what the document holds, and
                        // a control that cannot show it would read as an empty field over
                        // a file that is not empty. It is also how a name gets in that
                        // nothing here could know: a trait the mod has not written yet.
                        allowCustom: true,
                        placeholder: node.placeholder,
                        memoryKey: `dds:${path}#${getJSONPointer(item)}`,
                        onChange: (value) => modifyTreeElement(getJSONPointer(item), value),
                    });
                },
                [NodeKind.TEXT]: (valueEl, item, node) => {
                    const input = createTextEditor(
                        valueEl, { readOnly: node.readOnly, link: node.link },
                        (newValue) => commitValue(item, newValue, input)
                    );
                },
            },
        });

        // Adding, removing, copying and pasting array elements.
        decorateArrayNodes(tree, {
            applyPatch: updateTree,
            getDocument: () => data,
            // The English line resolved beside a block is display-only: it is stripped
            // on save, and it is stripped here too, so what lands on the clipboard is
            // what the file holds rather than what the screen shows.
            serialize: (value) => toSaveSafeJSON(value, DUMMY_KEYS),
            canAdd: (item) => canBuildElement(elementTypeOf(item), elementRefs()),
            addElement: async (item) => {
                const newContent = await buildElement(item);

                // An array the layout describes with a type nothing here can make a value
                // of. canAdd keeps the + off those, so this is the belt to its braces.
                if (newContent === null) return;

                await updateTree([
                    { op: 'add', path: getJSONPointer(item) + '/-', value: newContent },
                ]);
            },
        });
    }

    /**
     * Which kind of tree this window is showing part of, for the view.
     *
     * A tree says so itself. A message says nothing -- it is a document of its own, and
     * the same message can be pulled into trees of different kinds -- so it takes the kind
     * from the tree it was drilled into, which `loadFile` already passes down and already
     * reads this way for the newspaper key.
     *
     * Undefined for a block, which has no per-kind fields, and for a message opened
     * straight from the panel with no tree above it. Both mean "no view": everything is
     * shown, which is the honest answer when there is nothing to go on.
     */
    function viewType() {
        return rootType === ROOT_TYPES.tree ? data.treeType : parentData?.treeType;
    }

    /** The game's name for the type of this array's elements, or null. */
    function elementTypeOf(item) {
        return elementTypeAt([rootType, ...fieldPath(item)], window.typeLayout);
    }

    /**
     * A new element for `item`, filled in as far as it can be without asking anybody
     * anything -- which, since the layout describes every array in a DDS document, is all
     * the way. What is left to do to it is what the tree is for.
     */
    async function buildElement(item) {
        const type = elementTypeOf(item);
        const element = newElement(type, elementRefs());

        if (element === null) return null;

        await ELEMENT_DOCUMENTS[type]?.(element, item);
        return element;
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

        // A line is stored against the GUID beside it, and findChildren is how that
        // GUID is found. It does not await its handler, so the write cannot happen
        // inside one: anything thrown there is an unhandled rejection, which is this
        // edit silently doing nothing whatever went wrong. Collect, then write.
        const keys = [];
        item.parent.findChildren(
            node => ['id', 'replaceWithID'].includes(node.label),
            node => keys.push(renderedValue(node))
        );

        // Nothing to key the line by. Saying so beats appearing to have stored it.
        if (keys.length === 0) {
            alert('This line has no id or replaceWithID beside it to be stored against.');
            return false;
        }

        for (const key of keys) {
            await addOrModifyStrings(key, parsed);
        }

        // Show what was stored rather than what was typed: a line with a comma in it is
        // quoted on the way into the CSV, and a correction made at the prompt is not in
        // the control at all.
        setValue(input, parsed);

        await loadI18n();
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

/**
 * The part of a new element that is not a fact about its type.
 *
 * Its shape comes from the game's layout -- see scripts/elementTemplates.js -- and what
 * is left is what only this editor can do: write the document the element points at, and
 * stamp the IDs that make it *this* use of one. Each of these used to be a `prompt()`
 * standing between the + and the element, which is not how anything else in either
 * editor is filled in.
 *
 * Every one of them is a value the author can still change afterwards, in the tree, with
 * the control the field already has. A GUID typed at a prompt was never anything more
 * than that -- and a document that was created and then pointed elsewhere is a file in
 * the mod's folder, which is where every unused document in a mod already lives.
 */
const ELEMENT_DOCUMENTS = {
    // A message in a tree is a reference to a document, so a new one is a new document.
    // Cancelling the prompt this replaces did exactly this, which is what every
    // walkthrough of the editor told an author to do.
    DDSMessageSettings: async (element) => {
        element.msgID = await createNewFile('message');
        element.instanceID = crypto.randomUUID();
    },
    // The same story one level down: a message names the blocks it is made of.
    DDSBlockCondition: async (element) => {
        element.blockID = await createNewFile('block');
        element.instanceID = crypto.randomUUID();
    },
    // A replacement's line lives in the strings CSV keyed by this GUID. The row is
    // written empty rather than left out: it is what the `_ENG Localisation_` row beside
    // the element resolves through, and without it the element has nowhere to be typed.
    DDSReplacement: async (element) => {
        element.replaceWithID = crypto.randomUUID();
        await addOrModifyStrings(element.replaceWithID, '');
    },
    // Which message the link runs *from* is not a choice: it is the message the link was
    // added to. Read through renderedValue, because by the time an element is added the
    // instanceID beside it is an input rather than text.
    DDSMessageLink: async (element, item) => {
        element.from = renderedValue(
            item.parent.childNodes.find(node => node.label == 'instanceID'));
    },
};

/**
 * The reference data an element is built from, as the registry installs it on activation.
 *
 * Read at the moment it is needed rather than captured: these are replaced on every
 * activation, and a flow that is not the active one has no business building anything.
 */
const elementRefs = () => ({
    typeLayout: window.typeLayout,
    enums: window.enums,
    templates: window.templates,
    basicTypeTemplates: window.basicTypeTemplates,
});
