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
 * It sits BEHIND head sync — the one place this departs from an earlier change's
 * sketched order — because mergeability is a property OF a head, and judging
 * it against a head the local tree has not caught up to is mode 3 wearing a
 * different hat. A driver that pushes the base merge and re-polls within
 * GitHub's ~40s replication window would otherwise read the PRE-push
 * CONFLICTING verdict, pass head sync on a coincidence of timing, and report a
 * terminal state for a conflict it had just fixed. Deferring costs at most one
 * HEAD_LAG poll (a conflict does not resolve on its own, so nothing is lost by
 * looking a moment later); reading it too early costs a false terminal on an
 * unattended loop.
 */

// `TRUSTED_ASSOCIATIONS` lives on the CLI module, not `lib/`, the same import
// `reconcile-replied-threads.ts` already makes for the identical reason: one
// set, so this reader and that one cannot disagree about who counts as
// trusted.
import { TRUSTED_ASSOCIATIONS } from "../../summary-findings.ts";
import {
  hasLeaveOpenMarker,
  hasNoOutcomeMarker,
  qualifyingOutcome,
} from "../outcome.ts";
import { readPrState } from "../pr-state.ts";
import { reviewerLabel, reviewsDrafts } from "../overlay.ts";
import { ghCall, git, run, tsArgv } from "../proc.ts";
import {
  checkRunsFor,
  ciVerdictOf,
  commitStatusesFor,
  failingCheckRunNames,
  failingNames,
  failingStatusNames,
  type ReviewerSticky,
  reviewedShaFromComments,
  reviewerRun,
  reviewerStickyMarkers,
  SHA_MARKER,
  summaryFindings,
  type UnresolvedThread,
  unresolvedThreads,
} from "./evidence.ts";
import { terminal } from "./terminal-states.ts";
import type { WaitingEvaluationCache } from "./waiting-cache.ts";

export interface StatusReport {
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
  summaryUnaddressedKeys: string[] | null;
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
  ci: string;
  /**
   * The structured counterpart to `ci` — the individual failing check-run and
   * commit-status names, unparsed. A consumer that needs to test one of these
   * names for exact membership in a known set must read this field rather than
   * re-splitting `ci` on `,`/`;`, which cannot round-trip a name that itself
   * contains either delimiter. `null` mirrors `ci`'s own `unknown:` cases.
   */
  failingCheckNames: string[] | null;
  /**
   * The check-run-only subset of `failingCheckNames` — never legacy commit
   * statuses. A consumer deciding whether a required-named failure is merely
   * "possibly stale" (unconfirmed check-run freshness, `finalCi.code === 4`)
   * must intersect against THIS field, not `failingCheckNames`: the freshness
   * ambiguity only ever applies to a check-run, never to a commit status.
   * `null` mirrors `failingCheckNames`'s own `runsUnreadable` case.
   */
  failingCheckRunNames: string[] | null;
  /**
   * The legacy-commit-status-only complement of `failingCheckRunNames` — the
   * two together partition `failingCheckNames`'s merged, provenance-free output
   * back by source. A consumer exempting a required-named failure as "possibly
   * stale" must also confirm the SAME name is absent from here:
   * `failingCheckRunNames.includes(name)` alone cannot tell a purely
   * check-run-sourced failure from one that ALSO has a fresh, unambiguous
   * commit-status occurrence sharing that name. `null` mirrors
   * `failingCheckNames`'s own `statuses === null` case.
   */
  failingStatusNames: string[] | null;
}

export interface EvaluateContext {
  pr: string;
  owner: string;
  repo: string;
  botsOnly: boolean;
  headSync: boolean;
  localHead: string;
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
    summaryUnaddressedKeys: null,
    parkedItemKeys: null,
    openThreadPaths: null,
    ci: "",
    failingCheckNames: null,
    failingCheckRunNames: null,
    failingStatusNames: null,
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

/**
 * Is this thread a SETTLED decision left open on purpose, rather than live
 * work? `triage-thread.ts --leave-open` posts a qualifying trusted-author reply
 * and deliberately does not resolve the thread (SKILL.md's "Leaving a human
 * thread open" — usually a human thread the driver chose not to close on the
 * author's behalf), so it stays in `list-unresolved-threads.ts`'s output
 * forever by design. On an interactive run without `--bots-only`, such a thread
 * would otherwise re-contribute the same path to `openThreadPaths` every round
 * for as long as the PR stays open, arming `structuralEscalationDue` against a
 * file nothing new landed on — the signal's whole premise is "a finding LANDED
 * again," not "an old, already- triaged thread is still sitting unresolved"
 * (the identical rationale already applied to `parkedKeys` just below this
 * function's call site).
 *
 * The predicate is `reconcile-replied-threads.ts`'s own left-open check,
 * reused rather than re-derived: `hasLeaveOpenMarker` plus a qualifying
 * outcome that is not `accepted` (the marker never legitimately appears on
 * an accepted reply — see that script's own comment) from a
 * `TRUSTED_ASSOCIATIONS` author, scanning comments most-recent-first so a
 * later non-qualifying reply cannot hide an earlier qualifying one.
 *
 * A thread whose comments are truncated (past GitHub's 100-comment cap) is
 * never treated as left-open: a hidden later comment could be the qualifying
 * one, and guessing "not left-open" is the safe direction — it leaves a rare
 * truncated thread counted as live evidence rather than silently discarding
 * evidence on a guess (unreadable input fails closed).
 *
 * A second, narrower case is folded in here rather than left to
 * `structuralEscalationDue`'s `--no-outcome` clarification gap: a trusted
 * author's outcome-less last comment counts as an ask-and-wait clarification
 * ONLY when it carries `NO_OUTCOME_MARKER` (`lib/outcome.ts`), which
 * `reply-to-thread.ts` appends itself whenever `--no-outcome` is passed.
 * `qualifyingOutcome(body) === null` alone is NOT sufficient — that is also
 * true of a trusted OWNER/MEMBER/COLLABORATOR posting arbitrary prose straight
 * on GitHub ("I agree, please fix this"), which never passes through
 * `reply-to-thread.ts` and so can never carry the marker; treating that as a
 * settled clarification silently dropped a genuine finding recurrence from the
 * advisory signal (the original "no other way to reach this outcome-less"
 * premise this comment used to state was itself the bug). When the marker IS
 * present and it is also the thread's MOST RECENT comment, nothing has landed
 * since we asked, so this is an ask-and-wait, not a live finding still open —
 * counting its path would arm `structuralEscalationDue` against a file the fix
 * never touched twice. Checked against the last comment ONLY, never via the
 * backward scan below: the moment anyone replies after it, the thread is live
 * again and must count, which the backward scan's "find the most recent
 * QUALIFYING reply" search does not naturally stop for.
 *
 * A thread's FIRST comment is the finding that OPENED it, never a reply — the
 * outcome-token grammar `reply-to-thread.ts` enforces on a trusted author's
 * comment applies to replies posted after triage, not to the opening comment
 * (see two paragraphs up). A single-comment thread is therefore always an
 * opening finding, whatever its shape: reading it as a left-open marker
 * candidate misclassifies a fresh, live human finding — one an interactive
 * run's OWNER/MEMBER/COLLABORATOR author can post directly, with no reply
 * preceding it — as an already-settled clarification the instant it happens to
 * come from a trusted association, which permanently blinds
 * `structuralEscalationDue` to every fresh human finding on that file.
 * `comments.length < 2` is therefore refused before either check below ever
 * reads `comments[0]` as a candidate.
 *
 * Two adjacent classes are deliberately NOT chased, both already arbitrated: a
 * trusted author hand-typing `NO_OUTCOME_MARKER`'s exact text into a direct
 * post (accident-class only — same principal, same credential as the legitimate
 * producer; `wont-fix`, see `lib/outcome.ts`'s own marker); and reactivating an
 * already-answered merit-outcome `--leave-open` thread on a later rebuttal
 * (`rejected` — see two paragraphs up). This feeds an advisory signal only and
 * fails toward counting a thread as live, never toward silently excluding one.
 */
/**
 * A comment array element is untrusted input (parsed JSON off an external
 * enumerator) and must be shape- checked before any property read — a
 * `null`/non-object element would otherwise throw reading `.authorAssociation`
 * below and take the whole evaluation down with it. ONE guard, used at both
 * read sites in this function, rather than a per-call-site check that only one
 * of them remembers to make.
 */
function asCommentRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : null;
}

// Exported for direct unit testing, the same reason self-inflicted.ts's
// `labelRecord` is: a comment-array shape guard is fixture-testable as a pure
// function, and the real thread producer sanitizes/crashes on a malformed
// comment node before evaluate.ts would ever see one through the full CLI
// pipeline — so only a direct call can exercise this function's own defense
// against one.
export function isLeftOpenThread(t: UnresolvedThread): boolean {
  if ((t as { commentsTruncated?: unknown }).commentsTruncated === true)
    return false;
  const comments = (t as { comments?: unknown }).comments;
  if (!Array.isArray(comments) || comments.length < 2) return false;
  const last = asCommentRecord(comments[comments.length - 1]);
  if (last !== null) {
    const lastAssoc = last.authorAssociation;
    const lastBody = typeof last.body === "string" ? last.body : "";
    if (
      typeof lastAssoc === "string" &&
      TRUSTED_ASSOCIATIONS.has(lastAssoc) &&
      hasNoOutcomeMarker(lastBody) &&
      qualifyingOutcome(lastBody) === null &&
      // Same requirement as the leave-open branch below, and for the identical
      // reason: a trusted human's clarifying question PAUSES this thread's
      // escalation signal, but it does not make the underlying finding stop
      // needing resolution — a bot-started thread awaiting an answer still must
      // not silently drop out of the live-thread count this function feeds, or
      // convergence could finish while it sits unresolved.
      // `confirmedHumanStarted` fails CLOSED (counts as live) on anything that
      // isn't an explicit `true`.
      t.confirmedHumanStarted === true
    ) {
      return true;
    }
  }
  // `i >= 1`, never `0`: index 0 is always the opening comment (see header),
  // so it can never legitimately be the qualifying REPLY this scan looks for.
  for (let i = comments.length - 1; i >= 1; i--) {
    const c = asCommentRecord(comments[i]);
    if (c === null) continue;
    const assoc = c.authorAssociation;
    if (typeof assoc !== "string" || !TRUSTED_ASSOCIATIONS.has(assoc)) continue;
    const body = typeof c.body === "string" ? c.body : "";
    const candidate = qualifyingOutcome(body);
    if (candidate === null) continue;
    // The leave-open marker is human-thread-only by design (SKILL.md's "Leaving
    // a human thread open", `triage-thread.ts --leave-open`'s own documented
    // prohibition) — a bot-started thread must always eventually resolve, so
    // trusting the marker unconditionally here let a mistaken `--leave-open` on
    // a bot thread read as legitimately settled for convergence purposes too
    // (finish-round.ts has the sibling of this exact gap).
    // `confirmedHumanStarted` must be explicitly `true` to grant the exemption
    // — fails CLOSED (counts the thread as live) on anything else, including a
    // missing/malformed field from an enumerator this function does not
    // control. Deliberately not the field's own natural-seeming inverse: a
    // field computed as `__typename !== 'Bot'` would resolve an absent comment,
    // a `null` author, or a missing `__typename` to "not bot" — read here as
    // "confirmed human" when it is actually unreadable. The producer
    // (list-unresolved-threads.ts) computes this field the other way for
    // exactly that reason; see its own header.
    return (
      candidate.outcome !== "accepted" &&
      hasLeaveOpenMarker(body) &&
      t.confirmedHumanStarted === true
    );
  }
  return false;
}

/**
 * The comment url of this thread's MOST RECENT comment, from anyone — not
 * merely the most recent QUALIFYING reply. This is what a thread hold's own
 * `commentUrl` is compared against in the caller below: the reviewer's own
 * example of the bug this closes is itself unqualified — "the reviewer posts
 * a NEW FINDING in the same unresolved thread" is a bot comment with no
 * outcome token, so a comparison scoped to qualifying replies would still
 * read the thread's last comment as the earlier, now-superseded held reply
 * and keep excluding the path. Comparing
 * against the literal last comment catches that: any comment posted after
 * the held one — qualifying or not, from any author — moves the thread's
 * last-comment url off the held value, so the hold no longer describes what
 * is currently on GitHub.
 *
 * `null` on a truncated thread, an empty or unreadable comment array — every
 * one of those is NOT MEASURED, and the caller's own doc states which
 * direction that degrades: never toward silently excluding a thread whose
 * current state could not be checked.
 */
function latestCommentUrl(t: UnresolvedThread): string | null {
  if ((t as { commentsTruncated?: unknown }).commentsTruncated === true)
    return null;
  const comments = (t as { comments?: unknown }).comments;
  if (!Array.isArray(comments) || comments.length === 0) return null;
  const last = asCommentRecord(comments[comments.length - 1]);
  if (last === null) return null;
  const url = last.url;
  return typeof url === "string" && url !== "" ? url : null;
}

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
 * Resolve a `SHA_MARKER` value to a full 40-character object id, or `''` if it
 * is not a witness to anything.
 *
 * The marker grammar admits 7–40 hex (`evidence.ts`), so a bare equality test
 * against a full head SHA answers only for the 40-character case and silently
 * refuses every abbreviated one. Two places need that answer — the
 * stranded-check-run bypass and the reviewed-SHA gate — and they had two
 * different copies of it: the gate resolved abbreviations through git, the
 * bypass compared the raw marker. A uniquely-resolvable abbreviated marker
 * therefore satisfied the gate while never activating the bypass, leaving a
 * stranded run blocked forever — the one case that bypass exists to unblock.
 * One helper, both call sites.
 *
 * `--verify` refuses an ambiguous prefix and `^{commit}` refuses a non-commit,
 * so a non-empty return is always a unique commit in this clone. `''` covers
 * both "no marker" and "an abbreviation this clone cannot resolve" (a shallow
 * clone, an object never fetched, no git at all) — the two are the same thing
 * to every caller, which must treat `''` as fail-closed rather than as a
 * licence to fall back to a prefix comparison.
 */
async function resolveMarkerSha(marker: string): Promise<string> {
  if (marker === "") return "";
  if (marker.length === 40) return marker;
  const rp = await git(
    ["rev-parse", "--verify", "--quiet", `${marker}^{commit}`],
    { stderr: "ignore" },
  );
  return rp.code === 0 ? rp.stdout.trim() : "";
}

export async function evaluate(
  ctx: EvaluateContext,
  report: StatusReport,
): Promise<number> {
  return ctx.waitingCache
    ? ctx.waitingCache.evaluate(ctx, report, () => evaluateFresh(ctx, report))
    : evaluateFresh(ctx, report);
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

  // Draftness is MEASURED AND PUBLISHED here, and gates nothing. It was a
  // terminal state (`PR_IS_DRAFT`, exit 10) on the premise that no reviewer arm
  // looks at a draft; the module header records the measurement that killed
  // that premise for the arm `CONVERGED` is defined against. A drive on a draft
  // now proceeds exactly as it would on a Ready PR.
  //
  // Still validated as a BOOLEAN rather than read for truthiness, and still
  // INDETERMINATE when it is neither. It stopped being a gate but it did not
  // stop being DECISION evidence — `mark-ready.ts` reads this field to decide
  // whether the draft→Ready transition is owed, and `false` is the answer that
  // says "already Ready, nothing to do". An absent or null `isDraft` coerces to
  // exactly that, so accepting a partial response here would silently skip the
  // transition on the one PR that needs it rather than trip. The rule the
  // `mergeable` block below states therefore still applies.
  const draft = prJson.isDraft;
  if (typeof draft !== "boolean") {
    return terminal(
      report,
      "INDETERMINATE",
      `PR #${ctx.pr}'s snapshot succeeded but carried no boolean 'isDraft' (got '${draft === undefined ? "<absent>" : String(draft)}') — refusing to read that as Ready for review`,
    );
  }
  report.isDraft = draft;

  if (ctx.headSync && report.apiHead !== ctx.localHead) {
    return terminal(
      report,
      "HEAD_LAG",
      `API head ${report.apiHead} != local HEAD ${ctx.localHead} — the API has not caught up with the push yet`,
    );
  }

  // A nominally SUCCESSFUL read is validated, not trusted. A partial or
  // malformed response — `mergeable` null/absent/an unhandled enum, or an
  // empty `baseRefOid` — otherwise collapses to `''` and falls through
  // exactly as though the PR were mergeable, or silently disarms the
  // base-race guard.
  //
  // Validation is scoped to the fields a STATE IS DECIDED FROM, and that scope
  // is deliberate rather than an oversight. `mergeable` picks the branch and
  // `baseRefOid` arms the base-race guard, so a bad value in either is a wrong
  // decision and must be INDETERMINATE. `baseRefName`, `headRefName` and
  // `mergeStateStatus` are REPORTED, never branched on HERE: an absent one
  // costs a branch name in a `git merge` hint and a parenthetical in the
  // reason, both of which degrade to a named "unavailable" at the point of use.
  // `headRefName` is additionally consumed by `drive-status.ts`'s own
  // best-effort drift measurement (the branch-identity check beside its
  // ancestor check), which already degrades to "no drift published" on an empty
  // value — a second, narrower branch, not a reason to hard-fail the whole
  // snapshot on it here. Hard-failing on any of the three instead would block
  // PR_CONFLICTING from ever being reported over evidence that path does not
  // use — which is precisely the regression the check-runs read below already
  // had to undo. Requiring the fields OF THE CLI (above) and validating the
  // decision evidence (here) are therefore two different rules, and the prose
  // says so in both places rather than implying one blanket one.
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
  // AWAITING_REVIEWER from it is the 30-minute wait an earlier change exists to end —
  // but still enumerates the work below, and only reports PR_CONFLICTING when
  // that enumeration is empty.
  //
  // The first cut short-circuited here on the premise that "a conflicting
  // head has no findings, because GitHub runs no pull_request CI on it".
  // Review falsified the premise
  // and the sources confirm it: the live reviewer is not a `pull_request`
  // workflow at all: the publishing arm was a poller whose eligibility
  // predicate is "base branch, same-repo head, head SHA not yet reviewed",
  // plus drafts where the deployment reviews them (see the module header),
  // and mergeability appears nowhere in it. A poller is not stopped
  // by a conflict, so real findings CAN sit on a conflicting head, and
  // short-circuiting discarded them unread.
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

  // An unreadable status API is UNKNOWN, never an empty (therefore clean)
  // set: a timeout or a 403 reading as "no legacy statuses exist" would let
  // announce-merge-ready post that every non-reviewer check is green over a
  // status context nobody could see.
  const statuses = await commitStatusesFor(ctx.owner, ctx.repo, report.apiHead);
  report.ci = ciVerdictOf(runs, statuses, runsUnreadable, report.apiHead);
  report.failingCheckNames = failingNames(runs, statuses, runsUnreadable);
  report.failingCheckRunNames = failingCheckRunNames(runs, runsUnreadable);
  report.failingStatusNames = failingStatusNames(statuses);

  // A conflicting head SKIPS every reviewer gate below. Each of them returns
  // AWAITING_REVIEWER (exit 4, "becomes something else with time"), and on a
  // conflicting PR that is the state an earlier change measured polling to
  // `--timeout`. The work enumeration further down still runs, so findings
  // the poller DID post are picked up rather than discarded.
  if (!conflicting && reviewer === null) {
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

  if (!conflicting) {
    if (report.reviewerStatus !== "completed") {
      // Stranded-check-run bypass: a check-run stuck 'in_progress' for hours —
      // a crashed daemon, an exhausted PATCH retry — is indistinguishable from
      // a live one on status alone, and blocking on it unconditionally wedges
      // an unattended drive forever with no terminal state (measured: a
      // check-run sat in_progress 3.5+ hours while the review had already
      // published its sticky, three inline threads and a wind-down entry). The
      // main-line reviewed-SHA gate further down already resolves the head from
      // that same sticky marker (`reviewedShaSource: 'comment-marker'`), and
      // CONVERGED certifies against it; this extends that SAME trust to the one
      // case a check-run exists but is stuck. (It is NOT the no-check-run
      // branch above that establishes the precedent — that branch returns
      // AWAITING_REVIEWER before reading any sticky. The precedent is the gate
      // below.) Conditions, all required:
      //
      //   1. Status is 'in_progress' specifically — never 'queued', which has
      //      not started at all, so there is nothing yet a marker could have
      //      overtaken.
      //   2. The marker names THIS EXACT head — resolved through
      //      `resolveMarkerSha`, so an abbreviated marker is turned into a full
      //      object id before comparing and a mere prefix is never accepted.
      //      Same helper, and therefore the same answer, as the reviewed-SHA
      //      gate below; comparing the raw marker here instead meant an
      //      abbreviated one could never activate the bypass at all. A marker
      //      this clone cannot resolve witnesses nothing and keeps blocking, as
      //      does a genuinely running review whose marker still names an OLDER
      //      head.
      //   3. The sticky's own ai-review-round is NEWER than the round this
      //      drive has already counted (`drive-state.ts rounds`). Named in
      //      the AC, but WEAKER than it reads: the two counters answer
      //      different questions (§ "The reviewer stops after roughly
      //      thirteen or fourteen rounds" below — `rounds` is per-DRIVE and
      //      resets whenever a fresh drive starts, while `ai-review-round` is
      //      cumulative over the PR's whole life), so on a PR with any
      //      pre-drive reviewer history this is close to always-true. Kept
      //      because the AC asks for it and a roundless/malformed sticky
      //      still fails it, but condition 2 (the exact-SHA pin) and 4
      //      (below) are what actually carry the safety margin here — do not
      //      read this one as a real anti-replay check.
      //   4. The STICKY ITSELF was last updated at least
      //      $DRIVE_PR_STALLED_MIN_AGE_SEC ago (default `STALLED_MIN_AGE_SEC`;
      //      a non-positive or non-numeric setting falls back to it rather than
      //      disabling the floor). A review publishes its sticky and its inline
      //      threads as separate GitHub calls, not atomically — reading between
      //      them would see a matching, round-advanced sticky with ZERO threads
      //      and reach a false CONVERGED. The floor has to measure the age of
      //      the EVIDENCE, not of the run: a run stuck for hours trivially
      //      clears any run-age floor while its sticky is edited seconds before
      //      the read, which is exactly the outbox race the floor exists to
      //      exclude and which a `started_at` basis let straight through. The
      //      value itself is pinned to the reviewer service's own
      //      reconciliation window — see `STALLED_MIN_AGE_SEC`, which also
      //      states what this floor still cannot witness.
      //   5. That same sticky POST-DATES the current run's own `started_at`.
      //      Condition 2's exact-SHA pin does not imply this: a re-run on an
      //      UNCHANGED head never rewrites `ai-reviewed-sha`, so a sticky from
      //      an earlier, already-completed review of this very head still names
      //      it. With condition 3 near-vacuous (see above), such a stale sticky
      //      otherwise satisfied every condition the moment the re-run crossed
      //      the age floor — authorizing convergence on evidence the current
      //      attempt never produced. Requiring the evidence to be younger than
      //      the run it is being used to overrule is what actually binds it to
      //      THIS attempt. A run with no parseable `started_at` fails this and
      //      keeps blocking, which is the fail-closed direction.
      let stalled = false;
      if (report.reviewerStatus === "in_progress") {
        const sticky = await reviewerStickyMarkers(ctx.owner, ctx.repo, ctx.pr);
        earlySticky = sticky;
        const stickyFull =
          sticky === null ? "" : await resolveMarkerSha(sticky.sha);
        if (
          sticky !== null &&
          sticky.round !== null &&
          stickyFull !== "" &&
          stickyFull === report.apiHead
        ) {
          const countedRes = await run(
            tsArgv(ctx.driveStateScript, ["rounds", ctx.pr]),
            { stderr: "inherit" },
          );
          const counted =
            countedRes.code === 0
              ? Number.parseInt(countedRes.stdout.trim(), 10)
              : Number.NaN;
          const startedMs =
            reviewer !== null && reviewer.started !== null
              ? Date.parse(reviewer.started)
              : Number.NaN;
          const updatedMs = Date.parse(sticky.updatedAt);
          // Configured value, or the default on anything that is not a positive
          // finite number. NOT `Math.max(0, Number(...))`: that clamp turned an
          // empty-string env var (`Number('') === 0`) and any negative value
          // into `0` — silently DISABLING the floor and reopening the exact
          // outbox race it exists to close, on a misconfiguration that reads at
          // a glance like it set a bound. A non-numeric value already failed
          // closed through `NaN`; these two failed OPEN. The default is the
          // only fallback, because "the operator meant something, we cannot
          // tell what" must not resolve to "no floor at all".
          const configuredMinAge = Number(
            process.env.DRIVE_PR_STALLED_MIN_AGE_SEC ?? STALLED_MIN_AGE_SEC,
          );
          const minAgeSec =
            Number.isFinite(configuredMinAge) && configuredMinAge > 0
              ? configuredMinAge
              : STALLED_MIN_AGE_SEC;
          // The floor is on the sticky's own age (condition 4), NOT the run's:
          // a run stuck for hours clears a run-age floor while its sticky was
          // rewritten seconds ago. `runAgeSec` is reported, never gated on.
          const stickyAgeSec = Number.isFinite(updatedMs)
            ? (Date.now() - updatedMs) / 1000
            : Number.NaN;
          const runAgeSec = Number.isFinite(startedMs)
            ? (Date.now() - startedMs) / 1000
            : Number.NaN;
          if (
            Number.isInteger(counted) &&
            sticky.round > counted &&
            Number.isFinite(stickyAgeSec) &&
            stickyAgeSec >= minAgeSec &&
            // Condition 5. An unparseable `started_at` makes this false (NaN
            // compares false either way), which is the fail-closed direction.
            Number.isFinite(startedMs) &&
            updatedMs > startedMs
          ) {
            stalled = true;
            stalledCheckRunNote = `${reviewerLabel()} check-run on ${report.apiHead} reads 'in_progress' (running ${Math.round(runAgeSec)}s), but its sticky — last updated ${Math.round(stickyAgeSec)}s ago, after that run began — already records round ${sticky.round} reviewing this exact head (${counted} round(s) counted so far) — trusting the comment-marker witness over the stranded check-run`;
          }
        }
      }
      if (!stalled) {
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
        // A conclusion the job never reached. It attested to nothing.
        return terminal(
          report,
          "AWAITING_REVIEWER",
          `${reviewerLabel()} check-run on ${report.apiHead} was skipped — it never reviewed this head`,
        );
      }
      if (
        report.reviewerConclusion !== "success" &&
        report.reviewerConclusion !== "neutral"
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
  const markerRead =
    earlySticky !== undefined
      ? earlySticky === null
        ? null
        : earlySticky.sha
      : await reviewedShaFromComments(ctx.owner, ctx.repo, ctx.pr);
  let marker: string;
  if (markerRead === null) {
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
    marker = markerRead;
  }

  // What the marker resolves to, independent of whether anything gates on it.
  // Empty when there is no marker, or when an abbreviated one cannot be
  // resolved here — both of which the gate below treats as "not a witness".
  const markerFull = await resolveMarkerSha(marker);

  if (!conflicting) {
    // Second witness. When the reviewer has stamped a reviewed-SHA anywhere on
    // this PR, that stamp must name THIS head; a stamp naming an older commit
    // is the stale-review signature (checks read settled, review was of the
    // previous push).
    if (marker !== "") {
      report.reviewedSha = marker;
      report.reviewedShaSource = "comment-marker";
      // This is the SECOND WITNESS, and the contract it witnesses is "the
      // reviewer reviewed THIS EXACT head". A prefix comparison does not
      // establish that: the marker grammar admits 7–40 hex, and any commit
      // sharing the head's first N characters satisfies it — so a stale review
      // of a DIFFERENT commit is accepted as fresh, which is precisely the
      // stale-review signature this witness exists to catch. 7 hex is 28 bits;
      // on a repository this size that is a birthday-bound coincidence, not an
      // impossibility.
      //
      // So: a full 40-char marker is compared for equality (what the reviewer
      // actually emits today), and an abbreviated one is RESOLVED to its full
      // object id before comparing. `--verify` refuses an ambiguous prefix,
      // and `^{commit}` refuses a non-commit. If it cannot be resolved — a
      // shallow clone, a fetch that never brought the object, no git at all —
      // the marker is not a witness to anything, and the honest report is
      // that we cannot confirm this head was reviewed. Fail closed: an
      // unverifiable stamp costs a round, an accepted wrong one costs the
      // whole guard.
      if (marker.length === 40) {
        if (marker !== report.apiHead) {
          return terminal(
            report,
            "STALE_REVIEW",
            `${reviewerLabel()} last recorded reviewing ${marker}, but the PR head is ${report.apiHead}`,
          );
        }
      } else {
        if (markerFull === "") {
          return terminal(
            report,
            "STALE_REVIEW",
            `${reviewerLabel()} recorded reviewing the abbreviated ${marker}, which cannot be resolved to a full commit id here — refusing to accept a prefix of the PR head (${report.apiHead}) as proof it reviewed this commit`,
          );
        }
        report.reviewedSha = markerFull;
        if (markerFull !== report.apiHead) {
          return terminal(
            report,
            "STALE_REVIEW",
            `${reviewerLabel()} last recorded reviewing ${marker} (${markerFull}), but the PR head is ${report.apiHead}`,
          );
        }
      }
    } else {
      // No stamp anywhere — fall back to the check-run, which was queried BY
      // SHA and therefore always matches. Weaker evidence, so it is labelled
      // as such in the report rather than passed off as a second witness, and
      // it is NOT enough to converge on: see the guard just before CONVERGED
      // below.
      report.reviewedSha = report.apiHead;
      report.reviewedShaSource = "check-run";
    }
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
  // drive-state's stderr is PASSED THROUGH, not discarded. It writes there
  // only to say something a human has to act on — a malformed state file, or
  // a worktree-private state file orphaned by the git-dir migration — and
  // that second one is a ONE-TIME warning guarded by a durable marker.
  // Swallowing it here consumed the single showing invisibly and left the
  // marker claimed, so every later human-visible `rounds`/`get` stayed silent
  // about state holding parked human decisions. This is the FIRST
  // drive-state call of an evaluation, so it is the one that reliably ate it.
  const parkedRes = await run(
    tsArgv(ctx.driveStateScript, ["parked-keys", ctx.pr]),
    {
      stderr: "inherit",
    },
  );
  if (parkedRes.code !== 0) {
    return terminal(
      report,
      "INDETERMINATE",
      `cannot read the parked set for #${ctx.pr} — an unreadable parked set would re-arm work a human parked`,
    );
  }
  const parkedKeys = new Set(
    parkedRes.stdout.split("\n").filter((k) => k.length > 0),
  );
  report.parkedItemKeys = [...parkedKeys].sort();
  report.threadsParked = threads.filter((t) =>
    parkedKeys.has(String(t.threadId)),
  ).length;
  // Computed here, AFTER parkedKeys is known, and not alongside the other
  // thread-derived fields above: a parked thread is a human decision, not a
  // recurring root cause the fix keeps missing, and structuralEscalationDue's
  // whole premise is "a finding LANDED on this file again" — not "an item a
  // human already triaged is still sitting on GitHub, un-resolved because
  // resolving it is not this signal's job". Left
  // out, a single old thread parked on `a.ts` would arm every consecutive
  // round pair for as long as it stays parked, with nothing new for the pass
  // to have caused or to fix.
  const summaryLive = summary.unaddressed.filter(
    (f) => !parkedKeys.has(f.fingerprint),
  );
  const summaryParked = summary.unaddressed.length - summaryLive.length;
  report.summaryParked = summaryParked;

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
  const heldRes = await run(tsArgv(ctx.driveStateScript, ["held", ctx.pr]), {
    stderr: "inherit",
    timeoutSec: ctx.helperTimeoutSec,
  });
  let heldByKey: Map<string, string | undefined>;
  let heldKeys: Set<string>;
  if (heldRes.code !== 0) {
    console.error(
      `evaluate: could not read the held set for #${ctx.pr} — proceeding without excluding held items from recurrence evidence`,
    );
    heldByKey = new Map();
    heldKeys = new Set();
  } else {
    heldByKey = new Map();
    try {
      const parsed = JSON.parse(heldRes.stdout) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const rec = asCommentRecord(entry);
          if (rec === null) continue;
          const key = rec.key;
          if (typeof key !== "string" || key === "") continue;
          const commentUrl = rec.commentUrl;
          heldByKey.set(
            key,
            typeof commentUrl === "string" ? commentUrl : undefined,
          );
        }
      }
    } catch {
      console.error(
        `evaluate: held state for #${ctx.pr} is not readable JSON — proceeding without excluding held items from recurrence evidence`,
      );
    }
    heldKeys = new Set(heldByKey.keys());
  }
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
        .map((t) => (t as { path?: unknown }).path)
        .filter((p): p is string => typeof p === "string" && p.trim() !== ""),
      ...summaryLive
        .filter((f) => !heldKeys.has(f.fingerprint))
        .map((f) => f.path)
        .filter(
          (p): p is string =>
            typeof p === "string" && p.trim() !== "" && p !== "(unknown)",
        ),
    ]),
  ].sort();

  const liveThreads = report.threadsOpen - report.threadsParked;
  const liveSummary = report.summaryUnaddressed - summaryParked;

  if (liveThreads <= 0 && liveSummary <= 0) {
    // A conflict with NOTHING left to work is the unconvergeable state
    // an earlier change exists to report: no round can be reviewed, and no amount of
    // waiting changes that. Checked before HITL_PARKED because a merge is a
    // concrete command and a parked item is a question — an operator handed
    // both should be told the mechanical one, and the parked items are named
    // in the reason so nothing is hidden by the precedence.
    if (conflicting) {
      const rc = await stillOnHead();
      if (rc !== 0) return rc;
      return terminal(
        report,
        "PR_CONFLICTING",
        `PR #${ctx.pr} conflicts with its base (mergeable=${report.mergeable}${report.mergeStateStatus !== "" ? `, mergeStateStatus=${report.mergeStateStatus}` : ""}) and has no workable findings on ${report.apiHead} (${report.threadsParked} parked thread(s), ${summaryParked} parked summary finding(s)). Merge ${report.baseRefName !== "" ? report.baseRefName : "the base branch"} into this one, push, and re-run; nothing here becomes judgeable with time`,
      );
    }
    if (report.threadsParked > 0 || summaryParked > 0) {
      const rc = await stillOnHead();
      if (rc !== 0) return rc;
      let hitlReason = `every remaining item awaits a human decision (${report.threadsParked} thread(s), ${summaryParked} summary finding(s)) — handing back rather than re-arming`;
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
    if (report.reviewedShaSource !== "comment-marker") {
      return terminal(
        report,
        "AWAITING_REVIEWER",
        `${reviewerLabel()} completed on ${report.apiHead} but published no '${SHA_MARKER}' stamp; zero threads and zero summary findings are the same absence, so this is not convergence`,
      );
    }
    const rc = await stillOnHead();
    if (rc !== 0) return rc;
    let convergedReason = `${reviewerLabel()} completed on ${report.apiHead} (reviewed-SHA verified via ${report.reviewedShaSource}), 0 unresolved threads, 0 unaddressed summary findings`;
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
  if (stalledCheckRunNote !== "")
    roundReadyReason += ` — ${stalledCheckRunNote}`;
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
