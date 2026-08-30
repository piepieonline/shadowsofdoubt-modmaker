import { test, expect } from 'vitest';
import { typeLayout } from './refs.js';
import { resolveField } from './typeHints.js';
import soDefaults from '../refs/generated/soDefaults.json' with { type: 'json' };

/**
 * That the reference data still describes the fields a type *inherits*.
 *
 * `soTypeLayout.json` records only the fields a type declares itself. The game's types
 * inherit plenty -- `BossConfig` gets `occupation` from `OccupationSettings`, every DDS
 * document gets `name` and `id` from `DDSComponent`, every preset gets `presetName` from
 * `SoCustomComparison` -- and `resolveField` walks the layout literally, so a field the
 * layout does not name resolves to nothing. In the editor that is a reference field
 * rendered as a free-text box instead of a dropdown of the assets it can point at.
 *
 * Those fields are inlined into the checked-in file **by hand**, which the next
 * regeneration silently undoes -- see refs/GENERATOR.md section 8. That is what these
 * tests are for: they are the only thing that notices.
 *
 * Importing core/refs.js here is fine, and importing it from anywhere main.js reaches is
 * not: the reason it is loaded from a flow's loadRefs.js is to keep ~800 KB of JSON off
 * the initial page load, and a test has no page to load.
 */

/** The type a path lands on, or undefined. */
const typeAt = (...splitPath) => resolveField(splitPath, typeLayout)?.type;

test('a company structure names an occupation the editor can offer a list for', () => {
    // The reported bug. `companyStructure` is a `BossConfig`, which declares only
    // `subordinates` and inherits the other four fields from `OccupationSettings`.
    expect(typeAt('CompanyStructurePreset', 'companyStructure', 'occupation'))
        .toBe('OccupationPreset');

    expect(typeAt('CompanyStructurePreset', 'companyStructure', 'payGrade')).toBe('Single');
});

test('every level of the company hierarchy names an occupation', () => {
    // BossConfig -> Hierarchy1Config -> Hierarchy2Config -> Hierarchy3Config, each of
    // which declares only `subordinates` and inherits the same four fields. The last
    // step is an OccupationSettings outright.
    const path = ['CompanyStructurePreset', 'companyStructure'];

    for (let depth = 0; depth < 4; depth++) {
        expect(typeAt(...path, 'occupation')).toBe('OccupationPreset');
        path.push('subordinates');
    }

    expect(typeAt(...path, 'occupation')).toBe('OccupationPreset');
});

test('a DDS document has the name and id it inherits from DDSComponent', () => {
    // The two fields an author touches first, on all three document types.
    for (const type of ['DDSTreeSave', 'DDSMessageSave', 'DDSBlockSave']) {
        expect(typeAt(type, 'name')).toBe('String');
        expect(typeAt(type, 'id')).toBe('String');
    }
});

test('a door pair preset has the id a floor blueprint addresses it by', () => {
    // Inherited from ScriptableObjectIDSystem. DoorPairPreset is the one asset type with
    // an `id` instead of a `presetName`.
    expect(typeAt('DoorPairPreset', 'id')).toBe('String');
});

test('every preset type the layout describes has its presetName', () => {
    // Asserted over the whole set rather than a sample: `presetName` is the field the
    // editor renames a file by, and the default templates say exactly which types have
    // one. Any type that grows or loses a presetName is covered without editing this.
    const shouldHaveOne = Object.keys(soDefaults)
        .filter(type => 'presetName' in soDefaults[type] && typeLayout[type]);

    // 81 of them at the time of writing -- enough that an empty filter would be the bug.
    expect(shouldHaveOne.length).toBeGreaterThan(50);

    const without = shouldHaveOne.filter(type => typeAt(type, 'presetName') !== 'String');
    expect(without).toEqual([]);
});
