import { createFileIfMissing, deepClone } from '../../../core/files.js';
import { makeCSVSafe, makeNameFieldSafe } from '../../../core/strings.js';
import { PATCH_SUFFIX } from './contentList.js';

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
            content.fileOrder.splice(0, 0, `REF:${name.toLowerCase()}`);
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
 * An override: a partial file the loader applies over the base game asset of the same
 * name. A new one overrides nothing, so it holds only what identifies it -- the asset,
 * which the file name repeats, and the type, which a patch has no other way to state.
 */
export async function createOverrideIfNotExisting(name, type, handle) {
    return createFileIfMissing(handle, [`${name}${PATCH_SUFFIX}`], () => ({ name, fileType: type }));
}

export async function createFileIfNotExisting(filename, type, handle, newFileContentCallback) {
    const segments = Array.isArray(filename) ? filename : [`${filename}.sodso.json`];

    return createFileIfMissing(handle, segments, () => {
        const template = cloneTemplate(type);
        // The manifest describes the mod rather than being a typed asset itself.
        if (type !== 'MurderManifest') template.fileType = type;
        return newFileContentCallback(template);
    });
}
