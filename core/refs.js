/**
 * The reference data both flows read, composed once.
 *
 * `core/typeHints.js` resolves a field to a type name; this is what those names are
 * looked up in. Each flow used to build its own table, which is how the two came to
 * disagree about what a `Boolean` is: the case flow rendered one as a dropdown and the
 * DDS flow as a text field, for no reason either of them recorded.
 *
 * **Imported only from a flow's `scripts/loadRefs.js`.** Those are dynamically imported
 * on activation, which is what keeps ~800 KB of generated JSON off the initial page
 * load. Importing this from anywhere `main.js` reaches would undo that. See the
 * `loadRefs` note in core/flowRegistry.js.
 *
 * A JSON module is fetched and parsed once per page, so both flows share these objects
 * rather than copying them. Neither may mutate them.
 */
import soEnums from '../refs/generated/soEnums.json' with { type: 'json' };
import soTypeLayout from '../refs/generated/soTypeLayout.json' with { type: 'json' };

import basicEnums from '../refs/authored/basicEnums.json' with { type: 'json' };
import basicTypeLayouts from '../refs/authored/basicTypeLayouts.json' with { type: 'json' };

/**
 * Enum values by type name, in index order -- the game serialises these fields as
 * integers, so the position of a value is its meaning.
 *
 * The generated file wins a collision, as it did when the case flow composed this.
 */
export const enums = { ...basicEnums, ...soEnums };

/**
 * Every type's fields: `{ Item1: type, Item2: isArray, Item3: description }`.
 *
 * A flow may add entries of its own -- the case flow describes the manifest file, which
 * is not a game type -- but neither reads the generated file directly.
 */
export const typeLayout = { ...basicTypeLayouts, ...soTypeLayout };
