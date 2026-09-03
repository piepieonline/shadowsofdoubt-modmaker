/**
 * One answer to "what is already in this folder, and what may I do to it".
 *
 * Two flows write ScriptableObjects into a mod: the room creator writes four assets and a
 * patch per thing admitted, and the furniture creator writes three assets. Both had their
 * own copy of the same three decisions -- is the file there, is it mine, is it a patch or a
 * whole asset -- and the copies disagreed. The room creator's is what this module was
 * written for: it read a cluster of its own back out of the folder, failed to recognise it,
 * and wrote a `.sodso_patch.json` aimed at the mod's own file.
 *
 * So the decision is made once, here, and both flows ask.
 *
 * ## A change, and where it lands
 *
 * A flow says what it wants in the vocabulary below -- `ownAsset`, `addTo`, `takeOut` --
 * and `landAll` says what that comes to against the folder as it is. Nothing in either half
 * touches a folder, which is what lets the pane draw exactly what the write will do rather
 * than a second guess at it. `commit` is the only part that writes.
 *
 * | asked for | what the mod has | action |
 * |---|---|---|
 * | `ownAsset` | nothing | `create` |
 * | `ownAsset` | this flow's own file | `merge` |
 * | `ownAsset` | somebody else's file | `clash` |
 * | `addTo` | nothing | `create`, as a patch |
 * | `addTo` | a patch | `append` |
 * | `addTo` | a whole asset of the mod's own | `leave` |
 * | `addTo` | a patch in the old whole-field format | `refuse` |
 * | `takeOut` | a patch | `append`, or `delete` when nothing is left |
 * | `takeOut` | anything else | `leave` |
 * | anything | a file that will not parse | `refuse` |
 *
 * ## Why a mod's own asset is never patched
 *
 * A `.sodso_patch.json` names an asset and a type and the loader applies its operations to
 * whatever is registered under them. A mod that declares `Foo` *and* patches `Foo` is asking
 * the load order which of the two the patch lands on, and the load order is a list the
 * author maintains by hand. So a change to an asset the mod declares is the author's to make
 * in that file, and this says so rather than writing a patch that may or may not apply.
 *
 * ## Only the fields it knows about
 *
 * A file this tool wrote once is not a file it owns for ever -- the panes tell the author to
 * go and edit what was written. So `ownAsset` carries `owns`: the fields this flow decides,
 * and the only ones a save may write over. Everything else in the file is left exactly as it
 * is, including fields nothing here has heard of. Listed by name rather than taken from the
 * object being written, because the two differ in the case that matters: a field being
 * *removed* is absent from the new object, and overlaying only what is present would leave
 * the old value behind.
 */
import { getFile, readFileContent, removeFile, writeFile } from './fs.js';
import {
    MANIFEST_FILE, blankManifest, readManifest, withListing, withoutListing,
} from './murderManifest.js';
import {
    PATCH_SUFFIX, PRESET_SUFFIX, assetNameOf, fileNameFor, patchFileNameFor,
} from './soFileName.js';
import { parseJSON, stringifyJSON } from './jsonNumbers.js';

/* -------------------------------------------------------------------------- */
/* What a flow asks for                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A file this flow declares, and the fields in it that are this flow's to decide.
 *
 * `owns` null means the whole file, which is only right where the file is never written
 * twice -- see `createOnly`, which is how the furniture creator leaves an arrangement alone
 * once the author has one.
 */
export const ownAsset = ({ asset, type, content, owns = null, createOnly = false }) => ({
    kind: 'own',
    asset,
    type,
    content,
    owns,
    createOnly,
    file: fileNameFor(asset, type),
});

/**
 * Operations added to an asset this flow does not own.
 *
 * `shared` says the name belongs to assets of more than one type, so the patch's file name
 * has to carry the type -- see `patchFileNameFor`. It decides what a *new* patch is called
 * and nothing else: a patch already in the folder is landed on under whatever it is called.
 */
export const addTo = ({ asset, type, ops, shared = false }) => ({
    kind: 'add',
    asset,
    type,
    ops,
    file: patchFileNameFor(asset, type, shared),

    // The patch this would be on its own, which is what lands where the folder holds
    // nothing. Held on the change rather than built at landing time so that a pane can show
    // the file it is about to write without asking a folder first.
    content: { name: asset, fileType: type, patches: ops },
});

/**
 * This flow's own operations taken back out of a patch.
 *
 * `ours` is asked of each operation in the file. Only what it claims is removed: another
 * room, or the author by hand, may have added to the same shipped asset and their
 * operations are none of this flow's business.
 */
export const takeOut = ({ asset, type, ours, shared = false }) => ({
    kind: 'out',
    asset,
    type,
    ours,
    file: patchFileNameFor(asset, type, shared),
});

/* -------------------------------------------------------------------------- */
/* What the folder holds                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every ScriptableObject file in a content folder, read whole.
 *
 * The folder rather than the manifest's list: a file the author has not got round to
 * listing is still one that is there, and one the loader would ignore is better reported
 * than hidden. A file that will not parse is named rather than skipped -- writing over a
 * file this cannot read would throw away whatever is in it, and a file half-edited in
 * another window is the likeliest reason for it.
 *
 * `name` is what the file calls the asset. A patch names its target in `name`; an asset
 * names itself in `presetName`, which is what a `REF:` resolves against. Neither is
 * guaranteed to be there, and the file's own name is the fallback.
 */
export async function readModFiles(folder) {
    const empty = { files: [], unreadable: [], present: [] };
    if (!folder) return empty;

    const files = [];
    const unreadable = [];
    const present = [];

    try {
        for await (const entry of folder.values()) {
            if (entry.kind !== 'file' || entry.name === MANIFEST_FILE) continue;

            const patch = entry.name.endsWith(PATCH_SUFFIX);
            if (!patch && !entry.name.endsWith(PRESET_SUFFIX)) continue;

            present.push(entry.name);

            let raw = null;
            try {
                raw = parseJSON(await readFileContent(entry));
            } catch {
                unreadable.push(entry.name);
                continue;
            }

            const stem = entry.name.slice(0, -(patch ? PATCH_SUFFIX : PRESET_SUFFIX).length);
            const type = raw?.fileType ?? raw?.type ?? null;

            files.push({
                fileName: entry.name,
                file: stem,
                type,
                patch,
                raw,
                name: (patch ? raw?.name ?? raw?.presetName : raw?.presetName ?? raw?.name)
                    ?? assetNameOf(stem, type),
            });
        }
    } catch {
        // A folder that cannot be enumerated at all. Reported as an empty one rather than
        // thrown: every caller draws a pane from this, and none of them can do anything
        // useful with an exception here.
        return empty;
    }

    return { files, unreadable, present };
}

/**
 * The folder as a question anything can be asked of: does this mod declare that asset, does
 * it patch it, and is that file readable.
 *
 * Assets and patches are kept apart rather than merged, because a mod holding both of one
 * name is the case that has to be recognised rather than resolved -- see the note at the
 * top. Keyed by type as well as name: hundreds of names belong to more than one type, and
 * `SecurityDoorDouble` the cluster and `SecurityDoorDouble` the preset are two assets.
 */
export function indexMod({ files = [], unreadable = [], present = [] } = {}) {
    const assets = new Map();
    const patches = new Map();

    for (const entry of files) {
        if (!entry.type || !entry.name) continue;
        const into = entry.patch ? patches : assets;

        // First wins. Two files claiming one asset is a mod that already has a problem, and
        // the one the loader takes is decided by the manifest rather than by this.
        if (!into.has(keyOf(entry.name, entry.type))) {
            into.set(keyOf(entry.name, entry.type), { fileName: entry.fileName, raw: entry.raw });
        }
    }

    return {
        assets,
        patches,
        present: new Set(present.length ? present : files.map((entry) => entry.fileName)),
        broken: new Set(unreadable),
    };
}

/** An empty folder, for a pane drawing a plan before a mod has been chosen. */
export const emptyIndex = () => indexMod();

const keyOf = (asset, type) => `${type}|${asset}`;

/* -------------------------------------------------------------------------- */
/* Where each change lands                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What each change comes to against the folder.
 *
 * @param own the file names this flow is entitled to write over -- the assets of the thing
 *            being edited. A file of one of its names that is *not* in here belongs to
 *            something else, and taking it would be this flow quietly replacing it.
 */
export function landAll(changes, index, { own = new Set() } = {}) {
    return changes.map((change) => land(change, index, own));
}

function land(change, index, own) {
    if (change.kind === 'own') return landOwn(change, index, own);
    if (change.kind === 'add') return landAdd(change, index);
    return landOut(change, index);
}

/** A file of this flow's own: created, merged into, or somebody else's. */
function landOwn(change, index, own) {
    const declared = index.assets.get(keyOf(change.asset, change.type));
    const there = index.present.has(change.file);

    // The file at that name, and only if it is the one declaring this asset. A file whose
    // contents name something else is not this flow's whatever it is called, and merging
    // into it under that assumption is how a save quietly replaces somebody's work.
    const held = declared?.fileName === change.file ? declared : null;

    if (index.broken.has(change.file)) {
        return refuse(change, change.file, `${change.file} is in this folder and will not parse`);
    }

    if (!there) return { change, file: change.file, action: 'create', content: change.content };

    if (!held || !own.has(change.file)) {
        return {
            change,
            file: change.file,
            action: 'clash',
            reason: `${change.file} is already in this folder and belongs to something else`,
        };
    }

    // Written once and never again. The furniture creator's cluster is the case: after it
    // exists this flow owns nothing in it, so a save has nothing to contribute and
    // everything to lose.
    if (change.createOnly) {
        return { change, file: change.file, action: 'leave', reason: 'this is yours to edit' };
    }

    return {
        change,
        file: change.file,
        action: 'merge',
        content: mergeOwned(held.raw, change.content, change.owns),
    };
}

/** An addition to somebody else's asset, which is a patch unless the mod declares the asset. */
function landAdd(change, index) {
    const declared = index.assets.get(keyOf(change.asset, change.type));

    if (declared) {
        return {
            change,
            file: declared.fileName,
            action: 'leave',
            reason: `${change.asset} is one of this mod's own assets rather than the game's, so `
                + 'this change is yours to make in that file — a patch over it would apply or '
                + 'not depending on the load order',
        };
    }

    const held = index.patches.get(keyOf(change.asset, change.type));
    const file = held?.fileName ?? change.file;

    if (index.broken.has(file)) {
        return refuse(change, file, `${file} is in this folder and will not parse`);
    }

    if (!held) {
        // A file of that name holding something else. The type goes into a patch's file name
        // only for names known to be ambiguous, so this is a name that turned out to be.
        if (index.present.has(file)) {
            return refuse(change, file, `${file} is already in this folder and patches something else`);
        }

        return { change, file, action: 'create', content: change.content };
    }

    const merged = mergeOps(held.raw, change.ops);
    if (merged.reason) return refuse(change, file, merged.reason);

    return { change, file, action: 'append', content: merged.content, added: merged.added };
}

/** This flow taken back out of a patch, and the file dropped when nothing else is left. */
function landOut(change, index) {
    const held = index.patches.get(keyOf(change.asset, change.type));

    // Nothing to take this out of. Not a fault: the ordinary case is a flow listing
    // everything it might once have written and finding most of it was never written.
    if (!held) return { change, file: change.file, action: 'leave' };

    if (index.broken.has(held.fileName)) {
        return refuse(change, held.fileName, `${held.fileName} still names this and will not parse`);
    }

    const stripped = withdrawOps(held.raw, change.ours);

    if (!stripped.removed) return { change, file: held.fileName, action: 'leave' };

    return stripped.empty
        ? { change, file: held.fileName, action: 'delete', removed: stripped.removed }
        : {
            change, file: held.fileName, action: 'append', content: stripped.content, removed: stripped.removed,
        };
}

const refuse = (change, file, reason) => ({ change, file, action: 'refuse', reason });

/* -------------------------------------------------------------------------- */
/* The three merges                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One file as it should land on top of whatever is already there.
 *
 * The owned keys are cleared before the new ones go on, so a field this save means to
 * *remove* is removed rather than surviving underneath. Everything else is untouched.
 */
export function mergeOwned(existing, content, owns) {
    if (!existing || !owns) return content;

    const merged = { ...existing };
    for (const field of owns) delete merged[field];

    return { ...merged, ...content };
}

/**
 * A patch with this flow's operations added to it.
 *
 * Idempotent on purpose: writing the same room twice should be a no-op on its patches
 * rather than a file with the same operation in it twice.
 *
 * @returns `{ content, added }`, or `{ reason }` for a patch that cannot be added to
 */
export function mergeOps(existing, ops) {
    if (!Array.isArray(existing?.patches)) {
        // The format this app replaced states fields rather than operations. Appending an
        // operation to it would produce a file that is half one format and half the other,
        // and converting it needs the base asset, which is not always readable.
        return {
            reason: `${existing?.name ?? 'that file'} is written in the older whole-field format, `
                + 'so this change cannot be added to it',
        };
    }

    const has = (operation) => existing.patches.some((each) => each?.op === operation.op
        && each?.path === operation.path
        && stringifyJSON(each?.value) === stringifyJSON(operation.value));

    const missing = ops.filter((operation) => !has(operation));

    return { content: { ...existing, patches: [...existing.patches, ...missing] }, added: missing.length };
}

/**
 * A patch with this flow's operations taken out of it.
 *
 * The whole file is not dropped unless it is left with nothing: another room, or the author
 * by hand, may have added to the same shipped asset.
 *
 * @returns `{ content, removed, empty }`
 */
export function withdrawOps(existing, ours) {
    const patches = Array.isArray(existing?.patches) ? existing.patches : [];
    const kept = patches.filter((operation) => !ours(operation));

    return {
        content: { ...existing, patches: kept },
        removed: patches.length - kept.length,
        empty: kept.length === 0,
    };
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/** What stops a write before the folder is touched at all. */
export const refusals = (landed) => landed.filter((item) => item.action === 'refuse' || item.action === 'clash');

/** The manifest names files rather than assets, and names them without their suffix. */
export function stemOf(file) {
    if (file.endsWith(PATCH_SUFFIX)) return file.slice(0, -PATCH_SUFFIX.length);
    if (file.endsWith(PRESET_SUFFIX)) return file.slice(0, -PRESET_SUFFIX.length);
    return file;
}

/**
 * Put the landed changes into the folder.
 *
 * Order matters twice over. The files go down before the manifest, so a failure part way
 * through leaves assets the loader never reaches rather than a load order naming files that
 * are not there. And the manifest is listed in the order the changes came in, because that
 * is dependency order: every `REF:` has to resolve to something already loaded.
 *
 * A refusal anywhere stops all of it. A flow that wrote half a room would leave a mod that
 * does not load, and the half it wrote is the half that makes the rest unmergeable.
 *
 * @returns `{ refused }` for a write that did not happen, otherwise what it did
 */
export async function commit(folder, landed) {
    const refused = refusals(landed);
    if (refused.length) return { refused };

    const written = [];
    const removed = [];
    const left = landed.filter((item) => item.action === 'leave');

    for (const item of landed) {
        if (item.action === 'delete') {
            await removeFile(folder, [item.file]);
            removed.push(item);
            continue;
        }

        if (item.action === 'leave') continue;

        const handle = await getFile(folder, [item.file], true);
        await writeFile(handle, `${stringifyJSON(item.content, null, 2)}\n`);
        written.push(item);
    }

    // One read and one write rather than a pass per file: a dozen re-reads of the same
    // manifest is a dozen chances for it to be half-updated.
    const { present, malformed, data } = await readManifest(folder);
    if (malformed) return { refused: [], written, removed, left, malformed: true };

    let manifest = present ? data : blankManifest();

    for (const item of written) manifest = withListing(manifest, stemOf(item.file));

    // A file that has gone must stop being named, or the loader goes looking for it.
    for (const item of removed) manifest = withoutListing(manifest, stemOf(item.file));

    const handle = await getFile(folder, [MANIFEST_FILE], true);
    await writeFile(handle, `${stringifyJSON(manifest, null, 2)}\n`);

    return {
        refused: [], written, removed, left, malformed: false,
    };
}
