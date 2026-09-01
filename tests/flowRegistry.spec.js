import { test, expect } from '@playwright/test';
import { installFsHarness, gotoFlow } from './support/harness.js';

/**
 * The flow contract. A flow is one kind of mod content; core dispatches through the
 * descriptor rather than knowing about specific flows.
 *
 * The measure of this phase is that adding a flow needs no changes under core/, so
 * these tests exercise the registry generically -- including registering a fabricated
 * third flow, which is the thing the architecture actually exists to make cheap.
 */

const flowOf = (page) => page.evaluate(() => ({
    id: window.activeFlow?.id ?? null,
    label: window.activeFlow?.label ?? null,
    saveStrategy: window.activeFlow?.saveStrategy ?? null,
    windowPolicy: window.activeFlow?.windowPolicy ?? null,
}));

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
});

test('each page activates its flow and publishes what it is', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    expect(await flowOf(page)).toEqual({
        id: 'dds',
        label: 'DDS Text Content',
        saveStrategy: 'vanillaPatch',
        windowPolicy: 'drilldown',
    });

    await gotoFlow(page, '?flow=scriptableObject');
    expect(await flowOf(page)).toEqual({
        id: 'scriptableObject',
        label: 'Cases & ScriptableObjects',
        saveStrategy: 'fullFile',
        windowPolicy: 'byPath',
    });
});

test('readiness is not signalled until reference data has loaded', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');

    // The marker is the promise that anything depending on reference data should
    // wait on, so it must not appear before that data exists.
    expect(await page.evaluate(() => Object.keys(window.templates ?? {}).length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.ddsMap?.trees?.length ?? 0)).toBeGreaterThan(0);
});

/**
 * Reference data belongs to the active flow, however many times you switch.
 *
 * The flows share global names for data of different shapes. Each used to install its
 * own by assigning to window from a module body, which runs once per URL: the second
 * visit to a flow reinstalled nothing, so you edited case files against the DDS
 * templates, and DDS documents against a ddsMap with no id/name index.
 */
const refShape = (page) => page.evaluate(() => ({
    hasCaseTemplates: 'MurderManifest' in (window.templates ?? {}),
    hasDdsTemplates: 'tree' in (window.templates ?? {}),
    hasIdNameMap: Boolean(window.ddsMap?.idNameMap),
    // Only the case flow defines this, so it must not survive into the other. It was
    // `typeMap` until a DDS document's traits, jobs and item pool became dropdowns of the
    // game's assets -- both flows name assets now, and both install the list.
    hasPathIdMap: Boolean(window.pathIdMap),
    hasTypeMap: Boolean(window.typeMap),
}));

test('each flow reinstalls its reference data on every activation', async ({ page }) => {
    await gotoFlow(page, '?flow=scriptableObject');
    const caseRefs = await refShape(page);
    expect(caseRefs.hasCaseTemplates).toBe(true);
    expect(caseRefs.hasPathIdMap).toBe(true);

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();
    expect(await refShape(page)).toEqual({
        hasCaseTemplates: false,
        hasDdsTemplates: true,
        hasIdNameMap: true,
        hasPathIdMap: false,
        hasTypeMap: true,
    });

    // The second activation: the modules are cached, so nothing re-runs on import.
    await page.selectOption('#flow-picker', 'scriptableObject');
    await page.locator('html[data-flow-ready="scriptableObject"]').waitFor();
    expect(await refShape(page)).toEqual(caseRefs);

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();
    expect(await refShape(page)).toEqual({
        hasCaseTemplates: false,
        hasDdsTemplates: true,
        hasIdNameMap: true,
        hasPathIdMap: false,
        hasTypeMap: true,
    });
});

test('a flow keeps its inline handler surface across a round trip', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');
    const handler = () => page.evaluate(() => typeof window.setIdAndLoad);
    expect(await handler()).toBe('function');

    await page.selectOption('#flow-picker', 'scriptableObject');
    await page.locator('html[data-flow-ready="scriptableObject"]').waitFor();
    // The DDS markup is unmounted, so its handlers go with it.
    expect(await handler()).toBe('undefined');
    expect(await page.evaluate(() => typeof window.toggleEditMode)).toBe('function');

    await page.selectOption('#flow-picker', 'dds');
    await page.locator('html[data-flow-ready="dds"]').waitFor();
    expect(await handler()).toBe('function');
});

test('a third flow can register and activate without touching core', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');

    const result = await page.evaluate(async () => {
        const { registerFlow, activateFlow, listFlows, getFlow } =
            await import('/core/flowRegistry.js');

        let refsLoaded = false;
        let started = false;

        registerFlow({
            id: 'fabricated',
            label: 'Fabricated Test Flow',
            saveStrategy: 'fullFile',
            loadRefs: async () => { refsLoaded = true; },
            start: async () => { started = true; },
        });

        await activateFlow('fabricated');

        return {
            refsLoaded,
            started,
            active: window.activeFlow.id,
            known: listFlows().map((f) => f.id).sort(),
            lookup: getFlow('fabricated').label,
        };
    });

    expect(result).toEqual({
        refsLoaded: true,
        started: true,
        active: 'fabricated',
        // The shell registers every flow up front; the fabricated one joins them.
        known: ['building', 'dds', 'fabricated', 'scriptableObject'],
        lookup: 'Fabricated Test Flow',
    });
});

test('the registry rejects malformed and duplicate flows', async ({ page }) => {
    await gotoFlow(page, '?flow=dds');

    const errors = await page.evaluate(async () => {
        const { registerFlow, activateFlow } = await import('/core/flowRegistry.js');
        const caught = [];
        const attempt = async (fn) => {
            try { await fn(); caught.push(null); } catch (e) { caught.push(e.message); }
        };

        await attempt(() => registerFlow({ id: 'no-label', loadRefs: () => {} }));
        await attempt(() => registerFlow({ id: 'dds', label: 'Clash', loadRefs: () => {} }));
        await attempt(() => activateFlow('never-registered'));
        return caught;
    });

    expect(errors[0]).toContain('label');
    expect(errors[1]).toContain('already registered');
    expect(errors[2]).toContain('Unknown flow');
});
