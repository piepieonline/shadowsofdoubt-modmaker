# Shadows of Doubt — Mod Maker

An extensible browser-based mod editor for Shadows of Doubt. Merges the previously separate
[CaseEditor](https://github.com/piepieonline/ShadowsOfDoubt-CaseEditor) and
[DDSViewer](https://github.com/piepieonline/ShadowsOfDoubt-DDSViewer) into one app, with a flow-plugin
architecture so new mod types can be added without forking the tool again.

## Status

Mid-migration. See `.local/PLAN.md` for the phased plan.

One app, one page. The flow to edit is chosen with `?flow=<id>`, or from the picker in the header.

| Flow | `?flow=` | Origin |
|---|---|---|
| Cases & ScriptableObjects | `scriptableObject` | ShadowsOfDoubt-CaseEditor |
| DDS text content | `dds` | ShadowsOfDoubt-DDSViewer |

Each flow lives in `flows/<id>/` and declares itself in `flow.js`. Shared machinery is in `core/`; adding a
flow should not require changing anything there.

## Choosing what to edit

Point the app at your **BepInEx `plugins` folder** — one subfolder per installed mod — then pick a mod and a
content folder within it.

The second step is a search, not a subfolder list. What can be edited is a folder holding a
`murdermanifest.sodso.json`, a `DDSContent` directory, or both, and mods disagree about where that sits:

```
DartTowerTest                              the mod root itself
AdditionalEvidence/BinPasscodes            a direct subfolder
DialogAdditions/plugins/TalkToPartner      under the BepInEx plugins/ convention
WhiteCollarSideJobs/plugins/Cases/test     deeper again
```

One mod often holds several; loaders and utilities hold none and are listed as such. New content folders are
created beside whatever that mod already has, so they land where its loader expects them.

## Running locally

The File System Access API (`showDirectoryPicker`) requires a secure context, so opening `index.html` from
disk will not work — it must be served.

```sh
npm install
npm run serve      # http://127.0.0.1:8080, localhost only
```

Then open `http://127.0.0.1:8080/`. The old per-flow URLs still work and redirect.

`http://127.0.0.1` and `http://localhost` are secure contexts, so plain HTTP is sufficient when testing on
the same machine. **To reach the app from another device** (e.g. a Windows box with the game installed) you
need HTTPS — a LAN IP over plain HTTP is *not* a secure context, so `showDirectoryPicker` would be undefined
and every flow would die at the first folder prompt:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
npm run serve:lan   # binds all interfaces over HTTPS
```

Requires a Chromium-based browser — Firefox and Safari do not implement the File System Access API.

## Tests

```sh
npm test              # headless
npm run test:ui       # interactive
npm run report        # last HTML report
```

The app stays zero-build: npm is only needed for tests and the dev server, never to use or deploy the site.

Tests never touch your real filesystem. `showDirectoryPicker` cannot be driven by Playwright, so the harness
(`tests/support/harness.js`) seeds the Origin Private File System and hands the app genuine browser-native
`FileSystemDirectoryHandle` objects — real `createWritable`, `seek` and async `values()` rather than a mock.
Fixtures live in `tests/support/fixtures.js`.

These are **baseline** tests recorded against current behaviour, to refactor against in later phases. Where
current behaviour looks wrong, the test asserts it anyway and says so in a comment.

## Reference data

Everything the editor knows about the game before you open a mod lives in `refs/`, at the repo root,
shared by every flow. It is split by who writes it:

| | |
|---|---|
| `refs/generated/` | written by the `DocumentationGenerator` project in [ShadowsOfDoubtMods](https://github.com/piepieonline/ShadowsOfDoubtMods). Not hand-edited. |
| `refs/authored/` | hand-maintained. The generator does not write here. |
| `refs/assets/` | base game ScriptableObject extracts, also generated. Fetched at runtime, not imported. |

`refs/README.md` says what each file holds and which global it becomes. `refs/GENERATOR.md` is the
contract with the generator, including the changes it still needs.
