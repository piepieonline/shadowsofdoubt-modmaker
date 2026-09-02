/**
 * The step rail the room and furniture creators share.
 *
 * Both modals used to be one tall column of `<details>`: a dozen controls, three lists and
 * a file plan, stacked, with the thing that answers the author's question a scroll away
 * from the thing that changes it. Opening a section pushed the rest down, so the pane never
 * held still, and the two questions that matter -- what does this admit, and what is about
 * to be written -- were the two furthest from the top.
 *
 * So the same content is dealt out one step at a time, wide instead of tall. The rail on
 * the left is the whole shape of the job at a glance and the way about it; the pane in the
 * middle is one step's worth, laid out for the width it now has; the footer carries the
 * note for the step being read and the button that writes.
 *
 * ## What this module owns, and what it does not
 *
 * It owns which step is showing and the chrome around it. It owns *nothing* about what a
 * step says -- the hint beside a rail label, the note in the footer and the wording on the
 * primary button all come from the flow, which is the only thing that knows whether nine
 * sub-objects have been read or three files are about to be written.
 *
 * The steps themselves are declared in the markup rather than passed in, as
 * `.creator-pane[data-step][data-step-label]`. The rail is then a reading of the panes, and
 * a step that exists in one and not the other cannot happen.
 */

/**
 * Wire the rail, the panes and the footer of one creator modal together.
 *
 * Returns null when the markup is not there, the way the panes themselves return early:
 * these modules are imported by a flow whose dialogs may not have been stamped out yet.
 *
 * `onShow` fires on every `show`, including the one that lands on the step already open.
 * That is deliberate -- the furniture creator moves its 3D view into whichever pane is
 * showing and remeasures it, and a canvas measured while its container was hidden comes
 * out 1px tall and stays that way.
 */
export function createStepper(root, { onShow } = {}) {
    const dialog = typeof root === 'string' ? document.querySelector(root) : root;
    if (!dialog) return null;

    const panes = [...dialog.querySelectorAll('.creator-pane')];
    const rail = dialog.querySelector('.creator-steps');
    if (!panes.length || !rail) return null;

    const railNote = dialog.querySelector('.creator-rail-note');
    const footNote = dialog.querySelector('.creator-foot-note');
    const back = dialog.querySelector('.creator-back');
    const next = dialog.querySelector('.creator-next');

    const steps = panes.map((pane) => ({
        key: pane.dataset.step,
        label: pane.dataset.stepLabel ?? pane.dataset.step,
        pane,
    }));

    /** Per-step `{ hint, note }`, as the flow last said it. */
    let detail = {};
    let at = 0;

    // Built once and repainted, rather than replaced on every redraw. These are the only
    // buttons in either modal that are pressed while something else is being read, and a
    // rail rebuilt under the pointer loses the press that was landing on it.
    const buttons = steps.map((step, index) => {
        const button = document.createElement('button');
        const label = document.createElement('span');
        const dot = document.createElement('span');
        const hint = document.createElement('small');

        button.type = 'button';
        button.className = 'creator-step';
        dot.className = 'creator-step-dot';
        label.className = 'creator-step-label';
        hint.className = 'creator-step-hint';

        label.textContent = step.label;
        button.append(dot, label, hint);
        button.addEventListener('click', () => show(step.key));

        step.hintNode = hint;
        step.index = index;
        return button;
    });

    rail.replaceChildren(...buttons);

    /**
     * Put the chrome where the state says it is.
     *
     * The dot carries how far along the step is -- ahead, here, or behind -- which is the
     * one thing the rail says that the labels do not. It is an attribute rather than a
     * class so the CSS reads as the three states it is.
     */
    function paint() {
        for (const step of steps) {
            const here = step.index === at;

            buttons[step.index].setAttribute('aria-current', here ? 'step' : 'false');
            buttons[step.index].firstChild.dataset.at = here ? 'here' : step.index < at ? 'behind' : 'ahead';
            step.hintNode.textContent = detail[step.key]?.hint ?? '';
            step.hintNode.hidden = !step.hintNode.textContent;

            // `hidden` rather than a class: a pane that is not showing should be out of
            // the tab order as well as off the screen, and the attribute does both.
            step.pane.hidden = !here;
        }

        if (footNote) footNote.textContent = detail[steps[at].key]?.note ?? '';
        if (back) back.disabled = at === 0;
        if (next) next.disabled = at === steps.length - 1;
    }

    /** Show one step by key. Unknown keys are ignored rather than clearing the pane. */
    function show(key) {
        const found = steps.findIndex((step) => step.key === key);
        if (found >= 0) at = found;

        paint();
        onShow?.(steps[at].key);
    }

    const step = (by) => show(steps[Math.min(Math.max(at + by, 0), steps.length - 1)].key);

    if (back) back.addEventListener('click', () => step(-1));
    if (next) next.addEventListener('click', () => step(1));

    paint();

    return {
        /** Which step is showing. */
        key: () => steps[at].key,

        show,
        next: () => step(1),
        back: () => step(-1),

        /**
         * The hints and footer notes, as the flow last worked them out.
         *
         * Merged rather than replaced, so a flow that knows the answer for one step need
         * not restate the other five. Painting from here rather than from a redraw of the
         * rail keeps the buttons themselves alive -- see the note above.
         */
        update(next) {
            detail = { ...detail, ...next };
            paint();
        },

        /** The line under the rail: what is true of the whole job, not of one step. */
        say(text) {
            if (railNote) railNote.textContent = text ?? '';
        },
    };
}
