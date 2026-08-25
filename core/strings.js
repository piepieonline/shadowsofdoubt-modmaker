/** String helpers, byte-identical in both apps before extraction. */

export function makeNameFieldSafe(name) {
    return name.replaceAll(/[^a-zA-Z0-9\-]/g, "");
}

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
