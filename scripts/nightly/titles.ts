// Whether a test bun names still exists in the source: the check that keeps
// the nightly baseline (baseline.ts) from naming tests that are gone. A
// test's full name is its `describe` titles and its own, joined by ` > `;
// each title must be a string literal in the test file or in a file it
// imports, directly or not, by a relative path, since shared suites declare
// tests for the files that import them. A title written with placeholders
// (a template literal's `${…}`, `test.each`'s `%s`, `%p` and the rest, or
// `$name` for a row's field) matches any text in their place. A title that
// is computed some other way, by concatenation say, cannot be found, so its
// entry is reported: the remedy is to name the test with a literal.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { UNNAMED } from "./baseline.ts";

/** The string literals of a source, with their placeholders as wildcards. */
export interface Literals {
  plain: Set<string>;
  patterns: RegExp[];
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

const QUOTES = new Set(["'", '"', "`"]);

/** Where the `${…}` that opens at `at` ends, past any literal inside it. */
function skipInterpolation(source: string, at: number): number {
  let depth = 1;
  let i = at + 2;
  while (i < source.length && depth > 0) {
    const c = source[i] ?? "";
    if (QUOTES.has(c)) {
      i = readLiteral(source, i).end;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") depth--;
    i++;
  }
  return i;
}

/** One step through a literal: a character of its text, a `${…}` it splits at, or a line end that cuts it off. */
type Piece = { text: string; next: number } | { split: number } | { cut: true };

function piece(source: string, i: number, template: boolean): Piece {
  const c = source[i] ?? "";
  if (c === "\n" && !template) return { cut: true };
  if (template && source.startsWith("${", i))
    return { split: skipInterpolation(source, i) };
  if (c !== "\\") return { text: c, next: i + 1 };
  return readEscape(source, i);
}

const HEX = /^[0-9a-fA-F]+$/;

/** The escape sequence at `i`, a backslash: its character, and where it ends. */
function readEscape(source: string, i: number): { text: string; next: number } {
  const next = source[i + 1] ?? "";
  const fixed = (length: number) => {
    const digits = source.slice(i + 2, i + 2 + length);
    return digits.length === length && HEX.test(digits)
      ? {
          text: String.fromCharCode(parseInt(digits, 16)),
          next: i + 2 + length,
        }
      : undefined;
  };
  if (next === "x") return fixed(2) ?? { text: next, next: i + 2 };
  if (next === "u") {
    if (source[i + 2] === "{") {
      const close = source.indexOf("}", i + 3);
      const digits = close < 0 ? "" : source.slice(i + 3, close);
      const point = HEX.test(digits) ? parseInt(digits, 16) : Infinity;
      if (point <= 0x10ffff)
        return { text: String.fromCodePoint(point), next: close + 1 };
    }
    return fixed(4) ?? { text: next, next: i + 2 };
  }
  if (next === "\r" && source[i + 2] === "\n") return { text: "", next: i + 3 };
  return { text: ESCAPES[next] ?? (next === "\n" ? "" : next), next: i + 2 };
}

/**
 * The literal whose opening quote is at `at`: its text split around each
 * `${…}`, unescaped, and where it ends. A quoted literal a line end cuts off
 * has no parts.
 */
function readLiteral(
  source: string,
  at: number,
): { parts: string[]; end: number } {
  const quote = source[at];
  const parts: string[] = [];
  let text = "";
  let i = at + 1;
  while (i < source.length && source[i] !== quote) {
    const step = piece(source, i, quote === "`");
    if ("cut" in step) return { parts: [], end: i };
    if ("split" in step) {
      parts.push(text);
      text = "";
      i = step.split;
    } else {
      text += step.text;
      i = step.next;
    }
  }
  return i < source.length
    ? { parts: [...parts, text], end: i + 1 }
    : { parts: [], end: i };
}

const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `test.each`'s placeholders: printf-style, `%#` the row's index, `$field` a row's value. */
const EACH_PLACEHOLDER = /%[spdifjo#]|\$[A-Za-z_][\w.]*/;

/** The fewest characters outside placeholders a literal needs to count as a title. */
const MIN_FIXED_TEXT = 8;

/** Where the comment at `at` ends, or undefined when none starts there. */
function commentEnd(source: string, at: number): number | undefined {
  const [open, close] = source.startsWith("//", at)
    ? ["//", "\n"]
    : source.startsWith("/*", at)
      ? ["/*", "*/"]
      : [];
  if (!open || !close) return undefined;
  const end = source.indexOf(close, at + open.length);
  if (end < 0) return source.length;
  return close === "*/" ? end + close.length : end;
}

/** Record one literal's parts as a plain title, or as a pattern when it has placeholders. */
function record(parts: string[], into: Literals): void {
  if (!parts.length) return;
  const whole = parts.join("");
  if (parts.length === 1 && !EACH_PLACEHOLDER.test(whole)) {
    into.plain.add(whole);
    return;
  }
  const fixed = parts.map((part) => part.split(EACH_PLACEHOLDER));
  // A literal that is mostly placeholders would match any title.
  if (fixed.flat().join("").trim().length < MIN_FIXED_TEXT) return;
  const pattern = fixed
    .map((pieces) => pieces.map(escapeRegex).join("[^]*"))
    .join("[^]*");
  into.patterns.push(new RegExp(`^${pattern}$`));
}

/** The literals of a source, skipping comments. */
export function literals(
  source: string,
  into: Literals = { plain: new Set(), patterns: [] },
): Literals {
  let i = 0;
  while (i < source.length) {
    const past = commentEnd(source, i);
    if (past !== undefined) i = past;
    else if (QUOTES.has(source[i] ?? "")) {
      const { parts, end } = readLiteral(source, i);
      record(parts, into);
      i = end;
    } else i++;
  }
  return into;
}

const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\1/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts"];

/** `source` with each comment replaced by a space: a commented-out import imports nothing. */
function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const past = commentEnd(source, i);
    if (past !== undefined) {
      out += " ";
      i = past;
    } else if (QUOTES.has(source[i] ?? "")) {
      const { end } = readLiteral(source, i);
      out += source.slice(i, end);
      i = end;
    } else out += source[i++];
  }
  return out;
}

/** The relative imports of `file` that resolve to a file under `root`. */
function imports(root: string, file: string, source: string): string[] {
  const found: string[] = [];
  for (const match of withoutComments(source).matchAll(IMPORT)) {
    const base = resolve(dirname(file), match[2] ?? "");
    const path = EXTENSIONS.map((ext) => base + ext).find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    );
    const inside = path && !relative(root, path).startsWith("..");
    if (path && inside && !path.split(sep).includes("node_modules"))
      found.push(path);
  }
  return found;
}

/** Finds test titles in a test file and what it imports; reads each file once. */
export class TitleIndex {
  private readonly perFile = new Map<
    string,
    { literals: Literals; imports: string[] }
  >();
  private readonly perTest = new Map<string, Literals>();
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  private read(path: string) {
    let known = this.perFile.get(path);
    if (!known) {
      const source = readFileSync(path, "utf8");
      known = {
        literals: literals(source),
        imports: imports(this.root, path, source),
      };
      this.perFile.set(path, known);
    }
    return known;
  }

  /** The literals of the test file and every file it reaches by a relative import. */
  private closure(file: string): Literals {
    let all = this.perTest.get(file);
    if (all) return all;
    all = { plain: new Set(), patterns: [] };
    const queue = [resolve(join(this.root, file))];
    const seen = new Set(queue);
    for (let path = queue.shift(); path; path = queue.shift()) {
      const { literals: found, imports: next } = this.read(path);
      for (const text of found.plain) all.plain.add(text);
      all.patterns.push(...found.patterns);
      for (const imported of next)
        if (!seen.has(imported)) {
          seen.add(imported);
          queue.push(imported);
        }
    }
    this.perTest.set(file, all);
    return all;
  }

  /**
   * Whether every title of `name` is found. A title may itself hold ` > `,
   * so the name's parts are matched as runs of one or more parts each.
   */
  has(file: string, name: string): boolean {
    const found = this.closure(file);
    const matches = (title: string) =>
      found.plain.has(title) ||
      found.patterns.some((pattern) => pattern.test(title));
    const parts = name.split(" > ");
    if (parts.at(-1) === UNNAMED) parts.pop();
    const reachable = [true];
    for (let end = 1; end <= parts.length; end++)
      reachable[end] = Array.from({ length: end }, (_, start) => start).some(
        (start) =>
          reachable[start] && matches(parts.slice(start, end).join(" > ")),
      );
    return reachable[parts.length] === true;
  }
}
