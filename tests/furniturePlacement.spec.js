import { test, expect } from '@playwright/test';
import {
    installFsHarness, collectPageErrors, gotoFlow, seedFs, connectFolders, selectContent,
    readFile,
} from '../test-support/harness.js';
import { furnitureExport, furnitureTypeMap } from '../test-support/fixtures.js';

/**
 * Placement mode: a class's rules drawn on the grid they are written on, and edited there.
 *
 * What a rule means is `furnitureClass.unit.spec.js` and what gets written is
 * `furniturePlan.unit.spec.js`. This is the loop between them — mark a rule on the
 * diagram, change it, and find it in the file as the game spells it — plus the one thing
 * only a browser can show: that the diagram is a grid with the rules on the right edges.
 */

const json = (value) => JSON.stringify(value, null, 2);

const emptyMod = {
    'Mods/DeskMod/murdermanifest.sodso.json': json({
        enabled: true, fileOrder: [], loadBefore: '', version: 1,
    }),
};

const SPOILER_KEY = 'SOD_MurderCaseBuilder_SpoilerWarningDismissed';

const expectDialogOpen = (page, selector, open) =>
    expect.poll(() => page.locator(selector).evaluate((e) => e.open)).toBe(open);

const openSection = (page, label) => page.evaluate((text) => {
    const step = [...document.querySelectorAll('#furniture-creator-modal .creator-step')]
        .find((node) => node.querySelector('.creator-step-label')?.textContent === text);
    step?.click();
}, label);

async function openPane(page, fixture = emptyMod) {
    await page.addInitScript((k) => window.localStorage.setItem(k, 'true'), SPOILER_KEY);
    await gotoFlow(page, '?flow=scriptableObject');

    await seedFs(page, { ...furnitureExport, ...fixture });
    await connectFolders(page, { modDir: 'Mods', exportedSOs: 'ExportedSOs' });
    await selectContent(page, 'DeskMod', '');

    await page.evaluate((map) => Object.assign(window.typeMap, map), furnitureTypeMap);

    await page.getByRole('link', { name: 'Furniture Creator' }).click();
    await expectDialogOpen(page, '#furniture-creator-modal', true);
    await expect(page.locator('#furniture-creator-presets li').first()).toBeVisible();
}

async function choose(page, name) {
    // The picker is the first step's. Said here rather than at every call: choosing a
    // preset is what the rest of a test is about, not a step it happens to be on.
    await openSection(page, 'Source');
    await page.locator('#furniture-creator-search').fill(name);
    await page.locator('#furniture-creator-presets')
        .getByRole('button', { name, exact: true }).click();
}

/** Show the step the rules are on. */
async function placementMode(page) {
    await openSection(page, 'Placement');
    await expect(page.locator('#furniture-creator-placement')).toBeVisible();
}

/**
 * Put a rule on one tile, the way an author does: press that tile's +.
 *
 * Adding is per tile rather than a button under the grid, because the offset was the thing
 * hardest to get right — a single Add put every rule on the anchor and left the author to
 * type the tile back out in two number fields, having just pointed at it.
 *
 * The + is only shown on hover or focus, so this hovers first. `force` would click it while
 * it is still transparent, which is a test passing on a control a person cannot see.
 */
async function addRuleOn(page, x, y) {
    const add = page.getByRole('button', {
        name: `Put a rule on the tile at ${x}, ${y}`, exact: true,
    });

    await add.hover();
    await add.click();
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
});

/*
 * The model and the rules are two steps rather than two radio buttons now.
 *
 * The 3D view follows: there is one WebGL context and three steps that want it, so the
 * stepper moves the element into whichever of them is showing. Stepping away and back is
 * what would leave a canvas measured against a hidden box, which is a view one pixel tall.
 */
test('switches between the model and the rules, and the view follows', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openPane(page);
    await choose(page, 'HotelDesk');

    await expect(page.locator('#furniture-creator-view')).toBeVisible();

    await placementMode(page);
    await expect(page.locator('#furniture-creator-viewport')).toBeHidden();
    await expect(page.locator('.placement-grid')).toBeVisible();

    await openSection(page, 'Source');
    await expect(page.locator('#furniture-creator-view')).toBeVisible();

    // Standing in the step that is showing, rather than wherever it was built.
    await expect(page.locator('.creator-pane[data-step="source"] #furniture-creator-view'))
        .toHaveCount(1);

    expect(errors).toEqual([]);
});

/**
 * The diagram is the class's own frame, and it says so: a rule naming `behind` is about
 * the piece's back, not about north.
 */
test('draws the grid front-up, and says that is what up means', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await placementMode(page);

    await expect(page.locator('.creator-pane[data-step="placement"]'))
        .toContainText('Front is up');

    // 3x1LobbyDesk covers three tiles, so three of them are drawn as the piece.
    await expect(page.locator('.placement-tile-covered')).toHaveCount(3);
    await expect(page.locator('.placement-tile-anchor')).toHaveCount(1);
});

test('puts a rule on the edge it names, with what it means on it', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await placementMode(page);

    // Whatever this class's rules are, an edge rule is drawn on an edge rather than loose
    // in the tile, and carries a sentence a reader can act on.
    const edge = page.locator('.placement-edge').first();
    await expect(edge).toBeVisible();

    const label = await edge.getAttribute('aria-label');
    expect(label).toMatch(/Will not be placed|Prefers/);
});

/**
 * Blocked access is an effect rather than a gate, so it is under the grid and says so.
 * Reading it as a placement rule is the mistake the wording exists to prevent.
 */
test('keeps what a piece blocks apart from where it may stand', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await placementMode(page);

    await expect(page.locator('#furniture-creator-placement-notes'))
        .toContainText('Nothing about where this may stand');
});

test('marks a rule when it is clicked, and shows what it does', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await placementMode(page);

    await page.locator('.placement-edge').first().click();

    await expect(page.locator('#furniture-creator-rule-editor')).toBeVisible();
    await expect(page.locator('#furniture-creator-rule-meaning'))
        .toContainText(/Will not be placed|Prefers/);
});

test('changes a rule, and the diagram follows', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await placementMode(page);

    await page.locator('.placement-edge').first().click();
    await page.locator('#furniture-creator-rule-tag').selectOption('window');

    await expect(page.locator('#furniture-creator-rule-meaning')).toContainText('a window');
    await expect(page.locator('#furniture-creator-placement-notes'))
        .toContainText('These rules have been edited');
});

test('adds a rule and takes one away', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await placementMode(page);

    const before = await page.locator('.placement-edge, .placement-corner, .placement-node-rule').count();

    // On the tile that was pressed, not on the anchor. The far tile of this 3x1 desk — which
    // is at -2, because a footprint reaches back from its anchor — so the two cannot be
    // confused with each other.
    await addRuleOn(page, -2, 0);
    await expect(page.locator('#furniture-creator-rule-editor')).toBeVisible();
    await expect(page.locator('#furniture-creator-rule-at-x')).toHaveValue('-2');

    await page.getByRole('button', { name: 'Remove this one' }).click();
    await expect(page.locator('.placement-edge, .placement-corner, .placement-node-rule'))
        .toHaveCount(before);
});

/**
 * The dead end this pane had. A wall rule was the only kind a press could make, and the
 * other two kinds were only reachable by marking one that already existed — so a class with
 * no occupancy rule could never be given its first, and neither could one with no closed way
 * out. "Will not be placed if anything at all is there" was unwritable.
 */
test('turns a new rule into one about anything already standing there', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await placementMode(page);

    await addRuleOn(page, 0, 1);

    await page.locator('#furniture-creator-rule-kind').selectOption('node');
    await page.locator('#furniture-creator-rule-node-option').selectOption('cantFeature');
    await page.locator('#furniture-creator-rule-class').fill('*');

    await expect(page.locator('#furniture-creator-rule-meaning'))
        .toContainText('Will not be placed if anything at all is already there');

    await expect(page.locator('.placement-node-rule', { hasText: 'no anything' })).toBeVisible();
});

/** The other half of the same select: what standing here does to the room. */
test('turns a new rule into a way out it closes', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await placementMode(page);

    await addRuleOn(page, 0, 0);
    await page.locator('#furniture-creator-rule-kind').selectOption('block');

    await page.locator('#furniture-creator-block-left').check();

    await expect(page.locator('#furniture-creator-placement-notes'))
        .toContainText('Closes the way out of its own tile');
});

/**
 * The footprint, which nothing here could change before — a class copied from a 1x1 donor
 * stayed 1x1 however big the model was.
 */
test('widens the footprint, and the grid follows', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await placementMode(page);

    await page.locator('#furniture-creator-size-x').fill('4');

    await expect(page.locator('.placement-tile-covered')).toHaveCount(4);
    await expect(page.locator('#furniture-creator-placement')).toContainText('4 × 1 nodes');
});

/**
 * The payoff. A clone that states nothing brings the donor's node rules, still naming the
 * donor — invisible in game. Stating them replaces the list whole, and the warning goes
 * with it.
 */
test('warns about a bare clone, and stops warning once the rules are stated', async ({ page }) => {
    await openPane(page);
    await choose(page, 'HotelDesk');
    await openSection(page, 'What will be written');
    await page.locator('#furniture-creator-name').fill('MyDesk');

    await expect(page.locator('#furniture-creator-plan'))
        .toContainText('states no rules of its own');

    await placementMode(page);
    await addRuleOn(page, 0, 0);

    await expect(page.locator('#furniture-creator-plan'))
        .not.toContainText('states no rules of its own');
});

test('writes the rules into the class, as the game spells them', async ({ page }) => {
    const errors = collectPageErrors(page);

    await openPane(page);
    await choose(page, 'HotelDesk');
    await placementMode(page);

    // One rule of our own: a solid wall behind, which is the commonest thing a class asks
    // for and the easiest to read back out of the file.
    await addRuleOn(page, 0, 0);
    await page.locator('#furniture-creator-rule-tag').selectOption('wall');
    await page.locator('#furniture-creator-rule-dir').selectOption('behind');
    await page.locator('#furniture-creator-rule-option').selectOption('mustFeature');

    await openSection(page, 'What will be written');
    await page.locator('#furniture-creator-name').fill('MyDesk');
    await page.locator('#furniture-creator-write').click();

    await expect(page.locator('#furniture-creator-plan')).toContainText('3 files written');

    const written = JSON.parse(
        await readFile(page, 'Mods/DeskMod/MyDeskFC.FurnitureClass.sodso.json'));

    // Indices, not names: behind is 2 of BlockingDirection, wall is 1 of WallRule, and
    // mustFeature is 0 of FurnitureRuleOption.
    expect(written.wallRules).toContainEqual({
        nodeOffset: { x: 0, y: 0 },
        wallDirection: 2,
        option: 0,
        tag: 1,
        addScore: 0,
    });

    // All three lists, because each replaces the donor's rather than merging with it.
    expect(written.nodeRules).toBeDefined();
    expect(written.blockedAccess).toBeDefined();

    expect(errors).toEqual([]);
});
