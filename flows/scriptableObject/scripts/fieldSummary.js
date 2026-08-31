/**
 * What every asset of a type puts in one field.
 *
 * The editor shows one document at a time, which leaves the question behind most authoring
 * decisions unanswered: what does the rest of the type do with this field? Which values are
 * common, which are legal in practice, and which assets are the odd ones worth reading.
 *
 * So this is two things -- a mode for saying which field, and a table of the answer.
 *
 * ## Picking, rather than choosing from a list
 *
 * A field is named by clicking it in a document that is open, because that is where an
 * author is when the question occurs to them. A list of a type's fields would be the same
 * information with the context taken away, and `MurderMO` has forty-odd of them.
 *
 * The click is caught in the **capture phase** on the row of documents. jsonTree binds its
 * own click on every label to expand and collapse it (see `libs/jsonTree/jsonTree.js`), and
 * a capture listener on an ancestor runs first -- so picking a field that happens to be an
 * object does not also open it up.
 *
 * What a label stands for is on the label: `data-summary-type` and `data-summary-path` are
 * written as the tree is built, by the same pass that writes the tooltips. See
 * `runTreeSetup` in ../index.js.
 */
import { resolveField } from '../../../core/typeHints.js';
import { summariseField, prettyPath } from './fieldValues.js';
import { scanType } from './assetScan.js';
import { modFileOfAsset } from './contentList.js';
// Cyclic -- index.js reaches this module through globals.js -- and safe for the same
// reason jsonTreeAdditions.js says: nothing here runs before a click.
import { loadFile, openBaseGameAsset } from '../index.js';

const TREES = '#trees';
const STRIP = '#field-summary-strip';
const MODAL = '#field-summary-modal';

/** How many assets a row lists before the rest are put behind a button. */
const NAMES_SHOWN = 8;

const el = (selector) => document.querySelector(selector);


/* -------------------------------------------------------------------------- */
/* The mode                                                                    */
/* -------------------------------------------------------------------------- */

let picking = false;

/**
 * Turn on picking, from the Tools menu.
 *
 * With no document open there is nothing to pick from, and the strip says so rather than
 * the menu item being dead: "nothing happened" is the one answer a menu should never give.
 */
export function startFieldSummary() {
    if (picking) return;
    picking = true;

    const trees = el(TREES);
    trees?.addEventListener('click', onPick, true);
    document.addEventListener('keydown', onKey);

    document.querySelector('.flow-container')?.setAttribute('data-picking-field', '');

    const strip = el(STRIP);
    if (strip) {
        el('#field-summary-strip-text').textContent = pickableFields()
            ? 'Click a field to see what every asset of its type puts in it. '
                + 'Ctrl-click, or ⌘-click, to open a node up instead.'
            : 'Open a ScriptableObject first — a field is picked from a document.';
        strip.hidden = false;
    }
}

/** Turn it off again, leaving the editor exactly as it was. */
export function cancelFieldSummary() {
    if (!picking) return;
    picking = false;

    el(TREES)?.removeEventListener('click', onPick, true);
    document.removeEventListener('keydown', onKey);

    document.querySelector('.flow-container')?.removeAttribute('data-picking-field');

    const strip = el(STRIP);
    if (strip) strip.hidden = true;
}

/** Whether anything on screen can be picked, which is what the strip's wording turns on. */
const pickableFields = () =>
    Boolean(document.querySelector(`${TREES} .jsontree_label[data-summary-path]`));

function onKey(event) {
    if (event.key === 'Escape') cancelFieldSummary();
}

function onPick(event) {
    // A field inside a folded node cannot be picked until the node is opened, and while
    // this mode is on a plain click picks rather than opens -- so the modified clicks are
    // left to jsonTree, whose own handlers they are. Ctrl or ⌘ opens the whole subtree,
    // which is the one that gets you to a field several levels down in a click; alt and
    // shift are its mark and its JSON path. See libs/jsonTree/jsonTree.js.
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

    const label = event.target.closest?.('.jsontree_label');

    // A label with no path is not a field of a game type -- the manifest window, or a key
    // this editor added to the document. Left alone rather than swallowed, so it still does
    // what it does the rest of the time.
    const path = label?.dataset.summaryPath;
    const type = label?.dataset.summaryType;
    if (!path || !type) return;

    event.preventDefault();
    event.stopPropagation();

    cancelFieldSummary();
    void summarise(type, path.split('.'));
}


/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

/** The scan on screen, so closing the dialog or picking again abandons the last one. */
let running = null;

export function closeFieldSummary() {
    running?.abort();
    running = null;
    el(MODAL)?.removeAttribute('open');
}

async function summarise(type, path) {
    running?.abort();
    const controller = new AbortController();
    running = controller;

    el('#field-summary-field').textContent = prettyPath(type, path, window.typeLayout);
    el('#field-summary-search').value = '';
    el('#field-summary-rows').replaceChildren();
    el('#field-summary-notes').replaceChildren();
    el('#field-summary-cancel').hidden = false;
    setStatus('Reading assets…');
    el(MODAL).setAttribute('open', '');

    const scan = await scanType(type, {
        signal: controller.signal,
        onProgress: ({ read, total }) => {
            if (controller.signal.aborted) return;
            setStatus(total ? `Read ${read} of ${total} ${type} assets…` : 'Reading assets…');
        },
    });

    if (controller.signal.aborted) return;
    running = null;
    el('#field-summary-cancel').hidden = true;

    // The one enum lookup: what the layout says the field is, and whether the game has a
    // set of names for it. Without this the table is a column of integers.
    const field = resolveField([type, ...path], window.typeLayout);
    const enumValues = field?.type ? window.enums?.[field.type] : null;

    const summary = summariseField(scan.records, path, { enumValues });

    renderStatus(type, scan, summary);
    renderNotes(type, scan);
    renderRows(type, summary);
}

function setStatus(text) {
    el('#field-summary-status').textContent = text;
}

function renderStatus(type, scan, summary) {
    const parts = [
        `${summary.rows.length} ${summary.rows.length === 1 ? 'value' : 'values'}`,
        `across ${scan.records.length} ${type} ${scan.records.length === 1 ? 'asset' : 'assets'}`,
    ];

    if (scan.modCount) parts.push(`${scan.modCount} from this mod`);

    // Only where it says something the count of assets does not: a field inside a list is
    // read once per element, so the two numbers part company exactly when it matters.
    if (summary.occurrences !== scan.records.length) {
        parts.push(`${summary.occurrences} values read in all`);
    }

    setStatus(parts.join(' · '));
}

/**
 * What the table could not see.
 *
 * Said plainly rather than left to be inferred from a number that looks low. Most of the
 * game's types are readable only with the author's own export connected, and a summary of
 * the nine that ship here would otherwise look like a summary of the type.
 */
function renderNotes(type, scan) {
    const notes = el('#field-summary-notes');
    const lines = [];

    if (scan.unreadable.length) {
        const names = scan.unreadable.slice(0, 3).map((entry) => entry.name).join(', ');
        const more = scan.unreadable.length > 3 ? `, and ${scan.unreadable.length - 3} more` : '';
        lines.push(`${scan.unreadable.length} could not be read (${names}${more}). `
            + `First reason: ${scan.unreadable[0].reason}`);
    }

    if (!window.dirHandleExportedSOPath && !window.onlineTypes?.includes(type)) {
        lines.push('This tool ships assets for nine types and this is not one of them — '
            + 'connect your exported ScriptableObjects folder under Folders to read the '
            + "game's own assets of it.");
    }

    if (scan.unlisted.length) {
        lines.push(`${scan.unlisted.length} of this mod's files are not named by its `
            + 'manifest, so the game would not load them and they are not counted.');
    }

    notes.replaceChildren(...lines.map((line) => {
        const small = document.createElement('small');
        small.textContent = line;
        return small;
    }));
}

function renderRows(type, summary) {
    const body = el('#field-summary-rows');

    body.replaceChildren(...summary.rows.map((row) => {
        const tr = document.createElement('tr');
        // What the search filters on: the value and every asset name behind it, so a name
        // finds the value it holds as readily as the other way round.
        tr.dataset.search = `${row.display} ${row.assets.map((entry) => entry.name).join(' ')}`
            .toLowerCase();

        tr.append(
            cell(valueCell(row), `field-summary-value field-summary-${row.kind}`),
            cell(String(row.count), 'field-summary-count'),
            cell(assetsCell(type, row), 'field-summary-assets'));

        return tr;
    }));

    if (!summary.rows.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 3;
        td.textContent = 'Nothing to summarise — no assets of this type could be read.';
        tr.appendChild(td);
        body.appendChild(tr);
    }
}

function cell(content, className) {
    const td = document.createElement('td');
    td.className = className;
    if (typeof content === 'string') td.textContent = content;
    else td.appendChild(content);
    return td;
}

function valueCell(row) {
    const span = document.createElement('span');
    span.textContent = row.display;
    // A whole object or list is as long as it is; the tooltip is the only place the rest
    // of it fits.
    if (row.kind === 'complex') span.title = row.display;
    return span;
}

/**
 * The assets carrying a value, as buttons that open them.
 *
 * Cut off after a few, because a value shared by four hundred assets would otherwise be a
 * page of names -- and the row is read for the value first. The rest are one click away
 * rather than a search away.
 */
function assetsCell(type, row) {
    const wrapper = document.createElement('div');
    const shown = row.assets.slice(0, NAMES_SHOWN);

    for (const asset of shown) wrapper.appendChild(assetButton(type, asset));

    if (row.assets.length > shown.length) {
        const more = document.createElement('button');
        more.className = 'field-summary-more secondary';
        more.textContent = `+${row.assets.length - shown.length} more`;
        more.addEventListener('click', () => {
            more.remove();
            for (const asset of row.assets.slice(NAMES_SHOWN)) {
                wrapper.appendChild(assetButton(type, asset));
            }
        });
        wrapper.appendChild(more);
    }

    return wrapper;
}

function assetButton(type, asset) {
    const button = document.createElement('button');
    button.className = 'field-summary-asset';
    button.textContent = asset.name;
    button.dataset.source = asset.source;
    button.title = asset.source === 'mod'
        ? `${asset.name} — this mod's own. Open it`
        : `${asset.name} — the base game's. Open it`;

    button.addEventListener('click', () => openAsset(type, asset));
    return button;
}

/**
 * Open what a row names, through the same two doors everything else in this flow uses.
 *
 * The mod's file is found in the folder listing rather than by building a name: a `REF:`
 * resolves against `presetName`, and a mod written by hand may call the file anything --
 * see `modFileOfAsset`.
 */
async function openAsset(type, asset) {
    if (asset.source === 'mod') {
        const file = modFileOfAsset(type, asset.name);
        if (file) {
            await loadFile(file.id, false, file.openAs ?? type, file.suffix);
            return;
        }
    }

    await openBaseGameAsset(type, asset.name);
}

/** Filter the rows on what has been typed, matching the value and the asset names alike. */
export function filterFieldSummary(query) {
    const wanted = String(query ?? '').trim().toLowerCase();

    for (const row of document.querySelectorAll('#field-summary-rows tr')) {
        row.classList.toggle('hidden', Boolean(wanted) && !row.dataset.search?.includes(wanted));
    }
}
