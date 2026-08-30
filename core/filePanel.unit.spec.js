import { describe, it, expect } from 'vitest';
import { filterCategories } from './filePanel.js';

/**
 * Narrowing the file panel by a free-text search.
 *
 * Rendering needs a page and is covered in tests/soFilePanel.spec.js. What is decided
 * here is which files a query leaves, which is the part worth pinning: a search that
 * quietly drops a file the author is looking for is indistinguishable from the file
 * not being there.
 */

const categories = () => [
    {
        id: 'MurderMO',
        label: 'MurderMO',
        entries: [
            { id: 'testcase', label: 'testcase' },
            { id: 'AnotherMurder', label: 'AnotherMurder' },
        ],
    },
    {
        id: 'InteractablePreset',
        label: 'InteractablePreset',
        entries: [{ id: 'IP_Note', label: 'IP_Note' }],
    },
];

/** What a filtered panel would show, as `Category: entry, entry`. */
const shown = (result) =>
    result.map((category) => `${category.label}: ${category.entries.map((e) => e.label).join(', ')}`);

describe('filterCategories', () => {
    it('keeps entries whose name contains the query', () => {
        expect(shown(filterCategories(categories(), 'note'))).toEqual(['InteractablePreset: IP_Note']);
        expect(shown(filterCategories(categories(), 'case'))).toEqual(['MurderMO: testcase']);
    });

    it('ignores case, and the space around what was typed', () => {
        expect(shown(filterCategories(categories(), '  ip_NOTE '))).toEqual(['InteractablePreset: IP_Note']);
    });

    it('keeps everything under a heading that matches', () => {
        // Searching for a type is asking what the mod has of that type. Only the
        // category's own entries answer that -- an entry called MurderMO would too, and
        // there is none here.
        expect(shown(filterCategories(categories(), 'MurderMO')))
            .toEqual(['MurderMO: testcase, AnotherMurder']);
    });

    it('drops a category with nothing matching in it', () => {
        expect(filterCategories(categories(), 'AnotherMurder').map((c) => c.id)).toEqual(['MurderMO']);
    });

    it('opens what survives', () => {
        // A match inside a category that was collapsed is a match the author cannot see.
        const collapsed = [{ ...categories()[0], open: false }];
        expect(filterCategories(collapsed, 'testcase')[0].open).toBe(true);
    });

    it('answers with nothing when nothing matches', () => {
        expect(filterCategories(categories(), 'nosuchfile')).toEqual([]);
    });

    it('narrows sections, and keeps the ones holding a match', () => {
        const nested = [{
            id: 'Building',
            label: 'Building',
            sections: [
                { id: 'floor-1', label: 'Ground floor', entries: [{ id: 'lobby', label: 'lobby' }] },
                { id: 'floor-2', label: 'First floor', entries: [{ id: 'office', label: 'office' }] },
            ],
        }];

        const [building] = filterCategories(nested, 'office');
        expect(building.sections.map((s) => s.id)).toEqual(['floor-2']);
        expect(building.entries).toEqual([]);
    });

    it('hands back what it was given when nothing was typed', () => {
        // Not a filter, so not a rebuild: a panel that has not been searched is the
        // panel the flow built, in the state it built it in.
        const built = categories();
        expect(filterCategories(built, '')).toBe(built);
        expect(filterCategories(built, '   ')).toBe(built);
        expect(filterCategories(built, undefined)).toBe(built);
    });

    it('leaves an unlisted panel unlisted', () => {
        // Null is renderFilePanel's "there is nothing to list", which is not the same
        // as a folder whose files have all been searched out.
        expect(filterCategories(null, 'anything')).toBeNull();
    });
});
