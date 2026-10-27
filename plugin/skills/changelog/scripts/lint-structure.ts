// The whole changelog as the format checks read it: its lines with their
// numbers, its title, the text before the first release, each `##` section
// with the `###` groups under it, and its link reference definitions. Headings
// inside fenced code blocks are examples, not structure. Shared by the rules
// of each format (lint-keep-a-changelog.ts, lint-common-changelog.ts) and the
// command (lint.ts).
import { Defect } from "../../../shared/errors.ts";
import { fenced, heading, LINK_REF } from "./markdown-blocks.ts";

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

/** Whether a line is a link reference definition, which renders as nothing. */
export const isDefinition = (line: Line): boolean =>
  !line.inFence && LINK_REF.test(line.text);

/** The lines that render: not blank, not a link reference definition. */
export const content = (lines: Line[]): Line[] =>
  lines.filter((l) => l.text.trim() !== "" && !isDefinition(l));

/** The changelog at `file` read from `text`. */
export function readChangelog(file: string, text: string): Changelog {
  const lines: Line[] = fenced(text.replace(/\r\n/g, "\n")).map((l, i) => ({
    n: i + 1,
    text: l.line,
    inFence: l.inFence,
  }));
  const first = lines.find((l) => l.text.trim() !== "") ?? null;
  const titles: Line[] = [];
  const preamble: Line[] = [];
  const sections: Section[] = [];
  const definitions = new Map<string, { line: number; url: string }>();
  for (const line of lines) {
    const match = line.inFence ? null : LINK_REF.exec(line.text);
    if (match?.[1] && match[2] && !definitions.has(label(match[1])))
      definitions.set(label(match[1]), { line: line.n, url: match[2] });
    const h = line.inFence ? null : heading(line.text);
    const section = sections.at(-1);
    if (h?.level === 1) titles.push(line);
    if (h !== null && h.level <= 2) {
      if (h.level === 2)
        sections.push({ line: line.n, title: h.title, lead: [], groups: [] });
      continue;
    }
    if (h?.level === 3 && section) {
      section.groups.push({ line: line.n, title: h.title, body: [] });
      continue;
    }
    if (!section) {
      if (line !== first) preamble.push(line);
      continue;
    }
    (section.groups.at(-1)?.body ?? section.lead).push(line);
  }
  return { file, lines, first, titles, preamble, sections, definitions };
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
  const at = new Date(Date.UTC(year, month - 1, day));
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

function compareIdentifiers(a: string, b: string): number {
  const [x, y] = [/^\d+$/.test(a), /^\d+$/.test(b)];
  if (x && y) return Number(a) - Number(b);
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
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d;
  }
  const [p, q] = [x[4], y[4]];
  if (p === undefined || q === undefined)
    return p === q ? 0 : p === undefined ? 1 : -1;
  const [ps, qs] = [p.split("."), q.split(".")];
  for (let i = 0; i < Math.min(ps.length, qs.length); i++) {
    const d = compareIdentifiers(ps[i] ?? "", qs[i] ?? "");
    if (d) return d;
  }
  return ps.length - qs.length;
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
