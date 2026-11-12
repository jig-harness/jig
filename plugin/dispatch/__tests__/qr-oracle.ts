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

/** Each glyph's upper and lower module, `true` dark, drawn without color: the ink is light. */
const HALVES: Record<string, [boolean, boolean]> = {
  "█": [false, false],
  "▀": [false, true],
  "▄": [true, false],
  " ": [true, true],
};

/** The 256-color palette's black; any other color reads as light. */
const BLACK = 16;

/** A cell drawn in set colors: the ink is the foreground, the rest the background. */
function painted(glyph: string, ink: boolean, paper: boolean) {
  const cells: Record<string, [boolean, boolean]> = {
    "█": [ink, ink],
    "▀": [ink, paper],
    "▄": [paper, ink],
    " ": [paper, paper],
  };
  return cells[glyph];
}

/** The colors a select-graphic-rendition sequence leaves set, from those before it. */
function rendition(
  parameters: string,
  colors: { ink: number | null; paper: number | null },
) {
  const numbers = parameters.split(";").map(Number);
  let next = { ...colors };
  for (let i = 0; i < numbers.length; i++) {
    const code = numbers[i];
    if (code === 0) next = { ink: null, paper: null };
    if ((code === 38 || code === 48) && numbers[i + 1] === 5) {
      const color = numbers[i + 2] ?? null;
      next = code === 38 ? { ...next, ink: color } : { ...next, paper: color };
      i += 2;
    }
  }
  return next;
}

/** The escape character, which starts a select-graphic-rendition sequence. */
export const ESC = String.fromCharCode(27);

/** A select-graphic-rendition sequence, its parameters captured, or one drawn character. */
const TOKEN = new RegExp(`${ESC}\\[([0-9;]*)m|([^${ESC}])`, "g");

/** One line's cells, upper and lower module each, in set colors or as plain glyphs; `null` for a character no code draws. */
function cellsOf(line: string): [boolean, boolean][] | null {
  const cells: [boolean, boolean][] = [];
  let colors: { ink: number | null; paper: number | null } = {
    ink: null,
    paper: null,
  };
  for (const [, parameters, glyph] of line.matchAll(TOKEN)) {
    if (parameters !== undefined) colors = rendition(parameters, colors);
    else if (glyph !== undefined) {
      const cell =
        colors.ink === null || colors.paper === null
          ? HALVES[glyph]
          : painted(glyph, colors.ink === BLACK, colors.paper === BLACK);
      if (cell === undefined) return null;
      cells.push(cell);
    }
  }
  return cells;
}

/**
 * The modules lines of terminal text draw, two rows a line, `true` dark; `null`
 * for a character no code draws. A cell whose colors are set reads as those
 * colors; a plain glyph reads as ink that is light, as `qrencode -t UTF8` draws.
 */
export function parseDrawn(lines: string[]): boolean[][] | null {
  const rows: boolean[][] = [];
  for (const line of lines) {
    const cells = cellsOf(line);
    if (cells === null) return null;
    rows.push(
      cells.map(([top]) => top),
      cells.map(([, bottom]) => bottom),
    );
  }
  return rows;
}
