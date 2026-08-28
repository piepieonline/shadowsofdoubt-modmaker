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
 *   { id, label, group, open, footer, sections, entries }
 *   section:  { id, label, open, footer, entries }
 *   entry:    { id, label, tag, action, openAs }
 *
 * `openAs` is passed back to the flow's open handler. An entry without one is listed
 * but is not a link -- some content is real and worth seeing without being openable
 * on its own.
 *
 * `group` is optional, and heads the run of categories that share it. It answers a
 * question a per-category mark cannot: where does the mod's own content stop and the
 * base game's begin. A flow that does not group leaves it out and nothing is drawn.
 *
 * `open` overrides whether a category starts expanded. A panel of a dozen categories
 * that are all open is a scroll rather than a list, so a flow with many says so.
 *
 * `sections` is one level of nesting inside a category, for content that is grouped
 * twice over: a building's floors, each holding the layouts the game picks between. A
 * flow whose content is a flat list of files leaves it out and lists `entries` instead.
 * A category may have both; the sections are drawn first.
 *
 * The count in a heading is what it contains altogether, so a collapsed category still
 * says how much is under it however deeply that is nested.
 *
 * `action` is one more thing that can be done to an entry, as `{ label, title, onClick }`
 * -- deleting a floor. Kept to a single button because it sits in a 300px column beside
 * a name, and the flow decides which entries get one: a mod's own content can be
 * changed, the base game's cannot.
 *
 * `footer` is the same shape, at the foot of a category or a section rather than beside
 * a name: it acts on the whole of what is listed above it rather than on any one line of
 * it -- adding a floor to a building, a layout to a floor. Below rather than in the
 * heading because a heading is what you click to open the section, and a button in it is
 * a button you have to aim around to do that.
 */
import { fastElement } from './dom.js';

/**
 * The small button beside a name, or at the foot of a section.
 *
 * Its click is stopped from travelling. These sit inside a `<details>` that opens and
 * shuts on a click, and beside a row that opens what it names, and this button means
 * neither of those -- it does the one thing it is labelled with.
 */
function renderAction(action) {
    const button = fastElement('button', 'secondary outline file-panel-action');
    button.type = 'button';
    button.textContent = action.label;
    button.title = action.title ?? action.label;

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        action.onClick();
    });

    return button;
}

function renderEntry(entry, onOpen) {
    const item = fastElement('li', 'file-panel-entry');
    item.dataset.id = entry.id;
    if (entry.tag) item.dataset.kind = entry.tag;

    const label = fastElement('span', 'file-panel-name');
    label.textContent = entry.label;
    label.title = entry.title ?? entry.id;

    if (!entry.openAs) {
        item.append(label);
        if (entry.action) item.append(renderAction(entry.action));
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

    if (entry.action) item.append(renderAction(entry.action));
    return item;
}

/** The button at the foot of a category or a section. See `footer` above. */
function renderFooter(footer) {
    const holder = fastElement('div', 'file-panel-footer');
    holder.append(renderAction(footer));
    return holder;
}

/** A heading, and the count of everything under it. */
function renderSummary(label, count) {
    const summary = fastElement('summary');
    const name = fastElement('span', 'file-panel-summary-name');
    name.textContent = `${label} (${count})`;
    summary.append(name);
    return summary;
}

function renderEntries(entries, onOpen) {
    const list = fastElement('ul', 'file-panel-entries');
    for (const entry of entries ?? []) list.append(renderEntry(entry, onOpen));
    return list;
}

/** What a category or section holds, counting through whatever nesting it has. */
function countEntries(node) {
    return (node.entries?.length ?? 0)
        + (node.sections ?? []).reduce((total, section) => total + countEntries(section), 0);
}

/**
 * A group inside a category: a floor of a building, holding the layouts of it.
 *
 * Open unless the flow says otherwise, which is the opposite of the categories above
 * them. A category is one of a dozen buildings and is opened to find something; a
 * section is one of the few floors in the building you have just opened, and collapsing
 * those as well would hide the thing that was being looked for behind a second click.
 */
function renderSection(section, onOpen) {
    const details = fastElement('details', 'file-panel-subcategory');
    details.dataset.subcategory = section.id;
    details.open = section.open ?? true;

    details.append(renderSummary(section.label, countEntries(section)));
    details.append(renderEntries(section.entries, onOpen));
    if (section.footer) details.append(renderFooter(section.footer));

    return details;
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

    // The run a heading belongs to is the one it starts, so categories arrive already in
    // the order they are to be shown -- a flow that interleaves its groups would get a
    // heading each time it changed back, which is what it asked for.
    let group = null;

    for (const category of categories) {
        if (category.group && category.group !== group) {
            group = category.group;

            const heading = fastElement('h6', 'file-panel-group');
            heading.textContent = group;
            list.append(heading);
        }

        const held = countEntries(category);

        const details = fastElement('details', 'file-panel-category');
        details.dataset.category = category.id;
        // Open by default so the contents are visible without hunting for them, unless
        // the flow says otherwise.
        details.open = category.open ?? held > 0;

        details.append(renderSummary(category.label, held));

        for (const section of category.sections ?? []) {
            details.append(renderSection(section, onOpen));
        }

        // A category that groups its content into sections has nothing of its own to
        // list; one that does not is a flat list of files and has no sections.
        if (category.entries?.length || !category.sections?.length) {
            details.append(renderEntries(category.entries, onOpen));
        }

        if (category.footer) details.append(renderFooter(category.footer));

        list.append(details);
    }
}
