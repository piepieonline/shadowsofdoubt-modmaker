/**
 * Every ScriptableObject of one type, as the documents the game would load.
 *
 * What the field summary counts. The values a field takes are only worth reading if the
 * set they were read from is the set the game has, so this is where the two sources are
 * reconciled:
 *
 * | Where | What is read |
 * |---|---|
 * | the base game | every name in `window.typeMap[type]`, through `readBaseAsset` |
 * | the selected mod | every file of that type its manifest names |
 *
 * **A mod asset of the same name replaces the base game's** rather than joining it. The
 * game loads the mod's version, so counting both would report a value that is not in play
 * anywhere -- the same rule `applyModOverlay` follows in the building flow.
 *
 * ## Three ways a mod's file gets its values
 *
 * A file states fields; what it states them *over* is what differs.
 *
 * | Written as | Starts from |
 * |---|---|
 * | `<Name>.sodso.json` with `copyFrom` | the donor's resolved document |
 * | `<Name>.sodso.json` with no `copyFrom` | the type's defaults, from `soDefaults.json` |
 * | `<Name>.sodso_patch.json` | the base game's asset, with the patch applied |
 *
 * The defaults matter rather than being a formality: a file written from nothing states
 * only the fields its author touched, and reading it as though the rest were absent would
 * put every untouched field of every such asset in the `(field absent)` row.
 *
 * This is the same job `flows/building/scripts/furnitureOverlay.js` does for the twelve
 * furniture types, and is deliberately not shared with it: that module resolves each asset
 * into a *record reduced to the fields the furniture chain filters on*, and this needs the
 * whole document. What the two do share is the primitives underneath -- `readBaseAsset`,
 * `applyPatches`, `overwriteWith` and `soDefaults` -- which is where the rule about lists
 * replacing rather than merging actually lives.
 */
import { readFileContent, tryGetFile } from '../../../core/fs.js';
import { readBaseAsset, pathIdMap } from '../../../core/baseAssets.js';
import { resolveReferences } from '../../../core/soReferences.js';
import {
    applyPatches, isPatchFormat, mergeOldFormat, overwriteWith,
} from '../../../core/patchFormat.js';

import soDefaults from '../../../refs/generated/soDefaults.json' with { type: 'json' };

import { listContent, PATCH_SUFFIX } from './contentList.js';
import { parseJSON } from '../../../core/jsonNumbers.js';

/** How many assets are read at once. */
const AT_ONCE = 8;

/**
 * What the base game has of each type, once per page.
 *
 * The game's assets do not change under the editor, and a type is hundreds of files: the
 * second field summarised of a type should be instant, and reading `InteractablePreset`
 * twice for two questions about it is the thing this exists to prevent.
 *
 * Not the mod's, which is re-read every time -- a mod changes as it is edited, and that is
 * the half an author is most likely to be asking about.
 */
const baseCache = new Map();

/**
 * Forget what the base game holds.
 *
 * Called when the folders change, because `readBaseAsset` prefers the author's own export
 * to the assets shipped here: connecting one mid-session changes every answer, and a cache
 * filled before it would go on giving the old ones.
 */
export function forgetScannedTypes() {
    baseCache.clear();
}

/**
 * Every asset of `type`, and what could not be read.
 *
 * @param onProgress ({ read, total }) => void, called as the base game's assets arrive
 * @param signal     an AbortSignal; an aborted scan returns `{ cancelled: true }` rather
 *                   than a half-read set, since a table drawn from part of a type would
 *                   answer the question wrongly without saying so
 *
 * @returns `{ records, unreadable, unlisted, fromCache }` where a record is
 *          `{ name, source, document }` and `source` is 'game' or 'mod'
 */
export async function scanType(type, { onProgress = null, signal = null } = {}) {
    const base = await readBaseRecords(type, { onProgress, signal });
    if (base.cancelled) return { cancelled: true };

    const mod = await readModRecords(type);

    // By name: the mod's version of an asset is the one the game loads.
    const byName = new Map(base.records.map((record) => [record.name, record]));
    for (const record of mod.records) byName.set(record.name, record);

    return {
        records: [...byName.values()],
        unreadable: [...base.unreadable, ...mod.unreadable],
        unlisted: mod.unlisted,
        fromCache: base.fromCache,
        modCount: mod.records.length,
    };
}


/* -------------------------------------------------------------------------- */
/* The base game                                                               */
/* -------------------------------------------------------------------------- */

async function readBaseRecords(type, { onProgress, signal }) {
    const cached = baseCache.get(type);
    if (cached) {
        onProgress?.({ read: cached.records.length, total: cached.records.length });
        return { ...cached, fromCache: true };
    }

    const names = window.typeMap?.[type] ?? [];
    const records = [];
    const unreadable = [];
    let read = 0;

    onProgress?.({ read: 0, total: names.length });

    const cancelled = await inParallel(names, signal, async (name) => {
        const { document, reason } = await readBaseAsset(type, name);

        if (document) records.push({ name, source: 'game', document });
        else unreadable.push({ name, source: 'game', reason });

        onProgress?.({ read: ++read, total: names.length });
    });

    if (cancelled) return { cancelled: true };

    // Sorted, because a pool finishes in whatever order the reads come back and the order
    // assets are listed in a row should not depend on how busy the machine was.
    records.sort((a, b) => a.name.localeCompare(b.name));
    unreadable.sort((a, b) => a.name.localeCompare(b.name));

    baseCache.set(type, { records, unreadable });
    return { records, unreadable, fromCache: false };
}

/**
 * Run `work` over `items`, a few at a time, stopping early if the scan is abandoned.
 *
 * A pool rather than one at a time or all at once: a type is up to 732 files, which is
 * minutes in series, and firing all of them at a browser at once is how a fetch starts
 * timing out.
 *
 * @returns whether it was cancelled
 */
async function inParallel(items, signal, work) {
    let next = 0;

    const worker = async () => {
        while (next < items.length) {
            if (signal?.aborted) return;
            await work(items[next++]);
        }
    };

    await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, worker));

    return Boolean(signal?.aborted);
}


/* -------------------------------------------------------------------------- */
/* The mod                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the selected mod defines of this type.
 *
 * Only what the manifest names. A file the game would not load has nothing to say about
 * what values are in play, and counting it would make the summary disagree with the game
 * -- so it is reported instead, which is what the panel does with one too.
 */
async function readModRecords(type) {
    const empty = { records: [], unreadable: [], unlisted: [] };
    const folder = window.selectedMod?.baseFolder;
    if (!folder || !type) return empty;

    // Read again rather than reusing the panel's listing: this is opened by a click that
    // may be minutes after the last refresh, and a folder walk is milliseconds.
    let listing = null;
    try {
        listing = await listContent(folder);
    } catch {
        return empty;
    }

    const entries = listing?.find((group) => group.id === type)?.entries ?? [];
    const records = [];
    const unreadable = [];
    const unlisted = [];

    // What the whole scan shares: the folder, the listing a `copyFrom` is looked up in,
    // and the documents resolved so far.
    const scan = { folder, listing, resolved: new Map() };

    for (const entry of entries) {
        if (!entry.listed) {
            unlisted.push({ name: entry.assetName, file: entry.id });
            continue;
        }

        const { document, reason } = await resolveModAsset(type, entry, scan);

        if (document) records.push({ name: entry.assetName, source: 'mod', document });
        else unreadable.push({ name: entry.assetName, source: 'mod', reason });
    }

    return { records, unreadable, unlisted };
}

/**
 * One of the mod's files, as the document the game would end up with.
 *
 * `scan.resolved` is both a cache and the ring guard, keyed by type and name because a
 * mod may hold two assets of one name -- `Bar` is six of the game's types. A name already
 * being resolved is a `copyFrom` that comes back round to itself, which has no document to
 * answer with: the editor refuses to write one, but a mod is edited by hand as often as
 * through here.
 */
async function resolveModAsset(type, entry, scan) {
    const key = `${type}|${entry.assetName}`;

    if (scan.resolved.has(key)) {
        return scan.resolved.get(key)
            ?? { reason: `${entry.assetName} copies from itself, round a ring of files` };
    }

    // Marked before anything is read, so a ring meets its own null rather than recursing.
    scan.resolved.set(key, null);

    const resolved = await readModAsset(type, entry, scan);
    scan.resolved.set(key, resolved);
    return resolved;
}

async function readModAsset(type, entry, scan) {
    const { folder } = scan;
    const file = `${entry.id}${entry.suffix}`;
    const handle = await tryGetFile(folder, [file]);
    if (!handle) return { reason: `${file} is no longer in the folder` };

    let stated = null;
    try {
        stated = resolveReferences(parseJSON(await readFileContent(handle)), await pathIdMap());
    } catch {
        return { reason: `${file} is not valid JSON` };
    }

    if (entry.suffix === PATCH_SUFFIX) return applyOverride(type, entry, file, stated);

    const copyFrom = refTarget(stated?.copyFrom);

    // Nothing to copy from: what the game starts a file with is the type's own defaults,
    // and `FurniturePreset.minimumRoomSize` defaulting to 99 is the reminder that these
    // are the game's numbers rather than a convenient zero.
    if (!copyFrom) return { document: overwriteWith(soDefaults[type] ?? {}, stated) };

    const donor = await readDonor(copyFrom, scan);
    if (!donor.document) return { reason: `it copies from ${copyFrom.name}, and ${donor.reason}` };

    return { document: overwriteWith(donor.document, stated) };
}

/** An override, as the asset it overrides with the override applied. */
async function applyOverride(type, entry, file, stated) {
    const { document: base, reason } = await readBaseAsset(type, entry.assetName);
    if (!base) return { reason: `it overrides ${entry.assetName}, and ${reason}` };

    if (!isPatchFormat(stated)) return { document: mergeOldFormat(base, stated) };

    const { document, failed } = applyPatches(base, stated.patches);

    // Reported rather than counted against the base game's values: a patch that will not
    // apply is a document nobody has, and saying the asset is unchanged would be the
    // summary quietly agreeing with a file that is wrong.
    if (!document) {
        return {
            reason: `change ${failed.index + 1} (${failed.op.op} ${failed.op.path}) could not `
                + `be made to ${entry.assetName}: ${failed.reason}`,
        };
    }

    return { document };
}

/**
 * What a `copyFrom` names: one of the mod's own files where there is one, the base game's
 * asset otherwise.
 *
 * The mod's first, for the reason `openDerivedFrom` gives in index.js -- an author copying
 * within their own mod means the file they can edit, and the shipped asset of that name is
 * not the one the game will load.
 */
async function readDonor({ type, name }, scan) {
    const own = scan.listing?.find((group) => group.id === type)
        ?.entries.find((candidate) => candidate.listed && candidate.assetName === name);

    if (own) return resolveModAsset(type, own, scan);

    return readBaseAsset(type, name);
}

/** The asset a `REF:Type|Name` names, or null when the value names none. */
function refTarget(value) {
    const target = String(value ?? '').match(/^REF:([\w-]+)\|(.+)$/);
    if (!target) return null;

    return { type: target[1], name: target[2].trim() };
}
