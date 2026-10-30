// The whole changelog as the format checks read it: the blocks it renders as,
// read through Bun's own CommonMark parser (markdown-tree.ts), and the line
// each starts on. Its title, the blocks before the first release, each `##`
// section with the `###` groups under it. What a rule judges is what renders;
// the source lines only say where a finding points. Shared by the rules of
// each format (lint-keep-a-changelog.ts, lint-common-changelog.ts) and the
// command (lint.ts).
import { Defect } from "../../../shared/errors.ts";
import { fenced, heading } from "./markdown-blocks.ts";
import {
  type Block,
  type Inline,
  parseBlocks,
  plain,
} from "./markdown-tree.ts";

/** One rule a finding names: its id and where the format's specification states it. */
export interface Rule {
  /** `<format>/<rule>`, the same in every finding of the rule. */
  id: string;
  /** The specification's section that states the rule. */
  section: string;
  /** The address of that section. */
  url: string;
}

/** A place in the changelog that breaks a rule, and what to change. */
export interface Finding {
  rule: string;
  file: string;
  /** 1-based. */
  line: number;
  problem: string;
  remedy: string;
}

/** A top-level block and where it sits among the document's blocks. */
export interface Part {
  block: Block;
  index: number;
}

/** A heading: the line it is on, its source title and what it renders as. */
export interface Heading {
  line: number;
  /** The heading's text as written, for a message. */
  title: string;
  inline: Inline[];
  index: number;
}

/** A `###` heading and the blocks under it, up to the next heading of level 3 or less. */
export interface Group extends Heading {
  body: Part[];
}

/** A `##` heading and what follows it, up to the next heading of level 2 or less. */
export interface Section extends Heading {
  /** The blocks before the first `###` heading. */
  lead: Part[];
  groups: Group[];
}

export interface Changelog {
  file: string;
  /** The source lines, numbered from 1 by their index plus one. */
  lines: string[];
  blocks: Block[];
  /** The line of the first non-blank line, when the file has one. */
  first: number | null;
  /** The level-1 headings, in order. */
  titles: Heading[];
  /** The blocks between the first block and the first `##` heading, level-1 headings aside. */
  preamble: Part[];
  sections: Section[];
  /** The line top-level block `index` starts on, or with `item` the line that list item starts on. */
  lineOf(index: number, item?: number): number;
}

/**
 * The version a release heading opens with and the text after it. The version
 * is plain (`1.0.0`), a link that renders (`linked`, with its destination), or
 * in brackets that render as text (`unlinked`): a reference link whose label
 * has no definition, `ref` being that label.
 */
export interface HeadingVersion {
  version: string;
  link: "plain" | "linked" | "unlinked";
  href: string | null;
  ref: string | null;
  rest: string;
}

export function headingVersion(inline: Inline[]): HeadingVersion | null {
  const [head, ...tail] = inline;
  if (head?.k === "link") {
    const version = plain(head.inline).trim();
    return version
      ? {
          version,
          link: "linked",
          href: head.href,
          ref: null,
          rest: plain(tail),
        }
      : null;
  }
  const text = plain(inline);
  const bracket = /^\[([^[\]]+)\](?:\[([^[\]]*)\])?/.exec(text);
  if (bracket?.[1] !== undefined)
    return {
      version: bracket[1],
      link: "unlinked",
      href: null,
      ref: bracket[2]?.trim() ? bracket[2] : bracket[1],
      rest: text.slice(bracket[0].length),
    };
  const bare = /^([^\s[\]]+)([\s\S]*)$/.exec(text);
  return bare?.[1] === undefined
    ? null
    : {
        version: bare[1],
        link: "plain",
        href: null,
        ref: null,
        rest: bare[2] ?? "",
      };
}

/**
 * Whether a heading names the Unreleased section as it renders: a link whose
 * text is `Unreleased`, the same in brackets that render as text (escaped, or
 * a reference with no definition), or, where `bare` allows it, plain
 * `Unreleased`.
 */
export function isUnreleased(inline: Inline[], bare: boolean): boolean {
  const only = inline.length === 1 ? inline[0] : undefined;
  if (only?.k === "link")
    return /^unreleased$/i.test(plain(only.inline).trim());
  const shown = plain(inline).trim();
  return (
    /^\[Unreleased\](?:\[[^[\]]*\])?$/i.test(shown) ||
    (bare && /^Unreleased$/i.test(shown))
  );
}

/** What kind of block `b` is, as far as later lines cannot change it. */
const shape = (b: Block | undefined): string =>
  b === undefined
    ? ""
    : b.k === "heading"
      ? `h${b.level}`
      : b.k === "list"
        ? `list ${b.ordered}`
        : b.k === "other"
          ? b.kind
          : b.k;

/**
 * Whether a prefix of the file, rendered as `blocks`, holds the block (or
 * list item) `path` names in the whole file's `target`: the blocks before it
 * are those of the whole file, kind for kind, and it is there, of its kind.
 * Kinds, not contents: a definition later in the file may turn bracketed
 * text into a link. Matching the blocks before it keeps a block that shows
 * only in a prefix (an unfinished definition reads as a paragraph) from
 * standing in for it.
 */
function holds(blocks: Block[], target: Block[], path: number[]): boolean {
  const [index, item] = path as [number, number?];
  const block = blocks[index];
  if (!block || shape(block) !== shape(target[index])) return false;
  for (let i = 0; i < index; i++)
    if (shape(blocks[i]) !== shape(target[i])) return false;
  return (
    item === undefined || (block.k === "list" && block.items.length > item)
  );
}

/**
 * The first line whose prefix of the file renders the block `path` names: a
 * search over the file's prefixes, since the parser reports no positions. A
 * heading or table whose first lines render as a paragraph until its last
 * (a setext underline, a delimiter row) is found at that paragraph's start.
 */
function locate(lines: string[], target: Block[], path: number[]): number {
  const prefix = (n: number) => parseBlocks(lines.slice(0, n).join("\n"));
  let [lo, hi] = [1, lines.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (holds(prefix(mid), target, path)) hi = mid;
    else lo = mid + 1;
  }
  const [index, item] = path as [number, number?];
  if (item !== undefined || shape(target[index]) === "paragraph") return lo;
  const paragraph = { k: "paragraph", inline: [] } as Block;
  const swapped = target.map((b, i) => (i === index ? paragraph : b));
  while (lo > 1 && holds(prefix(lo - 1), swapped, [index])) lo--;
  return lo;
}

/**
 * The lines of the top-level headings of levels 1 to 3, by their index among
 * the blocks. A `#` heading line outside fenced code is its heading's line
 * when it renders as that heading: each such line is tagged with its number
 * and the tagged file parsed once, so a line inside an HTML comment, or one
 * that renders as something else, names no heading. A heading no line names
 * this way (a setext heading) is located.
 */
function headingLines(
  lines: string[],
  blocks: Block[],
  at: (path: number[]) => number,
): Map<number, number> {
  const written = fenced(lines.join("\n")).flatMap((l, i) => {
    const h = l.inFence ? null : heading(l.line);
    return h ? [i + 1] : [];
  });
  const tag = "";
  const tagged = [...lines];
  if (!lines.some((l) => l.includes(tag)))
    for (const n of written) tagged[n - 1] += ` ${tag}${n}${tag}`;
  const seen = parseBlocks(tagged.join("\n"));
  const lineOf = (index: number): number | null => {
    const b = seen[index];
    const want = blocks[index];
    if (seen.length !== blocks.length || b?.k !== "heading") return null;
    if (want?.k !== "heading" || b.level !== want.level) return null;
    const n = new RegExp(`${tag}(\\d+)${tag}`).exec(plain(b.inline))?.[1];
    return n === undefined ? null : Number(n);
  };
  return new Map(
    blocks.flatMap((b, index) =>
      b.k === "heading" && b.level <= 3
        ? [[index, lineOf(index) ?? at([index])] as const]
        : [],
    ),
  );
}

/** A heading's title as written on its line, else as it renders. */
function titleOn(lines: string[], line: number, inline: Inline[]): string {
  return heading(lines[line - 1] ?? "")?.title ?? plain(inline).trim();
}

/** The changelog at `file` read from `text`. */
export function readChangelog(file: string, text: string): Changelog {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = parseBlocks(lines.join("\n"));
  const located = new Map<string, number>();
  const at = (path: number[]): number => {
    const key = path.join(".");
    const found = located.get(key) ?? locate(lines, blocks, path);
    located.set(key, found);
    return found;
  };
  const headings = headingLines(lines, blocks, at);
  const firstLine = lines.findIndex((l) => l.trim() !== "");
  const changelog: Changelog = {
    file,
    lines,
    blocks,
    first: firstLine === -1 ? null : firstLine + 1,
    titles: [],
    preamble: [],
    sections: [],
    lineOf: (index, item) =>
      item === undefined
        ? (headings.get(index) ?? at([index]))
        : at([index, item]),
  };
  for (const [index, block] of blocks.entries()) place(changelog, block, index);
  return changelog;
}

/** Put the top-level block at `index` where it belongs: a title, a section or group, or the text under one. */
function place(changelog: Changelog, block: Block, index: number): void {
  if (block.k === "heading" && block.level <= 3) {
    placeHeading(changelog, block, index);
    return;
  }
  const section = changelog.sections.at(-1);
  const part = { block, index };
  if (section) (section.groups.at(-1)?.body ?? section.lead).push(part);
  else if (index > 0) changelog.preamble.push(part);
}

/** Put a heading of level 1 to 3 where it belongs: a title, a section, or a group. */
function placeHeading(
  changelog: Changelog,
  block: Block & { k: "heading" },
  index: number,
): void {
  const section = changelog.sections.at(-1);
  const line = changelog.lineOf(index);
  const h = {
    line,
    title: titleOn(changelog.lines, line, block.inline),
    inline: block.inline,
    index,
  };
  if (block.level === 1) changelog.titles.push(h);
  else if (block.level === 2)
    changelog.sections.push({ ...h, lead: [], groups: [] });
  else if (section) section.groups.push({ ...h, body: [] });
  else changelog.preamble.push({ block, index });
}

/** Whether the changelog's first block is a level-1 heading. */
export const opensWithTitle = (changelog: Changelog): boolean => {
  const first = changelog.blocks[0];
  return first?.k === "heading" && first.level === 1;
};

/**
 * Whether `date` is written year-month-day (`2024-01-31`) and names a day
 * that exists.
 */
export function isDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Date.UTC reads years 0 to 99 as 1900 to 1999; setUTCFullYear does not.
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  return (
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day
  );
}

/** A Semantic Versioning 2.0.0 version, from the specification's own expression. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const isSemver = (version: string): boolean => SEMVER.test(version);

/** Whether a version is stable: Semantic Versioning without a pre-release part. */
export const isStable = (version: string): boolean =>
  SEMVER.exec(version)?.[4] === undefined && isSemver(version);

/**
 * Two decimal numbers without leading zeros, by value: the longer is larger,
 * and of equal length the first to differ decides. Exact at any size, where
 * Number rounds past 2^53.
 */
function compareNumbers(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdentifiers(a: string, b: string): number {
  const [x, y] = [/^\d+$/.test(a), /^\d+$/.test(b)];
  if (x && y) return compareNumbers(a, b);
  if (x !== y) return x ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semantic Versioning precedence (its § 11): major, minor and patch as
 * numbers, a pre-release below its release, pre-release identifiers compared
 * one by one; build metadata does not count. Both must be valid versions.
 */
export function precedence(a: string, b: string): number {
  const [x, y] = [SEMVER.exec(a), SEMVER.exec(b)];
  if (!x || !y) throw new Defect(`not a semantic version: ${x ? b : a}`);
  const core = [1, 2, 3]
    .map((i) => compareNumbers(x[i] ?? "", y[i] ?? ""))
    .find((d) => d !== 0);
  return core ?? comparePrereleases(x[4], y[4]);
}

/** Two pre-release parts by precedence; a version without one ranks above one with. */
function comparePrereleases(p?: string, q?: string): number {
  if (p === undefined || q === undefined)
    return (p === undefined ? 1 : 0) - (q === undefined ? 1 : 0);
  const [ps, qs] = [p.split("."), q.split(".")];
  const length = Math.min(ps.length, qs.length);
  const differ = ps
    .slice(0, length)
    .map((id, i) => compareIdentifiers(id, qs[i] ?? ""))
    .find((d) => d !== 0);
  return differ ?? ps.length - qs.length;
}

/** A finding of `rule` at `line`, its remedy ending with where the format says so. */
export function finding(
  rule: Rule,
  changelog: Changelog,
  line: number,
  problem: string,
  remedy: string,
): Finding {
  return {
    rule: rule.id,
    file: changelog.file,
    line,
    problem,
    remedy: `${remedy} (${rule.section}: ${rule.url})`,
  };
}

/** What the coverage rule compares the changelog with. */
export interface Coverage {
  /** The version the version files hold; null where the version lives only in tags or cannot be read. */
  current: string | null;
  /** The repository's tags that name a version, as versions (the tag prefix removed). */
  tagged: string[];
}

/**
 * Each version of `wanted` the changelog has no section for, as a finding at
 * the first release heading (where a newer release goes), or past the end of
 * a file that has none.
 */
export function uncovered(
  rule: Rule,
  changelog: Changelog,
  released: Set<string>,
  wanted: { version: string; from: string }[],
): Finding[] {
  const at = changelog.sections[0]?.line ?? changelog.lines.length;
  const seen = new Set<string>();
  return wanted.flatMap(({ version, from }) => {
    if (released.has(version) || seen.has(version)) return [];
    seen.add(version);
    return [
      finding(
        rule,
        changelog,
        at,
        `${version}, which ${from}, has no release section`,
        `add a section for ${version}, in its place among the releases`,
      ),
    ];
  });
}
