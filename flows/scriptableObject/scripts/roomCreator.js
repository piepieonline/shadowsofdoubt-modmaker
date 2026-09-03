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
 * The same is true of writing. `roomPlan.js` says what the room comes to as a list of
 * changes, `core/soBuilder.js` says where each one lands against the folder and does the
 * writing, and this module reads the folder, draws the answer and reports what happened.
 * The preview and the write run the one function -- `landing` -- over two readings of the
 * same folder, so the pane cannot promise something the write then does differently.
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

import {
    readModFiles, indexMod, emptyIndex, landAll, commit, takeOut,
} from '../../../core/soBuilder.js';
import { MANIFEST_FILE } from '../../../core/murderManifest.js';
import {
    planRoom, refusedBy, fullClosure, abandoned, roomOperations, sharedNames, patchFileOf,
} from './roomPlan.js';
import { scanRooms, choicesFrom } from './roomScan.js';
import { createStepper } from './creatorSteps.js';

// Through BASE_URL rather than a leading slash: the web build is mounted under the Pages
// project prefix, where a root-absolute path lands outside the site entirely.
const CHAIN_PATH = `${import.meta.env.BASE_URL}refs/derived/furnitureChain.json`;
const ROOMS_PATH = `${import.meta.env.BASE_URL}refs/derived/roomCreator.json`;

/**
 * What each step is for, said in the footer while it is being read.
 *
 * The order is the markup's -- `createStepper` reads the panes -- so these are keyed rather
 * than listed, and a step renamed in one place and not the other loses its note instead of
 * putting it on the wrong pane.
 */
const STEP_NOTES = {
    identity: 'Lighting, security, cleanliness and decor come from the room you copy. '
        + 'Furniture does not — it is decided the other way round, so it takes the button.',
    where: 'Every one of these is optional. Blank is left open rather than guessed, so the '
        + 'reach beside them errs wide.',
    contents: 'A cluster brings its own presets with it. The ceiling lights start as the '
        + 'donor’s, and are yours from the first one you untick.',
    write: 'Nothing of anybody else’s is overwritten. A file that belongs to another room '
        + 'stops the write, and one of your own is added to rather than rebuilt.',
};

/** The step rail, built on first open. Null until the dialog is on screen. */
let steps = null;

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
    // than a setting: `{ donor, clusters, refused }`, or null. Nothing reads it back into
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

        // Every piece of furniture the game has, which is what `reachable` is a fraction
        // of. Read from the chain rather than counted from the clusters: a preset in no
        // cluster at all is still furniture this room does not reach.
        catalogue: Object.keys(chainData.furniture ?? {}).length,

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

    // Built once and kept, along with which step it was left on. Closing the pane to look
    // at a file and coming back to the third step is the ordinary way this gets used, and
    // a rail that reset to the first step every time would punish exactly that.
    steps ??= createStepper(dialog);

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
 * **Clusters the context refuses are copied too.** A donor's room is furnished, and copying
 * it minus the eleven things the third floor rules out would be a copy that quietly is not
 * one. Each is admitted the same way as any other and each is reported: the patch is
 * harmless where the gate refuses it, and relaxing the gate is the author's to do on a copy
 * of their own -- see the note at the top of `roomPlan.js`.
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
        refused: names.filter((name) => refusedBy(rooms, name, state.context).length).length,
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
    const gates = $('#room-creator-gates');
    if (!out) return;

    if (!rooms || !chain) {
        out.replaceChildren(note('The reference data could not be loaded, so nothing here can be checked.'));
        gates?.replaceChildren();
        return;
    }

    const result = summarise(rooms, chain, state);

    /*
     * What the room is and what it already reaches, on the step where it is decided.
     *
     * The two warnings are here rather than beside the gates because neither is about
     * where the room sits: an unlit donor and a cluster that can never resolve its
     * furniture are both consequences of the room you copied.
     */
    const verdict = [headline(result)];

    if (state.donor && result.unlit.includes(state.donor)) {
        verdict.push(note(`${state.donor} is one of the ${result.unlit.length} room configurations no `
            + 'lighting preset names, so a room copying it gets no ceiling light until one is patched '
            + 'to accept it.', 'warning'));
    } else if (state.donor && !state.lighting.size) {
        verdict.push(note(`Nothing lights this room. ${state.donor} is lit by `
            + `${lightsFor(rooms, state.donor).join(', ')} — tick one of those under “What goes in it” `
            + 'to patch it into accepting your room.', 'warning'));
    }

    if (result.hollow.length) {
        verdict.push(note(`${result.hollow.length} of the clusters this room could take cannot resolve `
            + 'furniture for an element they cannot do without, so each would be abandoned every time '
            + `it is attempted: ${result.hollow.map((entry) => entry.name).join(', ')}.`, 'warning'));
    }

    out.replaceChildren(...verdict);

    /*
     * What the gates did, on the step where they are typed.
     *
     * These two used to sit under the headline, several controls above the fields that
     * decide them. They are the only reading in the pane that answers a keystroke, so they
     * belong beside the keystroke.
     */
    const said = [];

    if (result.unanswered.length) {
        said.push(note(`Nothing has been said about ${asProse(result.unanswered)}, so `
            + `${result.unanswered.length === 1 ? 'that gate is' : 'those gates are'} `
            + 'left open rather than guessed. The reach beside them errs wide.'));
    }

    if (result.refusedBy.length) said.push(refusals(result));

    gates?.replaceChildren(...said);

    drawReach(result);
    drawCopy();
    drawContents(result);
    drawChosen();

    const plan = drawPlan();
    drawSteps(result, plan);
}

/**
 * How far the room reaches, as two bars beside the gates.
 *
 * The same two numbers the headline states in prose one step back. Restated rather than
 * moved, because they are read for two different reasons: on the identity step the count is
 * the answer to "what did copying that room get me", and here it is the needle that moves
 * as a floor is typed. A sentence on another step cannot be watched.
 */
function drawReach(result) {
    const out = $('#room-creator-reach');
    if (!out) return;

    const title = document.createElement('p');
    title.className = 'creator-card-title';
    title.textContent = 'Reach';

    out.replaceChildren(
        title,
        bar('Clusters', `${result.possible.length} / ${result.total}`,
            result.total ? result.possible.length / result.total : 0),
        bar('Presets in reach', String(result.reachable.length),
            // Against the whole catalogue, so the two bars are read on one scale: a room
            // admitting every cluster still reaches only three quarters of the furniture.
            result.catalogue ? result.reachable.length / result.catalogue : 0),
    );
}

function bar(label, value, fraction) {
    const wrapper = document.createElement('div');
    const line = document.createElement('div');
    const name = document.createElement('span');
    const count = document.createElement('span');
    const track = document.createElement('div');
    const fill = document.createElement('div');

    wrapper.className = 'room-creator-bar';
    line.className = 'room-creator-bar-label';
    count.className = 'room-creator-bar-value';
    track.className = 'room-creator-bar-track';
    fill.className = 'room-creator-bar-fill';

    name.textContent = label;
    count.textContent = value;
    fill.style.width = `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;

    line.append(name, count);
    track.append(fill);
    wrapper.append(line, track);
    return wrapper;
}

/**
 * The clusters this room holds, gathered as chips.
 *
 * The picker beside these lists what the gates allow, capped at forty rows and sorted with
 * the refused ones last -- so a cluster ticked before the floor was stated can be off the
 * bottom of it. Without this the pane could show a room and not show what is in it.
 */
function drawChosen() {
    const out = $('#room-creator-chosen');
    if (!out) return;

    const names = [...state.clusters].sort();
    const title = document.createElement('p');

    title.className = 'creator-card-title';
    title.textContent = names.length
        ? `In this room · ${names.length} ${names.length === 1 ? 'cluster' : 'clusters'}`
        : 'In this room';

    if (!names.length) {
        out.replaceChildren(title, note('Nothing yet. Tick a cluster beside this, or copy a '
            + 'room’s furniture on the first step.'));
        return;
    }

    const list = document.createElement('ul');
    list.className = 'room-creator-chips';

    for (const name of names) {
        const row = document.createElement('li');
        const chip = document.createElement('button');

        chip.type = 'button';
        chip.className = 'room-creator-chip';
        chip.title = `Take ${name} back out of this room`;

        // The name and the cross are one press. A chip is small, and two targets inside it
        // is two ways to miss -- there is nothing else pressing one could mean.
        chip.append(name, Object.assign(document.createElement('span'), { textContent: '✕' }));
        chip.addEventListener('click', () => toggleRoomCluster(name, false));

        row.append(chip);
        list.append(row);
    }

    out.replaceChildren(title, list);
}

/**
 * The rail: what each step has to say about itself, and the line under all of them.
 *
 * Read off the same `result` and plan the panes are drawn from rather than tracked, for the
 * reason `redraw` rebuilds whole -- a rail that kept its own counts could disagree with the
 * pane beside it about what the author last typed.
 */
function drawSteps(result, plan) {
    if (!steps) return;

    const stated = Object.keys(state.context).length;
    const subtitle = $('#room-creator-subtitle');

    if (subtitle) {
        subtitle.textContent = state.name
            ? `${state.name} · ${editingRoom() ? 'in this mod' : 'new'}`
            : 'unnamed';
    }

    steps.update({
        identity: { hint: state.name || 'not named yet', note: STEP_NOTES.identity },
        where: {
            hint: stated ? `${stated} of 7 stated` : 'nothing set',
            note: STEP_NOTES.where,
        },
        contents: {
            hint: `${state.clusters.size} ${state.clusters.size === 1 ? 'cluster' : 'clusters'}`,
            note: STEP_NOTES.contents,
        },
        write: {
            hint: plan ? `${plan.count} ${plan.count === 1 ? 'file' : 'files'}` : '',
            note: STEP_NOTES.write,
        },
    });

    // The first thing standing between this room and a write, or how far it reaches when
    // nothing is. One line: the plan itself says the rest, on the step that is about it.
    steps.say(plan?.problems?.[0]
        ?? `${result.possible.length} of ${result.total} clusters suit this room.`);
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
            + `clusters${state.copied.refused
                ? `, ${state.copied.refused} of which are refused where this room sits and will not `
                    + 'be placed until you copy them into your mod and relax the gate that refuses '
                    + 'them — the write plan names which'
                : ''}. Narrow them under “What goes in it”.`));
    }

    out.replaceChildren(...parts);
}

/**
 * The clusters this room could take, and the ones it could not, as a list to choose from.
 *
 * The refused ones are shown rather than dropped, and can be ticked. A list that quietly
 * omits them answers "why can I not put a picnic table here" with silence, and the answer --
 * which gate said no, and what it wanted -- is the thing an author needs in order to change
 * the room so that it fits. So they are listed, the reason is one click away, and admitting
 * one writes the same harmless patch as any other: the gate is checked before the room
 * class, so it does nothing until the author either states a floor that suits or copies the
 * cluster into their own mod and relaxes it there.
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

        // Tickable whatever the gates say. What a gate refuses is the room as it has been
        // described so far, and that description is design intent written nowhere -- a room
        // reopened tomorrow has forgotten its floor, and a box disabled on the strength of
        // a blank field is the pane refusing on evidence it does not have.
        box.type = 'checkbox';
        box.checked = admittedHere;
        box.addEventListener('change', () => toggleRoomCluster(name, box.checked));

        const presets = closure[name] ?? [];
        const admitted = presets.filter((preset) => state.furniture.has(preset)).length;

        const caption = document.createElement('span');
        caption.textContent = ` ${name} — ${admittedHere && admitted !== presets.length
            ? `${admitted} of ${presets.length}`
            : `${presets.length} ${presets.length === 1 ? 'preset' : 'presets'}`}`
            + `${failures ? ', refused here' : ''}`;

        label.append(box, caption);

        // Marked while it is out, so the list reads as what suits this room first. Once it
        // is in, it is as real as any other ticked row and the reason below says what will
        // still stop it being placed.
        if (failures && !admittedHere) label.className = 'room-creator-refused';
        row.append(label);

        // The reason stays on an admitted row: it is what the author has to relax on a copy
        // of their own, and it is the whole of why the cluster is not appearing in game.
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
 * Why a cluster will not be placed here, behind a button rather than on the row.
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
    button.setAttribute('aria-label', `Why ${name} will not be placed in this room`);
    button.setAttribute('aria-expanded', 'false');

    const reason = document.createElement('small');
    reason.className = 'room-creator-note room-creator-note-warning room-creator-reason';
    reason.hidden = true;
    reason.textContent = `${failures.map((failure) => failure.reason).join(' ')} Admitting it here `
        + 'is harmless and does nothing on its own: the gate is checked before the room class. To '
        + `place ${name} in this room, copy it into your mod and relax that on the copy — changing `
        + 'it on the shipped one would move it in every vanilla room too.';

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

/**
 * The whole write, landed against a folder: what the room is, plus what it is taken out of.
 *
 * One function for the preview and for the write, called with the folder as it was last
 * read and with the folder as it is. They used to be two -- `against` for the pane and a
 * staging loop for the write -- and two answers to "what will happen to this file" is one
 * more than a pane showing the author what it is about to do can afford.
 */
function landing(index) {
    const plan = planRoom(choices(), rooms, chain);
    const editing = editingRoom();

    // Saving a room over itself is not a clash: its own assets are what is being saved.
    // Anything else standing where one of them would go belongs to something else.
    const own = new Set(editing
        ? plan.changes.filter((change) => change.kind === 'own').map((change) => change.file)
        : []);

    // What this room admits today and would not after saving. Compared by asset and type
    // rather than by file name, so a patch the folder happens to hold under the other
    // spelling of its name is recognised as the same admission rather than added to and
    // withdrawn from at once.
    const wanted = new Set(plan.changes.map((change) => `${change.type}|${change.asset}`));
    const shared = sharedNames(rooms, chain);

    const withdrawals = admissionsOf(editing)
        .filter((entry) => !wanted.has(`${entry.type}|${entry.asset}`))
        .map((entry) => takeOut({
            asset: entry.asset,
            type: entry.type,
            shared: shared.has(entry.asset),
            ours: roomOperations(state.name),
        }));

    return { plan, landed: landAll([...plan.changes, ...withdrawals], index, { own }) };
}

/** What each landed change reads as in the list. */
const HOW = {
    create: '',
    merge: ' — this room’s, rewritten',
    delete: ' — nothing left in it, removed',
};

const howLanded = (item) => HOW[item.action]
    ?? (item.action === 'append'
        ? (item.change.kind === 'out' ? ' — this room taken back out of it' : ' — already here, this room is added to it')
        : item.action === 'leave' ? ' — yours, left alone'
            : item.action === 'clash' ? ' — already here, and another room’s'
                : ` — cannot be written: ${item.reason}`);

/**
 * What is about to be written, and a count of it for the rail.
 *
 * Returns `{ count, problems }` rather than drawing the rail itself: the rail is the same
 * `planRoom` read twice over otherwise, and this pane redraws on every keystroke.
 */
function drawPlan() {
    const out = $('#room-creator-plan');
    if (!out) return null;

    const { plan, landed } = landing(modIndex);

    // A withdrawal from a file that is not there is the ordinary case rather than an event:
    // most of what a room could once have written it never wrote.
    const shown = landed.filter((item) => !(item.action === 'leave' && item.change.kind === 'out'));

    const parts = [];

    const counts = (action) => shown.filter((item) => item.action === action).length;
    const appends = shown.filter((item) => item.action === 'append' && item.change.kind === 'add').length;
    const taken = shown.filter((item) => item.change.kind === 'out');
    const blockers = shown.filter((item) => item.action === 'clash' || item.action === 'refuse');
    const left = shown.filter((item) => item.action === 'leave');

    const summary = document.createElement('p');
    summary.innerHTML = `<strong>${counts('create')}</strong> new files`
        + (counts('merge') ? `, <strong>${counts('merge')}</strong> rewritten` : '')
        + (appends ? `, <strong>${appends}</strong> added to` : '')
        + (taken.length ? `, <strong>${taken.length}</strong> taken back` : '')
        + (left.length ? `, <strong>${left.length}</strong> left alone` : '')
        + ', plus the manifest.';
    parts.push(summary);

    const list = document.createElement('ol');
    for (const item of shown) {
        const row = document.createElement('li');

        // The name as a name, and what happens to it as a reading of that -- a file name is
        // a thing the author will go looking for in the folder, and it reads as one rather
        // than as the first few words of a sentence about it.
        row.append(asFile(item.file));

        const how = howLanded(item);
        if (how) row.append(said(how));

        list.append(row);
    }
    parts.push(list);

    if (taken.length) {
        parts.push(note(`This room is taken out of ${taken.map((item) => item.change.asset).join(', ')}. `
            + 'Any other room\'s changes to those files stay, and a file left with nothing goes.'));
    }

    for (const item of left) parts.push(note(item.reason, 'warning'));

    // The two blockers read differently because the answers differ. A clash is a name
    // another room has, and renaming is the whole of the fix; a refusal is a file that
    // cannot be added to, and what to do about it depends on why.
    const clashes = blockers.filter((item) => item.action === 'clash');
    const refused = blockers.filter((item) => item.action === 'refuse');

    if (clashes.length) {
        parts.push(note(`${clashes.map((item) => item.file).join(', ')} `
            + `${clashes.length === 1 ? 'belongs' : 'belong'} to another room. Change this room's `
            + 'name before writing.', 'warning'));
    }

    if (refused.length) {
        parts.push(note(`Nothing will be written: ${refused.map((item) => item.reason).join('. ')}.`, 'warning'));
    }

    for (const problem of plan.problems) parts.push(note(problem, 'warning'));

    out.replaceChildren(...parts);

    const counted = { count: shown.length, problems: plan.problems };
    const button = $('#room-creator-write');
    if (!button) return counted;

    const blocked = !window.selectedMod?.baseFolder;
    const unnamed = plan.problems.some((text) => text.includes('needs a name')
        || text.includes('not a usable asset name') || text.includes('needs a configuration'));

    button.disabled = blocked || unnamed || blockers.length > 0 || plan.collided.length > 0;

    const writes = counts('create') + counts('merge') + counts('append') + counts('delete');

    if (blocked) button.textContent = 'Choose a mod to write into';
    else if (plan.collided.length) button.textContent = 'Two of this room’s files share a name';
    else if (blockers.length) button.textContent = 'Change the name to write';
    else if (editingRoom()) button.textContent = `Save ${state.name}`;
    else if (appends) button.textContent = `Write ${writes - appends} files, add to ${appends}`;
    else button.textContent = `Write ${writes} files`;

    return counted;
}

/** The author's choices, in the shape `planRoom` reads. */
const choices = () => ({
    name: state.name,
    donor: state.donor,
    donorRoomType: state.donorRoomType,
    context: state.context,
    clusters: [...state.clusters],
    furniture: [...state.furniture],

    // What this room already admits, which is not the same question as what it can resolve.
    // A cluster of the author's own places furniture nothing here can enumerate, and a
    // closure that has never heard of it is not grounds for withdrawing that furniture --
    // see the note in `planRoom`.
    admitted: [...(editingRoom()?.presets ?? [])],
    surfaces: state.surfaces,
    lighting: [...state.lighting],
});


/* -------------------------------------------------------------------------- */
/* Opening a room that is already there                                        */
/* -------------------------------------------------------------------------- */

/** The rooms the folder was last found to hold, which the picker offers. */
let found = [];

/**
 * The folder as it was when it was last read, for the plan's preview.
 *
 * A preview only. `writeRoom` reads the folder again rather than trusting this: the pane
 * can sit open while files are added beside it, and a write has to answer to the folder as
 * it is rather than as it was.
 */
let modIndex = emptyIndex();

/** Fill the room picker from the selected mod, and say when there is nothing to fill it from. */
async function refreshRoomList() {
    const select = $('#room-creator-open');
    if (!select) return;

    const folder = window.selectedMod?.baseFolder;
    const read = await readModFiles(folder);

    found = scanRooms(read.files);
    modIndex = indexMod(read);

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
 * so they start blank again. Nothing is decided on the strength of that blank: every gate it
 * would answer reads "unknown" rather than "no", and what a gate refuses is reported rather
 * than acted on.
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

    // `choices.owned` -- clusters of the author's own that furnish this room -- is
    // deliberately not read into the ticks. This pane has nothing to write to one, and the
    // furniture they place is kept by `admitted` in `choices` rather than by a tick.

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

    // Said separately because it is a different kind of thing: a file in this folder whose
    // author decided what is in it. Nothing this pane does touches one.
    if (room.owned.length) {
        const one = room.owned.length === 1;

        parts.push(note(`${room.owned.join(', ')} ${one ? 'is a cluster' : 'are clusters'} of your `
            + `own naming this room’s filter, so ${one ? 'it furnishes' : 'they furnish'} it too. `
            + `Nothing here writes to ${one ? 'it' : 'them'}, and the furniture ${one ? 'it places is'
                : 'they place are'} left admitted even where this tool cannot say what it is.`));
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
 * The deciding is `core/soBuilder.js`'s and so is the writing; what is here is the reading
 * of the folder as it is now, and the saying of what happened. The pane's preview and this
 * run the same `landing` over two readings of the same folder, which is what stops the two
 * disagreeing about what a file is about to become.
 *
 * Nothing of anybody else's is overwritten. A patch of a cluster another room already
 * patched is the case that matters -- the second room adds its filter to the existing file
 * rather than replacing it -- and an asset the mod declares is left alone entirely.
 */
export async function writeRoom() {
    const folder = window.selectedMod?.baseFolder;
    const out = $('#room-creator-plan');
    if (!folder || !out) return;

    // Read before deciding anything. The index the pane draws its preview from is whatever
    // the folder held when it was opened, and a write has to answer to the folder as it is
    // now.
    const read = await readModFiles(folder);
    const { plan, landed } = landing(indexMod(read));

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

    const result = await commit(folder, landed);

    if (result.refused.length) {
        out.prepend(note(`Nothing has been written. ${result.refused.map((item) => item.reason).join('. ')}.`, 'warning'));
        return;
    }

    if (result.malformed) {
        out.prepend(note(`${MANIFEST_FILE} could not be read, so it has been left alone. The `
            + `${result.written.length} files are written but none of them will load until they `
            + 'are listed there by hand.', 'warning'));
        return;
    }

    const appended = result.written.filter((item) => item.action === 'append' && item.change.kind === 'add');
    const withdrawn = [...result.removed, ...result.written.filter((item) => item.change.kind === 'out')];

    const parts = [`${result.written.length - appended.length} files written`];
    if (appended.length) parts.push(`${appended.length} existing ${appended.length === 1 ? 'patch' : 'patches'} added to`);
    if (withdrawn.length) {
        parts.push(`${withdrawn.length} taken back${result.removed.length
            ? ` (${result.removed.length} left empty and removed)` : ''}`);
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

/** A file name in the plan, set apart from the prose around it. */
function asFile(text) {
    const element = document.createElement('code');
    element.textContent = text;
    return element;
}

/** What the plan says about the file beside it. */
function said(text) {
    const element = document.createElement('span');
    element.className = 'creator-plan-how';
    element.textContent = text;
    return element;
}

/** A list as prose, matching how the furniture checker reads its own. */
function asProse(names) {
    if (names.length < 2) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
