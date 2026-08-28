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
            floorTypes: make('floorTypes'),
            walls: make('walls'),
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
    expect(bar.hint).toContain('Ctrl+click to pick');
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
    expect(bar.opensAs.hint).toBe('Left click to select and pick · Nothing is edited');
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
    expect(bar.painting.hint).toBe('Left click to paint · Ctrl+click to pick');
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
        const select = row.querySelector(':scope > select');
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
        return { value: select.value, first: select.options[0].textContent };
    });

    // Replacing it with a real preset would rewrite a wall nobody asked to change.
    expect(shown.value).toBe('29');
    expect(shown.first).toBe('Unnamed preset 29');
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
        // Twice: on turns the elevator on, and again turns it through its first rotation.
        model.paintTile(model.tileAt(floor, 2, 2), model.TileMode.ELEVATOR);
        model.paintTile(model.tileAt(floor, 2, 2), model.TileMode.ELEVATOR);

        // A tile is three nodes square, so the hover is over a node *in* tile 2,2 rather
        // than at the same numbers -- node 2,2 is in tile 0,0 and carries nothing.
        panels.renderStatusPanel(elements.status, floor, state, { kind: 'cell', x: 6, y: 6 });

        const under = elements.status.querySelectorAll('.status-block')[1];
        return under.querySelector('.status-row[data-type="tile"] .status-value').textContent;
    });

    expect(shown).toContain('Elevator 90°');
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

    const everyType = ['address', 'room', 'floorType', 'wall', 'tile'];
    expect(shown.titles).toEqual(['Painting with', 'Under the pointer']);
    expect(shown.rows).toEqual([everyType, everyType]);
    expect(shown.active).toEqual(['address', 'address']);
});

test('the painting column says what the mode will do with the values in it', async ({ page }) => {
    const captions = await withPanels(page, (panels, elements, floor, state, panel, model, tools) => {
        const caption = () => {
            panels.renderStatusPanel(elements.status, floor, state, null);
            const block = elements.status.querySelector('.status-block');
            return block.querySelector('.status-note')?.textContent ?? null;
        };

        const seen = { none: caption() };
        state.mode = tools.PaintMode.PAINT;
        seen.paint = caption();
        state.mode = tools.PaintMode.FLOOD;
        seen.flood = caption();
        return seen;
    });

    // The heading says "Painting with", which is a lie in None and an understatement in
    // Flood. The caption is what makes the same five rows read correctly in all three.
    expect(captions.none).toBe('A click picks these instead of painting them');
    expect(captions.flood).toBe('A click fills up to the walls with these');

    // Paint is the plain case, and a caption restating the heading is noise.
    expect(captions.paint).toBe(null);
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
