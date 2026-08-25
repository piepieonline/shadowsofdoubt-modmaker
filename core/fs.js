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
