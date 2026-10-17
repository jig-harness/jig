#!/usr/bin/env bun
// Heartbeat classifier: is each scheduled job still running, and how did its
// last runs end?
//
// A scheduled workflow that has stopped running shows its last result forever,
// and the last result of a job that quietly stopped is usually green. So the
// question is asked of the clock as well as of the outcome: every scheduled
// job declares the cadence it is expected to produce a result at (a cadence
// registry, see ../../templates/scheduled-jobs.yaml), and this script puts each
// job in one class from that registry, a run history and the time now.
//
//   green     the last result is a success, and recent enough
//   degraded  the last results failed, but fewer in a row than the job's red_after
//   red       red_after or more failures in a row
//   stale     no result inside the cadence plus grace: the job stopped running,
//             was disabled, only ever got cancelled, or has never run
//   running   a run is in progress and the job was otherwise green or degraded
//
// Stale is never green. A watcher exits non-zero for a red or stale job, so
// "it stopped running" and "it failed" both raise the alarm.
//
// Run history: a JSON array, one object per run, collected from the CI
// provider's run list (mappings.md has a collector per provider):
//   { "job": "nightly", "id": "8812", "status": "success", "startedAt": "...Z", "finishedAt": "...Z" }
// `id` is the provider's run identifier; one run listed twice for a job is an
// input error, since it would count one failure twice. `status` is success,
// failure, running, cancelled or skipped. A provider's
// timed-out run is a failure. A cancelled or skipped run produced no result:
// it is neither a success nor a failure, and it neither resets nor extends a
// streak of failures. Results that finish at the same instant are ordered
// failure first, so the classification never depends on the input's order and
// an ambiguous tie reads as the failure. A run still `running` after the job's max_run is hung and
// counts as no run. Timestamps are ISO 8601 with a `Z` or an offset, and must
// name a real calendar date and time. Jobs in
// the history that the registry does not declare are listed and ignored.
//
// Cadence registry: YAML, an optional `version: 1`, and `jobs:` a list of
//   id         the name the history uses for the job (required, unique)
//   cadence    how often the job must produce a result: 30m, 12h, 7d (required)
//   grace      lateness tolerated before the job is stale; default a quarter of
//              the cadence, since a provider starts scheduled runs late and
//              sometimes drops one
//   max_run    how long a run may be in progress before it counts as hung;
//              default 6h
//   red_after  consecutive failures that make the job red; default 1
//   watcher    true for the job that runs this script: it is declared, so the
//              coverage check accepts its schedule, but it is not classified,
//              since its own failed run would keep it red after the cause is
//              gone; the external monitor watches it. Default false.
//   description  free text for a person reading the registry
//
// Fail closed. A registry that is missing, unreadable, empty or holds a field
// of another shape, a history that is not a JSON array of well-formed runs, a
// run with a timestamp more than five minutes in the future, or a bad option
// exits 2: an input the script cannot trust is never a pass. A declared job
// with no run in the history is stale; an empty history is therefore a stale
// job per declared job, which is what a failed collection should look like. A
// history that no longer reaches back past a streak of failures counts only the
// failures it holds.
//
// Exit codes: 0 every job is green, degraded or running, 1 a job is red or
// stale, 2 usage or input error.
//
// Usage:
//   classify-heartbeat.ts --registry <file> --history <file|-> [--now <time>] [--json]
// Every option is long-form and strict. `--now` pins the clock for a test or a
// replay and defaults to the current time.
import { readFileSync } from "node:fs";
import { cli, strictOptions } from "../../../../lib/cli.ts";
import { readYaml } from "../../../../lib/workflows.ts";

export type HeartbeatClass = "green" | "degraded" | "red" | "stale" | "running";

export interface Job {
  id: string;
  cadenceMs: number;
  graceMs: number;
  maxRunMs: number;
  redAfter: number;
  /** The job that runs the classifier: declared, not classified. */
  watcher: boolean;
}

export type RunStatus =
  | "success"
  | "failure"
  | "running"
  | "cancelled"
  | "skipped";

export interface Run {
  job: string;
  /** The provider's run identifier, unique per job. */
  id: string;
  status: RunStatus;
  startedMs: number;
  /** Set for a success or a failure, the runs that produced a result. */
  finishedMs: number | undefined;
}

export interface JobResult {
  id: string;
  class: HeartbeatClass;
  reason: string;
  consecutiveFailures: number;
  /** The newest success or failure, as ISO time, or null when there is none. */
  lastResultAt: string | null;
  lastResult: "success" | "failure" | null;
  ageMs: number | null;
}

const usage =
  "usage: classify-heartbeat.ts --registry <file> --history <file|-> [--now <time>] [--json]";

const DURATION = /^([1-9][0-9]{0,5})(m|h|d)$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const MAX_DURATION_MS = 366 * UNIT_MS.d;
const TIME =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?(Z|[+-]([0-9]{2}):([0-9]{2}))$/;
/** Clock skew between a runner and the watcher that a timestamp may show. */
const SKEW_MS = 5 * UNIT_MS.m;
const STATUSES: readonly string[] = [
  "success",
  "failure",
  "running",
  "cancelled",
  "skipped",
];
const JOB_KEYS = [
  "id",
  "cadence",
  "grace",
  "max_run",
  "red_after",
  "watcher",
  "description",
];
const DEFAULT_MAX_RUN_MS = 6 * UNIT_MS.h;

/** A registry, history or workflow folder that cannot be read or is malformed. */
export class HeartbeatInputError extends Error {
  override readonly name = "HeartbeatInputError";
}

/** A duration such as `90m`, `12h` or `7d` in milliseconds; throw on any other text. */
export function parseDuration(value: unknown, where: string): number {
  const match = typeof value === "string" ? DURATION.exec(value) : null;
  if (match === null)
    throw new HeartbeatInputError(
      `${where} must be a duration such as 30m, 12h or 7d, not ${JSON.stringify(value)}`,
    );
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  if (ms > MAX_DURATION_MS)
    throw new HeartbeatInputError(
      `${where} is longer than a year: ${String(value)}`,
    );
  return ms;
}

/**
 * The days in a month of the proleptic Gregorian calendar, computed from the
 * year as written: `Date.UTC` would read a year below 100 as 1900 plus it.
 */
function monthLength(year: number, month: number): number {
  if (month !== 2) return [4, 6, 9, 11].includes(month) ? 30 : 31;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return leap ? 29 : 28;
}

/** An ISO 8601 time with a zone in epoch milliseconds; throw on any other text. */
export function parseTime(value: unknown, where: string): number {
  const match = typeof value === "string" ? TIME.exec(value) : null;
  if (match === null)
    throw new HeartbeatInputError(
      `${where} must be an ISO 8601 time with Z or an offset, not ${JSON.stringify(value)}`,
    );
  // Date.parse rolls an impossible date over (February 30 becomes March 2), so
  // the components are checked before it runs.
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const daysInMonth = monthLength(year, month);
  const real =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (match[9] === undefined ||
      (Number(match[9]) <= 23 && Number(match[10]) <= 59));
  const ms = Date.parse(match[0]);
  if (!real || Number.isNaN(ms))
    throw new HeartbeatInputError(`${where} is not a real time: ${match[0]}`);
  return ms;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new HeartbeatInputError(`${where} must be a mapping`);
  return value as Record<string, unknown>;
}

function optionalDuration(
  value: unknown,
  fallback: number,
  where: string,
): number {
  return value === undefined ? fallback : parseDuration(value, where);
}

/** The optional fields that carry no duration: red_after, watcher, description. */
function checkPlainFields(fields: Record<string, unknown>, where: string) {
  const redAfter = fields.red_after === undefined ? 1 : fields.red_after;
  if (!Number.isInteger(redAfter) || (redAfter as number) < 1)
    throw new HeartbeatInputError(
      `${where}.red_after must be an integer of 1 or more`,
    );
  if (fields.watcher !== undefined && typeof fields.watcher !== "boolean")
    throw new HeartbeatInputError(`${where}.watcher must be true or false`);
  if (
    fields.description !== undefined &&
    typeof fields.description !== "string"
  )
    throw new HeartbeatInputError(`${where}.description must be text`);
  return { redAfter: redAfter as number, watcher: fields.watcher === true };
}

/** One job of the registry; throw when a field is unknown or of another shape. */
function parseJob(item: unknown, where: string): Job {
  const fields = record(item, where);
  for (const key of Object.keys(fields))
    if (!JOB_KEYS.includes(key))
      throw new HeartbeatInputError(`${where}: unknown field '${key}'`);
  const id = fields.id;
  if (typeof id !== "string" || id.trim() === "")
    throw new HeartbeatInputError(`${where}: 'id' must be a non-empty string`);
  if (fields.cadence === undefined)
    throw new HeartbeatInputError(`${where}: job '${id}' has no 'cadence'`);
  const cadenceMs = parseDuration(fields.cadence, `${where}.cadence`);
  return {
    id,
    cadenceMs,
    graceMs: optionalDuration(
      fields.grace,
      Math.ceil(cadenceMs / 4),
      `${where}.grace`,
    ),
    maxRunMs: optionalDuration(
      fields.max_run,
      DEFAULT_MAX_RUN_MS,
      `${where}.max_run`,
    ),
    ...checkPlainFields(fields, where),
  };
}

/** The jobs of a parsed cadence registry; throw when it declares none or one is malformed. */
export function parseRegistry(doc: unknown, path: string): Job[] {
  const root = record(doc, path);
  for (const key of Object.keys(root))
    if (key !== "version" && key !== "jobs")
      throw new HeartbeatInputError(`${path}: unknown top-level key '${key}'`);
  if (root.version !== undefined && root.version !== 1)
    throw new HeartbeatInputError(
      `${path}: 'version' must be 1, the only registry version this script reads, not ${JSON.stringify(root.version)}`,
    );
  const list = root.jobs;
  if (!Array.isArray(list) || list.length === 0)
    throw new HeartbeatInputError(
      `${path}: 'jobs:' must list at least one job (a registry that declares nothing watches nothing)`,
    );
  const seen = new Set<string>();
  const jobs = list.map((item, index) => {
    const job = parseJob(item, `${path}: jobs[${index}]`);
    if (seen.has(job.id))
      throw new HeartbeatInputError(
        `${path}: jobs[${index}]: job '${job.id}' is declared twice`,
      );
    seen.add(job.id);
    return job;
  });
  if (jobs.every((job) => job.watcher))
    throw new HeartbeatInputError(
      `${path}: every job is the watcher, so nothing is left to classify`,
    );
  return jobs;
}

/** The runs of a history file's text; throw unless it is a JSON array of well-formed runs. */
export function parseHistory(text: string, now: number): Run[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HeartbeatInputError(
      "the history is not JSON: a failed collection leaves an empty or partial file",
    );
  }
  if (!Array.isArray(parsed))
    throw new HeartbeatInputError("the history must be a JSON array of runs");
  const seen = new Set<string>();
  return parsed.map((item, index) => {
    const where = `history[${index}]`;
    const run = parseRun(item, where, now);
    const key = JSON.stringify([run.job, run.id]);
    if (seen.has(key))
      throw new HeartbeatInputError(
        `${where} repeats run '${run.id}' of job '${run.job}': one run listed twice would be counted twice`,
      );
    seen.add(key);
    return run;
  });
}

function runId(value: unknown, where: string): string {
  const text = typeof value === "string" && value !== "";
  const whole = Number.isSafeInteger(value) && (value as number) >= 0;
  if (!text && !whole)
    throw new HeartbeatInputError(
      `${where}.id must be the provider's run identifier, a non-empty string or a whole number`,
    );
  return String(value);
}

function notFuture(ms: number | undefined, now: number, where: string) {
  if (ms !== undefined && ms > now + SKEW_MS)
    throw new HeartbeatInputError(
      `${where} is in the future: a clock that is ahead would make a stopped job look fresh`,
    );
}

/**
 * A run's finish time when it supplies one, checked against its start and the
 * clock. Every supplied time is checked, a cancelled or skipped run's too,
 * although only a result's finish is kept.
 */
function suppliedFinish(
  fields: Record<string, unknown>,
  status: RunStatus,
  startedMs: number,
  where: string,
): number | undefined {
  const hasFinish =
    fields.finishedAt !== undefined && fields.finishedAt !== null;
  if (status === "running" && hasFinish)
    throw new HeartbeatInputError(`${where} is running but has a finishedAt`);
  if (!hasFinish && !producesResult(status)) return undefined;
  const ms = parseTime(fields.finishedAt, `${where}.finishedAt`);
  if (ms < startedMs)
    throw new HeartbeatInputError(`${where} finished before it started`);
  return ms;
}

function producesResult(status: RunStatus): boolean {
  return status === "success" || status === "failure";
}

/** One run of the history; throw when a field is missing or of another shape. */
function parseRun(item: unknown, where: string, now: number): Run {
  const fields = record(item, where);
  const job = fields.job;
  if (typeof job !== "string" || job === "")
    throw new HeartbeatInputError(`${where}.job must be a non-empty string`);
  const id = runId(fields.id, where);
  const status = fields.status;
  if (typeof status !== "string" || !STATUSES.includes(status))
    throw new HeartbeatInputError(
      `${where}.status must be one of ${STATUSES.join(", ")}, not ${JSON.stringify(status)}`,
    );
  const startedMs = parseTime(fields.startedAt, `${where}.startedAt`);
  notFuture(startedMs, now, `${where}.startedAt`);
  const finishMs = suppliedFinish(
    fields,
    status as RunStatus,
    startedMs,
    where,
  );
  notFuture(finishMs, now, `${where}.finishedAt`);
  return {
    job,
    id,
    status: status as RunStatus,
    startedMs,
    finishedMs: producesResult(status as RunStatus) ? finishMs : undefined,
  };
}

function span(ms: number): string {
  const minutes = Math.round(ms / UNIT_MS.m);
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.round(ms / UNIT_MS.h);
  return hours < 48 ? `${hours}h` : `${Math.round(ms / UNIT_MS.d)}d`;
}

type Result = Run & { finishedMs: number };

/**
 * A job's results, newest first; at the same instant the failure first, so
 * the order of the input never changes the class and a tie reads as the
 * failure.
 */
function resultsNewestFirst(runs: Run[]): Result[] {
  return runs
    .filter(
      (run): run is Result =>
        producesResult(run.status) && run.finishedMs !== undefined,
    )
    .sort(
      (a, b) =>
        b.finishedMs - a.finishedMs ||
        Number(b.status === "failure") - Number(a.status === "failure"),
    );
}

/** The class of a job that has produced no result yet. */
function classifyWithoutResult(
  job: Job,
  mine: Run[],
  inProgress: boolean,
  now: number,
): JobResult {
  const base = {
    id: job.id,
    lastResultAt: null,
    lastResult: null,
    consecutiveFailures: 0,
    ageMs: null,
  };
  // A job with no result yet is running only while its first run is young: a
  // run that never leaves the queue must not read as running forever.
  const firstRunYoung =
    now - Math.min(...mine.map((run) => run.startedMs)) <=
    job.cadenceMs + job.graceMs;
  if (inProgress && firstRunYoung)
    return {
      ...base,
      class: "running",
      reason: "its first run is in progress",
    };
  const why =
    mine.length === 0
      ? "no run in the history"
      : `${mine.length} run(s) in the history, none produced a result (cancelled, skipped or hung)`;
  return { ...base, class: "stale", reason: `never produced a result: ${why}` };
}

function failureStreak(results: Result[]): number {
  const firstSuccess = results.findIndex((run) => run.status !== "failure");
  return firstSuccess === -1 ? results.length : firstSuccess;
}

/** Put one job in a class from its runs and the time now. */
export function classify(job: Job, runs: Run[], now: number): JobResult {
  const mine = runs.filter((run) => run.job === job.id);
  const results = resultsNewestFirst(mine);
  const inProgress = mine.some(
    (run) => run.status === "running" && now - run.startedMs <= job.maxRunMs,
  );
  const last = results[0];
  if (last === undefined)
    return classifyWithoutResult(job, mine, inProgress, now);
  const streak = failureStreak(results);
  const ageMs = Math.max(0, now - last.finishedMs);
  const overdue = ageMs > job.cadenceMs + job.graceMs;
  const found = {
    id: job.id,
    lastResultAt: new Date(last.finishedMs).toISOString(),
    lastResult: last.status === "success" ? "success" : "failure",
    consecutiveFailures: streak,
    ageMs,
  } as const;
  const age = `last result ${span(ageMs)} ago`;
  const due = `cadence ${span(job.cadenceMs)} plus grace ${span(job.graceMs)}`;
  const failures = `${streak} failure(s) in a row`;
  if (streak >= job.redAfter)
    return {
      ...found,
      class: "red",
      reason: `${failures} (red after ${job.redAfter}); ${age}${overdue ? `, past ${due}` : ""}`,
    };
  if (overdue)
    return { ...found, class: "stale", reason: `${age}, past ${due}` };
  if (inProgress)
    return {
      ...found,
      class: "running",
      reason: `a run is in progress; ${age}${streak > 0 ? `, after ${failures}` : ""}`,
    };
  if (streak > 0)
    return {
      ...found,
      class: "degraded",
      reason: `${failures} (red after ${job.redAfter}); ${age}`,
    };
  return { ...found, class: "green", reason: `${age}, within ${due}` };
}

export interface Report {
  now: string;
  verdict: "ok" | "red";
  jobs: JobResult[];
  /** Declared jobs that are not classified because they run the watcher. */
  watchers: string[];
  /** Jobs the history names that the registry does not declare. */
  undeclared: string[];
}

/** Classify every declared job; the verdict is red when any is red or stale. */
export function heartbeat(jobs: Job[], runs: Run[], now: number): Report {
  const results = jobs
    .filter((job) => !job.watcher)
    .map((job) => classify(job, runs, now));
  const declared = new Set(jobs.map((job) => job.id));
  return {
    now: new Date(now).toISOString(),
    verdict: results.some((r) => r.class === "red" || r.class === "stale")
      ? "red"
      : "ok",
    jobs: results,
    watchers: jobs.filter((job) => job.watcher).map((job) => job.id),
    undeclared: [...new Set(runs.map((run) => run.job))]
      .filter((id) => !declared.has(id))
      .sort(),
  };
}

const LABEL: Record<HeartbeatClass, string> = {
  green: "GREEN   ",
  degraded: "DEGRADED",
  red: "RED     ",
  stale: "STALE   ",
  running: "RUNNING ",
};

function render(report: Report): string {
  const bad = report.jobs.filter(
    (r) => r.class === "red" || r.class === "stale",
  );
  const lines = report.jobs.map(
    (r) => `${LABEL[r.class]} ${r.id} — ${r.reason}`,
  );
  if (report.watchers.length > 0)
    lines.push(
      `(not classified, watched by the external monitor: ${report.watchers.join(", ")})`,
    );
  if (report.undeclared.length > 0)
    lines.push(`(ignored, not declared: ${report.undeclared.join(", ")})`);
  lines.push(
    report.verdict === "ok"
      ? `HEARTBEAT ok — ${report.jobs.length} job(s), none red or stale`
      : `HEARTBEAT red — ${bad.length} of ${report.jobs.length} job(s) red or stale: ${bad.map((r) => r.id).join(", ")}`,
  );
  return lines.join("\n");
}

interface Options {
  registry: string;
  history: string;
  now: number;
  json: boolean;
}

const OPTIONS = {
  registry: { type: "string" },
  history: { type: "string" },
  now: { type: "string" },
  json: { type: "boolean" },
} as const;

/** The options; throw with the usage on any other shape. */
export function parseOptions(args: string[], clock = Date.now()): Options {
  const { values } = strictOptions(
    { args, options: OPTIONS, allowPositionals: false },
    usage,
  );
  if (values.registry === undefined)
    throw new HeartbeatInputError(`--registry is required\n${usage}`);
  if (values.history === undefined)
    throw new HeartbeatInputError(`--history is required\n${usage}`);
  return {
    registry: values.registry,
    history: values.history,
    now: values.now === undefined ? clock : parseTime(values.now, "--now"),
    json: values.json === true,
  };
}

export function main(args = process.argv.slice(2)): number {
  const options = parseOptions(args);
  const file = readYaml(options.registry);
  if ("error" in file) throw new HeartbeatInputError(file.error);
  const jobs = parseRegistry(file.doc, options.registry);
  const text =
    options.history === "-"
      ? readFileSync(0, "utf8")
      : readFileSync(options.history, "utf8");
  const report = heartbeat(jobs, parseHistory(text, options.now), options.now);
  console.log(options.json ? JSON.stringify(report, null, 2) : render(report));
  return report.verdict === "ok" ? 0 : 1;
}

if (import.meta.main) cli(() => main());
