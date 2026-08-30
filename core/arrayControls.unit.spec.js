import { test, expect } from 'vitest';
import { controlsFor, interpretPaste } from './arrayControls.js';

/**
 * The two decisions behind the array buttons: which of them a node gets, and what the
 * text on the clipboard means for the node it is being pasted onto.
 *
 * The buttons themselves are DOM, and are covered by tests/arrayControls.spec.js
 * against a real page -- see tests/README.md for the line between the suites.
 */

test('an array can be added to, copied and pasted over', () => {
    expect(controlsFor({ isArray: true, isElement: false }))
        .toEqual(['add', 'copy', 'paste']);
});

test('an element can be removed, copied and pasted over, but not added to', () => {
    expect(controlsFor({ isArray: false, isElement: true }))
        .toEqual(['remove', 'copy', 'paste']);
});

test('an array inside an array is both, with one copy and one paste', () => {
    // Replacing that element and replacing that array are the same operation read two
    // ways, so there is no second pair of buttons for it.
    expect(controlsFor({ isArray: true, isElement: true }))
        .toEqual(['add', 'remove', 'copy', 'paste']);
});

test('no + on an array this flow cannot build an element of', () => {
    expect(controlsFor({ isArray: true, isElement: false, canAdd: false }))
        .toEqual(['copy', 'paste']);
});

test('a read-only document can still be copied out of, and nothing else', () => {
    expect(controlsFor({ isArray: true, isElement: true, readOnly: true })).toEqual(['copy']);
});

test('anything that is neither an array nor an element gets no buttons', () => {
    expect(controlsFor({ isArray: false, isElement: false })).toEqual([]);
});

test('an element is pasted as whatever JSON value the clipboard holds', () => {
    expect(interpretPaste('{"msgID": "abc"}', { intoArray: false }))
        .toEqual({ ok: true, value: { msgID: 'abc' } });
    expect(interpretPaste('"a trait"', { intoArray: false }))
        .toEqual({ ok: true, value: 'a trait' });
});

test('an array is pasted whole', () => {
    expect(interpretPaste('[1, 2]', { intoArray: true })).toEqual({ ok: true, value: [1, 2] });
});

test('a single element pasted onto an array says where it should go instead', () => {
    const result = interpretPaste('{"msgID": "abc"}', { intoArray: true });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('single element');
});

test('an array pasted onto an element is allowed: an element can be an array', () => {
    expect(interpretPaste('[1, 2]', { intoArray: false })).toEqual({ ok: true, value: [1, 2] });
});

test('text that is not JSON is reported rather than stored', () => {
    const result = interpretPaste('not json at all', { intoArray: false });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('not JSON');
});

test('an empty clipboard is nothing to paste rather than something to complain about', () => {
    for (const text of [null, '', '   ']) {
        expect(interpretPaste(text, { intoArray: false })).toEqual({ ok: false });
    }
});
