import { test, expect } from 'vitest';
import {
    CORE_PARAMS, MAX_QUERY_LENGTH, buildSearch, decodeList, encodeList, parseState,
} from './urlState.js';

/**
 * The URL as the record of what you are working on.
 *
 * The risk is in `buildSearch`, and it is the risk of a *partial* write: every caller
 * changes one thing -- the flow, the selection, what is open -- and must leave the rest
 * of the query exactly as it found it. A merge that drops a parameter it was not asked
 * about loses work on the next refresh, silently.
 */

test('core parameters and the flow\'s are told apart by name', () => {
    const state = parseState('?flow=dds&mod=TestMod&content=Content&open=["a.tree"]&strings=en.csv');

    expect(state.flow).toBe('dds');
    expect(state.mod).toBe('TestMod');
    expect(state.content).toBe('Content');
    // Everything core does not own belongs to the flow, whatever it is called.
    expect(state.params).toEqual({ open: '["a.tree"]', strings: 'en.csv' });
});

test('an empty content path is a selection, and a missing one is not', () => {
    // A content folder at the mod root has an empty path -- see core/modSelection.js.
    expect(parseState('?mod=TestMod&content=').content).toBe('');
    expect(parseState('?mod=TestMod').content).toBe(null);

    expect(buildSearch('', { flow: 'dds', mod: 'TestMod', content: '' }))
        .toBe('flow=dds&mod=TestMod&content=');
});

test('demo mode is core\'s, so a flow never sees it and never clears it', () => {
    expect(CORE_PARAMS).toContain('demo');
    expect(parseState('?demo&flow=dds&open=["a"]').params).toEqual({ open: '["a"]' });

    const search = buildSearch('?demo=&flow=dds&open=["a"]', {
        params: { open: '["b"]' },
        clearKeys: ['open'],
    });
    expect(new URLSearchParams(search).has('demo')).toBe(true);
});

test('a change leaves alone what it does not mention', () => {
    const before = '?flow=dds&mod=TestMod&content=Content&open=["a.tree"]';

    // Selecting a different mod says nothing about the flow.
    const after = buildSearch(before, { mod: 'Other' });
    expect(new URLSearchParams(after).get('flow')).toBe('dds');
    expect(new URLSearchParams(after).get('mod')).toBe('Other');
    // Nor about what was open: clearing that is the caller's to ask for.
    expect(new URLSearchParams(after).get('open')).toBe('["a.tree"]');
});

test('the previous flow\'s parameters are cleared rather than inherited', () => {
    // Both flows call their document list `open`; only the building flow has `floor`.
    // Without clearKeys the building flow's parameters would linger into the DDS flow,
    // which would read `open` as its own.
    const search = buildSearch('?flow=building&floor=Apartment/Ground/0&tool=paint', {
        flow: 'dds',
        params: { open: '["a.tree"]' },
        clearKeys: ['floor', 'tool'],
    });

    expect(search).toBe('flow=dds&open=%5B%22a.tree%22%5D');
});

test('a content path cannot outlive the mod it is a path within', () => {
    const search = buildSearch('?flow=dds&mod=TestMod&content=Content', { mod: null });
    expect(search).toBe('flow=dds');
});

test('an empty value removes a parameter rather than writing it empty', () => {
    const search = buildSearch('?flow=dds&open=["a.tree"]&strings=en.csv', {
        params: { open: '["a.tree"]', strings: null },
        clearKeys: ['open', 'strings'],
    });

    expect(search).toBe('flow=dds&open=%5B%22a.tree%22%5D');
});

test('a flow cannot claim a parameter core owns', () => {
    // Caught here rather than by the flow silently losing its state to a core writer.
    expect(() => buildSearch('', { params: { mod: 'Sneaky' } })).toThrow(/collides/);
});

test('past a readable length, the selection is kept and the open documents are dropped', () => {
    const open = encodeList(Array.from({ length: 200 }, (_, i) => `DDS/Trees/document-${i}.tree`));
    expect(open.length).toBeGreaterThan(MAX_QUERY_LENGTH);

    const search = buildSearch('', { flow: 'dds', mod: 'TestMod', content: 'Content', params: { open } });

    // Which mod you are in survives; which documents were open is the part that grows.
    expect(search).toBe('flow=dds&mod=TestMod&content=Content');
});

test('a list survives a filename containing the separator it would have used', () => {
    const names = ['a,b.tree', 'quote".tree', 'plain.tree'];
    expect(decodeList(encodeList(names))).toEqual(names);
});

test('an empty list is no parameter at all', () => {
    expect(encodeList([])).toBe(null);
    expect(encodeList(undefined)).toBe(null);
});

test('a hand-edited list leaves nothing open rather than throwing', () => {
    // Startup reads these. An exception here is a page that does not load.
    expect(decodeList('["truncated')).toEqual([]);
    expect(decodeList('{"not":"a list"}')).toEqual([]);
    expect(decodeList('[1,2,3]')).toEqual([]);
    expect(decodeList(null)).toEqual([]);
});
