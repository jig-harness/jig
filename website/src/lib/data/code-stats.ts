/**
 * Jig's own code statistics, for the `/stats/` page: the `code-stats/v1`
 * JSON report of the code-stats skill, run by the site's build on the
 * commit it builds. Nothing is committed: the build counts the checkout it
 * has, so the page always describes the commit it was built from.
 *
 * The build fails closed. A run that exits non-zero, prints something other
 * than JSON, or reports a schema other than `code-stats/v1` throws, so the
 * site is never deployed with an empty or stale report.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** The skill's script, by its path from the repository root. */
export const CODE_STATS_SCRIPT =
  "plugin/skills/code-stats/scripts/code-stats.ts";

/** The report could not be made or is not one this page renders. */
class CodeStatsReportError extends Error {
  override name = "CodeStatsReportError";
}

/** The one report shape this page renders. */
const SCHEMA = "code-stats/v1";

/** One group's counts: files, bytes, all lines, LOC, comment and blank lines. */
export interface Bucket {
  files: number;
  bytes: number;
  raw: number;
  code: number;
  comment: number;
  blank: number;
}

export interface Area {
  name: string;
  description: string;
  default: boolean;
}

/** The fields of a `code-stats/v1` report the page shows. */
export interface CodeStats {
  generatedAt: string;
  repository: string;
  commit: string;
  totals: {
    files: number;
    bytes: number;
    rawLines: number;
    codeLines: number;
    commentLines: number;
    blankLines: number;
  };
  unclassified: {
    files: number;
    codeLines: number;
    filesShare: number;
    codeShare: number;
  };
  vendored: { included: boolean; excludedFiles: number; excludedBytes: number };
  areas: Area[];
  byArea: Record<string, Bucket>;
  byKind: Record<string, Bucket>;
  byLanguage: Record<string, Bucket>;
  byModule: Record<string, Bucket>;
  byAreaKind: Record<string, Bucket>;
}

/** What one run of the script gave back. */
export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Runs the skill's script with `--json` on the repository at `root`. */
export function runCodeStats(root: string): Run {
  const bun = process.versions.bun ? process.execPath : "bun";
  const res = spawnSync(bun, [join(root, CODE_STATS_SCRIPT), "--json"], {
    cwd: root,
    env: { ...process.env, JIG_CONSUMER_ROOT: root, NO_COLOR: "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error,
  };
}

/** The report a run printed; throws when the run failed or printed no report. */
export function reportOf(run: Run): CodeStats {
  if (run.error || run.status !== 0)
    throw new CodeStatsReportError(
      `code-stats: ${CODE_STATS_SCRIPT} --json failed (${run.error?.message ?? `exit ${run.status}`}): ${run.stderr.trim()}`,
    );
  return parseCodeStats(run.stdout);
}

/**
 * A `code-stats/v1` report, checked field by field; throws on anything else,
 * naming the first field that does not fit.
 */
export function parseCodeStats(text: string): CodeStats {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new CodeStatsReportError(
      `code-stats: the report is not JSON: ${(e as Error).message}`,
    );
  }
  const r = record(value, "the report");
  if (r.schema !== SCHEMA)
    throw new CodeStatsReportError(
      `code-stats: schema ${JSON.stringify(r.schema)}, expected "${SCHEMA}"`,
    );
  const totals = record(r.totals, "totals");
  const unclassified = record(r.unclassified, "unclassified");
  const vendored = record(r.vendored, "vendored");
  if (typeof vendored.included !== "boolean")
    throw new CodeStatsReportError(
      "code-stats: vendored.included is not a boolean",
    );
  if (!Array.isArray(r.areas))
    throw new CodeStatsReportError("code-stats: areas is not a list");
  const report: CodeStats = {
    generatedAt: text_(r.generatedAt, "generatedAt"),
    repository: text_(r.repository, "repository"),
    commit: text_(r.commit, "commit"),
    totals: {
      files: count(totals.files, "totals.files"),
      bytes: count(totals.bytes, "totals.bytes"),
      rawLines: count(totals.rawLines, "totals.rawLines"),
      codeLines: count(totals.codeLines, "totals.codeLines"),
      commentLines: count(totals.commentLines, "totals.commentLines"),
      blankLines: count(totals.blankLines, "totals.blankLines"),
    },
    unclassified: {
      files: count(unclassified.files, "unclassified.files"),
      codeLines: count(unclassified.codeLines, "unclassified.codeLines"),
      filesShare: fraction(unclassified.filesShare, "unclassified.filesShare"),
      codeShare: fraction(unclassified.codeShare, "unclassified.codeShare"),
    },
    vendored: {
      included: vendored.included,
      excludedFiles: count(vendored.excludedFiles, "vendored.excludedFiles"),
      excludedBytes: count(vendored.excludedBytes, "vendored.excludedBytes"),
    },
    areas: r.areas.map((a, i) => {
      const area = record(a, `areas[${i}]`);
      if (typeof area.default !== "boolean")
        throw new CodeStatsReportError(
          `code-stats: areas[${i}].default is not a boolean`,
        );
      return {
        name: text_(area.name, `areas[${i}].name`),
        description: text_(area.description, `areas[${i}].description`),
        default: area.default,
      };
    }),
    byArea: buckets(r.byArea, "byArea"),
    byKind: buckets(r.byKind, "byKind"),
    byLanguage: buckets(r.byLanguage, "byLanguage"),
    byModule: buckets(r.byModule, "byModule"),
    byAreaKind: buckets(r.byAreaKind, "byAreaKind"),
  };
  if (Object.keys(report.byModule).length === 0 || report.totals.files === 0)
    throw new CodeStatsReportError("code-stats: the report counts no files");
  if (report.areas.filter((a) => a.default).length !== 1)
    throw new CodeStatsReportError(
      "code-stats: the report names no single default area",
    );
  return report;
}

function record(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new CodeStatsReportError(`code-stats: ${what} is not an object`);
  return v as Record<string, unknown>;
}

function text_(v: unknown, what: string): string {
  if (typeof v !== "string")
    throw new CodeStatsReportError(`code-stats: ${what} is not a string`);
  return v;
}

function count(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
    throw new CodeStatsReportError(`code-stats: ${what} is not a count`);
  return v;
}

function fraction(v: unknown, what: string): number {
  if (typeof v !== "number" || !(v >= 0 && v <= 1))
    throw new CodeStatsReportError(
      `code-stats: ${what} is not a fraction from 0 to 1`,
    );
  return v;
}

const BUCKET_FIELDS = [
  "files",
  "bytes",
  "raw",
  "code",
  "comment",
  "blank",
] as const;

function buckets(v: unknown, what: string): Record<string, Bucket> {
  const out: Record<string, Bucket> = {};
  for (const [name, b] of Object.entries(record(v, what))) {
    const bucket = record(b, `${what}.${name}`);
    out[name] = Object.fromEntries(
      BUCKET_FIELDS.map((f) => [f, count(bucket[f], `${what}.${name}.${f}`)]),
    ) as unknown as Bucket;
  }
  return out;
}

/** The commit without the `-dirty` mark, and whether the tree had changes. */
export function commitOf(report: CodeStats): { sha: string; dirty: boolean } {
  const dirty = report.commit.endsWith("-dirty");
  return {
    sha: dirty ? report.commit.slice(0, -"-dirty".length) : report.commit,
    dirty,
  };
}

/**
 * The default area's test LOC beside its code LOC, and their ratio, as the
 * skill's terminal summary states it. The ratio is 0 when there is no code.
 */
export function testToCode(report: CodeStats): {
  area: string;
  code: number;
  test: number;
  ratio: number;
} {
  const area = report.areas.find((a) => a.default)?.name ?? "";
  const code = report.byAreaKind[`${area}/code`]?.code ?? 0;
  const test = report.byAreaKind[`${area}/test`]?.code ?? 0;
  return { area, code, test, ratio: code > 0 ? test / code : 0 };
}

/** One row of an area's table: its counts and its code and test LOC. */
export interface AreaRow extends Area, Bucket {
  codeLoc: number;
  testLoc: number;
}

/** The areas in their rule order, each with its counts; an area with no files has zeros. */
export function areaRows(report: CodeStats): AreaRow[] {
  return report.areas.map((a) => ({
    ...a,
    ...(report.byArea[a.name] ?? empty()),
    codeLoc: report.byAreaKind[`${a.name}/code`]?.code ?? 0,
    testLoc: report.byAreaKind[`${a.name}/test`]?.code ?? 0,
  }));
}

export interface Named extends Bucket {
  name: string;
}

/** A group's buckets in the report's order. */
export function rows(group: Record<string, Bucket>): Named[] {
  return Object.entries(group).map(([name, b]) => ({ name, ...b }));
}

/** Buckets by LOC, most first, then by name. */
function byLoc(list: Named[]): Named[] {
  return [...list].sort(
    (a, b) => b.code - a.code || a.name.localeCompare(b.name),
  );
}

/**
 * The languages by LOC, the first `top` named and the rest summed into one
 * row, so the table stays short whatever a repository holds. A language with
 * no LOC (a binary format) is left out of the named rows and of the sum.
 */
export function topLanguages(
  report: CodeStats,
  top: number,
): { named: Named[]; rest: (Bucket & { languages: number }) | null } {
  const counted = byLoc(rows(report.byLanguage)).filter((l) => l.code > 0);
  const tail = counted.slice(top);
  if (tail.length === 0) return { named: counted, rest: null };
  const rest = { ...empty(), languages: tail.length };
  for (const l of tail) for (const f of BUCKET_FIELDS) rest[f] += l[f];
  return { named: counted.slice(0, top), rest };
}

/** A module, the folder that holds it, and the module's own name. */
export interface ModuleRow extends Named {
  /** `plugin/skills` for `plugin/skills/audit`; empty for a top-level folder. */
  parent: string;
  /** `audit` for `plugin/skills/audit`. */
  leaf: string;
}

/** The repository root's own files, as the report names their module. */
export const ROOT_MODULE = "<root>";

/** The modules by LOC, each split into its parent folder and its own name. */
export function moduleRows(report: CodeStats): ModuleRow[] {
  return byLoc(rows(report.byModule)).map((m) => {
    const at = m.name.lastIndexOf("/");
    return {
      ...m,
      parent: at < 0 ? "" : m.name.slice(0, at),
      leaf: at < 0 ? m.name : m.name.slice(at + 1),
    };
  });
}

/**
 * The site's page for a module, when it has one: a skill's page, or a
 * practice module's, by the folder the module is.
 */
export function moduleHref(
  name: string,
  pages: { skills: ReadonlySet<string>; modules: ReadonlyMap<string, string> },
): string | undefined {
  const skill = /^plugin\/skills\/([^/]+)$/.exec(name)?.[1];
  if (skill && pages.skills.has(skill)) return `/skills/${skill}/`;
  const id = pages.modules.get(name);
  return id ? `/modules/${id}/` : undefined;
}

/** The folders that hold modules, by the LOC of their modules, most first. */
export function moduleParents(
  list: ModuleRow[],
): { parent: string; modules: number; code: number }[] {
  const by = new Map<
    string,
    { parent: string; modules: number; code: number }
  >();
  for (const m of list) {
    const p = by.get(m.parent) ?? { parent: m.parent, modules: 0, code: 0 };
    p.modules++;
    p.code += m.code;
    by.set(m.parent, p);
  }
  return [...by.values()].sort(
    (a, b) => b.code - a.code || a.parent.localeCompare(b.parent),
  );
}

function empty(): Bucket {
  return { files: 0, bytes: 0, raw: 0, code: 0, comment: 0, blank: 0 };
}

/** A share as a whole-number percentage, or one decimal under 10%, `<0.1%` above 0. */
export function percent(part: number, whole: number): string {
  if (whole === 0 || part === 0) return "0%";
  const p = (part / whole) * 100;
  if (p < 0.1) return "<0.1%";
  return p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

const NUMBER = new Intl.NumberFormat("en-GB");

/** A count with thousands separators. */
export const fmt = (n: number): string => NUMBER.format(n);

/** A size in bytes, in the skill's units: B, KB, MB, GB at 1,024 each. */
export function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${v} B` : `${v.toFixed(1)} ${units[u]}`;
}
