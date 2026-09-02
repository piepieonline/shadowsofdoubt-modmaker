import { test, expect } from '@playwright/test';
import { installFsHarness, gotoFlow } from '../test-support/harness.js';

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
            floorTypes: make('floorTypes'),
            walls: make('walls'),
            tiles: make('tiles'),
            status: make('status'),
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
        // Every click here redraws the bar, so nothing may be held across one.
        const click = (selector) => elements.tools.querySelector(selector).click();

        const labels = [...elements.tools.querySelectorAll('.tool-bar button')]
            .map((button) => button.textContent);

        // Into paint first: the hint a floor opens with is about picking, not painting.
        click('.mode-bar button[data-mode="paint"]');
        click('.tool-bar button[data-tool="wall"]');

        return {
            labels,
            active: [...elements.tools.querySelectorAll('.tool-bar button')]
                .filter((button) => button.getAttribute('aria-pressed') === 'true')
                .map((button) => button.dataset.tool),
            tool: state.tool,
            hint: elements.tools.querySelector('.tool-bar + .tool-hint').textContent,
        };
    });

    expect(bar.labels).toEqual(['Address', 'Room', 'Floor type', 'Wall', 'Tile']);
    expect(bar.active).toEqual(['wall']);
    expect(bar.tool).toBe('wall');

    // The modifiers are the whole interface, and shift only means something for walls.
    expect(bar.hint).toContain('Ctrl+click to select');
    expect(bar.hint).toContain('Shift+click to remove');
});

test('the mode bar says what a click does, and survives changing tool', async ({ page }) => {
    const bar = await withPanels(page, (panels, elements, floor, state, panel, model, tools) => {
        const click = (selector) => elements.tools.querySelector(selector).click();
        const hint = () => elements.tools.querySelector('.tool-bar + .tool-hint').textContent;
        const active = () => elements.tools
            .querySelector('.mode-bar button[aria-pressed="true"]').dataset.mode;

        const labels = [...elements.tools.querySelectorAll('.mode-bar button')]
            .map((button) => button.textContent);

        const opensAs = { mode: active(), hint: hint(), loud: null };
        opensAs.loud = elements.tools.querySelector('.mode-bar').classList.contains('on');

        click('.mode-bar button[data-mode="flood"]');
        const flooding = { mode: state.mode, hint: hint(), tool: state.tool };
        flooding.loud = elements.tools.querySelector('.mode-bar').classList.contains('on');

        // The two tools a fill means nothing for.
        click('.tool-bar button[data-tool="wall"]');
        const wall = { mode: state.mode, hint: hint() };

        click('.tool-bar button[data-tool="address"]');
        click('.mode-bar button[data-mode="paint"]');
        const painting = { mode: state.mode, hint: hint() };

        return { labels, opensAs, flooding, wall, painting };
    });

    expect(bar.labels).toEqual(['None', 'Paint', 'Flood']);

    // A floor opens where a click cannot change it, and the bar is quiet about it.
    expect(bar.opensAs.mode).toBe('none');
    expect(bar.opensAs.hint).toBe('Left click to select a square · Nothing is edited');
    expect(bar.opensAs.loud).toBe(false);

    // Flood, and the frame goes loud: the difference between clicking to look and
    // clicking to change 200 cells is not something to have to read a label for.
    expect(bar.flooding.mode).toBe('flood');
    expect(bar.flooding.hint).toContain('Left click to fill up to the walls');
    expect(bar.flooding.loud).toBe(true);

    // The mode is not a sixth tool: switching tools leaves it alone.
    expect(bar.wall.mode).toBe('flood');

    // But the wall tool cannot be filled, so the hint promises what will actually happen.
    expect(bar.wall.hint).toContain('Left click to paint');
    expect(bar.wall.hint).not.toContain('fill');

    expect(bar.painting.mode).toBe('paint');
    expect(bar.painting.hint).toBe('Left click to paint · Ctrl+click to select');
});

test('an address that the base game has no name for is still shown', async ({ page }) => {
    const options = await withPanels(page, (panels, elements) => {
        const rows = [...elements.addresses.querySelectorAll('.address-row')];
        const select = rows[1].querySelector('select');

        return {
            value: select.value,
            // The selected option rather than the first: the control leads with an empty
            // one, which is what stands for "nothing chosen" and what the placeholder is
            // shown in place of. See setOptions in searchSelect.js.
            shown: select.selectedOptions[0].textContent,
            hasBaseGameNames: [...select.options].some((option) => option.value === 'Lobby'),
        };
    });

    // A mod may add a layout configuration, and a floor naming one is valid. Replacing
    // it with whatever happened to be first in the list would rewrite the floor.
    expect(options.value).toBe('MyCustomLayout');
    expect(options.shown).toBe('MyCustomLayout (not a base game asset)');
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

test('switching layout puts the room selection in the layout arriving', async ({ page }) => {
    const result = await withPanels(page, (panels, elements, floor, state, panel, model) => {
        // Two rooms in layout 1, and the second of them selected. Layout 2 has one room,
        // so that slot is about to stop existing.
        state.addressIndex = 1;
        model.addRoom(floor, 1, 'Kitchen');
        state.roomIndex = 1;
        panel.refresh();

        const select = elements.addresses.querySelectorAll('.address-row')[1]
            .querySelector('.variations select');
        select.value = '1';
        select.dispatchEvent(new Event('change'));

        return {
            roomIndex: state.roomIndex,
            room: model.roomAt(floor, 1, state.roomIndex)?.preset ?? null,
            rows: [...elements.rooms.querySelectorAll('.room-row')]
                .map((row) => row.dataset.room),
            checked: [...elements.rooms.querySelectorAll('input[type=radio]')]
                .filter((radio) => radio.checked).length,
        };
    });

    // A layout holds its own rooms, so a slot from the one being left names a different
    // room here, or none at all.
    expect(result.rows).toEqual(['Ballroom#3']);
    expect(result.roomIndex).toBe(0);
    expect(result.room).toBe('Ballroom');
    expect(result.checked).toBe(1);
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
        model.addRoom(floor, 0, 'Kitchen');
        panel.refresh();

        const row = [...elements.rooms.querySelectorAll('.room-row')]
            .find((entry) => entry.dataset.room.startsWith('Kitchen'));
        const radio = row.querySelector('input[type=radio]');
        radio.checked = true;
        radio.dispatchEvent(new Event('change'));

        tools.applyTool(floor, chosen, { kind: 'cell', x: 10, y: 10 });
        const room = model.roomOfNode(floor, model.nodeAt(floor, 10, 10));

        return {
            slot: chosen.roomIndex,
            rowSlot: Number(row.dataset.roomIndex),
            row: row.dataset.room,
            painted: `${room.preset}#${room.id}`,
        };
    });

    // Chosen by slot, not by name: two rooms of an address can carry the same preset and
    // the same id -- 24 in the base game do -- so the row is what says which one.
    expect(state.slot).toBe(1);
    expect(state.rowSlot).toBe(1);

    // Id 4, because 1, 2 and 3 are in use across this floor -- 3 of them in a layout
    // variation that is not even on show.
    expect(state.row).toBe('Kitchen#4');
    expect(state.painted).toBe('Kitchen#4');
});

test('a room’s id is stated rather than offered', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements) => {
        const row = elements.rooms.querySelector('.room-row');

        return {
            id: row.querySelector('.room-id').textContent,
            tag: row.querySelector('.room-id').tagName,
            // The preset is still chosen; only the id has stopped being a question.
            editable: [...row.querySelectorAll('input')].map((input) => input.type),
        };
    });

    expect(shown.id).toBe('#1');
    expect(shown.tag).toBe('SPAN');
    expect(shown.editable).toEqual(['radio']);
});

test('removing a room leaves its squares in the address’s Null room', async ({ page }) => {
    const result = await withPanels(page, (panels, elements, floor, state, panel, model) => {
        const kitchen = model.addRoom(floor, 0, 'Kitchen');
        model.setNodeRoom(floor, model.nodeAt(floor, 10, 10), 0, kitchen.roomIndex);

        state.roomIndex = kitchen.roomIndex;
        panel.refresh();

        const row = [...elements.rooms.querySelectorAll('.room-row')]
            .find((entry) => entry.dataset.room.startsWith('Kitchen'));
        row.querySelector('.room-remove').click();

        const node = model.nodeAt(floor, 10, 10);
        return {
            rows: [...elements.rooms.querySelectorAll('.room-row')].map((entry) => entry.dataset.room),
            room: model.roomOfNode(floor, node).preset,
            selected: state.roomIndex,
        };
    });

    expect(result.rows).toEqual(['Null#1']);
    expect(result.room).toBe('Null');

    // The selection was on the row that went, so it lands on what took its place --
    // here the only row left, rather than a slot that no longer exists.
    expect(result.selected).toBe(0);
});

test('a new address arrives with a room, and naming it adds the room of that name', async ({ page }) => {
    const result = await withPanels(page, (panels, elements, floor, state, panel, model) => {
        elements.addresses.querySelector('.add-entry').click();

        const rooms = () => [...elements.rooms.querySelectorAll('.room-row')]
            .map((row) => row.dataset.room);

        const onAdd = rooms();

        const row = elements.addresses.querySelectorAll('.address-row')[2];
        // The layout picker, not the variation one beside it. Both are inside a box of
        // their own now -- see keptSelects.js -- so the class is what tells them apart.
        const select = row.querySelector('.layout-select select');
        select.value = 'Ballroom';
        select.dispatchEvent(new Event('change'));

        return {
            onAdd,
            named: rooms(),
            address: state.addressIndex,
            layout: floor.addresses[2].layoutConfiguration,
        };
    });

    expect(result.address).toBe(2);
    expect(result.layout).toBe('Ballroom');

    // Something to paint with immediately, and the room the layout is named after once
    // that layout is chosen. 19 of the game's 32 layout configurations share a name with
    // a room preset, and an address of one nearly always holds a room of that name.
    expect(result.onAdd).toEqual(['Null#4']);
    expect(result.named).toEqual(['Null#4', 'Ballroom#5']);
});

test('removing an address takes its squares and its layouts with it', async ({ page }) => {
    const result = await withPanels(page, (panels, elements, floor, state, panel, model) => {
        model.setNodeAddress(floor, model.nodeAt(floor, 10, 10), 1);

        state.addressIndex = 1;
        panel.refresh();

        // An address holding squares asks first, since there is no undo and the answer
        // decides whether 1 square or 441 change hands.
        const asked = [];
        window.confirm = (message) => { asked.push(message); return true; };

        const rows = () => [...elements.addresses.querySelectorAll('.address-row')]
            .map((row) => row.querySelector('.layout-select select').value);

        const before = rows();
        elements.addresses.querySelectorAll('.address-row')[1]
            .querySelector('.address-remove').click();

        const node = model.nodeAt(floor, 10, 10);
        return {
            asked,
            before,
            after: rows(),
            addressOfNode: node.addressIndex,
            room: model.roomOfNode(floor, node).preset,
            selected: state.addressIndex,
            rooms: [...elements.rooms.querySelectorAll('.room-row')].map((row) => row.dataset.room),
        };
    });

    expect(result.before).toEqual(['Outside', 'MyCustomLayout']);
    expect(result.after).toEqual(['Outside']);

    // What it costs, in the terms the panel shows: which address, and how many squares.
    expect(result.asked).toEqual(['Delete address 1 (MyCustomLayout)? 1 painted square(s) go back to Outside.']);

    // The square it held is not dropped. A square in no address is the one thing
    // serialising refuses to write, so it goes where an unclaimed square goes.
    expect(result.addressOfNode).toBe(0);
    expect(result.room).toBe('Null');

    // The painting selection was on the row that went, so it lands on the Outside and
    // the room list below follows it there.
    expect(result.selected).toBe(0);
    expect(result.rooms).toEqual(['Null#1']);
});

test('declining the confirm leaves the address exactly as it was', async ({ page }) => {
    const result = await withPanels(page, (panels, elements, floor, state, panel, model) => {
        model.setNodeAddress(floor, model.nodeAt(floor, 10, 10), 1);
        window.confirm = () => false;

        elements.addresses.querySelectorAll('.address-row')[1]
            .querySelector('.address-remove').click();

        return {
            addresses: floor.addresses.map((address) => address.layoutConfiguration),
            addressOfNode: model.nodeAt(floor, 10, 10).addressIndex,
            variations: floor.addresses[1].variations.length,
        };
    });

    expect(result.addresses).toEqual(['Outside', 'MyCustomLayout']);
    expect(result.addressOfNode).toBe(1);
    expect(result.variations).toBe(2);
});

test('an address holding nothing is removed without asking', async ({ page }) => {
    const result = await withPanels(page, (panels, elements, floor, state, panel, model) => {
        let asked = 0;
        window.confirm = () => { asked++; return true; };

        elements.addresses.querySelectorAll('.address-row')[1]
            .querySelector('.address-remove').click();

        return { asked, addresses: floor.addresses.length };
    });

    // Nothing is lost that was not already empty, so a dialog here is in the way.
    expect(result.asked).toBe(0);
    expect(result.addresses).toBe(1);
});

test('the Outside address offers no way to remove it', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements, floor, state, panel, model) => {
        const buttons = [...elements.addresses.querySelectorAll('.address-row')]
            .map((row) => row.querySelector('.address-remove'));

        window.confirm = () => true;
        buttons[0].click();

        // Greyed rather than absent, so the reason is on the button.
        return {
            disabled: buttons.map((button) => button.disabled),
            title: buttons[0].title,
            addresses: floor.addresses.length,
        };
    });

    expect(shown.disabled).toEqual([true, false]);
    expect(shown.title).toBe('The Outside address cannot be removed');
    expect(shown.addresses).toBe(2);
});

test('the wall picker groups presets by what they are', async ({ page }) => {
    const picker = await withPanels(page, (panels, elements, floor, state) => {
        const select = elements.walls.querySelector('select');
        const groups = [...select.querySelectorAll('optgroup')].map((group) => group.label);

        select.value = '16';
        select.dispatchEvent(new Event('change'));

        // Less the empty one the control leads with, which stands for "nothing chosen"
        // and is not a preset. See setOptions in searchSelect.js.
        const offered = [...select.querySelectorAll('option')]
            .filter((option) => option.value !== '');

        return {
            groups,
            count: offered.length,
            chosen: state.wallPreset,
            named: offered.map((option) => option.textContent),
        };
    });

    expect(picker.groups).toEqual(['Walls', 'Windows', 'Doors', 'Blanks']);

    // The 27 presets the game actually has, less the two divider ends, plus the one piece
    // that stands for both. Ids 28 to 30 exist in the reference tool's table and name
    // nothing, so they are not offered.
    expect(picker.count).toBe(26);
    expect(picker.named).not.toContain('Unknown01');
    expect(picker.chosen).toBe('16');
});

/**
 * The two ends are not offered as themselves.
 *
 * Which of them a wall gets is worked out when it is written, from where in its run the
 * wall falls -- see dividerEnds.js. Offering the ids as a choice would let an author
 * pick one and have the editor immediately overrule it, which is worse than not asking.
 */
test('the wall picker offers one divider end rather than a left and a right', async ({ page }) => {
    const picker = await withPanels(page, (panels, elements, floor, state) => {
        const select = elements.walls.querySelector('select');

        select.value = 'dividerEnd';
        select.dispatchEvent(new Event('change'));

        return {
            named: [...select.querySelectorAll('option')].map((option) => option.textContent),
            values: [...select.querySelectorAll('option')].map((option) => option.value),
            chosen: state.wallPreset,
        };
    });

    expect(picker.named).toContain('Divider end');
    expect(picker.named).not.toContain('DividerEndLeft');
    expect(picker.named).not.toContain('DividerEndRight');

    // The centre is still a preset an author picks, because it is one thing rather than a
    // pair, and nothing has to be decided about which way round it goes.
    expect(picker.named).toContain('DividerCentre');

    expect(picker.values).not.toContain('5');
    expect(picker.values).not.toContain('6');
    expect(picker.chosen).toBe('dividerEnd');
});

/*
 * The tile setting. Two of its three choices step a tile through a cycle and the third
 * turns a stairwell's mirroring on and off, so the line under the picker is per choice:
 * one sentence covering all three could only be vague about the difference that decides
 * what a second click on the same tile does.
 */

test('the tile picker says what a click does with the setting chosen', async ({ page }) => {
    const picker = await withPanels(page, (panels, elements, floor, state) => {
        // Looked up again after every change: choosing redraws the panel, so neither the
        // select nor the line under it survives one.
        const choose = (value) => {
            const select = elements.tiles.querySelector('select');
            select.value = value;
            select.dispatchEvent(new Event('change'));

            return { chosen: state.tileMode, hint: elements.tiles.querySelector('.tool-hint').textContent };
        };

        return {
            named: [...elements.tiles.querySelectorAll('option')].map((option) => option.textContent),
            stairwell: choose('stairwell'),
            inverted: choose('inverted'),
            entrance: choose('entrance'),
        };
    });

    expect(picker.named).toEqual(['Stairwell', 'Inverted', 'Entrance']);

    expect(picker.stairwell.chosen).toBe('stairwell');
    expect(picker.stairwell.hint).toContain('each rotation');

    // The one that is a toggle rather than a cycle, and the only one where a second click
    // on the same tile undoes the first instead of moving it on.
    expect(picker.inverted.chosen).toBe('inverted');
    expect(picker.inverted.hint).toContain('changes nothing else');

    expect(picker.entrance.chosen).toBe('entrance');
    expect(picker.entrance.hint).toContain('main entrance');
});

/*
 * The floor type setting. Both halves of it are checked because the tool writes both:
 * setNodeFloor takes a type and a height together, so a panel that set one and not the
 * other would paint the other from whatever was last picked off the floor.
 */

test('the floor type picker offers every type and sets what is painted', async ({ page }) => {
    const picker = await withPanels(page, (panels, elements, floor, state) => {
        const select = elements.floorTypes.querySelector('select');

        select.value = '2';
        select.dispatchEvent(new Event('change'));

        return {
            named: [...select.options].map((option) => option.textContent),
            chosen: state.floorType,
            // The line under the picker, which is where "noneButIndoors" is explained and
            // where how each type is drawn is said.
            note: elements.floorTypes.querySelector('.tool-hint')?.textContent ?? null,
        };
    });

    expect(picker.named).toEqual([
        'none', 'floorAndCeiling', 'floorOnly', 'CeilingOnly', 'noneButIndoors',
    ]);

    // A number, not a name: state.floorType indexes the enum, and setNodeFloor writes it
    // straight into f_t.
    expect(picker.chosen).toBe(2);
    expect(picker.note).toContain('rooftop or a yard');
});

test('the height field takes a whole number and refuses anything else', async ({ page }) => {
    const typed = await withPanels(page, (panels, elements, floor, state) => {
        // Looked up again each time: an accepted value redraws the panel, so the element
        // that was typed into is no longer the one on screen.
        const enter = (value) => {
            const field = elements.floorTypes.querySelector('input[type="number"]');
            field.value = value;
            field.dispatchEvent(new Event('change'));

            return {
                held: state.extraHeight,
                shown: elements.floorTypes.querySelector('input[type="number"]').value,
            };
        };

        return {
            start: state.extraHeight,
            raised: enter('8'),
            fraction: enter('1.5'),
            cleared: enter(''),
        };
    });

    expect(typed.start).toBe(0);
    expect(typed.raised).toEqual({ held: 8, shown: '8' });

    // f_h is an integer and an empty box reads as 0, so neither a fraction nor a cleared
    // field is taken: both put the setting back rather than quietly painting at floor
    // level.
    expect(typed.fraction).toEqual({ held: 8, shown: '8' });
    expect(typed.cleared).toEqual({ held: 8, shown: '8' });
});

test('a floor type the enum has no name for is kept', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements, floor, state, panel) => {
        state.floorType = 9;
        panel.refresh();

        const select = elements.floorTypes.querySelector('select');
        return { value: select.value, first: select.options[0].textContent };
    });

    // The enum is positional, so a game update adding a type leaves the generated list
    // short. Showing the number keeps that square paintable back to what it was.
    expect(shown.value).toBe('9');
    expect(shown.first).toBe('Type 9');
});

test('a floor naming a wall preset with no name keeps it', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements, floor, state, panel) => {
        state.wallPreset = '29';
        panel.refresh();

        const select = elements.walls.querySelector('select');
        // The selected option, not the first: the control leads with an empty one.
        return { value: select.value, shown: select.selectedOptions[0].textContent };
    });

    // Replacing it with a real preset would rewrite a wall nobody asked to change.
    expect(shown.value).toBe('29');
    expect(shown.shown).toBe('Unnamed preset 29');
});

/*
 * The status column: what a click would paint, and what is already under the pointer,
 * over the same five rows. The hovered target is passed to renderStatusPanel rather than
 * set on the tool state, which is how the flow does it -- the pointer moves far more
 * often than anything else in the panels changes, so it is redrawn on its own.
 */

test('a hovered node\'s forced room is named, and nothing in the column is editable', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements, floor, state) => {
        panels.renderStatusPanel(elements.status, floor, state, { kind: 'cell', x: 9, y: 9 });

        const under = elements.status.querySelectorAll('.status-block')[1];
        return {
            caption: under.querySelector('.status-note').textContent,
            notes: [...under.querySelectorAll('.note')].map((p) => p.textContent),
            controls: elements.status.querySelectorAll('input, select, button').length,
        };
    });

    expect(shown.caption).toBe('Node 9, 9');

    // f_r is carried through untouched and named so an author knows it is there. It is
    // not editable, because what a doubled value means is not known -- and neither is
    // anything else here: the column says what is, and the panels beside it set it.
    expect(shown.notes).toContain('Forced room: Lobby.Lobby');
    expect(shown.controls).toBe(0);
});

test('a node with no forced room is not said to have one', async ({ page }) => {
    const notes = await withPanels(page, (panels, elements, floor, state) => {
        panels.renderStatusPanel(elements.status, floor, state, { kind: 'cell', x: 10, y: 10 });

        const under = elements.status.querySelectorAll('.status-block')[1];
        return [...under.querySelectorAll('.note')].map((p) => p.textContent);
    });

    expect(notes).toEqual([]);
});

test('a hovered tile is described by what it carries', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements, floor, state, panel, model) => {
        // A mirrored stairwell, turned through its first rotation. Two settings, because
        // the two facts are two settings' -- Inverted only ever turns the mirroring on and
        // off, and the stairwell cycle is what aims it.
        model.paintTile(model.tileAt(floor, 2, 2), model.TileMode.INVERTED);
        model.paintTile(model.tileAt(floor, 2, 2), model.TileMode.STAIRWELL);

        // A tile is three nodes square, so the hover is over a node *in* tile 2,2 rather
        // than at the same numbers -- node 2,2 is in tile 0,0 and carries nothing.
        panels.renderStatusPanel(elements.status, floor, state, { kind: 'cell', x: 6, y: 6 });

        const under = elements.status.querySelectorAll('.status-block')[1];
        return under.querySelector('.status-row[data-type="tile"] .status-value').textContent;
    });

    // Stairs, turned, and the mirrored preset -- three separate things about one tile,
    // which the column has one line for and so joins.
    expect(shown).toContain('Stairs 90° · Inverted');
});

test('a wall whose sides disagree says so when hovered', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements, floor, state, panel, model) => {
        // Half a wall, which is the state 582 base game wall halves are in.
        model.nodeAt(floor, 6, 6).walls.push({ ox: 0.5, oy: 0, preset: '7' });
        panels.renderStatusPanel(elements.status, floor, state, { kind: 'wall', x: 6, y: 6, axis: 'x' });

        const under = elements.status.querySelectorAll('.status-block')[1];
        return {
            caption: under.querySelector('.status-note').textContent,
            wall: under.querySelector('.status-row[data-type="wall"] .status-value').textContent,
            // A hover is over a wall or over a cell, never both, so the node's four rows
            // are left blank rather than filled in from whichever cell is behind it.
            room: under.querySelector('.status-row[data-type="room"] .status-value').textContent,
        };
    });

    expect(shown.caption).toBe('Wall 6, 6 (x)');
    expect(shown.wall).toContain('sides disagree');
    expect(shown.room).toBe('—');
});

test('with nothing hovered the column still lists every type', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements, floor, state) => {
        panels.renderStatusPanel(elements.status, floor, state, null);

        const blocks = [...elements.status.querySelectorAll('.status-block')];
        return {
            titles: blocks.map((block) => block.querySelector('strong').textContent),
            rows: blocks.map((block) => [...block.querySelectorAll('.status-row')]
                .map((row) => row.dataset.type)),
            // Switching tool to find out what is under the pointer would change what the
            // next click does. Every type is listed so that is never necessary.
            active: blocks.map((block) => block.querySelector('.status-row.active').dataset.type),
        };
    });

    // A fresh tool state is in None, where the top block is the square that was clicked
    // rather than a brush. Both blocks keep all five rows in all three modes.
    const everyType = ['address', 'room', 'floorType', 'wall', 'tile'];
    expect(shown.titles).toEqual(['Selected square', 'Under the pointer']);
    expect(shown.rows).toEqual([everyType, everyType]);
    expect(shown.active).toEqual(['address', 'address']);
});

/**
 * The top block is two different things, and says which it is.
 *
 * In None a click reads a square, so the block is that square and is headed for it. In
 * Paint and Flood it is the brush, and the caption is what tells those two apart -- the
 * same five values, put down one square at a time or up to the walls at once.
 */
test('the top block is headed for what it holds in each mode', async ({ page }) => {
    const shown = await withPanels(page, (panels, elements, floor, state, panel, model, tools) => {
        const read = () => {
            panels.renderStatusPanel(elements.status, floor, state, null);
            const block = elements.status.querySelector('.status-block');
            return {
                title: block.querySelector('strong').textContent,
                caption: block.querySelector('.status-note')?.textContent ?? null,
            };
        };

        const seen = { none: read() };
        state.selectedNode = { x: 9, y: 9 };
        seen.selected = read();

        state.mode = tools.PaintMode.PAINT;
        seen.paint = read();
        state.mode = tools.PaintMode.FLOOD;
        seen.flood = read();
        return seen;
    });

    // Nothing clicked yet, so the block says how to fill it rather than showing five
    // dashes with no explanation.
    expect(shown.none.title).toBe('Selected square');
    expect(shown.none.caption).toBe('Click a square to select it');

    // And once something is, which square. That is what the caption used to be
    // apologising for when the heading still said "Painting with".
    expect(shown.selected.title).toBe('Selected square');
    expect(shown.selected.caption).toBe('Node 9, 9');

    expect(shown.paint.title).toBe('Painting with');
    expect(shown.flood.title).toBe('Painting with');

    // Paint is the plain case, and a caption restating the heading is noise.
    expect(shown.paint.caption).toBe(null);
    expect(shown.flood.caption).toBe('A click fills up to the walls with these');
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


/*
 * What could spawn on the square under the pointer.
 *
 * The chain is covered against every base game floor in
 * flows/building/scripts/furnitureChain.unit.spec.js, so what is worth a browser here is
 * only what that suite cannot reach: that the section renders, that it is collapsed until
 * asked, that opening one group survives the redraw the next pointer move causes, and
 * that it says nothing at all before the reference data has arrived.
 *
 * It hangs off the **selected** square rather than the hovered one, so these set
 * `selectedNode` and pass no hover. That is what lets a list be read and scrolled: a
 * forty-row disclosure that reset every time the pointer left the canvas would be one
 * nobody could reach the bottom of.
 */

/**
 * The status column over a real blueprint, with the chain data loaded and a square
 * selected.
 *
 * `withPanels` builds a floor whose layouts are `Outside` and one the base game does not
 * have, so neither resolves to any furniture. This opens Eden_OfficeFloor01, which is an
 * `OfficeHighrise` -- the layout both `HighriseOffice` and `Laboratory` compete for, and
 * so the case the grouping exists for.
 *
 * `status` is passed to the body as the whole column; the furniture is in its **first**
 * block, which in None is the selected square.
 */
/*
 * `mod` lays assets over the chain the way a selected mod would, in the shape
 * `readModAssets` reports them -- for the sections the checker offers.
 *
 * `keepHost` leaves the column in the page after the body has run, for a test that has to
 * reach the control through the browser rather than through the DOM: the dropdown is
 * select2's, and opening it is the only way to see what it renders. Those tests take the
 * page as it is left, so they must be the only thing on it.
 */
async function withOfficeStatus(page, body, {
    loadChain = true, blueprint = 'Eden_OfficeFloor01', roomType = 'OfficeSpace',
    mod = null, keepHost = false,
} = {}) {
    return page.evaluate(async ({ source, loadChain, blueprint, roomType, mod, keepHost }) => {
        const panels = await import('/flows/building/scripts/panels.js');
        const tools = await import('/flows/building/scripts/tools.js');
        const model = await import('/flows/building/scripts/floorModel.js');
        const chain = await import('/flows/building/scripts/furnitureChain.js');
        Object.assign(window, (await import('/flows/building/scripts/loadRefs.js')).default);

        chain.setFurnitureChain(loadChain ? await chain.loadFurnitureChain() : null);
        if (mod) chain.applyModOverlay(mod);

        const floor = model.parseFloor(
            await (await fetch(`/refs/floors/blueprints/${blueprint}.json`)).json());

        // One node of the first room of that type, which is the square selected.
        const room = floor.rooms.find((entry) => entry.preset === roomType);
        const index = floor.nodes.findIndex((node) => node
            && node.addressIndex === room.addressIndex && node.roomIndex === room.roomIndex);
        const at = { x: index % 21, y: Math.floor(index / 21) };

        // The flow opens asking for folders, and a modal dialog holds the top layer: it
        // takes every click on the page. Everything else here works through the DOM and
        // never notices, but a test that has to reach the control the way a person would
        // cannot get past it.
        if (keepHost) for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();

        const host = document.createElement('div');
        document.body.appendChild(host);
        const status = document.createElement('div');
        host.appendChild(status);

        // None is where a click reads rather than writes, and is what a floor opens in.
        const state = tools.createToolState({ mode: tools.PaintMode.NONE, selectedNode: at });
        const draw = (hovered = null) => panels.renderStatusPanel(status, floor, state, hovered);
        draw();

        try {
            // eslint-disable-next-line no-new-func
            const result = await new Function('status', 'draw', 'at', 'floor', 'panels', 'state',
                `return (${source})(status, draw, at, floor, panels, state)`)(
                status, draw, at, floor, panels, state);

            // The sections the checker offers, read off the `<select>` behind the control.
            // Reported for every call because it costs nothing and it is what several of
            // these are about; a body returning nothing gets it as the whole result.
            const sections = [...status.querySelectorAll('.furniture-check-pick optgroup')]
                .map((group) => ({
                    label: group.label,
                    count: group.children.length,
                    options: [...group.children].map((option) => option.text),
                }));

            return result === undefined ? { sections: sections.map(
                // The base game's 310 are pinned by count rather than listed.
                (section) => (section.count > 20
                    ? { label: section.label, count: section.count }
                    : { label: section.label, options: section.options })) } : result;
        } finally {
            if (!keepHost) host.remove();
        }
    }, { source: body.toString(), loadChain, blueprint, roomType, mod, keepHost });
}

test('the furniture section groups by the address presets competing for the unit', async ({ page }) => {
    const shown = await withOfficeStatus(page, (status) => ({
        // The first block, which in None is the selected square. The hover block below
        // it has notes of its own, so the whole column is the wrong thing to search.
        block: status.querySelector('.status-block strong').textContent,
        heading: status.querySelector('.furniture-header')?.textContent,
        note: [...status.querySelector('.status-block').querySelectorAll('.status-note')]
            .pop()?.textContent,
        groups: [...status.querySelectorAll('.furniture-group')].map((group) => ({
            address: group.querySelector('.furniture-address').textContent,
            config: group.querySelector('.furniture-config').textContent,
            count: group.querySelector('.furniture-count').textContent,
            open: group.open,
        })),
    }));

    expect(shown.block).toBe('Selected square');
    expect(shown.heading).toBe('Furniture');

    // Two presets, and the whole chain on the summary line: the room class is what every
    // filter below it keys off, and is why the two groups differ at all.
    expect(shown.groups).toHaveLength(2);
    expect(shown.groups[0].address).toBe('HighriseOffice');
    expect(shown.groups[0].config).toBe('Office / OfficeSpace');
    expect(shown.groups[1].address).toBe('Laboratory');
    expect(shown.groups[1].config).toBe('Laboratory / Laboratory');
    expect(Number(shown.groups[0].count)).toBeGreaterThan(0);

    // Collapsed until asked. A few dozen names under each would push the five type rows
    // above them off the column on every hover.
    expect(shown.groups.map((group) => group.open)).toEqual([false, false]);

    // The list errs wide, and says where. Reading it as a promise is the failure mode
    // this line exists to prevent.
    expect(shown.note).toContain('Could spawn, not will');
    expect(shown.note).toContain('design style');
});

test('an open group lists furniture under its slot class, and stays open across a redraw', async ({ page }) => {
    const shown = await withOfficeStatus(page, (status, draw, at) => {
        const open = () => {
            const group = status.querySelector('.furniture-group');
            group.open = true;
            group.dispatchEvent(new Event('toggle'));
        };
        open();

        const rows = () => [...status.querySelectorAll('.furniture-group')][0]
            .querySelectorAll('.furniture-row');

        const cubicles = [...rows()]
            .find((row) => row.querySelector('.furniture-class').textContent === '1x1OfficeCubicle');

        const before = {
            rows: rows().length,
            class: cubicles.querySelector('.furniture-class').textContent,
            presets: [...cubicles.querySelectorAll('.furniture-preset')].map((p) => p.textContent),
        };

        // The pointer moves one square. The column is rebuilt from scratch, which is what
        // would close a details element that kept its own state -- and the selection has
        // not moved, so the same groups are rebuilt under it.
        draw({ kind: 'cell', x: at.x + 1, y: at.y });

        return {
            ...before,
            stillOpen: status.querySelector('.furniture-group').open,
            // The second group was never opened and must not have been opened for us.
            secondClosed: !status.querySelectorAll('.furniture-group')[1].open,
        };
    });

    expect(shown.rows).toBeGreaterThan(1);
    expect(shown.class).toBe('1x1OfficeCubicle');
    expect(shown.presets).toEqual(['ModernOfficeCubicle', 'OfficeCubicle']);
    expect(shown.stillOpen).toBe(true);
    expect(shown.secondClosed).toBe(true);
});

test('the checker answers Possible or No with the first gate that failed', async ({ page }) => {
    const shown = await withOfficeStatus(page, (status, draw) => {
        const pick = status.querySelector('.furniture-check-pick');

        const ask = (preset) => {
            pick.value = preset;
            pick.dispatchEvent(new Event('change'));

            // Each verdict is one element holding its own answer and reason, so nothing
            // here has to pair them up by position.
            return [...status.querySelectorAll('.verdict')].map((verdict) => ({
                address: verdict.querySelector('.verdict-address').textContent,
                answer: verdict.querySelector('.verdict-answer').textContent,
                reason: verdict.querySelector('.verdict-reason')?.textContent ?? null,
            }));
        };

        const before = status.querySelectorAll('.verdict').length;

        // What the control holds before anything is asked. A `<select>` with no option
        // marked selected takes its first one, which would show a preset nobody chose --
        // and answer for none of them, since choosing that same entry fires no change.
        const blank = pick.value;

        const cubicle = ask('OfficeCubicle');
        const bookcase = ask('LargeBookcase');

        // The pointer moves. The column is rebuilt, and the question has to survive it.
        draw({ kind: 'cell', x: 4, y: 4 });

        return {
            before,
            cubicle,
            bookcase,
            kept: status.querySelector('.furniture-check-pick').value,
            // Every preset the base game has, to choose from -- all of them under one
            // heading, since nothing here has a mod selected.
            sections: [...status.querySelectorAll('.furniture-check-pick optgroup')]
                .map((group) => group.label),
            // Inside the sections, so the empty "nothing asked yet" option is not counted
            // as something offered.
            options: status.querySelectorAll('.furniture-check-pick optgroup option').length,
            blank,
        };
    });

    // Nothing asked, nothing answered, and nothing showing as chosen.
    expect(shown.before).toBe(0);
    expect(shown.blank).toBe('');

    expect(shown.sections).toEqual(['Vanilla']);
    expect(shown.options).toBe(310);

    // One verdict per address preset competing for the unit, which is what makes the
    // question answerable at all: the same square is an office or a laboratory.
    expect(shown.cubicle.map((line) => line.address)).toEqual(['HighriseOffice', 'Laboratory']);
    expect(shown.cubicle[0].answer).toBe('Possible');
    expect(shown.cubicle[0].reason).toBeNull();

    expect(shown.cubicle[1].answer).toBe('No');
    expect(shown.cubicle[1].reason).toContain('do not cover Laboratory');

    // A preset failing several gates is answered by the first: LargeBookcase cannot
    // reach an office at all, which is *why* no office cluster has a slot for it.
    expect(shown.bookcase[0].answer).toBe('No');
    expect(shown.bookcase[0].reason).toBe('Its room filters (GeneralFurnishing, PawnShop '
        + 'and LoanShark) do not cover OfficeSpace.');

    expect(shown.kept).toBe('LargeBookcase');
});

/**
 * A name the reference data does not have is answered, not ignored.
 *
 * This is the reason the control allows a value that is not on its list at all. An author
 * who has just written a preset, or who has mistyped one, is asking a real question, and
 * the walk has a real answer for it -- so the control must be able to carry a name nobody
 * put in the list, and the panel must ask about it rather than fall back to an option.
 *
 * Driven through the control's own search box rather than by writing to the `<select>`,
 * because inventing the option is exactly the behaviour under test.
 */
test('a preset the data has never heard of is asked about anyway', async ({ page }) => {
    await withOfficeStatus(page, () => {}, { keepHost: true });

    // The rendered control, not the `<select>` behind it.
    await page.locator('.furniture-check .select2-selection').click();

    // Typed rather than filled. select2 searches on the keystrokes, so setting the field's
    // value outright leaves the list unfiltered and the pick takes whatever was already
    // highlighted -- which is not what was asked, and passes for the wrong reason.
    await page.locator('.select2-search__field').pressSequentially('MyModsSofa');
    await page.locator('.select2-results__option--highlighted').click();

    // One verdict per address preset competing for the unit, as for any other name: not
    // being in the data is a reason like the rest, not a special case that short-circuits.
    await expect(page.locator('.furniture-check .verdict-reason')).toHaveText([
        'The base game has no furniture preset called MyModsSofa.',
        'The base game has no furniture preset called MyModsSofa.',
    ]);

    await expect(page.locator('.furniture-check .verdict-answer')).toHaveText(['No', 'No']);
});

/**
 * The dropdown's search box leaves room for the icon Pico paints on it.
 *
 * select2 writes that box as `<input type="search">`, which Pico gives a magnifier and a
 * `padding-inline-start` to clear it. A `padding` shorthand anywhere that outranks Pico
 * takes the inset with it and every character typed runs under the icon -- which is what
 * the case flow's stylesheet used to do to it.
 */
test('the search box starts after the search icon', async ({ page }) => {
    await withOfficeStatus(page, () => {}, { keepHost: true });

    await page.locator('.furniture-check .select2-selection').click();

    const inset = await page.locator('.select2-search__field').evaluate((field) => {
        const style = getComputedStyle(field);
        return {
            start: parseFloat(style.paddingInlineStart),
            // Only meaningful if there is an icon to clear in the first place.
            icon: style.backgroundImage,
        };
    });

    expect(inset.icon).toContain('svg');

    // Pico's inset is the horizontal spacing plus 1.75rem, and the icon is 1rem wide at
    // 0.125rem in. Anything at or below the icon's right edge puts text under it.
    expect(inset.start).toBeGreaterThan(18);
});

/**
 * The control survives the column being rebuilt around it.
 *
 * The status column is a full redraw on every pointer move. A control rebuilt that often
 * would take an open dropdown away at the first twitch that crossed a square, and would
 * hand select2 a fresh select over 310 names each time -- so the checker is kept and
 * re-appended rather than rebuilt, and only the verdict under it is redrawn.
 */
test('the checker is kept across a redraw rather than rebuilt', async ({ page }) => {
    const shown = await withOfficeStatus(page, (status, draw, at) => {
        const pick = status.querySelector('.furniture-check-pick');
        pick.value = 'OfficeCubicle';
        pick.dispatchEvent(new Event('change'));

        const verdicts = () => status.querySelectorAll('.verdict').length;
        const before = verdicts();

        // The pointer crosses a square. The whole column is rebuilt.
        draw({ kind: 'cell', x: at.x + 1, y: at.y });

        const after = status.querySelector('.furniture-check-pick');
        return {
            before,
            after: verdicts(),
            // The same element, so this is a survival rather than a restore.
            same: after === pick,
            value: after.value,
            // Still attached: re-appending moves an element, it does not copy it.
            attached: status.contains(after),
        };
    });

    expect(shown.same).toBe(true);
    expect(shown.attached).toBe(true);
    expect(shown.value).toBe('OfficeCubicle');

    // The question is still answered, and answered for the square that is still selected
    // -- the pointer moved, and the selection did not.
    expect(shown.before).toBe(2);
    expect(shown.after).toBe(2);
});

/**
 * A mod's own presets come first, under a heading of their own.
 *
 * An author reaching for this list is usually asking about something they just wrote, and
 * their own handful should not be somewhere below the three hundred they did not write.
 */
test('the mod\'s own presets are offered before the base game\'s', async ({ page }) => {
    const shown = await withOfficeStatus(page, () => {}, {
        mod: [
            { type: 'FurniturePreset', name: 'MyModsSofa', file: 'MyModsSofa', patch: false,
                raw: { name: 'MyModsSofa' } },
        ],
    });

    expect(shown.sections).toEqual([
        { label: 'Modded', options: ['MyModsSofa'] },
        { label: 'Vanilla', count: 310 },
    ]);
});

test('a room class no cluster targets says so rather than opening onto nothing', async ({ page }) => {
    const shown = await withOfficeStatus(page, (status) => {
        const group = status.querySelector('.furniture-group');
        group.open = true;
        group.dispatchEvent(new Event('toggle'));

        return {
            count: group.querySelector('.furniture-count').textContent,
            rows: group.querySelectorAll('.furniture-row').length,
            empty: group.querySelector('.furniture-empty')?.textContent,
        };
    }, { blueprint: 'CityHall_FirstFloor', roomType: 'Atrium' });

    // 22 address-and-room pairs across the base game are in this state -- every Atrium,
    // and every Null room in a real address. A group that opened onto nothing would read
    // as the panel having failed rather than as the room having no furniture.
    expect(shown.count).toBe('0');
    expect(shown.rows).toBe(0);

    // The walk's own sentence rather than one of the panel's. The two used to word this
    // separately, and the panel's named the room filters whatever had actually stopped the
    // clusters -- see `unfurnishedReason`.
    expect(shown.empty).toBe('No furniture cluster is placeable in Atrium rooms, so nothing is '
        + 'furnished there at all.');
});

test('the section is absent, not empty, before the reference data arrives', async ({ page }) => {
    const shown = await withOfficeStatus(page, (status) => ({
        header: status.querySelector('.furniture-header'),
        groups: status.querySelectorAll('.furniture-group').length,
        // Everything else in the column is read off the floor and is there regardless.
        rows: status.querySelectorAll('.status-row').length,
    }), { loadChain: false });

    // A heading with nothing under it would say the square has no furniture, which is a
    // different claim from not yet knowing.
    expect(shown.header).toBeNull();
    expect(shown.groups).toBe(0);
    expect(shown.rows).toBeGreaterThan(0);
});
