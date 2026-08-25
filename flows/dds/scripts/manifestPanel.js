/**
 * The manifest panel: what a mod's ddsmanifest declares, above the file list.
 *
 * Shaped like the case flow's murdermanifest panel -- an entry per file, with the
 * document itself behind a switch -- because it answers the same question: what does
 * the loader think this mod contains? The file list below shows what is on disk; only
 * a mapping explains why a file the game reads as Strings/English/Citizens/jobs.csv is
 * sitting at the content root.
 *
 * Two things are deliberately absent.
 *
 * The entries are buttons that do nothing. They name strings CSVs, and nothing in the
 * app opens one of those yet; when something does, that is what they will do.
 *
 * The document is shown, not edited. jsonTree is built for the wide columns of #trees
 * (grid-auto-columns: minmax(500px, auto)) and in a 260px panel a value's box escapes
 * the column, leaving it legible but out of the pointer's reach. Editing waits for
 * somewhere wider to live. Until then the only thing that rewrites a manifest is the
 * app declaring a strings file it just created -- see writeManifest in ddsManifest.js.
 */
import { fastElement } from '../../../core/dom.js';
import { ddsContentFolder } from './modFileManager.js';
import { readManifest, virtualPathOf } from './ddsManifest.js';

const PANEL = '#dds-manifest-panel';

/** Rebuild the panel for the selected mod, or hide it when there is no manifest. */
export async function refreshManifestPanel() {
    const panel = document.querySelector(PANEL);
    if (!panel) return;

    const ddsFolder = await ddsContentFolder(window.selectedMod?.baseFolder ?? null);
    const manifest = await readManifest(ddsFolder);

    // A mod without a manifest is offered no editor for one. Starting to use a virtual
    // structure is the author's decision, not a side effect of opening the mod here.
    panel.classList.toggle('hidden', !manifest.present);
    if (!manifest.present) return;

    renderMappings(panel, manifest.files);
    renderSource(panel, manifest);
}

/** Pico switches the two views: the friendly list, or the document behind it. */
export function toggleManifestPanel() {
    document.querySelector(`${PANEL} .files-order`).classList.toggle('hidden');
    document.querySelector(`${PANEL} .manifest-source`).classList.toggle('hidden');
}

function renderMappings(panel, mappings) {
    const list = panel.querySelector('.files-order ul');
    list.replaceChildren();

    for (const mapping of mappings) {
        const item = fastElement('li');
        item.dataset.real = mapping.real;

        const button = fastElement('button', 'secondary');
        button.type = 'button';
        button.innerText = mapping.real;
        button.title = `Read by the game as ${virtualPathOf(mapping)}`;

        item.append(button);
        list.append(item);
    }
}

/**
 * The manifest as its author wrote it.
 *
 * A manifest that would not parse is shown the same way, because the text is exactly
 * what has to be repaired -- and it is marked, since otherwise an empty entry list is
 * the only clue that anything is wrong.
 */
function renderSource(panel, manifest) {
    const text = fastElement('pre', manifest.malformed ? 'manifest-text manifest-broken' : 'manifest-text');
    text.textContent = manifest.raw;

    panel.querySelector('.manifest-source').replaceChildren(text);
}
