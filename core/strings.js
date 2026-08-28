/** String helpers, byte-identical in both apps before extraction. */

/**
 * A name safe to use as an identifier and as a file name.
 *
 * Letters, digits, hyphen and underscore. The game's own presets are named this way --
 * `Hotel_GroundFloor` -- and everything the app writes is keyed by one of these: a
 * preset name goes in a `REF:` string, in a strings CSV key and in a file name, none of
 * which survive a space.
 */
export function makeNameFieldSafe(name) {
    return name.replaceAll(/[^a-zA-Z0-9\-_]/g, "");
}

/** Whether a name is already safe, for refusing one rather than silently altering it. */
export const isNameFieldSafe = (name) => name.length > 0 && makeNameFieldSafe(name) === name;

/**
 * Quote a value for the DDS strings CSV.
 * Returns a JSON-encoded string, so callers JSON.parse it back out.
 */
export function makeCSVSafe(line) {
    line = line.replace(/\\/g, '\\\\');

    // Allow double quoted for included commas etc
    if (line.includes(",")) {
        line = '\\"' + line + '\\"';
    }

    line = '"' + line + '"';

    return line;
}

export function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}
