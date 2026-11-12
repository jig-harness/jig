/**
 * A QR code (Model 2, ISO/IEC 18004) for one piece of text, and its drawing
 * in a terminal. `jig dispatch dashboard --access` draws the token-free
 * address of the dashboard's front with it, so a phone camera can carry the
 * address over. The plugin runs from a copy with no `node_modules`, so the
 * encoder lives here rather than in a package.
 *
 * The text is encoded as UTF-8 bytes in byte mode, at error-correction level
 * M (about 15% of the code may be damaged and still read) in the smallest
 * version, 1 to 40, that holds it; level L is the fallback for text M cannot
 * hold at any version. Of the eight masks, the one with the lowest penalty
 * score by the standard's four rules is kept.
 */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";

/** The code's modules, `true` for dark, `modules[row][column]`; `size` modules a side. */
export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

type Level = "L" | "M";

/** Error-correction codewords per block, and number of blocks, by version (index 0 unused). */
const ECC_PER_BLOCK: Record<Level, readonly number[]> = {
  L: [
    0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30,
    28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    30, 30, 30,
  ],
  M: [
    0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26,
    26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    28, 28, 28,
  ],
};
const BLOCKS: Record<Level, readonly number[]> = {
  L: [
    0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10,
    12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  M: [
    0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17,
    18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
};
/** The two format bits each level writes. */
const LEVEL_BITS: Record<Level, number> = { L: 1, M: 0 };

/** An entry of a list of numbers; the tables and codeword lists are always long enough. */
const at = (list: readonly number[], i: number): number => list[i] ?? 0;

const bit = (value: number, i: number): boolean => ((value >>> i) & 1) !== 0;

/** Modules left for data and error correction once the function patterns are drawn. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, level: Level): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    at(ECC_PER_BLOCK[level], version) * at(BLOCKS[level], version)
  );
}

/** Byte mode's character-count field: 8 bits through version 9, 16 after. */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** The smallest version and level holding `length` bytes, M before L. */
function fit(length: number): { version: number; level: Level } | null {
  for (const level of ["M", "L"] as const)
    for (let version = 1; version <= 40; version++)
      if (
        4 + countBits(version) + 8 * length <=
        dataCodewords(version, level) * 8
      )
        return { version, level };
  return null;
}

/** The data codewords: mode, count, bytes, terminator and padding. */
function dataStream(
  bytes: Uint8Array,
  version: number,
  level: Level,
): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, countBits(version));
  for (const byte of bytes) put(byte, 8);
  const capacity = dataCodewords(version, level) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8)
    codewords.push(
      bits.slice(i, i + 8).reduce((n, value) => (n << 1) | value, 0),
    );
  return codewords;
}

/** Multiplication in GF(256) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The Reed-Solomon generator polynomial of `degree`, its leading term dropped. */
function divisor(degree: number): number[] {
  let result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    const factor = root;
    result = result.map(
      (coefficient, j) => gfMultiply(coefficient, factor) ^ at(result, j + 1),
    );
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error-correction codewords of one block. */
function remainder(data: readonly number[], generator: number[]): number[] {
  let result = generator.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ at(result, 0);
    const shifted = [...result.slice(1), 0];
    result = shifted.map(
      (value, i) => value ^ gfMultiply(at(generator, i), factor),
    );
  }
  return result;
}

/** Splits the data into blocks, appends each block's error correction and interleaves them. */
function interleaved(data: number[], version: number, level: Level): number[] {
  const blocks = at(BLOCKS[level], version);
  const eccLength = at(ECC_PER_BLOCK[level], version);
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const generator = divisor(eccLength);
  const all: number[][] = [];
  for (let i = 0, start = 0; i < blocks; i++) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(start, start + length);
    start += length;
    const ecc = remainder(block, generator);
    // A short block holds a gap where the long blocks have one more data codeword.
    all.push([...block, ...(i < shortBlocks ? [-1] : []), ...ecc]);
  }
  const result: number[] = [];
  for (let i = 0; i <= shortLength; i++)
    for (const block of all) if (at(block, i) !== -1) result.push(at(block, i));
  return result;
}

/** A matrix under construction: the modules, and which of them the function patterns hold, row by row. */
class Canvas {
  readonly size: number;
  readonly dark: boolean[];
  readonly reserved: boolean[];
  constructor(size: number) {
    this.size = size;
    this.dark = new Array<boolean>(size * size).fill(false);
    this.reserved = new Array<boolean>(size * size).fill(false);
  }
  isDark(x: number, y: number): boolean {
    return this.dark[y * this.size + x] === true;
  }
  isReserved(x: number, y: number): boolean {
    return this.reserved[y * this.size + x] === true;
  }
  /** Draws a function-pattern module, which data and masks then leave alone. */
  set(x: number, y: number, dark: boolean): void {
    this.dark[y * this.size + x] = dark;
    this.reserved[y * this.size + x] = true;
  }
  put(x: number, y: number, dark: boolean): void {
    this.dark[y * this.size + x] = dark;
  }
  rows(): boolean[][] {
    return Array.from({ length: this.size }, (_, y) =>
      this.dark.slice(y * this.size, (y + 1) * this.size),
    );
  }
}

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step)
    result.splice(1, 0, position);
  return result;
}

/** A square of `radius` around a centre, each module dark or light by its ring. */
function drawRings(
  canvas: Canvas,
  cx: number,
  cy: number,
  radius: number,
  darkRing: (ring: number) => boolean,
): void {
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) continue;
      canvas.set(x, y, darkRing(Math.max(Math.abs(dx), Math.abs(dy))));
    }
}

function drawAlignment(canvas: Canvas, version: number): void {
  const positions = alignmentPositions(version, canvas.size);
  const last = positions.length - 1;
  positions.forEach((y, i) => {
    positions.forEach((x, j) => {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === last) ||
        (i === last && j === 0);
      if (!corner) drawRings(canvas, x, y, 2, (ring) => ring !== 1);
    });
  });
}

function drawFunctionPatterns(canvas: Canvas, version: number): void {
  const { size } = canvas;
  for (let i = 0; i < size; i++) {
    canvas.set(6, i, i % 2 === 0);
    canvas.set(i, 6, i % 2 === 0);
  }
  const finder = (ring: number) => ring !== 2 && ring !== 4;
  drawRings(canvas, 3, 3, 4, finder);
  drawRings(canvas, size - 4, 3, 4, finder);
  drawRings(canvas, 3, size - 4, 4, finder);
  drawAlignment(canvas, version);
  drawFormat(canvas, "M", 0);
  drawVersion(canvas, version);
}

/** The 15 format bits (level and mask, BCH-coded and masked) in both copies, and the dark module. */
function drawFormat(canvas: Canvas, level: Level, mask: number): void {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const { size } = canvas;
  for (let i = 0; i <= 5; i++) canvas.set(8, i, bit(bits, i));
  canvas.set(8, 7, bit(bits, 6));
  canvas.set(8, 8, bit(bits, 7));
  canvas.set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) canvas.set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) canvas.set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) canvas.set(8, size - 15 + i, bit(bits, i));
  canvas.set(8, size - 8, true);
}

/** The 18 version bits, from version 7 on, in both copies. */
function drawVersion(canvas: Canvas, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const a = canvas.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    canvas.set(a, b, bit(bits, i));
    canvas.set(b, a, bit(bits, i));
  }
}

/**
 * Every module in placement order: two-column strips from the right edge,
 * alternately upward and downward, stepping over the vertical timing column.
 */
function* zigzag(size: number): Generator<[number, number]> {
  for (let right = size - 1; right >= 1; right -= 2) {
    const column = right <= 6 ? right - 1 : right;
    const upward = ((column + 1) & 2) === 0;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      yield [column, y];
      yield [column - 1, y];
    }
  }
}

/** Places the codewords' bits in the zigzag, skipping the reserved modules. */
function drawCodewords(canvas: Canvas, codewords: number[]): void {
  const total = codewords.length * 8;
  let i = 0;
  for (const [x, y] of zigzag(canvas.size)) {
    if (i >= total) return;
    if (canvas.isReserved(x, y)) continue;
    canvas.put(x, y, bit(at(codewords, i >>> 3), 7 - (i & 7)));
    i++;
  }
}

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Flips every data module the mask selects; applying it twice undoes it. */
function applyMask(canvas: Canvas, flips: (x: number, y: number) => boolean) {
  for (let y = 0; y < canvas.size; y++)
    for (let x = 0; x < canvas.size; x++)
      if (!canvas.isReserved(x, y) && flips(x, y))
        canvas.put(x, y, !canvas.isDark(x, y));
}

/** Rule 1 (runs of five or more) and rule 3 (finder-like patterns, the margin light) over one line. */
function linePenalty(line: readonly boolean[]): number {
  let score = 0;
  let run = 1;
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && line[i] === line[i - 1]) run++;
    else {
      if (run >= 5) score += run - 2;
      run = 1;
    }
  }
  const text = `0000${line.map((dark) => (dark ? "1" : "0")).join("")}0000`;
  for (const pattern of ["10111010000", "00001011101"])
    for (
      let i = text.indexOf(pattern);
      i >= 0;
      i = text.indexOf(pattern, i + 1)
    )
      score += 40;
  return score;
}

/** Rule 2 (each 2x2 block of one color) and rule 4 (dark share away from half). */
function blockAndBalancePenalty(canvas: Canvas): number {
  const { size } = canvas;
  let score = 0;
  let dark = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const color = canvas.isDark(x, y);
      if (color) dark++;
      if (
        x < size - 1 &&
        y < size - 1 &&
        color === canvas.isDark(x + 1, y) &&
        color === canvas.isDark(x, y + 1) &&
        color === canvas.isDark(x + 1, y + 1)
      )
        score += 3;
    }
  const total = size * size;
  return score + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
}

/** The standard's penalty score; the mask with the lowest is kept. */
function penalty(canvas: Canvas): number {
  const rows = canvas.rows();
  let score = blockAndBalancePenalty(canvas);
  for (let i = 0; i < canvas.size; i++) {
    score += linePenalty(rows[i] ?? []);
    score += linePenalty(rows.map((row) => row[i] === true));
  }
  return score;
}

/** The QR code for `text`, or `too-long` when no version holds it. */
export function encodeQr(text: string): Outcome<QrMatrix, "too-long"> {
  const bytes = new TextEncoder().encode(text);
  const chosen = fit(bytes.length);
  if (chosen === null)
    return failed("too-long", `${bytes.length} bytes do not fit in a QR code`);
  const { version, level } = chosen;
  const canvas = new Canvas(version * 4 + 17);
  drawFunctionPatterns(canvas, version);
  drawCodewords(
    canvas,
    interleaved(dataStream(bytes, version, level), version, level),
  );
  let best = 0;
  let lowest = Number.POSITIVE_INFINITY;
  MASKS.forEach((flips, mask) => {
    applyMask(canvas, flips);
    drawFormat(canvas, level, mask);
    const score = penalty(canvas);
    if (score < lowest) [best, lowest] = [mask, score];
    applyMask(canvas, flips);
  });
  applyMask(canvas, MASKS[best] ?? (() => false));
  drawFormat(canvas, level, best);
  return ok({ size: canvas.size, modules: canvas.rows() });
}

/** The light margin around the code that a scanner needs, in modules. */
export const QUIET_ZONE = 4;

/** Each pair of modules a text cell draws without color, by whether the upper and the lower one is dark. */
const GLYPHS = [
  ["█", "▀"],
  ["▄", " "],
] as const;

/**
 * The 256-color palette's black (16) and white (231), as foreground and as
 * background, by whether a module is dark. They sit in the palette's fixed
 * color cube, which terminals draw as given rather than from their theme;
 * 256 colors are what xterm-compatible terminals read, the basic eight colors'
 * "white" is often a theme's grey.
 */
const FOREGROUND = ["38;5;231", "38;5;16"] as const;
const BACKGROUND = ["48;5;231", "48;5;16"] as const;
const RESET = "\x1b[0m";

/** The cell's upper module as the `▀`'s ink and its lower as the background, so every module's color is set. */
function paintedCell(upper: 0 | 1, lower: 0 | 1): string {
  return `\x1b[${FOREGROUND[upper]};${BACKGROUND[lower]}m▀`;
}

/**
 * The code as terminal text, two module rows per line, with a quiet zone of
 * `QUIET_ZONE` modules.
 *
 * With `color`, every cell sets its own colors (`paintedCell`): dark modules
 * black, light modules and the quiet zone white, whatever the terminal's
 * theme, and each line ends by resetting them. Without it (`NO_COLOR`), the
 * drawing follows `qrencode -t UTF8`: a light module is ink (`█`, or the half
 * `▀`/`▄` that is light) and a dark module a space, which shows the code dark
 * on light on a terminal with a dark background and inverted on a light one.
 * The address printed with it is the fallback either way.
 */
export function renderQr(
  matrix: QrMatrix,
  options: { color: boolean },
): string[] {
  const span = matrix.size + 2 * QUIET_ZONE;
  const dark = (x: number, y: number): 0 | 1 =>
    matrix.modules[y - QUIET_ZONE]?.[x - QUIET_ZONE] === true ? 1 : 0;
  const cell = options.color
    ? paintedCell
    : (upper: 0 | 1, lower: 0 | 1) => GLYPHS[upper][lower];
  const lines: string[] = [];
  for (let y = 0; y < span; y += 2) {
    let line = "";
    for (let x = 0; x < span; x++) line += cell(dark(x, y), dark(x, y + 1));
    lines.push(options.color ? line + RESET : line);
  }
  return lines;
}
