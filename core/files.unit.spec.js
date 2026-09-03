import { test, expect } from 'vitest';
import { deepClone } from './files.js';

/**
 * The structural copy every template instantiation goes through.
 *
 * Creating the file itself takes a directory handle and stays in the Playwright suite.
 * What matters here is that a template is not shared with the document made from it:
 * editing one document must not change the next one created from the same template.
 */

test('a clone is a copy all the way down, not a second reference', () => {
    const template = { name: 'Thing', messages: [{ msgID: 'A' }], nested: { deep: { value: 1 } } };
    const copy = deepClone(template);

    expect(copy).toEqual(template);

    copy.messages[0].msgID = 'B';
    copy.nested.deep.value = 2;

    expect(template.messages[0].msgID).toBe('A');
    expect(template.nested.deep.value).toBe(1);
});

/**
 * This used to go through JSON and pinned what JSON dropped -- an `undefined` property and
 * a function, both silently. It is `structuredClone` now, because the JSON round trip also
 * wrote `null` for Unity's `Infinity` and this is what `applyPatches` and `diffToPatches`
 * copy a base document with. See core/jsonNumbers.js.
 *
 * The old comment here called the silent loss out as the hazard, and that is what changes:
 * `undefined` survives, and a function throws where it used to vanish.
 */
test('a clone keeps what JSON would have dropped', () => {
    const copy = deepClone({ kept: 1, held: undefined });

    expect(Object.keys(copy)).toEqual(['kept', 'held']);
    expect(copy.held).toBeUndefined();
});

test('a clone of something JSON cannot hold fails loudly rather than silently', () => {
    // Templates are parsed from JSON files, so nothing here carries a function. If that
    // stops being true, this is the failure that says so -- where the JSON round trip
    // would have dropped it and left a template quietly missing a field.
    expect(() => deepClone({ alsoGone: () => {} })).toThrow();
});

test('a clone carries an infinite number, which is why it is not a JSON round trip', () => {
    // The five JobPreset assets hold one in an AnimationCurve. Cloned to null, a patch
    // made against one of them replaced the game's value with nothing.
    expect(deepClone({ outSlope: Infinity })).toEqual({ outSlope: Infinity });
    expect(deepClone({ outSlope: -Infinity }).outSlope).toBe(-Infinity);
    expect(JSON.parse(JSON.stringify({ outSlope: Infinity }))).toEqual({ outSlope: null });
});
