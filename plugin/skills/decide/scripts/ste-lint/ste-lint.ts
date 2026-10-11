#!/usr/bin/env bun
/**
 * Advisory linter for the structural rules of Simplified Technical English
 * (STE): text that asks a human to decide should be short, active and plain.
 *
 * A TypeScript translation of two Python files: the upstream linter
 * `scripts/ste-lint.py` from danyuchn/asd-ste100-skill (MIT, see LICENSE in
 * this directory), and a local wrapper that lints hard-wrapped Markdown by
 * sentence, not by physical line. README.md in this directory records the
 * provenance and why the wrapper exists.
 *
 * Usage:
 *   bun ste-lint.ts [--json] [--baseline N] [--disable a,b] FILE...
 *   cat draft.md | bun ste-lint.ts [--json]
 *   bun ste-lint.ts --selftest
 *   bun ste-lint.ts --raw ...        # the upstream linter alone, per line
 *
 * Exit 1 when hard ("advisory-free") findings exceed the baseline (default 0).
 * Advisory findings never fail the run. Hedges and modality (may, might,
 * could) are never flagged: confidence is content.
 *
 * Advisory use only. Run it on text you generated before you post that text,
 * then fix or note the flags. It is not a gate: no workflow or hook may call
 * it.
 *
 * Every rule, regular expression, message and output format matches the
 * Python originals. The first section below supplies the Python semantics the
 * translation depends on: Unicode `\b`, `\w`, `\s` and `\d`, Python's
 * case-insensitive letter matching, `str.split()`, `str.strip()`,
 * `str.splitlines()`, `str.expandtabs()`, and columns counted in code points,
 * not UTF-16 units.
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Python semantics
// ---------------------------------------------------------------------------

/** Characters for which Python's `str.isspace()` is true (and `\s` matches). */
const WS = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
/** Python's Unicode `\w`: letters, numbers and the underscore. */
const WORD = String.raw`\p{L}\p{N}_`;
const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
/** Non-ASCII characters Python's `re.I` matches for an ASCII letter. */
const FOLD_EXTRA: Record<string, string> = {
  i: String.raw`\u0130\u0131`,
  k: String.raw`\u212a`,
  s: String.raw`\u017f`,
};

function foldLetter(ch: string): string {
  const lower = ch.toLowerCase();
  return `${lower}${ch.toUpperCase()}${FOLD_EXTRA[lower] ?? ""}`;
}

/**
 * Compile a Python `re` pattern with Python's semantics. `\b`, `\w`, `\s`,
 * `\S` and `\d` take their Unicode meaning, `.` excludes only `\n`, `(?P<` is
 * a named group, and `ignoreCase` expands each ASCII letter to the exact set
 * Python matches (JavaScript's `i` flag also folds a few marks into letters).
 */
export function py(
  source: string,
  opts: { ignoreCase?: boolean; global?: boolean } = {},
): RegExp {
  let out = "";
  let inClass = false;
  for (let k = 0; k < source.length; k++) {
    const ch = source[k] as string;
    if (ch === "\\") {
      const next = source[++k] as string;
      if (inClass) {
        if (next === "s") out += WS;
        else if (next === "w") out += WORD;
        else if (next === "d") out += String.raw`\p{Nd}`;
        else out += `\\${next}`;
        continue;
      }
      if (next === "b") out += BOUNDARY;
      else if (next === "w") out += `[${WORD}]`;
      else if (next === "s") out += `[${WS}]`;
      else if (next === "S") out += `[^${WS}]`;
      else if (next === "d") out += String.raw`\p{Nd}`;
      else out += `\\${next}`;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      else if (opts.ignoreCase && /[a-zA-Z]/.test(ch)) {
        out += foldLetter(ch);
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      out += ch;
      if (source[k + 1] === "^") {
        out += "^";
        k++;
      }
      continue;
    }
    if (ch === "(" && source[k + 1] === "?") {
      const rest = source.slice(k);
      const named = /^\(\?P?<([A-Za-z_]\w*)>/.exec(rest);
      if (named) {
        out += `(?<${named[1]}>`;
        k += named[0].length - 1;
        continue;
      }
      const marker = /^\(\?(?::|=|!|<=|<!)/.exec(rest);
      if (!marker) throw new Error(`unsupported group in ${source}`);
      out += marker[0];
      k += marker[0].length - 1;
      continue;
    }
    if (ch === ".") {
      out += "[^\\n]";
      continue;
    }
    if (opts.ignoreCase && /[a-zA-Z]/.test(ch)) {
      out += `[${foldLetter(ch)}]`;
      continue;
    }
    out += ch;
  }
  return new RegExp(out, opts.global ? "gu" : "u");
}

const WS_RUN = py(String.raw`\s+`);
const LEADING_WS = py(String.raw`^\s+`);
const TRAILING_WS = py(String.raw`\s+$`);

/** Python `str.split()` with no separator. */
export function pySplit(s: string): string[] {
  return s.split(WS_RUN).filter((part) => part !== "");
}

export const pyLstrip = (s: string): string => s.replace(LEADING_WS, "");
export const pyRstrip = (s: string): string => s.replace(TRAILING_WS, "");
export const pyStrip = (s: string): string => pyRstrip(pyLstrip(s));

// biome-ignore lint/suspicious/noControlCharactersInRegex: Python's splitlines() breaks lines on these separators.
const LINE_BREAK = /\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]/;

/** Python `str.splitlines()`. */
export function splitlines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split(LINE_BREAK);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Length in code points, as Python's `len()` counts a string. */
export function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Python `s[start:end]`, indexes in code points. */
function cpSlice(s: string, start: number, end?: number): string {
  return Array.from(s).slice(start, end).join("");
}

/** The code-point offset of a UTF-16 index into `s`. */
function cpIndex(s: string, utf16: number): number {
  return cpLen(s.slice(0, utf16));
}

/** Python `str.expandtabs(size)`. */
function expandTabs(s: string, size: number): string {
  let out = "";
  let column = 0;
  for (const ch of s) {
    if (ch === "\t") {
      const n = size - (column % size);
      out += " ".repeat(n);
      column += n;
    } else {
      out += ch;
      column = ch === "\n" || ch === "\r" ? 0 : column + 1;
    }
  }
  return out;
}

/** Python string comparison: by code point, not by UTF-16 unit. */
function cmpStr(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d =
      ((x[i] as string).codePointAt(0) ?? 0) -
      ((y[i] as string).codePointAt(0) ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
}

/** Python `round(x, 1)`: the exact binary value, ties to even. */
export function pyRound1(x: number): number {
  // `toFixed` also rounds the exact binary value (1.95 is below 1.95, so it
  // gives 1.9), but breaks a true tie upward. The only binary values exactly
  // halfway between two tenths are odd multiples of 0.25.
  const quarters = x * 4;
  if (Number.isInteger(quarters) && quarters % 2 !== 0) {
    const floor = Math.floor(x * 10);
    return (floor % 2 === 0 ? floor : floor + 1) / 10;
  }
  return Number(x.toFixed(1));
}

/** Python `repr()` of a float in the range this tool prints. */
function pyFloat(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

/** Python `int(text)` for a decimal string. Throws as Python raises. */
function pyInt(text: string): number {
  const s = pyStrip(text);
  if (!/^[+-]?\p{Nd}+(?:_\p{Nd}+)*$/u.test(s))
    throw new Error(`invalid literal for int() with base 10: '${text}'`);
  let value = 0;
  for (const ch of s.replace(/^[+-]/, "").replaceAll("_", "")) {
    const code = ch.codePointAt(0) ?? 0;
    let zero = code;
    while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
    value = value * 10 + ((code - zero) % 10);
  }
  return s.startsWith("-") ? -value : value;
}

class PyFloat {
  constructor(readonly value: number) {}
}

/** Python `json.dumps(value, indent=2)`, with its default `ensure_ascii`. */
function pyDumps(value: unknown, depth = 0): string {
  const pad = "  ".repeat(depth + 1);
  const end = "  ".repeat(depth);
  if (value instanceof PyFloat) return pyFloat(value.value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((v) => pad + pyDumps(v, depth + 1)).join(",\n")}\n${end}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([k, v]) => `${pad}${pyDumps(k)}: ${pyDumps(v, depth + 1)}`).join(",\n")}\n${end}}`;
  }
  return JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// ---------------------------------------------------------------------------
// Upstream linter (ste-lint.py)
// ---------------------------------------------------------------------------

export type Level = "advisory-free" | "advisory";

export interface Finding {
  file: string;
  line: number;
  col: number;
  rule: string;
  level: Level;
  match: string;
  message: string;
}

/** A table cell's text and its zero-based source column. */
export type Cell = [text: string, column: number];

// Regex heuristics, not a parser. No noun-cluster rule: it needs part-of-speech
// tagging to avoid constant false positives. No ellipsis rule: technical
// writing sometimes earns one.
export const RULES: [
  id: string,
  level: Level,
  pattern: RegExp,
  message: string,
][] = [
  [
    "semicolon",
    "advisory-free",
    py(";", { global: true }),
    "STE bans the semicolon (Rule 8.1). Split into separate sentences.",
  ],
  [
    "phrasal-verb",
    "advisory-free",
    py(
      String.raw`\b(spin(?:ning|s)? up|spun up|reach(?:ing|es|ed)? out|div(?:e|es|ing|ed) into|dove into|kick(?:ing|s|ed)? off|circl(?:e|es|ing|ed) back|touch(?:ing|es|ed)? base)\b`,
      { ignoreCase: true, global: true },
    ),
    "Soft phrasal verb. Use the single plain verb (start, contact, read, begin).",
  ],
  [
    "marketing-adjective",
    "advisory-free",
    py(
      String.raw`\b(seamless(?:ly)?|robust(?:ly)?|cutting-edge|effortless(?:ly)?|blazing[- ]fast|world-class|state-of-the-art|game-chang(?:ing|er))\b`,
      { ignoreCase: true, global: true },
    ),
    "Marketing adjective. Delete, or replace with the measurement that earns the claim.",
  ],
  [
    "nominalization",
    "advisory-free",
    py(
      String.raw`\b(perform|performs|performed|conduct|conducts|conducted|carry out|carries out|carried out)\s+(?:a|an|the)\s+\w+(?:tion|sion|ment|ance|ence|ysis)\b`,
      { ignoreCase: true, global: true },
    ),
    "Action frozen into a noun. Use the verb (analyze, not perform an analysis of).",
  ],
  [
    "passive-voice",
    "advisory",
    py(
      String.raw`\b(is|are|was|were|been|being)\s+(\w+ed|given|taken|made|done|found|seen|known|shown|written|built|sent|set|run|read|kept|held|left|put)\b(?!\s+(?:to|for|by)\s+\w+ing)`,
      { ignoreCase: true, global: true },
    ),
    "Possible passive voice. Name the actor and use an active verb, unless the actor is unknown or irrelevant.",
  ],
  [
    "present-perfect",
    "advisory",
    // modal + perfect infinitive ("may have failed") is a protected hedge, not present perfect
    py(
      String.raw`(?<!\bmay )(?<!\bmight )(?<!\bcould )(?<!\bshould )(?<!\bwould )(?<!\bmust )\b(has|have|had)\s+(?:been\s+)?\w+(?:ed|en)\b`,
      { ignoreCase: true, global: true },
    ),
    "Compound tense. Use simple past/present unless current relevance is the point (then keep and flag).",
  ],
];

// One word, one meaning: groups of verbs commonly rotated for the same action.
// Only pairs where the members are genuinely interchangeable; error, fault and
// failure are distinct concepts and stay out.
export const SYNONYM_GROUPS: string[][] = [
  ["check", "verify", "confirm", "validate"],
  ["delete", "remove", "erase"],
  ["start", "launch", "begin", "initiate"],
  ["stop", "halt", "terminate"],
  ["show", "display"],
  ["use", "utilize", "employ"],
  ["fix", "repair", "correct"],
  ["send", "transmit"],
  ["get", "retrieve", "fetch", "obtain"],
  ["change", "modify", "alter"],
];

/** The cap for descriptions. The cap for instructions is 20, but it cannot be told apart without context. */
export const MAX_WORDS = 25;

export const CODE_FENCE = py("^(```|~~~)");
const INLINE_CODE = py("`[^`]*`", { global: true });
const LIST_ITEM_START = py(
  "^(?P<indent> {0,3})(?P<marker>[-*+]|[0-9]+[.)])(?P<gap> +)(?P<body>.*)$",
);
const CONJUNCTION_END = py(String.raw`\b(?:and|or)\s*$`, { ignoreCase: true });
const TABLE_SEPARATOR_CELL = py("^(?::?-{3,}:?)$");
const SENTENCE_BREAK = py(String.raw`(?<=[.!?])\s+`);
const UNESCAPED_PIPE = py(String.raw`(?<!\\)\|`);

const WORD_RES = new Map<string, RegExp>();
function wordRe(base: string): RegExp {
  let re = WORD_RES.get(base);
  if (!re) {
    re = py(String.raw`\b${base}(?:s|es|ed|d|ing)?\b`, { ignoreCase: true });
    WORD_RES.set(base, re);
  }
  return re;
}

/** Remove inline code spans, as upstream does before it reads prose. */
export function stripInlineCode(s: string): string {
  return s.replace(INLINE_CODE, "");
}

function leadingSpaces(line: string): number {
  return line.length - line.replace(/^ +/, "").length;
}

function isListContinuation(line: string, contentIndent: number): boolean {
  if (!pyStrip(line)) return true;
  if (LIST_ITEM_START.test(line)) return false;
  return leadingSpaces(line) >= contentIndent;
}

/**
 * Return trimmed table cells and their zero-based source columns.
 *
 * A pipe must separate at least two cells. Escaped pipes stay in their cell.
 * This deliberately implements only the ordinary Markdown table shape; it is
 * enough to distinguish a table from prose that happens to contain a pipe.
 */
export function splitTableRow(line: string): Cell[] | null {
  let left = cpLen(line) - cpLen(pyLstrip(line));
  const right = cpLen(pyRstrip(line));
  let content = cpSlice(line, left, right);
  if (!content.includes("|")) return null;
  if (content.startsWith("|")) {
    content = content.slice(1);
    left += 1;
  }
  if (content.endsWith("|")) content = content.slice(0, -1);
  const rawCells = content.split(UNESCAPED_PIPE);
  if (rawCells.length < 2) return null;
  const cells: Cell[] = [];
  let column = left;
  for (const rawCell of rawCells) {
    const leading = cpLen(rawCell) - cpLen(pyLstrip(rawCell));
    cells.push([pyStrip(rawCell), column + leading]);
    column += cpLen(rawCell) + 1;
  }
  return cells;
}

/**
 * Map ordinary Markdown table rows to their prose cells.
 *
 * The separator row anchors detection, so pipe-containing prose is not
 * treated as a table. Both leading-pipe and no-leading-pipe table styles are
 * accepted when their header and body use the same number of cells.
 */
export function markdownTableCells(lines: string[]): Map<number, Cell[]> {
  const tableCells = new Map<number, Cell[]>();
  let index = 1;
  while (index < lines.length) {
    const separator = splitTableRow(lines[index] as string);
    const header = splitTableRow(lines[index - 1] as string);
    if (
      !separator ||
      !header ||
      separator.length !== header.length ||
      !separator.every(([cell]) => TABLE_SEPARATOR_CELL.test(cell))
    ) {
      index += 1;
      continue;
    }
    tableCells.set(index - 1, header);
    tableCells.set(index, []);
    index += 1;
    while (index < lines.length) {
      const row = splitTableRow(lines[index] as string);
      if (!row || row.length !== separator.length) break;
      tableCells.set(index, row);
      index += 1;
    }
  }
  return tableCells;
}

function danglingConjunctionFindings(
  text: string,
  filename: string,
): Finding[] {
  const lines = splitlines(text);
  const findings: Finding[] = [];
  let inFence = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (CODE_FENCE.test(pyStrip(line))) {
      inFence = !inFence;
      index += 1;
      continue;
    }
    if (inFence) {
      index += 1;
      continue;
    }
    const start = LIST_ITEM_START.exec(line);
    if (!start?.groups) {
      index += 1;
      continue;
    }
    const { indent = "", marker = "", gap = "", body = "" } = start.groups;
    const contentIndent = indent.length + marker.length + gap.length;
    const itemLines: [number, string][] = [[index, body]];
    let nextIndex = index + 1;
    let itemFence = false;
    while (nextIndex < lines.length) {
      const candidate = lines[nextIndex] as string;
      if (CODE_FENCE.test(pyStrip(candidate))) {
        // Fence delimiters are state markers, not meaningful item lines.
        itemFence = !itemFence;
        nextIndex += 1;
        continue;
      }
      if (itemFence) {
        nextIndex += 1;
        continue;
      }
      if (!isListContinuation(candidate, contentIndent)) break;
      itemLines.push([nextIndex, candidate]);
      nextIndex += 1;
    }

    const meaningful: [number, string][] = [];
    for (const [lineIndex, itemLine] of itemLines) {
      // Preserve code spans as neutral operands while ignoring their contents.
      const cleaned = pyStrip(itemLine.replace(INLINE_CODE, " CODE "));
      if (cleaned) meaningful.push([lineIndex, cleaned]);
    }
    const last = meaningful[meaningful.length - 1];
    if (last && CONJUNCTION_END.test(last[1])) {
      const [endLineIndex, endLine] = last;
      let findingLine: number;
      let findingCol: number;
      if (endLineIndex === index) {
        findingLine = index + 1;
        findingCol = indent.length + 1;
      } else {
        const rawEndLine = (
          itemLines.find(([i]) => i === endLineIndex) as [number, string]
        )[1];
        const masked = rawEndLine.replace(INLINE_CODE, (m) =>
          " ".repeat(cpLen(m)),
        );
        const rawConjunction = CONJUNCTION_END.exec(masked);
        findingLine = endLineIndex + 1;
        findingCol = rawConjunction
          ? cpIndex(masked, rawConjunction.index) + 1
          : 1;
      }
      findings.push({
        file: filename,
        line: findingLine,
        col: findingCol,
        rule: "dangling-conjunction",
        level: "advisory-free",
        match: endLine,
        message:
          "List item ends with a coordinating conjunction. Complete the item or join it with the next item.",
      });
    }
    index = nextIndex;
  }
  return findings;
}

function byPosition(a: Finding, b: Finding): number {
  return a.line - b.line || a.col - b.col;
}

/** The upstream linter: every rule, one physical line at a time. */
export function upstreamLint(
  text: string,
  filename = "<stdin>",
): [Finding[], number] {
  const findings: Finding[] = [];
  let wordsTotal = 0;
  let inFence = false;
  const lines = splitlines(text);
  const tableCells = markdownTableCells(lines);
  // first occurrence of each synonym-group member: "group:base" -> [line, col, match]
  const seenSynonyms = new Map<string, [number, number, string]>();
  lines.forEach((rawLine, i) => {
    const lineno = i + 1;
    if (CODE_FENCE.test(pyStrip(rawLine))) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const segments = tableCells.get(lineno - 1) ?? [[rawLine, 0]];
    for (const [segment, sourceColumn] of segments) {
      const line = stripInlineCode(segment);
      wordsTotal += pySplit(line).length;
      for (const [ruleId, level, pattern, message] of RULES) {
        for (const m of line.matchAll(pattern)) {
          findings.push({
            file: filename,
            line: lineno,
            col: sourceColumn + cpIndex(line, m.index) + 1,
            rule: ruleId,
            level,
            match: m[0],
            message,
          });
        }
      }
      SYNONYM_GROUPS.forEach((group, gi) => {
        for (const base of group) {
          const key = `${gi}:${base}`;
          if (seenSynonyms.has(key)) continue;
          const m = wordRe(base).exec(line);
          if (m)
            seenSynonyms.set(key, [
              lineno,
              sourceColumn + cpIndex(line, m.index) + 1,
              m[0],
            ]);
        }
      });
      for (const sentence of line.split(SENTENCE_BREAK)) {
        const n = pySplit(sentence).length;
        if (n > MAX_WORDS) {
          findings.push({
            file: filename,
            line: lineno,
            col: sourceColumn + 1,
            rule: "long-sentence",
            level: "advisory-free",
            match: `${n} words`,
            message: `Sentence has ${n} words (cap ${MAX_WORDS}). Split it.`,
          });
        }
      }
    }
  });
  // synonym rotation: flag each member after the first, at its first occurrence
  SYNONYM_GROUPS.forEach((group, gi) => {
    const present: [[number, number, string], string][] = [];
    for (const base of group) {
      const seen = seenSynonyms.get(`${gi}:${base}`);
      if (seen) present.push([seen, base]);
    }
    if (present.length <= 1) return;
    present.sort(
      ([[la, ca, ma], ba], [[lb, cb, mb], bb]) =>
        la - lb || ca - cb || cmpStr(ma, mb) || cmpStr(ba, bb),
    ); // document order
    const firstBase = (present[0] as [unknown, string])[1];
    for (const [[lineno, col, match], base] of present.slice(1)) {
      findings.push({
        file: filename,
        line: lineno,
        col,
        rule: "synonym-rotation",
        level: "advisory-free",
        match,
        message: `'${base}' and '${firstBase}' name the same action. Pick one and use it every time.`,
      });
    }
  });
  findings.push(...danglingConjunctionFindings(text, filename));
  findings.sort(byPosition);
  return [findings, wordsTotal];
}

// ---------------------------------------------------------------------------
// Wrapper: lint hard-wrapped Markdown by sentence (ste-lint-joined.py)
//
// The upstream linter measures sentence length one physical line at a time,
// so it never sees a long sentence that a Markdown editor wrapped over several
// lines. `lint` runs the upstream linter twice. On the original text it keeps
// every finding except `long-sentence`; on the joined text (each wrapped
// paragraph or list item on one logical line) it keeps only `long-sentence`.
//
// Local corrections sit around the upstream call. Fenced code is blanked
// first, by real fence rules (delimiter character and length), so both passes
// skip the same regions. A modal hedge keeps its protection when a wrap or an
// adverb separates the modal from `have`. `synonym-rotation` is demoted to
// advice, because two verbs from one group do not prove they name one action.
// The joined line carries no list marker or quote marker, so `-` and `>` never
// count as words.
//
// The joined text goes on the paragraph's FIRST physical line and the
// remaining physical lines become empty. A `long-sentence` finding therefore
// reports the first line of its paragraph, with a column relative to the
// joined line.
// ---------------------------------------------------------------------------

// Markdown allows spaces between the marker characters (`* * *`, `- - -`).
const THEMATIC_BREAK = py(
  String.raw`^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$`,
);
const QUOTE_PREFIX = py(String.raw`^(?:\s{0,3}>\s?)+`);
const QUOTE_OPEN = py("^ {0,3}>[ ]?");
const HEADING = py(String.raw`^#{1,6}(?:\s|$)`);
// Deliberately broader than upstream's LIST_ITEM_START: any indent depth.
// A new item must always start a new joined line.
const ITEM_START = py(String.raw`^\s*(?:[-*+]|\d+[.)])\s+`);
// A fence delimiter sits at most three spaces inside its container.
const FENCE_RUN = py("^ {0,3}(?P<run>`{3,}|~{3,})(?P<info>.*)$");
const FENCE_LEAD = py("^(\\s*)(?:`{3,}|~{3,})");
const LIST_OPEN = py(
  String.raw`^( {0,3})([-*+]|\d{1,9}[.)])(?:( +)(?=\S)|[ ]*$)`,
);
// A modal hedge, optionally followed by adverbs, directly before `have`.
const MODAL_BEFORE = py(
  String.raw`\b(?:may|might|could|should|would|must)\s+` +
    String.raw`(?:(?:\w+ly|already|also|still|just|not|never|yet|ever)\s+)*$`,
  { ignoreCase: true },
);
const WS_RUN_ALL = py(String.raw`\s+`, { global: true });

/** One physical line after its containers are consumed. */
interface LineRecord {
  /** blockquote nesting depth */
  depth: number;
  /** identity of every open container, outermost first */
  path: number[];
  /** text after every quote prefix and list marker */
  inner: string;
  /** a list item starts on this line */
  item: boolean;
  /** paragraph text: not blank, code, heading, rule or table */
  prose: boolean;
}

interface Container {
  kind: "q" | "l";
  /** a list item's content indent */
  width: number;
  id: number;
}

const quoteDepth = (stack: Container[]) =>
  stack.filter((c) => c.kind === "q").length;
const containerPath = (stack: Container[]) => stack.map((c) => c.id);

/**
 * Parse the container structure once. Return [lines, per-line records].
 *
 * One stack of open blockquotes and list items serves every decision. Each
 * line is matched against the stack outermost first: a quote needs its `>`,
 * a list item needs its content indent (a blank line keeps it open), and the
 * first container that fails ends itself and everything inside it. Whatever
 * remains may open new containers, then a fence. Inside a fence the rest of
 * the line is code, and only a delimiter within three spaces of the
 * container closes it. A fence ends with its container, unclosed.
 * The returned lines have fenced code emptied, and the count never changes.
 */
function scan(text: string): [string[], LineRecord[]] {
  const lines = splitlines(text);
  const out = [...lines];
  const records: LineRecord[] = [];
  const stack: Container[] = [];
  let opened = 0; // containers opened so far; each gets its own id
  let fence: { char: string; length: number; holders: number } | null = null;
  lines.forEach((line, index) => {
    let rest = expandTabs(line, 4);
    let matched = 0;
    for (const { kind, width } of stack) {
      if (kind === "q") {
        const prefix = QUOTE_OPEN.exec(rest);
        if (!prefix) break;
        rest = rest.slice(prefix[0].length);
      } else if (pyStrip(rest)) {
        if (leadingSpaces(rest) < width) break;
        rest = cpSlice(rest, width);
      }
      matched += 1;
    }
    stack.length = matched;
    if (fence !== null && matched < fence.holders) fence = null;
    if (fence !== null) {
      out[index] = "";
      const closer = FENCE_RUN.exec(rest)?.groups;
      if (
        closer &&
        closer.run?.[0] === fence.char &&
        (closer.run?.length ?? 0) >= fence.length &&
        !pyStrip(closer.info ?? "")
      ) {
        fence = null;
      }
      records.push({
        depth: quoteDepth(stack),
        path: containerPath(stack),
        inner: "",
        item: false,
        prose: false,
      });
      return;
    }
    let item = false;
    while (!THEMATIC_BREAK.test(pyStrip(rest))) {
      const prefix = QUOTE_OPEN.exec(rest);
      if (prefix) {
        opened += 1;
        stack.push({ kind: "q", width: 0, id: opened });
        rest = rest.slice(prefix[0].length);
        continue;
      }
      const marker = LIST_OPEN.exec(rest);
      if (!marker) break;
      const spaces = (marker[3] ?? "").length;
      const width =
        cpLen((marker[1] ?? "") + (marker[2] ?? "")) +
        (spaces > 0 && spaces <= 4 ? spaces : 1);
      opened += 1;
      stack.push({ kind: "l", width, id: opened });
      rest = cpSlice(rest, width);
      item = true;
    }
    const depth = quoteDepth(stack);
    const opener = FENCE_RUN.exec(rest)?.groups;
    if (
      opener &&
      !(opener.run?.[0] === "`" && (opener.info ?? "").includes("`"))
    ) {
      fence = {
        char: opener.run?.[0] as string,
        length: opener.run?.length ?? 0,
        holders: stack.length,
      };
      out[index] = "";
      records.push({
        depth,
        path: containerPath(stack),
        inner: "",
        item,
        prose: false,
      });
      return;
    }
    // Any other line that upstream would still take for a delimiter (a
    // rejected opener, indented code) has its run removed.
    if (CODE_FENCE.test(pyStrip(out[index] as string))) {
      out[index] = (out[index] as string).replace(FENCE_LEAD, "$1");
    }
    if (CODE_FENCE.test(pyStrip(rest))) rest = rest.replace(FENCE_LEAD, "$1");
    if (!item && ITEM_START.test(rest)) {
      item = true;
      rest = rest.replace(ITEM_START, "");
    }
    const stripped = pyStrip(rest);
    const prose =
      Boolean(stripped) &&
      !(HEADING.test(stripped) || THEMATIC_BREAK.test(stripped));
    records.push({
      depth,
      path: containerPath(stack),
      inner: rest,
      item,
      prose,
    });
  });
  return [out, records];
}

const samePath = (a: number[], b: number[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Return the indexes of table rows, found one container block at a time.
 *
 * A table cannot cross a change of container: entering, leaving or replacing
 * a quote or list item, at any depth, gives the line a different container
 * path. Upstream sees each run of lines with one path on its own and never
 * pairs a header with a separator, or a row with a table, from another block.
 */
function tableRowIndexes(records: LineRecord[]): Set<number> {
  const rows = new Set<number>();
  let start = 0;
  for (let index = 1; index <= records.length; index++) {
    const record = records[index];
    if (record && samePath(record.path, (records[start] as LineRecord).path))
      continue;
    const block = records.slice(start, index).map((r) => r.inner);
    for (const offset of markdownTableCells(block).keys())
      rows.add(start + offset);
    start = index;
  }
  return rows;
}

/** Return [lines with fences emptied, records with tables and front matter marked]. */
function parse(text: string): [string[], LineRecord[]] {
  const [lines, records] = scan(text);
  for (const index of tableRowIndexes(records))
    (records[index] as LineRecord).prose = false;
  if (lines.length && pyStrip(lines[0] as string) === "---") {
    // YAML front matter is metadata, not prose: skip to its closing rule.
    for (let index = 1; index < lines.length; index++) {
      if (pyStrip(lines[index] as string) === "---") {
        for (let skipped = 0; skipped <= index; skipped++)
          (records[skipped] as LineRecord).prose = false;
        break;
      }
    }
  }
  return [lines, records];
}

/**
 * Return `text` with every fenced code region emptied, line count intact.
 *
 * A fence closes only on the same character, with at least the opening
 * length and no info string. A backtick fence cannot hold a backtick in its
 * info string. Container rules are in `scan`.
 */
export function blankFences(text: string): string {
  return scan(text)[0].join("\n");
}

/**
 * Return `text` with every wrapped paragraph or list item on one line.
 *
 * Headings, table rows, code fences, horizontal rules, front matter and blank
 * lines stay as they are. The line count never changes. Quote prefixes are
 * removed before any boundary is tested, and a change of quote depth is
 * a boundary. The joined line starts after its list marker and quote marker.
 */
export function joinWrapped(text: string): string {
  const [out, records] = parse(text);
  const buffer: number[] = []; // physical indexes of the open paragraph
  let bufferDepth = 0;

  const flush = () => {
    if (!buffer.length) return;
    const parts = buffer.map((i) => pyStrip((records[i] as LineRecord).inner));
    // A joined line is paragraph text. Its pipes must not rebuild a table
    // row beside a table the original containers kept apart; the broken
    // bar is the same width and the same one word.
    out[buffer[0] as number] = parts
      .filter((p) => p)
      .join(" ")
      .replaceAll("|", "\u00a6");
    for (const index of buffer.slice(1)) out[index] = "";
    buffer.length = 0;
  };

  records.forEach((record, index) => {
    if (buffer.length && record.depth !== bufferDepth) flush();
    if (!record.prose) {
      flush();
      // Upstream must see the same table row, heading or rule as it would
      // without the containers: a `>` or list marker left on the line is an
      // extra cell or word there.
      out[index] = record.inner;
      return;
    }
    if (record.item) flush();
    if (!buffer.length) bufferDepth = record.depth;
    buffer.push(index);
  });
  flush();
  return out.join("\n");
}

/**
 * Return the prose of the paragraph lines that come before line `index`.
 *
 * Quote and list prefixes are already removed. The walk back stops at the
 * paragraph start: a blank line, heading, rule, table row, code, an item
 * start or a change of quote depth. A modal can sit on any earlier wrapped
 * line, so the context is the whole paragraph, never one physical line.
 */
function paragraphBefore(records: LineRecord[], index: number): string[] {
  const here = records[index] as LineRecord;
  const parts: string[] = [];
  let cursor = index;
  while (cursor > 0 && !(records[cursor] as LineRecord).item) {
    const prev = records[cursor - 1] as LineRecord;
    if (!prev.prose || prev.depth !== here.depth) break;
    parts.unshift(prev.inner);
    cursor -= 1;
  }
  return parts;
}

/** True when a modal hedge directly precedes the finding, wraps included. */
function afterModal(
  lines: string[],
  records: LineRecord[],
  finding: Finding,
  tableCells: Map<number, Cell[]>,
): boolean {
  const index = finding.line - 1;
  // Upstream reports source_column + an offset into the CLEANED cell, so the
  // prefix must be cut from the cleaned cell, not from the cleaned line.
  const segments = tableCells.get(index) ?? [[lines[index] as string, 0]];
  const column = finding.col - 1;
  const candidates = segments.filter(([, start]) => start <= column);
  const chosen = candidates[candidates.length - 1];
  if (!chosen)
    throw new Error(
      `no segment holds column ${finding.col} on line ${finding.line}`,
    );
  const [segment, start] = chosen;
  let here = cpSlice(stripInlineCode(segment), 0, column - start);
  here = here.replace(QUOTE_PREFIX, "");
  const before = paragraphBefore(records, index)
    .map((p) => pyStrip(stripInlineCode(p)))
    .join(" ");
  const context = `${before} ${here}`.replace(WS_RUN_ALL, " ");
  return MODAL_BEFORE.test(context);
}

/** Apply the local corrections to one finding of the original-text pass. */
function refine(
  lines: string[],
  records: LineRecord[],
  finding: Finding,
  tableCells: Map<number, Cell[]>,
): Finding | null {
  if (
    finding.rule === "present-perfect" &&
    afterModal(lines, records, finding, tableCells)
  )
    return null;
  if (finding.rule === "synonym-rotation") {
    const message = finding.message.replaceAll(
      "name the same action. Pick one and use it every time.",
      "may name the same action. If they do, pick one and use it every " +
        "time. Ignore this if they name different actions.",
    );
    return { ...finding, level: "advisory", message };
  }
  return finding;
}

/** The linter `decide` runs: the upstream rules, with the wrapper's join and corrections. */
export function lint(
  source: string,
  filename = "<stdin>",
): [Finding[], number] {
  const text = blankFences(source);
  const records = parse(source)[1];
  const [upstream, wordsTotal] = upstreamLint(text, filename);
  const lines = splitlines(text);
  const tableCells = markdownTableCells(lines);
  const findings: Finding[] = [];
  for (const finding of upstream) {
    if (finding.rule === "long-sentence") continue;
    const kept = refine(lines, records, finding, tableCells);
    if (kept) findings.push(kept);
  }
  const [joined] = upstreamLint(joinWrapped(source), filename);
  findings.push(...joined.filter((f) => f.rule === "long-sentence"));
  findings.sort(byPosition);
  return [findings, wordsTotal];
}

// ---------------------------------------------------------------------------
// Report and command line
// ---------------------------------------------------------------------------

/** Render the report exactly as the Python originals print it. */
export function report(
  findings: Finding[],
  wordsTotal: number,
  asJson: boolean,
  hardCount: number,
  baseline: number,
): string {
  const rate = wordsTotal ? pyRound1((findings.length * 100) / wordsTotal) : 0;
  if (asJson) {
    return `${pyDumps({
      violations: findings,
      count: findings.length,
      hard_count: hardCount,
      baseline,
      words: wordsTotal,
      per_100_words: new PyFloat(rate),
    })}\n`;
  }
  const out = findings.map(
    (f) =>
      `${f.file}:${f.line}:${f.col} ${f.rule}: ${f.message} [${f.match}]\n`,
  );
  out.push(
    `\n${findings.length} violations (${hardCount} hard, baseline ${baseline}), ` +
      `${wordsTotal} words, ${pyFloat(rate)} per 100 words\n`,
  );
  out.push(
    "Hedges/modality (may, might, could) are never flagged: confidence is content.\n",
  );
  return out.join("");
}

function assert(condition: unknown, detail?: unknown): asserts condition {
  if (!condition) throw new Error(`selftest failed: ${JSON.stringify(detail)}`);
}

const rulesOf = (findings: Finding[], rule: string) =>
  findings.filter((f) => f.rule === rule);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The upstream selftest. */
export function selftestUpstream(): string {
  const lint = upstreamLint;
  const bad =
    "The panel is removed; spin up the job. " +
    "Perform an analysis of the seamless log. " +
    "We have received the report.";
  let [findings] = lint(bad);
  const rules = new Set(findings.map((f) => f.rule));
  for (const expected of [
    "semicolon",
    "phrasal-verb",
    "nominalization",
    "marketing-adjective",
    "passive-voice",
    "present-perfect",
  ])
    assert(rules.has(expected), expected);
  // hedges must never be flagged, including modal + perfect infinitive
  [findings] = lint(
    "The request may have failed. It could be a timeout. The disk might have filled.",
  );
  assert(findings.length === 0, findings);
  // code blocks skipped
  [findings] = lint("```\nx = a; y = b\n```");
  assert(findings.length === 0, findings);
  // all supported list markers, case variants, and trailing whitespace
  [findings] = lint(
    "- Confirm the target and\n* Record the result OR  \n+ Close the panel\n1. Start the task and\n2) Stop the task OR",
  );
  let dangling = rulesOf(findings, "dangling-conjunction");
  assert(dangling.length === 4, dangling);
  assert(
    same(
      dangling.map((f) => f.line),
      [1, 2, 4, 5],
    ),
    dangling,
  );
  assert(
    same(
      dangling.map((f) => f.col),
      [1, 1, 1, 1],
    ),
    dangling,
  );
  assert(
    dangling.every((f) => f.level === "advisory-free"),
    dangling,
  );

  const noDangling = (text: string) =>
    assert(!rulesOf(lint(text)[0], "dangling-conjunction").length, text);
  // valid continuation lines and standalone four-space code are ignored
  noDangling("  - Confirm the target and\n    record the result.");
  [findings] = lint("- Confirm the target\n  and");
  dangling = rulesOf(findings, "dangling-conjunction");
  assert(dangling.length === 1 && dangling[0]?.line === 2, dangling);
  assert(dangling[0]?.col === 3, dangling);
  noDangling("    - code and");
  noDangling("> - Confirm the target and\n> - Record the result or");
  [findings] = lint("- Do this and\n~~~\ncode and\n~~~");
  dangling = rulesOf(findings, "dangling-conjunction");
  assert(dangling.length === 1 && dangling[0]?.line === 1, dangling);
  noDangling("```text\n- code and\n```");

  // one- and three-space markers and ordered continuation width
  noDangling(" - Start the task and\n   record the result.");
  noDangling("-  Start the task and\n   record the result.");
  noDangling("-\tStart the task and");
  [findings] = lint("   - Start the task and", "fixture.md");
  dangling = rulesOf(findings, "dangling-conjunction");
  assert(dangling.length === 1 && dangling[0]?.col === 4, dangling);
  assert(dangling[0]?.file === "fixture.md");
  assert(dangling[0]?.match.endsWith("and"));
  assert(dangling[0]?.message.includes("Complete the item"));
  [findings] = lint("100. Start the task and\n  unrelated text");
  dangling = rulesOf(findings, "dangling-conjunction");
  assert(dangling.length === 1, dangling);
  noDangling("- Start the task and.\n- Stop the task or,");
  noDangling("- Start the task and\n\n  record the result.");
  [findings] = lint("- Parent item and\n  - Nested item or");
  dangling = rulesOf(findings, "dangling-conjunction");
  assert(
    same(
      dangling.map((f) => f.line),
      [1, 2],
    ),
    dangling,
  );

  // ordinary prose, inline code, and fenced code are ignored
  noDangling("The process may include steps and");
  noDangling("- Use `and` as a label");
  noDangling("- Combine `left` and `right`");
  noDangling("~~~\n- code and\n~~~");
  [findings] = lint(`${"word ".repeat(30).trim()}.`);
  assert(rulesOf(findings, "long-sentence").length, findings);
  // Markdown table syntax is layout, not prose. Each cell stays lintable.
  const terms = (n: number) =>
    `${Array.from({ length: n }, (_, i) => `term${i + 1}`).join(" ")}.`;
  const shortCell = terms(24);
  for (const table of [
    `| Label | Detail |\n| --- | --- |\n| Clear | ${shortCell} |`,
    `Label | Detail\n--- | ---\nClear | ${shortCell}`,
  ]) {
    const [tableFindings, wordsTotal] = lint(table);
    assert(!rulesOf(tableFindings, "long-sentence").length, tableFindings);
    assert(wordsTotal === 27, wordsTotal);
  }
  [findings] = lint(
    `| Label | Detail |\n| --- | --- |\n| Clear | ${terms(26)} |`,
  );
  const longSentences = rulesOf(findings, "long-sentence");
  assert(longSentences.length === 1, longSentences);
  assert(longSentences[0]?.match === "26 words", longSentences);
  // synonym rotation: second member flagged, first named as the keeper
  [findings] = lint(
    "Check the config file. Then verify the output. Verify twice.",
  );
  const rotation = rulesOf(findings, "synonym-rotation");
  assert(
    rotation.length === 1 &&
      rotation[0]?.message.includes("'verify' and 'check'"),
    rotation,
  );
  // single consistent term: no flag
  [findings] = lint("Check the config. Check the output.");
  assert(!rulesOf(findings, "synonym-rotation").length, findings);
  // per-file labels
  [findings] = lint("a; b", "x.md");
  assert(findings[0]?.file === "x.md");
  return "selftest OK";
}

/** The wrapper's own selftest. The upstream selftest runs separately. */
export function selftestJoined(): string {
  const longOf = (text: string) => rulesOf(lint(text)[0], "long-sentence");
  const words = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
  const longWrapped =
    "The importer reads the export and then compares each stated\n" +
    "shipping price with the matching rule in our catalogue so the\n" +
    "reviewer can see every difference before the import runs.";
  assert(
    splitlines(longWrapped).reduce((n, line) => n + pySplit(line).length, 0) ===
      30,
  );
  assert(!rulesOf(upstreamLint(longWrapped)[0], "long-sentence").length);
  let found = longOf(longWrapped);
  assert(found.length === 1 && found[0]?.line === 1, found);
  // a quoted paragraph after a table is a separate block, so its long
  // sentence is still found
  const cells = [words("w", 14), words("w", 14)].join(" | ");
  found = longOf(`| A | B |\n| --- | --- |\n> | ${cells} |`);
  assert(
    same(
      found.map((f) => f.line),
      [3],
    ),
    found,
  );
  // a hedge stays unflagged after joining
  assert(!lint("The request may have\nfailed.")[0].length);
  // nested list items and blockquote items are separate items, never one sentence
  const nested =
    "- Options:\n  - Keep the current shipping price for all orders\n" +
    "    - this applies to every order in the shop today\n" +
    "    - this applies to new orders placed after the change";
  assert(!longOf(nested).length, nested);
  const quoted =
    "> - Keep the current shipping price for all orders that are in scope\n" +
    "> - Apply the discount rule to every new order that is placed later";
  assert(!longOf(quoted).length, quoted);
  // every rule except long-sentence and synonym-rotation matches upstream
  // exactly, on the original text
  const local = new Set(["long-sentence", "synonym-rotation"]);
  for (const text of [
    "- Start the task and\n\n  record the result.",
    "    - code and",
    "- Confirm the target\n  and",
    "Check the file. Then verify it;\nconfirm twice. We have seen it.",
    "```\nx = a; y = b\n```\n# Heading; kept\n",
  ]) {
    const mine = lint(text)[0].filter((f) => !local.has(f.rule));
    const theirs = upstreamLint(text)[0].filter((f) => !local.has(f.rule));
    assert(same(mine, theirs), { text, mine, theirs });
  }
  // synonym-rotation stays visible but is advice, never a hard finding
  const rotation = rulesOf(
    lint("Validate the input. Confirm the choice.")[0],
    "synonym-rotation",
  );
  assert(rotation.length === 1 && rotation[0]?.level === "advisory", rotation);
  assert(!rotation[0]?.message.includes("Pick one"), rotation);
  assert(rotation[0]?.message.split("pick one").length === 2, rotation);
  // a hedge keeps its protection across a wrap before `have` and an adverb
  for (const hedge of [
    "The request may\nhave failed.",
    "The request may  have failed.",
    "The request may already have failed.",
    "The request may not yet have failed.",
  ])
    assert(!lint(hedge)[0].length, hedge);
  assert(rulesOf(lint("We have seen it.")[0], "present-perfect").length);
  // spaced thematic breaks are boundaries, whatever the marker
  const half = words("w", 14);
  for (const rule of ["_ _ _", "* * *", "- - -", "***"])
    assert(!longOf(`${half}\n${rule}\n${half}`).length, rule);
  // blockquote structure is parsed before boundaries: a quoted blank line,
  // a quoted heading and a quote that ends without a blank line all split
  for (const text of [
    `> ${half}\n>\n> ${half}`,
    `> ${half}\n> # Heading\n> ${half}`,
    `> ${half}\n${half}`,
    `${half}\n> ${half}`,
  ])
    assert(!longOf(text).length, text);
  // list and quote markers are not words: exactly 25 words is not long
  const prose = words("w", 25);
  for (const marker of ["- ", "> ", "1. ", "> - "])
    assert(!longOf(marker + prose).length, marker);
  // fences close on the same character and at least the same length
  assert(!lint("````\n```\nx = a; y = b\n```\n````\nDone.")[0].length);
  assert(!lint("```\n~~~\nx = a; y = b\n~~~\n```\nDone.")[0].length);
  assert(rulesOf(lint("```\nx\n```\nA; B.")[0], "semicolon").length);
  // a fence ends with its blockquote: the prose after it is linted again
  for (const text of ["> ```\n> code\n\nOne; two.", "> ```\n> code\nOne; two."])
    assert(rulesOf(lint(text)[0], "semicolon").length, text);
  assert(!rulesOf(lint("> ```\n> a; b\n> ```")[0], "semicolon").length);
  const ruleLines = (text: string) =>
    lint(text)[0].map((f) => [f.rule, f.line]);
  // a fence can open right after a list marker, and ends with its list item
  let got = ruleLines("- ```python\n  x = a; y = b\n  ```\n\nOne; two.");
  assert(same(got, [["semicolon", 5]]), got);
  got = ruleLines("- ```\n  x = a; y = b\nOne; two.");
  assert(same(got, [["semicolon", 3]]), got);
  // a rejected opener is prose, and upstream must not take it for a delimiter
  assert(rulesOf(lint("```foo`bar`\n\nOne; two.")[0], "semicolon").length);
  // hedges keep their protection across wrapped quotes, items and lines
  for (const hedge of [
    "> The request may\n> have failed.",
    "The request may\nalready\nhave failed.",
    "- The request may\n  already\n  have failed.",
    "| a | b |\n|---|---|\n| `x` | The request may already have failed. |",
  ])
    assert(!lint(hedge)[0].length, hedge);
  // a modal in an earlier paragraph does not protect a later sentence
  assert(
    rulesOf(lint("It may rain.\n\nWe have seen it.")[0], "present-perfect")
      .length,
  );
  // one container model decides fences, joins and hedges
  for (const [text, expected] of [
    ["    ````\nOne; two.", [["semicolon", 2]]],
    ["> - ```\n>   a; b\n>   ````\nAfter; now.", [["semicolon", 4]]],
    [
      "````\n- ```\nOne; two.\n```\nAfter; now.\n````\nEnd; here.",
      [["semicolon", 7]],
    ],
    ["````\n> ```\nOne; two.\n````\nEnd; here.", [["semicolon", 5]]],
    ["- Example\n\n  ```\n  code\n\nOutside; prose.", [["semicolon", 6]]],
    ["> ```\n> code\n\n> One; two.", [["semicolon", 4]]],
    ["- > ```\n  > a; b\n  > ```\nAfter; now.", [["semicolon", 4]]],
    ["> | a | b |\n> |---|---|\n> | c | d |", []],
    ["> The request may\n> already\n> have failed.", []],
  ] as [string, [string, number][]][]) {
    got = ruleLines(text);
    assert(same(got, expected), { text, got });
  }
  // a table or heading inside a container is judged like the same text
  // outside it: no layout token reaches the sentence-length pass
  const cell = words("w", 24);
  const bare = `| Label | Detail |\n| --- | --- |\n| x | ${cell} |`;
  assert(bare.split("w").length - 1 === 24);
  for (const [first, rest] of [
    ["> ", "> "],
    ["- ", "  "],
    ["> - ", ">   "],
  ] as [string, string][]) {
    const rows = bare.split("\n");
    const text = [
      first + rows[0],
      ...rows.slice(1).map((row) => rest + row),
    ].join("\n");
    assert(
      same(
        longOf(text).map((f) => f.rule),
        longOf(bare).map((f) => f.rule),
      ),
      text,
    );
  }
  const heading = `# ${cell} ${cell}`;
  assert(
    same(
      lint(`> ${heading}`)[0].map((f) => f.rule),
      lint(heading)[0].map((f) => f.rule),
    ),
  );
  // a table ends with its container, whichever way the container is left:
  // a line that exits a list item, or a nested item into its parent, is
  // paragraph text and its pipes never rebuild a table row
  const longRow = [words("w", 14), words("w", 14)].join(" | ");
  for (const [text, line] of [
    [`- | A | B |\n  | --- | --- |\n${longRow}`, 3],
    [`- Outer\n  - | A | B |\n    | --- | --- |\n  ${longRow}`, 4],
    [`> - | A | B |\n>   | --- | --- |\n> ${longRow}`, 3],
  ] as [string, number][]) {
    const lines = longOf(text).map((f) => f.line);
    assert(same(lines, [line]), { text, lines });
  }
  // the same table, kept inside its item, is still a table row
  const inside = `- | A | B |\n  | --- | --- |\n  | ${longRow} |`;
  assert(!longOf(inside).length, inside);
  return "selftest OK (joined)";
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Read a file as Python's `open(path, encoding="utf-8").read()` does: universal newlines. */
function readText(path: string): string {
  return decoder.decode(readFileSync(path)).replace(/\r\n?/g, "\n");
}

/** The flags that take no value. */
const SWITCHES = new Set(["--json", "--raw", "--selftest"]);

/**
 * Run the command line. Returns the exit code and writes the report to
 * `out`. `--raw` selects the upstream linter alone; every other flag behaves
 * as the Python originals do. An unknown flag is an error, so a misspelt one
 * cannot pass with the check it asked for left undone.
 */
export function main(
  argv: string[],
  out: (text: string) => void = (text) => process.stdout.write(text),
  readStdin: () => string = () => decoder.decode(readFileSync(0)),
): number {
  const raw = argv.includes("--raw");
  const lintFn = raw ? upstreamLint : lint;
  const asJson = argv.includes("--json");
  let baseline = 0;
  let disabled = new Set<string>();
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--baseline" || a === "--disable") {
      i += 1;
      const value = argv[i];
      // A `--` token is a flag, never a value: `--disable --jsno` would
      // otherwise swallow the misspelt flag as a rule name.
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${a} needs a value`);
      if (a === "--baseline") baseline = pyInt(value);
      else disabled = new Set(value.split(","));
    } else if (!a.startsWith("--")) {
      paths.push(a);
    } else if (!SWITCHES.has(a)) {
      throw new Error(`unknown flag ${a}`);
    }
  }
  if (argv.includes("--selftest")) {
    out(`${selftestUpstream()}\n`);
    if (!raw) out(`${selftestJoined()}\n`);
    return 0;
  }

  let findings: Finding[] = [];
  let wordsTotal = 0;
  if (paths.length) {
    for (const path of paths) {
      const [f, w] = lintFn(readText(path), path);
      findings.push(...f);
      wordsTotal += w;
    }
  } else {
    [findings, wordsTotal] = lintFn(readStdin());
  }

  findings = findings.filter((f) => !disabled.has(f.rule));
  const hardCount = findings.filter((f) => f.level === "advisory-free").length;
  out(report(findings, wordsTotal, asJson, hardCount, baseline));
  return hardCount > baseline ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `ste-lint: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
