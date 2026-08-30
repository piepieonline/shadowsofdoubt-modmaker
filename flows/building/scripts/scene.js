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
 * Text in the scene is for the tiles and for nothing else. The reference tool puts the
 * room preset, the room id and the coordinates on every one of its 441 cells with
 * TextMeshPro, which is 441 more objects and a font atlas to make a grid readable; here
 * the cell under the pointer gets an HTML label positioned by projecting its centre to
 * the screen, which is one DOM node. A tile is the exception, and for a reason a cell
 * does not have: what it carries is a stairwell's facing, which is a fact about the
 * *world* -- turned a quarter at a time, measured from the front of the building -- and
 * an HTML label over a canvas cannot be turned to lie in it. There are 49 tiles, at most
 * a handful of them carrying anything, so this is a label per interesting tile rather
 * than a label per coordinate.
 *
 * This module owns no model state. It is handed a floor model, reads it, and draws it.
 */
import {
    NODE_GRID, NODES_PER_TILE, TILE_GRID, AXIS_X, AXIS_Y,
    nodeAt, tileAt, getWall, isPaintable, isOutsideNode, tileParts, roomColour,
} from './floorModel.js';
import { dividerPostAtLowEnd } from './dividerEnds.js';

/** View units. A node is 1 wide, so the grid is 21 x 21 and the origin is a corner. */
const CELL = 1;
const CELL_HEIGHT = 0.08;
const WALL_HEIGHT = 0.55;
const WALL_THICKNESS = 0.1;

/**
 * Which side of the floor the front is, and where the camera stands to see it.
 *
 * A blueprint is a 21 x 21 grid of coordinates with nothing in it saying which way the
 * building faces, so this is a convention of the view. The front is the y = 0 edge, and
 * the camera starts beyond it looking back along +z.
 *
 * Standing on the far side instead would show the floor turned through half a turn --
 * the front edge at the back of the view, and x running right to left. That is one
 * camera position, not a mirrored grid: nothing about how a node maps to a point in the
 * scene changes, so picking, projecting and the wall arithmetic are all untouched by it.
 */
const FRONT_Z = -1;
const DEFAULT_EYE = [
    (NODE_GRID * CELL) / 2,
    NODE_GRID * 0.85,
    (NODE_GRID * CELL) / 2 + FRONT_Z * NODE_GRID * 0.95,
];

/**
 * How near and how far the camera may stand, and how far one press of a camera key moves.
 *
 * The bounds are not only the keyboard's: without them a zoom in carries on through the
 * floor and a zoom out loses the building. The grid is 21 across and the default eye
 * stands about 27 back from the middle of it, so these are a close look at a few cells
 * and a view with room to spare around the whole floor.
 *
 * The steps are sized for a key held down as much as for one tapped. A browser repeats at
 * about thirty a second, so a step small enough to aim with is still a turn in a second or
 * so of holding.
 */
const MIN_DISTANCE = 4;
const MAX_DISTANCE = 80;
const KEY_ORBIT = 0.06;
const KEY_ZOOM = 1.1;
const KEY_PAN = 0.05;

/** Straight down is a degenerate spherical angle, so the tilt stops just short of it. */
const MIN_POLAR = 0.001;

/**
 * The floor's x axis, reversed, which is the whole of the difference between the game's
 * coordinates and this scene's.
 *
 * The game's world is left-handed -- x right, y up, z forward -- and three's is
 * right-handed. Copying a node's x and y straight across as x and z, as the obvious
 * reading of the file invites, therefore draws the floor mirrored: every room ends up on
 * the wrong side of the building. Negating one axis is what the two coordinate systems
 * actually differ by, and x is the one chosen for it.
 *
 * Its own involution: `mirrorX(mirrorX(v)) === v`, so the same function converts a model
 * coordinate to the scene and a point the ray found back again. Everything that turns a
 * node into a position goes through it, and nothing else in the app knows about it --
 * pickAt hands back a point already in the floor's own units.
 */
const mirrorX = (value) => NODE_GRID * CELL - value;

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

/**
 * A divider's rail: a lintel across the whole wall, and a little deeper than one.
 *
 * Along the top rather than along the floor, which is where a piece belongs that is there
 * to be seen over the top of everything else in the view -- a band at the bottom is read
 * as part of the floor, and at this camera angle it is very nearly under it.
 */
const RAIL_DEPTH = 0.35;

const RAIL = { u: 0, v: (1 - RAIL_DEPTH) / 2, span: 1, rise: RAIL_DEPTH };

/** The same band across the middle of the wall only: a threshold rather than a run. */
const THRESHOLD = { u: 0, v: (1 - RAIL_DEPTH) / 2, span: OPENING_SPAN, rise: RAIL_DEPTH };

/**
 * The presets drawn as something more specific than their kind.
 *
 * A divider is a run of partition rather than one wall, and the game splits it into a
 * middle and two ends. The rail spans the whole wall, so that a run of them joins into
 * one line rather than reading as a row of dashes, and what tells the three apart is the
 * posts: a middle has none, because a post in the middle of a run is where the run does
 * *not* end, and each end carries the one on its own side. They are the same jambs a
 * blank has -- half of them, which is the whole of the difference between the pair.
 *
 * NothingEntrance is the same rail across the middle of the wall alone: a threshold, with
 * the way through on either side of it. It is not a divider, but it is the same question
 * -- something spanning, with the way past it beside rather than through -- so it is
 * drawn at the same height.
 *
 * Which side is which: `u` runs toward the far end of a wall in the floor's own
 * coordinates, which placePart is what makes true on both axes. Which end of a run the
 * game itself puts each preset at is a question this app cannot answer, and that is a
 * measured result rather than a shrug -- see the note at the top of dividerEnds.js for
 * what was tested against the game and how it failed. So the left is drawn at the low
 * end of a run and the right at the high one, which is a convention of this view and not
 * a claim about the game.
 *
 * It is still worth drawing, because it is the one thing the author can act on. The
 * editor writes the pair that reads with its posts capping the run, so a run drawn with
 * them bunched in the middle is one that has been deliberately turned round -- and the
 * two states being told apart at a glance is what makes the erase-and-replace repair in
 * dividerEnds.js usable at all.
 *
 * Keyed by id because that is a preset's identity; the names are in soDoorPairIds.json
 * and repeated here so this reads without it.
 */
const PRESET_SHAPES = {
    4: [RAIL],                  // DividerCentre
    10: [THRESHOLD],            // NothingEntrance
};

/**
 * A divider end, with its post on the side the game will put it.
 *
 * `u` runs toward the high end of a wall's run in the floor's own coordinates, so a post
 * at the low end is the left jamb and one at the high end the right. Which of the two a
 * preset gets is not a property of the preset -- it depends on which side of the wall the
 * parent room is, which is dividerEnds.js's business.
 */
const DIVIDER_END_SHAPES = {
    low: [JAMB_LEFT, RAIL],
    high: [JAMB_RIGHT, RAIL],
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

/**
 * The same five types as two facts about each, which is what the floor type overlay
 * draws.
 *
 * Five colours are five things to learn and nothing to reason from: the type of a square
 * is not one choice out of five but two independent ones -- is there something to stand
 * on, and is there something overhead -- and the names say so. floorAndCeiling has both,
 * floorOnly the floor, CeilingOnly the ceiling, and the two "none" values neither.
 *
 * So none and noneButIndoors are drawn identically and are told apart by colour alone,
 * which is honest: nothing stands in either, and where the game counts the square as
 * being is not a thing the view can show. Indices are the enum's, like the colours above.
 */
const FLOOR_TYPE_HAS_FLOOR = [false, true, true, false, false];
const FLOOR_TYPE_HAS_CEILING = [false, true, false, true, false];

/**
 * How the floor type overlay draws those two facts.
 *
 * A square with no floor is see-through rather than absent. Absent would be the truer
 * picture and the worse control: an empty coordinate cannot be aimed at, and turning a
 * hole back into a floor is exactly what this tool is for. So the slab stays where it is
 * and stops being solid, and the grid lines and walls showing through it are the sign.
 *
 * A ceiling is a square floating over the cell, clear of the walls. It is not what a
 * ceiling looks like -- a ceiling is a lid over a room, not a tile per square -- but it is
 * what the file stores, one square at a time, and drawing it per square is what makes a
 * hole in one visible.
 *
 * Half a cell across and in a colour of its own, rather than the cell's at nearly full
 * width. Both of those were tried the other way round and both were wrong: a lid the size
 * of the square it is over sits exactly on it from the angle the view opens at, and one
 * in the square's own colour has nothing to stand out against when it does clear it. So
 * what a floor of ordinary indoor squares looked like was a haze over half the floor. A
 * small square in a colour nothing else in the scene uses reads as a marker at height from
 * every angle, and leaves the floor under it visible either way.
 *
 * Only in this overlay. The address and room overlays are read as flat sheets of colour,
 * and a floor half of which is see-through with squares hanging over it is not one.
 */
const GHOST_OPACITY = 0.22;
const CEILING_CAP_CLEARANCE = WALL_HEIGHT;
const CEILING_CAP_INSET = 0.5;
const CEILING_CAP_OPACITY = 0.7;
const CEILING_CAP_COLOUR = 0xdfefff;

/**
 * How far a node's stored height lifts it in the view.
 *
 * `f_h` is in the floor's own unit, and the floor's `defaultCeilingHeight` is the number
 * to read it against: the base game's non-zero heights run from 7 to 51 on floors whose
 * ceilings are 42 and 52, so one unit is a small fraction of a storey rather than a step
 * of anything. Measured from `defaultFloorHeight`, which is the level the floor itself
 * sits at -- DinerFloorBeta stores 8 there and 8 on most of its nodes, and drawing that
 * floor hovering would say something false about every square on it.
 *
 * A ceiling's worth of height is drawn as a wall's worth of rise, so the tallest thing in
 * the base game -- 51 against a 42 ceiling -- clears the walls by about a fifth of one.
 */
const STOREY_RISE = WALL_HEIGHT;

/**
 * The tile overlay: where it floats, how big each square is, and how solid.
 *
 * Clear of the walls rather than level with them. A wall stands WALL_HEIGHT tall and is
 * the tallest thing in the scene, so a square laid at that height would be sliced by
 * every wall crossing it and the overlay would read as a set of fragments rather than as
 * one square per tile.
 *
 * The squares stop short of each other so the seams between tiles stay visible; without
 * the gap seven of them in a row are one sheet.
 */
const TILE_OVERLAY_HEIGHT = WALL_HEIGHT + CELL_HEIGHT * 2;
const TILE_OVERLAY_INSET = 0.94;
const TILE_OVERLAY_OPACITY = 0.28;
const TILE_OVERLAY_COLOUR = 0x6fb6ff;

/**
 * What is written on a tile: size, and how much of the square the words may take.
 *
 * A tile is 3 cells across and the longest thing one can say is "Main entrance", so the
 * size is what fits that on one line inside a square 3 wide with a margin. `maxWidth`
 * still matters, because a tile carrying a stairwell *and* an entrance says both, one
 * per line -- wrapping is what stops the longer of the two running off its square and
 * into the next one's.
 *
 * Just clear of the tile squares rather than level with them. Text laid at exactly their
 * height would z-fight the sheet it is written on, which is the one way of making a label
 * unreadable that no amount of contrast fixes.
 */
const TILE_LABEL_HEIGHT = TILE_OVERLAY_HEIGHT + 0.02;
const TILE_LABEL_SIZE = 0.36;
const TILE_LABEL_WIDTH = NODES_PER_TILE * CELL * 0.9;
const TILE_LABEL_LINE_HEIGHT = 1.15;

/**
 * White with the background painted round it, which is what makes a label readable over
 * a floor whose colours are the file's rather than the view's.
 *
 * The squares under the labels are addresses -- every colour a mod author chose, at
 * whatever contrast they chose it -- so there is no one text colour that works over all
 * of them. An outline in the scene's own background colour gives every glyph its own
 * backing, so the label is read against the view rather than against the floor.
 *
 * Drawn after the room outlines rather than before. Those are `depthTest: false` with a
 * late `renderOrder`, so they paint over whatever has already been drawn -- including,
 * without this, a white strip across the middle of a label wherever a room boundary
 * happened to run under it.
 */
const TILE_LABEL_COLOUR = 0xffffff;
const TILE_LABEL_OUTLINE_COLOUR = 0x14161a;
const TILE_LABEL_OUTLINE_WIDTH = '14%';
const TILE_LABEL_ORDER = 11;

/**
 * The mark on the selected square: an asterisk, written in the floor.
 *
 * Text rather than an outline, and for the same reason the tiles are: what a square
 * carries is already said in words lying in the floor, so the square that was clicked is
 * said the same way. An outline would have had to compete with the room outlines, which
 * are white quads on exactly the seams a square's own outline would fall on.
 *
 * Sits on the square's own top surface rather than at the tile labels' height, so it is
 * over the square it names at every camera angle -- a mark floating at wall height over a
 * single cell is ambiguous the moment the view tilts. `depthTest: false` is what keeps it
 * visible anyway: a selection you cannot see behind a wall is one you lose.
 *
 * Drawn after the tile labels, which are themselves after the room outlines.
 */
const SELECTION_MARK = '*';
const SELECTION_MARK_SIZE = 0.9;
const SELECTION_MARK_LIFT = 0.02;
const SELECTION_MARK_ORDER = TILE_LABEL_ORDER + 1;

/**
 * Much thinner than a tile label's.
 *
 * An outline is a percentage of the font size, and a tile label wants a heavy one: it is
 * small text read over squares in whatever colours a mod author chose. This is one large
 * glyph made of thin strokes, and 14% of a font size this big is wider than the strokes
 * are -- enough to close the gaps between the arms and leave a blob.
 */
const SELECTION_MARK_OUTLINE_WIDTH = '3%';

/** Degrees, which is what a tile stores its rotation in, as radians. */
const DEGREE = Math.PI / 180;

/**
 * The room outlines: how many segments there can be, how high they lie, and how wide.
 *
 * One segment per seam where the room changes, plus the two sides of the grid that have
 * no neighbour beyond them to compare against. Every cell can contribute the seam to its
 * right and the seam below it, and the cells along two edges one more each -- which is
 * the whole of it, because the far side of the last column *is* that column's right-hand
 * seam.
 *
 * A segment is a cell long plus its own width, so that two meeting at a corner overlap
 * instead of leaving a square notch out of it.
 */
const ROOM_EDGE_SLOTS = NODE_GRID * NODE_GRID * 2 + NODE_GRID * 2;
const ROOM_EDGE_HEIGHT = CELL_HEIGHT + 0.01;
const ROOM_EDGE_WIDTH = 0.09;
const ROOM_EDGE_LENGTH = CELL + ROOM_EDGE_WIDTH;

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
    const { Text } = await import('troika-three-text');

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
    camera.position.set(...DEFAULT_EYE);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(middle, 0, middle);
    controls.enableDamping = true;
    // The floor is a plane; letting the camera under it only ever loses the model.
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.minDistance = MIN_DISTANCE;
    controls.maxDistance = MAX_DISTANCE;

    /*
     * The left button belongs to the tools, not to the camera -- unless alt is held.
     *
     * OrbitControls has it orbit by default, which would mean every stroke also swung
     * the view. So it is given nothing -- a mouse action of null falls through the
     * control's switch and leaves it in no state at all -- and orbiting moves to the
     * middle and right buttons, either of which does it.
     *
     * Pan is not given a button of its own and does not need one: OrbitControls pans
     * instead of rotating whenever ctrl or shift is held on a button set to ROTATE, so
     * both of these pan with a modifier. Neither collides with the tools' modifiers,
     * which are on the left button only.
     */
    controls.mouseButtons = {
        LEFT: null,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: THREE.MOUSE.ROTATE,
    };

    controls.update();

    /*
     * Alt lends the left button to the camera for the length of one drag.
     *
     * A Mac trackpad has no middle button at all, and its right one is a two-finger click
     * that cannot be held through a drag without a third finger -- so orbiting was
     * reachable only by the gesture a trackpad is worst at. Alt+drag is what Maya,
     * Sketchfab and most orbit views on the web use, and here it collides with nothing:
     * OrbitControls picks pan over rotate on ctrl, meta and shift and never reads alt, and
     * the tools' modifiers are those same three. Alt+shift+drag pans, for free.
     *
     * Which button orbits has to be settled before OrbitControls sees the press, and it
     * binds its own pointerdown on the canvas as it is constructed -- ahead of the tools'.
     * Listeners on one element run in the order they were added whatever phase they asked
     * for, so no second canvas listener can get in front of it. A capture listener on the
     * container can: an ancestor's capture phase runs before the target's handlers.
     *
     * Read on the press alone. Alt taken up or put down part way through does not change
     * what the drag already is.
     */
    const chooseLeftButton = (event) => {
        controls.mouseButtons.LEFT = event.altKey ? THREE.MOUSE.ROTATE : null;
    };
    container.addEventListener('pointerdown', chooseLeftButton, { capture: true });

    /*
     * The middle button orbits, so it must not also do what the browser does with it.
     *
     * Chrome and Firefox on Windows and Linux start autoscroll on a middle press, which
     * would leave a scroll cursor stuck over the canvas for the whole of a drag.
     * OrbitControls does not stop it: it listens on pointerdown, and preventing that
     * does not suppress the mouse event the browser acts on. So the mouse event is what
     * is caught here.
     */
    const suppressAutoscroll = (event) => { if (event.button === 1) event.preventDefault(); };
    renderer.domElement.addEventListener('mousedown', suppressAutoscroll);

    /*
     * The camera on the keyboard: arrows orbit, shift+arrows pan, - and + zoom.
     *
     * OrbitControls has key handling of its own and it is not this one. `listenToKeyEvents`
     * puts pan on the bare arrows, rotate on the modified ones, and zoom on nothing at
     * all, so the camera is moved here instead -- by writing the position and letting
     * `update` reconcile, which is what resetView already does.
     *
     * The keys are the canvas's rather than the window's. An arrow means something in a
     * text field and in the trees and lists this app is mostly made of, and a handler on
     * the window would be left guessing which of those was asking; one on a canvas that
     * can hold focus never has to guess. Pressing in the view focuses it, so clicking on
     * the thing you want to steer is the whole of the ceremony.
     */
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label',
        'Floorplan view. Arrow keys orbit, shift with arrow keys pans, minus and plus zoom.');

    const focusOnPress = () => renderer.domElement.focus({ preventScroll: true });
    renderer.domElement.addEventListener('pointerdown', focusOnPress);

    /** Where the camera stands relative to what it looks at, which every key move works on. */
    const cameraOffset = () => camera.position.clone().sub(controls.target);

    function orbitBy(theta, phi) {
        const spherical = new THREE.Spherical().setFromVector3(cameraOffset());

        spherical.theta += theta;
        spherical.phi = Math.min(
            Math.max(spherical.phi + phi, controls.minPolarAngle + MIN_POLAR),
            controls.maxPolarAngle);

        camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    }

    function dollyBy(factor) {
        const offset = cameraOffset();
        const distance = Math.min(
            Math.max(offset.length() * factor, controls.minDistance), controls.maxDistance);

        camera.position.copy(controls.target).add(offset.setLength(distance));
    }

    /**
     * Pan across the screen rather than the world.
     *
     * Right is the camera's right and up is its up, so which way a key shifts the view
     * does not depend on where the camera has been orbited to. The eye and what it looks
     * at move together: moving only the eye would swing the view, which is orbiting.
     */
    function panBy(right, up) {
        camera.updateMatrixWorld();

        const step = cameraOffset().length() * KEY_PAN;
        const move = new THREE.Vector3()
            .setFromMatrixColumn(camera.matrixWorld, 0)
            .multiplyScalar(right * step)
            .add(new THREE.Vector3()
                .setFromMatrixColumn(camera.matrixWorld, 1)
                .multiplyScalar(up * step));

        camera.position.add(move);
        controls.target.add(move);
    }

    /*
     * An arrow moves the camera the way it points -- left orbits leftwards, up climbs --
     * so the floor appears to swing the other way. That is the direction OrbitControls'
     * own keys take and the one every other orbit view takes with them.
     */
    function onKeyDown(event) {
        // A key with ctrl, meta or alt on it belongs to the browser or to the OS.
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        const pans = event.shiftKey;

        switch (event.key) {
            case 'ArrowLeft': pans ? panBy(-1, 0) : orbitBy(-KEY_ORBIT, 0); break;
            case 'ArrowRight': pans ? panBy(1, 0) : orbitBy(KEY_ORBIT, 0); break;
            case 'ArrowUp': pans ? panBy(0, 1) : orbitBy(0, -KEY_ORBIT); break;
            case 'ArrowDown': pans ? panBy(0, -1) : orbitBy(0, KEY_ORBIT); break;

            // Shift is not consulted here: + is a shifted = on most layouts, and _ a
            // shifted -, so both spellings of each key mean the same zoom.
            case '-': case '_': dollyBy(KEY_ZOOM); break;
            case '=': case '+': dollyBy(1 / KEY_ZOOM); break;

            default: return;
        }

        // Only now that a key is known to be the camera's: an arrow this did not use is
        // still the page's to scroll with.
        event.preventDefault();
        controls.update();
        invalidate();
    }

    renderer.domElement.addEventListener('keydown', onKeyDown);

    scene.add(new THREE.AmbientLight(0xffffff, 1.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(1, 2, 1);
    scene.add(sun);

    // The floor itself: what is drawn where there is something to stand on, what is drawn
    // where there is not, the ceilings over both, and the boxes a ray actually meets.
    const cells = buildCells(THREE);
    const ghostCells = buildGhostCells(THREE);
    const ceilingCaps = buildCeilingCaps(THREE);
    const cellHits = buildCellHits(THREE);

    const walls = buildWallHits(THREE);
    const wallParts = buildWallParts(THREE);
    scene.add(cells, ghostCells, ceilingCaps, cellHits, walls, wallParts);

    // Where the tile grid falls, drawn as lines rather than geometry: it is a reading
    // aid over the cells, not a thing in the floor.
    const tileGrid = buildTileGrid(THREE);
    scene.add(tileGrid);

    // One square per tile, hidden until the tile tool is chosen, and what each of them
    // says written on it. See setTileOverlay: the two are shown and hidden together,
    // because a label is what the square it is on is for.
    const tileOverlay = buildTileOverlay(THREE);
    const tileLabels = buildTileLabels(THREE, Text);
    scene.add(tileOverlay, tileLabels);

    // Where one room ends and the next begins. Rebuilt from the model on every refresh.
    const roomEdges = buildRoomEdges(THREE);
    scene.add(roomEdges);

    // The square that was clicked. Not the tile overlay's business and not the model's:
    // which square is selected is the tools' state, so it arrives through setSelected.
    const selectionMark = buildSelectionMark(THREE, Text);
    scene.add(selectionMark);
    let selected = null;

    // How far the asterisk's ink sits from the middle of the box troika lays it out in.
    // Zero until the glyph exists to measure -- see centreMarkInk.
    let markInkOffset = 0;

    const forwardArrow = buildForwardArrow(THREE);
    scene.add(forwardArrow);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    let model = null;
    let overlay = Overlay.ADDRESS;
    let frame = null;
    let wantTileOverlay = false;

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
        showTileOverlay();
        refresh();

        // refresh draws nothing when there is no model, and closing a floor while the
        // tile tool is chosen has to take the squares off screen with it -- and the
        // selection mark with them, which refresh cannot do from inside its own guard.
        placeSelection();
        invalidate();
    }

    function setOverlay(mode) {
        overlay = mode;
        refresh();
    }

    /**
     * Show or hide the tile squares.
     *
     * Asked for by the tools rather than decided here: the scene has no idea which tool
     * is active, and this is the one thing the drawing needs to know about it. A tile is
     * 3 x 3 cells and the cells are what a click lands on, so without the squares the
     * only sign of where a tile boundary falls is a line on the floor -- which is under
     * the walls, and under the cursor, at exactly the moment it is being aimed at.
     */
    function setTileOverlay(on) {
        wantTileOverlay = on;
        showTileOverlay();
        invalidate();
    }

    /** Nothing is shown over a floor that is not open. */
    const showTileOverlay = () => {
        tileOverlay.visible = wantTileOverlay && model !== null;
        tileLabels.visible = tileOverlay.visible;
    };

    /**
     * Mark a square as selected, or clear the mark with null.
     *
     * Told rather than worked out, for the same reason setTileOverlay is: which square is
     * selected lives in the tool state, and the scene has no view of that.
     */
    function setSelected(at) {
        selected = at ? { x: at.x, y: at.y } : null;
        placeSelection();
        invalidate();
    }

    /**
     * Put the mark on the selected square's top surface.
     *
     * Re-run on every refresh as well as on every selection, because the height it sits
     * at is the square's own: painting a floor type under the selection, or switching to
     * the overlay that draws raised squares raised, moves the surface it lies on.
     */
    function placeSelection() {
        const at = model && selected;
        selectionMark.visible = !!at;
        if (!at) return;

        selectionMark.position.set(
            mirrorX((at.x + 0.5) * CELL),
            cellTop(at.x, at.y) + SELECTION_MARK_LIFT,
            (at.y + 0.5) * CELL - markInkOffset);

        // Laying out text is asynchronous, so the frame this was called for is drawn
        // without the glyph and the callback asks for another once it exists. troika
        // returns without calling back when nothing has changed, and the text never
        // changes here -- so this lays out once, on the first selection of the page.
        selectionMark.sync(() => {
            centreMarkInk(at);
            invalidate();
        });
    }

    /**
     * Put the asterisk's *ink* on the square's centre, rather than its line box.
     *
     * `anchorY: 'middle'` centres the block troika lays the glyph out in, which is a
     * whole line tall. An asterisk's ink sits in the top of that box -- it is a
     * superscript mark -- so a block centred on the square draws the asterisk itself
     * about a third of a cell above it, straddling whatever is on the seam.
     *
     * `visibleBounds` is the ink, so the difference between its middle and the block's is
     * exactly the correction. Measured rather than tuned, and measured once: the text
     * never changes, so the offset is the same for every square it ever lands on.
     *
     * Text-local +y is world +z here -- the mark is laid flat by a quarter turn about x
     * and then half a turn about z, and the two compose to send local up to world south.
     */
    function centreMarkInk(at) {
        const bounds = selectionMark.textRenderInfo?.visibleBounds;
        if (!bounds) return;

        markInkOffset = (bounds[1] + bounds[3]) / 2;
        selectionMark.position.z = (at.y + 0.5) * CELL - markInkOffset;
    }

    /** Re-read the model into the instance buffers. */
    function refresh() {
        if (!model) return;

        paintCells(THREE, {
            solid: cells, ghost: ghostCells, caps: ceilingCaps, hits: cellHits,
        }, model, overlay);
        paintWalls(THREE, walls, wallParts, model);
        paintRoomEdges(THREE, roomEdges, model);
        paintTileLabels(tileLabels, model, invalidate);
        placeSelection();
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
        const hit = raycaster.intersectObject(cellHits, false)[0];
        if (!hit || hit.instanceId === undefined) return null;

        return {
            x: hit.instanceId % NODE_GRID,
            y: Math.floor(hit.instanceId / NODE_GRID),
            point: inFloorUnits(hit.point),
        };
    }

    /**
     * Where the ray met the floor, in the floor's own units rather than the scene's.
     *
     * The wall tool asks which edge of a cell a click was nearest, which is arithmetic
     * on the click and the cell's coordinates -- so the two have to be in the same
     * units. Converting here is what keeps the mirror from leaking out of this file; see
     * mirrorX. Kept as `{x, z}` because that is the plane the floor lies in.
     */
    const inFloorUnits = (point) => ({ x: mirrorX(point.x), y: point.y, z: point.z });

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
        const hits = raycaster.intersectObjects([cellHits, walls], false);
        const hit = hits[0];
        if (!hit || hit.instanceId === undefined) return null;

        if (hit.object === walls) {
            return {
                kind: 'wall',
                ...wallOfInstance(hit.instanceId),
                point: inFloorUnits(hit.point),
            };
        }

        return {
            kind: 'cell',
            x: hit.instanceId % NODE_GRID,
            y: Math.floor(hit.instanceId / NODE_GRID),
            point: inFloorUnits(hit.point),
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
     *
     * Which is why the default is asked of the model rather than being CELL_HEIGHT: in
     * the floor type overlay a raised square's top is not where an unraised one's is, and
     * a default that ignored that would aim under the square it named.
     */
    function project(x, y, height = cellTop(x, y)) {
        return projectPoint(mirrorX((x + 0.5) * CELL), height, (y + 0.5) * CELL);
    }

    /** The height the square at a coordinate is currently drawn up to. */
    function cellTop(x, y) {
        return slabOf(model, model ? nodeAt(model, x, y) : null, overlay).top;
    }

    /**
     * Where a wall's middle lands on screen -- for labelling one, and for aiming at
     * one. A wall sits on the seam between two cells rather than over either.
     *
     * Its middle by default, which is the point a ray aimed at it would meet, so
     * projecting a wall and then picking at the result gives that wall back. A label
     * passes a greater height, for the same reason the cell label does: one drawn at the
     * middle would cover the wall it is naming.
     */
    function projectWall(x, y, axis, height = WALL_HEIGHT / 2) {
        const along = axis === AXIS_X;
        return projectPoint(
            mirrorX(along ? (x + 1) * CELL : (x + 0.5) * CELL),
            height,
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
        camera.position.set(...DEFAULT_EYE);
        controls.target.set(middle, 0, middle);
        controls.update();
        invalidate();
    }

    function dispose() {
        observer.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
        controls.dispose();
        renderer.domElement.removeEventListener('mousedown', suppressAutoscroll);
        renderer.domElement.removeEventListener('pointerdown', focusOnPress);
        renderer.domElement.removeEventListener('keydown', onKeyDown);

        // This one is not on the canvas, so it does not go when the canvas does.
        container.removeEventListener('pointerdown', chooseLeftButton, { capture: true });

        for (const mesh of [cells, ghostCells, ceilingCaps, cellHits, walls, wallParts]) {
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
        tileGrid.geometry.dispose();
        tileGrid.material.dispose();
        tileOverlay.geometry.dispose();
        tileOverlay.material.dispose();
        roomEdges.geometry.dispose();
        roomEdges.material.dispose();

        // A troika Text disposes its own geometry and nothing else -- deliberately, so
        // that a base material shared by several of them is not thrown away under the
        // rest. All 49 do share one, so it is disposed once, here; troika listens for
        // that and disposes the material it derived from it.
        for (const label of tileLabels.children) label.dispose();
        tileLabels.userData.material.dispose();

        selectionMark.dispose();
        selectionMark.userData.material.dispose();

        // One material shared by both pieces, so it is disposed once rather than per
        // child -- disposing it twice is harmless, but saying so here is cheaper than
        // leaving the next reader to check.
        for (const piece of forwardArrow.children) piece.geometry.dispose();
        forwardArrow.children[0]?.material.dispose();

        renderer.dispose();
        renderer.domElement.remove();
    }

    resize();

    return {
        setModel, setOverlay, setTileOverlay, setSelected, refresh, resize, draw, invalidate,
        cellAt, wallAt, pickAt, project, projectWall, resetView, dispose,
        get canvas() { return renderer.domElement; },
        get overlay() { return overlay; },
        // Which square is marked, so a caller can check the view agrees with whatever
        // told it. Read-only: setSelected is the only way in.
        get selected() { return selected && { ...selected }; },
        // For tests and for anything that needs to reason about the view directly.
        _internals: {
            THREE, scene, camera, controls, cells, ghostCells, ceilingCaps, cellHits,
            walls, wallParts, tileOverlay, tileLabels, roomEdges, selectionMark, renderer,
        },
    };
}


/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

const cellGeometry = (THREE) => new THREE.BoxGeometry(CELL * 0.96, CELL_HEIGHT, CELL * 0.96);

/**
 * Put every square flat on the grid, which is where they all are until a floor says
 * otherwise.
 *
 * paintCells rewrites these on every refresh and it is the only thing that has an opinion
 * about heights -- but it runs on a model, and a view with no floor open still has to draw
 * something and still has to answer where its squares are.
 */
function layFlat(THREE, mesh) {
    const matrix = new THREE.Matrix4();

    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            matrix.setPosition(mirrorX((x + 0.5) * CELL), 0, (y + 0.5) * CELL);
            mesh.setMatrixAt(y * NODE_GRID + x, matrix);
        }
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
}

/**
 * The squares of the floor, as they are drawn.
 *
 * Not what a click lands on -- that is buildCellHits, for the same reason the walls keep
 * the two apart. A square with no floor is drawn see-through and a raised one is drawn
 * standing proud, and neither may change where the cell can be aimed at: painting a floor
 * back into a hole is the whole point of the tool that puts holes there.
 *
 * The matrices are rewritten on every refresh rather than set once here, because the
 * height a square is drawn at is a fact about the floor and about which overlay is on.
 */
function buildCells(THREE) {
    const mesh = new THREE.InstancedMesh(
        cellGeometry(THREE), new THREE.MeshLambertMaterial(), NODE_GRID * NODE_GRID);

    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return layFlat(THREE, mesh);
}

/**
 * The same squares again, see-through: the ones the floor type overlay says nothing
 * stands on.
 *
 * A second mesh rather than a second colour because an `InstancedMesh` has one material
 * and a material has one opacity -- there is no per-instance alpha to set. So each square
 * is drawn by exactly one of the two meshes and scaled to nothing in the other, and
 * whichever is drawing it puts it in the same place at the same size.
 *
 * Lit like the solid one, so a ghost reads as the same slab with the solidity taken out
 * rather than as a different object. `depthWrite` off for the usual reason: a ghost that
 * wrote depth would stop whatever is behind it being drawn through it, which is the one
 * thing being see-through is for.
 */
function buildGhostCells(THREE) {
    const material = new THREE.MeshLambertMaterial({
        transparent: true,
        opacity: GHOST_OPACITY,
        depthWrite: false,
    });

    const mesh = new THREE.InstancedMesh(
        cellGeometry(THREE), material, NODE_GRID * NODE_GRID);

    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.visible = false;
    return mesh;
}

/**
 * A square floating over every cell the floor type overlay says has something overhead.
 *
 * Unlit and see-through, like the tile squares: it is a gizmo saying what the file
 * records, not a surface in the model, and the floor under it is what is being read while
 * it is on screen. One colour for all of them rather than the cell's own, because which
 * square a lid belongs to is said by where it is, and what it has to be legible against is
 * every one of the five floor colours.
 *
 * It clears the walls, which are the tallest thing in the scene, so a run of them reads as
 * a layer over the floor rather than as something tangled in it.
 */
function buildCeilingCaps(THREE) {
    // A plane faces its own +z, so it is laid flat once here rather than in 441 matrices.
    const geometry = new THREE.PlaneGeometry(CELL * CEILING_CAP_INSET, CELL * CEILING_CAP_INSET);
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshBasicMaterial({
        color: CEILING_CAP_COLOUR,
        transparent: true,
        opacity: CEILING_CAP_OPACITY,
        depthWrite: false,
        // The camera cannot go under the floor, but it can rise above these, and a plane
        // seen from behind is invisible rather than wrong.
        side: THREE.DoubleSide,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, NODE_GRID * NODE_GRID);

    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.visible = false;
    return mesh;
}

/**
 * What a ray hits: one box per cell, covering the whole of what is drawn there, never
 * drawn itself.
 *
 * The same split the walls make, and for the same kind of reason. The drawn square moves:
 * a raised one stands on a plinth, and one with no floor is a ghost you can see straight
 * through. A ray has to meet all of those the same way, because every one of them is a
 * square you paint by clicking where it appears to be -- and a see-through thing you
 * cannot click is a hole in the tool, not a hole in the floor.
 *
 * All 441 exist from the start and every one of them is placed on every refresh, so there
 * is no such thing as a coordinate on the grid that cannot be aimed at.
 */
function buildCellHits(THREE) {
    const mesh = new THREE.InstancedMesh(
        cellGeometry(THREE), new THREE.MeshBasicMaterial(), NODE_GRID * NODE_GRID);

    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // `visible = false` stops it being drawn but not raycast -- three tests visibility
    // when rendering and layers when raycasting, and this is only ever raycast by being
    // named. The same arrangement as the wall proxies above.
    mesh.visible = false;
    return layFlat(THREE, mesh);
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

/**
 * Which way the building faces, as an arrow lying off the front edge pointing away.
 *
 * A floor is a 21 x 21 grid with nothing in it that says which side is the front, so the
 * rotation the file stores against a stairwell is measured from a direction the view was
 * not showing. One arrow, always in the same place, is what makes those numbers mean
 * something.
 *
 * It sits off the front edge -- see FRONT_Z -- pointing away from the floor, so in the
 * default view it points at the viewer and never lands behind the model.
 */
function buildForwardArrow(THREE) {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: 0xffbe5c });

    const middle = (NODE_GRID * CELL) / 2;

    // The z the front edge is at, and the direction away from the floor across it: 0 and
    // -z at the y = 0 side, and the far corner and +z if that ever changes.
    const edge = FRONT_Z < 0 ? 0 : NODE_GRID * CELL;
    const out = FRONT_Z;

    // Clear of the outermost cells rather than touching them, so it reads as a marker
    // beside the floor rather than as something standing on it.
    const shaft = new THREE.Mesh(
        new THREE.BoxGeometry(CELL * 0.3, CELL_HEIGHT, CELL * 1.4), material);
    shaft.position.set(middle, CELL_HEIGHT / 2, edge + out * CELL * 1.2);

    // A cone points up its own y, so it is laid over to point along the floor.
    const head = new THREE.Mesh(
        new THREE.ConeGeometry(CELL * 0.55, CELL * 0.9, 4), material);
    head.rotation.x = out * Math.PI / 2;
    head.position.set(middle, CELL_HEIGHT / 2, edge + out * CELL * 2.35);

    group.add(shaft, head);
    return group;
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

/**
 * One square per tile, floating over the whole floor: what the tile tool works on.
 *
 * Every other tool paints a cell, and a tile is a 3 x 3 block of them. The lines the tile
 * grid draws say where the boundaries fall, but they lie on the floor -- under the walls,
 * and under whatever the pointer is over -- so at the moment a tile is being aimed at
 * they are the hardest thing in the scene to see. A square is the shape of the thing the
 * click will actually change.
 *
 * Drawn unlit and see-through: it is a gizmo over the floor, not a surface in it, and the
 * floor beneath is what an author is reading while placing a stairwell. `depthWrite` is
 * off for the same reason a transparent thing usually has it off -- writing depth would
 * let a nearer square stop a farther one from being drawn through it.
 *
 * All 49 are built once and never move. Visibility is the only thing that changes, and it
 * is the mesh's own -- an InstancedMesh has none per instance, which is exactly why this
 * is all-or-nothing rather than a square per interesting tile.
 */
function buildTileOverlay(THREE) {
    const side = NODES_PER_TILE * CELL;

    // A plane faces its own +z, so it is laid flat once here rather than in 49 matrices.
    const geometry = new THREE.PlaneGeometry(side * TILE_OVERLAY_INSET, side * TILE_OVERLAY_INSET);
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshBasicMaterial({
        color: TILE_OVERLAY_COLOUR,
        transparent: true,
        opacity: TILE_OVERLAY_OPACITY,
        depthWrite: false,
        // The camera cannot go under the floor, but a plane seen from behind is invisible
        // rather than wrong, which is the sort of thing that reads as a bug in a screenshot.
        side: THREE.DoubleSide,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, TILE_GRID * TILE_GRID);
    const matrix = new THREE.Matrix4();

    for (let y = 0; y < TILE_GRID; y++) {
        for (let x = 0; x < TILE_GRID; x++) {
            matrix.setPosition(mirrorX((x + 0.5) * side), TILE_OVERLAY_HEIGHT, (y + 0.5) * side);
            mesh.setMatrixAt(y * TILE_GRID + x, matrix);
        }
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();

    // Never raycast: pickAt names the two meshes it tests, and this is not one of them.
    // A click goes through to the cell underneath, which is what the tile tool reads.
    mesh.visible = false;
    return mesh;
}

/**
 * What each tile says, written on the square drawn over it.
 *
 * 49 of them, one per tile, built once and never moved -- the same arrangement as the
 * squares they lie on, and for the same reason: a tile's index is arithmetic on its
 * coordinates, so there is no list to keep in step with the model. The text is what
 * changes, and a slot with nothing to say is left empty and hidden rather than removed.
 *
 * Text meshes rather than the HTML the hovered cell uses, because a tile label has to lie
 * *in* the floor. A stairwell's rotation is measured from the front of the building, and
 * the way to show a direction is to point in it; an HTML element over the canvas can be
 * turned on the screen, which is a different plane and would say a different thing at
 * every camera angle.
 *
 * One base material for all 49, which is troika's own design: what a label says and what
 * colour it is are set per draw, so sharing costs nothing and means one shader program
 * and one thing to dispose. It is kept on the group rather than reached through
 * `label.material`, which returns the *derived* material -- and an array of two of them
 * once an outline is configured.
 */
/**
 * The asterisk on the selected square.
 *
 * One `Text`, with a material of its own rather than the tile labels' shared one: the
 * two are shown under different conditions -- the labels only while the tile tool is
 * chosen, this whenever a square is selected -- and sharing would tie the lifetime of a
 * thing that is always on to a group that is usually off.
 *
 * Laid flat and turned to be read from the front, and never rotated after that: an
 * asterisk has no direction to point in, which is the one thing a tile label's rotation
 * is for. That is the half turn the labels no longer start from -- theirs is read from
 * whichever side their stairs open onto, and this is read from where the camera is.
 */
function buildSelectionMark(THREE, Text) {
    const material = new THREE.MeshBasicMaterial({
        color: TILE_LABEL_COLOUR,
        transparent: true,
        depthWrite: false,

        // In front of the walls rather than inside them. The mark is on the square's own
        // surface, so anything standing on the seams around it would otherwise hide it
        // at exactly the angles a floor is usually read from.
        depthTest: false,
        side: THREE.DoubleSide,
    });

    const mark = new Text();

    mark.material = material;
    mark.text = SELECTION_MARK;
    mark.fontSize = SELECTION_MARK_SIZE;
    mark.textAlign = 'center';
    mark.anchorX = 'center';
    mark.anchorY = 'middle';
    mark.outlineWidth = SELECTION_MARK_OUTLINE_WIDTH;
    mark.outlineColor = TILE_LABEL_OUTLINE_COLOUR;
    mark.renderOrder = SELECTION_MARK_ORDER;
    mark.rotation.set(-Math.PI / 2, 0, Math.PI, 'XYZ');

    // Nothing is selected until something is clicked.
    mark.visible = false;
    mark.userData.material = material;

    return mark;
}

function buildTileLabels(THREE, Text) {
    const group = new THREE.Group();
    const side = NODES_PER_TILE * CELL;

    const material = new THREE.MeshBasicMaterial({
        color: TILE_LABEL_COLOUR,
        transparent: true,

        // A label is above every solid thing in the scene, so it has nothing to hide
        // behind and nothing to write depth for -- and writing it would let a glyph of
        // one label occlude the outline of its own.
        depthWrite: false,

        // A label faces up and the camera can get under one -- the tilt stops at the
        // horizon, and these float most of a wall's height above it, so a close zoom is
        // below them. troika's own default, and the better of the two: text seen from
        // beneath is mirrored, and text on a single-sided plane is gone. At the grazing
        // angle that reaches it neither is legible, and only one of them looks broken.
        side: THREE.DoubleSide,
    });

    for (let y = 0; y < TILE_GRID; y++) {
        for (let x = 0; x < TILE_GRID; x++) {
            const label = new Text();

            label.material = material;
            label.fontSize = TILE_LABEL_SIZE;
            label.maxWidth = TILE_LABEL_WIDTH;
            label.lineHeight = TILE_LABEL_LINE_HEIGHT;
            label.textAlign = 'center';
            label.anchorX = 'center';
            label.anchorY = 'middle';
            label.outlineWidth = TILE_LABEL_OUTLINE_WIDTH;
            label.outlineColor = TILE_LABEL_OUTLINE_COLOUR;
            label.renderOrder = TILE_LABEL_ORDER;

            label.position.set(mirrorX((x + 0.5) * side), TILE_LABEL_HEIGHT, (y + 0.5) * side);

            // Nothing to say until a floor is read, and an empty label is never synced --
            // see paintTileLabels. `visible` is what keeps a slot off screen; the group's
            // own visibility is what the tile tool switches.
            label.visible = false;

            group.add(label);
        }
    }

    group.userData.material = material;
    group.visible = false;
    return group;
}

/**
 * The outline of every room, in white, over everything else in the scene.
 *
 * A room is not a shape in the file. It is a list of nodes, and the only thing saying
 * where one ends is that the node beyond it belongs to a different room -- so a room that
 * has swallowed part of its neighbour, or that sits entirely inside another, looks
 * exactly like a room that has not until the outlines are drawn. Then it is a closed loop
 * inside a closed loop, which is a thing you cannot miss.
 *
 * Quads rather than lines. WebGL ignores `linewidth` on every desktop browser -- a
 * LineSegments outline is one pixel wide however close the camera gets, which is not
 * enough to read against a floor of coloured squares. A quad is as wide as it is told to
 * be and gets wider as you zoom in, like everything else in the scene.
 *
 * Drawn on top of everything rather than in its place. Room boundaries and walls fall on
 * the same seams, and a wall is a box a tenth of a cell thick standing on that seam -- so
 * a strip laid honestly on the floor is inside the wall and invisible for as long as the
 * wall is there. An outline that vanished along every walled edge would read as a broken
 * outline rather than as a wall, which is the opposite of the point. `depthTest: false`
 * plus a late `renderOrder` is what puts it in front; `transparent` is set not to make it
 * see-through -- it is fully opaque -- but because that is what moves it into the pass
 * that runs after the tile squares, which would otherwise be drawn over it.
 *
 * Every slot exists from the start and the unused ones are scaled to nothing, the same
 * way the wall parts are: an instance index stays arithmetic rather than a lookup that
 * has to be rebuilt whenever a room changes shape.
 */
function buildRoomEdges(THREE) {
    // A plane faces its own +z, so it is laid flat once here and the instances only ever
    // scale and translate it.
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        side: THREE.DoubleSide,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, ROOM_EDGE_SLOTS);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.renderOrder = 10;

    // Unused slots sit at the origin at zero scale, so a bounding sphere computed from
    // the instances would be wrong until the first floor is drawn -- and there is nothing
    // to gain from culling one object that covers the whole floor anyway.
    mesh.frustumCulled = false;

    return mesh;
}


/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where the top and the bottom of a square's slab are, in scene units.
 *
 * One answer used by everything that has to agree about it: what is drawn, what a ray
 * hits, where a ceiling floats, and where a label is put. A square at the floor's own
 * level is the box this always drew -- resting on nothing, a slab thick. A raised one
 * stands on a plinth reaching down to that level rather than floating over a gap, so what
 * is drawn is what the ray meets and a click near its edge cannot fall through. A sunken
 * one is the same slab, lowered; there is nothing to fill in, because the hole above it is
 * how you can see it at all.
 *
 * Height is only drawn in the floor type overlay, which is the one the tool that paints it
 * turns on. Everywhere else a floor is read as a flat sheet of colour.
 */
function slabOf(model, node, overlay) {
    const rise = overlay === Overlay.FLOOR_TYPE ? riseOf(model, node) : 0;
    return { top: CELL_HEIGHT + rise, bottom: Math.min(0, rise) };
}

/** A node's stored height as a rise. See STOREY_RISE for what it is measured against. */
function riseOf(model, node) {
    const ceiling = model?.defaultCeilingHeight;
    if (!ceiling || !node) return 0;

    const steps = (node.height ?? 0) - (model.defaultFloorHeight ?? 0);
    return (steps / ceiling) * STOREY_RISE;
}

const hasFloor = (node) => FLOOR_TYPE_HAS_FLOOR[node?.floorType] ?? true;
const hasCeiling = (node) => FLOOR_TYPE_HAS_CEILING[node?.floorType] ?? false;

/**
 * Lay out and colour every square: the solid ones, the see-through ones, the ceilings over
 * them, and the boxes a ray meets.
 *
 * Every square is coloured in both the solid mesh and the ghost one whichever is drawing
 * it, so the colour a cell has does not depend on what it is made of. Which of the two is
 * showing is the matrices' business, and it is settled one square at a time.
 */
function paintCells(THREE, meshes, model, overlay) {
    const { solid, ghost, caps, hits } = meshes;
    const colour = new THREE.Color();
    const matrix = new THREE.Matrix4();

    const typed = overlay === Overlay.FLOOR_TYPE;

    /** A box standing between two heights, or nothing at all. */
    const box = (mesh, index, centreX, centreZ, slab, shown) => {
        const scale = shown ? 1 : 0;
        matrix.makeScale(scale, scale * (slab.top - slab.bottom) / CELL_HEIGHT, scale);
        matrix.setPosition(centreX, (slab.top + slab.bottom) / 2, centreZ);
        mesh.setMatrixAt(index, matrix);
    };

    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            const index = y * NODE_GRID + x;
            const node = nodeAt(model, x, y);

            const [r, g, b] = cellColour(model, x, y, overlay);

            // The outer three nodes on every side are the margin between lots and
            // cannot be painted, so they are shown knocked back rather than hidden --
            // a floor that appeared to be 15 x 15 would misrepresent its own
            // coordinates.
            const dim = isPaintable(x, y) ? 1 : MARGIN_DIM;

            // Both slab meshes, so the colour a square has does not depend on what it is
            // made of. Not the lids: those have one colour of their own. See buildCeilingCaps.
            colour.setRGB(r * dim, g * dim, b * dim);
            solid.setColorAt(index, colour);
            ghost.setColorAt(index, colour);

            const centreX = mirrorX((x + 0.5) * CELL);
            const centreZ = (y + 0.5) * CELL;
            const slab = slabOf(model, node, overlay);

            // Solid unless this overlay is the one that says otherwise. A coordinate with
            // no node at all has nothing to say about its floor, so it keeps the slab it
            // is drawn with everywhere else rather than becoming a second kind of hole.
            const solidHere = !typed || hasFloor(node);
            box(solid, index, centreX, centreZ, slab, solidHere);
            box(ghost, index, centreX, centreZ, slab, !solidHere);

            // Always placed, whatever is drawn there: this is what makes every square on
            // the grid clickable, including the ones that are barely there.
            box(hits, index, centreX, centreZ, slab, true);

            const lid = typed && hasCeiling(node);
            matrix.makeScale(lid ? 1 : 0, 1, lid ? 1 : 0);
            matrix.setPosition(centreX, slab.top + CEILING_CAP_CLEARANCE, centreZ);
            caps.setMatrixAt(index, matrix);
        }
    }

    // Shown only where they mean something. Both are empty in the other overlays -- every
    // instance scaled away -- but a mesh that is off is one three does not walk at all.
    ghost.visible = typed;
    caps.visible = typed;

    for (const mesh of [solid, ghost, caps, hits]) {
        mesh.instanceMatrix.needsUpdate = true;

        // Only the two slab meshes have one, and only they need flushing.
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

        // An InstancedMesh caches a bounding sphere covering all its instances, and both
        // culling and raycasting test against it before looking at any instance. The
        // matrices have just moved, so the cached one is out of date -- and for `hits`,
        // stale by exactly as much as the tallest square on the floor.
        mesh.computeBoundingSphere();
    }
}

function cellColour(model, x, y, overlay) {
    const node = nodeAt(model, x, y);
    if (!node) return UNKNOWN_COLOUR;

    if (overlay === Overlay.FLOOR_TYPE) {
        return FLOOR_TYPE_COLOURS[node.floorType] ?? UNKNOWN_COLOUR;
    }

    if (overlay === Overlay.ROOM) {
        // Rooms have no colour of their own in the file, so it comes from the room's slot
        // -- the same palette the addresses are drawn from, read from the other end. See
        // roomColour: what that buys is that no square keeps its colour when the overlay
        // changes, which is how the view says which of the two is being painted.
        const colour = roomColour(node.roomIndex);
        return [colour.r, colour.g, colour.b];
    }

    const address = model.addresses[node.addressIndex];
    const colour = address?.colour;
    if (!colour) return UNKNOWN_COLOUR;

    return [colour.r ?? 0, colour.g ?? 0, colour.b ?? 0];
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

    /**
     * One piece of a wall, in the wall's own frame of reference.
     *
     * A wall running along y lies on the mirrored axis, so `u` is subtracted there rather
     * than added: the whole point of mirrorX is that a scene position is the floor's
     * coordinate reflected, and an offset from a reflected point runs the other way. That
     * did not matter while every shape was symmetrical about the middle of a wall. It
     * does now -- without it, the same asymmetric preset would be drawn one way round on
     * one axis and the other way round on the other.
     */
    const placePart = (index, centreX, centreZ, along, piece, height) => {
        const thick = WALL_THICKNESS;
        const span = piece.span * CELL;

        matrix.makeScale(
            along ? thick : span, piece.rise * height, along ? span : thick);
        matrix.setPosition(
            centreX - (along ? 0 : piece.u * CELL),
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

        // The seam between the two cells: half a cell past this node's centre. Mirrored
        // like everything else; which way a shape's pieces are then laid out along it is
        // placePart's business, and it is asymmetric shapes that made it one.
        const centreX = mirrorX(along ? (x + 1) * CELL : (x + 0.5) * CELL);
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

        const shape = shapeOf(model, x, y, axis, wall.preset);

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
 * Lay a strip along every seam where the room changes.
 *
 * Each cell is compared with the neighbour to its right and the one below it, so every
 * seam is looked at once from one side rather than twice from both. The two remaining
 * sides of the grid are handled by comparing against a coordinate that is off it.
 *
 * A room is identified by the pair it is stored under -- which address, and which room
 * within that address's chosen variation. Comparing the pair rather than the room object
 * means two different addresses meeting is a boundary as well, which it is: nothing about
 * the same room number under two addresses makes them one room.
 *
 * Three things are all "nothing" here and all compare equal: off the grid, a coordinate
 * with no node, and Outside. Which makes the whole rule one comparison -- a seam is drawn
 * wherever the two sides differ. Outside meeting Outside is not a boundary, so the margin
 * and every unclaimed square are left bare; Outside meeting a room is, so a room against
 * the open air is still closed. That is what keeps the outlines to the rooms someone laid
 * out rather than adding a second outline around all the space between them.
 */
function paintRoomEdges(THREE, edges, model) {
    const matrix = new THREE.Matrix4();
    let count = 0;

    /*
     * Which room each cell is in, worked out once up front.
     *
     * The loop below asks about every cell four times as it compares neighbours, and the
     * answer costs a search through the floor's room list -- so asking as it goes is four
     * searches per cell on a path that runs again on every stroke of the brush. Whether a
     * room is filler is cached per room rather than per cell for the same reason.
     */
    const keys = new Array(NODE_GRID * NODE_GRID);
    const filler = new Map();

    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            const node = nodeAt(model, x, y);
            if (!node) {
                keys[y * NODE_GRID + x] = null;
                continue;
            }

            const slot = `${node.addressIndex}:${node.roomIndex}`;
            if (!filler.has(slot)) filler.set(slot, isOutsideNode(model, node));
            keys[y * NODE_GRID + x] = filler.get(slot) ? null : slot;
        }
    }

    const roomKey = (x, y) => (
        x < 0 || y < 0 || x >= NODE_GRID || y >= NODE_GRID
            ? null
            : keys[y * NODE_GRID + x]);

    /** One strip, centred on the seam and running along it. */
    const segment = (centreX, centreZ, along) => {
        matrix.makeScale(
            along === AXIS_X ? ROOM_EDGE_LENGTH : ROOM_EDGE_WIDTH,
            1,
            along === AXIS_X ? ROOM_EDGE_WIDTH : ROOM_EDGE_LENGTH);
        matrix.setPosition(mirrorX(centreX), ROOM_EDGE_HEIGHT, centreZ);
        edges.setMatrixAt(count, matrix);
        count++;
    };

    const middle = 0.5 * CELL;

    for (let y = 0; y < NODE_GRID; y++) {
        for (let x = 0; x < NODE_GRID; x++) {
            const here = roomKey(x, y);

            // The seam to the right runs along y; the one below runs along x.
            if (roomKey(x + 1, y) !== here) segment((x + 1) * CELL, y * CELL + middle, AXIS_Y);
            if (roomKey(x, y + 1) !== here) segment(x * CELL + middle, (y + 1) * CELL, AXIS_X);

            // The two sides the loop never reaches from the other direction. Off the grid
            // is nothing, so this closes a room at the edge of the floor and leaves the
            // margin -- which is Outside, and also nothing -- alone.
            if (x === 0 && here !== null) segment(0, y * CELL + middle, AXIS_Y);
            if (y === 0 && here !== null) segment(x * CELL + middle, 0, AXIS_X);
        }
    }

    // Every slot the floor did not need, scaled away. An InstancedMesh has no per-instance
    // visibility, so this is what "not drawn" means -- and it has to happen every time,
    // or a floor with fewer boundaries than the last would keep the leftovers.
    matrix.makeScale(0, 0, 0);
    for (let slot = count; slot < ROOM_EDGE_SLOTS; slot++) edges.setMatrixAt(slot, matrix);

    edges.instanceMatrix.needsUpdate = true;
}

/**
 * A wall's colour, by what kind of thing it is rather than which preset it is.
 *
 * Four kinds is what the reference draws too, and it is as much as the data supports:
 * `wallPresetKinds.json` is a transcription, and four of its entries are unverified.
 */
function wallColour(preset) {
    switch (colourKindOf(preset)) {
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

/**
 * The three dividers, coloured as doors are.
 *
 * The kinds table calls them blanks, which is what they are -- an opening with nothing
 * above it -- and blanks are drawn in the dark grey that says "nothing here". That is the
 * wrong thing to say about a divider: it is a thing you can see over and step past, and
 * it belongs with the openings you pass through rather than with the gaps in a wall.
 */
const COLOUR_KINDS = { 4: 'door', 5: 'door', 6: 'door' };

const colourKindOf = (preset) => COLOUR_KINDS[preset] ?? kindOf(preset);

/**
 * The pieces to draw a preset as: its own, where it has one, and its kind's otherwise.
 *
 * The specific ones are drawings rather than data, which is why they are here and not in
 * `wallPresetKinds.json`: what a divider *is* is a blank, and that is what the table
 * says and what the picker groups it under. This is only how it is shown.
 */
const shapeOf = (model, x, y, axis, preset) => {
    // A divider end is asked where its post actually lands rather than told. Two runs
    // with identical presets can render opposite ways round, so the id alone cannot say.
    const atLowEnd = dividerPostAtLowEnd(model, x, y, axis, preset);
    if (atLowEnd !== null) return DIVIDER_END_SHAPES[atLowEnd ? 'low' : 'high'];

    return PRESET_SHAPES[preset] ?? WALL_SHAPES[kindOf(preset)] ?? WALL_SHAPES.wall;
};


/* -------------------------------------------------------------------------- */
/* Tile gizmos                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Write each tile's label, lying flat on its square and turned the way its stairwell
 * faces.
 *
 * Flat and turned rather than flat and square to the view, because the turn is the point:
 * a stairwell records a rotation and there is nothing else in the scene that shows what
 * one looks like. The degrees are written out as well -- see tileParts -- so a label
 * turned a quarter is still read as "90°" rather than counted.
 *
 * **A label is upright to whoever the stairs open onto.** Its top points away from the
 * opening, so reading it the right way up means standing where you would stand to walk
 * in: in the default view, where the camera is off the y = 0 edge, the label you can read
 * is the one whose stairs you could climb. That is the direction said in the shape of the
 * thing rather than in its degrees, which is what the turn is for -- and it is worth being
 * plain that the top of the words is the *back* of the stairwell, because pointing it the
 * other way is the obvious reading and is what this did until it was checked against the
 * game.
 *
 * Which way a rotation opens comes off the game's own floors rather than off the
 * arithmetic. Of the 116 stairwells in refs/floors/blueprints, every one at 90 has its
 * wall-free side on the floor's +x and every one at 270 on its -x, and the only tiles
 * carrying a door on their own edge are at 180 with it on -y. So 0 opens on the floor's
 * +y, each quarter turns that clockwise, and the words face the other way.
 *
 * The orientation, in three steps. A Text reads along its own +x, stands up its +y and
 * faces its +z, and for a stairwell at 0 the composed rotation lands those on:
 *
 *   +x -> scene +x     the reading direction, which is right to left in the default view
 *   +y -> scene -z     the top of the glyphs, pointing at the camera
 *   +z -> scene +y     face up, so it is the floor the label is written on
 *
 * -- a label read from the far side, because a stairwell at 0 opens away from the front.
 * Each quarter of the rotation turns the first two a quarter with it, and the third stays
 * put: the turn goes on the z of the Euler, which the XYZ order applies first and which is
 * therefore a spin in the label's own plane, the horizontal one once the other two are
 * done.
 *
 * It is negated there because positions in this scene are mirrored -- see mirrorX -- and
 * reflecting one axis reverses the sense of every rotation about the vertical. The floor's
 * +y is the scene's +z but the floor's +x is the scene's *-x*, so a quarter turn in the
 * floor's frame is a quarter turn the other way in the scene's.
 *
 * A tile with an entrance and no stairwell is not turned at all, and so is read from the
 * front like everything else on the screen. Its `stairwellRotation` is whatever the file
 * happens to have left there, and turning an entrance by a stairwell it does not have
 * would draw a direction out of a number that means nothing.
 */
function paintTileLabels(labels, model, onSync) {
    const shown = new Array(TILE_GRID * TILE_GRID).fill(null);
    for (const marker of tileMarkers(model)) shown[marker.y * TILE_GRID + marker.x] = marker;

    for (let index = 0; index < labels.children.length; index++) {
        const label = labels.children[index];
        const marker = shown[index];
        const text = marker?.label ?? '';
        const turn = marker?.stairwell ? (marker.rotation ?? 0) : 0;

        // The order is spelled out rather than left to three's default, because which
        // rotation is applied first is the whole of why the turn goes on the z.
        label.rotation.set(-Math.PI / 2, 0, -turn * DEGREE, 'XYZ');

        // Assigning the same string is not a change: troika's setters compare before
        // marking a label for re-layout, and this runs on every stroke of every brush.
        label.text = text;
        label.visible = text !== '';

        // Laying out text is asynchronous -- a font to fetch and an atlas to build --
        // so the frame this was called for is drawn without it and the callback asks
        // for another once the glyphs exist. `sync` returns without calling back when
        // nothing has changed, so a redraw is only ever asked for by a real change.
        //
        // Empty labels are never synced. Every one of the 49 starts dirty, so syncing
        // them all would set 40-odd fonts building for text that is not drawn.
        if (text) label.sync(onSync);
    }
}

/**
 * What each tile carries: an entrance, a stairwell, whether it is the mirrored one, which
 * way it faces, and what to write on it.
 *
 * Only the tiles carrying something are listed. A floor has 49 and the base game's use a
 * handful, so this is the difference between a label on each of the interesting ones and
 * "Nothing" written forty times over a floor someone is trying to read.
 *
 * The wording is tileParts', which is also what the status column and the hover label
 * say, so the three cannot describe the same tile differently. Joined with newlines
 * rather than the column's separator: a label is written on a square 3 cells across, and
 * a tile carrying a stairwell and an entrance has room for both only a line at a time.
 *
 * Kept exactly as tileParts hands them over, empty phrases included. This is the caller
 * those blanks are for: a stairwell says three things, not all of which are always true,
 * and writing the empty ones as empty rows is what keeps "Elevator" on the same line of
 * every tile that has one.
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
                stairwell: tile.isStairwell ? (tile.isInverted ? 'inverted' : 'stairs') : null,
                rotation: tile.stairwellRotation,
                label: tileParts(tile, model.stairwellElevators).join('\n'),
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
