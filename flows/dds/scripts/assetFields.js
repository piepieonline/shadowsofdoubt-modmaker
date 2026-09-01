/**
 * The DDS fields that hold the *name* of a game asset.
 *
 * The game's layout types all of these as `String`, which is true and not useful: a
 * participant's `traits` are names of `CharacterTrait` assets, and nothing but the field
 * they are in says so. Left as text, an author had to know that `Char-Enthusiastic` is
 * spelled exactly that way, against 389 traits they could not see -- and a typo is not an
 * error anywhere, it is a condition that never matches in a conversation that then never
 * plays.
 *
 * So these rows get the searchable dropdown the case editor gives a reference field. The
 * value written is still the bare name the game reads; only the way it is chosen changes.
 *
 * Keyed by the type that *owns* the field rather than by the field's name, which is the
 * distinction the old element table got wrong -- `traits` appears on four unrelated types
 * and would one day appear on a fifth that means something else by it.
 *
 * A name the list does not hold is still allowed, and has to be: a mod may define traits
 * of its own, and the ones it has not written yet are names nothing here can know. See
 * `allowCustom` where this is rendered.
 */

/** `<owner type>.<field>` -> the type of asset the name belongs to. */
const ASSET_NAME_FIELDS = {
    // Who a conversation, a line or a branch is for. The DDS format names a trait the
    // short way -- `Char-Cheerful` -- where a case document would write
    // `REF:CharacterTrait|Char-Cheerful`.
    'DDSParticipant.traits': 'CharacterTrait',
    'DDSMessageLink.traits': 'CharacterTrait',
    'DDSBlockCondition.traits': 'CharacterTrait',
    'DDSReplacement.traits': 'CharacterTrait',

    // A citizen's occupation, which is what `useJobs` casts against. `JobPreset` is the
    // other thing the game calls a job -- the side work an objective is built from --
    // and it is not this.
    'DDSParticipant.jobs': 'OccupationPreset',

    // What the tree may hand out, which is an interactable of the game's.
    'DDSTreeSave.itemPool': 'InteractablePreset',
};

/**
 * The kind of asset this node names, or null if it does not name one.
 *
 * Only elements of an array, because every one of these fields is a list of names and the
 * array itself is a node too -- both resolve to the same field, since the layout is walked
 * with array indices dropped. The list is edited by adding to it; a name is edited in the
 * row it sits in.
 *
 * @param resolved  what core/typeHints.js made of the node's path
 * @param isElement whether the node is an element of an array rather than the array
 */
export function assetTypeOfField(resolved, isElement) {
    if (!resolved || !isElement) return null;

    return ASSET_NAME_FIELDS[`${resolved.ownerType}.${resolved.field}`] ?? null;
}

/** Every asset type these fields can name, for the reference data to be checked against. */
export const ASSET_TYPES_NAMED = [...new Set(Object.values(ASSET_NAME_FIELDS))];
