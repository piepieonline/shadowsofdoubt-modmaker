/**
 * Saving.
 *
 * The two flows write differently and both are needed:
 *
 *  - fullFile:    the ScriptableObject flow owns its files outright, so it writes the
 *                 whole document.
 *  - vanillaPatch: the DDS flow edits base-game content it must not modify, so it
 *                 writes a JSON Patch against the vanilla file to a sibling
 *                 '<path>_patch', which the DDS Loader applies at runtime. Files the
 *                 mod itself created have no vanilla counterpart and are written whole.
 *
 * `jsonpatch` is a global from libs/JSON-Patch, loaded as a classic script.
 */
import { autosaveEnabled } from './autosave.js';
import { tryGetFile, writeFile } from './fs.js';

/** Saving needs somewhere to write. Both flows alerted and threw; kept as-is. */
export function assertModSelected() {
    if (!window.selectedMod) {
        alert('Please select a mod to save in first');
        throw 'Please select a mod to save in first';
    }
}

/** Autosave is opt-out, but explicit Save always writes. */
export function shouldSave(force) {
    return Boolean(autosaveEnabled() || force);
}

/**
 * Serialise a document for writing, dropping keys that exist only for display.
 *
 * `dummyKeys` maps NAME -> actual key, so the keys to strip are its *values*. Using
 * Object.keys here meant nothing was ever stripped, and the DDS flow's resolved
 * English text leaked into every block it saved.
 */
export function toSaveSafeJSON(data, dummyKeys) {
    const displayOnly = Object.values(dummyKeys);
    return JSON.stringify(data, (key, value) => (displayOnly.includes(key) ? undefined : value), 2);
}

/** Write the document as-is. */
export async function writeWholeFile(folder, pathSegments, contents) {
    await writeFile(await tryGetFile(folder, pathSegments, true), contents, false);
}

/** Write a JSON Patch describing how the document differs from the vanilla file. */
export async function writePatchAgainstVanilla(folder, pathSegments, vanillaText, contents) {
    const patch = jsonpatch.compare(JSON.parse(vanillaText), JSON.parse(contents));
    await writeFile(await tryGetFile(folder, pathSegments, true), JSON.stringify(patch), false);
}
