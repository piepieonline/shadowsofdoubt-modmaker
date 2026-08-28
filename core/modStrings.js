/**
 * Writing one row into a mod's strings CSV.
 *
 * The game reads every piece of text a player sees out of these files, keyed by
 * something the content refers to: a block's GUID for a line of dialogue, a preset's
 * name for a room or a building. So a flow that creates content with a human-readable
 * name is writing a strings row, whichever editor it happens to be.
 *
 * Which file that is comes from the manifest, not from the path the game reads: a mod
 * that keeps its CSVs somewhere of its own gets the row there, and gains the entry that
 * tells the loader where to read it from. Writing to the game's path in a mod like that
 * would leave a file nothing ever loads. See core/ddsManifest.js.
 *
 * Extracted from the DDS flow's addOrModifyStrings, which is now one caller of two. What
 * stayed behind there is what only that editor cares about -- refreshing the strings
 * window and the manifest panel, and the block-text cache.
 */
import { writeFile } from './fs.js';
import {
    ddsContentFolder, placeStringsFile, readManifest, stringsFileHandle, withMapping,
    writeManifest,
} from './ddsManifest.js';
import {
    EDITED_FIELD, KEY_FIELD, TEXT_FIELD, editedStamp, quote, rowKey, splitRow, unquoteText,
} from './stringsCsv.js';

/**
 * Write `text` against `key` in the CSV the loader reads from `virtualPath`.
 *
 * One question decides how it is written -- is there already a row for this key? -- so
 * it is asked once, of the rows themselves, rather than once of the file's text and
 * again of each line in a way that could disagree with it.
 *
 * The key and the line are quoted whichever way the row is written, which is the shape
 * the game's own CSVs are in and the shape the strings editor writes. `text` may arrive
 * quoted already when it holds a comma (see makeCSVSafe), so it is unquoted first --
 * quoting it twice would put the quotes in the string the player reads.
 *
 * @param contentFolder the mod's content folder, not its DDSContent
 * @param virtualPath   below DDSContent, where the game reads the file from
 * @returns where the row was actually written, the file's handle, and whether the
 *          manifest gained an entry -- all three so a caller can refresh whatever it
 *          has on screen that is now a row behind.
 */
export async function writeStringsRow(contentFolder, virtualPath, key, text) {
    const datestring = editedStamp();
    const line = quote(unquoteText(text));

    const ddsFolder = await ddsContentFolder(contentFolder, true);
    const manifest = await readManifest(ddsFolder);

    const { real, addEntry } = placeStringsFile(manifest, virtualPath);

    const handle = await stringsFileHandle(ddsFolder, real, true);

    // Creating the file is allowed to fail -- a folder that cannot be written, a name
    // taken by a directory -- and the next line would make that a TypeError on null,
    // thrown somewhere nobody would ever see it.
    if (!handle) throw new Error(`Could not open ${real} in this mod to write the line to.`);

    const lines = (await (await handle.getFile()).text()).split('\n');
    const existing = lines.findIndex((row) => rowKey(row) === key);

    if (existing !== -1) {
        // Only the columns this app knows the meaning of. A row can carry more -- the
        // game's own files do -- and rewriting the whole line threw that away.
        const fields = splitRow(lines[existing]);
        while (fields.length <= EDITED_FIELD) fields.push('');

        fields[KEY_FIELD] = quote(key);
        fields[TEXT_FIELD] = line;
        fields[EDITED_FIELD] = datestring;

        lines[existing] = fields.join(',');
        await writeFile(handle, lines.join('\n'), false);
    } else {
        await writeFile(handle, `\n${quote(key)},,${line},,,,${datestring}`, true);
    }

    // The file went where the mod keeps its CSVs, which is not where the game looks for
    // it -- so say so, or the text is written and never read.
    if (addEntry) await writeManifest(ddsFolder, withMapping(manifest, addEntry));

    return { real, handle, declared: Boolean(addEntry) };
}
