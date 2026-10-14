#!/usr/bin/env bun
// Queue-stall watchdog: a CI job that waits too long for a runner fails loudly.
//
// The problem it catches. A CI job's timeout (GitHub Actions `timeout-minutes`,
// and its equivalents elsewhere) counts only the time the job RUNS, not the
// time it waits for a runner to pick it up. So a job can sit queued for hours
// (no runner online, a self-hosted pool with no runner carrying the requested
// labels, an exhausted concurrency quota) while nothing fails. When that job
// belongs to a serialized workflow, it also holds the workflow's concurrency
// slot, and every newer run waits behind it. This check turns "is anything
// stuck waiting for a runner?" into a verdict that fails, so someone looks.
//
// The rule. A job is STALLED when its status is `queued` and it was created
// strictly more than the bound ago (at the bound still passes). Every other
// status is left out on purpose:
//   * `waiting`     waits for an environment's required reviewers: a person's
//                   wait, which a runner cannot end and this bound should not page.
//   * `requested`, `pending`, `in_progress`, `completed`: not a runner wait.
// A status outside those six is a provider change this check does not know,
// so it fails closed rather than reading it as "not queued".
//
// Input. JSON from a file path argument, or stdin when there is no path or the
// path is `-`, in any of these shapes:
//   * an array of jobs;
//   * `{ "jobs": [...] }`, one page of GitHub's "list jobs for a workflow run";
//   * an array of such pages (pages collected with `jq -s`).
// Each job carries `id`, `name`, `status`, `created_at` (ISO 8601 with a time
// zone) and optionally `html_url` and `run_id`; `id` and `run_id`, when
// present, are integers or non-empty strings. A job seen twice (the same run
// listed under two statuses while it moved) counts once, as its latest copy:
// a job only moves forward (waiting, requested or pending, then queued, then
// in_progress, then completed), so the copy furthest along is the newest,
// whatever order the copies arrive in. Every copy is checked before one is kept.
//
// Fail closed. Input that is not JSON or not one of those shapes, a job without
// a known `status`, an `id` or `run_id` of another type, a queued job whose
// `created_at` is missing, unparseable or not a real calendar time, two copies of one job with different `created_at`, or a bad option exits 2:
// input the check could not read never passes.
//
// Exit codes: 0 nothing stalled, 1 at least one job stalled, 2 usage or input
// error.
//
// Usage:
//   find-queue-stalls.ts [--max-wait-minutes 45] [--now <ISO 8601>] [jobs.json | -]
import { readFileSync } from "node:fs";
import { cli } from "../../../../lib/cli.ts";
import { isRecord } from "../../../../lib/record.ts";

export interface Job {
  id?: number | string;
  name?: string;
  status: string;
  created_at?: string;
  html_url?: string;
  run_id?: number | string;
}

export interface Stall {
  job: Job;
  waitedMinutes: number;
}

const usage =
  "usage: find-queue-stalls.ts [--max-wait-minutes <n>] [--now <ISO 8601>] [jobs.json | -]";

// A time zone is required: without one, Date.parse reads the stamp as local
// time and the verdict would depend on the machine it runs on.
const iso8601 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))$/;

/** Whether the matched fields name a real date and time of day. */
function isRealTime(f: RegExpExecArray): boolean {
  const n = (i: number) => Number(f[i] ?? 0);
  const stamp = new Date(Date.UTC(n(1), n(2) - 1, n(3), n(4), n(5), n(6)));
  // Date.UTC rolls an impossible field over into the next one (30 February
  // becomes 2 March), so a real time is one that comes back unchanged.
  const written = `${f[1]}-${f[2]}-${f[3]}T${f[4]}:${f[5]}:${f[6] ?? "00"}`;
  return (
    Number.isFinite(stamp.getTime()) &&
    stamp.toISOString().startsWith(written) &&
    n(7) <= 23 &&
    n(8) <= 59
  );
}

/**
 * The timestamp in milliseconds; throw unless it is ISO 8601 with a time zone
 * and names a real calendar time. Date.parse alone would roll an impossible
 * date such as 30 February over into March.
 */
export function parseTime(value: unknown, what: string): number {
  const fields = typeof value === "string" ? iso8601.exec(value) : null;
  const ms =
    fields !== null && isRealTime(fields) ? Date.parse(fields[0]) : NaN;
  if (Number.isNaN(ms))
    throw new Error(`${what} is not an ISO 8601 timestamp: ${String(value)}`);
  return ms;
}

const isPage = (v: unknown): v is { jobs: unknown[] } =>
  isRecord(v) && Array.isArray(v.jobs);

/** The raw job entries of any accepted input shape; throw on anything else. */
function rawJobs(input: unknown): unknown[] {
  if (isPage(input)) return input.jobs;
  if (Array.isArray(input) && input.length > 0 && input.every(isPage))
    return input.flatMap((page) => page.jobs);
  if (Array.isArray(input) && !input.some(isPage)) return input;
  throw new Error(
    "input is not a job array, a { jobs: [...] } page, or an array of such pages",
  );
}

/** Each known job status, ranked by how far along a job's life it comes. */
const STAGE: Record<string, number> = {
  waiting: 0,
  requested: 0,
  pending: 0,
  queued: 1,
  in_progress: 2,
  completed: 3,
};

const isIdentifier = (v: unknown): boolean =>
  (typeof v === "number" && Number.isSafeInteger(v)) ||
  (typeof v === "string" && v !== "");

/** One raw entry as a job; throw unless its status is known and readable. */
function checkJob(raw: unknown, index: number): Job {
  if (!isRecord(raw) || typeof raw.status !== "string")
    throw new Error(`job #${index} has no string status`);
  if (!Object.hasOwn(STAGE, raw.status))
    throw new Error(`job #${index} has an unknown status: ${raw.status}`);
  // The two identify a job when copies are merged, so a value that does not
  // print as itself would merge unrelated jobs and could hide a stall.
  for (const field of ["id", "run_id"])
    if (raw[field] !== undefined && !isIdentifier(raw[field]))
      throw new Error(`job #${index} has a ${field} that is not an identifier`);
  const job = raw as unknown as Job;
  if (job.status === "queued")
    parseTime(job.created_at, `created_at of job ${job.id ?? "?"}`);
  return job;
}

/** The copy of one job to keep: the one furthest along its life. */
function laterCopy(kept: Job, job: Job, key: string): Job {
  const [a, b] = [kept.created_at, job.created_at];
  if (a !== undefined && b !== undefined && a !== b)
    throw new Error(`job ${key} is listed with two different created_at`);
  return (STAGE[job.status] ?? 0) > (STAGE[kept.status] ?? 0) ? job : kept;
}

/** Flatten any accepted input shape to a list of jobs, each job once. */
export function parseJobs(input: unknown): Job[] {
  const slot = new Map<string, number>();
  const jobs: Job[] = [];
  for (const [index, raw] of rawJobs(input).entries()) {
    const job = checkJob(raw, index);
    // JSON keeps the pair apart: a joined string would let run "a", job "b/c"
    // and run "a/b", job "c" share one key and hide a queued copy.
    const key =
      job.id === undefined
        ? null
        : JSON.stringify([job.run_id ?? null, job.id]);
    const at = key === null ? undefined : slot.get(key);
    const kept = at === undefined ? undefined : jobs[at];
    if (key === null || at === undefined || kept === undefined) {
      if (key !== null) slot.set(key, jobs.length);
      jobs.push(job);
    } else jobs[at] = laterCopy(kept, job, key);
  }
  return jobs;
}

/** The queued jobs that have waited strictly longer than the bound. */
export function findQueueStalls(
  jobs: Job[],
  { now, maxWaitMinutes }: { now: number; maxWaitMinutes: number },
): Stall[] {
  const stalls: Stall[] = [];
  for (const job of jobs) {
    if (job.status !== "queued") continue;
    const waitedMs =
      now - parseTime(job.created_at, `created_at of job ${job.id ?? "?"}`);
    if (waitedMs > maxWaitMinutes * 60_000)
      stalls.push({ job, waitedMinutes: Math.floor(waitedMs / 6_000) / 10 });
  }
  return stalls;
}

interface Options {
  maxWaitMinutes: number;
  now: number;
  path: string | undefined;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    maxWaitMinutes: 45,
    now: Date.now(),
    path: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--max-wait-minutes")
      options.maxWaitMinutes = parseBound(args[++i] ?? "");
    else if (arg === "--now") options.now = parseTime(args[++i], "--now");
    else if (arg.startsWith("--"))
      throw new Error(`unknown option ${arg}\n${usage}`);
    else if (options.path !== undefined)
      throw new Error(`more than one input\n${usage}`);
    else options.path = arg;
  }
  return options;
}

function parseBound(value: string): number {
  if (!/^[0-9]{1,9}$/.test(value))
    throw new Error(
      `--max-wait-minutes must be a non-negative integer: ${value}\n${usage}`,
    );
  return Number(value);
}

function readInput(path: string | undefined): unknown {
  const text =
    path === undefined || path === "-"
      ? readFileSync(0, "utf8")
      : readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`input is not JSON: ${path ?? "stdin"}`);
  }
}

function stallLine({ job, waitedMinutes }: Stall, bound: number): string {
  const run = job.run_id === undefined ? "" : `, run ${job.run_id}`;
  const url = job.html_url ? ` ${job.html_url}` : "";
  return `  - ${job.name ?? "(unnamed)"} (job ${job.id ?? "?"}${run}): queued ${waitedMinutes} min (max ${bound})${url}`;
}

export function main(args = process.argv.slice(2)): number {
  const { maxWaitMinutes, now, path } = parseArgs(args);
  const jobs = parseJobs(readInput(path));
  const stalls = findQueueStalls(jobs, { now, maxWaitMinutes });
  if (stalls.length) {
    console.log(
      `STALLED — ${stalls.length} job(s) queued over ${maxWaitMinutes} min without a runner; their timeouts have not started.`,
    );
    for (const stall of stalls) console.log(stallLine(stall, maxWaitMinutes));
    return 1;
  }
  const queued = jobs.filter((job) => job.status === "queued").length;
  console.log(
    `OK — ${queued} queued job(s), none waiting over ${maxWaitMinutes} min`,
  );
  return 0;
}

if (import.meta.main) cli(() => main());
