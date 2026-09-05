import { describe, expect, test } from 'vitest';
import { isNewer, parseVersion } from './version.js';

/**
 * Whether to put a banner in front of somebody, decided from two strings neither of which
 * is guaranteed to be a version.
 *
 * Both failure directions are real and neither is loud. Say yes when the answer is no and
 * the app tells people to go and download what they already have; say no when the answer is
 * yes and nobody ever learns there is a new build, which is the whole point of the check.
 */

describe('parseVersion', () => {
    test('reads a plain version', () => {
        expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
    });

    test('reads the v prefix releases are usually tagged with', () => {
        expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
    });

    test('reads a prerelease suffix', () => {
        expect(parseVersion('v1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3, pre: 'beta.1' });
    });

    test('reads a version with something after it rather than giving up', () => {
        // A tag is whatever a human typed into the release form. There is a version in
        // this one, and refusing to see it would mean never updating anyone again.
        expect(parseVersion('v2.0.0+win64')).toEqual({ major: 2, minor: 0, patch: 0, pre: null });
    });

    test('refuses anything without three numbers', () => {
        for (const tag of ['', 'latest', '1.2', 'v1', 'release-1.2.3', null, undefined, 42, {}]) {
            expect(parseVersion(tag)).toBeNull();
        }
    });
});

describe('isNewer', () => {
    test('the same version is not newer', () => {
        expect(isNewer('1.2.3', '1.2.3')).toBe(false);
        expect(isNewer('v1.2.3', '1.2.3')).toBe(false);
    });

    test('a later version is newer, at every position', () => {
        expect(isNewer('2.0.0', '1.9.9')).toBe(true);
        expect(isNewer('1.3.0', '1.2.9')).toBe(true);
        expect(isNewer('1.2.4', '1.2.3')).toBe(true);
    });

    test('an earlier version is not', () => {
        expect(isNewer('1.9.9', '2.0.0')).toBe(false);
        expect(isNewer('1.2.9', '1.3.0')).toBe(false);
        expect(isNewer('1.2.3', '1.2.4')).toBe(false);
    });

    test('numbers compare as numbers, not as text', () => {
        // The one that string comparison gets wrong, and does not get wrong until the
        // tenth release of something.
        expect(isNewer('1.10.0', '1.9.0')).toBe(true);
        expect(isNewer('1.9.0', '1.10.0')).toBe(false);
    });

    test('a prerelease is never offered', () => {
        // Per semver 1.3.0-beta.1 precedes 1.3.0, so offering it as an upgrade would push
        // someone onto a build that was not announced. releases/latest excludes
        // prereleases anyway; this is what happens if that ever stops being true.
        expect(isNewer('1.3.0-beta.1', '1.2.0')).toBe(false);
        expect(isNewer('2.0.0-rc.1', '1.0.0')).toBe(false);
    });

    test('but leaving a prerelease behind is', () => {
        // Running 1.3.0-beta.1 when 1.3.0 proper appears: the three numbers are equal and
        // the release is still the newer thing.
        expect(isNewer('1.3.0', '1.3.0-beta.1')).toBe(true);
    });

    test('an unreadable tag or version means no banner', () => {
        // Silence is the answer to everything that is not confidently "yes, newer".
        expect(isNewer('latest', '1.2.3')).toBe(false);
        expect(isNewer('', '1.2.3')).toBe(false);
        expect(isNewer(undefined, '1.2.3')).toBe(false);
        expect(isNewer('9.9.9', 'not-a-version')).toBe(false);
        expect(isNewer(null, null)).toBe(false);
    });
});
