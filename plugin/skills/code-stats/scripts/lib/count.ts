/**
 * The line counter: every line of a text file is blank, comment or code.
 * Built in rather than delegated to a counting tool, so the skill runs with
 * nothing installed beyond Bun.
 */
import type { CommentStyle } from "./languages.ts";

export interface LineCounts {
  raw: number;
  blank: number;
  comment: number;
  code: number;
}

/**
 * A comment syntax as the scanner reads it. Every lexical feature that
 * decides whether a comment marker opens a comment is a field here, so each
 * language is one row of the table below rather than a branch of the
 * scanner. `quotes` close on the same line; `multiline` strings run until
 * their delimiter, across lines; a backslash escapes in both unless
 * `backslash` is false (SQL keeps a quote by doubling it, which reads as the
 * string closing and reopening), and does in any string opened right after
 * one of the `escapePrefixes` that is not the end of a longer name (SQL's
 * `E'…'`); with `continues`, a multiline string opened with only whitespace
 * and line comments since the last one closed continues it and keeps its escape mode (SQL's
 * doubled quote, and a fragment continued on the next line); `nested`
 * block comments count their depth; `regex` reads a regular-expression
 * literal where an expression may start. Markup takes no strings: its prose
 * holds apostrophes.
 */
interface Syntax {
  line?: string;
  block?: [string, string];
  nested?: boolean;
  regex?: boolean;
  quotes: string[];
  multiline: string[];
  backslash?: boolean;
  escapePrefixes?: string[];
  continues?: boolean;
}

const C: Syntax = {
  line: "//",
  block: ["/*", "*/"],
  quotes: ['"', "'"],
  multiline: ['"""', "`"],
};

const SYNTAX: Partial<Record<CommentStyle, Syntax>> = {
  c: C,
  js: { ...C, regex: true },
  nested: { ...C, nested: true },
  hash: { line: "#", quotes: ['"', "'"], multiline: [] },
  python: { line: "#", quotes: ['"', "'"], multiline: ['"""', "'''"] },
  sql: {
    line: "--",
    block: ["/*", "*/"],
    quotes: [],
    multiline: ["'", '"'],
    backslash: false,
    escapePrefixes: ["E", "e"],
    continues: true,
  },
  html: { block: ["<!--", "-->"], quotes: [], multiline: [] },
};

/**
 * What is open at the end of a line: block comments (their depth) or a
 * multiline string, with whether a backslash escapes inside it; and the
 * multiline string a new one would continue, when only whitespace and
 * line comments have followed its close.
 */
interface ScanState {
  depth: number;
  string: string | null;
  backslash: boolean;
  closed: { string: string; backslash: boolean } | null;
}

/** Whether a backslash escapes in the string whose opening delimiter is at `i`. */
function escapes(line: string, i: number, s: Syntax): boolean {
  const prefix = line[i - 1];
  if (prefix !== undefined && s.escapePrefixes?.includes(prefix))
    return !/[\w$]/.test(line[i - 2] ?? "");
  return s.backslash ?? true;
}

/** The index just past `close` from `i`, skipping backslash escapes unless `backslash` is false; -1 when absent. */
export function closeAt(
  text: string,
  i: number,
  close: string,
  backslash = true,
): number {
  for (let j = i; j < text.length; j++) {
    if (backslash && text[j] === "\\") j++;
    else if (text.startsWith(close, j)) return j + close.length;
  }
  return -1;
}

/** Where the block comment or multiline string open in `state` closes: the index after it, or -1. */
function closeOpen(
  line: string,
  i: number,
  s: Syntax,
  state: ScanState,
): number {
  if (state.depth > 0) {
    const [open, close] = s.block as [string, string];
    for (let j = i; j < line.length; ) {
      if (line.startsWith(close, j)) {
        j += close.length;
        if (--state.depth === 0) return j;
      } else if (s.nested && line.startsWith(open, j)) {
        j += open.length;
        state.depth++;
      } else j++;
    }
    return -1;
  }
  const end = closeAt(line, i, state.string as string, state.backslash);
  if (end !== -1) {
    state.closed = {
      string: state.string as string,
      backslash: state.backslash,
    };
    state.string = null;
  }
  return end;
}

/** What may stand before an expression: a `/` after one of these starts a regular expression. */
const BEFORE_EXPRESSION =
  /(?:^|[(,=:[!&|?{};+\-*%>~^]|\b(?:return|typeof|case|do|else|in|of|yield|await|void|delete|throw|new))$/;

/** Whether the `/` at `i` starts a regular-expression literal rather than a division. */
function regexStarts(line: string, i: number): boolean {
  return BEFORE_EXPRESSION.test(line.slice(0, i).trimEnd());
}

/** The index just past a regular-expression literal's closing `/`, from `i`; -1 when absent. */
function regexEnd(line: string, i: number): number {
  let inClass = false;
  for (let j = i; j < line.length; j++) {
    const ch = line[j];
    if (ch === "\\") j++;
    else if (inClass) inClass = ch !== "]";
    else if (ch === "[") inClass = true;
    else if (ch === "/") return j + 1;
  }
  return -1;
}

/**
 * The token at `i`: the index after it and whether it is code, opening a
 * block comment or a multiline string in `state`; null for a line comment.
 */
function token(
  line: string,
  i: number,
  s: Syntax,
  state: ScanState,
): { next: number; code: boolean } | null {
  if (s.line && line.startsWith(s.line, i)) return null;
  if (s.block && line.startsWith(s.block[0], i)) {
    state.depth = 1;
    return { next: i + s.block[0].length, code: false };
  }
  if (s.regex && line[i] === "/" && regexStarts(line, i)) {
    const end = regexEnd(line, i + 1);
    return { next: end === -1 ? line.length : end, code: true };
  }
  const multi = s.multiline.find((d) => line.startsWith(d, i));
  if (multi) {
    const closed = state.closed;
    state.string = multi;
    state.backslash =
      s.continues && closed?.string === multi
        ? closed.backslash
        : escapes(line, i, s);
    return { next: i + multi.length, code: true };
  }
  const quote = s.quotes.find((q) => line.startsWith(q, i));
  if (!quote) return { next: i + 1, code: true };
  const end = closeAt(line, i + 1, quote, escapes(line, i, s));
  return { next: end === -1 ? line.length : end, code: true };
}

/**
 * Read the token at `i` into `seen`: the index after it, or -1 when the rest
 * of the line is one comment or string still open.
 */
function step(
  line: string,
  i: number,
  s: Syntax,
  state: ScanState,
  seen: { code: boolean; comment: boolean },
): number {
  if (state.depth > 0 || state.string !== null) {
    if (state.depth > 0) seen.comment = true;
    else seen.code = true;
    return closeOpen(line, i, s, state);
  }
  if (/\s/.test(line[i] as string)) return i + 1;
  const t = token(line, i, s, state);
  if (t === null) {
    seen.comment = true;
    return -1;
  }
  state.closed = null;
  seen.code ||= t.code;
  return t.next;
}

/**
 * Whether a trimmed, non-blank line holds only comments, reading it token by
 * token so a comment opened after code, or comment markers inside a string,
 * are seen for what they are. `state` carries across lines.
 */
function onlyComment(line: string, s: Syntax, state: ScanState): boolean {
  const seen = { code: false, comment: false };
  for (let i = 0; i !== -1 && i < line.length; )
    i = step(line, i, s, state, seen);
  return (seen.comment || state.depth > 0) && !seen.code;
}

/** Count `content`'s lines, stripping comments of `style`. */
export function countLines(content: string, style: CommentStyle): LineCounts {
  const lines = content.split("\n");
  // A file that ends with a newline has no line after it.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const syntax = SYNTAX[style];
  let blank = 0;
  let comment = 0;
  const state: ScanState = {
    depth: 0,
    string: null,
    backslash: true,
    closed: null,
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") blank++;
    else if (syntax !== undefined && onlyComment(line, syntax, state))
      comment++;
  }

  const total = lines.length;
  return { raw: total, blank, comment, code: total - blank - comment };
}
