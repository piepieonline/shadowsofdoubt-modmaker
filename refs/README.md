# Reference data

Everything the editor knows about the game before you open a mod: what types exist, what
fields they have, what the base game's DDS content is called. One copy, at the repo root,
read by whichever flows need it.

It used to be a folder per flow. `ddsMap.json` was written into both and read by both, and
by the time they were merged the two copies were a hundred blocks apart — the answer to
"is this GUID a tree?" depended on which editor you happened to have open. That is the
duplication this folder exists to prevent.

## Layout

Folders are split by **who writes the file**, because that is what tells you whether you
may edit it.

| Folder | Written by | Loaded |
|---|---|---|
| `generated/` | `ShadowsOfDoubtMods/DocumentationGenerator` | imported as JSON modules |
| `authored/` | people, by hand | imported as JSON modules |
| `derived/` | a tool in this repo, from a dump of the game — see below | fetched at runtime |
| `assets/` | `DocumentationGenerator` | fetched at runtime, a file at a time |
| `floors/` | copied out of the game by hand — see below | fetched at runtime, a file at a time |

`generated/` and `assets/` are the generator's outright: it may delete and rewrite them
whole. Nothing hand-written belongs in either.

**There is currently one exception, and it is meant to be temporary.** `soTypeLayout.json`
has had inherited fields patched into it by hand, because it records only the fields a type
declares itself and the editor resolves every field through it — so `presetName`, a DDS
document's `name` and `id`, and `BossConfig.occupation` all resolved to nothing. The next
regeneration undoes it. `core/refs.unit.spec.js` fails when it does, and
[GENERATOR.md](GENERATOR.md) section 8 carries the map that was applied.

The same file also lists two fields the game marks `[NonSerialized]` and never writes —
`DDSTreeSave.messageRef` and `citizenAddCount`. Those are named in the DDS flow rather than
edited out of the file, so a regeneration cannot silently put them back into a document.
See section 8a, and `NOT_WRITTEN_TO_A_FILE` in `flows/dds/scripts/elementTemplates.js`.

`floors/` is the exception to that split, and an uncomfortable one: it is game data that
nobody generates. It is called out where it sits rather than filed under `authored/`,
because nothing in it was authored — it was copied.

Not everything here is read yet — `ddsScopes.json` is kept for work that has not been
built. That is fine as long as the table below says so, which is the actual lesson from
this data having drifted for a year: an unused file is only a problem when nothing records
whether it is unused on purpose.

## `generated/`

| File | Holds | Published as |
|---|---|---|
| `ddsContentIndex.json` | base game DDS content: tree/message/block GUIDs, GUID→name, and the reverse containment map | `window.ddsMap` |
| `soTypeLayout.json` | every ScriptableObject type's fields: type, is-array, official description | `window.typeLayout` |
| `soAssetsByType.json` | type → the names of the base game assets of that type | `window.typeMap` |
| `soEnums.json` | enum name → its values, in index order | `window.enums` |
| `soDefaults.json` | type → the default value of each field, which is what a new file starts as | `window.templates` |
| `soPathIds.json` | Unity `pathID` → asset name, for rewriting `m_FileID` references into `REF:` | `window.pathIdMap` |
| `soDoorPairIds.json` | `DoorPairPreset` index → name, which is how a floor blueprint stores a wall | `window.doorPairIds` |
| `ddsScopes.json` | the DDS substitution grammar: which scopes exist (`citizen`, `object`, `evidence`, `city`, …), what each contains, and the values each exposes | **nothing yet** |

`ddsScopes.json` is the one file here nothing reads. It describes what a `[citizen.job.name]`
token in block text may legally say, so it is what an autocomplete or a validator for those
tokens would be built on. Kept deliberately, pending that.

`ddsContentIndex.json`, `soTypeLayout.json` and `soEnums.json` are read by **both** flows.
A DDS document is an ordinary serialised game type: a tree is a `DDSTreeSave`, its messages
are `DDSMessageSettings`, its `treeType` is a `TreeType`. So both flows resolve a field the
same way, through `core/typeHints.js`, and neither keeps a table of its own.

Enum values are addressed **by index** — the game serialises these fields as integers, so
reordering one silently rewrites every mod that uses it.

Which makes one thing about `soEnums.json` worth knowing before you read a value out of it:
202 of its enums appear twice, once under a type name and once under a field name, and the
field-name copy is in *alphabetical* order rather than the game's. `FloorTileType` starts
with `none`, as the game does; its twin `f_t` starts with `CeilingOnly`, and every index
read from it after the first divergence means something else. Look enums up by type name.
Nothing in the app does otherwise — both editors resolve through `soTypeLayout.json`, which
names types — but the two sit side by side in one namespace once `core/refs.js` merges
them. `GENERATOR.md` §9a asks for the sorted half to go.

`soDoorPairIds.json` is index-addressed too, and the stakes are higher: a floor blueprint
stores each wall as the *string* form of its index, so `"7"` is `InteriorDoorway`. That
order is the game's own and not alphabetical, which is why `soAssetsByType.DoorPairPreset`
cannot stand in for it — it has the right 27 names and no way to say which is which.
Reordering this file does not change what a field means, it rewrites every wall in every
floor anyone has authored.

It is **not the generator's yet**. The file is transcribed from the reference tool's
`WallManager.DoorWindowPresets`, and `GENERATOR.md` §3 asks for it to be emitted properly.
Two things the transcription could not settle, both since checked against a dump of the
`DoorPairPreset` assets:

- **Id 3 is absent** and ids **28–30** are named `Unknown01`–`03` in the reference. The
  game has 27 of these assets, ids 0–2 and 4–27, so the gap is real and 28–30 are nothing.
  They are carried here as `null` so the file can answer "is 28 known?" with "no"; a
  regeneration may drop them.
- **What each preset is** — wall, window, door or blank. This was expected to be the
  asset's `sectionClass`. It is not: `sectionClass` groups WindowLargeRectangle with
  NothingWall and a wooden fence, so it describes the wall panel's mesh rather than its
  glazing. The question stays with `authored/wallPresetKinds.json` below.

### What the layout cannot type

`soTypeLayout.json` has no inheritance metadata, so a type's inherited fields are absent
from its entry. For DDS that means **`name` and `id`**, which every document inherits from
`DDSComponent`: they resolve to nothing, get no tooltip, and are edited as text. They are
strings, so nothing is lost beyond the description — but a base-type link from the
generator would close it for every type at once. See `GENERATOR.md`.

Two more fields are in the templates and not in the layout, and are untyped for the same
reason: `DDSBlockCondition.forceScope` and `NewspaperArticle.possibleImages`.

## `authored/`

| File | Holds | Published as |
|---|---|---|
| `ddsTemplates.json` | the skeleton of a new tree, message, block and newspaper — `DDSSaveClasses`' own field initialisers, nothing else | `window.templates` |
| `baseGameStringsFiles.json` | a copy of the game's `Strings/English` folder listing: its 130 CSVs as paths, without the `.csv` | `window.baseGameStringsFiles` |
| `basicTypeLayouts.json` | Unity's built-in types — `Vector2`, `Color`, `AnimationCurve` — in the same shape as `soTypeLayout.json`, which does not contain them | folded into `window.typeLayout` |
| `basicEnums.json` | `Boolean` and `WeightedMode`, which the generator does not emit | folded into `window.enums` |
| `fieldDescriptions.json` | prose descriptions of fields, keyed by type name, shown as tooltips | `window.fieldDescriptions` |
| `wallPresetKinds.json` | `DoorPairPreset` index → `wall` / `window` / `door` / `blank` | `window.wallPresetKinds` |

`window.templates` is shared with `generated/` on purpose: only one flow is active at a
time and the registry swaps the whole global surface on activation. See the `loadRefs`
note in `core/flowRegistry.js`.

`ddsTemplates.json` is the game's class initialisers and stops there — what
`new DDSTreeSave()` holds, field for field, which is why the layout cannot produce it: the
layout gives a type and no value, so anything built from it is `0`/`false`/`""` and
*overrides* an initialiser that is not zero. `flows/dds/scripts/elementTemplates.js` keeps
that pairing honest and its spec fails when a field goes missing.

What the template deliberately does **not** hold is anything that depends on which of the
six kinds of tree is being made. A `DDSTreeSave` is a conversation, a v-mail, a document, a
newspaper column, a message library or a dialog chain, and one skeleton can only be one of
them — it used to be a v-mail, so five kinds out of six came out set to a `treeType` and a
`triggerPoint` the game would never dispatch them on. That half lives in
`flows/dds/scripts/treeKinds.js`, applied over the template at creation.

`baseGameStringsFiles.json` is authored only in the sense that a person typed it in.
Nothing in it was decided here: it is `Strings/English` as the game ships it, read off a
listing of that folder and reduced to one path per line, with `LanguageSettings.txt`
dropped because it is not a CSV. It is what the DDS flow's "Add new..." dialog offers as
the file a new strings CSV is to be, grouped by the folder each path sits in.

Being a copy, it goes stale the way `floors/` does: a game update that adds a strings file
leaves this listing short, and nothing here will notice. What that costs is bounded, and
deliberately so — the dialog takes a typed path as well as a picked one, so a file this
list has never heard of is still reachable, and so is a path the base game has no
equivalent of at all. Refresh it by listing the game's `Strings/English` again.

`fieldDescriptions.json` covers both flows — a DDS type name is a key like any other. The
game's own descriptions are in `soTypeLayout.json`, and are near-absent for the DDS types
(1 field in 97), so anything useful there has to be written here. It is also the source for
the wiki page generated by `flows/scriptableObject/tools/GHWiki_SODescriptions.js`.

`basicTypeLayouts.json` and `basicEnums.json` are hand-written because they describe
Unity and the CLR, not the game: the generator reflects over game assemblies and never
sees these. Both flows need them — a DDS message's `pos` is a `Vector2` and its `col` a
`Color`, and without an entry the `x`/`y` and `r`/`g`/`b`/`a` underneath resolve to
nothing. `Boolean` is what makes a true/false field a dropdown rather than a box you have
to type `false` into.

Both are folded into the shared tables in `core/refs.js`, which is where each flow reads
its `enums` and `typeLayout` from. That composition used to be per-flow, which is how the
two came to disagree about `Boolean`.

`wallPresetKinds.json` wanted to stop being hand-written, and looks as though it cannot.
It says whether a `DoorPairPreset` is a wall, a window, a door or nothing, which decides
how the building flow draws it and which walls count as windows when generating a
building's window data. Getting one wrong costs a wall drawn as the wrong shape and, for a
window, a block of window UV data that should not be there — not corrupt saved data. Keyed
by index to match `soDoorPairIds.json`; ids with no name there have no entry here either.

The real answer was expected to be the asset's `sectionClass` field, and a dump of the
assets says it is not. `sectionClass` sorts a section by where its opening sits in the wall
panel's mesh, so class 2 holds WindowLargeArch and WindowLargeRectangle alongside
NothingWall, WoodenFence, Bannister01, DecoHandrail and AlleyBlockWalls, and class 5 holds
WindowSmallLower alongside RooftopVentilationVent. No mapping from those seven classes onto
these four kinds exists. `GENERATOR.md` §3 records every value.

What the dump does settle is **id 14, `WindowDiner`** — class 1, which contains nothing but
windows. **Ids 26 and 27** remain open, and two entries nobody had questioned join them:

| id | preset | table says | `sectionClass` | why it is open |
|---|---|---|---|---|
| 26 | WindowSmallWithUpperSpace | window | 4 `ventUpper` | class holds only windows, but nothing confirms `ventUpper` is glazed |
| 27 | WindowSmallLowWithUpperSpace | window | 5 `ventLower` | shares its class with RooftopVentilationVent |
| 1 | AlleyBlockWalls | wall | 2 `windowLarge` | shares its class with two windows |
| 13 | RooftopVentilationVent | wall | 5 `ventLower` | shares its class with two windows |

None of the four appears in any base game blueprint, so no test reaches them: flipping
1, 13 or 14 to `window` leaves the mesh suite at 76 passing. The rule that fits every
other entry is `sectionClass ∈ {1, 2, 4, 5} and not isFence`, which would make windows of
ids 1 and 13. Whether that rule is the game's is unresolved — it needs
`NewFloor.AssignWindowUVData` itself.

One entry deliberately disagrees with the reference tool. It calls **id 11,
`NothingWall`, a wall**; it is a blank, and is recorded as one here. The reason the
disagreement is written down rather than silently applied is that the next person to
compare the two tables will otherwise read it as a transcription error.

`ddsEnums.json` was here and is gone. It listed the DDS field enums by *field* name, which
could never reach an array's elements, and it had drifted from the game: index 6 of
`triggerPoint` was `newspaperMurder` where the game has `newspaperArticle`, so the editor
stored 7 — `onGameStart` — for anyone who picked it. `soEnums.json` is generated from the
assemblies and is now the only source.

## `derived/`

Neither generated nor authored: computed here, from game data, by a script that lives with
the flow that reads it. The folder exists because the ownership split above has no room for
that third case, and filing it under either of the other two would say the wrong thing
about who may edit it — nothing here should be touched by hand, and nothing here is the
generator's to overwrite.

| File | Holds | Written by | Read by |
|---|---|---|---|
| `furnitureChain.json` | how the game decides what furniture a room gets: address presets, room configurations, room type filters, furniture clusters, classes and presets, plus what each wall preset is, trimmed to the fields the editor filters on | `flows/building/tools/buildFurnitureChain.js` | `flows/building/scripts/furnitureChain.js` |
| `roomCreator.json` | the gates the square walk does not read: every cluster gate below the room class, design-style and wealth limits, per-room and per-address caps, which filters supply materials, what a room configuration passes on when it is copied, and which lighting presets accept it | `flows/building/tools/buildFurnitureChain.js` | the room creator, in the ScriptableObject flow |
| `furnitureCreator.json` | what a piece of furniture is rather than whether it may be placed: the model each preset names, the sub-object slots on it and where they sit, the interactables it instances, where each cluster element stands and which way it faces, the prop classes a slot can hold, and the placement rules that score or cannot be checked rather than gate | `flows/building/tools/buildFurnitureChain.js` | the furniture creator, in the ScriptableObject flow |

All three are the **base game's** alone. What the building flow actually answers against is
this with the selected mod's own assets merged over it — see
`flows/building/scripts/furnitureOverlay.js`, which reads them from the content folder at
runtime and never writes here.

### One dump, three files, no field in two

The three come out of one run of one tool, and that is deliberate. They answer different
questions about the same thirteen types: the building flow asks what could spawn on a square
and filters on the handful of gates a blueprint records; the room creator asks what a room
admits once an author has stated the floor, the wealth and the address kind, so it needs the
thirty-odd gates below that, plus materials and lighting; the furniture creator asks what is
actually there once something has been placed, which is geometry and nothing else filters on.

Splitting them keeps the pointer-move path cheap — the building flow does not fetch the
half it never reads — and running one tool keeps the two from disagreeing about what the
game contains. Two readers of one dump is how `ddsMap.json` came to have two answers.

**No field appears in two of the files**, which is the rule that makes them safe to join. A
cluster is `furnitureChain.clusters[name]` merged with `roomCreator.clusters[name].gates`;
`disable` and the room-size bounds live only in the first, and everything else only in the
second. Its elements are read zipped with `furnitureCreator.clusters[name].elements` —
same order, same length, both being `clusterElements` read in order. A name that resolves in
one file and not another is a bug in the tool.

`furnitureChain.json` is derived from a dump of thirteen ScriptableObject types — 1,538
files and 8 MB — reduced to 233 KB, about 21 KB over the wire, with `roomCreator.json` a
further 124 KB and 11 KB, and `furnitureCreator.json` 206 KB and 30 KB. That reduction is
the reason they exist: the building flow answers "what could spawn on this square" on every
pointer move, and neither the dump nor a fetch per hover can be in that path.

`roomCreator.json` compresses the same way, against `_gateDefaults` and `_classDefaults` at
the top of the file. Those tables are the **commonest value of each field across the shipped
assets**, computed by the tool — not the game's own field defaults, which the dump does not
carry. So absent means "whatever the table says", never "unset". Two gate fields never
deviate at all (`maximumGrub`, `onlySkipNoInhabitantsIfResidenceOrCompany`), which is worth
knowing before either is read as meaningful.

Two things the room creator needs and this file deliberately does not hold, because both are
computable from what is already here and a stored answer is a second thing to keep true:
a cluster's furniture closure, which inverts `furnitureChain.furniture[].classes`; and
whether a filter gates furniture as well as materials, which is whether any cluster or
preset names it.

**Asset names are the game's, not a URL's.** Four assets have a space in the name —
`OldTelevisionLarge 1`, `DrinksCoolersX2 1`, `MarketStandX2 2`, `SupermarketFrigeUnitsX3 2`.
The tool used to key them by the percent-encoded href it found them at over HTTP, so the
file disagreed with itself depending on which source it had been run against, and those four
were unmatchable by any lookup. `readType` decodes now, and
`furnitureChain.unit.spec.js` fails if an escape ever reappears.

Several of `furnitureChain.json`'s fields are written **only when they are not the
default**, which is what keeps it that size: `chance` and `zeroScale` on a cluster element,
`at` on a wall rule, and the whole of `size`, `stairwell`, `noFloor`, `diagonal` and the
floor limits on a class.
There are 1,139 elements across the 399 clusters, and stating both of theirs every time
would add 32 KB to say "normal" over and over. Absent means a chance of 1 and a non-zero
scale. Absent does *not* mean healthy — 18 elements state a chance, and 16 of those are a
deliberate 0.5, 0.8 or 0.9. Only the two at 0 are a mistake, and `clusterWarnings` in
`furnitureChain.js` is the one place that judgement is made.

The `walls` block is what each `DoorPairPreset` is — its section class, and whether it is a
divider or a fence — keyed on the id a blueprint stores in an edge. It exists for the wall
rules on a class to be read against, and it is **not** `authored/wallPresetKinds.json`
under another name. That table says what a wall looks like, for drawing it; this says what
the generator sees. They disagree about dividers, and each is right about its own question.

`furnitureCreator.json` compresses the same way and for the same reason. On a cluster
element, absent `at` is the anchor node — 410 of the 1,139 — and absent `facing` is `down`,
which 803 are; the fine `offset` and `scale` appear 32 and 91 times. On a sub-object,
`parent` and `security` are written only when set.

Its `classes` block is the half of a `FurnitureClass` the chain file does not carry, and the
split is by what a rule *does* rather than by who reads it. A rule that refuses a placement
is a gate and lives in the chain file, because the building flow applies it on every pointer
move; here are the 135 that only add to a placement score, the 9 whose tags no blueprint can
answer, and the three fields about what has already been placed nearby — `nodeRules`,
`blockedAccess` and `awayFromClasses`, plus the 18 custom node weights. Read joined, the two
are the whole of a class. 218 of the 262 carry something here.

Its positions and rotations are **rounded to a thousandth**, which is a tenth of a
millimetre and saves 88 KB across 1,504 sub-objects. That makes it a lossy read: a preset
written back out from this data carries the rounded numbers rather than the game's. Nothing
anyone can see moves, and it is still not a faithful copy of the asset.

The enums a wall rule is written in do **not** come from `generated/soEnums.json` — see
`flows/building/scripts/furnitureRules.js`, which says why that file cannot answer for
`WallRule` and where the declaration order comes from instead. The three
`furnitureCreator.json` resolves to names — `FurnitureFacing`, `SubObjectOwnership`,
`InteractableID` — are transcribed from the same source for the same reason, and
`FurnitureFacing` is a live instance of the problem: `soEnums.json` holds it twice, and the
copy keyed on the field name `facing` is alphabetised, which swaps `up` with `left` on 275
of the 1,139 elements. Resolving them in the tool means an app reading that file never
touches an index.

Regenerate all three against a dump served over HTTP or sitting on disk — one run writes
them:

```
node flows/building/tools/buildFurnitureChain.js http://<host>:<port>
node flows/building/tools/buildFurnitureChain.js /path/to/export
```

The dump is a folder per type holding one JSON file per asset. References in it are
`{m_FileID, m_PathID}` and are resolved through `generated/soPathIds.json`, so a
regeneration of that file has to come first — a pathID this repo cannot name is a
reference the tool silently drops.

**The dump itself is not in this repo**, which is the uncomfortable part, and the same
discomfort `floors/` has: it was served off a machine on a desk. What is checked in is the
output and the script that produced it, so the derivation is reproducible given the dump
and reviewable without it. `GENERATOR.md` §8 asks whether the generator should export
these ten types to `assets/` so the input stops being someone's local copy.

## `assets/`

Base game ScriptableObjects extracted from the game, so the asset explorer can show real
examples without the game installed. `index.json` lists which types are shipped; the rest
is a folder per type. Roughly 12 MB across 1500 files, which is why these are fetched one
at a time by URL rather than imported.

## `floors/`

The base game's floor blueprints and the building presets that reference them, for the
building flow.

| Path | Holds |
|---|---|
| `blueprints/` | 93 floor blueprints, one `FloorSaveData` per file |
| `buildings/` | 15 `BuildingPreset` dumps, which say which blueprints each building uses |
| `index.json` | the names in both folders, so neither has to be listed twice |

These ship with the app because they cannot be read from a user's install. Unlike DDS
content, which sits in `StreamingAssets` as loose files, floor blueprints are `TextAsset`s
inside asset bundles — a browser has no way in. So the choice is to ship them or to have no
base game floors to open, and 5 MB fetched a file at a time is the cheaper of those.

Fetched by URL like `assets/`, never imported, so nothing here is a page-load cost.

**Who wrote them:** not the generator. They were copied by hand out of
`ShadowsOfDoubt-FloorEditorUnity`'s `Assets/GameExports/`, which took them from the game.
A blueprint is kept byte-for-byte as the game emits it — one long line — so re-importing is
a copy and any drift shows up as a diff. `GENERATOR.md` §5 asks whether the generator can
reach them; until it answers, a game update that changes a floor is a change nothing here
will notice.

Two facts about the shape of a blueprint that the files themselves will not tell you,
because they hold only what happens to be true of the base game's 93:

- The node grid is **21 × 21** and the tile grid **7 × 7**. Six blueprints stop short of
  that in their first layout variation; those are nodes missing from the export, not a
  smaller floor, and the flow backfills them.
- An address may hold **several complete layout variations**, and the game picks one per
  floor at random. 117 of the 602 addresses here have more than one. Anything that reads a
  blueprint and writes it back has to carry the ones it is not editing, or it deletes
  layouts the game was relying on.

## Changing what the generator emits

`GENERATOR.md` in this folder is the contract: what the generator must write, under what
name, and what has changed since it last ran. Update it in the same change as the code
that reads the new shape.
