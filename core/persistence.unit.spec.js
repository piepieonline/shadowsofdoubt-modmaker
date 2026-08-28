import { test, expect } from 'vitest';
import { toSaveSafeJSON, shouldSave } from './persistence.js';

/**
 * What gets written, and what is dropped on the way.
 *
 * `dummyKeys` maps NAME -> actual key, so the keys to strip are its *values*. Reading
 * its keys instead meant nothing was ever stripped, and the DDS flow's resolved English
 * text leaked into every block it saved -- a value that only ever existed to be looked
 * at, written into the mod as though an author had typed it.
 *
 * Writing itself takes a directory handle and stays in the Playwright suite.
 */

/** As a flow declares them: the display name, against the key it is stored under. */
const DUMMY_KEYS = { ENGLISH_TEXT: 'dummy_englishText', PRESET_NAME: 'dummy_presetName' };

test('a display-only key is dropped, by its value rather than its name', () => {
    const written = JSON.parse(toSaveSafeJSON({
        msgID: 'GREETING',
        dummy_englishText: 'Hello there',
    }, DUMMY_KEYS));

    expect(written).toEqual({ msgID: 'GREETING' });
});

test('the name a display key is declared under is not itself stripped', () => {
    // The bug in reverse: a document with a real field called ENGLISH_TEXT must keep it.
    const written = JSON.parse(toSaveSafeJSON({ ENGLISH_TEXT: 'a real value' }, DUMMY_KEYS));

    expect(written).toEqual({ ENGLISH_TEXT: 'a real value' });
});

test('display keys are dropped wherever they are nested', () => {
    const written = JSON.parse(toSaveSafeJSON({
        messages: [
            { msgID: 'A', dummy_englishText: 'one' },
            { msgID: 'B', dummy_presetName: 'two' },
        ],
    }, DUMMY_KEYS));

    expect(written).toEqual({ messages: [{ msgID: 'A' }, { msgID: 'B' }] });
});

test('autosave is opt-out, and an explicit Save always writes', () => {
    // `enabled` starts true in core/autosave.js and is only ever changed through the
    // header switch, which is a page concern -- so the off branch is checked in
    // tests/ddsStrings.spec.js, where the switch can actually be turned off.
    expect(shouldSave(true)).toBe(true);
    expect(shouldSave(false)).toBe(true);
});
