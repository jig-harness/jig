/**
 * A job the runner stopped at its time limit (`timeout-minutes`) completes as
 * `cancelled`, like a job its concurrency group or a person cancelled. What
 * tells it apart is the annotation the runner leaves on its check run: "The
 * job running on runner <name> has exceeded the maximum execution time of 30
 * minutes." (or "... of 5m0s"). A timed-out job is a failure to repair, not
 * an absence of evidence to re-run: its re-run runs into the same limit.
 *
 * Its annotations are read only for a cancelled job whose check run carries
 * any, one request per page of up to 100 (at most ten pages); a read that fails, or an answer that does not
 * parse, leaves the job a cancellation. So does a run of its workflow still
 * going on the head (a re-run of it, queued before its jobs exist): the
 * recovery waits for that run as it waits for any replacement.
 */
import {
  attempt,
  failed,
  ok,
  type Outcome,
} from "../../../../shared/outcome.ts";
import { parseMs } from "../../../../shared/time.ts";
import type { CheckRunLite } from "./ci-hold.ts";
import { forgeReadClass, type ForgeReadCode } from "./forge-read.ts";
import { ghCall } from "./proc.ts";
import type { FailedRun, WorkflowRun } from "./status/workflow-runs.ts";

/** A workflow job the runner stopped at its time limit. */
export interface TimedOutJob {
  name: string;
  checkRunId: number;
  /** Its time limit, as the runner's annotation names it. */
  limitMs: number;
  /** How long it ran, from its start to its completion; `null` when either does not read. */
  ranMs: number | null;
  /** The workflow run behind it, for the repair pass; `null` when none is listed. */
  run: FailedRun | null;
}

/** A check run's annotations as the forge answers them, or why they did not read. */
export type AnnotationsRead = (
  checkRunId: number,
) => Promise<Outcome<unknown, ForgeReadCode>>;

const PHRASE = "has exceeded the maximum execution time of";
const IN_MINUTES = new RegExp(`${PHRASE}\\s+(\\d+)\\s*minutes?\\b`, "i");
const AS_DURATION = new RegExp(
  `${PHRASE}\\s+(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+(?:\\.\\d+)?)s)?(?!\\w)`,
  "i",
);

/** The time limit a runner's annotation names, in milliseconds; `null` when none names one. */
function limitIn(message: string): number | null {
  const minutes = IN_MINUTES.exec(message);
  if (minutes !== null) return Number(minutes[1]) * 60_000;
  const duration = AS_DURATION.exec(message);
  if (
    duration === null ||
    duration.slice(1).every((part) => part === undefined)
  )
    return null;
  const [hours, mins, secs] = duration
    .slice(1)
    .map((part) => Number(part ?? 0));
  const ms = ((hours ?? 0) * 3600 + (mins ?? 0) * 60 + (secs ?? 0)) * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * The time limit a check run's annotations say the runner stopped it at, in
 * milliseconds; `null` when no annotation says so, or the answer is not a list
 * of annotations.
 */
export function timeLimitOf(annotations: unknown): number | null {
  if (!Array.isArray(annotations)) return null;
  for (const entry of annotations) {
    if (typeof entry !== "object" || entry === null) continue;
    const message = (entry as Record<string, unknown>).message;
    if (typeof message !== "string") continue;
    const limit = limitIn(message);
    if (limit !== null) return limit;
  }
  return null;
}

/** GitHub lists at most 100 annotations a page; a check run's own limit is far below `MAX_PAGES` of them. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
/** Each entry is two numbers, so the bound is far above the jobs one head can have. */
const CACHE_ENTRIES = 1024;

/**
 * A completed check run's annotations do not change: each is read once per
 * process. What is kept is the classification of the full response (how many
 * annotations it held and the time limit it named), so a later read answers
 * as the first did whatever the messages said, and a long drive holds a
 * bounded amount.
 */
const readBefore = new Map<number, { count: number; limitMs: number | null }>();

function remember(checkRunId: number, annotations: readonly unknown[]): void {
  if (readBefore.size >= CACHE_ENTRIES) {
    const oldest = readBefore.keys().next();
    if (!oldest.done) readBefore.delete(oldest.value);
  }
  readBefore.set(checkRunId, {
    count: annotations.length,
    limitMs: timeLimitOf(annotations),
  });
}

/** The annotations a cached classification stands for: `count` of them, the first naming the limit. */
function recalled(entry: { count: number; limitMs: number | null }): unknown[] {
  const listed: unknown[] = Array.from({ length: entry.count }, () => ({}));
  if (entry.limitMs !== null && entry.count > 0)
    listed[0] = { message: `${PHRASE} ${entry.limitMs / 1000}s` };
  return listed;
}

/** A check run's annotations, page by page until one is short or the time-limit message is found. */
const readAnnotations: AnnotationsRead = async (checkRunId) => {
  const cached = readBefore.get(checkRunId);
  if (cached !== undefined) return ok(recalled(cached));
  const all: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await ghCall([
      "api",
      `repos/{owner}/{repo}/check-runs/${checkRunId}/annotations?per_page=${PAGE_SIZE}&page=${page}`,
    ]);
    if (result.code !== 0)
      return failed(
        forgeReadClass(result),
        `gh api check-run annotations exited ${result.code}: ${(result.stderrTail || result.stderr).trim().slice(-500)}`,
      );
    const decoded = attempt(
      "malformed",
      "the annotations answer is not JSON",
      (): unknown => JSON.parse(result.stdout),
    );
    if (!decoded.ok) return decoded;
    if (!Array.isArray(decoded.value))
      return failed("malformed", "the annotations answer is not a list");
    all.push(...decoded.value);
    if (decoded.value.length < PAGE_SIZE || timeLimitOf(all) !== null) break;
  }
  remember(checkRunId, all);
  return ok(all);
};

/** Whether a run of the job's workflow is still going on the head. */
function workflowGoing(
  job: CheckRunLite,
  runs: readonly WorkflowRun[],
): boolean {
  const own = runs.find((r) => r.checkSuiteId === job.suiteId);
  return (
    own !== undefined &&
    runs.some(
      (run) => run.workflowId === own.workflowId && run.status !== "completed",
    )
  );
}

function ranFor(job: CheckRunLite): number | null {
  if (job.startedAt === null || (job.completedAt ?? null) === null) return null;
  const ran = parseMs(job.completedAt ?? "") - parseMs(job.startedAt);
  return Number.isFinite(ran) && ran >= 0 ? ran : null;
}

function runBehind(
  job: CheckRunLite,
  runs: readonly WorkflowRun[],
): FailedRun | null {
  const run = runs.find((r) => r.checkSuiteId === job.suiteId);
  return run === undefined
    ? null
    : {
        id: run.id,
        createdAt: run.createdAt,
        conclusion: run.conclusion,
        jobNames: [job.name],
      };
}

/**
 * The completed `cancelled` jobs among `jobs` that the runner stopped at
 * their time limit. Only a job whose check run carries annotations, and whose
 * workflow has no run still going on the head, is asked about; a read that
 * fails is logged and leaves the job a cancellation.
 */
export async function timedOutJobs(
  jobs: readonly CheckRunLite[],
  runs: readonly WorkflowRun[],
  read: AnnotationsRead = readAnnotations,
): Promise<TimedOutJob[]> {
  const timedOut: TimedOutJob[] = [];
  for (const job of jobs) {
    if (
      job.status !== "completed" ||
      job.conclusion !== "cancelled" ||
      (job.annotationsCount ?? 0) === 0 ||
      workflowGoing(job, runs)
    )
      continue;
    const annotations = await read(job.id);
    if (!annotations.ok) {
      console.error(
        `cancelled CI recovery: the annotations of check run ${job.id} (${job.name}) did not read (${annotations.failure.code}: ${annotations.failure.reason}); it stays a cancellation`,
      );
      continue;
    }
    const limitMs = timeLimitOf(annotations.value);
    if (limitMs === null) {
      if (Array.isArray(annotations.value) && annotations.value.length > 0)
        console.error(
          `cancelled CI recovery: check run ${job.id} (${job.name}) carries ${annotations.value.length} annotation(s), none of them the runner's time-limit message; it stays a cancellation`,
        );
      continue;
    }
    timedOut.push({
      name: job.name,
      checkRunId: job.id,
      limitMs,
      ranMs: ranFor(job),
      run: runBehind(job, runs),
    });
  }
  return timedOut;
}

/** `30m 4s`, `1h 2m 3s`, `45s`: whole seconds. */
function duration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const parts = [
    [Math.floor(total / 3600), "h"],
    [Math.floor((total % 3600) / 60), "m"],
    [total % 60, "s"],
  ] as const;
  const written = parts
    .filter(([value]) => value > 0)
    .map(([value, unit]) => `${value}${unit}`);
  return written.length > 0 ? written.join(" ") : "0s";
}

/** "job `test` ran 30m 4s and stopped at its 30-minute limit (timeout-minutes)". */
export function timeoutWording(job: TimedOutJob): string {
  const limit =
    job.limitMs % 60_000 === 0
      ? `${job.limitMs / 60_000}-minute`
      : duration(job.limitMs);
  const ran = job.ranMs === null ? "" : ` ran ${duration(job.ranMs)} and`;
  return `job \`${job.name}\`${ran} stopped at its ${limit} limit (timeout-minutes)`;
}
