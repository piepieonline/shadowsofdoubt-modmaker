/**
 * The two newspaper fields, as lists to pick from.
 *
 * `newspaperCategory` and `newspaperContext` are plain `Int32` on `DDSTreeSave`. The game
 * has no enum for either -- `NewspaperController` compares them as numbers -- so the type
 * layout says `Int32` and the editor gave them a text box. An author writing an article
 * had to know that 6 means "lead slot, first kidnapping, kidnapper still active".
 *
 * They are presented as dropdowns anyway. The values are a fixed set with fixed meanings
 * even though the source does not name them, and a list of nine slots beats a box wanting
 * a number nothing on screen explains. Meanings are from `ddsCategories.md` §4.3, read out
 * of `NewspaperController.GenerateNewspaper` and `GetContextObject`.
 *
 * ## Not the `Category` enum
 *
 * The generated enums do carry a `Category` -- five values, `general`, `murder`, `ad`,
 * `foreignAffairs`, `murderSecond` -- and it is the obvious thing to reach for here. It is
 * the wrong list. That enum belongs to `NewspaperArticle`, the separate `.newspaper` file,
 * and it disagrees with this field: 1 is `murder` there and a classified ad here, 2 is
 * `ad` there and the foreign-affairs slot here. The shipped trees run to 8 -- `Kidnapper_2`
 * is 7, `Kidnapper_Caught_01` is 8 -- which a five-value enum cannot express at all.
 *
 * `newspaperContext` is the opposite case: `ContextSource` matches §4.3's table 0-5 value
 * for value, so it is reused rather than copied.
 */
import { enums } from '../../../core/refs.js';

/**
 * Which slot of the paper an article competes for.
 *
 * `GenerateNewspaper` fills five slots and picks one message at random from the trees
 * matching each. Indexed by value, so the position in this list is the number in the file.
 */
export const NEWSPAPER_CATEGORIES = [
    'General article — filler, and the lead when no murder is active',
    'Classified ad — four are drawn per paper',
    'Foreign affairs — the third article slot',
    'Lead: first murder, killer still active',
    'Lead: repeat murder by the same killer, still active',
    'Lead: murder, killer caught',
    'Lead: first kidnapping, kidnapper still active',
    'Lead: repeat kidnapping, kidnapper still active',
    'Lead: kidnapping, kidnapper caught',
];

/**
 * What the `|tokens|` in the article resolve against.
 *
 * Set this to match the scope the block text uses: a `|murder.*|` token written against
 * context `nothing` produces empty text.
 *
 * The game's own `ContextSource`, which stops at 5. A value of 6 or more means a specific
 * citizen -- `humanID = value - 6` -- which `NewspaperController` writes at runtime and no
 * authored tree has ever held, so the list does not offer them. See below for what happens
 * to a file that has one anyway.
 */
export const newspaperContexts = () => enums.ContextSource ?? [];

/** The fields this module answers for, keyed as `scripts/treeViews.js` keys them. */
const OPTIONS = {
    'DDSTreeSave.newspaperCategory': () => NEWSPAPER_CATEGORIES,
    'DDSTreeSave.newspaperContext': newspaperContexts,
};

/**
 * The list this field is picked from, or null if it is not one of these two.
 *
 * @param resolved a `core/typeHints.js` resolution
 */
export function newspaperOptions(resolved) {
    if (!resolved) return null;

    return OPTIONS[`${resolved.ownerType}.${resolved.field}`]?.() ?? null;
}

/**
 * The extra entry a file needs when it holds a number this list has no name for.
 *
 * A runtime-written `newspaperContext` of 7, or a category from a game update that added
 * one. Without this the control would select nothing and so display its first option,
 * which is an editor quietly claiming the file says `nothing` when it says 7 -- and the
 * next edit to any other field would leave that misreading on screen as the truth.
 *
 * Shown as the bare number, because that is all that is known about it.
 *
 * @returns a `leadingOptions` list for `createSelectEditor`, usually empty
 */
export function unnamedValueOption(options, currentValue) {
    const value = Number(currentValue);

    if (!Number.isInteger(value) || (value >= 0 && value < options.length)) return [];

    return [{ value, text: `${value} — not a value this editor has a name for` }];
}
