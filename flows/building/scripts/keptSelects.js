/**
 * Searchable selects that survive the panel around them being rebuilt.
 *
 * Every panel in this flow is a full redraw -- `clear(container)` and then build it again
 * -- and `createPanels.refresh()` runs on every paint stroke, so the address list is torn
 * down and rebuilt each time the pointer is released on the floor. That is fine for a
 * `<span>`. It is not fine for a select2 control, for two reasons.
 *
 * **A destroyed control is not the same as a removed one.** While its dropdown is open
 * select2 binds a scroll handler to every scrollable ancestor, and unbinds them on close.
 * An instance whose `<select>` is taken out of the document without `destroy` being called
 * leaves those handlers bound to a container that was not rebuilt -- and `#building-panels`
 * is `overflow-y: auto`, so the symptom is that column becoming impossible to scroll for
 * the life of the page. See core/components/searchSelect/searchSelect.js.
 *
 * **Rebuilding one is not free.** A layout dropdown offers 602 names. Handing that to
 * select2 once per address row per stroke is a cost the furniture rows are built lazily to
 * avoid paying once.
 *
 * So the controls are kept and the rows around them are not. `furnitureChecker` in
 * panels.js does this by hand for its single control; this is the same idea for lists whose
 * length changes.
 *
 * ## What a caller owns
 *
 * A pool per list, not one shared: `sweep` destroys everything not acquired since the last
 * sweep, so an address panel and a room panel sharing a pool would each throw the other's
 * controls away. The key is whatever identifies a row within its own list -- a slot index
 * is enough, and is what both callers use.
 *
 * ## Why the control is wrapped
 *
 * select2 does not wrap the `<select>`; it hides it and inserts its own `<span>` beside it,
 * as a sibling. Moving the `<select>` alone into a freshly built row would therefore leave
 * the visible half of the control behind in the row that was discarded. The box this
 * returns holds both, so moving it moves the control.
 */
import { searchSelect } from '../../../core/components/searchSelect/searchSelect.js';

/**
 * A pool of controls, keyed by row.
 *
 * `build` is the seam the unit tests come in through: what it stands for is select2, which
 * needs a browser, a jQuery and a stylesheet. What is worth testing here is which controls
 * get built, reused and destroyed, and that is decided before `build` is ever called.
 *
 * `onClosed` is told whenever one of this pool's dropdowns shuts. It exists for the caller
 * that held a redraw back while one was open -- see `anyOpen` -- and has to be told when
 * it may go ahead.
 */
export function createSelectPool({ build = searchSelect, onClosed = () => {} } = {}) {
    const entries = new Map();
    let used = new Set();

    /**
     * The control for `key`, appended into `into` and pointed at `spec.value`.
     *
     * Reuse is decided by `spec.signature`, an array compared element by element: anything
     * that differs rebuilds the control from scratch. What belongs in it is everything
     * `build` is given once and cannot be told again -- the options, the dropdown's parent,
     * whether the control is disabled. What does *not* belong in it is the value, which is
     * the one thing a kept control can be re-pointed at.
     *
     * `onPick` is replaced on every acquire rather than closed over at build time. A
     * control outlives the render that built it, so a handler holding that render's `model`
     * and `index` would go on editing whichever floor happened to be open when select2 was
     * first applied.
     */
    function acquire(key, into, spec) {
        used.add(key);

        const existing = entries.get(key);

        if (existing && sameSignature(existing.signature, spec.signature)) {
            existing.onPick = spec.onPick;

            // Re-appending an element that is already somewhere moves it; it does not
            // rebuild it. This is what carries the control into the row just built.
            into.appendChild(existing.box);
            existing.control.setValue(spec.value);

            return existing.box;
        }

        // Before the element goes, not after. See the note at the top of this file.
        discard(existing);

        const box = document.createElement('span');
        box.className = spec.class ?? 'kept-select';

        const select = document.createElement('select');
        if (spec.title) select.title = spec.title;
        if (spec.disabled) select.disabled = true;

        box.appendChild(select);

        // In the document before select2 is applied: it measures the element, and one that
        // is detached opens at zero width.
        into.appendChild(box);

        const entry = { box, select, signature: spec.signature, onPick: spec.onPick };

        entry.control = build(select, {
            parent: spec.parent,
            groups: spec.groups ?? null,
            options: spec.options ?? null,
            value: spec.value,
            placeholder: spec.placeholder ?? '',
            dropdownClass: spec.dropdownClass ?? '',
            alignRight: spec.alignRight ?? false,
            onChange: (value) => entry.onPick?.(value),
            onClose: () => onClosed(),
        });

        entries.set(key, entry);
        return box;
    }

    /**
     * Destroy every control not acquired since the last sweep.
     *
     * Called at the end of a render, once, rather than per removal: a row is not removed so
     * much as simply not built again, and the list has no idea which keys the render it just
     * finished decided against.
     */
    function sweep() {
        for (const [key, entry] of entries) {
            if (used.has(key)) continue;

            discard(entry);
            entries.delete(key);
        }

        used = new Set();
    }

    /**
     * Shut any dropdown that is open, **before the panel clears its container**.
     *
     * This is not tidiness, it is the one thing that keeps the column scrollable. While a
     * dropdown is open select2 holds a `scroll` handler on every scrollable ancestor that
     * puts the scroll position back, and it finds them again to unbind by walking the
     * control's ancestors -- so a control that is detached, or destroyed outright, never
     * unbinds, and `#building-panels` stops scrolling for the life of the page. See
     * `close` in searchSelect.js.
     *
     * `discard` closes too, but by then it is usually too late: a render clears its
     * container first, and everything in the pool is detached before a single control is
     * rebuilt. So this has to be called while the panel is still standing.
     *
     * Closing a dropdown the user had open is the cost. It is the right one -- the list
     * under it is about to be rebuilt, and a dropdown left open over a control that has
     * been replaced is showing choices for something that is no longer there.
     */
    function closeAll() {
        for (const entry of entries.values()) entry.control?.close();
    }

    /**
     * Whether one of this pool's dropdowns is showing.
     *
     * For the caller to ask before a redraw. `closeAll` is what a redraw has to do and is
     * not something to do to somebody mid-choice: the list is under the pointer, the
     * search box has what they typed in it, and the redraw that shut it was almost always
     * about something else entirely -- an autosave landing, most often.
     *
     * `?.` on the control as well as the entry: `build` is a seam, and a caller's stand-in
     * need not answer a question the real one does.
     */
    function anyOpen() {
        for (const entry of entries.values()) if (entry.control?.isOpen?.()) return true;
        return false;
    }

    /**
     * Destroy the lot.
     *
     * For the flow being switched away from, which has its markup replaced: the dropdowns
     * are parented to an element of that markup, so a control kept across the switch would
     * open into a box that is no longer on the page.
     */
    function clear() {
        closeAll();

        for (const entry of entries.values()) discard(entry);

        entries.clear();
        used = new Set();
    }

    return { acquire, sweep, clear, closeAll, anyOpen };
}

function discard(entry) {
    if (!entry) return;

    // Before destroying, which does not close on the caller's behalf. Worth doing even
    // though `closeAll` should already have run: this is the last point at which anything
    // can, and the failure it prevents is silent and unrecoverable.
    entry.control?.close();
    entry.control?.destroy();
    entry.box.remove();
}

/** Element by element and by identity: a signature holds objects as often as strings. */
function sameSignature(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    return a.every((value, index) => Object.is(value, b[index]));
}
