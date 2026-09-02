/**
 * The controls a value node is edited through.
 *
 * core/valueNodes.js decides *what* a node is; this builds the control that edits it.
 * Both flows render the same jsonTree and both replace a value's contents with a
 * control, but they had arrived at different controls for the same job: the case flow
 * put an inline input in the value, while the DDS flow left the value as text and hung
 * a `contextmenu` handler off it that opened a `window.prompt`. Nothing on screen said
 * so, so a DDS document read as uneditable unless you happened to right-click it.
 *
 * These are deliberately dumb: they build a control, seed it from what the value
 * already renders as, and hand the raw string back on commit. Deciding what that
 * string means -- JSON, a CSV line, an enum index -- is the flow's business, because
 * the flows genuinely disagree about it.
 */
import { fastElement } from './dom.js';
import { makeCSVSafe } from './strings.js';

/** Below this an empty or one-character value renders too small to click into. */
const MIN_INPUT_SIZE = 5;

/**
 * What a document should hold for the text typed into one of its fields.
 *
 * A field is edited as text and stored as JSON, and not every string survives the trip
 * -- an unescaped quote in a line of dialogue is enough, and so is anything at all in a
 * number or boolean field. That used to throw out of a blur handler: the edit vanished,
 * nothing said why, and the control went on showing a value the document did not have.
 *
 * So the text comes back, prefilled, until it parses or the caller's user gives up.
 *
 * @param raw      what was typed
 * @param isString whether the field holds a string, which is quoted on the way in
 * @returns `{ ok: true, value, raw }` -- `raw` is the accepted text, before quoting,
 *          which is how a caller tells a typed `null` from a parsed one -- or
 *          `{ ok: false }` if it was given up on
 */
export function parseEditedValue(raw, { isString }) {
    let text = raw;

    while (true) {
        // Typing `null` into a string field clears it rather than writing the word.
        const encoded = isString && text != 'null' ? makeCSVSafe(text) : text;

        try {
            return { ok: true, value: JSON.parse(encoded), raw: text };
        } catch (error) {
            const corrected = prompt(
                `This can't be stored as it is:\n\n${error.message}\n\n` +
                'Correct it, or cancel to put the field back the way it was.',
                text
            );

            if (corrected === null) return { ok: false };
            text = corrected;
        }
    }
}

/**
 * The ➥ affordance beside a value that points at another document.
 *
 * A bare input cannot be clicked through to what it names, so navigation moves out to
 * its own control rather than being a click on the text.
 *
 * `className` is a parameter only because the case flow's ScriptableObject references
 * have never carried `link-element`, and `#trees .link-element` is how both the tests
 * and a reader identify a link out to DDS content. Restyling those is its own change.
 */
export function createLinkButton(title, onClick, className = 'link-element') {
    // `open-target` sizes and places the glyph; the second class is what marks it as a
    // link out of this document.
    const button = fastElement('span', ['open-target', className].filter(Boolean).join(' '));
    button.innerText = '➥';
    if (title) button.title = title;
    button.addEventListener('click', onClick);
    return button;
}

/**
 * Show a value in a control, keeping it wide enough to read.
 *
 * Anything that puts a value into an input goes through here: setting `value` alone
 * leaves the control at the width of what it used to hold.
 */
export function setValue(input, value) {
    input.value = value;
    input.setAttribute('size', Math.max(String(value).length, MIN_INPUT_SIZE));
}

/**
 * An inline text input in place of the value, committed on blur.
 *
 * Seeded from the value's rendered text with quotes stripped, so a string is edited as
 * its contents rather than as its JSON encoding. `onCommit` only fires when the value
 * actually changed: tabbing through a document must not rewrite every field it passes.
 *
 * @param domNode  the `.jsontree_value` element to take over
 * @param link     `{ title, onClick }` for a ➥ button beside the input, or null
 * @param onCommit (rawValue) => void, called on blur with the input's text. Returning
 *                 false means it was not stored, and the control goes back to what it
 *                 was showing rather than a value the document does not have.
 */
export function createTextEditor(domNode, { readOnly = false, link = null } = {}, onCommit) {
    const input = document.createElement('input');
    const initialValue = domNode.innerText.replace(/"/g, '');

    input.readOnly = readOnly;
    setValue(input, initialValue);
    input.addEventListener('input', (e) => {
        e.target.setAttribute('size', Math.max(e.target.value.length, MIN_INPUT_SIZE));
    });

    domNode.replaceChildren(input);

    if (link) domNode.appendChild(createLinkButton(link.title, link.onClick));

    input.addEventListener('blur', async (e) => {
        if (initialValue === e.target.value) return;

        try {
            if (await onCommit(e.target.value) === false) {
                setValue(input, initialValue);
            }
        } catch (error) {
            // A commit that throws was an unhandled rejection: nothing stored, the
            // typed value still on screen as though it had been, and nothing said. The
            // control goes back to what the document holds, and the fault is reported.
            //
            // A thrown string is this codebase's idiom for "the user has already been
            // told" -- see assertModSelected -- so it is not reported twice.
            setValue(input, initialValue);
            if (typeof error !== 'string') alert(`This edit could not be stored:\n\n${error.message ?? error}`);
            throw error;
        }
    });

    return input;
}

/**
 * What a node currently holds, whichever editor is rendered over it.
 *
 * A decorated value is an input, and an input's contents are its `value`, not its
 * `innerText` -- reading the element gives an empty string. Anything reading a value
 * back out of the tree has to go through here, because whether a node has been
 * decorated yet depends on where in the setup pass the caller runs.
 */
export function renderedValue(item) {
    const valueEl = item.el.querySelector('.jsontree_value');
    if (!valueEl) return '';

    const input = valueEl.querySelector('input');

    // The input was seeded with the quotes already stripped.
    return input ? input.value : valueEl.innerText.replace(/^"|"$/g, '');
}

/**
 * A `<select>` in place of the value.
 *
 * Options are identified by their index in `options`, which is what both flows store:
 * the game serialises these fields as integers. `leadingOptions` are entries that come
 * before the list and mean something other than an index -- "Nothing (null)", or a
 * value the base game does not offer -- so they carry their own values.
 *
 * @param selectedValue the option value to preselect; compared loosely, since the
 *                      rendered value arrives as a string and indices are numbers
 * @param include       optional (index) => boolean, to offer part of the list. A field
 *                      can be an enum without every value of that enum being valid in it:
 *                      a vmail's `triggerPoint` is one of two of the eight `TriggerPoint`
 *                      values, and the other six are trees that never fire. Options keep
 *                      their index as their value, so leaving some out changes nothing
 *                      about what is stored.
 *
 *                      What the document already holds is always offered, whatever the
 *                      predicate says. A control that could not show its own file's value
 *                      would sit there displaying a different one, and the next edit
 *                      anywhere in the document would make that reading look deliberate.
 * @param onChange      (value) => void, called with the raw value of the chosen option
 * @returns `{ list, leading }` -- the element, and the leading options by value, so a
 *          caller can relabel one after the fact
 */
export function createSelectEditor(
    domNode,
    { options, selectedValue, readOnly = false, leadingOptions = [], include = null },
    onChange
) {
    const list = document.createElement('select');
    list.disabled = readOnly;
    domNode.replaceChildren(list);

    const leading = {};
    for (const { value, text } of leadingOptions) {
        const option = document.createElement('option');
        option.value = value;
        option.text = text;
        option.selected = value == selectedValue;
        list.appendChild(option);
        leading[value] = option;
    }

    for (let i = 0; i < options.length; i++) {
        if (include && !include(i) && i != selectedValue) continue;

        const option = document.createElement('option');
        option.value = i;
        option.text = options[i];
        option.selected = i == selectedValue;
        list.appendChild(option);
    }

    list.addEventListener('change', (e) => onChange(e.target.value));

    return { list, leading };
}
