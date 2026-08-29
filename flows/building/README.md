# Building floorplans

A 3D tile grid you paint addresses, rooms, floor types, walls and tile features onto,
saved as the game's floor blueprint JSON and attached to a building preset.

Ported from [ShadowsOfDoubt-FloorEditorUnity](https://github.com/piepieonline/ShadowsOfDoubt-FloorEditorUnity),
a Unity editor tool. The data model, the painting semantics and the save logic carry
over; the Unity inspector UI does not.

## What a floor is

```
FloorSaveData
  floorName, size, defaultFloorHeight, defaultCeilingHeight
  a_d[]  AddressSaveData      p_n layoutConfiguration, e_c colour
    vs[]   AddressLayoutVariation
      r_d[]  RoomSaveData     id, l roomTypePreset
        n_d[]  NodeSaveData   f_c coord, f_h height, f_t FloorTileType, f_r forcedRoom
          w_d[]  WallSaveData w_o offset, p_n DoorPairPreset index
  t_d[]  TileSaveData         f_c, i_e entrance, m_e mainEntrance,
                              s_t stairwell, e_l inverted/elevator, s_r + e_r rotation
```

The node grid is always 21 × 21 and the tile grid 7 × 7. `size` is the lot count, not the
grid size, and is `(1, 1)` in every base game floor. The outer three nodes on each side
are the margin the game builds between one lot and the next: read and written like any
other node, never painted.

A floor is never loaded on its own. The game reaches one through a building preset that
names it in a slot, so the editor opens a floor *through* a building and writes the
building back when the floor changes.

## Help

**Help** in the flow bar, in the slot the other two flows put theirs in and under the id
they share — only one flow is mounted, so the name belongs to whichever that is. It holds
the containment chain above written for someone who has not read this file, and the
controls.

The controls are there rather than under the tool bar. They are a reference to read once
rather than something to consult while painting, and the left column is narrow enough that
four static lines of them crowded out the panel saying what is under the pointer. What
stays on the tool bar is the one line that changes with the mode.

## Where it departs from the reference tool

Two of these are data loss the reference tool causes, so on both this does something it
has no working implementation to compare against. The 93-floor round trip in
`tests/buildingFloorModel.spec.js` is what stands in for that comparison.

**Layout variations.** An address may hold several complete room layouts and the game
picks one per floor at random; 117 of the base game's 602 addresses do. The reference
loads `vs[0]`, ignores the rest, and writes a single variation — so saving any of those
117 through it deletes the others silently. Here each address has a selected variation,
the grid is the union of every address's selected one, and only those are rebuilt on
save. The rest are written back exactly as they were read.

**Forced rooms.** The reference writes `f_r: ""` for every node, commented *"Seems to be
blank in real files? better to leave it blank"*. It is not blank in real files: 1,889
nodes across 40 base game floors carry a `RoomConfiguration` name, sometimes doubled as
`Lobby.Lobby`. The model carries it through untouched. It is shown in the selection
panel and not editable, because what the doubled form means, and how the game resolves a
value disagreeing with the room's own preset, are both unknown. The game's
`FloorEditTool` enum has a `forceRoom` entry, so there is a tool to model eventually —
when someone knows the semantics well enough to author it rather than guess.

**Rooms belong to an address.** The reference keeps one flat list of rooms shared across
addresses. Room ids clash within a single variation in 58 places across the base game, so
an id identifies nothing on its own; here a room is a slot in one address's variation.
Painting an address still takes the node's room with it — by finding the room of the same
preset in the address being painted, and adding one if it has none.

**A room id is generated, not authored.** Nothing offers one to type. A room made here
takes an id no room anywhere in the floor is using, counted across every address and
every layout variation rather than only the ones on show. That is a rule for rooms this
editor makes, not one the data is held to: the game's own floors reuse ids freely — 693
of the 2,872 rooms it ships share one with another room in the same file, and only 709
distinct ids cover the lot — and a floor is read and written with whatever ids it arrived
carrying. The id is shown beside each room, because it is what the floor's JSON calls it.

Which is also why a room is chosen by its slot rather than by its name and number. 24
rooms across 13 base game floors sit in the same address as another room with the same
preset *and* the same id, so those two things cannot tell one room from another even in
principle.

**Rooms are added and removed by hand.** A new address arrives holding a `Null` room, and
gains the room its layout configuration is named after when that layout is chosen — 19 of
the game's 32 layout configurations share a name with a room preset, and an address of
one nearly always holds a room of that name. Removing a room moves whatever was painted
into it to the address's `Null` room; removing an address's only `Null` room hands its
squares back to Outside, which is where a square no address claims already lives.

**Painting does not stop working.** In the reference it silently does whenever the Editor
object is deselected, because the tools live on an inspector.

## What is not repaired

All three are conditions the base game's own floors contain, so none is fatal and none is
fixed behind the author's back. The selection panel reports them.

- **Overlap** — two addresses claim the same node in their selected variations. Five base
  game floors do it. The later claim wins the square on the grid, so the earlier address
  writes back without it.
- **Gap** — no address covers a node. Six base game floors leave the grid incomplete.
  Filled in as Outside with no floor, mirroring `DataBuilder.BackfillOutside`, including
  giving the new node its half of any wall facing it.
- **Disagreeing walls** — a wall is stored on both of the nodes it sits between, and 582
  halves across 30 base game floors name a different preset from their opposite number.
  Three have no opposite at all. Guessing which side is right would rewrite the game's
  own data.

Anything written *through this editor* has matching halves. Every wall write goes through
`setWall`/`clearWall` in the model, which always writes both.

## How a wall is drawn

What a wall *is* reads off its shape rather than off its colour alone:

| Kind | Shape | |
|---|---|---|
| wall | ▮ | solid |
| window | ▣ | an opening with frame all the way around it |
| door | ∩ | an opening reaching the floor: two jambs and a lintel |
| blank | ∪ | an opening reaching the top: two jambs and a sill |

All four are the same frame with different pieces left out, so where the opening
*touches* is what tells them apart. A preset the kinds table has no entry for is drawn
solid — ids 28 to 30 name nothing the game has, so a floor referring to one is already
saying something this app cannot interpret, and a box claims least about it.

Drawing and hit-testing use different meshes, which is worth knowing before changing
either. A window is drawn with a hole in it, and a ray through that hole would miss the
wall and find the floor beyond — so aiming at the middle of a window would select
anything but the window. `wallHits` is one box per slot covering the wall's whole volume
and is never drawn; `wallParts` is up to four boxes per slot and is never raycast.

## How a floor type is drawn

`FloorTileType` has five values, and five colours are five things to memorise. The names
are made of two independent questions, so those are what the floor type overlay draws —
is there something to stand on, and is there something overhead:

| Type | Slab | Overhead | |
|---|---|---|---|
| none | see-through | — | nothing here at all |
| floorAndCeiling | solid | ▫ | an ordinary indoor square |
| floorOnly | solid | — | a rooftop or a yard |
| CeilingOnly | see-through | ▫ | overhead only |
| noneButIndoors | see-through | — | inside, but nothing there |

The colours are still there and are what tells `none` from `noneButIndoors`: nothing
stands in either, and where the game counts the square as being is not a thing the view
can show.

Only in this overlay, which the floor type tool is what turns on. The address and room
overlays are read as flat sheets of colour, and a floor half of which is see-through with
squares hanging over it is not one. `f_h` is drawn here too and nowhere else, measured
from the floor's own `defaultFloorHeight` against its `defaultCeilingHeight` — the base
game's non-zero heights run 7 to 51 against ceilings of 42 and 52, so it is a fraction of
a storey rather than a step of anything. A raised square stands on a plinth reaching the
floor rather than floating over a gap.

Drawing and hit-testing use different meshes, the same way the walls do and for a related
reason. A square with no floor is see-through and a raised one has moved, but painting a
floor back into a hole is exactly what this tool is for — so `cellHits` is one box per
square covering whatever is drawn there, is placed on every refresh, and is never drawn;
`cells` and `ghostCells` each draw the squares the other does not and are never raycast.
An `InstancedMesh` has one material and a material has one opacity, which is why "solid"
and "see-through" are two meshes rather than one with a per-instance alpha.

## How a tile is drawn

A tile is a 3 × 3 block of nodes, and what it carries — an entrance, a stairwell, an
elevator — is not a fact about any one of them. So the tile tool turns on a square per
tile floating clear of the walls, which is the shape of the thing a click actually
changes, and each tile carrying something is written on: `Stairs 90°`, `Main entrance`,
or both a line at a time.

The words are `tileParts`', which is also what the status column and the hover label say,
so the three cannot describe the same tile differently. Only the tiles carrying something
are labelled — 49 squares reading "Nothing" would be a floor nobody could read.

The label lies **in** the floor rather than over it, and is turned the way its stairwell
faces, because that is what a rotation is for. The top of the words points where the
stairwell points: a rotation of 0 faces the game's +z, which is this floor's +y, and each
quarter turns the label a quarter. The turn is negated going into the scene, for the same
reason everything else here is mirrored — reflecting one axis reverses the sense of every
rotation about the vertical. See `mirrorX`. The degrees are written out as well, so a
label lying at a quarter turn is read rather than measured, and the arrow off the front
edge is what the figure is measured from.

An entrance with no stairwell is not turned at all: its `s_r` is whatever the file left
there, and turning it would draw a direction out of a number that means nothing.

## Saving

Base game presets are never written to — the copy under `refs/floors/` is a URL this app
fetched, not a file it has a handle on. Saving a floor against one creates a stub of the
same name in the mod, carrying `copyFrom: "REF:BuildingPreset|<name>"` and its floor
list. That is what lets a custom floor reuse a base game building's existing prefab, mesh
and window data.

A stub is written **without its default-valued fields**. Under `copyFrom`, writing a
field at its default is not a no-op — it overwrites. A stub carrying the full template
would name a building to copy and blank its prefab, height and window data in the same
breath. This is the one place the flow departs from how the ScriptableObject flow writes
a new file.

A floor saved into the mod keeps the name the building already refers to, so it shadows
the base game copy and the building needs no change at all.

Every preset written is also named in the mod's `murdermanifest.sodso.json`, which is
written for a mod that has none. `fileOrder` is what the loader reads a `.sodso.json`
through — an unlisted preset is one the game never loads, which in game is a building
that is simply not in the city and nothing anywhere saying why. That happens in
`writeCustomPreset` rather than beside the dialog, because it is the one place a preset
reaches the mod: adding a building goes through it, and so does the stub written the
first time a floor is saved against a base game one. Entries go last, and a manifest that
will not parse is left as its author wrote it. See `core/murderManifest.js`.

Saving is debounced by 600 ms. A blueprint is around 55 KB of coordinates and one drag
can touch a hundred nodes.

## Adding a building

**Add building…** asks for three things before anything is written, so cancelling leaves
the mod as it was.

A building's name is two different things, and the dialog asks for both:

| | | |
|---|---|---|
| Title | what a player reads | used in one place only — a row in the mod's `DDSContent/Strings/English/names.rooms.csv`, keyed by the preset name. May hold spaces and punctuation. |
| Preset name | everything else | the file it is written to, the `REF:BuildingPreset\|…` a floor's building points at, and the key that row is stored against. Letters, digits, hyphens and underscores — `makeNameFieldSafe`. |

The preset name follows the title, made safe on the way, until it is typed into. Where
the CSV row actually lands is the mod's manifest's business, exactly as it is for a line
of block text — see `core/modStrings.js` and `core/ddsManifest.js`. Writing the building
succeeds or fails on its own; a row that cannot be written is reported and leaves the
building, which shows in game under its preset name.

**Copy from** offers the base game's buildings, or None. None is a building of its own,
with no prefab, mesh or window data, so the game has nothing to draw until those are
generated — see *Still to come*.

## The Floor section

Top of the right-hand column: which storey of the building is open, its blueprint's name,
and the way to the rest of it.

The arrows move a **storey** at a time, lowest first — `basementLayouts[0]` is the storey
immediately below the ground floor, so down from Floor 0 is Basement 0. A storey is one
floor setting, and the blueprints in it are alternative layouts the game picks between
when it builds the city; the **Layout** select below is how those are reached. Stepping
through the slot list one at a time would walk sideways through a storey's own layouts and
call it climbing — see `storeysOf`.

Which storey is open is decided by the slot the floor was opened through, not by its name.
Nothing stops a building listing one blueprint in two slots.

## Adding and deleting floors

The Browse menu divides into **Custom** and **Vanilla**, and a building opens into its
storeys: one collapsible section per floor, holding the layouts of that floor. That is the
shape a building has — the blueprints in one setting are alternatives the game picks
between for the same storey — and listing every blueprint at one level said "twelve
floors" where the building has four.

Only the mod's own buildings carry the three buttons: **Add floor** at the foot of the
building, **Add layout** at the foot of each of its floors, and **×** on each layout. A
base game building becomes a stub in the mod the moment its floor list is written, and
doing that from a delete button would be a mod gaining a building nobody asked for.

**Add floor** writes `<Building>_Floor<n>` — the first number nothing has taken, checked
against the base game's blueprints as well as the mod's, since a mod floor named after a
base game one shadows it everywhere — puts it in a floor setting of its own, and opens it.

**Add layout** puts one on the end of a setting that is already there, and names it after
the storey rather than by the next free floor number: `<Building>_Floor0_v1` is a second
layout of Floor 0, where `<Building>_Floor3` would name a floor the building has not got.
Never a control room variant — those are the same layouts with a control room in them,
which is not something that can be made out of a blank floor.

A new floor is not an empty grid. It is the three-node margin the city leaves between
lots, which is not paintable and so could never be filled in by hand, and inside it one
`Lobby` room covering the lot, walled off from the margin with `DefaultWalls`. See
`blankFloor`.

**×** takes the floor out of the building *and* deletes the mod's copy of it. Either half
on its own leaves something misleading: a file nothing loads, or a building naming a floor
that is not there. A setting left with no blueprints at all goes too —
`floorsWithThisSetting` means "the next N floors look like this", so an empty setting
silently shifts N floors onto the setting after it. On a stub, deleting a floor named
after a base game one uncovers the original rather than losing it.

## Layout

```
flow.js               descriptor
globals.js            inline-handler surface
style.css
scripts/
  loadRefs.js         wall preset tables, room/layout/building name lists
  floorModel.js       load, save, validate, backfill, variation handling, painting
  buildingLibrary.js  buildings, floor slots, stub presets, blueprint resolution
  scene.js            three.js grid, walls, camera, hit-testing, tile labels
  tools.js            the five painters, plus pick and erase
  panels.js           address/room/floor type/wall/tile panels and the tool bar
  ui.js               flow entry points
  meshExport.js       footprints, mesh, textures, window data
  pngWriter.js        PNG files, written a chunk at a time
```

three.js loads through an import map declared in `index.html` before `main.js`, so bare
specifiers resolve. Declaring a map fetches nothing, so the other two flows pay no cost;
this flow dynamic-imports `three`, `OrbitControls` and `troika-three-text` when its scene
is first built. The version is pinned rather than floating — a minor release changing
`InstancedMesh` raycast behaviour would break painting with no local change to point at.

troika's own four dependencies are mapped beside it rather than using jsDelivr's bundling
`/+esm`, which resolves `three` to a second copy of the same version at a different URL —
two module instances, and a `Text` that is not the `Mesh` the rest of the scene is made
of. It fetches font data on first use, so the tile labels appear a moment after the floor
does and not at all offline; nothing else in the view waits for them.

## Generating the building's model

A floor blueprint says what is *inside* a building. Nothing in it says what the building
looks like from the street — that is a mesh, a material and a hand-painted window map,
authored in Unity and shipped in an asset bundle. A building copying from a base game one
borrows all three, which is why this is optional. A building of its own has nothing to
draw until it runs.

**Generate mesh**, in the Floor section, derives all of it from the blueprints the
building's floor settings name. It writes seven files beside the preset and rewrites the
preset to point at them:

```
<Building>Prefab/
  <Building>.obj                the model
  <Building>.sodprefab.json     the prefab the loader builds, naming the mesh and material
  <Building>_diffuse.png        masonry, with a dark rectangle per window
  <Building>_emissive.png       black, with a white rectangle exactly over each of those
  <Building>_black.png          pure black — the state the emission texture starts in
  <Building>_mask.png           metallic in R, occlusion in G, detail in B, smoothness in A
  <Building>_normal.png         flat
```

| Preset field | What it becomes |
|---|---|
| `prefab` | `PREFAB:<Building>Prefab/<Building>` |
| `emissionMapLit` / `emissionMapUnlit` | the emissive and black textures |
| `floorCount` | the number of window rows |
| `sortedWindows` | four lists of `WindowUVBlock` per floor |

At runtime `NewRoom.UpdateEmission` blits the emissive map at a block's `originPixel` and
`rectSize` into the building's own emission texture when a room's lights come on, and the
black map back when they go out.

Base game presets are never written to, so generating against one creates the mod's stub
of it first — exactly as saving a floor against one does. That is not incidental: the
generated prefab and window data are what stop the stub deferring to the original.

### What is modelled

The ground floor is left out, because the street frontage the game puts in front of it is
what draws it, and so is any open rooftop on the top — both would otherwise take a row of
the texture and shift every floor above them. The panel says which floors were dropped.
Basements are not modelled at all.

A square is inside the building's shell if its floor tile is `floorAndCeiling`,
`CeilingOnly` or `noneButIndoors`. A wall goes wherever an enclosed square meets one that
is not, and a cap wherever a square appears or disappears between one storey and the next.
An atrium or lightwell with no way out to the street is filled in first, so the model has
no holes through which the inside of the building can be seen.

### Which window lights up

`NewFloor.AssignWindowUVData` collects a floor's exterior window walls, buckets them by
which way they face, sorts each bucket, and matches a wall to its block by `horizonal` —
the index in the list — and **nothing else**. So the order is the whole thing: one extra or
missing block and every window after it on that side lights the wrong rectangle.

| List | Wall faces | Sorted by | `side` |
|---|---|---|---|
| `front` | -Y | `cell.x` ascending | (0, 1) |
| `back` | +Y | `cell.x` descending | (0, -1) |
| `left` | +X | `cell.y` ascending | (-1, 0) |
| `right` | -X | `cell.y` descending | (1, 0) |

`side` reads inverted against the facings and is only read by a debug overlay; it is
written to match the list it sits in, the way the base game's own data looks.

### Checked against the base game

`refs/floors/` ships the 15 base game building presets as full dumps, `sortedWindows`
included — window data the game itself produced from hand-painted window maps. So the same
buildings can be derived from their blueprints and compared block for block, which is what
makes this testable with no game running. `meshExport.unit.spec.js` does it.

Townhouse, TownhouseShops, Hotel and ChemicalPlant reproduce exactly — about 30 floors with
no disagreement about which side a window landed on or which way the list runs — and 14 of
BrandyNetherland's 17. Where the rest differ it is the base game data disagreeing with its
own blueprints, and the tests pin the disagreements rather than paper over them:

- **OneFifthAve** paints 7 windows on the +Y wall of most floors where the blueprint has 6.
- **ShantyTown** floor 1 puts all 8 blocks in `left`; see limitation 6 below.
- **EdenTower** is painted as a uniform curtain wall, reporting identical counts for floors
  whose blueprints give no windows at all.

So parity with vanilla is not the target and is not always achievable. Parity with what
`AssignWindowUVData` enumerates at runtime is.

### PNGs are written by hand

Chunks, CRC-32, and `CompressionStream('deflate')` for the image data — not a canvas.
Canvas 2D holds colour as premultiplied alpha, and the mask map's alpha is *data*
(smoothness) rather than transparency, so a round trip through a canvas would scale the
other three channels by it. `0x00, 0xBF, 0x80, 0xD9` would come back as something else.
See `pngWriter.js`; it is 60 lines because one colour type and one filter is all it needs.

### When the model goes stale

Window data is written once, from the floors the building named at that moment. Editing one
of those floors afterwards leaves the preset describing a layout that no longer exists —
silently, because nothing about a stale `sortedWindows` looks wrong until a lit room lights
someone else's window.

So generating stores a hash of the floors it read, in `modMakerFloorHash`, and the Floor
section says *built from floors that have changed since* when they no longer match. The
field is not one the game has; the mod loader is expected to ignore a property it does not
recognise, which is what both of the common .NET JSON readers do by default — an
expectation rather than something verified against the loader, and the reason it is one
short string rather than anything larger. Only a building that has actually had a mesh
generated is checked, so nothing else pays for reading its floors again.

### Known limitations

Carried over from the reference tool's `BuildingWindowData.md`, because each needs
something the blueprint does not record and guessing would produce output that disagrees
with the game in a way nothing here could detect.

1. **Blueprint variants are unioned.** The game picks one layout of a storey at random, but
   `sortedWindows` is indexed per floor rather than per layout — so the game itself requires
   every layout of a storey to share an exterior window layout. Only variation 0 of each
   address is read, for the same reason.
2. **Enclosed is geometry; the game uses room flags.** A roofed courtyard whose rooms are
   flagged outside keeps its windows in game and loses them here, and filling voids widens
   the gap.
3. **Outdoor addresses are matched by name.** Six strings, in
   `OUTDOOR_LAYOUT_CONFIGURATIONS`; the game asks `NewAddress.isOutside`.
4. **Window presets come from a hand-maintained table.** `refs/authored/wallPresetKinds.json`
   stands in for each `DoorPairPreset`'s `sectionClass`, and ids 14, 26 and 27 are
   unconfirmed. One wrong entry shifts a whole side of a floor.
5. **Two walls facing the same way at different depths share a texture column.** A square
   maps to one of 15 columns per side, which knows nothing about depth, so both light
   together. Untidy, and it keeps the counts aligned with what the runtime enumerates —
   which is where the base game's own ShantyTown loses the alignment entirely.
6. **`localMeshPosition` assumes the generated prefab.** Unit scale and this tool's mesh
   child offset. A real building prefab scales and offsets its capture mesh and the game
   bakes that in. Only a debug overlay reads them.
7. **`floorCount` is inert.** Nothing outside `GenerateWindowData` reads it. Written for
   completeness, and unlike the game's version it counts every row including empty ones,
   which is what keeps `sortedWindows[floor - 1]` aligned.

The reference's limitation 5 — that the mesh comes out 180 degrees about Y from the game's
convention, so a generated building faces away from the street — **does not reproduce**.
Generated positions agree with the base game's in sign, and to within about a metre, on all
four sides of every preset checked. The unit suite asserts it, because the fix that
limitation proposes is two negated constants and would be an easy thing to apply by
mistake.

## Still to come

**Roof generation** (`DataBuilder.GenerateRoof`) — convert every indoor address to a
`VentedRooftop` address with `Rooftop` rooms and `floorOnly` tiles, everything else to
Outside, and put `NothingWall` between differing addresses.
