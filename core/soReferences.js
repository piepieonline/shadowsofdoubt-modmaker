/**
 * Unity's serialised object references, as this editor shows them.
 *
 * An exported ScriptableObject points at another one as `{"m_FileID":40114,"m_PathID":0}`
 * -- a position in the game's asset files, which says nothing on its own. The generated
 * reference data maps those ids to `Type|Name`, and this rewrites them into the `REF:`
 * strings the rest of the flow deals in.
 *
 * Two kinds of id resolve to no name, and they are not the same thing:
 *
 *   0     no reference at all. Written as null, which is exactly what it means.
 *   other the id names an asset the reference data does not cover: 181 of the 10,565
 *         references in the assets shipped here, concentrated in the types that point at
 *         prefabs, materials and sprites rather than at presets.
 *
 * The second was written as null too. That was a display bug while a patch file held
 * whole fields -- the null was on screen and what got saved was whatever the author typed
 * over it. A patch is a diff now, so an unmapped reference sitting in an array the author
 * edits would be carried into that op's value and would replace the game's reference with
 * nothing. The object is left exactly as it was found instead, so it round-trips byte for
 * byte and reads on screen as the opaque thing it is.
 */

/**
 * The one shape these take. Every reference in the 1,532 assets shipped here is written
 * this way, and the file is re-serialised before this runs, so there is no whitespace
 * between the two halves to allow for.
 */
const REFERENCE = /\{"m_FileID":(-?\d+),"m_PathID":-?\d+\}/g;

/**
 * A parsed document with its references named.
 *
 * @param document parsed JSON, which is not mutated
 * @param pathIdMap file id -> `Type|Name`, as loadRefs.js builds it
 */
export function resolveReferences(document, pathIdMap = {}) {
    const named = JSON.stringify(document).replaceAll(REFERENCE, (raw, id) => {
        const asset = pathIdMap[id];
        if (asset) return `"REF:${asset}"`;

        return Number(id) === 0 ? 'null' : raw;
    });

    return JSON.parse(named);
}
