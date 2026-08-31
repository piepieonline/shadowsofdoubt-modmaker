import { describe, expect, it } from 'vitest';
import { ancestryPaths, chain, occurrences } from './reverseSearch.js';

/**
 * The shape the generated index really has: a replacement is held by blocks, a block by
 * messages, a message by trees. Named rather than GUID'd -- nothing here parses a GUID,
 * and a wall of hex is a test nobody can read.
 */
const INDEX = {
    block: ['messageA', 'messageB'],
    messageA: ['tree'],
    messageB: ['tree'],
    replacement: ['block'],
};

const TYPES = {
    tree: 'tree',
    otherTree: 'tree',
    messageA: 'message',
    messageB: 'message',
    loneMessage: 'message',
    block: 'block',
    orphanBlock: 'block',
};

const typeOf = (id) => TYPES[id] ?? null;

describe('ancestryPaths', () => {
    it('walks up to the root, deepest step last', () => {
        expect(ancestryPaths(INDEX, 'messageA')).toEqual([['tree', 'messageA']]);
    });

    it('gives one chain per route to the same document', () => {
        expect(ancestryPaths(INDEX, 'block')).toEqual([
            ['tree', 'messageA', 'block'],
            ['tree', 'messageB', 'block'],
        ]);
    });

    it('walks the whole way up from a replacement inside a block', () => {
        expect(ancestryPaths(INDEX, 'replacement')).toEqual([
            ['tree', 'messageA', 'block', 'replacement'],
            ['tree', 'messageB', 'block', 'replacement'],
        ]);
    });

    it('is one chain for a document nothing holds', () => {
        expect(ancestryPaths(INDEX, 'orphanBlock')).toEqual([['orphanBlock']]);
    });

    it('counts a parent listed twice once: a message played twice is one place', () => {
        expect(ancestryPaths({ block: ['messageA', 'messageA'] }, 'block'))
            .toEqual([['messageA', 'block']]);
    });

    it('stops on a cycle rather than following it forever', () => {
        const cyclic = { a: ['b'], b: ['a'] };

        expect(ancestryPaths(cyclic, 'a')).toEqual([['a', 'b', 'a']]);
    });

    it('has nothing to walk when the index is missing', () => {
        expect(ancestryPaths(undefined, 'block')).toEqual([['block']]);
    });
});

describe('occurrences', () => {
    it('places each step at the level of what it is', () => {
        expect(occurrences(INDEX, typeOf, 'block')).toEqual([
            { tree: 'tree', message: 'messageA', block: 'block' },
            { tree: 'tree', message: 'messageB', block: 'block' },
        ]);
    });

    /*
     * The reason the levels are read by type rather than by position: a searched line is
     * as often a replacement as a block, which makes the chain four steps long against a
     * drill-down three windows deep.
     */
    it('drops the replacement the line is stored against, keeping its block', () => {
        expect(occurrences(INDEX, typeOf, 'replacement')).toEqual([
            { tree: 'tree', message: 'messageA', block: 'block' },
            { tree: 'tree', message: 'messageB', block: 'block' },
        ]);
    });

    it('leaves out the levels nothing holds the line at', () => {
        expect(occurrences({ orphanBlock: ['loneMessage'] }, typeOf, 'orphanBlock'))
            .toEqual([{ message: 'loneMessage', block: 'orphanBlock' }]);
    });

    it('is nothing at all for a line no document says', () => {
        expect(occurrences(INDEX, typeOf, 'unheardOf')).toEqual([]);
    });

    /*
     * The index holds GUIDs the type lists do not: a hundred-odd replacements, and ten
     * blocks it never places under a message. A chain of nothing but those has no window
     * to open, and a row of empty levels would be a row that did nothing when clicked.
     */
    it('is nothing for a chain no level can be read out of', () => {
        expect(occurrences({ replacement: ['unlisted'] }, typeOf, 'replacement')).toEqual([]);
    });

    it('is one row per set of documents, however many chains reach them', () => {
        // Two chains differing only in a step the reference data cannot place -- which
        // it has a hundred of -- describe the same two windows, so they are one row.
        const throughUnplaceable = {
            replacement: ['unlisted1', 'unlisted2'],
            unlisted1: ['messageA'],
            unlisted2: ['messageA'],
        };

        expect(occurrences(throughUnplaceable, typeOf, 'replacement'))
            .toEqual([{ message: 'messageA' }]);
    });
});

describe('chain', () => {
    it('is the documents to open, outermost first', () => {
        expect(chain({ tree: 'tree', message: 'messageA', block: 'block' }))
            .toEqual(['tree', 'messageA', 'block']);
    });

    it('skips a level that has no document', () => {
        expect(chain({ message: 'loneMessage', block: 'orphanBlock' }))
            .toEqual(['loneMessage', 'orphanBlock']);
    });
});
