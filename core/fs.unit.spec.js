import { test, expect, vi } from 'vitest';
import { tryGetFile, tryGetFolder, probeFile, probeFolder } from './fs.js';

/**
 * Telling "there is no such file" apart from "that could not be read".
 *
 * The two used to be one answer, and the answer was null. Everything that acts on a null
 * here acts on it by *writing*: creating the file it believes is absent, taking a free
 * name as free, giving a mod with no manifest a new one, building the preset it could not
 * find. So a permission that had lapsed or a disk busy enough to fail one read read as
 * absence, and absence was a licence to overwrite -- which is how a building came back as
 * a preset copying from its own name with one floor in it.
 *
 * Real handles need a directory, so those tests live in the Playwright suite. What is here
 * is the discrimination itself, which is the whole of the change and takes only a handle
 * shaped like one.
 */

/** A DOMException as the file system raises it, identified by name rather than by class. */
const fsError = (name) => Object.assign(new Error(`${name} from the test`), { name });

/** A directory handle that answers every lookup the same way. */
const handleThatThrows = (error) => ({
    getFileHandle: vi.fn(() => Promise.reject(error)),
    getDirectoryHandle: vi.fn(() => Promise.reject(error)),
});

const FOUND = { kind: 'file', name: 'found' };

const handleThatFinds = () => ({
    getFileHandle: vi.fn(() => Promise.resolve(FOUND)),
    getDirectoryHandle: vi.fn(() => Promise.resolve(FOUND)),
});


/* -------------------------------------------------------------------------- */
/* What counts as absence                                                      */
/* -------------------------------------------------------------------------- */

test('a name the folder does not hold is absent', async () => {
    const handle = handleThatThrows(fsError('NotFoundError'));

    expect(await tryGetFile(handle, ['nothing.json'])).toBeNull();
    expect(await tryGetFolder(handle, ['nothing'])).toBeNull();
});

test('a name taken by the other kind of thing is absent too', async () => {
    // Asking for a folder where a file sits, or the other way round. That is a fact about
    // the folder rather than a failure to look at it, and callers want the same answer.
    const handle = handleThatThrows(fsError('TypeMismatchError'));

    expect(await tryGetFile(handle, ['Floors'])).toBeNull();
    expect(await tryGetFolder(handle, ['preset.sodso.json'])).toBeNull();
});

test('no directory to look in is absent, rather than an error about a null', async () => {
    // Several callers reach here before a folder has been chosen -- no mod selected, no
    // game folder connected -- and "there is no file" is the answer they are asking for.
    expect(await tryGetFile(null, ['anything.json'])).toBeNull();
    expect(await tryGetFolder(undefined, ['anything'])).toBeNull();
});


/* -------------------------------------------------------------------------- */
/* What does not                                                               */
/* -------------------------------------------------------------------------- */

test('a read that failed is raised rather than reported as absence', async () => {
    // The one that cost a building: a disk under contention failing a read, taken for a
    // folder that does not hold the file, and the file then written over.
    for (const name of ['NotReadableError', 'NotAllowedError', 'InvalidStateError', 'AbortError']) {
        const handle = handleThatThrows(fsError(name));

        await expect(tryGetFile(handle, ['preset.sodso.json'])).rejects.toThrow(name);
        await expect(tryGetFolder(handle, ['Floors'])).rejects.toThrow(name);
    }
});

test('a caller handing over a path it cannot walk is raised', async () => {
    // getFile consumes its path with splice, so a string where an array belongs throws a
    // TypeError. Swallowed, the existence check it belonged to always failed and the file
    // was always written -- see the note at the top of core/files.js, which is where that
    // actually happened.
    const handle = handleThatFinds();

    await expect(tryGetFile(handle, 'MurderMO')).rejects.toThrow(TypeError);
});


/* -------------------------------------------------------------------------- */
/* The deliberate exception                                                    */
/* -------------------------------------------------------------------------- */

test('probeFolder answers null for any reason at all', async () => {
    // For working out the shape of a folder nobody here chose: the install root, its Data
    // directory, or StreamingAssets itself. Two of the three questions are expected to
    // fail and nothing is written on the answer, which is what makes this safe here and
    // nowhere else.
    for (const name of ['NotFoundError', 'NotReadableError', 'NotAllowedError']) {
        expect(await probeFolder(handleThatThrows(fsError(name)), ['StreamingAssets'])).toBeNull();
    }

    expect(await probeFolder(null, ['StreamingAssets'])).toBeNull();
    expect(await probeFolder(handleThatFinds(), ['StreamingAssets'])).toBe(FOUND);
});

test('probeFile does too, for a caller waiting on a file rather than acting on its absence', async () => {
    // The walkthrough re-reads the content folder every 400ms asking whether the step's
    // file has been written yet. One read failing means ask again on the next tick, not
    // end the step -- being patient is the step's whole job.
    for (const name of ['NotFoundError', 'NotReadableError', 'NotAllowedError']) {
        expect(await probeFile(handleThatThrows(fsError(name)), ['case.sodso.json'])).toBeNull();
    }

    expect(await probeFile(null, ['case.sodso.json'])).toBeNull();
    expect(await probeFile(handleThatFinds(), ['case.sodso.json'])).toBe(FOUND);
});
