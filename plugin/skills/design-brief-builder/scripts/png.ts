/** Decode a PNG's pixel content, so evidence is compared as an image rather than as bytes. */
import { inflateSync } from "node:zlib";
import { ExitError } from "../../../shared/cli.ts";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export interface Image {
  width: number;
  height: number;
  /** Color type, bit depth and palette: two images differ when any differs. */
  format: string;
  /** Unfiltered scanlines, independent of compression and filter choices. */
  pixels: Buffer;
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
function unfilter(data: Buffer, height: number, stride: number, bpp: number) {
  const out = Buffer.alloc(height * stride);
  const at = (index: number) => (index < 0 ? 0 : (out[index] ?? 0));
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)] ?? -1;
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= bpp ? at(index - bpp) : 0;
      const up = at(index - stride);
      const corner = x >= bpp ? at(index - stride - bpp) : 0;
      const value = data[y * (stride + 1) + 1 + x] ?? 0;
      out[index] = (value + predict(filter, left, up, corner)) & 0xff;
    }
  }
  return out;
}
interface Chunks {
  header: Buffer;
  palette: Buffer;
  compressed: Buffer;
}
/** Every chunk up to IEND, each checked against its CRC, with nothing after it. */
function chunks(data: Buffer): Chunks {
  if (!data.subarray(0, 8).equals(signature)) invalid("not a PNG");
  const found: Chunks = {
    header: Buffer.alloc(0),
    palette: Buffer.alloc(0),
    compressed: Buffer.alloc(0),
  };
  const idat: Buffer[] = [];
  let offset = 8;
  let type = "";
  while (type !== "IEND") {
    if (offset + 12 > data.length) invalid("truncated chunk");
    const length = data.readUInt32BE(offset);
    type = data.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > data.length) invalid(`truncated ${type} chunk`);
    const named = data.subarray(offset + 4, offset + 8 + length);
    if (Bun.hash.crc32(named) !== data.readUInt32BE(end - 4))
      invalid(`corrupt ${type} chunk`);
    const body = named.subarray(4);
    if (type === "IHDR") found.header = body;
    if (type === "PLTE") found.palette = body;
    if (type === "IDAT") idat.push(body);
    offset = end;
  }
  if (offset !== data.length) invalid("data after the image end");
  found.compressed = Buffer.concat(idat);
  return found;
}

/** Throws when the data is not a complete, non-interlaced PNG. */
export function decodePng(data: Buffer): Image {
  const { header, palette, compressed } = chunks(data);
  if (header.length !== 13) invalid("missing header");
  const width = header.readUInt32BE(0),
    height = header.readUInt32BE(4);
  const depth = header[8] ?? 0,
    colorType = header[9] ?? -1;
  const count = channels[colorType] ?? 0;
  if (!(count && depth && width && height)) invalid("invalid header");
  if (header[12]) invalid("interlaced PNG is not supported");
  const bits = count * depth;
  const stride = Math.ceil((width * bits) / 8);
  const raw = inflateSync(compressed);
  if (raw.length !== height * (stride + 1))
    invalid("image data does not match its size");
  return {
    width,
    height,
    format: `${colorType}/${depth}/${palette.toString("hex")}`,
    pixels: unfilter(raw, height, stride, Math.max(1, bits >> 3)),
  };
}

export function sameImage(a: Image, b: Image): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.format === b.format &&
    a.pixels.equals(b.pixels)
  );
}
