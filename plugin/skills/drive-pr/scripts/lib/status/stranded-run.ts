/**
 * The stranded-check-run bypass of the sticky-comment reviewer evidence
 * (`evaluate.ts`), and the reviewer service's recovery timings its age floor
 * is derived from.
 */
import { run, tsArgv } from "../proc.ts";
import { reviewerLabel } from "../overlay.ts";
import type { EvaluateContext, StatusReport } from "./evaluate.ts";
import {
  type CheckRun,
  type ReviewerSticky,
  reviewerStickyMarkers,
} from "./evidence.ts";
import { resolveMarkerSha } from "./reviewed-sha.ts";

/**
 * How often a self-hosted reviewer service runs its reconciliation pass
 * ("every 15 min").
 */
export const RECONCILIATION_INTERVAL_SEC = 15 * 60;

/**
 * How old a still-unposted head must be before that pass reactivates it
 * (the same service: "a still-eligible head … after 30 min → reactivate").
 *
 * A THRESHOLD, not a deadline — it is only ever evaluated when a pass runs, so
 * a head crossing it just after one waits out the rest of the interval too.
 */
export const RECONCILIATION_REACTIVATION_SEC = 30 * 60;

/**
 * Upper end of a review's own observed duration (§ 3: "a 4–15-minute review").
 *
 * Reactivation only re-queues the work; the sticky is not rewritten and the
 * inline threads are not posted until the re-run actually reaches publication.
 */
export const REVIEW_PUBLICATION_MARGIN_SEC = 15 * 60;

/**
 * Default for `$DRIVE_PR_STALLED_MIN_AGE_SEC`: how old the reviewer's sticky
 * must be before it may overrule a stranded `in_progress` check-run.
 *
 * Derived from the REVIEWER SERVICE's own recovery timings above, never picked
 * for feel and never written as a bare number. The service publishes through
 * an outbox (`publishing` → post → `posted`), so a worker that dies between
 * writing its sticky and posting its inline threads is repaired by the service
 * itself — and the only question this floor answers is whether the drive waits
 * long enough for that repair to have happened rather than racing it.
 *
 * Waiting long enough means all three terms, which is why they are summed
 * rather than picked from:
 *
 *   - the reactivation THRESHOLD, the age at which the pass acts at all;
 *   - one full pass INTERVAL, because that threshold is only evaluated when a
 *     pass runs — a head crossing it moments after one is not reactivated
 *     until the next, so worst-case detection is threshold + interval, not
 *     threshold;
 *   - one review's PUBLICATION margin, because reactivation merely re-queues:
 *     until the re-run publishes, the sticky is still stale and the threads
 *     are still absent, which is exactly the state that converges falsely.
 *
 * Two earlier values got this wrong in the same direction. 600s was under even
 * the first term, so the bypass could converge falsely through the whole
 * 10-to-30-minute gap. 2100s cleared the threshold but silently dropped the
 * other two terms, leaving the same false convergence reachable from roughly 35
 * to 60 minutes.
 *
 * This is still a MITIGATION, and the finding behind it is right that elapsed
 * time can never be a completion witness: if the service's repair fails
 * permanently (a `failed` row past its retry budget) it raises `/fail` to a
 * human and nothing re-posts, so a long-enough wait still ends in a bypass
 * over threads that will never arrive. What bounds that residual is the
 * service alarming, not this constant. The cost of the larger value is only
 * that a genuinely stranded run blocks an hour instead of ten minutes —
 * against the 3.5+ hour incident this bypass was built for, still cheap.
 */
export const STALLED_MIN_AGE_SEC =
  RECONCILIATION_REACTIVATION_SEC +
  RECONCILIATION_INTERVAL_SEC +
  REVIEW_PUBLICATION_MARGIN_SEC;

/**
 * Stranded-check-run bypass: a check-run stuck 'in_progress' for hours —
 * a crashed daemon, an exhausted PATCH retry — is indistinguishable from
 * a live one on status alone, and blocking on it unconditionally wedges
 * an unattended drive forever with no terminal state (measured: a
 * check-run sat in_progress 3.5+ hours while the review had already
 * published its sticky, three inline threads and a wind-down entry). The
 * main-line reviewed-SHA gate in `evaluate.ts` already resolves the head from
 * that same sticky marker (`reviewedShaSource: 'comment-marker'`), and
 * CONVERGED certifies against it; this extends that SAME trust to the one
 * case a check-run exists but is stuck. (It is NOT the no-check-run
 * branch that establishes the precedent — that branch returns
 * AWAITING_REVIEWER before reading any sticky. The precedent is the
 * reviewed-SHA gate.) Conditions, all required:
 *
 *   1. Status is 'in_progress' specifically — never 'queued', which has
 *      not started at all, so there is nothing yet a marker could have
 *      overtaken.
 *   2. The marker names THIS EXACT head — resolved through
 *      `resolveMarkerSha`, so an abbreviated marker is turned into a full
 *      object id before comparing and a mere prefix is never accepted.
 *      Same helper, and therefore the same answer, as the reviewed-SHA
 *      gate; comparing the raw marker here instead meant an
 *      abbreviated one could never activate the bypass at all. A marker
 *      this clone cannot resolve witnesses nothing and keeps blocking, as
 *      does a genuinely running review whose marker still names an OLDER
 *      head.
 *   3. The sticky's own ai-review-round is NEWER than the round this
 *      drive has already counted (`drive-state.ts rounds`). Named in
 *      the AC, but WEAKER than it reads: the two counters answer
 *      different questions (§ "The reviewer stops after roughly
 *      thirteen or fourteen rounds" in
 *      `references/terminal-states.md` — `rounds` is per-DRIVE and
 *      resets whenever a fresh drive starts, while `ai-review-round` is
 *      cumulative over the PR's whole life), so on a PR with any
 *      pre-drive reviewer history this is close to always-true. Kept
 *      because the AC asks for it and a roundless/malformed sticky
 *      still fails it, but condition 2 (the exact-SHA pin) and 4
 *      (below) are what actually carry the safety margin here — do not
 *      read this one as a real anti-replay check.
 *   4. The STICKY ITSELF was last updated at least
 *      $DRIVE_PR_STALLED_MIN_AGE_SEC ago (default `STALLED_MIN_AGE_SEC`;
 *      a non-positive or non-numeric setting falls back to it rather than
 *      disabling the floor). A review publishes its sticky and its inline
 *      threads as separate GitHub calls, not atomically — reading between
 *      them would see a matching, round-advanced sticky with ZERO threads
 *      and reach a false CONVERGED. The floor has to measure the age of
 *      the EVIDENCE, not of the run: a run stuck for hours trivially
 *      clears any run-age floor while its sticky is edited seconds before
 *      the read, which is exactly the outbox race the floor exists to
 *      exclude and which a `started_at` basis let straight through. The
 *      value itself is pinned to the reviewer service's own
 *      reconciliation window — see `STALLED_MIN_AGE_SEC`, which also
 *      states what this floor still cannot witness.
 *   5. That same sticky POST-DATES the current run's own `started_at`.
 *      Condition 2's exact-SHA pin does not imply this: a re-run on an
 *      UNCHANGED head never rewrites `ai-reviewed-sha`, so a sticky from
 *      an earlier, already-completed review of this very head still names
 *      it. With condition 3 near-vacuous (see above), such a stale sticky
 *      otherwise satisfied every condition the moment the re-run crossed
 *      the age floor — authorizing convergence on evidence the current
 *      attempt never produced. Requiring the evidence to be younger than
 *      the run it is being used to overrule is what actually binds it to
 *      THIS attempt. A run with no parseable `started_at` fails this and
 *      keeps blocking, which is the fail-closed direction.
 *
 * `note` says why the stranded run was overruled, `""` when it was not.
 * `sticky` is the sticky this read, for the reviewed-SHA gate to reuse:
 * `undefined` when it read none (the run is not `in_progress`), `null` when
 * the read failed.
 */
export async function strandedRunNote(
  ctx: Pick<EvaluateContext, "owner" | "repo" | "pr" | "driveStateScript">,
  report: StatusReport,
  reviewer: CheckRun | null,
): Promise<{ note: string; sticky: ReviewerSticky | null | undefined }> {
  if (report.reviewerStatus !== "in_progress")
    return { note: "", sticky: undefined };
  const sticky = await reviewerStickyMarkers(ctx.owner, ctx.repo, ctx.pr);
  if (sticky === null || sticky.round === null) return { note: "", sticky };
  const stickyFull = await resolveMarkerSha(sticky.sha);
  if (stickyFull === "" || stickyFull !== report.apiHead)
    return { note: "", sticky };
  const counted = await countedRounds(ctx);
  const note = overruledNote(report, reviewer, sticky, sticky.round, counted);
  return { note, sticky };
}

/** The rounds this drive has counted (`drive-state.ts rounds`), `NaN` when unreadable. */
async function countedRounds(
  ctx: Pick<EvaluateContext, "pr" | "driveStateScript">,
): Promise<number> {
  const countedRes = await run(
    tsArgv(ctx.driveStateScript, ["rounds", ctx.pr]),
    { stderr: "inherit" },
  );
  return countedRes.code === 0
    ? Number.parseInt(countedRes.stdout.trim(), 10)
    : Number.NaN;
}

/**
 * The age floor in seconds: the configured value, or the default on anything
 * that is not a positive finite number. NOT `Math.max(0, Number(...))`: that
 * clamp turned an empty-string env var (`Number('') === 0`) and any negative
 * value into `0` — silently DISABLING the floor and reopening the exact
 * outbox race it exists to close, on a misconfiguration that reads at a
 * glance like it set a bound. A non-numeric value already failed closed
 * through `NaN`; these two failed OPEN. The default is the only fallback,
 * because "the operator meant something, we cannot tell what" must not
 * resolve to "no floor at all".
 */
function minAgeSec(): number {
  const configured = Number(
    process.env.DRIVE_PR_STALLED_MIN_AGE_SEC ?? STALLED_MIN_AGE_SEC,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : STALLED_MIN_AGE_SEC;
}

/** Seconds since the instant `ms`, `NaN` when it is not one. */
function secondsSince(ms: number): number {
  return Number.isFinite(ms) ? (Date.now() - ms) / 1000 : Number.NaN;
}

/**
 * Conditions 3 to 5 over a sticky that names this head: the note overruling
 * the stranded run, `""` when one of them fails.
 */
function overruledNote(
  report: StatusReport,
  reviewer: CheckRun | null,
  sticky: ReviewerSticky,
  round: number,
  counted: number,
): string {
  const startedMs =
    reviewer?.started == null ? Number.NaN : Date.parse(reviewer.started);
  const updatedMs = Date.parse(sticky.updatedAt);
  // The floor is on the sticky's own age (condition 4), NOT the run's: a run
  // stuck for hours clears a run-age floor while its sticky was rewritten
  // seconds ago. The run's age is reported, never gated on.
  const stickyAgeSec = secondsSince(updatedMs);
  const fresh =
    Number.isInteger(counted) &&
    round > counted &&
    Number.isFinite(stickyAgeSec) &&
    stickyAgeSec >= minAgeSec();
  // Condition 5. An unparseable `started_at` makes this false (NaN compares
  // false either way), which is the fail-closed direction.
  if (!fresh || !Number.isFinite(startedMs) || !(updatedMs > startedMs))
    return "";
  return `${reviewerLabel()} check-run on ${report.apiHead} reads 'in_progress' (running ${Math.round(secondsSince(startedMs))}s), but its sticky — last updated ${Math.round(stickyAgeSec)}s ago, after that run began — already records round ${round} reviewing this exact head (${counted} round(s) counted so far) — trusting the comment-marker witness over the stranded check-run`;
}
