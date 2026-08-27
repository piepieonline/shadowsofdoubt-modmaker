/**
 * A strings CSV as rows, rather than as text.
 *
 * These files are the game's localisation tables: `guid,,text,,,,timestamp`, one line
 * per string the game looks up. Only two of the seven columns mean anything to this
 * app -- the key a line is stored against and the text itself -- and the rest belong
 * to the file's author, so a row read here and written back carries them unchanged.
 *
 * Two things about the format are worth stating, because both used to bite:
 *
 *  - A quote is load bearing. A field holding a comma is quoted precisely so that the
 *    comma is not a separator, so splitting a line on every comma tears such a row
 *    into pieces that do not rejoin into the row they came from. See splitRow.
 *  - The game's own CSVs quote the key and the text of every row, comma or not, and a
 *    mod that began life as a copy of one is in that shape. Reading has always allowed
 *    for it; writing now matches it, so a file does not end up half in one style and
 *    half in the other depending on which part of the app last touched it.
 *
 * The game's loader has no escape sequence -- it finds the end of a quoted field by
 * looking for the next quote -- so neither does this. A quote inside a line of text is
 * written through as it was typed, which is what the app did before and is the most
 * that format allows.
 */

/** The columns this app has a view on. A row holds more, and they are not ours. */
export const KEY_FIELD = 0;
export const TEXT_FIELD = 2;
export const EDITED_FIELD = 6;

/**
 * A row as its fields, with quoted fields kept whole.
 *
 * The quotes are kept in the field text, so that fields.join(',') gives back the line
 * exactly -- what a rewrite does not touch, it must not alter.
 */
export function splitRow(line) {
    const fields = [];
    let field = '';
    let quoted = false;

    for (const char of line) {
        if (char === '"') {
            quoted = !quoted;
            field += char;
        } else if (char === ',' && !quoted) {
            fields.push(field);
            field = '';
        } else {
            field += char;
        }
    }

    fields.push(field);
    return fields;
}

/**
 * The key a row is stored against, however it is written.
 *
 * Every quote comes off rather than a surrounding pair, because a key is a GUID or a
 * bare name and a quote is never part of one. Reverse search and loadI18n read a key
 * the same way; writing did not, which is the bug that made an edit to a quoted file
 * silently do nothing at all -- the row was never matched, so the file was written
 * back exactly as it was, with no new row, no changed row and no error.
 */
export const unquoteKey = (field) => field.replaceAll('"', '').trim();

/** The key of a whole line, for callers holding text rather than fields. */
export const rowKey = (line) => unquoteKey(splitRow(line)[KEY_FIELD]);

/**
 * The text of a field, with the quotes the game wraps it in taken off.
 *
 * One surrounding pair only: a comma-holding line reads `"Wait, listen to me"`, and
 * the quotes are the format's, not the author's. This is the rule the block editor
 * already displayed text by (see createDummyLocalisationKey).
 */
export const unquoteText = (field) => (field.startsWith('"') ? field.slice(1, -1) : field);

/** A field as the game writes it. */
export const quote = (value) => `"${value}"`;

/** The stamp the game keeps in the last column: `HH:MM DD/MM/YYYY`. */
export function editedStamp(now = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');

    return `${pad(now.getHours())}:${pad(now.getMinutes())} `
        + `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
}

/**
 * Read a file into the rows an editor can show.
 *
 * Blank lines are dropped. They carry nothing, and a file rebuilt from rows has no
 * way to say where one went, so keeping them in the model would only mean showing an
 * empty row that means nothing and warns about itself.
 *
 * Leading lines with no text are held back as `headers`, unparsed and unshown. The
 * game's CSVs open with three of them, and they are not strings: a list that offered
 * to edit `BLOCK CSV HEADER 1` as though it were a key would be inviting the author to
 * break the file. Only from the top, because a preamble is at the top of a file -- a
 * textless row further down is a row an author can see, and probably wants to fix.
 *
 * @returns `{ headers: string[], rows: [{ key, text, fields }] }`, where `fields` is
 *          the row as it was read, which is what the columns this app has no view on
 *          are carried back out in.
 */
export function parseStringsCsv(text) {
    const lines = (text ?? '').split('\n').filter((line) => line.trim() !== '');

    let firstRow = 0;
    while (
        firstRow < lines.length
        && unquoteText(splitRow(lines[firstRow])[TEXT_FIELD] ?? '') === ''
    ) firstRow++;

    return {
        headers: lines.slice(0, firstRow),
        rows: lines.slice(firstRow).map((line) => {
            const fields = splitRow(line);

            return {
                key: unquoteKey(fields[KEY_FIELD]),
                text: unquoteText(fields[TEXT_FIELD] ?? ''),
                fields,
            };
        }),
    };
}

/** Whether a row's key or text differs from what was read into it. */
function edited(row) {
    if (!row.fields) return true;

    return unquoteKey(row.fields[KEY_FIELD]) !== row.key
        || unquoteText(row.fields[TEXT_FIELD] ?? '') !== row.text;
}

/**
 * Write rows back out as a file.
 *
 * Every row is quoted, including ones nobody touched, so that a file has one shape
 * rather than a shape per writer. Only the timestamp distinguishes a row that was
 * edited: stamping every row on every save would throw away the one piece of history
 * these files keep, over a save that changed nothing.
 *
 * A row with neither a key nor any text is not written. That is what an added row
 * looks like before anything is typed into it, and `"",,"",,,,` in a file is a line
 * the game would read as nothing named by nothing.
 *
 * @param stamp what to put in the edited column of rows that changed
 */
export function serialiseStringsCsv({ headers = [], rows }, stamp) {
    const lines = [...headers];

    for (const row of rows) {
        if (row.key === '' && row.text === '') continue;

        const fields = [...(row.fields ?? [])];
        while (fields.length <= EDITED_FIELD) fields.push('');

        if (edited(row)) fields[EDITED_FIELD] = stamp;
        fields[KEY_FIELD] = quote(row.key);
        fields[TEXT_FIELD] = quote(row.text);

        lines.push(fields.join(','));
    }

    return lines.join('\n');
}
