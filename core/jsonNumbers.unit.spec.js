import { test, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseJSON, stringifyJSON } from './jsonNumbers.js';

/**
 * Unity writes an infinite float as a bare `Infinity`, which is not JSON in either
 * direction: `JSON.parse` refuses it and `JSON.stringify` writes `null` for it. Both
 * halves are here, because a codec that reads one and writes the other silently corrupts
 * every patch made against an asset that holds one.
 *
 * `Infinity` is also an ordinary word, and most of what follows is about the difference
 * between the token and the word.
 */

const NUL = String.fromCharCode(0);

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

test('a bare Infinity reads as the number it means', () => {
    expect(parseJSON('{"outSlope":Infinity}')).toEqual({ outSlope: Infinity });
    expect(parseJSON('{"outSlope":-Infinity}')).toEqual({ outSlope: -Infinity });
});

test('a bare Infinity reads the same wherever it sits', () => {
    expect(parseJSON('[1,Infinity,-Infinity]')).toEqual([1, Infinity, -Infinity]);
    expect(parseJSON('Infinity')).toBe(Infinity);
    expect(parseJSON('{"a":{"b":[{"c":Infinity}]}}')).toEqual({ a: { b: [{ c: Infinity }] } });
});

test('ordinary JSON is unaffected', () => {
    expect(parseJSON('{"a":1,"b":[true,null,"x"]}')).toEqual({ a: 1, b: [true, null, 'x'] });
});

/* -------------------------------------------------------------------------- */
/* The word, as opposed to the token                                           */
/* -------------------------------------------------------------------------- */

/**
 * The case that made the string-first alternation necessary. `m_PreInfinity` and
 * `m_PostInfinity` are key names in 76 of the shipped assets, and rewriting one would
 * turn a valid file into an unparseable one -- and would have done so on far more files
 * than the five this change exists for.
 */
test('a key whose name contains the word is left alone', () => {
    expect(parseJSON('{"m_PreInfinity":2,"m_PostInfinity":2}'))
        .toEqual({ m_PreInfinity: 2, m_PostInfinity: 2 });
});

test('a string value containing the word stays a string', () => {
    expect(parseJSON('{"note":"Infinity war"}')).toEqual({ note: 'Infinity war' });
    expect(parseJSON('{"note":"Infinity"}')).toEqual({ note: 'Infinity' });
    expect(parseJSON('{"note":"-Infinity"}')).toEqual({ note: '-Infinity' });
});

/**
 * An escaped quote inside a string must not end it. If it did, the scan would resume
 * mid-string and the next word could be read as a bare token.
 */
test('an escaped quote does not end a string early', () => {
    expect(parseJSON('{"esc":"a\\"Infinity","outSlope":Infinity}'))
        .toEqual({ esc: 'a"Infinity', outSlope: Infinity });
});

test('a backslash before the closing quote does not end the string early', () => {
    expect(parseJSON('{"esc":"back\\\\","outSlope":Infinity}'))
        .toEqual({ esc: 'back\\', outSlope: Infinity });
});

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

test('an infinite number is written as the bare token, not as null', () => {
    expect(stringifyJSON({ outSlope: Infinity })).toBe('{"outSlope":Infinity}');
    expect(stringifyJSON({ outSlope: -Infinity })).toBe('{"outSlope":-Infinity}');

    // What the built-in does, and the whole reason this module exists.
    expect(JSON.stringify({ outSlope: Infinity })).toBe('{"outSlope":null}');
});

test('a string containing the word is still written as a string', () => {
    expect(stringifyJSON({ note: 'Infinity' })).toBe('{"note":"Infinity"}');
    expect(stringifyJSON({ m_PreInfinity: 2 })).toBe('{"m_PreInfinity":2}');
});

test('indenting works as it does on the built-in', () => {
    expect(stringifyJSON({ a: Infinity }, null, 2)).toBe('{\n  "a": Infinity\n}');
});

/**
 * `toSaveSafeJSON` strips display-only keys with a replacer and still needs infinities to
 * survive, so the two compose rather than one replacing the other.
 */
test('a caller replacer composes with the codec rather than displacing it', () => {
    const dropB = (key, value) => (key === 'b' ? undefined : value);

    expect(stringifyJSON({ a: Infinity, b: 'display only' }, dropB)).toBe('{"a":Infinity}');
});

test('a caller replacer may itself return an infinite number', () => {
    const toInfinity = (key, value) => (value === 'max' ? Infinity : value);

    expect(stringifyJSON({ a: 'max' }, toInfinity)).toBe('{"a":Infinity}');
});

test('a value with no JSON representation still comes back undefined', () => {
    expect(stringifyJSON(undefined)).toBeUndefined();
});

/* -------------------------------------------------------------------------- */
/* Round trip                                                                  */
/* -------------------------------------------------------------------------- */

test('a document holding both signs round-trips byte for byte', () => {
    const source = '{"m_PreInfinity":2,"note":"Infinity war","esc":"a\\"Infinity",'
        + '"outSlope":Infinity,"inSlope":-Infinity}';

    expect(stringifyJSON(parseJSON(source))).toBe(source);
});

const ASSET = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'refs', 'assets', 'JobPreset', 'Theft_D6.json',
);

/**
 * One of the five assets this exists for. The base game's own file rather than a fixture,
 * so the shape being read is the shape the game actually writes.
 */
test('a shipped asset holding Infinity reads and writes it back', async () => {
    const raw = await readFile(ASSET, 'utf8');

    // Fails outright on the built-in, which is the bug.
    expect(() => JSON.parse(raw)).toThrow();

    const document = parseJSON(raw);
    expect(document.socialCreditLevelMinSpawnFrequency.m_Curve[0].outSlope).toBe(Infinity);

    expect(stringifyJSON(document)).toContain(':Infinity');
    expect(stringifyJSON(document)).not.toContain('"outSlope":null');
});

/* -------------------------------------------------------------------------- */
/* The documented limits                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately out of scope -- `fast-json-patch` compares with `===`, so a NaN read as a
 * number would put a meaningless `replace` into every patch on every save. Callers keep
 * reporting the file as unreadable, which is the safe answer.
 */
test('NaN is still refused, which is the documented limit', () => {
    expect(() => parseJSON('{"a":NaN}')).toThrow();
});

test('a NaN in hand is still written as null, as the built-in writes it', () => {
    expect(stringifyJSON({ a: NaN })).toBe('{"a":null}');
});

/**
 * The sentinel collision, pinned so it is a known limit rather than a surprise. It takes
 * NUL bytes around the word inside a Unity-exported string, which is why NUL was chosen.
 */
test('a string built from the sentinel is the one thing that does not survive', () => {
    expect(stringifyJSON({ a: `${NUL}Infinity${NUL}` })).toBe('{"a":Infinity}');
});
