/**
 * Taking a ScriptableObject file out of a case, and finding what pointed at it first.
 *
 * A case folder is a web of `REF:` strings. A MurderMO names the MurderPreset it is
 * compatible with, and a preset copies from another -- so deleting one asset routinely
 * breaks two or three others, and nothing in the panel says which. That is what this goes
 * and reads.
 *
 * The manifest is not one of them, though it does name the file. It lists **files** --
 * `REF:EP_Flyer.EvidencePreset`, where every other document names an **asset**,
 * `REF:EvidencePreset|EP_Flyer`; see core/soFileName.js -- and its listing is taken out
 * along with the file it names. What the list is for is the references that are *left*, and
 * naming the one thing that gets cleaned up turns "nothing else refers to it" into a
 * warning about the mod's own load order in nearly every deletion, which is the message
 * saying something untrue about itself the one time an author most needs to trust it.
 */
import { readFileContent, removeFile } from '../../../core/fs.js';
import { confirmDelete } from '../../../core/deletion.js';
import { MANIFEST_FILE, removeListing } from '../../../core/murderManifest.js';
import { PATCH_SUFFIX, PRESET_SUFFIX } from '../../../core/soFileName.js';
import { parseJSON } from '../../../core/jsonNumbers.js';

/**
 * A `REF:`, split into the type it names and the asset.
 *
 * The type is optional because both forms occur: this app writes `REF:Type|Name`, and a
 * mod written by hand -- or by the loader's own examples -- writes the bare `REF:Name`.
 */
const REF = /^REF:(?:([^|]+)\|)?(.+)$/;

/** Every string anywhere in a parsed document, however deeply it is nested. */
function* strings(value) {
    if (typeof value === 'string') {
        yield value;
    } else if (Array.isArray(value)) {
        for (const item of value) yield* strings(item);
    } else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) yield* strings(item);
    }
}

/**
 * Whether a document points at the asset.
 *
 * The type is checked only when the reference states one. Hundreds of asset names belong
 * to more than one type -- `Bar` is six things -- so a bare `REF:Bar` cannot be attributed
 * to any one of them, and is reported against all six rather than against none. An
 * over-broad warning costs an author a look at a file; a missed one costs them a mod that
 * silently stopped working.
 */
export function refersToAsset(document, { assetName, type }) {
    for (const text of strings(document)) {
        const match = REF.exec(text.trim());
        if (!match) continue;

        const [, refType, refName] = match;
        if (refName.trim() !== assetName) continue;
        if (refType && type && refType.trim() !== type) continue;

        return true;
    }

    return false;
}

/**
 * What the two functions below are told about the file being deleted:
 *
 *   { id, suffix, label, assetName, type }
 *
 * All five come off the panel entry -- `type` is its `openAs` -- and each is a different
 * question. `id` and `suffix` are the file, which is what is removed and what the manifest
 * lists. `label` is what the author sees, which is what the question is put in terms of.
 * `assetName` and `type` are what a `REF:` in another document resolves against, which is
 * not always what the file is called.
 */

/** The file a target stands for: the two forms live side by side and differ by suffix. */
const fileOf = (target) => `${target.id}${target.suffix ?? PRESET_SUFFIX}`;

/**
 * Everything in the content folder that points at this asset, labelled as the panel
 * labels a file.
 *
 * The folder is walked rather than the last listing being reused: a listing holds what
 * each file *is*, and this needs what each file *says*, which is only in the file.
 *
 * A file that will not parse is passed over. It states no references that can be read, and
 * reporting it as clean is the same answer as reporting it as unreadable would be -- the
 * author already has an Invalid entry in the panel telling them about it.
 */
export async function referencesToAsset(contentFolder, target) {
    if (!contentFolder) return [];

    const found = [];
    const self = fileOf(target);

    for await (const handle of contentFolder.values()) {
        if (handle.kind !== 'file' || handle.name === self) continue;

        // The load order goes when the file does, so it is not a reference left behind.
        if (handle.name === MANIFEST_FILE) continue;

        const suffix = [PATCH_SUFFIX, PRESET_SUFFIX].find((end) => handle.name.endsWith(end));
        if (!suffix) continue;

        let parsed = null;
        try {
            parsed = JSON.parse(await readFileContent(handle));
        } catch {
            continue;
        }

        if (refersToAsset(parsed, target)) found.push(handle.name.slice(0, -suffix.length));
    }

    return found.sort((a, b) => a.localeCompare(b));
}

/**
 * Ask, and then delete: the file, and the load order entry that named it.
 *
 * The file first. `removeListing` reads the manifest and writes it back, and doing that
 * before the removal would leave a mod whose manifest has forgotten a file that is still
 * sitting in the folder -- the state this app spends most of its manifest handling trying
 * to avoid. This way a failure part way through leaves the file deleted and named, which
 * the panel and the manifest panel both show.
 *
 * @returns whether anything was deleted -- false when the author said no
 */
export async function deleteAsset(contentFolder, target) {
    if (!contentFolder) return false;

    const references = await referencesToAsset(contentFolder, target);
    if (!confirmDelete(target.label, references)) return false;

    await removeFile(contentFolder, [fileOf(target)]);
    await removeListing(contentFolder, target.id);

    return true;
}
