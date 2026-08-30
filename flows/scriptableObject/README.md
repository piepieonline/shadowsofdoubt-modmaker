# Shadows of Doubt - Community Case Builder

This is a basic tool to build scriptable objects for the game, with a particular focus on enabling the creation of new murder case variants, to be loaded by the [CommunityCaseLoader](https://thunderstore.io/c/shadows-of-doubt/p/Piepieonline/CommunityCaseLoader/).

Instructions for use found on the wiki.

http-server -c-1 -S

To add a new data type for online reference:
Modify the documentation generator's onlineTypes, which is written to `refs/assets/index.json`.

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
