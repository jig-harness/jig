import { describe, expect, it } from "bun:test";
import { encodeQr, QUIET_ZONE, type QrMatrix, renderQr } from "../lib/qr.ts";
import { decodeModules, parseDrawn } from "./qr-oracle.ts";

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

describe("the terminal drawing", () => {
  const matrix = encoded("https://host.tailnet.ts.net:8443/");
  const lines = renderQr(matrix);

  it("draws two module rows per line inside a light quiet zone", () => {
    const span = matrix.size + 2 * QUIET_ZONE;
    expect(lines).toHaveLength(Math.ceil(span / 2));
    for (const line of lines) expect([...line]).toHaveLength(span);
    expect(lines[0]).toBe("█".repeat(span));
    expect(lines[1]).toBe("█".repeat(span));
    // The drawn modules are the code's, with light all round: the quiet zone,
    // and below it the half line an odd number of rows leaves.
    const light = (length: number) => new Array<boolean>(length).fill(false);
    const margin = light(QUIET_ZONE);
    const expected = [
      ...Array.from({ length: QUIET_ZONE }, () => light(span)),
      ...matrix.modules.map((row) => [...margin, ...row, ...margin]),
      ...Array.from({ length: QUIET_ZONE + (span % 2) }, () => light(span)),
    ];
    expect(parseRendered(lines)).toEqual(expected);
  });

  it("draws a code that decodes to the same address", () => {
    expect(decodeModules(parseRendered(lines), 0)?.data).toBe(
      "https://host.tailnet.ts.net:8443/",
    );
  });
});
