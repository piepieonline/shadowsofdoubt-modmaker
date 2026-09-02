/**
 * The model of a building, the five textures on it, and the window data the game lights.
 *
 * A floor blueprint says what is inside a building. Nothing in it says what the building
 * *looks like* from the street -- that is a mesh, a material and a hand-painted window
 * map, authored in Unity and shipped in an asset bundle. A mod building that copies from
 * a base game one borrows all three, which is why generating a mesh is optional and why
 * the flow works without this file at all. A building of its own has nothing to draw
 * until this runs.
 *
 * So this reads the blueprints back and derives the outside from the inside:
 *
 *   footprints  which squares of each floor are enclosed, and which of their walls are
 *               windows -- one footprint per storey, unioned across that storey's layouts
 *   mesh        a wall quad wherever an enclosed square has a neighbour that is not, and
 *               a cap wherever a square appears or disappears between one storey and the
 *               next -- bar the underside of the lowest storey, which faces the ground
 *   textures    1024 x 512, flat fills with a rectangle per window: what it looks like,
 *               what glows when a light is on, what glows when none is, and the packed
 *               material mask
 *   sortedWindows  four lists per floor, one block per window, in the order the game
 *               enumerates its walls -- because that order is the only thing tying a
 *               block to the window it lights
 *
 * Ported from `BuildingMeshGenerator.cs` and `BuildingExporter.cs`. Roughly a third of
 * the reference is Unity asset plumbing -- mesh assets, materials, prefabs, a scene
 * preview, importer settings -- which a browser writing a mod folder does not need. What
 * is left is arithmetic, and it is kept as arithmetic: nothing here touches the DOM, the
 * scene or the file system except `writeGeneratedBuilding` at the bottom.
 *
 * **The known limitations of this port are the reference's**, written up in its
 * `BuildingWindowData.md` and repeated in this flow's README. They are carried over
 * rather than fixed, because every one of them needs something the blueprint does not
 * say -- a room's `IsOutside()`, a `DoorPairPreset`'s `sectionClass` -- and guessing
 * would produce output that disagrees with the game in a way nothing here could detect.
 *
 * One of them is not carried over, because it does not reproduce: the reference's
 * limitation 5 says the mesh comes out 180 degrees about Y from the game's convention,
 * and it does not. Generated `localMeshPosition` values agree with the base game's in
 * sign, and to within about a metre, on all four sides of every preset checked. The unit
 * suite asserts it.
 */
import { getFolder, getFile, writeFile } from '../../../core/fs.js';
import { OUTDOOR_LAYOUT_CONFIGURATIONS } from './floorModel.js';
import { blueprintName } from './buildingLibrary.js';
import { encodePng } from './pngWriter.js';

/**
 * Which wall presets are windows.
 *
 * A hand-maintained table, and it stays one. `sectionClass` on the `DoorPairPreset` asset
 * was expected to replace it, and a dump of the assets shows it cannot: it groups
 * `WindowLargeRectangle` with `NothingWall` and a wooden fence, describing where the
 * opening sits in the wall panel's mesh rather than whether the section is glazed.
 *
 * Ids 1, 13, 26 and 27 are unconfirmed, and none of them appears in a base game
 * blueprint, so no test here reaches one. A single wrong entry shifts every block after
 * it on that side of that floor -- see limitation 4. Imported directly rather than through
 * loadRefs.js
 * because nothing in this flow is reached from main.js, so it costs nothing at page
 * load; buildingLibrary.js imports soDefaults.json the same way.
 */
import wallPresetKinds from '../../../refs/authored/wallPresetKinds.json' with { type: 'json' };


/* -------------------------------------------------------------------------- */
/* The game's dimensions                                                       */
/* -------------------------------------------------------------------------- */

/** A node is 1.8 m square, a storey is 5.4 m tall, and a lot is 27 m across. */
const NODE_SIZE = 1.8;
const FLOOR_HEIGHT = 5.4;
const LOT_SIZE = 27;

/**
 * How much wider than the lot it measures the shell is drawn.
 *
 * A model built exactly on the node grid sits a shade inside the walls of the floors it
 * was derived from, and what a generated building has needed on top of it is a 1.008
 * scale applied in Unity -- pushing each side out by about 11 cm at the edge of the lot.
 * Baked in here instead, so what the OBJ says is what the building is rather than
 * something that is only right once a transform has been put over it.
 *
 * Across only. Every vertical measurement in the game is the same 5.4 m a storey --
 * window rows, floor heights, where furniture stands -- and stretching Y by 0.8% would
 * put the model further out of step with all of them with each storey it gained.
 */
const WALL_OUTSET = 1.008;

/**
 * How far the whole shell is lifted off the ground.
 *
 * The distance the outset moves the edge of the lot, applied upwards -- so the shell is
 * off the baseline by the same amount it is proud of the grid on all four sides. Derived
 * from `WALL_OUTSET` rather than written as 0.108 so that changing one changes both;
 * they are the same measurement pointed in different directions.
 *
 * The top rises by it as well, so the shell is that much taller than the storeys it
 * models rather than merely shifted up them. Spread over the whole height rather than
 * added to the top storey: 0.108 m across a five storey building is a tenth of a percent
 * on each, where putting it all in the last one would be two percent on that one alone
 * and show as one window row taller than the rest.
 */
const BASE_LIFT = (LOT_SIZE / 2) * (WALL_OUTSET - 1);

/**
 * How far in from the edge the rim round an open top reaches.
 *
 * 10 cm of masonry in the finished model, so it is measured against `WALL_OUTSET`: the
 * strip is laid out on the grid and pushed out with everything else, and a tenth of a
 * metre on the grid would come out a hair over one on the building.
 */
const LIP_DEPTH = 0.1;
const LIP_INSET = LIP_DEPTH / WALL_OUTSET;

/** The 15 paintable nodes of the 21, and the coordinate the lot is centred on. */
const GRID_CENTRE = 10;
const FIRST_NODE = 3;
const LAST_NODE = 17;
const LOT_NODES = 15;

/**
 * How far the mesh sits above the prefab's root.
 *
 * The generated prefab puts the mesh in a child at this height, and `localMeshPosition`
 * in the window data is measured from the root, so the two have to agree. Exported
 * because the prefab definition is written from it as well.
 */
export const MESH_CHILD_LOCAL_Y = 5.175;

const TEXTURE_WIDTH = 1024;
const TEXTURE_HEIGHT = 512;

/** How much of a node's wall a window takes, and where it sits within its storey. */
const WINDOW_WIDTH_RATIO = 0.55;
const WINDOW_BOTTOM_RATIO = 0.153;
const WINDOW_TOP_RATIO = 0.626;

/**
 * The four sides take the left three quarters of the texture and the roof takes a square
 * out of the right hand quarter, which is how the game's own building textures are laid
 * out. The gutter is two pixels of wall colour at each end of a band, so that filtering
 * at the seam samples masonry rather than the next side along.
 */
const BAND_WIDTH = 0.1875;
const BAND_GUTTER = 2 / 512;
const ROOF_BLOCK_U = 0.75;
const ROOF_BLOCK_U_WIDTH = 0.25;
const ROOF_BLOCK_V_HEIGHT = 0.5;

/**
 * The four sides, in the order the game's window maps put them across U.
 *
 * `NewFloor.AssignWindowUVData` names them from the street's point of view, so the
 * blueprint's -Y wall is the *front*. Band index and list name are not the same thing
 * and both are needed, so both are spelled out.
 */
const LEFT_BAND = 0;
const BACK_BAND = 1;
const FRONT_BAND = 2;
const RIGHT_BAND = 3;

/** Which way each band faces in mesh space: left, back, forward, right. */
const BAND_OUTWARDS = [
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 0, z: 1 },
    { x: 1, y: 0, z: 0 },
];

/**
 * The neighbouring cell across each band, in blueprint space.
 *
 * Opposite in sign to `BAND_OUTWARDS`, because `cellCentre` maps an increasing cell
 * coordinate to a decreasing world one. The pairing of the two arrays is what makes each
 * band point out of the wall it maps, and neither can be changed without the other.
 */
const BAND_NEIGHBOURS = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
    { x: -1, y: 0 },
];

const UP = { x: 0, y: 1, z: 0 };
const DOWN = { x: 0, y: -1, z: 0 };

/**
 * `NewNode.FloorTileType` by index, which is how a blueprint stores it.
 *
 * A square is inside the building's shell if it has a ceiling over it or is explicitly
 * indoors, and open air if it has a floor and nothing above. The game asks the *room*
 * whether it is outside; this asks the geometry, which is limitation 2.
 *
 * The order is `soEnums.json`'s `FloorTileType`, which starts at `none` -- confirmed
 * against the game. Not its `f_t` key, which holds the same five values sorted
 * alphabetically and so starts at `CeilingOnly`: reading these indices out of that one
 * turns every empty square into a roofed one. See `refs/GENERATOR.md` §9a.
 */
const FLOOR_ONLY = 2;
const ENCLOSED_TILE_TYPES = new Set([
    1, // floorAndCeiling
    3, // CeilingOnly
    4, // noneButIndoors
]);


/* -------------------------------------------------------------------------- */
/* The colours in the five textures                                            */
/* -------------------------------------------------------------------------- */

const BASE_COLOUR = [0x9D, 0x97, 0x92, 0xFF];
const WINDOW_COLOUR = [0x3B, 0x31, 0x42, 0xFF];
const BLACK = [0x00, 0x00, 0x00, 0xFF];
const EMISSIVE_WINDOW_COLOUR = [0xFF, 0xFF, 0xFF, 0xFF];

/** Metallic in R, ambient occlusion in G, detail in B, smoothness in A. */
const MASONRY_MASK = [0x00, 0xFF, 0x80, 0x20];
const WINDOW_MASK = [0x00, 0xBF, 0x80, 0xD9];
const FLAT_NORMAL = [0x80, 0x80, 0xFF, 0xFF];


/* -------------------------------------------------------------------------- */
/* Cells                                                                       */
/* -------------------------------------------------------------------------- */

const cellKey = (x, y) => `${x},${y}`;
const windowKey = (x, y, band) => `${x},${y},${band}`;

const parseCell = (key) => {
    const [x, y] = key.split(',');
    return { x: Number(x), y: Number(y) };
};

/**
 * Cells in the order the reference walks them -- x ascending, then y.
 *
 * A `HashSet` has no order in C# either, so this is not decoration: it is what makes two
 * runs over the same blueprint produce the same vertex list, and therefore the same OBJ
 * and the same `horizonal` indices.
 */
const sortedCells = (cells) => [...cells]
    .map(parseCell)
    .sort((a, b) => a.x - b.x || a.y - b.y);

const inLot = (x, y) => x >= FIRST_NODE && x <= LAST_NODE && y >= FIRST_NODE && y <= LAST_NODE;


/* -------------------------------------------------------------------------- */
/* Vectors                                                                     */
/* -------------------------------------------------------------------------- */

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (v, k) => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

const cross = (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
});

/**
 * Where a cell's centre is in mesh space.
 *
 * The subtraction is what puts the grid into the game's lot space, which runs the other
 * way: cell (3, 3) is at +12.6 and cell (17, 17) at -12.6. Every UV, every texture
 * column and every mesh position in the window data derives from this one function, so
 * the model is consistent with itself -- and, measured against the base game's own
 * window data, with the game. Negating it would need `BAND_OUTWARDS` negated with it,
 * which mirrors the U direction within every band, and it is what the reference tool's
 * limitation 5 proposes. Do not: it is what would put the model 180 degrees out.
 */
const cellCentre = (cell) => ({
    x: (GRID_CENTRE - cell.x) * NODE_SIZE,
    y: 0,
    z: (GRID_CENTRE - cell.y) * NODE_SIZE,
});

/**
 * Grid space to shell space: out on all four sides, up off the ground, and that much
 * taller again.
 *
 * Applied to positions and to nothing else. A UV is a fraction of a side and a texture
 * column is one of fifteen, and both are measured off the grid the windows were counted
 * on -- so taking either from a point that has already been pushed out would slide the
 * whole texture 0.8% towards the corners of each side, and the painted rectangles with
 * it. The vertical UV has the same problem in the other direction: measured after the
 * lift, the bottom of the model would no longer be the bottom of the texture. The
 * geometry moves; what is painted on it stays where the blueprint put it.
 *
 * The vertical is affine, which is what lets the UVs stay on the grid: the top of the
 * shell and the top of the texture are still the same place, and every seam between them
 * still falls at the same fraction of the way up.
 *
 * @param gridHeight the storeys being modelled, in metres -- every storey, not only the
 *                   ones with a window row, since the rooftop is part of the shell
 */
const shellSpace = (gridHeight) => {
    const stretch = gridHeight > 0 ? 1 + BASE_LIFT / gridHeight : 1;

    return (point) => ({
        x: point.x * WALL_OUTSET,
        y: point.y * stretch + BASE_LIFT,
        z: point.z * WALL_OUTSET,
    });
};

/**
 * `Mathf.RoundToInt`, which rounds a half to the nearest *even* whole number.
 *
 * Not what `Math.round` does -- it rounds a half up -- and the difference is one pixel on
 * about half the window rectangles at a texture width of 1024. That pixel is written into
 * `originPixel` and read back by `NewRoom.UpdateEmission` when it blits a lit window, so
 * matching the game's rounding is what keeps a generated rectangle in the same place as
 * one the game would have measured.
 */
function roundToInt(value) {
    const below = Math.floor(value);
    const fraction = value - below;

    if (fraction > 0.5) return below + 1;
    if (fraction < 0.5) return below;

    return below % 2 === 0 ? below : below + 1;
}


/* -------------------------------------------------------------------------- */
/* Footprints                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One footprint per storey, from the ground up.
 *
 * A floor setting says "the next N floors look like this", so a setting with
 * `floorsWithThisSetting: 4` contributes the same footprint four times -- the same
 * object four times, since nothing modifies one after it is read.
 *
 * `basementLayouts` are not read. A basement is below the street and has no exterior to
 * model, and the game's own `floorCount` counts window rows above ground.
 *
 * `resolveFloor` is handed a blueprint name and returns its data or null. The caller
 * owns that, because where a blueprint comes from -- the mod, or the copy of the base
 * game's shipped with the app -- is buildingLibrary.js's question and not this file's.
 */
export async function readFootprints(preset, resolveFloor) {
    const floors = [];
    const missing = [];

    for (const layout of preset?.floorLayouts ?? []) {
        const footprint = await readLayout(layout, resolveFloor, missing);

        for (let i = 0; i < Math.max(1, layout?.floorsWithThisSetting ?? 1); i++) {
            floors.push(footprint);
        }
    }

    return { floors, missing: [...new Set(missing)] };
}

/**
 * One storey, unioned across every layout the game may pick for it.
 *
 * That union is limitation 1 and it cannot be fixed here: `sortedWindows` is indexed per
 * floor and not per layout, so the game itself requires every layout of a storey to have
 * the same exterior windows. A window present in one and not another shifts every
 * `horizonal` after it and the wrong rectangles light up.
 */
async function readLayout(layout, resolveFloor, missing) {
    const blueprints = blueprintsOf(layout);

    const footprint = {
        blueprint: blueprints[0] ?? '(empty)',
        enclosed: new Set(),
        openAir: new Set(),
        windows: new Set(),
        isRooftop: false,
    };

    for (const blueprint of blueprints) {
        const data = await resolveFloor(blueprint);

        if (!data) {
            missing.push(blueprint);
            continue;
        }

        accumulate(footprint, data);
    }

    for (const cell of footprint.enclosed) footprint.openAir.delete(cell);

    // A storey that is mostly open air is a rooftop rather than a floor of the building.
    // Trimmed off the top later, so the model does not carry a row of windows above the
    // last real floor.
    footprint.isRooftop = footprint.enclosed.size === 0
        || footprint.openAir.size > footprint.enclosed.size;

    fillEnclosedVoids(footprint.enclosed);

    return footprint;
}

/**
 * Add one blueprint's squares and window walls to a storey's footprint.
 *
 * Only the first layout variation of each address is read. The game picks one of an
 * address's variations at random per floor, so this has the same shape of problem as
 * unioning a storey's layouts -- and the same answer, since a variation cannot have
 * window data of its own either.
 */
function accumulate(footprint, data) {
    for (const address of data?.a_d ?? []) {
        if (!address.vs?.length) continue;
        if (OUTDOOR_LAYOUT_CONFIGURATIONS.has(address.p_n)) continue;

        for (const room of address.vs[0]?.r_d ?? []) {
            for (const node of room.n_d ?? []) {
                const { x, y } = node.f_c ?? {};
                if (!inLot(x, y)) continue;

                if (ENCLOSED_TILE_TYPES.has(node.f_t)) footprint.enclosed.add(cellKey(x, y));
                else if (node.f_t === FLOOR_ONLY) footprint.openAir.add(cellKey(x, y));

                for (const wall of node.w_d ?? []) {
                    const band = wallBand(wall.w_o);
                    if (band >= 0 && isWindow(wall.p_n)) {
                        footprint.windows.add(windowKey(x, y, band));
                    }
                }
            }
        }
    }
}

/**
 * The floors one storey may be built from, as names.
 *
 * A preset points at a floor the mod holds as `FLOOR:Floors/<name>` and at a base game
 * one by its bare name, so what is stored is not always what a floor is called. The
 * resolver is handed the name either way -- and the mod's copy first, so a building
 * naming a base game floor the mod has since taken over is modelled from the copy the
 * game will actually load.
 */
const blueprintsOf = (layout) => [
    ...(layout?.blueprints ?? []),
    ...(layout?.controlRoomVariants ?? []),
].filter(Boolean).map(blueprintName);

/** Which side of its node a wall sits on, or -1 for an offset pointing nowhere. */
function wallBand(offset) {
    for (let band = 0; band < BAND_NEIGHBOURS.length; band++) {
        const neighbour = BAND_NEIGHBOURS[band];
        if ((offset?.x ?? 0) * neighbour.x + (offset?.y ?? 0) * neighbour.y > 0) return band;
    }

    return -1;
}

const isWindow = (preset) => wallPresetKinds[preset] === 'window';

/**
 * Fill in an atrium, a lightwell or any other hole with no way out to the street.
 *
 * A courtyard in the middle of a floor is still inside the building's shell, so punching
 * walls through the model around it would show the inside of the building from outside
 * it. Anything the flood fill cannot reach from the edge of the lot is treated as
 * enclosed.
 *
 * This deliberately widens limitation 2: a roofed courtyard whose rooms the game flags
 * as outside keeps its windows in game and loses them here.
 */
export function fillEnclosedVoids(cells) {
    const reachable = new Set();
    const pending = [];

    const seed = (x, y) => {
        if (!inLot(x, y)) return;

        const key = cellKey(x, y);
        if (cells.has(key) || reachable.has(key)) return;

        reachable.add(key);
        pending.push({ x, y });
    };

    for (let edge = FIRST_NODE; edge <= LAST_NODE; edge++) {
        seed(edge, FIRST_NODE);
        seed(edge, LAST_NODE);
        seed(FIRST_NODE, edge);
        seed(LAST_NODE, edge);
    }

    while (pending.length) {
        const cell = pending.shift();
        for (const step of BAND_NEIGHBOURS) seed(cell.x + step.x, cell.y + step.y);
    }

    for (let x = FIRST_NODE; x <= LAST_NODE; x++) {
        for (let y = FIRST_NODE; y <= LAST_NODE; y++) {
            if (!reachable.has(cellKey(x, y))) cells.add(cellKey(x, y));
        }
    }

    return cells;
}

/**
 * The storeys that get a row of windows: everything but the ground floor and the roof.
 *
 * The ground floor is drawn by the street frontage the game puts in front of it rather
 * than by the building's own texture, and an open rooftop has no facade at all. Both
 * would otherwise take a row of the texture and shift every floor above them.
 *
 * The rooftops are returned rather than discarded. They take no row of the texture, and
 * they are still part of the building's silhouette -- `CityBank_Floor2` is three rows of
 * penthouse across the top of the lot with an open deck beside it, and dropping it left
 * the building a storey short from the street. `buildMesh` takes them as shell.
 *
 * @returns the body storeys, and the rooftop storeys trimmed off the top
 */
export function trimToWindowFloors(floors) {
    const body = floors.slice(1);
    const rooftops = [];

    while (body.length && body[body.length - 1].isRooftop) {
        rooftops.unshift(body.pop());
    }

    return { body, rooftops };
}


/* -------------------------------------------------------------------------- */
/* The mesh                                                                    */
/* -------------------------------------------------------------------------- */

const NO_CELLS = new Set();

/**
 * A wall wherever the building ends, and a cap wherever it changes shape.
 *
 * Two passes. The first walks every enclosed square of every storey and puts a quad on
 * each of its four sides that faces a square the storey does not have -- which is the
 * outside of the building, wherever that is. The second walks the seams *between*
 * storeys and caps a square that stops (a roof) or starts (a soffit under an overhang).
 *
 * Vertical UVs run over the body storeys rather than per storey, so window row 3 of 8
 * lands in the fourth eighth of the texture whatever the building's height.
 *
 * @param roof  false for a building something else is stacked on top of, which leaves off
 *              every upward-facing surface -- the top and the terrace of any storey that
 *              steps in -- and puts a lip round the edge in their place. What is above
 *              them is the floor of somebody else's mesh, and two surfaces in one place
 *              is what shimmers as the camera moves.
 * @param above the rooftop storeys, stacked on the body and built as shell only: see
 *              `onOuterShell`. They take no row of the texture, so the vertical UV still
 *              runs over `body` alone and their walls are mapped to flat masonry.
 */
export function buildMesh(body, { roof = true, above = [] } = {}) {
    const storeys = [...body, ...above];
    const height = body.length * FLOOR_HEIGHT;
    const buffers = {
        vertices: [], normals: [], uvs: [], triangles: [],
        place: shellSpace(storeys.length * FLOOR_HEIGHT),
    };

    for (let floor = 0; floor < storeys.length; floor++) {
        const cells = storeys[floor].enclosed;
        const under = floor > 0 ? storeys[floor - 1].enclosed : NO_CELLS;
        const over = floor + 1 < storeys.length ? storeys[floor + 1].enclosed : NO_CELLS;
        const shellOnly = floor >= body.length;

        for (const cell of sortedCells(cells)) {
            for (let band = 0; band < BAND_OUTWARDS.length; band++) {
                const step = BAND_NEIGHBOURS[band];
                const across = cellKey(cell.x + step.x, cell.y + step.y);

                if (cells.has(across)) continue;
                if (shellOnly && !onOuterShell(across, under)) continue;

                addWall(buffers, cell, band,
                    floor * FLOOR_HEIGHT, (floor + 1) * FLOOR_HEIGHT, height, shellOnly);

                // Nothing over this square, so the top of the wall is open sky. With no
                // roof to close it there is a rim instead -- see addLip. A square that is
                // enclosed above is either walled again or under an overhang, and either
                // way there is no edge to show.
                if (!roof && !over.has(cellKey(cell.x, cell.y))) {
                    addLip(buffers, cell, band, (floor + 1) * FLOOR_HEIGHT, cells);
                }
            }
        }
    }

    for (let level = 0; level <= storeys.length; level++) {
        const below = level > 0 ? storeys[level - 1].enclosed : NO_CELLS;
        const over = level < storeys.length ? storeys[level].enclosed : NO_CELLS;

        if (roof) {
            for (const cell of sortedCells(below)) {
                if (!over.has(cellKey(cell.x, cell.y))) {
                    addCap(buffers, cell, level * FLOOR_HEIGHT, UP);
                }
            }
        }

        // The underside of the lowest storey is the one downward face nothing can see:
        // it is flat against the ground the building stands on. Left off, so the model
        // is the shell of the building rather than a closed box with a floor in it.
        // Every other level's is a soffit under an overhanging storey, which is seen
        // from the street below it and is built.
        if (level === 0) continue;

        for (const cell of sortedCells(over)) {
            if (!below.has(cellKey(cell.x, cell.y))) {
                addCap(buffers, cell, level * FLOOR_HEIGHT, DOWN);
            }
        }
    }

    return buffers;
}

/**
 * Whether a rooftop storey's wall is part of the building's outer shell.
 *
 * A trimmed rooftop is two different things at once. Where its enclosed block reaches the
 * edge of the building it is the building -- `CityBank_Floor2` runs penthouse right across
 * the north of the lot, and without those walls the model stops a storey short of what the
 * street can see. Where the same block faces its own roof deck it is a structure standing
 * *on* the building, interior to the mass below it and not part of the silhouette; those
 * walls are left off, along with the deck they look out over.
 *
 * The test is what the wall stands over: a square the storey below encloses is roof, and
 * anything else is open air past the edge of the building.
 *
 * Only rooftops are read this way. A body storey that steps in is a setback and its walls
 * face the street over the roof below them -- which is why `Eden_Rooftop` is trimmed by
 * the majority rule in `readLayout` and the storeys under it are not.
 */
const onOuterShell = (across, below) => !below.has(across);

/**
 * One storey of one square's outside wall.
 *
 * A shell-only wall takes its UV from the roof block instead of its band. The four bands
 * are the window rows and a rooftop storey has none, so mapping it there would print
 * somebody else's lit windows onto a parapet; the roof block is flat masonry. Its own
 * span is used rather than a single point, because a quad whose UVs collapse to a line
 * has no area for a tangent to be derived from.
 */
function addWall(buffers, cell, band, y0, y1, height, shellOnly = false) {
    const outward = BAND_OUTWARDS[band];
    const tangent = cross(outward, UP);
    const edge = add(cellCentre(cell), scale(outward, NODE_SIZE / 2));
    const half = scale(tangent, NODE_SIZE / 2);

    const at = (sign, y) => add(add(edge, scale(half, sign)), scale(UP, y));

    const uv = shellOnly
        ? (vertex) => ({
            u: ROOF_BLOCK_U + alongWall(vertex, tangent) * ROOF_BLOCK_U_WIDTH,
            v: (vertex.y / y1) * ROOF_BLOCK_V_HEIGHT,
        })
        : (vertex) => ({ u: bandU(vertex, band, tangent), v: vertex.y / height });

    addQuad(buffers, at(-1, y0), at(-1, y1), at(1, y1), at(1, y0), outward, uv);
}

/** The top or the underside of one square, mapped into the texture's roof block. */
function addCap(buffers, cell, y, normal) {
    const centre = add(cellCentre(cell), scale(UP, y));
    const half = NODE_SIZE / 2;

    const at = (dx, dz) => ({ x: centre.x + dx * half, y: centre.y, z: centre.z + dz * half });

    addQuad(buffers, at(-1, -1), at(-1, 1), at(1, 1), at(1, -1), normal, roofUv);
}

/**
 * The rim along the top of a wall that nothing stands on.
 *
 * What is left of a roof when the roof is off: a hand's width of masonry round the edge,
 * so the building has a visible top rather than a wall that stops in mid air. The deck
 * inside it is not drawn, because whatever is stacked on this building draws it.
 *
 * The strip is shortened by its own depth at one end where the square beyond it is not
 * enclosed -- the outside of a corner, where this wall and the perpendicular one both
 * reach the same 10 cm square. Coplanar quads over the same ground are what z-fights, and
 * shortening the same end of every wall is what makes exactly one of the two own it.
 * Which end that is follows from the tangent, so it is derived rather than tabulated.
 */
function addLip(buffers, cell, band, y, cells) {
    const outward = BAND_OUTWARDS[band];
    const tangent = cross(outward, UP);
    const edge = add(add(cellCentre(cell), scale(outward, NODE_SIZE / 2)), scale(UP, y));

    // `cellCentre` maps an increasing cell coordinate to a decreasing world one, so the
    // square along +tangent is the one *back* along both axes.
    const along = { x: cell.x - tangent.x, y: cell.y - tangent.z };
    const far = NODE_SIZE / 2 - (cells.has(cellKey(along.x, along.y)) ? 0 : LIP_INSET);

    const at = (offset, depth) =>
        add(add(edge, scale(tangent, offset)), scale(outward, -depth));

    addQuad(buffers,
        at(-NODE_SIZE / 2, 0), at(-NODE_SIZE / 2, LIP_INSET),
        at(far, LIP_INSET), at(far, 0),
        UP, roofUv);
}

const roofUv = (position) => ({
    u: ROOF_BLOCK_U + (position.x + LOT_SIZE / 2) / LOT_SIZE * ROOF_BLOCK_U_WIDTH,
    v: (position.z + LOT_SIZE / 2) / LOT_SIZE * ROOF_BLOCK_V_HEIGHT,
});

/** How far across the lot a point is along a wall's own direction, from 0 to 1. */
const alongWall = (position, tangent) => Math.min(1, Math.max(0,
    (dot(position, tangent) + LOT_SIZE / 2) / LOT_SIZE));

/** How far along its band a point is, inside the two-pixel gutter at each end. */
function bandU(position, band, tangent) {
    return band * BAND_WIDTH + BAND_GUTTER
        + alongWall(position, tangent) * (BAND_WIDTH - 2 * BAND_GUTTER);
}

/**
 * Four vertices and two triangles, wound so the face points the way it says it does.
 *
 * The callers give their corners in the order that is convenient for them rather than in
 * a consistent winding, so the diagonal is swapped when the face has come out backwards.
 * A quad wound the wrong way is invisible from the side it is meant to be seen from and
 * solid from inside the building.
 *
 * The one place grid space becomes shell space, and it happens after the winding has been
 * settled and the UV taken: scaling by a positive amount cannot turn a face round, and
 * the texture is measured on the grid rather than on the shell.
 */
function addQuad(buffers, a, b, c, d, normal, uv) {
    if (dot(cross(sub(b, a), sub(c, a)), normal) < 0) [b, d] = [d, b];

    const first = buffers.vertices.length;

    for (const vertex of [a, b, c, d]) {
        buffers.vertices.push(buffers.place(vertex));
        buffers.normals.push(normal);
        buffers.uvs.push(uv(vertex));
    }

    buffers.triangles.push(first, first + 1, first + 2, first, first + 2, first + 3);
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });


/* -------------------------------------------------------------------------- */
/* Windows                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every window that is actually on the outside of the building, with the rectangle it
 * takes in the texture.
 *
 * A blueprint's window walls include the ones between two rooms of the same floor -- a
 * window into a corridor is still a window -- so a wall only counts here if the square it
 * belongs to is enclosed and the square across it is not.
 *
 * Two walls facing the same way at different depths, which a floor with a courtyard has,
 * land on the same texture column: `wallColumn` maps a square to one of 15 per side and
 * knows nothing about depth. Both light together. Untidy, and it keeps the counts aligned
 * with what the game enumerates, which is what actually matters -- see limitation 6.
 */
export function collectWindows(body) {
    const windows = [];
    const rowHeight = TEXTURE_HEIGHT / body.length;

    for (let floor = 0; floor < body.length; floor++) {
        const cells = body[floor].enclosed;

        const onFloor = [...body[floor].windows]
            .map((key) => {
                const [x, y, band] = key.split(',').map(Number);
                return { cell: { x, y }, band };
            })
            .sort((a, b) => a.cell.x - b.cell.x || a.cell.y - b.cell.y || a.band - b.band);

        for (const { cell, band } of onFloor) {
            const across = BAND_NEIGHBOURS[band];
            if (!cells.has(cellKey(cell.x, cell.y))) continue;
            if (cells.has(cellKey(cell.x + across.x, cell.y + across.y))) continue;

            windows.push({
                cell,
                band,
                floor,
                pixels: windowPixels(band, wallColumn(cell, band), floor, rowHeight),
            });
        }
    }

    return windows;
}

/** Which of a side's 15 columns a square falls in. */
function wallColumn(cell, band) {
    const tangent = cross(BAND_OUTWARDS[band], UP);
    const alongWall = (dot(cellCentre(cell), tangent) + LOT_SIZE / 2) / LOT_SIZE;

    return Math.min(LOT_NODES - 1, Math.max(0, Math.floor(alongWall * LOT_NODES)));
}

/** The rectangle a window takes: centred in its column, and low in its storey's row. */
export function windowPixels(band, column, floor, rowHeight) {
    const wallStart = (band * BAND_WIDTH + BAND_GUTTER) * TEXTURE_WIDTH;
    const cellWidth = (BAND_WIDTH - 2 * BAND_GUTTER) * TEXTURE_WIDTH / LOT_NODES;
    const margin = cellWidth * (1 - WINDOW_WIDTH_RATIO) / 2;

    const left = roundToInt(wallStart + column * cellWidth + margin);
    const right = roundToInt(wallStart + (column + 1) * cellWidth - margin);
    const bottom = roundToInt((floor + WINDOW_BOTTOM_RATIO) * rowHeight);
    const top = roundToInt((floor + WINDOW_TOP_RATIO) * rowHeight);

    return { x: left, y: bottom, width: right - left, height: top - bottom };
}


/* -------------------------------------------------------------------------- */
/* Textures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The five images, as RGBA buffers with their first row at the *bottom*.
 *
 * That is the way a Unity `Texture2D` is held and the way the rectangles above are
 * measured -- window row 0 is the ground floor and sits at the bottom of the texture --
 * so it is the way they stay. `encodePng` flips on the way out.
 *
 * | | |
 * |---|---|
 * | diffuse | what the building looks like: masonry, with a dark rectangle per window |
 * | emissive | black, with a white rectangle exactly over each of those |
 * | black | black, the state the instanced emission texture starts in |
 * | mask | the packed material channels, glossier and less occluded over a window |
 * | normal | flat |
 *
 * At runtime `NewRoom.UpdateEmission` blits from the emissive map into the building's own
 * emission texture when a room's lights come on, and from the black one when they go out.
 */
export function paintTextures(windows) {
    const diffuse = filled(BASE_COLOUR);
    const emissive = filled(BLACK);
    const black = filled(BLACK);
    const mask = filled(MASONRY_MASK);

    for (const window of windows) {
        fill(diffuse, window.pixels, WINDOW_COLOUR);
        fill(emissive, window.pixels, EMISSIVE_WINDOW_COLOUR);
        fill(mask, window.pixels, WINDOW_MASK);
    }

    return { diffuse, emissive, black, mask, normal: filled(FLAT_NORMAL) };
}

function filled(colour) {
    const pixels = new Uint8Array(TEXTURE_WIDTH * TEXTURE_HEIGHT * 4);

    for (let at = 0; at < pixels.length; at += 4) pixels.set(colour, at);

    return pixels;
}

function fill(pixels, rect, colour) {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
        for (let x = rect.x; x < rect.x + rect.width; x++) {
            pixels.set(colour, (y * TEXTURE_WIDTH + x) * 4);
        }
    }
}


/* -------------------------------------------------------------------------- */
/* Window data                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `sortedWindows`: four lists per floor, one block per window.
 *
 * The game's own version of this comes out of `BuildingPreset.GenerateWindowData`, which
 * flood-fills a hand-painted window map to find the rectangles and raycasts the capture
 * mesh to place them. Both steps are recovering something we already have, so the blocks
 * are written directly.
 *
 * What has to be right is the *order*. `NewFloor.AssignWindowUVData` collects a floor's
 * exterior window walls, buckets them by which way they face, sorts each bucket, and then
 * matches a wall to its block by `horizonal` -- the index in the list -- and nothing else.
 * One extra or missing block and every window after it on that side lights the wrong
 * rectangle.
 *
 * | List | Wall faces | Band | Sorted by | `side` |
 * |---|---|---|---|---|
 * | front | -Y | 2 | `cell.x` ascending | (0, 1) |
 * | back | +Y | 1 | `cell.x` descending | (0, -1) |
 * | left | +X | 0 | `cell.y` ascending | (-1, 0) |
 * | right | -X | 3 | `cell.y` descending | (1, 0) |
 *
 * `side` reads inverted against the facings because the game's meshes are 180 degrees
 * from the blueprint grid and this one is not. It is only read by a debug overlay, so it
 * is written to match the list it sits in, the way the game's own data looks.
 *
 * A floor with no windows still gets an entry with four empty lists, so that
 * `sortedWindows[floor - 1]` means the same thing on every building.
 *
 * @param place the same grid-to-shell transform the mesh was built with. It defaults to
 *              the one a building with no rooftop gets, because `height` is then the whole
 *              of the shell -- a building with one has to hand its own in, or the blocks
 *              describe a model a storey shorter than the one that was written.
 */
export function buildWindowData(windows, floorCount, height, place = shellSpace(height)) {
    const floors = [];

    for (let floor = 0; floor < floorCount; floor++) {
        const on = windows.filter((window) => window.floor === floor);
        const blocks = (band, order, descending, side) =>
            sideBlocks(on, band, order, descending, side, height, place);

        floors.push({
            front: blocks(FRONT_BAND, (w) => w.cell.x, false, { x: 0, y: 1 }),
            back: blocks(BACK_BAND, (w) => w.cell.x, true, { x: 0, y: -1 }),
            left: blocks(LEFT_BAND, (w) => w.cell.y, false, { x: -1, y: 0 }),
            right: blocks(RIGHT_BAND, (w) => w.cell.y, true, { x: 1, y: 0 }),
        });
    }

    return floors;
}

function sideBlocks(windows, band, order, descending, side, height, place) {
    const onSide = windows.filter((window) => window.band === band);

    // Stable, as LINQ's OrderBy is: two windows on one side of one storey at the same
    // sort coordinate keep the order collectWindows put them in.
    onSide.sort((a, b) => (descending ? order(b) - order(a) : order(a) - order(b)));

    return onSide.map((window, index) => buildBlock(window, side, index, height, place));
}

function buildBlock(window, side, horizonal, height, place) {
    const origin = { x: window.pixels.x, y: window.pixels.y };
    const size = { x: window.pixels.width, y: window.pixels.height };
    const centre = {
        x: origin.x + Math.floor(size.x * 0.5),
        y: origin.y + Math.floor(size.y * 0.5),
    };

    return {
        originPixel: origin,
        rectSize: size,
        centrePixel: centre,
        localMeshPositionLeft: meshPointAt(window, centre.x, centre.y, height, place),
        localMeshPositionRight: meshPointAt(window, centre.x + 1, centre.y, height, place),
        // 1-based, because the game's floor 0 is the ground floor this row sits above.
        floor: window.floor + 1,
        side,
        // The game's own spelling. Left as it is, because it is a field name in a file
        // the game reads.
        horizonal,
    };
}

/**
 * Where a texture pixel is on the model.
 *
 * The analytic inverse of `addWall`'s UVs, standing in for the `UvTo3D` raycast the game
 * does against the capture mesh. Offset by the prefab's mesh child height, and assuming
 * unit scale -- which is true of the prefab written here and not of the game's own, where
 * the capture mesh child is scaled and offset and that transform is baked into these
 * numbers. Only a debug overlay reads them, so this has no runtime effect; it does mean
 * they are not comparable to a base game preset's.
 *
 * Put into shell space like the vertices, and for the same reason the UVs are not: this is
 * a point *on* the shell, and a raycast against the shell would have found it where the
 * shell is. The prefab's child offset is added afterwards, because it is where the model
 * hangs rather than part of the model.
 */
function meshPointAt(window, pixelX, pixelY, height, place) {
    const outward = BAND_OUTWARDS[window.band];
    const tangent = cross(outward, UP);
    const face = add(cellCentre(window.cell), scale(outward, NODE_SIZE / 2));
    const across = (pixelX / TEXTURE_WIDTH - window.band * BAND_WIDTH - BAND_GUTTER)
        / (BAND_WIDTH - 2 * BAND_GUTTER);

    const onShell = place(add(
        add(scale(outward, dot(face, outward)),
            scale(tangent, across * LOT_SIZE - LOT_SIZE / 2)),
        { x: 0, y: pixelY / TEXTURE_HEIGHT * height, z: 0 }));

    return { ...onShell, y: onShell.y + MESH_CHILD_LOCAL_Y };
}


/* -------------------------------------------------------------------------- */
/* The files                                                                   */
/* -------------------------------------------------------------------------- */

/** Where a building's generated files go, beside its preset in the mod's folder. */
export const prefabFolder = (name) => `${name}Prefab`;

/**
 * The mesh as an OBJ.
 *
 * X is negated to swap Unity's left-handed space for OBJ's right-handed one. That
 * reverses which way round a face is wound, so the two triangles of every quad are
 * written back to front to keep them facing outwards.
 */
export function toObj(mesh, name) {
    const lines = [`o ${name}`];

    for (const vertex of mesh.vertices) lines.push(`v ${-vertex.x} ${vertex.y} ${vertex.z}`);
    for (const uv of mesh.uvs) lines.push(`vt ${uv.u} ${uv.v}`);
    for (const normal of mesh.normals) lines.push(`vn ${-normal.x} ${normal.y} ${normal.z}`);

    for (let i = 0; i < mesh.triangles.length; i += 3) {
        const a = mesh.triangles[i] + 1;
        const b = mesh.triangles[i + 1] + 1;
        const c = mesh.triangles[i + 2] + 1;
        lines.push(`f ${a}/${a}/${a} ${c}/${c}/${c} ${b}/${b}/${b}`);
    }

    return `${lines.join('\n')}\n`;
}

/**
 * The prefab the mod loader builds: one child holding the mesh and its material.
 *
 * `copyFrom` on the material is the preset's own, which is what the reference tool
 * writes. It is a `REF:BuildingPreset|…` rather than a material, which reads like a
 * mistake and is left as it is: there is no dump of the game's materials to name a real
 * one from, and inventing a reference that resolves to nothing would fail in the same
 * place with a value nobody could trace back to the tool that wrote it.
 */
export function prefabDefinition(name, copyFrom) {
    return `${JSON.stringify({
        prefabType: 'building',
        name,
        children: [{
            name: `${name}_Mesh`,
            position: [0, MESH_CHILD_LOCAL_Y, 0],
            components: [{
                type: 'MeshRenderer',
                mesh: `${name}.obj`,
                material: {
                    name,
                    copyFrom: copyFrom ?? '',
                    textures: {
                        _BaseColorMap: `${name}_diffuse.png`,
                        _NormalMap: `${name}_normal.png`,
                        _MaskMap: `${name}_mask.png`,
                    },
                },
            }],
        }],
    }, null, 2)}\n`;
}


/* -------------------------------------------------------------------------- */
/* Staleness                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The field a building carries saying which floors its mesh was built from.
 *
 * Not a field the game has. Window data is written once, from the floors the preset
 * referenced at that moment, and editing one of those floors afterwards leaves the
 * preset describing a layout that no longer exists -- silently, because nothing about a
 * stale `sortedWindows` looks wrong until a lit room lights someone else's window. This
 * turns that into something the editor can say out loud.
 *
 * The mod loader is expected to ignore a field it has no property for, which is what
 * both of the common .NET JSON readers do by default. That is an expectation rather than
 * something verified against the loader, and it is the reason this is one short string
 * rather than anything larger.
 */
export const MESH_SOURCE_FIELD = 'modMakerFloorHash';

/**
 * The field a building carries saying whether its model was built with a roof on it.
 *
 * Not a field the game has either, and it is stored for the same reason the hash is: it
 * is something the author decided about *this building* rather than about the moment they
 * pressed the button. A mesh is regenerated every time one of its floors changes, and a
 * choice held nowhere would put the roof silently back on the first time that happened.
 *
 * Written positively -- true is the ordinary building -- because a field named for the
 * exception reads backwards everywhere it is used.
 */
export const MESH_ROOF_FIELD = 'modMakerBuildRoof';

/**
 * Fields generation writes that `withoutDefaults` would otherwise drop.
 *
 * A stub says `copyFrom`, so a field left out is not "unchanged" -- it is whatever the
 * copied-from building has. `floorCount: 1` and `sortedWindows: []` are both the game's
 * defaults, so a one-storey building or one with no windows at all would silently keep
 * the original's window data. See withoutDefaults in buildingLibrary.js.
 */
export const GENERATED_FIELDS = [
    'prefab', 'emissionMapUnlit', 'emissionMapLit', 'floorCount', 'sortedWindows',
    MESH_SOURCE_FIELD, MESH_ROOF_FIELD,
];

/**
 * A fingerprint of everything the mesh was built from: the storey structure, and the
 * contents of every blueprint it names.
 *
 * `basementLayouts` are left out because nothing below the street reaches the model, so
 * editing a basement is not a reason to say the mesh has gone stale.
 *
 * FNV-1a, which is not a cryptographic hash and does not need to be. The question it
 * answers is "is this the same input as last time", against an author's own edits rather
 * than against anyone trying to produce a collision.
 */
export async function sourceFloorHash(preset, resolveFloor) {
    const parts = [];
    const seen = new Set();

    for (const layout of preset?.floorLayouts ?? []) {
        // Names rather than entries, so that a floor being pointed at one way and then
        // the other -- which is what saving a base game floor into the mod does -- is not
        // read as the building having changed shape.
        const blueprints = blueprintsOf(layout);

        parts.push(`${Math.max(1, layout?.floorsWithThisSetting ?? 1)}|${blueprints.join(',')}`);

        for (const blueprint of blueprints) {
            if (seen.has(blueprint)) continue;
            seen.add(blueprint);

            const data = await resolveFloor(blueprint);
            parts.push(data ? JSON.stringify(data) : `${blueprint}:missing`);
        }
    }

    // Written as an escape rather than as the character itself. A separator that cannot
    // appear in a part is the right one -- `JSON.stringify` escapes a null, and no
    // blueprint is named with one -- but a literal control character in the source made
    // this whole file read as binary: `grep` skips it and a diff of it says the files
    // differ without saying how. Same bytes at runtime, so every hash already written
    // still matches and no mesh is made to look stale by this.
    return fnv1a(parts.join('\u0000'));
}

function fnv1a(text) {
    let hash = 0x811C9DC5;

    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        // The FNV prime, by shift-and-add rather than by multiplication: 32-bit integer
        // multiplication overflows a double's 53 bits of mantissa and rounds.
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
        hash >>>= 0;
    }

    return hash.toString(16).padStart(8, '0');
}

/**
 * Whether a building's mesh describes floors that have since changed.
 *
 * Null when there is nothing to say: a building whose mesh was never generated has no
 * stored hash, and is not stale -- it copies its model from a base game building, or has
 * none at all, and either way regenerating is not what would fix it.
 */
export async function isMeshStale(preset, resolveFloor) {
    const stored = preset?.[MESH_SOURCE_FIELD];
    if (!stored) return null;

    return stored !== await sourceFloorHash(preset, resolveFloor);
}


/* -------------------------------------------------------------------------- */
/* Generating                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Everything a building needs to be drawn, from the floors its preset names.
 *
 * The preset is rewritten in place -- its prefab, its two emission maps, its window data
 * and the hash above -- and returned with the files that go beside it. Writing is the
 * caller's, because a preset also has to reach the mod's manifest and that is
 * buildingLibrary.js's business.
 *
 * `{ ok: false }` rather than a throw for the one thing that is an authoring problem
 * rather than a fault: a building with nothing above its ground floor has no facade to
 * model, and saying so is more useful than a stack trace.
 *
 * `roof` is the author's, and it is written onto the preset so that the next generation
 * -- which happens whenever one of the floors is edited -- does not have to be told
 * again.
 */
export async function generateBuilding(name, preset, resolve, { roof = true } = {}) {
    // Every blueprint is read twice -- once for its footprint and once for the hash --
    // and a storey's control room variant is usually the same file as another storey's.
    // Held for the length of one generation only, so an edit made after it is not hidden
    // behind a cache that outlived the thing it was speeding up.
    const resolveFloor = remembering(resolve);

    const { floors, missing } = await readFootprints(preset, resolveFloor);
    const { body, rooftops } = trimToWindowFloors(floors);

    if (body.length === 0) {
        return {
            ok: false,
            reason: `"${name}" has no floors above its ground floor to build a mesh from.`,
        };
    }

    const height = body.length * FLOOR_HEIGHT;

    // The shell is every storey; the texture is only the ones with a window row. They are
    // the same on most buildings and differ on any with a rooftop, which is why the
    // transform is built once here and handed to both.
    const place = shellSpace((body.length + rooftops.length) * FLOOR_HEIGHT);

    const mesh = buildMesh(body, { roof, above: rooftops });
    const windows = collectWindows(body);
    const textures = paintTextures(windows);

    preset.prefab = `PREFAB:${prefabFolder(name)}/${name}`;
    preset.emissionMapUnlit = `TEXTURE:${prefabFolder(name)}/${name}_black`;
    preset.emissionMapLit = `TEXTURE:${prefabFolder(name)}/${name}_emissive`;
    preset.floorCount = body.length;
    preset.sortedWindows = buildWindowData(windows, body.length, height, place);
    preset[MESH_ROOF_FIELD] = roof;
    preset[MESH_SOURCE_FIELD] = await sourceFloorHash(preset, resolveFloor);

    const folder = prefabFolder(name);
    const png = (pixels) => encodePng(TEXTURE_WIDTH, TEXTURE_HEIGHT, pixels, { bottomUp: true });

    return {
        ok: true,
        preset,
        floorCount: body.length,
        windowCount: windows.length,
        triangleCount: mesh.triangles.length / 3,
        height,
        missing,
        // The ground floor, which the street frontage in front of it draws instead.
        excluded: [floors[0].blueprint],
        // Built, but as shell rather than as a storey: no window row, and no walls facing
        // their own roof deck. Worth saying separately, because "not modelled" and "in the
        // silhouette but not lit" are different things to go looking for in game.
        shellOnly: rooftops.map((rooftop) => rooftop.blueprint),
        files: [
            { path: `${folder}/${name}.obj`, contents: toObj(mesh, name) },
            {
                path: `${folder}/${name}.sodprefab.json`,
                contents: prefabDefinition(name, preset.copyFrom),
            },
            { path: `${folder}/${name}_diffuse.png`, contents: await png(textures.diffuse) },
            { path: `${folder}/${name}_emissive.png`, contents: await png(textures.emissive) },
            { path: `${folder}/${name}_black.png`, contents: await png(textures.black) },
            { path: `${folder}/${name}_mask.png`, contents: await png(textures.mask) },
            { path: `${folder}/${name}_normal.png`, contents: await png(textures.normal) },
        ],
    };
}

/** A resolver that reads each blueprint once, however many slots name it. */
function remembering(resolveFloor) {
    const seen = new Map();

    return (blueprint) => {
        if (!seen.has(blueprint)) seen.set(blueprint, resolveFloor(blueprint));
        return seen.get(blueprint);
    };
}

/**
 * Put the generated files in the mod's content folder.
 *
 * The preset is not one of them. It goes through `writeCustomPreset`, which is also what
 * names it in the mod's manifest, and it is written *after* these -- a preset pointing at
 * a prefab that is not there yet is the failure that shows in game as a building the city
 * has no model for.
 *
 * The folder is made first because `getFile` only creates the file at the end of a path,
 * not the directories on the way to it.
 */
export async function writeGeneratedBuilding(contentFolder, name, files) {
    await getFolder(contentFolder, [prefabFolder(name)], true);

    for (const file of files) {
        const handle = await getFile(contentFolder, file.path.split('/'), true);
        await writeFile(handle, file.contents);
    }
}
