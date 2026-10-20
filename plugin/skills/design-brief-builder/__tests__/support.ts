import { existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

export const chrome =
  process.env.JIG_TEST_CHROMIUM ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(
      process.env.PROGRAMFILES ?? "C:/Program Files",
      "Google/Chrome/Application/chrome.exe",
    ),
  ].find(existsSync) ??
  Bun.which("chromium") ??
  Bun.which("chromium-browser") ??
  Bun.which("google-chrome");
export const required = process.env.JIG_REQUIRE_BROWSER === "1";

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const named = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Bun.hash.crc32(named));
  return Buffer.concat([length, named, crc]);
}

export interface PngSpec {
  width?: number;
  height?: number;
  colorType?: number;
  depth?: number;
  /** Each row's packed samples, without its filter byte. */
  rows: number[][];
  filter?: number;
  level?: number;
  palette?: number[] | undefined;
  transparency?: number[] | undefined;
  interlace?: number;
  /** Chunks placed before the image data, as [type, body]. */
  before?: [string, Buffer][];
  /** Replaces the deflated image data. */
  data?: Buffer;
}

/** A PNG built chunk by chunk, so tests can vary every field the decoder reads. */
export function png({
  width = 1,
  height = 1,
  colorType = 2,
  depth = 8,
  rows,
  filter = 0,
  level = 9,
  palette,
  transparency,
  interlace = 0,
  before = [],
  data,
}: PngSpec) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  header[12] = interlace;
  const raw = Buffer.from(rows.flatMap((row) => [filter, ...row]));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...(palette ? [chunk("PLTE", Buffer.from(palette))] : []),
    ...(transparency ? [chunk("tRNS", Buffer.from(transparency))] : []),
    ...before.map(([type, body]) => chunk(type, body)),
    chunk("IDAT", data ?? deflateSync(raw, { level })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A 1×1 RGB PNG; `filter` and `level` vary the encoding of the same pixel. */
export function onePixel(
  [r, g, b]: [number, number, number],
  { filter = 0, level = 9 }: { filter?: number; level?: number } = {},
) {
  // Sub and Up both predict from absent neighbours (0) for a single pixel.
  return png({ rows: [[r, g, b]], filter, level });
}
