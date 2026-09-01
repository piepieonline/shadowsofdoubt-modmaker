# What DocumentationGenerator has to change

For `piepieonline/ShadowsOfDoubtMods/DocumentationGenerator`, which writes the reference
data this editor reads.

The Mod Maker merged the Case Editor and the DDS Viewer into one app, and this folder
merged their two reference-data trees into one. The generator currently writes for two
separate tools, to two export paths, with two copies of one file. This is what it needs to
write instead.

**Nothing here is urgent.** The repo holds a working copy of every file under the new
names, so the editor runs today. This matters at the next regeneration: run as-is, the
generator writes the old names into folders nothing reads, and the editor keeps quietly
using the checked-in copies.

---

## 1. One export path, not two

Today the generator writes to two configured paths:

| Variable | Was |
|---|---|
| `MURDER_BUILDER_DOC_EXPORT_PATH` | the Case Editor's `scripts/ref/` |
| `DDS_EDITOR_DOC_EXPORT_PATH` | the DDS Viewer's `scripts/ref/` |

There is now one editor and one destination. Collapse both to a single path pointing at
`<ModMaker>/refs/generated/`, plus a second for the extracted assets (§4).

Suggested:

| Variable | Points at |
|---|---|
| `MOD_MAKER_REF_EXPORT_PATH` | `<ModMaker>/refs/generated/` |
| `MOD_MAKER_ASSET_EXPORT_PATH` | `<ModMaker>/refs/assets/` |

**This is the change that matters most.** `ddsMap.json` was written to both paths, and
the two copies drifted: at merge time one had 4243 blocks and the other 4339, so which
GUIDs the editor recognised depended on which flow was open. Writing it once makes that
class of bug impossible rather than merely fixed.

---

## 2. Renames

Every generated file is renamed to say what it holds, rather than which internal map it
came from. Same content, same shape — only the file name changes, except where noted.

| Generator writes today | Should write | Content change? |
|---|---|---|
| `ddsMap.json` (to both paths) | `ddsContentIndex.json` (once) | no |
| `soChildTypes.json` | `soTypeLayout.json` | no |
| `soIdMap.json` | `soPathIds.json` | no |
| `templates.json` (case editor's) | `soDefaults.json` | no |
| `soMap.json` | `soAssetsByType.json`, `soEnums.json` **and** `soDoorPairIds.json` | **yes — split, see §3** |
| `ddsScopeMap.json` | `ddsScopes.json` | no — keep writing it, see §6 |
| `templates.json` (DDS viewer's) | *stop writing it* | see §7 |
| `enums.json` (DDS viewer's) | *stop writing it* | see §7 |
| `onlineTypes.json` | `index.json`, in the assets folder | no |

---

## 3. Split `soMap.json` into three files

`soMap.json` is three unrelated maps in one object, and the editor pulls it apart to use
them. Emit them separately:

```
soMap.json                              soAssetsByType.json
{                          ───►         { "WindowTabPreset": ["ABC", ...], ... }
  "ScriptableObject": {...},   79 keys
  "Enum":             {...},  646 keys   soEnums.json
  "ScriptableObjectID": {...}, 1 key     { "build": [...], "height": [...], ... }
}
                                         soDoorPairIds.json
                                         { "0": "DefaultWalls", "1": ..., ... }
```

- `soAssetsByType.json` — the current `ScriptableObject` value, verbatim.
- `soEnums.json` — the current `Enum` value, verbatim.
- `soDoorPairIds.json` — the `DoorPairPreset` entry from `ScriptableObjectID`, as a flat
  index → name map. Unwrapping the single-key outer object, since nothing else is in it.

### `ScriptableObjectID` was groundwork, and here is what for

The earlier version of this section asked what `ScriptableObjectID` was for, said nothing
in the editor read it, and offered to drop it. **Keep it.** The building flow needs it.

A floor blueprint stores each wall as a string index into the `DoorPairPreset` list —
`"7"` for `InteriorDoorway`, `"16"` for `WindowLargeRectangle`. That order is the game's
own, not alphabetical, so `soAssetsByType.DoorPairPreset` cannot reconstruct it: it has
the right 27 names and no way to know which is which. Without this map, every wall in
every floorplan is an opaque number.

The reference tool solved it by hand-transcribing the table into
`WallManager.DoorWindowPresets`, which is exactly the hazard §1 exists to prevent — game
data copied by hand drifts from the game. The repo holds a transcription of that table as
`refs/generated/soDoorPairIds.json` so the flow can be built now; it should be the
generator's at the next run.

Two details the transcription could not answer. **Both are now answered**, from a dump of
the `DoorPairPreset` assets themselves — so what follows is a record of what was found
rather than a request.

- **Ids 3 and 28–30 do not exist.** The type holds exactly 27 assets, ids 0–2 and 4–27.
  The gap at 3 is real and 28–30 are nothing. Emit the game's order and keep the gap; the
  three `null`s currently carried for 28–30 can go.
- **`sectionClass` per preset is not the answer it was assumed to be.** It is on the asset
  and every value is now known (table below), but it does not say which presets are
  windows — see the next heading. `wallPresetKinds.json` stays hand-written. §7 was wrong
  about this and has been corrected.

Index order is load-bearing here for the same reason it is for enums — see §9.

### What `sectionClass` actually says

Values for all 27 presets, with `isFence` beside them because no rule fits without it:

| `sectionClass` | Presets |
|---|---|
| 0 `wall` | DefaultWalls, RooftopVentilation |
| 1 `window` | WindowDiner, WindowMediumRectangle |
| 2 `windowLarge` | WindowLargeArch, WindowLargeRectangle, AlleyBlockWalls, **Bannister01**, **NothingWall**, **WoodenFence**, **WoodenFenceJoinLeft**, **WoodenFenceJoinRight**, **DecoHandrail** |
| 3 `entrance` | DividerCentre, DividerEndLeft, DividerEndRight, InteriorDoorway, InteriorDoorwayFlat, InteriorDoorwayUpper, **NothingEntrance**, **WoodenFenceEntrance** |
| 4 `ventUpper` | WindowSmallRaised, WindowSmallTop, WindowSmallWithUpperSpace |
| 5 `ventLower` | WindowSmallLower, WindowSmallLowWithUpperSpace, RooftopVentilationVent |
| 6 `ventTop` | — |

Bold entries have `isFence: true`.

Class 2 puts WindowLargeRectangle beside NothingWall and a wooden fence; class 5 puts
WindowSmallLower beside RooftopVentilationVent. So the field describes where the opening
sits in the wall panel's mesh, not whether the section is glazed, and it cannot stand in
for `wallPresetKinds.json`. The nearest rule that fits is `sectionClass ∈ {1, 2, 4, 5}
and not isFence`, which reproduces the hand table exactly except that it also calls
AlleyBlockWalls and RooftopVentilationVent windows. Neither appears in any base game
blueprint, so the hand table's entries for them were never checkable either.

The enum order above is `WallSectionClass` from `soEnums.json`, not the `sectionClass`
key beside it — see §9.

---

## 4. Extracted assets

The base game ScriptableObjects the asset explorer shows now live in `refs/assets/`,
moved wholesale from the case editor's `data/`. Two changes:

- Write them to the assets export path rather than beside the ref JSON.
- `onlineTypes.json` becomes `index.json`, in the same folder as the type folders it
  lists. It is a manifest of what is next to it, so it is named for that rather than for
  the fact that the files are served over the web.

Content and folder-per-type structure are unchanged. The editor fetches these by URL one
at a time and does not import them, so their size is not a page-load cost.

---

## 5. Floor blueprints and building presets — can you reach these?

**A question, not an instruction.** The building flow needs the base game's floor
blueprints, and they are the one kind of reference data with no good source.

The game's floorplans are `TextAsset`s inside asset bundles, so a browser cannot read them
out of a user's install the way the DDS flow reads `StreamingAssets`. They have to ship
with the app: 93 floors, 5.0 MB of compact JSON, plus the 15 `BuildingPreset` dumps that
describe which floors each building uses. Fetched by URL one file at a time, like
`refs/assets/`, so the size is not a page-load cost.

They currently arrive by hand, copied from `ShadowsOfDoubt-FloorEditorUnity`'s
`Assets/GameExports/`, and sit in `refs/floors/` with an `index.json`. That is the same
hand-copied-game-data arrangement §1 exists to fix, and it will drift the same way — a
game update changes a floor, nothing here notices, and mods get authored against a layout
that no longer exists.

So: if the generator can reach `TextAsset`s in bundles, `refs/floors/` should be its
folder rather than a hand-maintained one, on the assets model — a manifest beside the files
it lists. If it cannot, say so here and the folder gets documented as hand-maintained with
a note on how to refresh it, which is at least a written procedure instead of a copy
nobody can date.

The building presets are ordinary ScriptableObjects and are already in
`soAssetsByType.BuildingPreset`, so those may just be a matter of adding `BuildingPreset`
to what §4 exports. The floors are the real question.

---

## 6. Keep writing `ddsScopeMap.json`, as `ddsScopes.json`

Nothing in the editor imports it yet. It is kept on purpose: it describes the DDS
substitution grammar — which scopes exist, what each contains, what values each exposes —
which is what a validator or autocomplete for `[citizen.job.name]` tokens in block text
would be built on.

Rename only. Content and shape unchanged, and it stays in `generated/`.

---

## 7. Do not write into `refs/authored/`

These files are hand-maintained and the generator must leave them alone:

| File | What it is |
|---|---|
| `ddsTemplates.json` | skeletons for a new DDS tree / message / block / newspaper |
| `basicTypeLayouts.json` | Unity's built-in types in `soTypeLayout.json`'s shape |
| `basicEnums.json` | `Boolean` and `WeightedMode`, which reflection over the game does not produce |
| `fieldDescriptions.json` | prose field descriptions, shown as tooltips |
| `wallPresetKinds.json` | whether each `DoorPairPreset` is a wall, window, door or blank |

`wallPresetKinds.json` wanted to stop being hand-written, and it now looks as though it
cannot. It exists because the building flow has to draw a wall differently depending on
what it is, and decide which walls count as windows when generating a building's window
data. That was assumed to be each preset's `sectionClass` — but the dump in §3 shows
`sectionClass` grouping WindowLargeRectangle with NothingWall and a wooden fence, so it
describes the wall panel's mesh and not its glazing. The file stays here.

It is still worth carrying `sectionClass` into `generated/` alongside `soDoorPairIds.json`,
because it narrows the hand-written part to a handful of entries rather than all 27. What
it cannot do is replace them.

`ddsTemplates.json` was the DDS Viewer's `templates.json`, which sat in a folder named
`ref/` alongside generated files. If the generator writes anything under that name today,
it is overwriting hand-written content.

The DDS Viewer's `enums.json` is gone: `soEnums.json` covers those fields and is correct
where the hand-written file had drifted. Do not start writing it again.

Should any of these become generated later, they move to `generated/` in the same change —
the folder is the statement of who owns the file, so a file in the wrong one is a lie
rather than an inconvenience.

---

## 8. Emit inherited fields — the checked-in file has them patched in by hand

`soTypeLayout.json` lists only the fields a type declares itself, and nothing says what it
inherits from. Both editors resolve every field through it, so an inherited field resolved
to nothing: no tooltip, no enum dropdown, no type, and a reference field rendered as a
free-text box.

This was not hypothetical. `CompanyStructurePreset.companyStructure.occupation` is an
`OccupationPreset` reference and got a text box, because `BossConfig` declares only
`subordinates` and inherits the rest from `OccupationSettings`. Every DDS document type —
`DDSTreeSave`, `DDSMessageSave`, `DDSBlockSave` — was missing the `name` and `id` it
inherits from `DDSComponent`, which are the two fields an author touches first.

**The checked-in `soTypeLayout.json` has been edited by hand** to inline each base type's
fields into its derived types, base fields first, as the game serialises them. That is a
hand edit to generated data — the thing §1 exists to prevent — and it is undone by the next
regeneration. It buys working dropdowns until then and nothing more.

### What the generator should do instead

Either inline inherited fields the same way, or emit a base-type name per entry and let the
editor walk the chain:

```
"DDSTreeSave": { "$base": "DDSComponent", "fields": { ... } }
```

Shape is your call — a sibling map of type → base would not require touching the existing
one. Whichever, say so here and the editor follows in the same change. Inlining keeps
`core/typeHints.js` as it is; a base-type map means `resolveField` grows a chain walk.

### The map that was applied, so it can be checked

92 derived types across five bases. All but the inferred rows were derived from the data
rather than guessed: a type's missing field set was matched against the declared field set
of every other type, and every match below was exact.

| Base | Derived types | Evidence |
|---|---|---|
| `SoCustomComparison` (`presetName`) | the 80 preset/SO types whose `soDefaults.json` template carries `presetName` while their layout entry did not declare it | template |
| `OccupationSettings` | `BossConfig` | exact field-set match |
| `OccupationSettings` | `Hierarchy1Config`, `Hierarchy2Config`, `Hierarchy3Config`, `Hierarchy4Config` | **inferred** — see below |
| `SelectableSettings_Base` | `SelectableSettings`, `SliderSettings`, `ScrollbarSettings` | field-set match |
| `DDSComponent` (`name`, `id`) | `DDSTreeSave`, `DDSMessageSave`, `DDSBlockSave` | `ddsTemplates.json` |
| `ScriptableObjectIDSystem` (`id`) | `DoorPairPreset` | template |

The four `HierarchyNConfig` rows are the one inference. No `CompanyStructurePreset` asset
ships in `refs/assets/` and the default template's `subordinates` is `[]`, so no data
reaches them — but they sit on the same chain as `BossConfig`
(`companyStructure` → `BossConfig` → `Hierarchy1Config` → … → `OccupationSettings`) and each
declares only `subordinates`, exactly as `BossConfig` did. `Hierarchy4Config` is orphaned:
`Hierarchy3Config.subordinates` points at `OccupationSettings` directly, so nothing reaches
it either way. **Confirm these five against the game.**

### Six fields still unresolved, and none of them is inheritance

Do not patch these the same way — they are the layout and the data disagreeing, and the
generator is where the answer is:

| Type | Field(s) | What it looks like |
|---|---|---|
| `TraitPick` | `appliedFrequencyMin`, `appliedFrequencyMax` | assets have these two; layout declares `appliedFrequency` |
| `TraitPickRule` | `baseChance`, `reasonChance` | assets have these two; layout declares `addChance` |
| `NewspaperArticle` | `possibleImages` | in `ddsTemplates.json`, declared by no type |
| ~~`DDSBlockCondition`~~ | ~~`forceScope`~~ | **Settled, and it was not the generator.** `DDSSaveClasses.DDSBlockCondition` has seven fields and no `forceScope`, matching the layout; the base game's own content has it in 88 of 96 block conditions. It is a field of an older format that the current class ignores, so it has been dropped from `ddsTemplates.json` rather than kept |
| `CustomColorBlock` | `m_NormalColor` and its seven siblings | the type declares the property names (`normalColor`) but not the `m_`-prefixed serialised fields. `CustomSpriteState` and `CustomAnimationTriggers` carry both forms |
| `AnimationCurve.Keyframe` | `inSlope`, `outSlope`, `serializedVersion` | ours, in `refs/authored/basicTypeLayouts.json` — not the generator's |

The first two read as version drift between the shipped assets and the reflected types. If
the generator and the asset export run against the same build, they should not disagree.

---

## 8a. `[NonSerialized]` fields are in the layout, and they should not be

`soTypeLayout.json` describes what a file holds — it is what both editors build a new
document from and what decides which fields carry a control. Two entries in it are fields
the game never writes:

| Type | Field | What it actually is |
|---|---|---|
| `DDSTreeSave` | `messageRef` | `[NonSerialized] Dictionary<string, DDSMessageSettings>` — an index the game builds after loading a tree. The layout reports it as `String[]` |
| `DDSTreeSave` | `citizenAddCount` | `[NonSerialized] int` — a counter kept while the tree runs |

Both are absent from all 39 base game trees checked, as they must be. The layout reporting
a `Dictionary` as an array of strings is the same fact seen from the other side: whatever
walks the type is reading fields it should be skipping, and guessing at the ones it cannot
express.

The DDS flow names these two and refuses to build them — see `NOT_WRITTEN_TO_A_FILE` in
`flows/dds/scripts/elementTemplates.js`. Without that, a tree's `messageRef` carried a
`+` like any other list of strings, and using it wrote a field into the mod's document that
the game overwrites the moment it loads it.

**The generator should skip fields marked `[NonSerialized]`.** That list is then empty and
the flow's can go.

---

## 9. Format

- **JSON, 2-space indent, LF, trailing newline.** `.gitattributes` marks
  `refs/generated/**` and `refs/assets/**` as generated and non-diffable, so formatting is
  for the repo's sake rather than for reading — but stable formatting keeps regeneration
  diffs to what actually changed. `refs/floors/**` needs the same marking if §5 lands.
- **Key order is stable output, not decoration.** Enum values are addressed *by index*:
  the game serialises those fields as integers, so reordering the values inside an enum
  silently rewrites the meaning of every mod using it. Order within each enum must follow
  the game's own order, not sort order. **`soEnums.json` currently breaks this for half
  its keys** — see §9a.
- **`soDoorPairIds.json` is index-addressed too**, and worse: its indices are written into
  saved floorplans as strings. A reordering does not merely change what a field means, it
  rewrites every wall in every floor anyone has authored. Emit the game's order, keep the
  gaps, and never renumber to close them.
- **No BOM.** One of these files arrived UTF-16 BE with a BOM and had to be re-encoded by
  hand at import (`f1671ec`).

---

## 9a. Half of `soEnums.json` is sorted, and sorting an enum destroys it

Every enum in the file appears under a type name, and 202 of them appear a second time
under a field name as well. The two copies do not agree:

```
FloorTileType  ["none", "floorAndCeiling", "floorOnly", "CeilingOnly", "noneButIndoors"]
f_t            ["CeilingOnly", "floorAndCeiling", "floorOnly", "none", "noneButIndoors"]

WallSectionClass  ["wall", "window", "windowLarge", "entrance", "ventUpper", ...]
sectionClass      ["entrance", "ventLower", "ventTop", "ventUpper", "wall", ...]
```

The type-name copy is the game's declaration order. The field-name copy is alphabetical,
and therefore says the wrong thing about every index it does not happen to fix. `f_t: 0`
is `none`; the sorted copy calls it `CeilingOnly`, which is a solid square rather than an
absent one — the building flow reads exactly this field to decide a building's footprint.

It is systemic rather than a one-off: 267 of the 297 field-name keys are in sort order,
against 28 of the 275 type-name keys.

**Nothing reads the broken copies today.** Both editors resolve a field through
`soTypeLayout.json`, which names types; all 725 types it references miss the 267 sorted
keys entirely. But `core/refs.js` flattens the file into one namespace, so the two live
side by side under names that look equally reasonable, and any future lookup by field name
finds the wrong list without erroring.

Two ways out, either acceptable:

- Stop emitting the field-name keys. `soTypeLayout.json` reaches every enum the editors
  need, and the field-name half is what got sorted.
- Emit both in declaration order.

What must not happen is the current mix, where the correctness of a lookup depends on
which of two spellings the caller picked.

---

## 9b. Keying enums on the bare name is lossy, and it has already lost one

Separate from the sorting, and found while reading `FurnitureClass.wallRules`: the game
declares the same enum name on two types, and only one of them survives into the file.

```
FurnitureClass.WallRule    17 members   nothing, wall, window, windowLarge, entrance, …
FurnitureCluster.WallRule   7 members   nothing, wallNoDoor, onlyWall, doorway, door, …
```

`soEnums.json` has one `WallRule`, and it is the cluster's. `soTypeLayout.json` points
`FurnitureWallRule.tag` and `FurnitureCluster.zeroNodeWallRules` at that same bare name, so
resolving the first through it returns the wrong list — and returns it confidently, with
every index past the sixth meaning something else. The assets use tags up to 15, so more
than half of them resolve to nothing at all.

**Nothing reads it today**, because the building flow carries its own copy — see
`flows/building/scripts/furnitureRules.js`, which says where it got the order from and why
it did not come from here.

Emitting enums keyed on `Type.Name` would settle this and §9a together: a declaring type
disambiguates the collision, and there is no second copy left to sort. The generator
already knows the declaring type — it is how `soTypeLayout.json` names the field's type in
the first place.

**Where the right answer lives**: the dump host serves an `enums.json` holding all 333
enums decompiled from `Assembly-CSharp`, each with `fullName`, source file, line, and
members in declaration order. That is the file to check against when an index-addressed
value reads oddly, and it is what settled this one.

---

## 10. The ten furniture-chain types — can you export these too?

**A question, not an instruction**, and the same shape as §5.

The building flow says what furniture could spawn on the square under the pointer. It gets
there by walking the game's own chain — `LayoutConfiguration` → `AddressPreset` →
`RoomConfiguration` → `RoomClassPreset` → `RoomTypeFilter` → `FurnitureCluster` →
`FurnitureClass` → `FurniturePreset` — which needs ten types the generator does not
currently export:

```
AddressPreset  RoomConfiguration  RoomTypePreset  RoomTypeFilter  RoomClassPreset
FurnitureCluster  FurnitureClass  FurniturePreset  LayoutConfiguration  DoorPairPreset
```

They are ordinary ScriptableObjects and would fit `assets/` unchanged, alongside the nine
types already there. Nothing about them is special except that nobody asked for them yet.

`DoorPairPreset` is the tenth and the newest. The flow reads `sectionClass`, `divider` and
`isFence` off it to answer a `FurnitureClass`'s wall rules — which is what §3's request to
carry `sectionClass` per preset was for, now that something depends on it.

Today they come from a dump served off a machine on a desk, reduced to
`refs/derived/furnitureChain.json` by `flows/building/tools/buildFurnitureChain.js`. The
script is checked in and the output is checked in; the input is not, so nobody but its
author can regenerate it. Adding these ten to `index.json` and the assets export would
make `refs/derived/` reproducible from this repo plus the game, which is the only thing
wrong with it.

If they are exported, the tool should read `refs/assets/` instead of a URL. Its `TYPES`
list is the whole of what it needs.

Two notes for whoever does it:

- The dump this was built from carries references as `{m_FileID, m_PathID}` with the
  **pathID in `m_FileID`**, resolved through `soPathIds.json`. If the generator's own
  asset export uses a different convention, the tool's `nameOf` is the one place to change.
- 149 of the 10,296 references across the original nine resolve to nothing, because they
  point at prefabs, sprites and materials rather than ScriptableObjects. That is expected
  and none of them is a reference the tool reads.

---

## Checklist

- [ ] Collapse the two export paths into one ref path plus one asset path (§1)
- [ ] Rename the six generated files, `ddsScopeMap.json` → `ddsScopes.json` among them (§2, §6)
- [ ] Split `soMap.json` into `soAssetsByType.json` + `soEnums.json` + `soDoorPairIds.json` (§3)
- [ ] Keep `ScriptableObjectID` — the building flow reads it. Ids 3 and 28–30 are confirmed
      absent: emit the gap, and drop the three `null`s (§3)
- [ ] Carry `sectionClass` per `DoorPairPreset`. It does not replace `wallPresetKinds.json`
      as §7 once claimed, but it narrows what stays hand-written (§3, §7)
- [ ] Fix `soEnums.json`: either drop the field-name keys or emit them in declaration
      order, never sorted (§9a) — and key on `Type.Name`, which settles §9a and §9b at
      once. `WallRule` is currently one enum standing in for two (§9b)
- [ ] Write `ddsContentIndex.json` exactly once (§1)
- [ ] Write assets to the asset path; rename `onlineTypes.json` to `index.json` (§4)
- [ ] Say whether floor blueprints can be exported, and export `BuildingPreset` with the
      other assets (§5)
- [ ] Stop writing the DDS `templates.json` / `enums.json`, if it does (§7)
- [ ] Emit inherited fields, so they resolve — and check the five inferred rows and the six
      unresolved fields in §8, which the hand patch could not settle (§8)
- [ ] Skip `[NonSerialized]` fields: `DDSTreeSave.messageRef` and `citizenAddCount` are in
      the layout and in no file the game writes (§8a)
- [ ] Say whether the ten furniture-chain types can join the asset export, so
      `refs/derived/` becomes reproducible from this repo (§10)

## Verifying a regeneration

From the Mod Maker repo, after pointing the generator at it and running:

```sh
git status refs/                  # only files that should have changed
git diff --stat refs/authored/    # must be empty: the generator does not own these
npm test                          # the reference-data tests assert every global populates
```

`tests/dds.spec.js` and `tests/scriptableObject.spec.js` both boot a flow and assert its
globals are non-empty, which catches a file that moved, was renamed, or came out with the
wrong shape. They do not assert counts, so they will not catch content that regenerated
short — check `git diff --stat` for a file that suddenly lost half its size.

---

## 6. `roomCyclePriority.json`

`RoomTypePreset.cyclePriority` per preset name, as `{ "Lobby": 3, "LivingRoom": 10, ... }`.

The building flow needs it to say which way round a divider end goes: of the two walls
facing each other across a divider, the parent is the one whose room has the higher
`cyclePriority`, and the preset's post sits at the end of the run that is on the left seen
from the parent room. Without the table the editor cannot draw a divider end on the side
the game will put it — see `flows/building/README.md`.

Checked in from the game's own `RoomTypePreset` assets so the flow works today, the same
way `soDoorPairIds.json` is. It should be the generator's: it is one field off an asset
type the generator already walks, and a mod adding a `RoomTypePreset` is a room this
editor currently falls back to the field's default of 5 for.
