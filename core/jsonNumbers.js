/**
 * Unity's non-finite floats, which are not JSON.
 *
 * The game's exporter writes an infinite float as the bare token `Infinity` or `-Infinity`.
 * `JSON.parse` refuses both, and `JSON.stringify` writes `null` for a non-finite number on the
 * way back out -- so a document holding one is unreadable coming in and quietly corrupted
 * going out. Five shipped assets hold one today, all of them an `outSlope` in an
 * AnimationCurve:
 *
 *     refs/assets/JobPreset/{Arrest,Photograph,Theft,ThrowFood,VandalismHome}_D6.json
 *
 * Everywhere game data is read or written goes through here, and the two halves have to agree:
 * a parse that produced a native `Infinity` and a stringify that wrote `null` would be worse
 * than refusing the file, because the loss would be silent and land in a patch.
 *
 * ## Why a text pass rather than a reviver alone
 *
 * A reviver never sees `Infinity` -- `JSON.parse` throws before it runs. A replacer cannot emit
 * one either: whatever it returns is serialised as JSON, and there is no JSON for an infinite
 * number. So the tokens are swapped for a sentinel string in the text on the way in, revived to
 * the native number, mapped back to the sentinel by a replacer, and swapped back to a bare token
 * in the text on the way out.
 *
 * ## Why the regex matches strings first
 *
 * `Infinity` is also an ordinary word. It is a key name in 76 shipped assets (`m_PreInfinity`,
 * `m_PostInfinity`) and could be any line of dialogue. `TOKEN` therefore matches a whole JSON
 * string literal as its *first* alternative and passes it through untouched, so a string is
 * consumed atomically and can never be rewritten from the inside. Only a token that survives to
 * the second alternative is a bare value, because that is the only place JSON allows one.
 *
 * ## `NaN` is not handled, on purpose
 *
 * Unity can emit it and no dump has been seen carrying one. It is left out because
 * `fast-json-patch` compares primitives with `===`, so where two infinities are equal and diff
 * to nothing, two NaNs are not:
 *
 *     compare({ a: Infinity }, { a: Infinity })  ->  []
 *     compare({ a: NaN },      { a: NaN })       ->  [{ op: 'replace', path: '/a', value: null }]
 *
 * Reading one would put a meaningless `replace` into every patch on every save. A file holding
 * `NaN` still fails to parse, which is the safe answer and the one callers already report.
 *
 * ## The one limit
 *
 * A genuine string equal to a sentinel would be written out as a bare token. That takes NUL
 * bytes on either side of the word inside a Unity-exported name or line of dialogue, which is
 * why the sentinels are built from NUL rather than from something typeable.
 */

/**
 * The stand-ins for the two tokens, between `JSON.parse` and `JSON.stringify`.
 *
 * NUL because it cannot occur in the data: the assets are UTF-8 text the game exported, and a
 * control character in a preset name or a line of dialogue is not a thing that happens.
 */
const NUL = '\u0000';
const POSITIVE = `${NUL}Infinity${NUL}`;
const NEGATIVE = `${NUL}-Infinity${NUL}`;

/**
 * How `JSON.stringify` writes those sentinels -- NUL is escaped rather than emitted raw, and it
 * is escaped the same way every time, so the text to search for on the way out is fixed. Derived
 * rather than written down, so the two cannot drift apart.
 */
const POSITIVE_JSON = JSON.stringify(POSITIVE);
const NEGATIVE_JSON = JSON.stringify(NEGATIVE);

/**
 * A JSON string literal, or a bare infinity outside one.
 *
 * The string alternative comes first and is what keeps this safe -- see the module note. Its
 * body is `[^"\\]|\\.`, which steps over an escaped quote rather than ending on it, so a value
 * like `"a\"Infinity"` is consumed whole.
 */
const TOKEN = /"(?:[^"\\]|\\.)*"|-?\bInfinity\b/g;

/**
 * `JSON.parse`, reading Unity's bare `Infinity` and `-Infinity` as the numbers they mean.
 *
 * Throws what `JSON.parse` throws for anything else, `NaN` included, so callers keep reporting
 * an unreadable file the way they already do.
 */
export function parseJSON(text) {
    const masked = String(text).replace(TOKEN, (match) => (
        match.startsWith('"')
            ? match
            : (match.startsWith('-') ? NEGATIVE_JSON : POSITIVE_JSON)
    ));

    return JSON.parse(masked, (key, value) => {
        if (value === POSITIVE) return Infinity;
        if (value === NEGATIVE) return -Infinity;

        return value;
    });
}

/**
 * `JSON.stringify`, writing an infinite number as the bare token Unity reads.
 *
 * Same signature as the built-in so call sites swap mechanically, and a caller's replacer is
 * composed with this one rather than replacing it -- `toSaveSafeJSON` has fields to strip and
 * still needs infinities to survive. Only a function replacer is supported; the array form is
 * an allowlist nothing here uses.
 *
 * `this` is forwarded because `JSON.stringify` calls a replacer with the holder as its receiver,
 * and a caller's replacer is entitled to read it.
 */
export function stringifyJSON(value, replacer = null, indent = undefined) {
    const text = JSON.stringify(value, function nonFinite(key, held) {
        const resolved = replacer ? replacer.call(this, key, held) : held;

        if (resolved === Infinity) return POSITIVE;
        if (resolved === -Infinity) return NEGATIVE;

        return resolved;
    }, indent);

    // `undefined` for a value with no JSON representation at all, which is the built-in's answer
    // and not this module's to change.
    if (text === undefined) return text;

    return text.replaceAll(POSITIVE_JSON, 'Infinity').replaceAll(NEGATIVE_JSON, '-Infinity');
}
