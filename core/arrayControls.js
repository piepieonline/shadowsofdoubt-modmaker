/**
 * Adding, removing, copying and pasting an array's elements.
 *
 * Both flows had this on a `contextmenu` handler: right-click an array's label to be
 * asked whether to add, right-click an element's to be asked whether to remove.
 * Nothing on screen said so, so an array read as a fixed list unless you happened to
 * try it -- the same complaint core/valueEditors.js records about editing a DDS value.
 *
 * The buttons are those handlers said out loud, at the end of the line the array or the
 * element occupies. The right-click is kept, routed through the same actions, because it
 * is what anyone who found it already reaches for.
 *
 * Core owns the buttons, the clipboard and the patches. Each flow supplies the one
 * thing the two genuinely disagree about: what a *new* element of a given array is --
 * a prompt for a GUID in the DDS flow, a template built from the game's type layout in
 * the case flow.
 *
 * `jsonpatch` is a global from libs/JSON-Patch, loaded as a classic script.
 */
import { fastElement } from './dom.js';
import { getJSONPointer } from './jsonPointer.js';
import { requireModSelected } from './persistence.js';

/** The class the button row carries, so a re-decorated node can find its own. */
export const CONTROLS_CLASS = 'array-controls';

/**
 * What each button shows and says. `label` is the array's name, or -- for an element --
 * its index, which is what jsonTree labels it with.
 */
const BUTTONS = {
    add: {
        glyph: '+',
        title: (label) => `Add an element to "${label}"`,
    },
    remove: {
        glyph: '−',
        title: (label) => `Remove element ${label}`,
    },
    copy: {
        glyph: '⧉',
        title: (label, isArray) => isArray
            ? `Copy the whole of "${label}" as JSON`
            : `Copy element ${label} as JSON`,
    },
    paste: {
        // Not U+2398, the paste glyph proper: at the size these sit at it is two
        // squares inside each other, and so is the copy beside it. An arrow into a
        // slot is at least a different shape.
        glyph: '↧',
        title: (label, isArray) => isArray
            ? `Replace the whole of "${label}" with the array on the clipboard`
            : `Replace element ${label} with the JSON on the clipboard`,
    },
};

/**
 * Which buttons a node gets, in the order they are laid out.
 *
 * A node can be both: an array nested inside another array is an element of its parent
 * and an array in its own right, so it adds *and* removes. Its copy and paste are the
 * same operation read either way -- replacing that element is replacing that array --
 * so there is only ever one of each.
 *
 * @param isArray   the node is an array
 * @param isElement the node is an element of one
 * @param canAdd    a new element can actually be made for this array. The DDS flow has
 *                  arrays it holds no template for and the case flow has arrays whose
 *                  element type the layout does not describe; a + on those would be a
 *                  button that does nothing.
 * @param readOnly  the document cannot be edited. Copying out of one still can be.
 * @returns action names, keys of BUTTONS
 */
export function controlsFor({ isArray, isElement, canAdd = true, readOnly = false }) {
    if (!isArray && !isElement) return [];
    if (readOnly) return ['copy'];

    return [
        ...(isArray && canAdd ? ['add'] : []),
        ...(isElement ? ['remove'] : []),
        'copy',
        'paste',
    ];
}

/**
 * What the text on the clipboard means for the node it is being pasted onto.
 *
 * @param intoArray whether the target is the array itself, which is pasted whole
 * @returns `{ ok: true, value }`, or `{ ok: false }` with a `message` when there is
 *          something to say about why -- an empty clipboard is a no-op, not a fault
 */
export function interpretPaste(text, { intoArray }) {
    if (text == null || text.trim() === '') return { ok: false };

    let value;
    try {
        value = JSON.parse(text);
    } catch (error) {
        return {
            ok: false,
            message: `What is on the clipboard is not JSON, so there is nothing to `
                + `paste here:\n\n${error.message}`,
        };
    }

    // Copying an array gives back an array, so pasting onto one expects the same. A
    // single element on the clipboard is a paste onto an element, and saying which
    // beats replacing an array of ten with a value that is not a list at all.
    if (intoArray && !Array.isArray(value)) {
        return {
            ok: false,
            message: 'The clipboard holds a single element rather than a whole array. '
                + "Paste it onto one of the array's own elements to replace that element, "
                + 'or use + to add one.',
        };
    }

    return { ok: true, value };
}

/**
 * Put text on the clipboard, or hand it to the user when that is refused.
 *
 * `navigator.clipboard` needs a secure context and, in some settings, a permission the
 * user may not give. Failing silently would look exactly like a successful copy.
 */
async function writeClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        prompt('This could not be put on the clipboard. Copy it from here:', text);
    }
}

/**
 * Read the clipboard, falling back to asking for the text.
 *
 * Reading needs a permission Chrome asks for the first time; a denial, an insecure
 * context or an empty clipboard all end up at the same prompt rather than at nothing
 * happening.
 */
async function readClipboard(what) {
    try {
        const text = await navigator.clipboard.readText();
        if (text != null && text.trim() !== '') return text;
    } catch {
        // Denied, or no clipboard API at all. Ask instead.
    }

    return prompt(`Paste the JSON for ${what} here.`);
}

/**
 * Put the buttons on every array in a rendered tree, and on every element of one.
 *
 * Called from each flow's tree setup, which runs again on every rebuild -- so a node
 * that already carries a row gets a fresh one rather than a second.
 *
 * @param tree        the jsonTree instance
 * @param applyPatch  async (patch) => void -- the flow's edit loop
 * @param getDocument () => the document the tree is rendering, read at click time
 * @param serialize   (value) => string for the clipboard. The default is plain JSON;
 *                    the DDS flow strips the keys it adds for display.
 * @param addElement  async (item) => void -- appends a new element to `item`. Omitted
 *                    means no + at all.
 * @param canAdd      (item) => boolean, for arrays this flow cannot build an element of
 * @param readOnly    the document is not editable
 */
export function decorateArrayNodes(tree, {
    applyPatch,
    getDocument,
    serialize = (value) => JSON.stringify(value, null, 2),
    addElement = null,
    canAdd = () => true,
    readOnly = false,
}) {
    /** What the document holds at this node, which is what gets copied. */
    const valueOf = (item) => jsonpatch.getValueByPointer(getDocument(), getJSONPointer(item));

    tree.findAndHandle(
        (item) => item.type === 'array' || item.parent?.type === 'array',
        (item) => {
            const isArray = item.type === 'array';
            const actions = controlsFor({
                isArray,
                isElement: item.parent?.type === 'array',
                canAdd: isArray && Boolean(addElement) && canAdd(item),
                readOnly,
            });

            if (actions.length === 0) return;

            const handlers = {
                add: async () => {
                    if (!requireModSelected()) return;
                    await addElement(item);
                },
                remove: async () => {
                    if (!requireModSelected()) return;
                    if (!confirm(`Remove element ${item.label}?`)) return;
                    await applyPatch([{ op: 'remove', path: getJSONPointer(item) }]);
                },
                copy: () => writeClipboard(serialize(valueOf(item))),
                paste: async () => {
                    if (!requireModSelected()) return;

                    const what = isArray
                        ? `the whole of "${item.label}"`
                        : `element ${item.label}`;
                    const pasted = interpretPaste(
                        await readClipboard(what), { intoArray: isArray });

                    if (!pasted.ok) {
                        if (pasted.message) alert(pasted.message);
                        return;
                    }

                    // Replacing an element loses that element; replacing an array
                    // loses every element in it, which is worth asking about.
                    const existing = valueOf(item);
                    if (isArray && Array.isArray(existing) && existing.length > 0
                        && !confirm(
                            `Replace all ${existing.length} element(s) of `
                            + `"${item.label}" with the ${pasted.value.length} on the `
                            + 'clipboard?')) {
                        return;
                    }

                    await applyPatch([
                        { op: 'replace', path: getJSONPointer(item), value: pasted.value },
                    ]);
                },
            };

            if (!place(item, buildControls(actions, item.label, isArray, handlers))) return;

            // The right-click these buttons replace, kept for the people who know it:
            // the array's own label adds, an element's removes.
            const primary = actions.includes('add') ? 'add'
                : actions.includes('remove') ? 'remove'
                : null;

            // `:scope >` because a complex node's element contains its children's label
            // wrappers too, and a bare querySelector would find whichever came first.
            const labelEl = item.el.querySelector(
                ':scope > .jsontree_label-wrapper > .jsontree_label');

            if (primary && labelEl && !labelEl.dataset.arrayMenu) {
                labelEl.dataset.arrayMenu = primary;
                labelEl.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    handlers[primary]();
                });
            }
        }
    );
}

/**
 * Put the row at the end of the node's opening line.
 *
 * Which element that is depends on what the node holds. A simple node's line is
 * `"label" : value,` and ends after the separator, so the row goes at the end of the
 * value wrapper. A complex node's is `"label" : [`, with the child list below it and
 * the closing bracket under that -- so the row goes *before* the child list. After the
 * bracket that closes it would be the end of the line only while the node is collapsed;
 * expanded, it would be at the bottom of the whole array.
 *
 * @returns whether there was anywhere to put it. The root node has no wrapper, and is
 *          never one of these anyway.
 */
function place(item, row) {
    const wrapper = item.el.querySelector(':scope > .jsontree_value-wrapper');
    if (!wrapper) return false;

    // Re-decorating a node that already carries a row replaces it rather than adding a
    // second. Spelled out rather than searched for: a complex node contains every row
    // below it, and only these two are its own.
    wrapper.querySelector(
        `:scope > .${CONTROLS_CLASS}, :scope > .jsontree_value > .${CONTROLS_CLASS}`
    )?.remove();

    if (!item.isComplex) {
        wrapper.appendChild(row);
        return true;
    }

    const value = wrapper.querySelector(':scope > .jsontree_value');
    if (!value) return false;

    // insertBefore with a null reference appends, which is what an empty array wants.
    value.insertBefore(row, value.querySelector(':scope > .jsontree_child-nodes'));
    return true;
}

/** The row of buttons itself. */
function buildControls(actions, label, isArray, handlers) {
    const row = fastElement('span', CONTROLS_CLASS);

    for (const action of actions) {
        const { glyph, title } = BUTTONS[action];
        const button = fastElement('button', 'array-control');

        // Stated rather than left to default, which is `submit`: a tree is rendered
        // into whatever container a flow hands it, and one of those may be a form.
        button.type = 'button';
        button.dataset.action = action;
        button.innerText = glyph;
        button.title = title(label, isArray);
        button.setAttribute('aria-label', button.title);
        button.addEventListener('click', handlers[action]);

        row.appendChild(button);
    }

    return row;
}
