/**
 * The folders the app works with, shared across every flow.
 *
 * Both flows used to prompt for their own folders on startup, from their own modal,
 * and neither knew what the other had already picked. There is one set of folders and
 * one place that owns them.
 *
 * Handles are kept on `window` because the flows' existing code reads them there, and
 * persisted in idb-keyval so a handle survives a reload. Whether it is still *usable*
 * after a reload is a permission question -- see restoreFolders below.
 */
import { tryGetFolder } from './fs.js';
import { isDemoMode } from './demo/demoMode.js';

export const FOLDERS = [
    {
        id: 'streamingAssets',
        label: 'Game folder',
        hint: 'Your Shadows of Doubt install. Read-only — base game content is read from here.',
        idbKey: 'StreamingAssetsPath',
        globalName: 'dirHandleStreamingAssets',
        mode: 'read',

        /**
         * Users reasonably pick the Steam install root rather than the buried
         * StreamingAssets directory, so walk down to it if we can.
         */
        async resolve(handle) {
            if (handle.name === 'StreamingAssets') return handle;
            return (
                await tryGetFolder(handle, ['Shadows of Doubt', 'Shadows of Doubt_Data', 'StreamingAssets']) ||
                await tryGetFolder(handle, ['Shadows of Doubt_Data', 'StreamingAssets']) ||
                await tryGetFolder(handle, ['StreamingAssets']) ||
                null
            );
        },
        invalidMessage: "That does not look like a Shadows of Doubt install — pick the game folder, or its StreamingAssets folder.",
    },
    {
        id: 'modDir',
        label: 'Mod folder',
        hint: 'Where your mods live, one subfolder per mod. Read and write.',
        idbKey: 'ModPath',
        // The DDS Viewer stored this separately, so its users are not asked again.
        legacyKeys: ['DDSModPath'],
        globalName: 'dirHandleModDir',
        mode: 'readwrite',
    },
    {
        id: 'exportedSOs',
        label: 'Exported ScriptableObjects',
        hint: 'Optional. Lets the asset explorer read assets you have exported yourself.',
        idbKey: 'ExportedSOPath',
        globalName: 'dirHandleExportedSOPath',
        mode: 'read',
        optional: true,
    },
];

export const getFolderKind = (id) => FOLDERS.find((f) => f.id === id) ?? null;

export const folderHandle = (id) => window[getFolderKind(id).globalName] ?? null;

export const folderName = (id) => folderHandle(id)?.name ?? null;

async function rememberedHandle(kind) {
    for (const key of [kind.idbKey, ...(kind.legacyKeys ?? [])]) {
        const handle = await idbKeyval.get(key);
        if (handle) return handle;
    }
    return null;
}

/**
 * Whether a remembered handle can be used without asking again.
 *
 * OPFS handles have no permission API at all, so treat a missing queryPermission as
 * granted rather than as a failure.
 */
async function isUsable(handle, mode) {
    if (!handle?.queryPermission) return true;
    try {
        return (await handle.queryPermission({ mode })) === 'granted';
    } catch {
        return false;
    }
}

/**
 * Reconnect to folders picked previously.
 *
 * Chrome only keeps a grant across reloads if the user chose to allow it every visit,
 * so this often finds a handle it cannot use yet. That is why the folder modal offers
 * a button per folder rather than assuming: re-granting needs a user gesture, and a
 * remembered handle makes that one click instead of navigating the file dialog again.
 */
export async function restoreFolders() {
    const restored = [];

    for (const kind of FOLDERS) {
        const handle = await rememberedHandle(kind);
        if (!handle) continue;

        if (await isUsable(handle, kind.mode)) {
            window[kind.globalName] = handle;
            restored.push(kind.id);
        } else {
            // Remembered but needs re-granting; the modal will show it as such.
            pendingHandles.set(kind.id, handle);
        }
    }

    return restored;
}

/** Handles we remember but may not use until the user re-grants them. */
const pendingHandles = new Map();

export const isPending = (id) => pendingHandles.has(id);
export const pendingName = (id) => pendingHandles.get(id)?.name ?? null;

/**
 * Publish a folder without remembering it.
 *
 * For handles that did not come from the picker and must not outlive the page -- demo
 * mode's seeded directories are the only ones so far. `accept` is the other half of
 * this, and the difference is deliberate: writing one of these to idb-keyval would
 * displace the real folder the user picked, and a later visit would silently reconnect
 * to demo content.
 */
export function useFolder(id, handle) {
    window[getFolderKind(id).globalName] = handle;
    return handle;
}

/**
 * Ask for a folder. Must be called from a user gesture.
 *
 * If we already have a remembered handle for it, try re-granting that first: the user
 * gets a one-click permission prompt instead of the file dialog.
 */
export async function selectFolder(id) {
    // Demo mode's promise is that no real folder is read or written. Connecting one here
    // would break that quietly, with the badge still saying otherwise -- and the folder
    // would then be remembered, so it would outlast the demo.
    if (isDemoMode()) {
        alert('Folders cannot be changed in demo mode. Reload without ?demo to use your own.');
        return null;
    }

    const kind = getFolderKind(id);

    const remembered = pendingHandles.get(id) ?? (await rememberedHandle(kind));

    if (remembered?.requestPermission) {
        try {
            if ((await remembered.requestPermission({ mode: kind.mode })) === 'granted') {
                return accept(kind, remembered);
            }
        } catch {
            // Fall through to the picker.
        }
    }

    const options = { mode: kind.mode };
    if (remembered) options.startIn = remembered;

    const picked = await window.showDirectoryPicker(options);
    const resolved = kind.resolve ? await kind.resolve(picked) : picked;

    if (!resolved) {
        alert(kind.invalidMessage ?? 'That folder cannot be used.');
        return null;
    }

    return accept(kind, resolved);
}

async function accept(kind, handle) {
    window[kind.globalName] = handle;
    pendingHandles.delete(kind.id);
    await idbKeyval.set(kind.idbKey, handle);
    return handle;
}

/** Which of a flow's required folders are still missing. */
export function missingFolders(flow) {
    return (flow.requiredFolders ?? []).filter((id) => !folderHandle(id));
}
