/**
 * Shadows of Doubt content GUIDs are real UUIDs: the pattern enforces a version
 * nibble of 1-5 and a variant nibble of 8/9/a/b. Placeholder GUIDs that ignore those
 * (all-zeroes, for instance) are rejected.
 *
 * Was declared independently in DDSViewer/index.js and
 * CaseEditor/scripts/jsonTreeAdditions.js, byte-identical in both.
 */
export const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
