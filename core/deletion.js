/**
 * Asking before a file is taken out of a mod, and saying what else pointed at it.
 *
 * Deleting is the one thing the file panel does that cannot be undone from inside the app
 * -- there is no history, and the folder is the author's real folder on disk. So it asks
 * first, and the asking is worth more than a bare "are you sure": the interesting question
 * is never whether the author meant to click, it is what stops working when they did.
 *
 * A mod's content is a web of references. A case asset is named by the load order and
 * pointed at by other presets; a DDS message is held by a tree and holds blocks of its
 * own. None of that is visible from the panel, and following it by hand means opening
 * every other file in the folder. So the references are gathered before the question is
 * put, and listed in it.
 *
 * They are listed and nothing more. Confirming deletes the file and takes it out of the
 * mod's load order -- an entry naming a file that is not there is a loader going looking
 * for something it cannot find -- and leaves every other file exactly as its author wrote
 * it. Blanking a `REF:` inside a document nobody has opened is a bigger thing than
 * deleting the file that was asked for, and the list is what puts the author in a position
 * to do it themselves.
 *
 * A native confirm rather than a dialog of our own, as everywhere else something is
 * deleted here: array elements, building floors, unsaved strings.
 */

/**
 * How many referring files are named before the list stops.
 *
 * A confirm box is as tall as its text and a mod can point at one asset from fifty
 * places. Past a point the list has stopped being something to read and started being
 * something to scroll past, and the count above it already says how bad it is.
 */
const LISTED = 15;

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * What the confirmation says. Separate from asking it so that it can be read without a
 * browser -- the wording is the whole of what this does.
 *
 * @param label      what the file is called, as the panel shows it
 * @param references what points at it, already labelled by whoever went looking
 */
export function deletionMessage(label, references = []) {
    const question = `Delete "${label}" from this mod?`;

    // Said rather than left out: "nothing else refers to it" is the answer that makes
    // this an easy click, and an absent list reads as a check that was not made.
    if (!references.length) return `${question}\n\nNothing else in this mod refers to it.`;

    const shown = references.slice(0, LISTED).map((name) => `  • ${name}`);
    const rest = references.length - shown.length;
    if (rest > 0) shown.push(`  … and ${plural(rest, 'more')}`);

    return `${question}\n\nReferenced by ${plural(references.length, 'file')}:\n${shown.join('\n')}\n\n`
        + 'Those files will be left as they are, and will point at something that is no longer there.';
}

/** Put the question. True if the author said yes. */
export function confirmDelete(label, references = []) {
    return confirm(deletionMessage(label, references));
}
