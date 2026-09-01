/**
 * The IDs a tree uses to talk about itself.
 *
 * A message has two: `msgID` names the *document*, and `instanceID` names this use of that
 * document in this tree. Links run between instances, and `startingMessage` names one, so
 * the same message can appear twice in a tree and be followed by something different each
 * time. That distinction is the one thing about the format that catches everybody out.
 *
 * Both halves were free text. An `instanceID` is a GUID the editor generates when the
 * element is created and nothing should ever type over -- doing so silently breaks every
 * link into that message and the tree's own starting point. And a field that *names* an
 * instance was a box to paste a GUID into, checked against nothing: the walkthrough's own
 * instruction was "copy the value of messages.1's instanceID, then paste it".
 *
 * So one is read-only and the other is a list of the instances actually in the document.
 */

/** `<owner type>.<field>`, for the checks below. */
const key = (resolved) => `${resolved.ownerType}.${resolved.field}`;

/**
 * The IDs the editor generates and nothing edits.
 *
 * Not merely unhelpful to type into: an instanceID is what links and `startingMessage`
 * point at, so changing one by hand is a tree whose parts no longer refer to each other,
 * with nothing on screen to say so.
 */
const GENERATED_IDS = new Set([
    'DDSMessageSettings.instanceID',
    'DDSBlockCondition.instanceID',
]);

/** The fields that hold the instanceID of a message in the same tree. */
const INSTANCE_REFERENCES = new Set([
    'DDSTreeSave.startingMessage',
    'DDSMessageLink.to',
    // Which message a link runs *from* is decided by where the link was added, and the
    // editor fills it in. It is listed all the same: a link pasted in from somewhere else
    // carries the `from` of the tree it was copied out of.
    'DDSMessageLink.from',
]);

/** Whether this field is an ID the editor made and no one should retype. */
export function isGeneratedId(resolved) {
    return Boolean(resolved) && GENERATED_IDS.has(key(resolved));
}

/** Whether this field names a message instance in the document it is part of. */
export function isInstanceReference(resolved) {
    return Boolean(resolved) && INSTANCE_REFERENCES.has(key(resolved));
}

/**
 * The messages of a tree, as options for a field that names one.
 *
 * The value is the instanceID, because that is what the field holds. The text is where the
 * message sits in the document, since that is what an author can see on the screen in
 * front of them -- a GUID identifies it and describes nothing.
 *
 * An element -- a message slot with no document behind it, carrying `elementName` instead
 * of a `msgID` -- is named by that, which is the only name it has.
 *
 * @param document the open document. Anything that is not a tree has no instances in it,
 *                 which is an empty list rather than a fault.
 */
export function instanceOptions(document) {
    const messages = Array.isArray(document?.messages) ? document.messages : [];

    // Numbered before the incomplete ones are dropped: the index is the position in the
    // document, which is what `messages.3` in the tree means and what the author is
    // looking at. Filtering first would renumber everything after a gap.
    return messages
        .map((message, index) => ({
            value: message?.instanceID,
            text: describe(message ?? {}, index),
        }))
        .filter((option) => Boolean(option.value));
}

function describe(message, index) {
    const named = message.elementName ? ` — ${message.elementName}` : '';
    const order = Number.isFinite(message.order) ? ` (order ${message.order})` : '';

    return `messages.${index}${named}${order}`;
}
