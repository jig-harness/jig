// The whole changelog as the format checks read it: its lines with their
// numbers, its title, the text before the first release, each `##` section
// with the `###` groups under it, and its link reference definitions. Headings
// inside fenced code blocks are examples, not structure. Shared by the rules
// of each format (lint-keep-a-changelog.ts, lint-common-changelog.ts) and the
// command (lint.ts).
import { Defect } from "../../../shared/errors.ts";
import { fenced, heading } from "./markdown-blocks.ts";

/**
 * A link reference definition on one line, as Markdown reads one: up to three
 * spaces of indentation, the label, a colon, the destination (bare or in angle
 * brackets) and an optional title in double quotes, single quotes or
 * parentheses.
 */
const DEFINITION =
  /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;

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

/** A line of the changelog, numbered from 1. */
export interface Line {
  n: number;
  text: string;
  inFence: boolean;
  /** Whether the line opens or closes its fenced code block. */
  delimiter: "open" | "close" | null;
}

/** A `###` heading and the lines under it, up to the next heading of level 3 or less. */
export interface Group {
  line: number;
  title: string;
  body: Line[];
}

/** A `##` heading and what follows it, up to the next heading of level 2 or less. */
export interface Section {
  line: number;
  title: string;
  /** The lines before the first `###` heading. */
  lead: Line[];
  groups: Group[];
}

export interface Changelog {
  file: string;
  lines: Line[];
  /** The first non-blank line, when the file has one. */
  first: Line | null;
  /** The level-1 headings, in order. */
  titles: Line[];
  /** The lines between the first line and the first `##` heading. */
  preamble: Line[];
  sections: Section[];
  /** Link reference definitions by label, matched without regard to case or spacing as Markdown matches them. */
  definitions: Map<string, { line: number; url: string }>;
}

/** A link label as Markdown matches it: case-folded, inner whitespace collapsed. */
export const label = (text: string): string =>
  text.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The version a release heading opens with and the text after it. The version
 * is plain (`1.0.0`) or a link: inline (`[1.0.0](https://…)`), full reference
 * (`[1.0.0][release]`), collapsed (`[1.0.0][]`) or shortcut (`[1.0.0]`); `ref`
 * is the label a reference link needs a definition for, null for the others.
 */
export interface HeadingVersion {
  version: string;
  link: "plain" | "inline" | "reference";
  ref: string | null;
  rest: string;
}

export function headingVersion(title: string): HeadingVersion | null {
  const linked =
    /^\[([^\]]+)\](?:\((?:<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)|\[([^\]]*)\])?(.*)$/.exec(
      title,
    );
  if (linked?.[1] !== undefined) {
    const [whole, version, ref, rest] = linked;
    const inline = whole.slice(version.length + 2).startsWith("(");
    return inline
      ? { version, link: "inline", ref: null, rest: rest ?? "" }
      : {
          version,
          link: "reference",
          ref: ref ? ref : version,
          rest: rest ?? "",
        };
  }
  const plain = /^([^\s[\]]+)(.*)$/.exec(title);
  return plain?.[1] === undefined
    ? null
    : { version: plain[1], link: "plain", ref: null, rest: plain[2] ?? "" };
}

/** Whether a line is a link reference definition, which renders as nothing. */
export const isDefinition = (line: Line): boolean =>
  !line.inFence && DEFINITION.test(line.text);

/** The lines that render: not blank, not a link reference definition. */
export const content = (lines: Line[]): Line[] =>
  lines.filter((l) => l.text.trim() !== "" && !isDefinition(l));

/** The link reference definitions of `lines`, the first of each label winning as in Markdown. */
function definitionsOf(lines: Line[]): Changelog["definitions"] {
  const definitions: Changelog["definitions"] = new Map();
  for (const line of lines) {
    const match = line.inFence ? null : DEFINITION.exec(line.text);
    const [, name, destination] = match ?? [];
    const url = destination?.replace(/^<(.*)>$/, "$1");
    if (name && url !== undefined && !definitions.has(label(name)))
      definitions.set(label(name), { line: line.n, url });
  }
  return definitions;
}

/** Where a line goes when it is a heading of level 1 or 2: a title, or a new section. */
function placeTop(
  changelog: Changelog,
  line: Line,
  level: number,
  title: string,
): void {
  if (level === 1) changelog.titles.push(line);
  else changelog.sections.push({ line: line.n, title, lead: [], groups: [] });
}

/** Where a line under a section goes: a new group, or the text of the group or lead it is in. */
function placeUnder(
  section: Section,
  line: Line,
  groupTitle: string | null,
): void {
  if (groupTitle !== null)
    section.groups.push({ line: line.n, title: groupTitle, body: [] });
  else (section.groups.at(-1)?.body ?? section.lead).push(line);
}

/** Put `line` where it belongs: a title, a section or group heading, or the text under one. */
function place(changelog: Changelog, line: Line): void {
  const h = line.inFence ? null : heading(line.text);
  const section = changelog.sections.at(-1);
  if (h !== null && h.level <= 2) placeTop(changelog, line, h.level, h.title);
  else if (section) placeUnder(section, line, h?.level === 3 ? h.title : null);
  else if (line !== changelog.first) changelog.preamble.push(line);
}

/** The changelog at `file` read from `text`. */
export function readChangelog(file: string, text: string): Changelog {
  const lines: Line[] = fenced(text.replace(/\r\n/g, "\n")).map((l, i) => ({
    n: i + 1,
    text: l.line,
    inFence: l.inFence,
    delimiter: l.delimiter,
  }));
  const changelog: Changelog = {
    file,
    lines,
    first: lines.find((l) => l.text.trim() !== "") ?? null,
    titles: [],
    preamble: [],
    sections: [],
    definitions: definitionsOf(lines),
  };
  for (const line of lines) place(changelog, line);
  return changelog;
}

/** Text split into the runs of lines between blank lines. */
export function paragraphs(lines: Line[]): Line[][] {
  const runs: Line[][] = [[]];
  for (const line of lines) {
    if (isDefinition(line)) continue;
    if (line.text.trim() === "") runs.push([]);
    else runs.at(-1)?.push(line);
  }
  return runs.filter((run) => run.length > 0);
}

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
