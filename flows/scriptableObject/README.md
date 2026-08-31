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
