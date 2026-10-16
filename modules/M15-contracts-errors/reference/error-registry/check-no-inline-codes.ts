#!/usr/bin/env bun
// No error code is constructed outside the registry.
//
// The rule it holds. Every code a system can emit is declared once, in one
// registry, with its metadata; the registry is the only place the code's
// constructor runs. A code minted inline at a throw site is on no generated
// copy (not in the client's union, not in any message catalog, not in the
// public reference), so the first the outside learns of it is the response
// that carries it.
//
// What it does. Scans the given paths for `new <Constructor>(` outside
// comments and literals (strings, template text, regular expressions; the
// code inside a template's `${...}` is scanned), leaves the registry path(s)
// out, and reports each construction with the file and line. After each
// `new` it reads the callee as a member chain: whitespace and comments
// between tokens, parentheses, `.name` and `['name']` members, non-null
// assertions and type arguments (balanced, so `<() => (Meta)>` is one group;
// a literal inside a group is one token, so a `)` in a regular expression
// closes nothing), in any order. The chain's last name is what is
// constructed (`(errors).ErrorCode`, `errors!['ErrorCode']`); where the
// chain does not settle a name (an expression in parentheses, a computed
// member), any mention of the constructor's name there counts, and so does
// literal text that could spell it where a name is read from it: a computed
// key, an array or object literal, a call's arguments. A `+` chain of plain
// literals and unknowns is matched exactly (`'Error' + 'Code'` and
// `prefix + 'Code'` count, `'Other' + 'Thing'` does not); a literal that is
// transformed or escaped counts, since this reader evaluates nothing more,
// and a template's text from the first `${...}` that holds a literal or a
// `/` on is unknown, since where that hole closes is not read. A comment is
// one token everywhere in the callee. A literal elsewhere is an operand
// (`kind === 'date' ? Date : RegExp`) and does not count. Names end at identifier boundaries, so a
// constructor named `Code$` matches. Text shaped like a construction in
// what the lexer read as a comment or a literal is reported too, marked as
// such, since a misread `/` hides code there. A construction's identity is the
// literal it passes as the whole first argument (`SYS-001`); a computed,
// composed or missing argument has the identity `?`. Tests and type
// declarations are not scanned: a test may build a code of its own.
//
// The allowlist. Existing debt is listed by identity, one line per file:
// `<file>:<identity>,<identity>`, identities sorted, under a `#` comment
// giving the reason. It covers constructions in code only: one in text is
// always a finding, reworded away or rewritten as code, because whether it is
// text rests on the lexer's reading, and a misread line makes it code. An
// entry is checked for exact equality with the code constructions the file
// holds, so a construction fixed and another added leave the entry stale (a
// count would not move); a stale entry, and an entry without a reason, is a
// finding. The list is kept at zero where it can be.
//
// Exit codes: 0 no construction outside the registry beyond the allowlist,
// 1 findings, 2 could not check (a path, the allowlist or the registry
// missing or unreadable, a path that holds no source file to scan, a file
// the lexer cannot read, a malformed allowlist, a bad option).
//
// Usage:
//   check-no-inline-codes.ts --registry <path> [--registry <path>]...
//     [--constructor ErrorCode] [--allowlist <file>] [--root <dir>]
//     [--ext .ts,.tsx,.mts,.cts] <path>...
import { cli } from "../../../../lib/cli.ts";
import {
  type Finding,
  reasonedEntries,
  reportFindings,
} from "../../../../lib/findings.ts";
import { lex } from "./lexer.ts";
import {
  escapeRegExp,
  existing,
  InputError,
  listFiles,
  optionValue,
  readText,
  splitList,
} from "./shared.ts";

const RULE = "inline-error-code";
const LIST_RULE = "inline-error-code-allowlist";
const usage =
  "usage: check-no-inline-codes.ts --registry <path>... [--constructor <Name>] [--allowlist <file>] [--root <dir>] [--ext <list>] <path>...";

export interface Construction {
  /** 1-based line of the `new`. */
  line: number;
  /** The first argument when the whole of it is a plain string literal, else `?`. */
  fingerprint: string;
  /** Present when it sits in what the lexer read as a comment or a literal. */
  inText?: true;
}

/** A string literal that is the whole first argument, and its text. */
const FIRST_ARGUMENT = /\s*(["'`])([\w.-]+)\1\s*[,)]/y;

/** The identity of the first argument, which begins at `from` in `code`; `?` without one. */
function fingerprintAt(code: string, from: number | undefined): string {
  if (from === undefined) return "?";
  FIRST_ARGUMENT.lastIndex = from;
  return FIRST_ARGUMENT.exec(code)?.[2] ?? "?";
}

/**
 * An identifier boundary. `\b` is not one: `$` is a non-word character to
 * it, so `\b` finds no boundary between `Code$` and `(`, and finds one inside
 * `x$Code`.
 */
const NOT_ID_BEFORE = String.raw`(?<![\w$])`;
const NOT_ID_AFTER = String.raw`(?![\w$])`;

/** A character that starts or continues an identifier. */
const isIdChar = (ch: string | undefined): boolean =>
  ch !== undefined && (/[\w$]/.test(ch) || ch.charCodeAt(0) > 127);

/** Whether a comment opens at `i`. */
const opensComment = (s: string, i: number): boolean =>
  s.startsWith("/*", i) || s.startsWith("//", i);

/** The index after the spaces and comments that start at `i`. */
function skipGap(s: string, i: number): number {
  for (;;) {
    while (i < s.length && /\s/.test(s[i] ?? "")) i++;
    if (s.startsWith("/*", i)) {
      const end = s.indexOf("*/", i + 2);
      if (end < 0) return s.length;
      i = end + 2;
    } else if (s.startsWith("//", i)) {
      const end = s.indexOf("\n", i);
      i = end < 0 ? s.length : end;
    } else return i;
  }
}

/** The index after the identifier at `i`, or `i` when none starts there. */
function identifierEnd(s: string, i: number): number {
  let j = i;
  if (s[j] === "#") j++;
  if (/\d/.test(s[j] ?? "")) return i;
  while (isIdChar(s[j])) j++;
  return j === i || (j === i + 1 && s[i] === "#") ? i : j;
}

/** The index after the string literal opened at `i`, or -1 if it never closes. */
function stringEnd(s: string, i: number): number {
  const quote = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === quote) return j + 1;
  }
  return -1;
}

const CLOSER: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "<": ">",
};

const isQuote = (ch: string | undefined): boolean =>
  ch === '"' || ch === "'" || ch === "`";

/** Which indexes of a scanned text lie inside a literal, when the lexer read it. */
type LiteralMask = readonly boolean[] | undefined;

/** The index after the run of literal text in `lit` that holds `j`. */
function literalEnd(lit: readonly boolean[], j: number): number {
  let k = j;
  while (lit[k]) k++;
  return k;
}

/**
 * The index after the token at `j` inside a group opened by `open`, or -1
 * when it is a closing bracket that does not match, or a string or group
 * that never closes. A literal the lexer marked is one token, so a bracket
 * inside a regular expression closes nothing.
 */
function tokenEnd(
  s: string,
  j: number,
  open: string,
  lit: LiteralMask,
): number {
  const ch = s[j] ?? "";
  const angle = open === "<";
  if (lit?.[j]) return literalEnd(lit, j);
  if (isQuote(ch)) return stringEnd(s, j);
  if (angle && s.startsWith("=>", j)) return j + 2;
  if ("([{".includes(ch) || (angle && ch === "<")) return groupEnd(s, j, lit);
  if (")]}".includes(ch) || (angle && ch === ">")) return -1;
  return j + 1;
}

/**
 * The index after the bracketed group opened at `i`, or -1 when it never
 * closes or closes on the wrong bracket. Strings and comments inside are
 * skipped, and so is every literal in `lit`. Inside type arguments (`<`)
 * angle brackets nest and the `>` of `=>` closes nothing; elsewhere `<` and
 * `>` are operators.
 */
function groupEnd(s: string, i: number, lit: LiteralMask): number {
  const open = s[i] ?? "";
  const close = CLOSER[open];
  for (let j = skipGap(s, i + 1); j < s.length; ) {
    if (s[j] === close) return j + 1;
    j = tokenEnd(s, j, open, lit);
    if (j < 0) return -1;
    j = skipGap(s, j);
  }
  return -1;
}

/** What a callee constructs, and where it ends. */
interface Callee {
  /** The constructed name, or undefined when the chain does not settle it. */
  name: string | undefined;
  /** Whether an unsettled part names the constructor. */
  mentions: boolean;
  /** The index after the callee. */
  end: number;
}

/**
 * The text a callee is read from, the index it must end by, the name, and
 * the lexer's literal mask over the text when it has one.
 */
interface Source {
  s: string;
  to: number;
  ctor: string;
  lit: LiteralMask;
}

/** A string or template literal: its end, its text between holes, its holes. */
interface Literal {
  end: number;
  /** The text around the holes, one more piece than there are holes. */
  pieces: string[];
  /** Each `${...}` as [start of its code, index of its `}`]. */
  holes: [number, number][];
  /** Whether the text holds an escape, so its pieces are not what it spells. */
  escaped: boolean;
}

/** The index of the `}` that closes a template hole whose code starts at `from`, or -1. */
function holeEnd(s: string, from: number): number {
  let depth = 0;
  for (let j = from; j < s.length; j++) {
    const ch = s[j];
    if (opensComment(s, j)) j = skipGap(s, j) - 1;
    else if (isQuote(ch)) {
      const inner = readLiteral(s, j);
      if (inner === undefined) return -1;
      j = inner.end - 1;
    } else if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

/** The string or template literal opened at `i`, or undefined when it never closes. */
function readLiteral(s: string, i: number): Literal | undefined {
  const quote = s[i];
  const literal: Literal = { end: -1, pieces: [], holes: [], escaped: false };
  let piece = "";
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") {
      literal.escaped = true;
      j++;
    } else if (s[j] === quote) {
      literal.pieces.push(piece);
      return { ...literal, end: j + 1 };
    } else if (quote === "`" && s.startsWith("${", j)) {
      const close = holeEnd(s, j + 2);
      if (close < 0) return undefined;
      literal.pieces.push(piece);
      literal.holes.push([j + 2, close]);
      piece = "";
      j = close;
    } else piece += s[j];
  }
  return undefined;
}

/** The index after the token at `j`, skipping a comment, literal or group whole; -1 when one never closes. */
function skipToken(src: Source, j: number): number {
  const { s, lit } = src;
  if (opensComment(s, j)) return skipGap(s, j);
  if (isQuote(s[j])) return readLiteral(s, j)?.end ?? -1;
  if (lit?.[j]) return literalEnd(lit, j);
  if ("([{".includes(s[j] ?? "")) return groupEnd(s, j, lit);
  return j + 1;
}

/** The parts of `from`..`to` between the top-level `sep` characters; undefined when one never closes. */
function splitTop(
  src: Source,
  from: number,
  to: number,
  sep: string,
): [number, number][] | undefined {
  const parts: [number, number][] = [];
  let start = from;
  for (let j = from; j < to; ) {
    if (src.s[j] === sep && src.s[j + 1] !== sep && src.s[j - 1] !== sep) {
      parts.push([start, j]);
      start = j + 1;
      j++;
      continue;
    }
    j = skipToken(src, j);
    if (j < 0 || j > to) return undefined;
  }
  parts.push([start, to]);
  return parts;
}

/** Whether a string or template literal opens anywhere in `from`..`to`, comments and regular expressions aside. */
function holdsString(src: Source, from: number, to: number): boolean {
  for (let j = from; j < to; j++) {
    if (opensComment(src.s, j)) j = skipGap(src.s, j) - 1;
    else if (src.lit?.[j] && src.s[j] === "/") j = literalEnd(src.lit, j) - 1;
    else if (isQuote(src.s[j])) return true;
  }
  return false;
}

/**
 * Whether the code of a template hole at `from`..`to` holds a literal or a
 * `/` outside comments. Such a hole may hold a brace this reader does not
 * see (`${/}/.source}`), so where it closes, and the text after it, is
 * unknown.
 */
function holeUncertain(s: string, from: number, to: number): boolean {
  for (let j = from; j < to; j++) {
    if (opensComment(s, j)) j = skipGap(s, j) - 1;
    else if (isQuote(s[j]) || s[j] === "/") return true;
  }
  return false;
}

/**
 * What one operand of a `+` chain contributes to the string it spells: its
 * literal text with a hole (`undefined`) for each unknown part, or "opaque"
 * when it transforms literal text in a way this reader does not evaluate
 * (`'Error_Code'.replace(...)`, an escape). The text of a template from the
 * first hole that holds a literal or a `/` on is one unknown part: the
 * reader cannot tell where that hole closes.
 */
function operandText(
  src: Source,
  from: number,
  to: number,
): (string | undefined)[] | "opaque" {
  const at = skipGap(src.s, from);
  if (!isQuote(src.s[at]))
    return holdsString(src, at, to) ? "opaque" : [undefined];
  const literal = readLiteral(src.s, at);
  if (
    literal === undefined ||
    literal.escaped ||
    skipGap(src.s, literal.end) !== to
  )
    return "opaque";
  const uncertain = literal.holes.findIndex(([a, b]) =>
    holeUncertain(src.s, a, b),
  );
  const pieces =
    uncertain < 0 ? literal.pieces : literal.pieces.slice(0, uncertain + 1);
  const text = pieces.flatMap((piece, k) =>
    k === 0 ? [piece] : [undefined, piece],
  );
  return uncertain < 0 ? text : [...text, undefined];
}

/**
 * Whether the value at `from`..`to` (a key or an argument) could be a string
 * that spells `ctor`. A `+` chain of literals and unknowns is matched
 * exactly: `'Error' + 'Code'` and `prefix + 'Code'` can, `'Other' + 'Thing'`
 * cannot. A value holding no string literal spells nothing this reader can
 * see; one that transforms a literal is assumed to spell it.
 */
function valueMaySpell(src: Source, from: number, to: number): boolean {
  const operands = splitTop(src, from, to, "+");
  if (operands === undefined) return true;
  const parts: (string | undefined)[] = [];
  for (const [a, b] of operands) {
    const text = operandText(src, a, b);
    if (text === "opaque") return true;
    parts.push(...text);
  }
  if (parts.every((part) => part === undefined)) return false;
  const pattern = parts
    .map((part) => (part === undefined ? "[\\s\\S]*" : escapeRegExp(part)))
    .join("");
  return new RegExp(`^${pattern}$`).test(src.ctor);
}

/** Whether a key or argument list at `from`..`to` could spell `ctor`, item by item. */
function itemsMaySpell(src: Source, from: number, to: number): boolean {
  const items = splitTop(src, from, to, ",");
  return (
    items === undefined ||
    items.some(
      ([a, b]) => valueMaySpell(src, a, b) || expressionMaySpell(src, a, b),
    )
  );
}

/**
 * Whether literal text in the expression at `from`..`to` could spell `ctor`
 * where it supplies a name: in a computed key, an array or object literal,
 * or a call's arguments, at any depth. Elsewhere a literal is an operand
 * (`kind === 'date' ? Date : RegExp`), never the constructor. A group that
 * never closes is assumed to spell it.
 */
function expressionMaySpell(src: Source, from: number, to: number): boolean {
  let operand = false;
  for (let j = skipGap(src.s, from); j < to; j = skipGap(src.s, j)) {
    const end = src.s.startsWith("?.", j) ? j + 2 : skipToken(src, j);
    if (end < 0 || end > to) return true;
    if (opensGroup(src, j) && groupMaySpell(src, j, end, operand)) return true;
    operand = endsOperand(src.s, j, end, operand);
    j = end;
  }
  return false;
}

/** Whether a bracket the lexer did not read as a literal opens at `j`. */
const opensGroup = (src: Source, j: number): boolean =>
  "([{".includes(src.s[j] ?? "") && !src.lit?.[j];

/**
 * Whether the group at `j`..`end` could spell `ctor`: a `(` that follows no
 * operand groups an expression; any other group holds keys, elements or
 * arguments.
 */
function groupMaySpell(
  src: Source,
  j: number,
  end: number,
  operand: boolean,
): boolean {
  return src.s[j] === "(" && !operand
    ? expressionMaySpell(src, j + 1, end - 1)
    : itemsMaySpell(src, j + 1, end - 1);
}

/**
 * Whether an operand ends with the token at `j`..`end`, so a `(` after it
 * calls it. `?.` and the `>` closing type arguments keep what came before.
 */
function endsOperand(
  s: string,
  j: number,
  end: number,
  operand: boolean,
): boolean {
  if (s.startsWith("?.", j) || s[j] === ">") return operand;
  return end > j + 1 || isIdChar(s[j]) || s[j] === "#";
}

/**
 * A callee whose name nothing settles, spanning `from` to `end`. It names the
 * constructor when the name appears there, or when literal text there could
 * spell it where it supplies a name, since this reader evaluates nothing
 * beyond joining literals with `+`.
 */
function unsettled(src: Source, from: number, end: number): Callee {
  const span = src.s.slice(from, end);
  const name = new RegExp(
    `${NOT_ID_BEFORE}${escapeRegExp(src.ctor)}${NOT_ID_AFTER}`,
  );
  return {
    name: undefined,
    mentions: name.test(span) || expressionMaySpell(src, from, end),
    end,
  };
}

/** The callee's first part, at `i`: a name or a parenthesized callee. */
function readPrimary(src: Source, i: number): Callee | undefined {
  const { s, to } = src;
  if (s[i] !== "(") {
    const end = identifierEnd(s, i);
    return end === i || end > to
      ? undefined
      : { name: s.slice(i, end), mentions: false, end };
  }
  const end = groupEnd(s, i, src.lit);
  if (end < 0 || end > to) return undefined;
  const inner = readCallee({ ...src, to: end - 1 }, i + 1);
  return inner !== undefined && skipGap(s, inner.end) === end - 1
    ? { ...inner, end }
    : unsettled(src, i, end);
}

/** The callee extended by the member or type arguments at `i`, if any. */
function readMember(
  src: Source,
  callee: Callee,
  i: number,
): Callee | undefined {
  const { s, to } = src;
  if (s[i] === ".") {
    const at = skipGap(s, i + 1);
    const end = identifierEnd(s, at);
    return end === at || end > to
      ? undefined
      : { name: s.slice(at, end), mentions: false, end };
  }
  if (s[i] !== "[" && s[i] !== "<") return undefined;
  const end = groupEnd(s, i, src.lit);
  if (end < 0 || end > to) return undefined;
  if (s[i] === "<") return { ...callee, end };
  const at = skipGap(s, i + 1);
  const close = isQuote(s[at]) ? stringEnd(s, at) : -1;
  const key = s.slice(at + 1, close - 1);
  // Only a key that is one literal with no escape and no `${` settles a name.
  return close < 0 || skipGap(s, close) !== end - 1 || /[\\]|\$\{/.test(key)
    ? unsettled(src, i, end)
    : { name: key, mentions: false, end };
}

/**
 * The callee that starts at `from` (and ends by `src.to`): the last name of
 * its member chain (`errors.ErrorCode`, `(errors).ErrorCode`,
 * `errors['ErrorCode']`, through parentheses and type arguments), and the
 * index after it. Where the chain does not settle the name (a computed
 * member, an expression in parentheses) `mentions` says whether the
 * constructor's name appears there at all. Undefined when no callee starts
 * there.
 */
function readCallee(src: Source, from: number): Callee | undefined {
  let callee = readPrimary(src, skipGap(src.s, from));
  while (callee !== undefined) {
    let i = skipGap(src.s, callee.end);
    // A non-null assertion (`errors!.ErrorCode`, `errors!['ErrorCode']`)
    // continues the chain.
    while (
      src.s[i] === "!" &&
      ".[!".includes(src.s[skipGap(src.s, i + 1)] ?? " ")
    )
      i = skipGap(src.s, i + 1);
    const next = i < src.to ? readMember(src, callee, i) : undefined;
    if (next === undefined) return callee;
    callee = next;
  }
  return undefined;
}

/** Every `new` at an identifier boundary in `s`, by index. */
const NEW_KEYWORD = new RegExp(`${NOT_ID_BEFORE}new${NOT_ID_AFTER}`, "g");

/**
 * The constructions of `ctor` in `s`: each `new` whose callee constructs
 * `ctor` (or, where the callee does not settle a name, mentions it), with the
 * index after its argument list's `(`, or after the callee when it has no
 * arguments.
 */
function constructionsOf(
  s: string,
  ctor: string,
  lit: LiteralMask,
): { index: number; argsAt: number | undefined }[] {
  const found: { index: number; argsAt: number | undefined }[] = [];
  for (const match of s.matchAll(NEW_KEYWORD)) {
    const callee = readCallee({ s, to: s.length, ctor, lit }, match.index + 3);
    if (callee === undefined) continue;
    if (callee.name === undefined ? !callee.mentions : callee.name !== ctor)
      continue;
    const next = skipGap(s, callee.end);
    found.push({
      index: match.index,
      argsAt: s[next] === "(" ? next + 1 : undefined,
    });
  }
  return found;
}

/**
 * Every `new <ctor>` in the text, with or without arguments, in order. One in the code is a
 * construction. One in what the lexer read as a comment or a literal is
 * reported too, marked `inText`: a lexer that misreads a line (a `/` taken
 * for division that opened a regular expression, or the reverse) hides code
 * exactly there, so text shaped like a construction is never passed in
 * silence, and never allowlisted (`excessConstructions`). Text the lexer
 * cannot read (`lexer.ts`) throws.
 */
export function findConstructions(text: string, ctor: string): Construction[] {
  const { code, literal } = lex(text);
  const found = new Map<number, Omit<Construction, "line">>();
  for (const { index, argsAt } of constructionsOf(code, ctor, literal))
    if (!literal[index])
      found.set(index, { fingerprint: fingerprintAt(code, argsAt) });
  for (const { index, argsAt } of constructionsOf(text, ctor, undefined))
    if (!found.has(index))
      found.set(index, {
        fingerprint: fingerprintAt(text, argsAt),
        inText: true,
      });
  const constructions: Construction[] = [];
  let lineOf = 1;
  let last = 0;
  for (const [index, construction] of [...found].sort(([a], [b]) => a - b)) {
    for (let i = last; i < index; i++) if (text[i] === "\n") lineOf++;
    last = index;
    constructions.push({ line: lineOf, ...construction });
  }
  return constructions;
}

export interface AllowlistEntry {
  fingerprints: string[];
  /** 1-based line in the allowlist. */
  line: number;
  reason: string;
}

/** The allowlist by file; a line it cannot read throws. */
export function parseAllowlist(content: string): Map<string, AllowlistEntry> {
  const entries = new Map<string, AllowlistEntry>();
  for (const entry of reasonedEntries(content)) {
    const match = /^(.+?):(.+)$/.exec(entry.text.trim());
    if (!match)
      throw new InputError(
        `allowlist line ${entry.line}: expected <file>:<fingerprint>,<fingerprint>,...`,
      );
    const file = match[1] ?? "";
    const fingerprints = (match[2] ?? "").split(",").map((fp) => fp.trim());
    if (fingerprints.some((fp) => fp === ""))
      throw new InputError(
        `allowlist line ${entry.line}: an empty fingerprint`,
      );
    if ([...fingerprints].sort().join(",") !== fingerprints.join(","))
      throw new InputError(
        `allowlist line ${entry.line}: fingerprints must be sorted`,
      );
    if (entries.has(file))
      throw new InputError(
        `allowlist line ${entry.line}: ${file} listed twice`,
      );
    entries.set(file, { fingerprints, line: entry.line, reason: entry.reason });
  }
  return entries;
}

/**
 * The constructions not covered by `allowed`, each identity consumed once by
 * a construction in code. One in text is never covered: whether it is text
 * rests on the lexer's reading, so an exception for it could cover code.
 */
export function excessConstructions(
  found: readonly Construction[],
  allowed: readonly string[],
): Construction[] {
  const left = new Map<string, number>();
  for (const fp of allowed) left.set(fp, (left.get(fp) ?? 0) + 1);
  return found.filter(({ fingerprint, inText }) => {
    if (inText) return true;
    const n = left.get(fingerprint) ?? 0;
    if (n === 0) return true;
    left.set(fingerprint, n - 1);
    return false;
  });
}

interface Options {
  registry: string[];
  ctor: string;
  allowlist: string | undefined;
  root: string;
  extensions: string[];
  paths: string[];
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    registry: [],
    ctor: "ErrorCode",
    allowlist: undefined,
    root: process.cwd(),
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    paths: [],
  };
  const value = (i: number, name: string) => optionValue(args, i, name, usage);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--registry") options.registry.push(value(++i, arg));
    else if (arg === "--constructor") options.ctor = value(++i, arg);
    else if (arg === "--allowlist") options.allowlist = value(++i, arg);
    else if (arg === "--root") options.root = value(++i, arg);
    else if (arg === "--ext") options.extensions = splitList(value(++i, arg));
    else if (arg.startsWith("--"))
      throw new InputError(`unknown option ${arg}\n${usage}`);
    else options.paths.push(arg);
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(options.ctor))
    throw new InputError(`--constructor is not an identifier: ${options.ctor}`);
  if (options.registry.length === 0)
    throw new InputError(`--registry is required\n${usage}`);
  if (options.paths.length === 0)
    throw new InputError(`no path to scan\n${usage}`);
  return options;
}

/** The allowlist's entries without a reason, and the stale ones. */
function allowlistFindings(
  allowlist: ReadonlyMap<string, AllowlistEntry>,
  foundByFile: ReadonlyMap<string, Construction[]>,
  files: readonly string[],
  listFile: string,
): Finding[] {
  const findings: Finding[] = [];
  const at = (entry: AllowlistEntry, problem: string, remedy: string) =>
    findings.push({
      rule: LIST_RULE,
      file: listFile,
      line: entry.line,
      problem,
      remedy,
    });
  for (const [file, entry] of allowlist) {
    const actual = (foundByFile.get(file) ?? [])
      .filter(({ inText }) => !inText)
      .map(({ fingerprint }) => fingerprint)
      .sort();
    if (entry.reason === "")
      at(
        entry,
        `the entry for ${file} has no reason.`,
        "Open its group with a `#` comment saying why the debt stays.",
      );
    if (!files.includes(file))
      at(
        entry,
        `stale: ${file} is not among the scanned files.`,
        "Remove the entry, or point it at the file's new path.",
      );
    else if (actual.join(",") !== entry.fingerprints.join(","))
      at(
        entry,
        `stale: ${file} holds [${actual.join(",")}], the entry lists [${entry.fingerprints.join(",")}].`,
        "Update the entry to what the file holds now, so the debt only ever shrinks on purpose.",
      );
  }
  return findings;
}

/** Each construction the allowlist does not cover, with its place. */
function constructionFindings(
  foundByFile: ReadonlyMap<string, Construction[]>,
  allowlist: ReadonlyMap<string, AllowlistEntry>,
  ctor: string,
  registry: readonly string[],
): Finding[] {
  const findings: Finding[] = [];
  for (const [file, found] of foundByFile)
    for (const { line, fingerprint, inText } of excessConstructions(
      found,
      allowlist.get(file)?.fingerprints ?? [],
    )) {
      const construction = `new ${ctor}(${fingerprint === "?" ? "…" : JSON.stringify(fingerprint)})`;
      const declare = `declare the code in the registry (${registry.join(", ")}) and import its constant here`;
      findings.push({
        rule: RULE,
        file,
        line,
        problem: inText
          ? `${construction} outside the registry, in what reads as a comment or a literal.`
          : `${construction} outside the registry.`,
        remedy: inText
          ? `If it is code, the line before it was misread: rewrite that line so it reads as code (wrap the expression around a \`/\` in parentheses), then ${declare}. If it is text, reword it so it no longer reads as a construction: the allowlist does not cover text, since a misread line would make it code.`
          : `Declare the code in the registry (${registry.join(", ")}) and import its constant here.`,
      });
    }
  return findings;
}

/** The constructions in one source file; one the lexer cannot read throws. */
function constructionsIn(
  root: string,
  file: string,
  ctor: string,
): Construction[] {
  const text = readText(root, file, "a source file");
  try {
    return findConstructions(text, ctor);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    throw new InputError(`${file} cannot be read as code: ${error.message}`, {
      cause: error,
    });
  }
}

export function main(args = process.argv.slice(2)): number {
  const options = parseArgs(args);
  const root = existing(process.cwd(), options.root, "--root");
  for (const path of options.registry) existing(root, path, "the registry");
  const files = listFiles(
    root,
    options.paths,
    options.extensions,
    options.registry,
    "a path to scan",
  );
  const allowlist =
    options.allowlist === undefined
      ? new Map<string, AllowlistEntry>()
      : parseAllowlist(readText(root, options.allowlist, "the allowlist"));
  const foundByFile = new Map<string, Construction[]>();
  for (const file of files) {
    const found = constructionsIn(root, file, options.ctor);
    if (found.length > 0) foundByFile.set(file, found);
  }
  const findings = [
    ...allowlistFindings(
      allowlist,
      foundByFile,
      files,
      options.allowlist ?? "",
    ),
    ...constructionFindings(
      foundByFile,
      allowlist,
      options.ctor,
      options.registry,
    ),
  ];
  if (findings.length > 0) {
    reportFindings(findings);
    return 1;
  }
  const debt = [...allowlist.values()].reduce(
    (n, entry) => n + entry.fingerprints.length,
    0,
  );
  console.log(
    `OK — ${files.length} file(s) construct no ${options.ctor} outside the registry${debt > 0 ? `; the allowlist carries ${debt} construction(s) of debt` : ""}`,
  );
  return 0;
}

if (import.meta.main) cli(() => main());
