/**
 * Divider ends, placed by the editor rather than chosen by the author.
 *
 * A divider is a run of low partition, and the game splits it into three presets: a
 * centre with no post, and two ends carrying one each. Which of the two belongs at which
 * end of a run is the question this file answers.
 *
 * **The rule.** `DividerEndLeft`'s post sits at the end of the run that is on the left as
 * seen from inside the *parent* room. Of the two walls facing each other across a
 * divider, the parent is the one whose room has the higher `RoomTypePreset.cyclePriority`,
 * tiebroken by the higher room id, and a real room always parents a `Null` one. The pair
 * shares one preset, and the mesh is drawn from `parentWallsShort/Long` on the parent side
 * and the mirrored `childWallsShort/Long` on the other -- which is why the id reads as
 * "left when standing in the parent room" rather than as a direction on the grid.
 *
 * A wall faces back into its own node's room, so the parent wall's facing is the
 * direction from the wall toward the parent node, and its left is that turned a quarter
 * turn. Worked through, in the grid's own coordinates:
 *
 *   wall along x, parent is the low node    left end is high y
 *   wall along x, parent is the high node   left end is low y
 *   wall along y, parent is the low node    left end is low x
 *   wall along y, parent is the high node   left end is high x
 *
 * Checked against the game rather than assumed: 305 of the 316 divider runs this module
 * finds across the base game come out with their posts capping the run, against 72% for
 * the reading it replaced, and it accounts for all three runs on the floor that raised
 * this -- including the one that renders crossed, which is what any correct rule has to
 * reproduce.
 *
 * **What it still cannot answer.** Most of the residue is walls with the *same room on
 * both sides*: identical preset and identical id, so priority and the tiebreak are both
 * exhausted and the parent falls to the order the game happened to build the two walls
 * in, which a blueprint does not record. Choosing either side scores the same over the
 * base game, so it really is a coin flip. That is what the flip below is for, and it is
 * now the only thing it is for.
 *
 * So this file:
 *
 *   - **Places automatically.** The author marks a wall as a divider end and the editor
 *     writes whichever id puts the post on the outer end of the run, from the rule above.
 *   - **Flips on replace.** Erasing one end of a run and putting it back swaps both. For
 *     a wall between two different rooms that should never be needed; for a wall inside
 *     one room it is the whole of the control available.
 *
 * Both ends move together because a run holds one of each. All 327 divider runs in the
 * base game are bookended by a left and a right, and none pairs a preset with itself --
 * flipping one end alone would write a shape the game has never been given.
 */
import { AXIS_X, getWall, setWall, nodeAt, roomOfNode } from './floorModel.js';
import cyclePriorities from '../../../refs/generated/roomCyclePriority.json' with { type: 'json' };

/**
 * `RoomTypePreset.cyclePriority` for a room, or the game's own default.
 *
 * 5 is what `soDefaults.json` records as the field's default, so a mod's room preset --
 * which is not in the generated table, being the mod's -- is treated as the game treats a
 * preset that never set it.
 */
const DEFAULT_CYCLE_PRIORITY = 5;

/** The room a null room is: the one a real room always parents. */
const NULL_ROOM = new Set(['Null', '']);

/** The three divider presets, keyed as the model keys a preset: by id, as a string. */
export const DIVIDER_CENTRE = '4';
export const DIVIDER_END_LEFT = '5';
export const DIVIDER_END_RIGHT = '6';

/**
 * What the wall tool paints when the author picks a divider end.
 *
 * Not a preset id, because which id gets written is decided per wall at the moment of
 * writing -- that is the whole point. It sits in `wallPreset` where an id would, so the
 * one field still answers "what does the wall tool paint", and everything that writes a
 * wall has to ask this file what that means.
 */
export const DIVIDER_END = 'dividerEnd';

/**
 * What the picker calls it, and which group it is listed under.
 *
 * Among the blanks because that is what `wallPresetKinds.json` calls both ends: a divider
 * is an opening with no structure, and the kind is what an author picks between first.
 */
export const DIVIDER_END_NAME = 'Divider end';
export const DIVIDER_END_KIND = 'blank';

const ENDS = new Set([DIVIDER_END_LEFT, DIVIDER_END_RIGHT]);
const DIVIDERS = new Set([DIVIDER_CENTRE, DIVIDER_END_LEFT, DIVIDER_END_RIGHT]);

/** Whether a preset is one of the two ends. */
export const isDividerEnd = (preset) => ENDS.has(preset);

/** Whether a preset is any part of a divider -- an end or the centre between them. */
export const isDivider = (preset) => DIVIDERS.has(preset);

/**
 * Which way a run lies.
 *
 * A wall along the x axis separates two cells side by side, so the wall itself stands
 * across y and a run of them extends that way. The other axis is the mirror of it. This
 * is the direction `low end` and `high end` are measured along, everywhere below.
 */
const runStep = (axis) => (axis === AXIS_X ? { dx: 0, dy: 1 } : { dx: 1, dy: 0 });

/**
 * Which of the two nodes a wall sits between holds the parent wall.
 *
 * Higher `cyclePriority` wins, then the higher room id, and a real room always parents a
 * null one. A wall with a room on one side only -- the grid's margin -- is parented by
 * the side that has one.
 *
 * A full tie means the same room on both sides, where the game decides by something a
 * blueprint does not record. The low node is taken, which is a choice rather than an
 * answer; see the note at the top.
 */
export function parentIsLowNode(model, x, y, axis) {
    const { dx, dy } = axis === AXIS_X ? { dx: 1, dy: 0 } : { dx: 0, dy: 1 };

    const low = roomOfNode(model, nodeAt(model, x, y));
    const high = roomOfNode(model, nodeAt(model, x + dx, y + dy));

    if (!low || !high) return !!low;

    const lowNull = NULL_ROOM.has(low.preset);
    const highNull = NULL_ROOM.has(high.preset);
    if (lowNull !== highNull) return highNull;

    const lowPriority = cyclePriorities[low.preset] ?? DEFAULT_CYCLE_PRIORITY;
    const highPriority = cyclePriorities[high.preset] ?? DEFAULT_CYCLE_PRIORITY;
    if (lowPriority !== highPriority) return lowPriority > highPriority;

    if (low.id !== high.id) return low.id > high.id;

    return true;
}

/**
 * Whether `DividerEndLeft`'s post lands at the low end of a run.
 *
 * The whole of the rule, once the parent is known. A wall along x is parented from the
 * low node when its left end is the high one, and the other axis is the mirror of that --
 * which falls out of the wall facing back into its own room and its left being that
 * turned a quarter turn.
 */
export const endLeftAtLowEnd = (axis, parentIsLow) =>
    (axis === AXIS_X ? !parentIsLow : parentIsLow);

/**
 * Where a divider end's post will actually land, as an end of the run.
 *
 * What the view draws with, so that a run the game will render crossed is drawn crossed
 * rather than tidied up into a lie.
 */
export function dividerPostAtLowEnd(model, x, y, axis, preset) {
    if (!isDividerEnd(preset)) return null;

    const leftAtLow = endLeftAtLowEnd(axis, parentIsLowNode(model, x, y, axis));
    return preset === DIVIDER_END_LEFT ? leftAtLow : !leftAtLow;
}

/**
 * The run of divider a wall belongs to, from its low end to its high end.
 *
 * The wall at `(x, y)` is counted whether or not it is a divider yet, because the caller
 * is usually about to make it one: asking what run a wall would join has to be answerable
 * before the wall exists, or the first end of a new run has nothing to be an end of.
 *
 * Everything adjacent that *is* a divider joins it, centre and ends alike. A run that
 * already has an end where the walk reaches one stops there, since a run cannot continue
 * past its own end.
 */
export function dividerRun(model, x, y, axis) {
    const { dx, dy } = runStep(axis);
    const run = [{ x, y }];

    for (const direction of [-1, 1]) {
        let cx = x + dx * direction;
        let cy = y + dy * direction;

        for (;;) {
            const wall = getWall(model, cx, cy, axis);
            if (!wall || !isDivider(wall.preset)) break;

            run.push({ x: cx, y: cy });
            if (isDividerEnd(wall.preset)) break;

            cx += dx * direction;
            cy += dy * direction;
        }
    }

    const along = axis === AXIS_X ? 'y' : 'x';
    return run.sort((a, b) => a[along] - b[along]);
}

/**
 * Put a divider end on a wall, and keep the run it joins consistent.
 *
 * The id written is decided from where in its run the wall falls, not from anything the
 * author chose. `flip` swaps the run's two ends over, which is what erasing an end and
 * replacing it does -- see the note at the top of this file for why that is the repair
 * an author gets instead of a left/right choice.
 *
 * A wall dropped into the middle of a run is treated as the end it is nearer, since the
 * author has said "end" and the middle is not one. A run one wall long is its own low
 * end, which makes a lone divider end a left by default.
 *
 * Returns whether anything changed, matching `setWall`.
 */
export function placeDividerEnd(model, x, y, axis, { insteadOf = null } = {}) {
    const run = dividerRun(model, x, y, axis);
    const along = axis === AXIS_X ? 'y' : 'x';

    const low = run[0];
    const high = run[run.length - 1];

    // Which end this wall is. The middle of a run is resolved by distance so that the
    // answer is always one of the two, and ties go low -- a run of one is all low end.
    const here = axis === AXIS_X ? y : x;
    const atLowEnd = here - low[along] <= high[along] - here;

    const far = atLowEnd ? high : low;
    const farIsElsewhere = far.x !== x || far.y !== y;
    const farWall = farIsElsewhere ? getWall(model, far.x, far.y, axis) : null;

    // Replacing the end that was just erased writes the other id, which turns the run
    // round. A toggle off what was actually there rather than off the rule, so a second
    // erase and replace comes back: flipping to a fixed state would strand an author in
    // one of the two with no way to return.
    const preset = isDividerEnd(insteadOf)
        ? opposite(insteadOf)
        : presetForPost(model, x, y, axis, atLowEnd);

    // setWall is the one thing that knows whether a slot is on the grid, and it says so
    // by refusing. Nothing below it is worth doing for a wall that was never written.
    if (!setWall(model, x, y, axis, preset)) return false;

    // The far end takes the other of the pair. Rewritten rather than left alone because
    // the pair is what a run is: setting one end without the other is how a run ends up
    // with two lefts, which is a shape no floor the game ships contains.
    if (farWall && isDividerEnd(farWall.preset)) {
        setWall(model, far.x, far.y, axis, opposite(preset));
    }

    return true;
}

/** The other of the pair. */
const opposite = (preset) =>
    (preset === DIVIDER_END_LEFT ? DIVIDER_END_RIGHT : DIVIDER_END_LEFT);

/** The id that puts this wall's post at one end of its run. */
function presetForPost(model, x, y, axis, wantPostAtLowEnd) {
    const leftAtLow = endLeftAtLowEnd(axis, parentIsLowNode(model, x, y, axis));
    return leftAtLow === wantPostAtLowEnd ? DIVIDER_END_LEFT : DIVIDER_END_RIGHT;
}
