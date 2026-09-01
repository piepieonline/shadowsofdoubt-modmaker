import { describe, test, expect } from 'vitest';
import { typeLayout } from '../../../core/refs.js';
import { resolveField } from '../../../core/typeHints.js';
import { instanceOptions, isGeneratedId, isInstanceReference } from './instances.js';

/**
 * The IDs a tree uses to talk about itself.
 *
 * Both halves of this were free text: an `instanceID` could be typed over, breaking every
 * link into that message at once, and a field that names one was a box to paste a GUID
 * into. What is checked here is which fields are which -- getting that wrong makes a field
 * uneditable that should not be, or offers a list where a document name belongs.
 */

const TREE = 'DDSTreeSave';
const MESSAGE = 'DDSMessageSave';

const at = (path) => resolveField(path, typeLayout);

describe('isGeneratedId', () => {
    test('names the IDs the editor makes and no one retypes', () => {
        expect(isGeneratedId(at([TREE, 'messages', 'instanceID']))).toBe(true);
        expect(isGeneratedId(at([MESSAGE, 'blocks', 'instanceID']))).toBe(true);
    });

    test('and not the IDs that name a document', () => {
        // `msgID` and `blockID` point at files, and pointing one somewhere else is an
        // ordinary edit -- it is how a message is reused in a second tree.
        expect(isGeneratedId(at([TREE, 'messages', 'msgID']))).toBe(false);
        expect(isGeneratedId(at([MESSAGE, 'blocks', 'blockID']))).toBe(false);
        // The document's own id is the file's name, and renaming that is its own affair.
        expect(isGeneratedId(at([TREE, 'id']))).toBe(false);
        expect(isGeneratedId(null)).toBe(false);
    });
});

describe('isInstanceReference', () => {
    test('names the fields that hold an instanceID', () => {
        expect(isInstanceReference(at([TREE, 'startingMessage']))).toBe(true);
        expect(isInstanceReference(at([TREE, 'messages', 'links', 'to']))).toBe(true);
        expect(isInstanceReference(at([TREE, 'messages', 'links', 'from']))).toBe(true);
    });

    test('and not the ones that hold anything else', () => {
        expect(isInstanceReference(at([TREE, 'messages', 'msgID']))).toBe(false);
        expect(isInstanceReference(at([TREE, 'messages', 'instanceID']))).toBe(false);
        expect(isInstanceReference(at([TREE, 'name']))).toBe(false);
    });
});

describe('instanceOptions', () => {
    const tree = {
        messages: [
            { msgID: 'a-document', instanceID: 'instance-one', order: 0 },
            { msgID: 'a-document', instanceID: 'instance-two', order: 3 },
            { elementName: 'Heading', instanceID: 'instance-three', order: 1 },
        ],
    };

    test('offers each message by where it sits, and stores its instanceID', () => {
        // The same document twice is the case the two IDs exist for: both entries point at
        // one message, and a list that showed `msgID` could not tell them apart.
        expect(instanceOptions(tree)).toEqual([
            { value: 'instance-one', text: 'messages.0 (order 0)' },
            { value: 'instance-two', text: 'messages.1 (order 3)' },
            { value: 'instance-three', text: 'messages.2 — Heading (order 1)' },
        ]);
    });

    test('numbers by position in the document, not by position in the list', () => {
        // A message with no instance yet is not offered -- there is nothing to point at --
        // but it still occupies its place, and the ones after it keep their own.
        const withAGap = { messages: [{ instanceID: 'first', order: 0 }, {}, { instanceID: 'third', order: 2 }] };

        expect(instanceOptions(withAGap).map((option) => option.text))
            .toEqual(['messages.0 (order 0)', 'messages.2 (order 2)']);
    });

    test('has nothing to offer for a document that holds no messages', () => {
        // A message or a block opened in its own window: no `messages`, no instances, and
        // no field in it that names one either.
        expect(instanceOptions({ blocks: [] })).toEqual([]);
        expect(instanceOptions(null)).toEqual([]);
    });
});
