import { test, expect, vi } from 'vitest';
import { decorateValueNodes, NodeKind } from './valueNodes.js';

/**
 * The seam between the flows: who decides what editor a value node gets.
 *
 * Core owns the walk and the dispatch; each flow supplies `resolveNode` to answer "what
 * is this?" and the renderers for the kinds it can produce. What is worth pinning is
 * the dispatch -- that an unresolved node falls back to text, that a read-only one gets
 * no editor at all, and that a kind with no renderer is reported rather than silently
 * skipped.
 *
 * The tree and its items are the shape jsonTree hands in, stood up here as plain
 * objects. Rendering into them is the flows' business and stays in the Playwright suite.
 */

/** A jsonTree stand-in: `findAndHandle` runs the handler over the matching items. */
const treeOf = (items) => ({
    findAndHandle: (matches, handle) => items.filter(matches).forEach(handle),
});

/** An item as the walk reads one -- a value element under a node element. */
const item = (label, { isComplex = false, hasValue = true } = {}) => {
    const value = { label };
    return {
        label,
        isComplex,
        value,
        el: { querySelector: (selector) => (hasValue && selector === '.jsontree_value' ? value : null) },
    };
};

test('a node the flow does not recognise is given a text editor', () => {
    const text = vi.fn();
    const items = [item('msgID')];

    decorateValueNodes(treeOf(items), {
        resolveNode: () => null,
        render: { [NodeKind.TEXT]: text },
    });

    expect(text).toHaveBeenCalledOnce();
    expect(text.mock.calls[0][0]).toBe(items[0].value);
    expect(text.mock.calls[0][2]).toEqual({ kind: NodeKind.TEXT });
});

test('each kind goes to its own renderer, and a complex node to none', () => {
    const render = {
        [NodeKind.ENUM]: vi.fn(),
        [NodeKind.REFERENCE]: vi.fn(),
        [NodeKind.TEXT]: vi.fn(),
    };

    decorateValueNodes(treeOf([
        item('treeType'),
        item('presetName'),
        item('msgID'),
        // A complex node is a branch, not a value: the walk must not reach it.
        item('messages', { isComplex: true }),
    ]), {
        resolveNode: ({ label }) => {
            if (label === 'treeType') return { kind: NodeKind.ENUM, values: ['A'] };
            if (label === 'presetName') return { kind: NodeKind.REFERENCE, type: 'Thing' };
            return null;
        },
        render,
    });

    expect(render[NodeKind.ENUM]).toHaveBeenCalledOnce();
    expect(render[NodeKind.REFERENCE]).toHaveBeenCalledOnce();
    expect(render[NodeKind.TEXT]).toHaveBeenCalledOnce();
});

test('a read-only node gets no editor, and an unrenderable kind is reported', () => {
    const text = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    decorateValueNodes(treeOf([
        item('readOnlyField'),
        item('strangeField'),
        // No value element to render into: nothing to do, and nothing to warn about.
        item('headless', { hasValue: false }),
    ]), {
        resolveNode: ({ label }) => {
            if (label === 'readOnlyField') return { kind: NodeKind.READ_ONLY };
            if (label === 'strangeField') return { kind: 'somethingElse' };
            return null;
        },
        render: { [NodeKind.TEXT]: text },
    });

    // READ_ONLY is displayed as-is: no editor, no handlers, and no complaint either.
    expect(text).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('somethingElse');

    warn.mockRestore();
});
