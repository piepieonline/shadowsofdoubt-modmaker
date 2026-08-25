/**
 * The file panel: what the selected content folder contains, down the left-hand side.
 *
 * Both flows need this and neither could offer it before. DDS content is found by
 * GUID, so without a list there was no way to see what a mod held. The case flow had
 * its manifest, but that only lists what the manifest references -- files present on
 * disk but not loaded were invisible.
 *
 * Core renders; each flow decides what the categories are, because they group by
 * different things. DDS groups by how its content nests (trees hold messages, messages
 * hold blocks, blocks resolve to strings); the case flow groups by the type of
 * ScriptableObject each file describes.
 *
 * Category shape:
 *   { id, label, entries: [{ id, label, tag, openAs }] }
 *
 * `openAs` is passed back to the flow's open handler. An entry without one is listed
 * but is not a link -- some content is real and worth seeing without being openable
 * on its own.
 */
import { fastElement } from './dom.js';

function renderEntry(entry, onOpen) {
    const item = fastElement('li', 'file-panel-entry');
    item.dataset.id = entry.id;
    if (entry.tag) item.dataset.kind = entry.tag;

    const label = fastElement('span', 'file-panel-name');
    label.textContent = entry.label;
    label.title = entry.title ?? entry.id;

    if (!entry.openAs) {
        item.append(label);
        return item;
    }

    const button = fastElement('button', 'secondary file-panel-open');
    button.append(label);

    if (entry.tag) {
        const tag = fastElement('small', 'file-panel-tag');
        tag.textContent = entry.tag;
        button.append(tag);
    }

    button.addEventListener('click', () => onOpen(entry));
    item.append(button);
    return item;
}

/**
 * Render categories into a container.
 *
 * @param emptyMessage shown when there is nothing selected to list
 */
export function renderFilePanel(containerSelector, categories, onOpen, emptyMessage) {
    const list = document.querySelector(containerSelector);
    if (!list) return;

    list.replaceChildren();

    if (!categories) {
        const empty = fastElement('p', 'file-panel-empty');
        empty.textContent = emptyMessage;
        list.append(empty);
        return;
    }

    for (const category of categories) {
        const section = fastElement('details', 'file-panel-category');
        section.dataset.category = category.id;
        // Open by default so the contents are visible without hunting for them.
        section.open = category.entries.length > 0;

        const summary = fastElement('summary');
        summary.textContent = `${category.label} (${category.entries.length})`;
        section.append(summary);

        const entries = fastElement('ul', 'file-panel-entries');
        for (const entry of category.entries) entries.append(renderEntry(entry, onOpen));
        section.append(entries);

        list.append(section);
    }
}
