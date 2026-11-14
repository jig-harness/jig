/**
 * The drive-status decision — which state a PR-review drive is in, refusing to
 * say "converged" on any evidence weaker than "the finding-posting reviewer
 * completed a review of THIS exact SHA and had nothing left to say".
 *
 * Ordering is load-bearing: liveness first (a merged PR must stop the loop
 * before anything else spends a call), then head sync (judging a stale head is
 * how mode 3 fires), then MERGEABILITY, then the reviewer, then the work.
 *
 * DRAFTNESS used to sit second, as a TERMINAL state (`PR_IS_DRAFT`, exit 10),
 * on the premise that no reviewer arm looks at a draft. That premise is false
 * for the arm `CONVERGED` is actually defined against, and was measured false
 * on 2026-08-13: two PRs created as drafts and never marked Ready each received
 * findings from an in-house reviewer roughly one
 * minute later: its deployment reviews drafts. Whether a reviewer does is a
 * deployment setting, declared by the consumer as `drive.reviews_drafts` and
 * used only to explain a wait. So `isDraft` is now READ AND PUBLISHED, and
 * gates nothing.
 *
 * What stayed true is the OTHER half: CodeRabbit still refuses a draft outright
 * ("Review skipped — Draft detected", measured on the same PRs), and the
 * dormant CI arm still carries `!github.event.pull_request.draft`. That is what
 * the draft→Ready transition exists for, and why it is a transition rather than
 * a gate: the drive works the in-house reviewer's findings first and marks the
 * PR Ready once, so the paid external reviewer spends its one pass on a head
 * that has already had the obvious set cleaned up. `mark-ready.ts` owns it.
 *
 * Mergeability sits ahead of the reviewer because a conflict is precisely what
 * starves the reviewer: GitHub runs no `pull_request`-triggered workflow on a
 * CONFLICTING head, so the posting reviewer's check-run is never created and
 * the reviewer branch below reports AWAITING_REVIEWER — a state documented as
 * "becomes something else with time", which a conflict never does. Measured: 30
 * minutes of 30s polls to `--timeout` on a PR whose work state was already
 * clean.
 *
 * It sits BEHIND head sync because mergeability is a property OF a head, and
 * judging it against a head the local tree has not caught up to is mode 3
 * wearing a different hat. A driver that pushes the base merge and re-polls
 * within GitHub's ~40s replication window would otherwise read the PRE-push
 * CONFLICTING verdict, pass head sync on a coincidence of timing, and report a
 * terminal state for a conflict it had just fixed. Deferring costs at most one
 * HEAD_LAG poll (a conflict does not resolve on its own, so nothing is lost by
 * looking a moment later); reading it too early costs a false terminal on an
 * unattended loop.
 */

import {
  isLeftOpenThread,
  latestCommentUrl,
  openThreadVersions,
} from "./thread-evidence.ts";
export { isLeftOpenThread } from "./thread-evidence.ts";
import { readPrState } from "../pr-state.ts";
import {
  readParkedSets,
  standingProvisionalKeys,
  unlistedReversals,
} from "../provisional.ts";
import {
  reviewerApp,
  reviewerEvidence,
  reviewerExpected,
  reviewerLabel,
  reviewsDrafts,
} from "../overlay.ts";
import { ghCall } from "../proc.ts";
import {
  type CiReport,
  checkRunsFor,
  ciReportFor,
  type ReviewerSticky,
  reviewerRun,
  reviewerStickyMarkers,
  SHA_MARKER,
  summaryFindings,
  type UnresolvedThread,
  unresolvedThreads,
} from "./evidence.ts";
import {
  headSyncState,
  headMismatchReason,
  inheritedReason,
  mayEndWithoutWork,
} from "./inherited-head.ts";
import { resolveMarkerSha, reviewedShaGate, skipNote } from "./reviewed-sha.ts";
import { readHeldEvidence, isFindingHoldCurrent } from "./held-evidence.ts";
import { judgeReviewObject, latestReviewBy } from "./review-object.ts";
import { strandedRunNote } from "./stranded-run.ts";
import { terminal } from "./terminal-states.ts";
import type { WaitingEvaluationCache } from "./waiting-cache.ts";

export interface StatusReport extends CiReport {
  state: string;
  reason: string;
  apiHead: string;
  localHead: string;
  mergeable: string;
  mergeStateStatus: string;
  baseRefName: string;
  headRefName: string;
  baseHead: string;
  /** `null` until the snapshot measured it, for the same reason the work
   * counts below start null: `false` is the claim "GitHub answered, and this
   * PR is Ready for review", and every gate ahead of the snapshot returns
   * without having asked. */
  isDraft: boolean | null;
  reviewerPresent: boolean;
  reviewerStatus: string;
  reviewerConclusion: string;
  reviewedSha: string;
  reviewedShaSource: string;
  /** The work counts start EMPTY ("not measured", JSON null). Zero is a
   * measurement — "the enumerator ran and found none" — and `evaluate()`
   * returns from the liveness, head-sync and reviewer gates long before it
   * enumerates anything. Initialised to 0 these published `unresolvedThreads:
   * 0` from those gates, indistinguishable from a clean round; observed
   * directly while driving a PR whose AWAITING_REVIEWER report said zero while
   * nine threads were live. */
  threadsOpen: number | null;
  threadsParked: number | null;
  summaryTotal: number | null;
  summaryUnaddressed: number | null;
  /** Parked summary-only findings, the finding-side counterpart of
   * `threadsParked`. Published for the same reason that one is: parking is
   * progress, and a consumer that can see it only for threads reads a pass that
   * parked a finding as a pass that did nothing (drive.ts's stall fingerprint
   * stopped a productive drive at exit 13). Both are derived from the same
   * parked-key set below. */
  summaryParked: number | null;
  /**
   * WHICH items are open, not just how many — the unresolved threads' node
   * ids, the unaddressed summary findings' fingerprints, and the parked keys,
   * each sorted so the serialization is order-independent.
   *
   * A cardinality is not an identity, and a consumer comparing two gates on
   * counts alone calls a SUBSTITUTION unchanged: a pass resolves thread A while
   * the reviewer posts thread B, the count stays 1, and every count- derived
   * field is identical across a round that did real work (drive.ts's stall stop
   * then exits 13 claiming nothing changed). The same substitution happens to
   * summary findings, and to a parked item traded for another.
   *
   * `null` carries the same meaning as the counts beside them: not measured.
   */
  openThreadKeys: string[] | null;
  /** Latest comment per open thread; null when a version could not be read. */
  openThreadVersions: [string, string][] | null;
  summaryUnaddressedKeys: string[] | null;
  /** Unaddressed finding holds whose promised fix has no recorded push stamp. */
  summaryHeldUndispatchedKeys: string[] | null;
  parkedItemKeys: string[] | null;
  /**
   * WHICH FILES this round's open findings anchor to — threads AND
   * summary-only findings both, sorted, de-duplicated, `null` when nothing
   * enumerated them (the same not-measured meaning every field above
   * carries, and the same reason it must not be `[]`: an empty array is the
   * positive claim "the reviewer found nothing on any file", which is
   * precisely what a same-file recurrence check must never be told on a
   * gate that returned before enumerating).
   *
   * The durable input to `structuralEscalationDue`. A summary-only
   * finding creates no thread (`summaryFindings` above, and
   * `summary-findings.ts`'s own doc comment on why), so a recurrence signal
   * fed only by threads never arms for one that keeps landing on the same
   * file across rounds — this field is the
   * anchor set the signal is actually documented to cover, not "threads
   * plus a gap". A thread with no `path` — a PR-level comment — contributes
   * nothing, because a signal about one file recurring cannot be fed by a
   * finding that names no file; the same holds for an `unaccounted` summary
   * slot, whose sentinel `'(unknown)'` path names no file either. A PARKED
   * item's path also contributes nothing, whichever kind it is, even while
   * it stays open on GitHub: it is a human decision already made, not a
   * recurring root cause the fix keeps missing, and counting it would arm
   * the signal for as long as the parked item sits there rather than on new
   * evidence.
   */
  openThreadPaths: string[] | null;
}

export interface EvaluateContext {
  pr: string;
  owner: string;
  repo: string;
  botsOnly: boolean;
  headSync: boolean;
  localHead: string;
  /** The witnessed head a pass left work on, unpushed (`inherited-head.ts`). */
  inheritedHead?: string;
  /** Absolute paths to the sibling scripts this decision spawns. */
  driveStateScript: string;
  listThreadsScript: string;
  summaryScript: string;
  helperTimeoutSec: number;
  /** Only polling invocations opt in; --once gathers all evidence directly. */
  waitingCache?: WaitingEvaluationCache;
}

export function emptyReport(): StatusReport {
  return {
    state: "",
    reason: "",
    apiHead: "",
    localHead: "",
    mergeable: "",
    mergeStateStatus: "",
    baseRefName: "",
    headRefName: "",
    baseHead: "",
    isDraft: null,
    reviewerPresent: false,
    reviewerStatus: "",
    reviewerConclusion: "",
    reviewedSha: "",
    reviewedShaSource: "",
    threadsOpen: null,
    threadsParked: null,
    summaryTotal: null,
    summaryUnaddressed: null,
    summaryParked: null,
    openThreadKeys: null,
    openThreadVersions: null,
    summaryUnaddressedKeys: null,
    summaryHeldUndispatchedKeys: null,
    parkedItemKeys: null,
    openThreadPaths: null,
    ci: "",
    failingCheckNames: null,
    failingCheckRunNames: null,
    failingStatusNames: null,
    failingRuns: null,
  };
}

/**
 * One `gh pr view --json <fields>` read. On failure, distinguishes WHY,
 * because the two failures need opposite handling and conflating them was a
 * measured bug:
 *
 *   'missing-field' — `gh` validates a `--json` field list against its own
 *          baked-in schema before making any network call, so this fails
 *          deterministically and client-side with `Unknown JSON field: "..."`
 *          (verified against gh 2.97.0). It is a property of the BINARY, so
 *          it will not clear on a retry: it is an unmet prerequisite, and the
 *          caller exits 2 telling the operator to upgrade.
 *   'transient' — anything else: a timeout, a 5xx, a rate limit, an auth
 *          blip. These DO clear, so they are INDETERMINATE and the caller's
 *          MAX_QUERY_ERRORS retry handles them. Treating one of these as a
 *          missing field would silently disable a real guard on ordinary
 *          network noise — and the evaluation that ran blind can be the one
 *          reporting CONVERGED.
 */
async function tryPrViewFields(
  pr: string,
  fields: string,
): Promise<
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; why: "missing-field" | "transient" }
> {
  const r = await ghCall(["pr", "view", pr, "--json", fields]);
  if (r.code === 0) {
    try {
      return {
        ok: true,
        json: JSON.parse(r.stdout) as Record<string, unknown>,
      };
    } catch {
      return { ok: false, why: "transient" };
    }
  }
  const combined = `${r.stdout}${r.stderr}`;
  if (combined.includes("Unknown JSON field")) {
    return { ok: false, why: "missing-field" };
  }
  return { ok: false, why: "transient" };
}

function str(obj: Record<string, unknown>, field: string): string {
  const v = obj[field];
  return v == null ? "" : String(v);
}

export {
  RECONCILIATION_INTERVAL_SEC,
  RECONCILIATION_REACTIVATION_SEC,
  REVIEW_PUBLICATION_MARGIN_SEC,
  STALLED_MIN_AGE_SEC,
} from "./stranded-run.ts";

export async function evaluate(
  ctx: EvaluateContext,
  report: StatusReport,
): Promise<number> {
  return ctx.waitingCache
    ? ctx.waitingCache.evaluate(ctx, report, () => evaluateFresh(ctx, report))
    : evaluateFresh(ctx, report);
}

/**
 * Do the reviewer gates apply? Only where the repository names an AI reviewer
 * (`reviewerExpected`), and on a head that is not conflicting. A repository
 * that names none has no reviewer evidence to take: the drive converges on
 * threads, summary findings and CI alone, and no check run is the reviewer's
 * because `isReviewerCheck` matches nothing.
 */
function reviewerGatesApply(conflicting: boolean): boolean {
  return !conflicting && reviewerExpected();
}

/**
 * The reviewer's sticky the reviewed-SHA gate judges: an empty one where no
 * reviewer is expected or its evidence is review objects, `null` when the
 * reviewer's comments cannot be read. Reuses the stranded-check-run bypass's
 * read (`earlySticky`) when it made one.
 */
async function reviewerStamp(
  ctx: EvaluateContext,
  earlySticky: ReviewerSticky | null | undefined,
): Promise<ReviewerSticky | null> {
  if (!reviewerExpected() || reviewerEvidence() === "review_object")
    return { sha: "", round: null, updatedAt: "", skip: null };
  if (earlySticky === undefined)
    return reviewerStickyMarkers(ctx.owner, ctx.repo, ctx.pr);
  return earlySticky;
}

/**
 * Convergence needs the reviewer's own stamp, where a reviewer is expected:
 * for this head, or for the head it reviewed before skipping this one
 * (`reviewed-sha.ts`); for a review-object reviewer, its review of this head,
 * or its skip of this draft (`review-object.ts`).
 */
const STAMPS = new Set([
  "comment-marker",
  "skip-notice",
  "review-object",
  "review-check-run",
  "draft-skip",
]);

function lacksReviewerStamp(report: StatusReport): boolean {
  return reviewerExpected() && !STAMPS.has(report.reviewedShaSource);
}

function convergedReasonOf(report: StatusReport): string {
  if (report.reviewedShaSource === "draft-skip")
    return `${reviewerLabel()} skips drafts and has not reviewed ${report.apiHead}: the draft has 0 unresolved threads, 0 unaddressed summary findings. Marking it Ready for review summons that review, which the drive then waits for`;
  if (report.reviewedShaSource === "review-check-run")
    return `${reviewerLabel()} completed its check run on ${report.apiHead} and submitted no review of it, having nothing new to say: 0 unresolved threads, 0 unaddressed summary findings`;
  return reviewerExpected()
    ? `${reviewerLabel()} completed on ${report.apiHead} (reviewed-SHA verified via ${report.reviewedShaSource}), 0 unresolved threads, 0 unaddressed summary findings${skipNote(report)}`
    : `no AI reviewer is configured for this repository (review.reviewer_app, review.reviewer_check_pattern), so no reviewer evidence was required: ${report.apiHead} has 0 unresolved threads, 0 unaddressed summary findings`;
}

async function evaluateFresh(
  ctx: EvaluateContext,
  report: StatusReport,
): Promise<number> {
  // Reset every reported field first. The wait loop calls this repeatedly, and
  // a field left over from an earlier iteration would be published in the JSON
  // contract as though it described THIS one — e.g. `reviewer.present: true`
  // from the pass before the reviewer's check-run vanished from a re-query.
  // The report is what callers act on, so a stale field in it is a correctness
  // bug, not a cosmetic one.
  Object.assign(report, emptyReport(), { localHead: ctx.localHead });

  // Every witness below is measured against `apiHead`, read at the TOP.
  // Between then and any conclusion sit the thread query, the summary
  // enumerator and the check-run reads — each with its own deadline. Another
  // actor pushing anywhere in that window leaves every witness describing a
  // head the PR no longer has. So `stillOnHead` is called before EVERY
  // terminal return, and it is one function rather than a check written out
  // at each of them deliberately: the first version covered `CONVERGED`
  // alone; review then found `HITL_PARKED` — also terminal, also
  // drive-stopping, and returning a few lines earlier — with the same hole. A
  // per-site check would have to be remembered again at the next terminal
  // state anyone adds, which is exactly the class of guard this whole skill
  // exists to move out of memory and into mechanism.
  //
  // NON-terminal returns are deliberately NOT guarded against ordinary
  // staleness (a moved head, a moved base). A stale `ROUND_READY` just
  // re-enumerates against the newer head on the next pass, which is what the
  // loop does anyway; the terminal states are the ones that stop the loop, so
  // they are the ones that must be true at the instant they are claimed.
  // Closure is the one exception — see `closedSinceOpen`, below, which
  // `ROUND_READY` alone also rechecks, because dispatching a round against a
  // PR that has since closed spends a whole triage-fix-push pass on a branch
  // nothing can land on, rather than just re-reading a wasted enumeration.
  //
  // A moved head is head-lag (4), not a failure: it becomes judgeable again
  // as soon as the witnesses are re-gathered, which the wait loop does. An
  // unreadable re-check is INDETERMINATE — never a pass.
  //
  // It rechecks the BASE tip too, not only the head. Mergeability is a
  // function of (head, base), not head alone: `mergeable` is computed against
  // a base SNAPSHOT that GitHub refreshes lazily, and `baseRefOid` names that
  // snapshot. If it changes mid-evaluation, the mergeability verdict gathered
  // at the top describes a base pairing that no longer holds, and a terminal
  // return would rest on it.
  //
  // What this guard proves, EXACTLY — and it is narrower than it first reads:
  // that the (base, mergeability) pair stayed INTERNALLY CONSISTENT across the
  // evaluation. It does NOT prove the base branch's live tip is unchanged, and
  // it deliberately does not try to. Measured (2026-08-05) on a healthy
  // MERGEABLE PR: `baseRefOid` lagged the live `develop` tip, and develop moved
  // again between two measurements minutes apart. Comparing against the live
  // tip, and failing closed when it differs, would refuse to settle on
  // essentially every evaluation against an active base branch: the drive would
  // never converge at all. The lag is the normal state, not the anomaly.
  //
  // That is the right trade because the pair is what the verdict depends on.
  // When GitHub has not yet refreshed `baseRefOid`, it has not recomputed
  // `mergeable` either, so the two still agree with each other; the window
  // this closes is the one where it refreshes BETWEEN the snapshot and the
  // terminal return, leaving them describing different bases. The residual —
  // a live base that has moved but that GitHub has not caught up with — is
  // covered instead by refusing to converge with no mergeability verdict at
  // all, and by re-evaluating each round.
  //
  // ALL THREE — state, head and base — are read TOGETHER, in one call, for
  // the same reason the opening snapshot reads them together: two calls are
  // two instants, and every one of these is part of what the verdict depends
  // on. The first version of this recheck read `headRefOid` alone, which
  // makes the guard blind to the terminal transition it most needs to catch:
  // a PR that MERGES between the liveness check at the top and a terminal
  // return keeps the exact same head, so the head comparison passes and the
  // drive is told CONVERGED / HITL_PARKED / REVIEWER_FAILED about a pull
  // request that is no longer open. That is the required `PR_NOT_OPEN` (5) —
  // the one state that must stop the loop without a push — reported instead
  // as states that do not stop it that way. Liveness, head and base are one
  // observation, so they are read in one call and asserted together,
  // liveness first.
  async function stillOnHead(): Promise<number> {
    const now = await ghCall(
      ["pr", "view", ctx.pr, "--json", "state,headRefOid,baseRefOid"],
      { stderr: "ignore" },
    );
    let parsed: Record<string, unknown> | null = null;
    if (now.code === 0) {
      try {
        parsed = JSON.parse(now.stdout) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    if (parsed === null) {
      return terminal(
        report,
        "INDETERMINATE",
        `cannot re-read #${ctx.pr}'s state, head and base to confirm they did not change while the witnesses were gathered`,
      );
    }
    const stateNow = str(parsed, "state");
    const headNow = str(parsed, "headRefOid");
    if (stateNow === "" || headNow === "") {
      return terminal(
        report,
        "INDETERMINATE",
        `cannot re-read #${ctx.pr}'s state and head to confirm they did not change while the witnesses were gathered`,
      );
    }
    if (stateNow !== "OPEN") {
      return terminal(
        report,
        "PR_NOT_OPEN",
        `#${ctx.pr} became ${stateNow} while this evaluation ran — stop the loop; a push now would be orphaned, and no terminal claim about the review holds on a PR that is no longer open`,
      );
    }
    // Draftness is deliberately NOT re-read here, and its absence from the
    // `--json` list above is the point rather than an omission. This recheck
    // used to trip `PR_IS_DRAFT` on a mid-evaluation flip back to draft,
    // because a terminal claim was only sound while a reviewer was scheduled to
    // look. The posting reviewer reviews drafts (measured — see the module
    // header), so a flip to draft invalidates none of the witnesses `CONVERGED`
    // rests on: the reviewer's own check-run, its reviewed-SHA stamp, and the
    // thread and summary counts all still describe this head and still mean
    // what they meant. Re-reading it to trip on it would now stop a drive over
    // a state change that costs the claim nothing.
    if (headNow !== report.apiHead) {
      return terminal(
        report,
        "HEAD_MOVED",
        `#${ctx.pr} advanced from ${report.apiHead} to ${headNow} while this evaluation ran — every witness above describes the old head, so no terminal claim about it holds`,
      );
    }
    // An EMPTY base is not evidence the base held — it is evidence the recheck
    // could not read it, the same failure mode the head check above already
    // treats as INDETERMINATE rather than "unchanged". Falling through here
    // would let a snapshot whose base half could not be re-verified reach
    // CONVERGED or PR_CONFLICTING anyway.
    const baseNow = str(parsed, "baseRefOid");
    if (baseNow === "") {
      return terminal(
        report,
        "INDETERMINATE",
        `cannot re-read #${ctx.pr}'s base to confirm it did not move while the witnesses were gathered`,
      );
    }
    if (baseNow !== report.baseHead) {
      return terminal(
        report,
        "HEAD_MOVED",
        `#${ctx.pr}'s base (${report.baseRefName}) advanced from ${report.baseHead} to ${baseNow} while this evaluation ran — mergeability and reviewer witnesses above describe the old base, so no terminal claim about it holds`,
      );
    }
    return 0;
  }

  // NON-terminal returns are deliberately not guarded by `stillOnHead` (see
  // the comment at the top of this function) — a stale `ROUND_READY` just
  // re-enumerates against the newer head on the next pass, which the loop
  // does anyway. Closure breaks that trade specifically: unlike ordinary
  // staleness, a `ROUND_READY` dispatches a WHOLE triage-fix-push round to a
  // pass, and a PR that has since merged or closed gives that round nowhere to
  // land — its push is refused by `guarded-push.ts` and its whole cost is
  // spent for nothing.
  //
  // A STANDALONE read, deliberately not the full `stillOnHead`: that also
  // gates on head/base movement, which stays intentionally unguarded on this
  // path — folding it in here would silently reverse that design decision
  // for every ROUND_READY, not just the closure case this exists to close.
  //
  // This ALSO used to trip `PR_IS_DRAFT` on a mid-evaluation flip to draft,
  // which is what it was originally added for; the closure half rode along
  // because GitHub keeps `isDraft` true on a closed draft, so an isDraft-only
  // read could not tell the two apart and `PR_NOT_OPEN` had to win. The posting
  // reviewer reviews drafts (see the module header), so the draft half is gone
  // and the half that rode along is now the whole reason this exists — it is
  // kept, not deleted with its former sibling, because "a round dispatched onto
  // a closed PR is a round spent for nothing" was always an independent
  // justification and is unaffected by the premise that died.
  //
  // Self-contained like `stillOnHead`: sets the report and returns the exit
  // code directly, rather than a boolean the caller has to reinterpret.
  async function closedSinceOpen(): Promise<number> {
    // A conditional REST read, for the same reason the sweep's
    // liveness probe is: state is ALL this asks for, so an unchanged PR answers
    // `304` and spends nothing from the GraphQL bucket. Nothing here is compared
    // against another field of the same response, which is what keeps
    // `stillOnHead` and the opening snapshot on GraphQL.
    const now = await readPrState(ctx.pr, { caller: "recheck" });
    if (!now.ok) {
      return terminal(
        report,
        "INDETERMINATE",
        `cannot re-read #${ctx.pr}'s state to confirm it did not change while the witnesses were gathered (${now.reason})`,
      );
    }
    if (now.state !== "OPEN") {
      return terminal(
        report,
        "PR_NOT_OPEN",
        `#${ctx.pr} became ${now.state} while this evaluation ran — stop the loop; a push now would be orphaned, and no terminal claim about the review holds on a PR that is no longer open`,
      );
    }
    return 0;
  }

  // ONE snapshot for liveness, draft-ness, the head, the base and
  // mergeability. Not fields bolted onto convenience: `mergeable` describes a
  // specific (head, base) pair — see `stillOnHead` above — so reading any of
  // these in a separate call opens a window where they describe different
  // commits, and the mergeability verdict is terminal, so that window is a
  // false-terminal window. `isDraft` rides the same read for the cheaper
  // reason that it costs nothing there and a second call would be a second
  // instant for no gain.
  //
  // Every field in it is REQUIRED OF THE CLI — which is a narrower claim than
  // "every field is validated after the read", and the two are deliberately not
  // the same rule (see the validation block below for which fields are checked
  // and why the rest are not). `mergeable`, `mergeStateStatus`, `baseRefName`,
  // `headRefName` and `baseRefOid` have been in `gh pr view --json` for years,
  // so a `gh` without them is an unmet prerequisite, not a configuration to
  // support: compat shims, dual paths and accepts-both-shapes parsers are ruled
  // out, and an earlier cut of this guard built exactly that — a three-tier
  // CLI-version ladder plus a second REST parser speaking a different response
  // dialect. Each tier then needed its own binding and validation guards, and
  // each of those produced fresh defects. Requiring the fields deletes that
  // whole surface: one path, one dialect, nothing to keep consistent.
  const snapshot = await tryPrViewFields(
    ctx.pr,
    "state,isDraft,headRefOid,mergeable,mergeStateStatus,baseRefName,headRefName,baseRefOid",
  );
  if (!snapshot.ok && snapshot.why === "missing-field") {
    // Liveness FIRST, even here. The contract is "a merged or closed PR stops
    // the loop before anything else", and folding liveness into the combined
    // required-field read broke it: on an unsupported `gh` a finished PR
    // reported a configuration error, so a caller could not tell a PR that is
    // simply done from a CLI it cannot use. `state` alone is supported by every
    // `gh` that has the subcommand, and this costs one call on a path that is
    // otherwise a hard stop anyway.
    const live = await ghCall(
      ["pr", "view", ctx.pr, "--json", "state", "-q", ".state"],
      {
        stderr: "ignore",
      },
    );
    const liveState = live.code === 0 ? live.stdout.trim() : "";
    if (liveState !== "" && liveState !== "OPEN") {
      return terminal(
        report,
        "PR_NOT_OPEN",
        `PR #${ctx.pr} is ${liveState} — stop the loop; a push now would be orphaned (note: this 'gh' also cannot report mergeability, but the PR is finished, so that is moot)`,
      );
    }
    // A property of the BINARY, so it will not clear on a retry. Fail as the
    // configuration error it is, naming the fix, rather than degrading into a
    // weaker guard the caller believes is armed. Reported through the report,
    // never a bare throw: the loop's catch-all branch reports and exits with
    // this code, so the JSON contract holds on every path out of here.
    return terminal(
      report,
      "UNSUPPORTED_CLI",
      "this 'gh' cannot report mergeability or draft state — 'gh pr view --json' rejected one of state,isDraft,headRefOid,mergeable,mergeStateStatus,baseRefName,headRefName,baseRefOid. Every field in that list is required; upgrade the GitHub CLI (gh 2.x supports them all)",
    );
  }
  if (!snapshot.ok) {
    return terminal(
      report,
      "INDETERMINATE",
      `cannot read PR #${ctx.pr} (a transient failure, not a missing-field error) — retrying rather than treating ordinary network noise as an unmet prerequisite`,
    );
  }
  const prJson = snapshot.json;

  const prState = str(prJson, "state");
  if (prState === "") {
    return terminal(
      report,
      "INDETERMINATE",
      `cannot read the state of PR #${ctx.pr}`,
    );
  }
  if (prState !== "OPEN") {
    return terminal(
      report,
      "PR_NOT_OPEN",
      `PR #${ctx.pr} is ${prState} — stop the loop; a push now would be orphaned`,
    );
  }

  report.apiHead = str(prJson, "headRefOid");
  if (report.apiHead === "") {
    return terminal(
      report,
      "INDETERMINATE",
      `cannot read the head SHA of PR #${ctx.pr}`,
    );
  }

  // Draftness is MEASURED AND PUBLISHED here, and gates nothing: a drive on a
  // draft proceeds as on a Ready PR (the module header says why exit 10 is
  // retired). It is still validated as a BOOLEAN, because `mark-ready.ts`
  // decides from it whether the draft→Ready transition is owed, and an absent
  // or null value read as `false` would skip it on the one PR that needs it.
  const draft = prJson.isDraft;
  if (typeof draft !== "boolean") {
    return terminal(
      report,
      "INDETERMINATE",
      `PR #${ctx.pr}'s snapshot succeeded but carried no boolean 'isDraft' (got '${draft === undefined ? "<absent>" : String(draft)}') — refusing to read that as Ready for review`,
    );
  }
  report.isDraft = draft;

  // The witnessed inherited head passes; the round is judged on the API head.
  const sync = await headSyncState(
    ctx.headSync,
    report.apiHead,
    ctx.localHead,
    ctx.inheritedHead ?? "",
    str(prJson, "headRefName"),
  );
  if (sync === "lagging") {
    return terminal(
      report,
      "HEAD_LAG",
      await headMismatchReason(
        report.apiHead,
        ctx.localHead,
        str(prJson, "headRefName"),
      ),
    );
  }

  // A nominally SUCCESSFUL read is validated, not trusted. A partial or
  // malformed response (`mergeable` null, absent or unhandled, or an empty
  // `baseRefOid`) otherwise collapses to `''` and reads as mergeable, or
  // silently disarms the base-race guard.
  //
  // Validation is scoped to the fields a STATE IS DECIDED FROM, deliberately.
  // `mergeable` picks the branch and `baseRefOid` arms the base-race guard, so
  // a bad value in either is a wrong decision and must be INDETERMINATE.
  // `baseRefName`, `headRefName` and `mergeStateStatus` are REPORTED, never
  // branched on HERE: an absent one costs a branch name in a `git merge` hint
  // or a parenthetical in the reason, each degrading to a named "unavailable"
  // where used, and `drive-status.ts`'s best-effort drift measurement already
  // degrades to "no drift published" on an empty `headRefName`. Hard-failing
  // on any of the three would block PR_CONFLICTING over evidence that path
  // does not use. Requiring the fields OF THE CLI (above) and validating the
  // decision evidence (here) are two different rules.
  report.mergeable = str(prJson, "mergeable").toUpperCase();
  report.mergeStateStatus = str(prJson, "mergeStateStatus").toUpperCase();
  if (!["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(report.mergeable)) {
    return terminal(
      report,
      "INDETERMINATE",
      `PR #${ctx.pr}'s snapshot succeeded but carried no handled 'mergeable' value (got '${report.mergeable === "" ? "<empty>" : report.mergeable}') — refusing to read that as mergeable`,
    );
  }
  report.baseRefName = str(prJson, "baseRefName");
  report.headRefName = str(prJson, "headRefName");
  report.baseHead = str(prJson, "baseRefOid");
  if (report.baseHead === "") {
    return terminal(
      report,
      "INDETERMINATE",
      `PR #${ctx.pr}'s snapshot succeeded but carried no 'baseRefOid' — refusing to silently disarm the base-race guard`,
    );
  }

  // `UNKNOWN` is the value GitHub publishes while it recomputes mergeability
  // after ANY push to the PR or its base — including the base-race
  // `stillOnHead` checks for. It is NOT treated as "not conflicting": GitHub
  // has not finished computing an answer at all, so nothing downstream (the
  // reviewer's own witnesses, `CONVERGED`) is safe to trust against it
  // either. Reported as MERGEABILITY_UNKNOWN (exit 4, the same "becomes
  // something else with time" bucket as HEAD_LAG) rather than let it silently
  // fall through to the reviewer/work checks below and risk a terminal claim
  // resting on a mergeability verdict GitHub itself had not settled — the
  // false-CONVERGED sibling of the false-CONFLICTING case this skill exists
  // to prevent.
  //
  // Only CONFLICTING is otherwise acted on. `MERGEABLE` proceeds to the
  // reviewer checks below. There is no fourth possibility: the validation
  // above already rejected anything that is not one of the three.
  //
  // CONFLICTING does NOT return here. It sets a flag and skips the REVIEWER
  // gate — which is the check a conflict starves, and returning
  // AWAITING_REVIEWER from it is a 30-minute wait that ends in nothing — but
  // still enumerates the work below, and only reports PR_CONFLICTING when
  // that enumeration is empty.
  //
  // It does not short-circuit on the premise that "a conflicting head has no
  // findings, because GitHub runs no pull_request CI on it": the live reviewer
  // is not a `pull_request` workflow at all. Its publishing arm is a poller
  // whose eligibility predicate is "base branch, same-repo head, head SHA not
  // yet reviewed", plus drafts where the deployment reviews them (see the
  // module header), and mergeability appears nowhere in it. A poller is not
  // stopped by a conflict, so real findings CAN sit on a conflicting head, and
  // short-circuiting would discard them unread.
  let conflicting = false;
  if (report.mergeable === "CONFLICTING") {
    conflicting = true;
  } else if (report.mergeable === "UNKNOWN") {
    return terminal(
      report,
      "MERGEABILITY_UNKNOWN",
      `PR #${ctx.pr}'s mergeable is UNKNOWN — GitHub is still recomputing it (mergeStateStatus=${report.mergeStateStatus === "" ? "UNKNOWN" : report.mergeStateStatus}); this settles to MERGEABLE or CONFLICTING within seconds and neither is safe to assume in the meantime`,
    );
  }

  // An unreadable check-runs API is INDETERMINATE — but only where the answer
  // is actually needed. On a conflicting head every consumer of the runs is
  // already skipped (the reviewer gates), so hard-failing here let a timeout
  // or a 403 on evidence this path does not use block `PR_CONFLICTING` from
  // ever being reported. The verdict
  // degrades to "unknown" instead, which is what the reporter prints and what
  // announce-merge-ready already refuses to announce on.
  let runs = await checkRunsFor(ctx.owner, ctx.repo, report.apiHead);
  let runsUnreadable = false;
  if (runs === null) {
    if (!conflicting) {
      return terminal(
        report,
        "INDETERMINATE",
        `cannot read check-runs for ${report.apiHead}`,
      );
    }
    runs = [];
    runsUnreadable = true;
  }

  // Bound to the app slug AND a check name, not the app alone: an app may
  // publish several checks on one SHA, and picking "the newest run from this
  // app" would let an unrelated sibling check attest that the review
  // completed. Newest wins within that pair (a re-run, or a cancelled first
  // attempt).
  const reviewer = reviewerRun(runs);

  const awaitReviewer = reviewerGatesApply(conflicting);

  Object.assign(
    report,
    await ciReportFor(
      ctx.owner,
      ctx.repo,
      report.apiHead,
      runs,
      runsUnreadable,
      ctx.pr,
    ),
  );

  // A conflicting head SKIPS every reviewer gate below. Each of them returns
  // AWAITING_REVIEWER (exit 4, "becomes something else with time"), and on a
  // conflicting PR that state polls until `--timeout`. The work enumeration
  // further down still runs, so findings the poller DID post are picked up
  // rather than discarded.
  if (awaitReviewer && reviewer === null) {
    // THIS is modes 2 and 4. Other checks being settled — including a
    // rate-limited CodeRabbit reporting `success` for a review it never ran —
    // is not evidence about the app that posts findings. Absence of the
    // reviewer's check-run is absence of a review, full stop.
    let reason = `no check-run from ${reviewerLabel()} on ${report.apiHead} yet — other checks settling is not evidence it reviewed`;
    // Whether the reviewer looks at drafts is a property of the consumer's
    // reviewer deployment (`drive.reviews_drafts`), not an invariant this
    // skill can check from here. So on a draft specifically, this wait has one
    // cause the others do not: a reviewer that skips drafts will never
    // publish, and this state polls to `--timeout` learning nothing. Named in
    // the reason, not gated on: refusing to drive drafts on the chance that
    // the reviewer skips them is the very stall retiring `PR_IS_DRAFT` removed.
    if (report.isDraft) {
      const drafts = reviewsDrafts();
      reason +=
        drafts === false
          ? `. NOTE: #${ctx.pr} is a draft, and this repository declares that ${reviewerLabel()} does not review drafts (drive.reviews_drafts: false): mark it Ready for review, or this polls to --timeout`
          : drafts === true
            ? `. NOTE: #${ctx.pr} is a draft; this repository declares that ${reviewerLabel()} reviews drafts (drive.reviews_drafts: true). If this polls to --timeout, check that the reviewer's draft setting is still on before assuming it is merely slow`
            : `. NOTE: #${ctx.pr} is a draft, and some reviewers skip drafts (drive.reviews_drafts is not set). If this polls to --timeout, check whether ${reviewerLabel()} reviews drafts before assuming it is merely slow`;
    }
    return terminal(report, "AWAITING_REVIEWER", reason);
  }

  if (reviewer !== null) {
    report.reviewerPresent = true;
    report.reviewerStatus = reviewer.status;
    report.reviewerConclusion = reviewer.conclusion ?? "";
  }

  // Set only by the stranded-check-run bypass below, and appended to
  // whichever terminal reason this evaluation ends up reporting — so a
  // ROUND_READY, CONVERGED or HITL_PARKED reached BECAUSE the bypass fired
  // always says so (the operator can see which witness was used), rather
  // than reading identically to one reached with a normally-completed
  // check-run.
  let stalledCheckRunNote = "";
  // `undefined` = the bypass below never ran (status was not 'in_progress');
  // `null` = it ran and the fetch itself failed; a `ReviewerSticky` = it ran
  // and succeeded. Cached so the reviewed-SHA gate further down reuses this
  // SAME read instead of issuing a second `issues/{pr}/comments` fetch —
  // not merely to save a call, but because two independent fetches open a
  // window for the sticky to change between them, which would let the
  // bypass trust one snapshot while the gate below judges a different one.
  let earlySticky: ReviewerSticky | null | undefined;

  // A reviewer that records its reviews as pull-request reviews is judged on
  // its check run's title and its newest review (`review-object.ts`).
  const byObject = reviewerEvidence() === "review_object";
  if (awaitReviewer && byObject && reviewer !== null) {
    const latest =
      reviewer.status === "completed"
        ? await latestReviewBy(
            ctx.owner,
            ctx.repo,
            ctx.pr,
            `${reviewerApp()}[bot]`,
          )
        : { review: null };
    if (latest === null)
      return terminal(
        report,
        "INDETERMINATE",
        `cannot read ${reviewerLabel()}'s pull-request reviews on #${ctx.pr} — refusing to judge its review of ${report.apiHead} without them`,
      );
    const verdict = judgeReviewObject(
      reviewer,
      latest.review,
      report.apiHead,
      report.isDraft === true,
      reviewerLabel(),
    );
    switch (verdict.state) {
      case "AWAITING_REVIEWER":
        return terminal(report, "AWAITING_REVIEWER", verdict.reason);
      case "STALE_REVIEW":
        return terminal(report, "STALE_REVIEW", verdict.reason);
      case "REVIEW_SKIPPED": {
        const rc = await stillOnHead();
        if (rc !== 0) return rc;
        return terminal(report, "REVIEW_SKIPPED", verdict.reason);
      }
      case "REVIEWER_FAILED": {
        const rc = await stillOnHead();
        if (rc !== 0) return rc;
        return terminal(report, "REVIEWER_FAILED", verdict.reason);
      }
      case "draft-skip":
        report.reviewedShaSource = "draft-skip";
        break;
      default:
        report.reviewedSha = report.apiHead;
        report.reviewedShaSource = verdict.source;
    }
  } else if (awaitReviewer) {
    if (report.reviewerStatus !== "completed") {
      // A check run stuck `in_progress` may be overruled by the sticky it
      // already published (`stranded-run.ts`).
      const stranded = await strandedRunNote(ctx, report, reviewer);
      earlySticky = stranded.sticky;
      stalledCheckRunNote = stranded.note;
      if (stalledCheckRunNote === "") {
        return terminal(
          report,
          "AWAITING_REVIEWER",
          `${reviewerLabel()} check-run on ${report.apiHead} is '${report.reviewerStatus}'`,
        );
      }
    } else {
      // `neutral` is this reviewer's normal conclusion even on a clean run —
      // the check-run summary says "informational only — it never blocks
      // merge" — so it is a completion, not a failure.
      if (report.reviewerConclusion === "skipped") {
        // A conclusion the job never reached. It attested to nothing, unless
        // the reviewer's own sticky carries a skip notice naming this head:
        // that goes on to the reviewed-SHA gate, which decides whether the
        // last review stands for it (`reviewed-sha.ts`). The sticky is read
        // once and shared with that gate.
        earlySticky = await reviewerStamp(ctx, earlySticky);
        const noticeHead =
          earlySticky?.skip == null || earlySticky.sha === ""
            ? ""
            : await resolveMarkerSha(earlySticky.skip.head);
        if (noticeHead !== report.apiHead) {
          return terminal(
            report,
            "AWAITING_REVIEWER",
            `${reviewerLabel()} check-run on ${report.apiHead} was skipped — it never reviewed this head`,
          );
        }
      }
      if (
        report.reviewerConclusion !== "success" &&
        report.reviewerConclusion !== "neutral" &&
        report.reviewerConclusion !== "skipped"
      ) {
        const rc = await stillOnHead();
        if (rc !== 0) return rc;
        return terminal(
          report,
          "REVIEWER_FAILED",
          `${reviewerLabel()} check-run on ${report.apiHead} concluded '${report.reviewerConclusion}' — it may never have posted its findings, so a zero thread count would not mean the round was clean`,
        );
      }
    }
  }

  // A conflicting head skips the reviewed-SHA GATE — every return inside it
  // is STALE_REVIEW (exit 4), the same poll-to-timeout stall as the reviewer
  // gate above, for the same reason: the marker only advances when the
  // reviewer publishes, and nothing here becomes true with time while the
  // conflict sits.
  //
  // It does NOT skip READING the marker. Skipping the read as well threw away
  // the one piece of evidence that says whether a conflicting head's findings
  // are current or left over from an earlier review, so the report claimed
  // nothing either way and a caller could not tell. Gating on it is the wrong
  // answer — that reinstates exactly the stall that ordering mergeability ahead
  // of the reviewer exists to remove, and an unresolved thread is open work
  // regardless of which head it was posted on — so the marker is read,
  // published in the report, and named in the ROUND_READY `reason`. Report, do
  // not gate.
  //
  // Reuses `earlySticky` when the stranded-check-run bypass above already
  // fetched it, rather than issuing a second `issues/{pr}/comments` call —
  // see that variable's own doc comment for why this is about correctness
  // (one snapshot, not two that could disagree), not merely avoiding a call.
  const sticky = await reviewerStamp(ctx, earlySticky);
  let marker: string;
  if (sticky === null) {
    // Where the marker is DECISION evidence, an unreadable one is
    // INDETERMINATE: falling back to the weaker witness would hide a stale
    // reviewed-SHA. Where it is only reported, it degrades to "unknown" rather
    // than blocking PR_CONFLICTING over evidence no gate consumes — the same
    // rule the check-runs read follows.
    if (!conflicting) {
      return terminal(
        report,
        "INDETERMINATE",
        `cannot read the reviewer's comments on #${ctx.pr} — refusing to fall back to the weaker witness, which would hide a stale reviewed-SHA`,
      );
    }
    marker = "";
  } else {
    marker = sticky.sha;
  }

  // What the marker resolves to, independent of whether anything gates on it.
  // Empty when there is no marker, or when an abbreviated one cannot be
  // resolved here — both of which the gate below treats as "not a witness".
  const markerFull = await resolveMarkerSha(marker);

  if (awaitReviewer && !byObject) {
    // Second witness: the reviewer's stamp must name THIS head, or the head
    // it reviewed before skipping this one unchanged (`reviewed-sha.ts`).
    const stop = await reviewedShaGate(
      report,
      marker,
      markerFull,
      sticky?.skip ?? null,
    );
    if (stop?.state === "REVIEW_SKIPPED") {
      const rc = await stillOnHead();
      if (rc !== 0) return rc;
      return terminal(report, "REVIEW_SKIPPED", stop.reason);
    }
    if (stop?.state === "INDETERMINATE")
      return terminal(report, "INDETERMINATE", stop.reason);
    if (stop !== null) return terminal(report, "STALE_REVIEW", stop.reason);
  } else if (marker !== "") {
    // Conflicting: publish the marker as evidence, and NEVER the check-run
    // fallback. That fallback is "queried by SHA, so it always matches" — on
    // a path where no reviewer gate ran, printing it would assert the
    // reviewer reviewed this head on evidence that cannot say so. An absent
    // marker stays absent, which is the honest report.
    report.reviewedSha = markerFull !== "" ? markerFull : marker;
    report.reviewedShaSource = "comment-marker";
  }

  const threads = await unresolvedThreads(
    ctx.listThreadsScript,
    ctx.pr,
    ctx.botsOnly,
    ctx.helperTimeoutSec,
  );
  if (threads === null) {
    return terminal(
      report,
      "INDETERMINATE",
      `cannot enumerate review threads on #${ctx.pr}`,
    );
  }
  report.threadsOpen = threads.length;
  report.openThreadKeys = threads.map((t) => String(t.threadId)).sort();
  report.openThreadVersions = openThreadVersions(threads);

  const summary = await summaryFindings(
    ctx.summaryScript,
    ctx.pr,
    ctx.helperTimeoutSec,
  );
  if (summary === null) {
    return terminal(
      report,
      "INDETERMINATE",
      `cannot enumerate summary-only findings on #${ctx.pr}`,
    );
  }
  report.summaryTotal = summary.total;
  report.summaryUnaddressed = summary.unaddressed.length;
  report.summaryUnaddressedKeys = summary.unaddressed
    .map((f) => String(f.fingerprint))
    .sort();

  // Parked = decided by a human, or waiting on one. Counting them as open work
  // is what makes an autonomous loop wake, re-read the same undeferrable
  // threads, learn nothing, and burn turns forever (measured).
  //
  // A failed read is INDETERMINATE, not an empty set: state that became
  // malformed after startup would otherwise report zero parked items, so a
  // thread awaiting a human reads as live ROUND_READY work and the drive
  // re-arms exactly what a human parked. The empty set is a real answer only
  // when the state says so.
  //
  // drive-state's stderr is PASSED THROUGH: it writes there only what a human
  // must act on (a malformed state, a database a newer plugin needs a newer
  // reader for).
  const parked = await readParkedSets(ctx);
  if (parked === null) {
    return terminal(
      report,
      "INDETERMINATE",
      `cannot read the parked set for #${ctx.pr} — an unreadable parked set would re-arm work a human parked`,
    );
  }
  const parkedKeys = parked.keys;
  report.parkedItemKeys = [...parkedKeys].sort();
  report.threadsParked = threads.filter((t) =>
    parkedKeys.has(String(t.threadId)),
  ).length;
  const provisionalKeys = standingProvisionalKeys(threads, parkedKeys);
  // Computed AFTER parkedKeys: a parked thread is a human decision, not a
  // finding that LANDED on its file again (structuralEscalationDue's premise),
  // so one old parked thread on `a.ts` must not arm every consecutive round
  // pair while it stays parked.
  const summaryLive = summary.unaddressed.filter(
    (f) => !parkedKeys.has(f.fingerprint),
  );
  const summaryParked = summary.unaddressed.length - summaryLive.length;
  report.summaryParked = summaryParked;
  const reversalParked = unlistedReversals(parked.reversals, threads, summary);

  // A thread/finding held for `resolve-held-thread.ts` /
  // `answer-summary-finding.ts` to dispatch (an `accepted` or `moot`
  // disposition, § 3) is triaged work awaiting its own external mutation, not a
  // finding that landed again — the same "already decided, not evidence of
  // recurrence" argument `parkedKeys` makes just above, extended to the third
  // way a thread stays open with nothing new for the next pass to have caused.
  // Reachable from a single transient `resolve-held-thread.ts` failure inside
  // `finish-round.ts`'s drain, or from the reconciliation sweep's own
  // `accepted`/`moot` → re-hold path, which by design does not resolve.
  //
  // Reads the full `held` records rather than `held-keys`' bare key list:
  // `hold`/`restore-held` deliberately distinguish a hold by `(key, outcome,
  // commentUrl)`, never by `key` alone, because a LATER reply on the same
  // thread can supersede the disposition an earlier hold represents without
  // ever clearing that hold (`schema.ts`'s own `HeldItem.commentUrl` doc).
  // Filtering `openThreadPaths` by key alone therefore excluded a thread
  // forever once ANY hold ever landed on it, even after a newer, unrelated
  // finding was posted to the identical thread — a false negative on
  // `structuralEscalationDue`'s own recurrence evidence. `heldByKey` below is
  // compared against each thread's OWN most-recent qualifying comment URL, so
  // only a hold that still matches what is currently on GitHub excludes the
  // thread.
  //
  // Degrades to a STDERR note rather than INDETERMINATE on failure, unlike
  // `parkedKeys` above: an unreadable parked set re-arms work a human parked,
  // but an unreadable held set can only ever OVER-count `openThreadPaths` — the
  // advisory `structuralEscalationDue` input this feeds — never re-arm work a
  // human is waiting on, so failing the whole evaluation over it would be a
  // worse answer than the thing it guards against. Touches `openThreadPaths`
  // only: `threadsParked` and `summaryParked` (and therefore
  // `liveThreads`/`liveSummary` and every
  // ROUND_READY/HITL_PARKED/CONVERGED/PR_CONFLICTING verdict below) are
  // untouched, because a held item is still live work for the round it belongs
  // to — only its RECURRENCE evidence is stale.
  const heldEvidence = await readHeldEvidence(
    ctx.driveStateScript,
    ctx.pr,
    ctx.helperTimeoutSec,
    report.reviewedSha === report.apiHead ? report.apiHead : "",
  );
  report.summaryHeldUndispatchedKeys =
    heldEvidence.reviewRound === null
      ? null
      : summary.unaddressed
          .filter((finding) => {
            const held = heldEvidence.byKey.get(finding.fingerprint);
            return (
              held?.kind === "finding" &&
              (typeof held.verifiedSha !== "string" || held.verifiedSha === "")
            );
          })
          .map((finding) => finding.fingerprint)
          .sort((a, b) => a.localeCompare(b));
  const heldByKey = new Map(
    [...heldEvidence.byKey].map(([key, record]) => [
      key,
      typeof record.commentUrl === "string" ? record.commentUrl : undefined,
    ]),
  );
  // A thread hold's `commentUrl` is REQUIRED by every writer (`hold`,
  // `restore-held` — `schema.ts`'s own doc), so an entry with none is either
  // a `kind: finding` hold sharing no key space with a threadId, or an
  // unreadable/legacy record — either way there is nothing to compare
  // against, so the ORIGINAL key-only behavior applies rather than a
  // three-valued comparison this data cannot support.
  const isThreadHoldCurrent = (t: UnresolvedThread): boolean => {
    const key = String(t.threadId);
    if (!heldByKey.has(key)) return false;
    const heldUrl = heldByKey.get(key);
    if (heldUrl === undefined) return true;
    return latestCommentUrl(t) === heldUrl;
  };

  // Set semantics, matching what `normalizeRoundPaths` will store: three
  // findings on one file in one round is one file. Non-string and empty
  // `path`s are dropped rather than stringified — a PR-level thread has
  // `path: null`, and `"null"` is not a file; an `unaccounted` summary
  // finding has `path: '(unknown)'`, a sentinel that names no file either
  // and is excluded on the same basis.
  //
  // `.trim()` below is used ONLY to detect a whitespace-only path — the
  // filter's own predicate — never to transform the stored identity. Two
  // legitimate, distinct repository paths can differ only by leading or
  // trailing whitespace (`a.ts` vs ` a.ts`), and trimming both into the stored
  // set would alias them to the same recurrence key, arming
  // `structuralEscalationDue` on findings from two different files. The exact
  // GitHub path is the identity that survives into the set.
  report.openThreadPaths = [
    ...new Set([
      ...threads
        .filter((t) => !parkedKeys.has(String(t.threadId)))
        .filter((t) => !isThreadHoldCurrent(t))
        .filter((t) => !isLeftOpenThread(t))
        .filter((t) => !provisionalKeys.has(String(t.threadId)))
        .map((t) => (t as { path?: unknown }).path)
        .filter((p): p is string => typeof p === "string" && p.trim() !== ""),
      ...summaryLive
        .filter((f) => !isFindingHoldCurrent(heldEvidence, f.fingerprint))
        .map((f) => f.path)
        .filter(
          (p): p is string =>
            typeof p === "string" && p.trim() !== "" && p !== "(unknown)",
        ),
    ]),
  ].sort();

  const liveThreads =
    report.threadsOpen - report.threadsParked - provisionalKeys.size;
  const liveSummary = report.summaryUnaddressed - summaryParked;

  // Over unpushed inherited commits only a conflict stops; else push them.
  const liveWork = Math.max(liveThreads, 0) + Math.max(liveSummary, 0);
  if (mayEndWithoutWork(liveWork, sync, conflicting)) {
    // A conflict with NOTHING left to work is unconvergeable: no round can be
    // reviewed, and no amount of waiting changes that. Checked before
    // HITL_PARKED because a merge is a concrete command and a parked item is a
    // question — an operator handed both should be told the mechanical one, and
    // the parked items are named in the reason so nothing is hidden by the
    // precedence.
    if (conflicting) {
      const rc = await stillOnHead();
      if (rc !== 0) return rc;
      return terminal(
        report,
        "PR_CONFLICTING",
        `PR #${ctx.pr} conflicts with its base (mergeable=${report.mergeable}${report.mergeStateStatus !== "" ? `, mergeStateStatus=${report.mergeStateStatus}` : ""}) and has no workable findings on ${report.apiHead} (${report.threadsParked} parked thread(s), ${summaryParked} parked summary finding(s)). Merge ${report.baseRefName !== "" ? report.baseRefName : "the base branch"} into this one, push, and re-run; nothing here becomes judgeable with time`,
      );
    }
    if (report.threadsParked + summaryParked + reversalParked > 0) {
      const rc = await stillOnHead();
      if (rc !== 0) return rc;
      let hitlReason = `every remaining item awaits a human decision (${report.threadsParked} thread(s), ${summaryParked} summary finding(s), ${reversalParked} other reversed provisional decision(s)) — handing back rather than re-arming`;
      if (stalledCheckRunNote !== "") hitlReason += ` — ${stalledCheckRunNote}`;
      return terminal(report, "HITL_PARKED", hitlReason);
    }
    // Convergence needs the reviewer's OWN stamp for this head, never the
    // check-run fallback. The zeroes above are both read out of the sticky
    // comment's neighbourhood: `summary-findings.ts` reads a missing sticky
    // as zero findings, and a review that posted nothing leaves zero threads.
    // So when the check-run completed but its sticky never published — a
    // failed comment write, a changed bot identity, a reviewer whose findings
    // went somewhere this driver cannot see — "no evidence of work" is
    // indexed on the same absence, and the weaker witness cannot tell the two
    // apart.
    //
    // ROUND_READY keeps the fallback: there, the evidence of live work is
    // positive, so a weak SHA witness costs nothing. Only the terminal claim
    // is gated.
    if (lacksReviewerStamp(report)) {
      return terminal(
        report,
        "AWAITING_REVIEWER",
        `${reviewerLabel()} completed on ${report.apiHead} but published no '${SHA_MARKER}' stamp; zero threads and zero summary findings are the same absence, so this is not convergence`,
      );
    }
    const rc = await stillOnHead();
    if (rc !== 0) return rc;
    let convergedReason = convergedReasonOf(report);
    if (stalledCheckRunNote !== "")
      convergedReason += ` — ${stalledCheckRunNote}`;
    return terminal(report, "CONVERGED", convergedReason);
  }

  // Live work exists. Recheck liveness — see `closedSinceOpen` above — before
  // handing the round out at all: dispatching one against a PR that has since
  // merged or closed orphans the round's own push.
  const rc = await closedSinceOpen();
  if (rc !== 0) return rc;

  // On a conflicting head that is still a workable round — the findings are
  // real and the fixes land — so the round is handed out, with the conflict
  // named so the pass knows CI will not run on what it pushes.
  let roundReadyReason = `${liveThreads} unresolved thread(s) and ${liveSummary} unaddressed summary finding(s) on ${report.apiHead}`;
  if (report.summaryHeldUndispatchedKeys?.length)
    roundReadyReason += ` — held but not dispatched: re-hold to dispatch (${report.summaryHeldUndispatchedKeys.join(", ")}); verify the promised fix, then push and finish the round`;
  if (stalledCheckRunNote !== "")
    roundReadyReason += ` — ${stalledCheckRunNote}`;
  roundReadyReason += inheritedReason(sync, ctx.localHead, ctx.inheritedHead);
  if (conflicting) {
    roundReadyReason += ` — NOTE: PR #${ctx.pr} conflicts with its base, so no pull_request CI will run on what this round pushes; merge ${report.baseRefName !== "" ? report.baseRefName : "the base branch"} in as part of the round`;
    // Say, in the reason itself, how current these findings are. The reviewer
    // gates did not run on this path, so the pass has no other way to know —
    // and it changes nothing about whether the work is workable (an
    // unresolved thread is open work on any head), only what the pass should
    // expect to see after it pushes. Stated, not gated.
    if (report.reviewedSha === "") {
      roundReadyReason += `. ${reviewerLabel()} has published no '${SHA_MARKER}' stamp on this PR at all, so these findings cannot be dated — triage them as open work regardless`;
    } else if (report.reviewedSha === report.apiHead) {
      roundReadyReason += `. ${reviewerLabel()} did review this exact head (${SHA_MARKER}=${report.reviewedSha}), so the findings are current`;
    } else {
      roundReadyReason += `. ${reviewerLabel()} last recorded reviewing ${report.reviewedSha}, NOT this head — these findings predate ${report.apiHead} and it may never review a conflicting one, which is why this is reported rather than waited on`;
    }
  }
  return terminal(report, "ROUND_READY", roundReadyReason);
}
