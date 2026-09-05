import { test, expect, gotoFlow, dismissFolderPrompt } from './support/launch.js';
import { collectPageErrors } from '../test-support/harness.js';

/**
 * The floorplan view, opened for real in the desktop shell.
 *
 * This flow was outside the smoke subset when the desktop build was written -- the plan chose
 * the shell, the folders and one document flow -- and a bug went straight through the gap: the
 * content policy in desktop/main.js forbade the `new Function` that troika rebuilds its worker
 * with, so every piece of text in the 3D view disappeared. Nothing failed loudly. The floor
 * drew, the rooms were the right colours, and the labels and the mark on the selected square
 * were absent, which reads as a rendering quirk rather than as a policy refusing an API.
 *
 * So this is here for one reason: it is the only flow whose correctness depends on a worker,
 * on `eval`, on WebGL and on a font fetch all at once, and every one of those is something the
 * desktop shell can take away without the app noticing.
 *
 * Base game floors are read from `refs/`, so no mod folder is needed and none is connected.
 */

/** Open the Browse dialog and the first floor it offers, in one go. */
async function openFirstFloor(page) {
    await page.locator('#building-file-list').waitFor({ state: 'attached' });

    // Synchronously, because the panel re-renders as the mod list settles and anything done
    // in two steps loses the element in between.
    const opened = await page.evaluate(() => {
        document.querySelector('#building-browse')?.setAttribute('open', '');
        for (const section of document.querySelectorAll('#building-file-list details')) {
            section.open = true;
        }

        // The click handler is on the button inside the row, not on the row.
        const rows = [...document.querySelectorAll('#building-file-list .file-panel-entry')]
            .filter((row) => row.querySelector('.file-panel-open'));

        rows[0]?.querySelector('.file-panel-open').click();
        return { offered: rows.length, id: rows[0]?.dataset.id ?? null };
    });

    expect(opened.offered, 'the base game floors should be listed with no mod folder')
        .toBeGreaterThan(0);
    await page.locator('#building-canvas canvas').waitFor();

    return opened.id;
}

test('a base game floor opens, and its text is not silently missing', async ({ page }) => {
    const errors = collectPageErrors(page);

    await gotoFlow(page, '?flow=building');
    await dismissFolderPrompt(page);

    const floor = await openFirstFloor(page);
    expect(floor).toBeTruthy();

    // Long enough for a font to be fetched and an atlas built. The failure this guards is
    // asynchronous and silent, so there has to be something to wait for it to not happen in.
    await page.waitForTimeout(3000);

    // The whole symptom, and the only loud part of it. `worker module init function failed to
    // rehydrate` and `init did not return a callable function` were raised nine times over
    // when the policy forbade eval, and nothing else anywhere reported a problem.
    expect(errors.join('\n')).not.toMatch(/rehydrate|did not return a callable/);
    expect(errors).toEqual([]);
});

test('clicking a square marks it, which is a glyph the scene has to lay out', async ({ page }) => {
    const errors = collectPageErrors(page);

    await gotoFlow(page, '?flow=building');
    await dismissFolderPrompt(page);
    await openFirstFloor(page);

    const canvas = page.locator('#building-canvas canvas');
    const box = await canvas.boundingBox();

    // In the default tool a click selects the square under it, and a selected square is what
    // draws the asterisk -- the thing that was reported missing.
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.45);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(2000);

    expect(errors).toEqual([]);
});
