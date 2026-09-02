/**
 * The selected mod's own furniture, read out of the content folder.
 *
 * The game's assets come from the author's export, one at a time, through
 * `furnitureAssets.js`. A mod's do not: they are files in the content folder being edited,
 * they change while the pane is open, and they shadow the shipped asset of the same name.
 * So they are read here, and everything else about them is the same code.
 *
 * ## Three ways a file gets its values, and one reader
 *
 * | Written as | Starts from |
 * |---|---|
 * | `<Name>.sodso.json` with `copyFrom` | the donor asset, read whole |
 * | `<Name>.sodso.json` with no `copyFrom` | the type's defaults |
 * | `<Name>.sodso_patch.json` | the shipped asset, with the operations applied |
 *
 * All three end as a whole document, which is then read by the same function that reads a
 * shipped one. That is the point of doing it this way: there is one description of what a
 * `FurniturePreset` means, and a mod's own cannot come out shaped differently from the
 * game's because nothing describes it separately.
 *
 * `overwriteWith` is the loader's own rule -- `FromJsonOverwrite` -- and the half worth
 * naming is that a **list a file states replaces the donor's** rather than merging with it.
 * So a preset that states `subObjects` at all states all of them, and one that states an
 * empty list states that there are none.
 */
import { readFileContent } from '../../../core/fs.js';
import { PRESET_SUFFIX, PATCH_SUFFIX } from '../../../core/soFileName.js';
import { MANIFEST_FILE } from '../../../core/murderManifest.js';
import { readBaseAsset } from '../../../core/baseAssets.js';
import { applyPatches, isPatchFormat, mergeOldFormat, overwriteWith } from '../../../core/patchFormat.js';
import soDefaults from '../../../refs/generated/soDefaults.json' with { type: 'json' };

import { readAsset, refName, setModAssets } from './furnitureAssets.js';
import { describeAsset } from './furnitureModel.js';
import { placementFromAsset } from './furnitureClass.js';

const PRESET = 'FurniturePreset';
const CLASS = 'FurnitureClass';

/**
 * Every file of one type in a content folder.
 *
 * The folder rather than the manifest's list, for the reason the room creator reads rooms
 * the same way: a file the author has not got round to listing yet is still one worth
 * showing, and one the loader would ignore is better reported than hidden.
 */
export async function readTypeFiles(folder, type) {
    if (!folder) return [];

    const files = [];

    try {
        for await (const entry of folder.values()) {
            if (entry.kind !== 'file' || entry.name === MANIFEST_FILE) continue;

            const patch = entry.name.endsWith(PATCH_SUFFIX);
            if (!patch && !entry.name.endsWith(PRESET_SUFFIX)) continue;

            let raw = null;
            try {
                raw = JSON.parse(await readFileContent(entry));
            } catch {
                // A file being edited, or one that is not JSON at all. Neither is a reason
                // to show none of the others.
                continue;
            }

            if ((raw?.fileType ?? raw?.type) !== type) continue;

            files.push({
                fileName: entry.name,
                name: raw.name ?? raw.presetName
                    ?? entry.name.slice(0, -(patch ? PATCH_SUFFIX : PRESET_SUFFIX).length)
                        .replace(new RegExp(`\\.${type}$`), ''),
                patch,
                raw,
            });
        }
    } catch {
        return [];
    }

    return files;
}

/** The mod's own furniture presets, keyed by name. */
export const readFurnitureFiles = (folder) => readTypeFiles(folder, PRESET);

/**
 * What a mod's file amounts to, as a whole document.
 *
 * `{ document }` or `{ reason }`. The reason is the author's to act on and is worth more
 * than a half-read document: a patch that will not apply names the operation that failed,
 * and a `copyFrom` that resolves to nothing names what it could not find.
 */
export async function resolveFile(type, file) {
    if (!file.patch) {
        const donorName = refName(file.raw?.copyFrom);
        const donor = donorName ? await readAsset(type, donorName) : null;

        if (donorName && !donor) {
            return { reason: `it copies from ${donorName}, which could not be read` };
        }

        return mergeFile(type, file, donor);
    }

    const { document: base, reason } = await readBaseAsset(type, file.name);

        if (!base) {
        return {
            reason: `this patches ${file.name}, and ${reason}. Applying a patch needs the `
                + 'whole shipped asset, so nothing about what it changes can be shown '
                + 'until there is one',
        };
    }

    if (!isPatchFormat(file.raw)) return { document: mergeOldFormat(base, file.raw) };

    const { document, failed } = applyPatches(base, file.raw.patches);

    // A document made from the operations that happened to apply is one nobody has, and it
    // looks like a real one.
    if (!document) {
        return {
            reason: `change ${failed.index + 1} (${failed.op.op} ${failed.op.path}) could `
                + `not be made to ${file.name}: ${failed.reason}`,
        };
    }

    return { document };
}

/**
 * A file laid over what it copies, or over the type's defaults.
 *
 * Pure, and split from the read above so that the loader's rule can be checked without a
 * folder: what a file amounts to is the half that is easy to get wrong -- a stated list
 * replaces rather than merges -- and reading the donor is the half that needs a browser.
 *
 * Nothing to copy from means the type's own defaults, which is what the game starts a file
 * with. `FurniturePreset.minimumRoomSize` defaulting to 99 is the reminder that these are
 * the game's numbers rather than a convenient zero.
 */
export function mergeFile(type, file, donor = null) {
    return { document: overwriteWith(donor ?? soDefaults[type] ?? {}, file.raw) };
}

/**
 * One of the mod's presets, in the shape the pane draws.
 *
 * The same shape a shipped preset comes back as, from the same reader. A file that cannot
 * be resolved comes back carrying `unread` and nothing else, which the pane reports rather
 * than drawing an empty preset that looks like a real one.
 */
export async function modPreset(file) {
    const { document, reason } = await resolveFile(PRESET, file);

    if (!document) {
        return {
            name: file.name,
            fileName: file.fileName,
            source: file.patch ? 'patch' : 'copy',
            unread: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`,
            prefab: null,
            classes: [],
            filters: [],
            placed: [],
            parented: [],
            interactables: [],
            universal: true,
            minimumRoomSize: 0,
        };
    }

    const record = await describeAsset(file.name, document);

    return {
        ...record,
        fileName: file.fileName,
        source: file.patch ? 'patch' : refName(file.raw?.copyFrom) ? 'copy' : 'new',
        donor: refName(file.raw?.copyFrom),
        patched: file.patch,

        // What it resolved to, for the caller to register as shadowing the game's asset of
        // that name. Held rather than re-derived: resolving it read a donor.
        document,
    };
}

/**
 * The content folder's own `FurnitureClass` assets, as placements keyed by name.
 *
 * A mod that authors furniture properly authors a class of its own -- the bank example
 * ships three. Without this the pane would tell an author their own class could not be
 * read, which is true of the game's assets and useless: it is the class they wrote, and it
 * is in the folder that is open.
 */
export async function readModClasses(folder) {
    const found = new Map();
    const documents = new Map();

    for (const file of await readTypeFiles(folder, CLASS)) {
        const { document } = await resolveFile(CLASS, file);
        if (!document) continue;

        documents.set(file.name, document);

        // The merge has already applied the loader's rule, so there is no donor left to
        // pass: what arrives here is the class as the game would hold it.
        //
        // The donor's *name* is kept even so, and it is not for reading the rules. It is
        // what the creator needs to save this class again without making it copy from
        // itself: the preset it belongs to names this class, so on the way back in this is
        // the class the pane finds itself mimicking. The preset half keeps a `donor` for
        // exactly the same reason -- see `resolveFile` above.
        found.set(file.name, {
            ...placementFromAsset(file.name, document, null),
            donor: refName(file.raw?.copyFrom),
        });
    }

    // Registered so that everything else looking a class up finds the mod's own before the
    // export's, which is what the game does with them.
    setModAssets(CLASS, documents);

    return found;
}
