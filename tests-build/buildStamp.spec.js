import { test, expect } from '@playwright/test';
import { BUILD_SHA } from '../playwright.build.js';

/**
 * The footer knows which build it is.
 *
 * This is here rather than in `tests/` because it is a source-to-artifact question and only
 * makes sense against a real build: the commit is read from the environment by
 * vite.config.js, inlined by esbuild as `__BUILD_COMMIT__`, and rendered by
 * core/buildVersion.js. Every step of that is invisible to a suite running off the dev
 * server, and the whole chain has exactly one observable end.
 *
 * It exists because this line has already been wrong for a long time without anyone
 * noticing. index.html carried `{{ site.github.build_revision }}` for Jekyll to substitute;
 * Pages moved to deploying a prebuilt Vite artifact and stopped running Jekyll; the footer
 * showed the template text to every visitor from then on. `tests/shell.spec.js` had a test
 * pointed straight at it, and it passed throughout -- it asserted the template string was
 * there, which by then was the bug rather than the wiring.
 *
 * So: assert what the page says, not what it is built from.
 */

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await page.goto('./');
    await page.locator('html[data-flow-ready]').waitFor();
});

test('the commit the build came from reaches the footer', async ({ page }) => {
    const footer = page.locator('#build-version');

    await expect(footer).toHaveText(BUILD_SHA.slice(0, 7));

    // The web build has no version to give: the site is whatever was deployed last. The
    // desktop build adds one, and tests-desktop/shell.spec.js is where that is asserted.
    expect(await footer.textContent()).not.toContain('v');
});

test('the commit is linked long and shown short', async ({ page }) => {
    const link = page.locator('#build-version a');

    // An abbreviation is a display decision. A URL that has to keep resolving as the
    // repository grows gets the whole hash.
    await expect(link).toHaveAttribute(
        'href', `https://github.com/piepieonline/shadowsofdoubt-modmaker/commit/${BUILD_SHA}`);
    await expect(link).toHaveText(BUILD_SHA.slice(0, 7));

    // Hovering gives the full hash, for copying into a report without following the link.
    await expect(link).toHaveAttribute('title', BUILD_SHA);
});

/**
 * No template markup survives into the artifact, anywhere.
 *
 * Broader than the footer on purpose. The footer is the one that got caught, but the same
 * mistake is available anywhere a `{{ ... }}` is left in the markup for a build step that
 * no longer runs, and it fails the same way: silently, in text, in front of everyone.
 */
test('no unsubstituted template markup is served', async ({ page }) => {
    const html = await (await page.request.get('./')).text();

    // Comments stripped first. index.html explains this history in prose, and that prose has
    // to be able to quote the thing it is about -- a check that cannot tell a mistake from a
    // note explaining the mistake is one that gets worked around rather than fixed.
    const markup = html.replace(/<!--[\s\S]*?-->/g, '');

    expect(markup).not.toContain('{{');
    expect(markup).not.toContain('site.github');
});
