import { test, expect } from 'vitest';
import { GUID_PATTERN } from './guid.js';

/**
 * What counts as a content GUID.
 *
 * Shadows of Doubt GUIDs are real UUIDs, and the version and variant nibbles are what
 * separate one from a placeholder somebody typed. The strings editor flags a key that
 * is not a GUID rather than refusing it, so this decides what gets flagged.
 */

test('a real UUID is a GUID, in either case', () => {
    expect(GUID_PATTERN.test('33333333-3333-4333-8333-333333333333')).toBe(true);
    expect(GUID_PATTERN.test('A1B2C3D4-E5F6-1789-B012-3456789ABCDE')).toBe(true);

    // Versions 1 to 5 and variants 8, 9, a, b -- the whole of what the game writes.
    expect(GUID_PATTERN.test('00000000-0000-1000-9000-000000000000')).toBe(true);
    expect(GUID_PATTERN.test('00000000-0000-5000-b000-000000000000')).toBe(true);
});

test('a placeholder that ignores the version or variant is not one', () => {
    // All-zeroes is the one people actually type, and it is version 0.
    expect(GUID_PATTERN.test('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(GUID_PATTERN.test('00000000-0000-6000-8000-000000000000')).toBe(false);
    expect(GUID_PATTERN.test('00000000-0000-4000-c000-000000000000')).toBe(false);

    // And the shapes that are not a UUID at all.
    expect(GUID_PATTERN.test('NotAGuid')).toBe(false);
    expect(GUID_PATTERN.test('33333333-3333-4333-8333-33333333333')).toBe(false);
    expect(GUID_PATTERN.test(' 33333333-3333-4333-8333-333333333333')).toBe(false);
});
