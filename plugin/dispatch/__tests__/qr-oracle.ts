/**
 * An independent reading of the QR codes the dashboard draws: jsQR, a decoder
 * that shares no code with the encoder, reads a bitmap of the modules, and a
 * drawing in terminal text is read back into modules first.
 */
import jsQR from "jsqr";

/**
 * The text a grid of modules (`true` dark) decodes to, drawn dark on a light
 * background, each module `scale` pixels a side, with `margin` light modules
 * around it: what a camera sees of a printed code. `undefined` when it does not
 * decode.
 */
export function decodeModules(
  grid: boolean[][],
  margin: number,
  scale = 4,
): { data: string; version: number } | undefined {
  const width = ((grid[0]?.length ?? 0) + 2 * margin) * scale;
  const height = (grid.length + 2 * margin) * scale;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [y, row] of grid.entries())
    for (const [x, dark] of row.entries()) {
      if (!dark) continue;
      for (let dy = 0; dy < scale; dy++) {
        const start =
          ((y + margin) * scale + dy) * width + (x + margin) * scale;
        for (let at = start; at < start + scale; at++)
          pixels.fill(0, at * 4, at * 4 + 3);
      }
    }
  const read = jsQR(pixels, width, height, { inversionAttempts: "dontInvert" });
  return read === null ? undefined : { data: read.data, version: read.version };
}

/** Each glyph's upper and lower module, `true` dark: the drawing's ink is light. */
const HALVES: Record<string, [boolean, boolean]> = {
  "█": [false, false],
  "▀": [false, true],
  "▄": [true, false],
  " ": [true, true],
};

/** The modules lines of terminal text draw, two rows a line; `null` for a character no code draws. */
export function parseDrawn(lines: string[]): boolean[][] | null {
  const rows: boolean[][] = [];
  for (const line of lines) {
    const cells = [...line].map((glyph) => HALVES[glyph]);
    if (cells.some((cell) => cell === undefined)) return null;
    const pairs = cells as [boolean, boolean][];
    rows.push(
      pairs.map(([top]) => top),
      pairs.map(([, bottom]) => bottom),
    );
  }
  return rows;
}
