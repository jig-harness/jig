#!/usr/bin/env bun
/**
 * Drive review rounds on one PR until it reaches exactly one terminal state.
 *
 * The loop BODY has to be an agent — something must read each finding and
 * choose an outcome. The loop CONTROL does not, and keeping it here is what
 * lets the drive run unattended from any harness: each round is a fresh agent
 * process, so a long converge never depends on one session's context
 * surviving.
 *
 * Usage:
 *   drive.ts [PR] [flags] -- <command to run ONE pass> [args...]
 *
 *   --max-rounds N   stop after N rounds (default `drive.max_rounds`, else
 *                    10). A finding the agent cannot fix would otherwise
 *                    re-push forever.
 *   --handoff-at V   the context-economy dial: hand off at V% of the pass's
 *                    context rather than degrading. V is a whole percent, or
 *                    `never` for a continuous drive through compaction.
 *                    Aliases: `careful` (50, the default), `eager` (75),
 *                    `continuous` (never). Exported to the pass as
 *                    $DRIVE_PR_HANDOFF_AT. This one is AGENT-JUDGED, not
 *                    measured — see below.
 *   --bots-only      count only bot-authored threads (pass it to the agent
 *                    too).
 *   --keep-draft     do NOT mark a draft PR Ready for review at all; the same
 *                    as `pull_requests.mark_ready: never` for this run. When
 *                    the drive marks a draft Ready is otherwise
 *                    `pull_requests.mark_ready`: after round N (default 1),
 *                    or only at convergence. Off by default: repo policy births
 *                    every PR as a draft, the configured AI reviewer reviews
 *                    drafts but CodeRabbit refuses them, so the drive clears
 *                    the AI reviewer's findings and THEN marks the PR Ready,
 *                    spending the paid external reviewer's one pass on an
 *                    already-cleaned head.
 *                    See mark-ready.ts for the measurements.
 *   --timeout S      forwarded to drive-status.ts.
 *   --interval S     forwarded to drive-status.ts.
 *   --no-head-sync   forwarded to drive-status.ts.
 *
 * There is deliberately no `--head`: drive.ts DRIVES THE TREE IT RUNS IN. Its
 * worktree lock is keyed on that tree, its pass edits and pushes that tree, and
 * its convergence certification (`rev-parse HEAD`, the operation markers,
 * `git status`) reads that tree — so a flag pointing the head COMPARISON
 * somewhere else could only ever describe a repository nothing else in this
 * file touches. A briefly-forwarded `--head` was all three reviewers' finding
 * in one round: frozen at startup, it wedges the head-sync guard in
 * HEAD_LAG the moment a pass pushes; being a caller's assertion at one instant
 * rather than a continuing measurement, it cannot attest sameness for the stall
 * stop either; and it left the convergence certification reading the driver's
 * own unrelated checkout. `$DRIVE_PR_WORKTREE` is the mechanism that survived:
 * drive.ts exports the tree it drives and drive-status.ts RE-MEASURES there at
 * every gate. `drive-status.ts --head` remains, for a single-shot probe where
 * one instant is all that is claimed.
 *   --dry-run        report each round's decision; never invoke the pass.
 *
 * The pass command is given as ARGV after `--`, and is executed directly —
 * never through a shell. An opaque command string run through a shell would
 * have to be proven, by walking it character by character tracking quote state,
 * to name the right PR in every `;`/`&&`/`||`/`|`-separated segment — because a
 * pass that silently targets the current branch's PR edits and resolves threads
 * on the wrong pull request. Taking argv removes the shell layer, so there are
 * no segments to prove anything about and the guard below is an exact token
 * test (resolve-review-comments' converge.ts takes the same interface for the
 * same reason).
 *
 *   drive.ts 123 --bots-only -- claude -p "/jig:drive-pr --bots-only 123"
 *
 * Exit codes mirror drive-status.ts, plus 6:
 *   0  converged (SHA-verified)
 *   1  a pass failed, or the state could not be read
 *   2  usage error
 *   4  timed out waiting for the round to become judgeable, OR the reviewer
 *      converged but another driver holds the Ready-mark lease — not full
 *      convergence, since that driver dying would leave the PR a draft
 *      forever with nothing left to retry it
 *   5  the PR stopped being open — the loop stops WITHOUT running another pass
 *   6  hit --max-rounds without converging
 *   7  the posting reviewer's check-run did not pass
 *   8  HITL-parked — everything left awaits a human decision; does NOT re-arm
 *   9  the PR conflicts with its base AND has nothing left to work — the base
 *      has to be merged in first. A conflict with live findings is a normal
 *      ROUND_READY instead; only the no-work case is terminal
 *  11  another LIVE driver already holds this PR's single-instance lock —
 *      refused without touching any state
 *  12  the review converged, but this worktree still has uncommitted state.
 *      The convergence itself is real (it is a claim about the remote); the
 *      leftovers are edits no round shipped — scratch probes, regenerated
 *      artefacts, a fix from a round that ended another way — and exiting 0
 *      over them is how they silently die with the worktree. Commit or
 *      discard them, then re-run
 *  13  another live WORKING TREE is driving this PR, met at
 *      the round's own bump-attempt. The single-instance lock above does
 *      not cover it: that lock is only ever held by another drive.ts, so
 *      an INTERACTIVE pass in another worktree — which takes no lock — is
 *      invisible to it. Nothing was written; stop rather than become the
 *      second resolver.
 *  14  the loop STALLED: $DRIVE_PR_STALL_ROUNDS (default 2) consecutive
 *      completed passes changed nothing this loop can observe — the
 *      reviewed head did not move and every thread/finding IDENTITY SET
 *      (not merely count — a substitution that swaps one resolved thread
 *      for one new one leaves the count unchanged) came back identical.
 *      A pass that exits 0 without acting (the measured case: a pass
 *      standing down after mistaking its own parent driver for a
 *      competing drive) burns the whole
 *      --max-rounds budget while the round headers look like progress;
 *      this stop names what did not happen instead. A DIFFERENT code from
 *      `13` deliberately: a caller reading the exit code alone must be able
 *      to tell "another working tree owns this PR" (recoverable by waiting
 *      or handing off) from "this pass is stuck and needs a human look"
 *      (recoverable by reading the pass output) — sharing one code
 *      collapsed that distinction, which the terminal-state table exists
 *      to preserve.
 *  15  the pass hit $DRIVE_PR_PASS_TIMEOUT and was killed. Distinct from
 *      `1` because it is the one pass failure that says nothing about the
 *      pass's own logic: it ran out of wall clock, and what a caller does
 *      next (widen the deadline, or go look for the hang) has no overlap
 *      with what a genuine pass failure asks for. It is also the only
 *      code here that can name an in-flight hang rather than a completed
 *      one — every other stop in this loop, `14` included, can only fire
 *      between rounds, which is where the hangs are not.
 *  16  QUOTA-PARKED: the pass died on a subscription usage wall that will
 *      not reopen within the sleep bound — a weekly window, an
 *      unclassifiable one, or a reset this loop could not resolve. NOT a
 *      pass failure and deliberately not `1`: nothing is wrong with the
 *      PR, the tree or the pass, and the recovery is a clock rather than
 *      a fix. A SHORT window does not reach this code at all — the driver
 *      sleeps through that one and resumes, since the whole cost of
 *      stopping there is a re-arm nobody is awake to perform.
 *  18  MAILBOX_STOPPED: a stop directive was observed at a round boundary.
 *      The in-flight pass, if any, already finished; normal exit releases locks.
 *  19  MAILBOX_PAUSE_TIMEOUT: a pause stayed active beyond the bounded wait.
 *      Resume the pause directive and re-arm the drive.
 */

import { PROCESS_REGISTRY_ENV } from "../../../shared/process-registry.ts";
import { driverStopRequested, stopRequestPath } from "./lib/stop-request.ts";
import {
  registerCleanup,
  registerSignalHandler,
} from "../../../shared/cleanup.ts";
import { span } from "../../../shared/trace.ts";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { ciPolicy } from "./lib/ci-policy.ts";
import {
  CLAIM_PREFIX,
  type ClaimDiag,
  claimLive,
  claimName,
  formatClaim,
  heartbeatStaleMs,
  parseClaimText,
  stagingLive,
  parseStagingHost,
} from "./lib/claim.ts";
import {
  fail,
  isDigits,
  runMain,
  shellQuote,
  sleep,
  testPacing,
} from "./lib/cli.ts";
import { FinalCiWait } from "./lib/final-ci-wait.ts";
import { DriverLog, type DriverLogLevel } from "./lib/driver-log.ts";
import { errnoCode } from "../../../shared/errors.ts";
import {
  type AccountIdentity,
  formatAccountIdentity,
  resolveAccountIdentity,
} from "./lib/identity.ts";
import {
  ciHoldTimeoutSeconds,
  driveStatusOnceTimeoutSeconds,
  finalVerifyTimeoutSeconds,
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  helperTimeoutSeconds,
  markReadyTimeoutSeconds,
  type RunHandle,
  readTimeoutEnv,
  resolvePr,
  run,
  tsArgv,
  unconcludedGitOpMarker,
} from "./lib/proc.ts";
import {
  DEFAULT_MAX_ROUNDS,
  maxRoundsSetting,
  reviewerLabel,
} from "./lib/overlay.ts";
import {
  type MarkReady,
  markReadyDueAfterRound,
  prPolicy,
} from "./lib/pr-policy.ts";
import {
  describe as describeQuota,
  detectQuotaBlock,
  planFor,
  prepareQuotaSpawn,
  snapshotQuotaSessions,
} from "./lib/quota/index.ts";
// The code itself rather than a literal repeated here — see its own comment.
import {
  DRIVE_HELD_ELSEWHERE_EXIT,
  stateDirIdentityToken,
} from "./lib/state/lease.ts";
import { foldGateState, resolveMailboxDir } from "./lib/state/mailbox.ts";
import { reflectDepthPastLast } from "./lib/state/schema.ts";
import { reflectionSwitch } from "../../reflect/scripts/lib/settings.ts";
import { resolveStateDir, worktreeLockName } from "./lib/state/store.ts";
// TERMINAL_STATES is the canonical source — every driver-only exit
// constant below is DERIVED from it, not an independently hand-typed literal
// that happens to match, so the two cannot drift apart silently the way they
// used to (see each constant's own comment and terminal-states.ts's
// own header for the other half of this binding).
import { driverOnlyExitCode } from "./lib/status/terminal-states.ts";

const here = dirname(fileURLToPath(import.meta.url));
const driveState = join(here, "drive-state.ts");
const driveStatus = join(here, "drive-status.ts");
const ciHold = join(here, "ci-hold.ts");
const loopMetrics = join(here, "loop-metrics.ts");
const markReady = join(here, "mark-ready.ts");
const captureIntentChain = join(here, "capture-intent-chain.ts");

// The words `mark-ready.ts` documents as its whole exit-0 STDOUT contract (its
// own top-of-file comment). Exit 0 with anything else is a malformed or
// truncated response, not a settled transition — validated at both call sites
// below rather than trusted: an unrecognized outcome must not be read as
// "nothing owed". `not-open` is deliberately absent, because it never arrives
// at exit 0; it is exit 5, which both call sites answer before ever looking at
// stdout.
const MARK_READY_OUTCOMES = new Set([
  "marked",
  "already-ready",
  "already-marked",
  "claimed-by-other",
  "still-draft",
]);

/**
 * The loop-economy block a drive prints when it stops: rounds,
 * thread count, outcome mix, and how much of the code landed AFTER review
 * started — temporal, not causal; see `lib/metrics.ts` § "What the split does
 * NOT establish".
 *
 * BEST-EFFORT, and that is a deliberate asymmetry with every other spawn in
 * this file. The round budget, the durable counters and the parked set are all
 * read HARD — an unreadable one is a loop with no bound, so it stops the drive.
 * This is a REPORT: nothing acts on it, no gate consumes it, and a drive that
 * converged has converged whether or not its epilogue rendered. Failing the
 * drive over a missing summary would be strictly worse than printing a note.
 *
 * Returns the text rather than writing it, so a caller can pay the network cost
 * at a point of its choosing and print at another — which the converged path
 * needs, because its final HEAD re-read must stay the LAST thing before the
 * convergence is reported. Always a string: a failure renders as a note saying
 * so, never as silence, so an operator can tell "cheap loop" from "no answer".
 */
async function loopEconomy(pr: string): Promise<string> {
  // Leniently read, unlike announce-merge-ready.ts's validated use of the same
  // variable: a malformed deadline there refuses an announcement, and here it
  // would refuse a decoration. Fall back to the documented default instead.
  const read = readTimeoutEnv("DRIVE_PR_HELPER_TIMEOUT", 120);
  const r = await run(tsArgv(loopMetrics, [pr]), {
    timeoutSec: read.ok ? read.seconds : 120,
    stderr: "ignore",
  });
  if (r.code !== 0 || r.stdout.trim() === "") {
    return `  (loop-metrics could not read PR #${pr} — no economy summary this run)\n`;
  }
  return r.stdout;
}

/**
 * Surface a total severity-parsing outage before an agent starts triaging the
 * round. This is reporting only: an unreadable metric must never prevent a
 * pass that could repair the reviewer format or its findings.
 */
async function severityWarnings(pr: string): Promise<string> {
  const read = readTimeoutEnv("DRIVE_PR_HELPER_TIMEOUT", 120);
  const r = await run(tsArgv(loopMetrics, [pr, "--severity-warnings"]), {
    timeoutSec: read.ok ? read.seconds : 120,
    stderr: "ignore",
  });
  if (r.code !== 0) {
    return `  (loop-metrics could not read severity warnings for PR #${pr} — continuing without them this round)\n`;
  }
  return r.stdout;
}

/**
 * What the driven worktree still holds, for a NON-converged stop.
 *
 * The converged path already certifies a clean tree and refuses to exit 0 over
 * leftovers, so it needs no such report. The stall stop is the mirror case: a
 * pass that made real, correct edits and then stood down without committing
 * exits the loop with its work product sitting in the worktree, and without
 * this report nothing tells the operator so; a `git checkout`, a re-arm, or a
 * branch switch would then destroy those edits.
 *
 * Reports rather than decides: the exit code is the caller's, unchanged.
 * Never silence — a tree that cannot be READ is reported as unreadable,
 * because "no leftovers" over a failed probe is the false all-clear this
 * exists to prevent; a clean tree is stated positively for the same reason;
 * an unconcluded git operation and uncommitted paths are each named when
 * present, together when both are (leftoverReport below is the source of
 * truth for the exact population — this comment doesn't re-enumerate it).
 * Silence is what the operator could not distinguish from any of these.
 *
 * Same flags as the convergence-path probe, for the same measured reasons:
 * `--untracked-files=normal` because `--porcelain` alone inherits
 * `status.showUntrackedFiles`, where `=no` hides an untracked file entirely,
 * and `--ignore-submodules=none` because `submodule.<name>.ignore = all` hides
 * modifications one level down regardless of the untracked-files mode.
 */
async function leftoverReport(): Promise<string> {
  const dirty = await git(
    [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    { stderr: "ignore", timeoutSec: gitCallTimeoutSeconds() },
  );
  if (dirty.code !== 0) {
    return (
      "  This worktree is UNREADABLE, so what it still holds is unknown — check it\n" +
      "  by hand before any command that discards state (git checkout/reset, a branch\n" +
      "  switch, a re-arm).\n"
    );
  }
  // Porcelain answers "is anything uncommitted", not "is a git operation
  // still open": resolving a conflict back to a tree that matches what was
  // already committed leaves MERGE_HEAD behind while porcelain reports empty
  // — the same gap the CONVERGED
  // path checks via this same helper, below.
  const op = await unconcludedGitOpMarker(gitCallTimeoutSeconds());
  // A stalled tree can carry BOTH signals at once — a conflict-resolution
  // pass commonly does — so report every one that's KNOWN rather than
  // collapsing to one message and hiding the rest (an early return on the op
  // marker once discarded already-collected dirty paths, and a failed op-marker
  // PROBE discarded them too, even though `dirty` — read successfully above
  // — was already known). `op.ok === false` means only the marker check
  // itself is unreadable; the porcelain read that already succeeded is not
  // thereby unknown, so it is still reported, alongside an explicit note
  // that the operation-marker state specifically could not be determined.
  if (op.ok && op.marker === null && dirty.stdout === "") {
    return "  This worktree is clean — nothing was left behind by the stalled pass(es).\n";
  }
  let report = "";
  if (!op.ok) {
    report +=
      "  Whether an unconcluded git operation (MERGE_HEAD or similar) is present could\n" +
      "  NOT be determined — check by hand before any command that discards state.\n";
  } else if (op.marker !== null) {
    report +=
      `  An UNCONCLUDED GIT OPERATION is present (${op.marker}) — resolve or abort it\n` +
      "  (git merge/cherry-pick/revert --abort) before any command that discards state.\n";
  }
  if (dirty.stdout !== "") {
    report +=
      "  UNCOMMITTED WORK IS LEFT IN THIS WORKTREE. It shipped in no round and no push,\n" +
      "  so it exists nowhere else — commit it on this branch or copy it out BEFORE any\n" +
      "  command that discards state (git checkout/reset, a branch switch, a re-arm):\n" +
      dirty.stdout;
  } else {
    // `dirty.stdout === ''` is known regardless of `op.ok` — the porcelain
    // read succeeded earlier and is independent of the op-marker probe. A
    // failed probe must not suppress this already-known result too (an
    // earlier `else if (op.ok)` guard here was the SAME bug it was meant to
    // close, one level down).
    report += "  No uncommitted paths — porcelain status is clean.\n";
  }
  return report;
}

/** Re-certify the local tree immediately before the converged success return. */
async function certifyFinalWorktree(
  reviewedHead: string,
  passes: number,
): Promise<boolean> {
  const unreadable = () => {
    console.error(
      `review converged after ${passes} round(s), but the working tree is UNREADABLE —`,
    );
    console.error(
      "cannot certify the worktree is clean, so not exiting 0 over unknown leftovers.",
    );
  };
  const timeoutSec = gitCallTimeoutSeconds();
  const localHeadRes = await git(["rev-parse", "HEAD"], {
    stderr: "ignore",
    timeoutSec,
  });
  if (localHeadRes.code !== 0) {
    unreadable();
    return false;
  }
  if (reviewedHead === "" || localHeadRes.stdout.trim() !== reviewedHead) {
    console.error(
      `review converged after ${passes} round(s), but local HEAD is ${localHeadRes.stdout.trim() || "<empty>"},`,
    );
    console.error(
      `while the reviewed head is ${reviewedHead || "<empty>"} — a commit landed here`,
    );
    console.error(
      "that was never pushed or reviewed. Push it, or reset to the reviewed head, then re-run.",
    );
    return false;
  }
  const op = await unconcludedGitOpMarker(timeoutSec);
  if (!op.ok) {
    unreadable();
    return false;
  }
  if (op.marker !== null) {
    console.error(
      `review converged after ${passes} round(s), but an unconcluded git operation is present (${op.marker}) —`,
    );
    console.error("resolve or abort it, then re-run.");
    return false;
  }
  const dirty = await git(
    [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    { stderr: "ignore", timeoutSec },
  );
  if (dirty.code !== 0) {
    unreadable();
    return false;
  }
  if (dirty.stdout !== "") {
    console.error(
      `review converged after ${passes} round(s), but this worktree still has uncommitted state:`,
    );
    process.stderr.write(dirty.stdout);
    console.error(
      "These edits shipped in no round — commit or discard them, then re-run.",
    );
    return false;
  }
  const finalHeadRes = await git(["rev-parse", "HEAD"], {
    stderr: "ignore",
    timeoutSec,
  });
  if (finalHeadRes.code !== 0) {
    unreadable();
    return false;
  }
  if (finalHeadRes.stdout.trim() !== reviewedHead) {
    console.error(
      `review converged after ${passes} round(s), but local HEAD is ${finalHeadRes.stdout.trim() || "<empty>"},`,
    );
    console.error(
      `while the reviewed head is ${reviewedHead || "<empty>"} — a commit landed here during the final check.`,
    );
    console.error("Push it, or reset to the reviewed head, then re-run.");
    return false;
  }
  return true;
}

/**
 * One ROUND_READY gate's observable outcome surface, serialized for equality:
 * the head the reviewer judged, the local head when the gate measured one, and
 * every work count drive-status.ts reported. Two consecutive gates reading the
 * SAME fingerprint means the pass that ran between them produced nothing this
 * loop can observe — no push, no reply, no resolution, no addressed finding —
 * which is the stall signature: a pass that exits 0 after standing down (for
 * example, against its own parent driver) looks exactly
 * like a productive round to every other counter this loop keeps.
 *
 * Null means "cannot attest sameness", never "same": an unreadable head or a
 * gate where neither the thread count nor the summary-finding count was
 * measured produces no fingerprint at all, so an unmeasurable round can only
 * ever RESET the stall streak — the failure direction is a drive that runs to
 * --max-rounds as before, not one stopped on a guess. Counts that CAN be null
 * per-field (countOrNull) still participate when at least one core count is a
 * number: null-vs-number is itself an observable change, and serializing the
 * field keeps it one.
 *
 * That rule binds the LOCAL head, which must be MEASURED — a real SHA from
 * `head.local`, whatever `head.localSource` says produced it. Without one, a
 * pass can commit (or commit and push, while the API head this gate read is
 * still stale) and every other field stays put, so the verdict would indict a
 * round that did work and the report would state, falsely, that nothing was
 * pushed. `--no-head-sync` is not an exemption from that — a caller declining
 * to COMPARE the local head is not a caller asserting no local head exists
 * (that holds both for a measurement that failed and for the deliberate
 * opt-out). `drive.ts` has deliberately no `--head` to fall back on (this
 * file's own top-of-file comment — it drives the tree it runs in); a drive
 * that genuinely cannot measure in its own tree instead gets `local: ''` /
 * `localSource: 'unavailable'` from drive-status.ts, which the empty-string
 * check above already refuses — losing only this earlier stop and falling
 * back to the `--max-rounds` bound, same as a caller that opts out entirely.
 *
 * And it binds work IDENTITIES, not cardinalities. Counts alone call a
 * SUBSTITUTION unchanged — a pass resolves thread A while the reviewer posts
 * thread B, so the count stays 1 across a round that did real work. The key
 * arrays are therefore required, not optional: a gate that measured counts
 * but published no keys cannot attest sameness, and says so with `null`
 * rather than falling back to the weaker evidence.
 */
export function roundFingerprint(
  status: Record<string, unknown>,
): string | null {
  const head = status.head as Record<string, unknown> | undefined;
  const work = status.work as Record<string, unknown> | undefined;
  const api = head?.api;
  if (typeof api !== "string" || api === "") return null;
  const local = head?.local;
  if (typeof local !== "string" || local === "") return null;
  const localSource =
    typeof head?.localSource === "string" ? head.localSource : "";
  // Only a provenance KNOWN to re-measure the driven worktree attests
  // anything. `git` is that set today; everything else — a caller-supplied
  // `--head` (`flag`), an opt-out (`disabled`), a failed read (`unavailable`),
  // or any source a later build introduces — is refused.
  //
  // Named-denylist first, and that was wrong in the one direction that costs a
  // productive drive: a future
  // `localSource: 'cache'` carrying a frozen SHA would read as a continuing
  // measurement and stop the loop at 14 after real pushes. Refusing an unknown
  // source only ever loses this early stop and falls back to the `--max-rounds`
  // bound, so the allowlist is the fail-closed direction. Adding a source that
  // genuinely re-measures means adding it here, deliberately.
  if (localSource !== "git") return null;
  const threadKeys = work?.unresolvedThreadKeys;
  const summaryKeys = work?.summaryUnaddressedKeys;
  if (!Array.isArray(threadKeys) || !Array.isArray(summaryKeys)) return null;
  const parkedKeys = work?.parkedKeys;
  // Required, not optional, same as threadKeys/summaryKeys above: parking is
  // progress that moves nothing else — no marker is posted, so a parked
  // summary finding leaves both summary counts standing — and one parked
  // item traded for another is the same substitution the thread and finding
  // keys exist to catch. Substituting `null` for a missing/malformed value
  // (rather than refusing the whole fingerprint) would make two passes that
  // park DIFFERENT findings serialize identically whenever the status report
  // omits this field, which is exactly the false-stall the identity check
  // exists to prevent.
  if (!Array.isArray(parkedKeys)) return null;
  return JSON.stringify([
    api,
    local,
    localSource,
    threadKeys,
    summaryKeys,
    parkedKeys,
    // The totals ride along as evidence for the printed report, and because a
    // total moving while the unaddressed set does not (a finding answered on
    // an unchanged head) is itself an observable change.
    work?.summaryFindings ?? null,
  ]);
}

/**
 * The context-economy dial's CANONICAL value: a whole percent as a string, or
 * the literal `never`. Throws `ExitError(2)` — via `fail`, so the operator sees
 * the same guidance either way — on anything else.
 *
 * Normalised to exactly those two shapes so the pass reads ONE value and never
 * a vocabulary. The named settings are aliases resolved here rather than a
 * parallel set of tiers: the semantics are literally "hand off at N%", and a
 * number says what a name only gestures at while leaving every point between
 * the tiers reachable.
 *
 * EXPORTED, and that is the load-bearing part rather than an incidental
 * refactor. The alias table is a pure total function of one string, so its
 * tests assert it in-process: spawning a whole `drive.ts` per value — locks,
 * gates, a stubbed forge, a pass — to read the resolved value back out of the
 * child's environment costs about 35.9s for five handoff values
 * <!-- measured -->, all of it paid for machinery the assertion does not
 * name. ONE spawn probe stays alongside to witness that this value actually
 * reaches the pass as $DRIVE_PR_HANDOFF_AT, the one thing only a spawned
 * drive can show. See the suite's § Spawn-boundary integration floor.
 */
export function resolveHandoffAt(raw: string): string {
  if (raw === "careful") return "50";
  if (raw === "eager") return "75";
  if (raw === "continuous" || raw === "never") return "never";
  if (!isDigits(raw)) {
    fail(
      2,
      "--handoff-at takes a whole percent (1-100), 'never', or one of the",
      `aliases careful (50) / eager (75) / continuous (never). Got '${raw}'.`,
    );
  }
  const v = Number.parseInt(raw, 10);
  if (v < 1 || v > 100) {
    fail(
      2,
      `--handoff-at must be between 1 and 100, or 'never'. Got '${raw}'.`,
    );
  }
  return raw;
}

/**
 * The no-op streak after one more gate: `streak + 1` when this gate's
 * fingerprint is a REPEAT of the previous one, 0 otherwise.
 *
 * An unmeasurable gate — `next === null` — resets rather than extends, and so
 * does an unmeasurable PREVIOUS one, since `null === null` must not read as
 * sameness. The detector may only ever stop on positive evidence that two gates
 * observed the same work; anything less falls through to the `--max-rounds`
 * bound exactly as before. That asymmetry is the whole safety argument for
 * stopping a drive early, which is why it is a named function rather than the
 * conditional it replaced: the failure direction is a drive that stops while
 * rounds are still doing work, and the ways to reach a reset (a moved head, a
 * changed work set, a gate that could not measure, a first round with nothing
 * to compare) are one claim, not incidental branches.
 *
 * Its probe used to be five separate `drive.ts` drives — each running two or
 * three rounds against a stubbed forge to manufacture one fingerprint sequence,
 * ~53s of a 733s suite between them — while the
 * OTHER half of each, that `roundFingerprint` moves or refuses on the input in
 * question, was already asserted directly in `roundFingerprint — what counts as
 * evidence of sameness`. What the drives uniquely witnessed was the composition
 * reaching a real exit code, and drives are kept for exactly that: one that
 * must stop (14), and several that must not — thread-identity substitution,
 * `--no-head-sync` forwarding, and a growing parked set are each a different
 * way to move the fingerprint.
 */
export function advanceStallStreak(
  prev: string | null,
  next: string | null,
  streak: number,
): number {
  return next !== null && next === prev ? streak + 1 : 0;
}

/**
 * What a completed pass's exit code means to the DRIVE — the only place that
 * mapping is written down.
 *
 * `5` alone propagates. The pre-pass liveness check cannot cover the minutes a
 * round spends triaging and running gates, so `guarded-push.ts` re-checks at
 * the instant of the push and exits 5 on a PR that merged in between;
 * flattening that to a generic pass failure tells the caller its pass is broken
 * about a PR that is simply finished, and 5 is a documented TERMINAL state.
 *
 * And ONLY 5. The pass is an arbitrary command whose exit space is its own, so
 * blanket propagation would let an agent exiting 3 for its own reasons report
 * SHA-verified convergence — every other non-zero code flattens to 1. That
 * `only` is the half a probe has to enumerate to check, which is why this is a
 * total function of the code rather than two conditionals inline: the old probe
 * spawned a whole `drive.ts` per code it wanted to try, so the enumeration was
 * bounded by what the suite could afford (three codes, ~10.8s
 * <!-- measured -->) rather than by what the claim covers. Here it is free, so
 * the table below it asserts the boundary itself: 0, 5, and a spread of others
 * including the drive-status codes an agent could plausibly leak.
 */
export function passExitDisposition(code: number): {
  kind: "ok" | "not-open" | "failed";
  exit: number;
} {
  if (code === 5) return { kind: "not-open", exit: 5 };
  if (code !== 0) return { kind: "failed", exit: 1 };
  return { kind: "ok", exit: 0 };
}

type MailboxCheckpoint =
  | "clear"
  | "resumed"
  | "stopped"
  | "pause-timeout"
  | "unreadable"
  | "compromised";

/** Keep the driver and its heartbeat alive while a pause is active. */
async function waitAtMailboxCheckpoint(
  dir: string,
  pr: string,
  pauseMaxSec: number,
): Promise<MailboxCheckpoint> {
  let pausedAt: number | null = null;
  for (;;) {
    if (compromised !== "") return "compromised";
    const gate = foldGateState(dir, pr);
    if (!gate.ok) {
      console.error(`drive.ts: mailbox gate state unreadable: ${gate.why}`);
      return "unreadable";
    }
    if (gate.state.stop.active) {
      console.error(
        `drive.ts: stop requested for PR #${pr}; ending at a safe round boundary.`,
      );
      return "stopped";
    }
    if (!gate.state.pause.active)
      return pausedAt === null ? "clear" : "resumed";
    if (pausedAt === null) {
      pausedAt = performance.now();
      console.error(
        `drive.ts: PR #${pr} paused by mailbox directive; waiting for resume --target pause (stop also ends the wait).`,
      );
    }
    if (performance.now() - pausedAt >= pauseMaxSec * 1000) {
      console.error(
        `drive.ts: PR #${pr} remained paused for ${pauseMaxSec}s; releasing the drive locks. Re-arm after resuming.`,
      );
      return "pause-timeout";
    }
    await sleep(Math.min(MAILBOX_POLL_SECONDS, pauseMaxSec));
  }
}

/**
 * The driver-only exit codes — every one below is read out of
 * `TERMINAL_STATES` via `driverOnlyExitCode`, not hand-typed, so an edit to
 * the table and an edit to this file cannot silently disagree the way
 * `__tests__/terminal-states-consistency.ts`'s own drift check on
 * `drive.ts` verifies. Before this, each of these was either a
 * bare numeric literal repeated at every `return` site
 * (`MAX_ROUNDS`/`SINGLE_INSTANCE_LOCK`/`WORKTREE_UNCLEAN`/`STALLED`) or —
 * for the ones that already had a named constant — a SEPARATE literal that
 * merely happened to equal `TERMINAL_STATES`'s own copy
 * (`PASS_DEADLINE`/`QUOTA_PARKED`); either shape is the "transcribed by
 * hand, verified once by inspection" gap `terminal-states.ts`'s own header
 * used to describe for this whole category.
 */
/** The pass hit its deadline. */
export const PASS_DEADLINE_EXIT = driverOnlyExitCode("PASS_DEADLINE");
/** The pass died on a usage wall nothing should sleep through. */
export const QUOTA_PARKED_EXIT = driverOnlyExitCode("QUOTA_PARKED");
/** Hit `--max-rounds` without converging. */
export const MAX_ROUNDS_EXIT = driverOnlyExitCode("MAX_ROUNDS");
/**
 * This driver's single-instance lock (worktree or per-PR) was already held
 * by another driver, or was recovered by another driver mid-run. Shares its
 * exit code with `drive-status.ts`'s own `SESSION_LEASE_HELD` by design — a
 * distinct cause, not a collision (see that state's own entry in
 * `terminal-states.ts`).
 */
export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode(
  "SINGLE_INSTANCE_LOCK",
);
/** The worktree could not be certified clean at the point of reporting convergence. */
export const WORKTREE_UNCLEAN_EXIT = driverOnlyExitCode("WORKTREE_UNCLEAN");
/** The stall-streak bound was hit — the loop stopped making progress. */
export const STALLED_EXIT = driverOnlyExitCode("STALLED");
/** A mailbox stop directive ended the drive at a safe round boundary. */
export const MAILBOX_STOPPED_EXIT = driverOnlyExitCode("MAILBOX_STOPPED");
/** A mailbox pause outlived its bounded wait. */
export const MAILBOX_PAUSE_TIMEOUT_EXIT = driverOnlyExitCode(
  "MAILBOX_PAUSE_TIMEOUT",
);
/**
 * The result of one `runRepairPass` call, kept apart from a raw process exit
 * code: the spawned command is caller-supplied and its exit space is its
 * own, so a real pass exiting with, say, 18 or 19 would otherwise collide
 * with this driver's own `MAILBOX_STOPPED_EXIT` /
 * `MAILBOX_PAUSE_TIMEOUT_EXIT` sentinels — the bare-`number` return this
 * replaced conflated the two code spaces into one. `dispatched` says which
 * space `code` (when present) belongs to:
 *
 *  - `dispatched: true` — the pass actually ran; `code` is ITS exit code,
 *    arbitrary, never to be compared against this file's own exit
 *    constants. `postPassMailboxExit` is this driver's own exit code from a
 *    mailbox checkpoint taken immediately AFTER the pass completed — `null`
 *    on 'clear' or 'resumed' (the pass's own `code` is what matters either
 *    way), non-null on stop/pause-timeout/unreadable, in which case the
 *    caller returns it directly, in preference to interpreting `code`, once
 *    it has committed whatever budget this confirmed dispatch earned.
 *  - `dispatched: false, resumed: true` — a live pause cleared at the
 *    pre-spawn checkpoint before anything spawned; there is no code to
 *    report, and the caller re-gates from the top exactly like every other
 *    'resumed' checkpoint in this file.
 *  - `dispatched: false, resumed: false` — nothing spawned, and `code` is
 *    THIS driver's own exit code (a mailbox stop/pause-timeout/unreadable,
 *    or a lock takeover) — safe to return directly from `main()`.
 */
type RepairDispatch =
  | { dispatched: true; code: number; postPassMailboxExit: number | null }
  | { dispatched: false; resumed: true }
  | { dispatched: false; resumed: false; code: number };

/**
 * How long one pass may run before it is killed, in seconds; `0` disables.
 *
 * THE PASS WAS THE LAST UNDEADLINED THING IN THIS SKILL, and that was a
 * deliberate position rather than an oversight: § Deadlines bounds every
 * outbound call precisely because a review round "takes as long as it takes".
 * The position is right about the round and wrong about the failure it leaves
 * open. Everything else here can only stop the loop BETWEEN rounds —
 * `--max-rounds`, the stall streak, the status poll's `--timeout` — so a pass
 * that never returns is invisible to all of them. The driver keeps refreshing
 * its claim from a timer, `drives.ts` keeps reporting it LIVE, and it waits
 * forever. The measured shapes: a pass that died mid-`git merge` leaving the
 * driver polling for a head change that could never arrive, and the
 * spawn's own comment conceding that a descendant which wants to PROMPT is "a
 * hang no deadline in this skill covers".
 *
 * NINETY MINUTES, and generous on purpose. This is a backstop against a wedge,
 * not a budget: a legitimate round can merge a base, run the full cumulative
 * validation plan and wait on the machine-wide test mutex. A deadline tight
 * enough to shape behaviour would kill honest rounds, which is a worse failure
 * than the one it prevents — so the number is set where nothing healthy
 * reaches it. Widen it if a real round ever does; do not tighten it to make
 * the loop feel faster.
 */
export function passTimeoutSeconds(): number {
  const raw = process.env.DRIVE_PR_PASS_TIMEOUT;
  if (raw === undefined || raw === "") return 90 * 60;
  if (!isDigits(raw)) return 90 * 60;
  const seconds = Number.parseInt(raw, 10);
  // `run()` forwards this to `setTimeout`, which takes a 32-bit signed
  // MILLISECOND delay: anything over 2147483647ms overflows and fires
  // IMMEDIATELY, killing the pass at once instead of after the generous
  // window this knob promises — the deadline inverted, exactly like the
  // other timeout accessors in lib/proc.ts already guard against. `0` is
  // exempt: it means "disabled" here, never a delay handed to a timer.
  if (seconds !== 0 && seconds * 1000 > 2_147_483_647) return 90 * 60;
  return seconds;
}

// ── Repair rounds ────────────────────────────────────────────────

/**
 * The two stops this loop used to hand back to a human for work it can do
 * itself: a red final-CI verdict, and a conflict with no workable finding.
 *
 * Both were defended on the same reasoning — "this is not a review round, and
 * a triage pass has nothing to do with it" — which is true of TRIAGE and false
 * of the PASS. The pass is a general agent with `/jig:fix-ci` and
 * `/jig:resolve-conflicts` available to it, and `base-sync.ts`'s exit-9
 * row already documents the conflict procedure *for a pass to follow*. The
 * asymmetry that gave the game away: a conflict WITH findings already comes
 * back `ROUND_READY` and gets merged as part of that round, so the identical
 * work was already being done — just never when it was the only thing left.
 *
 * Measured before the change (98 drives in the nine days after `ci:hold`
 * landed): 57 converged, 19 stopped for `/fix-ci`, 9 stopped on a conflict.
 * Roughly 29% of drives ended on a stop whose fix was a command.
 *
 * BUDGETS ARE IN-MEMORY, and that is deliberate rather than a shortcut. The
 * alternative — a `DriveState` field — is not available at an acceptable
 * price: `isUsableState` refuses any file written before a field existed
 * (there is no optional-and-defaulted tier, by documented design), so adding
 * one stops every in-flight drive on the fleet at its next state read. The
 * precedent is `noopRounds`, whose own streak is in-memory for the same
 * reason and whose reset-on-restart semantics are already documented to
 * operators in the skill's `README.md`. A re-armed drive therefore gets a fresh
 * repair budget, exactly as it gets a fresh stall streak.
 *
 * `0` disables a repair kind, restoring the older stop verbatim.
 */
const CI_REPAIR_ROUNDS_DEFAULT = 2;
const CONFLICT_REPAIR_ROUNDS_DEFAULT = 1;

/**
 * How long the converged head's final-CI polls sleep between reads, and how
 * many "no fresh required-check witness yet" polls are tolerated before the
 * drive gives up with exit `4` — 180 × 10s = 30 minutes.
 *
 * The bound exists because that particular wait has a state it cannot escape:
 * see the branch that reads it. `0` restores the unbounded wait.
 *
 * The poll and the two waits below are test pacing seams (`testPacing`, in
 * milliseconds), not configuration.
 */
const FINAL_CI_POLL_SECONDS =
  testPacing("DRIVE_PR_FINAL_CI_POLL_MS", 10_000, 10) / 1000;
const FINAL_CI_WITNESS_POLLS_DEFAULT = 180;
/**
 * How long a drive lets GitHub schedule the workflows that removing the CI
 * hold label triggers before it re-reads the evidence.
 */
const UNLABEL_SETTLE_SECONDS =
  testPacing("DRIVE_PR_UNLABEL_SETTLE_MS", 5_000, 10) / 1000;
/**
 * How often a paused drive, and a drive waiting out a usage wall, re-reads
 * its mailbox for a resume or stop.
 */
const MAILBOX_POLL_SECONDS =
  testPacing("DRIVE_PR_MAILBOX_POLL_MS", 2_000, 10) / 1000;

export function finalCiWitnessPolls(): number {
  return wholeEnv(
    process.env.DRIVE_PR_FINAL_CI_WITNESS_POLLS,
    FINAL_CI_WITNESS_POLLS_DEFAULT,
  );
}

export function ciRepairRounds(): number {
  return wholeEnv(
    process.env.DRIVE_PR_CI_REPAIR_ROUNDS,
    CI_REPAIR_ROUNDS_DEFAULT,
  );
}

export function conflictRepairRounds(): number {
  return wholeEnv(
    process.env.DRIVE_PR_CONFLICT_REPAIR_ROUNDS,
    CONFLICT_REPAIR_ROUNDS_DEFAULT,
  );
}

/**
 * An unusable value in the environment is inherited noise, not an
 * instruction — the same stance `passTimeoutSeconds()` takes, and for the
 * same reason: a drive an operator did not misconfigure must not stop because
 * something upstream exported a typo.
 */
function wholeEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!isDigits(raw)) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/**
 * What a repair pass is asked to do. Carried to the pass in its ENVIRONMENT,
 * never by rewriting the argv after `--`: that argv is opaque to this script
 * (`claude -p "/jig:drive-pr 4818"`, a Codex invocation, a shell wrapper), and a
 * driver that edited it would be guessing at another tool's command grammar.
 * Env is already this driver's channel to its pass — `DRIVE_PR_TARGET`,
 * `DRIVE_PR_SESSION`, `DRIVE_PR_REFLECT_DUE` all ride it — and works
 * identically for every agent.
 *
 * `SKILL.md` § "Repair rounds" is the pass-side half of this contract.
 */
export type RepairTask = "ci-repair" | "conflict-resolve";

// ── Single-instance locking ─────────────────────────────────────────────────

/**
 * ONE driver per shared resource — and a drive has TWO of them, which is why
 * there are two locks rather than a debate about how to key one (each keying
 * is correct against the other's hazard):
 *
 *   - the WORKTREE. Two drivers in one worktree edit, commit and push the same
 *     working tree; one loop's round-agent committed and pushed the other
 *     session's in-progress edits (measured). They cross-ship whether or not
 *     they target the same PR, so this lock is keyed by worktree and carries
 *     the PR only as diagnostics.
 *   - the PR. Two drivers in DIFFERENT worktrees have separate working trees,
 *     so they never cross-ship edits — but they race pushes to one head
 *     branch and share the clone-wide durable state (`resolveStateDir()` is
 *     `--git-common-dir`, deliberately: round budgets and parked sets are
 *     per-clone). Conductor makes multi-worktree the normal case, so this
 *     lock is keyed by PR and lives clone-wide, next to the state it guards.
 *
 * Acquired in that fixed order, always, so two drivers contending for both can
 * never deadlock against each other.
 *
 * Staleness is keyed to the OWNER'S LIVENESS rather than to a fixed age window
 * (the state store's mutex, lib/state/lock.ts, does the latter — right for a
 * transaction, wrong for a lock held across a whole drive): a lock whose
 * recorded pid is dead is stale however young. A live pid is honoured only so
 * long as the owner keeps REFRESHING its claim, because a pid alone cannot
 * distinguish the driver from a stranger the OS handed its number to after it
 * died — see HEARTBEAT_STALE_MIN_DEFAULT.
 */
interface DriveLock {
  dir: string;
  /** What it protects, for the refusal message. */
  what: string;
  /**
   * Written into the claim's diagnostics line at take time (`lib/claim.ts`) —
   * what an exit-11 refusal and the `drives.ts` listing can show about THIS
   * driver. Advisory: nothing that decides liveness or recovery reads it.
   */
  diag?: ClaimDiag;
  /**
   * This process's GENERATION of the lock, set when it is taken. It is not a
   * value later steps compare against a file's contents but the NAME of the
   * claim file this process published — which is what makes every later write
   * and removal address one INSTANCE rather than a path. A path names a SLOT,
   * and the slot's occupant can change between any two syscalls, which is
   * exactly how a check-then-act on the path alone hands two drivers the same
   * resource.
   */
  nonce?: string;
}

/** Unguessable, filesystem-safe, and unique per acquisition. */
function newNonce(): string {
  return randomBytes(12).toString("hex");
}

/**
 * The one entry a lock instance publishes: `claim.<generation>`, whose format
 * — `<pid> <hostname>`, plus an optional operator-diagnostics line — lives in
 * `lib/claim.ts`, shared with the read-only listing (`drives.ts`)
 * so writer and reader cannot drift. Its mtime carries that instance's last
 * refresh; the hostname is what makes the pid check meaningful.
 *
 * The generation is in the NAME rather than in the contents, and that is the
 * whole design. Every destructive step of the protocol — a recoverer retiring
 * a stale instance, an owner releasing its own — names the entry it removes,
 * so an actor still acting on a generation that has since been replaced
 * removes a file that is already gone instead of the successor that took its
 * place. Suspension then needs no reasoning about at all, and nothing has to
 * be left behind as a fence.
 */
interface Claim {
  /** The entry name — the only handle anything is allowed to remove it by. */
  name: string;
  nonce: string;
  pid: number;
  host: string;
  platform: string | null;
  /** The claim's diagnostics line — advisory, absent on older claims. */
  diag: ClaimDiag | null;
}

/**
 * What occupies a lock path right now.
 *
 * `names` is the whole listing, not just the claim: it is the list a
 * retirement removes, and taking it from ONE `readdir` is what keeps that
 * removal addressed to entries this process actually saw. A lock's entries are
 * only ever installed wholesale by `takeLock`'s rename, so anything a
 * successor publishes is absent from an earlier observation by construction.
 */
interface Occupant {
  names: string[];
  /** Every `claim.*` seen. More than one is unreachable — see `acquire`. */
  claimNames: string[];
  claim: Claim | null;
  /**
   * True only when `readdirSync(dir)` itself threw — a transient permission,
   * I/O, or filesystem error, not a confirmed empty or occupied directory.
   * `claimNames` is `[]` in this case too, which is indistinguishable from a
   * genuinely vanished claim set unless a caller checks this flag first
   *: a directory read failure is not
   * evidence that a successor took over.
   */
  unreadable: boolean;
}

// Exported so the `unreadable` distinction is unit-testable on its own —
// same reasoning as `claimWasTakenOver`'s own export.
export function inspect(dir: string): Occupant {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { names: [], claimNames: [], claim: null, unreadable: true };
  }
  const claimNames = names.filter(
    (n) => n.startsWith(CLAIM_PREFIX) && n.length > CLAIM_PREFIX.length,
  );
  const only = claimNames.length === 1 ? (claimNames[0] as string) : null;
  const nothing = { names, claimNames, claim: null, unreadable: false };
  // Anything that is not exactly one claim is debris, and debris is retired by
  // name rather than trusted as an owner. Entries from a drive.ts older than
  // this one — a bare `pid`, a `heartbeat` — land here too, since backward
  // compatibility is deferred before general availability: this file owes
  // that old format nothing, not even a liveness check, and does not carry a
  // second parser to give it one (a liveness check for the legacy shape was
  // tried and reverted for exactly this reason).
  if (only === null) return nothing;
  try {
    const record = parseClaimText(readFileSync(join(dir, only), "utf8"));
    if (record === null) return nothing;
    return {
      names,
      claimNames,
      claim: {
        name: only,
        nonce: only.slice(CLAIM_PREFIX.length),
        pid: record.pid,
        host: record.host,
        platform: record.platform,
        diag: record.diag,
      },
      unreadable: false,
    };
  } catch {
    return nothing;
  }
}

/**
 * Does a directory that JUST held exactly our own claim now belong to
 * someone else, or to no one at all? True for coexistence (more than one
 * claim — a resurrected entry sitting ALONGSIDE ours), for a full
 * successor-only transition (exactly one claim, but not the one named
 * `ownClaimName`), and for a vanished claim set (zero claims observed) alike:
 * a contender that ran `retire()` after we renamed our rewrite over `dest`
 * removes exactly that file — `dest` never changes name across rewrites —
 * and rebuilds the directory from scratch with its OWN, differently-named
 * claim. Landing the inspection in the gap between that removal and the
 * successor's own rename reads zero claims, not one — `inspect()` also
 * folds a genuine `readdirSync` failure into the same empty result — and
 * either way this generation's own claim is not verifiably still there, so
 * both must read as loss exactly like the other two shapes. This function is
 * therefore true whenever `claimNames` is anything OTHER than the
 * single-element array containing exactly `ownClaimName`. Exported so this
 * decision is unit-testable on its own: the real race it detects is a
 * microsecond, unrepeatable window between a `renameSync` and the `inspect()`
 * call that follows it, with nothing in a single-process test able to land
 * inside it.
 */
export function claimWasTakenOver(
  claimNames: readonly string[],
  ownClaimName: string,
): boolean {
  return claimNames.length !== 1 || claimNames[0] !== ownClaimName;
}

/**
 * Publish the claim BEFORE the lock becomes visible. `mkdir` then write left a
 * window in which the lock existed with no record in it, indistinguishable
 * from an abandoned one; it was covered by an `mtime < 2000ms` wall-clock
 * guess, which is not a guess a shared or network-backed
 * `$DRIVE_PR_HANDOFF_DIR` honours. Staging +
 * `rename` removes the window instead of narrowing it.
 *
 * The mutual exclusion is `rename(2)`'s refusal to replace a NON-EMPTY
 * directory: the staging directory always carries a claim, so once any
 * instance is installed every later attempt fails. The ordinary destination is
 * ABSENT rather than merely empty — both `retire` and `release` `rmdir` the
 * slot once they have emptied it, which is what lets the rename succeed on
 * Windows too (`MoveFileEx` refuses an existing directory outright, empty or
 * not). Only the interleaving where a successor claimed the slot between that
 * `rmdir` and this rename still meets a non-empty directory, and that is
 * exactly the case the refusal is for. The read-back then settles which
 * contender landed, since the claim name is unguessable and this process is
 * the only one that ever wrote it.
 *
 * The staging directory's name carries pid AND host — host because the lock
 * directory itself may be shared across hosts (the same `$DRIVE_PR_HANDOFF_DIR`
 * concern the claim record's own host field exists for), and two hosts can
 * report the identical pid. Without host in the name, two such hosts compute
 * the identical staging path and each blindly `rmSync`s it as "my own leftover
 * from last time" on entry — destroying whatever the OTHER host had just
 * published there. Pid comes first and
 * host last so the name parses unambiguously despite a hostname that may
 * itself contain dots: pid is exactly the digits up to the first dot, host is
 * everything after it.
 *
 * This process's own staging is cleared on entry, but a crash between
 * creating it and renaming it is not bounded by that alone: nothing revisits
 * this exact pid+host's staging directory unless that exact, possibly-recycled
 * pid on that exact host happens to attempt this exact lock again, which on a
 * long-lived clone may never happen. `sweepStaleStaging` is what actually
 * bounds it — it inspects EVERY sibling staging directory, not just this
 * process's own, and reclaims the ones whose recorded owner is confirmed gone.
 */
function stagingDirFor(lock: DriveLock, pid: number, host: string): string {
  return `${lock.dir}.${pid}.${host}@${process.platform}.staging`;
}

function takeLock(lock: DriveLock): boolean {
  const nonce = newNonce();
  const staging = stagingDirFor(lock, process.pid, hostname());
  sweepStaleStaging(lock);
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(
      join(staging, claimName(nonce)),
      formatClaim(process.pid, hostname(), lock.diag),
    );
    renameSync(staging, lock.dir);
  } catch {
    rmSync(staging, { recursive: true, force: true });
    return false;
  }
  if (inspect(lock.dir).claim?.nonce !== nonce) return false;
  lock.nonce = nonce;
  return true;
}

/**
 * Parse the pid and host `stagingDirFor` encoded into a directory name, or
 * `null` if `entry` is not a staging directory for THIS lock at all.
 */
function parseStagingName(
  base: string,
  entry: string,
): { pid: number; host: string; platform: string | null } | null {
  const prefix = `${base}.`;
  const suffix = ".staging";
  if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) return null;
  const middle = entry.slice(prefix.length, entry.length - suffix.length);
  const dot = middle.indexOf(".");
  if (dot === -1) return null;
  const pidStr = middle.slice(0, dot);
  if (!isDigits(pidStr)) return null;
  return {
    pid: Number.parseInt(pidStr, 10),
    ...parseStagingHost(middle.slice(dot + 1)),
  };
}

/**
 * Reclaim staging directories orphaned by a crash before the `rename` that
 * installs them — the same "confirm the owner is gone" test a stale LOCK
 * recovers by, applied to staging because a crash there leaves an artifact
 * this process did not create and has no name of its own to find it by.
 *
 * The owner comes ONLY from the directory's own NAME — never from the claim
 * file inside it. An earlier cut preferred the claim file when readable,
 * reasoning that it was the more authoritative record; the opposite is true.
 * The directory becomes visible the instant `mkdirSync` returns, but the
 * claim file inside is written by a SEPARATE, non-atomic `writeFileSync`
 * afterward — so a sweep running concurrently with another host's own
 * publish can observe a torn write, e.g. `123 ` with no host token yet,
 * parsing as `host === ''`. `pidAlive` treats an empty host as "this host"
 * (the same convenient default it uses for genuinely old, host-less debris),
 * so a torn read from a FOREIGN host's in-flight publish gets probed
 * locally and can read as dead, and the recursive removal that follows then
 * destroys a directory that was never abandoned at all. The directory's NAME
 * carries no such window: it is fixed, complete, and correct from the single
 * atomic `mkdirSync` that creates it, never touched again — so it is the
 * only identity source this sweep should ever trust.
 *
 * `pidAlive` is necessary but not sufficient ON A HOST THIS PROCESS CAN
 * ACTUALLY PROBE: after the ORIGINAL publisher crashes, the OS can hand that
 * same pid to an unrelated long-lived process — the exact hazard
 * `HEARTBEAT_STALE_MIN_DEFAULT` documents for the main lock — and `pidAlive`
 * would then report that stranger as alive forever, since staging has
 * nothing to refresh. Unlike the main lock, staging cannot fall back to a
 * heartbeat: it is meant to exist for three synchronous syscalls, never
 * touched again, so `STAGING_STALE_MS` — far shorter than the lock's
 * multi-minute floor, but still generous by orders of magnitude over that
 * expected lifetime — is the fallback instead. Reclaiming a directory whose
 * pid merely reads as alive by age is still safe by the same argument as
 * everywhere else in this protocol: if that pid IS the true,
 * merely-suspended publisher, its own eventual `renameSync` just fails onto
 * an absent destination and `takeLock` reports failure the ordinary way —
 * never data loss, never two drivers.
 *
 * That safety argument depends on the age actually being comparable to THIS
 * host's clock, which is exactly what a foreign host's `pidAlive() === true`
 * is NOT evidence of — it is the fail-OPEN default for an unanswerable
 * question, not a confirmed liveness signal the age check may then
 * override. Applying the age fallback there anyway would delete a foreign
 * publisher's directory for being briefly slow, or for ordinary clock skew
 * on a shared mount — the exact class of guess `heartbeatStaleMs`'s own doc
 * rejects for the main lock. The loop below therefore restricts the age
 * fallback to entries on THIS host; a foreign host's entry is left alone
 * unconditionally, same as before this fallback existed.
 *
 * Every failure here is swallowed: this is opportunistic cleanup running
 * ahead of an acquire that must still succeed even if a sibling's directory
 * cannot be read or removed right now — it is not this attempt's job to force
 * that, only to leave it for a later sweep.
 *
 * The age policy itself — `STAGING_STALE_MS`, the foreign-host
 * `heartbeatStaleMs()` fallback, and the `pidAlive`-first ordering the
 * comments above justify — lives in `lib/claim.ts`'s `stagingLive`, shared
 * with `migrate-state-dir.ts`'s own staging-liveness check so the two never
 * drift into independently maintained copies of the same rule.
 */
function sweepStaleStaging(lock: DriveLock): void {
  const parent = dirname(lock.dir);
  const base = basename(lock.dir);
  const ownStaging = basename(stagingDirFor(lock, process.pid, hostname()));
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ownStaging) continue; // this attempt's own — handled above
    const named = parseStagingName(base, entry);
    if (named === null) continue;
    const stagingDir = join(parent, entry);
    let age: number | null;
    try {
      age = Date.now() - statSync(stagingDir).mtimeMs;
    } catch {
      age = null; // gone, or unreadable — not this sweep's to force either way
    }
    if (stagingLive({ ...named, ageMs: age })) continue;
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // Leave it for a later sweep rather than fail THIS acquisition over a
      // sibling's directory this process may not even own.
    }
  }
}

// The staleness window itself — HEARTBEAT_STALE_MIN_DEFAULT and
// heartbeatStaleMs — lives in `lib/claim.ts` with the rest of the claim's
// interpretation, so `drives.ts` judges live-vs-stale by exactly the rule
// recovery uses here. This is not the `mtime < 2000ms` publication guess that
// was rightly rejected above: that one tried to resolve a race in the
// millisecond a lock was being created, on a filesystem whose timestamp
// granularity is of the same order, while the window bounds a LIVENESS signal
// at a scale where no filesystem's granularity or a shared mount's latency is
// material. Renewal runs on `startHeartbeat`'s own timer at a sixth of the
// window, so even the five-minute floor is refreshed every fifty seconds
// regardless of what the pass is doing.

/**
 * How often a held claim is renewed. A sixth of the staleness window, capped:
 * frequent enough that several consecutive failed refreshes still leave the
 * claim fresh, cheap enough to ignore. The explicit override exists so the
 * mechanism can be exercised in a test at a scale a human would not wait for,
 * and so an operator running a deliberately short window can match it.
 */
function heartbeatRefreshMs(): number {
  const raw = process.env.DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS ?? "";
  if (isDigits(raw)) return Math.max(50, Number.parseInt(raw, 10));
  return Math.max(1_000, Math.min(60_000, Math.floor(heartbeatStaleMs() / 6)));
}

/**
 * Set when a held lock stops being this process's — named, so the refusal can
 * say which one. Written from the heartbeat timer, read by the round loop.
 */
let compromised = "";

/**
 * The pass currently running, or `null` between rounds.
 *
 * A pass is the only child that outlives a decision this process can change its
 * mind about. Losing a lock mid-pass and a SIGINT/SIGTERM are both events that
 * must END it, and neither can if nothing holds a handle to it: the loop's
 * `compromised` check runs only at the next round boundary, so a pass that
 * started before the takeover went on to edit, commit and push on behalf of a
 * claim another driver already held.
 */
let activePass: RunHandle | null = null;

/**
 * Set while the driver is sleeping out a short quota window — `null`
 * between rounds and whenever a pass is actually running.
 *
 * A quota sleep is the OTHER thing, besides a running pass, that a lock
 * takeover must be able to interrupt promptly rather than let run to
 * completion: `stopActivePass` only has a live pass to act on
 * (`activePass`), so a takeover observed while the driver is merely
 * sleeping through a wall previously went unnoticed until the sleep's OWN
 * up-to-six-hour timer elapsed, holding the compromised lock's refresh
 * going the entire time. `touchLock` aborts this the moment it
 * notices, the same way `stopActivePass` already ends a live pass.
 */
let quotaSleepAbort: AbortController | null = null;

/**
 * The witness promise from the stop that is already under way, if any.
 *
 * The takeover path stops the pass from a TIMER callback, which cannot block —
 * so it fires and forgets, and the run loop resolves as soon as the pass
 * process closes. That is earlier than the tree being gone, so without this
 * the loop would return and let the `exit` handler release the lock it still
 * legitimately owns while a descendant lived on. Keeping the promise is what
 * lets the loop re-join the wait it could not perform inline.
 */
let passStopWitness: Promise<boolean> | null = null;

function installStopControls(
  held: DriveLock[],
  releaseAll: () => void,
): Disposable {
  let shuttingDown = false;
  const shutDown = (sig: string): Promise<void> | undefined => {
    const code =
      sig === "SIGINT"
        ? 130
        : sig === "SIGTERM" || sig === "stop request"
          ? 143
          : 129;
    // A repeated signal forces termination without unlocking a live pass.
    if (shuttingDown) {
      held.length = 0;
      process.exit(code);
    }
    shuttingDown = true;
    return stopActivePass(`received ${sig}`).then((gone) => {
      if (gone) releaseAll();
      else held.length = 0;
      process.exit(code);
    });
  };
  const cancellation = registerSignalHandler(shutDown);
  const stopTimer = setInterval(() => {
    if (
      !shuttingDown &&
      held.some(
        (lock) =>
          lock.nonce !== undefined && driverStopRequested(lock.dir, lock.nonce),
      )
    ) {
      void shutDown("stop request");
    }
  }, 250);
  stopTimer.unref?.();
  return {
    [Symbol.dispose]() {
      clearInterval(stopTimer);
      cancellation[Symbol.dispose]();
    },
  };
}

function createDriverRegistry(held: DriveLock[]): void {
  // The registry belongs to this acquisition. Detached foreground runners
  // inherit it, so the operator can also capture them if a driver is wedged.
  if (process.platform === "win32") {
    const prLock = held[held.length - 1];
    if (prLock?.nonce !== undefined) {
      const registry = join(prLock.dir, `processes.${prLock.nonce}`);
      mkdirSync(registry);
      process.env[PROCESS_REGISTRY_ENV] = registry;
    }
  }
}

/**
 * End the running pass and report whether its termination was WITNESSED.
 *
 * The answer comes from `RunHandle.stop()`, which polls the pass's process
 * group until no member is left, and never from the pass process's own exit or
 * from the fact that a signal was sent. Those two are what the first cuts of
 * this used, and both were wrong in the same direction: the leader closing
 * says nothing about a descendant that ignored SIGTERM, and delivering SIGKILL
 * says nothing about a process wedged in uninterruptible sleep.
 *
 * `false` therefore means "still running, as far as anything can tell" — and
 * callers must treat it as "the locks may NOT be released". A live pass under
 * a released lock is precisely the concurrent driver the lock exists to
 * prevent, while a lock left behind costs a refusal a human clears in one
 * command (`acquire` says how) or that the staleness window clears by itself.
 */
async function stopActivePass(why: string): Promise<boolean> {
  const handle = activePass;
  if (handle === null) return true;
  console.error(`drive.ts: stopping the active pass — ${why}`);
  // Recorded before the await so the loop can re-join this same wait — `stop()`
  // memoises, so a second caller shares the outcome rather than restarting it.
  passStopWitness = handle.stop();
  const gone = await passStopWitness;
  if (!gone) {
    console.error(
      "drive.ts: could not witness the pass tree terminating — NOT releasing the locks.",
    );
    console.error(
      "  A released lock plus a live pass is two drivers on one tree. Leaving the",
    );
    console.error(
      "  lock costs a refusal instead: remove the lock dir once the pass is gone.",
    );
  }
  return gone;
}

/**
 * Refresh this process's claim on a lock it holds, and notice if it has
 * stopped holding it.
 *
 * `utimes` on the claim's own generation-keyed name is the whole operation.
 * There is no ownership check in front of it to race, because the only entry
 * it can reach is the one this process published — a successor's carries a
 * different name and is not addressable from here at all.
 *
 * So a MISSING claim is the takeover signal, and it is exact: the only thing
 * that removes `claim.<ours>` is a recovery of this generation. A refresh that
 * fails for any other reason must not be read that way — a drive must not die
 * because it could not write — so the absence is confirmed before the drive
 * gives up on a lock it may still hold.
 */
function touchLock(lock: DriveLock): void {
  if (lock.nonce === undefined) return; // never taken
  const claim = join(lock.dir, claimName(lock.nonce));
  const now = Date.now() / 1000;
  try {
    utimesSync(claim, now, now);
    return;
  } catch {
    if (existsSync(claim)) return; // transient: the claim is still ours
  }
  // Our GENERATION is gone, so another driver recovered this path while we
  // believed we held it. A drive that keeps going from here is the second
  // driver the lock exists to prevent, so record it and let the loop stop;
  // `release` will not touch the successor's lock, because the only name it
  // removes is ours.
  noteTakeover(lock);
}

/**
 * The one response to a detected takeover, called the moment one is detected
 * and before anything else is done or printed about it: `compromised` is what
 * stops the driver log rotating (`mayRotateDriverLog`), and a diagnostic
 * written while it is still unset could rename the log over the successor's
 * history.
 *
 * Recording it is not enough on its own: the loop only reads `compromised`
 * at a round boundary, and a pass already running does not pause at one. So
 * the pass is stopped HERE, the moment ownership is lost — the
 * fire-and-forget is deliberate, since a timer callback cannot block and
 * `stop()` is synchronous up to the SIGTERM; the loop awaits the same handle
 * before it decides anything. The quota sleep is aborted for the same
 * reason: `stopActivePass` is a no-op when nothing is running, which is
 * exactly the state the driver is in for up to six hours while sleeping out a
 * short quota window, and a controller with no listener is a harmless no-op.
 */
function noteTakeover(lock: DriveLock): void {
  if (compromised !== "") return;
  compromised = lock.what;
  void stopActivePass(`the ${lock.what} lock was recovered by another driver`);
  quotaSleepAbort?.abort();
}

/**
 * Do two identities disagree in any way a display should care about?
 * `reason` IS compared, not excluded. An earlier revision excluded it on the
 * theory that a resolver "can retry the identical failure with
 * differently-worded prose across ticks" — but every resolver in
 * `lib/identity.ts` returns a deterministic template string per cause, never
 * free-form wording, so a retried, unchanged failure always compares equal
 * here regardless. What excluding it actually did was collapse distinct
 * causes: `resolveCodexIdentity`'s unreadable-file, invalid-JSON, and
 * missing-identity outcomes all share `{account:null, vendor:'codex',
 * provenance:'CODEX_HOME auth.json'}` and differ only by `reason`, so once
 * one was stamped, a transition to a DIFFERENT cause never rewrote the
 * claim — an operator's exit-11 diagnostic or `drives.ts` listing kept
 * reporting an obsolete cause indefinitely. `reason` is user-visible through
 * `formatAccountIdentity`, so a changed cause is exactly the kind of
 * disagreement a display should care about.
 */
function accountChanged(a: AccountIdentity, b: AccountIdentity): boolean {
  return (
    a.account !== b.account ||
    a.vendor !== b.vendor ||
    a.provenance !== b.provenance ||
    a.reason !== b.reason
  );
}

/**
 * Re-resolve the billing account identity, while no pass is actively
 * running, and rewrite every held claim's diagnostics if it changed.
 *
 * WHY THIS EXISTS. `lib/identity.ts` resolves a
 * Claude identity two different ways: `CLAUDE_CODE_OAUTH_TOKEN`, which is
 * THIS PROCESS's own environment and therefore genuinely fixed for the
 * drive's whole life — resolving it once at arm time is correct, and this
 * function's own re-resolution of it will simply keep agreeing forever,
 * confirmed by `accountChanged` returning `false` every tick. But the
 * file-backed path (`oauthAccount` / `CODEX_HOME` auth, i.e. no token set)
 * is LIVE FILE CONTENT the pass re-reads on every fresh spawn — an operator's
 * `/login`, or an account-switching wrapper's own login swap, mid-drive changes
 * which account the NEXT pass actually bills against, while a diag resolved
 * only once at arm time would keep reporting the OLD one for the rest of the
 * drive's life, defeating the whole point of reporting the account in exactly
 * the scenario it exists for.
 *
 * WHY THE CALLER GATES THIS ON "NO ACTIVE PASS". An earlier revision called
 * this unconditionally on every tick, including while a pass was already
 * running. `run` spawns the pass with whatever the environment held AT THAT
 * MOMENT — an already-running child's own billing account does not move — so
 * rewriting the claim mid-pass displayed the account the NEXT pass would
 * use, not the one the CURRENT pass was actually billing against, for the
 * pass's entire remaining life.
 * `startHeartbeat` below only calls this while `activePass` is `null`, so
 * the diag holds steady for an active pass and only moves between passes —
 * exactly the window in which "the next pass's account" and "the account a
 * reader should expect" are the same claim.
 *
 * Piggybacks on the EXISTING heartbeat timer rather than a second one: the
 * same cadence that already proves this driver alive is a fine cadence to
 * notice an identity change at, and it keeps every claim-file write behind
 * the one place that already owns "when does a held claim get touched".
 *
 * RETURNS whether every lock's diag agrees with the freshly-resolved
 * identity by the time this call returns — `false` on a transient rewrite
 * failure (a lock left retryable, `compromised` untouched) OR a detected
 * takeover (`compromised` set). The heartbeat-timer and post-pass callers
 * ignore this: a `false` there just means the NEXT tick or the pre-spawn
 * call retries. The pre-spawn call site cannot afford to ignore it — see
 * its own comment for why.
 */
function refreshAccountIdentity(
  locks: DriveLock[],
  passArgv: readonly string[],
): boolean {
  if (locks.every((l) => l.diag === undefined)) return true; // never taken, or diag never stamped — nothing to synchronize
  const fresh = resolveAccountIdentity(passArgv);
  let allSynced = true;
  for (const lock of locks) {
    if (lock.diag === undefined || lock.nonce === undefined) continue;
    // Checked PER LOCK, not once up front against a single shared `current`:
    // a shared check against only the FIRST lock with a diag would, on a
    // match, skip the others. A transient failure rewriting one lock (caught
    // below, `lock.diag` left unchanged) while a DIFFERENT lock's rewrite
    // succeeded would then go permanently unretried — the next tick sees the
    // first lock already agreeing with `fresh` and skips the loop entirely,
    // stranding the failed lock on the stale account until some LATER
    // identity change happens to give it another chance. Each lock instead
    // retries independently until ITS OWN diag agrees with `fresh`.
    if (!accountChanged(fresh, lock.diag.account)) continue;
    const updated: ClaimDiag = { ...lock.diag, account: fresh };
    const dest = join(lock.dir, claimName(lock.nonce));
    // Deliberately OUTSIDE the `claim.` namespace `CLAIM_PREFIX` names — a
    // name like `${dest}.rewrite-${pid}` still STARTS WITH `claim.`, so
    // between this write and the rename below the directory would briefly
    // hold two entries `inspect()`'s `claimNames` scan both counts
    // as generations. That reads as debris to every concurrent reader:
    // `drives.ts --json` reports `contested` instead of `live`, and a
    // concurrent `acquire()` sees more-than-one claim and refuses outright.
    // A name that never matches `CLAIM_PREFIX` is invisible to that scan for
    // the whole window, so exactly one claim is ever visible until the
    // atomic rename installs the new one.
    const tmp = join(lock.dir, `rewrite.${lock.nonce}.${process.pid}`);
    try {
      writeFileSync(tmp, formatClaim(process.pid, hostname(), updated));
      // Re-confirmed IMMEDIATELY before the rename, not assumed from
      // `touchLock` having run earlier this same tick: `writeFileSync` above
      // is real disk I/O, wide enough for a concurrent recovery to delete
      // `dest` and install a successor's own claim while it runs. Renaming
      // over that regardless would still republish this generation's
      // obsolete claim ALONGSIDE the successor's — both now reading as valid
      // — even with `touchLock` correctly ordered first. This does not make
      // the check and the rename atomic with each other — no POSIX primitive
      // here does — but it narrows the exposure from the full write's
      // duration down to the gap between a stat and a rename. The
      // post-rename check below is what actually closes the remainder —
      // `touchLock`'s own next tick cannot.
      if (!existsSync(dest)) {
        throw new Error("claim recovered mid-rewrite");
      }
      // `rename(2)` is what makes THIS step atomic from a reader's
      // perspective — never a torn write of this call's own making: a
      // concurrent reader of `dest` sees either the complete old content or
      // the complete new content, nothing in between.
      renameSync(tmp, dest);
      // The `existsSync` check above narrows the exposure but does not close
      // it: a recovery can still land in the gap between that check and this
      // rename, retiring `lock.dir` (removing `dest`, then `rmdirSync`-ing the
      // directory itself) and reinstalling it fresh with the SUCCESSOR's own
      // differently-named claim — after which THIS rename recreates `dest`
      // regardless, republishing our now-obsolete generation ALONGSIDE the
      // successor's, both reading as valid. `touchLock`'s own next tick is NOT
      // a backstop for this: it addresses `dest` by the same fixed name, so a
      // resurrected file there makes its `utimesSync` succeed and permanently
      // masks the takeover instead of catching it. Detect it here instead, the
      // only place that still knows a rewrite just happened: a directory
      // holding more than one claim is exactly what `acquire` already treats
      // as unreachable-by-construction, so treat it as this generation's own
      // takeover signal and repair it immediately rather than leaving a ghost
      // for the next reader to trip on.
      const afterRewrite = inspect(lock.dir);
      if (afterRewrite.unreadable) {
        // The rename just above succeeded, so this generation's claim is on
        // disk; a `readdirSync` failure right afterward proves nothing about
        // takeover (see `Occupant.unreadable`). Treat it as the same
        // best-effort transient failure the outer `catch` below handles:
        // leave `lock.diag` unadvanced so a later tick retries and actually
        // confirms which case this was.
        allSynced = false;
      } else if (
        // See `claimWasTakenOver`'s own comment for why this covers both
        // coexistence AND a full successor-only transition, not just the
        // former.
        claimWasTakenOver(afterRewrite.claimNames, claimName(lock.nonce))
      ) {
        // First, before the cleanup below can print anything.
        noteTakeover(lock);
        if (afterRewrite.claimNames.length > 1) {
          try {
            rmSync(dest, { force: true });
          } catch {
            // NOT harmless if this fails. `inspect()` reads
            // `claim: null` for a directory holding more than one `claim.*`
            // entry, and `acquire()` refuses outright rather than guess which
            // one is real — so a resurrected entry that survives this removal
            // wedges the lock PERMANENTLY: no future driver, this generation's
            // takeover included, can ever auto-recover `lock.dir` again. This
            // generation is about to stop (via `compromised`, set above) either
            // way, so print the one thing an operator needs and cannot
            // otherwise discover on their own: which directory needs manual
            // cleanup, and why automatic recovery will never happen for it.
            console.error(
              `drive.ts: could not remove the resurrected claim at ${dest} — ${lock.dir} now permanently holds more than one claim and no driver can auto-recover it. Manual fix required: inspect the directory and remove the stale entry by hand.`,
            );
          }
        }
        // A successor-only transition (exactly one claim, not ours) and a
        // vanished claim set (zero claims — the successor removed ours but
        // had not yet installed its own when this landed) both hit this
        // branch too, but `dest` (our own name) is already gone by then —
        // either the successor's `retire()` removed it and rebuilt
        // `lock.dir` from scratch, or that rebuild simply had not happened
        // yet — so there is nothing of OURS left to remove either way. Any
        // claim present now belongs to someone else; touching it would be
        // exactly the destructive cross-driver mutation this generation
        // exists to avoid, so both cases only ever stop driving, never
        // mutate the directory.
        allSynced = false;
        // Stop entirely, not just this lock: `held` is ordered worktree lock
        // first, PR lock second, so a `continue` here would proceed straight
        // into the rewrite path for the NEXT lock while this generation is
        // already known to have lost one — potentially resurrecting a claim
        // beside a successor that is concurrently acquiring it and
        // permanently wedging that lock.
        break;
      } else {
        // Advanced only NOW, after the rewrite is actually on disk AND
        // confirmed unchallenged. An earlier revision set `lock.diag =
        // updated` before attempting the write — so a failed
        // `writeFileSync`/`renameSync` still left the in-memory diag
        // pointing at `updated`, and the NEXT tick's `accountChanged`
        // compared a fresh read against that already-advanced value, saw no
        // difference, and never retried — stranding one or all persisted
        // claims on the stale account for the rest of the drive.
        lock.diag = updated;
      }
    } catch {
      // Best-effort: a later tick retries — `lock.diag` is left unchanged
      // above precisely so that retry actually fires. Not this tick's job
      // to force — same posture `touchLock` already takes on its own
      // refresh failures.
      //
      // But an ordinary transient write failure (permissions, a full disk,
      // a slow filesystem) is not the only way to land here: `writeFileSync`
      // itself throws ENOENT when a contender has ALREADY retired `lock.dir`
      // before this call ever ran, and the `!existsSync(dest)` check above
      // throws for the narrower race it exists to catch. The resurrection
      // check further up only runs on the SUCCESS path (after a completed
      // rename), so a failure that stems from `dest` genuinely being gone
      // needs its own check here — otherwise this generation's claim can
      // vanish with `compromised` never set, and this driver keeps going
      // with no claim protecting the tree at all.
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Leftover tmp file; harmless — the next successful tick's rename
        // overwrites its own tmp path, and this one shares no name with it.
      }
      if (!existsSync(dest)) {
        noteTakeover(lock);
      }
      allSynced = false;
    }
    // Same stop-the-whole-loop reasoning as the `claimWasTakenOver` branch
    // above: proceeding to the next lock once this one is known compromised
    // risks the identical resurrection race, whichever of the two paths
    // above is what set it.
    if (compromised !== "") break;
  }
  return allSynced;
}

/**
 * `refreshAccountIdentity`, retried a bounded few times when the rewrite
 * merely failed transiently (a full disk, a slow filesystem) rather than
 * detecting a takeover — the last chance to close the staleness window
 * before a pass spawns, same reasoning as the ordinary-pass spawn site that
 * introduced this retry:
 * active-pass gating suppresses the heartbeat's own retries the moment a
 * pass starts, so a rewrite left unretried here would strand a stale claim
 * for that whole pass's life. Bounded rather than looped until success — a
 * filesystem stuck longer than this must not block the drive from ever
 * spawning another pass over a DISPLAY value.
 *
 * Stops retrying immediately once `compromised` is set: sleeping further
 * would only delay the caller's own takeover handling, never change it.
 *
 * Shared by both spawn sites:
 * the repair-pass spawn used to call `refreshAccountIdentity` directly and
 * discard its result, so a transient failure there went unretried right up
 * to the next repair spawn — the same gap this retry closed for the
 * ordinary-pass spawn, just never generalized to the second call site.
 */
async function refreshAccountIdentityBeforeSpawn(
  locks: DriveLock[],
  passArgv: readonly string[],
): Promise<boolean> {
  let identitySynced = refreshAccountIdentity(locks, passArgv);
  for (
    let attempt = 1;
    !identitySynced && compromised === "" && attempt < 3;
    attempt++
  ) {
    // `sleep()` (`lib/cli.ts`) takes SECONDS, not milliseconds — `sleep(200)`
    // waited 200 SECONDS per retry, not 200ms, holding the driver's locks
    // without launching a pass for up to ~6m40s across both retries.
    await sleep(0.2);
    identitySynced = refreshAccountIdentity(locks, passArgv);
  }
  return identitySynced;
}

/**
 * Renew every held claim on a timer of its OWN, independent of the round loop.
 *
 * Refreshing once per round made a claim only as fresh as the round was short,
 * and a round is not short: one runs an agent pass, the fixes it decides on,
 * the full gate suite and sometimes a Testbox. A single ordinary pass can
 * outlast the staleness window, and another start would then quarantine the
 * locks of a driver that is demonstrably alive and working — reintroducing the
 * concurrent editing and pushes the lock exists to prevent. A lease has to be
 * renewed WHILE the work happens, not between units of it.
 *
 * `run()` spawns asynchronously, so the event loop stays live for the whole
 * pass and this timer fires during it. `unref` keeps the timer from holding
 * the process open on its own account.
 *
 * `touchLock` runs FIRST, every tick, unconditionally — `refreshAccountIdentity`
 * runs after, and only when this tick found no takeover and no pass is
 * currently running. Both restrictions close a real defect:
 *
 * - **Takeover ordering.** The reverse order let `refreshAccountIdentity`'s
 *   rename RECREATE a claim file a recovering driver had just removed,
 *   before `touchLock` ever got to notice the absence — republishing this
 *   generation's now-obsolete claim and defeating `touchLock`'s takeover
 *   detection outright (its own comment: "the only thing that removes
 *   `claim.<ours>` is a recovery of this generation"). Detecting the
 *   takeover first, and skipping the rewrite once `compromised` is set,
 *   means nothing this tick ever recreates a claim a recovery just deleted.
 * - **Active-pass gating.** See `refreshAccountIdentity`'s own comment for
 *   why rewriting mid-pass showed the NEXT pass's account while the CURRENT
 *   one was still running.
 */
function startHeartbeat(locks: DriveLock[], passArgv: readonly string[]): void {
  const timer = setInterval(() => {
    for (const lock of locks) touchLock(lock);
    if (compromised === "" && activePass === null) {
      refreshAccountIdentity(locks, passArgv);
    }
  }, heartbeatRefreshMs());
  timer.unref?.();
}

/**
 * Age of the claim's last refresh, or `null` when it cannot be read — an
 * unreadable age must never be treated as a stale one.
 */
function lastRefreshAgeMs(dir: string, claim: Claim): number | null {
  try {
    return Date.now() - statSync(join(dir, claim.name)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Is the recorded owner alive? Delegated to `lib/claim.ts`'s `claimLive` —
 * one rule, shared with the operator listing, so `drives.ts` can never call
 * a claim live that recovery here would retire, or vice versa.
 */
function claimAlive(claim: Claim, dir: string): boolean {
  return claimLive({
    pid: claim.pid,
    host: claim.host,
    platform: claim.platform,
    ageMs: lastRefreshAgeMs(dir, claim),
  });
}

/**
 * Retire the instance that was OBSERVED, by removing exactly the entries that
 * observation listed.
 *
 * This is the step every earlier cut got wrong, and always in the same way: it
 * addressed the lock's PATH. Renaming the path to a per-pid destination let a
 * second contender that had observed the same stale owner move a live
 * replacement aside and drive alongside it; the same shape in `release` let a
 * suspended owner move its SUCCESSOR's lock and leave the canonical path
 * briefly empty for a third driver. Keying the rename's DESTINATION to the
 * observed generation closed both, because `rename(2)` refuses a non-empty
 * directory as a destination — but only for as long as that destination stayed
 * non-empty, which meant a tombstone per generation that nothing could ever
 * reclaim: two permanent directories per drive run, growing with lifetime
 * invocations. An age-based sweep of them is not available, and was tried and
 * reverted: the quantity a threshold would have to bound is "does any process
 * still hold an observation of generation N", which the filesystem cannot
 * answer.
 *
 * Naming the SOURCE instead needs no fence, and so leaves nothing to bound.
 * Every name here comes from one `readdir` of the lock, and a lock's entries
 * are only ever installed wholesale by `takeLock`'s rename — so an entry a
 * successor published cannot appear in an observation taken before it existed.
 * An actor still acting on generation N after N was replaced therefore removes
 * `claim.N`, which is already gone: a no-op, whatever occupies the path now,
 * however long that actor was suspended. The interleavings the tombstone
 * closed are closed by the addressing itself.
 *
 * The emptied directory is removed too, not merely left empty: POSIX `rename`
 * accepts an empty directory as a destination, but Windows' `MoveFileEx`
 * refuses to replace an existing directory at all, empty or not — and this
 * skill supports Windows (SKILL.md's runtime section). Left standing, an
 * emptied slot would make every recovery attempt fail there the same way,
 * forever. Removing it is safe by the
 * SAME identity argument `release` already uses for its own `rmdir`: it
 * refuses a directory that is not empty, so a successor that moved in between
 * this retirement's removals and this `rmdir` is what stops it — the failure
 * is swallowed, and the next `takeLock` attempt settles the race the normal
 * way, against a non-empty destination.
 */
function retire(dir: string, occupant: Occupant): void {
  for (const name of occupant.names) {
    rmSync(join(dir, name), { recursive: true, force: true });
  }
  try {
    rmdirSync(dir);
  } catch {
    // A successor occupies it now, or removing it failed transiently — either
    // way not this retirement's to force; the caller's own takeLock retry is
    // what actually needs the slot, and it will find out for itself.
  }
}

/**
 * Acquire, recovering a lock whose owner is gone by RETIRING the instance that
 * was observed — see `retire` for why naming the instance rather than the path
 * is what makes a suspended contender harmless, and why nothing is kept back.
 *
 * Two contenders that observe the same stale generation both retire it, both
 * find the removal idempotent, and then race a `rename` that only one of them
 * can win; the loser refuses rather than driving. A contender whose
 * observation has been overtaken loses that race for the same reason, since
 * the winner's claim makes the destination non-empty.
 */
function acquire(lock: DriveLock, pr: string): void {
  mkdirSync(dirname(lock.dir), { recursive: true });
  if (takeLock(lock)) return;

  const occupant = inspect(lock.dir);
  const held = occupant.claim;
  if (held !== null && claimAlive(held, lock.dir)) {
    // The diagnostics line answers what this refusal used to leave open —
    // WHICH PR that driver is working, from where, and where its log is. A
    // claim without one (an older driver) still names its owner, and the
    // drives.ts hint covers both.
    const about =
      held.diag === null
        ? []
        : [
            `That driver is working PR #${held.diag.pr} from ${held.diag.worktree}`,
            `(started ${held.diag.started}). Its log: ${held.diag.log}`,
            `Account: ${formatAccountIdentity(held.diag.account)}`,
          ];
    fail(
      11,
      `drive.ts: another driver already holds the ${lock.what} lock (pid ${held.pid} on ${held.host || "this host"}) — refusing to start a second loop.`,
      ...about,
      `Lock: ${lock.dir}. List live drives: drives.ts (same directory); stop one: drives.ts --stop <PR>.`,
      "If that loop is genuinely gone, remove the lock dir and retry.",
    );
  }
  if (occupant.claimNames.length > 1) {
    // Unreachable by construction — an instance is installed whole, by rename,
    // so a lock holds one generation or none. Refuse rather than guess which
    // of them to retire: the cost is a refusal a human clears in one command,
    // and the cost of guessing wrong is the two drivers this exists to prevent.
    fail(
      11,
      `drive.ts: the ${lock.what} lock holds ${occupant.claimNames.length} claims at once — refusing to guess which is live.`,
      `Lock: ${lock.dir}. Remove the lock dir once no driver is running.`,
    );
  }
  retire(lock.dir, occupant);
  if (held !== null) {
    console.error(
      `drive.ts: recovered a stale ${lock.what} lock (owner pid ${held.pid} is gone)`,
    );
  }
  if (!takeLock(lock)) {
    fail(
      11,
      `drive.ts: lost the ${lock.what} lock race for PR #${pr} — another driver recovered the same stale lock first.`,
    );
  }
}

/**
 * Release ONLY the instance this process took, and leave the slot free.
 *
 * There is no ownership check here, because there is nothing left to check:
 * the only entry this can remove is the one this process published, and a
 * successor's carries a different name. Release used to have a protocol of its
 * own — check the owner, then move the path to a private `.releasing.<nonce>`
 * name and inspect what actually arrived — and three different interleavings
 * went through it, all the same defect. A private destination is not a fence:
 * it is always free, so the rename always succeeds, so a process suspended
 * past the staleness window — its lock recovered, the path now holding a
 * SUCCESSOR's live lock — moves that successor's lock away and leaves the
 * canonical path momentarily absent for a third driver to claim.
 *
 * `rmdir` then reclaims the slot, and it is safe by the same argument taking a
 * different route: it refuses a directory that is not empty, so a successor
 * that has already moved in is what stops it. Identity again, not timing —
 * and, unlike the tombstone this replaces, it leaves nothing behind at all.
 */
function release(lock: DriveLock): void {
  if (lock.nonce === undefined) return; // never taken
  rmSync(join(lock.dir, `processes.${lock.nonce}`), {
    recursive: true,
    force: true,
  });
  rmSync(stopRequestPath(lock.dir, lock.nonce), { force: true });
  rmSync(join(lock.dir, claimName(lock.nonce)), { force: true });
  try {
    rmdirSync(lock.dir);
  } catch {
    // A successor occupies it, or it is already gone. Either way it is not
    // this process's to remove.
  }
}

// ── Durable driver log ──────────────────────────────────────────────────────

/**
 * Install the tee, then announce the log: its path, or why there is none.
 * do-item quotes the announced path as the drive's log, so a log that could
 * not be started is never announced by path.
 */
/**
 * True while this driver holds the drive's locks; cleared before it releases
 * them. Rotation also stops once another driver has recovered a lock
 * (`compromised`), so only the current owner ever renames the log.
 */
let driverLogRotates = false;
const mayRotateDriverLog = (): boolean =>
  driverLogRotates && compromised === "";

function startDriverLog(logPath: string): void {
  const unavailable = teeConsoleTo(logPath);
  console.error(
    unavailable === null
      ? `drive.ts: driver log → ${logPath}`
      : `drive.ts: driver log unavailable: ${unavailable}`,
  );
}

/**
 * Mirror everything this process writes to stdout/stderr into `logPath`,
 * append-only and BEST-EFFORT: the console stays authoritative, and a log
 * write that fails (disk full, directory vanished) must never take the drive
 * down with it — the same asymmetry `loopEconomy` documents for the report it
 * renders.
 *
 * TWO channels are wrapped, because under Bun they are disjoint: the console
 * methods write to the fd natively, BYPASSING the JS-level
 * `process.stdout.write` (measured — a stream-only tee logged nothing but its
 * own header), while the direct `process.stderr.write` call sites in
 * this file (the dirty-tree listing, the loop-economy epilogues) dispatch
 * through the assignable property and never touch console. Under Node the
 * channels are NOT disjoint — console methods dispatch THROUGH the patched
 * `stream.write` (measured on Node 24: an unguarded double tee appended
 * every console line twice) — so the console tee raises a reentrancy flag
 * and the stream tee skips its append while it is up, keeping every line
 * exactly-once on both supported runtimes. A child spawned
 * with inherited stdio writes to the fd itself and is NOT captured — that is
 * the pass, and it is deliberate (see the log's comment in `main`). Appends
 * are synchronous, so the tail survives the exit path without the async-pipe
 * truncation macOS is known for. Each line carries its time and level, and
 * the file rotates at a size bound (`lib/driver-log.ts`).
 *
 * Returns `null` once the tee is installed, or the reason there is no log.
 */
function teeConsoleTo(logPath: string): string | null {
  // An armed drive outlives the session that started it; once that session
  // closes the pipe, a console write fails with EPIPE. That one error is
  // absorbed whether or not the durable log starts: with a log it carries
  // the narrative from then on, and without one the drive still runs on.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (err) => {
      if (errnoCode(err) !== "EPIPE") throw err;
    });
  }
  // Problems with the log are reported straight to the terminal, never
  // through the tee, which would only try the failing log again.
  const rawStderrWrite = process.stderr.write.bind(process.stderr);
  let starting = true;
  const driverLog = new DriverLog(logPath, {
    report: (message) => {
      if (!starting) rawStderrWrite(`drive.ts: warning: ${message}\n`);
    },
    // Several drivers can write this log (one that refuses to start writes
    // its refusal here); only the one holding the drive's locks rotates it.
    mayRotate: mayRotateDriverLog,
  });
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch (err) {
    return `cannot create ${dirname(logPath)} (${err instanceof Error ? err.message : String(err)})`;
  }
  driverLog.startRun(
    `── drive.ts pid ${process.pid} — driver narrative (pass output streams to the launching session) ──`,
  );
  starting = false;
  const unavailable = driverLog.firstProblem;
  if (unavailable !== null) {
    // Best-effort from the very first byte: an unwritable log — full disk, a
    // directory squatting on the path, permissions — must not stop the drive.
    // `startDriverLog` prints the one line that says so.
    return unavailable;
  }
  const append = (level: DriverLogLevel, text: string | Uint8Array): void =>
    driverLog.append(level, text);
  // Reentrancy flag for the Node path, where the original console methods
  // dispatch through the patched `stream.write` below — without it every
  // console line is appended twice. Console calls are synchronous, so a
  // plain boolean cannot interleave across writers.
  let teeingConsole = false;
  const consoleTee =
    (level: DriverLogLevel, original: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      // `util.format` — the same formatter console.log itself applies —
      // so the durable copy keeps placeholders, object inspection and
      // Error stacks instead of degrading to `[object Object]`.
      append(level, `${format(...args)}\n`);
      teeingConsole = true;
      try {
        original(...args);
      } finally {
        teeingConsole = false;
      }
    };
  console.log = consoleTee("INFO", console.log.bind(console));
  console.error = consoleTee("WARN", console.error.bind(console));
  for (const [stream, level] of [
    [process.stdout, "INFO"],
    [process.stderr, "WARN"],
  ] as const) {
    const original = stream.write.bind(stream);
    const teed: typeof stream.write = (
      chunk: Uint8Array | string,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean => {
      if (!teeingConsole) append(level, chunk);
      return typeof encodingOrCb === "function"
        ? original(chunk, encodingOrCb)
        : original(chunk, encodingOrCb, cb);
    };
    stream.write = teed;
  }
  return null;
}

// `drive.ts` is itself very often launched from inside a live Claude Code
// session (do-item's "Arm the drive" step spawns it in the background), and
// a spawned child inherits that session's env by default — including
// CLAUDECODE, which the `claude` CLI sets to recognize a nested invocation of
// itself. Passed through unchanged to a `claude -p` pass command, that marker
// makes the pass refuse to start as a nested session — silently, after this
// process has already reported the round as running. The pass is a fresh
// top-level session, not a continuation of whatever spawned `drive.ts`, so it
// must not inherit that marker.
function passEnv(task?: {
  task: RepairTask;
  detail: string;
}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  // DELETED UNCONDITIONALLY FIRST, then set only for a repair pass. An
  // ordinary review round must never inherit a repair task — not from this
  // driver's own environment, and not from an operator who exported one by
  // hand to reproduce something. A review pass that believed it was a
  // CI-repair round would skip triage entirely and leave live findings
  // unanswered, which is the one failure this whole loop exists to prevent.
  delete env.DRIVE_PR_ROUND_TASK;
  delete env.DRIVE_PR_ROUND_TASK_DETAIL;
  if (task !== undefined) {
    env.DRIVE_PR_ROUND_TASK = task.task;
    env.DRIVE_PR_ROUND_TASK_DETAIL = task.detail;
  }
  return env;
}

/**
 * Spawn one repair pass and return its exit code.
 *
 * The RAW code, not a collapsed boolean: `guarded-push.ts` exits `5` for
 * `PR_NOT_OPEN` inside the pass, exactly like the ordinary-pass ROUND_READY
 * spawn does, and a caller that only learns "zero or nonzero" cannot tell
 * that apart from an ordinary repair failure — reporting a CI stop or a
 * conflict stop over a PR that already merged or closed, which
 * `passExitDisposition` exists precisely to prevent for the ordinary path.
 * Callers check `=== 5` themselves, mirroring `passExitDisposition`'s own
 * handling rather than duplicating it inside this shared helper.
 *
 * DELIBERATELY NOT the ROUND_READY spawn block. That block carries a review
 * round's whole accounting: the durable round/attempt bumps, the pre-pass
 * Ready record, the stall fingerprint, `--max-rounds`, the reflect-due
 * handoff. None of it describes a repair, and threading a second mode through
 * it would put a conditional on every one of those steps — the shape that
 * makes a state machine unreadable, on the file `references/consistency.md` already names as the
 * highest-churn.
 *
 * What it therefore does NOT get, stated rather than discovered later:
 *
 *   - NO QUOTA HANDLING. A repair pass that dies on a subscription wall is
 *     an ordinary failed pass here, and the caller falls back to the stop it
 *     would have taken anyway. It does not park the drive. That is a bounded
 *     degradation of a path that previously did not exist at all, never a
 *     regression of the quota handling a REVIEW round still gets in full.
 *   - NO DURABLE ROUND ACCOUNTING. A repair is bounded by its in-memory
 *     budget, not by `--max-rounds`; see `ciRepairRounds`'s header.
 *
 * What it does share, because those are about the process tree rather than
 * the round: `detached` so a stop reaches the whole pass tree, `activePass`
 * so the signal handlers can find it, the pass deadline, and a lock touch on
 * the way out.
 */
async function runRepairPass(
  // `string[]`, not `readonly string[]`: `run()`'s own argv parameter is
  // mutable, and widening here would only move the variance error to the call.
  agent: string[],
  // Mutable: the unwitnessed-deadline branch below needs to clear this array
  // in place, the same way the ordinary-pass path clears `held` — see that
  // branch's own comment for why.
  locks: DriveLock[],
  task: RepairTask,
  detail: string,
  // The caller's own checkpoint closure (§ mailboxCheckpoint in `main()`).
  // Passed in rather than re-created here: it closes over `mailboxDir`, `pr`
  // and `pauseMaxSec`, all local to `main()`, and re-checking through the
  // SAME closure keeps this function's own re-check indistinguishable from
  // every other call site's (see this function's own pre-spawn re-check
  // below for why one is needed here at all).
  mailboxCheckpoint: () => Promise<"clear" | "resumed" | number>,
): Promise<RepairDispatch> {
  const deadlineSec = passTimeoutSeconds();
  // One more refresh, immediately before THIS spawn — not only at the PRIOR
  // pass's exit, below: the only other call in this function ran AFTER
  // `run()` returned, so the very FIRST repair pass of a drive got no
  // pre-spawn read at all — a file-backed login change landing between
  // dispatch and this spawn stayed stale for that pass's whole life, while
  // active-pass gating suppressed the heartbeat's own retries throughout.
  // Same pattern as the ordinary-pass spawn site's own pre-spawn call.
  const preSpawnSynced = await refreshAccountIdentityBeforeSpawn(locks, agent);
  if (compromised !== "") {
    console.error(
      `drive.ts: the ${compromised} lock was recovered by another driver — not starting a repair pass.`,
    );
    return {
      dispatched: false,
      resumed: false,
      code: SINGLE_INSTANCE_LOCK_EXIT,
    };
  }
  if (!preSpawnSynced) {
    console.error(
      "  the account-identity claim rewrite did not land before the repair pass — proceeding with a possibly-stale display; the heartbeat retries once this pass exits.",
    );
  }
  // Re-checked HERE, after the identity refresh above, not only by the
  // caller before this function was invoked: that refresh is itself an await
  // a mailbox directive can land during, so the caller's own pre-dispatch
  // checkpoint does not cover the gap between it and this spawn — this call
  // is what makes THIS spawn's own checkpoint the LAST await before `run()`,
  // matching the ordinary-pass site's invariant. Its outcome is tagged
  // `dispatched: false` so a caller can never mistake it for the pass's OWN
  // exit code below.
  const mailboxBeforeSpawn = await mailboxCheckpoint();
  if (typeof mailboxBeforeSpawn === "number")
    return { dispatched: false, resumed: false, code: mailboxBeforeSpawn };
  if (mailboxBeforeSpawn === "resumed")
    return { dispatched: false, resumed: true };
  const res = await span("pass", { kind: "repair" }, () =>
    run(agent, {
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
      env: passEnv({ task, detail }),
      ...(deadlineSec > 0 ? { timeoutSec: deadlineSec } : {}),
      onSpawn: (h) => {
        activePass = h;
      },
    }),
  );
  // Captured before `activePass` is cleared, same as the ordinary-pass
  // path's own `passHandle` — see its comment for why this has to happen
  // here rather than reading `activePass` again below.
  const handle = activePass;
  activePass = null;
  // Mirror the ordinary-pass path's PASS_DEADLINE handling: `run` resolving
  // once its own SIGKILL escalation FIRES is proof a signal was SENT, not
  // that the process group is actually GONE — a descendant in
  // uninterruptible sleep, or one that escaped the group, can outlive it.
  // Re-poll the same witnessed-termination check before this driver's own
  // exit handler releases its locks: a live repair descendant under a
  // released lock is the exact two-drivers-one-tree state those locks exist
  // to prevent. The ordinary path does this via `passHandle.stop()`
  // re-joining the same memoised wait `RunHandle.stop()` performs; this is
  // that same call.
  if (res.timedOut && handle !== null && !(await handle.stop())) {
    console.error(
      "  the repair pass hit its deadline and its termination could NOT be witnessed — some descendant may still be running.",
    );
    console.error(
      "  NOT releasing this drive's locks: a live pass under a released lock is the",
    );
    console.error(
      "  exact two-drivers-one-tree state they exist to prevent. Confirm the tree is",
    );
    console.error("  actually gone, then remove the lock dir to re-arm.");
    locks.length = 0;
    // No post-pass checkpoint here: termination could not be witnessed, so
    // a descendant may still be running — this return must stay quick
    // rather than risk blocking on a pause wait against a tree in that
    // state.
    return { dispatched: true, code: res.code, postPassMailboxExit: null };
  }
  for (const lock of locks) touchLock(lock);
  // Mirror the ordinary-pass path's post-pass refresh, bounded retry
  // included: `activePass` is already `null` (above), which is the exact
  // window a file-backed login change during THIS repair pass needs closed
  // before the next spawn — the CI-repair budget (default 2) lets the loop
  // re-gate and dispatch a second repair pass well inside one heartbeat
  // interval, same as the ordinary path's own back-to-back-spawn risk. A
  // bare, unretried call here left a merely-transient rewrite failure
  // unretried right up to that next spawn — see
  // `refreshAccountIdentityBeforeSpawn`'s own header. Its `compromised` side
  // effect is picked up by both call sites' existing
  // `if (compromised !== '')` check immediately after this returns —
  // there is nothing further to do with it here.
  const identitySynced = await refreshAccountIdentityBeforeSpawn(locks, agent);
  if (compromised === "" && !identitySynced) {
    // Not a takeover — an ordinary, still-unresolved transient failure
    // after every retry. Proceeding anyway, same posture as the
    // ordinary-pass spawn: the heartbeat resumes retrying once this repair
    // pass's caller reaches its own next tick, and a repair pass must not
    // stall over a DISPLAY value.
    console.error(
      "  the account-identity claim rewrite did not land after the repair pass — proceeding with a possibly-stale display; the heartbeat retries before the next spawn.",
    );
  }
  // A directive sent WHILE this repair pass ran must still be honored before
  // its result is reported — the same gap the ordinary-pass path had at its
  // own post-pass point. `clear`/`resumed` both leave `postPassMailboxExit`
  // null: the pass already ran, so the caller reports its real result either
  // way, once it has committed the budget this confirmed dispatch earned.
  const mailboxAfterRepairPass = await mailboxCheckpoint();
  return {
    dispatched: true,
    code: res.code,
    postPassMailboxExit:
      typeof mailboxAfterRepairPass === "number"
        ? mailboxAfterRepairPass
        : null,
  };
}

/**
 * Record the quota wall this drive is parking on.
 *
 * Called on BOTH quota paths, which is the whole point: the `stop` path
 * exits and lets the claim age toward `stale`, while the `sleep` path holds
 * its locks and keeps refreshing them for up to `maxSleepMs` (six hours by
 * default) with no pass running and no progress to stamp. Without a record,
 * `--doctor` reads that second case as a live driver with hours-stale
 * progress and no pass child — the exact shape of `WEDGED` — and reports a
 * drive that is doing precisely what it was designed to do as stuck.
 * `QUOTA_PARKED` outranks `WEDGED` in `lib/doctor.ts`'s precedence order, so
 * recording it here is what makes the sleeping case classify honestly.
 *
 * Best-effort by design: a failure to record must not fail the wall handling
 * itself. Losing the record costs a `--doctor` verdict — `WEDGED` on the
 * sleeping path, `UNKNOWN` on the exiting one — never a false `HEALTHY`, and
 * never the drive.
 */
async function recordQuotaPark(
  driveStatePath: string,
  pr: string,
  block: { vendor: string; window: string; resetAt: Date | null },
): Promise<void> {
  const park = await run(
    tsArgv(driveStatePath, [
      "quota-park",
      pr,
      "--vendor",
      block.vendor,
      "--window",
      block.window,
      ...(block.resetAt !== null
        ? ["--reset-at", block.resetAt.toISOString()]
        : []),
    ]),
    // Deadlined per `references/consistency.md` — on the exiting
    // path an undeadlined hang would hold the drive's locks open
    // indefinitely at the one moment whose whole job is to release them.
    { stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
  );
  if (park.code !== 0) {
    console.error(
      `drive.ts: could not record the quota park for PR #${pr} (drive-state.ts exited ${park.code}) — continuing anyway.`,
    );
  }
}

/**
 * The round budget: `--max-rounds` when given, else the repository's
 * `drive.max_rounds`, else the built-in default. The setting is read only
 * when the flag is absent, so a malformed one cannot block an explicit run.
 */
function resolveMaxRounds(flag: string | undefined): number {
  if (flag !== undefined) {
    if (!isDigits(flag)) fail(2, "--max-rounds takes a whole number");
    const n = Number.parseInt(flag, 10);
    if (!Number.isSafeInteger(n) || n < 1)
      fail(2, "--max-rounds must be a whole number of at least 1");
    return n;
  }
  try {
    return maxRoundsSetting() ?? DEFAULT_MAX_ROUNDS;
  } catch (e) {
    return fail(1, `drive.ts: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Whether the reflect duty is armed: the depth past the last recorded
 * reflection passes the threshold and reflection is on (the `reflection`
 * configuration section); with it off the lesson has no store to reach.
 * Unreadable settings are reported and read as off.
 */
function reflectDutyArmed(depth: number, threshold: number): boolean {
  if (!(depth > threshold)) return false;
  const reflection = reflectionSwitch();
  if (reflection instanceof Error)
    console.error(
      `  reflection settings unreadable, so no /jig:reflect duty: ${reflection.message}`,
    );
  return reflection === true;
}

async function main(): Promise<number> {
  let pr = "";
  let maxRounds: string | undefined;
  let dryRun = false;
  let botsOnly = false;
  let keepDraft = false;
  let handoffAt = "50";
  let passTimeout = "";
  const forward: string[] = [];
  const agent: string[] = [];
  let sawDdash = false;

  const argv = process.argv.slice(2);
  const take = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined) fail(2, `${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (sawDdash) {
      agent.push(a);
      continue;
    }
    switch (a) {
      case "--":
        sawDdash = true;
        break;
      case "--max-rounds":
        maxRounds = take(a, i++);
        break;
      case "--handoff-at":
        handoffAt = take(a, i++);
        break;
      case "--pass-timeout":
        passTimeout = take(a, i++);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--keep-draft":
        keepDraft = true;
        break;
      case "--bots-only":
        botsOnly = true;
        forward.push(a);
        break;
      case "--no-head-sync":
        forward.push(a);
        break;
      case "--timeout":
      case "--interval":
        forward.push(a, take(a, i++));
        break;
      default:
        if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
        pr = a;
    }
  }

  const maxRoundsN = resolveMaxRounds(maxRounds);

  // When a draft is marked Ready: `--keep-draft` wins, else the repository's
  // `pull_requests.mark_ready`. Read once, up front: an unreadable policy
  // stops the drive rather than guessing when to summon more reviewers.
  let markReadyPolicy: MarkReady = 1;
  try {
    markReadyPolicy = prPolicy().markReady;
  } catch (e) {
    fail(1, `drive.ts: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (markReadyPolicy === "never") keepDraft = true;

  // The flag is the env var's front door, validated HERE rather than in
  // `passTimeoutSeconds()`: a typo on the command line must refuse at exit 2
  // like every other bad flag, where the env var's own reader falls back to
  // the default (an unusable value in the environment is inherited noise, not
  // an instruction, and must not stop a drive an operator did not misconfigure).
  if (passTimeout !== "") {
    if (!isDigits(passTimeout)) {
      fail(2, "--pass-timeout takes a whole number of seconds (0 disables)");
    }
    const passTimeoutN = Number.parseInt(passTimeout, 10);
    // Same 32-bit `setTimeout` millisecond bound `passTimeoutSeconds()` falls
    // back on for the env var — but a FLAG's typo belongs at the front door,
    // exit 2, not a silent substitution that leaves an operator asking for a
    // longer deadline with a shorter one instead.
    if (passTimeoutN !== 0 && passTimeoutN * 1000 > 2_147_483_647) {
      fail(
        2,
        `--pass-timeout must be 0 or no greater than 2147483 seconds (got '${passTimeout}') — beyond that the millisecond delay overflows a 32-bit timer and fires immediately, inverting the deadline.`,
      );
    }
    process.env.DRIVE_PR_PASS_TIMEOUT = passTimeout;
  }

  handoffAt = resolveHandoffAt(handoffAt);

  if (!dryRun && agent.length === 0) {
    fail(
      2,
      "usage: drive.ts [PR] [flags] -- <command to run one pass> [args...]",
    );
  }

  const explicitPr = pr;
  pr = await resolvePr(pr);
  if (pr === "") fail(1, "drive.ts: could not resolve a PR number");
  // Digits, checked here rather than at the three places it lands. It is
  // interpolated into a `new RegExp` below, so a metacharacter — `drive.ts '('`
  // — throws a SyntaxError instead of a usage error; and it is exported as
  // $DRIVE_PR_TARGET, where drive-status.ts and guarded-push.ts compare it as a
  // string and refuse for a less obvious reason. Both of those already apply
  // isDigits; this is the entry point that did not.
  if (!isDigits(pr)) fail(2, `drive.ts: PR must be a number (got '${pr}')`);
  process.env.PR = pr;
  // The authoritative, out-of-band statement of which PR this drive is about.
  // drive-status.ts refuses to run when a pass resolves a different one, which
  // is what makes driver/pass agreement an assertion rather than an inference
  // from whatever the pass's prompt happens to contain. The argv check below
  // stays as a cheap early typo-catcher; this is the guarantee.
  process.env.DRIVE_PR_TARGET = pr;

  // Both shared resources, in a fixed order — see § Single-instance locking.
  // Both names live in the state dir: one keyed by PR, one by the working tree
  // — see `worktreeLockName` for why the latter may not be keyed by anything a
  // second driver in the same tree can be configured to compute differently.
  const stateDir = await resolveStateDir();
  const mailboxDir = await resolveMailboxDir();

  // The durable log. A drive is routinely armed as a background
  // child of a session that ends long before the drive does (do-item's
  // "Arm the drive" step), and its console output dies with that session — so
  // every line this process prints is ALSO appended here, beside the per-PR
  // state it belongs to. The PASS is deliberately not captured: it runs with
  // inherited stdio (see the spawn below), and routing it through a pipe
  // instead would change `run()`'s close semantics — a detached descendant of
  // the pass holding the pipe open past the leader's exit would wedge the
  // round. This log is the DRIVER's narrative: round decisions, refusals,
  // mark-Ready outcomes, and the terminal state.
  const logPath = join(stateDir, `drive-pr-${pr}.log`);
  startDriverLog(logPath);

  // What this driver publishes about itself into its lock claims — the answer
  // to "who is working my worktree, and on what?" that the exit-11 refusal
  // and the `drives.ts` listing surface. Advisory: lock liveness
  // never reads it (`lib/claim.ts`).
  // Deadlined like every other git call in main(): this runs before any
  // lock is acquired and only feeds the advisory worktree display string, so
  // a hung git must not stall the whole drive at startup.
  // The env is scrubbed of GIT_DIR / GIT_WORK_TREE: a hook-launched driver
  // inherits them for another checkout, and they outrank the cwd, so an
  // unscrubbed call would name THAT checkout in `diag.worktree` — which the
  // intent-chain capture spawn below then anchors its `cwd` to.
  const rootRes = await git(["rev-parse", "--show-toplevel"], {
    stderr: "ignore",
    timeoutSec: gitCallTimeoutSeconds(),
    env: gitIdentityEnv(),
  });
  // Resolved once HERE for the FIRST pass, from THIS process's own
  // environment. `startHeartbeat` below re-resolves on its own timer, but
  // only between passes — see `refreshAccountIdentity`'s own comment for
  // why a token-backed identity never needs that (env vars are fixed for
  // this process's life) while a file-backed one does, and why the rewrite
  // is withheld while a pass is actively running (an operator's login swap
  // mid-drive changes which account the NEXT pass bills, and a diag resolved
  // only here would keep reporting the old one for the rest of the drive's
  // life).
  const account = resolveAccountIdentity(agent);
  const diag: ClaimDiag = {
    pr,
    worktree: rootRes.code === 0 ? rootRes.stdout.trim() : "",
    log: logPath,
    started: new Date().toISOString(),
    account,
  };
  const locks: DriveLock[] = [
    { dir: join(stateDir, await worktreeLockName()), what: "worktree", diag },
    { dir: join(stateDir, `pr-drive-${pr}.lock`), what: `PR #${pr}`, diag },
  ];
  const held: DriveLock[] = [];
  using lockResources = new DisposableStack();
  const releaseAll = (): void => {
    driverLogRotates = false;
    lockResources.dispose();
    held.length = 0;
  };
  using stopControls = installStopControls(held, releaseAll);
  void stopControls;
  for (const lock of locks) {
    acquire(lock, pr);
    held.push(lock);
    lockResources.use(
      registerCleanup(() => {
        driverLogRotates = false;
        // An unwitnessed pass termination deliberately abandons these locks.
        if (held.includes(lock)) release(lock);
      }),
    );
  }
  createDriverRegistry(held);
  driverLogRotates = true;
  // Renewal starts the moment the last lock is held, and runs on its own timer
  // for the rest of the drive — a claim must stay fresh DURING a pass, not
  // only between passes.
  startHeartbeat(held, agent);

  // The SESSION every drive-state mutation of this drive belongs to, exported
  // once the locks are actually held (`lease.ts`). This driver plus
  // every round's pass — each a separate agent process, each with an agent pid
  // of its own — must count as ONE session, or round 2's pass would read round
  // 1's lease as a stranger's; and the session has to stay live for the WHOLE
  // drive, so that an interactive session in this same tree is refused between
  // rounds rather than only during one. This process's own pid is the only id
  // that satisfies both: it spans every pass and dies exactly when the drive
  // does. The locks above stop a second DRIVER; this is what extends that
  // guarantee to a driver-by-hand, which takes no lock at all.
  process.env.DRIVE_PR_SESSION = String(process.pid);

  // The ACQUISITION token behind that pid, exported beside it so a pass can
  // bind "this lock claim" to "the driver that spawned me" rather than to a
  // number the OS reuses. A pid alone cannot: a dead driver's still-fresh
  // claim whose pid the OS then handed to THIS driver reads live (same-host,
  // alive) and self (pid matches), and the pass would wave through a lock its
  // parent never took. This file already treats
  // `diag.started` as the instance token when correlating a worktree lock to
  // a PR lock; `drives.ts` compares the same value against this variable.
  process.env.DRIVE_PR_SESSION_STARTED = diag.started;

  // The TREE this drive drives, so a pass measures local HEAD there rather
  // than wherever its shell happens to stand. A pass is an agent with a
  // persistent shell cwd, and the state dir it legitimately reads — the driver
  // log, the durable state — IS the git common dir: one `cd` there and every
  // later `git rev-parse HEAD` answers with the MAIN worktree's head, which in
  // a Conductor checkout is `develop`. Measured: the gate then reported
  // HEAD_LAG against a head that was never going to arrive, the pass did
  // nothing, and the driver counted the round. Empty when the driver could not
  // resolve its own root, in which case the pass keeps the old behaviour.
  if (diag.worktree !== "") process.env.DRIVE_PR_WORKTREE = diag.worktree;

  // DURABLE knowledge of where this drive's state lives, handed to every pass
  // so the fence never has to re-derive it from a `.git` marker that may be
  // gone by then.
  //
  // `resolveFenceContext` asks git where the state dir is, and falls back to
  // "is a repository in play at all" when git cannot say. That fallback reads
  // the filesystem, so it distinguishes a confirmed absence from an
  // unanswerable look — but a marker that was DELETED or RENAMED is a genuine
  // `ENOENT`, indistinguishable from a tree that never held a repository, and
  // the fence would allow the POST with a still-live lease sitting unread in
  // this directory. No probe can close that from the filesystem alone: the
  // question is not "is there a repository here now" but "was drive state ever
  // resolved here", which only something that remembers can answer.
  //
  // This is that memory, and it costs nothing: the driver already resolved the
  // directory above, the override short-circuits the probe entirely, and every
  // pass is a child of this process. A lease only exists because a drive wrote
  // one, and a drive spawns its own passes — so the path that can actually
  // race an outcome reply is covered.
  //
  // NOT covered, and deliberately not claimed: a purely INTERACTIVE session
  // that took a lease and then lost its `.git`. It has no driver to inherit
  // this from, and recovering the directory after the fact needs durable state
  // outside the repository that nothing here keeps. Named in the fence's own
  // residuals rather than papered over.
  process.env.DRIVE_PR_STATE_DIR = stateDir;

  // The directory's ON-DISK IDENTITY at the moment the driver resolved it —
  // `<dev>:<ino>` — exported alongside the path because the PATH is exactly
  // what a rename-and-recreate leaves unchanged.
  //
  // Without this, the fence's identity baseline can only be captured by the
  // fence itself, in the same breath as its own enumeration. That closes a
  // swap landing DURING the fence, but not one that completed BEFORE the pass
  // started: the fence would enumerate the empty replacement, capture ITS
  // identity, find that identity perfectly stable throughout, and authorize
  // the POST while the live lease sits in the directory that moved. Only
  // something that observed the directory before the swap can answer that,
  // and the driver is the one thing that did.
  //
  // FAIL CLOSED when it cannot be read, rather than omitting the variable.
  // An earlier revision omitted it, reasoning by analogy with
  // `Lease.sessionStarted`'s leniency — but the analogy does not hold, and the
  // difference is the whole point of this variable. A token-less session
  // genuinely HAS no token, so `''` is the truth about it. A driver that
  // cannot stat its own state directory has not learned "there is no
  // baseline"; it has FAILED TO READ ONE. Omitting the variable publishes the
  // first as though it were the second, and the pass then treats a failed
  // safety read as "no baseline inherited" — so a transient failure here,
  // followed by the directory being replaced before the pass starts, lands in
  // exactly the pre-pass swap window this baseline exists to close.
  //
  // This is the fail-closed rule for gates applied to the producer: a check
  // that cannot read its input has verified nothing, and must say so rather
  // than emit an empty answer. Refusing costs a drive that could not have
  // fenced its own passes anyway.
  const stateDirIdentity = stateDirIdentityToken(stateDir);
  if (stateDirIdentity === "") {
    fail(
      1,
      `drive.ts: could not establish the identity of the drive state directory:`,
      `  ${stateDir}`,
      "",
      "Refusing to start. Every pass this drive spawns inherits that identity as",
      "the baseline proving the directory was not swapped before the pass began;",
      'without it a pass cannot tell a failed read from "no baseline", and would',
      "post unfenced through exactly that window.",
    );
  }
  process.env.DRIVE_PR_STATE_DIR_IDENTITY = stateDirIdentity;

  // The dial reaches the pass the same way $DRIVE_PR_REFLECT_DUE does, and for
  // the same reason: nothing here can read a session's context usage, so this
  // is an INSTRUCTION to the agent, not a guard over it. SKILL.md § Handing
  // off before you degrade makes acting on it part of the round; a control
  // loop cannot.
  process.env.DRIVE_PR_HANDOFF_AT = handoffAt;

  // `never` is the one setting that expects a compaction to happen MID-ROUND,
  // and a compaction between the reply and the resolve drops the held
  // `accepted` batch unless that batch is durable. So it is gated on the
  // durable-hold backend actually being there rather than assumed: a vendored
  // or older drive-state with no `held-keys` command, or state this driver
  // cannot read, would run a continuous drive with exactly the protection
  // missing that makes it safe. The probe is read-only and returns empty on a
  // fresh drive.
  if (handoffAt === "never") {
    const probe = await run(tsArgv(driveState, ["held-keys", pr]), {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (probe.code !== 0) {
      fail(
        2,
        `refusing --handoff-at never: the durable held batch is unavailable for PR #${pr}.`,
        "That setting runs THROUGH compaction, and a compaction between replying",
        "'**accepted**' and resolving the thread drops the held batch — leaving a",
        "fixed finding re-triaged next round, or two outcome tokens on one thread.",
        `'drive-state.ts held-keys ${pr}' must work first. Either this drive-state.ts`,
        "predates the held batch, or the state file is unreadable — run it directly",
        "to see which. Until then use --handoff-at 50 (or 75).",
      );
    }
  }

  // Guard the mis-targeting above. Only meaningful when the caller NAMED a PR:
  // with no argument the driver and the pass both resolve the current branch's
  // PR, so there is nothing to disagree about. A bare substring test would let
  // PR 12 satisfy a driver waiting on 123, so match the number as a delimited
  // token.
  if (explicitPr !== "" && agent.length > 0) {
    const token = new RegExp(`(?:^|[^0-9])${explicitPr}(?:[^0-9]|$)`);
    const found = agent.some((word) => token.test(word));
    if (!found) {
      console.error(
        `refusing to run: PR #${explicitPr} was given, but the pass command names no PR:`,
      );
      console.error(`  ${agent.map(shellQuote).join(" ")}`);
      console.error(
        "The pass would target the current branch’s PR instead — editing and",
      );
      console.error(
        "resolving threads on a different pull request. Name it explicitly, e.g.",
      );
      console.error(
        `  drive.ts ${explicitPr} -- claude -p "/jig:drive-pr ${explicitPr}"`,
      );
      return 2;
    }
  }

  // --bots-only scopes what the driver COUNTS. A pass that is not also scoped
  // resolves human threads the count never included, and the loop then
  // converges against a different set than the one it watched.
  if (botsOnly && agent.length > 0) {
    const found = agent.some((word) => word.includes("--bots-only"));
    if (!found) {
      fail(
        2,
        "refusing to run: --bots-only was given, but the pass command does not pass it.",
        "The pass would act on human threads the convergence count excludes.",
      );
    }
  }

  // A dry run inspects; it does not work a round. Counting it would inflate
  // the round total the bound is measured against.
  //
  // `--once` too: without it, drive-status.ts takes
  // its OWN internal polling path — up to its full `--timeout` (30 minutes by
  // default) — because `--no-count` marks the reconciliation sweep suppressed
  // (`sweepSuppressed`), and every UNRECONCILED_STOPPERS code (2/7/8/9/10,
  // which includes both repair states this drive can dispatch) can only be
  // CERTIFIED once that sweep has run and succeeded — never true
  // under suppression. So a dry run against a PR sitting in any of those
  // states, or simply not yet settled (case 4), used to block for minutes
  // before reporting anything, which defeats the entire point of a preview.
  // `--once` was already the correct pattern for exactly this shape of call —
  // see `announce-merge-ready.ts`'s own `--no-count` re-read — and this call
  // site is a "re-read" too: dry-run's whole premise is inspecting current
  // state without doing work, i.e. without a prior sweep of its own to lean
  // on either. It still cannot CERTIFY those codes (nothing short of running
  // the sweep can, and a dry run must not mutate GitHub thread state as a side
  // effect of a preview) — it now just says so immediately instead of after a
  // long, silent wait.
  const probeFlags = dryRun ? ["--no-count", "--once"] : [];

  // Separate bounds, each capped at --max-rounds, because they measure
  // different runaways and neither one covers the other:
  //
  //   `counted`   — the DURABLE count of distinct reviewed heads, bumped by
  //                 drive-status.ts. Blind to a pass that never pushes: the
  //                 head does not move, so this never grows.
  //   `attempts`  — the DURABLE count of passes made on the CURRENT head,
  //                 bumped below. Bounds exactly that case.
  //
  // Both are durable, and that is the correction. `attempts` used to be a
  // per-process counter, which bounded a non-pushing pass only within one
  // process: on an unchanged head `counted` stays flat, so every restart of
  // the driver started from zero and granted another full `--max-rounds`, and
  // a harness that restarts drive.ts ran unbounded passes against a "bounded"
  // loop. Keying `attempts` to the head is what keeps a genuine new round from
  // inheriting the previous head's exhausted budget.
  //
  // They stay SEPARATE counters, though. Seeding one from the other — one
  // counter doing both jobs — is what double-counted a head across a resume:
  // the over-limit head is persisted by drive-status.ts before being rejected
  // here, so an operator who raises the limit to that persisted count starts
  // at N, increments to N+1, and rejects the very round they raised the limit
  // to admit.
  //
  // An unreadable state file is a hard stop, not a zero. Defaulting it would
  // restore exactly the fresh-budget-per-restart hole this closes, on the one
  // path where the evidence has already been lost.
  const resumedRes = await run(tsArgv(driveState, ["rounds", pr]), {
    stderr: "inherit",
  });
  if (resumedRes.code !== 0) {
    fail(
      1,
      `cannot read the durable drive state for PR #${pr}; refusing to drive on an unknown round budget`,
    );
  }
  const resumedRaw = resumedRes.stdout.trim();
  const resumed = isDigits(resumedRaw) ? Number.parseInt(resumedRaw, 10) : 0;
  if (resumed > 0) {
    console.error(
      `resuming PR #${pr} at round ${resumed} of ${maxRoundsN} (from durable state)`,
    );
  }
  // Announced because it is unenforceable. Every other setting here is checked
  // by something; this one is only ever as real as the pass's own judgement,
  // so the human watching stderr is told what the pass was asked to do.
  if (handoffAt === "never") {
    console.error(
      "handoff: never (continuous) — the pass drives through compaction and leans on",
    );
    console.error(
      `  the durable held batch and .context/pr-drive-${pr}.md to survive it.`,
    );
  } else {
    console.error(
      `handoff: at ~${handoffAt}% context (agent-judged, not measured)`,
    );
  }

  // Keep the PR pin captured from the explicit pickup token before arm.
  // Without an existing pin this helper refuses rather than inferring a source
  // from mutable aliases; rounds report missing scope. Best effort,
  // bounded by helperTimeoutSeconds(), and first-write-wins on every re-arm.
  if (!dryRun) {
    // Anchored to the tree this drive drives (`diag.worktree`), not the
    // ambient cwd: the capture CLI reads its PR lookup, intent-chain root and
    // checked-out branch from process.cwd(), so a driver started from a
    // subdirectory would otherwise verify against a different root.
    const cap = await run(tsArgv(captureIntentChain, [pr]), {
      stderr: "pipe",
      timeoutSec: helperTimeoutSeconds(),
      cwd: diag.worktree === "" ? undefined : diag.worktree,
      // `cwd` alone does not bind git to this worktree: an inherited GIT_DIR
      // (a hook-launched driver) outranks it, and the capture CLI's branch
      // check and chain-root lookup both go through git. The child inherits
      // this scrubbed environment for every git call it makes.
      env: gitIdentityEnv(),
    });
    const said = `${cap.stdout.trim()} ${cap.stderr.trim()}`.trim();
    console.error(
      `intent chain: ${cap.code === 0 ? "pinned" : cap.code === 3 ? "not pinned" : `capture failed (exit ${cap.code})`} for PR #${pr}${said === "" ? "" : ` — ${said}`}`,
    );
  }

  let passes = 0;
  // Whether THIS run fired the draft→Ready transition. Not the durable claim —
  // that answers "has it ever been marked", which is the wrong question for a
  // convergence report. What the operator needs to know is that the reviewers
  // which skip drafts were summoned moments ago and have not answered yet, and
  // that is true only of the run that did the summoning.
  let markedReadyThisRun = false;
  // Whether the transition was left in ANOTHER driver's hands. Reported
  // separately from `markedReadyThisRun` because it is a different fact with a
  // different consequence: nobody has been summoned yet, and whether they ever
  // are depends on a driver this one cannot see.
  let readyLeftToOtherDriver = false;
  // Whether the owner converted an already-Ready PR to draft in the window
  // before this drive's own --record-only read — a DIFFERENT unsettled shape
  // than `readyLeftToOtherDriver`: no other driver is involved, so the
  // "another driver holds the lease" message would be wrong here. Reported
  // separately so each gets its own accurate stderr line while both share the
  // same non-terminal exit.
  let readyFlippedToDraftBeforeRecord = false;
  // Whether the CONVERGED-with-no-round-to-run branch has already re-gated
  // once for a STABLE mark-ready.ts outcome (`already-ready` /
  // `already-marked`). That branch never runs a round, so it never touches
  // `passes`/`--max-rounds` the way case 0 (ROUND_READY) does — nothing else
  // bounds a loop that keeps re-entering it. A genuinely unmoved head
  // answers CONVERGED with the same stable outcome every time, so one extra
  // gate call closes the TOCTOU window this re-gate exists for; a second
  // `continue` from this exact spot would buy nothing further and spin
  // forever on a head that never changes.
  let reGatedForStableMarkReadyOutcome = false;
  // Consecutive post-round transitions that failed. A single failure is not a
  // reason to abandon a productive drive — the lease is released, so the next
  // round retries — but a PERMANENTLY failing one (an unwritable state store, a
  // revoked token) would otherwise run silently to `--max-rounds` with the PR
  // still a draft — the gap of ignoring `rc.code` entirely.
  let readyMarkFailures = 0;
  // Stall guard: consecutive
  // ROUND_READY gates reading an identical fingerprint mean the passes between
  // them completed (exit 0) while changing nothing — the exact shape of a pass
  // that stands down every round, which no other counter here distinguishes
  // from progress. `counted` never grows on an unmoved head, `attempts` only
  // bounds it at the full --max-rounds budget, and the round headers look
  // healthy throughout (measured: five wasted rounds on one PR, ten on
  // another — and the first then merged over six live findings because the
  // log read as driven).
  // The threshold is deliberately small: ONE no-op round can be a legitimate
  // blip, but a second identical one will not improve by itself, because the
  // next pass is the same command against the same world.
  const stallRoundsRaw = process.env.DRIVE_PR_STALL_ROUNDS ?? "2";
  const stallRounds = isDigits(stallRoundsRaw)
    ? Number.parseInt(stallRoundsRaw, 10)
    : 2;
  let prevFingerprint: string | null = null;
  let noopRounds = 0;
  // Repair-round budgets. In-memory for the reason `ciRepairRounds`
  // documents — a new `DriveState` field would refuse every state file written
  // before it existed, stopping the whole fleet's in-flight drives — and on
  // the `noopRounds` precedent directly above, whose reset-across-restarts
  // semantics operators already know from the skill's `README.md`.
  //
  // The CI budget is read ONCE, here, rather than per-iteration: the "how many
  // have I spent" counter and the bound it is compared against must come from
  // the same reading, or an operator editing the environment mid-drive could
  // move the goalposts under a partially-spent budget. (The conflict budget is
  // read at its own single use site, which is reached at most once per
  // iteration and compared against its counter in the same expression.)
  const ciRepairBudget = ciRepairRounds();
  let ciRepairs = 0;
  let conflictRepairs = 0;
  // Consecutive "converged, nothing failing, but no fresh required-check
  // witness" polls — bounded for the reason that branch documents. `0`
  // disables the bound and restores the unbounded wait.
  const witnessWaitLimit = finalCiWitnessPolls();
  let witnessWaits = 0;
  // The head `witnessWaits` is counting against — see the reset at its own
  // branch for why the count is per-head rather than per-drive.
  let witnessWaitHead = "";
  const finalCiWait = new FinalCiWait(pr);
  const pauseMaxRaw = process.env.DRIVE_PR_PAUSE_MAX_SEC ?? "1800";
  const pauseMaxSec =
    isDigits(pauseMaxRaw) &&
    Number(pauseMaxRaw) >= 1 &&
    Number(pauseMaxRaw) <= 86400
      ? Number(pauseMaxRaw)
      : 1800;
  const mailboxCheckpoint = async (): Promise<"clear" | "resumed" | number> => {
    const outcome = await waitAtMailboxCheckpoint(mailboxDir, pr, pauseMaxSec);
    switch (outcome) {
      case "clear":
      case "resumed":
        return outcome;
      case "stopped":
        return MAILBOX_STOPPED_EXIT;
      case "pause-timeout":
        return MAILBOX_PAUSE_TIMEOUT_EXIT;
      case "compromised":
        console.error(
          `drive.ts: the ${compromised} lock was recovered by another driver at a mailbox checkpoint — stopping.`,
        );
        return SINGLE_INSTANCE_LOCK_EXIT;
      case "unreadable":
        return 1;
    }
  };
  for (;;) {
    // The heartbeat timer reports a takeover here rather than acting on it
    // itself: a lock recovered out from under this drive means another driver
    // is already working the same worktree or PR, and continuing is exactly
    // the concurrency the lock exists to prevent. Nothing is released on the
    // way out — `release` refuses a lock whose nonce is no longer ours.
    if (compromised !== "") {
      console.error(
        `drive.ts: the ${compromised} lock was recovered by another driver mid-drive — stopping rather than running a second loop.`,
      );
      return SINGLE_INSTANCE_LOCK_EXIT;
    }
    const mailboxAtRoundStart = await mailboxCheckpoint();
    if (typeof mailboxAtRoundStart === "number") return mailboxAtRoundStart;
    if (mailboxAtRoundStart === "resumed") finalCiWait.clear();
    // Reuse only a keep-waiting decision. Terminal claims still pass through
    // live status, release, final-ready and final status below.
    const skippedFinalCi = await finalCiWait.skip(
      witnessWaits,
      witnessWaitLimit,
    );
    if (skippedFinalCi !== null) {
      if (skippedFinalCi === "witness") witnessWaits += 1;
      await sleep(FINAL_CI_POLL_SECONDS);
      continue;
    }
    const statusRes = await run(
      tsArgv(driveStatus, [pr, "--json", ...forward, ...probeFlags]),
      { stderr: "inherit" },
    );
    const code = statusRes.code;
    let status: Record<string, unknown> = {};
    try {
      status = JSON.parse(statusRes.stdout) as Record<string, unknown>;
    } catch {
      status = {};
    }
    const reasonLine = `  ${String(status.reason ?? "")}`;
    // A directive may have arrived during drive-status.ts's long poll. Re-gate
    // after a resumed pause so its pre-pause snapshot cannot authorize work.
    const mailboxAfterStatus = await mailboxCheckpoint();
    if (typeof mailboxAfterStatus === "number") return mailboxAfterStatus;
    if (mailboxAfterStatus === "resumed") continue;

    // A dry run can NEVER see the real `code === 9` (PR_CONFLICTING)
    // certification: `--no-count` — part of every dry-run probe's
    // `probeFlags`, unconditionally — suppresses the replied-thread
    // reconciliation sweep, and `UNRECONCILED_STOPPERS` (`drive-status.ts`)
    // withholds code 9 until that sweep has run and succeeded, degrading to
    // INDETERMINATE (1) instead regardless of `--once`. That silently made
    // case 9's own dry-run preview below dead code, contradicting
    // README.md's "`--dry-run` reports what each round would do".
    // Recognise the SAME condition `evaluate()` uses to decide
    // PR_CONFLICTING — mergeable === 'CONFLICTING' and nothing LIVE left to
    // work — directly off this already-fetched report instead: the counts
    // below come from a plain, non-mutating enumeration, not from the
    // reconciliation sweep dry-run suppresses, so reading them here mutates
    // nothing and needs no certification. Every field must be a POSITIVELY
    // measured number, never a null (unmeasured) treated as zero — an
    // uncertain read must fall through to the honest INDETERMINATE below,
    // not manufacture a preview from a guess.
    if (dryRun) {
      const merge = (status.merge ?? {}) as Record<string, unknown>;
      const work = (status.work ?? {}) as Record<string, unknown>;
      const num = (v: unknown): number | null =>
        typeof v === "number" ? v : null;
      const unresolvedThreads = num(work.unresolvedThreads);
      const parkedThreads = num(work.parkedThreads);
      const summaryUnaddressed = num(work.summaryUnaddressed);
      const parkedSummaryFindings = num(work.parkedSummaryFindings);
      if (
        merge.mergeable === "CONFLICTING" &&
        unresolvedThreads !== null &&
        parkedThreads !== null &&
        summaryUnaddressed !== null &&
        parkedSummaryFindings !== null &&
        unresolvedThreads - parkedThreads <= 0 &&
        summaryUnaddressed - parkedSummaryFindings <= 0
      ) {
        const base = String(
          (status.base as Record<string, unknown> | undefined)?.refName ?? "",
        );
        // Mirror case 9's own budget check (`conflictRepairs < conflictBudget`
        // further below) instead of always previewing a repair pass: this
        // shortcut returns before `conflictRepairs` could ever be
        // incremented, so it is always comparing against a fresh 0, which
        // collapses the same comparison to "is the budget positive". Without
        // this, `DRIVE_PR_CONFLICT_REPAIR_ROUNDS=0` still previewed "would
        // run a conflict-resolution pass" even though the real,
        // non-dry-run path takes the manual exit-9 stop instead.
        const conflictBudget = conflictRepairRounds();
        if (base === "") {
          console.error(
            "(dry-run) PR is conflicting with nothing left to work, but the base ref could not be read",
          );
        } else if (conflictBudget > 0) {
          console.error(
            `(dry-run) would run a conflict-resolution pass against origin/${base}`,
          );
        } else {
          console.error(
            `PR #${pr} conflicts with its base and has nothing left to work — stopping.`,
          );
          console.error(reasonLine);
          console.error(
            `  Fix: git fetch origin && git merge origin/${base}, resolve, run the gates, push. (DRIVE_PR_CONFLICT_REPAIR_ROUNDS=0 disables the automated repair pass)`,
          );
        }
        return 9;
      }
    }

    // Keep the resumable trail current even if the pass below dies mid-round.
    await run(tsArgv(driveState, ["handoff", pr]), {
      stdout: "ignore",
      stderr: "ignore",
    });

    switch (code) {
      case 3: {
        // Convergence is a remote fact — the reviewer stamped this head with
        // zero findings — so it says nothing about THIS worktree. Every
        // per-thread guard (answer-summary-finding.ts, resolve-held-thread.ts)
        // checks cleanliness only at its own moment: a round resolved entirely
        // with rejected/wont-fix/deferred outcomes never hits one, and dirt
        // created after the last resolution (gate re-runs, scratch probes, a
        // pass that died mid-edit before a resume) is invisible to all of
        // them. Exit 0 is the signal an operator merges on, so it must also
        // certify there is nothing left on the floor. Fail closed: an
        // unreadable tree gets the same refusal, not a shrug.
        //
        // Local HEAD must still be the reviewed head, checked before anything
        // else: a new local commit lands with an empty `git status` (nothing
        // uncommitted) and no unconcluded-op marker, so every check below
        // would pass over local HEAD having silently moved from the reviewed
        // commit to an unreviewed one that was never pushed. Same fix as
        // announce-merge-ready.ts's sibling check.
        const reviewedHead = String(
          (status.head as Record<string, unknown> | undefined)?.api ?? "",
        );
        const headTimeoutSec = gitCallTimeoutSeconds();
        const localHeadRes = await git(["rev-parse", "HEAD"], {
          stderr: "ignore",
          timeoutSec: headTimeoutSec,
        });
        if (localHeadRes.code !== 0) {
          console.error(
            `review converged after ${passes} round(s), but the working tree is UNREADABLE —`,
          );
          console.error(
            "cannot certify the worktree is clean, so not exiting 0 over unknown leftovers.",
          );
          return WORKTREE_UNCLEAN_EXIT;
        }
        const localHead = localHeadRes.stdout.trim();
        if (reviewedHead === "" || localHead !== reviewedHead) {
          console.error(
            `review converged after ${passes} round(s), but local HEAD is ${localHead || "<empty>"},`,
          );
          console.error(
            `while the reviewed head is ${reviewedHead || "<empty>"} — a commit landed here`,
          );
          console.error(
            "that was never pushed or reviewed. Push it, or reset to the reviewed head,",
          );
          console.error("then re-run.");
          return WORKTREE_UNCLEAN_EXIT;
        }

        // The economy block's NETWORK work happens HERE, ahead of every
        // worktree certification below rather than between them.
        //
        // It used to sit after the dirt and marker probes, on the reasoning
        // that work done BEFORE the final `rev-parse` re-read costs nothing.
        // That reasoning holds for HEAD alone, which IS re-read afterwards —
        // and fails for the other two, which are not: a `loopEconomy()` call
        // is up to 120s of elapsed time in which an uncommitted edit or a
        // fresh MERGE_HEAD can appear without moving HEAD, leaving the final
        // re-read satisfied and the drive exiting 0 over leftovers it had
        // certified two minutes earlier.
        // Moving the call above all three restores the narrow window rather
        // than duplicating the probes on both sides of it.
        const economy = await loopEconomy(pr);

        // A `git status --porcelain` predicate — however hardened — answers
        // "is anything uncommitted", not "is a git operation still open":
        // resolving a conflict back to a tree that matches what was already
        // committed leaves `MERGE_HEAD` behind while porcelain status reports
        // empty. Checked
        // next, same as announce-merge-ready.ts's sibling check.
        const opTimeoutSec = gitCallTimeoutSeconds();
        const op = await unconcludedGitOpMarker(opTimeoutSec);
        if (!op.ok) {
          console.error(
            `review converged after ${passes} round(s), but the working tree is UNREADABLE —`,
          );
          console.error(
            "cannot certify the worktree is clean, so not exiting 0 over unknown leftovers.",
          );
          return WORKTREE_UNCLEAN_EXIT;
        }
        if (op.marker !== null) {
          console.error(
            `review converged after ${passes} round(s), but an unconcluded git operation is`,
          );
          console.error(
            `present (${op.marker}) — resolve or abort it (git merge/cherry-pick/revert`,
          );
          console.error("--abort), then re-run.");
          return WORKTREE_UNCLEAN_EXIT;
        }

        // `--untracked-files=normal` is explicit, not decorative: `--porcelain`
        // alone inherits `status.showUntrackedFiles` from repo or user config,
        // and `=no` there makes a plain `git status --porcelain` report an
        // untracked scratch file as a clean tree — silently certifying a
        // leftover as shipped (the same root cause as announce-merge-ready.ts's
        // sibling check). `--ignore-submodules=none` closes the same class one
        // level down: `submodule.<name>.ignore`/`.gitmodules` can set `ignore =
        // all` and hide modifications inside a tracked submodule regardless of
        // the untracked-files mode.
        const dirty = await git(
          [
            "status",
            "--porcelain",
            "--untracked-files=normal",
            "--ignore-submodules=none",
          ],
          {
            stderr: "ignore",
            timeoutSec: gitCallTimeoutSeconds(),
          },
        );
        if (dirty.code !== 0) {
          console.error(
            `review converged after ${passes} round(s), but the working tree is UNREADABLE —`,
          );
          console.error(
            "cannot certify the worktree is clean, so not exiting 0 over unknown leftovers.",
          );
          return WORKTREE_UNCLEAN_EXIT;
        }
        if (dirty.stdout !== "") {
          console.error(
            `review converged after ${passes} round(s), but this worktree still has uncommitted state:`,
          );
          process.stderr.write(dirty.stdout);
          console.error(
            "These edits shipped in no round — commit or discard them, then re-run.",
          );
          return WORKTREE_UNCLEAN_EXIT;
        }

        // Re-read local HEAD once more, immediately before reporting
        // converged. The check above narrows the window a commit can land in
        // undetected; it cannot close it, because the operation-marker and
        // status probes are themselves further elapsed time after that read
        // — a commit landing in that gap leaves `git status` reporting a
        // clean H2 while this branch was about to exit 0 for reviewed H1.
        // Same fix as announce-merge-ready.ts's sibling check.
        const finalHeadRes = await git(["rev-parse", "HEAD"], {
          stderr: "ignore",
          timeoutSec: headTimeoutSec,
        });
        if (finalHeadRes.code !== 0) {
          console.error(
            `review converged after ${passes} round(s), but the working tree is UNREADABLE —`,
          );
          console.error(
            "cannot certify the worktree is clean, so not exiting 0 over unknown leftovers.",
          );
          return WORKTREE_UNCLEAN_EXIT;
        }
        const finalHead = finalHeadRes.stdout.trim();
        if (finalHead !== reviewedHead) {
          console.error(
            `review converged after ${passes} round(s), but local HEAD is ${finalHead},`,
          );
          console.error(
            `while the reviewed head is ${reviewedHead || "<empty>"} — a commit landed`,
          );
          console.error(
            "here during this check that was never pushed or reviewed. Push it, or reset",
          );
          console.error("to the reviewed head, then re-run.");
          return WORKTREE_UNCLEAN_EXIT;
        }

        // Converged AND certified clean — but a drive that gets here while the
        // PR is still an UNMARKED DRAFT has not finished the job the transition
        // exists for. The in-house AI reviewer reviewed this head and had
        // nothing left to say; CodeRabbit never looked at it at all, and by
        // repo policy never will until someone marks the PR Ready. Returning 0
        // here would report "the review loop is done" about a PR whose external
        // review is pending by construction — the false-terminal shape this
        // skill exists to refuse, arrived at from the one direction the round
        // loop has no hook in, because a drive that converges on its first gate
        // never runs a pass and so never reaches the post-round transition
        // below.
        //
        // So: mark it Ready, then re-gate rather than returning. Bounded to ONE
        // extra iteration — `readyMarkedRound` is non-zero afterwards, so the
        // next CONVERGED falls straight through — and it is not a wait for
        // CodeRabbit, which this skill does not gate on either way.
        //
        // DELIBERATELY BEHIND the whole clean-worktree gate above, and the order
        // is the decision rather than an accident of the merge that put these
        // two together. `gh pr ready` fires `ready_for_review`, which spends the
        // external reviewer's one-pass-per-push budget on whatever head is
        // current at that instant. Over a dirty worktree — uncommitted leftovers,
        // an unconcluded merge, a local commit that outran the reviewed head —
        // that head is precisely the one about to change once the operator
        // resolves it, so marking first would spend the pass on a head nobody
        // intends to keep. That is the exact waste this transition exists to
        // avoid, so the drive earns the right to summon anyone only once it can
        // certify there is nothing left on the floor. Exit 12 therefore leaves
        // the PR a draft, and the retry after the operator cleans up marks it.
        // Gated on `--keep-draft` ALONE, not on `status.draft`. A draftness
        // gate here looks like an optimisation and is a hole: on an
        // ALREADY-Ready PR that converges before any pass runs, it skips
        // `mark-ready.ts` entirely, so `readyMarkedRound` stays 0 and this
        // drive keeps no record that it owed nothing. A human who later
        // converts that PR back to draft then meets the next drive reading 0,
        // seeing a draft, and marking it Ready again — undoing their decision,
        // which is the exact case the already-Ready recording path exists for
        // and the one place it was unreachable.
        //
        // `mark-ready.ts` is the right place for that decision anyway: it
        // reads the durable record first, and only then a live snapshot, so
        // the call costs one state read on every round after the first.
        //
        // NOT gated on `!keepDraft` ALONE: `--keep-draft` exists to suppress
        // the outward draft→Ready DISPATCH, not the harmless,
        // side-effect-free record of an already-Ready observation.
        // `status.draft === false` also runs this under `--keep-draft`, for
        // the same reason the pre-pass call does — skipping it left
        // `readyMarkedRound` at 0 for a PR this drive observed as already
        // Ready, so a later ordinary drive could not tell a deliberate
        // Ready→draft conversion from a never-marked draft.
        // `status.draft === true` still respects `--keep-draft`: that case is
        // the actual dispatch-capable call, which is exactly what the flag
        // exists to suppress.
        if (!keepDraft || status.draft === false) {
          // `--record-only` when THIS gate's own snapshot already saw the PR
          // as Ready — mirroring the
          // round-loop's pre-pass call: a call that CAN dispatch is exactly
          // what let an earlier version of this branch fire `gh pr ready` on
          // a PR the owner converted to draft in the window before this
          // call's own live re-read, reversing that decision. When
          // `status.draft` is `true` here, this call is precisely the one
          // meant to dispatch the actual draft→Ready transition, so it does
          // NOT get `--record-only`.
          const recordOnly = status.draft === false;
          const rc = await run(
            tsArgv(markReady, [
              pr,
              ...(recordOnly ? ["--record-only"] : []),
              "--reason",
              "converged with no round to run",
            ]),
            { stderr: "inherit", timeoutSec: markReadyTimeoutSeconds() },
          );
          // LIVENESS FIRST, and it wins over the convergence this branch was
          // about to report. Exit 5 means `mark-ready.ts` re-read the PR —
          // AFTER the gate did — and found it merged or closed. That is a
          // fresher observation of the same fact `drive-status.ts` reports as
          // PR_NOT_OPEN, so it propagates as PR_NOT_OPEN rather than falling
          // through into an exit 0 that would tell an operator to merge a PR
          // that is already gone.
          if (rc.code === 5) {
            console.error(
              `PR #${pr} stopped being open while the converged drive was marking it Ready`,
            );
            console.error(
              "  — reporting the newer observation, not the gate's.",
            );
            return 5;
          }
          // STOP rather than re-gate when the transition FAILED. Its lease is
          // released on failure, so looping back would converge, fail, release
          // and converge again — an unbounded spin on a step that does not get
          // better by itself. Exit 1 is what it is: an action this drive owed
          // and could not complete.
          if (rc.code !== 0) {
            console.error(
              `converged on PR #${pr}, but marking it Ready for review failed — stopping rather than`,
            );
            console.error(
              `  re-gating in a loop. Mark it by hand (gh pr ready ${pr}) and re-run the drive.`,
            );
            return 1;
          }
          const outcome = rc.stdout.trim();
          if (!MARK_READY_OUTCOMES.has(outcome)) {
            console.error(
              `converged on PR #${pr}, but mark-ready.ts reported exit 0 with an unrecognized`,
            );
            console.error(
              `  outcome ('${outcome}') — not one of ${[...MARK_READY_OUTCOMES].join(", ")}.`,
            );
            console.error(
              `  Treating this as unsettled rather than converged. Mark it by hand`,
            );
            console.error(`  (gh pr ready ${pr}), and re-run the drive.`);
            return 1;
          }
          // `marked`, `already-ready`, and `already-marked` ALL re-gate:
          // this call is itself the slow, awaited step in this branch — up
          // to `markReadyTimeoutSeconds()` of real elapsed time — and
          // another clone can push a new head while it runs. `mark-ready.ts`
          // only re-reads PR state and draftness, never `headRefOid`, so
          // declaring convergence straight off this call's outcome vouches
          // for the head the OUTER gate verified minutes ago, not the one
          // live now. `markedReadyThisRun` is set only for `marked` itself:
          // the other two dispatched nothing this run.
          if (outcome === "marked") {
            markedReadyThisRun = true;
            continue;
          }
          // `already-ready` / `already-marked` are STABLE answers — an
          // unmoved head gives the identical one on every re-ask — so unlike
          // `marked` (a real state transition, safe to re-gate on
          // unconditionally) this re-gate is bounded to ONCE. Case 3
          // (CONVERGED) never touches `passes`/`--max-rounds` the way case 0
          // does, so nothing else would stop a head that genuinely never
          // changes from re-entering this exact branch forever. One extra
          // gate call closes the TOCTOU window the re-gate exists for; a
          // second one on the SAME stable outcome would learn nothing further
          // and spin.
          if (
            (outcome === "already-ready" || outcome === "already-marked") &&
            !reGatedForStableMarkReadyOutcome
          ) {
            reGatedForStableMarkReadyOutcome = true;
            continue;
          }
          // `claimed-by-other` is NOT proof the transition completed — another
          // driver holds the lease and may still be in flight, or may die
          // holding it. It is not a
          // reason to spin here either: re-gating would find the same lease
          // and converge into the same branch.
          if (outcome === "claimed-by-other") {
            readyLeftToOtherDriver = true;
          }
          // `still-draft` (only reachable via `--record-only`) means the
          // owner converted the PR to draft in the window before this call's
          // own live read — nothing was recorded, and dispatching was
          // structurally impossible, so there is nothing more this call could
          // have done. Reported separately from `readyLeftToOtherDriver`: no
          // other driver is involved here.
          if (outcome === "still-draft") {
            readyFlippedToDraftBeforeRecord = true;
          }
        }

        // Neither a lease left to another driver NOR an unrecorded draft flip
        // is full convergence.
        // Returning exit 0 here claims "nothing left to do" and ends the
        // drive outright — for the lease case, a dead other-driver then
        // leaves the PR a draft forever with no external reviewer summoned
        // and nothing left to notice; for the draft-flip case, the PR is
        // genuinely a draft again by the owner's own deliberate action, and
        // this drive owes it nothing further right now.
        if (readyLeftToOtherDriver) {
          console.error(
            `converged against the reviewer after ${passes} round(s), but PR #${pr} is still a`,
          );
          console.error(
            "  draft and another driver holds the Ready-mark lease — not reporting full",
          );
          console.error(
            "  convergence. Whether the reviewers that skip drafts get summoned is that",
          );
          console.error(
            "  driver's call; if it died, the lease expires and a later drive takes the",
          );
          console.error("  transition over. Re-run the drive to retry.");
          // Exit 4 ("not yet judgeable"): genuinely retry-safe, since either
          // the other driver finishes the transition or its lease expires and
          // a later drive takes it over — nothing here needs a fresh look, an
          // unattended wrapper's plain retry is exactly the right response.
          return 4;
        }
        if (readyFlippedToDraftBeforeRecord) {
          console.error(
            `converged against the reviewer after ${passes} round(s), but PR #${pr} is still a`,
          );
          console.error(
            "  draft — the owner converted it back before this drive could record it was",
          );
          console.error(
            "  ever Ready. Not reporting full convergence, and NOT retrying automatically:",
          );
          console.error("  unlike the lease case above, nothing");
          console.error(
            "  durable was written here, so a blind retry that reaches this exact branch",
          );
          console.error(
            "  again would just repeat the race rather than resolve it. Re-run the drive",
          );
          console.error("  by hand to re-evaluate against the current state.");
          // Exit 1, not 4: an unattended wrapper's plain retry is the wrong
          // response to an observation that was never persisted anywhere —
          // this needs a fresh top-level look, not mechanical repetition.
          return 1;
        }

        // Intermediate synchronize pushes ran under the CI hold, when the
        // repository has one (`ci.hold_label`; without it `release` prints
        // `disabled` and nothing below waits on an unlabel). Release only
        // after convergence, the clean-tree certification, and the Ready
        // transition above have all settled. `ci-hold.ts` compares the
        // persisted labelled timeline-event id before removing anything, so a
        // human remove/re-add is never mistaken for a label this driver owns.
        const finalCiSignals = await finalCiWait.prime();
        const release = await run(
          tsArgv(ciHold, ["release", pr, "--expect-head", reviewedHead]),
          { stderr: "inherit", timeoutSec: ciHoldTimeoutSeconds() },
        );
        if (release.code === 5) return 5;
        if (release.code === 4) {
          console.error(
            "review converged, but the CI hold label is externally owned or the head moved; not removing it or reporting merge-ready",
          );
          return 4;
        }
        if (release.code !== 0) {
          console.error(
            `review converged, but releasing the CI hold label failed (exit ${release.code})`,
          );
          return 1;
        }
        if (release.stdout.trim() === "removed") {
          // The current status snapshot predates the `unlabeled` event. It may
          // still call old skipped runs green, so it cannot participate in the
          // final decision. Let GitHub schedule the unlabel-triggered workflows
          // and re-read all evidence from the top.
          console.error(
            "CI hold label removed; waiting for full CI on the converged head",
          );
          await sleep(UNLABEL_SETTLE_SECONDS);
          continue;
        }

        const finalCi = await span("ci.wait", {}, () =>
          run(
            tsArgv(ciHold, ["final-ready", pr, "--expect-head", reviewedHead]),
            { stderr: "inherit", timeoutSec: ciHoldTimeoutSeconds() },
          ),
        );
        if (finalCi.code === 5) return 5;
        // What used to stand here read `status.ci` — the PRE-UNLABEL
        // snapshot, which the comment forty lines above this one already
        // declares unusable for the final decision ("cannot participate") —
        // and retried on it. `final-ready` returns 4 for BOTH "the fresh
        // required check has not landed yet" and "it landed and is settled
        // red", because it does not distinguish them: a post-unlabel
        // `detect-changes` failure cascades `code-quality-and-build`/`tests`
        // into `skipped`, which `completedRequiredCi()` correctly refuses to
        // accept as fresh evidence. So a genuinely-red converged head slept
        // ten seconds and looped, forever, never reaching the fresh
        // `finalVerdict` branch below that would have decided it correctly.
        //
        // Exit 4 therefore no longer decides anything on its own. It FALLS
        // THROUGH to the fresh evidence, and only re-takes the wait once that
        // evidence has positively ruled out a failure — see the deferred
        // `finalCi.code === 4` check below `finalVerdict`.
        if (finalCi.code !== 0 && finalCi.code !== 4) {
          console.error(
            `could not establish final CI freshness (exit ${finalCi.code})`,
          );
          return 1;
        }
        // A fresh witness was just confirmed: `witnessWaits` is documented as
        // counting a CONSECUTIVE unwitnessed streak on one head, but used to
        // reset only on a head change. A same-head sequence — several `finalCi.code === 4`
        // polls, then `code === 0` while an unrelated non-required check is
        // still pending (the branch below loops on it), then a required
        // check rerun returns `code === 4` again — resumed the earlier
        // count instead of starting a fresh streak, so the bound could trip
        // well short of its configured duration. `finalCi.code === 0` at
        // this point means final-ready positively established a fresh
        // required witness, so the streak is broken here regardless of
        // which head it is on.
        if (finalCi.code === 0) {
          witnessWaits = 0;
        }
        const finalStatusRes = await run(
          tsArgv(driveStatus, [pr, "--json", "--once", "--no-count"]),
          { stderr: "inherit", timeoutSec: driveStatusOnceTimeoutSeconds() },
        );
        let finalStatus: Record<string, unknown> = {};
        try {
          finalStatus = JSON.parse(finalStatusRes.stdout) as Record<
            string,
            unknown
          >;
        } catch {
          finalStatus = {};
        }
        const finalVerdict = String(finalStatus.ci ?? "");
        // The STRUCTURED counterpart to `finalVerdict`: `finalVerdict` is a
        // rendered, delimiter-joined string, so re-splitting it on `,`/`;`
        // cannot round-trip a check name that itself contains either
        // character. `Array.isArray` here is the same defensive read every
        // other array field off this JSON boundary uses (see
        // `roundFingerprint` above) — an absent or malformed field degrades
        // to `null`, never to a guessed `[]` that would silently read as
        // "nothing failing".
        const finalFailingNamesRaw = finalStatus.failingCheckNames;
        const finalFailingNames = Array.isArray(finalFailingNamesRaw)
          ? finalFailingNamesRaw.filter(
              (name): name is string => typeof name === "string",
            )
          : null;
        // The CHECK-RUN-ONLY subset:
        // `completedRequiredCi()` (ci-hold.ts) establishes freshness from
        // check-runs alone — it has no notion of a commit status at all — so
        // the ambiguity `finalCi.code === 4` encodes can only ever apply to a
        // name in THIS array. `finalFailingNames` above merges in legacy
        // commit-status contexts with no provenance, so testing a required
        // name against IT ALONE would let a genuinely fresh, currently
        // failing legacy status context that happens to share a required
        // check's name be misclassified as merely "possibly stale" below.
        const finalFailingCheckRunNamesRaw = finalStatus.failingCheckRunNames;
        const finalFailingCheckRunNames = Array.isArray(
          finalFailingCheckRunNamesRaw,
        )
          ? finalFailingCheckRunNamesRaw.filter(
              (name): name is string => typeof name === "string",
            )
          : null;
        // The COMMIT-STATUS-ONLY complement: `finalFailingNames` merges
        // check-run and commit-status names with no per-entry provenance, so
        // a required name that fails in BOTH sources under the identical
        // name — e.g. a check-run named `Schema gate` whose freshness
        // `finalCi.code === 4` cannot confirm, alongside a legacy commit
        // status ALSO named `Schema gate` that is unambiguously fresh —
        // would satisfy `finalFailingCheckRunNames.includes(name)` for every
        // merged occurrence of that name, including the status-sourced one,
        // and read as wholly stale. Only a name ABSENT from this array
        // can safely be treated as purely check-run-sourced.
        const finalFailingStatusNamesRaw = finalStatus.failingStatusNames;
        const finalFailingStatusNames = Array.isArray(
          finalFailingStatusNamesRaw,
        )
          ? finalFailingStatusNamesRaw.filter(
              (name): name is string => typeof name === "string",
            )
          : null;
        const finalRemoteHead = String(
          (finalStatus.head as Record<string, unknown> | undefined)?.api ?? "",
        );
        if (finalRemoteHead !== reviewedHead) {
          console.error(
            "review/head evidence changed while final CI freshness was established; re-gating",
          );
          continue;
        }
        // MUST be checked before interpreting or repairing the CI verdict
        // below: a live finding can land between the original convergence
        // decision and this re-read, which flips `finalStatus.state` off
        // `CONVERGED` while CI is still red from the held period. Checking
        // this only at the bottom of the verdict-handling chain (as before)
        // let a `failing:` verdict dispatch a `ci-repair` pass — whose
        // documented contract skips triage — over a head that actually has a
        // fresh, untriaged finding on it, leaving that finding unanswered.
        if (finalStatusRes.code !== 3 || finalStatus.state !== "CONVERGED") {
          console.error(
            "review evidence changed while final CI freshness was established; re-gating",
          );
          continue;
        }
        // Only the CONFIRMED-fresh case takes this short, unbounded poll:
        // `finalCi.code === 4` means final-ready could not yet witness a
        // fresh, completed REQUIRED check, and a `pending:` verdict under
        // that code is exactly the ambiguous state the bounded witness-wait
        // below exists for — a required check that never leaves
        // queued/in-progress must still trip
        // `DRIVE_PR_FINAL_CI_WITNESS_POLLS`, the same as a `skipped` one
        // does. Falling through here (rather than looping forever on this
        // branch) is what lets it reach that bound. `finalCi.code === 0`
        // means a fresh required witness already exists, so a `pending:`
        // verdict there names only an unrelated, non-required check still
        // running — genuinely unbounded polling is correct for that case,
        // unchanged.
        if (finalVerdict.startsWith("pending:") && finalCi.code !== 4) {
          console.error(
            `review converged; waiting for exact-head full CI (current verdict: ${finalVerdict})`,
          );
          finalCiWait.remember(reviewedHead, finalCiSignals, false);
          await sleep(FINAL_CI_POLL_SECONDS);
          continue;
        }
        // A REQUIRED check: `finalStatus.ci` is `ciVerdictOf()`'s "latest run
        // per check name", with no notion of the unlabel-event watermark
        // `final-ready` itself applies. Right after `ci:hold` is removed —
        // before any post-unlabel run has even STARTED — the newest run on
        // record for a required check can still be its deliberately-red
        // held-period one, and this would read that as a fresh `failing:`
        // verdict. `finalCi.code === 4` is exactly "final-ready could not
        // positively confirm freshness", which includes this case, so a
        // required check named in the verdict under that code is not yet
        // trustworthy either way — fall through to the SAME bounded
        // witness-wait below rather than repairing a
        // possibly-imaginary failure or stopping the drive over one. A
        // NON-required check in the same verdict (a `detect-changes` failure
        // cascading its dependents into `skipped`, the typical
        // case) carries no such ambiguity — final-ready says nothing
        // about it either way — so it is trusted immediately, unchanged.
        //
        // "The verdict is stale" therefore has to mean EVERY failing name is
        // a required one — `.every()`, not `.some()`. A `.some` would
        // treat a MIXED verdict (a stale required check alongside a
        // genuinely fresh non-required one, e.g. `failing: Schema gate,
        // detect-changes`) as wholly unreliable the moment any required name
        // appears in it, deferring the actionable non-required failure to
        // the witness wait right along with the ambiguous one — exactly the
        // case the comment above says must be trusted immediately. `length >
        // 0` guards the vacuous-truth trap: `.every()` on an empty array is
        // `true`, which would wrongly mark a verdict with no failing names
        // at all as "stale".
        //
        // Read from `failingCheckNames` — the structured array `evaluate.ts`
        // now publishes alongside the rendered `ci` string — never by
        // re-splitting `finalVerdict` on `,`/`;`: a failing check whose own
        // name contains either delimiter cannot round-trip through that
        // split, so a fragment of it could coincidentally match a required
        // name exactly.
        //
        // Every entry must ALSO be present in `finalFailingCheckRunNames`:
        // membership in the required checks alone is a name test, blind to
        // whether the entry came from a check-run or a legacy commit status,
        // but `finalCi.code === 4`'s ambiguity is a check-run-freshness fact
        // only — `completedRequiredCi()` never reads a commit status. A
        // required name failing ONLY as a commit status (absent from the
        // check-run list) is therefore not stale-by-ambiguity at all, and
        // must not satisfy this predicate.
        //
        // And it must ALSO be ABSENT from `finalFailingStatusNames`: the
        // check above tests membership BY NAME, blind to provenance, so a
        // required name failing as BOTH a check-run AND a legacy commit
        // status under the identical name would otherwise satisfy it for
        // every merged occurrence — including the status-sourced one, which
        // carries no freshness ambiguity at all and must be treated as an
        // actionable failure regardless of what the check-run side is doing.
        let requiredChecks: readonly string[];
        try {
          requiredChecks = (await ciPolicy(pr)).requiredChecks;
        } catch (error) {
          console.error(
            `could not read the required checks: ${error instanceof Error ? error.message : String(error)}`,
          );
          return 1;
        }
        const staleRequiredFailure =
          finalCi.code === 4 &&
          finalFailingNames !== null &&
          finalFailingCheckRunNames !== null &&
          finalFailingStatusNames !== null &&
          finalFailingNames.length > 0 &&
          finalFailingNames.every(
            (name) =>
              requiredChecks.includes(name) &&
              finalFailingCheckRunNames.includes(name) &&
              !finalFailingStatusNames.includes(name),
          );
        // POSITIVELY-NAMED failing checks, not merely "not green".
        // `unknown:` (commit statuses unreadable) and `''` (the status report
        // did not parse) are absences of evidence, not evidence of failure,
        // and a `/fix-ci` pass handed neither a run nor a check name has
        // nothing to work from. Those keep today's stop verbatim, below.
        if (
          finalVerdict.startsWith("failing:") &&
          !staleRequiredFailure &&
          ciRepairs < ciRepairBudget
        ) {
          const failing = finalVerdict.slice("failing:".length).trim();
          if (dryRun || agent.length === 0) {
            console.error(
              `(dry-run) would run a CI-repair pass for: ${failing || "<unnamed checks>"}`,
            );
            return 1;
          }
          const mailboxBeforeCiRepair = await mailboxCheckpoint();
          if (typeof mailboxBeforeCiRepair === "number")
            return mailboxBeforeCiRepair;
          if (mailboxBeforeCiRepair === "resumed") continue;
          console.error(
            `review converged, but the fresh non-reviewer CI verdict is '${finalVerdict}'.`,
          );
          console.error(
            // A peek, not a charge — `ciRepairs` is committed only once
            // `runRepairPass` confirms it actually dispatched, below: an
            // earlier revision charged before the call and refunded on an
            // abort path, which is exactly the charge-then-compensate shape
            // whose ABA gap this class of finding kept re-finding on the
            // durable `attempts` counter.
            // "Never charge until certain" needs no compensating action at
            // all — this line only has to DISPLAY the attempt number the
            // dispatch below, if it happens, will actually become.
            `  Running CI-repair pass ${ciRepairs + 1}/${ciRepairBudget} (DRIVE_PR_CI_REPAIR_ROUNDS=${ciRepairBudget}; 0 stops here instead).`,
          );
          const repair = await runRepairPass(
            agent,
            held,
            "ci-repair",
            failing,
            mailboxCheckpoint,
          );
          if (!repair.dispatched) {
            // The repair pass's OWN pre-spawn checkpoint (inside
            // runRepairPass, after its identity refresh) resumed a pause
            // without ever dispatching — re-gate from the top rather than
            // trusting this branch's now-stale snapshot.
            // Nothing to refund: `ciRepairs` was never charged for this
            // attempt in the first place.
            if (repair.resumed) continue;
            // Same checkpoint reporting stop/pause-timeout/unreadable/a lock
            // takeover: those are driver-ending answers, not repair-pass
            // failures, so return them as-is rather than falling into the
            // generic "pass failed" branch below.
            return repair.code;
          }
          // Confirmed dispatch — NOW commit the charge.
          ciRepairs += 1;
          const repairCode = repair.code;
          if (compromised !== "") {
            // Checked before `postPassMailboxExit` — a lock takeover means
            // this driver has already lost authority over the PR, which
            // outranks any exit code the mailbox checkpoint might report.
            // Re-join the SAME witness the ordinary-pass path joins on its
            // own `compromised` branch: the takeover stopped this repair
            // pass from a TIMER callback, which could not wait, so
            // `passStopWitness` is the only place that wait is still live.
            // Clearing `held` on an unwitnessed termination is what keeps
            // the loop-top `compromised` check below from releasing a lock
            // over a repair descendant that may still be running.
            if (passStopWitness !== null && !(await passStopWitness)) {
              held.length = 0;
            }
            continue;
          }
          // A directive observed immediately after this pass completed —
          // outranks reporting the pass's own result, same as the
          // ordinary-pass path's own post-pass checkpoint. The charge above
          // already stands: the pass DID run.
          if (repair.postPassMailboxExit !== null)
            return repair.postPassMailboxExit;
          // Preserve PR_NOT_OPEN: `guarded-push.ts` exits 5 inside the pass
          // exactly like the ordinary-pass path's own push does, and
          // reporting a CI stop over a PR that already merged or closed sends
          // an operator to fix code nobody can push to anymore —
          // `passExitDisposition` exists to prevent exactly this for the
          // ordinary path, so the repair path must not silently drop the same
          // signal.
          if (repairCode === 5) {
            console.error(
              `PR #${pr} stopped being open during the CI-repair pass; stopping.`,
            );
            return 5;
          }
          if (repairCode !== 0) {
            console.error(
              "the CI-repair pass failed; stopping for /fix-ci by hand.",
            );
            return 1;
          }
          // Re-gate rather than re-check CI here. A repair that pushed moved
          // the head, which makes `reviewedHead` — and every piece of
          // evidence gathered under it, including the reviewer's own stamp —
          // stale. The top of the loop is the only place entitled to rebuild
          // all of it. A repair that pushed NOTHING lands back on this same
          // branch with the same verdict and spends the next unit of budget,
          // which is what the budget is for.
          continue;
        }
        // A `pending:` verdict is never a stop condition: it reaches here
        // only when `finalCi.code === 4` (the branch above let it through
        // deliberately), and it names a required check still
        // queued/in-progress, not a failure — the witness-wait branch just
        // below is what bounds the wait on it.
        const finalVerdictPending = finalVerdict.startsWith("pending:");
        if (
          finalVerdict !== "green" &&
          !staleRequiredFailure &&
          !finalVerdictPending
        ) {
          console.error(
            `review converged and the required checks ran, but the fresh non-reviewer CI verdict is '${finalVerdict || "unknown"}'; stopping for /fix-ci`,
          );
          if (finalVerdict.startsWith("failing:") && ciRepairBudget > 0) {
            console.error(
              `  (${ciRepairs} CI-repair pass(es) already run — the budget is spent.)`,
            );
          }
          return 1;
        }
        // DEFERRED from above (widened by the required-check handling
        // above): either the aggregate verdict is green with nothing
        // failing, or it names only a REQUIRED check whose freshness this
        // same `finalCi.code === 4` already couldn't confirm — and either
        // way, `final-ready` could not witness a fresh, completed,
        // successful REQUIRED check on this exact head. That is the genuine
        // "the unlabel-triggered run has not landed yet" wait the old exit-4
        // branch was trying to express — reached now only once the fresh
        // evidence has positively ruled out a NON-required failure, rather
        // than standing in front of it.
        //
        // BOUNDED, unlike the branch it replaces. There is one state this
        // wait cannot escape on its own: a required check whose fresh run
        // completed `skipped` is PASSING to the aggregate verdict
        // (`PASSING_CONCLUSIONS` in `lib/status/evidence.ts` — deliberately,
        // a skipped job is not a failure) and NOT a witness to
        // `completedRequiredCi`, which wants a success. Nothing later turns a
        // skipped run into a successful one, so the two disagree forever and
        // the loop sleeps forever. The typical shape is a `detect-changes`
        // failure cascading its dependents into `skipped`; its RED half is
        // handled above by the fall-through, and this is the other
        // half, where nothing NON-required is red and there is
        // still no witness (a required check's OWN staleness is the other
        // way this can arrive here, per `staleRequiredFailure` above).
        //
        // Exit `4`, not a terminal code: the state is genuinely "not
        // judgeable yet", it is retry-safe, and an unattended wrapper's plain
        // re-run is the right response — a later drive re-reads CI from
        // scratch and may well find a witness a rerun produced. The bound is
        // generous (30 minutes by default) because a legitimately slow
        // unlabel-triggered run must never reach it.
        if (finalCi.code === 4) {
          // CONSECUTIVE ON ONE HEAD, not cumulative across the drive. A long
          // drive can legitimately reach this wait on several different heads
          // — once per convergence attempt — and a counter that never reset
          // would spend the budget a few polls at a time and then trip on a
          // later head that had barely waited at all. Keying the reset to the
          // head is what makes the bound mean "this head has been unwitnessed
          // for 30 minutes", which is the claim the give-up message makes.
          if (reviewedHead !== witnessWaitHead) {
            witnessWaitHead = reviewedHead;
            witnessWaits = 0;
          }
          witnessWaits += 1;
          // `0` means "wait forever", the older behaviour — so the
          // bound is checked only when one was actually asked for. Without
          // this guard `0` would read as the TIGHTEST possible bound and stop
          // on the first poll, inverting the knob.
          if (witnessWaitLimit > 0 && witnessWaits > witnessWaitLimit) {
            console.error(
              staleRequiredFailure
                ? `review converged, but the only failing check(s) reported ('${finalVerdict}') are required checks final-ready could not confirm are fresh, and no fresh exact-head witness appeared in ${Math.round((witnessWaitLimit * FINAL_CI_POLL_SECONDS) / 60)} minute(s).`
                : finalVerdictPending
                  ? `review converged, but the verdict has stayed '${finalVerdict}' with no fresh exact-head required-check witness for ${Math.round((witnessWaitLimit * FINAL_CI_POLL_SECONDS) / 60)} minute(s).`
                  : `review converged and nothing is failing, but no fresh exact-head required-check witness appeared in ${Math.round((witnessWaitLimit * FINAL_CI_POLL_SECONDS) / 60)} minute(s).`,
            );
            console.error(
              "  A required check whose fresh run completed SKIPPED reads as passing to the aggregate",
            );
            console.error(
              "  verdict and as no witness at all here, and nothing later turns it into a success —",
            );
            console.error(
              "  so this can never resolve by waiting. Re-run the required checks on this head",
            );
            console.error(
              `  (a fresh run, NOT 'gh run rerun' of the old one — that replays the original payload),`,
            );
            console.error(
              `  then re-arm. ($DRIVE_PR_FINAL_CI_WITNESS_POLLS=${witnessWaitLimit}; 0 waits forever, as before.)`,
            );
            return 4;
          }
          console.error(
            staleRequiredFailure
              ? `review converged; waiting for a fresh exact-head required-check witness (current verdict '${finalVerdict}' names only a required check final-ready has not yet confirmed fresh)`
              : finalVerdictPending
                ? `review converged; waiting for a fresh exact-head required-check witness (current verdict '${finalVerdict}')`
                : "review converged; waiting for a fresh exact-head required-check witness (aggregate verdict is green)",
          );
          finalCiWait.remember(reviewedHead, finalCiSignals, true);
          await sleep(FINAL_CI_POLL_SECONDS);
          continue;
        }

        const verified = await run(
          tsArgv(driveState, ["set-verified", pr, "--sha", reviewedHead]),
          { stderr: "inherit", timeoutSec: finalVerifyTimeoutSeconds() },
        );
        if (verified.code === 5) return 5;
        if (verified.code === 4) {
          console.error(
            "final verification became stale while it was recorded; re-gating",
          );
          continue;
        }
        if (verified.code !== 0) {
          console.error(
            `recording the final green-verified SHA failed (exit ${verified.code})`,
          );
          return 1;
        }

        if (!(await certifyFinalWorktree(reviewedHead, passes)))
          return WORKTREE_UNCLEAN_EXIT;

        const mailboxBeforeConvergence = await mailboxCheckpoint();
        if (typeof mailboxBeforeConvergence === "number")
          return mailboxBeforeConvergence;
        if (mailboxBeforeConvergence === "resumed") continue;

        console.error(`converged after ${passes} round(s) in this run`);
        if (markedReadyThisRun) {
          console.error(
            `  NOTE: this drive marked PR #${pr} Ready for review, which is what summons the`,
          );
          console.error(
            "  reviewers that skip drafts (CodeRabbit). Convergence here is against",
          );
          console.error(
            `  ${reviewerLabel()} only — anything they post lands after this drive ends, so re-run it.`,
          );
        }
        // Printing only — no I/O, so the re-read above is still the last thing
        // that could have changed this branch's answer.
        process.stderr.write(economy);
        return 0;
      }
      case 8: {
        // Deliberately terminal. Re-arming here is a measured failure: the loop
        // wakes, re-reads the same undeferrable threads, learns nothing it may
        // act on, and burns turns until something external stops it.
        console.error(
          "HITL-parked — the decisions below need a human; not re-arming.",
        );
        const get = await run(tsArgv(driveState, ["get", pr]), {
          stderr: "ignore",
        });
        try {
          const state = JSON.parse(get.stdout) as {
            parked?: Array<{ kind: string; key: string; reason: string }>;
          };
          for (const p of state.parked ?? []) {
            console.error(`  [${p.kind}] ${p.key}\n    ${p.reason}`);
          }
        } catch {
          // best-effort listing, like the bash `|| true`
        }
        // A park is a finished drive too, and the one whose cost a human is
        // about to weigh by hand — so it gets the same economy block the
        // converged and exhausted exits do.
        process.stderr.write(await loopEconomy(pr));
        return 8;
      }
      case 9: {
        // Deliberately NOT flattened into the generic propagation below. A
        // conflict is the one stop-state whose fix is a concrete git command
        // rather than a decision, and the whole failure this exists to end is
        // an operator being told "waiting for the reviewer" about a PR that
        // needs a merge. Name the fix.
        //
        // It is no longer terminal ON ARRIVAL, though. The earlier
        // reasoning here ("drive-status.ts only emits this state when the work
        // enumeration is EMPTY, so there is nothing for a triage pass to do
        // with it") conflated TRIAGE with the PASS. There is nothing to
        // triage, and there is plenty to do: merge the base, resolve, run the
        // round's validation plan, push — which `base-sync.ts`'s own exit-9
        // row already spells out for a pass to follow. The tell was the
        // asymmetry: a conflict that still HAS findings arrives as
        // ROUND_READY (the live reviewer is a poller and reviews conflicting
        // heads) and that same merge happens inside the round. Only the
        // no-work case was handed back, and only because no triage came with
        // it.
        //
        // So: spend the conflict-repair budget first, and fall through to the
        // original stop — message unchanged — once it is gone.
        //
        // Read the base name out of the STATUS REPORT drive-status.ts already
        // fetched, rather than a second, ungated `gh pr view` call. Two
        // problems with that second call: it carries no deadline of its own,
        // so a stalled connection could keep this script from ever emitting
        // the fix and exiting 9 — the one thing this branch exists to
        // guarantee; and a failed/timed-out read silently fell back to a
        // guessed default, handing an operator a concrete `git merge` command
        // for the WRONG branch on a release or stacked PR.
        // Reusing the report needs no network call at all, so there is
        // nothing left to fail.
        const base = String(
          (status.base as Record<string, unknown> | undefined)?.refName ?? "",
        );
        const conflictBudget = conflictRepairRounds();
        if (
          conflictRepairs < conflictBudget &&
          // An unreadable base name does NOT spend repair budget — the same
          // fail-closed rule the CI side applies to a verdict naming no
          // failing check. This branch exists precisely because guessing
          // `develop` handed an operator a concrete, wrong command on a
          // release or stacked PR; dispatching a pass with an empty base
          // would make the same guess one level further away, where the
          // operator cannot see it being made.
          base !== ""
        ) {
          if (dryRun || agent.length === 0) {
            console.error(
              `(dry-run) would run a conflict-resolution pass against origin/${base}`,
            );
            return 9;
          }
          const mailboxBeforeConflictRepair = await mailboxCheckpoint();
          if (typeof mailboxBeforeConflictRepair === "number")
            return mailboxBeforeConflictRepair;
          if (mailboxBeforeConflictRepair === "resumed") continue;
          console.error(
            `PR #${pr} conflicts with its base and has nothing left to work.`,
          );
          console.error(reasonLine);
          console.error(
            // A peek, not a charge — see the CI-repair call site's own
            // comment for why.
            `  Running conflict-resolution pass ${conflictRepairs + 1}/${conflictBudget} (DRIVE_PR_CONFLICT_REPAIR_ROUNDS=${conflictBudget}; 0 stops here instead).`,
          );
          const resolve = await runRepairPass(
            agent,
            held,
            "conflict-resolve",
            base,
            mailboxCheckpoint,
          );
          // Same mailbox handling as the CI-repair call site above — see its
          // own comments for why.
          if (!resolve.dispatched) {
            if (resolve.resumed) continue;
            return resolve.code;
          }
          // Confirmed dispatch — NOW commit the charge.
          conflictRepairs += 1;
          const resolveCode = resolve.code;
          if (compromised !== "") {
            // Same re-join as the CI-repair call site above — see its own
            // comment for why.
            if (passStopWitness !== null && !(await passStopWitness)) {
              held.length = 0;
            }
            continue;
          }
          // Same post-pass mailbox precedence as the CI-repair call site
          // above — see its own comment for why.
          if (resolve.postPassMailboxExit !== null)
            return resolve.postPassMailboxExit;
          // Same PR_NOT_OPEN preservation as the CI-repair call site above —
          // see its own comment for why.
          if (resolveCode === 5) {
            console.error(
              `PR #${pr} stopped being open during the conflict-resolution pass; stopping.`,
            );
            return 5;
          }
          if (resolveCode === 0) continue;
          console.error(
            "the conflict-resolution pass failed; stopping with the manual fix below.",
          );
        }
        console.error(
          `PR #${pr} conflicts with its base and has nothing left to work — stopping.`,
        );
        console.error(reasonLine);
        if (base !== "") {
          console.error(
            `  Fix: git fetch origin && git merge origin/${base}, resolve, run the gates, push.`,
          );
        } else {
          console.error(
            "  Fix: merge this PR’s base branch in, resolve, run the gates, push. (base branch name unavailable from the status report — check the PR directly rather than guessing one)",
          );
        }
        return 9;
      }
      // There is no `case 10`. It was `PR_IS_DRAFT`, terminal and un-re-armed
      // on the premise that no reviewer arm looks at a draft; the in-house AI
      // reviewer reviews drafts (measured — see mark-ready.ts), so a drive on
      // one now proceeds and marks it Ready itself at the round
      // `pull_requests.mark_ready` declares.
      // The CODE stays retired rather than being recycled for something else:
      // an operator reading `10` out of an old log or a wrapper script should
      // find nothing rather than a different meaning.
      case 0:
        break;
      default:
        // 1 / 4 / 5 / 7 / 13 all propagate verbatim. Note that 5 (PR merged
        // or closed) lands HERE, before the pass runs — the loop never hands
        // work to an agent that would push it onto an orphaned branch. 13
        // (another working tree is driving this PR) lands here for
        // the same reason and wants the same treatment: stop before the pass,
        // rather than become the second resolver.
        //
        // This check alone is NOT the merged-mid-loop guarantee, though: the
        // pass that runs below validates, commits and pushes, and the PR can
        // merge at any point during it. A liveness check taken before a
        // multi-minute pass says nothing about the moment of the push. That
        // is why the push itself must go through `guarded-push.ts`, which
        // re-checks immediately before pushing — see SKILL.md § 6. This check
        // keeps the loop from *starting* work it cannot land; guarded-push.ts
        // keeps it from *finishing* one.
        return code;
    }

    // The stall check runs HERE — after the gate said ROUND_READY, before this
    // gate spends anything (the pre-pass Ready record, the durable attempt
    // bump, the pass itself). The first iteration has no previous fingerprint,
    // and the only way back to this point is a completed pass, so an unchanged
    // fingerprint always indicts the pass that just ran. An unmeasurable gate
    // (null fingerprint) resets the streak rather than extending it — the
    // detector may only ever stop on positive evidence of sameness; anything
    // less falls through to the --max-rounds bound exactly as before.
    const fingerprint = roundFingerprint(status);
    noopRounds = advanceStallStreak(prevFingerprint, fingerprint, noopRounds);
    prevFingerprint = fingerprint;
    if (stallRounds > 0 && noopRounds >= stallRounds) {
      const work = (status.work ?? {}) as Record<string, unknown>;
      // A count can be null per-field while the fingerprint still matched on
      // the other one; "?" reads as "unmeasured", which is what null means.
      const count = (v: unknown) => (typeof v === "number" ? String(v) : "?");
      const apiHeadShort = String(
        (status.head as Record<string, unknown> | undefined)?.api ?? "",
      ).slice(0, 12);
      console.error(
        `the last ${noopRounds} completed pass(es) on PR #${pr} changed NOTHING this loop can observe:`,
      );
      console.error(
        `  head ${apiHeadShort} unmoved, ${count(work.unresolvedThreads)} unresolved thread(s) and`,
      );
      console.error(
        `  ${count(work.summaryUnaddressed)} unaddressed summary finding(s), with ${count(work.parkedThreads)} thread(s)`,
      );
      console.error(
        `  and ${count(work.parkedSummaryFindings)} summary finding(s) parked — identical before and after.`,
      );
      console.error(
        "  The SAME thread ids and finding fingerprints, not merely the same totals —",
      );
      console.error(
        "  nothing was resolved, addressed, parked or replaced, and local HEAD did not",
      );
      console.error(
        "  move. A pass that exits 0 without acting — e.g. one that stood down after",
      );
      console.error(
        "  mistaking its own parent driver for a competing drive —",
      );
      console.error(
        `  looks exactly like this. Stopping rather than spending the rest of --max-rounds (${maxRoundsN})`,
      );
      console.error(
        "  on no-ops. Read the pass output above for what it decided, fix why it did",
      );
      console.error(
        `  not act, then re-arm. ($DRIVE_PR_STALL_ROUNDS=${stallRounds}; 0 disables this stop.)`,
      );
      // WHY it stopped is above; WHAT it left behind is here. A pass can make
      // substantive, correct edits and still trip this stop by standing down
      // before committing them — the stall predicate keys on what the loop can
      // observe (head, threads, findings), and an uncommitted edit moves none
      // of those. So the two reports are independent, and the one an operator
      // acts on FIRST is this one.
      //
      // EXECUTE `loopEconomy()` before `leftoverReport()` even though it is
      // PRINTED after it — the same reordering the CONVERGED path already
      // uses, for the same reason: `loopEconomy()` is up to 120s of network
      // work, and an edit landing in that window would make a report that
      // already ran and printed "clean" false by the time this function
      // actually returns.
      // Certifying the worktree LAST, right before the exit, is what keeps
      // that window as narrow as it can be.
      const economyReport = await loopEconomy(pr);
      process.stderr.write(await leftoverReport());
      process.stderr.write(economyReport);
      return STALLED_EXIT;
    }

    // A PR that is ALREADY Ready when this round starts needs the same
    // durable "nothing owed" record the post-round call gives it — but
    // recorded NOW, before the pass runs.
    // Without it, `readyMarkedRound` stays 0 for the whole pass, which can run
    // several minutes; if the owner converts the PR back to draft while it is
    // running, the post-round call below sees `readyMarkedRound === 0` PLUS
    // the now-draft flag and fires `gh pr ready`, reversing a decision this
    // whole mechanism exists not to undo.
    //
    // `--record-only` — this call may NEVER fire `gh pr ready` itself.
    // Without it, this call uses the GENERAL mark-ready.ts path, which — if
    // the owner converts the PR back to draft in the window between
    // drive-status.ts's read above and mark-ready.ts's OWN live re-read —
    // would see a draft and immediately dispatch the transition itself,
    // undoing the very decision this pre-pass record exists to protect.
    // `--record-only` makes that structurally impossible: it can only record
    // an already-Ready observation or report `still-draft` with no side
    // effect, never claim the lease or call `gh pr ready`. It does not touch
    // the "not at the start" ordering documented at the post-round call
    // below, which is about spending CodeRabbit's one pass on a cleaned-up
    // head, a different concern.
    //
    // NOT gated on `!keepDraft`:
    // `--keep-draft` exists to suppress the outward draft→Ready DISPATCH,
    // which this call structurally cannot perform. Skipping it under
    // `--keep-draft` left `readyMarkedRound` at 0 for a PR this drive
    // observed as already Ready, so a LATER ordinary (non-`--keep-draft`)
    // drive — after a human converts that PR to draft — could not tell a
    // deliberate Ready→draft conversion from a PR that was simply never
    // marked, and would fire `gh pr ready` on it.
    if (status.draft === false) {
      const rc = await run(
        tsArgv(markReady, [
          pr,
          "--record-only",
          "--reason",
          "already Ready at round start",
        ]),
        { stderr: "inherit", timeoutSec: markReadyTimeoutSeconds() },
      );
      if (rc.code === 5) {
        console.error(
          `PR #${pr} stopped being open while recording its already-Ready state; stopping`,
        );
        return 5;
      }
      const outcome = rc.code === 0 ? rc.stdout.trim() : null;
      // REQUIRE CONFIRMATION before the pass starts, rather than proceeding
      // on an unconfirmed result: this
      // record is the ONLY thing that closes the mid-pass draft-flip race, so
      // continuing hopefully on a failed or malformed record reopens exactly
      // that race for the whole (possibly multi-minute) pass about to run.
      //
      // `claimed-by-other` and `still-draft` are BOTH deliberately NOT
      // sufficient confirmation,
      // even though both are recognized, exit-0 outcomes: neither writes a
      // durable record.
      //
      // `claimed-by-other` means another driver holds the lease and may
      // record it, or may die holding it — proceeding on that basis reopens
      // the mid-pass draft-flip race this call exists to close.
      //
      // `still-draft` was wrongly treated as sufficient in an earlier version
      // of this fix, on the reasoning that "the race window already closed
      // before this read" — that reasoning had a hole: the PR was Ready at
      // `status.draft === false` above (the guard for even calling this),
      // and if the owner converted it to draft in the window before this
      // call's own read, `--record-only` sees the draft and correctly
      // records NOTHING — but that leaves no evidence anywhere that this was
      // a Ready→draft conversion rather than an ordinary never-marked draft.
      // The pass then runs, and the post-round call sees
      // `readyMarkedRound === 0` plus `isDraft === true` — indistinguishable
      // from a PR that was simply always a draft — and fires `gh pr ready`,
      // undoing the very conversion this whole mechanism exists to respect.
      if (
        outcome === null ||
        !MARK_READY_OUTCOMES.has(outcome) ||
        outcome === "claimed-by-other" ||
        outcome === "still-draft"
      ) {
        console.error(
          `could not confirm PR #${pr}'s already-Ready state before this round's pass`,
        );
        console.error(
          `  (exit ${rc.code}${outcome === null ? "" : `, outcome '${outcome}'`}) — stopping rather than`,
        );
        console.error(
          "  running the pass unprotected against a mid-pass draft flip. Re-run the drive.",
        );
        return 1;
      }
    }

    const mailboxBeforePass = await mailboxCheckpoint();
    if (typeof mailboxBeforePass === "number") return mailboxBeforePass;
    if (mailboxBeforePass === "resumed") continue;

    // `passes` itself is incremented only at the actual dispatch point,
    // several awaits below — not here: this is one round-boundary checkpoint
    // among several before the pass is certain to run, and counting here
    // would double-count against the late increment.
    // A round boundary is a cheap extra renewal, not the mechanism: the timer
    // started above is what keeps the claim fresh through a long pass. Nothing
    // else distinguishes this driver from a stranger that inherited its pid
    // after it died, and a lock that stops being refreshed is what lets a
    // later start recover one.
    for (const lock of held) touchLock(lock);
    // drive-status.ts bumped the durable round count for this head on its way
    // to exit 0, so read it back rather than deriving it; the durable
    // per-head attempt count is bumped here, because a pass is this loop's
    // event, not the status check's. Both reads are hard — a state file this
    // loop cannot read is a loop with no bound, and continuing on a default
    // is the fail-open.
    const apiHead = String(
      (status.head as Record<string, unknown> | undefined)?.api ?? "",
    );
    const countedRes = await run(tsArgv(driveState, ["rounds", pr]), {
      stderr: "inherit",
    });
    if (countedRes.code !== 0) {
      fail(1, `cannot read the durable round count for PR #${pr}; stopping`);
    }
    // A NON-MUTATING peek at what this round's attempt count WOULD become.
    // The durable `bump-attempt` commit itself now happens only immediately
    // before the pass is actually dispatched, several awaits below — nothing
    // here may charge the budget yet, because everything between here and
    // dispatch can still abort without a pass ever running. An earlier
    // revision charged here and refunded on abort; that compensating refund
    // had its own correctness gaps (an ABA case on its compare-and-swap)
    // that a "never charge until certain" design does not need to defend
    // against at all. `get`, not `attempts` alone, because the peek must
    // know whether THIS head still matches the stored `attemptsHead` — a
    // head change resets the count to 1, exactly like `bump-attempt`'s own
    // reset branch. Also carries
    // `lastReflectedRound`/`lastReflectedAttempts` for the reflect-duty
    // check below, in the SAME read: a separate, later `get` call would
    // still be reading state from BEFORE this round's commit, understating
    // `reflectDepthPastLast` by exactly one round every time (caught in
    // testing after the restructuring away from charge-then-refund).
    const peekRes = await run(tsArgv(driveState, ["get", pr]), {
      stderr: "inherit",
    });
    if (peekRes.code !== 0) {
      fail(1, `cannot read durable state for PR #${pr}; stopping`);
    }
    let peekedAttempts = 0;
    let peekedLastReflectedRound: number | undefined;
    let peekedLastReflectedAttempts: number | undefined;
    try {
      const peeked = JSON.parse(peekRes.stdout) as {
        attempts?: unknown;
        attemptsHead?: unknown;
        lastReflectedRound?: unknown;
        lastReflectedAttempts?: unknown;
      };
      const priorAttempts =
        typeof peeked.attempts === "number" &&
        Number.isInteger(peeked.attempts) &&
        peeked.attempts >= 0
          ? peeked.attempts
          : null;
      peekedAttempts =
        peeked.attemptsHead === apiHead && priorAttempts !== null
          ? priorAttempts + 1
          : 1;
      // `lastReflectedRound` is untouched by a head change — `rounds` is
      // cumulative, not per-head, so no reset applies here.
      peekedLastReflectedRound =
        typeof peeked.lastReflectedRound === "number"
          ? peeked.lastReflectedRound
          : undefined;
      // `lastReflectedAttempts`, unlike `lastReflectedRound`, IS reset by a
      // head change — `bump-attempt`'s own head-change branch zeroes it in
      // the SAME atomic update that resets `attempts` to 1. Reading the
      // stored value unconditionally here left a stale baseline from the
      // PREVIOUS head in place after a head change — e.g. `peekedAttempts`
      // correctly reset to 1 while this stayed at 8 from the old head, so
      // `reflectDepthPastLast`'s `attempts - lastReflectedAttempts` computed
      // `1 - 8` instead of `1 - 0`, delaying the /reflect duty by however
      // many passes the old head had already reflected past.
      peekedLastReflectedAttempts =
        peeked.attemptsHead === apiHead &&
        typeof peeked.lastReflectedAttempts === "number"
          ? peeked.lastReflectedAttempts
          : undefined;
    } catch {
      // Fail closed: this `get` call already succeeded (checked above), so a
      // JSON parse failure here means drive-state.ts returned malformed
      // output for a request that otherwise worked — not an absence of
      // evidence to fail open on, the way an unreadable READ is treated
      // elsewhere. Leaving `peekedAttempts` at 0 let a
      // malformed-but-successful response under-count the round/max-rounds
      // check and dispatch another pass past the budget instead of enforcing
      // it.
      fail(1, `cannot parse durable state for PR #${pr}; stopping`);
    }
    const countedRaw = countedRes.stdout.trim();
    const counted = isDigits(countedRaw) ? Number.parseInt(countedRaw, 10) : 0;
    const round = Math.max(counted, peekedAttempts);
    if (counted > maxRoundsN || peekedAttempts > maxRoundsN) {
      console.error(
        `hit --max-rounds (${maxRoundsN}) on PR #${pr} without converging`,
      );
      console.error("This is a NON-CONVERGENCE report, not a quiet stop:");
      console.error(reasonLine);
      // The exhausted-budget exit is exactly where the economy matters most:
      // whatever the loop spent, it spent without finishing.
      process.stderr.write(await loopEconomy(pr));
      return MAX_ROUNDS_EXIT;
    }

    console.error(`--- round ${round}/${maxRoundsN} on PR #${pr} ---`);
    console.error(reasonLine);
    process.stderr.write(await severityWarnings(pr));

    // Past the third round, a `/reflect` pass is due: rounds that keep
    // producing findings are evidence of a scaffolding or
    // reviewer-configuration gap, and the round that discovers it is worth
    // more than the round that patches one more instance. Waiting for
    // --max-rounds is too late — that is the bound, not the signal.
    //
    // A control loop cannot invoke a slash command, so this arms the PASS,
    // which can: the flag is exported into its environment (SKILL.md § 3
    // makes acting on it part of the round) and announced on stderr for the
    // human watching. It is a duty, not a gate — blocking here would strand
    // an unattended drive on a step only an agent can perform.
    const reflectAfterRaw = process.env.DRIVE_PR_REFLECT_AFTER ?? "3";
    const reflectAfter = isDigits(reflectAfterRaw)
      ? Number.parseInt(reflectAfterRaw, 10)
      : 3;
    // Measured forward from where a /reflect was LAST RECORDED
    // (drive-state.ts set-reflected), not from zero: a duty keyed on the
    // absolute round re-arms every round forever against a reflect that
    // already happened. `reflectDepthPastLast` is the shared predicate —
    // drive-status.ts derives the `reflectDue` report field from the same
    // function over the same durable state, which is what makes the duty fire
    // on interactive runs too and what stops the two answering differently
    // (this env var is the legacy transport for passes driven from here).
    //
    // Built from the EARLY peek above, not a fresh `get` here: a separate
    // read at this point would still be reading state from BEFORE this
    // round's own `bump-attempt` commit, which now happens only right before
    // dispatch — understating depth by exactly one round, every round, and
    // silently delaying the duty past its own threshold. `rounds` comes from
    // `countedRes` above for the same reason: it is already this round's
    // accurate value, read once.
    const depth = reflectDepthPastLast({
      rounds: counted,
      attempts: peekedAttempts,
      lastReflectedRound: peekedLastReflectedRound,
      lastReflectedAttempts: peekedLastReflectedAttempts,
    });
    if (reflectDutyArmed(depth, reflectAfter)) {
      process.env.DRIVE_PR_REFLECT_DUE = String(round);
      console.error(
        `  ⚠ round ${round} is ${Number.isFinite(depth) ? depth : "an unreadable distance"} past the last recorded reflection (threshold ${reflectAfter}): /jig:reflect is DUE before triaging this round.`,
      );
      console.error(
        "    Repeat findings at this depth are a scaffolding gap, not reviewer noise.",
      );
    } else {
      delete process.env.DRIVE_PR_REFLECT_DUE;
    }

    if (dryRun) {
      // Reports the AMENDED command, because that is the one a real round
      // would spawn. Printing the argv as typed would hide the one
      // modification this driver makes to it — so an operator whose CLI
      // rejects the injected flag would see, in the surface built for
      // exactly that question, a command that works.
      const dryPrepared = prepareQuotaSpawn(agent, passEnv());
      const dryArgv = dryPrepared?.argv ?? agent;
      console.error(
        `(dry-run) would run: ${dryArgv.length > 0 ? dryArgv.join(" ") : "<no pass command given>"}`,
      );
      if (dryPrepared !== null) {
        // Mirrors the real-run branch below: `--resume <id>`, `--continue`
        // and a bare `--resume` are all correlated WITHOUT amending argv
        // (`dryArgv` above already shows that faithfully), so a message
        // claiming `--session-id` was added would be false for every one of
        // them. Distinguish by the same length check the real-run branch
        // uses, not by whether a correlation exists at all.
        const amended = dryPrepared.argv.length !== agent.length;
        console.error(
          amended
            ? `  (--session-id ${dryPrepared.correlation.sessionId} is added by this driver to bind quota evidence to the pass; DRIVE_PR_QUOTA_NO_SPAWN_PREP=1 disables it.)`
            : `  (correlated for quota attribution without amending argv: ${dryPrepared.correlation.vendor} session ${dryPrepared.correlation.sessionId ?? "(no exact id — a deliberately resumed/continued session)"}; DRIVE_PR_QUOTA_NO_SPAWN_PREP=1 disables it.)`,
        );
      }
      return 0;
    }

    // A pass that discovers the PR merged mid-round exits 5 —
    // `guarded-push.ts` refuses on a merged or closed PR and the pass
    // propagates it. That is the documented terminal `PR_NOT_OPEN`, not a
    // broken pass, and flattening it to 1 tells the caller "your pass is
    // failing, look at it" about a PR that is simply finished. Preserve
    // exactly that one code.
    //
    // Only that one. The pass is an arbitrary command whose exit space is its
    // own, and blanket propagation would collide with this script's: an agent
    // exiting 3 for its own reasons would report SHA-verified convergence.
    // Every other non-zero stays 1, which is what it is — a pass that failed.
    // `detached` so a stop reaches the whole pass tree — the agent, its tool
    // subprocesses, and the `guarded-push.ts`/`git push` underneath them —
    // rather than the agent process alone. It costs tty signal delivery, which
    // the handlers installed above now supply instead, and the controlling
    // terminal, so a descendant that wants to PROMPT (a git credential helper)
    // now fails instead of asking. That is the right answer for a driver whose
    // whole premise is running unattended: an unanswerable prompt is a hang no
    // deadline in this skill covers.
    //
    // Captured BEFORE the spawn and used as the quota scan's `since` floor.
    // The account-wide transcripts hold every wall this machine ever hit, so
    // without a floor the newest one is indistinguishable from this pass's own
    // — and a drive re-armed after an earlier block would read that stale wall
    // and park itself again, forever.
    const passStartedAt = new Date();
    // Progress, not merely a claim heartbeat. `startHeartbeat`'s
    // timer refreshes the CLAIM on a schedule independent of anything
    // happening in this round, so a driver that hit a quota wall, exhausted
    // its pass's context, or wedged on a head-sync wait heartbeats
    // IDENTICALLY to a healthy one; six drives were observed live at once
    // with two silently stale locks nobody had reported. "A pass was
    // spawned" is the one genuine progress event `drive.ts` itself
    // originates (the other three — a round advancing, a push landing, a
    // held batch draining — are stamped inside `drive-state.ts` by the verbs
    // that already do that work), so it goes through the same named
    // `progress` verb rather than a bespoke write here.
    //
    // Stamped from `onSpawn`, not before this call, so a missing or invalid
    // pass executable never records an event that did not occur: `onSpawn`
    // fires only once `run()`'s internal `spawn()` has actually produced a
    // child process, whereas a stamp issued before this call would fire
    // unconditionally, including when `run(agent, …)` goes on to fail at the
    // synchronous spawn step and never starts anything.
    //
    // Best-effort, deliberately, and now fire-and-forget rather than
    // awaited: a failure to record the stamp must not fail the ROUND — the
    // pass is the actual work, and refusing to run it over an observability
    // write would let `--doctor`'s own accounting break the drive it exists
    // only to watch. Losing a stamp costs a `--doctor` verdict that degrades
    // to UNKNOWN (fail-closed; see `lib/doctor.ts`), never a false HEALTHY,
    // so the failure mode of skipping this check is bounded.
    // `timeoutSec`, per `references/consistency.md`: an undeadlined
    // `run()` here could outlive the driver, and this one queues for the state
    // mutex — which a concurrent driver on the same PR can legitimately hold
    // for the length of its own write. `helperTimeoutSeconds()` is the
    // accessor for exactly this (one spawned helper, whole-invocation bound,
    // 120s default); expiring it is the same bounded loss as any other
    // failure on this best-effort path.
    const passDeadlineSec = passTimeoutSeconds();
    // One more refresh, immediately before THIS spawn — not only at the
    // PRIOR pass's exit. The exit-time call closes the gap up to that
    // instant, but everything between it and here (triage, fixes, the full
    // gate suite, a push, sometimes a Testbox) can take a while, and a
    // file-backed login change landing in that window would otherwise still
    // hand this pass a stale claim for its own entire life — the same
    // failure `refreshAccountIdentity` exists to close, just at the one
    // remaining call site that had no guaranteed pre-spawn read of its own.
    // Bounded-retried by `refreshAccountIdentityBeforeSpawn` — see its own
    // header for why a merely-transient failure here cannot be left
    // unretried.
    const identitySynced = await refreshAccountIdentityBeforeSpawn(held, agent);
    // Checked IMMEDIATELY after: that call can itself detect a resurrection
    // (its own post-rename `claimNames.length > 1` check) and set
    // `compromised` — and unlike the post-pass check below, nothing here
    // was watching for it before now, because no pass was running for the
    // heartbeat timer to stop. Falling through into `run()` regardless
    // would spawn a NEW pass alongside a successor that already believes it
    // holds this lock: `touchLock` returns early once `compromised` is set,
    // so no LATER heartbeat tick can stop it either — the two-drivers state
    // every lock in this file exists to prevent, self-inflicted by this
    // driver's own refresh call.
    if (compromised !== "") {
      console.error(
        `drive.ts: the ${compromised} lock was recovered by another driver — not starting another pass.`,
      );
      return SINGLE_INSTANCE_LOCK_EXIT;
    }
    if (!identitySynced) {
      // Not a takeover — an ordinary, still-unresolved transient failure
      // after every retry. Spawning anyway rather than stopping the drive
      // over a DISPLAY value: the heartbeat resumes retrying the moment
      // this pass exits, same as it always has for any other transient
      // failure.
      console.error(
        "drive.ts: the account-identity claim rewrite did not land before this spawn — proceeding with a possibly-stale display; the heartbeat retries once this pass exits.",
      );
    }
    // The other half of binding evidence to THIS pass, and the reason both of
    // these sit immediately above the spawn rather than at the top of the
    // round. `cwd` + `since` alone cannot separate this pass from a human's
    // interactive session sitting in the same worktree — the normal condition
    // while a drive runs, since the drive locks exclude other DRIVERS, not a
    // chat — so that session's wall could park this pass and its healthy
    // telemetry could clear this pass's real wall.
    //
    // `snapshotQuotaSessions()` records what already exists, so anything that
    // appears afterwards is a session started during the pass;
    // `prepareQuotaSpawn()` goes further where the vendor allows it, giving
    // the pass an identity chosen HERE so its evidence can be matched
    // exactly. The window between these two calls and the spawn is the
    // residual, which is why nothing is interposed between them.
    const preexistingSnapshot = snapshotQuotaSessions();
    const preexistingSessions = preexistingSnapshot.files;
    const baseEnv = passEnv();
    const prepared = prepareQuotaSpawn(agent, baseEnv);
    if (prepared !== null) {
      // Said out loud, once per round. This is the only place the driver
      // rewrites a command the caller gave it, and an operator whose CLI
      // does not understand the injected flag sees the round die instantly
      // with a usage error for a command they never typed — with nothing
      // anywhere connecting the two, or naming the way out.
      //
      // Two shapes, told apart by argv length rather than the correlation's
      // own `sessionId` being non-null: a minted or exact-resume-value
      // correlation both leave `sessionId` a real string, but only the
      // MINTED one actually injects `--session-id` into argv — an
      // exact-resume-value or a vendor-confirmed-no-id correlation (a
      // deliberate `--continue`/`-c`/ambiguous `--resume`) leaves argv
      // unchanged, so describing either of those as an "amended" flag
      // injection would name a mutation that never happened.
      const amended = prepared.argv.length !== agent.length;
      console.error(
        amended
          ? `pass argv amended for quota attribution: --session-id ${prepared.correlation.sessionId} (DRIVE_PR_QUOTA_NO_SPAWN_PREP=1 disables)`
          : `pass correlated for quota attribution without amending argv: ${prepared.correlation.vendor} session ${prepared.correlation.sessionId ?? "(no exact id — a deliberately resumed/continued session)"} (DRIVE_PR_QUOTA_NO_SPAWN_PREP=1 disables)`,
      );
    }
    // Populated by `onSpawn` below with the fire-and-forget `pass-spawned`
    // stamp's own promise, so it can be joined once the pass itself has
    // finished — see the comment at that join point for why this ordering
    // is load-bearing.
    let passSpawnProgressStamp: Promise<unknown> | null = null;
    // Several awaited state/account reads separate the earlier round check
    // from this spawn, and a directive sent during one of them must still
    // prevent a new pass — this checkpoint is the LAST await before the
    // charge below and the spawn that follows it.
    const mailboxAtSpawn = await mailboxCheckpoint();
    if (typeof mailboxAtSpawn === "number") return mailboxAtSpawn;
    if (mailboxAtSpawn === "resumed") continue;
    // Commit the durable charge and the local pass counter HERE, not
    // earlier: everything above this line can still abort without a pass
    // running, so nothing above it may spend real budget. This replaced an
    // earlier charge-then-refund design whose compensating refund had its
    // own correctness gap (an ABA case on its compare-and-swap) — "never
    // charge until certain" needs no compensating action at all. The one
    // irreducible residual is the `bump-attempt` call's own round-trip
    // immediately below: a directive landing in that single await is not
    // caught before this dispatch, only at the next checkpoint — accepted
    // deliberately, because closing it would need the charge and the spawn
    // to be literally the same operation, which they cannot be.
    passes += 1;
    const bump = await run(
      tsArgv(driveState, ["bump-attempt", pr, "--head", apiHead]),
      { stderr: "inherit" },
    );
    // A PR-wide refusal is not a persistence fault, and flattening it into
    // one costs exactly what the gate provides. `drive.ts`'s own
    // per-PR lock does NOT cover this case: that lock is only ever held by
    // another `drive.ts`, so an INTERACTIVE pass in another worktree — an
    // agent walking SKILL.md by hand, which takes no lock at all — is
    // invisible to it, and this is the first call that meets that session's
    // lease. Propagated with its own code so a log reads as "another tree is
    // driving this PR" rather than "the state dir is unwritable"; the child's
    // stderr is already inherited and names the tree, its session and how to
    // check it.
    if (bump.code === DRIVE_HELD_ELSEWHERE_EXIT) {
      fail(
        DRIVE_HELD_ELSEWHERE_EXIT,
        `PR #${pr} is being driven from another working tree; stopping rather than becoming the second resolver`,
      );
    }
    if (bump.code !== 0) {
      fail(
        1,
        `cannot record this pass against PR #${pr}'s head; stopping rather than driving unbounded`,
      );
    }
    const passRes = await span("pass", { round }, () =>
      run(prepared?.argv ?? agent, {
        stdout: "inherit",
        stderr: "inherit",
        detached: true,
        env: prepared?.env ?? baseEnv,
        // `0` disables, matching every other deadline knob in this skill; `run()`
        // takes the absence of the field as "no deadline" rather than a zero.
        ...(passDeadlineSec > 0 ? { timeoutSec: passDeadlineSec } : {}),
        onSpawn: (handle) => {
          activePass = handle;
          passSpawnProgressStamp = run(
            tsArgv(driveState, ["progress", pr, "--phase", "pass-spawned"]),
            { stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
          ).then((progressStamp) => {
            if (progressStamp.code !== 0) {
              console.error(
                `drive.ts: could not stamp progress for round ${round}'s pass (drive-state.ts exited ${progressStamp.code}) — continuing anyway.`,
              );
            }
          });
        },
      }),
    );
    // Captured before `activePass` is cleared: the PASS_DEADLINE branch below
    // needs it to witness the pass tree's termination, which happens after
    // this point.
    const passHandle = activePass;
    activePass = null;
    // Joined here, before the pass result is interpreted or anything below
    // writes state again — not to make the write itself fatal (a failed or
    // slow stamp is still swallowed by the `.then()` above), but to ORDER
    // it: this write queues on the same state mutex as everything else, and
    // being fire-and-forget from `onSpawn`'s perspective let it complete
    // AFTER a later write in this same round (`recordQuotaPark()`, several
    // hundred lines below) rather than before it. A `pass-spawned` stamp
    // that lands after a quota-park write refreshes `lastProgressAt` and
    // clears `quotaPark`, so `--doctor` reads recent HEALTHY progress or
    // loses the QUOTA_PARKED verdict for a pass that has already stopped.
    // The pass itself has already finished by this point, so joining here
    // adds no latency to its own critical path.
    if (passSpawnProgressStamp !== null) {
      await passSpawnProgressStamp;
    }
    // Checked BEFORE the exit code is interpreted: a pass this process killed
    // for a takeover exits non-zero, and reporting that as "your pass is
    // failing, look at it" would bury the actual event. `release` is
    // nonce-checked, so the way out touches no successor's lock.
    if (compromised !== "") {
      console.error(
        `drive.ts: the ${compromised} lock was recovered by another driver mid-pass — the pass was stopped; not driving further.`,
      );
      // The takeover's stop ran from a timer, which could not wait — so re-join
      // its witness here. The COMPROMISED lock is not ours to release either
      // way (its nonce check fails), but the other one still is, and releasing
      // it while a descendant of the pass survives is the same two-drivers-one-
      // tree state this whole path exists to avoid.
      if (passStopWitness !== null && !(await passStopWitness)) {
        held.length = 0;
      }
      return SINGLE_INSTANCE_LOCK_EXIT;
    }
    // Refresh synchronously HERE too, not only on the heartbeat timer.
    // `activePass` just went back to `null`, which is the exact window
    // `refreshAccountIdentity`'s own gate exists for — but the heartbeat's
    // own next tick can be up to `heartbeatRefreshMs()` away, and this loop
    // may spawn the very next pass before it ever fires. A credential file
    // that changed while this pass ran would otherwise hand that next pass a
    // stale claim for its own entire life, the same failure mode
    // `refreshAccountIdentity` exists to close for the file-backed identity
    // path.
    refreshAccountIdentity(held, agent);
    // Checked immediately after, same as the pre-spawn call site: this
    // refresh can itself detect a resurrection and set `compromised`, and
    // falling through to interpret `passRes.code` regardless would let the
    // loop keep going with no claim protecting the tree — including into
    // the quota-sleep path below, which can hold what it believes is a
    // live lock for HOURS after the takeover, and into a Ready-mark
    // transition neither of which re-checks this before the next loop
    // boundary.
    if (compromised !== "") {
      console.error(
        `drive.ts: the ${compromised} lock was recovered by another driver — not continuing.`,
      );
      return SINGLE_INSTANCE_LOCK_EXIT;
    }
    const disposition = passExitDisposition(passRes.code);
    // A directive sent WHILE this pass ran must still be honored before a
    // non-success terminal result for it is reported, PR_NOT_OPEN included.
    // NOT extended to the
    // SUCCESS path below (no `disposition.kind === 'ok'` branch exists here
    // — the function falls through to mark-ready and the held-batch drain
    // instead): checking unconditionally, before `disposition` is computed,
    // would break the documented "a running pass is allowed to complete,
    // including its post-round Ready transition, before the next
    // checkpoint" guarantee.
    // A round that succeeded reaches mark-ready regardless of a directive
    // that arrived while it ran; it already re-checks the mailbox at the top
    // of the next iteration in the ordinary course of looping.
    // `clear`/`resumed` both fall through to reporting PR_NOT_OPEN — the
    // pass already found this out, so a live pause only delays WHEN it is
    // reported, never what it was; `stopped`/`pause-timeout`/`unreadable`
    // return their own exit code in its place.
    if (disposition.kind === "not-open") {
      const mailboxAfterNotOpen = await mailboxCheckpoint();
      if (typeof mailboxAfterNotOpen === "number") return mailboxAfterNotOpen;
      console.error(
        `pass reported the PR is no longer open on round ${round}; stopping`,
      );
      return disposition.exit;
    }
    if (disposition.kind === "failed") {
      // `timedOut` rather than `code === 124`, because the pass is an arbitrary
      // command whose exit space is its own: one that exits 124 for its own
      // reasons must not be reported as a deadline this driver never fired.
      if (passRes.timedOut) {
        console.error(
          `pass hit its ${passDeadlineSec}s deadline on round ${round} and was killed.`,
        );
        // `run()` resolves once its own SIGKILL escalation FIRES — proof a
        // signal was sent, not that the process group is actually gone (a
        // descendant in uninterruptible sleep, or one that escaped the group,
        // can outlive it). Re-poll the same witnessed-termination check the
        // takeover and signal paths already use before this driver's own
        // 'exit' handler releases its locks: a live pass under a released
        // lock is the exact two-drivers-one-tree state those locks exist to
        // prevent. Idempotent — if `run()`'s own escalation already finished
        // the job, this resolves immediately.
        const witnessed = passHandle === null || (await passHandle.stop());
        if (witnessed) {
          console.error(
            "  The pass tree is gone, but whatever it was doing when the clock ran out is NOT",
          );
          console.error(
            "  rolled back. Check `git status --short` for an uncommitted fix and",
          );
          console.error(
            "  `git rev-list --count @{u}..HEAD` for a committed-but-unpushed one before re-arming;",
          );
          console.error(
            "  a killed pass strands work at whatever step it had reached.",
          );
        } else {
          console.error(
            "  Its termination could NOT be witnessed — some descendant may still be running.",
          );
          console.error(
            "  NOT releasing this drive's locks: a live pass under a released lock is the",
          );
          console.error(
            "  exact two-drivers-one-tree state they exist to prevent. Confirm the tree is",
          );
          console.error(
            "  actually gone, then remove the lock dir to re-arm (see `acquire`'s message).",
          );
          held.length = 0;
        }
        console.error(
          "  ($DRIVE_PR_PASS_TIMEOUT / --pass-timeout; 0 disables this deadline.)",
        );
        // A directive sent WHILE this pass ran must still be honored before
        // reporting PASS_DEADLINE — but only when the tree's termination was
        // WITNESSED: checking mailbox (which can itself wait out a live
        // pause) is not safe to do immediately after deciding a descendant
        // may still be alive and out there unsupervised. The unwitnessed
        // branch above already leaves `held` cleared and returns
        // unconditionally, same as before.
        if (witnessed) {
          const mailboxAfterDeadline = await mailboxCheckpoint();
          if (typeof mailboxAfterDeadline === "number")
            return mailboxAfterDeadline;
        }
        return PASS_DEADLINE_EXIT;
      }

      // A usage wall is not a pass failure, and reporting it as one is what
      // sends an operator to read a pass that did nothing wrong. Ask the
      // adapters before saying anything about the exit code. One `now` grounds
      // both the adapters' future-timestamp rejection and the sleep/stop
      // decision below, rather than each reading the clock separately a few
      // lines apart for what is, in substance, one detect-then-decide step.
      const now = new Date();
      const block = detectQuotaBlock(
        {
          cwd: process.cwd(),
          since: passStartedAt,
          now,
          preexistingSessions,
          ...(prepared !== null ? { correlation: prepared.correlation } : {}),
        },
        preexistingSnapshot.truncatedByVendor,
      );
      if (block !== null) {
        const plan = planFor(block, now);
        console.error(`pass on round ${round} hit a quota wall.`);
        console.error(`  ${describeQuota(block)}`);
        console.error(`  evidence read from ${block.source}`);
        if (plan.action === "sleep") {
          // This round's attempt is already durably counted and is not
          // refunded — so if it was also the LAST one `--max-rounds`
          // permits, resuming after the sleep re-enters the gate on an
          // unchanged head, `bump-attempt` advances past the limit, and the
          // driver exits 6 having run no further pass. Sleeping first would
          // hold its locks for hours to reach that same exit
          // — check now instead.
          if (round >= maxRoundsN) {
            console.error(
              `  round ${round} was already the last of --max-rounds (${maxRoundsN}) — not sleeping ${Math.ceil(plan.ms / 60000)} minute(s) for an attempt that cannot happen.`,
            );
            console.error(
              `hit --max-rounds (${maxRoundsN}) on PR #${pr} without converging`,
            );
            console.error(
              "This is a NON-CONVERGENCE report, not a quiet stop:",
            );
            console.error(
              `  pass on round ${round} hit a quota wall and no further attempt remains`,
            );
            console.error(
              "  Check for work the killed pass left behind first — `git status --short` and",
            );
            console.error("  `git rev-list --count @{u}..HEAD`.");
            // Recorded even though nothing will sleep or resume: this exit is
            // NORMAL (not a crash), so `process.on('exit')` releases and
            // `rmdir`s the lock slot on the way out, same as the standalone
            // QUOTA_PARKED_EXIT path below. Without this, `--doctor` would
            // see a state-only row with no quota evidence at all and report
            // UNKNOWN instead of QUOTA_PARKED for a drive that hit a real,
            // genuine wall — the exact distinction this record exists to draw
            // (see `recordQuotaPark`'s own callers for why every other
            // quota-wall exit already does this).
            await recordQuotaPark(driveState, pr, block);
            process.stderr.write(await loopEconomy(pr));
            // A directive sent WHILE the killed pass ran must still be
            // honored, same as the non-quota failure branch below:
            // `clear`/`resumed` both fall through to this same
            // non-convergence report — the budget is exhausted either way, a
            // resumed pause grants no further rounds — while
            // `stopped`/`pause-timeout`/`unreadable` return their own exit
            // code in its place.
            const mailboxAtQuotaMaxRounds = await mailboxCheckpoint();
            if (typeof mailboxAtQuotaMaxRounds === "number")
              return mailboxAtQuotaMaxRounds;
            return MAX_ROUNDS_EXIT;
          }
          const minutes = Math.ceil(plan.ms / 60000);
          console.error(
            `  SLEEPING ${minutes} minute(s) until ${plan.until.toISOString()}, then resuming.`,
          );
          console.error(
            "  The locks stay held and keep refreshing: this drive is still the one driving",
          );
          console.error(
            "  this PR, and releasing them here would invite a second driver into the tree.",
          );
          // The round this wall consumed is NOT refunded. It was counted before
          // the pass ran, and unwinding a durable counter from here would mean
          // a failure path that mutates the very state the loop's bounds are
          // read from. Burning one of --max-rounds on a wall is the cheap
          // direction; an unbounded loop is not.
          //
          // Raced against a lock takeover, not merely timed: sleeping this
          // long unconditionally left `touchLock`'s takeover signal
          // (`compromised`) unobserved for up to `maxSleepMs()` — six hours
          // by default — because nothing between here and the loop's next
          // round-boundary check reads it while this `await` is in flight.
          // `quotaSleepAbort` is what `touchLock` fires the moment it
          // notices; this wakes on whichever comes first.
          // Recorded BEFORE the sleep, not after: the whole interval this
          // call describes is the one during which `--doctor` would
          // otherwise misread this drive (see `recordQuotaPark`). Cleared by
          // the next genuine progress event — the `progress` stamp the
          // resumed round takes before it spawns its pass.
          await recordQuotaPark(driveState, pr, block);
          // Re-check BEFORE creating the controller: a takeover detected by
          // `touchLock` WHILE the await above was in flight called
          // `quotaSleepAbort?.abort()` against a controller that did not
          // exist yet — a no-op — and set `compromised`, so `touchLock`'s
          // own `if (compromised !== '') return;` guard skips firing it
          // again on every later heartbeat tick. Without this check, the
          // controller created next would never receive an abort at all, and
          // the sleep below would run for the FULL `plan.ms` (up to
          // `maxSleepMs()`, six hours) before the after-sleep check further
          // down ever saw the takeover.
          if (compromised !== "") {
            continue;
          }
          quotaSleepAbort = new AbortController();
          try {
            const quotaWaitStartedAt = performance.now();
            while (performance.now() - quotaWaitStartedAt < plan.ms) {
              // Quota waiting is between passes, so a mailbox stop must not
              // sit behind this potentially multi-hour sleep. Keep the
              // takeover abort on each short sleep as before.
              const mailboxDuringQuota = await mailboxCheckpoint();
              if (typeof mailboxDuringQuota === "number")
                return mailboxDuringQuota;
              if (compromised !== "") break;
              const remainingMs =
                plan.ms - (performance.now() - quotaWaitStartedAt);
              if (remainingMs > 0) {
                await sleep(
                  Math.min(MAILBOX_POLL_SECONDS, remainingMs / 1000),
                  quotaSleepAbort.signal,
                );
              }
            }
          } finally {
            quotaSleepAbort = null;
          }
          if (compromised !== "") {
            // The loop's own top-of-iteration check reports and returns 11 —
            // nothing to add here beyond not claiming a resumption that
            // never happened.
            continue;
          }
          // Deliberately does NOT name the next round number. `continue`
          // re-enters the gate, which re-derives the round from durable state —
          // and hours have passed, so the head may well have moved under us.
          // Printing `round + 1` here would be this loop's guess, contradicted
          // by the very next line the gate prints.
          console.error(
            `quota window reopened; resuming the drive of PR #${pr}.`,
          );
          continue;
        }
        console.error(`  NOT sleeping: ${plan.why}.`);
        console.error(
          "  Stopping rather than holding this PR's locks through a wall nothing here can",
        );
        console.error(
          "  wait out. Re-arm the drive once the window reopens; nothing about the PR, the",
        );
        console.error("  tree or the pass needs fixing first.");
        console.error(
          "  Check for work the killed pass left behind first — `git status --short` and",
        );
        console.error("  `git rev-list --count @{u}..HEAD`.");
        // Record the park BEFORE this process exits: once this
        // returns, nothing refreshes this drive's claim any further, and
        // `release()` (`process.on('exit')`) `rmdir`s the lock slot on the
        // way out — a NORMAL exit, not a crash, so a later `--doctor` sweep
        // finds NO lock directory here at all. Without this record it would
        // therefore see NOTHING for this PR — not even a stale claim to
        // report — and could not tell a drive that parked ON PURPOSE from one
        // that never existed. `listStateOnlyRows` (`drives.ts`) is what makes
        // the record findable despite the missing lock: it sweeps
        // `drive-pr-<PR>.json` directly, so this write is what `--doctor`
        // actually reads to draw the `QUOTA_PARKED` distinction
        // (`lib/doctor.ts`). Best-effort, same reasoning as the pre-spawn
        // stamp above: the wall itself is the fact worth acting on, and
        // refusing to park cleanly over a bookkeeping failure would strand
        // the drive here instead.
        await recordQuotaPark(driveState, pr, block);
        // Same as the sleep-branch max-rounds report above, and the
        // non-quota failure branch below: a directive sent WHILE the killed
        // pass ran must still be honored.
        // `clear`/`resumed` both fall through to parking — this wall cannot
        // be slept through either way — while `stopped`/`pause-timeout`/
        // `unreadable` return their own exit code in its place.
        const mailboxAtQuotaPark = await mailboxCheckpoint();
        if (typeof mailboxAtQuotaPark === "number") return mailboxAtQuotaPark;
        return QUOTA_PARKED_EXIT;
      }

      // A directive sent WHILE this pass ran must still be honored before
      // reporting this generic non-quota failure. `clear`/`resumed` fall
      // through to reporting the failure — it already happened — while
      // `stopped`/`pause-timeout`/`unreadable` return their own exit code in
      // its place.
      const mailboxBeforeFailureReport = await mailboxCheckpoint();
      if (typeof mailboxBeforeFailureReport === "number")
        return mailboxBeforeFailureReport;
      console.error(
        `pass failed on round ${round} (exit ${passRes.code}); not driving further`,
      );
      return disposition.exit;
    }

    // A round completed: triaged, replied, resolved, and pushed whatever it
    // fixed. THIS is the moment the draft→Ready transition is owed — not the
    // start of the drive, and not convergence.
    //
    // Not at the start, because the whole value of waiting is that CodeRabbit
    // refuses to look at a draft and reviews a Ready PR exactly once per push:
    // marking it Ready before the first round spends that pass on the untouched
    // first draft of the branch, which is the spend this ordering exists to
    // avoid. Not at convergence either — by then the drive is over, and the
    // external findings it summons would land on a PR nobody is driving.
    //
    // Gated on a COMPLETED pass rather than on a push landing. A round that
    // adjudicated every finding as rejected/wont-fix pushes nothing and is
    // still a cleaned-up feedback set, which is what the external reviewer is
    // being handed; keying on the head moving would leave that round's PR a
    // draft forever.
    //
    // `mark-ready.ts` is idempotent and durably once-only, so calling it after
    // EVERY round is correct and costs one state read on all but the first.
    //
    // ITS EXIT CODE IS HANDLED, not ignored, and the non-zero codes get
    // opposite treatment because they mean opposite things:
    //
    //   5 — the PR stopped being open. Deliberately NOT propagated here: the
    //     gate at the top of the next iteration owns that decision and re-reads
    //     liveness anyway, so it costs one cheap loop to let the one place that
    //     is allowed to declare PR_NOT_OPEN declare it.
    //   anything else — the transition was owed and could not be made. One
    //     failure is survivable (the lease is released, so the next round
    //     retries) and the round itself succeeded, so aborting a productive
    //     drive over it would be the wrong trade. A failure that REPEATS is a
    //     different animal: it does not get better by itself, and continuing
    //     silently would run out the round budget on a PR that stays a draft —
    //     which is exactly the "may run more rounds and eventually terminate at
    //     --max-rounds while the PR remains draft" this once did. So the second
    //     consecutive one stops the drive and says which command to run by
    //     hand.
    if (!keepDraft && markReadyDueAfterRound(markReadyPolicy, round)) {
      const rc = await run(
        tsArgv(markReady, [pr, "--reason", `round ${round} completed`]),
        { stderr: "inherit", timeoutSec: markReadyTimeoutSeconds() },
      );
      // Rechecked HERE, immediately after the await, same reasoning as every
      // other `compromised` guard in this file: `touchLock` runs on its own
      // timer and can set it at any point during the wait above, and this
      // driver has no claim protecting the tree from that moment on.
      // Proceeding to interpret `rc` regardless would let a compromised
      // drive still perform the Ready transition (or count its outcome
      // toward `readyMarkFailures`) with no lock behind it.
      if (compromised !== "") {
        console.error(
          `drive.ts: the ${compromised} lock was recovered by another driver — not processing the Ready-mark outcome.`,
        );
        return SINGLE_INSTANCE_LOCK_EXIT;
      }
      // A recognized outcome requires BOTH exit 0 AND stdout being one of the
      // words in `MARK_READY_OUTCOMES` — exit 0 with anything else (empty,
      // truncated, garbled) is a malformed protocol response, not progress, and is
      // routed into the same failure-counting path as a nonzero exit rather
      // than silently resetting `readyMarkFailures`.
      const outcome = rc.code === 0 ? rc.stdout.trim() : null;
      const validOutcome = outcome !== null && MARK_READY_OUTCOMES.has(outcome);
      if (validOutcome) {
        // `claimed-by-other` is exit 0 and is NOT progress. The case that
        // makes the distinction load-bearing is the one this round's own
        // helper deadline creates: if the timeout fires after `mark-ready.ts`
        // won its lease, the helper is killed before its cleanup can release
        // it, so the NEXT round meets an orphaned lease, is told
        // `claimed-by-other`. Leaving `readyMarkFailures` merely UNCHANGED
        // here (rather than counting it as another unsuccessful attempt) meant
        // it could never reach the `>= 2` stop condition on its own — a
        // repeatedly orphaned lease would keep reporting `claimed-by-other`
        // every round without ever tripping the stop, and the drive would
        // exhaust `--max-rounds` with the PR still a draft.
        if (outcome !== "claimed-by-other") {
          readyMarkFailures = 0;
        } else {
          readyMarkFailures += 1;
          console.error(
            `round ${round} completed, but PR #${pr}'s Ready-mark lease is held elsewhere —`,
          );
          console.error(
            "  no transition made. If no other driver is running, this is an orphaned lease",
            `\n  (a killed helper); it ages out after $DRIVE_PR_CLAIM_STALE_MIN.`,
          );
          if (readyMarkFailures >= 2) {
            console.error(
              `  That is ${readyMarkFailures} in a row, so it is not a blip — stopping rather than`,
            );
            console.error(
              `  driving to --max-rounds on a PR that stays a draft. If no other driver is`,
            );
            console.error(
              `  running, break the lease by hand (drive-state.ts release-ready-mark ${pr})`,
            );
            console.error(
              "  and re-run the drive — NOT `gh pr ready` directly, which fires the remote",
            );
            console.error(
              "  transition but leaves this local lease in place, so a later round can still",
            );
            console.error("  see it as held and report the same contention.");
            // A directive sent WHILE this (successful) pass ran must still
            // be honored before this terminal return: a repeated Ready-mark
            // failure is the one path past a successful pass that does NOT
            // loop back to the next iteration's own checkpoint.
            // `clear`/`resumed` fall through to reporting the
            // repeated-failure stop unchanged;
            // `stopped`/`pause-timeout`/`unreadable` return their own exit
            // code in its place.
            const mailboxAtReadyStop = await mailboxCheckpoint();
            if (typeof mailboxAtReadyStop === "number")
              return mailboxAtReadyStop;
            return 1;
          }
        }
        if (outcome === "marked") markedReadyThisRun = true;
      } else if (rc.code !== 5) {
        readyMarkFailures += 1;
        if (rc.code === 0) {
          console.error(
            `round ${round} completed, but mark-ready.ts reported exit 0 with an unrecognized`,
          );
          console.error(
            `  outcome ('${outcome}') — not one of ${[...MARK_READY_OUTCOMES].join(", ")}.`,
          );
        } else {
          console.error(
            `round ${round} completed, but marking PR #${pr} Ready for review failed (exit ${rc.code}).`,
          );
        }
        if (readyMarkFailures >= 2) {
          console.error(
            `  That is ${readyMarkFailures} in a row, so it is not a blip — stopping rather than`,
          );
          console.error(
            `  driving to --max-rounds on a PR that stays a draft. Mark it by hand`,
          );
          console.error(
            `  (gh pr ready ${pr}), fix what made this fail, and re-run the drive.`,
          );
          // Same as the claimed-by-other stop above — see its own comment for
          // why.
          const mailboxAtReadyFailStop = await mailboxCheckpoint();
          if (typeof mailboxAtReadyFailStop === "number")
            return mailboxAtReadyFailStop;
          return 1;
        }
        console.error(
          "  The next round retries — either the lease was released, or an ambiguous outcome",
        );
        console.error(
          "  left it held on purpose until it can be confirmed or goes stale — stopping only",
        );
        console.error("  if it fails again.");
      }
    }
  }
}

// Guarded, the same way summary-findings.ts guards its own entry (and for the
// portability reason documented there — `import.meta.main` is Bun-only on the
// Node versions this skill supports). Unguarded, merely IMPORTING this module
// ran the whole driver against the importer's argv: a probe of an exported
// helper printed the usage banner, and under a different argv would have taken
// this worktree's drive locks from inside a test run.
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runMain("drive.ts", () => span("drive", {}, main));
}
