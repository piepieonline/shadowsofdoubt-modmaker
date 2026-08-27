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
    setNodeAddress, setNodeRoom, setNodeFloor, paintTile, isPaintable,
} from './floorModel.js';

export const Tool = {
    ADDRESS: 'address',
    ROOM: 'room',
    FLOOR_TYPE: 'floorType',
    WALL: 'wall',
    TILE: 'tile',
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

        addressIndex: 0,

        // A room is chosen by what it is rather than by where it sits, because that is
        // what the room list shows. See setNodeRoom in the model.
        roomPreset: 'Null',
        roomId: 1,

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
 * `point` is where the ray met the floor, in the scene's own units where a cell is one
 * unit square. Whichever of the four edges is closest wins, expressed as the low node
 * of that edge so it names the same wall from either side.
 */
function nearestEdge(target) {
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

    switch (state.tool) {
        case Tool.ADDRESS:
            return { changed: setNodeAddress(model, node, state.addressIndex), picked: false };

        case Tool.ROOM:
            return { changed: setNodeRoom(model, node, state.roomPreset, state.roomId), picked: false };

        case Tool.FLOOR_TYPE:
            return {
                changed: setNodeFloor(model, node, state.floorType, state.extraHeight),
                picked: false,
            };

        default:
            return unchanged();
    }
}

/** Ctrl+click: take the selection from what is under the pointer. */
function pickFromNode(model, state, node) {
    state.selectedNode = { x: node.x, y: node.y };

    switch (state.tool) {
        case Tool.ADDRESS:
            state.addressIndex = node.addressIndex;
            break;

        case Tool.ROOM: {
            const room = roomOfNode(model, node);
            if (!room) return unchanged();
            state.addressIndex = node.addressIndex;
            state.roomPreset = room.preset;
            state.roomId = room.id;
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
 * the reference's MouseDown/MouseDrag. Two things bound it:
 *
 *  - A tool that cycles acts on the press alone. See PRESS_ONLY.
 *  - A drag never paints the same target twice, so a pointer wandering within one cell
 *    does not repeat the edit. That matters for more than tidiness: repeating a wall
 *    write is harmless, but it is the same guard that would stop a cycling tool if one
 *    were ever allowed to drag.
 *
 * Only the primary button paints; the others belong to the orbit controls.
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
            pick: event.ctrlKey || event.metaKey,
            erase: event.shiftKey,
        });

        if (result.changed || result.picked) onChange?.(result);
    }

    function onPointerDown(event) {
        if (event.button !== 0) return;

        // Ctrl-click is a pick, and on a Mac it is also the platform's context menu
        // gesture, so the orbit controls must not also take it as a drag.
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

        if (PRESS_ONLY.has(state.tool)) return;
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
