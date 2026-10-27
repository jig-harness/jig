/**
 * Why a conflict happened: a cause for each conflicting region, from the
 * region's three sides (the merge base, ours and theirs) and, where a rule
 * says so, from the three versions of the region's file.
 *
 * The rules are tried in `CAUSES` order and the first that matches wins. A
 * rule matches only on evidence it can settle; anything else falls through,
 * so a region nothing explains is `overlap`, never a guess. `derived` (the
 * path is a lockfile or a generated file) and `structural` (git reports the
 * path's conflict without text regions) are decided for the path as a whole,
 * before its regions.
 */
import { posix } from "node:path";

export const CAUSES = [
  "derived",
  "structural",
  "echo",
  "version",
  "sequence",
  "tally",
  "append",
  "packed-list",
  "adjacent",
  "overlap",
] as const;
export type Cause = (typeof CAUSES)[number];

/** Each cause's shape in one sentence, for a reader who has not seen the rules. */
export const SHAPES: Readonly<Record<Cause, string>> = {
  derived: "Both sides changed a lockfile or a generated file.",
  structural:
    "Git reported the conflict without text regions (a binary file, a modify/delete, a rename, a file/directory or a mode conflict).",
  echo: "One side's edit was already in the other, as when a branch is built on another that was squash-merged beneath it.",
  version:
    "The sides differed only in a release version the release step writes, or in a date stamp.",
  sequence: "Both sides added an entry with the same next ordinal.",
  tally:
    "Only a number differed, and each side's number counted the lines that side added to the file.",
  append: "Both sides added lines at the same place.",
  "packed-list": "Both sides added items to the same one-line list.",
  adjacent: "The lines each side changed touched without overlapping.",
  overlap:
    "Both sides changed the same lines: two pieces of work changed the same thing.",
};

/** The change that removes each cause. */
export const REMEDIES: Readonly<Record<Cause, string>> = {
  derived:
    "regenerate it; keep it out of pull requests if a step after the merge can write it",
  structural:
    "none from the regions: resolving it stays a decision (the report names git's own kind of conflict)",
  echo: "keep the side that contains the other; rebuild a branch on its base once the branch it was built on merges",
  version:
    "move the version after the merge (a release step writes it); take a date from git instead of the file",
  sequence:
    "use identifiers that cannot collide (a timestamp), or one step that renumbers the entry everywhere it is named",
  tally:
    "derive the number where it is used; a register that stores line numbers keys its entries by name instead",
  append:
    "one file per entry (as change notes are), or a sorted list with one entry per line",
  "packed-list":
    "one item per line, or stop listing what another file already lists",
  adjacent:
    "split what changes for different reasons onto lines or files of its own",
  overlap:
    "two pieces of work changed the same thing: plan them apart, or land one first",
};

/** An `append` in source code can be the same fix written twice, so its remedy is a question. */
const APPEND_IN_CODE =
  "is this the same fix written twice? If not, could the entries go one per file, or one per line in a sorted list?";

const CODE_EXTENSIONS = new Set(
  (
    "c cc cpp cxx h hpp cs go java kt kts scala swift m mm rs rb py php pl lua " +
    "js jsx mjs cjs ts tsx mts cts vue svelte dart ex exs erl hs clj fs " +
    "sh bash zsh ps1 sql r jl zig nim"
  ).split(" "),
);

/** Whether `path` is source code, by its extension. */
export function isSourceCode(path: string): boolean {
  const ext = posix.extname(path).slice(1).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

const PROSE_EXTENSIONS = new Set([
  "md",
  "markdown",
  "mdx",
  "txt",
  "rst",
  "adoc",
]);

/** Whether `path` is prose, by its extension. */
export function isProse(path: string): boolean {
  return PROSE_EXTENSIONS.has(posix.extname(path).slice(1).toLowerCase());
}

/** The remedy for `cause` at `path`. */
export function remedyFor(cause: Cause, path: string): string {
  return cause === "append" && isSourceCode(path)
    ? APPEND_IN_CODE
    : REMEDIES[cause];
}

/** Whether a cause is one a change to the files can remove. */
export function isMechanical(cause: Cause): boolean {
  return cause !== "overlap" && cause !== "structural";
}

// ---------------------------------------------------------------------------
// Line alignment

/** Above this many cells the alignment is not computed and the rules that need it do not match. */
const MAX_CELLS = 4_000_000;

/** How many leading and trailing entries `a` and `b` share. */
function sharedEnds<T>(a: readonly T[], b: readonly T[]): [number, number] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  const most = Math.min(a.length, b.length) - head;
  while (tail < most && a[a.length - 1 - tail] === b[b.length - 1 - tail])
    tail++;
  return [head, tail];
}

/** The longest-common-subsequence lengths of every pair of suffixes of `a` and `b`. */
function lcsTable<T>(a: readonly T[], b: readonly T[]): Uint32Array {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) {
      const down = table[(i + 1) * width + j] as number;
      const right = table[i * width + j + 1] as number;
      const diagonal = (table[(i + 1) * width + j + 1] as number) + 1;
      table[i * width + j] = a[i] === b[j] ? diagonal : Math.max(down, right);
    }
  return table;
}

/** The matching pairs of one longest common subsequence of `a` and `b`, read from its table. */
function lcsPairs<T>(a: readonly T[], b: readonly T[]): [number, number][] {
  const table = lcsTable(a, b);
  const width = b.length + 1;
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (
      (table[(i + 1) * width + j] as number) >=
      (table[i * width + j + 1] as number)
    )
      i++;
    else j++;
  }
  return pairs;
}

/**
 * Pairs of matching indexes `[i, j]` (a[i] === b[j]) of a longest common
 * subsequence of `a` and `b`, in order; null when the inputs are too large.
 */
export function align<T>(
  a: readonly T[],
  b: readonly T[],
): [number, number][] | null {
  const [head, tail] = sharedEnds(a, b);
  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);
  if ((middleA.length + 1) * (middleB.length + 1) > MAX_CELLS) return null;
  const pairs: [number, number][] = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);
  for (const [i, j] of lcsPairs(middleA, middleB))
    pairs.push([head + i, head + j]);
  for (let k = 0; k < tail; k++)
    pairs.push([a.length - tail + k, b.length - tail + k]);
  return pairs;
}

export interface Edit {
  /** Lines of `to` not matched in `from`. */
  added: string[];
  /** Lines of `from` not matched in `to`. */
  removed: string[];
  /** Each changed stretch of `from` as `[start, end)`; `start === end` is an insertion before `start`. */
  spans: [number, number][];
}

/** What turns `from` into `to`; null when the inputs are too large to align. */
export function edit(
  from: readonly string[],
  to: readonly string[],
): Edit | null {
  const pairs = align(from, to);
  if (pairs === null) return null;
  const added: string[] = [];
  const removed: string[] = [];
  const spans: [number, number][] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [
    ...pairs,
    [from.length, to.length] as [number, number],
  ]) {
    if (pi > i || pj > j) spans.push([i, pi]);
    for (let k = i; k < pi; k++) removed.push(from[k] as string);
    for (let k = j; k < pj; k++) added.push(to[k] as string);
    i = pi + 1;
    j = pj + 1;
  }
  return { added, removed, spans };
}

function counts(lines: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
  return map;
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

// ---------------------------------------------------------------------------
// The rules

export interface Region {
  ours: string[];
  base: string[];
  theirs: string[];
}

export type SideName = "base" | "ours" | "theirs";

/**
 * The line of a file that holds the release version at the configured key,
 * found as the release step finds it: the whole line, and where the version
 * sits in it.
 */
export interface ReleaseField {
  version: string;
  line: string;
  start: number;
  end: number;
}

/** What a rule may read beyond the region. */
export interface RegionContext {
  /** Whether the file existed in the merge base; a file both sides added did not. */
  inBase: boolean;
  /** The whole file in each version, as lines; null where that version is absent or unreadable. */
  file: Record<SideName, string[] | null>;
  /** Where each version of the file holds a release version the release step writes: one field per configured key of the path. */
  release: Record<SideName, readonly ReleaseField[]>;
  /** Whether the file is prose, where a list's items are separated by commas and a closing `and` or `or`. */
  prose: boolean;
  /**
   * The net number of lines `side` added to the file above line `line`
   * (1-based) of the base version; null when it cannot be told.
   */
  netAbove(side: "ours" | "theirs", line: number): number | null;
}

/**
 * `echo`: the sides are identical, or one side's edit from the base is
 * already in the other: every line it added is there, every line it removed
 * is not, and the lines the two share stand in the same order. An edit that
 * only removes lines is in any rewrite of them, which settles nothing, so the
 * contained edit must add a line.
 */
export function isEcho(r: Region): boolean {
  if (same(r.ours, r.theirs)) return true;
  return (
    contains(r.base, r.ours, r.theirs) || contains(r.base, r.theirs, r.ours)
  );
}

/** Whether `side`'s edit from `base` is already in `other`. */
function contains(base: string[], side: string[], other: string[]): boolean {
  if (same(base, side)) return false;
  const change = edit(base, side);
  const shared = align(side, other);
  if (change === null || shared === null || change.added.length === 0)
    return false;
  const inSide = counts(side);
  const inOther = counts(other);
  for (const line of new Set(change.added))
    if ((inOther.get(line) ?? 0) < (inSide.get(line) ?? 0)) return false;
  for (const line of new Set(change.removed))
    if ((inOther.get(line) ?? 0) > (inSide.get(line) ?? 0)) return false;
  let common = 0;
  for (const [line, n] of inSide) common += Math.min(n, inOther.get(line) ?? 0);
  return shared.length === common;
}

/** A line holding a date stamp: a last-updated, last-modified or last-reviewed field. */
const DATE_STAMP_KEY =
  /(last[\s_-]?(updated|modified|reviewed|changed|verified)|updated[\s_-]?(at|on)|modified[\s_-]?(at|on)|lastUpdated|lastModified)/i;
const DATE =
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
const PLACEHOLDER_VERSION = "\u0000version\u0000";
const PLACEHOLDER_DATE = "\u0000date\u0000";

/**
 * The lines with the release version masked where each release field holds
 * it and every date stamp masked. A field's line is told by its whole text,
 * which must stand once in the file: another line with the same text could be
 * the one in the region, so then that field is not masked.
 */
function stamped(
  lines: readonly string[],
  release: readonly ReleaseField[],
  file: readonly string[] | null,
): string[] {
  const fields =
    file === null
      ? []
      : release
          .filter((f) => file.filter((line) => line === f.line).length === 1)
          // Masked from the end of a line, so an earlier field's offsets still hold.
          .toSorted((a, b) => b.start - a.start);
  return lines.map((line) => {
    let out = line;
    for (const field of fields)
      if (line === field.line)
        out = `${out.slice(0, field.start)}${PLACEHOLDER_VERSION}${out.slice(field.end)}`;
    if (DATE_STAMP_KEY.test(out)) out = out.replace(DATE, PLACEHOLDER_DATE);
    return out;
  });
}

/**
 * `version`: the sides differ only in the release version of an artifact the
 * repository's release step writes (the value the configured key is assigned,
 * nowhere else), or in a date stamp.
 */
export function isVersion(r: Region, ctx: RegionContext): boolean {
  const ours = stamped(r.ours, ctx.release.ours, ctx.file.ours);
  const theirs = stamped(r.theirs, ctx.release.theirs, ctx.file.theirs);
  return !same(r.ours, r.theirs) && same(ours, theirs);
}

const ORDINAL = /^(\D*)(\d+)/;

interface Ordinal {
  /** What the line holds before its first number. */
  prefix: string;
  value: number;
}

function ordinalOf(line: string): Ordinal | null {
  const match = line.match(ORDINAL);
  return match ? { prefix: match[1] as string, value: Number(match[2]) } : null;
}

/** The highest ordinal among `lines` that start with `prefix`; 0 for none. */
function highestOrdinal(lines: readonly string[], prefix: string): number {
  let highest = 0;
  for (const line of lines) {
    const ordinal = ordinalOf(line);
    if (ordinal?.prefix === prefix) highest = Math.max(highest, ordinal.value);
  }
  return highest;
}

/**
 * `sequence`: both sides only add lines, and both add an entry with the same
 * ordinal, the one after the highest the base version of the file holds for
 * entries written the same way. A side that also changes or removes a line
 * has an edit the collision does not explain.
 */
export function isSequence(r: Region, ctx: RegionContext): boolean {
  const ours = edit(r.base, r.ours);
  const theirs = edit(r.base, r.theirs);
  const baseFile = ctx.file.base ?? (r.base.length === 0 ? [] : null);
  if (ours === null || theirs === null || baseFile === null) return false;
  if (ours.removed.length > 0 || theirs.removed.length > 0) return false;
  const theirsOrdinals = theirs.added.map((line) => ({
    line,
    ordinal: ordinalOf(line),
  }));
  return ours.added.some((line) => {
    const mine = ordinalOf(line);
    if (mine === null) return false;
    const clash = theirsOrdinals.some(
      (t) =>
        t.line !== line &&
        t.ordinal?.prefix === mine.prefix &&
        t.ordinal.value === mine.value,
    );
    return clash && mine.value === highestOrdinal(baseFile, mine.prefix) + 1;
  });
}

const NUMBER = /\d+/g;

function numbersIn(line: string): number[] {
  return (line.match(NUMBER) ?? []).map(Number);
}

function shape(line: string): string {
  return line.replace(NUMBER, "#");
}

/** Whether the three sides hold the same lines once every number is a placeholder. */
function sameShape(r: Region): boolean {
  return (
    r.base.length === r.ours.length &&
    r.base.length === r.theirs.length &&
    r.base.every(
      (line, i) =>
        shape(line) === shape(r.ours[i] as string) &&
        shape(line) === shape(r.theirs[i] as string),
    )
  );
}

/** Each number that differs among the sides, as it stands in each. */
function movedNumbers(
  r: Region,
): { base: number; ours: number; theirs: number }[] {
  return r.base.flatMap((line, i) => {
    const ours = numbersIn(r.ours[i] as string);
    const theirs = numbersIn(r.theirs[i] as string);
    return numbersIn(line)
      .map((base, k) => ({
        base,
        ours: ours[k] as number,
        theirs: theirs[k] as number,
      }))
      .filter((n) => n.ours !== n.base || n.theirs !== n.base);
  });
}

/**
 * `tally`: with every number replaced by one placeholder the three sides are
 * equal, and each number that differs moved, on each side, by the net number
 * of lines that side added to the file, or by the net number of lines it
 * added above the base line the number names.
 */
export function isTally(r: Region, ctx: RegionContext): boolean {
  const { base, ours, theirs } = ctx.file;
  if (base === null || ours === null || theirs === null || !sameShape(r))
    return false;
  const net = {
    ours: ours.length - base.length,
    theirs: theirs.length - base.length,
  };
  const moved = movedNumbers(r);
  const followsLines = (n: (typeof moved)[number], side: "ours" | "theirs") => {
    const delta = n[side] - n.base;
    return (
      delta === net[side] ||
      (n.base >= 1 && delta === ctx.netAbove(side, n.base))
    );
  };
  return (
    moved.length > 0 &&
    moved.every((n) => followsLines(n, "ours") && followsLines(n, "theirs"))
  );
}

/**
 * `append`: the base side of the region is empty, so both sides added lines
 * at the same place. A file both sides added has an empty base everywhere
 * because it did not exist, not because lines were added at one place, so
 * its regions are not `append`.
 */
export function isAppend(r: Region, ctx: RegionContext): boolean {
  return r.base.length === 0 && ctx.inBase;
}

/** A separator between the items of a list written on one line. */
const SEPARATORS = new Set([",", ";", "|", "and", "or"]);

/** The separators of a prose list, which a list growing moves: `b and c` becomes `b, c and d`. */
const PROSE_SEPARATORS = new Set([",", "and", "or"]);

const CONJUNCTIONS = ["and", "or"];

const PROSE_SEPARATOR = "\u0000separator\u0000";

/**
 * A quoted literal, whole: what it holds is one item, separators and spaces
 * included. Each literal is read as the language it stands in reads it. In
 * prose a run of backticks opens a literal that the next run of the same
 * length closes, with no escapes inside (a Markdown code span), so ``a,b``
 * is one literal, not two empty ones around `a,b`. In code a backtick opens a
 * template literal, which a backslash escapes inside, like a quoted string.
 */
const DOUBLE_QUOTED = /"(?:[^"\\]|\\.)*"/u;
const CODE_SPAN = /(?<!`)(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)/u;
const SINGLE_QUOTED = /'(?:[^'\\]|\\.)*'/u;
const TEMPLATE = /`(?:[^`\\]|\\.)*`/u;

const LITERAL = {
  prose: `${DOUBLE_QUOTED.source}|${CODE_SPAN.source}`,
  code: `${DOUBLE_QUOTED.source}|${SINGLE_QUOTED.source}|${TEMPLATE.source}`,
};

/** The quotes that open a literal: in prose `'` is an apostrophe. */
const quotes = (prose: boolean): string[] =>
  prose ? ['"', "`"] : ['"', "`", "'"];

/**
 * A line as tokens: each quoted literal, each run of letters, digits and
 * `_`, and each other non-blank character. In prose a comma and a closing
 * `and` or `or` are one token, so `b and c` growing into `b, c and d` keeps
 * its items in place; elsewhere every separator is itself, since `a | b` and
 * `a, b` differ. Null for a line whose items cannot be told without guessing
 * at its language: a quote that closes nowhere; in code a `/`, which opens
 * a regular expression literal or a comment as often as it divides, so
 * `[/a,b/, c]` would read as items it does not hold; and in code a template
 * literal's `${`, whose expression can hold literals of its own, so where the
 * template ends takes a parser, not a pattern.
 */
function tokens(line: string, prose: boolean): string[] | null {
  const literal = prose ? LITERAL.prose : LITERAL.code;
  const found =
    line.match(new RegExp(`${literal}|[\\p{L}\\p{N}_]+|\\S`, "gu")) ?? [];
  if (found.some((token) => quotes(prose).includes(token))) return null;
  if (!prose && found.some((token) => token === "/")) return null;
  if (!prose && found.some((t) => t.startsWith("`") && t.includes("${")))
    return null;
  return found.map((token) =>
    prose && PROSE_SEPARATORS.has(token) ? PROSE_SEPARATOR : token,
  );
}

const isSeparator = (token: string): boolean =>
  token === PROSE_SEPARATOR || SEPARATORS.has(token);

/** How many times each of `words` stands in `line` as a word, as text. */
function wordCounts(line: string, words: readonly string[]): string[] {
  const all = line.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.map((word) => String(all.filter((w) => w === word).length));
}

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

/** Where a sentence ends a prose list: `a, b.` grows into `a, b, c.`. */
const SENTENCE_ENDS = new Set([".", "!", "?", ":"]);

/**
 * Whether `tokens` are whole items, one or more between separators: each
 * holds something and closes every bracket it opens, and a separator inside
 * brackets belongs to the item (`g(x, y)` is one item).
 */
function wholeItems(tokens: readonly string[]): boolean {
  const open: string[] = [];
  let empty = true;
  for (const token of tokens) {
    if (open.length === 0 && isSeparator(token)) {
      if (empty) return false;
      empty = true;
      continue;
    }
    empty = false;
    if (OPENERS.has(token)) open.push(token);
    else if (CLOSERS.has(token)) {
      const opener = open.pop();
      if (
        opener === undefined ||
        "([{".indexOf(opener) !== ")]}".indexOf(token)
      )
        return false;
    }
  }
  return !empty && open.length === 0;
}

/**
 * Whether `run`, inserted between `before` and `after` (null at an end of the
 * line), adds whole items at an item boundary: a separator and items placed
 * where an item ends (before a separator, a closing bracket or the end), or
 * items and a separator placed where an item starts (after a separator, an
 * opening bracket or the start; in prose also before the sentence's end) or
 * after a trailing separator (`[a, b,]` becoming `[a, b, c,]`).
 * Anything else, `b` becoming `b + d,` or `b` becoming `b, x + e`, changes an
 * item the base has.
 */
function addsWholeItems(
  run: readonly string[],
  before: string | null,
  after: string | null,
  prose: boolean,
): boolean {
  return (
    (isSeparator(run[0] as string) &&
      endsAnItem(before, after, prose) &&
      wholeItems(run.slice(1))) ||
    (isSeparator(run.at(-1) as string) &&
      startsAnItem(before, after) &&
      wholeItems(run.slice(0, -1)))
  );
}

/** Whether a run between `before` and `after` stands where an item ends. */
function endsAnItem(
  before: string | null,
  after: string | null,
  prose: boolean,
): boolean {
  if (before === null || isSeparator(before) || OPENERS.has(before))
    return false;
  return (
    after === null ||
    isSeparator(after) ||
    CLOSERS.has(after) ||
    (prose && SENTENCE_ENDS.has(after))
  );
}

/**
 * Whether a run between `before` and `after` stands where an item starts, or
 * after a list's trailing separator, before its closing bracket or the end.
 */
function startsAnItem(before: string | null, after: string | null): boolean {
  if (before !== null && !isSeparator(before) && !OPENERS.has(before))
    return false;
  if (after !== null && !isSeparator(after) && !CLOSERS.has(after)) return true;
  return (
    before !== null &&
    isSeparator(before) &&
    (after === null || CLOSERS.has(after))
  );
}

/**
 * Whether `to` is `from` with items added to its list: every token of `from`
 * stands in `to` unchanged and in order, and each run of tokens `to` inserts
 * is whole items at an item boundary (`addsWholeItems`), so no item of
 * `from` changed (`b` becoming `b()` inserts `(` `)`, which is not an item).
 */
function addsItems(from: string, to: string, prose: boolean): boolean {
  // A prose list keeps its conjunctions: `a or b` becoming `a and b and c` changes the list.
  if (
    prose &&
    !same(wordCounts(from, CONJUNCTIONS), wordCounts(to, CONJUNCTIONS))
  )
    return false;
  const before = tokens(from, prose);
  const after = tokens(to, prose);
  if (before === null || after === null) return false;
  const pairs = align(before, after);
  if (pairs === null || pairs.length !== before.length) return false;
  let inserted = 0;
  let j = 0;
  for (const [, pj] of [...pairs, [before.length, after.length]]) {
    const end = pj as number;
    if (end > j) {
      const run = after.slice(j, end);
      if (!addsWholeItems(run, after[j - 1] ?? null, after[end] ?? null, prose))
        return false;
      inserted++;
    }
    j = end + 1;
  }
  return inserted > 0;
}

/** `packed-list`: the region is one line in every side, and each side adds items to a list in it. */
export function isPackedList(r: Region, ctx: RegionContext): boolean {
  if (r.base.length !== 1 || r.ours.length !== 1 || r.theirs.length !== 1)
    return false;
  const base = r.base[0] as string;
  return (
    addsItems(base, r.ours[0] as string, ctx.prose) &&
    addsItems(base, r.theirs[0] as string, ctx.prose)
  );
}

function spansOverlap(a: [number, number], b: [number, number]): boolean {
  const [as, ae] = a;
  const [bs, be] = b;
  if (as === ae && bs === be) return as === bs;
  if (as === ae) return bs < as && as < be;
  if (bs === be) return as < bs && bs < ae;
  return as < be && bs < ae;
}

/** `adjacent`: the lines each side changed do not overlap, but touch. */
export function isAdjacent(r: Region): boolean {
  if (r.base.length === 0) return false;
  const ours = edit(r.base, r.ours);
  const theirs = edit(r.base, r.theirs);
  if (ours === null || theirs === null) return false;
  if (ours.spans.length === 0 || theirs.spans.length === 0) return false;
  return ours.spans.every((a) =>
    theirs.spans.every((b) => !spansOverlap(a, b)),
  );
}

/** The cause of one text region, by the first rule that matches. */
export function regionCause(r: Region, ctx: RegionContext): Cause {
  if (isEcho(r)) return "echo";
  if (isVersion(r, ctx)) return "version";
  if (isSequence(r, ctx)) return "sequence";
  if (isTally(r, ctx)) return "tally";
  if (isAppend(r, ctx)) return "append";
  if (isPackedList(r, ctx)) return "packed-list";
  if (isAdjacent(r)) return "adjacent";
  return "overlap";
}

/** Causes in `CAUSES` order, each once. */
export function ordered(causes: Iterable<Cause>): Cause[] {
  const set = new Set(causes);
  return CAUSES.filter((cause) => set.has(cause));
}

/**
 * The one cause that stands for a path: `structural` or `overlap` when the
 * path has one (nothing but a decision removes them, so they decide how the
 * path counts), else the cause of most of its regions, ties in `CAUSES` order.
 */
export function primaryCause(
  causes: readonly Cause[],
  regions: readonly { cause: Cause }[],
): Cause {
  if (causes.includes("structural")) return "structural";
  if (causes.includes("overlap")) return "overlap";
  const counts = new Map<Cause, number>();
  for (const { cause } of regions)
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  let best: Cause | undefined;
  for (const cause of CAUSES) {
    const n = counts.get(cause) ?? 0;
    if (n > 0 && n > (counts.get(best as Cause) ?? 0)) best = cause;
  }
  return best ?? causes[0] ?? "overlap";
}
