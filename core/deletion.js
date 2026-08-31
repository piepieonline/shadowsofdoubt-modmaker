/**
 * Asking before a change that leaves the rest of a mod pointing at something that is not
 * there, and saying which files those are.
 *
 * Two changes do that. Deleting is the one thing the file panel does that cannot be undone
 * from inside the app -- there is no history, and the folder is the author's real folder on
 * disk. Renaming an asset can be undone by renaming it back, but it breaks the same links
 * in the same way, and for a long time said nothing at all.
 *
 * Both ask, and the asking is worth more than a bare "are you sure": the interesting
 * question is never whether the author meant to click, it is what stops working when they
 * did.
 *
 * A mod's content is a web of references. A case asset is named by the load order and
 * pointed at by other presets; a DDS message is held by a tree and holds blocks of its
 * own. None of that is visible from the panel, and following it by hand means opening
 * every other file in the folder. So the references are gathered before the question is
 * put, and listed in it.
 *
 * They are listed and nothing more. Confirming a deletion removes the file and takes it out
 * of the mod's load order -- an entry naming a file that is not there is a loader going
 * looking for something it cannot find. Confirming a rename moves the file and follows it
 * through that same load order. Neither touches any other file: rewriting a `REF:` inside a
 * document nobody has opened is a bigger thing than the one that was asked for, and the
 * list is what puts the author in a position to do it themselves.
 *
 * Where the two part company is what happens when nothing points at the asset. A deletion
 * says so out loud, because it is the answer that makes the click an easy one and because
 * an absent list would read as a check that was never made. A rename with nothing to warn
 * about is not put at all -- renaming is ordinary editing and it undoes itself, so a box on
 * every `presetName` edit would be a click that carries no information.
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

/** The referring files, one to a line, cut off at the cap with the remainder counted. */
function listed(references) {
    const shown = references.slice(0, LISTED).map((name) => `  • ${name}`);
    const rest = references.length - shown.length;
    if (rest > 0) shown.push(`  … and ${plural(rest, 'more')}`);

    return shown.join('\n');
}

/** How the list is headed, which is the count the cut-off list may not carry. */
const heading = (references) => `Referenced by ${plural(references.length, 'file')}:`;

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

    return `${question}\n\n${heading(references)}\n${listed(references)}\n\n`
        + 'Those files will be left as they are, and will point at something that is no longer there.';
}

/** Put the question. True if the author said yes. */
export function confirmDelete(label, references = []) {
    return confirm(deletionMessage(label, references));
}

/**
 * What the author is asked before an asset's name changes under the files that name it.
 *
 * Both names are in the question. A rename is the one change here where naming the file
 * alone does not say what is about to happen -- the new name has just been typed into a
 * field and the old one has already gone off the screen with it.
 *
 * What follows the new name is named too. A rename does move the file and does rewrite the
 * mod's load order, and a tool that got that far is reasonably assumed to have got the rest
 * of the way; saying which half was done is the difference between a warning and a
 * half-truth.
 *
 * Only reached when something refers to the asset -- see `confirmRename`.
 *
 * @param from       what the asset is called now
 * @param to         what it is about to be called
 * @param references what points at it, already labelled by whoever went looking
 */
export function renameMessage(from, to, references = []) {
    return `Rename "${from}" to "${to}"?\n\n${heading(references)}\n${listed(references)}\n\n`
        + "This mod's load order will follow the new name. Those files will not: each one still "
        + `says "${from}", and will point at an asset that is no longer there.`;
}

/**
 * Put the question, when there is one to put. True if the rename should go ahead.
 *
 * An asset nothing points at is renamed without being asked about, which is the one place
 * this parts company with `confirmDelete` -- see the note at the top. The check still runs:
 * what is skipped is a box with nothing in it to read.
 */
export function confirmRename(from, to, references = []) {
    if (!references.length) return true;

    return confirm(renameMessage(from, to, references));
}
