/**
 * What build this is, in the last line of the page.
 *
 * It answers one question and it is only ever asked once: something has gone wrong and needs
 * reporting, and the report is worthless without knowing which build it came from. So it
 * takes a line and no attention -- see `#build-version` in core/chrome.css.
 *
 * The two builds need different answers, and the desktop one needs both halves:
 *
 * | Web     | `a1b2c3d`                | The commit is the whole identity. The site is whatever was deployed last, and there is no version to speak of. |
 * | Desktop | `v0.2.0 · a1b2c3d`       | The release is what a user can tell you and what they downloaded. The commit is what is actually in it -- a re-tagged or rebuilt release has the same version and different contents. |
 *
 * Written here rather than left in the markup, which is what went wrong before: index.html
 * carried `{{ site.github.build_revision }}` for Jekyll to substitute, Pages stopped building
 * the site with Jekyll, and the footer showed the template text to every visitor from then
 * on. Nothing noticed, because the only test that read it asserted that exact string.
 */
import { appVersion, isDesktop } from './platform.js';

const COMMIT_URL = 'https://github.com/piepieonline/shadowsofdoubt-modmaker/commit/';

/**
 * Baked by vite.config.js. Empty when it could not be worked out.
 *
 * `typeof` rather than a bare read: Vitest has no `define`, and a module that throws
 * `ReferenceError` on import would take down any unit test that so much as imported
 * something near it. esbuild substitutes inside `typeof` too, so this costs nothing in a
 * real build.
 */
const commit = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : '';

/** Enough to identify a commit, and short enough for a line nobody is meant to read. */
const SHORT = 7;

/**
 * The commit, linked to itself on GitHub.
 *
 * GitHub resolves an abbreviated hash in a commit URL, but the full one is what is baked and
 * what is linked -- an abbreviation is a display decision and does not belong in a URL that
 * has to still work when the repository has grown enough to make seven characters ambiguous.
 *
 * Opens the user's browser on desktop rather than navigating the app: desktop/main.js hands
 * every `https:` link to `shell.openExternal`. Without that this would replace the shell, the
 * connected folders and any unsaved edits with a web page.
 */
function commitLink() {
    const link = document.createElement('a');

    link.href = `${COMMIT_URL}${commit}`;
    link.textContent = commit.slice(0, SHORT);
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.title = commit;

    return link;
}

/**
 * Fill in the footer. Called once, from the shell.
 *
 * Everything is optional and nothing is invented. No commit and no version says `unknown`,
 * which is the honest answer for a build made outside both a repository and a release, and
 * is still more use in a bug report than a blank line that could mean anything.
 */
export function initBuildVersion() {
    const footer = document.getElementById('build-version');
    if (!footer) return;

    const parts = [];

    if (isDesktop && appVersion) parts.push(document.createTextNode(`v${appVersion}`));

    if (commit) parts.push(commitLink());
    else if (!parts.length) parts.push(document.createTextNode('unknown'));

    // The separator between them, not around them: one part on its own gets none.
    if (parts.length === 2) parts.splice(1, 0, document.createTextNode(' · '));

    footer.replaceChildren(...parts);
}
