import { readFileContent, tryGetFile } from '../../core/fs.js';
import { deepClone, renameFile } from '../../core/files.js';
import { assertModSelected, shouldSave, toSaveSafeJSON, writeWholeFile } from '../../core/persistence.js';
import { MANIFEST_FILE, refFor, renameListing } from '../../core/murderManifest.js';
import { assetNameOf, assetOfPath, fileNameFor } from '../../core/soFileName.js';
import { confirmRename } from '../../core/deletion.js';
import { createEditLoop, expandDefaultsOnce } from '../../core/document.js';
import { decorateArrayNodes } from '../../core/arrayControls.js';
import { decorateValueNodes, NodeKind } from '../../core/valueNodes.js';
import { getJSONPointer } from '../../core/jsonPointer.js';
import { describeField, fieldPath, resolveField } from '../../core/typeHints.js';
import { parseEditedValue } from '../../core/valueEditors.js';
import { isNameFieldSafe } from '../../core/strings.js';
import { fastElement } from '../../core/dom.js';
import { addTreeElement, deleteTree, renameTreeWindow, createInputElement, createSOSelectElement, createEnumSelectElement, MOD_PREFIX } from './scripts/jsonTreeAdditions.js';
import { cloneTemplate, createFileIfNotExisting, createOverrideIfNotExisting } from './scripts/modFileManager.js';
import { referencesToAsset } from './scripts/deleteAsset.js';
import { applyDefaultValueVisibility, setNewFileMode, setNewFileSource } from './scripts/ui.js';
import { NEW_SUFFIX, PATCH_SUFFIX, moddedNamesOfType, modFileOfAsset, modFileOfStem } from './scripts/contentList.js';
import { applyPatches, diffToPatches, ENVELOPE_KEYS, isPatchFormat, mergeOldFormat, patchFile } from '../../core/patchFormat.js';
import { resolveReferences } from '../../core/soReferences.js';
import { ASSET_DATA, readBaseAsset } from '../../core/baseAssets.js';

export const DUMMY_KEYS = {
    'LOCALISATION_DUMMY_KEY': '_ENG Localisation_',
    'NEWSPAPER_DUMMY_KEY': '_Newspaper Article Configuration_'
};

/**
 * An asset's identity, which it states three times over: `presetName` is what it is
 * called, `name` repeats it, and the file is named after it too.
 *
 * The three were independently editable, and nothing kept them together -- so a case
 * could end up called one thing by its file, another by `presetName`, and a third by
 * `name`, which the game and this app read in different places. `presetName` is now the
 * one that is edited and the other two follow it.
 *
 * The file is named after it and after the type -- `<presetName>.<fileType>.sodso.json`,
 * see core/soFileName.js -- and that type is the only place the type appears. Nothing
 * else here deals in file names: a `REF:` resolves against `presetName`, and so does
 * every dropdown and every check for whether an asset is pointing at itself.
 *
 * Only assets have a `presetName`. An override (`*.sodso_patch.json`) is identified by
 * the base game asset it patches, which its `name` alone records, so there `name` stays
 * exactly as it is: visible and the author's to set.
 */
const NAME_FIELD = 'name';
const PRESET_NAME_FIELD = 'presetName';

/**
 * The asset this one takes the fields it does not state for itself from. The New File
 * dialog asks for it when the file is made, and the row on the document is where it is
 * re-pointed afterwards.
 */
const COPY_FROM_FIELD = 'copyFrom';

export async function initAndLoad(path) {
    let openWindows = document.querySelectorAll('.file-window');
    for(let i = openWindows.length - 1; i >= 0; i--) {
        deleteTree(openWindows[i]);
    }
    await loadFile(path, false);
}

/**
 * Rebuild the manifest panel where it stands, for when something outside it has changed
 * what the manifest says -- a preset renamed, a file deleted.
 *
 * Not initAndLoad, which would also close every document the author has open. Nothing
 * happens when the panel is not showing: there is no manifest on screen to be out of date,
 * and building one because a file was deleted would be an editing session appearing on its
 * own.
 */
export async function reloadManifestPanel() {
    const container = document.getElementById('manifest_content_tree');
    if (!container?.hasChildNodes()) return;

    container.replaceChildren();
    await loadFile(MANIFEST_FILE.slice(0, -NEW_SUFFIX.length), false);
}

/**
 * Where a document was read from, recorded on its window.
 *
 * A path alone does not say: `MurderMO/Bartender.json` is a base game asset, either
 * shipped with this tool or exported by the author, and `Bartender.MurderMO.sodso.json`
 * is the mod's own. Only the caller knows which, and knowing matters when what is open
 * has to be opened again -- from a link, or after a reload.
 */
export const Source = {
    /** The mod's content folder. */
    MOD: 'mod',
    /** The optional folder of ScriptableObjects the author exported themselves. */
    EXPORTED: 'exported',
    /** The base game assets shipped with this tool, under refs/assets/. */
    ASSET: 'asset',
};

/**
 * What can be done with an open document, which is three things rather than two.
 *
 * `readOnly` answers most of it and had nowhere to put the third case. A patch is written
 * to, so it is not read-only, but what gets written is not the document on screen: the
 * author edits the base game's asset and the file receives the difference between the two.
 * Whether the document can be edited is still `readOnly`; what gets written, what counts as
 * an unchanged field, and whether choosing fields means anything all ask this instead.
 */
export const Mode = {
    /** A base game asset. Nothing here is the mod's to change. */
    VIEW: 'view',
    /** One of the mod's own files, written out whole. */
    NEW: 'new',
    /** An override of a base game asset, written out as a diff against it. */
    PATCH: 'patch',
};

/**
 * Open a file in the content folder by name. `suffix` says which of the two files
 * that name can stand for; everything but the file panel means the mod's own asset.
 */
export async function loadFile(path, readOnly, type, suffix = NEW_SUFFIX) {
    await loadFileFromFolder(path + suffix, window.selectedMod.baseFolder, readOnly, type);
}

// Awaited the whole way down, which it was not before. Opening a document used to be
// synchronous once its bytes were in hand, so nothing was lost by letting the last call
// go unwaited; a patch has to read the asset it overrides and may have to ask the author
// a question first, and a caller that carries on through that is a caller acting on a
// window that is not there yet.
export async function loadFileFromFolder(path, folderHandle, readOnly, type, source = Source.MOD) {
    let loadedFile = await tryGetFile(folderHandle, path.split('/'));
    let loadedFileContent = await (await (loadedFile)?.getFile())?.text();
    await loadFileContent(path, loadedFileContent, readOnly, type, source);
}

/**
 * @param quiet say nothing if it is not there. For reopening what a URL names, which
 *              can name an asset this copy of the tool does not ship -- a link from
 *              someone on a different version. Nothing was asked for, so nothing is
 *              owed an explanation.
 */
export async function loadFileFromOnlineRepo(path, type, { quiet = false } = {}) {
    const response = await fetch(new URL(path, ASSET_DATA));

    if (!response.ok) {
        if (!quiet) alert(`${path} is not among the base game assets included with this tool`);
        return;
    }

    await loadFileContent(path, await response.text(), true, type, Source.ASSET);
}

/**
 * Open the file a load order entry names.
 *
 * An entry is a file name with the part saying which kind of file it is left off -- see
 * modFileOfStem, which puts it back from what is actually in the folder. Everything else
 * here opens a file the app has just walked or just written and so already knows both
 * halves; an entry is the one place a name arrives on its own.
 *
 * An entry naming nothing in the folder is opened as it stands, which is a file that is
 * not there and says so. That is the honest answer: the load order names a file the mod
 * does not have, and it is the manifest that is wrong rather than the click.
 */
async function openListedFile(stem) {
    const file = modFileOfStem(stem);

    if (!file) {
        await loadFile(stem, false);
        return;
    }

    // The file's own name rather than the entry's, which need not match its case.
    await loadFile(file.id, false, file.openAs, file.suffix);
}

/**
 * Open one of the base game's assets, from wherever this copy of the tool can reach it.
 *
 * The author's own export first, when they have connected one: it is the game they are
 * modding at the version they are running, and it holds every type. What ships with this
 * tool is a subset of that, and is what there is otherwise. Read-only either way -- the
 * game's file is not the mod's to change.
 */
export async function openBaseGameAsset(type, name) {
    const path = `${type}/${name}.json`;

    if (window.dirHandleExportedSOPath) {
        await loadFileFromFolder(path, window.dirHandleExportedSOPath, true, type, Source.EXPORTED);
        return;
    }

    await loadFileFromOnlineRepo(path, type);
}

/** The asset a `REF:Type|Name` names, or null when the value names none. */
function refTarget(value) {
    const target = String(value ?? '').match(/^REF:([\w-]+)\|(.+)$/);
    if (!target) return null;

    return { type: target[1], name: target[2].trim() };
}

/**
 * Open the asset a document is derived from.
 *
 * A `copyFrom` may name the mod's own asset or a base game one, and the mod's is tried
 * first: an author copying within their own mod means the file they can edit, and the
 * shipped asset of that name is not the one the game will end up loading.
 *
 * Which of the mod's files that is comes from the folder listing rather than from building
 * a name, as it does for a load order entry -- see modFileOfAsset. This used to look for
 * `<name>.<type>.sodso.json`, which is what this app writes and not what every mod holds:
 * a `REF:` resolves against `presetName`, so a file named anything else was missed and the
 * base game's asset of that name opened in its place.
 */
async function openDerivedFrom({ type, name }) {
    const file = modFileOfAsset(type, name);

    if (file) {
        await loadFile(file.id, false, file.openAs ?? type, file.suffix);
        return;
    }

    await openBaseGameAsset(type, name);
}

/**
 * A patch file, as the document it describes: the base game's asset with the override
 * applied over it. That document is what the author edits, and the difference between it
 * and the base is what gets written back.
 *
 * Which means a patch can no longer be authored without the asset it patches, and that is
 * a real loss worth stating plainly rather than leaving to be discovered. The old format
 * let anyone hand-write an override for any type with no reference data at all; a
 * difference has to be a difference from something. With an exported ScriptableObjects
 * folder connected every type is reachable; without one it is the nine types this tool
 * ships assets for, and everything else says so and stops.
 *
 * @returns `{ baseDocument, data }`, or null when the file cannot be opened -- in which
 *          case the author has already been told why
 */
async function openPatchOver(path, file, fileType, target) {
    const { document: base, reason } = await readBaseAsset(fileType, target);

    if (!base) {
        alert(`${path} overrides ${fileType ? `${fileType}/` : ''}${target || path}, and an `
            + `override is a difference from that asset -- but ${reason}.`);
        return null;
    }

    if (isPatchFormat(file)) {
        const { document, failed } = applyPatches(base, file.patches);

        if (!document) {
            // Almost always the base having moved on: the patch was written against one
            // version of the game and is being opened against another. Opening it anyway
            // would show a document the file does not describe, and then save the
            // difference between that and the base straight over it.
            alert(`${path} does not apply to ${fileType}/${target}. Change ${failed.index + 1} `
                + `(${failed.op.op} ${failed.op.path}) could not be made: ${failed.reason}.`);
            return null;
        }

        return { baseDocument: base, data: document };
    }

    // An override in the older format, which lists fields to write over the asset rather
    // than changes to make to it. Reading it is a merge; saving it converts it -- so an
    // author who has fields at stake is asked first. One that overrides nothing yet is
    // not: every override this app has ever created starts as exactly that, and there is
    // nothing there to convert.
    const overrides = Object.keys(file).filter((key) => !ENVELOPE_KEYS.includes(key));

    if (overrides.length && !confirm(
        `${target} is an override in the older format, which lists the fields to write over `
        + `${fileType}/${target}.\n\n`
        + 'Saving it writes it back as the list of changes the loader now prefers, which is '
        + 'what this editor makes. It will be a much shorter file describing the same '
        + 'override.\n\nOpen it?'
    )) {
        return null;
    }

    return { baseDocument: base, data: mergeOldFormat(base, file) };
}

export async function loadFileContent(path, loadedFile, readOnly, type, source = Source.MOD) {
    if(!loadedFile) {
        alert(`${path} doesn't exist or is a vanilla asset - create it in the manifest first`);
        return;
    }

    const isManifestFile = path === MANIFEST_FILE;
    const isPatch = path.endsWith(PATCH_SUFFIX);

    let data;
    try {
        // Unity's references named, which is the shape everything downstream deals in --
        // and the shape a patch is diffed in, so the base goes through the same door.
        data = resolveReferences(JSON.parse(loadedFile), window.pathIdMap);
    } catch {
        alert(`${path} is not valid JSON, so there is nothing here to open.`);
        return;
    }

    // Read before the window is built rather than after: the window is titled by what
    // the document is as well as by what it is called, and a base game asset states
    // neither -- it is stored in a folder named after its type, which is where the
    // caller's `type` comes from.
    let fileType = data.fileType || type || "Manifest";

    /**
     * The base game asset this document is a difference from, held for a patch and null
     * for everything else. Never mutated: it is what the next save is compared against,
     * so an edit reaching it would be an edit that quietly stops being an override.
     */
    let baseDocument = null;

    /**
     * The asset a patch overrides, which is the whole of what identifies it -- the file
     * is named after it and the file's `name` repeats it. Held apart from `data`, which
     * from here on is the base game's asset rather than the patch file.
     */
    const patchTarget = isPatch ? (data[NAME_FIELD] ?? assetOfPath(path, fileType)) : null;

    if (isPatch) {
        const opened = await openPatchOver(path, data, fileType, patchTarget);
        if (!opened) return;

        ({ baseDocument, data } = opened);
    }

    /** Which of the three kinds of document this is -- see `Mode`. */
    const mode = readOnly ? Mode.VIEW : isPatch ? Mode.PATCH : Mode.NEW;

    // Manifest Frame
    // By id, not by position: the file list is a div in this panel too, and it now
    // comes first.
    let DOMtarget = isManifestFile ? document.getElementById('manifest_content_tree') : document.getElementById('trees');

    /**
     * The asset this document is derived from, or null when it is derived from nothing and
     * there is no base to offer.
     *
     * The two kinds of derived file say what they came from in different places. An asset
     * states it in `copyFrom`, which names an asset of the document's own type. A patch
     * states it nowhere at all: what it overrides is the base game asset of the same name
     * and type, and the file name is the whole of how a patch says so -- see
     * core/soFileName.js -- so a `copyFrom` left in one by hand is not what the loader
     * would go by and is not read here either.
     *
     * Read on each use rather than settled when the file was opened: `copyFrom` is the
     * author's to re-point, and a button that opens the baseline the file used to have is
     * worse than no button at all.
     */
    const baseAsset = () => {
        if (isPatch) {
            const name = assetOfPath(path, fileType);
            return name ? { type: fileType, name } : null;
        }

        return refTarget(data?.[COPY_FROM_FIELD]);
    };

    let treeEle = addTreeElement(path, DOMtarget, readOnly, fileType, source, {
        copySource,
        save,
        // The button is built for every document that can be edited and hidden while there
        // is nothing for it to open -- see syncOpenBase. Which of those it is changes as
        // the author re-points copyFrom, and the editor bar is built once.
        openBase: () => {
            const base = baseAsset();
            return base && openDerivedFrom(base);
        },
        // Which fields a file states is what an override used to be made of, and is still
        // what one of the mod's own files is made of -- the ones it does not state, it
        // takes from its copyFrom. A patch states nothing: it holds the whole asset and
        // saves the difference, so there is no set of fields here to choose.
        showSelectFieldsDialog: mode === Mode.NEW ? showSelectFieldsDialog : null,
    });

    if(!treeEle) return;

    /** Whether this document is one whose `name` is a repeat of its `presetName`. */
    const hasPresetName = () => typeof data?.[PRESET_NAME_FIELD] === 'string';

    /**
     * Whether `name` is a field this document has. It is never added to one that does
     * not: a file written without it is not made to grow one because it was opened.
     */
    const hasName = () => hasPresetName() && NAME_FIELD in data;

    /**
     * What this document is, for keeping it out of its own reference fields.
     *
     * A file cannot sensibly point at itself -- `copyFrom` doing so is a cycle -- and it
     * used to be offered, because the list is built from the folder and the folder
     * contains the file being edited. Read on each render rather than captured: renaming
     * a preset changes it, and the tree is rebuilt when it does.
     *
     * A patch is identified by the base game asset it overrides, which is its `name`.
     */
    const self = () => ({
        type: fileType,
        name: data?.[PRESET_NAME_FIELD] ?? data?.[NAME_FIELD] ?? null,
    });

    /**
     * The chain of assets from `value` back round to this document, or null when pointing
     * `copyFrom` there makes no such chain.
     *
     * A copy takes the fields it does not state for itself from its baseline, so a ring of
     * them has nothing to take: the game follows it round and never reaches an asset that
     * answers. The dropdown already leaves this document out of its own list, but
     * `Custom...` names whatever is typed into it, and a ring can be two files long.
     *
     * Only the mod's own files are walked. A base game asset was shipped before this mod
     * existed, so its `copyFrom` names another base game asset and a chain that leaves the
     * folder does not come back. What that misses is an override re-pointing a base game
     * asset at one of the mod's, which is not something this editor offers: a patch's
     * `copyFrom` is not shown.
     */
    async function copyFromRing(value) {
        const folder = window.selectedMod?.baseFolder;
        const me = self();
        if (!folder || !me.name) return null;

        const chain = [];
        const seen = new Set();
        let target = refTarget(value);

        while (target) {
            chain.push(target.name);

            if (target.type === me.type && target.name === me.name) return chain;

            // A ring the folder already holds, which this change is not the making of.
            const step = `${target.type}|${target.name}`;
            if (seen.has(step)) return null;
            seen.add(step);

            // From the folder listing rather than by building a file name: an asset is not
            // always stored under its own name. See modFileOfAsset.
            const file = modFileOfAsset(target.type, target.name);
            if (!file) return null;

            const handle = await tryGetFile(folder, [`${file.id}${file.suffix}`]);
            if (!handle) return null;

            try {
                target = refTarget(JSON.parse(await readFileContent(handle))?.[COPY_FROM_FIELD]);
            } catch {
                // A file that will not parse states no baseline.
                return null;
            }
        }

        return null;
    }

    // Corrected on opening, not just on edit: `name` is about to stop being shown, and a
    // file that arrived with the two already disagreeing would otherwise keep a wrong
    // name that nothing in the editor admits to. Only in memory -- the file is not
    // rewritten until something is saved.
    if (hasName()) data[NAME_FIELD] = data[PRESET_NAME_FIELD];

    // The file this document is currently stored as, which follows `presetName`. Held
    // apart from `path` so a rename can be settled at save time: with autosave off, an
    // edit is not committed until Save, and the file on disk should not move before the
    // edit that moves it has been written.
    let renameTo = null;

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
        afterRebuild: () => { markDefaultValues(); syncOpenBase(); },
    });

    // What this document is arrived at showing, and only the first time -- see
    // core/document.js. A manifest's load order is the one that carries this flow: closing
    // it and then adding a file used to open it again.
    const openDefaultNodes = expandDefaultsOnce(['fileOrder', 'blocks', 'replacements']);

    runTreeSetup();
    markDefaultValues();
    syncOpenBase();

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

            const path = fieldPath(item);

            labelEle.title = describeField([fileType, ...path], {
                typeLayout: window.typeLayout,
                descriptions: window.fieldDescriptions,
            });

            // What this label stands for, for the field summary to pick up -- the type
            // whose assets would be read, and the field within it. Written here rather
            // than looked up on the click because this is where a document knows its own
            // type, and because the pass runs on every render: a mark left on the label
            // survives the tree being rebuilt under it.
            //
            // The manifest is not one of the game's types and has no assets to compare
            // against, so its labels are left unmarked and are not pickable.
            if (!isManifestFile && path.length) {
                labelEle.dataset.summaryType = fileType;
                labelEle.dataset.summaryPath = path.join('.');
            }
        });

        // `name` is not shown at all rather than shown read-only: it says nothing
        // `presetName` does not, and a field the author can neither change nor learn
        // anything from is only in the way. It is still written to the file, which is
        // where the game reads it.
        if (hasName()) {
            tree.findAndHandle(
                item => item.parent?.isRoot && item.label === NAME_FIELD,
                item => { item.el.classList.add('hidden'); }
            );
        }

        // An override's `copyFrom` is the base game asset's rather than the mod's. What a
        // patch overrides is settled by its file name -- see core/soFileName.js -- so a
        // row here would offer a decision the loader does not read, and re-pointing it
        // would write a change to the base game's own baseline into the override.
        //
        // The mod's own files keep their row, where it is what the asset copies from and
        // is the author's to change. So does a read-only one, where it is the route
        // through to the asset being copied.
        if (mode === Mode.PATCH) {
            tree.findAndHandle(
                item => item.parent?.isRoot && item.label === COPY_FROM_FIELD,
                item => { item.el.classList.add('hidden'); }
            );
        }

        openDefaultNodes(tree);

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
                    openListedFile(refPath);
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
                    openListedFile(refPath);
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
                if (splitPath.at(-1) === COPY_FROM_FIELD) mappedType = fileType;

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
                            } else if (String(selectedIndex).startsWith(MOD_PREFIX)) {
                                // One of the mod's own, which carries its name rather than
                                // a position in the base game's list -- it has none.
                                value = `REF:${node.type}|${String(selectedIndex).slice(MOD_PREFIX.length)}`;
                            } else if (selectedIndex >= 0) {
                                value = `REF:${node.type}|${window.typeMap[node.type][selectedIndex]}`;
                            } else {
                                value = `REF:${node.type}|${customValue}`;
                            }

                            // The document's own baseline is the one reference that can be
                            // pointed back at the document. A `copyFrom` further down
                            // belongs to some other object and is not this file's chain.
                            if (item.parent?.isRoot && item.label === COPY_FROM_FIELD) {
                                const ring = await copyFromRing(value);

                                if (ring) {
                                    alert(`${self().name} can't copy from ${ring[0]}, which comes `
                                        + `back round to it: ${[self().name, ...ring].join(' -> ')}.\n\n`
                                        + 'A file takes the fields it does not state for itself from '
                                        + 'the one it copies from, so a ring of them has nothing to '
                                        + 'take.');

                                    // Nothing has changed, but the dropdown is showing the
                                    // choice that was refused. Rebuilding puts back what
                                    // the document actually says, and keeps the author's
                                    // place while it does -- see core/document.js.
                                    await updateTree([]);
                                    return;
                                }
                            }

                            await updateTree([{
                                op: 'replace',
                                path: getJSONPointer(item),
                                value,
                            }]);
                        },
                        moddedNamesOfType(node.type, self()),

                        // The field, named the way everything else here names one: the
                        // document it is in and the pointer to it. What it is for is a
                        // dropdown that remembers what was typed into it, and this is
                        // the identity that outlives the control -- editing anything
                        // rebuilds the whole tree, so the control does not.
                        //
                        // A pointer into an array is a position, so removing an element
                        // hands its term to the one that moves up into its place. A
                        // stale search string in a box that opens with it selected is
                        // the whole of that, and keying by anything else would mean no
                        // memory at all in the lists that are longest.
                        `so:${path}#${getJSONPointer(item)}`
                    );
                },
                [NodeKind.TEXT]: (valueEl, item, node) => {
                    createInputElement(valueEl, node.readOnly, async (typed) => {
                        assertModSelected();

                        // Returning false puts the control back: see createTextEditor.
                        const edited = parseEditedValue(typed, { isString: item.type == 'string' });
                        if (!edited.ok) return false;

                        const { value: parsed, raw } = edited;

                        if (hasPresetName() && item.parent?.isRoot && item.label === PRESET_NAME_FIELD) {
                            return renamePreset(item, parsed);
                        }

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

        // Adding, removing, copying and pasting array elements. A read-only document
        // gets the copy button alone -- see core/arrayControls.js.
        decorateArrayNodes(tree, {
            applyPatch: updateTree,
            getDocument: () => data,
            readOnly,
            canAdd: canAddElement,
            addElement: (item) =>
                addNewArrayElement([fileType, ...fieldPath(item)], getJSONPointer(item)),
        });

        /**
         * Whether a new element can be made for this array.
         *
         * The + is not offered where it cannot be honoured. An element is built from
         * the type the layout gives the array, and there are arrays it describes with
         * a type nothing here knows how to make a value of; asking for one throws
         * rather than adding anything.
         */
        function canAddElement(item) {
            const type = typeAtPath([fileType, ...fieldPath(item)]);
            if (!type) return false;

            // FileType is the manifest's load order, whose elements are files chosen
            // or created through the new file dialog.
            return type === 'FileType'
                || type in window.typeMap
                || type in window.enums
                || type in window.basicTypeTemplates
                || type in window.templates
                || type in window.typeLayout;
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

    /**
     * Whether the file is allowed to follow the asset's name.
     *
     * Only a document this mod owns, opened from its content folder under a plain asset
     * name: a base game asset is read-only, the manifest is not an asset, and an
     * override is named after the thing it overrides rather than after itself.
     */
    const canRenameFile = () =>
        !readOnly && !isManifestFile && !path.includes('/') && path.endsWith(NEW_SUFFIX);

    /**
     * The file a content path names, which is what the manifest lists -- the asset's name
     * and its type, not the asset's name alone. See core/soFileName.js.
     */
    const stemOf = (filePath) => filePath.slice(0, -NEW_SUFFIX.length);

    /**
     * What else in the mod points at this asset by the name it currently has, labelled as
     * the file panel labels a file.
     *
     * The document's own file is excluded, and `referencesToAsset` recognises it by putting
     * `id` and `suffix` back together -- see the note on the target shape there. For a
     * document in the mod's own folder those two are the whole of `path`, so the split is
     * made by whichever suffix the path actually carries rather than by assuming a preset.
     */
    async function referencesToThis(folder, assetName) {
        const suffix = [PATCH_SUFFIX, NEW_SUFFIX].find((end) => path.endsWith(end)) ?? '';

        return referencesToAsset(folder, {
            id: suffix ? path.slice(0, -suffix.length) : path,
            suffix,
            assetName,
            type: fileType,
        });
    }

    /**
     * Rename the asset. `presetName` is what it is called; `name` repeats it and so does
     * the file, so editing it moves all three.
     *
     * A file stored under the older `<presetName>.sodso.json` moves to the typed name
     * here, and only here. The rename is already writing the file somewhere new and
     * already following it through the manifest, so there is nothing extra to go wrong;
     * opening or saving one leaves it exactly where its author left it.
     *
     * What it does not follow is the mod's other documents. A `REF:` in one of them resolves
     * against `presetName`, so a rename leaves it naming an asset that has gone -- the same
     * break deleting the file would cause, which the panel warns about and this did not. So
     * it asks, when there is something to ask about; see core/deletion.js.
     */
    async function renamePreset(item, value) {
        const wanted = String(value ?? '');

        // Refused rather than quietly made safe: this is about to become a file name and
        // a `REF:` entry in the load order, and correcting it behind the author's back
        // would leave them reading one name while the mod uses another.
        if (!isNameFieldSafe(wanted)) {
            alert(`"${wanted}" can't be used as a preset name. It names the preset's own `
                + 'file, so it can only hold letters, numbers, - and _.');
            return false;
        }

        if (wanted === data[PRESET_NAME_FIELD]) return;

        // Asked here rather than at save time, where the file actually moves. This is the
        // moment the author is thinking about the name, and returning false puts the old one
        // back in the field; with autosave off, a question at Save would be asking about an
        // edit made some time earlier and would have nothing left to put back.
        const was = data[PRESET_NAME_FIELD];
        const folder = window.selectedMod?.baseFolder;

        if (folder && !confirmRename(was, wanted, await referencesToThis(folder, was))) return false;

        // Acted on by save(), so that with autosave off the file does not move before the
        // edit moving it has been committed.
        if (canRenameFile()) renameTo = fileNameFor(wanted, fileType);

        await updateTree([
            { op: 'replace', path: getJSONPointer(item), value: wanted },
            ...(hasName() ? [{ op: 'replace', path: `/${NAME_FIELD}`, value: wanted }] : []),
        ]);
    }

    async function save(force) {
        assertModSelected();
        if (!shouldSave(force)) return;

        // Renamed back to what it already was: nothing to move.
        if (renameTo === path) renameTo = null;

        if (renameTo) {
            await saveRenamed(renameTo);
            return;
        }

        await writeWholeFile(window.selectedMod.baseFolder, path.split('/'), getSaveSafeJSON());
    }

    /**
     * The same asset stored under the older `<presetName>.sodso.json`, if the folder holds
     * one, and null otherwise.
     *
     * A rename lands on a name rather than on a file, and since that convention a name
     * can be spelled two ways. The typed name being free says nothing about the bare one,
     * so a mod written before the type joined the name would end up holding two assets of
     * one type and one name -- and a `REF:` to either of them resolves to whichever the
     * loader read last.
     *
     * Of one *type*: a bare file of some other type is not a clash at all. Two assets
     * sharing a name and differing in type is the whole reason the type is in the file
     * name, and refusing that would give back the problem this was meant to solve.
     */
    async function olderFileFor(folder, newPath) {
        const bare = `${assetNameOf(stemOf(newPath), fileType)}${NEW_SUFFIX}`;
        if (bare === newPath || bare === path) return null;

        const handle = await tryGetFile(folder, [bare]);
        if (!handle) return null;

        try {
            return JSON.parse(await readFileContent(handle))?.fileType === fileType ? bare : null;
        } catch {
            // A file that will not parse claims no type, so it is not this asset's twin.
            return null;
        }
    }

    /**
     * Write the document under its new file name, take the old file away, and bring
     * everything that names the file along with it: the mod's load order, the file list,
     * and the window it is open in.
     */
    async function saveRenamed(newPath) {
        const folder = window.selectedMod.baseFolder;
        const oldPath = path;
        renameTo = null;

        // Checked before the write rather than after: renameFile only knows about the
        // name it was given, and refusing has to leave both files exactly as they are.
        const taken = await olderFileFor(folder, newPath);

        if (taken || !await renameFile(folder, oldPath, newPath, getSaveSafeJSON())) {
            alert(`This mod already has a "${taken ?? newPath}", so the file has not been renamed. `
                + `The preset is still stored as "${oldPath}".`);
            await writeWholeFile(folder, oldPath.split('/'), getSaveSafeJSON());
            return;
        }

        path = newPath;
        renameTreeWindow(treeEle.closest('.file-window'), newPath, fileType);

        // A file the manifest still names by its old name is a file the loader goes
        // looking for and does not find.
        await renameListing(folder, stemOf(oldPath), stemOf(newPath));

        const { refreshPanel } = await import('./scripts/ui.js');
        await refreshPanel();
        await reloadManifestPanel();
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

    /**
     * What gets written, which is not the same thing as what is on screen.
     *
     * One of the mod's own files is its document. A patch is the difference between the
     * document and the base game's asset, wrapped in the two keys that say which asset
     * that is -- see scripts/patchFormat.js. An untouched patch therefore saves as an
     * empty list of changes rather than as a copy of the asset it overrides.
     */
    function getSaveSafeJSON() {
        if (mode !== Mode.PATCH) return toSaveSafeJSON(data, DUMMY_KEYS);

        return toSaveSafeJSON(patchFile(patchTarget, fileType, diffToPatches(baseDocument, data)), DUMMY_KEYS);
    }

    /**
     * Show Open Base only while there is something for it to open.
     *
     * The editor bar is built once and `copyFrom` can be re-pointed at any time, including
     * to nothing at all, so this is toggled on every rebuild rather than decided when the
     * document was opened. A patch's base does not move, and it costs nothing to ask.
     */
    function syncOpenBase() {
        treeEle.querySelector('.jsontree-editor-bar-open-base-button')
            ?.classList.toggle('hidden', !baseAsset());
    }

    /**
     * Grey out the fields the author has not decided anything about, which Hide Default
     * Values then takes off the screen.
     *
     * What counts as undecided depends on what the file is. One of the mod's own states
     * every field it carries, so the question is which of them still hold the template's
     * value. A patch states only what it changes, so the question is which fields are
     * still the base game's -- and a patch of any size is mostly those, which is what
     * makes the toggle worth having there.
     *
     * What is marked here is then taken to wherever Hide Default Values stands. A document
     * can be opened -- or rebuilt by an edit -- long after that switch was flipped, and
     * marking alone would leave it showing what every other open document is hiding.
     */
    function markDefaultValues()
    {
        const unchanged = mode === Mode.PATCH ? baseDocument : window.templates[fileType];
        if (!unchanged) return;

        tree.findAndHandle(item => {
            return item.parent.isRoot;
        }, item => {
            let itemLabel = item.label;
            if(itemLabel in unchanged && JSON.stringify(data[itemLabel]) === JSON.stringify(unchanged[itemLabel]))
            {
                item.el.classList.add('default-value-node');
            }
        });

        applyDefaultValueVisibility();
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
        const assetName = overriding ? copyFrom : name;

        // What the manifest will name, which is the file rather than the asset. A patch
        // is named after what it overrides and carries no type, so the two agree there.
        let stem = assetName;

        if (overriding) {
            // Checked before the file is written, not when it is opened a moment later.
            // A patch is a difference from the asset it names, so one whose asset cannot
            // be read is a file that can never be opened again -- and the dialog would
            // have left it sitting in the folder and in the load order.
            const { reason } = await readBaseAsset(type, assetName);

            if (reason) {
                alert(`${assetName} cannot be overridden here: ${reason}.`);
                return null;
            }

            // Not a template: a patch holds the changes to make to the asset, so a new
            // one holds none.
            await createOverrideIfNotExisting(assetName, type, window.selectedMod.baseFolder);
        } else {
            stem = await createFileIfNotExisting(assetName, type, window.selectedMod.baseFolder, (content) => {
                content.name = assetName;
                content.presetName = assetName;
                content.type = type;
                content.copyFrom = copyFrom ? `REF:${type}|${copyFrom}` : null;
                return content;
            });
        }

        // The folder has a new file in it.
        const { refreshPanel } = await import('./scripts/ui.js');
        await refreshPanel();

        // Asking for a file is asking to fill it in, and the dialog used to end with the
        // file panel one entry longer and nothing on screen -- the author had to go and
        // find what they had just named. Windows are keyed by path, so naming a file that
        // already exists opens the one that is there rather than a second copy of it.
        await loadFile(stem, false, type, overriding ? PATCH_SUFFIX : NEW_SUFFIX);

        return refFor(stem);
    }

    // A type the layout describes as a plain value rather than as a shape: a new
    // element of an array of strings is "". cloneTemplate builds from window.templates
    // or from the layout, and there is neither for these -- it threw, which was the
    // whole of what right-clicking such an array used to do.
    //
    // After the enums check cloneTemplate makes first: this flow stores an enum as its
    // index, Boolean included, and basicTypeTemplates would hand back `false`.
    if (!(templateName in window.enums) && templateName in window.basicTypeTemplates) {
        return deepClone(window.basicTypeTemplates[templateName]);
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

/**
 * The asset the next new file dialog opens on, or null for the blank dialog the
 * manifest's own Add new file gives.
 *
 * Set immediately before that button is clicked and read once, when the dialog opens.
 * The two are joined by a DOM click, which carries nothing: the button belongs to
 * whichever manifest document is open, and going through it is what makes "Use as..."
 * create a file exactly as Add new file does -- listed in the load order, in the same
 * mod, by the same code -- rather than a second way of doing the same thing.
 */
let newFileSource = null;

/**
 * Open the new file dialog on a base game asset, from the window showing it.
 *
 * A base game asset is read-only, so what an author does with one is copy it. Finding it
 * again in the dialog's list of every asset of its type -- having just been reading it --
 * is the step this takes out.
 */
export function useAsNewFile(type, name) {
    const addFile = document.querySelector('#manifest_add_item_button');

    // Disabled until a content folder is chosen: a new file is a file in a mod, and
    // there is no mod here to put one in.
    if (!addFile || addFile.disabled) {
        alert('Please select a mod to save in first');
        return;
    }

    // Bound by the manifest document as it loads, so an unbound button is a folder whose
    // manifest could not be read. Said rather than silently doing nothing, which is what
    // clicking a button bound to nothing does.
    if (!addFile.onclick) {
        alert(`This folder has no ${MANIFEST_FILE}, so there is nothing to add a new file to.`);
        return;
    }

    newFileSource = { type, name };
    addFile.click();
}

// Creates a promise that is pending while the new file model is open
export async function showNewFilePopup() {
    let popupPromise = new Promise((resolve, reject) => {
        window.newFilePromiseResolve = (name, type, copyFrom, mode) =>
            resolve({ name, type, copyFrom: (copyFrom === 'None' ? null : copyFrom), mode });
        window.newFilePromiseReject = () => reject({ name: null, type: null, copyFrom: null, mode: null });
    });

    // Read once, and cleared whether or not the dialog is gone through with: the next
    // file is a new file rather than another copy of the last asset looked at.
    const source = newFileSource;
    newFileSource = null;

    // Opening is the only point at which the file type is known to be settled, so the
    // list is filled here rather than left empty until the type select is touched.
    setNewFileSource(source);
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
