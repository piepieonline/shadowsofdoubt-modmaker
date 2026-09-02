import { describe, test, expect } from 'vitest';
import { enums, typeLayout } from '../../../core/refs.js';
import { resolveField } from '../../../core/typeHints.js';
import {
    NEWSPAPER_CATEGORIES, newspaperContexts, newspaperOptions, unnamedValueOption,
} from './newspaperFields.js';

/**
 * The two fields the game reads as numbers and this editor shows as lists.
 *
 * The risk being tested for is a list that does not mean what the field means. Both are
 * `Int32` with no enum behind them, so nothing in the generated reference data can catch a
 * list that has drifted -- and the nearest thing that looks like it would (`Category`) is
 * a different field's enum with different meanings for the same numbers.
 */

const at = (ownerType, field) => resolveField([ownerType, field], typeLayout);

describe('newspaperOptions', () => {
    test('answers for the two fields and nothing else', () => {
        expect(newspaperOptions(at('DDSTreeSave', 'newspaperCategory')))
            .toBe(NEWSPAPER_CATEGORIES);
        expect(newspaperOptions(at('DDSTreeSave', 'newspaperContext')))
            .toEqual(enums.ContextSource);

        // Another Int32 on the same type is still a number.
        expect(newspaperOptions(at('DDSTreeSave', 'priority'))).toBeNull();
        expect(newspaperOptions(at('DDSMessageSettings', 'order'))).toBeNull();
        expect(newspaperOptions(null)).toBeNull();
    });

    test('both fields are the plain integers the layout says they are', () => {
        // If the game ever gives these a real enum, the layout will say so and this
        // module becomes the wrong way to do it.
        expect(at('DDSTreeSave', 'newspaperCategory').type).toBe('Int32');
        expect(at('DDSTreeSave', 'newspaperContext').type).toBe('Int32');
    });
});

describe('the category list', () => {
    test('covers every value the shipped trees use', () => {
        // 0-8. The shipped newspaper trees reach 8 -- Kidnapper_Caught_01 -- and a list
        // that stopped short would leave those trees showing nothing for their own value.
        expect(NEWSPAPER_CATEGORIES).toHaveLength(9);
    });

    test('is not the Category enum, which means different things by the same numbers', () => {
        // The trap this module exists to avoid. `Category` belongs to NewspaperArticle,
        // the separate .newspaper file: its 1 is `murder` where this field's 1 is a
        // classified ad, and its 2 is `ad` where this field's 2 is foreign affairs.
        expect(enums.Category).toHaveLength(5);
        expect(NEWSPAPER_CATEGORIES.length).toBeGreaterThan(enums.Category.length);
        expect(NEWSPAPER_CATEGORIES[1]).toMatch(/classified ad/i);
        expect(NEWSPAPER_CATEGORIES[2]).toMatch(/foreign affairs/i);
    });

    test('names the murder and kidnapping leads in the order the controller checks them', () => {
        expect(NEWSPAPER_CATEGORIES[3]).toMatch(/first murder/i);
        expect(NEWSPAPER_CATEGORIES[5]).toMatch(/killer caught/i);
        expect(NEWSPAPER_CATEGORIES[6]).toMatch(/first kidnapping/i);
        expect(NEWSPAPER_CATEGORIES[8]).toMatch(/kidnapper caught/i);
    });
});

describe('the context list', () => {
    test('is the game\'s own enum rather than a copy of it', () => {
        // ContextSource matches the field value for value, so it is reused. A copy would
        // be a second thing to keep in step with the game.
        expect(newspaperContexts()).toBe(enums.ContextSource);
        expect(newspaperContexts()).toEqual([
            'nothing', 'lastMurder', 'player', 'randomCitizen', 'randomCriminal', 'randomGroup',
        ]);
    });

    test('stops where the authored values stop', () => {
        // 6 and above is `humanID = value - 6`, written at runtime and never authored.
        expect(newspaperContexts()).toHaveLength(6);
    });
});

describe('unnamedValueOption', () => {
    test('adds nothing when the list already names the value', () => {
        expect(unnamedValueOption(NEWSPAPER_CATEGORIES, 0)).toEqual([]);
        expect(unnamedValueOption(NEWSPAPER_CATEGORIES, 8)).toEqual([]);
        expect(unnamedValueOption(newspaperContexts(), 5)).toEqual([]);
        // The rendered value arrives as text from the tree.
        expect(unnamedValueOption(newspaperContexts(), '3')).toEqual([]);
    });

    test('shows a runtime context rather than claiming the file says something else', () => {
        // Without this the control selects nothing, displays its first option, and the
        // editor reads as `nothing` over a file that says 7.
        const [option] = unnamedValueOption(newspaperContexts(), 7);

        expect(option.value).toBe(7);
        expect(option.text).toContain('7');
    });

    test('covers a value below the list as well as above it', () => {
        expect(unnamedValueOption(NEWSPAPER_CATEGORIES, 9)).toHaveLength(1);
        expect(unnamedValueOption(NEWSPAPER_CATEGORIES, -1)).toHaveLength(1);
    });

    test('leaves a value that is not a whole number alone', () => {
        // Nothing useful to offer for it, and inventing an option would put a number in
        // the control that the file does not hold.
        expect(unnamedValueOption(NEWSPAPER_CATEGORIES, '')).toEqual([]);
        expect(unnamedValueOption(NEWSPAPER_CATEGORIES, 'null')).toEqual([]);
        expect(unnamedValueOption(NEWSPAPER_CATEGORIES, 1.5)).toEqual([]);
    });
});
