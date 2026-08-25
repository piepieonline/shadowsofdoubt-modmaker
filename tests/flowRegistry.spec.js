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
        known: ['dds', 'fabricated', 'scriptableObject'],
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
