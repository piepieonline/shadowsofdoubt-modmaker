import { test, expect } from 'vitest';
import { fieldPath, resolveField, describeField } from './typeHints.js';

/**
 * What the game's type layout says about the field a tree node shows.
 *
 * The layout is keyed by field name from a root type down, and array indices are not
 * part of that path -- which is the bug this replaced: keying an enum off the label
 * alone meant no element of an array ever resolved, because its label is its index.
 *
 * `fieldPath` walks a jsonTree node's parents, so the nodes here are the minimum shape
 * it reads: a label and a parent.
 */

/** A chain of jsonTree-ish nodes, root last. */
const nodeChain = (...labels) => labels.reduce(
    (parent, label) => ({ label, parent }), { label: null, parent: null });

/** The game's layout, as refs/generated/soTypeLayout.json shapes it. */
const TYPE_LAYOUT = {
    DDSTreeSave: {
        messages: { Item1: 'DDSMessageSettings', Item2: true, Item3: 'The messages in this tree' },
        treeType: { Item1: 'TreeType', Item2: false, Item3: '' },
    },
    DDSMessageSettings: {
        msgID: { Item1: 'String', Item2: false, Item3: 'The message identifier' },
        nested: { Item1: 'String', Item2: false, Item3: '' },
    },
};

test('a field path is the labels from the root down', () => {
    expect(fieldPath(nodeChain('msgID'))).toEqual(['msgID']);
    expect(fieldPath(nodeChain('messages', 'msgID'))).toEqual(['messages', 'msgID']);
});

test('an array index is not part of the path', () => {
    // `messages[3].msgID` is described as messages -> DDSMessageSettings -> msgID. The
    // 3 says nothing about what the field is, and keying off it resolved nothing.
    expect(fieldPath(nodeChain('messages', '3', 'msgID'))).toEqual(['messages', 'msgID']);
    expect(fieldPath(nodeChain('messages', '12'))).toEqual(['messages']);
});

test('the root has no path at all', () => {
    expect(fieldPath({ label: null, parent: null })).toEqual([]);
});

test('a leaf field resolves to its type and its description', () => {
    expect(resolveField(['DDSTreeSave', 'treeType'], TYPE_LAYOUT)).toEqual({
        ownerType: 'DDSTreeSave',
        field: 'treeType',
        type: 'TreeType',
        isArray: false,
        officialDescription: '',
    });
});

test('a field inside an array resolves through the element type', () => {
    // The step through `messages` is what makes this work: Item1 of a non-leaf is the
    // type its children are described by, which for an array is the element type.
    expect(resolveField(['DDSTreeSave', 'messages', 'msgID'], TYPE_LAYOUT)).toEqual({
        ownerType: 'DDSMessageSettings',
        field: 'msgID',
        type: 'String',
        isArray: false,
        officialDescription: 'The message identifier',
    });

    expect(resolveField(['DDSTreeSave', 'messages'], TYPE_LAYOUT).isArray).toBe(true);
});

test('anything the layout does not describe is null rather than an error', () => {
    // A document may legitimately hold fields the reference data has no entry for, and
    // display-only keys the editor added. Callers read null as "no idea".
    expect(resolveField(['DDSTreeSave', 'notAField'], TYPE_LAYOUT)).toBeNull();
    expect(resolveField(['NoSuchType', 'msgID'], TYPE_LAYOUT)).toBeNull();
    expect(resolveField(['DDSTreeSave'], TYPE_LAYOUT)).toBeNull();
    expect(resolveField(['DDSTreeSave', 'treeType'], null)).toBeNull();
});

test('a tooltip puts what we wrote first and what the game says after', () => {
    const descriptions = { DDSMessageSettings: { msgID: 'How the tree refers to this message.' } };
    const path = ['DDSTreeSave', 'messages', 'msgID'];

    expect(describeField(path, { typeLayout: TYPE_LAYOUT, descriptions })).toBe(
        'How the tree refers to this message.\n\nOfficial description: The message identifier');

    // Either alone, and nothing when there is neither.
    expect(describeField(path, { typeLayout: TYPE_LAYOUT, descriptions: {} }))
        .toBe('Official description: The message identifier');
    expect(describeField(['DDSTreeSave', 'treeType'], { typeLayout: TYPE_LAYOUT, descriptions }))
        .toBe('');
});

test('a field the layout does not know has no tooltip', () => {
    expect(describeField(['DDSTreeSave', 'notAField'], { typeLayout: TYPE_LAYOUT, descriptions: {} }))
        .toBe('');
});
