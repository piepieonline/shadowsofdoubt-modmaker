# Shadows of Doubt — Mod Maker

An extensible browser-based mod editor for Shadows of Doubt. Merges the previously separate
[CaseEditor](https://github.com/piepieonline/ShadowsOfDoubt-CaseEditor) and
[DDSViewer](https://github.com/piepieonline/ShadowsOfDoubt-DDSViewer) into one app, with a flow-plugin
architecture so new mod types can be added without forking the tool again.

## Status

Mid-migration. See `.local/PLAN.md` for the phased plan.

One app, one page. The flow to edit is chosen with `?flow=<id>`, or from the picker in the header. The URL
keeps up with what you are working on from there — see [What the URL remembers](#what-the-url-remembers).

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

## What the URL remembers

The address bar holds what you are working on, so refreshing brings it back rather than dropping you into
an empty workspace — and so a URL is a link to a piece of work rather than to the app in general.

```
?flow=dds&mod=DialogAdditions&content=plugins/TalkToPartner
  &open=["DDS/Trees/1c2f….tree","DDS/Messages/8ba0….msg"]&strings=Strings/english.csv
```

`flow`, `mod` and `content` belong to the shell. Everything else belongs to whichever editor is active,
which names its own parameters — `open` and `strings` above, `building`/`blueprint`/`slot`/`variations`/`tool`
for floorplans. See `core/urlState.js`, and `sessionState` in each `flows/<id>/flow.js`.

Three things are worth knowing:

- **Only the active editor's documents are in the URL.** The others are remembered in memory, so they
  survive switching editor but not a reload. Three sessions in the address bar to save the two you are not
  looking at is not worth what it does to the length.
- **Putting it back can have to wait.** Chrome usually will not carry a File System Access grant across a
  reload, so the mod folder often has to be re-granted first. The parameters are held until then — a link
  whose state is erased while its own permission prompt is on screen is a link that only works if answered
  quickly.
- **What is no longer there is dropped quietly.** A mod, floor or document named by the URL may have been
  deleted or renamed since. Nothing is said about it, and the URL is rewritten from what actually came back.

Base game content needs no mod selected, so `?flow=scriptableObject&open=["asset:MurderMO/ExCopSniper.json"]`
is a link anyone can open with no folders connected at all. **Share Open Files** copies the current URL with
`viewOnly=true`, which is that link plus "for reading".

The DDS editor accepts a bare GUID in `open` as well as a path — `?flow=dds&open=["1c2f…"]` — which is what
a link to a document can reasonably know. Which of the three kinds of document it is comes from the
reference data.

## Running locally

The File System Access API (`showDirectoryPicker`) requires a secure context, so opening `index.html` from
disk will not work — it must be served.

```sh
npm install
npm run dev        # https://127.0.0.1:8123, localhost only
```

Then open `http://127.0.0.1:8123/`. The old per-flow URLs still work and redirect.

`http://127.0.0.1` and `http://localhost` are secure contexts, so plain HTTP is sufficient when testing on
the same machine. **To reach the app from another device** (e.g. a Windows box with the game installed) you
need HTTPS — a LAN IP over plain HTTP is *not* a secure context, so `showDirectoryPicker` would be undefined
and every flow would die at the first folder prompt:

```sh
npm run dev:lan    # binds all interfaces over HTTPS, making a cert first if there is none
```

It prints the LAN URL to open. The certificate is self-signed, so the browser will warn once.

Requires a Chromium-based browser — Firefox and Safari do not implement the File System Access API.

### Building

```sh
npm run build           # dist/,         for GitHub Pages under /shadowsofdoubt-modmaker/
npm run build:desktop   # dist-desktop/, document-relative, for the Electron shell
npm run preview         # serve dist/ exactly as Pages will
```

The tests run against the dev server rather than a build, so `preview` is worth a look after changing
anything about how assets are resolved — that is the one gap the suites do not cover.

## Demo mode

`?demo` runs the whole app against content that is not on your disk — no game install, no mod
folder, no folder prompt. It exists for trying the UI out, so there is no button for it.

```sh
http://127.0.0.1:8123/?demo                    # the default editor
http://127.0.0.1:8123/?flow=building&demo      # composes with ?flow=
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
| Badge | A red **Demo data** chip in the header, and a `DEMO - ` prefix on the tab title for when the header is scrolled away or the tab is in the background. Undiscoverable is not the same as invisible — made-up content must never be mistaken for the mod you are working on. |

The content is three mods in `core/demo/fixtures.js`: one holding a case, its DDS text *and* a
building (which is what lets switching editors keep the selection), one holding only a building,
and one loader with nothing editable in it. The base game documents there are written by hand —
their GUIDs and names are real ones from `refs/generated/ddsContentIndex.json`, so the Browse list
names them correctly, but demo mode reads no install and there is nothing else they could be.

## Tests

Three suites, and the line between them is worth knowing before adding a test.

```sh
npm test                 # unit and Playwright, unit first
npm run test:unit        # Vitest, ~3s
npm run test:unit:watch  # the one to leave running
npm run test:playwright  # Chromium, ~3min
npm run test:e2e         # the walkthroughs, played. Not part of npm test
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

The single exception is `fetch` for `/refs/**` (`test-support/refs.js`), which serves the same files the
dev server does from the same paths. It is not a mock of anything, and nothing else is stubbed.

**Playwright specs live in `tests/`**, named `*.spec.js`, and drive the real app in a real page. This is the
app's own coverage, a feature at a time, and it is what `npm test` runs.

**`e2e/` holds one test per shipped tutorial**, which plays that walkthrough from its first step to its last:
doing what every step asks, in order, from an empty mod to the file the tutorial set out to build. A step
naming a control that is not there, or waiting on a condition the app never satisfies, leaves a player stuck
with nowhere to click — and nothing short of playing the file finds that. They are about the tutorials rather
than about the app, so they have a config of their own (`playwright.e2e.config.js`) and are asked for by name.
`npm run demo` plays them paced and headed, to be watched.

| | Tests | Wall clock |
|---|---:|---:|
| Unit (Vitest) | 1065 | ~3s |
| Playwright (`tests/`) | 688 | ~4min |
| Walkthroughs (`e2e/`) | 2 | ~25s |
| Build (`tests-build/`) | 7 | ~5s |

`tests/` and `e2e/` run against the Vite dev server, which serves source at the paths the specs use --
several reach into a module directly with `import('/flows/...')`. That is what keeps a failure pointing at a
file, and it is also why those suites cannot see anything the *build* gets wrong.

**`tests-build/` is the check for that.** It builds, serves `dist/` under the project base the way Pages
does, and asserts the seam between source and artifact: that asset URLs resolve, that the side-effect-only
vendor imports survived, that the stylesheets are still concatenated in cascade order, that `refs/` is
served and a missing asset 404s, and that nothing reaches another origin. Each of those broke at least once
while the build was being put in, with every spec in `tests/` still passing. Run with `npm run test:build`.

Playwright tests never touch your real filesystem. `showDirectoryPicker` cannot be driven by Playwright, so the harness
(`test-support/harness.js`) seeds the Origin Private File System and hands the app genuine browser-native
`FileSystemDirectoryHandle` objects — real `createWritable`, `seek` and async `values()` rather than a mock.
Fixtures live in `test-support/fixtures.js`.

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
