/**
 * The five painting tools, and the pointer handling behind them.
 *
 * One tool is active at a time and one modifier changes what it does, which is the
 * reference tool's arrangement and worth keeping: it means a floor is painted with one
 * hand on the mouse rather than through a dialog per edit.
 *
 *   Tool        click                                   ctrl+click
 *   Address     paint the selected address              pick the address here
 *   Room        paint the selected room                 pick the room here
 *   Floor type  paint the floor type and height         pick both
 *   Wall        set the selected preset, both sides     pick it (shift removes)
 *   Tile        step the tile through its cycle         select the tile only
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
    nodeAt, tileForNode, roomOfNode, getWall, setWall, clearWall,
    setNodeAddress, setNodeRoom, setNodeFloor, paintTile, isPaintable, floodRegion,
} from './floorModel.js';

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

    return state.tool === Tool.WALL
        ? applyWallTool(model, state, target, { pick, erase })
        : applyCellTool(model, state, target, { pick });
}

const unchanged = (extra = {}) => ({ changed: false, picked: false, ...extra });

/**
 * The wall tool works on a wall, but a click rarely lands on one: an edge with no wall
 * is a sliver a few pixels high. So a click on a *cell* is resolved to the edge of that
 * cell nearest where it landed, which is what makes drawing a wall along a room's side
 * possible at all.
 */
function applyWallTool(model, state, target, { pick, erase }) {
    const edge = target.kind === 'wall' ? target : nearestEdge(target);
    if (!edge) return unchanged();

    if (pick) {
        const wall = getWall(model, edge.x, edge.y, edge.axis);
        if (!wall) return unchanged();

        state.wallPreset = wall.preset;
        state.selectedWall = { x: edge.x, y: edge.y, axis: edge.axis };
        return { changed: false, picked: true, wall: state.selectedWall };
    }

    state.selectedWall = { x: edge.x, y: edge.y, axis: edge.axis };

    const changed = erase
        ? clearWall(model, edge.x, edge.y, edge.axis)
        : setWall(model, edge.x, edge.y, edge.axis, state.wallPreset);

    return { changed, picked: false, wall: state.selectedWall };
}

/**
 * The edge of a cell a click was nearest to.
 *
 * `point` is where the ray met the floor, in the floor's own units where a cell is one
 * unit square -- the scene converts it, so this is arithmetic on two things measured the
 * same way. Whichever of the four edges is closest wins, expressed as the low node of
 * that edge so it names the same wall from either side.
 *
 * Exported because the hover has to answer the same question the click does: with the
 * wall tool chosen, what is under the pointer is the edge this picks, and saying anything
 * else would label one wall and paint another.
 */
export function nearestEdge(target) {
    const { x, y, point } = target;
    if (!point) return { x, y, axis: AXIS_X };

    // Distance from the click to each of the cell's four sides.
    const fromWest = point.x - x;
    const fromSouth = point.z - y;

    const distances = [
        { distance: fromWest, x: x - 1, y, axis: AXIS_X },
        { distance: 1 - fromWest, x, y, axis: AXIS_X },
        { distance: fromSouth, x, y: y - 1, axis: AXIS_Y },
        { distance: 1 - fromSouth, x, y, axis: AXIS_Y },
    ];

    const nearest = distances.reduce((best, edge) => (edge.distance < best.distance ? edge : best));

    // An edge off the grid is no edge; the outermost cells have only three.
    return nearest.x < 0 || nearest.y < 0 ? null : nearest;
}

function applyCellTool(model, state, target, { pick }) {
    if (target.kind !== 'cell') return unchanged();

    const { x, y } = target;

    if (state.tool === Tool.TILE) return applyTileTool(model, state, x, y, { pick });

    const node = nodeAt(model, x, y);
    if (!node) return unchanged();

    if (pick) return pickFromNode(model, state, node);

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

/** Ctrl+click: take the selection from what is under the pointer. */
function pickFromNode(model, state, node) {
    state.selectedNode = { x: node.x, y: node.y };

    switch (state.tool) {
        case Tool.ADDRESS:
            // The room comes with it. A room slot means nothing outside the address it
            // is in, so leaving the old one behind would leave the room list pointing at
            // whichever room of the new address happened to sit in that position.
            state.addressIndex = node.addressIndex;
            state.roomIndex = node.roomIndex;
            break;

        case Tool.ROOM: {
            const room = roomOfNode(model, node);
            if (!room) return unchanged();
            state.addressIndex = node.addressIndex;
            state.roomIndex = room.roomIndex;
            break;
        }

        case Tool.FLOOR_TYPE:
            // Both, as the reference does: picking a floor type without its height
            // means the next thing painted is at the wrong level.
            state.floorType = node.floorType;
            state.extraHeight = node.height;
            break;

        default:
            return unchanged();
    }

    return { changed: false, picked: true };
}

/**
 * The tile tool selects on ctrl and cycles otherwise.
 *
 * A tile is 3 x 3 nodes, so the cell that was clicked names the tile rather than being
 * the thing edited.
 */
function applyTileTool(model, state, x, y, { pick }) {
    const tile = tileForNode(model, x, y);
    if (!tile) return unchanged();

    state.selectedTile = { x: tile.x, y: tile.y };
    if (pick) return { changed: false, picked: true, tile: state.selectedTile };

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

    const targetKey = (target) => (
        target.kind === 'wall' ? `w:${target.x},${target.y},${target.axis}` : `c:${target.x},${target.y}`);

    function paintAt(event, isPress) {
        const model = getModel();
        if (!model) return;

        const target = scene.pickAt(event);
        if (!target) return;

        // The wall tool resolves a cell click to an edge, so its repeat guard has to be
        // on what was picked rather than on what was hit.
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
