/**
 * The evidence record's shape and what is read from it: the `verify`
 * settings, the counts from a run's JUnit report, whether a record vouches
 * for its run, the block that may travel, and lookup by tree and command.
 * `evidence.ts` runs the command and writes the record; see its header.
 */

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { errnoCode } from "./errors.ts";
import { decodeJson, isRecord } from "./guards.ts";
import { JunitReportError, parseJunitReport } from "./junit-report.ts";

export const DEFAULT_OUTPUT_LINES = 60;
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const DEFAULT_RETENTION_DAYS = 30;
/** The longest deadline a timer can hold: 2^31 - 1 milliseconds. */
export const MAX_TIMEOUT_MINUTES = 35_791;
/** The largest report read; a larger one is recorded as unreadable, never parsed. */
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const VERIFY_FIELDS = [
  "store",
  "output_lines",
  "timeout_minutes",
  "retention_days",
] as const;

/** A configuration or store problem the command line reports and exits on. */
export class EvidenceError extends Error {
  override name = "EvidenceError";
}

/** The `verify` section, resolved. */
export interface VerifySettings {
  store: string;
  outputLines: number;
  timeoutMinutes: number;
  /** Read and checked here; records past it are collected by the resource collection runner. */
  retentionDays: number;
}

export type Outcome =
  | "pass"
  | "fail"
  | "timed-out"
  | "could-not-start"
  | "killed-for-output"
  | "seen-to-fail"
  | "expectation-failed";

type CaseResult = "passed" | "failed" | "skipped";
interface CaseId {
  classname: string;
  name: string;
}

export interface ReportSummary {
  /** The report's path, relative to the repository root. */
  path: string;
  status: "read" | "no report" | "stale" | "unreadable";
  problem?: string;
  executed?: number;
  skipped?: number;
  suites?: {
    name: string;
    depth: number;
    run: number;
    skipped: number;
    /** A top-level suite that ran no case, as M14's skip tripwire marks it. */
    tripwire: boolean;
  }[];
  failed?: CaseId[];
  cases?: (CaseId & { result: CaseResult })[];
  /** The report ran no case, or a top-level suite in it ran none. */
  tripwire?: boolean;
  /** Where a report found at the path before the run was moved. */
  movedAside?: string;
}

export interface EvidenceRecord {
  schema: "jig-evidence/v1";
  id: string;
  repository: string;
  tree: string;
  /** The tree after the run; null when it could no longer be taken. */
  treeAfter: string | null;
  treeChanged: boolean;
  scope: string;
  command: { hash: string; display: string; argv: string[]; cwd: string };
  startedAt: string;
  endedAt: string;
  durationMs: number;
  timeoutMinutes: number;
  exit: number | null;
  signal: string | null;
  outcome: Outcome;
  expectFail: {
    case: string | null;
    met: boolean;
    reason: string;
    failedCases: string[];
  } | null;
  junit: ReportSummary | null;
  output: { lines: number; head: string[]; tail: string[]; file: string };
}

// ---------------------------------------------------------------- settings

function wholeNumber(
  value: unknown,
  field: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    const bound = max < Number.MAX_SAFE_INTEGER ? ` and ≤ ${max}` : "";
    throw new EvidenceError(
      `verify.${field} must be a whole number ≥ 1${bound}`,
    );
  }
  return value;
}

function storePath(value: unknown, root: string): string {
  if (value === undefined || value === null)
    return join(homedir(), ".local", "state", "jig", "evidence");
  if (typeof value !== "string" || value.trim() === "")
    throw new EvidenceError("verify.store must be a nonempty path");
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\"))
    return join(homedir(), value.slice(2));
  return resolve(root, value);
}

/**
 * The `verify` section of the merged configuration. A key it does not know
 * is refused, since a misspelt one would silently keep the default it was
 * written to change; the message opens with the field at fault.
 */
export function verifySettings(section: unknown, root: string): VerifySettings {
  if (section !== undefined && section !== null) {
    if (typeof section !== "object" || Array.isArray(section))
      throw new EvidenceError("verify must be a mapping");
    for (const key of Object.keys(section))
      if (!(VERIFY_FIELDS as readonly string[]).includes(key))
        throw new EvidenceError(
          `verify.${key} is not a field of verify (${VERIFY_FIELDS.join(", ")})`,
        );
  }
  const v = (section ?? {}) as Record<string, unknown>;
  return {
    store: storePath(v.store, root),
    outputLines: wholeNumber(
      v.output_lines,
      "output_lines",
      DEFAULT_OUTPUT_LINES,
    ),
    timeoutMinutes: wholeNumber(
      v.timeout_minutes,
      "timeout_minutes",
      DEFAULT_TIMEOUT_MINUTES,
      MAX_TIMEOUT_MINUTES,
    ),
    retentionDays: wholeNumber(
      v.retention_days,
      "retention_days",
      DEFAULT_RETENTION_DAYS,
    ),
  };
}

// ---------------------------------------------------------------- the report

const caseKey = (c: CaseId) => `${c.classname}::${c.name}`;

/** A report that was read: its counts per suite and each case's result. */
function summarize(text: string, path: string): ReportSummary {
  const report = parseJunitReport(text);
  const suites = report.suites.map((s) => ({
    name: s.name,
    depth: s.depth,
    run: s.executed,
    skipped: s.skipped,
    tripwire: s.depth === 0 && s.executed === 0,
  }));
  const skipped = report.cases.filter((c) => c.skipped).length;
  const executed = report.cases.length - skipped;
  return {
    path,
    status: "read",
    executed,
    skipped,
    suites,
    failed: report.cases
      .filter((c) => c.failed)
      .map(({ classname, name }) => ({ classname, name })),
    cases: report.cases.map((c) => ({
      classname: c.classname,
      name: c.name,
      result: c.failed ? "failed" : c.skipped ? "skipped" : "passed",
    })),
    tripwire: executed === 0 || suites.some((s) => s.tripwire),
  };
}

/**
 * The text of the file open on `fd`, or why it is not read: not a regular
 * file (a named pipe would block the read forever), larger than
 * `MAX_REPORT_BYTES`, or written before `startedMs`.
 */
function reportText(
  fd: number,
  startedMs: number,
): { text: string } | Pick<ReportSummary, "status" | "problem"> {
  const stat = fstatSync(fd);
  if (!stat.isFile())
    return { status: "unreadable", problem: "not a regular file" };
  if (stat.size > MAX_REPORT_BYTES)
    return {
      status: "unreadable",
      problem: `${stat.size} bytes, more than the ${MAX_REPORT_BYTES} read`,
    };
  if (stat.mtimeMs < Math.floor(startedMs / 1000) * 1000)
    return {
      status: "stale",
      problem: `written ${new Date(stat.mtimeMs).toISOString()}, before the run began`,
    };
  const text = readBounded(fd);
  return text === undefined
    ? {
        status: "unreadable",
        problem: `grew past the ${MAX_REPORT_BYTES} bytes read while it was read`,
      }
    : { text };
}

/**
 * The file open on `fd`, or undefined once more than `MAX_REPORT_BYTES` is
 * read: a writer the command left running can grow the file after its size
 * was checked, so the bound holds on the read itself.
 */
function readBounded(fd: number): string | undefined {
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(64 * 1024);
  for (let total = 0; ; ) {
    const n = readSync(fd, chunk, 0, chunk.length, null);
    if (n === 0) return Buffer.concat(chunks, total).toString("utf8");
    total += n;
    if (total > MAX_REPORT_BYTES) return undefined;
    chunks.push(Buffer.from(chunk.subarray(0, n)));
  }
}

/**
 * The report at `file`, read only when it is a regular file of bounded size
 * written after `startedMs`: its modification time at or after the start, to
 * the whole second a coarse file system keeps. The checks and the read are
 * of one open file, so the path cannot be swapped between them. `shown` is
 * the path the record names.
 */
export function readReport(
  file: string,
  shown: string,
  startedMs: number,
): ReportSummary {
  let read: ReturnType<typeof reportText>;
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    read = reportText(fd, startedMs);
  } catch (error) {
    if (errnoCode(error) === "ENOENT")
      return { path: shown, status: "no report" };
    return { path: shown, status: "unreadable", problem: String(error) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!("text" in read)) return { path: shown, ...read };
  try {
    return summarize(read.text, shown);
  } catch (error) {
    if (!(error instanceof JunitReportError)) throw error;
    return { path: shown, status: "unreadable", problem: error.message };
  }
}

// ---------------------------------------------------------------- outcome

/** What a finished child left, as `proc.ts`'s `run` reports it. */
interface Finished {
  code: number;
  signal?: string;
  timedOut: boolean;
  spawnFailed: boolean;
  bufferExceeded: boolean;
}

/** How the command ended, before any expectation is applied. */
function ended(r: Finished): Outcome {
  if (r.spawnFailed) return "could-not-start";
  if (r.timedOut) return "timed-out";
  if (r.bufferExceeded) return "killed-for-output";
  return r.code === 0 ? "pass" : "fail";
}

type Expectation = NonNullable<EvidenceRecord["expectFail"]>;

/** Whether every case named `wanted` failed in this run's report. */
function caseFailed(
  wanted: string,
  junit: ReportSummary | null,
  base: Omit<Expectation, "met" | "reason">,
): Expectation {
  const no = (reason: string) => ({ ...base, met: false, reason });
  if (junit?.status !== "read")
    return no(`the report gave no result (${junit?.status ?? "no report"})`);
  const named = (junit.cases ?? []).filter(
    (c) => c.name === wanted || caseKey(c) === wanted,
  );
  if (named.length === 0) return no(`no case ${wanted} in the report`);
  if (named.some((c) => c.result !== "failed"))
    return no(`case ${wanted} did not fail`);
  const failedCases = named.map(caseKey);
  return { ...base, failedCases, met: true, reason: `case ${wanted} failed` };
}

/**
 * Whether a run under `--expect-fail` failed as expected: a non-zero exit of
 * its own (a signal is no exit) and, when a case is named (its `name` or `<classname>::<name>`), every
 * case of that name failed in this run's report.
 */
function judgeExpectation(
  wanted: { case: string | null },
  outcome: Outcome,
  signal: string | null,
  junit: ReportSummary | null,
): Expectation {
  const failedCases = (junit?.failed ?? []).map(caseKey);
  const base = { case: wanted.case, failedCases };
  if (outcome === "pass")
    return { ...base, met: false, reason: "the command passed" };
  if (signal !== null)
    return {
      ...base,
      met: false,
      reason: `the command was ended by ${signal}, never exiting on its own`,
    };
  if (outcome !== "fail")
    return {
      ...base,
      met: false,
      reason: `the run ${outcome.replaceAll("-", " ")}`,
    };
  if (wanted.case === null)
    return { ...base, met: true, reason: "the command failed" };
  return caseFailed(wanted.case, junit, base);
}

/**
 * The outcome, exit code and expectation of a finished run. The exit code is
 * kept only where the child exited on its own: not where it never started,
 * was ended at the deadline or for its output, or by a signal.
 */
export function settle(
  r: Finished,
  expectFail: { case: string | null } | null,
  junit: ReportSummary | null,
): Pick<EvidenceRecord, "outcome" | "exit" | "signal" | "expectFail"> {
  const ran = ended(r);
  const exited = ran === "pass" || (ran === "fail" && !r.signal);
  const exit = exited ? r.code : null;
  const signal = r.signal ?? null;
  if (!expectFail) return { outcome: ran, exit, signal, expectFail: null };
  const judged = judgeExpectation(expectFail, ran, signal, junit);
  const outcome = judged.met ? "seen-to-fail" : "expectation-failed";
  return { outcome, exit, signal, expectFail: judged };
}

/**
 * Whether the record vouches for what its run asked, on a tree that did not
 * change and, when a report was named, from a fresh one: a pass whose report
 * failed no case and in which every top-level suite ran one, or with
 * `--expect-fail` a seen-to-fail.
 */
export function vouches(record: EvidenceRecord): boolean {
  if (record.treeChanged) return false;
  const junit = record.junit;
  if (junit && junit.status !== "read") return false;
  if (record.outcome === "seen-to-fail") return true;
  return (
    record.outcome === "pass" &&
    (junit === null || (junit.tripwire === false && junit.failed?.length === 0))
  );
}

// ---------------------------------------------------------------- the block

function duration(ms: number): string {
  if (ms < 9_950) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The report's counts. Suite and case names, and a parser's diagnostics,
 * come from the report and stay in the record: the block carries counts.
 */
function counts(junit: ReportSummary): string {
  if (junit.status !== "read") return `${junit.status} (junit: ${junit.path})`;
  const tripped = (junit.suites ?? []).filter((s) => s.tripwire).length;
  const failed = junit.failed?.length ? `, ${junit.failed.length} failed` : "";
  const trip = junit.tripwire
    ? `  ·  ran zero cases: ${tripped ? plural(tripped, "suite") : "the whole report"}`
    : "";
  return `${junit.executed} cases ran, ${junit.skipped} skipped${failed} (junit: ${junit.path})${trip}`;
}

/** The status words of an outcome other than a plain exit; names stay in the record. */
const STATUS: Partial<
  Record<Outcome, (record: EvidenceRecord, exit: string) => string>
> = {
  "timed-out": (r) => `timed out at ${r.timeoutMinutes}m`,
  "could-not-start": () => "could not start",
  "killed-for-output": () => "killed for too much output",
  "seen-to-fail": (r, exit) =>
    `${exit} (seen to fail: ${r.expectFail?.case === null ? "expected" : plural(r.expectFail?.failedCases.length ?? 0, "case")})`,
  "expectation-failed": (_r, exit) =>
    `${exit} (expected to fail: not met, the record says why)`,
};

function status(record: EvidenceRecord): string {
  const exit =
    record.exit === null
      ? `signal ${record.signal ?? "?"}`
      : `exit ${record.exit}`;
  return STATUS[record.outcome]?.(record, exit) ?? exit;
}

function underHome(path: string): string {
  const h = homedir();
  return path === h || path.startsWith(`${h}/`) || path.startsWith(`${h}\\`)
    ? `~${path.slice(h.length)}`
    : path;
}

/**
 * The block that may travel to a pull request or an issue: the tree, the
 * display name, the exit, the counts and where the record is. Never the
 * command's arguments or its output, which can carry credentials.
 */
export function formatBlock(
  record: EvidenceRecord,
  recordPath: string,
): string {
  const tree = record.treeChanged
    ? `tree ${record.tree.slice(0, 7)} -> ${record.treeAfter?.slice(0, 7) ?? "unknown"} (tree-changed: vouches for no tree)`
    : `tree ${record.tree.slice(0, 7)}`;
  const parts = [status(record), duration(record.durationMs)];
  if (record.junit) parts.push(counts(record.junit));
  return [
    `EVIDENCE  ${tree}  ${record.command.display}`,
    parts.join("  ·  "),
    `record ${underHome(recordPath)}`,
  ].join("\n");
}

// ---------------------------------------------------------------- lookup

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

const isString = (v: unknown): v is string => typeof v === "string";
const orNull =
  <T>(is: (v: unknown) => v is T) =>
  (v: unknown): v is T | null =>
    v === null || is(v);
const isNumber = (v: unknown): v is number => typeof v === "number";

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const arrayOf =
  <T>(is: (v: unknown) => v is T) =>
  (v: unknown): v is T[] =>
    Array.isArray(v) && v.every(is);
const STATUSES: readonly unknown[] = [
  "read",
  "no report",
  "stale",
  "unreadable",
];
const RESULTS: readonly unknown[] = ["passed", "failed", "skipped"];

const isCaseId = (v: unknown): v is CaseId =>
  isRecord(v) && isString(v.classname) && isString(v.name);
const isCase = (v: unknown): v is CaseId & { result: CaseResult } =>
  isCaseId(v) && RESULTS.includes((v as { result?: unknown }).result);
type Suite = NonNullable<ReportSummary["suites"]>[number];
const isSuite = (v: unknown): v is Suite =>
  isRecord(v) &&
  isString(v.name) &&
  isNumber(v.depth) &&
  isNumber(v.run) &&
  isNumber(v.skipped) &&
  v.tripwire === (v.depth === 0 && v.run === 0);

/**
 * A read report's counts, complete and agreeing with its cases as
 * `summarize` writes them: what `vouches` reads is never inferred from a
 * field that is missing.
 */
function isReadSummary(v: Record<string, unknown>): boolean {
  if (
    !isNumber(v.executed) ||
    !isNumber(v.skipped) ||
    !arrayOf(isSuite)(v.suites) ||
    !arrayOf(isCaseId)(v.failed) ||
    !arrayOf(isCase)(v.cases) ||
    !isBoolean(v.tripwire)
  )
    return false;
  const { cases, suites } = v;
  const count = (result: CaseResult) =>
    cases.filter((c) => c.result === result).length;
  return (
    v.skipped === count("skipped") &&
    v.executed === cases.length - count("skipped") &&
    v.failed.length === count("failed") &&
    v.tripwire === (v.executed === 0 || suites.some((s) => s.tripwire))
  );
}

function isReportSummary(value: unknown): value is ReportSummary {
  return (
    isRecord(value) &&
    isString(value.path) &&
    STATUSES.includes(value.status) &&
    (value.status !== "read" || isReadSummary(value))
  );
}

function isExpectation(value: unknown): value is Expectation {
  return (
    isRecord(value) &&
    orNull(isString)(value.case) &&
    typeof value.met === "boolean" &&
    isString(value.reason) &&
    Array.isArray(value.failedCases)
  );
}

/** Every field lookup, `vouches` and the block read, so a malformed record is refused by name. */
function isEvidenceRecord(value: unknown): value is EvidenceRecord {
  return (
    isRecord(value) &&
    value.schema === "jig-evidence/v1" &&
    isString(value.id) &&
    isString(value.tree) &&
    orNull(isString)(value.treeAfter) &&
    typeof value.treeChanged === "boolean" &&
    isString(value.startedAt) &&
    isNumber(value.durationMs) &&
    isNumber(value.timeoutMinutes) &&
    orNull(isNumber)(value.exit) &&
    orNull(isString)(value.signal) &&
    isString(value.outcome) &&
    orNull(isExpectation)(value.expectFail) &&
    orNull(isReportSummary)(value.junit) &&
    isRecord(value.command) &&
    isString(value.command.hash) &&
    isString(value.command.display)
  );
}

function readRecord(path: string): EvidenceRecord {
  return decodeJson(readFileSync(path, "utf8"), isEvidenceRecord, path);
}

function newestFirst(a: EvidenceRecord, b: EvidenceRecord): number {
  return b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id);
}

/** Every record of one tree and command directory, newest first. */
function runsIn(dir: string): { record: EvidenceRecord; path: string }[] {
  return entries(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ path: join(dir, f), record: readRecord(join(dir, f)) }))
    .sort((a, b) => newestFirst(a.record, b.record));
}

/**
 * The records under `repositoryDir` whose tree hash starts with `tree` and
 * whose command hash starts with `command`: per command the newest that
 * vouches for its run (`vouches`: never a failure, a timeout, a changed
 * tree or a missing report), or with `all` every record, newest first.
 */
export function lookup(
  repositoryDir: string,
  tree: string,
  options: { command?: string; all?: boolean } = {},
): { record: EvidenceRecord; path: string }[] {
  const found: { record: EvidenceRecord; path: string }[] = [];
  for (const t of entries(repositoryDir).filter((t) => t.startsWith(tree)))
    for (const c of entries(join(repositoryDir, t)).filter((c) =>
      c.startsWith(options.command ?? ""),
    )) {
      const runs = runsIn(join(repositoryDir, t, c));
      const kept = options.all
        ? runs
        : runs.filter((r) => vouches(r.record)).slice(0, 1);
      found.push(...kept);
    }
  return found.sort((a, b) => newestFirst(a.record, b.record));
}
