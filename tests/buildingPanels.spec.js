import { test, expect } from '@playwright/test';
import { installFsHarness, gotoFlow } from './support/harness.js';

/**
 * The panels beside the floorplan.
 *
 * What is worth checking here is the handful of places where a panel has to say
 * something the data alone does not: that an address's layout variations are reachable
 * at all, that a name the base game does not have is still shown rather than silently
 * replaced, and that `f_r` appears without being editable. The rest is a list rendering
 * a list.
 */

async function withPanels(page, body) {
    return page.evaluate(async (source) => {
        const panels = await import('/flows/building/scripts/panels.js');
        const tools = await import('/flows/building/scripts/tools.js');
        const model = await import('/flows/building/scripts/floorModel.js');
        const refs = (await import('/flows/building/scripts/loadRefs.js')).default;

        // The panels read their name lists off window, as the registry installs them.
        Object.assign(window, refs);

        const nodes = [];
        for (let x = 0; x < 21; x++) {
            for (let y = 0; y < 21; y++) {
                nodes.push({ f_c: { x, y }, f_h: 0, f_t: 0, f_r: '', w_d: [] });
            }
        }
        // One node carrying a forced room, as 1,889 base game nodes do.
        nodes.find((n) => n.f_c.x === 9 && n.f_c.y === 9).f_r = 'Lobby.Lobby';

        const floor = model.parseFloor({
            floorName: 'Test',
            a_d: [
                {
                    p_n: 'Outside', e_c: { r: 1, g: 0, b: 0.4, a: 1 },
                    vs: [{ r_d: [{ id: 1, n_d: nodes, l: 'Null' }] }],
                },
                {
                    // A layout configuration the base game does not have, as a mod may add.
                    p_n: 'MyCustomLayout', e_c: { r: 0, g: 0.5, b: 1, a: 1 },
                    vs: [
                        { r_d: [{ id: 2, n_d: [], l: 'Lobby' }] },
                        { r_d: [{ id: 3, n_d: [], l: 'Ballroom' }] },
                    ],
                },
            ],
            t_d: [],
        });

        const host = document.createElement('div');
        document.body.appendChild(host);
        const make = (name) => {
            const element = document.createElement('div');
            element.dataset.panel = name;
            host.appendChild(element);
            return element;
        };

        const elements = {
            tools: make('tools'),
            addresses: make('addresses'),
            rooms: make('rooms'),
            walls: make('walls'),
            selection: make('selection'),
        };

        const state = tools.createToolState();
        const panel = panels.createPanels(elements, floor, state);

        try {
            // eslint-disable-next-line no-new-func
            return await new Function('panels', 'elements', 'floor', 'state', 'panel', 'model', 'tools',
                `return (${source})(panels, elements, floor, state, panel, model, tools)`)(
                panels, elements, floor, state, panel, model, tools);
        } finally {
            host.remove();
        }
    }, body.toString());
}

test.beforeEach(async ({ page }) => {
    await installFsHarness(page);
    await page.addInitScript(() =>
        localStorage.setItem('SOD_MurderCaseBuilder_SpoilerWarningDismissed', 'true'));
    await gotoFlow(page, '?flow=dds');
});


test('the tool bar offers all five tools and says which is active', async ({ page }) => {
    const bar = await withPanels(page, (panels, elements, floor, state) => {
        const buttons = [...elements.tools.querySelectorAll('button')];
        buttons.find((button) => button.dataset.tool === 'wall').click();

        return {
            labels: buttons.map((button) => button.textContent),
            active: [...elements.tools.querySelectorAll('button')]
                .filter((button) => button.getAttribute('aria-pressed') === 'true')
                .map((button) => button.dataset.tool),
            tool: state.tool,
            hint: elements.tools.querySelector('.tool-hint').textContent,
        };
    });

    expect(bar.labels).toEqual(['Address', 'Room', 'Floor type', 'Wall', 'Tile']);
    expect(bar.active).toEqual(['wall']);
    expect(bar.tool).toBe('wall');

    // The modifiers are the whole interface, and shift only means something for walls.
    expect(bar.hint).toContain('Ctrl+click to pick');
    expect(bar.hint).toContain('Shift+click to remove');
});

test('an address that the base game has no name for is still shown', async ({ page }) => {
    const options = await withPanels(page, (panels, elements) => {
        const rows = [...elements.addresses.querySelectorAll('.address-row')];
        const select = rows[1].querySelector('select');

        return {
            value: select.value,
            first: select.options[0].textContent,
            hasBaseGameNames: [...select.options].some((option) => option.value === 'Lobby'),
        };
    });

    // A mod may add a layout configuration, and a floor naming one is valid. Replacing
    // it with whatever happened to be first in the list would rewrite the floor.
    expect(options.value).toBe('MyCustomLayout');
    expect(options.first).toBe('MyCustomLayout (not a base game asset)');
    expect(options.hasBaseGameNames).toBe(true);
});

test('address 0 and 1 are labelled as the roles the game relies on', async ({ page }) => {
    const labels = await withPanels(page, (panels, elements) => (
        [...elements.addresses.querySelectorAll('.address-index')].map((span) => span.textContent)
    ));

    expect(labels).toEqual(['0 (outside)', '1 (lobby)']);
});

test('every layout variation of an address is reachable', async ({ page }) => {
    const result = await withPanels(page, (panels, elements, floor, state, panel, model) => {
        const row = elements.addresses.querySelectorAll('.address-row')[1];
        const select = row.querySelector('.variations select');

        const before = {
            options: [...select.options].map((option) => option.textContent),
            value: select.value,
        };

        select.value = '1';
        select.dispatchEvent(new Event('change'));

        return {
            before,
            selectedNow: floor.addresses[1].selectedVariation,
            rooms: model.roomsOfAddress(floor, 1).map((room) => room.preset),
        };
    });

    // This is what the reference tool has no equivalent of: it shows vs[0] and writes
    // only that, so 117 of the base game's addresses lose layouts on save.
    expect(result.before.options).toEqual(['Layout 1 of 2', 'Layout 2 of 2']);
    expect(result.before.value).toBe('0');

    expect(result.selectedNow).toBe(1);
    expect(result.rooms).toEqual(['Ballroom']);
});

test('an address with no layouts says so rather than showing an empty list', async ({ page }) => {
    const text = await withPanels(page, (panels, elements, floor, state, panel, model) => {
        model.removeVariation(floor, 1, 1);
        model.removeVariation(floor, 1, 0);
        panel.refresh();

        const row = elements.addresses.querySelectorAll('.address-row')[1];
        return {
            note: row.querySelector('.variation-none')?.textContent ?? null,
            hasSelect: !!row.querySelector('.variations select'),
        };
    });

    // Six base game addresses are in this state, so it is representable rather than
    // prevented.
    expect(text.note).toBe('no layouts');
    expect(text.hasSelect).toBe(false);
});

test('the room list follows the address being painted with', async ({ page }) => {
    const rooms = await withPanels(page, (panels, elements, floor, state, panel) => {
        const outside = [...elements.rooms.querySelectorAll('.room-row')]
            .map((row) => row.dataset.room);

        state.addressIndex = 1;
        panel.refresh();

        const lobby = [...elements.rooms.querySelectorAll('.room-row')]
            .map((row) => row.dataset.room);

        return { outside, lobby };
    });

    expect(rooms.outside).toEqual(['Null#1']);
    expect(rooms.lobby).toEqual(['Lobby#2']);
});

test('choosing a room in the list is what the room tool paints', async ({ page }) => {
    const state = await withPanels(page, (panels, elements, floor, chosen, panel, model, tools) => {
        chosen.addressIndex = 0;
        chosen.tool = tools.Tool.ROOM;
        model.addRoom(floor, 0, 'Kitchen', 7);
        panel.refresh();

        const row = [...elements.rooms.querySelectorAll('.room-row')]
            .find((entry) => entry.dataset.room === 'Kitchen#7');
        const radio = row.querySelector('input[type=radio]');
        radio.checked = true;
        radio.dispatchEvent(new Event('change'));

        tools.applyTool(floor, chosen, { kind: 'cell', x: 10, y: 10 });
        const room = model.roomOfNode(floor, model.nodeAt(floor, 10, 10));

        return { preset: chosen.roomPreset, id: chosen.roomId, painted: `${room.preset}#${room.id}` };
    });

    expect(state).toEqual({ preset: 'Kitchen', id: 7, painted: 'Kitchen#7' });
});

test('the wall picker groups presets by what they are', async ({ page }) => {
    const picker = await withPanels(page, (panels, elements, floor, state) => {
        const select = elements.walls.querySelector('select');
        const groups = [...select.querySelectorAll('optgroup')].map((group) => group.label);

        select.value = '16';
        select.dispatchEvent(new Event('change'));

        return {
            groups,
            count: select.querySelectorAll('option').length,
            chosen: state.wallPreset,
            named: [...select.querySelectorAll('option')].map((option) => option.textContent),
        };
    });

    expect(picker.groups).toEqual(['Walls', 'Windows', 'Doors', 'Blanks']);

    // The 27 presets the game actually has. Ids 28 to 30 exist in the reference tool's
    // table and name nothing, so they are not offered.
    expect(picker.count).toBe(27);
    expect(picker.named).not.toContain('Unknown01');
    expect(picker.chosen).toBe('16');
});

test('a floor naming a wall preset with no name keeps it', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements, floor, state, panel) => {
        state.wallPreset = '29';
        panel.refresh();

        const select = elements.walls.querySelector('select');
        return { value: select.value, first: select.options[0].textContent };
    });

    // Replacing it with a real preset would rewrite a wall nobody asked to change.
    expect(shown.value).toBe('29');
    expect(shown.first).toBe('Unnamed preset 29');
});

test('a selected node shows its fields, and its forced room read-only', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements, floor, state, panel) => {
        state.selectedNode = { x: 9, y: 9 };
        panel.refresh();

        const section = elements.selection.querySelector('.selected-node');
        const forced = section.querySelector('.read-only');

        return {
            heading: section.querySelector('h4').textContent,
            labels: [...section.querySelectorAll('.field > span')].map((span) => span.textContent),
            forcedText: forced?.textContent ?? null,
            forcedIsInput: forced?.tagName === 'INPUT',
            forcedTitle: forced?.getAttribute('title') ?? null,
        };
    });

    expect(shown.heading).toBe('Node 9, 9');
    expect(shown.labels).toContain('Forced room');

    // f_r is carried through untouched and shown so an author knows it is there. It is
    // not editable, because what a doubled value means is not known.
    expect(shown.forcedText).toBe('Lobby.Lobby');
    expect(shown.forcedIsInput).toBe(false);
    expect(shown.forcedTitle).toContain('Not editable');
});

test('a node with no forced room does not show the field at all', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements, floor, state, panel) => {
        state.selectedNode = { x: 10, y: 10 };
        panel.refresh();

        const section = elements.selection.querySelector('.selected-node');
        return [...section.querySelectorAll('.field > span')].map((span) => span.textContent);
    });

    expect(shown).not.toContain('Forced room');
});

test('a selected tile shows its state and which cycle the tool is stepping', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements, floor, state, panel, model) => {
        model.paintTile(model.tileAt(floor, 2, 2), model.TileMode.ELEVATOR);
        model.paintTile(model.tileAt(floor, 2, 2), model.TileMode.ELEVATOR);
        state.selectedTile = { x: 2, y: 2 };
        panel.refresh();

        const section = elements.selection.querySelector('.selected-tile');
        return {
            heading: section.querySelector('h4').textContent,
            values: [...section.querySelectorAll('.field')].map((label) => label.textContent),
        };
    });

    expect(shown.heading).toBe('Tile 2, 2');
    expect(shown.values.join(' ')).toContain('elevator, 90°');
});

test('a wall whose sides disagree says so when selected', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements, floor, state, panel, model) => {
        // Half a wall, which is the state 582 base game wall halves are in.
        model.nodeAt(floor, 6, 6).walls.push({ ox: 0.5, oy: 0, preset: '7' });
        state.selectedWall = { x: 6, y: 6, axis: 'x' };
        panel.refresh();

        const section = elements.selection.querySelector('.selected-wall');
        return {
            heading: section.querySelector('h4').textContent,
            warning: section.querySelector('.warning')?.textContent ?? null,
        };
    });

    expect(shown.heading).toBe('Wall 6, 6 (x)');
    expect(shown.warning).toContain('disagree');
});

test('a floor with something wrong with it says what', async ({ page }) => {
    const notes = await withPanels(page, (panels, elements, floor, state, panel) => {
        panel.refresh();
        return [...elements.selection.querySelectorAll('.issues .note')].map((p) => p.textContent);
    });

    // This fixture has none of the three conditions, so nothing is claimed.
    expect(notes).toEqual([]);
});

test('a colour survives a round trip through the picker', async ({ page }) => {
    const result = await withPanels(page, (panels) => {
        const original = { r: 1, g: 0, b: 0.4, a: 1 };
        const hex = panels.toHex(original);
        const back = panels.fromHex(hex);

        return {
            hex,
            back,
            // The alpha is not the picker's to change, and must not be lost.
            keysBack: Object.keys(back),
        };
    });

    expect(result.hex).toBe('#ff0066');
    expect(result.back.r).toBeCloseTo(1, 2);
    expect(result.back.g).toBeCloseTo(0, 2);
    expect(result.back.b).toBeCloseTo(0.4, 2);

    // fromHex returns only the three channels, so assigning it over a stored colour
    // leaves the alpha alone.
    expect(result.keysBack).toEqual(['r', 'g', 'b']);
});
