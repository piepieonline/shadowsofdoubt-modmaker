/**
 * Reference data lives at the repo root in refs/, not in this flow. ddsContentIndex is
 * the same file the case flow reads -- there used to be a copy per flow, and they had
 * drifted a hundred blocks apart. See refs/README.md.
 *
 * The type layout and the enums are shared too, and composed in one place: a DDS
 * document is a game type like any other -- a tree is a `DDSTreeSave`, its messages are
 * `DDSMessageSettings` -- so the generated layout describes it, and this flow no longer
 * keeps a hand-written table of enums keyed by field name. That table had drifted: it
 * named index 6 of `triggerPoint` `newspaperMurder`, where the game has
 * `newspaperArticle`.
 */
import ddsMap from '../../../refs/generated/ddsContentIndex.json' with { type: 'json' };

import templates from '../../../refs/authored/ddsTemplates.json' with { type: 'json' };
import fieldDescriptions from '../../../refs/authored/fieldDescriptions.json' with { type: 'json' };

import { enums, typeLayout } from '../../../core/refs.js';

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
    typeLayout,
    enums,
    fieldDescriptions,
};
