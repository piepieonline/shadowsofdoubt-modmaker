/**
 * PNG files, written a chunk at a time.
 *
 * Five textures come out of a mesh generation and every one of them has to survive the
 * trip byte for byte. That rules out the obvious route: a canvas holds colours as
 * *premultiplied* alpha, so writing a pixel and reading it back is lossy for anything
 * that is not fully opaque, and `toBlob` re-encodes through the same buffer. The mask
 * map is four unrelated channels packed into one image -- metallic in R, ambient
 * occlusion in G, detail in B, smoothness in A -- so its alpha is data rather than
 * transparency, and running it through premultiplication would scale the other three
 * channels by it. `0x00, 0xBF, 0x80, 0xD9` would come back as something else entirely.
 *
 * So the bytes are assembled here instead, and nothing but `CompressionStream` touches
 * them. That is 60 lines of PNG rather than a dependency, and PNG is a small format when
 * all that is needed is one colour type, no interlacing and one filter:
 *
 *   signature   8 bytes, fixed
 *   IHDR        width, height, 8 bits per channel, colour type 6 (RGBA)
 *   IDAT        every scanline prefixed with a filter byte, zlib-compressed
 *   IEND        empty
 *
 * `CompressionStream('deflate')` is the zlib wrapper the spec asks for -- header and
 * Adler-32 checksum included -- rather than the raw deflate stream `'deflate-raw'`
 * gives. It is available in the Chromium this app already requires and in the Node the
 * unit suite runs under.
 *
 * Nothing here knows what the images are for. See meshExport.js for that.
 */

/** Colour type 6: red, green, blue and alpha, 8 bits each. */
const RGBA_CHANNELS = 4;
const BIT_DEPTH = 8;
const COLOUR_TYPE_RGBA = 6;

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);

/**
 * Filter type 0 -- store the row as it is.
 *
 * The choice a real encoder agonises over, and the right one here: these images are flat
 * fills with rectangles in them, so a scanline is long runs of one repeated colour and
 * deflate takes a 4 KB row down to a handful of bytes on its own. A Sub or Paeth filter
 * would turn those runs into runs of zeroes, which compress to about the same size for
 * meaningfully more work.
 */
const FILTER_NONE = 0;

/**
 * A PNG of an RGBA buffer.
 *
 * `rgba` is `width * height * 4` bytes, one row after another, and is not modified.
 *
 * `bottomUp` says the buffer's first row is the *bottom* of the image, which is how a
 * Unity `Texture2D` holds one and therefore how the textures in meshExport.js are built
 * -- window row 0 is the lowest floor and sits at the bottom. PNG stores rows the other
 * way up, so the rows are read in reverse rather than the buffer being flipped by its
 * author, which would put a coordinate flip between the rectangles being drawn and the
 * `originPixel` values written into the building preset describing them.
 *
 * @returns {Promise<Uint8Array>} the whole file
 */
export async function encodePng(width, height, rgba, { bottomUp = false } = {}) {
    const stride = width * RGBA_CHANNELS;

    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`A PNG cannot be ${width} x ${height}`);
    }
    if (rgba.length !== stride * height) {
        throw new Error(
            `Expected ${stride * height} bytes for a ${width} x ${height} image, got ${rgba.length}`);
    }

    const compressed = await deflate(filtered(width, height, rgba, bottomUp));

    return concat([
        SIGNATURE,
        chunk('IHDR', header(width, height)),
        chunk('IDAT', compressed),
        chunk('IEND', new Uint8Array(0)),
    ]);
}

/** The thirteen bytes of an IHDR: the size, then five one-byte answers. */
function header(width, height) {
    const data = new Uint8Array(13);
    const view = new DataView(data.buffer);

    view.setUint32(0, width);
    view.setUint32(4, height);
    data[8] = BIT_DEPTH;
    data[9] = COLOUR_TYPE_RGBA;
    data[10] = 0; // compression: deflate, the only one there is
    data[11] = 0; // filtering: the five adaptive filters, the only set there is
    data[12] = 0; // interlacing: none

    return data;
}

/** Every scanline with its filter byte in front of it, which is what IDAT compresses. */
function filtered(width, height, rgba, bottomUp) {
    const stride = width * RGBA_CHANNELS;
    const out = new Uint8Array((stride + 1) * height);

    for (let row = 0; row < height; row++) {
        const source = bottomUp ? height - 1 - row : row;
        const at = row * (stride + 1);

        out[at] = FILTER_NONE;
        out.set(rgba.subarray(source * stride, source * stride + stride), at + 1);
    }

    return out;
}

/**
 * A chunk: its length, its four-letter name, its data, and a CRC over the two of those.
 *
 * The length does not cover the name or the checksum, and the checksum does cover the
 * name. Both are easy to get subtly wrong and produce a file every decoder rejects with
 * nothing useful to say, so they are written once here rather than at each call.
 */
function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);

    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));

    return out;
}

/** zlib, which is what a PNG's image data is wrapped in. */
async function deflate(bytes) {
    const stream = new Blob([bytes]).stream()
        .pipeThrough(new CompressionStream('deflate'));

    return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);

    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let bit = 0; bit < 8; bit++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }

    return table;
})();

/** The CRC-32 the format specifies, which is the one zip and gzip use. */
function crc32(bytes) {
    let crc = 0xFFFFFFFF;

    for (let i = 0; i < bytes.length; i++) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }

    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function concat(parts) {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));

    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }

    return out;
}
