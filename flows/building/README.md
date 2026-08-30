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

**The name lists include the mod's own.** An address names a `LayoutConfiguration` and a
room names a `RoomTypePreset`, and the reference offers only what the game ships. Both
pickers here are the searchable control the case flow's reference fields use, with the
mod's own assets under a **Modded** heading above the game's — read off the same overlay
the furniture checker is answered from, so a `LayoutConfiguration` written into the
selected content folder can be chosen the moment it exists. A name the mod redefines is
listed once, as the mod's: that is the file the game will load.

Neither list can be typed into. A layout configuration nothing defines is a floor the
game will not load, so this is a list to choose from rather than a field to fill in. A
floor that already names something on neither list keeps it, shown and marked, because
replacing it would rewrite the floor.

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

## Divider ends

A divider is a run of low partition, and the game splits it into three presets: a centre
with no post and two ends, `DividerEndLeft` and `DividerEndRight`, carrying one each.

**`DividerEndLeft`'s post sits at the end of the run that is on the left as seen from
inside the _parent_ room.** Of the two walls facing each other across a divider, the
parent is the one whose room has the higher `RoomTypePreset.cyclePriority`, tiebroken by
the higher room id, with a real room always parenting a `Null` one. The pair shares one
preset and the mesh is drawn from `parentWallsShort/Long` on the parent side and the
mirrored `childWallsShort/Long` on the other — which is why the id means "left when
standing in the parent room" rather than a direction on the grid.

A wall faces back into its own node's room, so the parent wall's facing runs from the wall
toward the parent node and its left is that turned a quarter turn:

| wall | parent side | `DividerEndLeft` post lands |
|---|---|---|
| along x | low node | high-y end |
| along x | high node | low-y end |
| along y | low node | low-x end |
| along y | high node | high-x end |

Note the two axes mirror each other. A view that drew the same preset the same way round
on both would be hiding the rule rather than showing it.

Measured, not assumed: **305 of the 316 divider runs the editor finds across the base
game** come out with their posts capping the run under this, and it reproduces all three
runs on the floor that raised the question — including the one that renders crossed, which is what any correct
rule has to account for. `cyclePriority` comes from `refs/generated/roomCyclePriority.json`;
a room preset the table has no entry for takes the field's own default of 5.

### What it cannot answer

Most of the residue is walls with the **same room on both sides** — identical preset and
identical id — so priority and the tiebreak are both exhausted and
the parent falls to the order the game happened to build the two walls in, which a
blueprint does not record. Choosing either side scores identically across the base game,
so it is a genuine coin flip.

That is what the flip is for, and now the only thing it is for. The picker offers one
**Divider end** piece rather than a left and a right, `dividerEnds.js` writes whichever id
puts the post on the outer end, and **erasing one end and placing it again** turns the run
round — both ends together, and doing it twice returns it. Between two different rooms
that should never be needed.

Two consequences worth knowing. Ctrl-picking a divider end takes the *piece*, not the id,
because an id says where in *its own* run a wall sits — carrying it to a run whose parent
falls on the other side would write a second left. And a run drawn with its posts in the
middle is not a fault in the view: it is a run that will render that way in game.

### Hand-placing blocks the generator

A run is skipped entirely by the generator if any wall in it already carries a
dividerLeft/dividerRight preset (`GenerationController.cs:1685-1692`). So placing a
divider end by hand stops the game ever adding one across those walls. Silent, and not yet
warned about.

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

## How an address and a room are coloured

One palette of twelve pastels, in `floorModel.js`. An address takes its slot's colour from
the front of it; a room takes its slot's from the back.

An address carries its colour in the file — `e_c`, the field the game's own editor draws
it by — so a floor's colours are whatever its author chose and are kept as they are. Only
two cases are overridden: an address with no colour at all, and a black one, which in an
overlay read as flat sheets of colour is a hole in the plan rather than an address. None
of the base game's 602 addresses is either. A new address takes its slot's colour rather
than asking, and the picker beside it changes that.

A room carries no colour anywhere — the format has nowhere to put one — so its colour is
derived from its slot every time it is drawn. Slots are per address, so the third room of
one address and the third room of another are the same colour; the room overlay is for
telling apart the rooms of the address being painted with.

Reading the one list from both ends is what makes swapping tools visible. Nothing else on
screen changes when the tool does, and the two overlays draw the same 441 squares, so the
guarantee is that no square keeps its colour across the switch: slot *i* from the front and
slot *i* from the back are never the same colour, and are far apart rather than near
neighbours. Twelve is a cycle rather than a limit, and it is the number that makes the
cycle rare — the busiest base game floor holds 13 addresses, and its busiest address 12
rooms.

## How a tile is drawn

A tile is a 3 × 3 block of nodes, and what it carries — an entrance, a stairwell, an
elevator — is not a fact about any one of them. So the tile tool turns on a square per
tile floating clear of the walls, which is the shape of the thing a click actually
changes, and each tile carrying something is written on: `Stairs 90°`, `Main entrance`,
or both a line at a time.

The words are `tileParts`', which is also what the status column and the hover label say,
so the three cannot describe the same tile differently. Only the tiles carrying something
are labelled — 49 squares reading "Nothing" would be a floor nobody could read.

What a click does depends on which of the tool's three settings is chosen, and two of them
are cycles while one is a toggle:

| Setting | A click |
|---|---|
| Stairwell | steps the tile on: on facing 0, each rotation, then off again |
| Inverted | turns the mirroring on or off, and changes nothing else |
| Entrance | steps the tile on: entrance, main entrance, then off again |

Mirroring is one fact about a stairwell rather than a kind of stairwell, so the setting
that paints it leaves the rotation alone — and the stairwell cycle turns a mirrored
stairwell rather than un-mirroring it, which is the same rule read from the other end.
Inverted was a third cycle until it became a toggle: a click on an already-mirrored
stairwell turned it and a fifth click took it away, which made mirroring a stairwell you
had already aimed a job of counting clicks. The ends are where each still touches the
other's fact, because there is no stairwell there for it to be about — a click on an empty
tile puts one down, mirrored or plain to match the setting, and a stairwell cycled off
takes its mirroring with it.

The label lies **in** the floor rather than over it, and is turned the way its stairwell
faces, because that is what a rotation is for. The degrees are written out as well, so a
label lying at a quarter turn is read rather than measured, and the arrow off the front
edge is what the figure is measured from.

**A label is upright to whoever the stairs open onto.** Its top points away from the
opening, so the label you can read from where you are standing is the one whose stairs you
could walk into — and a stairwell facing the other way is read by orbiting round to the
side it opens on, which is the side you would approach it from in the game. The top of the
words is the *back* of the stairwell, which is worth saying plainly: pointing it at the
front is the obvious reading, and is what this did until it was checked against the game.

Which way a rotation opens is taken from the game's own floors rather than from the
arithmetic. Of the 116 stairwells in `refs/floors/blueprints`, every one at 90 has its
wall-free side on the floor's +x and every one at 270 on its −x, and the only tiles
carrying a door on their own edge are at 180 with it on −y. So 0 opens on +y, each quarter
turns that clockwise, and the words face the other way. The turn itself is negated going
into the scene, for the same reason everything else here is mirrored — reflecting one axis
reverses the sense of every rotation about the vertical. See `mirrorX`.

An entrance with no stairwell is not turned at all: its `s_r` is whatever the file left
there, and turning it would draw a direction out of a number that means nothing.

## Selecting a square

A floor opens in **None**, where a click reads rather than writes. That click selects the
square under it and takes **all five values at once** — address and room, floor type and
height, the wall on the edge the click landed nearest, and what the tile carries —
whichever tool happens to be active. Ctrl+click does the same in the other two modes.

It used to take only the active tool's value, which made finding out a square's floor type
require switching to the floor type tool, and switching tool changed what the next click
would paint. One click now answers every question about a square.

The selected square is marked `*` in the view, written in the floor the way a stairwell's
rotation is, and on the square's own top surface rather than at the tile labels' height —
a mark floating at wall height over a single cell is ambiguous the moment the view tilts.
It is drawn with `depthTest: false`, so a wall between it and the camera does not hide it.

The top of the status column is headed for what it holds:

| Mode | Heading | What the five rows are |
|---|---|---|
| None | **Selected square** | the square that was clicked, named `Node x, y` |
| Paint, Flood | **Painting with** | what a click would put down |

They are the same five values either way — selecting is how you load the brush — but they
are read off different things, and the Tile row is where that shows: a selected square says
what its tile carries, and a brush says which of the three settings a click would paint.

**Under the pointer** stays below, unchanged. The comparison is the point: you select the
square you are working on, then move the pointer to read others against it.

A selection does not survive the floor it was made on — opening another, or closing the
one that is open, clears it. Node 10,10 exists on every blueprint and is a different room
in a different address on each, so carrying one across is carrying a coordinate and calling
it a place. The view is told as well as the tool state: `setModel` re-*places* the mark
rather than clearing it, because a layout variation switch rebuilds the grid under a
selection that should survive that.

## What could spawn on a square

Under the pointer, below the five type rows: the furniture the game could put on the
square being hovered. A blueprint says nothing about furniture — it says which
`LayoutConfiguration` an address has and which `RoomTypePreset` each room is, and the game
turns that into objects at city generation. This walks that chain forwards:

```
LayoutConfiguration → AddressPreset → RoomConfiguration → RoomClassPreset
  → RoomTypeFilter → FurnitureCluster → FurnitureClass → FurniturePreset
```

It hangs off the **selected** square, not the hovered one, so a forty-row list can be read
and scrolled without the pointer leaving the canvas meaning anything.

**It is grouped by address preset, because a blueprint does not name one.** Every preset
whose `compatible` list contains the layout competes for the unit, scored on size, footfall
and district when the city is built, and each maps the room's type to a `RoomConfiguration`
of its own choosing. `OfficeHighrise` is shared by `HighriseOffice` and `Laboratory`, which
send the same `OfficeSpace` room to `RoomConfiguration|Office` and
`RoomConfiguration|Laboratory` — 42 furniture presets against 31, barely overlapping. One
merged list would assert something the file does not say, so each group carries its own
summary line: address preset, configuration, room class.

Inside a group, furniture is listed under the `FurnitureClass` it fills, because that is
the shape of the thing: a class is the slot an arrangement puts somewhere, and the presets
under it are the models that could land in it. A slot class with nothing that fits is
counted rather than listed — it is not furniture, but an empty pool on an element marked
`importantToCluster` aborts the whole cluster, which is the transitive gate an
address-scoped arrangement is built on.

Collapsed by default. A room of any size runs to a few dozen presets across forty classes,
and the five type rows above are read on every hover where this is read of one square.

### The square is answered by its walls, in two ways

`FurnitureClass` carries `minimumZeroNodeWallCount` and `maximumZeroNodeWallCount` — how
many walls the square a slot sits on must have — and a blueprint records every wall.
**166 of the game's 262 slot classes need at least one wall**, and the 15 that need two are
exactly the corner pieces: `1x1CornerArmchair`, `1x1SecurityCameraLeftCorner` and their
kind. Seven need a square with *no* walls.

The count is the coarse half. The fine half is `wallRules`, which **230 of the 262 classes
carry**: where the count asks how many edges have a wall, a rule asks what kind sits on a
named edge, and what lies through it. A bookcase does not merely want a wall behind it, it
wants a solid one — a doorway will not do — and 82 classes say exactly that through
`mustFeature wallOrUpperVent`.

So more walls is not more furniture. Three squares of one 28-node `OfficeSpace`:

| Square | Walls | Offers |
|---|---|---|
| middle | none | **4** presets — a cubicle, its under-desk drawers and an easel |
| edge | one, and it is a doorway | **4**, and *not* the cubicle or the easel |
| corner | two, and both are large windows | **19**, and no wall pieces among them |

The edge has a wall the middle has not and offers less than open floor does. A doorway on
a square bars every class that takes the square up, which is 179 of the 262
(`GenerationController.cs:4663`), and a window bars anything tall enough to stand in front
of one (`:4667`) — which is why a corner with two walls hangs nothing on either.

The count is on the summary line (`OfficeSpace, 28 nodes, 2 walls`) and what it excluded is
counted at the foot of each group: too few walls, too many, and *the wrong kind*, which are
three different facts about the square and one fix — select a different one.

### Six more things a square can refuse a class for

Beside the rules a class writes down, the placement loop tests the square itself against
six flags. Each is one line of `GenerationController.cs` and each is in the blueprint:

| Flag | Refuses | Classes |
|---|---|---|
| not `allowedOnStairwell` | a stairwell tile, **and any square orthogonally beside one** | 244 |
| `onlyOnStairwell` | anything but a stairwell tile | 1 |
| not `allowIfNoFloor` | a square with no floor | 208 |
| `requiresCeiling` | a square with no ceiling | 3 |
| `occupiesTile` | a square carrying a doorway that is not a divider | 179 |
| `tall` or `wallPiece` | a square carrying a window of either size | 108 |

The stairwell one reaches a square further than its name suggests, and that is not a
reading — the loop walks the four neighbours itself (`:4582-4591`). A kitchen square beside
the hotel's stairwell is offered 10 presets where the same room two squares along offers
43.

`onlyOnStairwell` is 1 rather than the 2 classes that set it, because the game only ever
reads it inside the `else` of `allowedOnStairwell` (`:4597`). `1x1WallLampBallroom` sets it
without setting that, so it is barred from stairwells rather than confined to them, and its
`only` is dead. The editor folds the pair to one field so that the two names cannot suggest
a behaviour the game does not have.

A multi-tile class is tested on every square it would cover, and each of those must be in
the *same room* as the anchor — `newNode3.room != room` at `:4570`, which is stricter than
fitting inside a room of the right size.

Not applied, because they read what has already been placed rather than the floor:
`ceilingPiece` (air ducts and ceiling vents), `windowPiece` (a window already spoken for),
`tall` against air ducts, `allowLightswitch`, and `allowNewFurniture`.

**Every wall counts, blanks among them.** `NothingWall`, `NothingEntrance` and the three
dividers draw as openings with no structure — how a floor separates two addresses with
nothing between them — and `refs/authored/wallPresetKinds.json` calls them blanks for that
reason. The generator does not. It compares against `newNode.walls.Count` raw
(`GenerationController.cs:4559`, and `:4400` for a cluster's own bounds) and gives those
presets no special handling anywhere in the file, so a square beside a divider is a square
against a wall however little there is to see.

This was read the other way until the decompiled source settled it, and the wall count was
wrong on every square beside a blank. What a wall *looks like* and whether the generator
has one to work with are different questions: the kinds table answers the first and is
still right for drawing, and the count no longer consults it.

The rest of a `FurnitureClass` — `nodeRules`, `awayFromClasses`, `blockedAccess` — is about
what has already been placed nearby, which is generation state rather than blueprint state,
and is not read. `nodeRules` search the room's cluster maps (`:5111`), and `blockedAccess`
is not a match at all: it declares which node-to-node links a piece *blocks*, and feeds a
reachability veto (`:5314`). Treating it as effect-only accepts placements the game would
refuse, which is the direction this errs in everywhere else.

Two wall-rule tags are dropped for the same reason. `securityDoorDivider` reads the room's
`securityDoors` rule, the address through the wall, whether that room holds a stairwell,
the doors already on the floor and — above the ground floor — whether the building's air
ducts reach a basement (`:4981-5070`). `lightswitch` needs a placed interactable, and no
shipped class uses it. A class that loses rules this way is counted rather than decided:
the panel says *2 more carry a wall rule this cannot check* rather than offering them or
refusing them.

### Could spawn, not will

The gates applied are those a blueprint records what they read: `allowedRoomFilters` on
clusters and presets, `minimumRoomSize` / `maximumRoomSize` against the room's node count
on the grid, `onlyAllowInFollowing` / `banInFollowing` against the group's address preset,
`disable` on a cluster, the wall counts and wall rules above, and the six square flags.

District, wealth, grubbiness, inhabitants, building, floor range and design style are not.
None is in a blueprint — they are decided when the city is built, from where the building
landed and what the generator rolled. The panel names them rather than filtering on a
guess: dropping furniture that really can appear here is the wrong way for this list to be
wrong. A preset whose appearance depends on the room's decor style is marked where it is
listed, since that one is a property of the name beside it rather than of the room.

The three cluster flags `allowInResidential`, `allowInCompanies` and `allowOnStreets` are
left out too, and that one is not for want of data. 106 of the 399 clusters set none of the
three and 17 address presets have neither a company nor a residence, so the predicate is
not the conjunction it looks like, and no reading of it could be checked without the
generator's source. The room class already does the work — a bedroom cluster's filters do
not reach an office.

Stage 5 of the chain, the interactables a preset carries, is not walked at all: it decides
what can be *done* with an object rather than whether the object is there.

### Why not this one

The list answers "what could go here", which is the question with no starting point. Under
it, **Why not…** answers the opposite one: type any of the game's 310 furniture presets and
get a verdict per address preset competing for the unit.

A text field against a `<datalist>` rather than a list of 310 options — it filters as you
type, it is the browser's own control so it needs no keyboard handling here, and it costs
nothing to load. select2 is jQuery, is loaded for the ScriptableObject flow alone, and
`index.html` already records dropping it as the aim.

Free text is not a hazard, it is the point: the walk answers a name it has never heard of
with a reason like any other, so typing a mod's own preset is told that this reference data
is the base game's rather than being silently ignored. Half a name is not a question, so
typing answers only once what is in the field *is* a name; committing it — blur, Enter, or
a pick from the dropdown — is when not being one becomes worth saying.

Two states, because the data supports exactly two:

| | |
|---|---|
| **No**, with a reason | Sound *against the data the game would load* — the base game's plus this mod's, see below. Every gate applied is a hard filter. |
| **Possible** | Nothing in the blueprint rules it out. *Not* a promise — the gates above still apply. |

There is deliberately no *Yes*. A blueprint cannot know the district the building landed
in, the decor style rolled for the room, or whether a cluster's `placementChance` came up.

**The reason is the first gate that says no**, walking down the game's own chain from the
address:

| Order | Stage | Gate |
|---|---|---|
| 1 | `addressType` | `onlyAllowInFollowing` / `banInFollowing` against the preset claiming the unit |
| 2 | `roomClass` | `allowedRoomFilters` against the room's class |
| 3 | `roomSize` | `minimumRoomSize` against the room's square count |
| 4 | `cluster` | is any class it can fill named by a cluster placeable in this room |
| 5 | `square` | does this square have the right *number* of walls for any of those classes |
| 6 | `wallRules` | are they the right *kind*, in the right places, at some rotation — and is the square one the class is allowed on at all |

Stopping at the first is the point. `LargeBookcase` in an office fails 2, 4 *and* 5 — and
it fails 4 and 5 *because* it fails 2. Reporting all three says the same thing three times
and buries the one an author can act on:

```
LargeBookcase          HighriseOffice  No
  Its room filters (GeneralFurnishing, PawnShop and LoanShark) do not cover OfficeSpace.

WaterCooler            HighriseOffice  No
  Its slot class 1x1WaterCooler needs a square touching at least 1 wall, and this one has 0.
                       Laboratory      No
  Its room filters (Reception, CorporateLobby, OfficeSpace, Launderette and HotelLobby)
  do not cover Laboratory.
```

5 and 6 are one gate in the game and two here, coarse before fine: "this square has no
walls and that needs one" is a plainer thing to be told than which of its edges is the
wrong kind, and a class that fails the count would fail the rules for a reason that merely
restates it.

A stage 6 reason names the class, says it cannot be turned any way that works, and then
offers the nearest miss — the rotation that satisfied the most rules before one failed:

```
WaterCooler            HighriseOffice  No
  Its slot class 1x1WaterCooler cannot be placed on this square any way round. It takes
  up the whole square, and this one has a doorway on it.

BreakerBox             GrandHotel      No
  Its slot class 1x1BreakerBox cannot be placed on this square any way round. It is not
  allowed on a stairwell tile, nor on any square beside one.
```

The nearest miss is offered *as* that rather than as the reason, because a class with four
rules typically fails a different one at each rotation and singling one out would be false.
Directions in it are the furniture's own — `behind it`, not behind the square — since both
halves of a rule turn together and a compass bearing would be naming one of the four
rotations the check tried rather than anything in the file.

The two address presets can fail at different stages over the same square, which is why
the verdict is per group rather than one answer.

#### Stage 4 says which of two things went wrong

"No cluster reaches this room" and "clusters reach it and put down slots of other classes"
are opposite fixes — widen a cluster's `allowedRoomFilters`, or add a class to the preset —
and the second is far the commoner. So they are different sentences.

#### …and then which file to open

Naming the mismatch still left the reader to find the lever themselves. The clusters that
*would* have given the preset a home are exactly the ones the walk threw away when it
worked out what this room puts down — so nothing downstream could name them, and an author
was told a slot of their class is missing without being told who was supposed to put one
down.

So the walk goes back for them. Same scan, kept rather than discarded, asked the opposite
question: not which clusters reach this room, but which clusters carry this class and what
stopped each of them here.

```
Clusters are placeable in LivingRoom rooms, but none of the 62 slot classes they put down
is any of its classes (1x1SecurityCameraRightCorner and 1x1SecurityCameraLeftCorner).
SecurityCameraLeftCorner, SecurityCameraLeftCornerEatery and 2 other clusters would put
down a slot it could fill, but are placeable only in the rooms the Alarms, Bar and Diner
filters name. Add LivingRoom to the roomClasses of one of those filters, or add a filter
naming LivingRoom to those clusters' allowedRoomFilters.
```

That one is the base game arguing with itself — `SecurityCamera` is `Everywhere`, and the
four clusters that carry its slots are not — so it needs no mod to reproduce. A mod hits it
the same way by widening a preset onto a room class the carrying cluster was never told
about.

Both ends of the link are offered because the link is owned at one end only: a
`RoomTypeFilter` lists its `roomClasses`, and nothing on a room class says which filters
name it. So there is no "allow another filter in my room" — there is adding the class to a
filter the cluster already takes, or adding a filter that already names the class to the
cluster. Two files, one edit, and the second avoids patching a shipped asset.

**Which gate is named matters more than which cluster.** A cluster is kept out by its
filters, by the room's size, or by `disable`, and only the first has an edit behind it —
telling an author to widen a filter at a cluster that wants four squares in a room of two
would be true and useless. So the reason picks the gate with the best fix, names up to two
clusters sharing it, and counts the rest. One instruction rather than a menu.

The mod's own clusters and filters are preferred wherever there is a choice, for the same
reason the class hint prefers a mod's own classes: that is the asset the author can edit
without patching anything shipped.

#### When there is no cluster to open

A class no cluster anywhere names is the opposite instruction — no filter reaches a cluster
that does not exist — so it is said outright, and it is the one case where the reason still
describes what the room *does* put down instead. That is worth having: with nothing to open,
the nearest slot already being placed is the whole lead.

```
Clusters are placeable in Chemist rooms, but none of the 45 slot classes they put down is
its class 1x1SupermarketShelvingSign. No cluster anywhere puts down that slot, so widening
a filter would not help: what is missing is a cluster with an element of that class. The
nearest by name is 1x1SupermarketShelvingBackward.
```

The base game is in this state once: `1x1SupermarketShelvingSign` is the only one of its
262 classes no cluster element names, stranding `SupermarketSignStarch` and
`SupermarketSignSynthBeef`. The name offered is a guess and is worded as one — it drops the
`1x1`-style size prefix before comparing and wants a shared head of five characters or more,
which leaves nine in ten of these with no name offered rather than a coincidental one.

### One walk, not two

`checkFurniture` is the only place the gates are written. The list above is **derived from
it** — every preset put through the same walk, and the ones that come back `possible` kept
— rather than computed alongside it. Two implementations of five gates would drift, and
would drift silently: the list saying one thing and the verdict another, with nothing to
catch it.

`furnitureChain.unit.spec.js` asserts that directly. Across five floors spanning office,
retail, residential, civic and industrial, every distinct square is put to all 310 presets
— about 60,000 verdicts — and `possible` must agree with "in the list" every time.

### The mod's own assets

The chain is the base game's, shipped as reference data — so answering a *mod* from it
alone is not merely incomplete but wrong, and wrong in the direction that matters. A mod's
own cluster makes furniture placeable that the walk would call impossible; its own address
preset is a whole competing answer the walk would never show. "No" is only sound against
the data it was asked of.

So `furnitureOverlay.js` reads the **selected content folder** and lays what it finds over
the base. Not the mod's other content folders, not other mods, and not the load order
between them.

Only what the game would load. A `.sodso.json` is read because the mod's
`murdermanifest.sodso.json` names it in `fileOrder`, not because it is in the folder — so
a file that is not listed is **reported** rather than merged, which is otherwise the
failure that shows up in play as content simply missing and nothing saying why.

Three ways an asset gets its values, and they are one operation — a base record with the
fields the file states laid over it:

| Written as | Starts from |
|---|---|
| `<Name>.sodso.json` with `copyFrom` | the donor's record, resolved first |
| `<Name>.sodso_patch.json` | the shipped asset of that name |
| `<Name>.sodso.json` with no `copyFrom` | the type's defaults, from `soDefaults.json` |

A list a file states **replaces** the base's rather than adding to it, which is the mod
loader's own rule for both routes.

The defaults being the game's own is load-bearing: `FurniturePreset.minimumRoomSize`
defaults to **99**, so a preset written from scratch without one needs a 99-square room —
larger than any room the base game ships — and will never place. Guessing 0 would have made
every from-scratch mod preset look fine. The checker now says *"It needs a room of at least
99 squares, and this OfficeSpace has 28."*

`copyFrom` chains, including through the mod's own assets, and is resolved by need rather
than by file order — so a mod whose `fileOrder` is wrong still merges correctly here. A ring
falls back to the type's defaults rather than recursing.

**Nothing downstream changed.** The walk is name-keyed throughout, so this is a merge in
front of it, and `furnitureChain.js` memoises on the data object's identity — a fresh merge
invalidates its caches by existing. The overlay is rebuilt from the base each time rather
than layered on the last one, so a file deleted from the mod stops counting.

The status column says what came from where: *Including this mod's own assets: 3 added* and,
separately, how many files the manifest does not name.

### Problems in the mod's own assets

Everything above answers "what about *here*". Two checks do not: they are properties of what
the mod ships, true before a square is picked and still true after. They get their own block
at the top of the status column, present only when there is something to say.

| Check | Severity | What happens in game |
|---|---|---|
| `chanceOfPlacementAttempt: 0` on an element | fails the cluster if the element is `importantToCluster`, else thins it | `GenerationController.cs:4314` rolls `random > chance` and drops the element; `:4380` returns null for the whole cluster |
| `localScale: {0,0,0}` on an element | fails | placed correctly, counts against every limit, rendered at no size (`FurnitureLocation.cs:217`) |
| A cluster gated only by `allowedRoomFilters` | degrades | room filters are city-wide, so it reaches every room of that class in the city rather than this mod's building |

Three decisions worth keeping:

**Only the mod's own assets.** A shipped cluster with an odd element is the base game's
business and an author cannot act on it — and the base game does ship two, so a check over
everything would open with two complaints on a page where nothing is wrong.

**`0` is the defect, not "anything but 1".** 18 shipped elements state a chance and 16 of
them are a deliberate 0.5, 0.8 or 0.9.

**An omitted `chanceOfPlacementAttempt` is read as 1.** Whether the loader leaves an absent
float at C#'s `0f` or the class initialises it to `1f` is not something this repo can
establish, and reading it as 0 would report every hand-written minimal element as broken. A
warning that fires on correct files teaches the reader to ignore the section, so only a
stated `0` counts. This is the one known gap in the check.

The city-wide warning is scoped to the mod's own presets. A cluster whose slots are filled
entirely by shipped furniture is city-wide too, but the remedy — `onlyAllowInFollowing` with
`allowedInAddressesOfType`, or `OnlyAllowInBuildings` with `allowedInBuildings` — goes on the
preset, and telling an author to gate the base game's presets is not advice worth giving.

The block is deliberately **not** a `.status-block`. The two blocks under it keep the same
five rows in the same order, and both test suites read them positionally.

### Where the data comes from

`refs/derived/furnitureChain.json`, fetched once per page — 188 KB, about 20 KB over the
wire — and filtered in the browser per room. It is derived from a dump of nine
ScriptableObject types by `tools/buildFurnitureChain.js`; see `refs/README.md` for who owns
it and how to regenerate it.

`furnitureChain.unit.spec.js` resolves every room of all 93 base game floors: 1,399 produce
a list, and the seven that do not are pinned by name. Six are outdoor layouts, which are
not furnished from a room class. The seventh is `FathomsLobby`, which no address preset
lists as compatible — the condition the game logs `No address preset shortlist for …` for,
and falls back to its lobby preset. The panel says so rather than showing an empty list.

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

A preset new to the mod is written as `<Name>.BuildingPreset.sodso.json` — the building,
then what it is. The type is there because a name alone does not identify an asset, and
it is the file's name and nothing else's: the flow deals in bare building names
throughout, and `assetNameOf` takes the type back off whatever a folder happens to hold.
See `core/soFileName.js`. A building already in the mod is written back into the file it
came out of, whatever that is called, so a mod written before that convention keeps its
`<Name>.sodso.json` rather than having its files move under a save nobody asked for.

Every preset written is also named in the mod's `murdermanifest.sodso.json`, which is
written for a mod that has none. `fileOrder` is what the loader reads a `.sodso.json`
through — an unlisted preset is one the game never loads, which in game is a building
that is simply not in the city and nothing anywhere saying why. The entry names the
*file*, so it carries the type the file name carries. That happens in
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
generated — see *Generating the building's model*.

## The Floor section

Top of the right-hand column: which storey of the building is open, its blueprint's name,
and the way to the rest of it.

The arrows move a **storey** at a time, lowest first — `basementLayouts[0]` is the storey
immediately below the ground floor, so down from Floor 0 is Basement 1. A storey is one
floor setting, and the blueprints in it are alternative layouts the game picks between
when it builds the city; the **Layout** select below is how those are reached. Stepping
through the slot list one at a time would walk sideways through a storey's own layouts and
call it climbing — see `storeysOf`.

A storey is named by the floors of the building it covers, not by its place in the setting
list. `floorsWithThisSetting` means "the next N floors look like this", so the two are not
the same count: Hotel's settings read `[1, 1, 1, 1, 1, 4, 1, 2]`, which is a twelve storey
building whose sixth setting is **Floors 5–8** and whose eighth is **Floors 10–11**.
Numbering the settings instead called that top setting Floor 7 and left the building four
floors shorter than it is. Basements count from 1 downwards — there is no Basement 0,
because the floor in that place is Floor 0. See `storeyName`.

Which storey is open is decided by the slot the floor was opened through, not by its name.
Nothing stops a building listing one blueprint in two slots.

## Adding and deleting floors

The Browse menu divides into **Custom** and **Vanilla**, and a building opens into its
storeys: one collapsible section per floor, holding the layouts of that floor. That is the
shape a building has — the blueprints in one setting are alternatives the game picks
between for the same storey — and listing every blueprint at one level said "twelve
floors" where the building has four.

Only the mod's own buildings carry the four buttons: **Add floor** and **Add basement**
at the foot of the building, **Add layout** at the foot of each of its floors, and **×**
on each layout. A base game building becomes a stub in the mod the moment its floor list
is written, and doing that from a delete button would be a mod gaining a building nobody
asked for.

**Add floor** writes `<Building>_Floor<n>` — the first number nothing has taken, checked
against the base game's blueprints as well as the mod's, since a mod floor named after a
base game one shadows it everywhere — puts it in a floor setting of its own, and opens it.

**Add basement** is the same thing downwards, into `basementLayouts` rather than
`floorLayouts`, and named `<Building>_Basement<n>`. The game counts one list up from the
ground floor and the other down from it, so which list a storey is in is where it is —
which is why this is a second button rather than a question. A basement is laid against
the deepest storey the building has, a floor against the topmost, and both ends are the
same stack: a building of basements gets its first floor laid against the one below it.

**Add layout** puts one on the end of a setting that is already there, and names it after
the storey rather than by the next free floor number: `<Building>_Floor0_v1` is a second
layout of Floor 0, where `<Building>_Floor3` would name a floor the building has not got.
Never a control room variant — those are the same layouts with a control room in them,
which is not something that can be made out of a blank floor.

None of them starts as an empty grid unless that is what was asked for.

**Add layout** copies the storey's first blueprint whole, under the new name — addresses,
rooms, node heights, stairwells and entrances, and each address's other variations. The
blueprints in one setting are the same storey drawn more than once, so the second is
written by altering the first. Copied verbatim rather than rebuilt, so duplicating a base
game floor writes back the file the game shipped. See `floorCopy`. It is the one that is
not asked about: anything less than the whole storey would be a different storey wearing
its number.

**Add floor** and **Add basement** ask, because there is no one right answer — a tower's
floors are mostly the same shape with different rooms in them, its lobby is not, and its
roof is neither. The dialog names the storey it would copy from, and offers four answers:

| Answer | What comes across | |
|---|---|---|
| Copy it whole | Everything, as Add layout does | `floorCopy` |
| Its walls, stairs and entrances | Walls, and the tiles holding stairwells and doorways. The default | `floorLike`, `{ tiles: true }` |
| Its outline only | The walls between inside and out, without the partitions inside them | `floorLike`, `{ outline: true }` |
| A roof over it | Its shape, as a rooftop — see *Roof generation* below | `generateRoof` |
| Start empty | Nothing | `blankFloor` |

A roof is offered by **Add floor** and not by **Add basement**. Under the bottom of a
building it is not an answer that cannot be had yet, it is not an answer, so it is taken
away rather than dimmed.

Walls come across on all but the last because a building is one shape all the way up, so
its outline is not something to redraw per storey. Tiles come across by default because a
stairwell has to sit in the same tile on every storey it passes through. Rooms, addresses
and node heights never do: they are exactly what makes one storey differ from the next.
The outline answer is for the storey that is the same building and not the same plan —
the interior partitions of the floor below are a distraction on it rather than a start.

With nothing to copy from — the building's first storey — the copy answers are shown
disabled with the reason, and **Start empty** is the one left. It is the three-node margin
the city leaves between lots, which is not paintable and so could never be filled in by
hand, and inside it one `Lobby` room covering the lot, walled off from the margin with
`DefaultWalls`. See `blankFloor`.

The dialog is asked before anything is written, so dismissing it leaves the mod exactly as
it was.

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
  keptSelects.js      the panels' searchable selects, kept across a full redraw
  furnitureChain.js   what could spawn on a square, from the game's own chain
  furnitureOverlay.js the mod's own furniture assets, merged over the base game's
  ui.js               flow entry points
  meshExport.js       footprints, mesh, textures, window data
  pngWriter.js        PNG files, written a chunk at a time
tools/
  buildFurnitureChain.js   writes refs/derived/furnitureChain.json from a game dump
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
   was believed to stand in for each `DoorPairPreset`'s `sectionClass`. A dump of the assets
   says it does not: `sectionClass` groups WindowLargeRectangle with NothingWall and a
   wooden fence, because it describes where the opening sits in the wall panel's mesh rather
   than whether the section is glazed. So the table stays hand-written. Id 14 `WindowDiner`
   is now confirmed a window; **26 and 27 are still unconfirmed, and 1 `AlleyBlockWalls` and
   13 `RooftopVentilationVent` join them** — each shares a `sectionClass` with a preset the
   table classes the other way. None of the four appears in a base game blueprint, so
   nothing here can test them. One wrong entry shifts a whole side of a floor. See
   `refs/README.md` for the table of what is open and why.
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

## Roof generation

`DataBuilder.GenerateRoof`, in `scripts/roofGenerator.js`, reached from the Add floor
dialog. A roof is the one floor nobody draws: where the storey below is indoors there is
something to stand on and open sky over it, and everywhere else there is nothing at all —
so the shape of the building is the whole of the input.

| | |
|---|---|
| Address | one `VentedRooftop` per address that was indoors, in the order they were met |
| Rooms | one `Rooftop` room in each |
| Floor type | `floorOnly` under the roof, `none` everywhere else |
| Walls | `NothingWall` between squares in different addresses, and no other wall |
| Tiles | the storey below's, verbatim |
| Heights | flat: `f_h` is 0 everywhere |

The address division survives because it is the building's — two flats under one roof are
two lots of roof, and the game reads an address as a place. What does not survive is
everything describing the storey below: its rooms and their presets, its layout
configurations, its interior walls and its raised floors. A roof has edges rather than
walls, which is what `NothingWall` is: a division the game can still walk across.

Outdoor addresses are not roofed. A `Yard` or a `Park` is laid out and named and is still
open air, so nothing goes over it — the same question `floorLike` asks about where a
building's wall is, answered by the same list.

The tiles are the one thing carried whole. A stairwell has to sit in the same tile on
every storey it passes through and the roof is the last of them, which is what
`Eden_Rooftop` does; a building with no way onto its roof is one deleted tile away.

Checked against the rooftops the game ships — `DinerRooftop`, `ShantyTown_TowerRooftop`
and `Eden_Rooftop` — for the names and the floor types, and against all 93 of its floors
for the derivation being one the game could load: every square accounted for, both halves
of every wall, and written back out unchanged.

