/**
 * The five painting tools, and the pointer handling behind them.
 *
 * One tool is active at a time and one modifier changes what it does, which is the
 * reference tool's arrangement and worth keeping: it means a floor is painted with one
 * hand on the mouse rather than through a dialog per edit.
 *
 *   Tool        click                                   ctrl+click
 *   Address     paint the selected address              select the square
 *   Room        paint the selected room                 select the square
 *   Floor type  paint the floor type and height         select the square
 *   Wall        set the selected preset, both sides     select the square (shift removes)
 *   Tile        step the tile through its cycle         select the square
 *
 * **A pick is of the square, not of the tool.** Every pick takes all five values at once
 * -- address and room, floor type and height, the wall on the nearest edge, and what the
 * tile carries -- whichever tool happens to be active. It used to take only the active
 * tool's, which meant finding out what a square's floor type was required switching tool,
 * and switching tool changed what the next click would paint. One click now answers every
 * question about a square, and the panel shows the answer as *Selected square*.
 *
 * Painting continues while the button is held, as the reference's MouseDown/MouseDrag
 * does -- **except for tiles**. A tile tool acts on the initial press alone, because
 * its click cycles rather than sets: dragging across one would spin it through its
 * rotations as fast as pointer events arrive.
 *
 * Nothing here reaches into the scene beyond asking it what is under the pointer, and
 * nothing here writes a wall directly -- that goes through the model, which is what
 * keeps both halves of every wall in step.
 *
 * The reference's worst wart does not survive: there, painting silently stops working
 * whenever the Editor object is deselected, because the tools live on an inspector.
 */
import {
    AXIS_X, AXIS_Y, TileMode,
    nodeAt, tileForNode, getWall, setWall, clearWall,
    setNodeAddress, setNodeRoom, setNodeFloor, paintTile, isPaintable, floodRegion,
} from './floorModel.js';
import { DIVIDER_END, isDividerEnd, placeDividerEnd } from './dividerEnds.js';

export const Tool = {
    ADDRESS: 'address',
    ROOM: 'room',
    FLOOR_TYPE: 'floorType',
    WALL: 'wall',
    TILE: 'tile',
};

/**
 * What a click does, which is a different question from what it does it with.
 *
 * Apart from `tool` because the answer stays put while you cycle through all five tools:
 * whether you are looking or changing, and how much you change at once, is not something
 * you want to re-decide every time you switch from rooms to floor types.
 *
 *   none    a click selects and picks. Nothing is edited, whatever is clicked.
 *   paint   a click writes one cell, and a drag writes every cell it crosses.
 *   flood   a click writes every cell the walls let it reach from there.
 */
export const PaintMode = {
    NONE: 'none',
    PAINT: 'paint',
    FLOOD: 'flood',
};

/** Which tools cycle rather than set, and so must not repeat while dragging. */
const PRESS_ONLY = new Set([Tool.TILE]);

/**
 * How much of each end of an edge is not the edge, as a fraction of a cell.
 *
 * A quarter off each end leaves the middle half of every edge live, and the quarter
 * square at each corner of a cell belonging to no edge at all. One number to tune: raise
 * it and a stroke is easier to keep straight but harder to aim, lower it and the strays
 * described at nearestEdge start coming back.
 */
const EDGE_MARGIN = 0.25;

/**
 * What the tool bar and the panels are choosing between.
 *
 * Held in one object so that picking with ctrl can write back into the same selection
 * the panels read from -- picking a wall preset off the floor and then painting with it
 * is the same field in both directions.
 */
export function createToolState(overrides = {}) {
    return {
        tool: Tool.ADDRESS,

        // Starts at none, so that opening a floor to look at it cannot edit it: a stray
        // click on a base game floor would otherwise write a copy of it into the mod.
        mode: PaintMode.NONE,

        addressIndex: 0,

        // A room is chosen by the slot it sits in, within the address above. Its preset
        // and its id cannot stand in for that: 24 rooms across 13 base game floors share
        // both with another room in the same address, so a name and a number identify
        // nothing on their own. -1 is an address with no rooms to paint with.
        roomIndex: 0,

        floorType: 1,
        extraHeight: 0,

        wallPreset: '0',

        // The divider end just erased, if the last write was an erase of one. Putting a
        // divider end back on that same wall flips the run it belongs to, which is the
        // only control an author has over which way round a run reads -- see
        // dividerEnds.js for why there is nothing better to offer.
        erasedDividerEnd: null,

        tileMode: TileMode.STAIRWELL,

        // What the panels are showing the fields of.
        selectedNode: null,
        selectedTile: null,
        selectedWall: null,

        ...overrides,
    };
}

/**
 * Apply the active tool at a target, or pick from it.
 *
 * `target` is whatever the scene reported under the pointer: `{kind: 'cell', x, y}` or
 * `{kind: 'wall', x, y, axis}`. Returns what happened, so a caller knows whether to
 * redraw and whether the selection moved.
 */
export function applyTool(model, state, target, { pick = false, erase = false } = {}) {
    if (!model || !target) return unchanged();

    // Before the tool split, because a pick is of the square rather than of the tool --
    // see the note at the top. Which tool is active decides what a *write* does and no
    // longer decides what a read takes.
    if (pick) return pickFrom(model, state, target);

    return state.tool === Tool.WALL
        ? applyWallTool(model, state, target, { erase })
        : applyCellTool(model, state, target);
}

const unchanged = (extra = {}) => ({ changed: false, picked: false, ...extra });

/**
 * The wall tool works on a wall, but a click rarely lands on one: an edge with no wall
 * is a sliver a few pixels high. So a click on a *cell* is resolved to one of that cell's
 * edges, which is what makes drawing a wall along a room's side possible at all. Not
 * always to one: see nearestEdge for the corners of a cell, which name no edge and where
 * this writes nothing.
 */
function applyWallTool(model, state, target, { erase }) {
    const edge = target.kind === 'wall' ? target : nearestEdge(target);
    if (!edge) return unchanged();

    state.selectedWall = { x: edge.x, y: edge.y, axis: edge.axis };

    if (erase) {
        // What was there decides what putting one back means. Erasing an end of a divider
        // run and replacing it is how an author flips the run over -- see dividerEnds.js
        // -- so the erase is what has to remember it.
        const wall = getWall(model, edge.x, edge.y, edge.axis);
        state.erasedDividerEnd = wall && isDividerEnd(wall.preset)
            ? { x: edge.x, y: edge.y, axis: edge.axis, preset: wall.preset }
            : null;

        return {
            changed: clearWall(model, edge.x, edge.y, edge.axis),
            picked: false,
            wall: state.selectedWall,
        };
    }

    const changed = state.wallPreset === DIVIDER_END
        ? placeDividerEnd(model, edge.x, edge.y, edge.axis, { insteadOf: replacing(state, edge) })
        : setWall(model, edge.x, edge.y, edge.axis, state.wallPreset);

    // Spent whether it was used or not. A flip is one repair of one run, not a mode the
    // next wall inherits.
    state.erasedDividerEnd = null;

    return { changed, picked: false, wall: state.selectedWall };
}

/**
 * The divider end just erased from this wall, if this write is putting one back there.
 *
 * Null for any other wall, which is what makes the flip a repair of one run rather than a
 * mode the next wall inherits.
 */
function replacing(state, edge) {
    const erased = state.erasedDividerEnd;
    const same = !!erased
        && erased.x === edge.x && erased.y === edge.y && erased.axis === edge.axis;
    return same ? erased.preset : null;
}

/**
 * The edge of a cell a click means, if it means one.
 *
 * `point` is where the ray met the floor, in the floor's own units where a cell is one
 * unit square -- the scene converts it, so this is arithmetic on two things measured the
 * same way. The answer is the low node of the edge, so it names the same wall from either
 * side of it.
 *
 * **An edge is only offered along the middle of its own length.** It used to be whichever
 * of the four sides was closest, and that made drawing a line of walls by dragging
 * impossible. Dragging east along a row of south edges holds the pointer a tenth of a cell
 * up from each south side while sweeping the full width of the cell, so in the first and
 * last tenth of every cell the west or east side was the nearer one -- and the stroke laid
 * a stray wall across the line it was drawing, one at roughly every cell boundary. So an
 * edge is a candidate only while the pointer lies between EDGE_MARGIN and 1 - EDGE_MARGIN
 * *along that edge*: an x edge runs in y, so how far along it the pointer is is how far
 * north in the cell it is, and a y edge is the same the other way round. The nearest
 * candidate wins; a side the pointer is off the end of cannot win at all.
 *
 * **The corners of a cell are deliberately dead.** Where neither pair is a candidate --
 * the quarter square at each corner, where two edges meet -- this returns null and a click
 * paints nothing. That is the rule working rather than a hole in it: a corner is exactly
 * where "nearest" cannot tell which of two perpendicular edges was meant, and guessing
 * there is what put the stray walls down. Aiming at a corner is not something a stroke
 * along an edge ever means to do.
 *
 * Null as well for an edge off the grid; the outermost cells have only three.
 *
 * Exported because the hover has to answer the same question the click does: with the
 * wall tool chosen, what is under the pointer is the edge this picks, and saying anything
 * else would label one wall and paint another. That is also what makes the dead corners
 * visible -- the label goes out as the pointer enters one -- rather than something an
 * author finds out by clicking and getting no wall.
 */
export function nearestEdge(target) {
    const { x, y, point } = target;
    if (!point) return { x, y, axis: AXIS_X };

    // How far into the cell the click landed, from its west and its south side.
    const fromWest = point.x - x;
    const fromSouth = point.z - y;

    // `distance` is across the edge and decides which is nearest; `along` is down the
    // edge's own length and decides whether it is in the running at all.
    const edges = [
        { distance: fromWest, along: fromSouth, x: x - 1, y, axis: AXIS_X },
        { distance: 1 - fromWest, along: fromSouth, x, y, axis: AXIS_X },
        { distance: fromSouth, along: fromWest, x, y: y - 1, axis: AXIS_Y },
        { distance: 1 - fromSouth, along: fromWest, x, y, axis: AXIS_Y },
    ];

    const candidates = edges.filter(
        (edge) => edge.along >= EDGE_MARGIN && edge.along <= 1 - EDGE_MARGIN);

    // A corner of the cell, belonging to no edge.
    if (!candidates.length) return null;

    const nearest = candidates.reduce((best, edge) => (edge.distance < best.distance ? edge : best));

    // An edge off the grid is no edge; the outermost cells have only three.
    return nearest.x < 0 || nearest.y < 0 ? null : nearest;
}

function applyCellTool(model, state, target) {
    if (target.kind !== 'cell') return unchanged();

    const { x, y } = target;

    if (state.tool === Tool.TILE) return applyTileTool(model, state, x, y);

    const node = nodeAt(model, x, y);
    if (!node) return unchanged();

    // The outer three nodes on each side are the margin between one lot and the next.
    // They are shown, and they are read and written like any other node, but nothing
    // paints them -- the game builds that margin itself.
    if (!isPaintable(x, y)) return unchanged({ blocked: 'margin' });

    state.selectedNode = { x, y };

    // A flood is the same write as a click, repeated over everything the walls let it
    // reach. Which cells those are is the model's question, not the tool's -- see
    // floodRegion, and the note there about why what is already in a cell has no say.
    const cells = state.mode === PaintMode.FLOOD ? floodRegion(model, x, y) : [{ x, y }];

    let changed = false;
    for (const cell of cells) {
        const at = nodeAt(model, cell.x, cell.y);

        // Not short-circuited: every cell is written, and `changed` is whether any of
        // them turned out to be different from what was there.
        if (at) changed = writeNode(model, state, at) || changed;
    }

    return { changed, picked: false, filled: cells.length };
}

/**
 * The active tool's write, at one node.
 *
 * Split out because a flood does the same thing many times. The wall and tile tools are
 * not here: neither is reached through this path, and neither is a thing that could be
 * flooded -- a wall is an edge rather than an area, and a tile click cycles rather than
 * sets, so filling a region with one would leave every tile in a different state.
 */
function writeNode(model, state, node) {
    switch (state.tool) {
        case Tool.ADDRESS:
            return setNodeAddress(model, node, state.addressIndex);

        case Tool.ROOM:
            return setNodeRoom(model, node, state.addressIndex, state.roomIndex);

        case Tool.FLOOR_TYPE:
            return setNodeFloor(model, node, state.floorType, state.extraHeight);

        default:
            return false;
    }
}

/**
 * Select a square, and take every value it has.
 *
 * A click in none, or ctrl+click in either of the other two. All five at once, whichever
 * tool is active -- see the note at the top of this file for why that changed.
 *
 * The square is the unit of selection even when a wall was what the ray actually hit: a
 * wall is stored on the node at its low side, so that node is what the other four values
 * are read from. Clicking the wall between two rooms therefore selects the lower-indexed
 * of them, which is at least the same square from whichever side it was clicked.
 */
function pickFrom(model, state, target) {
    const edge = target.kind === 'wall' ? target : nearestEdge(target);
    const node = nodeAt(model, target.x, target.y);

    // Off the grid entirely. A wall target is always on it, so this is a cell hit on
    // nothing, which the scene does not produce -- guarded because the tools take a
    // target from whoever calls them.
    if (!node) return unchanged();

    state.selectedNode = { x: node.x, y: node.y };

    // The address and its room together. A room slot means nothing outside the address
    // it sits in, so taking one without the other would leave the room list pointing at
    // whichever room of the new address happened to be in that position.
    state.addressIndex = node.addressIndex;
    state.roomIndex = node.roomIndex;

    // Both, as the reference does: a floor type without its height paints at the wrong
    // level, and every square painted after it comes out raised.
    state.floorType = node.floorType;
    state.extraHeight = node.height;

    pickWall(model, state, edge);
    pickTile(model, state, node.x, node.y);

    return {
        changed: false,
        picked: true,
        wall: state.selectedWall,
        tile: state.selectedTile,
    };
}

/**
 * The wall on the edge the click was nearest, if there is one.
 *
 * An edge with nothing on it leaves `wallPreset` alone rather than clearing it. There is
 * no preset meaning "no wall" -- absence is the wall not being in the node's list -- so
 * there is nothing to take, and the alternative is a pick that silently changes what the
 * wall tool would paint next into whatever it was before that.
 *
 * A divider end is taken as the *piece* rather than as the id it happens to carry here.
 * Which of the two ends a wall holds says where in its own run it sits, so carrying that
 * id to another wall would copy an answer to a question about somewhere else -- pick the
 * left-hand end of one run, paint the right-hand end of another, and the run you painted
 * has two lefts. Taken as the piece, the id is worked out again where it lands.
 */
function pickWall(model, state, edge) {
    const wall = edge && getWall(model, edge.x, edge.y, edge.axis);

    if (!wall) {
        state.selectedWall = null;
        return;
    }

    state.wallPreset = isDividerEnd(wall.preset) ? DIVIDER_END : wall.preset;
    state.selectedWall = { x: edge.x, y: edge.y, axis: edge.axis };
}

/**
 * The tile the square sits in, and which of the tool's three settings it answers to.
 *
 * `tileMode` is what the tile tool changes rather than a value read off a tile, so what is
 * taken is what the tile *is*: a stairwell takes the stairwell setting, which is the one
 * that turns it, so picking a stairwell and then turning it is two clicks rather than
 * three.
 *
 * A mirrored stairwell takes the same setting as a plain one. It used to take Inverted --
 * back when that was a third cycle, and so was also the setting that turned an already
 * inverted stairwell -- but Inverted now only toggles the mirroring, and a pick that left
 * the tool there would answer "which way does this face" with a click that mirrors it.
 * Which of the two a stairwell is remains on the tile, and the status column says it.
 *
 * A tile carrying nothing leaves the setting alone. It is neither, so there is nothing
 * to take.
 */
function pickTile(model, state, x, y) {
    const tile = tileForNode(model, x, y);
    if (!tile) { state.selectedTile = null; return; }

    state.selectedTile = { x: tile.x, y: tile.y };

    if (tile.isStairwell) state.tileMode = TileMode.STAIRWELL;
    else if (tile.isEntrance) state.tileMode = TileMode.ENTRANCE;
}

/**
 * The tile tool cycles what the clicked square's tile carries.
 *
 * A tile is 3 x 3 nodes, so the cell that was clicked names the tile rather than being
 * the thing edited.
 */
function applyTileTool(model, state, x, y) {
    const tile = tileForNode(model, x, y);
    if (!tile) return unchanged();

    state.selectedTile = { x: tile.x, y: tile.y };

    return { changed: paintTile(tile, state.tileMode), picked: false, tile: state.selectedTile };
}


/* -------------------------------------------------------------------------- */
/* Pointer handling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Wire a scene's canvas up to the tools.
 *
 * Painting runs on pointerdown and on pointermove while the button is held, which is
 * the reference's MouseDown/MouseDrag. Three things bound it:
 *
 *  - `state.mode` has to be paint or flood. In none, a click still picks -- which is why
 *    the mode is read here rather than in applyTool: what a tool does at a target has not
 *    changed, only what the pointer asks it for. Same layer as the two guards below.
 *  - Only paint drags. A tool that cycles acts on the press alone (see PRESS_ONLY), and
 *    so does a flood -- dragging one would refill from every cell on the way, each fill
 *    undoing most of the last.
 *  - A drag never paints the same target twice, so a pointer wandering within one cell
 *    does not repeat the edit. That matters for more than tidiness: repeating a wall
 *    write is harmless, but it is the same guard that would stop a cycling tool if one
 *    were ever allowed to drag.
 *
 * The left button is the tools' unless alt is held -- the scene gives the camera the
 * middle and right ones outright, and the left one for as long as alt is down -- so a
 * stroke never also swings the view. This ignores every button but the primary, and every
 * primary press that alt has already spoken for.
 *
 * Returns a function that unbinds everything, because a flow that is switched away from
 * and back would otherwise paint twice per click.
 */
export function attachPainting(scene, getModel, state, { onChange, onHover } = {}) {
    const canvas = scene.canvas;

    let painting = false;
    let lastTarget = null;

    /**
     * What a drag must not do twice running.
     *
     * The wall tool resolves a cell click to an edge, so its key has to be that edge and
     * not the cell that was hit: a stroke crosses several of one cell's edges on the way
     * across it, and each of them is a different wall. Keyed by cell, a stroke would write
     * whichever edge it met first in each cell and nothing else -- and with the corners
     * dead (see nearestEdge) that first answer is usually no edge at all, which would
     * leave a drag along a row of edges drawing nothing.
     *
     * A cell whose corner the pointer is in falls back to naming the cell, so the key
     * still stands for something. It can never be mistaken for an edge, so a corner on the
     * way through is not in the way of the wall on the far side of it.
     */
    const targetKey = (target) => {
        if (target.kind === 'wall') return `w:${target.x},${target.y},${target.axis}`;

        const edge = state.tool === Tool.WALL ? nearestEdge(target) : null;

        return edge
            ? `w:${edge.x},${edge.y},${edge.axis}`
            : `c:${target.x},${target.y}`;
    };

    function paintAt(event, isPress) {
        const model = getModel();
        if (!model) return;

        const target = scene.pickAt(event);
        if (!target) return;

        const key = targetKey(target);
        if (!isPress && key === lastTarget) return;
        lastTarget = key;

        const result = applyTool(model, state, target, {
            pick: state.mode === PaintMode.NONE || event.ctrlKey || event.metaKey,
            erase: event.shiftKey,
        });

        if (result.changed || result.picked) onChange?.(result);
    }

    function onPointerDown(event) {
        if (event.button !== 0) return;

        // Alt is the camera's. The scene puts orbit on alt+left drag, because a trackpad
        // has no comfortable way to hold the buttons that otherwise do it, so a press
        // holding alt is the start of a camera move and never a stroke.
        if (event.altKey) return;

        // Ctrl-click is a pick, and on a Mac it is also the platform's context menu
        // gesture. The orbit controls suppress that menu for the whole canvas, which
        // they do because the right button now orbits -- so the gesture arrives here as
        // an ordinary press and nothing else happens on top of it.
        painting = true;
        lastTarget = null;
        canvas.setPointerCapture?.(event.pointerId);
        paintAt(event, true);
    }

    function onPointerMove(event) {
        if (!painting) {
            onHover?.(scene.pickAt(event));
            return;
        }

        // Only paint strokes. A pick is a press, not a stroke -- dragging in none would
        // drag the selection across the floor and take a different value from every cell
        // on the way, which is not what holding the button down meant -- and a flood is a
        // press for the reason in the note above.
        if (state.mode !== PaintMode.PAINT || PRESS_ONLY.has(state.tool)) return;
        paintAt(event, false);
    }

    function onPointerUp(event) {
        if (!painting) return;
        painting = false;
        lastTarget = null;
        canvas.releasePointerCapture?.(event.pointerId);
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);

    return function detach() {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerUp);
        canvas.removeEventListener('pointerleave', onPointerUp);
    };
}
