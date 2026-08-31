import { describe, it, expect } from 'vitest';
import { filterCategories, withoutEntries, countEntries } from './filePanel.js';

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

/**
 * Taking out what the author has asked not to be shown at all -- the other half of
 * narrowing a panel, and the more dangerous half: a search is a thing being typed and a
 * filter is a state left switched on, so a file dropped here is one nothing on the screen
 * explains the absence of. The flow says how many went; this decides which.
 */
describe('withoutEntries', () => {
    const unwanted = (entry) => entry.id === 'AnotherMurder';

    it('drops the entries the predicate names', () => {
        expect(shown(withoutEntries(categories(), unwanted)))
            .toEqual(['MurderMO: testcase', 'InteractablePreset: IP_Note']);
    });

    it('drops a category it empties', () => {
        expect(withoutEntries(categories(), (entry) => entry.id.startsWith('IP_')).map((c) => c.id))
            .toEqual(['MurderMO']);
    });

    it('leaves what survives in the state the flow built it in', () => {
        // Unlike a search, which forces open whatever it leaves. A filter says what the
        // panel is made of rather than where in it to look, so a category the author had
        // collapsed stays collapsed.
        const collapsed = [{ ...categories()[0], open: false }];

        expect(withoutEntries(collapsed, unwanted)[0].open).toBe(false);
    });

    it('reaches into sections', () => {
        const nested = [{
            id: 'Building',
            label: 'Building',
            sections: [
                { id: 'floor-1', label: 'Ground floor', entries: [{ id: 'lobby', label: 'lobby' }] },
                { id: 'floor-2', label: 'First floor', entries: [{ id: 'office', label: 'office' }] },
            ],
        }];

        const [building] = withoutEntries(nested, (entry) => entry.id === 'lobby');
        expect(building.sections.map((s) => s.id)).toEqual(['floor-2']);
    });

    it('hands back what it was given when nothing was taken out', () => {
        const built = categories();

        expect(withoutEntries(built, () => false)).toBe(built);
        expect(withoutEntries(built, null)).toBe(built);
        expect(withoutEntries(null, unwanted)).toBeNull();
    });

    it('keeps a category that was already empty', () => {
        // Nothing was taken out of it, so there is nothing for this to have decided. An
        // empty category is the flow's statement that it has none of that type, and this
        // is not the thing that gets to retract it.
        const empty = [{ id: 'MurderMO', label: 'MurderMO', entries: [{ id: 'gone', label: 'gone' }] },
            { id: 'Empty', label: 'Empty', entries: [] }];

        expect(withoutEntries(empty, (entry) => entry.id === 'gone').map((c) => c.id))
            .toEqual(['Empty']);
    });
});

describe('countEntries', () => {
    it('counts through whatever nesting a category has', () => {
        expect(countEntries(categories()[0])).toBe(2);

        expect(countEntries({
            id: 'Building',
            entries: [{ id: 'roof' }],
            sections: [
                { id: 'floor-1', entries: [{ id: 'lobby' }, { id: 'stairs' }] },
                { id: 'floor-2', entries: [{ id: 'office' }] },
            ],
        })).toBe(4);
    });

    it('counts nothing as nothing', () => {
        expect(countEntries({ id: 'Empty' })).toBe(0);
    });
});
