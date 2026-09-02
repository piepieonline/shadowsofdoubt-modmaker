/**
 * The game's furniture assets, read one at a time as something asks for them.
 *
 * The furniture creator used to read a trimmed copy of these -- `furnitureCreator.json`,
 * derived from a dump by a tool in this repo. That was the wrong shape for this pane. A
 * trim has to anticipate every question, and this one had to be widened three times in a
 * day: once for sub-object geometry, once so a patch had a whole asset to apply to, and
 * once for the placement rules a class states. Each widening was a tool change, a
 * regeneration and a commit, and the data was still a snapshot of whichever build of the
 * game happened to be dumped.
 *
 * So it reads the assets instead, through `core/baseAssets.js` -- the author's own
 * exported ScriptableObjects folder, which holds every type and is the game they are
 * actually modding. Nothing is trimmed, nothing goes stale, and the next field somebody
 * wants is already there.
 *
 * ## One asset at a time
 *
 * A preset is one file, its classes are one or two more, and its sub-object classes are a
 * handful. Opening a piece of furniture reads about a dozen files, not a thousand. The
 * exception is the reverse index -- which clusters have a slot for a class -- which is a
 * question about every cluster and cannot be answered from any smaller set; that one is
 * asked for explicitly and is the only scan here.
 *
 * ## What is cached, and when it is forgotten
 *
 * Per asset, for the life of the page. The game's assets do not change under the editor,
 * which is the same reasoning `assetScan.js` gives for its own cache -- and the same reason
 * both are dropped when the folders change: `readBaseAsset` prefers the author's export to
 * what this tool ships, so connecting one mid-session changes every answer.
 */
import { readBaseAsset, listBaseAssets } from '../../../core/baseAssets.js';

/** `type -> name -> document | null`, where null is "read, and there is no such asset". */
const cache = new Map();

/**
 * The mod's own assets, which shadow the game's.
 *
 * The loader's rule: an asset a mod defines replaces the shipped one of that name. So a
 * lookup has to consult these first, or a preset naming its mod's own class goes looking
 * for it in the export folder, does not find it, and reports the author's own work as
 * unreadable -- which is the bug this exists to prevent rather than a tidiness.
 *
 * Held here rather than passed through every call because it is a fact about what the game
 * would load, not an argument to one question.
 */
const modAssets = new Map();

/** Hand over the mod's own assets of one type, replacing whatever was there. */
export function setModAssets(type, byName) {
    modAssets.set(type, byName ?? new Map());
}

/** The cluster index, which is the one thing here worth a scan. Null until asked for. */
let clusterIndex = null;

/** `type -> names`, one directory listing each. */
const listings = new Map();

/**
 * Every asset name of one type, from the export folder itself.
 *
 * Listed rather than taken from `window.typeMap`, which is generated from whichever build
 * was dumped -- so furniture a newer game added would be on the author's disk and missing
 * from every picker. The generated list is still the fallback when there is no export.
 */
export async function listAssets(type) {
    if (!listings.has(type)) listings.set(type, await listBaseAssets(type));
    return listings.get(type);
}

/**
 * Forget everything read so far.
 *
 * Called when the folders change. A cache filled before an export folder was connected
 * holds whatever this tool ships, which for these four types is nothing at all.
 */
export function forgetFurnitureAssets() {
    cache.clear();
    clusterIndex = null;
    modAssets.clear();
    listings.clear();
}

/**
 * One asset, or null.
 *
 * The failure is not reported here. Every caller wants the same thing from a name it
 * cannot read -- to say so about that one asset and carry on with the rest -- and a reason
 * threaded through six call sites to be joined back together at the end is worth less than
 * `readMissing` below, which asks the same question once when there is something to say.
 */
export async function readAsset(type, name) {
    if (!name) return null;

    // The mod's own first. Not cached with the rest: these change while the pane is open,
    // and the cache exists because the game's assets do not.
    const own = modAssets.get(type)?.get(name);
    if (own) return own;

    const byName = cache.get(type) ?? new Map();
    cache.set(type, byName);

    if (byName.has(name)) return byName.get(name);

    const { document } = await readBaseAsset(type, name);
    byName.set(name, document ?? null);

    return document ?? null;
}

/** Several at once, in the order asked for, skipping the ones that could not be read. */
export async function readAssets(type, names) {
    const documents = await Promise.all([...new Set(names)].map((name) => readAsset(type, name)));
    return documents.filter(Boolean);
}

/**
 * Why an asset could not be read, for the one place that needs to say it.
 *
 * `readBaseAsset`'s own reason, which already distinguishes "your export does not have
 * this" from "this tool does not ship this type, connect your export folder". Both are
 * things an author can act on and they need different actions.
 */
export async function readMissing(type, name) {
    if (modAssets.get(type)?.has(name)) return null;

    const { reason } = await readBaseAsset(type, name);
    return reason ?? null;
}

/**
 * Which clusters have a slot for each class, built once and kept.
 *
 * The hop nothing in the files states: a preset names classes, a cluster names classes,
 * and nothing points from one to the other. Answering it means reading every cluster --
 * there is no smaller set that can be shown to be enough, because the answer is "none of
 * them" exactly when every one has been checked.
 *
 * 399 files, so it is asked for rather than assumed: the pane offers it behind a press and
 * says what it costs. Kept for the session afterwards, which makes the second piece of
 * furniture instant.
 *
 * @param names   every cluster name, from `listAssets`
 * @param onProgress ({ read, total }) => void
 */
export async function readClusterIndex(names, onProgress = null) {
    if (clusterIndex) return clusterIndex;

    const byClass = new Map();
    const clusters = new Map();
    let read = 0;

    onProgress?.({ read: 0, total: names.length });

    // Eight at a time, matching `assetScan.js`. Enough to keep the reads in flight without
    // asking the file system for four hundred handles at once.
    const queue = [...names];

    const worker = async () => {
        for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
            const document = await readAsset('FurnitureCluster', name);
            onProgress?.({ read: ++read, total: names.length });
            if (!document) continue;

            clusters.set(name, document);

            for (const element of document.clusterElements ?? []) {
                const className = refName(element?.furnitureClass);
                if (!className) continue;

                if (!byClass.has(className)) byClass.set(className, new Set());
                byClass.get(className).add(name);
            }
        }
    };

    await Promise.all(Array.from({ length: 8 }, worker));

    clusterIndex = { byClass, clusters };
    return clusterIndex;
}

/** Whether the index has already been built, so the pane can offer it or use it. */
export const haveClusterIndex = () => clusterIndex !== null;

/** A `REF:Type|Name`, a `REF:Name` or a bare name, as the name. */
export function refName(value) {
    if (typeof value !== 'string') return null;

    const trimmed = value.trim().replace(/^REF:/i, '');
    if (!trimmed || trimmed.toLowerCase() === 'null') return null;

    const bar = trimmed.indexOf('|');
    return (bar >= 0 ? trimmed.slice(bar + 1) : trimmed).trim() || null;
}

export const refNames = (value) =>
    (Array.isArray(value) ? value.map(refName).filter(Boolean) : []);
