/**
 * File creation shared by both flows.
 *
 * Both had their own "create this file unless it exists" helper with different
 * signatures, and the case flow's existence check never worked: it passed the type
 * name where a path array was expected, so getFile called .splice on a string, threw,
 * and tryGetFile swallowed it and returned null. The check therefore always failed
 * and the file was always written -- creating a case with the name of an existing one
 * silently overwrote its manifest and preset.
 */
import { getFile, tryGetFile, writeFile } from './fs.js';

/**
 * Create a file only if it does not already exist. Returns the handle either way,
 * so callers can tell the difference only by whether their builder ran.
 *
 * @param folder       directory handle to create relative to
 * @param pathSegments path below that directory, as an array
 * @param buildContent () => object, called only when the file is absent
 */
export async function createFileIfMissing(folder, pathSegments, buildContent) {
    // getFile consumes the array via splice, so hand each call its own copy.
    const existing = await tryGetFile(folder, [...pathSegments]);
    if (existing) return existing;

    const handle = await getFile(folder, [...pathSegments], true);
    await writeFile(handle, JSON.stringify(await buildContent()));
    return handle;
}

/**
 * Give a file in a directory a new name, with the contents it should have under it.
 *
 * Written and then removed rather than moved: `FileSystemFileHandle.move()` is not
 * something this app can rely on being there, and doing it in this order means a failure
 * part way through leaves the document under one of the two names -- never under
 * neither. The caller supplies the contents because it already has them; the file on
 * disk may be a save behind.
 *
 * A name already taken is refused rather than overwritten. It belongs to another asset,
 * and quietly replacing one because a field was edited is not a rename.
 *
 * @returns true if the file was renamed, false if `toName` was already taken
 */
export async function renameFile(folder, fromName, toName, contents) {
    if (fromName === toName) return true;
    if (await tryGetFile(folder, [toName])) return false;

    await writeFile(await getFile(folder, [toName], true), contents);
    await folder.removeEntry(fromName);
    return true;
}

/** Structural copy, used wherever a template is instantiated. */
export function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}
