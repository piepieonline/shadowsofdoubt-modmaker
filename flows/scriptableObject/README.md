# Shadows of Doubt - Community Case Builder

This is a basic tool to build scriptable objects for the game, with a particular focus on enabling the creation of new murder case variants, to be loaded by the [CommunityCaseLoader](https://thunderstore.io/c/shadows-of-doubt/p/Piepieonline/CommunityCaseLoader/).

Instructions for use found on the wiki.

http-server -c-1 -S

To add a new data type for online reference:
Modify the documentation generator's onlineTypes, which is written to `refs/assets/index.json`.

## The file list

Everything in the content folder, grouped by type — not only what the manifest names.
Search it by typing part of a name or of a type.

**Filter**, beside the search box, is what to reach for once the folder has rooms in it.
Building one room patches every furniture cluster and preset it admits, every material
filter it takes a surface from, and every light it uses, and none of those files is about
the room:

| | What it leaves out |
|---|---|
| Exclude room permissions | `FurnitureCluster` and `FurniturePreset` overrides that do nothing but change `allowedRoomFilters` |
| Exclude surface and lighting permissions | `RoomTypeFilter` overrides that only add a room class, `RoomLightingPreset` overrides that only add a configuration |

An override that changes anything else is never hidden, and neither is an asset the mod
defines — a cloned cluster of your own stays on the list. The line under the box says how
many files are being held back, and choosing another mod clears the filter.

## Field summary

**Tools ▸ Summarise a field…**, then click a field in an open document: a table of every
value that field takes across every asset of its type, and which assets take each one.
The game's own assets and this mod's are counted together, and where the mod overrides a
shipped asset the mod's version is the one counted — that is the one the game loads.

A path running through a list is answered per element, so `MurderMO.MOleads[].chance` reads
one value per lead rather than one per asset. The `[]` in the dialog's heading is what says
so. A field the path ends at is one value, whole.

While the mode is on, a click picks rather than opens a node up: ctrl-click, or ⌘-click,
still opens one — and opens everything below it, which is how a field several levels down
is reached.

The same reach as everything else here: nine types can be read as shipped, every type with
your exported ScriptableObjects folder connected. Whatever it could not read, it says.

## Overrides

A `*.sodso_patch.json` changes one of the base game's assets. It is written as the list of
changes to make to that asset, which the loader applies before deserialising:

```json
{
  "name": "PaperCeilingLightBright",
  "fileType": "RoomLightingPreset",
  "patches": [
    { "op": "add", "path": "/roomCompatibility/-", "value": "REF:RoomConfiguration|BankATMVestibuleRC" }
  ]
}
```

RFC 6902, plus `[field=value]` wherever an array index can stand — a key match still finds
the same element after the game renumbers a list, and says so loudly rather than editing
the wrong one when it cannot. Files written in the older whole-field format still load, and
still open here; saving one converts it, and you are asked before it does.

None of this is on screen. An override is edited as the asset it overrides, in full, and
what reaches the file is the difference. **Hide Default Values** there means "hide what I
have not changed".

The catch is that a difference needs something to differ from, so authoring an override
needs the asset to be readable: every type if you have connected your exported
ScriptableObjects folder, and otherwise the nine types under `refs/assets/`. The New File
dialog says so rather than creating a file that cannot be opened again.

## Furniture Creator

Furniture is three assets, and the one you name is not the one that decides behaviour:

```
FurnitureCluster  ->  FurnitureClass  ->  FurniturePreset
the arrangement       the slot            the model
```

A cluster puts slots down at tile offsets; each slot names one class; every preset carrying
that class competes for it in a uniform draw. So what a thing *looks like* is decided at the
preset, *where it may stand* at the class, and *what stands beside it* at the cluster.

The pane shows all three at once, because the hop between them is the one no file states: a
preset names classes and a cluster names classes, and nothing points from one to the other.
"This is a 3x1 lobby desk, so it appears in these arrangements" is what an author comes here
to find out.

Beside it, the model's sub-objects — the mug on the desk, the lamp on the side table — drawn
where the game puts them, in metres from the model's origin. And under those, what is
*built into* it: the interactables that decide what a citizen can do with the thing.

The pane writes. A save comes to three files — the preset, a class whose only member is that
preset, and a cluster that puts the class down — and it merges into whatever is already
there rather than rebuilding it, so a field this pane has no control for survives untouched.

### What the 3D view can and cannot show you

The positions are the game's. **The box under them is not.** A shipped model is a Unity
prefab inside an asset bundle this app cannot open, so what is drawn is a wireframe the size
of the footprint its class declares — scaffolding to read positions against, drawn as edges
precisely so it cannot be taken for the model.

A sub-object with a `parent` is the case worth knowing about. It hangs off a named transform
*inside* the prefab — `TopDrawer`, `VintageFridgeDoor` — so its position is relative to
something unreadable here, and where it really sits is not knowable. 127 of the game's 1,504
sub-objects are like this. They are listed with the transform they belong to, and left out of
the view until you ask for them; the toggle then draws them at the model's origin, which is
somewhere they are not.

### What it says out loud

Each of these fails silently in game — the object is simply absent, and the only sign is a
line in a log:

| | |
|---|---|
| in no furniture class | no cluster has a slot it can fill |
| no room filters | no room class admits it; a clone brings the donor's |
| not universal, styles that do not overlap | never drawn in that room's decor |
| `minimumRoomSize` of 99 | what a from-scratch preset is left holding, and larger than most rooms |
| two slots on one tile | the second fires whatever model won the first, so drawers spawn inside a desk with no knee-hole |

### What is built into it

Stages 1 to 4 of the chain put a *model* in a room. Stage 5 decides what anybody can do with
it: work at it, sit at it, hide in it. That is `integratedInteractables` on the preset, and
each entry is three fields.

| | |
|---|---|
| `preset` | the `InteractablePreset` to create |
| `pairToController` | which `InteractableController` **in the prefab** gives it a position |
| `belongsTo` | `nobody`, `anybody`, or `person0`… — an index into the furniture's owner map |

`pairToController` is the constraint that makes this a *prefab* question. The interactable
is not spawned in the room; it is created at a controller inside the model and looked up
there by id. Miss, and it is not an error — the game logs one line and creates the thing at
the model's origin, which is inside the desk rather than on it.

So the ids that can be used are whatever the model already has, and whether this app can
know them depends entirely on which kind of prefab it is:

| Prefab | |
|---|---|
| a shipped `GameObject` | inside an asset bundle nothing here can open — **listed, read-only** |
| a `PREFAB:` path to a `.sodprefab.json` | the controllers are in the file — **editable** |

A `.sodprefab.json` declares them as components, alongside the mesh and the colliders:

```json
{ "name": "HidingPlace",
  "position": [0, 0.4, -1.8],
  "components": [
    { "type": "BoxCollider", "size": [0.58, 0.72, 3.6], "isTrigger": true },
    { "type": "InteractableController", "id": "hidingPlace" } ] }
```

The picker then offers exactly those ids and `none`, and each interactable gets a marker in
the 3D view where its controller stands. The marker has no nose on it, unlike a sub-object's:
a controller supplies rotation as well as position and this app reads only the position, so a
marker that pointed somewhere would be claiming something nothing was read from. They are not
draggable for the same reason — the position belongs to the prefab, and moving one means
editing that file.

The mesh is not part of this. A prefab whose `.obj` has not been exported yet still answers
the only question being asked, so the list stays editable and the model note says the rest.

#### What the section says out loud

Every one of these is silent in game:

| | |
|---|---|
| paired to a controller the prefab has not got | one log line, and the interactable at the origin |
| paired to `none` | the entry is skipped outright and creates nothing |
| the prefab declares an id that is not an `InteractableID` | nothing can ever pair to it |
| the prefab declares no controllers at all | nothing here can be positioned |
| two entries on one controller | both created at the same point |
| `personN` past the class's `assignBelongsToOwners` | `Could not find interactable owner for index N` — the worker gets no work position |

That last one is the two-files-must-agree trap: `HotelDesk` pairs the same preset to `A` and
`B` as `person0` and `person1`, and its class `3x1LobbyDesk` has to set
`assignBelongsToOwners: 2` to match. Neither file mentions the other.

#### It replaces, it does not add

`integratedInteractables` overwrites the donor's list wholesale, the way `clusterElements`
does — so a preset that states the field states all of it. That is why the list on screen is
the donor's *already resolved*, and why saving writes every entry back rather than only the
ones that were touched. Adding one interactable to a cloned preset means re-listing the
donor's, and this does that for you.

### Placement mode

The other half of the pane, and the other question about the same piece: not what it is, but
where it may stand. That is the `FurnitureClass`, and it is written as offsets from one
anchor tile — which makes it a diagram, and is why it is hard to author as a list of
`{offset, direction, tag}` rows.

So it is drawn as the grid it is written on. Tiles, with the rules on the edges between
them:

| | |
|---|---|
| a solid mark | must have this, or the piece is not placed |
| a red mark | must not have this |
| a dotted mark | prefers this — adds to a placement score and never refuses |
| a dashed outline | a gate the game applies and this app cannot check |
| an inset border | a way out of the tile the piece closes once it is there |
| a filled tile | the footprint — a tile the piece stands on |
| a hatched tile | the model reaches here and the class does not declare it |

**Front is up.** Every offset and direction is in the furniture's own frame, and the
generator tries all four quarter turns of it — so the diagram is the one the author wrote
rather than a compass bearing. A rule naming `behind` is about the piece's back.

Three things are under the grid rather than on it, because they are not about a tile:
what the piece blocks once placed (an effect, not a gate), the minimum distance it keeps
from other classes (measured through the room — a diagonal step is about 1.8), and how many
of its tile's four edges must be walled.

#### How big it is, and where the model falls outside that

The footprint is a field above the grid, in nodes. The anchor is the piece's *front-right*
node and the body reaches back and to its left, so a 3×1 desk covers `0,0`, `-1,0` and
`-2,0` — it is not centred on the anchor, and which end is the far end is the thing you need
to know before deciding what to block.

Negative, and that is not a quirk of the drawing: the generator lays a footprint down two
quarter turns from the angle it reads every rule at, so a class states rules about its own
nodes at negative offsets. The shipped `2x1Sofa` asks for a wall behind `0,0` and `-1,0`,
which are its own two.

Where the mod supplies its own prefab, the mesh is measured against that footprint and the
tiles it reaches into are hatched. **The game never checks this.** Placement is decided from
`objectSize` alone, so an overhanging model is placed anyway and then clips whatever the
generator stood next to it — no failed placement, nothing logged. Widen the footprint, or
close those ways out.

Export the `.obj` as a standard right-handed model — do not pre-mirror it. The mod loader
negates x on the way in, so in the file a 3×1 desk runs from `-0.9` to `+4.5` on x and sits
flush to the floor at `y = 0`. A file already in the game's coordinates loads mirrored, with
the anchor on the wrong side.

#### Editing

Click a tile to mark it, then press its **+** to put a rule on that tile. The rule starts as
a wall rule — 233 of the 262 classes have one — and the *This one is about* select turns it
into either of the other two:

| | |
|---|---|
| the walls around this tile | what must or must not be on an edge |
| what is already standing on this tile | a named class, or `*` for anything at all |
| the ways out of this tile it closes | not a placement rule; what standing here does to the room |

That select is how the last two are reached at all. A class with no occupancy rule has none
to click, so before it there was no way to write a first one — "will not be placed if
anything at all is there" was unwritable, and so was a closed way out.

Editing matters beyond convenience: a class written as a bare `copyFrom` brings the donor's
rules **including node rules that still name the donor**, which fails silently in game.
Stating the rules replaces that list whole, so a class written from Placement mode does not
carry it. The footprint is stated for the same reason — left off, a copy keeps the donor's
size, which is a 1×1 desk where a 3×1 one was drawn.

### Where the data comes from

Your **exported ScriptableObjects folder**, an asset at a time — and the list of what is in
it comes from the folder itself rather than from this tool's generated tables, so furniture
a newer game added is offered rather than sitting on disk invisibly. There is no trimmed
copy of furniture in this repo: opening a piece reads its own file and the handful its fields name,
about a dozen files, and every field the game has is there whether or not anything here was
written to expect it. Connect the folder under **Folders** — without it there is nothing to
read, and the pane says so rather than showing an empty preset.

One question is not about a single asset. Nothing points from a preset to the clusters it
appears in, so answering it means reading every cluster — that is behind a press that says
what it costs, and is kept for the rest of the session once done.

The mod's own files shadow the game's, which is what the loader does with them: a preset or
class in the content folder replaces the shipped one of that name.
