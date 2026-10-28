import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The frontmatter reader every M4 script shares. It reads an explicit subset of
// YAML and rejects anything outside it with a message, rather than guessing:
// a gate that misreads a value passes or fails the wrong document. The subset
// is listed in the frontmatter-check README and the WIKI-SCHEMA template.

/** A field's value: one scalar, a list of scalars, or null (empty, `null`, `~`). */
export type FieldValue = string | string[] | null;

export interface Frontmatter {
  /** The document opens with a `---` line. */
  present: boolean;
  /** 0-based index of the closing `---` line, or -1 when it never closes. */
  end: number;
  fields: Map<string, FieldValue>;
  /**
   * Keys written with nothing after the colon. They read as null like `~`,
   * but a field where `~` is a value can tell the two apart here.
   */
  blank: Set<string>;
  /** Constructs outside the subset, each with its 1-based line number. */
  errors: string[];
}

const DELIMITER = /^---[ \t]*$/;
/**
 * YAML's whitespace is space and tab only. JavaScript's `\s` and `trim()` also
 * take U+00A0 and other characters YAML keeps as content, so the reader never
 * uses them.
 */
const isWhite = (ch: string | undefined) => ch === " " || ch === "\t";
const trimStart = (text: string) => text.replace(/^[ \t]+/, "");
const trimEnd = (text: string) => text.replace(/[ \t]+$/, "");
const trim = (text: string) => trimEnd(trimStart(text));
/**
 * The first character YAML does not allow anywhere in a stream: a control
 * character other than tab, line feed and carriage return, DEL, a C1 control
 * other than NEL, U+FFFE/U+FFFF, or an unpaired surrogate.
 */
function nonPrintable(line: string): number | undefined {
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f && code !== 0x85) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0xfffe ||
      code === 0xffff
    )
      return code;
  }
  return undefined;
}
const NULLS = new Set(["null", "Null", "NULL", "~"]);
/** `|` or `>`, an optional indentation digit (1-9), an optional chomping sign. */
const BLOCK_HEADER = /^[|>][1-9]?[-+]?$/;
const KEY_LINE = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t](.*))?$/;

const QUOTES = `"'`;
/** In a flow list, a scalar starts after these. */
const FLOW_OPENERS = "[,";

/**
 * Visit every character outside quotes; `visit` returns true to stop there. A
 * quote opens a scalar only where a scalar starts: at the start of the text
 * or, in a flow list, after `[` or `,` (whitespace aside). So an apostrophe
 * inside a plain value is ordinary text. Inside double quotes a backslash
 * escapes the next character; inside single quotes `''` is a quote. Returns
 * false when a quote is left open.
 */
function scan(
  text: string,
  flow: boolean,
  visit: (index: number, ch: string) => boolean,
): boolean {
  let quote = "";
  let atStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote) [i, quote] = inQuote(text, i, quote);
    else if (atStart && QUOTES.includes(ch)) quote = ch;
    else if (visit(i, ch)) return true;
    else if (!isWhite(ch)) atStart = flow && FLOW_OPENERS.includes(ch);
  }
  return !quote;
}

/**
 * One step inside a quote: the index the step ends at (past an escape) and
 * the quote still open, "" once it closes.
 */
function inQuote(text: string, i: number, quote: string): [number, string] {
  const ch = text[i];
  if (quote === '"' && ch === "\\") return [i + 1, quote];
  if (quote === "'" && ch === "'" && text[i + 1] === "'") return [i + 1, quote];
  return [i, ch === quote ? "" : quote];
}

/**
 * Cut an unquoted trailing comment. A `#` opens a comment only outside quotes
 * and at the start of the text or after whitespace, so `"a # b"` and `a#b`
 * keep their `#`, and `the team's guide # note` loses its comment.
 */
export function decomment(text: string): string {
  let cut = -1;
  const flow = trimStart(text).startsWith("[");
  scan(text, flow, (i, ch) => {
    if (ch !== "#" || (i > 0 && !isWhite(text[i - 1]))) return false;
    cut = i;
    return true;
  });
  return trimEnd(cut < 0 ? text : text.slice(0, cut));
}

/** The index of the quote closing a scalar opened at 0, or -1. */
function closingQuote(text: string): number {
  const quote = text[0];
  for (let i = 1; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") i++;
    else if (text[i] === quote) {
      if (quote === "'" && text[i + 1] === "'") i++;
      else return i;
    }
  }
  return -1;
}

/** The first characters that open a construct the subset does not read. */
const UNSUPPORTED_START: Record<string, string> = {
  "&": "anchors and aliases are not supported",
  "*": "anchors and aliases are not supported",
  "!": "explicit tags are not supported",
  "{": "flow mappings {…} are not supported",
  "[": "a nested list is not supported here",
  "?": "explicit keys (? key) are not supported",
  "|": "a block scalar is supported only as a key's own value",
  ">": "a block scalar is supported only as a key's own value",
  "@": "'@' is reserved and cannot start a plain value (quote it)",
  "`": "'`' is reserved and cannot start a plain value (quote it)",
  "%": "'%' cannot start a plain value (quote it)",
  "]": "']' cannot start a plain value (quote it)",
  "}": "'}' cannot start a plain value (quote it)",
  ",": "',' cannot start a plain value (quote it)",
};

type Scalar = { value: string | null } | string;

/**
 * The escapes a double-quoted YAML scalar may hold: one character from the
 * spec's set, or `x`, `u`, `U` with two, four or eight hexadecimal digits.
 */
const ESCAPE =
  /\\(?:[0abt\tnvfre "/\\N_LP]|x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8})/y;

/** The first backslash in a double-quoted body that starts no valid escape, or -1. */
function badEscape(body: string): number {
  for (let i = body.indexOf("\\"); i >= 0; i = body.indexOf("\\", i)) {
    ESCAPE.lastIndex = i;
    if (!ESCAPE.test(body)) return i;
    i = ESCAPE.lastIndex;
  }
  return -1;
}

/**
 * A quoted scalar: the matching quotes come off and the content is never
 * decoded, but a double-quoted one must hold only escapes YAML defines.
 */
function readQuoted(text: string): Scalar {
  const close = closingQuote(text);
  if (close < 0) return `unterminated quoted value: ${text}`;
  if (close !== text.length - 1) return `text after the closing quote: ${text}`;
  const body = text.slice(1, -1);
  const bad = text[0] === '"' ? badEscape(body) : -1;
  if (bad >= 0)
    return `'${body.slice(bad, bad + 2)}' is not a YAML escape: ${text}`;
  return { value: body };
}

/**
 * Read one scalar: comment cut first, then a matching pair of quotes stripped
 * (never decoded). Returns the value, or an error message for text the subset
 * does not read. A quote opens a scalar only as its first character, so an
 * apostrophe inside a plain value is ordinary text.
 */
export function readScalar(raw: string): Scalar {
  const text = trim(decomment(raw));
  if (!text) return { value: null };
  const first = text[0] ?? "";
  if (first === '"' || first === "'") return readQuoted(text);
  const unsupported = UNSUPPORTED_START[first];
  if (unsupported) return `${unsupported}: ${text}`;
  if (/^-([ \t]|$)/.test(text))
    return `'- ' cannot start a plain value (quote it, or put list members on their own lines): ${text}`;
  if (/:([ \t]|$)/.test(text))
    return `a plain value cannot contain ': ' (quote it): ${text}`;
  return { value: NULLS.has(text) ? null : text };
}

/** Split on commas outside quotes; an unclosed quote returns undefined. */
function splitOutsideQuotes(inner: string): string[] | undefined {
  const cuts: number[] = [];
  const closed = scan(inner, true, (i, ch) => {
    if (ch === ",") cuts.push(i);
    return false;
  });
  if (!closed) return undefined;
  return [-1, ...cuts].map((cut, n) =>
    inner.slice(cut + 1, cuts[n] ?? inner.length),
  );
}

/** One inline-list member, or why it cannot be read. */
function readMember(part: string, list: string): { value: string } | string {
  const member = readScalar(part);
  if (typeof member === "string") return member;
  if (member.value === null) return `empty list member in ${list}`;
  if (!/^[ \t]*["']/.test(part) && /[[\]{}]/.test(member.value))
    return `a plain list member cannot contain [ ] { } (quote it): ${list}`;
  return { value: member.value };
}

/** The members of an inline `[a, b]` list, split on commas outside quotes. */
function readInlineList(text: string): string[] | string {
  const inner = text.slice(1, -1);
  if (!trim(inner)) return [];
  const parts = splitOutsideQuotes(inner);
  if (!parts) return `unterminated quoted value in list: ${text}`;
  // A trailing comma adds no member in YAML; an empty slot anywhere else is
  // not valid YAML.
  if (parts.length > 1 && !trim(parts.at(-1) ?? "")) parts.pop();
  const members: string[] = [];
  for (const part of parts) {
    const member = readMember(part, text);
    if (typeof member === "string") return member;
    members.push(member.value);
  }
  return members;
}

type Pending =
  | { kind: "none" }
  | { kind: "open"; key: string }
  | { kind: "list"; key: string; indent: number; items: string[] }
  | {
      kind: "block";
      key: string;
      /** Content indentation: the header's digit, else the first content line's. */
      indent: number | undefined;
      folded: boolean;
      chomp: "clip" | "strip" | "keep";
      lines: string[];
    };

interface State {
  fields: Map<string, FieldValue>;
  blank: Set<string>;
  errors: string[];
  pending: Pending;
}

/** A line indented past the block's own indentation, kept as written when folding. */
const moreIndented = (line: string) => isWhite(line[0]);

/**
 * What a line break between two block-scalar lines folds into: a space
 * between two ordinary lines, nothing before an empty line (each empty line
 * is a break of its own), and a kept break around a more-indented line.
 * `next` is the first non-empty line from `line` on.
 */
function foldedBreak(prev: string, line: string, next: string): string {
  if (prev === "" || moreIndented(prev)) return "\n";
  if (line === "") return moreIndented(next) ? "\n" : "";
  return moreIndented(line) ? "\n" : " ";
}

/** Fold block-scalar lines as YAML's `>` does. */
function fold(lines: string[]): string {
  // The first non-empty line from each index on, found in one backward pass.
  const next: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    next[i] = line !== "" ? line : (next[i + 1] ?? "");
  }
  let out = lines[0] ?? "";
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    out += foldedBreak(lines[i - 1] ?? "", line, next[i] ?? "") + line;
  }
  return out;
}

/**
 * A block scalar's value as YAML gives it: indentation, folding and chomping
 * applied. Only the block's own indentation is removed, so a whitespace-only
 * line keeps the spaces past it as content.
 */
function blockValue(p: Extract<Pending, { kind: "block" }>): string | null {
  const indent = p.indent;
  if (indent === undefined) return null;
  const lines = p.lines.map((line) => line.slice(indent));
  let trailing = 0;
  while (lines.length && lines.at(-1) === "") {
    lines.pop();
    trailing++;
  }
  if (!lines.length) return null;
  const text = p.folded ? fold(lines) : lines.join("\n");
  if (p.chomp === "strip") return text;
  return `${text}\n${p.chomp === "keep" ? "\n".repeat(trailing) : ""}`;
}

function finish(state: State): void {
  const p = state.pending;
  if (p.kind === "open") {
    state.fields.set(p.key, null);
    state.blank.add(p.key);
  }
  if (p.kind === "list") state.fields.set(p.key, p.items);
  if (p.kind === "block") state.fields.set(p.key, blockValue(p));
  state.pending = { kind: "none" };
}

/** Set a field from a value or an error message; an unreadable value is absent. */
function settle(state: State, key: string, value: Scalar, at: string): void {
  if (typeof value === "string") state.errors.push(`${at}: ${value}`);
  state.fields.set(key, typeof value === "string" ? null : value.value);
}

function startBlock(state: State, key: string, header: string, at: string) {
  if (!BLOCK_HEADER.test(header)) {
    settle(state, key, `unsupported block scalar header '${header}'`, at);
    return;
  }
  const digit = /[1-9]/.exec(header)?.[0];
  state.pending = {
    kind: "block",
    key,
    indent: digit ? Number(digit) : undefined,
    folded: header[0] === ">",
    chomp: header.includes("-")
      ? "strip"
      : header.includes("+")
        ? "keep"
        : "clip",
    lines: [],
  };
}

function keyLineError(line: string): string {
  if (/^-([ \t]|$)/.test(line))
    return "list members must be indented under their key";
  if (line.startsWith("?")) return "explicit keys (? key) are not supported";
  if (/^["']/.test(line)) return "quoted keys are not supported";
  return "not a `key: value` line";
}

/** Read the value after `key:` on the key's own line. */
function readValue(state: State, key: string, rest: string, at: string): void {
  if (!rest) state.pending = { kind: "open", key };
  else if (rest[0] === "|" || rest[0] === ">") startBlock(state, key, rest, at);
  else if (rest[0] !== "[") settle(state, key, readScalar(rest), at);
  else if (!rest.endsWith("]"))
    settle(state, key, `unterminated inline list: ${rest}`, at);
  else {
    const list = readInlineList(rest);
    if (typeof list === "string") settle(state, key, list, at);
    else state.fields.set(key, list);
  }
}

function readKeyLine(state: State, line: string, at: string): void {
  const match = KEY_LINE.exec(line);
  const key = match?.[1];
  if (!key) state.errors.push(`${at}: ${keyLineError(line)}`);
  else if (state.fields.has(key))
    state.errors.push(`${at}: duplicate key '${key}'`);
  else readValue(state, key, trim(decomment(match[2] ?? "")), at);
}

function readListItem(state: State, line: string, at: string): void {
  const p = state.pending;
  if (p.kind !== "open" && p.kind !== "list") return;
  const indent = line.length - trimStart(line).length;
  if (p.kind === "list" && indent !== p.indent) {
    state.errors.push(`${at}: list members of '${p.key}' are not aligned`);
    return;
  }
  const items = p.kind === "list" ? p.items : [];
  state.pending = { kind: "list", key: p.key, indent, items };
  const member = readScalar(trim(line).slice(1));
  if (typeof member === "string") state.errors.push(`${at}: ${member}`);
  else if (member.value === null)
    state.errors.push(`${at}: empty list member of '${p.key}'`);
  else items.push(member.value);
}

function readIndentedLine(state: State, line: string, at: string): void {
  const p = state.pending;
  const isItem = /^[ \t]+-([ \t]|$)/.test(line);
  if (isItem && (p.kind === "open" || p.kind === "list"))
    readListItem(state, line, at);
  else if (p.kind === "open")
    state.errors.push(
      `${at}: nested mappings under '${p.key}' are not supported`,
    );
  else
    state.errors.push(
      `${at}: a plain value cannot continue on the next line (quote it or use a block scalar)`,
    );
}

/**
 * Feed a line to an open block scalar; false once the line ends the block,
 * which is then finished. Indentation is spaces only, so a tab after it is
 * content. A comment indented less than the content ends the block (YAML's
 * trailing comments); one at the content's indentation is content.
 */
function readBlockLine(state: State, line: string, at: string): boolean {
  const p = state.pending;
  if (p.kind !== "block") return false;
  if (/^ *$/.test(line)) {
    p.lines.push(line);
    return true;
  }
  const indent = /^ */.exec(line)?.[0].length ?? 0;
  const rest = line.slice(indent);
  const comment = rest.startsWith("#");
  if (
    indent === 0 ||
    (comment && p.indent !== undefined && indent < p.indent)
  ) {
    finish(state);
    return false;
  }
  if (p.indent === undefined) {
    p.indent = indent;
    // A leading empty line may not hold more spaces than the content's indentation.
    if (p.lines.some((l) => l.length > indent))
      state.errors.push(
        `${at}: block scalar '${p.key}' has a leading line indented past its content`,
      );
  }
  if (indent >= p.indent) p.lines.push(line);
  else if (rest.startsWith("\t"))
    state.errors.push(`${at}: tab in indentation`);
  else state.errors.push(`${at}: block scalar '${p.key}' is under-indented`);
  return true;
}

function readLine(state: State, line: string, at: string): void {
  // Checked once here, for every form a line can take: a value, a comment, a
  // block scalar's content.
  const bad = nonPrintable(line);
  if (bad !== undefined) {
    const code = bad.toString(16).toUpperCase().padStart(4, "0");
    state.errors.push(`${at}: U+${code} is not allowed in YAML`);
    return;
  }
  if (readBlockLine(state, line, at)) return;
  if (/^ *\t/.test(line) && trim(line)) {
    state.errors.push(`${at}: tab in indentation`);
    return;
  }
  if (!trim(line) || /^[ \t]*#/.test(line)) return;
  if (isWhite(line[0])) {
    readIndentedLine(state, line, at);
    return;
  }
  finish(state);
  readKeyLine(state, line, at);
}

/**
 * A document's lines, split at YAML's line breaks: CR LF, LF, or a CR on its
 * own. `Frontmatter.end` indexes this array.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * The same lines, each keeping its own line break, so the pieces join back to
 * the text and line `i` here is line `i` of `splitLines`.
 */
export function linesWithBreaks(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

/**
 * The first line of the navigation index `generate-index.ts` writes. The index
 * is derived, not authored, so it carries no frontmatter, and the frontmatter
 * checker leaves it out: the file at the index's configured path that opens
 * with this line. The marker alone exempts nothing, since any author can write
 * it; the path is the one `generate-index.ts --check` holds to the generated
 * content.
 */
export const GENERATED_INDEX =
  "<!-- AUTO-GENERATED by generate-index.ts — do not edit by hand. -->";

/** The document opens with the generated navigation index's marker. */
export const isGeneratedIndex = (text: string) =>
  splitLines(text)[0] === GENERATED_INDEX;

/** Where the navigation index is written: `$OUT`, else `INDEX.md` in `$DOCS_DIR` (default `docs`). */
export const generatedIndexPath = (env: Record<string, string | undefined>) =>
  env.OUT || join(env.DOCS_DIR || "docs", "INDEX.md");

/**
 * Read the leading frontmatter block: the document's first line is `---` and
 * the block ends at the next `---` line. Fields come back with errors for
 * every construct outside the subset; a document without a block has none.
 */
export function readFrontmatter(text: string): Frontmatter {
  const lines = splitLines(text);
  const result: Frontmatter = {
    present: DELIMITER.test(lines[0] ?? ""),
    end: -1,
    fields: new Map(),
    blank: new Set(),
    errors: [],
  };
  if (!result.present) return result;
  const state: State = {
    fields: result.fields,
    blank: result.blank,
    errors: result.errors,
    pending: { kind: "none" },
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (DELIMITER.test(line)) {
      result.end = i;
      break;
    }
    readLine(state, line, `line ${i + 1}`);
  }
  finish(state);
  return result;
}

/**
 * A document's fields for a command that reads them to act on: none for a
 * document without frontmatter, and an error, never a partial reading, for
 * frontmatter that is present but unreadable (a construct outside the subset,
 * or a block that never closes). `label` names the document in that error.
 */
export function documentFields(
  text: string,
  label: string,
): Map<string, FieldValue> {
  const frontmatter = readFrontmatter(text);
  const problems =
    frontmatter.present && frontmatter.end < 0
      ? ["the frontmatter never closes", ...frontmatter.errors]
      : frontmatter.errors;
  if (problems.length)
    throw new Error(
      `${label}: unreadable frontmatter (${problems.join("; ")})`,
    );
  return frontmatter.fields;
}

/** A field's value as text: a scalar as is, a list joined, absent or null as "". */
export function frontmatterValue(
  text: string,
  key: string,
  label = "the document",
): string {
  const value = documentFields(text, label).get(key);
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

/** A real calendar date written `YYYY-MM-DD`: the shape alone admits 2026-02-30. */
export function isDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  // setUTCFullYear keeps years 0-99 as written; Date.UTC maps them to 19xx.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** True when a value counts as present for a required field. */
export function hasValue(value: FieldValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  return Array.isArray(value) || value.trim() !== "";
}

export function markdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) result.push(path);
  }
  return result;
}
export function readDocument(file: string): string {
  if (!existsSync(file) || !statSync(file).isFile())
    throw new Error(`not a file: ${file}`);
  return readFileSync(file, "utf8");
}
/** Command-line boundary: an exception, thrown or rejected, exits 2. */
export function cli(action: () => number | Promise<number>): void {
  Promise.resolve()
    .then(action)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 2;
    });
}
