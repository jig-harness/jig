/**
 * Re-run a converged head's checks that failed on the infrastructure, instead
 * of spending a CI-repair pass on them.
 *
 * A failing check whose job failed on the infrastructure (`shared/ci-infra.ts`:
 * a lost runner, or a setup step's network failure, with no code diagnostic)
 * cannot be fixed by a code change, so a repair pass spent on it is wasted and
 * the drive's `CI_REPAIR_SPENT` stop is one only a person used to settle. When
 * every failing check on the head reads that way, the drive:
 *
 * 1. re-runs the failed jobs of each run behind them (`gh run rerun <run>
 *    --failed`), at most `DRIVE_PR_CI_INFRA_RERUNS` (default 2) times per
 *    head, never a run created under the CI hold's label (a re-run replays
 *    that event);
 * 2. when a run cannot be re-run (the forge refuses it, as it does for a
 *    default-setup code scan, or the run is under the hold) or the re-runs on
 *    this head are spent, moves the head: merges the base when the branch is
 *    behind it for the next validated round to push, otherwise commits and
 *    pushes an empty commit, at most
 *    `DRIVE_PR_CI_INFRA_HEAD_MOVES` (default 2) times per drive;
 * 3. past both, stops `CI_INFRA_PERSISTED` (exit `23`), which the dispatcher
 *    re-drives after a backoff.
 *
 * Each step then re-gates from the top, which waits for the checks as usual.
 * No CI-repair pass is spent and the repair counter does not move. A failing
 * check this cannot read, a commit status (no log to read), or one read as the
 * code's leaves the decision to the repair path, unchanged.
 */
import { readInfrastructure } from "../../../../../shared/ci-infra.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { readTimeoutEnv } from "../../../../../shared/proc.ts";
import { sleep } from "./../cli.ts";
import { cachedRepoView } from "./../gh-conditional.ts";
import {
  ghCall,
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  run,
  tsArgv,
} from "./../proc.ts";
import { treeFence } from "./../attach.ts";
import type { FailedRun } from "./../status/workflow-runs.ts";
import { failedRunsField, rerunnableRuns } from "./failed-runs.ts";
import { baseSync, guardedPush } from "./paths.ts";
import type { DriveRoundContext } from "./round-context.ts";
import {
  CI_INFRA_PERSISTED_EXIT,
  FINAL_CI_POLL_SECONDS,
  UNLABEL_SETTLE_SECONDS,
} from "./settings.ts";

/** The commit message of the head move that only re-triggers the checks. */
export const RERUN_COMMIT_MESSAGE =
  "ci: re-run checks after an infrastructure failure";

/** What the converged head's fresh report says is failing. */
export interface FailingChecks {
  /** The check-run names failing, `failingCheckRunNames`; `null` when unread. */
  checkRunNames: string[] | null;
  /** The commit-status names failing, `failingStatusNames`; `null` when unread. */
  statusNames: string[] | null;
  /** The workflow runs behind them, the report's `failingRuns`. */
  runs: unknown;
  /** The failing commit statuses and their URLs, the report's `failingStatuses`. */
  statuses?: unknown;
}

/** What one re-run answered: re-run, refused by the forge, or failed to ask. */
export type RerunAnswer = "rerun" | "refused" | "failed";

/** The forge and the tree, as this step reaches them; tests replace them. */
export interface InfraDeps {
  /** Each run's failed-step log, or `null` when one cannot be read. */
  readLogs(runs: readonly number[]): Promise<string[] | null>;
  /** The ids of these runs a re-run may replay: none created under the hold. */
  rerunnable(pr: string, runs: readonly FailedRun[]): Promise<number[]>;
  rerun(run: number): Promise<{ answer: RerunAnswer; detail: string }>;
  /** Move the pull request's head so its checks run again. */
  moveHead(pr: string, head: string): Promise<number | "continue">;
  sleep(seconds: number): Promise<void>;
}

/** Per-head re-runs and per-drive head moves, and their bounds. */
export interface InfraRecovery {
  head: string;
  reruns: number;
  moves: number;
  rerunBudget: number;
  moveBudget: number;
}

/** Invalid or excessive retry counts use the bounded default. */
export const wholeOr = (raw: string | undefined, fallback: number): number => {
  const value =
    raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(value) && value >= 0 && value <= 100
    ? value
    : fallback;
};

/** The bounds, read once at the start of the drive. */
export function infraRecoveryBudget(): InfraRecovery {
  return {
    head: "",
    reruns: 0,
    moves: 0,
    rerunBudget: wholeOr(process.env.DRIVE_PR_CI_INFRA_RERUNS, 2),
    moveBudget: wholeOr(process.env.DRIVE_PR_CI_INFRA_HEAD_MOVES, 2),
  };
}

/**
 * Whether every failing check is a job its run's log reads as failed on the
 * infrastructure; the reason either way, for the log.
 */
export function everyFailureInfrastructure(
  failing: FailingChecks,
  logs: readonly string[],
): { infrastructure: boolean; why: string } {
  const names = failing.checkRunNames;
  if (failing.statusNames === null || failing.statusNames.length > 0)
    return {
      infrastructure: false,
      why:
        failing.statusNames === null
          ? "the commit statuses could not be read"
          : `a commit status is failing (${failing.statusNames.join(", ")}), which has no log to read`,
    };
  if (names === null || names.length === 0)
    return { infrastructure: false, why: "no failing check-run is named" };
  const runs = failedRunsField(failing.runs);
  const missing = workflowCoverage(runs, names, logs.length);
  return missing ?? classifyRunLogs(runs, logs);
}

/** The text without its trailing full stops, for a sentence that adds its own. */
function withoutTrailingDots(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === ".") end--;
  return text.slice(0, end);
}

/** Require a workflow identity for every failing check, including duplicate names. */
function workflowCoverage(
  runs: readonly FailedRun[],
  names: readonly string[],
  logCount: number,
): { infrastructure: false; why: string } | null {
  if (
    runs.length !== logCount ||
    runs.some(
      (run) =>
        !Array.isArray(run.jobNames) ||
        run.jobNames.some((name) => typeof name !== "string" || name === ""),
    )
  )
    return {
      infrastructure: false,
      why: "the failing checks' workflow provenance could not be read",
    };
  const covered = runs
    .flatMap((run) => run.jobNames ?? [])
    .sort((a, b) => a.localeCompare(b));
  if (
    JSON.stringify(covered) !==
    JSON.stringify([...names].sort((a, b) => a.localeCompare(b)))
  )
    return {
      infrastructure: false,
      why: "a failing check has no unique workflow-run coverage",
    };
  return null;
}

/** Classify each log in its own workflow run and retain its overall verdict. */
function classifyRunLogs(
  runs: readonly FailedRun[],
  logs: readonly string[],
): { infrastructure: boolean; why: string } {
  const reasons: string[] = [];
  for (const [index, run] of runs.entries()) {
    const reading = readInfrastructure(logs[index] ?? "");
    if (!reading.infrastructure) return reading;
    for (const name of run.jobNames ?? []) {
      const job = reading.jobs.find((job) => job.job === name);
      if (job === undefined)
        return {
          infrastructure: false,
          why: `no failed-run log names the failing check '${name}' in run ${run.id}`,
        };
      reasons.push(`run ${run.id} '${name}': ${job.why}`);
    }
  }
  return { infrastructure: true, why: reasons.join("; ") };
}

/**
 * Recover a converged head whose failing checks all failed on the
 * infrastructure: re-run them, move the head, or stop `CI_INFRA_PERSISTED`.
 * `null` when they do not all read that way, so the repair path decides.
 */
export async function recoverInfrastructureFailure(
  context: DriveRoundContext,
  reviewedHead: string,
  failing: FailingChecks,
  deps: InfraDeps = defaultDeps,
): Promise<number | "continue" | null> {
  const failed = failedRunsField(failing.runs);
  const runs = failed.map((r) => r.id);
  if (runs.length === 0) return null;
  const logs = await deps.readLogs(runs);
  if (logs === null) {
    console.error(
      "  The failed runs' logs could not be read, so the failure is not read as the infrastructure's.",
    );
    return null;
  }
  const reading = everyFailureInfrastructure(failing, logs);
  if (!reading.infrastructure) {
    console.error(
      `  Not an infrastructure failure: ${withoutTrailingDots(reading.why)}.`,
    );
    return null;
  }
  console.error(
    `review converged, but every failing check failed on the infrastructure: ${withoutTrailingDots(reading.why)}.`,
  );
  console.error(
    "  Re-running instead of spending a CI-repair pass on a failure no code change fixes.",
  );
  if (context.dryRun || context.agent.length === 0) {
    console.error(
      `(dry-run) would re-run run(s) ${runs.join(", ")} or move the head`,
    );
    return 1;
  }
  const mailbox = await context.mailboxCheckpoint();
  if (typeof mailbox === "number") return mailbox;
  if (mailbox === "resumed") return "continue";
  return await rerunOrMove(context, reviewedHead, failed, deps);
}

async function rerunOrMove(
  context: DriveRoundContext,
  head: string,
  failed: readonly FailedRun[],
  deps: InfraDeps,
): Promise<number | "continue"> {
  const state = context.ciInfra;
  if (state.head !== head) {
    state.head = head;
    state.reruns = 0;
  }
  const runs = failed.map((r) => r.id);
  const rerunnable = await deps.rerunnable(context.pr, failed);
  const held = runs.filter((r) => !rerunnable.includes(r));
  let cannot =
    held.length > 0
      ? `run(s) ${held.join(", ")} were created under the CI hold's label, which a re-run replays`
      : state.reruns >= state.rerunBudget
        ? `the ${state.rerunBudget} re-run(s) on this head are spent (DRIVE_PR_CI_INFRA_RERUNS)`
        : "";
  if (cannot === "") {
    const asked = await rerunAll(runs, deps);
    if (asked.answer !== "refused") {
      state.reruns += 1;
      console.error(
        asked.answer === "rerun"
          ? `  Re-ran the failed jobs of run(s) ${runs.join(", ")} (re-run ${state.reruns}/${state.rerunBudget} on this head); waiting for the checks.`
          : `  Asking for the re-run failed (${asked.detail}); counted as re-run ${state.reruns}/${state.rerunBudget} on this head.`,
      );
      await deps.sleep(
        asked.answer === "rerun"
          ? UNLABEL_SETTLE_SECONDS
          : FINAL_CI_POLL_SECONDS,
      );
      return "continue";
    }
    cannot = `the forge refused to re-run it: ${asked.detail}`;
  }
  if (state.moves >= state.moveBudget) {
    console.error(
      `  The checks cannot be re-run (${cannot}), and the ${state.moveBudget} head move(s) of this drive are spent (DRIVE_PR_CI_INFRA_HEAD_MOVES).`,
    );
    console.error(
      `  The infrastructure failure persisted: exit ${CI_INFRA_PERSISTED_EXIT}, CI_INFRA_PERSISTED. A later drive re-runs them again; no CI-repair pass was spent.`,
    );
    return CI_INFRA_PERSISTED_EXIT;
  }
  state.moves += 1;
  console.error(
    `  The checks cannot be re-run (${cannot}); moving the head so they run again (head move ${state.moves}/${state.moveBudget}).`,
  );
  return await deps.moveHead(context.pr, head);
}

/** Re-run each run in turn; the first refusal or failure answers for all. */
async function rerunAll(
  runs: readonly number[],
  deps: InfraDeps,
): Promise<{ answer: RerunAnswer; detail: string }> {
  for (const id of runs) {
    const asked = await deps.rerun(id);
    if (asked.answer !== "rerun")
      return { answer: asked.answer, detail: `run ${id}: ${asked.detail}` };
  }
  return { answer: "rerun", detail: "" };
}

/** How the forge says a run is not one it re-runs, as against a call that failed. */
const REFUSED =
  /cannot be (?:retried|re-?run)|not (?:be )?(?:retried|re-?run)|HTTP 40[34]\b/iu;

/** What `moveHead` reads of a command it ran. */
export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** How `moveHead` runs a command; tests replace it. */
export type Exec = (
  argv: string[],
  opts: { timeoutSec: number; cwd?: string },
) => Promise<Ran>;

const drivenTree = (): string | undefined =>
  process.env.DRIVE_PR_WORKTREE || undefined;

const execInTree: Exec = (argv, opts) =>
  run(argv, {
    stderr: "pipe",
    timeoutSec: opts.timeoutSec,
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  });

const seconds = (name: string, fallback: number): number => {
  const read = readTimeoutEnv(name, fallback);
  return read.ok ? read.seconds : fallback;
};

/** Where a command `moveHead` runs runs: the driven tree, when the drive names one. */
const inTree = (): { cwd?: string } => {
  const cwd = drivenTree();
  return cwd === undefined ? {} : { cwd };
};

/**
 * Merge the base into the branch when it is behind it (`base-sync.ts
 * --force`): `"merged"`, `"none"` only on a confirmed in-sync reading,
 * a numeric refusal otherwise, `"conflict"` when the base does not merge cleanly.
 */
async function mergeBase(
  pr: string,
  exec: Exec,
): Promise<"merged" | "none" | "conflict" | number> {
  const sync = await exec(tsArgv(baseSync, [pr, "--force", "--json"]), {
    timeoutSec: seconds("DRIVE_PR_FETCH_TIMEOUT", 120) + 60,
    ...inTree(),
  });
  if (sync.code === 9) return "conflict";
  if (sync.code !== 0) {
    console.error(
      `  Merging the base failed (base-sync.ts exit ${sync.code}): ${sync.stderr.trim()}; refusing to move the head.`,
    );
    return sync.code;
  }
  return readBaseSync(sync.stdout);
}

/** Only positive base-sync reports authorize a head move. */
function readBaseSync(stdout: string): "merged" | "none" | 1 {
  try {
    const report: unknown = JSON.parse(stdout);
    if (isRecord(report)) {
      if (report.action === "merged" && report.reason === "merged")
        return "merged";
      if (report.action === "none" && report.reason === "in-sync")
        return "none";
    }
    console.error(
      "  base-sync.ts returned no confirmed merge or in-sync reading; refusing to move the head.",
    );
    return 1;
  } catch {
    console.error(
      "  base-sync.ts returned malformed JSON; refusing to move the head.",
    );
    return 1;
  }
}

/** Push the local head when it moved past `head`: `"continue"` once pushed, `5` when the pull request closed, else `1`. */
async function pushMoved(
  pr: string,
  head: string,
  exec: Exec,
  what: string,
  certified: string,
): Promise<number | "continue"> {
  const local = await exec(["git", "rev-parse", "HEAD"], {
    timeoutSec: gitCallTimeoutSeconds(),
    ...inTree(),
  });
  const moved = local.stdout.trim();
  if (
    local.code !== 0 ||
    moved === "" ||
    moved === head ||
    moved !== certified
  ) {
    console.error(
      `  The local head '${moved || "unreadable"}' is not the certified recovery commit; not pushing.`,
    );
    return 1;
  }
  const push = await exec(tsArgv(guardedPush, [pr, "--expect-head", moved]), {
    timeoutSec: seconds("DRIVE_PR_PUSH_TIMEOUT", 3600) + 60,
    ...inTree(),
  });
  if (push.code === 5) return 5;
  if (push.code !== 0) {
    console.error(
      `  Pushing the moved head failed (guarded-push.ts exit ${push.code}): ${push.stderr.trim()}`,
    );
    return 1;
  }
  console.error(`  Pushed ${what} (${moved}); waiting for the checks.`);
  return "continue";
}

/**
 * Move the head: merge the base when the branch is behind it, else commit an
 * empty commit and push it through `guarded-push.ts`. A local base merge is
 * handed to the next ordinary round for validation before its push. `"continue"`
 * once pushed or handed off, and when the base conflicts (the re-gate takes it to its
 * repair round); `5` when the pull request closed; `1` when the tree or the
 * push refused, the stop printing why.
 */
export async function moveHead(
  pr: string,
  head: string,
  exec: Exec = execInTree,
  commitEmpty: (pr: string, head: string) => Promise<Ran> = emptyCommit,
): Promise<number | "continue"> {
  const merged = await mergeBase(pr, exec);
  if (typeof merged === "number") return merged;
  if (merged === "conflict") {
    console.error(
      "  The base does not merge cleanly into the branch; re-gating, which takes the conflict to its repair round.",
    );
    return "continue";
  }
  if (merged === "merged") {
    console.error(
      "  The base merged locally; the next round inherits this commit and must run its validation plan before finish-round.ts pushes it.",
    );
    return "continue";
  }
  const commit = await commitEmpty(pr, head);
  if (commit.code !== 0) {
    console.error(
      `  Committing '${RERUN_COMMIT_MESSAGE}' failed: ${commit.stderr.trim()}`,
    );
    return 1;
  }
  return await pushMoved(
    pr,
    head,
    exec,
    `an empty commit, '${RERUN_COMMIT_MESSAGE}'`,
    commit.stdout.trim(),
  );
}

/**
 * The empty commit, under this tree's fence, refused over a tree holding
 * staged or modified tracked files: the commit must carry nothing.
 */
async function emptyCommit(pr: string, head: string): Promise<Ran> {
  const cwd = drivenTree();
  const opts = {
    ...(cwd === undefined ? {} : { cwd }),
    env: gitIdentityEnv(),
    stderr: "pipe" as const,
    timeoutSec: gitCallTimeoutSeconds(),
  };
  let fence: Awaited<ReturnType<typeof treeFence>>;
  try {
    fence = await treeFence(pr, "drive.ts");
  } catch (err) {
    return {
      code: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    return await checkedEmptyCommit(head, (argv) => git(argv.slice(1), opts));
  } finally {
    fence?.release();
  }
}

/** Under the tree fence, certify that hooks committed only the reviewed tree. */
export async function checkedEmptyCommit(
  head: string,
  exec: Exec,
): Promise<Ran> {
  const opts = { timeoutSec: gitCallTimeoutSeconds(), ...inTree() };
  const refused = (reason: string): Ran => ({
    code: 1,
    stdout: "",
    stderr: reason,
  });
  const before = await exec(["git", "rev-parse", "HEAD", "HEAD^{tree}"], opts);
  const [parent, tree] = before.stdout.trim().split("\n");
  if (before.code !== 0 || parent !== head || !tree)
    return refused(
      "HEAD no longer matches the reviewed head; use a validated round",
    );
  const status = await exec(
    ["git", "status", "--porcelain", "--untracked-files=no"],
    opts,
  );
  if (status.code !== 0 || status.stdout.trim() !== "")
    return refused("the tree holds tracked changes or could not be read");
  const commit = await exec(
    ["git", "commit", "--allow-empty", "-m", RERUN_COMMIT_MESSAGE],
    opts,
  );
  if (commit.code !== 0) return commit;
  const after = await exec(
    ["git", "rev-parse", "HEAD", "HEAD^", "HEAD^{tree}"],
    opts,
  );
  const [sha, actualParent, actualTree] = after.stdout.trim().split("\n");
  if (after.code !== 0 || !sha || actualParent !== head || actualTree !== tree)
    return refused(
      "the recovery commit changed the reviewed parent or tree; use a validated round",
    );
  return { code: 0, stdout: sha, stderr: "" };
}

/** The repository the drive's forge reads name, `owner/name`; `null` when unread. */
async function repoSlug(): Promise<string | null> {
  const view = await cachedRepoView([
    "--json",
    "owner,name",
    "-q",
    '.owner.login + "/" + .name',
  ]);
  const slug = view.stdout.trim();
  return view.code === 0 && /^[^/\s]+\/[^/\s]+$/u.test(slug) ? slug : null;
}

const defaultDeps: InfraDeps = {
  async readLogs(runs) {
    const slug = await repoSlug();
    if (slug === null) return null;
    const logs: string[] = [];
    for (const id of runs) {
      const r = await ghCall([
        "run",
        "view",
        String(id),
        "--log-failed",
        "--repo",
        slug,
      ]);
      if (r.code !== 0) return null;
      logs.push(r.stdout);
    }
    return logs;
  },
  rerunnable: (pr, runs) => rerunnableRuns(pr, runs),
  async rerun(id) {
    const slug = await repoSlug();
    if (slug === null)
      return { answer: "failed", detail: "the repository could not be read" };
    const r = await ghCall([
      "run",
      "rerun",
      String(id),
      "--failed",
      "--repo",
      slug,
    ]);
    if (r.code === 0) return { answer: "rerun", detail: "" };
    const detail = r.stderr.trim() || `gh exited ${r.code}`;
    return { answer: REFUSED.test(detail) ? "refused" : "failed", detail };
  },
  moveHead: (pr, head) => moveHead(pr, head),
  sleep,
};
