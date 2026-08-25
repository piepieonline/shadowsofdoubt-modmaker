import { tryGetFile, readFileContent } from '../../../core/fs.js';

/**
 * Load the vanilla strings this flow resolves block text against.
 *
 * Choosing the folder is the shell's job now -- see core/folders.js -- so this only
 * reads from whatever has been connected.
 */
export async function loadVanillaStrings() {
    const ddsBlocksFile = await readFileContent(
        await tryGetFile(window.dirHandleStreamingAssets, ['Strings', 'English', 'DDS', 'dds.blocks.csv'], false)
    );
    window.vanillaDDSStringsContent = ddsBlocksFile.split(/(?:\r)?\n/).slice(3);
    window.createRSearchList();
}
