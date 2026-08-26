/**
 * Reference data lives at the repo root in refs/, not in this flow. ddsContentIndex is
 * the same file the case flow reads -- there used to be a copy per flow, and they had
 * drifted a hundred blocks apart. See refs/README.md.
 */
import ddsMap from '../../../refs/generated/ddsContentIndex.json' with { type: 'json' };
import templates from '../../../refs/authored/ddsTemplates.json' with { type: 'json' };
import enums from '../../../refs/authored/ddsEnums.json' with { type: 'json' };

/**
 * The flow's reference data, returned rather than assigned to window: the registry
 * installs it on every activation. See the loadRefs note in core/flowRegistry.js.
 */
export default {
    ddsMap: {
        trees: ddsMap.Trees,
        messages: ddsMap.Messages,
        blocks: ddsMap.Blocks,
        idNameMap: ddsMap.IdNameMap,
        reverseIdMap: ddsMap.ReverseIdMap
    },
    templates,
    enums,
};
