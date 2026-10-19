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
    removed.push(...from.slice(i, pi));
    added.push(...to.slice(j, pj));
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

/** What a rule may read beyond the region. */
export interface RegionContext {
  /** Whether the file existed in the merge base; a file both sides added did not. */
  inBase: boolean;
  /** The whole file in each version, as lines; null where that version is absent or unreadable. */
  file: Record<SideName, string[] | null>;
  /** The release version each version of the file holds at a key the release step writes, if the path is a version file. */
  release: Record<SideName, { version: string; key: string } | null>;
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stamped(
  lines: readonly string[],
  release: { version: string; key: string } | null,
): string[] {
  const keyName = release?.key.split(".").at(-1) ?? "";
  const version =
    release === null
      ? null
      : new RegExp(
          `(?<![\\w.])${escapeRegExp(release.version)}(?![\\w.])`,
          "g",
        );
  return lines.map((line) => {
    let out = line;
    if (version !== null && (keyName === "" || line.includes(keyName)))
      out = out.replace(version, PLACEHOLDER_VERSION);
    if (DATE_STAMP_KEY.test(out)) out = out.replace(DATE, PLACEHOLDER_DATE);
    return out;
  });
}

/**
 * `version`: the sides differ only in the release version of an artifact the
 * repository's release step writes (read at the configured key, on the lines
 * that name it), or in a date stamp.
 */
export function isVersion(r: Region, ctx: RegionContext): boolean {
  const ours = stamped(r.ours, ctx.release.ours);
  const theirs = stamped(r.theirs, ctx.release.theirs);
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
 * `sequence`: both sides add an entry with the same ordinal, the one after the
 * highest the base version of the file holds for entries written the same way.
 */
export function isSequence(r: Region, ctx: RegionContext): boolean {
  const ours = edit(r.base, r.ours);
  const theirs = edit(r.base, r.theirs);
  const baseFile = ctx.file.base ?? (r.base.length === 0 ? [] : null);
  if (ours === null || theirs === null || baseFile === null) return false;
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

/** What separates the items of a list written on one line. */
const ITEM_SEPARATOR = /\s*[,;|]\s*|\s+(?:and|or)\s+/;

/** The items of a list on one line, without the brackets and quotes around them. */
function items(line: string): string[] {
  return line
    .split(ITEM_SEPARATOR)
    .map((item) => item.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((item) => item !== "");
}

/** Whether `to` is `from` with items added to its list, and none changed or removed. */
function addsItems(from: string, to: string): boolean {
  const before = counts(items(from));
  const after = items(to);
  if (after.length <= items(from).length || !ITEM_SEPARATOR.test(to))
    return false;
  const inAfter = counts(after);
  for (const [item, n] of before)
    if ((inAfter.get(item) ?? 0) < n) return false;
  return true;
}

/** `packed-list`: the region is one line in every side, and each side adds items to a list in it. */
export function isPackedList(r: Region): boolean {
  if (r.base.length !== 1 || r.ours.length !== 1 || r.theirs.length !== 1)
    return false;
  const base = r.base[0] as string;
  return (
    addsItems(base, r.ours[0] as string) &&
    addsItems(base, r.theirs[0] as string)
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
  if (isPackedList(r)) return "packed-list";
  if (isAdjacent(r)) return "adjacent";
  return "overlap";
}

/** Causes in `CAUSES` order, each once. */
export function ordered(causes: Iterable<Cause>): Cause[] {
  const set = new Set(causes);
  return CAUSES.filter((cause) => set.has(cause));
}
