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

Two details the transcription cannot answer, and the generator can:

- **Ids 3 and 28–30.** The hand-written table skips 3 and names 28–30 `Unknown01`–`03`.
  Whether those indices exist at all is unknown. Emit whatever the game has, gaps and all.
- **`sectionClass` per preset.** Which presets are walls, windows, doors or blanks. The
  reference infers it from a second hand-written table, and flags ids 14, 26 and 27 as
  unverified. `sectionClass` is a field on the asset, so if the dump can carry it, add it
  and the second table goes away. See §7.

Index order is load-bearing here for the same reason it is for enums — see §9.

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

`wallPresetKinds.json` is the one entry here that wants to stop being hand-written. It
exists because the building flow has to draw a wall differently depending on what it is,
and decide which walls count as windows when generating a building's window data. The
underlying answer is each preset's `sectionClass`, which is a field on the asset — so if
§3 can carry it, this file moves to `generated/` and the hand-written guesses at ids 14,
26 and 27 stop mattering.

`ddsTemplates.json` was the DDS Viewer's `templates.json`, which sat in a folder named
`ref/` alongside generated files. If the generator writes anything under that name today,
it is overwriting hand-written content.

The DDS Viewer's `enums.json` is gone: `soEnums.json` covers those fields and is correct
where the hand-written file had drifted. Do not start writing it again.

Should any of these become generated later, they move to `generated/` in the same change —
the folder is the statement of who owns the file, so a file in the wrong one is a lie
rather than an inconvenience.

---

## 8. Emit each type's base type

`soTypeLayout.json` lists only the fields a type declares itself, and nothing says what it
inherits from. Both editors now resolve every field through it, so an inherited field
resolves to nothing: it gets no tooltip, no enum dropdown, and no type.

This is not hypothetical. Every DDS document type — `DDSTreeSave`, `DDSMessageSave`,
`DDSBlockSave` — inherits `name` and `id` from `DDSComponent`, and those are the two fields
an author touches first.

A base-type name per entry is enough; the editor can walk the chain:

```
"DDSTreeSave": { "$base": "DDSComponent", "fields": { ... } }
```

Shape is your call — a sibling map of type → base would not require touching the existing
one. Whichever, say so here and the editor follows in the same change.

---

## 9. Format

- **JSON, 2-space indent, LF, trailing newline.** `.gitattributes` marks
  `refs/generated/**` and `refs/assets/**` as generated and non-diffable, so formatting is
  for the repo's sake rather than for reading — but stable formatting keeps regeneration
  diffs to what actually changed. `refs/floors/**` needs the same marking if §5 lands.
- **Key order is stable output, not decoration.** Enum values are addressed *by index*:
  the game serialises those fields as integers, so reordering the values inside an enum
  silently rewrites the meaning of every mod using it. Order within each enum must follow
  the game's own order, not sort order.
- **`soDoorPairIds.json` is index-addressed too**, and worse: its indices are written into
  saved floorplans as strings. A reordering does not merely change what a field means, it
  rewrites every wall in every floor anyone has authored. Emit the game's order, keep the
  gaps, and never renumber to close them.
- **No BOM.** One of these files arrived UTF-16 BE with a BOM and had to be re-encoded by
  hand at import (`f1671ec`).

---

## Checklist

- [ ] Collapse the two export paths into one ref path plus one asset path (§1)
- [ ] Rename the six generated files, `ddsScopeMap.json` → `ddsScopes.json` among them (§2, §6)
- [ ] Split `soMap.json` into `soAssetsByType.json` + `soEnums.json` + `soDoorPairIds.json` (§3)
- [ ] Keep `ScriptableObjectID` — the building flow reads it. Emit ids 3 and 28–30 as the
      game actually has them (§3)
- [ ] Carry `sectionClass` per `DoorPairPreset`, if the dump can reach it (§3, §7)
- [ ] Write `ddsContentIndex.json` exactly once (§1)
- [ ] Write assets to the asset path; rename `onlineTypes.json` to `index.json` (§4)
- [ ] Say whether floor blueprints can be exported, and export `BuildingPreset` with the
      other assets (§5)
- [ ] Stop writing the DDS `templates.json` / `enums.json`, if it does (§7)
- [ ] Emit each type's base type, so inherited fields resolve (§8)

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
