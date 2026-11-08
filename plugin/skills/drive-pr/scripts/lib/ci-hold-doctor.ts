/** Read-only evidence gathering for a recorded CI hold. */
import { realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isRecord } from "../../../../shared/guards.ts";
import type { ProcessRow } from "../../../../shared/process-table.ts";
import { readDriverRecord } from "./ledger-stop.ts";
import { worktreePathKey } from "./state/actor.ts";
import { judge } from "../../../../shared/liveness.ts";
import { processTable } from "../../../../shared/process-table.ts";
import {
  diagnoseCiHold,
  type CiHoldDiagnosis,
  type CiHoldEvidence,
} from "./ci-hold-diagnosis.ts";
import { holdLabelPolicy } from "./ci-policy.ts";
import {
  ciHoldTransitions,
  ownsHeldTransition,
  parsePrSnapshot,
} from "./ci-hold.ts";
import { verifyCheckoutIsPrHead } from "./base-drift.ts";
import { readTimeline } from "./pr-timeline.ts";
import {
  type RunResult,
  ghCall,
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  unconcludedGitOpMarker,
} from "./proc.ts";
import { leaseRefsFor, readLease } from "./state/lease.ts";
import type { DriveState } from "./state/schema.ts";
import { type Ledger, newerClaim } from "./state/ledger.ts";
import { readLedgerSnapshot, resolveLogin } from "./state/ledger-forge.ts";
import { peekCloneKey } from "./state/clone-key.ts";
import { cloneId } from "./state/ledger-mirror.ts";
import { emptyReport, evaluate } from "./status/evaluate.ts";

class DiagnosticReadError extends Error {
  readonly code = "CI_HOLD_DIAGNOSIS_UNREADABLE";
}

async function currentLedger(pr: string): Promise<Ledger> {
  const snapshot = await readLedgerSnapshot(pr, await resolveLogin());
  if (typeof snapshot === "string") throw new DiagnosticReadError(snapshot);
  const parsed = snapshot.canonical?.parsed;
  if (parsed?.kind !== "ledger")
    throw new DiagnosticReadError(
      "the current forge ledger is absent or unreadable",
    );
  const ledger = parsed.ledger;
  const own =
    snapshot.claims.find(
      (claim) =>
        claim.id === ledger.driver.position &&
        claim.claim.clone === ledger.driver.clone,
    ) ?? null;
  const takeover = newerClaim(
    snapshot.claims,
    ledger.driver.position ?? 0,
    ledger.driver.clone,
    own,
  );
  if (takeover !== null)
    throw new DiagnosticReadError(
      `another clone's claim (comment ${takeover.id}) took the drive over`,
    );
  return ledger;
}

export type LedgerDriverEvidence = Pick<
  CiHoldEvidence,
  | "driver"
  | "driverReason"
  | "worktree"
  | "actor"
  | "generation"
  | "started"
  | "pr"
>;

export async function readLedgerDriver(
  e: LedgerDriverEvidence,
  stateDir: string,
  lock: string,
  ledger: Ledger,
): Promise<void> {
  const leases = leaseRefsFor(stateDir, e.pr).flatMap((ref) => {
    const lease = readLease(ref);
    return lease === null ? [] : [lease];
  });
  const rows = await processTable();
  const readings = leases.map((lease) => ({
    lease,
    result: lease.holder === "session" ? judge(lease, rows) : null,
  }));
  const alive = readings.find(
    (r) => r.result?.ok && r.result.value.state === "alive",
  );
  const unknown = readings.find((r) => r.result === null || !r.result.ok);
  const matching = readings.find(
    (r) =>
      r.lease.actor === ledger.driver.actor &&
      r.lease.sessionStarted === ledger.driver.started,
  );
  const selected = alive ?? unknown ?? matching;
  if (selected === undefined) {
    readReleasedDriver(e, stateDir, lock, ledger, rows);
    return;
  }
  const { lease, result } = selected;
  e.driver = result?.ok ? result.value.state : "unknown";
  e.driverReason =
    result === null
      ? "worktree lease has no process identity"
      : result.ok
        ? result.value.reason
        : result.failure.reason;
  e.worktree = lease.worktree || null;
  e.actor = lease.actor;
  e.generation = lease.generation;
  e.started = lease.sessionStarted || null;
  if (
    ledger.driver.clone !== cloneId(stateDir) ||
    selected !== matching ||
    e.started === null
  ) {
    e.driver = "unknown";
    e.driverReason =
      "the current forge ledger cannot be matched to the recorded local process";
  }
  if (
    e.driver !== "alive" &&
    ["live", "contested", "unreadable"].includes(lock)
  ) {
    e.driver = "unknown";
    e.driverReason = `the driver lock is ${lock}`;
  }
}

/** A released record witnesses that the pass tree ended; an absent local pid proves the driver ended too. */
function readReleasedDriver(
  e: LedgerDriverEvidence,
  stateDir: string,
  lock: string,
  ledger: Ledger,
  rows: ProcessRow[] | null,
): void {
  if (!["empty", "stale"].includes(lock)) return;
  const record = readDriverRecord(stateDir, e.pr);
  if (record?.released !== true) return;
  if (
    ledger.driver.clone !== cloneId(stateDir) ||
    ledger.driver.started !== record.started ||
    ledger.driver.actor !== `wt-${worktreePathKey(record.worktree)}`
  )
    return;
  const result = judge(
    { host: record.host, hostId: "", bootId: "", pid: record.pid, start: "" },
    rows,
  );
  e.driver = result.ok ? result.value.state : "unknown";
  e.driverReason = result.ok ? result.value.reason : result.failure.reason;
  e.worktree = record.worktree;
  e.actor = ledger.driver.actor;
  e.started = record.started;
}

function requirePassTermination(
  e: CiHoldEvidence,
  stateDir: string,
  ledger: Ledger,
): void {
  const record = readDriverRecord(stateDir, e.pr);
  if (
    record?.released !== true ||
    record.started !== ledger.driver.started ||
    `wt-${worktreePathKey(record.worktree)}` !== ledger.driver.actor
  ) {
    throw new DiagnosticReadError(
      "the stopped driver's pass termination was not witnessed",
    );
  }
}

async function readJson(args: string[]): Promise<Record<string, unknown>> {
  const raw = await ghCall(args);
  if (raw.code !== 0)
    throw new DiagnosticReadError(
      `gh ${args.slice(0, 2).join(" ")} exited ${raw.code}: ${raw.stderrTail || raw.stderr.trim().slice(-500)}`,
    );
  const value: unknown = JSON.parse(raw.stdout);
  if (!isRecord(value))
    throw new DiagnosticReadError(
      `gh ${args.slice(0, 2).join(" ")} returned an invalid object`,
    );
  return value;
}

async function readHold(
  e: CiHoldEvidence,
  state: DriveState,
): Promise<{ head: string; branch: string } | null> {
  e.label = holdLabelPolicy();
  const value = await readJson([
    "pr",
    "view",
    e.pr,
    "--json",
    "state,headRefOid,headRefName,labels",
  ]);
  const live = parsePrSnapshot(value, e.label);
  if (live === null)
    throw new DiagnosticReadError(
      "the PR head and CI hold label could not be read",
    );
  e.head = live.head;
  e.held = live.held;
  if (live.state !== "OPEN" || e.label === null) return null;
  const events = await readTimeline(e.pr);
  if (!events.ok) throw new DiagnosticReadError(events.failure.reason);
  const transitions = ciHoldTransitions(events.value, e.label);
  if (transitions === null)
    throw new DiagnosticReadError(
      "the CI hold timeline contains an unreadable label transition",
    );
  e.transitionId = transitions.at(-1)?.id ?? null;
  e.ownership =
    transitions !== null &&
    ownsHeldTransition(state.ciHold, transitions.at(-1) ?? null);
  return {
    head: live.head,
    branch: typeof value.headRefName === "string" ? value.headRefName : "",
  };
}

function requireGitRead(result: RunResult, command: string): void {
  if (result.code !== 0)
    throw new DiagnosticReadError(
      `git ${command} exited ${result.code}: ${result.stderrTail || result.stderr.trim().slice(-500)}`,
    );
}

async function sameClone(
  cwd: string,
  stateDir: string,
): Promise<string | null> {
  const env = gitIdentityEnv();
  const timeoutSec = gitCallTimeoutSeconds();
  const [tree, caller] = await Promise.all([
    git(["rev-parse", "--git-common-dir"], { cwd, env, timeoutSec }),
    git(["rev-parse", "--git-common-dir"], { env, timeoutSec }),
  ]);
  requireGitRead(tree, "rev-parse --git-common-dir (driver worktree)");
  requireGitRead(caller, "rev-parse --git-common-dir (diagnosing checkout)");
  const common = realpathSync(resolve(cwd, tree.stdout.trim()));
  if (common !== realpathSync(resolve(process.cwd(), caller.stdout.trim())))
    return "the driver worktree belongs to another clone";
  return peekCloneKey(common) === basename(stateDir)
    ? null
    : "the driver worktree's clone identity does not match the diagnosed state directory";
}

async function cleanTree(
  cwd: string,
  branchName: string,
  expectedHead: string,
  stateDir: string,
): Promise<string | null> {
  const mismatch = await sameClone(cwd, stateDir);
  if (mismatch !== null) return mismatch;
  const env = gitIdentityEnv();
  const timeoutSec = gitCallTimeoutSeconds();
  const [head, dirty, branch, operation] = await Promise.all([
    git(["rev-parse", "HEAD"], { cwd, env, timeoutSec }),
    git(
      [
        "status",
        "--porcelain",
        "--untracked-files=normal",
        "--ignore-submodules=none",
      ],
      { cwd, env, timeoutSec },
    ),
    verifyCheckoutIsPrHead(git, cwd, branchName, expectedHead, env),
    unconcludedGitOpMarker(timeoutSec, { cwd, env }),
  ]);
  requireGitRead(head, "rev-parse HEAD");
  requireGitRead(
    dirty,
    "status --porcelain --untracked-files=normal --ignore-submodules=none",
  );
  if (!branch.ok) return `the driver worktree is unsafe: ${branch.why}`;
  if (!operation.ok)
    throw new DiagnosticReadError(
      `the driver worktree's unfinished git operations could not be inspected: ${operation.reason}`,
    );
  if (head.stdout.trim() !== expectedHead)
    return `the driver worktree's HEAD is ${head.stdout.trim()}, expected ${expectedHead}`;
  if (dirty.stdout !== "") return "the driver worktree has uncommitted changes";
  return operation.marker === null
    ? null
    : `the driver worktree has an unfinished git operation (${operation.marker})`;
}

async function readReview(
  e: CiHoldEvidence,
  scripts: string,
  head: string,
): Promise<void> {
  const repository = await readJson([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
  ]);
  const slug = repository.nameWithOwner;
  if (typeof slug !== "string" || slug.split("/").length !== 2)
    throw new DiagnosticReadError(
      "the forge repository identity could not be read",
    );
  const [owner, repo] = slug.split("/");
  if (owner === undefined || repo === undefined) return;
  const report = emptyReport();
  // evaluate reads evidence directly, without drive-status's reply sweep or counters.
  await evaluate(
    {
      pr: e.pr,
      owner,
      repo,
      botsOnly: false,
      headSync: true,
      localHead: head,
      driveStateScript: join(scripts, "drive-state.ts"),
      listThreadsScript: join(
        scripts,
        "..",
        "..",
        "resolve-review-comments",
        "scripts",
        "list-unresolved-threads.ts",
      ),
      summaryScript: join(scripts, "summary-findings.ts"),
      helperTimeoutSec: 30,
    },
    report,
  );
  e.review =
    report.state === "CONVERGED" && report.apiHead === head
      ? "converged"
      : ["INDETERMINATE", "UNSUPPORTED_CLI"].includes(report.state)
        ? "unknown"
        : "pending";
  if (e.review !== "converged")
    e.readFailure = `review evidence ${report.state}: ${report.reason}`;
}

export async function ciHoldDoctor(
  stateDir: string,
  pr: string,
  state: DriveState,
  lock: string,
  scripts: string,
): Promise<CiHoldDiagnosis> {
  const e: CiHoldEvidence = {
    driver: "unknown",
    driverReason: "no recorded process identity",
    head: null,
    label: null,
    held: null,
    review: "unknown",
    worktree: null,
    worktreeSafe: false,
    ownership: false,
    parked: state.parked.length,
    actor: null,
    generation: null,
    started: null,
    pr,
    releaseScript: join(scripts, "ci-hold.ts"),
  };
  try {
    const ledger = await currentLedger(pr);
    e.ledgerGeneration = ledger.generation;
    e.parked = Math.max(state.parked.length, ledger.parked.length);
    await readLedgerDriver(e, stateDir, lock, ledger);
    requirePassTermination(e, stateDir, ledger);
    const live = await readHold(e, state);
    if (live === null || e.worktree === null) return diagnoseCiHold(e);
    const unsafe = await cleanTree(
      e.worktree,
      live.branch,
      live.head,
      stateDir,
    );
    e.worktreeSafe = unsafe === null;
    if (unsafe !== null) e.worktreeReason = unsafe;
    else await readReview(e, scripts, live.head);
  } catch (error) {
    e.readFailure = error instanceof Error ? error.message : String(error);
    e.ownership = false;
  }
  return diagnoseCiHold(e);
}
