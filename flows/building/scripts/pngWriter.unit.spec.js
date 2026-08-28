/**
 * The PNG encoder.
 *
 * What matters is that the bytes are a file a decoder accepts and that the pixels come
 * back out unchanged -- particularly for the mask map, whose alpha channel is packed
 * data rather than transparency and is the reason none of this goes through a canvas.
 *
 * So the tests decode rather than compare against a fixture. A golden file would pass
 * for a broken encoder as readily as a working one, given that both ends of the
 * comparison would be this module's own output.
 */
import { describe, expect, it } from 'vitest';

import { encodePng } from './pngWriter.js';

const SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/** An image of `width * height` pixels, each a function of where it is. */
function image(width, height, colourAt) {
    const pixels = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) pixels.set(colourAt(x, y), (y * width + x) * 4);
    }

    return pixels;
}

/**
 * Walk a PNG's chunks, checking every length and CRC on the way.
 *
 * The check is the point: a chunk whose declared length or checksum is wrong is a file
 * every real decoder rejects, and nothing about the bytes looks wrong from the outside.
 */
function chunks(png) {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const found = [];

    let at = 8;
    while (at < png.length) {
        const length = view.getUint32(at);
        const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
        const data = png.subarray(at + 8, at + 8 + length);

        expect(view.getUint32(at + 8 + length), `${type} CRC`)
            .toBe(crc32(png.subarray(at + 4, at + 8 + length)));

        found.push({ type, data });
        at += 12 + length;
    }

    expect(at, 'the chunks account for the whole file').toBe(png.length);
    return found;
}

/** The image data, inflated and with its per-row filter bytes taken off. */
async function decode(png, width, height) {
    const idat = chunks(png).filter((chunk) => chunk.type === 'IDAT');
    const joined = new Uint8Array(idat.reduce((total, chunk) => total + chunk.data.length, 0));

    let at = 0;
    for (const chunk of idat) {
        joined.set(chunk.data, at);
        at += chunk.data.length;
    }

    const stream = new Blob([joined]).stream()
        .pipeThrough(new DecompressionStream('deflate'));
    const raw = new Uint8Array(await new Response(stream).arrayBuffer());

    const stride = width * 4;
    expect(raw.length, 'a filter byte per row, then the row').toBe((stride + 1) * height);

    const rows = [];
    for (let row = 0; row < height; row++) {
        expect(raw[row * (stride + 1)], `row ${row} filter`).toBe(0);
        rows.push(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    }

    return rows;
}

function crc32(bytes) {
    let crc = 0xFFFFFFFF;

    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }

    return (crc ^ 0xFFFFFFFF) >>> 0;
}


describe('encodePng', () => {
    it('writes a signature, a header, image data and an end marker, in that order', async () => {
        const png = await encodePng(2, 2, image(2, 2, () => [1, 2, 3, 4]));

        expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);
        expect(chunks(png).map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    });

    it('declares the size, 8 bits a channel, RGBA, and no interlacing', async () => {
        const png = await encodePng(7, 3, image(7, 3, () => [0, 0, 0, 0]));
        const [header] = chunks(png);
        const view = new DataView(header.data.buffer, header.data.byteOffset);

        expect(view.getUint32(0)).toBe(7);
        expect(view.getUint32(4)).toBe(3);
        expect([...header.data.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    });

    it('brings every channel back byte for byte', async () => {
        // The mask map's four channels: metallic, occlusion, detail and smoothness, none
        // of which means transparency. Round-tripping these through a canvas would
        // premultiply the first three by the fourth and lose them.
        const packed = [0x00, 0xBF, 0x80, 0xD9];
        const png = await encodePng(4, 2, image(4, 2, () => packed));

        for (const row of await decode(png, 4, 2)) {
            for (let x = 0; x < 4; x++) expect([...row.subarray(x * 4, x * 4 + 4)]).toEqual(packed);
        }
    });

    it('keeps a fully transparent pixel\'s colour', async () => {
        // The same point again, and the one a canvas cannot do at all: an alpha of zero
        // scales every other channel to nothing, so the colour is gone before it is
        // written. Here it survives.
        const png = await encodePng(1, 1, Uint8Array.of(0x12, 0x34, 0x56, 0x00));

        expect([...(await decode(png, 1, 1))[0]]).toEqual([0x12, 0x34, 0x56, 0x00]);
    });

    it('writes rows top down', async () => {
        const png = await encodePng(1, 3, image(1, 3, (x, y) => [y, 0, 0, 255]));
        const rows = await decode(png, 1, 3);

        expect(rows.map((row) => row[0])).toEqual([0, 1, 2]);
    });

    it('flips a buffer whose first row is the bottom of the image', async () => {
        // Which is how the textures are built: window row 0 is the ground floor and sits
        // at the bottom of the texture, so that the rectangles and the originPixel values
        // describing them are measured the same way up.
        const png = await encodePng(1, 3, image(1, 3, (x, y) => [y, 0, 0, 255]), { bottomUp: true });
        const rows = await decode(png, 1, 3);

        expect(rows.map((row) => row[0])).toEqual([2, 1, 0]);
    });

    it('refuses a buffer that is not the size it says it is', async () => {
        await expect(encodePng(4, 4, new Uint8Array(4 * 4 * 3)))
            .rejects.toThrow(/Expected 64 bytes/);
    });

    it('refuses an image with no pixels in it', async () => {
        await expect(encodePng(0, 8, new Uint8Array(0))).rejects.toThrow(/cannot be 0 x 8/);
    });

    it('handles the size the textures actually are', async () => {
        // 1024 x 512 is 2 MB raw, and one flat fill with a rectangle in it -- so this is
        // as much about the encoder not falling over at that size as about the bytes.
        const white = [0xFF, 0xFF, 0xFF, 0xFF];
        const pixels = image(1024, 512, (x, y) =>
            (x >= 100 && x < 110 && y >= 40 && y < 60 ? white : [0x9D, 0x97, 0x92, 0xFF]));

        const png = await encodePng(1024, 512, pixels);
        const rows = await decode(png, 1024, 512);

        expect([...rows[50].subarray(105 * 4, 105 * 4 + 4)]).toEqual(white);
        expect([...rows[50].subarray(99 * 4, 99 * 4 + 4)]).toEqual([0x9D, 0x97, 0x92, 0xFF]);
        expect(png.length, 'a flat fill compresses to almost nothing').toBeLessThan(50_000);
    });
});
