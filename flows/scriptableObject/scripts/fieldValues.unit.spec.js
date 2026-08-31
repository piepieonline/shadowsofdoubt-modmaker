/**
 * Grouping one field's values across a set of documents.
 *
 * The two things worth pinning are what happens to a list -- flattened when the path runs
 * through it, taken whole when the path ends at it -- and that "no asset has this value"
 * and "the asset does not have this field" stay different answers all the way to the row.
 */
import { describe, test, expect } from 'vitest';

import {
    ABSENT, NO_ELEMENTS, valuesOf, describeValue, summariseField, prettyPath,
} from './fieldValues.js';

/** A record as assetScan.js produces one. */
const asset = (name, document, source = 'game') => ({ name, source, document });

const displays = (result) => result.rows.map((row) => row.display);
const named = (result, display) => result.rows.find((row) => row.display === display);


describe('reaching the value', () => {
    test('a field at the root, and one nested under it', () => {
        const document = { baseDifficulty: 3, hexaco: { humility: 5 } };

        expect(valuesOf(document, ['baseDifficulty'])).toEqual([3]);
        expect(valuesOf(document, ['hexaco', 'humility'])).toEqual([5]);
    });

    test('a list the path runs through contributes one value per element', () => {
        const document = { modifiers: [{ rule: 0 }, { rule: 2 }, { rule: 0 }] };

        expect(valuesOf(document, ['modifiers', 'rule'])).toEqual([0, 2, 0]);
    });

    test('a list the path ends at is one value, taken whole', () => {
        const document = { modifiers: [{ rule: 0 }, { rule: 2 }] };

        expect(valuesOf(document, ['modifiers'])).toEqual([[{ rule: 0 }, { rule: 2 }]]);
    });

    test('lists nest, and every element of every one contributes', () => {
        const document = { outer: [{ inner: [{ v: 1 }, { v: 2 }] }, { inner: [{ v: 3 }] }] };

        expect(valuesOf(document, ['outer', 'inner', 'v'])).toEqual([1, 2, 3]);
    });

    /**
     * The distinction the table is built on: an empty list means the asset has the field
     * and put nothing in it, which is a fact about the asset. A missing field means the
     * document is not shaped the way the type says.
     */
    test('an empty list on the way is not the same as a missing field', () => {
        expect(valuesOf({ modifiers: [] }, ['modifiers', 'rule'])).toEqual([NO_ELEMENTS]);
        expect(valuesOf({}, ['modifiers', 'rule'])).toEqual([ABSENT]);
    });

    test('a field explicitly set to null is a value, not an absence', () => {
        expect(valuesOf({ weapon: null }, ['weapon'])).toEqual([null]);
    });

    test('a path asking for a field of something with no fields is absent', () => {
        expect(valuesOf({ hexaco: 4 }, ['hexaco', 'humility'])).toEqual([ABSENT]);
    });

    test('one element missing the field does not hide the others', () => {
        const document = { modifiers: [{ rule: 1 }, {}, { rule: 1 }] };

        expect(valuesOf(document, ['modifiers', 'rule'])).toEqual([1, ABSENT, 1]);
    });
});


describe('naming a value', () => {
    test('scalars stand for themselves', () => {
        expect(describeValue(3)).toMatchObject({ key: '3', display: '3', kind: 'text' });
        expect(describeValue(false)).toMatchObject({ display: 'false', kind: 'text' });
        expect(describeValue('Blunt')).toMatchObject({ display: 'Blunt', kind: 'text' });
    });

    test('an enum keeps the number the file holds and adds what it means', () => {
        const enumValues = ['none', 'blunt', 'sharp'];

        expect(describeValue(1, { enumValues }))
            .toMatchObject({ key: '1', display: '1 — blunt', kind: 'enum' });
    });

    /** Better than labelling it with whatever name happens to sit at that index. */
    test('an enum value outside the list says so rather than guessing', () => {
        expect(describeValue(9, { enumValues: ['none', 'blunt'] }).display)
            .toBe('9 — not in the enum');
    });

    test('a reference is shown as the asset it names', () => {
        expect(describeValue('REF:CharacterTrait|Sniper'))
            .toMatchObject({ display: 'CharacterTrait|Sniper', kind: 'reference' });
    });

    test('the three ways of holding nothing are told apart', () => {
        expect(describeValue(null).display).toBe('(null)');
        expect(describeValue([]).display).toBe('(empty list)');
        expect(describeValue(ABSENT).display).toBe('(field absent)');
        expect(describeValue(NO_ELEMENTS).display).toBe('(no elements)');
    });

    /**
     * Two blocks saying the same thing are one value. The game's own assets are emitted in
     * a stable order, but a mod's file is written by whatever produced it.
     */
    test('objects group on their content rather than on their key order', () => {
        expect(describeValue({ x: 1, y: 2 }).key).toBe(describeValue({ y: 2, x: 1 }).key);
        expect(describeValue({ x: 1, y: 2 }).display).toBe('{"x":1,"y":2}');
    });
});


describe('the table', () => {
    const records = [
        asset('Bartender', { baseDifficulty: 0 }),
        asset('Hitman', { baseDifficulty: 1 }),
        asset('Sniper', { baseDifficulty: 0 }),
        asset('MyKiller', { baseDifficulty: 0 }, 'mod'),
    ];

    test('a row per value, commonest first, carrying the assets that hold it', () => {
        const result = summariseField(records, ['baseDifficulty']);

        expect(displays(result)).toEqual(['0', '1']);
        expect(named(result, '0').count).toBe(3);
        expect(named(result, '0').assets.map((entry) => entry.name))
            .toEqual(['Bartender', 'Sniper', 'MyKiller']);
        expect(result.assets).toBe(4);
    });

    /** The source is the summary's to show and not this module's to interpret. */
    test('where an asset came from is carried through untouched', () => {
        const result = summariseField(records, ['baseDifficulty']);

        expect(named(result, '0').assets.at(-1)).toEqual({ name: 'MyKiller', source: 'mod' });
    });

    /**
     * An asset holding the same value five times in a list is one asset carrying it. Both
     * numbers are reported because both are asked: how many assets, and how often.
     */
    test('an asset counts once against a value however many times it holds it', () => {
        const result = summariseField(
            [asset('Hitman', { modifiers: [{ rule: 1 }, { rule: 1 }, { rule: 2 }] })],
            ['modifiers', 'rule']);

        expect(named(result, '1')).toMatchObject({ count: 1, occurrences: 2 });
        expect(named(result, '2')).toMatchObject({ count: 1, occurrences: 1 });
        expect(result.occurrences).toBe(3);
    });

    test('ties sort numerically, so 2 comes before 10', () => {
        const result = summariseField([
            asset('A', { level: 10 }), asset('B', { level: 2 }), asset('C', { level: 9 }),
        ], ['level']);

        expect(displays(result)).toEqual(['2', '9', '10']);
    });

    /**
     * A field most of a type does not carry would otherwise head the table, which reads as
     * a value that is common rather than as a shape that is unusual.
     */
    test('what is not a value sits at the foot of the table, however common', () => {
        const result = summariseField([
            asset('A', {}), asset('B', {}), asset('C', {}), asset('D', { level: 4 }),
        ], ['level']);

        expect(displays(result)).toEqual(['4', '(field absent)']);
        expect(named(result, '(field absent)').count).toBe(3);
    });

    test('no documents at all is an empty table rather than a throw', () => {
        expect(summariseField([], ['level'])).toEqual({ rows: [], assets: 0, occurrences: 0 });
    });
});


describe('naming the field', () => {
    const typeLayout = {
        MurderMO: {
            murdererTraitModifiers: { Item1: 'TraitModifier', Item2: true },
            hexaco: { Item1: 'Hexaco', Item2: false },
        },
        TraitModifier: { rule: { Item1: 'Rule', Item2: false } },
        Hexaco: { humility: { Item1: 'Int32', Item2: false } },
    };

    test('a list the path runs through is marked, so the row count is not misread', () => {
        expect(prettyPath('MurderMO', ['murdererTraitModifiers', 'rule'], typeLayout))
            .toBe('MurderMO.murdererTraitModifiers[].rule');
    });

    /** The whole list is one value, and `[]` here would say the opposite. */
    test('a list the path ends at is not marked', () => {
        expect(prettyPath('MurderMO', ['murdererTraitModifiers'], typeLayout))
            .toBe('MurderMO.murdererTraitModifiers');
    });

    test('a field the layout cannot describe still gets a name', () => {
        expect(prettyPath('MurderMO', ['whatIsThis', 'inner'], typeLayout))
            .toBe('MurderMO.whatIsThis.inner');
    });

    test('nesting reads as it does in the document', () => {
        expect(prettyPath('MurderMO', ['hexaco', 'humility'], typeLayout))
            .toBe('MurderMO.hexaco.humility');
    });
});
