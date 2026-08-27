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
| `assets/` | `DocumentationGenerator` | fetched at runtime, a file at a time |
| `floors/` | copied out of the game by hand — see below | fetched at runtime, a file at a time |

`generated/` and `assets/` are the generator's outright: it may delete and rewrite them
whole. Nothing hand-written belongs in either.

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

`soDoorPairIds.json` is index-addressed too, and the stakes are higher: a floor blueprint
stores each wall as the *string* form of its index, so `"7"` is `InteriorDoorway`. That
order is the game's own and not alphabetical, which is why `soAssetsByType.DoorPairPreset`
cannot stand in for it — it has the right 27 names and no way to say which is which.
Reordering this file does not change what a field means, it rewrites every wall in every
floor anyone has authored.

It is **not the generator's yet**. The file is transcribed from the reference tool's
`WallManager.DoorWindowPresets`, and `GENERATOR.md` §3 asks for it to be emitted properly.
Two things the transcription cannot settle:

- **Id 3 is absent** and ids **28–30** are named `Unknown01`–`03` in the reference. They
  are carried here as `null`, because the 27 names that *are* known are exactly the 27
  assets in `soAssetsByType.DoorPairPreset` — every real preset is accounted for without
  them, so the three are almost certainly not ids at all. Listed rather than dropped so
  the file can answer "is 28 known?" with "no", and so a regeneration that does find them
  is a visible change.
- **What each preset is** — wall, window, door or blank. That is the asset's
  `sectionClass`, which no generated file carries, so it lives in
  `authored/wallPresetKinds.json` below.

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
| `ddsTemplates.json` | the skeleton of a new tree, message, block and newspaper | `window.templates` |
| `basicTypeLayouts.json` | Unity's built-in types — `Vector2`, `Color`, `AnimationCurve` — in the same shape as `soTypeLayout.json`, which does not contain them | folded into `window.typeLayout` |
| `basicEnums.json` | `Boolean` and `WeightedMode`, which the generator does not emit | folded into `window.enums` |
| `fieldDescriptions.json` | prose descriptions of fields, keyed by type name, shown as tooltips | `window.fieldDescriptions` |
| `wallPresetKinds.json` | `DoorPairPreset` index → `wall` / `window` / `door` / `blank` | `window.wallPresetKinds` |

`window.templates` is shared with `generated/` on purpose: only one flow is active at a
time and the registry swaps the whole global surface on activation. See the `loadRefs`
note in `core/flowRegistry.js`.

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

`wallPresetKinds.json` is the one file here that wants to stop being hand-written. It says
whether a `DoorPairPreset` is a wall, a window, a door or nothing, which decides how the
building flow draws it and which walls count as windows when generating a building's
window data. The real answer is the asset's `sectionClass` field; until the generator can
carry it, this is a transcription of the reference tool's second hand-written table, and
that table flags **ids 14, 26 and 27** as unverified. Getting one wrong costs a wall drawn
as the wrong shape and, for a window, a block of window UV data that should not be there —
not corrupt saved data. Keyed by index to match `soDoorPairIds.json`; ids with no name
there have no entry here either.

One entry deliberately disagrees with the reference tool. It calls **id 11,
`NothingWall`, a wall**; it is a blank, and is recorded as one here. That is the kind of
correction this file exists to hold until `sectionClass` makes it unnecessary — and the
reason the disagreement is written down rather than silently applied is that the next
person to compare the two tables will otherwise read it as a transcription error.

`ddsEnums.json` was here and is gone. It listed the DDS field enums by *field* name, which
could never reach an array's elements, and it had drifted from the game: index 6 of
`triggerPoint` was `newspaperMurder` where the game has `newspaperArticle`, so the editor
stored 7 — `onGameStart` — for anyone who picked it. `soEnums.json` is generated from the
assemblies and is now the only source.

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
