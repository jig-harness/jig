/** The terminal summary: headline numbers, then tables by area, kind, language and module. */
import { type Bucket, groupBy, total, unclassified } from "./aggregate.ts";
import type { FileStats, Kind } from "./model.ts";
import type { Unreadable } from "./test-runners/index.ts";

const COLOURS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

type Palette = typeof COLOURS;
const PLAIN: Palette = Object.fromEntries(
  Object.keys(COLOURS).map((k) => [k, ""]),
) as Palette;

/**
 * Whether to colour the summary: only on a terminal, and never when
 * `NO_COLOR` is set to anything (https://no-color.org).
 */
export function useColour(
  isTerminal: boolean,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isTerminal && !env.NO_COLOR;
}

// C0 and C1 control characters and DEL: a carriage return or an escape
// sequence in a file name or configured value could rewrite the terminal.
const char = String.fromCharCode;
const CONTROL = new RegExp(
  `[${char(0)}-${char(0x1f)}${char(0x7f)}-${char(0x9f)}]`,
  "g",
);

/**
 * `text` with every control character written as a visible escape (`\r`,
 * `\u001b`), for terminal output; the JSON report keeps the original.
 */
export function visible(text: string): string {
  return text.replace(CONTROL, (ch) => {
    const escaped = JSON.stringify(ch).slice(1, -1);
    return escaped === ch
      ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
      : escaped;
  });
}

export function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function bar(c: Palette, fraction: number, width = 20): string {
  const filled = Math.round(fraction * width);
  return `${c.cyan}${"█".repeat(filled)}${c.dim}${"░".repeat(width - filled)}${c.reset}`;
}

function heading(c: Palette, title: string): string {
  return `\n${c.bold}${c.cyan}${title}${c.reset}\n${c.dim}${"─".repeat(title.length)}${c.reset}\n`;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function visibleLength(str: string): number {
  return str.replace(ANSI, "").length;
}

function padEnd(str: string, width: number): string {
  return str + " ".repeat(Math.max(0, width - visibleLength(str)));
}

function header(c: Palette, cols: Array<[string, number]>): string {
  return `${cols.map(([t, w]) => padEnd(`${c.bold}${t}${c.reset}`, w)).join("")}\n`;
}

/** The widest of `labels` plus a gap, at least `min`, without spreading an unbounded list. */
export function columnWidth(labels: Iterable<string>, min: number): number {
  let width = min;
  for (const label of labels) width = Math.max(width, label.length + 2);
  return width;
}

const isCodeOrTest = (f: FileStats) => f.kind === "code" || f.kind === "test";
const codeOf = (map: Map<string, Bucket>, key: string) =>
  map.get(key)?.code ?? 0;

function areaTable(
  c: Palette,
  files: readonly FileStats[],
  areas: readonly string[],
) {
  const byArea = groupBy(files, (f) => f.area);
  const code = groupBy(
    files.filter((f) => f.kind === "code"),
    (f) => f.area,
  );
  const test = groupBy(
    files.filter((f) => f.kind === "test"),
    (f) => f.area,
  );
  const all = files.filter(isCodeOrTest).reduce((a, f) => a + f.codeLines, 0);
  const width = columnWidth(areas.map(visible), 18);
  let out = header(c, [
    ["Area", width],
    ["Files", 9],
    ["Size", 11],
    ["Code LOC", 12],
    ["Test LOC", 12],
    ["All lines", 12],
    ["Share", 8],
  ]);
  out += `${c.dim}${"".padEnd(width + 64)}(share = code+test LOC of the repository's code+test LOC)${c.reset}\n`;
  for (const area of areas) {
    const b = byArea.get(area);
    if (!b) continue;
    const ct = codeOf(code, area) + codeOf(test, area);
    out +=
      padEnd(visible(area), width) +
      padEnd(fmt(b.files), 9) +
      padEnd(fmtBytes(b.bytes), 11) +
      padEnd(`${c.green}${fmt(codeOf(code, area))}${c.reset}`, 12) +
      padEnd(`${c.cyan}${fmt(codeOf(test, area))}${c.reset}`, 12) +
      padEnd(fmt(b.raw), 12) +
      padEnd(pct(ct, all), 8) +
      `${bar(c, all > 0 ? ct / all : 0)}\n`;
  }
  return out;
}

function kindTable(
  c: Palette,
  files: readonly FileStats[],
  kinds: readonly Kind[],
) {
  const byKind = groupBy(files, (f) => f.kind);
  let out = header(c, [
    ["Kind", 12],
    ["Files", 9],
    ["Size", 11],
    ["Code LOC", 12],
    ["Comment", 11],
    ["All lines", 12],
  ]);
  for (const kind of kinds) {
    const b = byKind.get(kind);
    if (!b) continue;
    out +=
      padEnd(kind, 12) +
      padEnd(fmt(b.files), 9) +
      padEnd(fmtBytes(b.bytes), 11) +
      padEnd(fmt(b.code), 12) +
      padEnd(fmt(b.comment), 11) +
      `${fmt(b.raw)}\n`;
  }
  return out;
}

function languageTable(c: Palette, files: readonly FileStats[], top = 15) {
  const codeAndTest = files.filter(isCodeOrTest);
  const all = groupBy(codeAndTest, (f) => f.language);
  const tests = groupBy(
    codeAndTest.filter((f) => f.kind === "test"),
    (f) => f.language,
  );
  const whole = codeAndTest.reduce((a, f) => a + f.codeLines, 0);
  const sorted = [...all.entries()].sort((a, b) => b[1].code - a[1].code);
  let out = header(c, [
    ["Language", 16],
    ["Files", 9],
    ["Code LOC", 12],
    ["Test LOC", 12],
    ["Comment", 11],
    ["Share", 8],
  ]);
  for (const [lang, b] of sorted.slice(0, top)) {
    const test = codeOf(tests, lang);
    out +=
      padEnd(visible(lang), 16) +
      padEnd(fmt(b.files), 9) +
      padEnd(`${c.green}${fmt(b.code - test)}${c.reset}`, 12) +
      padEnd(`${c.cyan}${fmt(test)}${c.reset}`, 12) +
      padEnd(fmt(b.comment), 11) +
      `${pct(b.code, whole)}\n`;
  }
  if (sorted.length > top) {
    const rest = sorted.slice(top).reduce((acc, [, b]) => acc + b.code, 0);
    out += `${c.dim}  …${sorted.length - top} more languages: ${fmt(rest)} LOC${c.reset}\n`;
  }
  return out;
}

function moduleTable(c: Palette, files: readonly FileStats[], top: number) {
  const buckets = groupBy(files.filter(isCodeOrTest), (f) => f.module);
  const code = groupBy(
    files.filter((f) => f.kind === "code"),
    (f) => f.module,
  );
  const sorted = [...buckets.entries()].sort((a, b) => b[1].code - a[1].code);
  const width = columnWidth(
    sorted.slice(0, top).map(([m]) => visible(m)),
    40,
  );
  let out = header(c, [
    ["Module", width],
    ["Files", 9],
    ["Code LOC", 12],
    ["Test LOC", 12],
    ["Total", 10],
  ]);
  for (const [mod, b] of sorted.slice(0, top)) {
    const own = codeOf(code, mod);
    out +=
      padEnd(visible(mod), width) +
      padEnd(fmt(b.files), 9) +
      padEnd(`${c.green}${fmt(own)}${c.reset}`, 12) +
      padEnd(`${c.cyan}${fmt(b.code - own)}${c.reset}`, 12) +
      `${fmt(b.code)}\n`;
  }
  if (sorted.length > top)
    out += `${c.dim}  …${sorted.length - top} more modules${c.reset}\n`;
  return out;
}

export interface TerminalInput {
  repository: string;
  date: string;
  areas: readonly string[];
  defaultArea: string;
  kinds: readonly Kind[];
  files: readonly FileStats[];
  vendoredExcluded: Bucket;
  includeVendored: boolean;
  missing: number;
  /** Test-runner configuration files that could not be read. */
  unreadable: readonly Unreadable[];
  topModules: number;
  htmlCommand: string;
  /** Whether to write ANSI colour codes. */
  colour: boolean;
}

/**
 * The whole terminal report, as one string. Files are grouped by their
 * original values and only the printed labels are escaped: escaping is not
 * one-to-one (a newline and the two characters `\n` print alike), so
 * grouping escaped values would merge buckets the JSON report keeps apart.
 */
export function terminalReport(input: TerminalInput): string {
  const c = input.colour ? COLOURS : PLAIN;
  const { files, areas } = input;
  const defaultArea = visible(input.defaultArea);
  const repository = visible(input.repository);
  const sum = total(files);
  const inDefault = (kind: Kind) =>
    files
      .filter((f) => f.area === input.defaultArea && f.kind === kind)
      .reduce((a, f) => a + f.codeLines, 0);
  const prodCode = inDefault("code");
  const prodTest = inDefault("test");
  const u = unclassified(files);
  const lines = [
    `\n${c.bold}${c.cyan}${repository}: codebase statistics${c.reset} ${c.dim}(${input.date})${c.reset}`,
    `${c.dim}Tracked files counted: ${fmt(sum.files)}  •  Size: ${fmtBytes(sum.bytes)}  •  Total lines: ${fmt(sum.raw)}${c.reset}`,
    input.includeVendored
      ? `${c.dim}Vendored files are included (--include-vendored).${c.reset}`
      : `${c.dim}Left out: ${fmt(input.vendoredExcluded.files)} vendored files (${fmtBytes(input.vendoredExcluded.bytes)}); --include-vendored counts them.${c.reset}`,
    ...(input.missing
      ? [
          `${c.yellow}${fmt(input.missing)} tracked files are missing from the working tree and not counted.${c.reset}`,
        ]
      : []),
    "",
    `  ${c.bold}${defaultArea} code:${c.reset} ${fmt(prodCode)} LOC  ${c.dim}•${c.reset}  ${c.bold}${defaultArea} tests:${c.reset} ${fmt(prodTest)} LOC  ${c.dim}(test-to-code ratio ${(prodCode > 0 ? prodTest / prodCode : 0).toFixed(2)})${c.reset}`,
    `  ${c.bold}Unclassified:${c.reset} ${pct(u.files, files.length)} of files (${fmt(u.files)}), ${pct(u.codeLines, sum.code)} of LOC  ${c.dim}(kind other: ${fmt(u.kindOther)}; no area rule matched, so ${defaultArea}: ${fmt(u.defaultArea)})${c.reset}`,
    ...input.unreadable.map(
      (u) =>
        `  ${c.yellow}Test runner ${visible(u.reader)}: unreadable: ${visible(u.path)} (${visible(u.why)})${c.reset}`,
    ),
    heading(c, "By area (what the file is for)"),
    areaTable(c, files, areas),
    heading(c, "By kind (what the file is)"),
    kindTable(c, files, input.kinds),
    heading(c, "Top languages (code + test LOC)"),
    languageTable(c, files),
    heading(c, "Top modules (code + test LOC)"),
    moduleTable(c, files, input.topModules),
    `${c.dim}Interactive drill-down: ${input.htmlCommand}${c.reset}\n`,
  ];
  return lines.join("\n");
}
