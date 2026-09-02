/**
 * File System Access API helpers.
 *
 * Lifted verbatim from the two apps' fileManager.js, which were identical apart from
 * DDSViewer additionally defining readFileContent. Behaviour is unchanged.
 *
 * Note: getFile/getFolder consume `path` via splice, so callers must pass a throwaway
 * array (the usual `somePath.split('/')` is fine, a shared array is not).
 *
 * Choosing directories is core/folders.js; this is only about reading and writing
 * once a directory has been connected.
 */

export async function getFile(handle, path, create) {
    if (path.length == 1) {
        return await (await handle.getFileHandle(path[0], { create }));
    }
    else {
        var folder = path.splice(0, 1)[0];
        return getFile(await handle.getDirectoryHandle(folder), path, create);
    }
}

/**
 * The errors that mean "there is no such entry", as opposed to "this could not be read".
 *
 * `NotFoundError` is the plain answer: nothing of that name is in the folder.
 * `TypeMismatchError` is the same answer about a name taken by the other kind of thing --
 * a file where a folder was asked for -- which is a fact about the folder rather than a
 * failure to look at it.
 *
 * Everything else is the file system saying it could not answer: a permission that has
 * lapsed, a disk busy enough to fail a read, a directory handle whose folder has been
 * moved, a bug handing this a path it cannot walk. None of those is absence.
 *
 * The difference is not academic, because absence is what callers *act* on, and what they
 * do about it is write. `createFileIfMissing` creates the file it believes is not there;
 * `renameFile` takes a free name as free; `readManifest` gives a mod with no manifest a
 * new one; `presetForSaving` builds the building it cannot find. Every one of those turns
 * a moment of I/O trouble into a file overwritten -- see the note at the top of
 * core/files.js, where this had already happened once through a swallowed TypeError.
 *
 * So only the two are absence, and everything else is raised. A caller that genuinely
 * wants "or null for any reason at all" says so: see probeFolder.
 */
const MISSING = ['NotFoundError', 'TypeMismatchError'];

const isMissing = (error) => MISSING.includes(error?.name);

/**
 * A file below a directory handle, or null when the directory does not hold it.
 *
 * No directory is a form of not holding it: several callers reach here with a folder they
 * have not been given yet -- no mod selected, no game folder connected -- and "there is no
 * file" is the answer they want rather than an error about a null handle.
 *
 * @throws whatever the file system raised, when that is something other than absence
 */
export async function tryGetFile(handle, path, create) {
    if (!handle) return null;

    try {
        return await getFile(handle, path, create)
    }
    catch (error)
    {
        if (isMissing(error)) return null;
        throw error;
    }
}

export async function readFileContent(handle) {
    return await (await (handle)?.getFile())?.text()
}

export async function getFolder(handle, path, create) {
    if (path.length == 1) {
        return await handle.getDirectoryHandle(path[0], { create });
    }
    else {
        var folder = path.splice(0, 1)[0];
        return getFolder(await handle.getDirectoryHandle(folder, { create }), path, create);
    }
}

/**
 * A directory below a directory handle, or null when it is not there. See tryGetFile.
 *
 * @throws whatever the file system raised, when that is something other than absence
 */
export async function tryGetFolder(handle, path, create) {
    if (!handle) return null;

    try {
        return await getFolder(handle, path, create)
    }
    catch (error)
    {
        if (isMissing(error)) return null;
        throw error;
    }
}

/**
 * A directory, or null for any reason whatever that there is not one.
 *
 * For working out the shape of a folder nobody here chose -- the one the author picked in
 * the file dialog, which may be the game's install root, its Data directory, or
 * StreamingAssets itself. The caller is asking three questions and expects two of them to
 * fail, and what a failure *was* does not change what it does about it.
 *
 * Nothing is written on the strength of the answer, which is the whole reason this is safe
 * where a plain tryGetFolder would not be. Anywhere a null leads to a write, use that one
 * and let the trouble be raised.
 */
export async function probeFolder(handle, path) {
    if (!handle) return null;

    try {
        return await getFolder(handle, path);
    }
    catch {
        return null;
    }
}

/**
 * A file, or null for any reason whatever that there is not one. See probeFolder.
 *
 * For a caller that is *waiting* for a file rather than acting on its absence. The
 * walkthrough is the one: it re-reads the content folder every 400ms asking whether the
 * step's file has been written yet, and "not yet" is the answer it expects for as long as
 * the author takes. There, one read failing is a reason to ask again on the next tick and
 * nothing more -- raising would end the step over a blip, and the step's whole job is to
 * be patient.
 *
 * Safe for the same reason probeFolder is: nothing is written on the answer.
 */
export async function probeFile(handle, path) {
    if (!handle) return null;

    try {
        return await getFile(handle, path);
    }
    catch {
        return null;
    }
}

/**
 * Delete a file below a directory handle.
 *
 * Absent counts as removed. The caller's reason for asking is that the file should not be
 * there afterwards, and a file that was already gone satisfies that -- treating it as a
 * failure would leave the manifest still naming it.
 *
 * @param path segments below `handle`, the last of which is the file
 * @returns false only when the folder or the removal itself refused
 */
export async function removeFile(handle, path) {
    const segments = [...path];
    const name = segments.pop();
    if (!name) return false;

    // getFolder consumes the array it is given, so it gets its own copy.
    const folder = segments.length ? await tryGetFolder(handle, [...segments]) : handle;
    if (!folder) return false;

    try {
        await folder.removeEntry(name);
        return true;
    } catch (error) {
        return error?.name === 'NotFoundError';
    }
}

export async function writeFile(fileHandle, contents, append) {
    const writeable = await fileHandle.createWritable({ keepExistingData: append });

    if (append) {
        let offset = (await fileHandle.getFile()).size;
        writeable.seek(offset);
        if (offset === 0) {
            contents = contents.trim();
        }
    }

    await writeable.write(contents);
    await writeable.close();
}
