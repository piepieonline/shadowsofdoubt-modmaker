/**
 * Autosaving: one switch in the shell header, for everything.
 *
 * It used to be a control per flow, and the same word meant two different things. The
 * case flow remembered the setting in localStorage; the DDS flow forced it back on
 * every time it started. Switching editors therefore silently changed whether your
 * edits were being written.
 *
 * The preference is the shell's, so it lives here rather than in a flow, and
 * core/persistence.js reads it through `autosaveEnabled()`.
 */

const KEY = 'SOD_ModMaker_Autosave';

/** The case flow's key, read once so nobody's existing preference is reset. */
const LEGACY_KEY = 'SOD_MurderCaseBuilder_Autosave';

const SWITCH = '#autosave-switch';

let enabled = true;

export const autosaveEnabled = () => enabled;

export function setSaving(saving) {
    enabled = Boolean(saving);
    localStorage.setItem(KEY, JSON.stringify(enabled));

    const box = document.querySelector(SWITCH);
    if (box) box.checked = enabled;
}

/** Opt-out, as it was in both flows: anything unreadable means on. */
function storedPreference() {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (raw == null) return true;

    try {
        return JSON.parse(raw) !== false;
    } catch {
        return true;
    }
}

/** Bind the header switch. Called once by the shell, not per flow. */
export function initAutosave() {
    const box = document.querySelector(SWITCH);
    box.addEventListener('change', () => setSaving(box.checked));
    setSaving(storedPreference());
}
