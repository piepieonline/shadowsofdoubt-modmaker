import { afterEach, test, expect, vi } from 'vitest';
import { confirmRename, deletionMessage, renameMessage } from './deletion.js';

/**
 * What the author is asked before a file is taken out of their mod.
 *
 * The wording is the whole of what this module does, and it is the last thing standing
 * between a click and a file that cannot be got back -- so it is worth pinning that the
 * count agrees with the list, and that a file nothing points at says so rather than saying
 * nothing.
 */

afterEach(() => vi.unstubAllGlobals());

test('names the file and says nothing points at it', () => {
    const message = deletionMessage('EP_Flyer', []);

    expect(message).toContain('Delete "EP_Flyer" from this mod?');
    // Said out loud: an absent list would read as a check that was never made.
    expect(message).toContain('Nothing else in this mod refers to it.');
});

test('lists what points at it, and counts them', () => {
    const message = deletionMessage('NeonNoirTower', ['testcase', 'Lobby.AddressPreset']);

    expect(message).toContain('Referenced by 2 files:');
    expect(message).toContain('• testcase');
    expect(message).toContain('• Lobby.AddressPreset');

    // The author is told what confirming does and does not do to those files.
    expect(message).toContain('will be left as they are');
});

test('one reference is a file rather than 1 files', () => {
    expect(deletionMessage('X', ['a'])).toContain('Referenced by 1 file:');
});

test('a long list is cut off, and says how much it cut', () => {
    const many = Array.from({ length: 18 }, (unused, i) => `File${i}`);
    const message = deletionMessage('X', many);

    // The count above the list is the whole truth however much of it is shown.
    expect(message).toContain('Referenced by 18 files:');

    expect(message).toContain('• File14');
    expect(message).not.toContain('• File15');
    expect(message).toContain('… and 3 more');
});

test('exactly the cap is listed rather than trailed off', () => {
    const message = deletionMessage('X', Array.from({ length: 15 }, (unused, i) => `File${i}`));

    expect(message).toContain('• File14');
    expect(message).not.toContain('and 0 more');
});

test('no references at all is the same as an empty list', () => {
    expect(deletionMessage('X')).toBe(deletionMessage('X', []));
});

/**
 * What the author is asked before an asset's name changes under the files that name it.
 *
 * A rename is reversible where a deletion is not, so the bar for putting a question at all
 * is higher -- and what makes it worth putting is the same thing either way: the files that
 * will still be saying the old name when it is over.
 */

test('a rename names what the asset is called now and what it is about to be', () => {
    expect(renameMessage('HouseStyle', 'TowerStyle', ['testcase']))
        .toContain('Rename "HouseStyle" to "TowerStyle"?');
});

test('a rename lists what points at it, and says what does and does not follow', () => {
    const message = renameMessage('HouseStyle', 'TowerStyle', ['testcase', 'Lobby.AddressPreset']);

    expect(message).toContain('Referenced by 2 files:');
    expect(message).toContain('• testcase');
    expect(message).toContain('• Lobby.AddressPreset');

    // The half a tool that repaired the load order is assumed to have repaired, said out
    // loud: the author is otherwise told about a check without being told its limit.
    expect(message).toContain("This mod's load order will follow the new name");
    expect(message).toContain('Those files will not');
    expect(message).toContain('still says "HouseStyle"');
});

test('a rename cuts a long list off the same way a deletion does', () => {
    const many = Array.from({ length: 18 }, (unused, i) => `File${i}`);
    const message = renameMessage('X', 'Y', many);

    expect(message).toContain('Referenced by 18 files:');
    expect(message).toContain('• File14');
    expect(message).not.toContain('• File15');
    expect(message).toContain('… and 3 more');
});

test('an asset nothing points at is renamed without being asked about', () => {
    const asked = vi.fn(() => false);
    vi.stubGlobal('confirm', asked);

    // Unlike a deletion, which says "nothing refers to it" out loud. Renaming is ordinary
    // editing and it undoes itself, so a box here is a click that carries no information.
    expect(confirmRename('Old', 'New', [])).toBe(true);
    expect(confirmRename('Old', 'New')).toBe(true);
    expect(asked).not.toHaveBeenCalled();
});

test('an asset something points at is asked about, and no means no', () => {
    const asked = vi.fn(() => false);
    vi.stubGlobal('confirm', asked);

    expect(confirmRename('Old', 'New', ['testcase'])).toBe(false);
    expect(asked).toHaveBeenCalledWith(renameMessage('Old', 'New', ['testcase']));
});
