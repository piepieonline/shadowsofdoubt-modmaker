/**
 * The room creator: build a room type, and see what it admits while you build it.
 *
 * A room in this game is four assets, not one. Furniture, materials and lighting all key
 * off `RoomClassPreset`, reached through `RoomTypeFilter`; the `RoomTypePreset` the author
 * thinks they are making is required because `RoomConfiguration.roomType` demands one, and
 * on a hand-built floor almost every field on it is inert. So the modal presents one room
 * and writes four assets plus a patch per thing admitted.
 *
 * The `RoomTypePreset` still earns the bare room name, because it is the one asset that
 * surfaces where the author browses -- the building flow's room picker lists it, and a
 * blueprint stores it as the plain string in `r_d[].l`. The other three carry suffixes.
 *
 * ## What this pane is for
 *
 * A brand-new room class is in no filter at all, so it admits *nothing*: no furniture, no
 * wallpaper, no flooring, no ceiling light. Every file written after the first adds one
 * thing back. That is easy to get wrong in a way that produces no error -- the city builds,
 * the room is empty, and the only sign is a debug line -- which is why the verdict is on
 * screen the whole time rather than behind a validate button.
 *
 * ## Where the answers come from
 *
 * `core/spawnRules.js` holds every gate below the room class and is shared. Nothing about
 * what a room admits is decided here; this module asks and draws.
 *
 * The two reference files are fetched rather than imported, the way the building flow
 * fetches its own: 233 KB and 124 KB, read by one pane of one flow, and the other flows
 * should not pay for them on load. The building flow fetches `furnitureChain.json` too and
 * that is fine -- only one flow is active at a time, and two fetches of one file is not the
 * same thing as two readings of it.
 */
import {
    admitted, closures, importantElements, surfaceFilters, unlitConfigurations, lightsFor,
    clustersFor,
} from '../../../core/spawnRules.js';

import { getFile, tryGetFile, writeFile, readFileContent, removeFile } from '../../../core/fs.js';
import {
    readManifest, blankManifest, withListing, withoutListing, MANIFEST_FILE,
} from '../../../core/murderManifest.js';
import { PATCH_SUFFIX, PRESET_SUFFIX } from '../../../core/soFileName.js';
import {
    planRoom, decideCluster, collisions, mergePatch, against, fullClosure, abandoned,
    roomRefs, withoutRoom, sharedNames, patchFileOf,
} from './roomPlan.js';
import { scanRooms, choicesFrom } from './roomScan.js';

const CHAIN_PATH = '/refs/derived/furnitureChain.json';
const ROOMS_PATH = '/refs/derived/roomCreator.json';

let chain = null;
let rooms = null;
let loading = null;

/**
 * What the author has said so far.
 *
 * `context` is deliberately sparse: a field that is not here has not been decided, and a
 * gate reading it answers "unknown" rather than "no". Writing a default in would be the
 * modal quietly deciding the room is on the ground floor.
 */
const state = {
    name: '', donor: '', donorRoomType: '', context: {},
    clusters: new Set(), furniture: new Set(), surfaces: {}, lighting: new Set(), search: '',

    // Whether the author has picked lights themselves. Until they have, the lighting
    // follows the donor -- a room copying `Atrium` wants `Atrium`'s lights far more often
    // than it wants none, and leaving the list empty behind a note saying which presets
    // *would* light it reads as a choice already made that cannot be unmade.
    lightingChosen: false,

    // The room opened from the folder, while its name is still that room's. Saving then
    // reconciles it rather than refusing: the four assets are rewritten, newly admitted
    // furniture is patched in, and furniture taken back is patched out.
    editing: null,

    // The last copy of a donor's furniture, as a record of something that happened rather
    // than a setting: `{ donor, clusters, cloned }`, or null. Nothing reads it back into
    // the choices -- once copied, the clusters are ordinary ticks.
    copied: null,
};

/** The room being edited, or null once the name has moved off it. */
const editingRoom = () => (state.editing && state.name === state.editing.roomType ? state.editing : null);

/**
 * What an opened room admits things through, as `{ asset, type }`.
 *
 * The scanner hands back four lists and the type is implied by which list a name is in.
 * It has to be carried rather than read off the name, because half of what names these
 * files *is* the type -- see `patchFileOf` -- and the names that need it are exactly the
 * ones a name alone cannot identify.
 */
const admissionsOf = (room) => (!room ? [] : [
    ...room.clusters.map((asset) => ({ asset, type: 'FurnitureCluster' })),
    ...room.presets.map((asset) => ({ asset, type: 'FurniturePreset' })),
    ...room.surfaces.map((asset) => ({ asset, type: 'RoomTypeFilter' })),
    ...room.lighting.map((asset) => ({ asset, type: 'RoomLightingPreset' })),
]);

/** Test seam, and what the pane reads. */
export const roomCreatorState = () => state;


/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

export function loadRoomData() {
    loading ??= Promise.all([
        fetch(CHAIN_PATH).then((response) => (response.ok ? response.json() : null)),
        fetch(ROOMS_PATH).then((response) => (response.ok ? response.json() : null)),
    ])
        .then(([loadedChain, loadedRooms]) => {
            chain = loadedChain;
            rooms = loadedRooms;
            return { chain, rooms };
        })
        .catch(() => ({ chain: null, rooms: null }));

    return loading;
}

/** Test seam: hand the module data directly, or clear it. */
export function setRoomData(nextChain, nextRooms) {
    chain = nextChain ?? null;
    rooms = nextRooms ?? null;
    loading = nextChain || nextRooms ? Promise.resolve({ chain, rooms }) : null;
}


/* -------------------------------------------------------------------------- */
/* What the room admits                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every district any cluster names, for the district control to offer.
 *
 * Derived rather than listed: a district gate is written as a name and the set of names is
 * whatever the shipped clusters happen to use, so a hand-kept list would go stale against
 * the same file it is read beside.
 */
export function districtsIn(data) {
    const names = new Set();

    for (const record of Object.values(data?.clusters ?? {})) {
        for (const name of record.allowedInDistricts ?? []) names.add(name);
        for (const name of record.notAllowedInDistricts ?? []) names.add(name);
    }

    return [...names].sort();
}

/**
 * The whole answer for the room as it currently stands.
 *
 * The room class half is not applied: no filters have been chosen yet, so every cluster in
 * the game is a candidate and what narrows the list is the context alone. Choosing what
 * furnishes the room narrows it again, and that is the next pane rather than this one.
 *
 * `refusedBy` groups by gate rather than listing clusters, because the useful reading is
 * "eleven things are out because of the floor" rather than eleven separate sentences.
 */
export function summarise(data, chainData, current = state) {
    if (!data || !chainData) return null;

    const names = Object.keys(data.clusters);
    const { possible, refused } = admitted(data, names, current.context);

    const refusedBy = new Map();
    for (const entry of refused) {
        for (const failure of entry.failures) {
            if (!refusedBy.has(failure.gate)) refusedBy.set(failure.gate, []);
            refusedBy.get(failure.gate).push(entry);
        }
    }

    const unanswered = new Set();
    for (const entry of [...possible, ...refused]) {
        for (const gate of entry.unanswered) unanswered.add(gate);
    }

    // The furniture that could actually spawn: the closure of what survived. This is the
    // number the author is really asking about -- a room that admits 200 clusters and
    // resolves 12 presets is a room that looks furnished and is not.
    const closure = closures(chainData);
    const reachable = new Set(possible.flatMap((entry) => closure[entry.name] ?? []));

    // A cluster whose important element resolves to nothing abandons the whole placement,
    // silently. Reported against what survived, since one that is already refused is not
    // the author's problem yet.
    const hollow = possible
        .map((entry) => ({
            name: entry.name,
            missing: importantElements(chainData, entry.name).filter((element) => !element.presets.length),
        }))
        .filter((entry) => entry.missing.length);

    return {
        total: names.length,
        possible,
        refused,
        refusedBy: [...refusedBy].sort((a, b) => b[1].length - a[1].length),
        unanswered: [...unanswered].sort(),
        reachable: [...reachable].sort(),
        hollow,
        surfaces: surfaceFilters(data, chainData),
        unlit: unlitConfigurations(data),
    };
}

/** What a donor configuration passes on, as the short prose the picker shows beside it. */
export function describeDonor(data, name) {
    const config = data?.configurations?.[name];
    if (!config) return '';

    const traits = [
        config.forceOutside === 1 && 'outdoors',
        config.useMainLights && 'main lights',
        config.canBeOpenPlan && 'open plan',
        config.securityDoors > 0 && 'security doors',
        config.useOwnership && 'owned',
    ].filter(Boolean);

    return traits.length ? traits.join(', ') : 'no notable settings';
}


/* -------------------------------------------------------------------------- */
/* The pane                                                                    */
/* -------------------------------------------------------------------------- */

const $ = (selector) => document.querySelector(selector);

export async function openRoomCreator() {
    const dialog = $('#room-creator-modal');
    if (!dialog) return;

    dialog.toggleAttribute('open', true);

    await loadRoomData();
    fillControls();
    redraw();
    await refreshRoomList();
}

export function closeRoomCreator() {
    $('#room-creator-modal')?.removeAttribute('open');
}

/** Read every control into `state`, then redraw. Wired to `oninput` on the whole form. */
export function roomCreatorChanged() {
    state.name = $('#room-creator-name')?.value.trim() ?? '';
    state.donor = $('#room-creator-donor')?.value ?? '';

    // The donor room type follows the donor configuration unless the author has said
    // otherwise. On this route it is nearly inert, so asking twice would be asking about
    // something that does not matter -- see the note at the top of roomPlan.js.
    state.donorRoomType = rooms?.configurations?.[state.donor]
        ? chain?.roomConfigs?.[state.donor]?.roomType ?? ''
        : '';

    // A copy names the donor it came from, so it stops being true the moment the donor
    // moves. The clusters it ticked stay -- they are the author's now.
    if (state.copied && state.copied.donor !== state.donor) state.copied = null;

    state.search = $('#room-creator-search')?.value.trim().toLowerCase() ?? '';

    // The donor's own lights, until the author says otherwise. Nothing lights a brand new
    // configuration, so an empty list is never the useful default.
    if (!state.lightingChosen) state.lighting = new Set(lightsFor(rooms, state.donor));

    for (const surface of ['walls', 'floor', 'ceiling']) {
        const value = $(`#room-creator-surface-${surface}`)?.value ?? '';
        if (value) state.surfaces[surface] = value;
        else delete state.surfaces[surface];
    }

    state.context = {};
    for (const field of ['floor', 'wealth', 'grub', 'residences']) {
        const raw = $(`#room-creator-${field}`)?.value;
        if (raw !== '' && raw != null) state.context[field] = Number(raw);
    }

    for (const field of ['openPlan', 'inhabitants']) {
        const raw = $(`#room-creator-${field}`)?.value;
        if (raw === 'yes') state.context[field] = true;
        if (raw === 'no') state.context[field] = false;
    }

    const district = $('#room-creator-district')?.value;
    if (district) state.context.district = district;

    redraw();
}

function fillControls() {
    const donor = $('#room-creator-donor');

    if (donor && !donor.options.length && rooms) {
        donor.append(new Option('Choose a room to copy…', ''));

        for (const name of Object.keys(rooms.configurations).sort()) {
            donor.append(new Option(`${name} — ${describeDonor(rooms, name)}`, name));
        }
    }

    const district = $('#room-creator-district');

    if (district && !district.options.length && rooms) {
        district.append(new Option('Not decided', ''));
        for (const name of districtsIn(rooms)) district.append(new Option(name, name));
    }

    // Surfaces offer the safe filters only. The ones that would also bring furniture are
    // listed and disabled rather than left out: an author who cannot see `CorporateLobby`
    // concludes it is missing, and an author who can see it greyed learns the rule.
    const surfaces = surfaceFilters(rooms, chain);

    for (const surface of ['walls', 'floor', 'ceiling']) {
        const select = $(`#room-creator-surface-${surface}`);
        if (!select || select.options.length || !rooms) continue;

        select.append(new Option('None — the engine’s fallback', ''));
        for (const name of surfaces[surface].safe) select.append(new Option(name, name));

        for (const name of surfaces[surface].alsoGatesFurniture) {
            const option = new Option(`${name} — also admits its furniture`, name);
            option.disabled = true;
            select.append(option);
        }
    }
}

/**
 * A cluster the author has admitted, or taken back.
 *
 * Admitting one brings its whole closure with it, because that is what makes the cluster
 * work and is what an author asking for a booth means. Taking one back removes only the
 * furniture no *other* admitted cluster still needs -- a chair shared by two booths stays
 * when one of them goes.
 */
export function toggleRoomCluster(name, on) {
    if (on) {
        state.clusters.add(name);
        for (const preset of fullClosure(chain, [name])) state.furniture.add(preset);
    } else {
        state.clusters.delete(name);

        const stillWanted = new Set(fullClosure(chain, [...state.clusters]));
        for (const preset of [...state.furniture]) {
            if (!stillWanted.has(preset)) state.furniture.delete(preset);
        }
    }

    redraw();
}

/**
 * Everything the donor is furnished with, ticked in one go.
 *
 * A button and not a setting. `copyFrom` on the `RoomConfiguration` carries the donor's
 * lighting, security and decor because those are fields *on* it; furniture is decided the
 * other way round, by each cluster naming the room classes it will go in, so there is
 * nothing for `copyFrom` to carry and the room has to be added to 50-odd shipped assets
 * instead. That is a large, visible act -- `ApartmentLivingRoom` is 77 clusters and 80
 * presets, so 157 patches beside the four assets the room itself is -- and it belongs to a
 * button the author presses once, not to a checkbox that quietly reapplies itself when
 * something else moves.
 *
 * Nothing is taken back out first. A copy adds to what is already ticked, because the
 * author who ticked something by hand and then reached for the donor's furniture wants
 * both; and untangling one from the other afterwards is what "no tracking" rules out.
 *
 * **Clusters the context refuses are copied too**, and each becomes a clone with the gate
 * that refused it relaxed -- `planRoom` already does exactly that for one ticked by hand
 * before the floor was stated. A donor's room is furnished, and copying it minus the
 * eleven things the third floor rules out would be a copy that quietly is not one.
 */
export function copyDonorFurniture() {
    const names = clustersFor(chain, state.donor);
    if (!names.length) return;

    for (const name of names) state.clusters.add(name);

    // One closure over the whole set rather than a pass per cluster: the closure walks all
    // 399 clusters, and 77 walks of it to answer one question is 76 too many.
    for (const preset of fullClosure(chain, names)) state.furniture.add(preset);

    state.copied = {
        donor: state.donor,
        clusters: names.length,
        cloned: names.filter((name) => decideCluster(rooms, name, state.context).action === 'clone').length,
    };

    redraw();
}

/** One piece of furniture within a cluster, admitted or not. */
export function toggleRoomFurniture(name, on) {
    if (on) state.furniture.add(name);
    else state.furniture.delete(name);

    redraw();
}

export function toggleRoomLight(name, on) {
    if (on) state.lighting.add(name);
    else state.lighting.delete(name);

    // From here the lighting is the author's, and changing the donor no longer moves it.
    state.lightingChosen = true;
    redraw();
}

/**
 * Draw the verdict.
 *
 * Rebuilt whole on every keystroke rather than patched. 399 clusters through seven gates
 * is not enough work to be worth the bookkeeping, and a pane that redraws entirely cannot
 * disagree with itself about what the author last typed.
 */
function redraw() {
    const out = $('#room-creator-verdict');
    if (!out) return;

    if (!rooms || !chain) {
        out.replaceChildren(note('The reference data could not be loaded, so nothing here can be checked.'));
        return;
    }

    const result = summarise(rooms, chain, state);
    const parts = [];

    parts.push(headline(result));

    if (state.donor && result.unlit.includes(state.donor)) {
        parts.push(note(`${state.donor} is one of the ${result.unlit.length} room configurations no `
            + 'lighting preset names, so a room copying it gets no ceiling light until one is patched '
            + 'to accept it.', 'warning'));
    } else if (state.donor && !state.lighting.size) {
        parts.push(note(`Nothing lights this room. ${state.donor} is lit by `
            + `${lightsFor(rooms, state.donor).join(', ')} — tick one of those below to patch it `
            + 'into accepting your room.', 'warning'));
    }

    if (result.unanswered.length) {
        parts.push(note(`Nothing has been said about ${asProse(result.unanswered)}, so `
            + `${result.unanswered.length === 1 ? 'that gate is' : 'those gates are'} `
            + 'left open rather than guessed. The list above errs wide.'));
    }

    if (result.hollow.length) {
        parts.push(note(`${result.hollow.length} of the clusters this room could take cannot resolve `
            + 'furniture for an element they cannot do without, so each would be abandoned every time '
            + `it is attempted: ${result.hollow.map((entry) => entry.name).join(', ')}.`, 'warning'));
    }

    if (result.refusedBy.length) parts.push(refusals(result));

    out.replaceChildren(...parts);

    drawCopy();
    drawContents(result);
    drawPlan();
}

/**
 * The copy button, and what the last press of it did.
 *
 * The count is on the button rather than beside it because it is the thing that decides
 * whether to press: one and 77 are both answers a shipped donor gives -- `Path` and
 * `ApartmentLivingRoom` -- and which one is not guessable from the name beside it.
 *
 * Short, because it shares a row with the donor select and the select is the half worth
 * the width. So the donor's name is not repeated here -- it is being read an inch to the
 * left -- and the sentence that would not fit goes on the `title` and, where it is a
 * reason the button cannot be pressed, into the note below where it is actually visible.
 *
 * A donor whose class no filter names gets the button disabled and the fact said out loud.
 * `Atrium` is one -- so is every configuration in the game whose rooms are furnished by
 * hand rather than by the generator -- and "nothing is placeable in an atrium" is a useful
 * thing to learn early, where a button that appeared to do nothing would read as broken.
 */
function drawCopy() {
    const button = $('#room-creator-copy-furniture');
    const out = $('#room-creator-copied');
    if (!button) return;

    const names = state.donor ? clustersFor(chain, state.donor) : [];

    button.disabled = !names.length;
    button.textContent = names.length ? `Copy ${names.length} clusters` : 'Copy furniture';
    button.title = !state.donor
        ? 'Choose a room to copy from first'
        : names.length
            ? `Tick the ${names.length} furniture clusters ${state.donor} holds`
            : `${state.donor} holds no furniture to copy`;

    if (!out) return;

    const parts = [];

    if (state.donor && !names.length) {
        parts.push(note(`${state.donor} has no furniture to copy: no cluster in the game names its `
            + 'room class, so nothing the generator places goes in one. Tick what this room should '
            + 'hold below.'));
    }

    // Said once, after the press. It describes what happened rather than what is set, so
    // it does not follow the ticks around as they are narrowed afterwards.
    if (state.copied) {
        parts.push(note(`Copied ${state.copied.clusters} of ${state.copied.donor}’s furniture `
            + `clusters${state.copied.cloned
                ? `, ${state.copied.cloned} of which are refused where this room sits and are copied `
                    + 'as clones with that one gate relaxed'
                : ''}. Narrow them under “What goes in it”.`));
    }

    out.replaceChildren(...parts);
}

/**
 * The clusters this room could take, and the ones it could not, as a list to choose from.
 *
 * The refused ones are shown rather than dropped. A list that quietly omits them answers
 * "why can I not put a picnic table here" with silence, and the answer -- which gate said
 * no, and what it wanted -- is the thing an author needs in order to change the room so
 * that it fits. So they are listed, their box is disabled, and the reason is one click
 * away rather than absent.
 *
 * Capped at what fits, with the count said out loud: 399 rows is not a list anyone reads,
 * and a silent truncation reads as "that is all there is".
 */
function drawContents(result) {
    const list = $('#room-creator-clusters');
    if (!list) return;

    const closure = closures(chain);
    const refusals = new Map(result.refused.map((entry) => [entry.name, entry.failures]));

    // Admitted first, then what could be admitted, then what could not. A room loaded from
    // the folder shows its own choices rather than burying them past the fortieth row, and
    // the refused ones sit at the end where they read as an explanation rather than a list.
    const rank = (name) => (state.clusters.has(name) ? 0 : refusals.has(name) ? 2 : 1);

    const matching = [...result.possible, ...result.refused]
        .map((entry) => entry.name)
        .filter((name) => !state.search || name.toLowerCase().includes(state.search))
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

    const shown = matching.slice(0, 40);
    const rows = shown.map((name) => {
        const row = document.createElement('li');
        const label = document.createElement('label');
        const box = document.createElement('input');

        const failures = refusals.get(name);
        const admittedHere = state.clusters.has(name);

        // A refused cluster cannot be ticked by hand -- the reason is the thing to read
        // first, and a tick before reading it is a clone written by accident. But one the
        // copy button brought in *is* in the room, as a clone, so it shows ticked and can
        // be taken back out. A box that showed empty for something the plan below is about
        // to write would be the pane disagreeing with itself.
        box.type = 'checkbox';
        box.checked = admittedHere;
        box.disabled = !!failures && !admittedHere;
        if (!box.disabled) box.addEventListener('change', () => toggleRoomCluster(name, box.checked));

        const decision = decideCluster(rooms, name, state.context);
        const presets = closure[name] ?? [];

        const admitted = presets.filter((preset) => state.furniture.has(preset)).length;

        const caption = document.createElement('span');
        caption.textContent = ` ${name} — ${admittedHere && admitted !== presets.length
            ? `${admitted} of ${presets.length}`
            : `${presets.length} ${presets.length === 1 ? 'preset' : 'presets'}`}`
            + `${decision.action === 'clone' ? ', cloned' : ''}`;

        label.append(box, caption);

        // Greyed only while it is out. Once it is in the room it is as real as any other
        // ticked row, whatever the gate that made it a clone.
        if (failures && !admittedHere) label.className = 'room-creator-refused';
        row.append(label);

        // The reason stays on a cloned row: it is what the clone relaxes, and the author
        // taking one back out wants to know why it needed cloning in the first place.
        if (failures) row.append(...whyNot(name, failures));

        // Its contents, once it is in. A cluster puts down a slot per element and the
        // game fills each from whatever carries that class -- so this is the furniture
        // the room would actually get, and the author may not want all of it.
        if (admittedHere && presets.length) row.append(contentsOf(name, presets));

        return row;
    });

    if (matching.length > shown.length) {
        const more = document.createElement('li');
        more.className = 'room-creator-note';
        more.textContent = `${matching.length - shown.length} more match. Narrow the search to see them.`;
        rows.push(more);
    }

    if (!matching.length) {
        const none = document.createElement('li');
        none.className = 'room-creator-note';
        none.textContent = state.search
            ? `No furniture cluster is called "${state.search}".`
            : 'The reference data holds no clusters at all.';
        rows.push(none);
    }

    list.replaceChildren(...rows);

    const lights = $('#room-creator-lights');
    if (!lights) return;

    // Redrawn from `state` every time rather than built once. A list that keeps whatever
    // the DOM last held cannot show a donor's lights arriving, or a room's coming back
    // when one is opened -- which is how ticking them became something the author could
    // not undo.
    const donorLights = new Set(lightsFor(rooms, state.donor));

    lights.replaceChildren(...Object.keys(rooms.lighting).sort().map((name) => {
        const row = document.createElement('li');
        const label = document.createElement('label');
        const box = document.createElement('input');

        box.type = 'checkbox';
        box.checked = state.lighting.has(name);
        box.addEventListener('change', () => toggleRoomLight(name, box.checked));

        const caption = document.createElement('span');
        caption.textContent = donorLights.has(name) ? ` ${name} — lights ${state.donor}` : ` ${name}`;

        label.append(box, caption);
        row.append(label);
        return row;
    }));
}

/**
 * What is about to be written, before it is.
 *
 * A room is ten-odd files and a manifest edit, so the set is shown rather than described.
 * `problems` is not a refusal -- a room with no ceiling light is a decision an author is
 * allowed to make, as long as they are not making it by accident.
 */
/**
 * Why a cluster cannot be admitted, behind a button rather than on the row.
 *
 * On the row it would be a wall of text: at floor 3 the reason is the same sentence on a
 * hundred and forty rows, and the list stops being scannable. Behind a button it is there
 * for the one cluster the author is asking about.
 *
 * Every failing gate, not the first. These are independent conditions on the room being
 * designed -- see `admits` -- so being told about the floor while the wealth is also wrong
 * would send the author round twice.
 */
function whyNot(name, failures) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'room-creator-why';
    button.textContent = '?';
    button.setAttribute('aria-label', `Why ${name} cannot go in this room`);
    button.setAttribute('aria-expanded', 'false');

    const reason = document.createElement('small');
    reason.className = 'room-creator-note room-creator-note-warning room-creator-reason';
    reason.hidden = true;
    reason.textContent = failures.map((failure) => failure.reason).join(' ');

    button.addEventListener('click', () => {
        reason.hidden = !reason.hidden;
        button.setAttribute('aria-expanded', String(!reason.hidden));
    });

    // Returned apart rather than wrapped: the row is a flex line, and a wrapper would be
    // one item -- putting the sentence in a column beside the name instead of beneath it.
    return [button, reason];
}

/**
 * The furniture one admitted cluster would resolve, as a nested list to narrow.
 *
 * Marked rather than merely listed. A preset that fills an element the cluster cannot do
 * without is the one whose ticking matters -- unticking every preset for such an element
 * loses the whole cluster, silently, and that is worth saying before the write rather than
 * in the plan afterwards.
 */
function contentsOf(name, presets) {
    // Not "this fills a slot that matters" -- on a lounge set every sofa does, and a
    // marker on all nine says nothing. What is worth marking is the preset that is the
    // *only* admitted one for such a slot, because unticking that one is what loses the
    // cluster.
    const soleFor = new Map();

    for (const element of importantElements(chain, name)) {
        const admitted = element.presets.filter((preset) => state.furniture.has(preset));
        if (admitted.length === 1) soleFor.set(admitted[0], element.class);
    }

    const list = document.createElement('ul');
    list.className = 'room-creator-contents';

    for (const preset of presets) {
        const row = document.createElement('li');
        const label = document.createElement('label');
        const box = document.createElement('input');

        box.type = 'checkbox';
        box.checked = state.furniture.has(preset);
        box.addEventListener('change', () => toggleRoomFurniture(preset, box.checked));

        const caption = document.createElement('span');
        caption.textContent = soleFor.has(preset)
            ? ` ${preset} — the only one filling ${soleFor.get(preset)}`
            : ` ${preset}`;

        if (soleFor.has(preset)) caption.className = 'room-creator-sole';

        label.append(box, caption);
        row.append(label);
        list.append(row);
    }

    // Said here as well as in the plan: this is where it can be put right.
    for (const entry of abandoned(chain, [name], state.furniture)) {
        for (const slot of entry.starved) {
            const warning = document.createElement('li');
            warning.className = 'room-creator-note room-creator-note-warning';
            warning.textContent = slot.why === 'unadmitted'
                ? `Nothing admitted fills ${slot.class}, so this cluster would be abandoned whole.`
                : `No furniture in the game carries ${slot.class}, so this cluster can never place.`;
            list.append(warning);
        }
    }

    return list;
}

function drawPlan() {
    const out = $('#room-creator-plan');
    if (!out) return;

    const plan = planRoom(choices(), rooms, chain);
    const editing = editingRoom();
    const landing = against(plan.files, existingFiles).map((entry) => (
        // Saving a room over itself is not a clash: its own assets are what is being saved.
        editing && entry.landing === 'clash' ? { ...entry, landing: 'resave' } : entry));

    const parts = [];

    const appends = landing.filter((entry) => entry.landing === 'append').length;
    const clashes = landing.filter((entry) => entry.landing === 'clash');

    // Furniture this room admits today and would not after saving.
    const wanted = new Set(plan.files.map((entry) => entry.file));
    const shared = sharedNames(rooms, chain);
    const taken = admissionsOf(editing)
        .filter((entry) => !wanted.has(patchFileOf(shared, entry.asset, entry.type)))
        .map((entry) => entry.asset);

    const resaves = landing.filter((entry) => entry.landing === 'resave').length;

    const summary = document.createElement('p');
    summary.innerHTML = `<strong>${landing.length - appends - resaves}</strong> new files`
        + (resaves ? `, <strong>${resaves}</strong> rewritten` : '')
        + (appends ? `, <strong>${appends}</strong> added to` : '')
        + (taken.length ? `, <strong>${taken.length}</strong> taken back` : '')
        + ', plus the manifest.';
    parts.push(summary);

    const list = document.createElement('ol');
    for (const entry of landing) {
        const row = document.createElement('li');
        const how = {
            write: '',
            append: ' — already here, this room is added to it',
            resave: ' — this room’s, rewritten',
            clash: ' — already here, and another room’s',
        }[entry.landing];

        row.textContent = `${entry.file}${how}`;
        list.append(row);
    }
    parts.push(list);

    if (taken.length) {
        parts.push(note(`This room is taken out of ${taken.join(', ')}. Any other room's changes to `
            + 'those files stay, and a file left with nothing goes.'));
    }

    if (clashes.length) {
        parts.push(note(`${clashes.map((entry) => entry.file).join(', ')} `
            + `${clashes.length === 1 ? 'belongs' : 'belong'} to another room. Change this room's `
            + 'name before writing.', 'warning'));
    }

    for (const problem of plan.problems) parts.push(note(problem, 'warning'));

    out.replaceChildren(...parts);

    const button = $('#room-creator-write');
    if (!button) return;

    const blocked = !window.selectedMod?.baseFolder;
    const unnamed = plan.problems.some((text) => text.includes('needs a name')
        || text.includes('not a usable asset name') || text.includes('needs a configuration'));

    button.disabled = blocked || unnamed || clashes.length > 0 || plan.collided.length > 0;

    if (blocked) button.textContent = 'Choose a mod to write into';
    else if (plan.collided.length) button.textContent = 'Two of this room’s files share a name';
    else if (clashes.length) button.textContent = 'Change the name to write';
    else if (editing) button.textContent = `Save ${state.name}`;
    else if (appends) button.textContent = `Write ${landing.length - appends} files, add to ${appends}`;
    else button.textContent = `Write ${landing.length} files`;
}

/** The author's choices, in the shape `planRoom` reads. */
const choices = () => ({
    name: state.name,
    donor: state.donor,
    donorRoomType: state.donorRoomType,
    context: state.context,
    clusters: [...state.clusters],
    furniture: [...state.furniture],
    surfaces: state.surfaces,
    lighting: [...state.lighting],
});


/* -------------------------------------------------------------------------- */
/* Opening a room that is already there                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every asset and patch in the content folder, in the shape `scanRooms` reads.
 *
 * Deliberately not the manifest's list. A room half-written, or one whose author has not
 * got round to listing a file yet, is still a room worth showing -- and a file the loader
 * would ignore is better reported through the room it belongs to than hidden from it.
 */
export async function readRoomFiles(folder) {
    if (!folder) return [];

    const files = [];

    try {
        for await (const entry of folder.values()) {
            if (entry.kind !== 'file' || entry.name === MANIFEST_FILE) continue;

            const patch = entry.name.endsWith(PATCH_SUFFIX);
            if (!patch && !entry.name.endsWith(PRESET_SUFFIX)) continue;

            let raw = null;
            try {
                raw = JSON.parse(await readFileContent(entry));
            } catch {
                // A file being edited, or one that is not JSON at all. Neither is a
                // reason to show no rooms.
                continue;
            }

            files.push({
                // `file` is the stem, which is what the manifest names and what the
                // scanner reports. `fileName` is what is actually on disk, which is what
                // the plan's own entries are keyed by.
                file: entry.name.slice(0, -(patch ? PATCH_SUFFIX : PRESET_SUFFIX).length),
                fileName: entry.name,
                type: raw?.fileType ?? raw?.type ?? null,
                patch,
                raw,
            });
        }
    } catch {
        return [];
    }

    return files;
}

/** The rooms the folder was last found to hold, which the picker offers. */
let found = [];

/**
 * The file names the folder held when it was last read, for the plan's preview.
 *
 * A preview only. `writeRoom` reads the folder again rather than trusting this: the pane
 * can sit open while files are added beside it, and a write has to answer to the folder as
 * it is rather than as it was.
 */
let existingFiles = new Set();

/** Fill the room picker from the selected mod, and say when there is nothing to fill it from. */
async function refreshRoomList() {
    const select = $('#room-creator-open');
    if (!select) return;

    const folder = window.selectedMod?.baseFolder;
    const files = folder ? await readRoomFiles(folder) : [];

    found = scanRooms(files);
    existingFiles = new Set(files.map((entry) => entry.fileName));

    select.replaceChildren(new Option(
        found.length ? `${found.length} room${found.length === 1 ? '' : 's'} in this mod…` : 'No rooms in this mod',
        '',
    ));

    for (const room of found) {
        const suffix = { exact: '', partial: ' — partly understood', identity: ' — nothing admitted to it' };
        select.append(new Option(`${room.roomType ?? room.configuration}${suffix[room.verdict]}`, room.configuration));
    }

    select.disabled = !found.length;
}

/**
 * Load a room that is already in the folder back into the pane.
 *
 * What comes back is what the files say. **The context does not** -- which floor the author
 * had in mind, and how wealthy the district was, are design intent and are written nowhere,
 * so they start blank again. That matters for one thing only: a cluster that was cloned
 * because a gate conflicted will read as patchable until the context that conflicted is
 * stated again.
 */
export function openExistingRoom() {
    const select = $('#room-creator-open');
    const room = found.find((entry) => entry.configuration === select?.value);
    if (!room) return;

    const choices = choicesFrom(room, rooms);

    state.name = choices.name;
    state.donor = choices.donor;
    state.clusters = new Set(choices.clusters);
    state.lighting = new Set(choices.lighting);
    state.surfaces = { ...choices.surfaces };

    // The presets the folder's patches actually admit, not the closure of the clusters --
    // a room whose author narrowed the furniture must come back narrowed.
    state.furniture = new Set(room.presets);

    // What the files say, not what the donor would suggest -- an opened room's lighting is
    // a decision somebody already made, including the decision to have none.
    state.lightingChosen = true;

    // From here, writing under this name means saving *this* room rather than making
    // another. Renaming ends that -- a new name is a new room, and the old one stays.
    state.editing = room;

    // A copy of a donor's furniture done a moment ago was done to a different room. The
    // note describing it would survive a same-donor open and read as though it described
    // this one's ticks, which came from its files.
    state.copied = null;

    $('#room-creator-name').value = choices.name;
    if ($('#room-creator-donor')) $('#room-creator-donor').value = choices.donor;

    for (const surface of ['walls', 'floor', 'ceiling']) {
        const control = $(`#room-creator-surface-${surface}`);
        if (control) control.value = choices.surfaces[surface] ?? '';
    }

    roomCreatorChanged();
    drawOpened(room);
}

/** What the scanner could not account for, said rather than swallowed. */
function drawOpened(room) {
    const out = $('#room-creator-opened');
    if (!out) return;

    const parts = [];

    if (room.verdict === 'identity') {
        parts.push(note(`${room.configuration} has a room class and nothing admitted to it. That is `
            + 'what a room copied wholesale from a shipped one looks like, and it is not a fault — '
            + 'it admits whatever its donor already admits.'));
    }

    for (const line of room.unaccounted) parts.push(note(line, 'warning'));

    if (room.verdict !== 'identity') {
        parts.push(note(`Read back: ${room.clusters.length} clusters, ${room.presets.length} furniture `
            + `presets, ${room.surfaces.length} surface filters, ${room.lighting.length} lights. `
            + 'Where the room sits is not written down anywhere, so those boxes start empty.'));
    }

    parts.push(note('Writing makes a new room. Nothing here is overwritten — change the name first.'));

    out.replaceChildren(...parts);
}


/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Write the room into the selected mod's content folder.
 *
 * Order matters twice over. The files go down before the manifest, so a failure part way
 * through leaves assets the loader never reaches rather than a load order naming files
 * that are not there. And `fileOrder` is appended in dependency order, because every
 * `REF:` has to resolve to something already loaded.
 *
 * Nothing is overwritten. A patch of a cluster another room already patched is the case
 * that matters -- the second room has to add its filter to the existing file rather than
 * replace it, and that is the author's call.
 */
export async function writeRoom() {
    const folder = window.selectedMod?.baseFolder;
    const out = $('#room-creator-plan');
    if (!folder || !out) return;

    const plan = planRoom(choices(), rooms, chain);

    // Before the folder is touched at all: two of the room's own files wanting one name is
    // decided by the room, not by what is on disk, and writing the set half-way would put
    // down the very file that makes the second one unmergeable afterwards.
    if (plan.collided.length) {
        out.prepend(note(`Nothing has been written. ${plan.collided.map((entry) => `${entry.asset} `
            + `is ${asProse(entry.types)} at once, so this room's changes to both would go to `
            + `${entry.file} and only one would survive`).join('. ')}. The file naming is meant to `
            + 'keep those apart, so this is a fault in the editor rather than in the room — it is '
            + 'worth reporting.', 'warning'));
        return;
    }

    // Read before deciding anything. The cached list the pane draws its preview from is
    // whatever the folder held when it was opened, and a write has to answer to the folder
    // as it is now.
    const onDisk = new Map();
    for (const entry of plan.files) {
        const handle = await tryGetFile(folder, [entry.file]);
        if (!handle) continue;

        try {
            onDisk.set(entry.file, JSON.parse(await readFileContent(handle)));
        } catch {
            onDisk.set(entry.file, null);
        }
    }

    const editing = editingRoom();
    const own = new Set(editing ? plan.files.map((entry) => entry.file) : []);
    const clash = collisions(plan.files, new Set(onDisk.keys()), own);

    if (clash.length) {
        out.prepend(note(`${clash.join(', ')} ${clash.length === 1 ? 'is' : 'are'} already in this `
            + 'folder, and belong to another room. Nothing has been written — change this room\'s '
            + 'name.', 'warning'));
        return;
    }

    // Furniture, surfaces and lights this room used to admit and no longer does. Read from
    // the folder rather than from what the pane started with, so a file edited elsewhere
    // since is still handled correctly.
    //
    // Both spellings for an ambiguous name. A room saved before the type went into these
    // file names admits through the bare one, and leaving that behind would mean unticking
    // a cluster took it out of the new file and not out of the old -- which reads as the
    // untick not having worked. Nothing is lost by looking: a file that is not there is
    // skipped, and one belonging to another room keeps everything but this room's own
    // operations.
    const shared = sharedNames(rooms, chain);
    const wanted = new Set(plan.files.map((entry) => entry.file));
    const stale = [...new Set(admissionsOf(editing)
        .flatMap((entry) => [
            patchFileOf(shared, entry.asset, entry.type),
            `${entry.asset}${PATCH_SUFFIX}`,
        ])
        .filter((file) => !wanted.has(file)))];

    // Work out every merge before writing any of them, so a patch this room cannot be
    // added to stops the whole write rather than leaving the room half admitted.
    const staged = [];
    const refused = [];

    for (const entry of plan.files) {
        const existing = onDisk.get(entry.file);

        if (existing === undefined) {
            staged.push({ entry, content: entry.content, appended: false });
            continue;
        }

        if (existing === null) {
            refused.push(`${entry.file} is in this folder and will not parse`);
            continue;
        }

        // One of this room's own assets, being saved again: written as the plan says
        // rather than merged, because the plan *is* what the room now is.
        if (entry.kind === 'asset' && own.has(entry.file)) {
            staged.push({ entry, content: entry.content, appended: false, rewritten: true });
            continue;
        }

        const merged = mergePatch(existing, entry.content);

        if (merged.reason) refused.push(merged.reason);
        else staged.push({ entry, content: merged.content, appended: true, added: merged.added });
    }

    // What this room is being taken out of. Only its own operations go; anything else in
    // the file belongs to another room or to the author and is left exactly as it is.
    const refs = roomRefs(state.name);
    const withdrawn = [];

    for (const file of stale) {
        const handle = await tryGetFile(folder, [file]);
        if (!handle) continue;

        let existing = null;
        try {
            existing = JSON.parse(await readFileContent(handle));
        } catch {
            refused.push(`${file} still admits this room but will not parse`);
            continue;
        }

        const stripped = withoutRoom(existing, refs);
        if (stripped.removed) withdrawn.push({ file, ...stripped });
    }

    if (refused.length) {
        out.prepend(note(`Nothing has been written. ${refused.join('. ')}.`, 'warning'));
        return;
    }

    for (const item of staged) {
        const handle = await getFile(folder, [item.entry.file], true);
        await writeFile(handle, `${JSON.stringify(item.content, null, 2)}\n`);
    }

    // A patch left with no operations is a file saying nothing, so it goes rather than
    // sitting in the folder and the load order as a puzzle for whoever reads it next.
    for (const item of withdrawn) {
        if (item.empty) await removeFile(folder, [item.file]);
        else {
            const handle = await getFile(folder, [item.file], true);
            await writeFile(handle, `${JSON.stringify(item.content, null, 2)}\n`);
        }
    }

    const appended = staged.filter((item) => item.appended);

    // One read and one write rather than a pass of `ensureListed` per file: twelve
    // re-reads of the same manifest is twelve chances for it to be half-updated.
    const { present, malformed, data } = await readManifest(folder);

    if (malformed) {
        out.prepend(note(`${MANIFEST_FILE} could not be read, so it has been left alone. The `
            + `${plan.files.length} files are written but none of them will load until they are `
            + 'listed there by hand.', 'warning'));
        return;
    }

    let manifest = present ? data : blankManifest();
    for (const entry of plan.order) manifest = withListing(manifest, entry);

    // A file that has gone must stop being named, or the loader goes looking for it.
    for (const item of withdrawn) {
        if (item.empty) manifest = withoutListing(manifest, item.file.replace(PATCH_SUFFIX, ''));
    }

    const handle = await getFile(folder, [MANIFEST_FILE], true);
    await writeFile(handle, `${JSON.stringify(manifest, null, 2)}\n`);

    const written = staged.length - appended.length;
    const parts = [`${written} files written`];
    if (appended.length) parts.push(`${appended.length} existing ${appended.length === 1 ? 'patch' : 'patches'} added to`);
    if (withdrawn.length) {
        const gone = withdrawn.filter((item) => item.empty).length;
        parts.push(`${withdrawn.length} taken back${gone ? ` (${gone} left empty and removed)` : ''}`);
    }
    const how = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

    // Re-read and redraw first. `drawPlan` replaces this pane wholesale, so a note put up
    // before it runs is a note the author never sees -- and the plan it draws now is the
    // one for a folder that has this room in it.
    await refreshRoomList();
    drawPlan();

    out.prepend(note(`${how}, listed in ${MANIFEST_FILE}. `
        + `Paint a room as ${state.name} in the floorplan editor to use it.`));
}

function headline(result) {
    const element = document.createElement('p');

    element.innerHTML = `<strong>${result.possible.length}</strong> of ${result.total} furniture `
        + `clusters suit this room, putting <strong>${result.reachable.length}</strong> furniture `
        + 'presets within reach once they are admitted.';

    return element;
}

function refusals(result) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');

    summary.textContent = `${result.refused.length} refused, by ${result.refusedBy.length} `
        + `${result.refusedBy.length === 1 ? 'gate' : 'gates'}`;
    details.append(summary);

    for (const [gate, entries] of result.refusedBy) {
        const heading = document.createElement('p');
        heading.innerHTML = `<strong>${gate}</strong> — ${entries.length}`;

        const list = document.createElement('ul');

        // The first reason stands for the gate: every cluster refused by one gate is
        // refused for the same shape of reason, and 200 near-identical sentences is not a
        // thing anyone reads.
        const example = document.createElement('li');
        example.innerHTML = `<em>${entries[0].name}</em> — `
            + entries[0].failures.find((failure) => failure.gate === gate).reason;
        list.append(example);

        if (entries.length > 1) {
            const rest = document.createElement('li');
            rest.textContent = `and ${entries.length - 1} more: `
                + `${entries.slice(1, 12).map((entry) => entry.name).join(', ')}`
                + `${entries.length > 12 ? '…' : ''}`;
            list.append(rest);
        }

        details.append(heading, list);
    }

    return details;
}

function note(text, kind = 'plain') {
    const element = document.createElement('small');
    element.className = `room-creator-note room-creator-note-${kind}`;
    element.setAttribute('role', 'status');
    element.textContent = text;
    return element;
}

/** A list as prose, matching how the furniture checker reads its own. */
function asProse(names) {
    if (names.length < 2) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
