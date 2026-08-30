/**
 * A `<select>` you can search, and optionally type a value into that is not on it.
 *
 * The case flow's ScriptableObject reference fields have been this control for a long
 * time -- `copyFrom` is the one everybody meets first -- and the building flow's furniture
 * checker needs the same thing, so it lives here rather than in either flow. What it wraps
 * is select2, loaded globally by index.html.
 *
 * ## Why a wrapper rather than a call to select2
 *
 * Three reasons, all of them things a second caller would otherwise have to rediscover.
 *
 * **The dropdown has to be re-parented.** select2 appends its dropdown next to the control
 * by default, which puts it inside whatever is scrolling -- the building flow's status
 * column is `overflow-y: auto`, and a native `<datalist>` there rendered sideways off the
 * column. `dropdownParent` is not an optimisation, it is what makes the control usable
 * inside a scrolling panel, so it is a required argument rather than an option.
 *
 * **It has to be closed before whatever redraws.** While its dropdown is open select2
 * binds a scroll handler to every scrollable ancestor that puts the scroll position back
 * where it was -- that is how it keeps the document still under an open dropdown -- and
 * unbinds them when it closes. A caller that rebuilds its DOM on change takes the
 * `<select>` away before select2 gets that far, and the handler is left bound to a
 * container that was not rebuilt: every attempt to scroll is then snapped back, for as
 * long as the page lives. Closing first is done here so neither caller can forget it.
 *
 * **jQuery stays in one file.** Everything else in `core/` is a module against the DOM.
 * index.html:16 says dropping select2 is the aim, and when that happens this is the file
 * that changes.
 *
 * ## What a caller in a scrolling panel has to do
 *
 * Give that panel a `position` of its own. select2 keeps the original `<select>` in the
 * document and hides it with `.select2-hidden-accessible`, which is `position: absolute`
 * with no offsets, and moves focus to it when the dropdown opens. With nothing positioned
 * between it and the page, the page is its containing block: it holds the place the
 * panel's unscrolled flow gave it, ignores the panel's scrolling and its clipping, and
 * ends up far from the control -- so opening the dropdown scrolls the whole page to a
 * one-pixel element nobody can see. `flows/building/style.css` has the long version.
 *
 * ## Sections
 *
 * `groups` renders as `<optgroup>`s in the order given, which is how a caller separates a
 * mod's own assets from the base game's. select2 scrolls the whole results list, headings
 * included, so sections cost nothing beyond saying which is which.
 */

/** Wraps the free-text value a caller allowed, so it cannot collide with a real option. */
const CUSTOM_PREFIX = 'custom:';

/**
 * The jQuery event namespace every handler here is bound under, so `destroy` can take
 * them all off in one go without touching handlers a caller bound itself.
 */
const NAMESPACE = 'searchSelect';

/**
 * Turn a `<select>` into a searchable one.
 *
 * The element is the source of truth throughout: options are written to it, and the value
 * is read off it. select2 mirrors it, so anything already reading `select.value` -- the
 * case flow does -- goes on working.
 *
 * @param select       the `<select>` to take over. Already in the document: select2
 *                     measures it, and one that is detached opens at zero width.
 * @param parent       what to append the dropdown to. Must not be inside anything that
 *                     scrolls independently of the control -- see above. Defaults to
 *                     `document.body`, which satisfies that by construction; a caller
 *                     names something closer only to keep the dropdown inside a stacking
 *                     or theming context of its own. A missing element falls back to the
 *                     body rather than throwing: a dropdown in the wrong parent is a
 *                     cosmetic fault, and taking the panel down with it is not.
 * @param groups       `[{ label, options }]`, rendered as `<optgroup>`s in order. An
 *                     `option` is `{ value, text }`, or a bare string used as both. A
 *                     group with no options is skipped rather than rendered empty.
 * @param options      a flat list, for a caller with no sections. Rendered before
 *                     `groups`, so leading entries that mean something other than a
 *                     choice -- "Nothing (null)" -- come first.
 *
 *                     Give neither and whatever the element already holds is left alone.
 *                     The case flow builds its options through `createSelectEditor`,
 *                     where an option's value is its index and two leading entries mean
 *                     something else entirely; rewriting them here would be this control
 *                     deciding something that is not its business.
 * @param value        what to preselect, compared loosely: an option value arrives as a
 *                     string from the DOM and callers hold indices as numbers.
 * @param allowCustom  whether a value not on the list can be typed. Off by default,
 *                     because for most fields it would be a typo; the furniture checker
 *                     turns it on, where answering a name the data does not have is the
 *                     point rather than a hazard.
 * @param allowClear   whether the selection can be taken back off again, by an `×` in the
 *                     control. Off by default: for a field that has to hold something,
 *                     emptying it is not a state the caller wants back, and the way to
 *                     change a value is to pick another. Turn it on where nothing selected
 *                     means something in its own right rather than nothing chosen yet.
 *                     Needs `placeholder`, which is what the control shows once cleared.
 * @param placeholder  shown when nothing is selected.
 * @param alignRight   line the dropdown's right edge up with the control's, rather than
 *                     its left. For a control near the right of the window opening a
 *                     dropdown wider than itself: select2 anchors the left edge, so a
 *                     26rem list opened from a 16rem control in a right-hand column runs
 *                     off the side of the window. Measured on open rather than declared
 *                     in CSS, because the overhang is the difference between two widths
 *                     and the control's is whatever its column leaves it.
 * @param dropdownClass a class for the dropdown. The dropdown is parented away from the
 *                     control -- that is the point of `parent` -- so it inherits type and
 *                     colour from wherever it landed rather than from the panel it
 *                     belongs to, and a caller whose panel is not sized like the rest of
 *                     the page has no other way to reach it.
 * @param minSearchLength
 *                     how much has to be typed before the list answers at all. Zero, the
 *                     default, is a list that shows everything the moment it opens.
 *
 *                     This is a cost control, not a nicety. select2 renders every matching
 *                     row into the DOM at once -- there is no virtual scrolling -- so a
 *                     list of thousands of options is thousands of elements built on open
 *                     and rebuilt on every keystroke that widens the match. A minimum makes
 *                     the empty search, which is the one the list opens on, match nothing.
 * @param tooShortMessage
 *                     what to show in place of results until `minSearchLength` is reached.
 *                     select2's own wording counts down the characters remaining; a caller
 *                     that set a minimum usually has something better to say about why.
 * @param onChange     (value) => void. Fires after the dropdown is closed, so a handler
 *                     is free to rebuild the DOM this control is in.
 * @param onClose      () => void. Fires whenever the dropdown closes, however it closed:
 *                     picked from, dismissed, or shut by the caller. For a caller that
 *                     put something off while the list was open -- see `isOpen` -- this
 *                     is when to do it.
 * @returns `{ setValue, isOpen, close, destroy }`.
 *
 *          `setValue` shows a value the caller already had on the list, without reporting
 *          it as a choice -- see the note on it below. It is what a control kept across a
 *          redraw needs to be pointed at whatever the redraw is about.
 *
 *          `destroy` takes select2 off again, leaving the plain `<select>`. A caller that
 *          throws its DOM away need not call it; one that reuses the element must, or
 *          select2 refuses to re-apply.
 */
export function searchSelect(select, {
    parent,
    groups = null,
    options = null,
    value = null,
    allowCustom = false,
    allowClear = false,
    placeholder = '',
    dropdownClass = '',
    alignRight = false,
    minSearchLength = 0,
    tooShortMessage = null,
    onChange = () => {},
    onClose = () => {},
} = {}) {
    if (groups || options) {
        setOptions(select, {
            groups: groups ?? [], options: options ?? [], value, allowCustom,
        });
    }

    const $select = window.jQuery(select);

    $select.select2({
        dropdownParent: window.jQuery(parent ?? document.body),
        dropdownCssClass: dropdownClass,
        placeholder,

        // select2 warns and does nothing without a placeholder to fall back to, so the
        // two travel together rather than leaving that to be found out.
        allowClear: allowClear && Boolean(placeholder),

        width: '100%',

        // Zero is select2's own default and it skips the decorator entirely for it, so
        // this costs a control that wants no minimum nothing.
        minimumInputLength: minSearchLength,

        // A `language` given as an object is a partial language pack: select2 puts it
        // ahead of English and falls back through to it for every key not named here, so
        // this replaces the one message without restating the other eight.
        ...(tooShortMessage ? { language: { inputTooShort: () => tooShortMessage } } : {}),

        // "Tags" is select2's word for free text. `createTag` says what a typed term is
        // worth offering as; select2 itself then drops the offer when an option already
        // matches the term exactly, so typing a name that is on the list picks the real
        // option rather than a duplicate of it.
        //
        // The key is only present when it is wanted: select2 merges these over its own
        // defaults, and an explicit `undefined` would overwrite one rather than leave it.
        ...(allowCustom ? {
            tags: true,
            createTag: (params) => {
                const text = params.term.trim();
                return text ? { id: CUSTOM_PREFIX + text, text } : null;
            },
        } : {}),
    });

    // Namespaced so `destroy` can take it off again. `select2('destroy')` unbinds
    // select2's own handlers and nothing else, so a plain `change` handler here outlived
    // every rebuild: a caller that destroys and re-applies the control -- the asset
    // explorer does it each time the type changes -- ended up with one handler per
    // rebuild, each closed over the arguments it was built with. Picking a value then ran
    // all of them, oldest first, and the stale ones acted on what the control used to be
    // about.
    //
    // Not `change.select2`: that is the namespace `setValue` triggers to redraw the
    // control without calling it a choice, and answering it here would report an edit
    // nobody made. A user's selection fires an unnamespaced `change`, which jQuery
    // delivers to both.
    $select.on(`change.${NAMESPACE}`, () => {
        // Before the handler, which is free to rebuild everything -- see the note above.
        $select.select2('close');

        onChange(readValue(select, allowCustom));
    });

    if (alignRight) $select.on(`select2:open.${NAMESPACE}`, () => alignDropdownRight($select));

    /*
     * Whether the list is showing, tracked rather than asked for.
     *
     * select2 knows, but only through the instance object hung off the element's jQuery
     * data -- reaching into that is reaching past the wrapper this file exists to be. The
     * two events it fires say the same thing and are part of its documented surface.
     *
     * `select2:close` does not fire for a control that was not open, so a caller cannot
     * be woken by a `close()` that did nothing.
     */
    let showing = false;

    $select.on(`select2:open.${NAMESPACE}`, () => { showing = true; });

    $select.on(`select2:close.${NAMESPACE}`, () => {
        showing = false;
        onClose();
    });

    /*
     * Clearing empties the control and stops there.
     *
     * select2's own clear ends by toggling the dropdown open, on the assumption that
     * clearing is the first half of picking something else. For a control that allows it
     * that assumption is backwards: `allowClear` is turned on where empty means something
     * in its own right, so what clearing is followed by is whatever that meaning enables --
     * and a list reopening over it is in the way of exactly the thing just asked for.
     *
     * `select2:opening` is preventable and `select2:clear` fires earlier in the same
     * handler, so the flag only has to survive the rest of it. The timeout takes it back
     * down whether or not an open followed, because the next one is the user's.
     */
    if (allowClear) {
        let clearing = false;

        $select.on(`select2:clear.${NAMESPACE}`, () => {
            clearing = true;
            setTimeout(() => { clearing = false; });
        });

        $select.on(`select2:opening.${NAMESPACE}`, (event) => {
            if (clearing) event.preventDefault();
        });
    }

    return {
        /**
         * Show a value, without calling it a choice.
         *
         * select2 mirrors the `<select>` rather than watching it, so writing `select.value`
         * alone changes what the element holds and leaves the control rendering the old
         * name. The redraw it needs is a `change` -- which is also what a user picking
         * something fires, and firing the caller's `onChange` here would report an edit
         * nobody made.
         *
         * The namespace is what separates the two. select2 binds its own handler as
         * `change.select2`; the handler above is bound plain, and jQuery delivers a
         * namespaced trigger only to handlers in that namespace. So this reaches select2
         * and stops there.
         *
         * A value no option carries leaves the element empty, as it would on a plain
         * `<select>`. Callers keep whatever is not on the list on it -- see `allowCustom`,
         * and the leading `options` a caller can pass for the same purpose.
         */
        setValue: (next) => {
            const wanted = next ?? '';
            if (select.value === wanted) return;

            select.value = wanted;
            $select.trigger('change.select2');
        },

        /**
         * Whether the list is showing.
         *
         * For a caller with something it would rather not do while a choice is being
         * made -- a redraw that would take this control out of the document, most of
         * all. `onClose` is the other half of that: it says when the moment has passed.
         */
        isOpen: () => showing,

        /**
         * Shut the dropdown, if it is open.
         *
         * **Call this before taking the control out of the document, and before
         * destroying it.** While the dropdown is open select2 has a `scroll` handler on
         * every scrollable ancestor that puts the scroll position back -- that is how it
         * keeps the page still underneath -- and it unbinds them on close by walking the
         * control's ancestors again. Two ways that walk finds nothing:
         *
         * - `select2('destroy')` does not close first, so destroying an open control
         *   never runs the unbind at all.
         * - the walk is `parents()`, so a control already detached has none, and the
         *   handler stays bound to a column that was not rebuilt.
         *
         * Either leaves that column impossible to scroll for the life of the page, which
         * is the one failure here with no visible cause and no way back short of a
         * reload. `destroy` cannot do it on the caller's behalf, because by then it is
         * usually too late -- a panel clears its container before it rebuilds.
         */
        close: () => {
            try { $select.select2('close'); } catch { /* not applied, or already gone */ }
        },

        destroy: () => {
            // `select2('destroy')` on an element that never had it, or has already been
            // destroyed, throws. A caller cleaning up twice is not an error worth raising.
            try { $select.select2('destroy'); } catch { /* already gone */ }

            // select2's destroy leaves this one bound, because it is not select2's. A
            // caller that re-applies the control to the same element would otherwise
            // keep the handler this one installed -- see where it is bound.
            $select.off(`.${NAMESPACE}`);
        },
    };
}

/**
 * Put the dropdown's right edge where the control's is.
 *
 * select2 positions the dropdown by writing an absolute `left` onto a wrapper anchored at
 * the control's left edge, and recomputes it whenever anything scrolls. So the shift is a
 * margin on the dropdown inside that wrapper rather than a change to `left`: the two
 * compose, and select2 goes on repositioning without this having to follow it.
 *
 * Measured per open. The overhang is the dropdown's width less the control's, and the
 * control's is whatever the column and the label beside it leave -- which differs between
 * the three pickers and again whenever the window is resized.
 *
 * Never shifted right: a dropdown narrower than its control is already inside it, and
 * moving it out to the right edge would leave it hanging off a control it belongs to.
 */
function alignDropdownRight($select) {
    const api = $select.data('select2');

    // The wrapper select2 positions, and the dropdown inside it that carries the width.
    const wrapper = api?.$dropdown?.[0];
    const dropdown = wrapper?.querySelector('.select2-dropdown') ?? wrapper;
    const control = api?.$container?.[0];

    if (!dropdown || !control) return;

    const overhang = dropdown.offsetWidth - control.offsetWidth;
    dropdown.style.marginInlineStart = overhang > 0 ? `${-overhang}px` : '';
}

/**
 * What the control holds, with the wrapper taken off anything typed.
 *
 * A caller that allowed free text gets back what was typed, not the internal id -- it
 * asked for a name, and the name is what it should be handed.
 */
function readValue(select, allowCustom) {
    const raw = select.value;
    if (allowCustom && raw?.startsWith(CUSTOM_PREFIX)) return raw.slice(CUSTOM_PREFIX.length);
    return raw;
}

/**
 * Fill the `<select>`, flat entries first and then a group each.
 *
 * A value that is not on the list becomes an option of its own when free text is allowed,
 * because a control cannot show what it does not hold: without this, reopening a panel
 * whose field held a typed name would silently show the first option instead.
 */
function setOptions(select, { groups, options, value, allowCustom }) {
    select.replaceChildren();

    /*
     * An empty option, first, for "nothing chosen yet".
     *
     * A `<select>` with no option marked selected selects its first one, so without this
     * the control opens claiming whatever happens to sort first -- a mod's own preset, as
     * it turned out, since those are offered before the base game's. Nothing had been
     * asked, the panel below it was blank, and choosing that same entry by hand fired no
     * `change` at all, because it was already the value.
     *
     * It is also what select2 requires before it will show a placeholder on a single
     * select, so the two are the same fix.
     */
    const empty = document.createElement('option');
    empty.value = '';
    select.appendChild(empty);

    let matched = false;
    const add = (into, entry) => {
        const { value: optionValue, text } = normalise(entry);
        const option = document.createElement('option');
        option.value = optionValue;
        option.text = text;

        // Loose, because indices are held as numbers and read back as strings.
        if (value !== null && optionValue == value) {
            option.selected = true;
            matched = true;
        }

        into.appendChild(option);
    };

    for (const entry of options) add(select, entry);

    for (const { label, options: entries = [] } of groups) {
        if (!entries.length) continue;

        const group = document.createElement('optgroup');
        group.label = label;
        for (const entry of entries) add(group, entry);
        select.appendChild(group);
    }

    if (!matched && allowCustom && value) {
        const option = document.createElement('option');
        option.value = CUSTOM_PREFIX + value;
        option.text = value;
        option.selected = true;
        empty.after(option);
        matched = true;
    }

    // Explicit, rather than left to the browser's "first option wins" -- which is what
    // the empty option above exists to make harmless, and this is what makes it chosen.
    if (!matched) empty.selected = true;
}

/** An entry is a `{ value, text }` pair, or a string that is both. */
function normalise(entry) {
    if (typeof entry === 'string') return { value: entry, text: entry };
    return { value: entry.value, text: entry.text ?? entry.value };
}
