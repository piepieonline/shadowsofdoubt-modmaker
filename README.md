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
| Building floorplans | `building` | ShadowsOfDoubt-FloorEditorUnity |

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

## Demo mode

`?demo` runs the whole app against content that is not on your disk — no game install, no mod
folder, no folder prompt. It exists for trying the UI out, so there is no button for it.

```sh
http://127.0.0.1:8080/?demo                    # the default editor
http://127.0.0.1:8080/?flow=building&demo      # composes with ?flow=
```

It seeds the Origin Private File System and hands the shell genuine browser-native
`FileSystemDirectoryHandle` objects, the same trick the Playwright harness uses. Nothing about
the app changes: every flow reads and writes the way it always does, so there is no demo-only
path to drift out of step with the real one.

What that means in practice:

|  |  |
|---|---|
| Your folders | Never read and never written. Demo mode does not call `restoreFolders`, so a remembered handle is not even looked at, and nothing is written to idb-keyval. Leaving demo mode is a reload with the parameter dropped. |
| Saving | Works, into the demo tree — an edit can be saved, reopened and seen again. That tree is wiped and reseeded on every load, so nothing accumulates. |
| Folders modal | Reachable, but the buttons are disabled: connecting a real folder would break the promise above, quietly, with the badge still saying otherwise. |
| Badge | A red **Demo data** chip in the header. Undiscoverable is not the same as invisible — made-up content must never be mistaken for the mod you are working on. |

The content is three mods in `core/demo/fixtures.js`: one holding a case, its DDS text *and* a
building (which is what lets switching editors keep the selection), one holding only a building,
and one loader with nothing editable in it. The base game documents there are written by hand —
their GUIDs and names are real ones from `refs/generated/ddsContentIndex.json`, so the Browse list
names them correctly, but demo mode reads no install and there is nothing else they could be.

## Tests

Two suites, and the line between them is worth knowing before adding a test.

```sh
npm test                 # both, unit first
npm run test:unit        # Vitest, ~1s
npm run test:unit:watch  # the one to leave running
npm run test:playwright  # Chromium, ~2min
npm run test:ui          # interactive Playwright
npm run report           # last HTML report
```

**Unit tests sit beside the module they cover**, named `*.unit.spec.js` — `core/stringsCsv.unit.spec.js`
covers `core/stringsCsv.js`. They cover the logic that carries the correctness risk and needs no browser:
parsing and serialising a file, turning a floor blueprint into a grid and back, deciding what a painting
tool does to a node.

> A unit test is never handed a `FileSystemDirectoryHandle`, real or fake, never a WebGL context, and never
> a `document`. If a test needs one of the three, it belongs in the Playwright suite. `environment: 'node'`
> makes the third of those a hard failure rather than a matter of discipline.

The single exception is `fetch` for `/refs/**` (`tests/support/refs.js`), which serves the same files
`http-server` does from the same paths. It is not a mock of anything, and nothing else is stubbed.

**Playwright specs live in `tests/`**, named `*.spec.js`, and drive the real app in a real page.

| | Tests | Wall clock |
|---|---:|---:|
| Unit (Vitest) | 168 | ~2s |
| Playwright | 319 | ~6min |

The app stays zero-build: npm is only needed for tests and the dev server, never to use or deploy the site.

Playwright tests never touch your real filesystem. `showDirectoryPicker` cannot be driven by Playwright, so the harness
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
| `refs/floors/` | the base game's floor blueprints and building presets, copied out of the game by hand. Fetched at runtime, not imported. |

`refs/README.md` says what each file holds and which global it becomes. `refs/GENERATOR.md` is the
contract with the generator, including the changes it still needs.
