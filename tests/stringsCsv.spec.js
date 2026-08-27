import { test, expect } from '@playwright/test';

/**
 * The row model behind a strings CSV.
 *
 * The editor above it is a list of boxes; what decides whether a mod still loads is
 * what happens to the five columns nobody is looking at, to the quotes that keep a
 * comma from being a column boundary, and to the lines at the top of the file that are
 * not strings at all. Those are cheaper and clearer to pin here than through the UI.
 *
 * Exercised in the page rather than in Node so it is the module the app actually
 * serves, loaded the way the app loads it.
 */

const GUID = '33333333-3333-4333-8333-333333333333';
const STAMP = '12:00 02/02/2026';

/** Parse a file, returning the rows without the DOM the editor wraps them in. */
const parse = (page, text) => page.evaluate(async (csv) => {
    const { parseStringsCsv } = await import('/core/stringsCsv.js');
    return parseStringsCsv(csv);
}, text);

/** Round-trip a file through the model, with the given edits applied to its rows. */
const rewrite = (page, text, edits = []) => page.evaluate(async ([csv, changes, stamp]) => {
    const { parseStringsCsv, serialiseStringsCsv } = await import('/core/stringsCsv.js');

    const file = parseStringsCsv(csv);
    for (const { at, key, text: value } of changes) {
        if (at === file.rows.length) file.rows.push({ key, text: value });
        else Object.assign(file.rows[at], key === undefined ? {} : { key },
            value === undefined ? {} : { text: value });
    }

    return serialiseStringsCsv(file, stamp);
}, [text, edits, STAMP]);

test.beforeEach(async ({ page }) => {
    // Any page from this origin will do: the module under test is a static file with
    // no dependencies of its own.
    await page.goto('/');
});

test('reads the two columns that are strings, and keeps the row they came from', async ({ page }) => {
    const file = await parse(page, `${GUID},,Hello,,KEEP-ME,,09:00 01/01/2024`);

    expect(file.headers).toEqual([]);
    expect(file.rows).toEqual([{
        key: GUID,
        text: 'Hello',
        fields: [GUID, '', 'Hello', '', 'KEEP-ME', '', '09:00 01/01/2024'],
    }]);
});

test('takes the game\'s quotes off both columns', async ({ page }) => {
    const file = await parse(page, `"${GUID}",,"Wait, listen to me",,,,09:00 01/01/2024`);

    // The comma is inside the field, which is what its quotes are for -- one string,
    // not two columns.
    expect(file.rows.map((row) => [row.key, row.text])).toEqual([[GUID, 'Wait, listen to me']]);
});

test('holds back the header lines at the top and nothing else', async ({ page }) => {
    const file = await parse(page, [
        'BLOCK CSV HEADER 1,,,,,,',
        '"BLOCK CSV HEADER 2",,,,,,',
        `${GUID},,Hello,,,,09:00 01/01/2024`,
        // Textless, but below a real row -- so it is a row an author can see and fix,
        // not a preamble.
        'SomethingWithNoText,,,,,,',
    ].join('\n'));

    expect(file.headers).toEqual(['BLOCK CSV HEADER 1,,,,,,', '"BLOCK CSV HEADER 2",,,,,,']);
    expect(file.rows.map((row) => row.key)).toEqual([GUID, 'SomethingWithNoText']);
});

test('an empty file is no headers and no rows', async ({ page }) => {
    expect(await parse(page, '')).toEqual({ headers: [], rows: [] });
    expect(await parse(page, '\n\n')).toEqual({ headers: [], rows: [] });
});

test('writes every row quoted, headers as they were', async ({ page }) => {
    const written = await rewrite(page, [
        'HEADER 1,,,,,,',
        `${GUID},,Hello,,,,09:00 01/01/2024`,
    ].join('\n'));

    // Headers are not strings and are not requoted; rows are, so a file has one shape
    // rather than a shape per writer.
    expect(written).toBe([
        'HEADER 1,,,,,,',
        `"${GUID}",,"Hello",,,,09:00 01/01/2024`,
    ].join('\n'));
});

test('a row nobody edited keeps its timestamp', async ({ page }) => {
    const written = await rewrite(
        page,
        [`${GUID},,Hello,,,,09:00 01/01/2024`, 'Other,,Untouched,,,,10:00 01/01/2024'].join('\n'),
        [{ at: 0, text: 'Changed' }],
    );

    // The one piece of history these files keep, and requoting is not an edit.
    expect(written.split('\n')).toEqual([
        `"${GUID}",,"Changed",,,,${STAMP}`,
        '"Other",,"Untouched",,,,10:00 01/01/2024',
    ]);
});

test('the columns this app has no view on survive an edit', async ({ page }) => {
    const written = await rewrite(
        page,
        `${GUID},,Hello,,KEEP-ME,SO-DOES-THIS,09:00 01/01/2024`,
        [{ at: 0, text: 'Changed' }],
    );

    expect(written).toBe(`"${GUID}",,"Changed",,KEEP-ME,SO-DOES-THIS,${STAMP}`);
});

test('a row added with nothing in it is not written', async ({ page }) => {
    const written = await rewrite(page, `${GUID},,Hello,,,,09:00 01/01/2024`, [
        { at: 1, key: '', text: '' },
    ]);

    // `"",,"",,,,` is a line the game reads as nothing named by nothing.
    expect(written).toBe(`"${GUID}",,"Hello",,,,09:00 01/01/2024`);
});

test('a row added and typed into gets the full set of columns', async ({ page }) => {
    const written = await rewrite(page, '', [{ at: 0, key: 'NewRoom', text: 'A new room' }]);

    expect(written).toBe(`"NewRoom",,"A new room",,,,${STAMP}`);
});

test('a blank line is not a row and does not come back', async ({ page }) => {
    const written = await rewrite(page, `${GUID},,Hello,,,,09:00 01/01/2024\n\nOther,,Second,,,,`);

    // Nothing is carried in one, and a file rebuilt from rows has no way to say where
    // it went -- so an empty row that means nothing is not offered to be edited.
    expect(written.split('\n')).toHaveLength(2);
});

test('text with a comma in it round-trips', async ({ page }) => {
    const original = `${GUID},,"Wait, listen to me",,,,09:00 01/01/2024`;
    const file = await parse(page, original);

    expect(file.rows[0].text).toBe('Wait, listen to me');
    // Read back as one field, not three: the quotes it is written with are the ones
    // that make that true.
    expect(await parse(page, await rewrite(page, original))).toEqual(
        await parse(page, await rewrite(page, await rewrite(page, original))),
    );
});

test('a comma typed into a box becomes a quoted field, not two columns', async ({ page }) => {
    const written = await rewrite(page, `${GUID},,Hello,,,,09:00 01/01/2024`, [
        { at: 0, text: 'Wait, listen to me' },
    ]);

    const reread = await parse(page, written);
    expect(reread.rows.map((row) => [row.key, row.text])).toEqual([[GUID, 'Wait, listen to me']]);
});
