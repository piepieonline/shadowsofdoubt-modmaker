/**
 * What a mod's DDS content folder actually contains.
 *
 * DDS content is four things, in the order they nest: trees hold messages, messages
 * hold blocks, and blocks resolve to strings in a CSV. The panel lists all four,
 * because "what is in this mod" is otherwise invisible -- the files are named by GUID
 * and you have to already know the GUID to open one.
 *
 * A folder holds two kinds of entry:
 *   new       a file the mod adds        <guid>.tree
 *   patch     an override of base game   <guid>.tree_patch
 *
 * Patched files are the more interesting of the two to see listed, since nothing else
 * in the app tells you which vanilla content a mod is quietly changing.
 *
 * Strings are the exception: they are listed as the CSV files they live in, not as
 * their rows. A mod's strings are not only DDS text -- room names, job titles and
 * evidence names sit in files of their own -- and a row of those has nothing to open.
 * One of these opens as a list of its strings; see stringsEditor.js.
 */
import { readFileContent, tryGetFolder } from '../../../core/fs.js';
import { parseJSON } from '../../../core/jsonNumbers.js';
import {
    DDS_CONTENT_ROOT, ddsContentFolder, readManifest, toVirtual,
} from '../../../core/ddsManifest.js';

const CATEGORIES = [
    { id: 'trees', label: 'Trees', dir: ['DDS', 'Trees'], extension: 'tree', type: 'tree' },
    { id: 'messages', label: 'Messages', dir: ['DDS', 'Messages'], extension: 'msg', type: 'message' },
    { id: 'blocks', label: 'Blocks', dir: ['DDS', 'Blocks'], extension: 'block', type: 'block' },
];

/**
 * Trees, messages and blocks are listed from their own folders, so the strings walk
 * has no reason to go into DDS/ -- and every reason not to, since a large mod keeps
 * thousands of files there and the panel is rebuilt on every selection.
 */
const NOT_STRINGS = new Set(['DDS']);

/** What a strings entry is opened as: text rather than a document. See openPanelEntry. */
export const STRINGS_OPEN_AS = 'strings';

/** Vanilla content has a name in the generated reference data; a mod's own does not. */
const vanillaName = (id) => window.ddsMap?.idNameMap?.[id] ?? null;

async function readEntries(contentFolder, category) {
    const folder = await tryGetFolder(contentFolder, [DDS_CONTENT_ROOT, ...category.dir]);
    if (!folder) return [];

    const entries = [];

    for await (const entry of folder.values()) {
        if (entry.kind !== 'file') continue;

        const patch = entry.name.endsWith(`.${category.extension}_patch`);
        const isNew = entry.name.endsWith(`.${category.extension}`);
        // .newspaper files sit alongside messages but are a companion, not a message.
        if (!patch && !isNew) continue;

        const id = entry.name.split('.')[0];
        entries.push({
            id,
            type: category.type,
            kind: patch ? 'patch' : 'new',
            name: patch ? vanillaName(id) : await nameInside(entry),
            // The file the GUID is stored in. A mod's own document and a patch of the
            // base game's differ only by extension, so the GUID alone does not say which
            // of the two is on disk -- which deleting one has to know.
            file: entry.name,
        });
    }

    return entries.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

/** A mod's own files carry their display name inside; patches only hold a diff. */
async function nameInside(fileHandle) {
    try {
        return parseJSON(await readFileContent(fileHandle))?.name ?? null;
    } catch {
        return null;
    }
}

/**
 * The mod's strings files, each with the path the game reads it from.
 *
 * Conventionally they sit under Strings/ nested by language and then by what they name
 * -- Strings/English/DDS/dds.blocks.csv, Strings/English/Evidence/evidence.names.csv,
 * and some, room names among them, directly under the language. A manifest-using mod
 * puts them wherever it likes and declares the rest, so the walk starts at the content
 * root and covers both.
 *
 * The manifest is never a source of entries, only an annotation on what is on disk.
 * That is what makes a mapped file appear once rather than twice, and an entry naming
 * a file that is not there stay quietly out of the list.
 */
async function readStringsFiles(contentFolder) {
    const root = await ddsContentFolder(contentFolder);
    if (!root) return [];

    const manifest = await readManifest(root);

    return (await collectCsvFiles(root, [], NOT_STRINGS))
        .map((file) => {
            const virtual = toVirtual(manifest, file.path);
            return { ...file, virtual, mapped: virtual !== file.path };
        })
        .sort((a, b) => a.virtual.localeCompare(b.virtual));
}

/** @param skip directory names to leave alone, at this level only */
async function collectCsvFiles(folder, trail, skip) {
    const files = [];

    for await (const entry of folder.values()) {
        if (entry.kind === 'directory') {
            if (skip?.has(entry.name)) continue;
            files.push(...await collectCsvFiles(entry, [...trail, entry.name]));
            continue;
        }

        if (!entry.name.toLowerCase().endsWith('.csv')) continue;

        files.push({
            path: [...trail, entry.name].join('/'),
            name: entry.name.replace(/\.csv$/i, ''),
        });
    }

    return files;
}

/**
 * Everything in the selected content folder, grouped the way DDS content nests, in
 * the shape core/filePanel.js renders.
 */
export async function listContent(contentFolder) {
    if (!contentFolder) return null;

    const categories = [];

    for (const category of CATEGORIES) {
        const found = await readEntries(contentFolder, category);

        categories.push({
            id: category.id,
            label: category.label,
            entries: found.map((entry) => ({
                id: entry.id,
                label: entry.name || entry.id,
                tag: entry.kind === 'patch' ? 'patch' : null,
                openAs: entry.type,
                // What is on disk, which is what deleting the entry removes.
                file: entry.file,
            })),
        });
    }

    categories.push({
        id: 'strings',
        label: 'Strings',
        entries: (await readStringsFiles(contentFolder)).map((file) => ({
            // The real path: two mappings can claim one virtual path, but two files
            // cannot share a place on disk.
            id: file.path,
            label: file.name,
            tag: file.mapped ? 'mapped' : null,
            // Two languages hold files of the same name, so the path is what tells
            // them apart -- the one the game reads, and where it actually is when the
            // manifest has moved it.
            title: file.mapped ? `${file.virtual} (really ${file.path})` : file.path,
            openAs: STRINGS_OPEN_AS,
        })),
    });

    return categories;
}
