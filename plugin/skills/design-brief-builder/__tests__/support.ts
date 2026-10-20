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

/** A 1×1 RGB PNG; `filter` and `level` vary the encoding of the same pixel. */
export function onePixel(
  [r, g, b]: [number, number, number],
  { filter = 0, level = 9 }: { filter?: number; level?: number } = {},
) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  // Sub and Up both predict from absent neighbours (0) for a single pixel.
  const row = Buffer.from([filter, r, g, b]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(row, { level })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
