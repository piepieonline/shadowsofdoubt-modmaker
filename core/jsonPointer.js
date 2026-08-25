/**
 * RFC 6901 JSON Pointer for a jsonTree node.
 * Identical in both apps before extraction.
 */
export function getJSONPointer(node) {
    if (node.isRoot) {
        return "";
    }

    return getJSONPointer(node.parent) + "/" + node.label;
}
