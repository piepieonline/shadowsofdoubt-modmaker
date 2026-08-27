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
preset and id in the address being painted, and adding one if it has none.

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

Saving is debounced by 600 ms. A blueprint is around 55 KB of coordinates and one drag
can touch a hundred nodes.

## Layout

```
flow.js               descriptor
globals.js            inline-handler surface
style.css
scripts/
  loadRefs.js         wall preset tables, room/layout/building name lists
  floorModel.js       load, save, validate, backfill, variation handling, painting
  buildingLibrary.js  buildings, floor slots, stub presets, blueprint resolution
  scene.js            three.js grid, walls, camera, hit-testing
  tools.js            the five painters, plus pick and erase
  panels.js           address/room/wall/tile panels and the tool bar
  ui.js               flow entry points
```

three.js loads through an import map declared in `index.html` before `main.js`, so bare
specifiers resolve. Declaring a map fetches nothing, so the other two flows pay no cost;
this flow dynamic-imports `three` and `OrbitControls` when its scene is first built. The
version is pinned rather than floating — a minor release changing `InstancedMesh` raycast
behaviour would break painting with no local change to point at.

## Still to come

**Roof generation** (`DataBuilder.GenerateRoof`) — convert every indoor address to a
`VentedRooftop` address with `Rooftop` rooms and `floorOnly` tiles, everything else to
Outside, and put `NothingWall` between differing addresses.

**Mesh and window data export** — the footprint reading, mesh building, five 1024 × 512
textures and `sortedWindows` blocks a building of its own needs before the game can draw
it. Until then, a custom building should copy from a base game one. The reference's
`BuildingWindowData.md` documents its expected disagreements (OneFifthAve, ShantyTown,
EdenTower) and ten known limitations; those carry over.

**Stale window data.** Window data is written when a mesh is generated, from the floors
the preset referenced at that moment. Editing a floor afterwards leaves the preset
describing the old layout, silently. Worth a stored hash of the source floors, checked on
save — nothing does this yet.
