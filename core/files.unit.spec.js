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

test('a clone goes through JSON, so what JSON drops is dropped', () => {
    // Worth stating rather than discovering: templates are JSON files, so nothing here
    // ever carries a function or an undefined -- but a caller reaching for this to copy
    // a live object would lose both silently.
    const copy = deepClone({ kept: 1, gone: undefined, alsoGone: () => {} });

    expect(copy).toEqual({ kept: 1 });
    expect(Object.keys(copy)).toEqual(['kept']);
});
