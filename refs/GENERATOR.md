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
| `soMap.json` | `soAssetsByType.json` **and** `soEnums.json` | **yes — split, see §3** |
| `ddsScopeMap.json` | `ddsScopes.json` | no — keep writing it, see §5 |
| `templates.json` (DDS viewer's) | *stop writing it* | see §6 |
| `enums.json` (DDS viewer's) | *stop writing it* | see §6 |
| `onlineTypes.json` | `index.json`, in the assets folder | no |

---

## 3. Split `soMap.json` into two files

`soMap.json` is three unrelated maps in one object, and the editor immediately pulls it
apart into two globals. Emit them as two files:

```
soMap.json                              soAssetsByType.json
{                          ───►         { "WindowTabPreset": ["ABC", ...], ... }
  "ScriptableObject": {...},   79 keys
  "Enum":             {...},  646 keys   soEnums.json
  "ScriptableObjectID": {...}, 1 key     { "build": [...], "height": [...], ... }
}                                        (ScriptableObjectID — see below)
```

- `soAssetsByType.json` — the current `ScriptableObject` value, verbatim.
- `soEnums.json` — the current `Enum` value, verbatim.

**`ScriptableObjectID` needs a decision from you.** It holds one entry, `DoorPairPreset`,
mapping index → name, and nothing in the editor has ever read it. It is not carried into
either new file, so at the next regeneration it disappears. If it was groundwork for
something, say what it is for and it gets a file and a reader; otherwise drop it from the
generator too.

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

## 5. Keep writing `ddsScopeMap.json`, as `ddsScopes.json`

Nothing in the editor imports it yet. It is kept on purpose: it describes the DDS
substitution grammar — which scopes exist, what each contains, what values each exposes —
which is what a validator or autocomplete for `[citizen.job.name]` tokens in block text
would be built on.

Rename only. Content and shape unchanged, and it stays in `generated/`.

---

## 6. Do not write into `refs/authored/`

Three files are hand-maintained and the generator must leave them alone:

| File | What it is |
|---|---|
| `ddsTemplates.json` | skeletons for a new DDS tree / message / block / newspaper |
| `ddsEnums.json` | the DDS field enums (`treeType`, `triggerPoint`, `traitConditions`, …) |
| `soFieldDescriptions.json` | prose field descriptions, shown as tooltips |

The first two were the DDS Viewer's `templates.json` and `enums.json`, which sat in a
folder named `ref/` alongside generated files. If the generator writes anything under
those names today, it is overwriting hand-written content.

Should any of these become generated later, they move to `generated/` in the same change —
the folder is the statement of who owns the file, so a file in the wrong one is a lie
rather than an inconvenience.

---

## 7. Format

- **JSON, 2-space indent, LF, trailing newline.** `.gitattributes` marks
  `refs/generated/**` and `refs/assets/**` as generated and non-diffable, so formatting is
  for the repo's sake rather than for reading — but stable formatting keeps regeneration
  diffs to what actually changed.
- **Key order is stable output, not decoration.** Enum values are addressed *by index*:
  the game serialises those fields as integers, so reordering the values inside an enum
  silently rewrites the meaning of every mod using it. Order within each enum must follow
  the game's own order, not sort order.
- **No BOM.** One of these files arrived UTF-16 BE with a BOM and had to be re-encoded by
  hand at import (`f1671ec`).

---

## Checklist

- [ ] Collapse the two export paths into one ref path plus one asset path (§1)
- [ ] Rename the six generated files, `ddsScopeMap.json` → `ddsScopes.json` among them (§2, §5)
- [ ] Split `soMap.json` into `soAssetsByType.json` + `soEnums.json` (§3)
- [ ] Decide what happens to `ScriptableObjectID` (§3)
- [ ] Write `ddsContentIndex.json` exactly once (§1)
- [ ] Write assets to the asset path; rename `onlineTypes.json` to `index.json` (§4)
- [ ] Stop writing the DDS `templates.json` / `enums.json`, if it does (§6)

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
