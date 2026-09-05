/**
 * Is the release GitHub is offering newer than the one running?
 *
 * Kept apart from main.js and importing nothing, because this is the only part of the
 * update check that can be tested: the fetch depends on GitHub, the banner depends on a
 * window, and this is a pure function of two strings. `desktop/**` is collected by
 * vitest.config.js for that reason.
 *
 * The strings are not trustworthy. `tag_name` is whatever a human typed into the release
 * form -- `v1.2.0`, `1.2.0`, `release-1.2`, or a typo -- and `app.getVersion()` is whatever
 * package.json says. So every answer that is not confidently "yes, newer" is `false`, and
 * `false` means no banner. See the note about silence in main.js.
 */

/**
 * `v1.2.3-beta.1` -> `{ major: 1, minor: 2, patch: 3, pre: 'beta.1' }`, or null.
 *
 * Anchored at the start and deliberately not at the end: a tag with something after the
 * version -- `v1.2.3+win`, `1.2.3 (hotfix)` -- still has a version in it, and reading it is
 * better than treating the whole tag as unparseable and never updating anyone again.
 */
export function parseVersion(tag) {
    if (typeof tag !== 'string') return null;

    const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?/.exec(tag);
    if (!match) return null;

    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        pre: match[4] ?? null,
    };
}

/**
 * Whether `candidate` is a release worth telling the user about, given they are on `current`.
 *
 * A candidate carrying a prerelease suffix is never one, whatever the numbers say. Per
 * semver `1.3.0-beta.1` precedes `1.3.0`, so offering it as an upgrade from `1.2.0` would be
 * pushing people onto a build that was not announced -- and `releases/latest` excludes
 * prereleases anyway, so this only ever fires if that changes or a tag is misread.
 *
 * A *current* prerelease is the other way round: someone running `1.3.0-beta.1` should be
 * told when `1.3.0` proper appears, even though the three numbers are equal.
 */
export function isNewer(candidate, current) {
    const next = parseVersion(candidate);
    const now = parseVersion(current);

    if (!next || !now) return false;
    if (next.pre) return false;

    for (const part of ['major', 'minor', 'patch']) {
        if (next[part] > now[part]) return true;
        if (next[part] < now[part]) return false;
    }

    // Same three numbers: newer only if this one leaves a prerelease behind.
    return now.pre !== null;
}
