import { createFileIfMissing, deepClone } from '../../../core/files.js';
import { makeCSVSafe, makeNameFieldSafe } from '../../../core/strings.js';
import { refFor } from '../../../core/murderManifest.js';
import { PATCH_SUFFIX, PRESET_SUFFIX, stemFor } from '../../../core/soFileName.js';

/**
 * Lay out a new case inside a content folder: the preset it revolves around, and the
 * manifest telling the loader what to load and in what order.
 *
 * No DDS folders. This used to offer to create them, on the grounds that the case
 * might gain dialogue later; the DDS flow now makes them when there is a document to
 * put in them, so a folder full of empty directories is no longer the price of a case.
 */
export async function scaffoldCase(folder, name, type) {
    const hasPreset = type === 'MurderMO' || type === 'JobPreset';

    if (hasPreset) {
        await createFileIfNotExisting(name, type, folder, (content) => {
            content.name = name;
            content.presetName = name;
            content.notes = name;
            content.copyFrom = null;
            return content;
        });
    }

    await createFileIfNotExisting('murdermanifest', 'MurderManifest', folder, (content) => {
        if (hasPreset) {
            // Named exactly as the file is named. This used to lowercase what it wrote,
            // which `isListed` tolerates and the loader does too -- but an entry that
            // does not match the file it names is one an author has to read twice, and
            // there is now more of it to disagree about.
            content.fileOrder.splice(0, 0, refFor(stemFor(name, type)));
        }
        return content;
    });
}

export function cloneTemplate(template) {
    var templateToClone = template in window.enums ? 0 : window.templates[template];
    if(templateToClone === undefined)
    {
        function remapTemplate(obj)
        {
            let keys = Object.keys(obj);
            for(let i = 0; i < keys.length; i++)
            {
                let childType = obj[keys[i]].Item1;
                let isArray = obj[keys[i]].Item2;

                let newVal = deepClone(window.basicTypeTemplates[childType] ?? childType);
                
                if(newVal === childType && !(childType in window.typeMap) && !(childType in window.enums))
                {
                    console.warn(`TypeMap is missing: ${childType}`);
                }

                if(isArray) {
                    newVal = [];
                }
                else if(childType in window.typeMap)
                {
                    newVal = `REF:${childType}|${window.typeMap[childType][0]}`;
                }
                else if(childType in window.enums)
                {
                    newVal = 0;
                }

                obj[keys[i]] = newVal;
            }

            return obj;
        }

        templateToClone = remapTemplate(deepClone(window.typeLayout[template]));
    }
    return deepClone(templateToClone);
}

/**
 * An override: a list of changes the loader makes to the base game asset of the same name.
 * A new one changes nothing, so it holds what identifies it -- the asset, which the file
 * name repeats, and the type, which a patch has no other way to state -- and an empty list.
 *
 * The list is what marks the file as this format rather than the one it replaces, so it is
 * written even when it is empty. See scripts/patchFormat.js.
 */
export async function createOverrideIfNotExisting(name, type, handle) {
    return createFileIfMissing(handle, [`${name}${PATCH_SUFFIX}`], () => ({ name, fileType: type, patches: [] }));
}

/**
 * Create one of the mod's own assets, and answer with the file it is stored as.
 *
 * The stem is the caller's next problem rather than an afterthought: the manifest has to
 * name the file, and the file is not named after the asset alone -- see
 * core/soFileName.js.
 *
 * The manifest is the one file here that is not a typed asset, so it is the one file
 * whose name carries no type. That is the same fact as its having no `fileType`, which
 * is why one test governs both.
 */
export async function createFileIfNotExisting(filename, type, handle, newFileContentCallback) {
    const isAsset = type !== 'MurderManifest';
    const stem = isAsset ? stemFor(filename, type) : filename;

    await createFileIfMissing(handle, [`${stem}${PRESET_SUFFIX}`], () => {
        const template = cloneTemplate(type);
        if (isAsset) template.fileType = type;
        return newFileContentCallback(template);
    });

    return stem;
}
