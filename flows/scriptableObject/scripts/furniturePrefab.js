/**
 * A mod's own model, read off disk: the prefab it declares and the mesh that prefab names.
 *
 * The base game's furniture is 310 Unity prefabs inside an asset bundle, and nothing in
 * this app can open one. A mod's is different in kind rather than in degree: it is a
 * `.sodprefab.json` and an `.obj` sitting in the content folder, which is a format this
 * repo already writes -- `meshExport.js` generates exactly that pair for a building shell,
 * and the bank example mod ships one. So where a preset in the mod points at a prefab, the
 * real model can be drawn instead of a box the size of its footprint.
 *
 * Read only. Whether the loader will build a *furniture* prefab from JSON is unsettled --
 * the one worked example is a building -- so nothing here writes one, and a model that is
 * drawn is one the author already had.
 *
 * ## The mirror that is not there
 *
 * An `.obj` is **not** in the game's coordinates, and reading one applies no mirror at all.
 * That is the opposite of what it looks like it should be, so here is the whole chain:
 *
 * | Space | x |
 * |---|---|
 * | the game's, left-handed | `gx` |
 * | the `.obj`, right-handed | `-gx` — the loader negates x on import (`modelSpace.md` §6) |
 * | this scene, three.js | `-gx` — `inSceneSpace` negates x for the same handedness |
 *
 * The file and the scene are the same right-handed frame; the game's is the odd one out, and
 * neither end of this pane is in it. So an `.obj` reads straight through, faces wound as
 * written, which is what three.js' own `OBJLoader` does. `toObj` in the building flow does
 * negate x, because *its* meshes are built in the game's space -- the two are not a pair.
 *
 * Mirroring here drew a mod's model as its own reflection: sitting where the footprint is
 * not, with every sub-object marker on the wrong end of it. Nothing said so, because a
 * mirrored desk is still a desk.
 */
import { tryGetFile, tryGetFolder, readFileContent } from '../../../core/fs.js';
import { parseJSON } from '../../../core/jsonNumbers.js';

/** What a `prefab` field looks like when it points into the mod: `PREFAB:<folder>/<name>`. */
const PREFAB_PREFIX = /^PREFAB:/i;

/**
 * The folder and name a prefab reference names, or null.
 *
 * Null for a base game preset, whose `prefab` resolves to a `GameObject` name and nothing
 * more -- there is no file to go and look for, which is the difference this returns.
 */
export function prefabPathOf(reference) {
    if (typeof reference !== 'string' || !PREFAB_PREFIX.test(reference.trim())) return null;

    const path = reference.trim().replace(PREFAB_PREFIX, '');
    const slash = path.lastIndexOf('/');

    // A reference with no folder is a prefab beside the manifest rather than in one of its
    // own, which is legal and is what a small mod tends to write.
    return slash < 0
        ? { folder: null, name: path, file: `${path}.sodprefab.json` }
        : {
            folder: path.slice(0, slash),
            name: path.slice(slash + 1),
            file: `${path.slice(slash + 1)}.sodprefab.json`,
        };
}

/**
 * Every mesh a prefab names, with where in the prefab it sits.
 *
 * Walked recursively rather than one level deep. `meshExport` writes a single child
 * holding a `MeshRenderer`, but the format plainly allows a tree and a hand-authored
 * prefab may well be one -- and a mesh silently skipped for being one level too deep is a
 * model that appears with a piece missing.
 *
 * Offsets accumulate down the tree, which is what `position` on a child means.
 */
export function meshesIn(prefab) {
    const found = [];

    const walk = (node, offset) => {
        const at = node?.position ?? [0, 0, 0];
        const here = [offset[0] + (at[0] ?? 0), offset[1] + (at[1] ?? 0), offset[2] + (at[2] ?? 0)];

        for (const component of node?.components ?? []) {
            if (component?.mesh) found.push({ mesh: component.mesh, offset: here });
        }

        for (const child of node?.children ?? []) walk(child, here);
    };

    walk(prefab, [0, 0, 0]);
    return found;
}

/**
 * Every `InteractableController` a prefab declares, with where in the prefab it sits.
 *
 * The other half of what a `.sodprefab.json` is worth reading for, and the half nothing
 * else in this app can answer. A `FurniturePreset`'s `integratedInteractables` names a
 * controller by `id`, and `FurnitureLocation.CreateInteractables` looks that id up among
 * the prefab's controllers to get the interactable's position and rotation. A miss is not
 * fatal: it logs `Unable for find corresponding controller for integrated interactable on
 * <name>` and creates the thing at the furniture's origin with no rotation -- which is a
 * mug inside the desk rather than on it, and no error anywhere an author will see.
 *
 * For a shipped preset the ids are unknowable here: the prefab is a Unity `GameObject` in
 * an asset bundle nothing in a browser can open. For a `PREFAB:` one they are simply in the
 * file, which is what lets the pane offer the ids that exist rather than the 32 the enum
 * has.
 *
 * Walked the same way `meshesIn` walks, and for the same reason: the format allows a tree
 * and a controller one level deeper than expected would be a pairing that silently could
 * not be made.
 *
 * ## Position only
 *
 * Offsets accumulate; **rotation does not**, because no node in either worked example
 * carries one -- neither `meshExport.js`, which writes the only prefabs this repo makes,
 * nor the game's own `BoardRoomTablePrefab`. A controller under a rotated parent would come
 * back at the wrong place, so what this reports is where the file says the node is, and a
 * caller drawing it is drawing that.
 */
export function controllersIn(prefab) {
    const found = [];

    const walk = (node, offset) => {
        const at = node?.position ?? [0, 0, 0];
        const here = [offset[0] + (at[0] ?? 0), offset[1] + (at[1] ?? 0), offset[2] + (at[2] ?? 0)];

        for (const component of node?.components ?? []) {
            // The id is what a preset pairs to, so a controller without one is a component
            // nothing can name. Kept out rather than listed as an empty choice.
            if (component?.type === 'InteractableController' && component.id) {
                found.push({ id: component.id, node: node?.name ?? null, offset: here });
            }
        }

        for (const child of node?.children ?? []) walk(child, here);
    };

    walk(prefab, [0, 0, 0]);
    return found;
}

/**
 * An `.obj` as the arrays a three.js geometry is built from.
 *
 * De-indexed into one vertex per corner, keyed on the `v/vt/vn` triple, because that is
 * what an `.obj` actually describes: the three indices in a face vary independently, so a
 * position shared by two faces with different normals is two vertices in a mesh even
 * though it is one line in the file.
 *
 * Handles what the format uses in practice rather than all of it: `v`, `vn`, `vt`, `f`
 * with any of the four corner spellings, negative (relative) indices, and faces with more
 * than three corners, which are fanned. Materials, groups, smoothing and curves are read
 * past -- this draws a shape, it does not import a scene.
 *
 * Returns null for text with no faces in it, which is a file that is not an `.obj` rather
 * than a model of nothing.
 */
export function parseObj(text) {
    const positions = [];
    const normals = [];
    const uvs = [];

    const outPositions = [];
    const outNormals = [];
    const outUvs = [];
    const indices = [];
    const seen = new Map();

    /** An index as written: 1-based, or negative counting back from the end. */
    const resolve = (raw, list) => {
        const value = Number.parseInt(raw, 10);
        if (!Number.isFinite(value) || value === 0) return -1;
        return value > 0 ? value - 1 : list.length / 3 + value;
    };

    const resolveUv = (raw) => {
        const value = Number.parseInt(raw, 10);
        if (!Number.isFinite(value) || value === 0) return -1;
        return value > 0 ? value - 1 : uvs.length / 2 + value;
    };

    /** One corner of a face, added once however many faces name it. */
    const corner = (token) => {
        if (seen.has(token)) return seen.get(token);

        const [v, vt, vn] = token.split('/');
        const position = resolve(v, positions);
        const normal = vn ? resolve(vn, normals) : -1;
        const uv = vt ? resolveUv(vt) : -1;

        const index = outPositions.length / 3;

        // As written. The file's frame is this scene's frame -- see the table at the top.
        outPositions.push(
            positions[position * 3] ?? 0,
            positions[position * 3 + 1] ?? 0,
            positions[position * 3 + 2] ?? 0);

        if (normal >= 0) {
            outNormals.push(
                normals[normal * 3] ?? 0,
                normals[normal * 3 + 1] ?? 0,
                normals[normal * 3 + 2] ?? 0);
        }

        if (uv >= 0) outUvs.push(uvs[uv * 2] ?? 0, uvs[uv * 2 + 1] ?? 0);

        seen.set(token, index);
        return index;
    };

    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const parts = trimmed.split(/\s+/);
        const keyword = parts[0];

        if (keyword === 'v') positions.push(+parts[1] || 0, +parts[2] || 0, +parts[3] || 0);
        else if (keyword === 'vn') normals.push(+parts[1] || 0, +parts[2] || 0, +parts[3] || 0);
        else if (keyword === 'vt') uvs.push(+parts[1] || 0, +parts[2] || 0);
        else if (keyword === 'f') {
            const corners = parts.slice(1).map(corner);

            // A fan from the first corner. Right for a triangle, right for the convex
            // quads an exporter writes, and no worse than the file for anything else.
            for (let i = 1; i + 1 < corners.length; i++) {
                // In the order the file names them. Winding is orientation, and orientation
                // only flips with a mirror -- there is none here, so reversing this would
                // leave every face pointing into the model.
                indices.push(corners[0], corners[i], corners[i + 1]);
            }
        }
    }

    if (!indices.length) return null;

    return {
        positions: outPositions,
        // Only when the file gave one for every corner. A partial normal array is worse
        // than none: three.js reads it positionally, so the mesh is lit from whatever the
        // gaps happen to line up with. Computing them is the caller's business.
        normals: outNormals.length === outPositions.length ? outNormals : null,
        uvs: outUvs.length * 3 === outPositions.length * 2 ? outUvs : null,
        indices,
    };
}


/* -------------------------------------------------------------------------- */
/* Reading it off disk                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The model a preset points at, read out of the mod's content folder.
 *
 * Returns `{ meshes }` when it is all there, and `{ missing }` naming the first thing that
 * was not when it is not. Never a proxy: a preset that names a prefab is a preset whose
 * author expects a model, and quietly drawing a box the size of its footprint instead
 * reads as the model being wrong rather than absent.
 *
 * `controllers` comes back from **both**, because it is the prefab's answer rather than the
 * mesh's: a model whose `.obj` has not been exported yet is still a model whose author can
 * say what pairs to what, and gating the interactable editor on a file that has nothing to
 * do with it would be this pane refusing to do the one thing only it can.
 *
 * The reference is resolved against the selected content folder alone -- the same reach
 * everything else in these panes has, and the same one the mod loader gives a relative
 * path.
 */
export async function readModel(folder, reference) {
    const path = prefabPathOf(reference);
    if (!folder || !path) return null;

    const home = path.folder ? await tryGetFolder(folder, path.folder.split('/')) : folder;
    if (!home) return { missing: `${path.folder}, the folder its prefab is in` };

    const handle = await tryGetFile(home, [path.file]);
    if (!handle) return { missing: path.file };

    let prefab = null;
    try {
        prefab = parseJSON(await readFileContent(handle));
    } catch {
        return { missing: `${path.file}, which is there but will not parse` };
    }

    // Read before anything can go wrong with a mesh, and carried into every return below.
    const controllers = controllersIn(prefab);
    const read = { name: path.name, controllers };

    const named = meshesIn(prefab);
    if (!named.length) return { ...read, missing: `a mesh in ${path.file}, which names none` };

    const meshes = [];

    for (const entry of named) {
        const meshHandle = await tryGetFile(home, [entry.mesh]);
        if (!meshHandle) return { ...read, missing: `${entry.mesh}, named by ${path.file}` };

        const geometry = parseObj(await readFileContent(meshHandle));
        if (!geometry) return { ...read, missing: `usable geometry in ${entry.mesh}` };

        meshes.push({ name: entry.mesh, offset: entry.offset, geometry });
    }

    return { ...read, meshes };
}
