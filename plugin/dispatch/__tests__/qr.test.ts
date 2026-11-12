import { describe, expect, it } from "bun:test";
import { encodeQr, QUIET_ZONE, type QrMatrix, renderQr } from "../lib/qr.ts";
import { decodeModules, ESC, parseDrawn } from "./qr-oracle.ts";

function parseRendered(lines: string[]): boolean[][] {
  const grid = parseDrawn(lines);
  expect(grid).not.toBeNull();
  return grid ?? [];
}

function encoded(text: string): QrMatrix {
  const code = encodeQr(text);
  if (!code.ok) throw new Error(code.failure.reason);
  return code.value;
}

const ADDRESSES = [
  "https://h.example/",
  "https://host.tailnet.ts.net:8443/",
  "https://dashboard.internal.example.net/a/rather/long/path/that/forces/a/larger/version/of/the/code/than/the/short/ones/do/",
  "https://例え.テスト/パス/ünïcödé",
  `https://h.example/${"a".repeat(600)}`,
];

describe("the QR encoder", () => {
  it("encodes each address so an independent decoder reads back exactly that address", () => {
    const versions = new Set<number>();
    for (const address of ADDRESSES) {
      const matrix = encoded(address);
      const read = decodeModules(matrix.modules, QUIET_ZONE);
      expect(read?.data).toBe(address);
      versions.add(read?.version ?? 0);
      expect(matrix.size).toBe(17 + 4 * (read?.version ?? 0));
    }
    expect(versions.size).toBe(ADDRESSES.length);
    expect(Math.max(...versions)).toBeGreaterThan(9);
  });

  it("takes the smallest version at level M, and level L only for text M cannot hold", () => {
    expect(encoded("https://host.tailnet.ts.net:8443/").size).toBe(29);
    // 2,418 bytes: more than level M holds even at version 40 (2,331), and
    // what level L holds at version 36.
    const beyondM = `https://h.example/${"b".repeat(2400)}`;
    const matrix = encoded(beyondM);
    expect(matrix.size).toBe(17 + 4 * 36);
    expect(decodeModules(matrix.modules, QUIET_ZONE, 2)?.data).toBe(beyondM);
  });

  it("refuses text no version holds", () => {
    const code = encodeQr("c".repeat(3000));
    expect(code.ok ? "encoded" : code.failure.code).toBe("too-long");
  });
});

describe("each version's capacity", () => {
  // Byte mode at level M: the data codewords each version holds, less the
  // mode and count fields (8 count bits through version 9, 16 after).
  const DATA_CODEWORDS_M = [
    16, 28, 44, 64, 86, 108, 124, 154, 182, 216, 254, 290, 334, 365, 415, 453,
    507, 563, 627, 669, 714, 782, 860, 914, 1000, 1062, 1128, 1193, 1267, 1373,
    1455, 1541, 1631, 1725, 1812, 1914, 1992, 2102, 2216, 2334,
  ];
  const capacity = (version: number) =>
    (DATA_CODEWORDS_M[version - 1] ?? 0) - (version <= 9 ? 2 : 3);

  it("decodes the shortest and the longest text of every version 1 to 40 at that version", () => {
    for (let version = 1; version <= 40; version++)
      for (const length of [capacity(version - 1) + 1, capacity(version)]) {
        const text = "x".repeat(Math.max(length, 1));
        const matrix = encoded(text);
        const read = decodeModules(matrix.modules, QUIET_ZONE, 2);
        expect({
          version,
          length,
          read: read?.version,
          same: read?.data === text,
        }).toEqual({
          version,
          length,
          read: version,
          same: true,
        });
      }
  }, 60_000);
});

describe("the terminal drawing", () => {
  const address = "https://host.tailnet.ts.net:8443/";
  const matrix = encoded(address);
  const span = matrix.size + 2 * QUIET_ZONE;
  // The drawn modules are the code's, with light all round: the quiet zone,
  // and below it the half line an odd number of rows leaves.
  const light = (length: number) => new Array<boolean>(length).fill(false);
  const margin = light(QUIET_ZONE);
  const expected = [
    ...Array.from({ length: QUIET_ZONE }, () => light(span)),
    ...matrix.modules.map((row) => [...margin, ...row, ...margin]),
    ...Array.from({ length: QUIET_ZONE + (span % 2) }, () => light(span)),
  ];

  for (const color of [true, false])
    describe(color ? "in set colors" : "without color", () => {
      const lines = renderQr(matrix, { color });

      it("draws two module rows per line inside a light quiet zone", () => {
        expect(lines).toHaveLength(Math.ceil(span / 2));
        expect(parseRendered(lines)).toEqual(expected);
      });

      it("draws a code that decodes to the same address, uninverted", () => {
        expect(decodeModules(parseRendered(lines), 0)?.data).toBe(address);
      });
    });

  it("sets both colors of every cell, black for dark and white for light, and resets them at each line's end", () => {
    const sequence = new RegExp(`${ESC}\\[38;5;(16|231);48;5;(16|231)m▀`, "g");
    const reset = `${ESC}[0m`;
    for (const line of renderQr(matrix, { color: true })) {
      expect(line.endsWith(reset)).toBe(true);
      const body = line.slice(0, -reset.length);
      expect(body.replace(sequence, "")).toBe("");
      expect([...body.matchAll(sequence)]).toHaveLength(span);
    }
  });

  it("draws without color in plain glyphs, the ink light, as qrencode does", () => {
    const lines = renderQr(matrix, { color: false });
    for (const line of lines) expect([...line]).toHaveLength(span);
    expect(lines[0]).toBe("█".repeat(span));
    expect(lines[1]).toBe("█".repeat(span));
  });
});
