import ddsMap from './ref/ddsMap.json' with { type: 'json' };
import templates from './ref/templates.json' with { type: 'json' };
import enums from './ref/enums.json' with { type: 'json' };

window.ddsMap = {
    trees: ddsMap.Trees,
    messages: ddsMap.Messages,
    blocks: ddsMap.Blocks,
    idNameMap: ddsMap.IdNameMap,
    reverseIdMap: ddsMap.ReverseIdMap
};

window.templates = templates;
window.enums = enums;
