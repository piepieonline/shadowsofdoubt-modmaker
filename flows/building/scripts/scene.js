/**
 * The floorplan, drawn.
 *
 * A floor is 441 cells and 840 wall slots, every one of them built from axis-aligned
 * boxes. That is thousands of draw calls if they are separate meshes and three if they
 * are instanced, so everything here is an `InstancedMesh` with a per-instance colour.
 * Nothing creates a mesh per node.
 *
 * Three meshes rather than two, because drawing a wall and hitting one want different
 * shapes:
 *
 *   cells       441 boxes, one per node
 *   wallHits    840 boxes, one per wall slot, never drawn -- what a ray tests against
 *   wallParts   up to four boxes per slot, drawn -- what a wall looks like
 *
 * A window is drawn with a hole in it, and a ray through that hole would miss the wall
 * and find the floor beyond, so aiming at the middle of a window would select anything
 * but the window. Keeping a solid proxy for hit-testing means a wall is clickable
 * everywhere it appears to be, whatever shape is drawn inside it.
 *
 * Raycasting an `InstancedMesh` reports which instance was hit, and for the two meshes
 * that are raycast the instance index *is* the coordinate -- `y * 21 + x` for a cell,
 * and a pair of 20 x 21 blocks for walls. So there is no scene graph to search and no
 * per-object userData to keep in step with the model.
 *
 * What is deliberately *not* drawn in 3D: text. The reference tool puts the room preset,
 * the room id and the coordinates on every one of its 441 cells with TextMeshPro, which
 * is 441 more objects and a font atlas to make a grid readable. Here the hovered and
 * selected cells get an HTML label positioned by projecting their centre to the screen,
 * which is two DOM nodes. Labelling the whole grid can follow if it turns out to be
 * wanted; starting there would have been the expensive way to find out it is not.
 *
 * This module owns no model state. It is handed a floor model, reads it, and draws it.
 */
import {
    NODE_GRID, NODES_PER_TILE, TILE_GRID, AXIS_X, AXIS_Y,
    nodeAt, tileAt, getWall, isPaintable,
} from './floorModel.js';

/** View units. A node is 1 wide, so the grid is 21 x 21 and the origin is a corner. */
const CELL = 1;
const CELL_HEIGHT = 0.08;
const WALL_HEIGHT = 0.55;
const WALL_THICKNESS = 0.1;

/** Instances per axis: 20 x 21 gaps between neighbours, twice over. */
const WALLS_PER_AXIS = (NODE_GRID - 1) * NODE_GRID;

/**
 * How a wall is drawn: as up to four pieces of a frame, so that what a wall *is* reads
 * off its shape rather than off its colour alone.
 *
 *   wall     ▮   solid
 *   window   ▣   an opening with frame all the way around it
 *   door     ∩   an opening reaching the floor: two jambs and a lintel
 *   blank    ∪   an opening reaching the top: two jambs and a sill
 *
 * Which is a coherent thing to read at a glance -- where the opening *touches* is what
 * tells the three apart, and it is the same distinction the game makes.
 */
const WALL_PARTS = 4;

/** How much of a wall an opening takes, along it and up it. */
const OPENING_SPAN = 0.5;
const OPENING_RISE = 0.5;

/** The remaining width down each side, and the remaining height above and below. */
const JAMB = (1 - OPENING_SPAN) / 2;
const BAND = (1 - OPENING_RISE) / 2;

/**
 * The pieces, in wall-local fractions: `u` runs along the wall and `v` up it, both from
 * its centre, and `span`/`rise` are fractions of its length and height.
 */
const JAMB_LEFT = { u: -(1 - JAMB) / 2, v: 0, span: JAMB, rise: 1 };
const JAMB_RIGHT = { u: (1 - JAMB) / 2, v: 0, span: JAMB, rise: 1 };
const LINTEL = { u: 0, v: (1 - BAND) / 2, span: OPENING_SPAN, rise: BAND };
const SILL = { u: 0, v: -(1 - BAND) / 2, span: OPENING_SPAN, rise: BAND };
const WHOLE = { u: 0, v: 0, span: 1, rise: 1 };

const WALL_SHAPES = {
    wall: [WHOLE],
    window: [JAMB_LEFT, JAMB_RIGHT, LINTEL, SILL],
    door: [JAMB_LEFT, JAMB_RIGHT, LINTEL],
    blank: [JAMB_LEFT, JAMB_RIGHT, SILL],
};

/** How a floor is coloured. The reference has these as two toggles; here they compose. */
export const Overlay = {
    ADDRESS: 'address',
    FLOOR_TYPE: 'floorType',
    ROOM: 'room',
};

/**
 * FloorTileType as colour. Indices are the enum's, which are positional -- see the note
 * in refs/README.md about what reordering an enum costs.
 */
const FLOOR_TYPE_COLOURS = [
    [0.13, 0.14, 0.17],  // none            -- nothing here at all
    [0.55, 0.60, 0.68],  // floorAndCeiling -- an ordinary indoor square
    [0.44, 0.58, 0.42],  // floorOnly       -- a rooftop or a yard
    [0.58, 0.45, 0.62],  // CeilingOnly     -- overhead only
    [0.62, 0.56, 0.38],  // noneButIndoors  -- inside, but not walkable
];

/** A cell nothing has coloured, and the tint the outer margin is knocked back by. */
const UNKNOWN_COLOUR = [0.25, 0.25, 0.28];
const MARGIN_DIM = 0.35;

/** Walls the two halves of which disagree, so the floor can show which they are. */
const MISMATCH_COLOUR = [0.85, 0.15, 0.15];

/**
 * Build the view inside a container element.
 *
 * Returns a controller rather than exposing the scene: what callers need is "draw this
 * model", "what is under this point", and "let go of the GPU", and every one of those
 * is easier to keep correct in one place than spread across the tool code.
 */
export async function createScene(container) {
    const THREE = await import('three');
    const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14161a);

    const middle = (NODE_GRID * CELL) / 2;
    const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 500);
    camera.position.set(middle, NODE_GRID * 0.85, middle + NODE_GRID * 0.95);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(middle, 0, middle);
    controls.enableDamping = true;
    // The floor is a plane; letting the camera under it only ever loses the model.
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 1.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(1, 2, 1);
    scene.add(sun);

    const cells = buildCells(THREE);
    const walls = buildWallHits(THREE);
    const wallParts = buildWallParts(THREE);
    scene.add(cells, walls, wallParts);

    // Where the tile grid falls, drawn as lines rather than geometry: it is a reading
    // aid over the cells, not a thing in the floor.
    const tileGrid = buildTileGrid(THREE);
    scene.add(tileGrid);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    let model = null;
    let overlay = Overlay.ADDRESS;
    let frame = null;

    /* ---------------------------------------------------------------- */

    function resize() {
        const width = container.clientWidth || 1;
        const height = container.clientHeight || 1;

        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        draw();
    }

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    function draw() {
        controls.update();
        renderer.render(scene, camera);
    }

    /** Draw on the next frame, so a run of edits costs one render rather than many. */
    function invalidate() {
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
            frame = null;
            draw();
        });
    }

    controls.addEventListener('change', invalidate);

    /* ---------------------------------------------------------------- */

    /** Show a floor. Safe to call on every edit; it rewrites the instance buffers. */
    function setModel(next) {
        model = next;
        refresh();
    }

    function setOverlay(mode) {
        overlay = mode;
        refresh();
    }

    /** Re-read the model into the instance buffers. */
    function refresh() {
        if (!model) return;

        paintCells(THREE, cells, model, overlay);
        paintWalls(THREE, walls, wallParts, model);
        invalidate();
    }

    /* ---------------------------------------------------------------- */

    /** Put the pointer's position into normalised device coordinates. */
    function toDevice(event) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
    }

    /**
     * The cell under a screen point, or null.
     *
     * The instance index is the coordinate, so nothing has to be looked up.
     */
    function cellAt(event) {
        toDevice(event);
        const hit = raycaster.intersectObject(cells, false)[0];
        if (!hit || hit.instanceId === undefined) return null;

        return {
            x: hit.instanceId % NODE_GRID,
            y: Math.floor(hit.instanceId / NODE_GRID),
            point: hit.point,
        };
    }

    /** The wall under a screen point, or null. */
    function wallAt(event) {
        toDevice(event);
        const hit = raycaster.intersectObject(walls, false)[0];
        if (!hit || hit.instanceId === undefined) return null;
        return wallOfInstance(hit.instanceId);
    }

    /**
     * Whichever of the two is nearer the camera.
     *
     * A wall stands above the cells it sits between, so a click near an edge hits both.
     * The wall tool wants the wall and the others want the cell, but both want the one
     * actually in front -- picking by object would let a click land on a cell hidden
     * behind the wall it appears to be on.
     */
    function pickAt(event) {
        toDevice(event);
        const hits = raycaster.intersectObjects([cells, walls], false);
        const hit = hits[0];
        if (!hit || hit.instanceId === undefined) return null;

        if (hit.object === walls) {
            return { kind: 'wall', ...wallOfInstance(hit.instanceId), point: hit.point };
        }

        return {
            kind: 'cell',
            x: hit.instanceId % NODE_GRID,
            y: Math.floor(hit.instanceId / NODE_GRID),
            point: hit.point,
        };
    }

    /**
     * Where a cell's centre lands on screen, for positioning an HTML label over it.
     * Null when it is behind the camera, which is what stops a label from appearing on
     * the opposite side of the view.
     *
     * Projects the cell's top surface by default -- the same point a ray would hit --
     * so that projecting a cell and then picking at the result gives that cell back. A
     * label that wants to float above the floor passes a greater height.
     */
    function project(x, y, height = CELL_HEIGHT) {
        return projectPoint((x + 0.5) * CELL, height, (y + 0.5) * CELL);
    }

    /**
     * Where a wall's middle lands on screen -- for labelling one, and for aiming at
     * one. A wall sits on the seam between two cells rather than over either.
     */
    function projectWall(x, y, axis) {
        const along = axis === AXIS_X;
        return projectPoint(
            along ? (x + 1) * CELL : (x + 0.5) * CELL,
            WALL_HEIGHT / 2,
            along ? (y + 0.5) * CELL : (y + 1) * CELL);
    }

    function projectPoint(x, y, z) {
        const rect = renderer.domElement.getBoundingClientRect();
        const point = new THREE.Vector3(x, y, z).project(camera);

        if (point.z > 1) return null;

        return {
            left: rect.left + ((point.x + 1) / 2) * rect.width,
            top: rect.top + ((-point.y + 1) / 2) * rect.height,
        };
    }

    /** Frame the whole floor again, for a "reset view" control. */
    function resetView() {
        camera.position.set(middle, NODE_GRID * 0.85, middle + NODE_GRID * 0.95);
        controls.target.set(middle, 0, middle);
        controls.update();
        invalidate();
    }

    function dispose() {
        observer.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
        controls.dispose();

        for (const mesh of [cells, walls, wallParts]) {
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
        tileGrid.geometry.dispose();
        tileGrid.material.dispose();

        renderer.dispose();
        renderer.domElement.remove();
    }

    resize();

    return {
        setModel, setOverlay, refresh, resize, draw, invalidate,
        cellAt, wallAt, pickAt, project, projectWall, resetView, dispose,
        get canvas() { return renderer.domElement; },
        get overlay() { return overlay; },
        // For tests and for anything that needs to reason about the view directly.
        _internals: { THREE, scene, camera, controls, cells, walls, wallParts, renderer },
    };
}


/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

function buildCells(THREE) {
    const geometry = new THREE.BoxGeometry(CELL * 0.96, CELL_HEIGHT, CELL * 0.96);
    const material = new THREE.MeshLambertMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, NODE_GRID * NODE_GRID);

    const matrix = new THREE.Matrix4();
    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            matrix.setPosition((x + 0.5) * CELL, 0, (y + 0.5) * CELL);
            mesh.setMatrixAt(y * NODE_GRID + x, matrix);
        }
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
}

/**
 * What a ray hits: one box per wall slot, covering the whole of it, never drawn.
 *
 * Hit-testing is kept apart from the drawing because the two want different shapes. A
 * window is drawn with a hole in it, and a ray through that hole would miss the wall
 * and find the floor beyond -- so aiming at the middle of a window would select
 * anything but the window. The proxy is the wall's whole volume, so a wall is
 * clickable everywhere it appears to be, whatever shape is drawn inside it.
 *
 * All 840 exist from the start and a slot with no wall gets a sliver rather than
 * nothing: an `InstancedMesh` has no per-instance visibility, and keeping every slot in
 * the buffer is what lets a wall be painted onto an empty edge at all.
 *
 * `visible = false` stops it being drawn but not raycast -- three tests visibility when
 * rendering and layers when raycasting, and this is only ever raycast by being named.
 * `a wall is hit where it looks solid, including across a window's opening` in
 * tests/buildingScene.spec.js is what says so if that ever stops being true.
 */
function buildWallHits(THREE) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, WALLS_PER_AXIS * 2);

    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.visible = false;
    return mesh;
}

/**
 * What is drawn: up to four pieces per slot, so a wall can have a hole in it.
 *
 * Four instances per slot whether or not they are all used, so that an instance index
 * is still arithmetic on the slot rather than a lookup that has to be rebuilt whenever
 * a wall changes kind. Unused pieces are scaled to nothing; this mesh is never
 * raycast, so a degenerate instance costs a few triangles that draw nothing.
 */
function buildWallParts(THREE) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshLambertMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, WALLS_PER_AXIS * 2 * WALL_PARTS);

    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
}

/**
 * Which wall an instance index refers to.
 *
 * The first block is the x-axis walls -- the gap between (x, y) and (x + 1, y), of
 * which there are 20 per row -- and the second the y-axis ones.
 */
function wallOfInstance(index) {
    if (index < WALLS_PER_AXIS) {
        return { x: index % (NODE_GRID - 1), y: Math.floor(index / (NODE_GRID - 1)), axis: AXIS_X };
    }

    const offset = index - WALLS_PER_AXIS;
    return { x: offset % NODE_GRID, y: Math.floor(offset / NODE_GRID), axis: AXIS_Y };
}

/** And back again, so painting can find the instance for a wall it just changed. */
export function instanceOfWall(x, y, axis) {
    return axis === AXIS_X
        ? y * (NODE_GRID - 1) + x
        : WALLS_PER_AXIS + y * NODE_GRID + x;
}

/** The 7 x 7 tile boundaries, as lines laid just above the cells. */
function buildTileGrid(THREE) {
    const points = [];
    const span = NODE_GRID * CELL;
    const height = CELL_HEIGHT;

    for (let i = 0; i <= TILE_GRID; i++) {
        const at = i * NODES_PER_TILE * CELL;
        points.push(at, height, 0, at, height, span);
        points.push(0, height, at, span, height, at);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));

    return new THREE.LineSegments(
        geometry, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 }));
}


/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

function paintCells(THREE, mesh, model, overlay) {
    const colour = new THREE.Color();

    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            const [r, g, b] = cellColour(model, x, y, overlay);

            // The outer three nodes on every side are the margin between lots and
            // cannot be painted, so they are shown knocked back rather than hidden --
            // a floor that appeared to be 15 x 15 would misrepresent its own
            // coordinates.
            const dim = isPaintable(x, y) ? 1 : MARGIN_DIM;

            colour.setRGB(r * dim, g * dim, b * dim);
            mesh.setColorAt(y * NODE_GRID + x, colour);
        }
    }

    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

function cellColour(model, x, y, overlay) {
    const node = nodeAt(model, x, y);
    if (!node) return UNKNOWN_COLOUR;

    if (overlay === Overlay.FLOOR_TYPE) {
        return FLOOR_TYPE_COLOURS[node.floorType] ?? UNKNOWN_COLOUR;
    }

    if (overlay === Overlay.ROOM) {
        // Rooms have no colour of their own in the file, so one is derived from the
        // room's identity. Stable across a session and across a reload, which is what
        // matters: it is there to tell two rooms apart, not to mean anything.
        return hashColour(`${node.addressIndex}:${node.roomIndex}`);
    }

    const address = model.addresses[node.addressIndex];
    const colour = address?.colour;
    if (!colour) return UNKNOWN_COLOUR;

    return [colour.r ?? 0, colour.g ?? 0, colour.b ?? 0];
}

/** A readable colour from a string, evenly spread around the hue circle. */
function hashColour(key) {
    let hash = 0;
    for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) | 0;

    const hue = ((hash % 360) + 360) % 360;
    return hslToRgb(hue / 360, 0.45, 0.6);
}

function hslToRgb(h, s, l) {
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const second = chroma * (1 - Math.abs(((h * 6) % 2) - 1));
    const match = l - chroma / 2;

    const sextant = Math.floor(h * 6) % 6;
    const table = [
        [chroma, second, 0], [second, chroma, 0], [0, chroma, second],
        [0, second, chroma], [second, 0, chroma], [chroma, 0, second],
    ][sextant];

    return table.map((component) => component + match);
}

/**
 * Stand a wall up where the floor has one, and leave the rest as slivers.
 *
 * A wall whose two halves disagree is shown in red rather than in its own colour. 582
 * wall halves across 30 base game floors are in that state, so this is a thing an
 * author will see on floors they did not author -- the point is that it is visible,
 * not that it is theirs.
 */
function paintWalls(THREE, hits, parts, model) {
    const matrix = new THREE.Matrix4();
    const colour = new THREE.Color();

    /** One piece of a wall, in the wall's own frame of reference. */
    const placePart = (index, centreX, centreZ, along, piece, height) => {
        const thick = WALL_THICKNESS;
        const span = piece.span * CELL;

        matrix.makeScale(
            along ? thick : span, piece.rise * height, along ? span : thick);
        matrix.setPosition(
            centreX + (along ? 0 : piece.u * CELL),
            height / 2 + piece.v * height,
            centreZ + (along ? piece.u * CELL : 0));

        parts.setMatrixAt(index, matrix);
    };

    const hide = (index, centreX, centreZ) => {
        matrix.makeScale(0, 0, 0);
        matrix.setPosition(centreX, 0, centreZ);
        parts.setMatrixAt(index, matrix);
    };

    const place = (slot, x, y, axis) => {
        const wall = getWall(model, x, y, axis);
        const along = axis === AXIS_X;

        // The seam between the two cells: half a cell past this node's centre.
        const centreX = along ? (x + 1) * CELL : (x + 0.5) * CELL;
        const centreZ = along ? (y + 0.5) * CELL : (y + 1) * CELL;

        const first = slot * WALL_PARTS;

        if (!wall) {
            // No wall: a sliver, so the edge can be seen and aimed at.
            matrix.makeScale(
                along ? WALL_THICKNESS : CELL, CELL_HEIGHT * 0.6, along ? CELL : WALL_THICKNESS);
            matrix.setPosition(centreX, CELL_HEIGHT * 0.3, centreZ);
            hits.setMatrixAt(slot, matrix);
            parts.setMatrixAt(first, matrix);

            colour.setRGB(0.2, 0.2, 0.23);
            parts.setColorAt(first, colour);

            for (let part = 1; part < WALL_PARTS; part++) hide(first + part, centreX, centreZ);
            return;
        }

        // What a ray hits is the whole of the wall, whatever shape is drawn in it.
        matrix.makeScale(
            along ? WALL_THICKNESS : CELL, WALL_HEIGHT, along ? CELL : WALL_THICKNESS);
        matrix.setPosition(centreX, WALL_HEIGHT / 2, centreZ);
        hits.setMatrixAt(slot, matrix);

        const [r, g, b] = wall.matched ? wallColour(wall.preset) : MISMATCH_COLOUR;
        colour.setRGB(r, g, b);

        const shape = WALL_SHAPES[kindOf(wall.preset)] ?? WALL_SHAPES.wall;

        for (let part = 0; part < WALL_PARTS; part++) {
            if (part < shape.length) {
                placePart(first + part, centreX, centreZ, along, shape[part], WALL_HEIGHT);
                parts.setColorAt(first + part, colour);
            } else {
                hide(first + part, centreX, centreZ);
            }
        }
    };

    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID - 1; x++) place(instanceOfWall(x, y, AXIS_X), x, y, AXIS_X);
    }
    for (let y = 0; y < NODE_GRID - 1; y++) {
        for (let x = 0; x < NODE_GRID; x++) place(instanceOfWall(x, y, AXIS_Y), x, y, AXIS_Y);
    }

    hits.instanceMatrix.needsUpdate = true;
    parts.instanceMatrix.needsUpdate = true;
    if (parts.instanceColor) parts.instanceColor.needsUpdate = true;

    // An InstancedMesh caches a bounding sphere covering all its instances, and both
    // culling and raycasting test against it before looking at any instance. It is
    // computed on first use -- which happens at the first render, when every wall
    // matrix is still the zero matrix an InstancedMesh starts with. Left alone, that
    // caches a sphere of radius nothing and every ray at a wall misses for the life of
    // the scene. Recomputed here because this is where the matrices change.
    hits.computeBoundingSphere();
    parts.computeBoundingSphere();
}

/**
 * A wall's colour, by what kind of thing it is rather than which preset it is.
 *
 * Four kinds is what the reference draws too, and it is as much as the data supports:
 * `wallPresetKinds.json` is a transcription, and three of its entries are unverified.
 */
function wallColour(preset) {
    switch (kindOf(preset)) {
        case 'window': return [0.35, 0.65, 0.85];
        case 'door': return [0.85, 0.70, 0.30];
        case 'blank': return [0.30, 0.30, 0.34];
        default: return [0.78, 0.78, 0.82];
    }
}

/**
 * What a preset is: wall, window, door or blank.
 *
 * A preset the table has no entry for is drawn as a wall. That is the honest default --
 * ids 28 to 30 name nothing the game has, so a floor referring to one is already
 * saying something this app cannot interpret, and a solid box is the shape that claims
 * least about it.
 */
const kindOf = (preset) => window.wallPresetKinds?.[preset] ?? 'wall';


/* -------------------------------------------------------------------------- */
/* Tile gizmos                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What each tile carries: an entrance, a stairwell, an elevator, and which way it
 * faces.
 *
 * Read out rather than drawn, so the caller can render them as HTML over the canvas.
 * They are per-tile rather than per-node -- 49 of them -- and drawing 49 arrows as
 * geometry to say the same thing would be more code, more disposal, and less legible
 * at a shallow camera angle.
 */
export function tileMarkers(model) {
    const markers = [];

    for (let x = 0; x < TILE_GRID; x++) {
        for (let y = 0; y < TILE_GRID; y++) {
            const tile = tileAt(model, x, y);
            if (!tile) continue;
            if (!tile.isEntrance && !tile.isStairwell) continue;

            markers.push({
                x, y,
                // The tile's centre, in node coordinates, for project().
                nodeX: x * NODES_PER_TILE + 1,
                nodeY: y * NODES_PER_TILE + 1,
                entrance: tile.isMainEntrance ? 'main' : (tile.isEntrance ? 'entrance' : null),
                stairwell: tile.isStairwell ? (tile.isInverted ? 'elevator' : 'stairs') : null,
                rotation: tile.stairwellRotation,
            });
        }
    }

    return markers;
}

/** What a cell's label should say: the reference's room preset, id and coordinates. */
export function describeCell(model, x, y) {
    const node = nodeAt(model, x, y);
    if (!node) return null;

    const address = model.addresses[node.addressIndex];
    const room = model.rooms.find(
        (entry) => entry.addressIndex === node.addressIndex && entry.roomIndex === node.roomIndex);

    return {
        coordinate: `${x}, ${y}`,
        address: address?.layoutConfiguration ?? '?',
        room: room ? `${room.preset} #${room.id}` : '?',
        floorType: node.floorType,
        height: node.height,
        backfilled: node.backfilled,
    };
}
