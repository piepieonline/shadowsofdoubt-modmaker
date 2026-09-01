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

/**
 * What a value of a type the layout gives no fields for is: the leaves a document
 * bottoms out in, and the two-and-three-number structs the game treats as leaves.
 *
 * Composed here for the reason the two above are. This was the case flow's table alone,
 * and building a new array element is the second thing to need it -- the DDS flow now
 * builds its elements from the same layout rather than from a table of prompts keyed by
 * field name.
 *
 * `Boolean` is here *and* in `enums`, and the two disagree on purpose: a case document
 * stores every enum as its index, a boolean included, where a DDS document stores a real
 * `true`. Each flow says which of the two it wants first -- see cloneTemplate in the case
 * flow's modFileManager, and newElement in the DDS flow's elementTemplates.
 */
export const basicTypeTemplates = {
    Int32: 0,
    Single: 0,
    Boolean: false,
    String: '',
    // A TextAsset is named rather than described: a building preset's floorLayouts hold
    // `blueprints` and `controlRoomVariants`, each a list of floor blueprint names --
    // `FLOOR:Floors/MyFloor` for one the mod carries, the bare name for a base game one.
    // The layout gives no shape for the type, so without this the case flow could not
    // make an element of either array and offered no + on them. They are the only
    // TextAssets the game's layout describes, and both are arrays.
    TextAsset: '',
    Vector2: { x: 0, y: 0 },
    Vector3: { x: 0, y: 0, z: 0 },
    Color: { r: 0, g: 0, b: 0, a: 0 },
};
