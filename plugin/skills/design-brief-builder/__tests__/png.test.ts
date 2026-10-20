import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import {
  decodePng,
  maxImageBytes,
  maxImagePixels,
  sameImage,
} from "../scripts/png.ts";
import { png } from "./support.ts";

const same = (a: Buffer, b: Buffer) => sameImage(decodePng(a), decodePng(b));

test("the same pixels compare equal across color types and depths", () => {
  const rgb = png({ rows: [[10, 20, 30, 40, 50, 60]], width: 2 });
  const rgba = png({
    colorType: 6,
    width: 2,
    rows: [[10, 20, 30, 255, 40, 50, 60, 255]],
  });
  const rgb16 = png({
    depth: 16,
    width: 2,
    rows: [[10, 10, 20, 20, 30, 30, 40, 40, 50, 50, 60, 60]],
  });
  const indexed = png({
    colorType: 3,
    width: 2,
    palette: [40, 50, 60, 10, 20, 30],
    rows: [[1, 0]],
  });
  for (const other of [rgba, rgb16, indexed])
    expect(same(rgb, other)).toBe(true);
  expect(same(rgb, png({ rows: [[10, 20, 30, 40, 50, 61]], width: 2 }))).toBe(
    false,
  );
});

test("transparency is part of the image", () => {
  const indexed = (transparency?: number[]) =>
    png({ colorType: 3, palette: [1, 2, 3], transparency, rows: [[0]] });
  expect(same(indexed(), indexed([255]))).toBe(true);
  expect(same(indexed(), indexed([0]))).toBe(false);
  const gray = (transparency?: number[]) =>
    png({ colorType: 0, rows: [[7]], transparency });
  expect(same(gray(), gray([0, 7]))).toBe(false);
  expect(same(gray([0, 7]), indexed([0]))).toBe(true);
});

test("sub-byte samples are read one by one", () => {
  const twoBit = png({
    colorType: 0,
    depth: 2,
    width: 4,
    rows: [[0b00011011]],
  });
  const eightBit = png({ colorType: 0, width: 4, rows: [[0, 85, 170, 255]] });
  expect(same(twoBit, eightBit)).toBe(true);
});

test("invalid PNG structure is refused", () => {
  const cases: [string, Buffer][] = [
    ["invalid header", png({ depth: 4, rows: [[0]] })],
    [
      "unknown compression or filter method",
      (() => {
        const data = png({ rows: [[1, 2, 3]] });
        data[8 + 8 + 10] = 1;
        data.writeUInt32BE(Bun.hash.crc32(data.subarray(12, 29)), 29);
        return data;
      })(),
    ],
    ["indexed PNG without a palette", png({ colorType: 3, rows: [[0]] })],
    [
      "palette not allowed",
      png({ colorType: 0, palette: [1, 2, 3], rows: [[0]] }),
    ],
    [
      "palette index out of range",
      png({ colorType: 3, palette: [1, 2, 3], rows: [[1]] }),
    ],
    [
      "tRNS not allowed",
      png({ colorType: 6, transparency: [0], rows: [[1, 2, 3, 4]] }),
    ],
    [
      "unsupported critical chunk",
      png({ rows: [[1, 2, 3]], before: [["ABCD", Buffer.alloc(0)]] }),
    ],
    [
      "PLTE out of order",
      png({
        colorType: 3,
        palette: [1, 2, 3],
        before: [["PLTE", Buffer.from([1, 2, 3])]],
        rows: [[0]],
      }),
    ],
    [
      "interlaced PNG is not supported",
      png({ interlace: 1, rows: [[1, 2, 3]] }),
    ],
  ];
  // Decoding alone refuses: an image that is never compared is still checked.
  for (const [reason, data] of cases)
    expect(() => decodePng(data)).toThrow(reason);
  expect(() =>
    decodePng(
      png({ rows: [[1, 2, 3]], before: [["tEXt", Buffer.from("a\0b")]] }),
    ),
  ).not.toThrow();
});

test("decompression is bounded by the declared size", () => {
  const bomb = png({
    rows: [[0, 0, 0]],
    data: deflateSync(Buffer.alloc(10_000_000)),
  });
  expect(() => decodePng(bomb)).toThrow("image data exceeds its declared size");
  const huge = png({
    colorType: 6,
    depth: 16,
    width: 8192,
    height: 8192,
    rows: [[0, 0, 0, 0, 0, 0, 0, 0]],
  });
  expect(() => decodePng(huge)).toThrow(`image exceeds ${maxImageBytes}`);
});

test("pixel count is bounded even when the decoded bytes are not", () => {
  // 1-bit grayscale packs eight pixels a byte: 128 MiB of data, a billion pixels.
  const dense = png({
    colorType: 0,
    depth: 1,
    width: 32_768,
    height: 32_768,
    rows: [[0]],
  });
  expect(() => decodePng(dense)).toThrow(
    `image exceeds ${maxImagePixels} pixels`,
  );
});
