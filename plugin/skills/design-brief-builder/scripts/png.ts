/** Decode a PNG's pixel content, so evidence is compared as an image rather than as bytes. */
import { inflateSync } from "node:zlib";
import { ExitError } from "../../../shared/cli.ts";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Samples per pixel, and the bit depths the PNG specification allows, per color type. */
const colorTypes: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};
/**
 * The most decompressed image data one screenshot may hold: a full-page
 * capture 1,440 pixels wide and over 40,000 tall fits. The bound is checked
 * from the header before anything is inflated, and inflation stops at the
 * size the header declares.
 */
export const maxImageBytes = 256 * 1024 * 1024;
/**
 * The most pixels one screenshot may hold, which bounds comparison work the
 * way {@link maxImageBytes} bounds memory: a low-depth image packs many
 * pixels into few bytes. The same full-page capture fits.
 */
export const maxImagePixels = 64 * 1024 * 1024;

type Rgba = [number, number, number, number];
export interface Image {
  width: number;
  height: number;
  /** The color of pixel `index` (row-major) as 16-bit RGBA; fully transparent pixels read as 0. */
  rgba(index: number): Rgba;
}

function invalid(reason: string): never {
  throw new ExitError(2, reason);
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
/** The value a scanline filter predicts from the left, upper and upper-left bytes. */
function predict(filter: number, a: number, b: number, c: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return a;
    case 2:
      return b;
    case 3:
      return (a + b) >> 1;
    case 4:
      return paeth(a, b, c);
    default:
      return invalid(`unknown filter ${filter}`);
  }
}
interface Layout {
  /** Bytes of samples per row, after the filter byte. */
  stride: number;
  /** Bytes per complete pixel, at least 1: the filters' left-neighbour distance. */
  bpp: number;
}
/** Reverses one row's filter in place, from the row above it (already reversed). */
function unfilterRow(data: Buffer, y: number, { stride, bpp }: Layout) {
  const row = stride + 1;
  const start = y * row + 1;
  const filter = data[start - 1] ?? -1;
  const byte = (index: number, available: boolean) =>
    available ? (data[index] ?? 0) : 0;
  for (let x = 0; x < stride; x++) {
    const index = start + x;
    const left = byte(index - bpp, x >= bpp);
    const up = byte(index - row, y > 0);
    const corner = byte(index - row - bpp, x >= bpp && y > 0);
    data[index] =
      ((data[index] ?? 0) + predict(filter, left, up, corner)) & 0xff;
  }
}
interface Chunks {
  header: Buffer;
  palette: Buffer | undefined;
  transparency: Buffer | undefined;
  idat: Buffer[];
  previous: string;
}
/** Records one chunk, refusing what the PNG specification's chunk order forbids. */
function accept(found: Chunks, type: string, body: Buffer, first: boolean) {
  if (first !== (type === "IHDR")) invalid("exactly one IHDR, first");
  const afterData = found.idat.length > 0;
  switch (type) {
    case "IHDR":
      found.header = body;
      break;
    case "PLTE":
      if (found.palette || found.transparency || afterData)
        invalid("PLTE out of order");
      found.palette = body;
      break;
    case "tRNS":
      if (found.transparency || afterData) invalid("tRNS out of order");
      found.transparency = body;
      break;
    case "IDAT":
      if (afterData && found.previous !== "IDAT")
        invalid("IDAT chunks must be consecutive");
      found.idat.push(body);
      break;
    case "IEND":
      if (body.length) invalid("IEND must be empty");
      break;
    default:
      if (!/^[a-z][A-Za-z]{3}$/.test(type))
        invalid(`unsupported critical chunk ${type}`);
  }
  found.previous = type;
}
/** One chunk at `offset`, checked against its CRC. */
function chunkAt(data: Buffer, offset: number) {
  if (offset + 12 > data.length) invalid("truncated chunk");
  const length = data.readUInt32BE(offset);
  const type = data.toString("latin1", offset + 4, offset + 8);
  const end = offset + 12 + length;
  if (end > data.length) invalid(`truncated ${type} chunk`);
  const named = data.subarray(offset + 4, offset + 8 + length);
  if (Bun.hash.crc32(named) !== data.readUInt32BE(end - 4))
    invalid(`corrupt ${type} chunk`);
  return { type, body: named.subarray(4), end };
}
/**
 * The chunk sequence the PNG specification requires: IHDR first, at most one
 * PLTE and tRNS before the image data, one consecutive run of IDAT, IEND last
 * and empty; every chunk checked against its CRC; no unknown critical chunk.
 */
function chunks(data: Buffer): Chunks {
  if (!data.subarray(0, 8).equals(signature)) invalid("not a PNG");
  const found: Chunks = {
    header: Buffer.alloc(0),
    palette: undefined,
    transparency: undefined,
    idat: [],
    previous: "",
  };
  let offset = 8;
  while (found.previous !== "IEND") {
    const { type, body, end } = chunkAt(data, offset);
    accept(found, type, body, offset === 8);
    offset = end;
  }
  if (offset !== data.length) invalid("data after the image end");
  if (!found.idat.length) invalid("missing image data");
  return found;
}
interface Header {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  channels: number;
}
function header(body: Buffer): Header {
  if (body.length !== 13) invalid("missing header");
  const width = body.readUInt32BE(0),
    height = body.readUInt32BE(4);
  const depth = body[8] ?? 0,
    colorType = body[9] ?? -1;
  const type = colorTypes[colorType];
  const inRange = (n: number) => n > 0 && n <= 0x7fffffff;
  if (!type?.depths.includes(depth) || !inRange(width) || !inRange(height))
    invalid("invalid header");
  if (body[10] || body[11]) invalid("unknown compression or filter method");
  if (body[12] === 1) invalid("interlaced PNG is not supported");
  if (body[12]) invalid("unknown interlace method");
  if (width * height > maxImagePixels)
    invalid(`image exceeds ${maxImagePixels} pixels`);
  return { width, height, depth, colorType, channels: type.channels };
}
/** The palette's entry count, after checking it may and must be present. */
function paletteEntries(palette: Buffer | undefined, h: Header): number {
  if (palette && (h.colorType === 0 || h.colorType === 4))
    invalid("palette not allowed for this color type");
  if (h.colorType === 3 && !palette) invalid("indexed PNG without a palette");
  if (!palette) return 0;
  const entries = palette.length / 3;
  const limit = h.colorType === 3 ? 2 ** h.depth : 256;
  if (!(Number.isInteger(entries) && entries >= 1 && entries <= limit))
    invalid("invalid palette");
  return entries;
}
function checkTransparency(
  transparency: Buffer | undefined,
  h: Header,
  entries: number,
) {
  if (!transparency) return;
  if (h.colorType === 4 || h.colorType === 6)
    invalid("tRNS not allowed for this color type");
  const valid =
    h.colorType === 3
      ? transparency.length <= entries
      : transparency.length === h.channels * 2;
  if (!valid) invalid("invalid tRNS");
}
/** The unfiltered image data, inflated no further than the header's declared size. */
function pixelData(
  compressed: Buffer,
  h: Header,
): { raw: Buffer; stride: number } {
  const bits = h.channels * h.depth;
  const stride = Math.ceil((h.width * bits) / 8);
  const size = h.height * (stride + 1);
  if (size > maxImageBytes)
    invalid(`image exceeds ${maxImageBytes} decoded bytes`);
  let raw: Buffer;
  try {
    raw = inflateSync(compressed, { maxOutputLength: size });
  } catch {
    return invalid("image data exceeds its declared size or is corrupt");
  }
  if (raw.length !== size) invalid("image data does not match its size");
  const layout = { stride, bpp: Math.max(1, bits >> 3) };
  for (let y = 0; y < h.height; y++) unfilterRow(raw, y, layout);
  return { raw, stride };
}
/** Reads sample `n` of row `y`, unscaled, at the image's bit depth. */
function sampler(raw: Buffer, stride: number, depth: number) {
  const mask = 2 ** depth - 1;
  return (y: number, n: number): number => {
    const start = y * (stride + 1) + 1;
    if (depth === 16) return raw.readUInt16BE(start + n * 2);
    if (depth === 8) return raw[start + n] ?? 0;
    const bit = n * depth;
    return ((raw[start + (bit >> 3)] ?? 0) >> (8 - depth - (bit & 7))) & mask;
  };
}
interface Colors {
  palette: Buffer | undefined;
  transparency: Buffer | undefined;
  entries: number;
}
/** Maps a pixel's samples to 16-bit RGBA by its color type. */
function colorOf(
  h: Header,
  { palette, transparency, entries }: Colors,
): (samples: number[]) => Rgba {
  // 65535 is divisible by every 2^d − 1 used, so scaling is exact.
  const scale = 65535 / (2 ** h.depth - 1);
  const opaque = (samples: number[]) =>
    transparency &&
    samples.every((v, i) => v === transparency.readUInt16BE(i * 2))
      ? 0
      : 65535;
  switch (h.colorType) {
    case 0:
      return (s) => {
        const g = (s[0] ?? 0) * scale;
        return [g, g, g, opaque(s)];
      };
    case 2:
      return (s) => {
        const [r = 0, g = 0, b = 0] = s.map((v) => v * scale);
        return [r, g, b, opaque(s)];
      };
    case 3:
      return ([entry = 0]) => {
        if (!palette || entry >= entries) invalid("palette index out of range");
        const at = (i: number) => (palette[entry * 3 + i] ?? 0) * 257;
        return [at(0), at(1), at(2), (transparency?.[entry] ?? 255) * 257];
      };
    case 4:
      return (s) => {
        const [g = 0, a = 0] = s.map((v) => v * scale);
        return [g, g, g, a];
      };
    default:
      return (s) => {
        const [r = 0, g = 0, b = 0, a = 0] = s.map((v) => v * scale);
        return [r, g, b, a];
      };
  }
}

/**
 * Throws when the data is not a valid, non-interlaced PNG within
 * {@link maxImageBytes} and {@link maxImagePixels}.
 */
export function decodePng(data: Buffer): Image {
  const found = chunks(data);
  const h = header(found.header);
  const entries = paletteEntries(found.palette, h);
  checkTransparency(found.transparency, h, entries);
  const { raw, stride } = pixelData(Buffer.concat(found.idat), h);
  const sample = sampler(raw, stride, h.depth);
  // Every index is checked here, so a decoded image is valid whether or not it is ever compared.
  if (h.colorType === 3)
    for (let y = 0; y < h.height; y++)
      for (let x = 0; x < h.width; x++)
        if (sample(y, x) >= entries) invalid("palette index out of range");
  const color = colorOf(h, { ...found, entries });
  return {
    width: h.width,
    height: h.height,
    rgba(index) {
      const y = Math.floor(index / h.width),
        x = index % h.width;
      const samples = Array.from({ length: h.channels }, (_, n) =>
        sample(y, x * h.channels + n),
      );
      const rgba = color(samples);
      return rgba[3] === 0 ? [0, 0, 0, 0] : rgba;
    },
  };
}

/** Whether two decoded images show the same pixels, whatever their encoding. */
export function sameImage(a: Image, b: Image): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.width * a.height; i++) {
    const p = a.rgba(i),
      q = b.rgba(i);
    if (p[0] !== q[0] || p[1] !== q[1] || p[2] !== q[2] || p[3] !== q[3])
      return false;
  }
  return true;
}
