import { test, expect } from 'vitest';
import { conventionalParent } from './newContent.js';

/**
 * Where a new content folder should go.
 *
 * Mods disagree about layout -- content sits at the mod root, one level down, or under
 * the BepInEx plugins/ convention -- and a loader is usually configured for one of
 * them. So new content copies what the mod already does rather than picking a house
 * style, and creating the folder itself stays in the Playwright suite.
 */

const at = (...paths) => paths.map((path) => ({ path }));

test('a mod that keeps content in a folder gets its new one there too', () => {
    expect(conventionalParent(at('plugins/Cases/One', 'plugins/Cases/Two'))).toBe('plugins/Cases');
});

test('a mod whose only content is its root has no convention to copy', () => {
    // Nothing to go by, so new content goes alongside at the root.
    expect(conventionalParent(at(''))).toBe('');
    expect(conventionalParent([])).toBe('');
});

test('the most common parent decides it, not the first one', () => {
    expect(conventionalParent(at('odd/One', 'plugins/Two', 'plugins/Three'))).toBe('plugins');
});

test('a tie is broken by name, so the answer does not depend on read order', () => {
    // Two folders each, and a directory listing is not ordered -- picking whichever
    // arrived first would put the same mod's content in a different place each time.
    const forwards = conventionalParent(at('alpha/One', 'beta/Two', 'alpha/Three', 'beta/Four'));
    const backwards = conventionalParent(at('beta/Four', 'alpha/Three', 'beta/Two', 'alpha/One'));

    expect(forwards).toBe('alpha');
    expect(backwards).toBe('alpha');
});
