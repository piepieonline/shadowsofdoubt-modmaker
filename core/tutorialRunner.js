/**
 * Running a tutorial.
 *
 * driver.js draws the cutout and the popover. What it does not do is wait: its own
 * flow is Next-button driven, which suits a feature tour and is wrong for a walkthrough
 * that builds a real mod. Every step here depends on the one before having actually
 * happened, so a Next button lets you arrive at "name the murder file" with no file
 * open and nothing to point at.
 *
 * So a step names a condition, and its Next button stays locked until the app satisfies
 * it: the walkthrough will not run ahead of the mod being built, and the player still
 * decides when to move on. A step whose doing is the whole of it can say `autoAdvance`
 * and carry itself, which is what keeps a run of small edits from being a run of button
 * presses. The conditions live in a table here rather than in the tutorial, so a tutorial
 * stays data: see CONDITIONS.
 */
import { onSelectionChanged, currentModName } from './modSelection.js';
import { switchFlow } from './navigation.js';
import { probeFile, readFileContent } from './fs.js';

// Loaded only once a tutorial starts. Nobody pays for it just by loading the app, which
// is why the module is a dynamic import rather than a static one -- the bundler splits it
// into a chunk of its own and fetches it on first use.
//
// The stylesheet is asked for by URL rather than imported, because it is added and removed
// with the walkthrough rather than living for the life of the page. `?url` gives the
// hashed path the build emits.
import DRIVER_CSS from 'driver.js/dist/driver.css?url';

let driverModule = null;

async function loadDriver() {
    if (!document.querySelector(`link[href="${DRIVER_CSS}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = DRIVER_CSS;
        document.head.appendChild(link);
    }

    driverModule ??= await import('driver.js');
    return driverModule.driver;
}

/**
 * What a step can wait for; `advanceWhen` names one of these.
 *
 * Each is a predicate plus a way of being told it might now be true. The app's own
 * listeners are used where they exist, because they fire exactly when the thing
 * happened. Everything else falls back to watching the DOM.
 */
const CONDITIONS = {
    'mod-chosen': {
        satisfied: () => currentModName() !== null,
        subscribe: onSelectionChanged,
    },
    'content-chosen': {
        // Both dropdowns: a mod alone does not say what is being edited.
        satisfied: () => Boolean(window.selectedMod),
        subscribe: onSelectionChanged,
    },
};

function watchDom(fn) {
    const observer = new MutationObserver(fn);
    // From the root rather than the body: switching editors is announced by an
    // attribute on <html>. Attributes at all because a dialog opens by gaining `open`,
    // which is no tree change.
    observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
    });
    return () => observer.disconnect();
}

const isVisible = (selector) => {
    const element = document.querySelector(selector);
    return Boolean(element?.checkVisibility());
};

/** The window a file is open in. Both flows tag one with the path it came from. */
const fileWindow = (path) => document.querySelector(`.file-window[path="${path}"]`);

/**
 * The window a step is talking about.
 *
 * `file` names it by the path it was opened from, which is how the case editor's
 * windows are told apart. The DDS editor's are not: they are levels of a drill-down at
 * fixed ids, and their paths are GUIDs nobody can write down in advance, so a step
 * there names the window by selector instead.
 */
function scopeFor({ file, window: selector }) {
    if (selector) return document.querySelector(selector);
    return file ? fileWindow(file) : null;
}

/** The key a row is labelled with, quotes and all -- jsonTree renders `"messages"`. */
const rowLabel = (row) =>
    row.querySelector(':scope > .jsontree_label-wrapper > .jsontree_label')?.textContent.trim();

/**
 * A row's own value, as opposed to anything nested below it.
 *
 * Simple and complex nodes agree on this much of the markup, so one selector reaches
 * both. Only a simple node ends up with an editor inside it -- see decorateValueNodes --
 * which is what makes reading a value through here safe: a step naming a whole object
 * finds no input rather than the first input belonging to something inside it.
 */
const rowValue = (row) => row.querySelector(':scope > .jsontree_value-wrapper > .jsontree_value');

/** The rows of a document, which hang off the root node's list. */
const documentRows = (scope) => [...(scope?.querySelector('.jsontree_child-nodes')?.children ?? [])];

/** The rows one level inside another, which hang off its value. See _NodeComplex. */
const nestedRows = (row) =>
    [...(rowValue(row)?.querySelector(':scope > .jsontree_child-nodes')?.children ?? [])];

/**
 * The row a field is edited on.
 *
 * Found by reading labels rather than by selector: jsonTree renders the key as text
 * inside the row, and CSS cannot match on text. That is also why a step points at a
 * field by name instead of carrying a selector -- there is no selector to carry.
 *
 * A dotted name descends a level per segment: `participantA.connection`. Array elements
 * come along for free, because jsonTree labels one by its index and quotes it exactly as
 * it quotes a key -- so `messages.1.saidBy` needs no syntax of its own. That matters for
 * the DDS editor, where a document is mostly nesting and the fields worth waiting for are
 * hardly ever at the top.
 *
 * The walk starts at the document's own rows, so a step asking for `name` cannot land on
 * a `name` belonging to something nested inside it.
 *
 * Rows exist whether or not their parent is expanded -- jsonTree builds the whole tree and
 * expands by class -- so a condition does not depend on what the player has opened up.
 */
function fieldRow(spec) {
    let rows = documentRows(scopeFor(spec));
    let row = null;

    for (const segment of String(spec.field).split('.')) {
        row = rows.find((candidate) => rowLabel(candidate) === `"${segment}"`) ?? null;
        if (!row) return null;
        rows = nestedRows(row);
    }

    return row;
}

/** What a field currently holds, as the editor shows it. */
function fieldValue(spec) {
    const row = fieldRow(spec);
    const input = row && rowValue(row)?.querySelector(':scope > input, :scope > select');
    return input ? input.value : null;
}

/**
 * Re-check on a timer.
 *
 * For anything read off disk. Writing a file raises no event this could listen for,
 * and a walkthrough is idle between steps, so asking now and then costs nothing.
 */
function poll(fn) {
    const timer = setInterval(fn, 400);
    return () => clearInterval(timer);
}

/** Walk a dotted path, array indices included: `MOleads.0.spawnItem`. */
const valueAt = (data, path) =>
    path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), data);

/**
 * A file in the content folder as it currently stands on disk, or null.
 *
 * probeFile rather than tryGetFile, and the whole of the difference is that this is asked
 * on a timer. A step waits for the author to write a file, so "not there" is the expected
 * answer for as long as they take, and a read that fails in the middle of that is a reason
 * to ask again 400ms later rather than to end the step. Nothing here writes.
 */
async function savedText(path) {
    const base = window.selectedMod?.baseFolder;
    if (!base) return null;

    const handle = await probeFile(base, path.split('/'));
    if (!handle) return null;

    try {
        return (await readFileContent(handle)) ?? null;
    } catch {
        // Caught for the same reason: a file being rewritten under the poll is a file to
        // look at again, not a walkthrough to abandon.
        return null;
    }
}

/** The same, parsed. Null while a file is absent or not yet valid JSON. */
async function savedFile(path) {
    const text = await savedText(path);
    if (text === null) return null;

    try {
        return JSON.parse(text);
    } catch {
        // Not written yet, or half-written. Not there as far as a step is concerned.
        return null;
    }
}

/**
 * Turn a step's `advanceWhen` into a condition.
 *
 * A string names one of the app-state conditions above. An object describes something
 * to look for, which is always watched through the DOM: none of these have a listener
 * of their own, and a walkthrough is idle between steps anyway.
 */
function conditionFor(spec) {
    if (typeof spec === 'string') {
        const named = CONDITIONS[spec];
        if (!named) throw new Error(`Tutorial names a condition that does not exist: ${spec}`);
        return named;
    }

    if (spec.visible) {
        return { satisfied: () => isVisible(spec.visible), subscribe: watchDom };
    }

    if (spec.fileOpen) {
        return { satisfied: () => Boolean(fileWindow(spec.fileOpen)), subscribe: watchDom };
    }

    // The content folder being worked in, for a step that asks for one to be made. Named
    // rather than found on the page: the dropdown holds it as an option's value, which no
    // selector can match on -- and `content-chosen` would be satisfied by whichever folder
    // was already open, which is the one the step is asking to move away from.
    //
    // By its name alone, not the path: where a new folder goes follows the mod's own
    // convention -- `plugins/theftgonewrong` in most mods and `theftgonewrong` in some --
    // and a walkthrough cannot know which mod it is being played in.
    if (spec.contentFolder) {
        return {
            satisfied: () => window.selectedMod?.contentPath.split('/').pop() === spec.contentFolder,
            subscribe: onSelectionChanged,
        };
    }

    // Waiting for the editor to be changed, as opposed to a step's `flow`, which
    // changes it for you. Moving between the two editors is most of what there is to
    // learn about how the app is laid out, so the walkthrough asks rather than does.
    if (spec.editor) {
        return {
            satisfied: () => window.activeFlow?.id === spec.editor,
            subscribe: watchDom,
        };
    }

    // How many entries an array has grown to, which no value can say: an array is a row
    // with children rather than something with an input to read. `count` is a floor, not
    // a total -- a player who adds a sixth message has still done what the step asked.
    if (spec.rows) {
        return {
            satisfied: () => {
                const row = fieldRow({ ...spec, field: spec.rows });
                return Boolean(row) && nestedRows(row).length >= spec.count;
            },
            subscribe: watchDom,
        };
    }

    if (spec.field) {
        return {
            // `is` omitted means any value will do -- for a field the player has to
            // fill in but whose contents are theirs to choose, and for the GUID fields,
            // whose value is whatever the document they just made happens to have.
            //
            // Where it is given, it is compared as text, because text is what a control
            // holds. A tutorial writes it however the field reads: a number for a number,
            // and for an enum the index behind the name -- that is what the dropdown's
            // options carry, and what the document stores.
            satisfied: () => {
                const value = fieldValue(spec);
                if (value === null) return false;
                return spec.is === undefined ? value.trim() !== '' : value === String(spec.is);
            },
            subscribe: watchDom,
        };
    }

    // Read off disk rather than out of the editor. Arrays and nested objects have no
    // input to read -- `weaponsPool` is a row with children, not a value -- and what
    // matters for those is what ended up in the mod anyway.
    if (spec.saved) {
        const { saved, at, is, contains } = spec;
        return {
            satisfied: async () => {
                const data = await savedFile(saved);
                if (!data) return false;
                if (!at) return true;

                const value = valueAt(data, at);
                if (contains !== undefined) {
                    return Array.isArray(value) && value.includes(contains);
                }
                if (is !== undefined) return value === is;
                return value !== undefined && value !== null && value !== '';
            },
            subscribe: poll,
        };
    }

    // The strings are CSV, not JSON, so they are checked as text. Only ever for
    // something appearing in the file -- a step has no business caring where in it.
    if (spec.savedText) {
        return {
            satisfied: async () => {
                const text = await savedText(spec.savedText);
                return text !== null && text.includes(spec.contains);
            },
            subscribe: poll,
        };
    }

    throw new Error(`Tutorial step has an advanceWhen this cannot read: ${JSON.stringify(spec)}`);
}

/**
 * What a step points at, as something driver.js can highlight.
 *
 * A selector is handed over as-is for driver.js to resolve, so a step pointing at a
 * fixed control keeps working across a tree rebuild. A field has to be resolved here,
 * for the reason fieldRow explains.
 */
function targetFor(element) {
    if (!element) return undefined;
    if (typeof element === 'string') return element;
    // Field first: a step naming a window and a field means the field, in that window.
    if (element.field) return fieldRow(element) ?? undefined;
    return scopeFor(element) ?? undefined;
}

/** Whether a step's target is on screen yet, so advancing can wait for it. */
function targetCondition(element) {
    if (!element) return null;
    if (typeof element === 'string') return conditionFor({ visible: element });
    if (element.field) {
        return { satisfied: () => Boolean(fieldRow(element)), subscribe: watchDom };
    }
    return { satisfied: () => Boolean(scopeFor(element)), subscribe: watchDom };
}

/**
 * Resolve once the condition holds, or as soon as the tutorial is abandoned.
 *
 * Abandoning resolves rather than rejecting, so the caller ends a step the same way it
 * ends any other and checks `signal.aborted` to find out which happened. A wait that
 * never settled would strand the loop holding it.
 */
async function waitFor(condition, signal) {
    if (signal?.aborted || await condition.satisfied()) return;

    return new Promise((resolve) => {
        let stop;
        let settled = false;
        // Conditions that read the disk are async, and the poll driving them does not
        // wait. Without this a slow read would be started again on every tick.
        let checking = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            stop?.();
            resolve();
        };

        const check = async () => {
            if (settled || checking) return;
            checking = true;
            try {
                if (await condition.satisfied()) finish();
            } finally {
                checking = false;
            }
        };

        signal?.addEventListener('abort', finish, { once: true });
        stop = condition.subscribe(check);

        // Satisfied while subscribing: `stop` was not assigned yet if the callback ran
        // synchronously, so unsubscribe again here.
        check();
        if (settled) stop?.();
    });
}

/**
 * Drop driver.js's mark on the highlighted element.
 *
 * It marks each one and never unmarks it, so the class piles up a step at a time. Its
 * stylesheet then clamps `overflow: hidden !important` on anything holding a marked
 * element -- which by the middle of a walkthrough is most of the editor. The file list
 * and the open document stop scrolling, so the fields a step is pointing at cannot be
 * reached, and they stay stuck once the walkthrough ends.
 *
 * Nothing here wants the class. The cutout is drawn by the overlay, and the only other
 * rule using it is a pointer-events one that core/chrome.css already overrides.
 */
function clearHighlightMarks() {
    for (const el of document.querySelectorAll('.driver-active-element')) {
        el.classList.remove('driver-active-element');
    }
}

/**
 * Keep it cleared for as long as the walkthrough runs.
 *
 * Clearing once per step is not enough on its own: the editors rebuild their trees
 * whenever a value changes, and driver.js re-renders its stage on scroll and resize, so
 * the mark can come back between steps. Watching for it is cheap -- the callback only
 * looks for one class, and it only runs while a walkthrough is on screen.
 */
function watchHighlightMarks() {
    const observer = new MutationObserver(clearHighlightMarks);
    observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
    });
    return () => observer.disconnect();
}

/**
 * Lock or unlock the way forward.
 *
 * driver.js takes a `disableButtons` option and it is only half of this: it is read when
 * the popover is built, so it can set the button up locked but has no way of letting it
 * go again while the step is still on screen. The other half is done here.
 *
 * Nothing fights over the state afterwards. Scrolling and resizing only re-position the
 * popover, and a new step throws the popover away and builds another, so a lock cannot
 * be inherited by the step after it either.
 */
function setForwardEnabled(enabled) {
    const button = document.querySelector('.driver-popover-next-btn');
    if (!button) return;

    button.disabled = !enabled;
    button.classList.toggle('driver-popover-btn-disabled', !enabled);
    button.title = enabled ? '' : 'Do what this step asks to carry on';
}

/**
 * Keep the forward button in the state the step wants, however late the popover arrives.
 *
 * driver.js builds the popover for a step on an animation frame partway through the
 * transition from the last one, so a step whose condition is already met -- the player
 * did it while reading the step before -- would otherwise unlock a button that has since
 * been thrown away, and the one that replaces it would stay locked for good.
 *
 * Watching body's own children is enough and stays quiet: the popover wrapper is a
 * direct child of it, and the app's own churn is all further down.
 */
function watchForward(isEnabled) {
    const observer = new MutationObserver(() => setForwardEnabled(isEnabled()));
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
}

/** The running tutorial, so starting one cannot leave another behind. */
let active = null;

export function stopTutorial() {
    if (!active) return;
    const { tour, controller, unwatch } = active;
    active = null;
    controller.abort();
    unwatch();
    tour.destroy();
    clearHighlightMarks();
}

/**
 * Show one step and wait for it to be left, resolving with which way.
 *
 * driver.js drives itself off a fixed step list, which this cannot use: a step's
 * target often does not exist until the step before it is done, and some steps are in
 * a different editor entirely. So the sequence is run here and driver.js is asked to
 * draw one step at a time.
 *
 * @param live whether this is as far as the walkthrough has got. A step being re-read is
 *             not being re-done, so it is never locked -- asking for its condition again
 *             would mean undoing the step to get back to where you were.
 * @returns 'forward' or 'back'
 */
async function runStep(tour, steps, index, live, signal) {
    const step = steps[index];

    // Steps move between editors -- the case files, the DDS documents and the strings
    // are three different ones -- so be where the step points before pointing.
    if (step.flow) await switchFlow(step.flow);
    if (signal.aborted) return 'forward';

    // The action that finished the last step is usually what creates this one's target,
    // and driver.js given a missing element floats the popover mid-screen pointing at
    // nothing.
    const target = targetCondition(step.element);
    if (target) await waitFor(target, signal);
    if (signal.aborted) return 'forward';

    // Scoped to this visit, so the condition stops being watched the moment the step is
    // left -- otherwise stepping back and forth would pile up a watcher per visit.
    const visit = new AbortController();
    const endVisit = () => visit.abort();
    signal.addEventListener('abort', endVisit, { once: true });

    let leave;
    const left = new Promise((resolve) => { leave = resolve; });
    visit.signal.addEventListener('abort', () => leave('forward'), { once: true });

    // Watched before the popover is drawn, so a step finished the instant it appears is
    // not missed.
    //
    // Meeting the condition unlocks the step; leaving it is a press of the button.
    // Moving on the instant the app agrees took the popover away mid-sentence -- a step
    // is read after doing the thing as often as before -- and left no way to look at
    // what had just been done.
    //
    // `autoAdvance` opts a step out of that, and the walkthroughs use it for the ones
    // where the doing is the whole of the step: set this field, add this row, open this
    // dialog. There is nothing to look back at, the description is spent by the time the
    // thing is done, and a button between each of a dozen of them is a dozen presses
    // saying nothing. It is the steps that explain what just happened, or ask for
    // several things at once, that are worth stopping on.
    const gated = live && Boolean(step.advanceWhen);
    const auto = gated && step.autoAdvance === true;
    let unlocked = false;
    let unwatchForward = null;

    if (gated) {
        // An auto step is locked too, right up until it leaves: a step that has not been
        // done cannot be skipped either way.
        if (!auto) unwatchForward = watchForward(() => unlocked);

        waitFor(conditionFor(step.advanceWhen), visit.signal).then(() => {
            if (visit.signal.aborted) return;
            if (auto) {
                leave('forward');
                return;
            }
            unlocked = true;
            setForwardEnabled(true);
        });
    }

    tour.highlight({
        element: targetFor(step.element),
        popover: {
            title: step.title,
            description: step.description,
            side: step.side ?? 'bottom',
            align: step.align ?? 'start',
            // For a step that has to stand beside something wide. See the narrow
            // popover rule in core/chrome.css.
            popoverClass: step.popoverClass,
            showProgress: true,
            progressText: `Step ${index + 1} of ${steps.length}`,
            // Every step offers a way forward, and a live gated one offers it locked
            // until the thing has been done -- so the button says what the walkthrough
            // is waiting for rather than the step simply refusing to end. A step being
            // re-read is never locked: it was done on the way through, and unlocking it
            // again would mean undoing it. Both keep the close button: a walkthrough you
            // cannot leave is a trap.
            showButtons: [
                ...(index > 0 ? ['previous'] : []),
                'next',
                'close',
            ],
            disableButtons: gated ? ['next'] : [],
            prevBtnText: '←',
            nextBtnText: '→',
            onPrevClick: () => leave('back'),
            onNextClick: () => leave('forward'),
            onCloseClick: () => stopTutorial(),
        },
    });

    clearHighlightMarks();

    const direction = await left;
    signal.removeEventListener('abort', endVisit);
    unwatchForward?.();
    visit.abort();
    return direction;
}

export async function startTutorial(id) {
    stopTutorial();

    const response = await fetch(`./tutorials/${id}.tutorial.json`);
    if (!response.ok) throw new Error(`No tutorial file for ${id}`);
    const definition = await response.json();

    const createDriver = await loadDriver();
    const controller = new AbortController();
    const tour = createDriver({
        // The app is clicked through the cutout, so a stray click on the overlay must
        // not be what ends the walkthrough.
        allowClose: false,
        // No smooth scrolling. A step points at a whole document, and animating that
        // into view fights whoever is already scrolling through it looking for the key
        // the step named.
        smoothScroll: false,
    });

    active = { tour, controller, unwatch: watchHighlightMarks() };

    try {
        const { steps } = definition;

        // How far the walkthrough has actually got, as opposed to which step is on
        // screen. Stepping back to re-read something does not undo it, so returning to
        // the furthest step puts you back on the live one rather than starting it over.
        let index = 0;
        let furthest = 0;

        while (index < steps.length) {
            if (controller.signal.aborted) return;

            const direction = await runStep(
                tour, steps, index, index === furthest, controller.signal);
            if (controller.signal.aborted) return;

            index = direction === 'back' ? Math.max(0, index - 1) : index + 1;
            furthest = Math.max(furthest, index);
        }
    } finally {
        if (active?.controller === controller) stopTutorial();
    }
}
