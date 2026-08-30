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

export async function tryGetFile(handle, path, create) {
    try {
        return await getFile(handle, path, create)
    }
    catch
    {
        return null;
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

export async function tryGetFolder(handle, path, create) {
    try {
        return await getFolder(handle, path, create)
    }
    catch
    {
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
