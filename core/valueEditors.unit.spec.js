import { test, expect, afterEach } from 'vitest';
import { parseEditedValue } from './valueEditors.js';

/**
 * Turning what was typed into a field into the value that gets stored.
 *
 * A string field is quoted on the way in, so typing `null` into one clears it rather
 * than writing the word -- and a value that will not parse comes back to the user
 * prefilled rather than being discarded or written as text.
 *
 * `prompt` is stubbed here to stand in for that user, which is what
 * tests/support/harness.js does for the Playwright suite. Nothing else is stubbed: the
 * function reaches no further.
 */

const answerPrompts = (...answers) => {
    const queued = [...answers];
    const calls = [];
    globalThis.prompt = (message, defaultValue) => {
        calls.push({ message: String(message), defaultValue });
        return queued.length ? queued.shift() : null;
    };
    return calls;
};

afterEach(() => { delete globalThis.prompt; });

test('a string field stores what was typed, quoted', () => {
    expect(parseEditedValue('Hello', { isString: true })).toEqual({
        ok: true, value: 'Hello', raw: 'Hello',
    });
});

test('a comma typed into a string field is part of the value, not a break in it', () => {
    expect(parseEditedValue('Wait, listen to me', { isString: true }).value)
        .toBe('"Wait, listen to me"');
});

test('typing null into a string field clears it rather than writing the word', () => {
    expect(parseEditedValue('null', { isString: true })).toEqual({
        ok: true, value: null, raw: 'null',
    });
});

test('a non-string field parses what was typed as JSON', () => {
    expect(parseEditedValue('42', { isString: false }).value).toBe(42);
    expect(parseEditedValue('true', { isString: false }).value).toBe(true);
    expect(parseEditedValue('[1, 2]', { isString: false }).value).toEqual([1, 2]);
});

test('a value that will not parse comes back prefilled until it does', () => {
    const calls = answerPrompts('7');

    // `{oops` is not JSON. The user is asked, corrects it, and the corrected value is
    // what gets stored.
    expect(parseEditedValue('{oops', { isString: false })).toEqual({
        ok: true, value: 7, raw: '7',
    });

    // Prefilled with the text that was rejected, so nothing has to be retyped.
    expect(calls).toHaveLength(1);
    expect(calls[0].defaultValue).toBe('{oops');
});

test('giving up on a value leaves the field alone', () => {
    answerPrompts();

    // No `value` and no `raw`: the caller puts back what was there before.
    expect(parseEditedValue('{oops', { isString: false })).toEqual({ ok: false });
});
