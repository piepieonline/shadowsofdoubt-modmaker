import { test, expect } from 'vitest';
import {
    makeNameFieldSafe, isNameFieldSafe, makeCSVSafe, capitalizeFirstLetter,
} from './strings.js';

/**
 * The string helpers everything the app writes passes through.
 *
 * A preset name ends up in a `REF:` string, in a strings CSV key and in a file name, so
 * what `makeNameFieldSafe` lets through decides whether a mod loads. `makeCSVSafe`
 * returns JSON-encoded text that callers JSON.parse back out, which is easy to read as
 * a plain quoting helper and is not one.
 */

test('a name keeps letters, digits, hyphen and underscore, and loses the rest', () => {
    expect(makeNameFieldSafe('Hotel_GroundFloor')).toBe('Hotel_GroundFloor');
    expect(makeNameFieldSafe('Tall-Tower_2')).toBe('Tall-Tower_2');
    expect(makeNameFieldSafe('My Tower!')).toBe('MyTower');
    expect(makeNameFieldSafe('a/b\\c.d')).toBe('abcd');
});

test('a name that is nothing but punctuation comes back empty', () => {
    // Worth pinning, because the caller has to refuse rather than write a file called ''.
    expect(makeNameFieldSafe('!!!')).toBe('');
    expect(makeNameFieldSafe('')).toBe('');
});

test('a name is safe only when nothing would be taken out of it', () => {
    expect(isNameFieldSafe('Hotel_GroundFloor')).toBe(true);
    expect(isNameFieldSafe('My Tower')).toBe(false);
});

test('an empty name is never safe', () => {
    // The length check is what stops '' passing: nothing is removed from it either.
    expect(isNameFieldSafe('')).toBe(false);
    expect(isNameFieldSafe('!!!')).toBe(false);
});

test('a plain value comes back as a JSON string, quotes and all', () => {
    expect(makeCSVSafe('Hello')).toBe('"Hello"');
    expect(JSON.parse(makeCSVSafe('Hello'))).toBe('Hello');
});

test('a value with a comma gains the quotes that keep it one field', () => {
    const encoded = makeCSVSafe('Wait, listen to me');

    // The inner pair is what survives JSON.parse, and is what the game reads as one
    // field rather than two columns.
    expect(JSON.parse(encoded)).toBe('"Wait, listen to me"');
});

test('a backslash is escaped so the result still parses', () => {
    expect(JSON.parse(makeCSVSafe('C:\\Games'))).toBe('C:\\Games');
});

test('capitalising touches the first character and nothing else', () => {
    expect(capitalizeFirstLetter('hotel')).toBe('Hotel');
    expect(capitalizeFirstLetter('Hotel')).toBe('Hotel');
    expect(capitalizeFirstLetter('hOTEL')).toBe('HOTEL');
    expect(capitalizeFirstLetter('')).toBe('');
});
