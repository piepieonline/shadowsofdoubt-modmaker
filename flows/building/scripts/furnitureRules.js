/**
 * The enums a furniture placement rule is written in, and the reader that turns a raw
 * `FurnitureClass` into the rules the resolver applies.
 *
 * Shared by the two places a class is read: `../tools/buildFurnitureChain.js`, which
 * reduces the game's own assets to `refs/derived/furnitureChain.json`, and
 * `furnitureOverlay.js`, which reads a mod's `.sodso.json` of the same type. They differ
 * only in how a reference resolves -- a pathID in the dump, a `REF:Type|Name` string in a
 * mod file -- which is the `name` argument. Everything else has to agree exactly, because
 * a mod's class that came out shaped differently from a shipped one is an answer that is
 * wrong only for the author's own content, which is the last place it would be noticed.
 *
 * ## The enums are index-addressed, and the obvious source for them is wrong
 *
 * The game serialises these fields as integers, so the order below *is* the meaning.
 *
 * They are not read from `refs/generated/soEnums.json`. That file keys enums on their bare
 * name, and the game declares `WallRule` twice: `FurnitureClass.WallRule` with 17 members
 * and `FurnitureCluster.WallRule` with 7. Only the cluster's survived the collision, and
 * `soTypeLayout.json` points both fields at the same name -- so a lookup through it comes
 * back with a confidently wrong answer for every tag past the sixth. A different failure
 * from the sorted-enum problem in GENERATOR.md §9a, with the same consequence.
 *
 * Transcribed instead from `enums.json` at the root of the ScriptableObject dump, which
 * carries all 333 enums from the decompiled `Assembly-CSharp` keyed on `fullName` and in
 * declaration order. Check against that, not against `soEnums.json`, if a tag ever reads
 * oddly.
 */

/** `FurnitureClass.WallRule` (FurnitureClass.cs:381). */
export const WALL_RULE = [
    'nothing', 'wall', 'window', 'windowLarge', 'entrance', 'ventUpper', 'ventLower',
    'wallOrUpperVent', 'ventTop', 'entranceDoorOnly', 'entranceToRoomOfType', 'anyWindow',
    'entraceDivider', 'securityDoorDivider', 'fence', 'addressEntrance', 'lightswitch',
];

/** `CityData.BlockingDirection` (CityData.cs:787). */
export const BLOCKING_DIRECTION = [
    'none', 'behindLeft', 'behind', 'behindRight', 'left', 'right',
    'frontLeft', 'front', 'frontRight',
];

/** `DoorPairPreset.WallSectionClass` (DoorPairPreset.cs:125). */
export const WALL_SECTION_CLASS = [
    'wall', 'window', 'windowLarge', 'entrance', 'ventUpper', 'ventLower', 'ventTop',
];

/** `FurnitureClass.FurnitureRuleOption` (FurnitureClass.cs:370). */
export const RULE_OPTION = ['mustFeature', 'cantFeature', 'canFeature'];

/**
 * Tags whose answer is not in a blueprint, whose rules are dropped rather than carried.
 *
 * `securityDoorDivider` reads far more than the wall it names: the room's `securityDoors`
 * rule, the address on the other side, whether that room holds a stairwell tile, the
 * security doors already placed on the floor, and above floor 0 whether the building's air
 * ducts reach a basement (`GenerationController.cs:4981-5070`). `lightswitch` needs a
 * placed interactable. Nine rules across two classes, and none at all, respectively.
 *
 * A class that loses rules this way keeps a count of them in `unchecked`, so the resolver
 * can say it is gated on something unread rather than quietly passing it.
 */
export const UNREADABLE_TAGS = new Set(['securityDoorDivider', 'lightswitch']);


/**
 * A class's wall rules, as the resolver reads them.
 *
 * Names rather than indices, for both the tag and the direction. The file is read by one
 * module that would otherwise have to carry these same enums, and the whole reason they
 * had to be recovered from a decompiled source is that an integer means nothing without
 * the list beside it. Names cost about 7 KB across the set and cannot rot.
 *
 * `canFeature` rules are dropped. They add `addScore` to the placement score when
 * satisfied and never reject (`GenerationController.cs:5083`), so they are not a gate:
 * 135 of the game's 841.
 *
 * `at` is omitted when a rule applies to the square itself, which is 500 of the 841 --
 * the same convention as `chance` on a cluster element, and for the same reason.
 *
 * The six `none` and three diagonal directions are carried unchanged rather than folded
 * away. `wallDict` is keyed on cardinal half-offsets (`NewNode.cs:120`), so those can
 * never resolve a wall and always take the no-wall branch -- but all nine are
 * `mustFeature nothing`, which that branch satisfies, so what each actually asserts is
 * that its offset node exists. `3x1LobbyDesk` uses six to require that the 3x2 in front of
 * it be real nodes. A live requirement written through a quirk, not a dead rule, and the
 * ordinary path gets it right without a special case.
 *
 * @param raw   a `FurnitureClass`, in either the dump's shape or a mod file's
 * @param name  resolves a `roomType` reference to a `RoomConfiguration` name
 */
export function wallRulesOf(raw, name) {
    const rules = [];
    let unchecked = 0;

    for (const rule of raw.wallRules ?? []) {
        const option = RULE_OPTION[rule.option ?? 0];
        if (option === 'canFeature') continue;

        const tag = WALL_RULE[rule.tag ?? 0];

        // An index past the end of the enum, which a mod can write and the game cannot.
        // Counted with the unreadable rather than dropped silently: the class is gated on
        // something this cannot answer, which is exactly what `unchecked` says.
        if (tag === undefined || UNREADABLE_TAGS.has(tag)) { unchecked++; continue; }

        const at = [rule.nodeOffset?.x ?? 0, rule.nodeOffset?.y ?? 0];
        const room = tag === 'entranceToRoomOfType' ? name(rule.roomType) : null;

        rules.push({
            dir: BLOCKING_DIRECTION[rule.wallDirection ?? 0] ?? 'none',
            tag,
            must: option === 'mustFeature',
            ...(at[0] === 0 && at[1] === 0 ? {} : { at }),
            ...(room ? { room } : {}),
        });
    }

    return { rules, unchecked };
}

/**
 * `allowedOnStairwell` and `onlyOnStairwell`, as the one field the game reads them as.
 *
 * With `allowedOnStairwell` off, the square *and its four orthogonal neighbours* must all
 * be clear of stairwell tiles, and `onlyOnStairwell` is never consulted at all -- it sits
 * in the `else` of that branch (`GenerationController.cs:4575-4601`). Two classes set
 * `onlyOnStairwell`, and for `1x1WallLampBallroom`, which leaves `allowedOnStairwell` off,
 * it is dead. Folded to follow the branch rather than what the pair of names suggests.
 *
 * Undefined -- the absent case -- is therefore "barred from stairwells and from anything
 * next to one", which is the default and 244 of the 262 classes.
 */
export function stairwellOf(allowed, only) {
    if (!allowed) return undefined;
    return only ? 'only' : 'allowed';
}
