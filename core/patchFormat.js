/**
 * What a `.sodso_patch.json` holds, and how one is made from what the author edited.
 *
 * A patch used to be a partial file: the fields it named were written over the base game
 * asset and the rest was left alone. The loader now reads a list of operations instead --
 *
 *   {
 *     "name": "PaperCeilingLightBright",
 *     "fileType": "RoomLightingPreset",
 *     "patches": [
 *       { "op": "add", "path": "/roomCompatibility/-", "value": "REF:RoomConfiguration|BankATMVestibuleRC" }
 *     ]
 *   }
 *
 * -- which it applies to the live object's serialised form before deserialising it back.
 * `patches` is what tells the two apart: a file without it still takes the old
 * whole-field path, so nothing already published stops loading.
 *
 * The operations are RFC 6902 with one addition. `[field=value]` stands anywhere an array
 * index does, and resolves against the document as it stands when that operation runs:
 *
 *   /companyStructure/subordinates/[positionsMaximum=4]/positionsMinimum
 *
 * That is the whole point of the format. An index is a position in a list the game ships
 * and is free to renumber; a key match still finds the same element after an update, and
 * says so loudly rather than editing the wrong one when it cannot. `fast-json-patch` knows
 * nothing about it, so `applyPatches` resolves selectors to indices before handing each
 * operation over, and `diffToPatches` writes them out.
 *
 * None of this is the author's to think about. They edit the asset; what comes out is the
 * difference between it and the base.
 *
 * `jsonpatch` is a global from libs/JSON-Patch, loaded as a classic script.
 */
import { deepClone } from './files.js';

/**
 * The keys that describe the patch rather than the asset. They name the target -- which
 * the file's own name repeats -- and they are not fields of the object being patched, so
 * they are held apart from the document being edited and written back around it.
 */
export const ENVELOPE_KEYS = ['name', 'fileType', 'patches'];

/**
 * Fields that identify an element of an array well enough to match on, most specific
 * first. Nothing is matched on a field that is not one of these: a selector is a promise
 * that this element is still that element after a game update, and a field like
 * `scoreModifier` cannot keep it.
 */
const IDENTIFYING_FIELDS = ['name', 'presetName', 'id', 'itemTag', 'occupation'];

/** `[field=value]`, non-greedy on the field so a value may contain `=`. */
const SELECTOR = /^\[(.+?)=(.*)\]$/;

/** Whether a file is in the operation format rather than the one it replaces. */
export function isPatchFormat(parsed) {
    return Array.isArray(parsed?.patches);
}

/** The patch file itself, as it is written. */
export function patchFile(name, fileType, patches) {
    return { name, fileType, patches };
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The operations that turn `base` into `working`.
 *
 * `jsonpatch.compare` gives the mechanically correct answer and a brittle one: every array
 * path is an index, and inserting an element rewrites the whole tail after it. So each
 * operation is walked and its path made as durable as it can be made, against a copy of
 * the base that is carried forward operation by operation -- which is the same document
 * the loader will be looking at when it runs that operation, and the only state in which
 * a selector or an append can be judged.
 *
 * Accumulating the operations as the author makes them would preserve intent better -- an
 * append would stay an append rather than being recognised as one afterwards -- but it
 * drifts the moment anything changes the document outside the edit loop, and it needs
 * coalescing when one field is edited twice. Comparing is self-correcting: it always
 * describes the difference that is actually there.
 */
export function diffToPatches(base, working) {
    const evolving = deepClone(base);
    const durable = [];

    for (const op of jsonpatch.compare(base, working)) {
        durable.push({ ...op, path: durablePath(evolving, op) });

        // The index form, which is what `compare` produced against this exact state.
        // Cloned so the evolving document shares no structure with what is returned: a
        // later operation reaching into an object an earlier one inserted would otherwise
        // edit that earlier operation's value as well.
        jsonpatch.applyOperation(evolving, deepClone(op));
    }

    return durable;
}

/**
 * One operation's path, with each array segment written the most durable way it can be.
 *
 * Appends become `/-`. Array segments that land on an element with a unique identifying
 * field become `[field=value]`. Anything else keeps its index and is position-dependent,
 * which is the best that can be said about an array of numbers or of anonymous shapes.
 *
 * The last segment of an `add` is left alone. There it is a position to insert at rather
 * than an element to find -- `/list/2` means third, not "the one currently third".
 */
function durablePath(document, op) {
    if (!op.path) return op.path;

    const segments = op.path.split('/');
    const written = [segments[0]];
    let node = document;

    for (let i = 1; i < segments.length; i++) {
        const segment = segments[i];
        const isLast = i === segments.length - 1;

        if (!Array.isArray(node)) {
            written.push(segment);
            node = step(node, segment);
            continue;
        }

        const index = Number(segment);

        if (isLast && op.op === 'add') {
            written.push(index === node.length ? '-' : segment);
            break;
        }

        written.push(selectorFor(node, index) ?? segment);
        node = node[index];
    }

    return written.join('/');
}

/**
 * `[field=value]` for the element at `index`, or null when nothing identifies it.
 *
 * The value has to be unique in the array, or the selector names more than one element
 * and the loader refuses it -- which is the right answer there and a bug here, so it is
 * checked before the selector is written rather than left to be discovered in game.
 */
function selectorFor(array, index) {
    const element = array[index];
    if (!isPlainObject(element)) return null;

    for (const field of IDENTIFYING_FIELDS) {
        if (!(field in element)) continue;

        const value = selectableValue(element[field]);
        if (value === null) continue;

        const matches = array.filter((el) => isPlainObject(el) && String(el[field]) === value);
        if (matches.length === 1) return `[${field}=${value}]`;
    }

    return null;
}

/**
 * How a value is written into a selector, or null if it cannot be.
 *
 * Strings holding any of the punctuation a path is made of are refused rather than
 * escaped: a JSON Pointer escapes `/` and `~`, a selector delimits with `[`, `]` and `=`,
 * and the two escaping schemes would have to agree across this file and the loader's C#
 * for the value to survive. Falling back to an index costs a selector; getting that wrong
 * costs the wrong element.
 *
 * Whole numbers only among numbers, for the same reason in a smaller way: `4.0` is written
 * `4` by JSON.stringify here and may not be there. Booleans identify nothing -- an array
 * where one is unique is an array where it is about to stop being.
 */
function selectableValue(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
    if (typeof value !== 'string' || !value) return null;

    return /[[\]=/~]/.test(value) ? null : value;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The document a patch describes: the base with its operations applied.
 *
 * An operation that will not apply stops the whole file rather than being skipped. The
 * usual reason is that the base has moved on -- the asset was patched against one version
 * of the game and is being opened against another -- and carrying on would present a
 * document that is not what the patch says, then save the difference back over it.
 *
 * @returns `{ document }`, or `{ failed }` naming the operation and why
 */
export function applyPatches(base, patches) {
    const document = deepClone(base);

    for (const [index, op] of (patches ?? []).entries()) {
        try {
            const resolved = { ...op, path: resolveSelectors(document, op.path) };
            if (typeof op.from === 'string') resolved.from = resolveSelectors(document, op.from);

            jsonpatch.applyOperation(document, deepClone(resolved), true);
        } catch (error) {
            return { failed: { index, op, reason: error?.message ?? String(error) } };
        }
    }

    return { document };
}

/**
 * A path with every `[field=value]` replaced by the index it names, against `document` as
 * it stands now -- which is after every operation before this one has been applied.
 *
 * Throws when a selector matches nothing or matches more than one element. Both are the
 * patch describing a document other than the one in front of it, and neither has an answer
 * that is better than saying so.
 */
function resolveSelectors(document, path) {
    const segments = String(path ?? '').split('/');
    const resolved = [segments[0]];
    let node = document;

    for (let i = 1; i < segments.length; i++) {
        const segment = segments[i];
        const match = SELECTOR.exec(segment);

        if (!match) {
            resolved.push(segment);
            node = step(node, segment);
            continue;
        }

        const [, field, value] = match;
        const where = resolved.join('/') || '/';

        if (!Array.isArray(node)) {
            throw new Error(`${segment} has to select from a list, and ${where} is not one`);
        }

        const found = node.reduce(
            (hits, element, index) =>
                (isPlainObject(element) && String(element[field]) === value ? [...hits, index] : hits),
            []
        );

        if (found.length === 0) throw new Error(`nothing in ${where} has ${field} = ${value}`);
        if (found.length > 1) throw new Error(`${found.length} things in ${where} have ${field} = ${value}`);

        resolved.push(String(found[0]));
        node = node[found[0]];
    }

    return resolved.join('/');
}

/**
 * A patch in the old format, read as the document it describes.
 *
 * Objects merge key by key and arrays replace whole, which is what `FromJsonOverwrite`
 * does with the file and so is what its author meant by writing it. The keys naming the
 * target are left out: they describe the patch rather than the asset, the base game's
 * assets carry neither, and merging them in would put an `add /name` in every patch this
 * app converts.
 *
 * Whether Unity reconstructs nested `[Serializable]` classes rather than merging into them
 * is unverified on the loader side. If it reconstructs, files in the wild were already
 * loading differently from how they read, and converting one makes it more like what its
 * author wrote rather than less.
 */
export function mergeOldFormat(base, file) {
    const overrides = { ...file };
    for (const key of ENVELOPE_KEYS) delete overrides[key];

    return mergeInto(deepClone(base), overrides);
}

function mergeInto(target, source) {
    if (!isPlainObject(target) || !isPlainObject(source)) return deepClone(source);

    for (const [key, value] of Object.entries(source)) {
        target[key] = isPlainObject(value) && isPlainObject(target[key])
            ? mergeInto(target[key], value)
            : deepClone(value);
    }

    return target;
}

/* -------------------------------------------------------------------------- */

/** One step down a JSON Pointer, whose segments are escaped. */
function step(node, segment) {
    if (node === null || typeof node !== 'object') return undefined;

    return node[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
}

/** An object with fields, as opposed to an array or a null. */
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
