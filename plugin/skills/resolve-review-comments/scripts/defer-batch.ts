#!/usr/bin/env bun
/**
 * Find-or-create the per-PR+Type BATCH follow-up issue for a deferred review
 * finding, append the finding as a self-contained entry, and print the issue
 * link for the `**deferred**` reply — the mechanized path behind
 * references/deferral-protocol.md § Batching is the default.
 *
 * Batching is the protocol's default because filing a fresh issue per finding
 * is the path of least resistance mid-round, and left to that path almost
 * nothing gets batched. This script makes the batch cheaper than a fresh issue
 * — one command, no Linear UI, an idempotent append.
 *
 * Usage:
 *   defer-batch.ts [--batch] <PR#> <type> \
 *     (--thread-url <url> | --comment-url <url> --fingerprint <marker-safe>) \
 *     --reason <text> \
 *     --severity <blocker|high|medium|low|unknown> --category <cat|unknown> \
 *     --originating <TEAM-1234|none> [--team <KEY>] \
 *     [--fix <text>] [--size xs|small] [--repo-label <name>] \
 *     [--labels a,b] [--no-parent --no-parent-reason <text>] \
 *     [--repo-slug owner/name] [--dry-run]   < finding.txt
 *
 *   `--severity` is REQUIRED, matching `--reason`/`--originating` — the bug
 *   this closes (follow-up issues filed with no Linear priority) is severity
 *   being silently dropped, so an optional flag would just reproduce the same
 *   failure with an escape hatch. It sets
 *   the batch's Linear `priority` field (see `SEVERITY_TO_PRIORITY`) on both
 *   the CREATE and APPEND paths, escalating an existing batch's priority but
 *   never downgrading it. Same vocabulary and flag name as
 *   `triage-ladder.ts --severity`, imported from `./lib/ladder.ts` rather than
 *   re-pinned.
 *
 *   `--category` is REQUIRED, matching `--severity` — mirrors
 *   `triage-ladder.ts`'s own requirement: an omitted flag is
 *   indistinguishable from an explicit `unknown` and could silently discard a
 *   real parsed value. It is recorded in the entry text only
 *   (`**Category**: <token>`) — it has no Linear label side-effect.
 *   When reviewer emission is available, pass `unknown` explicitly only for
 *   a finding whose reviewer genuinely emitted no `🏷️ category:` tag — never
 *   as a stand-in for an omitted flag.
 *
 *   `--dry-run` previews without writing, and resolves and validates every
 *   label first — a preview that skipped that printed "would create" for a
 *   command the real run aborts.
 *
 *   <type> is the Type-group label the batched findings share, from the
 *   repository's declared taxonomy (bug, feature, infra, docs, chore) — it is
 *   in the title because it is the lookup key.
 *   The reviewer's FINDING text is read from STDIN, never from an argument:
 *   review text routinely contains backticks/$( )/$VAR that a shell argument
 *   would evaluate or drop before the script runs (the same reason reply bodies use stdin). Use a quoted heredoc (<<'EOF') or a file.
 *
 *   `--thread-url` must be a review-thread permalink on THIS repository and
 *   THIS PR. A summary-only finding instead uses `--comment-url` for the PR
 *   conversation-comment permalink plus the reviewer's stable marker-safe
 *   `--fingerprint`. The source is both the audit backlink and the basis of
 *   the idempotency key, so a URL from anywhere else files the entry under a
 *   key no later run for the real finding can match. `--reason`, `--fix` and
 *   `--no-parent-reason` are rendered as raw Markdown and must be SINGLE
 *   LINES — a newline in one forges the `### <url>` heading that keys the
 *   append, which would report a later real deferral as already present.
 *
 * Behaviour:
 *   - FIND: searches open issues whose title is exactly
 *     `PR #<N> <type> review follow-ups` (case-insensitive) — keyed on the
 *     TITLE, deliberately not on `pr-followup`, because filtering by that
 *     label made a batch missing it invisible and the helper then minted a
 *     second issue under a key that already had one; it is a run-independent
 *     mandatory label, so the batch is found and the label reconciled onto it
 *     — AND which do not
 *     carry a DIFFERENT Repo label — the title carries no repository, so
 *     another repo's PR of the same number and Type mints an identically
 *     titled batch, and appending to it files the deferral into someone
 *     else's backlog. A candidate carrying NO Repo label ABORTS the run: it
 *     is ambiguous rather than ours, and claiming it would both misfile the
 *     finding and stamp that issue with this repo's label. A candidate whose
 *     TYPE disagrees with the title aborts too — Type is the lookup key, so
 *     the batch is mislabelled and appending would file the finding under a
 *     Type that decides which findings may share the batch. An API failure
 *     ABORTS — it is never read as "not found", because create-on-error is how
 *     duplicate batch keys are minted . A TRUNCATED page aborts for the same reason: a batch sitting
 *     past the requested page reads as absent, and the helper would mint a
 *     second issue under the key it exists to keep unique — so every Linear
 *     connection this script reads is checked for `hasNextPage` and refuses
 *     rather than acting on a partial view. Two open issues under one key is
 *     a pre-existing defect: the oldest wins the append and the others are
 *     named on stderr. Find-then-create is likewise not atomic and Linear has
 *     no unique-title constraint, so two runs that both saw no candidate both
 *     create. That cannot be PREVENTED here for the same reason the append
 *     race cannot, but it is NOTICED: a create re-queries the key afterwards
 *     and names any duplicate loudly, so the run that made the mess reports it
 *     rather than leaving it for whoever reads the tracker next. Merging them
 *     stays a human call — closing someone else's issue is not a deferral
 *     helper's decision.
 *   - CREATE (when absent): title per the protocol; labels = `pr-followup` +
 *     <type> + size (default `small`) + consumer-configured repo label +
 *     the originating issue's inherited context labels (`agent:*`,
 *     `domain:*`, `codearea:*`) + `--labels` extras; parent = the originating
 *     issue's own parent (one level up, per the protocol — `--no-parent`
 *     for the domain-mismatch judgment, which requires `--no-parent-reason`
 *     because the protocol files a parentless follow-up only with the
 *     mismatch stated in its description); on the protocol's PARENTLESS rows,
 *     the originating issue's project and milestone, so the follow-up stays
 *     in its planning context; a `related` link back to the originating
 *     issue — unless the originating issue is ITSELF an epic (it carries the
 *     workspace's `epic` flag label — that label and nothing else, since a
 *     child-bearing issue is usually a mid-tree grouping with a real epic
 *     parent), which is a row of the
 *     protocol's table in its own right: that batch is filed PARENTLESS with
 *     the originating issue's project and milestone, so a nested epic's batch
 *     is not silently hung off the grandparent. Any required label the
 *     workspace cannot resolve aborts the
 *     create, as does a `<type>` outside the repository's DECLARED Type
 *     taxonomy (`BATCH_TYPES`, loaded from consumer configuration) or a `<type>`/`--size`/`--repo-label` that is not actually
 *     in Linear's Type/Size/Repo group — the two answer different questions,
 *     "is it one of ours" and "is it a Type at all" — a `--labels` extra that sits
 *     in one of those single-valued groups (it would file two Size labels on
 *     one issue), and a create with no `agent:*`/`domain:*`/`codearea:*`
 *     label to apply — a batch issue filed without its mandatory groups is
 *     tracker noise with provenance. The Context check is the PREFIX filter,
 *     not a count of labels supplied: `--labels manual-ops` supplies a label
 *     without supplying a context one.
 *   - APPEND: adds the entry (source-backed identity heading, quoted finding, reason,
 *     optional fix sketch) to the description. Idempotent on the entry's
 *     HEADING LINE (`### <key>`), not on a substring search for the URL: one
 *     thread URL is a prefix of another (`…_r1` inside `…_r10`) and a URL
 *     quoted inside a neighbouring finding matches too, either of which
 *     reports `alreadyPresent` for a finding never recorded. The
 *     read-modify-write is not atomic and Linear takes a WHOLE description,
 *     so a concurrent writer's replacement can erase this entry. `labelIds` is
 *     a whole-set replacement for the same reason, so a concurrent run can
 *     equally erase the labels this one added. BOTH effects are therefore
 *     VERIFIED by re-reading the issue after the write and rebuilding from
 *     what is live — the description re-appended, the label set re-UNIONed
 *     against the latest read rather than a stale snapshot — up to a small
 *     retry bound, aborting rather than reporting success if either did not
 *     survive. Without that, the loser of the race printed a ready
 *     `**deferred**` reply, and `labelsAdded` claimed a reconciliation that
 *     never persisted.
 *
 *     What is verified is the CLAIM the reply makes, not this run's own
 *     edits: the entry is checked even when it was already present and this
 *     run appended nothing (a concurrent replacement can erase a PRE-EXISTING
 *     entry), and the label check is the whole batch contract via
 *     `batchContractHolds` rather than just the labels this run added (a
 *     replacement can drop a mandatory label that predates the run, which a
 *     "did my additions land" test never asks about). The verification
 *     therefore runs even on the nothing-to-write path, since that path still
 *     prints a ready reply.
 *
 *     That verification NARROWS the race; it does not close it, and it must
 *     not be read as a guarantee. The interleaving A-write → A-verify →
 *     B-write(stale) → B-verify passes on both sides while B has already
 *     erased A's entry. Closing it needs compare-and-swap or a lock, and
 *     Linear's API offers neither — `issueUpdate` has no conditional form,
 *     and a filesystem lock would only serialize runs on ONE machine, which
 *     is a guarantee this script cannot make about where it is invoked from.
 *     What the verification does buy is that the COMMON interleavings become
 *     a loud abort instead of a silent loss. The residual is a genuinely
 *     concurrent second writer on the same PR+Type batch.
 *   - RECONCILE (on every append, not only at create): the batch is brought
 *     back to the contract each run, because create is several effects and
 *     only the first is retried by find-or-create. Missing CONTEXT labels
 *     (`inherited` + `--labels`) are added ONLY once ownership is settled —
 *     an incoming `agent:`/`domain:` set that shares NO label at all with the
 *     batch's own aborts before reconciliation runs at all
 *     (`ownerDomainMismatches`), per the protocol's different-owner rule
 *     (lines 105-108); any overlap counts as shared ownership, since both
 *     groups are multi-valued (`pick: "1-3"`) and ordinary triage can add a
 *     second label to an already-filed batch. `codearea:*` is exempt from
 *     that check and reconciles additively regardless. A single-valued group (Type/Size)
 *     that is ABSENT is filled, while a differing SIZE is kept and reported —
 *     the group is satisfied, both values are legitimate, and adding the
 *     second label would violate the taxonomy in the name of repairing it. A
 *     differing Type aborts instead, per FIND above; Repo never reaches here;
 *     and MORE THAN ONE label in any single-valued group aborts, since that
 *     group is then not satisfied at all and which value governs is
 *     undecidable. Reconciliation is deliberately scoped to what has a
 *     RUN-INDEPENDENT correct value — the mandatory label groups, and a
 *     `related` link to this run's originating issue, which is additive —
 *     `pr-followup` included, since a batch that lost it stops being
 *     discoverable at all. It
 *     does NOT touch the batch's PLACEMENT (parent epic, project, milestone):
 *     those are single-valued and belong to whichever originating issue filed
 *     the batch FIRST, so a later run's originating issue is not authoritative
 *     over them and repairing them would reparent the batch under whichever
 *     epic happened to defer last. A
 *     missing `related` link back to the originating issue is created —
 *     without which an `issueRelationCreate` that failed after a successful
 *     create left the batch permanently unlinked, since the next run takes
 *     the append branch and nothing there retried it. The Context group FAILS
 *     CLOSED here exactly as at create: a batch with no context label that
 *     this run cannot repair aborts rather than warning, because the operator
 *     can re-run with `--labels` — the refusal is retryable, whereas a warning
 *     ships a `**deferred**` reply for a batch that still violates the
 *     contract.
 *   - DRY-RUN reports what each path WOULD do and returns `dryRun: true` from
 *     both, never the ordinary success output — that output carries a ready
 *     `**deferred**` reply, and a caller acting on it resolves a thread whose
 *     finding was never persisted.
 *
 * Every mutation's `success` is CHECKED. Linear returns `success: false`
 * without a top-level GraphQL error, so discarding it reports a persisted
 * entry that does not exist — and the caller resolves the review thread with
 * no tracked finding behind it.
 *
 * Output (stdout, JSON): { identifier, url, title, created, appended,
 * alreadyPresent, labelsAdded, relatedLinked } — plus a ready-to-adapt
 * `**deferred**` reply line on stderr. Exit 0 on success, 2 on usage, 1 on
 * API/env failure.
 *
 * Auth: LINEAR_API_TOKEN (the repo's script-side convention —
 * consumer environment), with
 * LINEAR_API_KEY accepted as a fallback (the name many environments export). Calls are bounded at 30s each, mirroring GH_CALL_TIMEOUT.
 *
 * On Windows, invoke through the runtime (`bun defer-batch.ts …`) — a shebang
 * only carries the POSIX direct-execution path.
 */

import { readOverlay, reviewConfig, withSource } from "./lib/consumer.ts";
import {
  DEFAULT_TRACKER_LABELS,
  parseTrackerLabels,
} from "./lib/tracker-labels.ts";
import { fail, readStdinAll, runMain } from "./lib/cli.ts";
import {
  CANONICAL_SEVERITIES,
  CATEGORY_UNKNOWN,
  SEVERITY_UNKNOWN,
} from "./lib/ladder.ts";

const LINEAR_API = "https://api.linear.app/graphql";
const LINEAR_TIMEOUT_MS = 30_000;

/**
 * How long the WHOLE run may spend on Linear calls before it is aborted
 * outright, rather than left to the retry loop's attempt count alone.
 *
 * `APPEND_ATTEMPTS` bounds the number of attempts, not the duration of any one
 * awaited `linear(...)` call — a stalled request could otherwise pin the
 * unattended drive loop forever. `LINEAR_TIMEOUT_MS` already caps a single
 * `fetch`, but that cap lived only inside `makeClient`, one implementation of
 * the `LinearClient` port; nothing in the PORT's own type required it, so a
 * test double (or a future client) had no obligation to honor any bound at all,
 * and no caller could bound the loop AS A WHOLE rather than call-by-call.
 * Threading a caller-supplied deadline through the port makes the guarantee
 * part of the CONTRACT every implementation must honor — `makeClient` combines
 * it with its own per-call timeout via `AbortSignal.any`, and `appendWithRetry`
 * checks it directly so a stalled or endlessly-retried run aborts instead of
 * blocking past this ceiling. Generous relative to `LINEAR_TIMEOUT_MS` *
 * `APPEND_ATTEMPTS` (30s × 3 = 90s of pure call time) to leave room for the
 * `RETRY_MAX_MS`-bounded backoff between attempts and the label/relation calls
 * outside the retry loop.
 */
export const RUN_DEADLINE_MS = 5 * 60_000;

/**
 * Consumer-declared taxonomy: live workspace groups are also validated before
 * writing. Read when the module loads, so an importer in a repository without
 * configuration gets the defaults; running the command there refuses in
 * `main` with the configuration error instead of a stack trace.
 */
let consumerError: string | undefined;
const consumer = (() => {
  try {
    return reviewConfig();
  } catch (error) {
    consumerError = error instanceof Error ? error.message : String(error);
    return {} as ReturnType<typeof reviewConfig>;
  }
})();
export const BATCH_SIZES = consumer.taxonomy?.sizes ?? ["xs", "small"];
/**
 * The follow-up and epic labels: `issue_tracker.labels`, else the older
 * `review.taxonomy` fields, else the defaults (`lib/tracker-labels.ts`).
 */
const labels = (() => {
  try {
    const overlay = readOverlay();
    try {
      return parseTrackerLabels(overlay);
    } catch (error) {
      throw withSource(overlay, ["issue_tracker", "review"], error);
    }
  } catch (error) {
    consumerError ??= error instanceof Error ? error.message : String(error);
    return DEFAULT_TRACKER_LABELS;
  }
})();
export const PROVENANCE_LABEL = labels.followup;
export const EPIC_LABEL = labels.epic;
export const BATCH_REPOS = consumer.taxonomy?.repos ?? [];
export const BATCH_TYPES = consumer.taxonomy?.types ?? [];
export const REVIEW_CATEGORIES = consumer.taxonomy?.categories ?? [];
const CONTEXT_PREFIXES = consumer.taxonomy?.context_prefixes ?? [];
const OWNERSHIP_PREFIXES = consumer.taxonomy?.ownership_prefixes ?? [];

/**
 * Is this Size label one a BATCH may carry? Shared by the pre-write gate and
 * the post-write contract check so the two cannot disagree about which sizes
 * are batchable — the same reason `hasEntry` is shared with `appendEntry`.
 */
export function isBatchableSize(name: string): boolean {
  return (BATCH_SIZES as readonly string[]).includes(name);
}

/**
 * Linear's `priority` field for each severity token — the priority-preservation
 * rule: without it, follow-up issues carry no priority at all, because severity
 * is accepted by the deferral tooling and then silently dropped on the floor
 * rather than written anywhere.
 *
 * Linear defines urgent=1, high=2, medium=3, low=4, none=0. A blocker maps
 * to urgent because ranking it below high would understate the one severity
 * that should never have been deferred at all (see the contradiction warning
 * in runDeferBatch). The consumer's severity mapping is tested against this
 * map so the deferral and triage tools cannot disagree about priority.
 *
 * This map is a BIJECTION onto Linear's full `{0,1,2,3,4}` priority domain —
 * every priority value has exactly one severity token that produces it, which
 * is what makes `PRIORITY_TO_SEVERITY` (its total, well-defined inverse)
 * possible below.
 */
export const SEVERITY_TO_PRIORITY: Record<string, number> = {
  [SEVERITY_UNKNOWN]: 0, // None
  low: 4,
  medium: 3,
  high: 2,
  blocker: 1, // Urgent
};

// Fails CLOSED at import time if this map's key set ever drifts from the
// canonical severity vocabulary. Unlike `SEVERITY_RANK_ORDER` (derived from
// `CANONICAL_SEVERITIES` below), this map's VALUES — Linear priority numbers
// — have no derivable relationship to severity tokens, so the map itself
// must stay hand-written; only its key set can be checked against the
// accepted vocabulary. Without this, a canonical severity token added to
// `lib/ladder.ts` with no matching entry here parses fine in `parseArgs`
// (which validates against `CANONICAL_SEVERITIES` directly) and then
// silently produces `undefined` from `SEVERITY_TO_PRIORITY[token]` —
// `priorityAfterSeverity` returns `undefined`, so CREATE sends no `priority`
// field at all and the severity is accepted and then dropped, exactly the
// failure class the other boundaries already reject
// (concurrent-write regression).
{
  const expected = new Set([...CANONICAL_SEVERITIES, SEVERITY_UNKNOWN]);
  const actual = new Set(Object.keys(SEVERITY_TO_PRIORITY));
  const missing = [...expected].filter((s) => !actual.has(s));
  const extra = [...actual].filter((s) => !expected.has(s));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `defer-batch: SEVERITY_TO_PRIORITY's keys no longer match the canonical severity vocabulary` +
        `${missing.length > 0 ? ` — missing [${missing.join(", ")}]` : ""}` +
        `${extra.length > 0 ? ` — stale [${extra.join(", ")}]` : ""}. ` +
        `Update SEVERITY_TO_PRIORITY (and PRIORITY_TO_SEVERITY) to match CANONICAL_SEVERITIES/SEVERITY_UNKNOWN.`,
    );
  }
}

/**
 * The inverse of `SEVERITY_TO_PRIORITY`. Well-defined and total because
 * Linear's `priority` field only ever holds one of exactly `{0,1,2,3,4}`, and
 * `SEVERITY_TO_PRIORITY` is a bijection onto that set — every live priority
 * this script ever reads back from Linear resolves to exactly one severity
 * token here.
 *
 * Needed by `priorityAfterSeverity`/`priorityReflectsSeverity`: a batch's
 * LIVE `priority` is a Linear priority NUMBER, not a severity token, so
 * answering "does this priority already reflect at least this severity"
 * requires converting it back to a severity first and comparing RANKS (see
 * `SEVERITY_RANK_ORDER`) — comparing the raw numbers directly is wrong (see
 * that constant's own doc).
 */
export const PRIORITY_TO_SEVERITY: Record<number, string> = {
  0: SEVERITY_UNKNOWN,
  4: "low",
  3: "medium",
  2: "high",
  1: "blocker",
};

/**
 * Severity, weakest→strongest, `unknown` lowest of all.
 *
 * Deliberately NOT `SEVERITY_TO_PRIORITY`'s own values, and not derivable
 * from them by numeric comparison: those are Linear PRIORITY numbers, where a
 * lower number is MORE urgent (1 Urgent, 4 Low) except for 0 (None), which is
 * numerically the lowest of all despite being the LEAST severe — the absence
 * of a priority, not a real one. Comparing `SEVERITY_TO_PRIORITY` values
 * directly to decide "which severity is more severe" is therefore wrong in
 * two different ways at once. This is the explicit rank table
 * `severityRank`/`priorityAfterSeverity`/`priorityReflectsSeverity` use
 * instead of ever touching the priority numbers for that comparison.
 *
 * DERIVED from `CANONICAL_SEVERITIES` (already weakest-first per
 * `lib/ladder.ts`'s own doc), not a second hand-copy of it: `parseArgs`
 * validates `--severity` against `[...CANONICAL_SEVERITIES, SEVERITY_UNKNOWN]`
 * — a hand-maintained literal here could silently drift from that list if a
 * token is ever added there, and the failure mode is exactly the bug this
 * file exists to close: `severityRank` would return `-1` (`indexOf` on a miss)
 * for the new token, making `priorityReflectsSeverity` true against EVERY live
 * priority (so a batch is never escalated) and `SEVERITY_TO_PRIORITY[token]`
 * `undefined` (so CREATE sends no `priority` field at all) — severity accepted
 * and then silently dropped, fail-open where the other boundaries already
 * fail closed.
 */
export const SEVERITY_RANK_ORDER = [SEVERITY_UNKNOWN, ...CANONICAL_SEVERITIES];

/** Where `severity` sits on `SEVERITY_RANK_ORDER` — higher is more severe. */
export function severityRank(severity: string): number {
  return SEVERITY_RANK_ORDER.indexOf(severity);
}

/**
 * Does a batch's LIVE `priority` field already imply a severity at least as
 * severe as `severity`? Converts the live Linear priority number back to its
 * severity token via the total `PRIORITY_TO_SEVERITY` map and compares RANKS
 * (`severityRank`), never the raw priority numbers — see
 * `SEVERITY_RANK_ORDER`'s own doc for why a numeric comparison would be
 * wrong. `?? SEVERITY_UNKNOWN` is defensive only: every priority this script
 * ever reads back from Linear is one of the five `PRIORITY_TO_SEVERITY` keys.
 */
export function priorityReflectsSeverity(
  currentPriority: number,
  severity: string,
): boolean {
  const currentSeverity =
    PRIORITY_TO_SEVERITY[currentPriority] ?? SEVERITY_UNKNOWN;
  return severityRank(currentSeverity) >= severityRank(severity);
}

/**
 * The priority a batch's live `priority` field SHOULD have once it also
 * reflects `severity` — NEVER a downgrade, only an escalation or a no-op.
 *
 * A batch may already carry a MORE severe priority than the finding being
 * added (an earlier, worse finding in the same batch), and that must be
 * preserved rather than overwritten down to this finding's own weaker
 * severity — the same "keep the stronger of the two" contract
 * `missingSingleValued`'s Size handling documents for a different field.
 */
export function priorityAfterSeverity(
  currentPriority: number,
  severity: string,
): number {
  if (priorityReflectsSeverity(currentPriority, severity)) {
    return currentPriority;
  }
  const priority = SEVERITY_TO_PRIORITY[severity];
  if (priority === undefined) throw new Error(`Unknown severity '${severity}'`);
  return priority;
}

/** How many times an append re-reads and retries against a concurrent writer. */
export const APPEND_ATTEMPTS = 3;

/** First retry's base pause, doubling per attempt up to `RETRY_MAX_MS`. */
export const RETRY_BASE_MS = 250;
/** Ceiling on one retry's pause, so `APPEND_ATTEMPTS` can never stall a run. */
export const RETRY_MAX_MS = 2_000;

/**
 * How long to wait before retry number `attempt + 1`.
 *
 * Retrying with NO pause puts every attempt's label lookup, mutation and
 * verification into the same instant as the concurrent writer this loop
 * exists to outlast — maximising the chance all `APPEND_ATTEMPTS` collide
 * with one another and burning Linear API quota on writes that were always
 * going to lose. Exponential so a persistent writer gets progressively more
 * room, CLAMPED at `RETRY_MAX_MS` so a bounded retry count stays a bounded
 * wall-clock, and JITTERED across the lower half so two runs that collided once
 * do not re-collide in lockstep on every later attempt.
 */
export function retryBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const capped = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  return Math.round(capped * (0.5 + random() / 2));
}

/**
 * The pause between retries, injectable so tests do not sleep for real.
 *
 * `signal` is OPTIONAL and exists only so `realSleep` can clear its own
 * timer promptly on abort (see its own doc) — a test double is free to
 * ignore it entirely, exactly as before this parameter existed; the actual
 * cross-implementation cancellation guarantee is `sleepUnlessAborted`, the
 * caller's OUTER race, not this parameter.
 */
export type Sleeper = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * A plain `setTimeout` left uncleared when the abort side of the caller's race
 * won instead kept a live timer on the event loop — and `runMain` deliberately
 * sets `process.exitCode` rather than calling `process.exit()` (so pending
 * stdout writes flush), so the CLI process did not actually exit until that
 * leaked timer fired, up to `RETRY_MAX_MS` after the run had already aborted.
 * Checking `aborted` synchronously first (a signal already aborted before this
 * call would never fire a LATER `'abort'` event), and removing its own listener
 * on the timer's NORMAL completion too: `{ once: true }` alone only
 * self-removes a listener when the event actually FIRES, so on every ORDINARY
 * retry (the timer winning, not the signal aborting — the common case) the
 * listener from an earlier attempt stayed registered on the shared,
 * run-lifetime `signal` for the rest of the run. Bounded by `APPEND_ATTEMPTS`,
 * not unbounded, but real.
 */
const realSleep: Sleeper = (ms, signal) => {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

/**
 * Races `sleeper(ms)` against `signal` aborting, cleaning up after itself
 * either way — the call site's half of the same listener-leak class
 * `realSleep` closes for its own half (see that function's own doc).
 *
 * A bare `Promise.race([sleeper(ms), abortedPromise])` left THIS side's
 * `{ once: true }` `'abort'` listener registered on `signal` for the rest of
 * the run every time `sleeper` won instead (the ordinary, non-aborted retry) —
 * self-removal via `{ once: true }` only fires when the event actually does.
 * Registering exactly one listener and removing it in a `finally` once the race
 * settles, regardless of which side won, closes that gap independently of which
 * `Sleeper` is injected (a test double that ignores `signal` gets the same
 * cleanup here).
 *
 * Still the reason this races at all rather than a bare
 * `await sleeper(ms, signal)`: `appendWithRetry`'s `checkDeadline` only runs
 * BEFORE and AFTER the retry pause, not during it, so a deadline firing WHILE
 * asleep between attempts must wake this wait immediately — not wait out the
 * full pause — for the very next `checkDeadline` call to catch it promptly, and
 * that guarantee must hold even against a `Sleeper` double that does not itself
 * look at `signal` at all.
 */
async function sleepUnlessAborted(
  ms: number,
  signal: AbortSignal,
  sleeper: Sleeper,
): Promise<void> {
  if (signal.aborted) return;
  // Placeholder reassigned synchronously below, before this function ever
  // awaits — the Promise executor runs immediately.
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([sleeper(ms, signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The protocol's lookup key: Type is in the title deliberately. */
export function batchTitle(pr: string, type: string): string {
  return `PR #${pr} ${type} review follow-ups`;
}

/**
 * Does an existing issue title carry this PR+Type batch key? Case-insensitive
 * and whitespace-trimmed — a hand-filed batch issue may vary casing, and a
 * near-miss that spawns a SECOND issue under the same key recreates exactly
 * the noise batching exists to eliminate.
 */
export function isBatchTitle(title: string, pr: string, type: string): boolean {
  return title.trim().toLowerCase() === batchTitle(pr, type).toLowerCase();
}

export interface EntryInput {
  sourceUrl: string;
  /** The exact heading-key idempotency marker; defaults to `sourceUrl`. */
  entryKey?: string;
  finding: string;
  reason: string;
  /** A `SEVERITY_RANK_ORDER` token — always rendered, even `unknown`. */
  severity: string;
  /** A `REVIEW_CATEGORIES` token, or `unknown` — always rendered. */
  category: string;
  fix?: string;
}

/**
 * One self-contained entry, per the protocol's description contract: the
 * review source, the reviewer's finding quoted, severity, category, and the
 * deferral reason — enough to act on without re-reading the PR.
 *
 * `**Severity**`/`**Category**` are rendered UNCONDITIONALLY, even when
 * category is `unknown` — matching `.config/review-triage.yaml`'s own
 * documented stance that an `unknown` category (a finding whose reviewer
 * emitted no `🏷️ category:` tag) is deliberate and safe. Hiding the line for
 * `unknown` would make a genuinely-unmeasured category indistinguishable
 * from an entry rendered before this field existed at all.
 */
export function renderEntry(e: EntryInput): string {
  const quoted = e.finding
    .trimEnd()
    .split("\n")
    .map((l) => `> ${l}`.trimEnd())
    .join("\n");
  const entryKey = e.entryKey ?? e.sourceUrl;
  const lines = [entryHeading(entryKey), ""];
  if (entryKey !== e.sourceUrl) {
    lines.push(`**Source comment**: ${e.sourceUrl}`, "");
  }
  lines.push(
    quoted,
    "",
    `**Severity**: ${e.severity}`,
    `**Category**: ${e.category}`,
    `**Why deferred**: ${e.reason}`,
  );
  if (e.fix !== undefined && e.fix !== "") {
    lines.push(`**Fix sketch**: ${e.fix}`);
  }
  return lines.join("\n");
}

/** The one line that marks an entry as present — `renderEntry`'s own heading. */
export function entryHeading(entryKey: string): string {
  return `### ${entryKey}`;
}

/** Where this skill's PRs live; `--repo-slug` covers a fork. */
export const DEFAULT_REPO_SLUG = consumer.repo_slug ?? "";

/**
 * The shape a `--thread-url` must have: a GitHub review-thread permalink on
 * THIS repository and THIS PR.
 *
 * An `https://` prefix check is not enough, because the URL is load-bearing
 * twice over — it is the audit backlink a reader follows, and it is the
 * idempotency key. Another PR's discussion URL (or any https URL at all)
 * therefore files the entry under a key no later run for the real thread will
 * match, and the originating thread gets resolved with no valid tracked
 * connection.
 */
export function threadUrlPattern(repoSlug: string, pr: string): RegExp {
  const escaped = `${repoSlug}/pull/${pr}`.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  return new RegExp(`^https://github\\.com/${escaped}#discussion_r[0-9]+$`);
}

/** The PR-level conversation permalink used by summary-only findings. */
export function commentUrlPattern(repoSlug: string, pr: string): RegExp {
  const escaped = `${repoSlug}/pull/${pr}`.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  return new RegExp(`^https://github\\.com/${escaped}#issuecomment-[0-9]+$`);
}

/**
 * The reviewer's finding-fingerprint format. Deliberately as wide as
 * `MARKER_SAFE_FINGERPRINT` in drive-pr's `summary-findings.ts` — the
 * authoritative producer boundary for this value — not the narrower
 * 16-char-hex shape `fingerprintOf()` there emits for a locally-synthesized
 * body finding. A reviewer-supplied `ai-review-backlog` fingerprint is
 * validated there against the wider shape and can legitimately be something
 * like `reviewer_key-1`; narrowing this validator to hex-only rejected a
 * real backlog fingerprint outright.
 *
 * Duplicated rather than imported: each skill ships self-contained (see
 * `resolve-review-comments/__tests__/scripts.test.ts`), and a sibling such as
 * `drive-pr` may live in the consumer repository instead, so a script here
 * may not import from a sibling skill directory. Keep this in
 * sync with `MARKER_SAFE_FINGERPRINT` by hand if that shape ever changes.
 */
export const FINDING_FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Stable, non-linkified heading key for one finding in a sticky comment. */
export function summaryEntryKey(
  commentUrl: string,
  fingerprint: string,
): string {
  const match = /#issuecomment-([0-9]+)$/.exec(commentUrl);
  if (match === null) {
    throw new Error(`cannot derive a summary entry key from '${commentUrl}'`);
  }
  return `ai-review-backlog:issuecomment-${match[1]}:${fingerprint}`;
}

/**
 * Append `entry` to `description`, idempotently keyed on the entry's HEADING
 * LINE: a re-run after a crash mid-round must not duplicate the entry.
 *
 * The key is a whole trimmed line equal to `### <url>`, not a substring search
 * for the URL. A substring is not evidence the thread has an entry, in two
 * measured ways: one thread URL is a PREFIX of another (`…#discussion_r1` sits
 * inside `…#discussion_r10`), and a URL quoted inside a neighbouring finding's
 * text matches too. Either reports `alreadyPresent` for a finding that was
 * never recorded, and the caller then resolves the review thread with nothing
 * tracking it.
 */
/**
 * The exact idempotency key an entry heading names, or null if the line is not one.
 *
 * MEASURED: Linear rewrites a bare
 * URL into a markdown link when it stores a description, so the heading this
 * script WRITES is not the heading it reads back —
 * `### https://…#discussion_r1` returns as
 * `### [https://…#discussion_r1](<https://…#discussion_r1>)`. An exact
 * line-equality key therefore never matched after a round trip: every append
 * failed its own post-write verification, the retry loop re-appended, and the
 * issue ended up with the same entry three times before the run aborted.
 *
 * Parsing the URL out and comparing it EXACTLY keeps the property the
 * line-equality key was chosen for — a thread URL that merely prefixes another
 * (`…_r1` inside `…_r10`) still does not match, and a URL quoted inside a
 * neighbouring finding is not on a `###` line at all.
 */
export function headingEntryKey(line: string): string | null {
  // 0-3 leading spaces, per CommonMark: that is the range which still parses
  // as a heading. FOUR or more makes it an indented CODE BLOCK, so a Markdown
  // example inside a description would otherwise be read as a real entry and
  // make the helper skip the append — resolving the thread with nothing
  // tracking it (a legal-but-unexpected indentation must never read as a
  // real entry). A bare `trim()` erased that distinction.
  const heading = /^ {0,3}### (.*)$/.exec(line.trimEnd());
  if (heading === null) return null;
  const rest = (heading[1] ?? "").trim();
  const link = /^\[([^\]]*)\]\(<?([^)>]*)>?\)$/.exec(rest);
  return link ? link[2] || link[1] || "" : rest;
}

/**
 * The entry headings a description actually contains, skipping anything inside
 * a FENCED code block.
 *
 * CommonMark renders a `### …` line inside ``` or ~~~ as code, not a heading,
 * so counting one as a real entry makes the append skip a finding that was
 * never recorded — the thread then resolves with nothing tracking it. Same
 * failure the indented-code-block bound closed; this is its sibling, and the
 * two together are what "a heading is a heading" actually means here.
 */
export function entryHeadings(description: string): string[] {
  const found: string[] = [];
  // CommonMark's fence rules in full, rather than one clause per round:
  //  - an opener is 3+ backticks or tildes at 0-3 spaces of indent;
  //  - a BACKTICK opener may not carry a backtick in its info string;
  //  - a closer must use the SAME character, be at least as LONG as the
  //    opener, and carry nothing but whitespace after it.
  // The length rule is why the opener's length is kept: after a ```` opener a
  // ``` line is NOT a close, and treating it as one exposes the code beneath
  // as headings again.
  let fence: { char: string; len: number } | null = null;
  for (const line of description.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    let consumed = false;
    if (marker !== null) {
      const fenceText = marker[1] ?? "";
      const char = fenceText.charAt(0);
      const len = fenceText.length;
      const info = marker[2] ?? "";
      if (fence === null) {
        if (char !== "`" || !info.includes("`")) {
          fence = { char, len };
          consumed = true;
        }
        // else: not a legal opener, so fall through and read it as content
      } else {
        if (char === fence.char && len >= fence.len && info.trim() === "") {
          fence = null;
        }
        consumed = true; // either the close, or a line inside the fence
      }
    }
    if (consumed || fence !== null) continue;
    const key = headingEntryKey(line);
    if (key !== null) found.push(key);
  }
  return found;
}

export function hasEntry(description: string, entryKey: string): boolean {
  return entryHeadings(description).includes(entryKey);
}

export function appendEntry(
  description: string,
  entry: string,
  entryKey: string,
): { description: string; appended: boolean } {
  if (hasEntry(description, entryKey)) {
    return { description, appended: false };
  }
  const base = description.trimEnd();
  return {
    description: base === "" ? entry : `${base}\n\n${entry}`,
    appended: true,
  };
}

/**
 * The domain-mismatch exception's audit trail: the protocol requires a
 * parentless follow-up to state WHY no epic holds it and which epic was
 * rejected, so `--no-parent` carries both rather than silently dropping the
 * parent (deferral-protocol.md § Parent).
 */
export interface NoParentRationale {
  reason: string;
  /**
   * The originating issue's own epic, `''` when it had none to reject, or
   * `null` when this run genuinely does not KNOW which of those two is
   * true (a repair reconstructing a wiped description with no rationale of
   * its own to fall back on — see `noParentRationaleForRepair`). `''` and
   * `null` render differently in `initialDescription`: `''` is an asserted
   * fact ("no epic to inherit"), `null` is an admitted gap. Collapsing the
   * two would assert a fact this run never verified.
   */
  rejectedEpic: string | null;
}

/** The scaffold a freshly created batch issue starts from. */
export function initialDescription(
  pr: string,
  originating: string,
  noParent?: NoParentRationale,
): string {
  const provenance =
    originating === ""
      ? `Batch of review deferrals from PR #${pr} (no originating issue — PR has no ticket).`
      : `Batch of review deferrals from PR #${pr}; originating issue ${originating}.`;
  const lines = [
    provenance,
    "",
    "Filed per the batch-by-default rule in Jig's resolve-review-comments",
    "`references/deferral-protocol.md` § Batching",
    "is the default. Each entry is self-contained: the review-source URL, the",
    "reviewer's finding quoted, and why it was deferred rather than fixed in the PR.",
  ];
  if (noParent !== undefined) {
    // THREE renderings, not two: `null` must not fall into either asserted
    // branch below — see `NoParentRationale.rejectedEpic`'s own doc. Only
    // `''` (a verified fact: this run read the originating issue and it had
    // no epic) and a real identifier (a verified fact: this run read the
    // originating issue and rejected its named epic) are assertions this
    // scaffold is entitled to make.
    const placement =
      noParent.rejectedEpic === null
        ? ""
        : noParent.rejectedEpic === ""
          ? " (the originating issue has no epic to inherit)."
          : ` Originating issue's epic is ${noParent.rejectedEpic} (rejected as unrelated).`;
    lines.push("", `**No epic parent**: ${noParent.reason}${placement}`);
  }
  lines.push("", "## Entries");
  return lines.join("\n");
}

/**
 * The no-parent scaffold to use when rebuilding a WIPED description (a
 * hand-filed/partial batch, or a concurrent writer's blank-out mid-append) —
 * derived from the batch's OWN current placement, not this invocation's
 * `noParentRationale`.
 *
 * RECONCILE never touches a batch's `parentId` (see the file header): it
 * belongs to whichever entry filed the batch FIRST, and an append neither
 * changes nor reads it. A repair that rebuilt the scaffold from THIS
 * invocation's own `--no-parent` flag ignored that entirely — an append that
 * happens to pass `--no-parent` onto a batch whose first entry selected a
 * normal epic parent left the issue's `parentId` field untouched (still
 * parented) while its just-rebuilt description asserted
 * `**No epic parent**` and named THIS run's rejected epic, corrupting the
 * placement audit trail a reader relies on. `hasParent` is read from a fresh
 * query of the batch's actual `parent` field, not from `args.noParent`.
 *
 * When the batch genuinely has no parent, `invocationRationale` is NEVER
 * reused here — even when this run happens to have one of its own. Having
 * one only proves THIS append also passed `--no-parent`; it proves nothing
 * about whether that reason matches the reason the batch's FIRST entry was
 * originally placed parentless. Those can differ (a different originating
 * issue, a different rejected epic), and presenting one as the other writes
 * false placement provenance into the audit trail. A repair therefore always falls back to the
 * generic placeholder that records the original reason as lost — with
 * `rejectedEpic: null`, NOT `''`. `''` is `initialDescription`'s rendering
 * for a VERIFIED fact ("the originating issue has no epic to inherit"),
 * which this fallback has no way to know: the batch could equally have been
 * filed parentless because ITS OWN originating issue rejected a real epic.
 * Reusing `''` here rendered a description that both admitted the reason
 * was unrecoverable AND asserted a specific, possibly false, one in the same
 * sentence.
 */
export function noParentRationaleForRepair(
  hasParent: boolean,
): NoParentRationale | undefined {
  if (hasParent) return undefined;
  return {
    reason:
      "the batch was filed with no epic parent; the original reason was lost when its description was cleared and this repair could not recover it",
    rejectedEpic: null,
  };
}

/**
 * The description this run should treat the batch as starting from: the
 * LIVE description when non-empty, otherwise a freshly built scaffold whose
 * no-parent block (if any) is derived from `hasParent` alone via
 * `noParentRationaleForRepair` — this invocation's own rationale is never
 * consulted, because it describes why THIS append used `--no-parent`, not
 * why the batch was originally placed parentless.
 *
 * Shared by BOTH sites that rebuild a wiped description — `runDeferBatch`'s
 * pre-loop read and `appendWithRetry`'s own mid-loop rebuild after a
 * concurrent writer clobbers it — so the two cannot silently diverge. Testing
 * this function directly (below, in the test suite) covers the LOGIC both
 * call sites share, but NOT whether either call site is actually wired to
 * it — that overclaim is what the pre-loop site's rebuild being reachable by
 * no test at all let slip through once (`main()` was neither exported nor
 * exercised by this file's suite, so a regression at that call site failed
 * nothing). `main()` was extracted into `runDeferBatch` for exactly this
 * reason, mirroring `appendWithRetry`'s own seam, and each call site's wiring
 * is now tested separately against a mock `LinearClient`.
 */
export function descriptionForRepair(
  liveDescription: string,
  pr: string,
  originating: string,
  hasParent: boolean,
): string {
  return liveDescription.trim() === ""
    ? initialDescription(pr, originating, noParentRationaleForRepair(hasParent))
    : liveDescription;
}

/**
 * The SCAFFOLD slice of a batch description — everything `initialDescription`
 * writes (provenance, the batching-protocol note, and the `**No epic
 * parent**` placement claim when present) — as opposed to `## Entries` and
 * everything after it.
 *
 * Every placement check must be scoped to this slice, never the whole
 * description: an entry's finding/reason/fix-sketch is external,
 * model-generated text, so an unrestricted `description.includes('**No epic
 * parent**')` mistakes an entry that happens to quote that exact marker for
 * the scaffold's own claim (both in `placementMatchesFreshParent`, which is
 * why the split lives here once rather than being duplicated at each call
 * site).
 */
export function scaffoldPortion(description: string): string {
  return description.split("## Entries", 1)[0] ?? description;
}

/**
 * Does a description's own placement claim (its `**No epic parent**` block,
 * present or absent) agree with the issue's FRESHLY read `hasParent`?
 *
 * A blank-description repair can race a reparent/unparent between the initial
 * candidate lookup and this run's first write, so the REBUILT scaffold is built
 * from a `hasParent` that was already stale the moment it was written —
 * `appendWithRetry`'s verify step re-reads `parent` fresh on every attempt, but
 * until this function existed nothing compared that fresh value against what
 * the description it had just confirmed actually CLAIMS. Only meaningful for a
 * description THIS run rebuilt (see `appendWithRetry`'s `everRebuiltScaffold`
 * tracking) — an ordinary batch's placement claim predates this run, and
 * RECONCILE deliberately never touches it (`descriptionForRepair`'s own doc:
 * placement "belongs to whichever originating issue filed the batch FIRST").
 */
export function placementMatchesFreshParent(
  description: string,
  hasParent: boolean,
): boolean {
  const claimsNoParent =
    scaffoldPortion(description).includes("**No epic parent**");
  return claimsNoParent === !hasParent;
}

interface PageInfo {
  hasNextPage: boolean;
}

interface Connection<T> {
  pageInfo?: PageInfo;
  nodes: T[];
}

/**
 * A workspace label plus the NAME OF ITS GROUP, read from Linear's own
 * `parent` rather than from a list copied into this file. The single-valued
 * groups (`Type`, `Size`, `Repo`) are the mandatory ones this script has to
 * reason about, and a hand-maintained copy of their membership would drift
 * from the workspace the moment a label is added.
 */
export interface LabelNode {
  id: string;
  name: string;
  parent?: { name: string } | null;
}

/** The mandatory groups that admit exactly ONE label per issue. */
export const TYPE_GROUP = "Type";
export const SIZE_GROUP = "Size";
export const REPO_GROUP = "Repo";

/** Which mandatory group a label belongs to, or '' for an ungrouped one. */
export function groupOf(label: LabelNode): string {
  return label.parent?.name ?? "";
}

interface RelationNode {
  type?: string | null;
  issue?: { id: string } | null;
  relatedIssue?: { id: string } | null;
}

/** The relation type the protocol requires, as Linear returns it. */
export const RELATED_TYPE = "related";

interface Candidate {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  createdAt: string;
  /**
   * The batch's OWN parent, read fresh — the source of truth
   * `noParentRationaleForRepair` reconstructs a wiped description's no-parent
   * block from, since an append never changes or reads this field itself.
   */
  parent: { id: string } | null;
  /**
   * The batch's OWN Linear priority, read fresh at the initial find — the
   * seed `runDeferBatch` reads as `originalPriority` and passes to
   * `appendWithRetry`, mirroring how `originalSize` is read from `labels`
   * just below. Never downgraded, only escalated — see
   * `priorityAfterSeverity`.
   */
  priority: number;
  labels: Connection<LabelNode>;
  relations: Connection<RelationNode>;
  inverseRelations: Connection<RelationNode>;
}

/**
 * Did a Linear connection return its whole population? `undefined` counts as
 * incomplete: the query asked for `pageInfo`, so its absence means the answer
 * cannot be judged, and a scan that cannot read its input has verified
 * nothing.
 */
export function isComplete(pageInfo: PageInfo | undefined): boolean {
  return pageInfo?.hasNextPage === false;
}

/**
 * Choose which of several same-key batch issues receives the append: the
 * OLDEST — later duplicates are the defect, and appending to the earliest
 * keeps the entry where a reader following the first link finds it.
 *
 * Generic over the timestamp alone: the caller's node type grows connections
 * this decision never reads, and a test fixture should not have to build them.
 */
export function pickBatch<T extends { createdAt: string }>(candidates: T[]): T {
  return candidates.reduce((best, c) =>
    c.createdAt < best.createdAt ? c : best,
  );
}

/** Whether a same-key candidate belongs to this repository, or cannot be told. */
export type RepoVerdict =
  | "this-repo"
  | "other-repo"
  | "unlabelled"
  | "ambiguous";

/**
 * Is this candidate a batch for THIS repository?
 *
 * The batch key is `PR #<N> <type>`, which carries no repository — so a
 * different repo in the same Linear workspace hitting the same PR number and
 * Type produces an identically titled `pr-followup` issue, and appending to it
 * misfiles the deferral into another repo's backlog entirely.
 *
 * Four outcomes, because a Repo group that is MISSING or holds more than one
 * label is ambiguous rather than reassuring, and BOTH uncertain states fail
 * closed — a caller that handles only `other-repo` would skip the two verdicts
 * that matter most. An earlier revision treated a missing label as this
 * repo's — a repairable gap — reasoning that skipping it would mint a
 * duplicate under the key. That is the wrong trade: an unlabelled
 * `PR #42 chore review follow-ups` filed for another repo would be claimed,
 * appended to, and then STAMPED `project` by the reconciliation path.
 * Claiming it is destructive and silent; a duplicate is tracker noise a human
 * merges. So `unlabelled` and `ambiguous` both fail closed and the caller asks
 * the operator to fix the issue's Repo group.
 */
export function repoVerdict(
  labels: LabelNode[],
  repoLabel: string,
): RepoVerdict {
  const repo = labels.filter((l) => groupOf(l) === REPO_GROUP);
  if (repo.length === 0) return "unlabelled";
  // CARDINALITY, not membership. A batch carrying both `project` and
  // `website` contains the requested label, so a `.some()` test calls it ours
  // — while it is exactly as ambiguous as carrying none, and taxonomy-invalid
  // besides. Being in a single-valued group means being the ONLY one.
  if (repo.length > 1) return "ambiguous";
  return repo[0]?.name === repoLabel ? "this-repo" : "other-repo";
}

/**
 * Which single-valued mandatory groups an existing batch is missing entirely,
 * as the label name that should fill each.
 *
 * ABSENT is the only repairable case. A group already holding a DIFFERENT
 * value is left alone and reported by the caller: the group is satisfied, so
 * the contract holds, and silently replacing an operator's `small` with this
 * call's `xs` would overwrite a decision this script did not make. Adding the
 * second one is the outcome that is never acceptable — one issue carrying two
 * Size labels violates the taxonomy in the name of repairing it.
 */
export function missingSingleValued(
  present: LabelNode[],
  wanted: { type: string; size: string },
): {
  add: string[];
  conflicts: Array<{ group: string; has: string; duplicate: boolean }>;
} {
  const add: string[] = [];
  const conflicts: Array<{ group: string; has: string; duplicate: boolean }> =
    [];
  // Repo is NOT here: `repoVerdict` already decided it, and it fails closed on
  // an unlabelled or ambiguous candidate — so anything reaching this point
  // carries exactly the right Repo label and there is nothing left to report.
  for (const [group, want] of [
    [TYPE_GROUP, wanted.type],
    [SIZE_GROUP, wanted.size],
  ] as const) {
    const held = present.filter((l) => groupOf(l) === group);
    const has = held.map((l) => l.name).join(", ");
    if (held.length === 0) {
      add.push(want);
    } else if (held.length > 1) {
      // Two labels in a single-valued group is taxonomy-invalid whatever they
      // are, and `[chore, bug]` CONTAINS the requested `chore` — so a
      // membership test reports no conflict on the very state that most needs
      // one. `duplicate` marks it, because the caller cannot treat it as the
      // benign "batch already sized differently" case: that reasoning rests on
      // the group being satisfied, and here it is not.
      conflicts.push({ group, has, duplicate: true });
    } else if (held[0]?.name !== want) {
      conflicts.push({ group, has, duplicate: false });
    }
  }
  return { add, conflicts };
}

/**
 * Does a batch's live label set still satisfy the contract this script
 * guarantees when it prints a ready `**deferred**` reply?
 *
 * Verification must check the CONTRACT, not just this run's own additions. A
 * concurrent whole-set replacement can erase a mandatory label that was
 * already there before this run started — which the "did my additions land"
 * question never asks about, so the run reported success over a batch that had
 * silently lost its Type, Repo or Context group.
 *
 * `requiredContext` is the SPECIFIC set of context labels this run's contract
 * guarantees survive — not merely "is the Context group non-empty". A generic
 * group check reachably passes past a real loss: a batch carrying both
 * `agent:meta` and `domain:tooling` (neither newly added by this run) that
 * has ONLY `agent:meta` erased by a concurrent whole-set replacement still
 * satisfies "some context label is present" via `domain:tooling` alone, so a
 * group-membership check confirms the write while the erased label — which
 * this run's reply claims is tracked — was never restored. The caller passes
 * the full expected set (existing context labels at the read this run started
 * from, unioned with `inherited`/`--labels`), computed ONCE before the retry
 * loop: it is what must be true when this run completes, not a function of
 * what happens to be live at any one moment mid-loop. Empty means nothing is
 * required, so nothing can be reported missing — the caller that has no
 * specific set in mind gets no context finding, not a fallback group check.
 *
 * A differing SIZE is not a problem here, deliberately: the group is satisfied
 * and both values are legitimate (see `missingSingleValued`).
 *
 * `requiredExtras` closes the same gap for non-context `--labels` flags
 * (`manual-ops`, `dpa-relevant`, ...): without it, a flag label this run
 * added in an EARLIER attempt that a LATER concurrent writer erases is
 * invisible to this check entirely — this function otherwise never asks
 * about anything outside the mandatory Type/Size/Repo/Context groups, so
 * the run would report `confirmed` over a batch that silently lost a label
 * the caller explicitly requested (concurrent-write regression).
 */
export function batchContractHolds(
  live: LabelNode[],
  wanted: { type: string; size: string; repoLabel: string },
  requiredContext: string[],
  requiredExtras: string[],
): string[] {
  const problems: string[] = [];
  const repo = repoVerdict(live, wanted.repoLabel);
  if (repo !== "this-repo") problems.push(`Repo group is ${repo}`);
  if (!live.some((l) => l.name === PROVENANCE_LABEL)) {
    // Not merely bookkeeping: `FIND_BATCHES` no longer filters on it, but
    // anything else that does — and the protocol's own contract — stops
    // seeing this batch, so the tracked entry becomes undiscoverable while
    // later runs mint duplicates under the same key.
    problems.push(`no ${PROVENANCE_LABEL} label`);
  }
  const single = missingSingleValued(live, wanted);
  for (const name of single.add) problems.push(`no ${name} label`);
  for (const c of single.conflicts) {
    if (c.duplicate) problems.push(`${c.group} holds ${c.has}`);
    else if (c.group === TYPE_GROUP) problems.push(`${TYPE_GROUP} is ${c.has}`);
    else if (
      c.group === SIZE_GROUP &&
      !(BATCH_SIZES as readonly string[]).includes(c.has)
    ) {
      // A differing Size is tolerated because both values are legitimate
      // BATCHABLE sizes. `medium`/`large` are not: the protocol sends anything
      // above `small` to its own issue, so a batch carrying one must not keep
      // collecting entries.
      problems.push(
        `${SIZE_GROUP} is ${c.has}, which is not batchable (${BATCH_SIZES.join("|")})`,
      );
    }
  }
  const liveNames = new Set(live.map((l) => l.name));
  const missingContext = requiredContext.filter((n) => !liveNames.has(n));
  if (missingContext.length > 0) {
    problems.push(`missing context label(s): ${missingContext.join(", ")}`);
  }
  const missingExtras = requiredExtras.filter((n) => !liveNames.has(n));
  if (missingExtras.length > 0) {
    problems.push(`missing extra label(s): ${missingExtras.join(", ")}`);
  }
  return problems;
}

/** Context labels inherited from the originating issue onto the batch. */
export function inheritedContextLabels(labels: string[]): string[] {
  return labels.filter((l) =>
    CONTEXT_PREFIXES.some((prefix) => l.startsWith(prefix)),
  );
}

/**
 * The CONTEXT labels the batch will carry once this run has reconciled it —
 * what it already has, plus what this run can add.
 *
 * Empty means the mandatory Context group stays empty, which BOTH paths refuse
 * on. The predicate is the prefix filter, deliberately: an earlier revision
 * asked whether there were any labels to apply at all, which `--labels
 * manual-ops` satisfies while supplying no context label whatsoever (a
 * regression from an earlier fix).
 */
export function contextAfterReconcile(
  present: string[],
  inherited: string[],
  extras: string[],
): string[] {
  return inheritedContextLabels([...present, ...inherited, ...extras]);
}

/**
 * Which CONTEXT labels an existing batch is missing — the set a later round's
 * finding may carry that the batch's first entry did not.
 *
 * Deliberately context-only (`inherited` + `--labels` extras). The Type, Size
 * and repo groups are single-valued, so unioning THEM onto a batch created as
 * `small` when a later finding sizes `xs` would leave one issue carrying both
 * size labels — a label-taxonomy violation, in the name of fixing one.
 */
export function contextLabelsToAdd(
  present: string[],
  inherited: string[],
  extras: string[],
): string[] {
  const have = new Set(present);
  return [...new Set([...inherited, ...extras])].filter((n) => !have.has(n));
}

/**
 * Which labels a batch is missing against the mandatory contract, computed
 * FRESH from whatever label set is passed in.
 *
 * Shared by the pre-loop computation and every retry inside the append loop
 * so the two cannot drift apart. Before this existed, the pre-loop call site
 * computed this once from the initial read and the retry loop kept reusing
 * that frozen result: a concurrent whole-set replacement that erased a label
 * present at the initial read was never re-added, because the label was
 * never "missing" in the snapshot the retry kept re-sending. Calling this
 * again on each iteration's freshly re-read label set is what lets the retry
 * actually repair an erasure it detects.
 *
 * Takes `requiredContext` — the FULL context set `batchContractHolds` checks
 * this run's contract against — rather than `inherited`/`extras` alone.
 * concurrent-write regression: a batch can carry a context label that
 * predates this run entirely (filed by an earlier finding's originating
 * issue), which is not in THIS run's `inherited` or `--labels`. Diffing
 * against `inherited ∪ extras` alone never proposes restoring that label, so
 * an erasure of it fails `batchContractHolds` every attempt with no way to
 * repair it — the retry exhausts and aborts even after the concurrent
 * writer has stopped. `requiredContext` is the batch's full pre-run context
 * set unioned with `inherited`/`extras` (computed once, before the retry
 * loop starts — see `contextAfterReconcile` at the call site), so it covers
 * every context label the contract actually requires. `wanted.repoLabel` is
 * repaired the same way: `missingSingleValued` deliberately excludes Repo
 * (the initial candidate lookup already guarantees it), but a CONCURRENT
 * erasure mid-loop breaks that guarantee, and `batchContractHolds` checks
 * Repo regardless of who is responsible for restoring it.
 *
 * `requiredExtras` is SEPARATE from `requiredContext` on purpose: `--labels`
 * may carry non-context flag labels too (`manual-ops`, `dpa-relevant` —
 * anything outside the single-valued groups and the agent:/domain:/codearea:
 * prefixes), and `requiredContext` is deliberately prefix-filtered to just
 * the mandatory Context group (`contextAfterReconcile` →
 * `inheritedContextLabels`). A non-context extra therefore never appears in
 * `requiredContext`, so passing ONLY that here would drop it from the
 * append path's repair set entirely — the create path adds every
 * `args.extraLabels` value unfiltered, and an append must match: reporting
 * success while silently never adding the flag label the caller asked for.
 * The result is de-duplicated across ALL FIVE sources, not just extras
 * against context. The five overlap in more ways than one pairing: `--labels`
 * is rejected only for Type/Size/Repo names, so `--labels pr-followup` lands
 * in both `requiredExtras` and the provenance branch, and a context label can
 * repeat through `requiredExtras` too. A repeated name is resolved twice by
 * `fetchLabels` and written twice, so dedupe the SET rather than one pairing
 * of it.
 *
 * The Repo repair is gated on `repoVerdict`, not on `liveNames.has(...)`
 * membership: a concurrent writer that REPLACES the Repo label with a
 * different Repo-group value (`other-repo`) is not the same state as one
 * that ERASES it entirely (`unlabelled`), even though both make
 * `liveNames.has(wanted.repoLabel)` false. Treating them alike unioned
 * `wanted.repoLabel` onto the conflicting value, leaving the LIVE issue
 * carrying two Repo labels — `repoVerdict` then reports `ambiguous` on the
 * very next read, so the retry loop still fails safe eventually, but the
 * invalid two-label mutation it wrote along the way persists and needs
 * manual cleanup. Only a genuinely ABSENT Repo group is repairable here;
 * `other-repo`/`ambiguous` are left unrepaired for `batchContractHolds` to
 * flag as a problem — the same treatment a differing Type or a duplicated
 * group already gets above, via `missingSingleValued`'s `conflicts`.
 */
export function repairableMissingLabels(
  live: LabelNode[],
  wanted: { type: string; size: string; repoLabel: string },
  requiredContext: string[],
  requiredExtras: string[],
): string[] {
  const liveNames = new Set(live.map((l) => l.name));
  const repoIsAbsent = repoVerdict(live, wanted.repoLabel) === "unlabelled";
  // `wanted.repoLabel` is excluded from the generic `requiredContext` /
  // `requiredExtras` filters below and repaired ONLY through the dedicated
  // `repoIsAbsent` branch above. The generic filters test raw
  // `!liveNames.has(n)` membership — exactly the signal a CONFLICTING Repo
  // value also produces — so a caller naming the repo label via `--labels`
  // (legitimate: see "does not duplicate a REPO label that is also passed
  // as an extra" below) would otherwise let those filters re-add it onto a
  // conflicting value even though the dedicated branch just correctly
  // refused to. `repoIsAbsent` already covers the one case those filters
  // could legitimately help with (genuinely absent), so excluding the name
  // from them entirely loses nothing and closes the bypass.
  return [
    ...new Set([
      ...(liveNames.has(PROVENANCE_LABEL) ? [] : [PROVENANCE_LABEL]),
      ...missingSingleValued(live, wanted).add,
      ...(repoIsAbsent ? [wanted.repoLabel] : []),
      ...requiredContext.filter(
        (n) => n !== wanted.repoLabel && !liveNames.has(n),
      ),
      ...requiredExtras.filter(
        (n) => n !== wanted.repoLabel && !liveNames.has(n),
      ),
    ]),
  ];
}

/** One `agent:`/`domain:` prefix disagreeing between a batch and an incoming finding. */
export interface OwnerDomainMismatch {
  group: string;
  batchHas: string[];
  incomingHas: string[];
}

/**
 * Which `agent:`/`domain:` labels a batch's live label set and an incoming
 * finding's inherited context labels are COMPLETELY DISJOINT on — sharing no
 * label at all for that prefix.
 *
 * The protocol requires a finding owned by a different owner or domain than the
 * rest of the batch to get its OWN issue (deferral-protocol.md § Batching is
 * the default) — that triage call is made before this script is invoked, and
 * this check is the safety net for when it wasn't. "Different" is read as
 * DISJOINT rather than exact-set-equal: an ownership group (a
 * `review.taxonomy.ownership_prefixes` prefix such as `agent:` or `domain:`)
 * may be multi-valued, so a batch legitimately carries more than one label
 * under the same prefix — ordinary human triage in Linear can add a second one
 * to an already-filed batch. Requiring the incoming set to
 * match EXACTLY would abort every later append to that batch even though the
 * finding shares real ownership with it; ANY overlap is evidence of shared
 * ownership, so only a set with NO shared label counts as "different".
 * Deliberately excludes `codearea:*`: unlike ownership, code area reconciles
 * ADDITIVELY, since one PR+Type batch can legitimately collect findings
 * under the same owner that touch different parts of the codebase.
 *
 * Empty on either side is not a mismatch — a batch's FIRST entry establishes
 * ownership, and it has nothing yet to disagree with.
 */
export function ownerDomainMismatches(
  batchLabels: string[],
  incomingLabels: string[],
): OwnerDomainMismatch[] {
  const mismatches: OwnerDomainMismatch[] = [];
  for (const prefix of OWNERSHIP_PREFIXES) {
    const group = prefix.replace(/:$/, "");
    const batchHas = batchLabels.filter((l) => l.startsWith(prefix)).sort();
    const incomingHas = incomingLabels
      .filter((l) => l.startsWith(prefix))
      .sort();
    if (batchHas.length === 0 || incomingHas.length === 0) continue;
    const batchSet = new Set(batchHas);
    const sharesOwnership = incomingHas.some((l) => batchSet.has(l));
    if (!sharesOwnership) mismatches.push({ group, batchHas, incomingHas });
  }
  return mismatches;
}

/**
 * Is `otherUuid` on either end of any of these relations? Direction-agnostic
 * on purpose: this script always creates the link as batch→originating, but a
 * hand-filed batch may carry the inverse, and a re-created "missing" link
 * would be a duplicate relation on the issue.
 */
export function hasRelationTo(
  nodes: RelationNode[],
  otherUuid: string,
): boolean {
  return nodes.some(
    (n) =>
      // TYPE as well as endpoints. A `blocks`/`blocked-by` edge between the
      // same two issues satisfies an endpoint-only test, so the protocol's
      // required `related` link would never be created — and the reply would
      // still say the batch is linked.
      n.type === RELATED_TYPE &&
      (n.issue?.id === otherUuid || n.relatedIssue?.id === otherUuid),
  );
}

/**
 * The `signal` is REQUIRED, not optional — see `RUN_DEADLINE_MS`'s own doc.
 * A caller-supplied deadline that an implementation is free to ignore is no
 * guarantee at all, so it is part of the port's own type, not bolted on
 * per-call. This does NOT, by itself, force every existing test double to
 * accept it: TypeScript's function-type assignability allows a
 * fewer-parameter function to stand in for a type expecting more (the
 * caller may pass extra arguments; JS ignores them), so a 2-arg fake typed
 * as `LinearClient` still type-checks and simply never sees `signal`. The
 * actual enforcement is `appendWithRetry`'s own `checkDeadline` (below),
 * which does not trust an implementation to honor the signal at all — it
 * checks `signal.aborted` itself before making any call. `makeClient`'s real
 * implementation additionally races the signal against `fetch` via
 * `AbortSignal.any`, so a REAL client does cancel the in-flight request; a
 * test double that ignores `signal` merely resolves as if the deadline had
 * not fired, which `checkDeadline` still catches on the next loop check.
 */
export type LinearClient = (
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>;

function makeClient(token: string): LinearClient {
  return async (query, variables, signal) => {
    let resp: Response;
    try {
      resp = await fetch(LINEAR_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({ query, variables }),
        // Whichever fires first: this one call's own LINEAR_TIMEOUT_MS cap,
        // or the caller's run-wide deadline — so a single stalled request is
        // bounded even when the deadline still has room left, AND the loop
        // as a whole cannot outlast the deadline by retrying calls that each
        // individually look fine.
        signal: AbortSignal.any([
          AbortSignal.timeout(LINEAR_TIMEOUT_MS),
          signal,
        ]),
      });
    } catch (e) {
      throw new Error(
        `Linear API unreachable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!resp.ok) {
      throw new Error(`Linear API HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as {
      data?: Record<string, unknown>;
      errors?: unknown;
    };
    if (json.errors) {
      throw new Error(`Linear API error: ${JSON.stringify(json.errors)}`);
    }
    return json.data ?? {};
  };
}

/** Refuse to act on a page the API truncated — see `isComplete`. */
function assertComplete(pageInfo: PageInfo | undefined, what: string): void {
  if (!isComplete(pageInfo)) {
    fail(
      1,
      `defer-batch: ${what} did not fit one page — refusing to act on a partial view. Acting on one mints a second batch issue under a key that already has one, or files a batch missing its context labels.`,
    );
  }
}

/**
 * A Linear mutation reports `success: false` WITHOUT a top-level GraphQL
 * error, so an unchecked payload flows straight into the success path: the
 * script prints a ready `**deferred**` reply and the caller resolves the
 * thread, with nothing persisted behind it.
 */
function assertMutationOk(payload: unknown, what: string): void {
  const success = (payload as { success?: boolean } | null | undefined)
    ?.success;
  if (success !== true) {
    fail(
      1,
      `defer-batch: Linear reported that ${what} did not succeed (success: ${String(success)}) — nothing was persisted; do NOT resolve the review thread.`,
    );
  }
}

/**
 * Fails fast if `signal` has already aborted — generalizes
 * `appendWithRetry`'s own `checkDeadline` (which guards its retry loop) to
 * every OTHER `LinearClient` dispatch this file makes.
 *
 * `runDeferBatch`'s own entry-point guard (see its doc) only catches a
 * signal already aborted before that function STARTS — a deadline firing
 * BETWEEN two of its own pre-loop calls (the originating-issue lookup, the
 * team lookup, `FIND_BATCHES`, a `fetchLabels`/`createRelated` dispatch) was
 * still not caught until whichever later point happened to check it, if
 * any ever did. Called at the top of every such call site.
 */
function assertNotAborted(signal: AbortSignal, what: string): void {
  if (signal.aborted) {
    fail(
      1,
      `defer-batch: aborted — the run-wide deadline elapsed before ${what} could be dispatched. Do NOT resolve the review thread: this run cannot show the finding is tracked.`,
    );
  }
}

/**
 * Resolve label names to the workspace's labels, in the order given, carrying
 * each one's GROUP. A name the workspace cannot resolve ABORTS: a batch issue
 * filed without its mandatory groups is tracker noise with provenance.
 */
async function fetchLabels(
  linear: LinearClient,
  names: string[],
  signal: AbortSignal,
): Promise<LabelNode[]> {
  if (names.length === 0) return [];
  assertNotAborted(signal, "the workspace label lookup");
  const data = await linear(
    `query($names: [String!]!) { issueLabels(first: 100, filter: { name: { in: $names } }) {
       pageInfo { hasNextPage } nodes { id name parent { name } } } }`,
    { names },
    signal,
  );
  const conn = data.issueLabels as Connection<LabelNode>;
  assertComplete(conn.pageInfo, "the workspace label lookup");
  const byName = new Map(conn.nodes.map((n) => [n.name, n] as const));
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    fail(
      1,
      `defer-batch: workspace labels not found: ${missing.join(", ")} — refusing to file or update a batch issue without its mandatory label groups.`,
    );
  }
  return names.map((n) => byName.get(n) as LabelNode);
}

/**
 * Assert that the labels standing in for the single-valued mandatory groups
 * really BELONG to those groups, per Linear's own grouping.
 *
 * `<type>` is validated as a label-name shape by `parseArgs`, which any
 * lowercase workspace label satisfies — `pr-followup` and `manual-ops`
 * included. Those resolve fine, so the create then succeeds with NO Type label
 * at all, and the bogus value becomes the batch key every later round looks
 * up. The group is the only thing that actually distinguishes them.
 */
function assertGroupMembership(
  labels: LabelNode[],
  wanted: { type: string; size: string; repoLabel: string },
): void {
  const byGroup = [
    [TYPE_GROUP, wanted.type, "<type>"],
    [SIZE_GROUP, wanted.size, "--size"],
    [REPO_GROUP, wanted.repoLabel, "--repo-label"],
  ] as const;
  for (const [group, name, flag] of byGroup) {
    const label = labels.find((l) => l.name === name);
    if (label === undefined) continue; // fetchLabels already aborted on this
    const actual = groupOf(label);
    if (actual !== group) {
      fail(
        1,
        `defer-batch: ${flag} '${name}' is not a ${group}-group label in this workspace (group: ${actual === "" ? "none" : actual}) — it would file a batch with no ${group} label, and '${name}' would become the lookup key every later round misses.`,
      );
    }
  }
  // And the other direction: nothing ELSE in the set may sit in one of these
  // groups. `--labels xs` alongside `--size small` resolves both, and the
  // issue is filed carrying two Size labels — the same taxonomy violation the
  // reconciliation path refuses to create, arriving through the extras.
  for (const label of labels) {
    const group = groupOf(label);
    const wantedForGroup = byGroup.find(([g]) => g === group);
    if (wantedForGroup === undefined) continue;
    if (label.name !== wantedForGroup[1]) {
      fail(
        1,
        `defer-batch: label '${label.name}' is in the single-valued ${group} group, which ${wantedForGroup[2]} already sets to '${wantedForGroup[1]}' — one issue cannot carry two. Drop it from --labels, or pass it as ${wantedForGroup[2]}.`,
      );
    }
  }
}

/**
 * Create the protocol's `related` link back to the originating issue. Called
 * on the append path too, not only at create: create is several effects and
 * find-or-create retries only the first, so a relation that failed once would
 * otherwise never be retried.
 */
async function createRelated(
  linear: LinearClient,
  batchId: string,
  originatingUuid: string,
  signal: AbortSignal,
): Promise<void> {
  // Deliberately NOT guarded by `assertNotAborted`, unlike `fetchLabels`
  // above: both of this function's call sites run AFTER the primary
  // finding-tracking write (the entry append, or the batch create) has
  // already succeeded — see the matching note at the post-create
  // duplicate-check re-query. Aborting here would discard that already-
  // persisted result and report failure on a thread this run DID track;
  // a deadline firing here just skips the best-effort `related` link.
  const data = await linear(
    `mutation($issueId: String!, $relatedIssueId: String!) {
       issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: related }) { success }
     }`,
    { issueId: batchId, relatedIssueId: originatingUuid },
    signal,
  );
  assertMutationOk(data.issueRelationCreate, "the related-link creation");
}

/**
 * The batch lookup, named so the initial find and the post-create duplicate
 * re-query cannot drift apart — they must agree about what counts as a
 * candidate or the second read would answer a different question.
 *
 * Keyed on the TITLE alone, deliberately NOT on `pr-followup`. Filtering by
 * that label made a hand-filed or partially-created batch missing it
 * INVISIBLE, so the helper minted a second issue under a key that already had
 * one — the exact defect this lookup exists to prevent. It is a
 * run-independent mandatory label like any other, so the right move is to find
 * the batch and reconcile the label onto it. The title needle is exact enough
 * to keep the population tight (`isBatchTitle` then demands equality), and
 * every ambiguity below still fails closed.
 */
const FIND_BATCHES = `query($search: String!) { issues(first: 50, filter: {
     title: { containsIgnoreCase: $search },
     state: { type: { nin: ["completed", "canceled"] } }
   }) {
     pageInfo { hasNextPage }
     nodes { id identifier title url description createdAt priority
       parent { id }
       labels(first: 50) { pageInfo { hasNextPage } nodes { id name parent { name } } }
       relations(first: 50) { pageInfo { hasNextPage } nodes { type issue { id } relatedIssue { id } } }
       inverseRelations(first: 50) { pageInfo { hasNextPage } nodes { type issue { id } relatedIssue { id } } }
     } } }`;

const USAGE = `usage: defer-batch.ts [--batch] <PR#> <type> (--thread-url <url> | --comment-url <url> --fingerprint <marker-safe>) --reason <text> \\
         --severity <blocker|high|medium|low|unknown> --category <cat|unknown> \\
         --originating <TEAM-1234|none> [--team <KEY>] [--fix <text>] \\
         [--size xs|small] [--repo-label <name>] [--repo-slug owner/name] \\
         [--labels a,b] [--no-parent --no-parent-reason <text>] [--dry-run] \\
         < finding.txt
The reviewer's finding is read from stdin (quoted heredoc or file) — never an argument.`;

/**
 * Every option that takes a value. An unrecognised `--flag` is REJECTED rather
 * than collected: `--no-parrent true` parses cleanly against a permissive
 * collector, leaves `noParent` false, and silently files the parented issue
 * the operator asked not to have.
 */
const VALUE_FLAGS = [
  "thread-url",
  "comment-url",
  "fingerprint",
  "reason",
  "severity",
  "category",
  "originating",
  "team",
  "fix",
  "size",
  "repo-label",
  "repo-slug",
  "labels",
  "no-parent-reason",
] as const;

/** Every option that takes no value. */
const BOOLEAN_FLAGS = ["batch", "no-parent", "dry-run"] as const;

export interface Args {
  pr: string;
  type: string;
  /** Audit backlink: an inline thread or PR conversation comment. */
  sourceUrl: string;
  /** Heading-key identity: source URL for threads, comment-id + fingerprint for summaries. */
  entryKey: string;
  reason: string;
  /** A `SEVERITY_RANK_ORDER` token — required, never defaulted (see USAGE). */
  severity: string;
  /** A `REVIEW_CATEGORIES` token, or `CATEGORY_UNKNOWN` — required, never defaulted (see USAGE). */
  category: string;
  originating: string; // '' means --originating none
  team: string;
  fix: string;
  size: string;
  repoLabel: string;
  repoSlug: string;
  extraLabels: string[];
  noParent: boolean;
  noParentReason: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): Args | string {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  const seen = new Set<string>();
  let noParent = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const isBoolean = (BOOLEAN_FLAGS as readonly string[]).includes(name);
      if (!isBoolean && !(VALUE_FLAGS as readonly string[]).includes(name)) {
        return `unknown option ${a} — supported: ${[...BOOLEAN_FLAGS, ...VALUE_FLAGS].map((f) => `--${f}`).join(" ")}`;
      }
      if (seen.has(name)) return `${a} given more than once`;
      seen.add(name);
      if (name === "batch") continue; // tolerated alias of the positional form
      if (name === "no-parent") {
        noParent = true;
        continue;
      }
      if (name === "dry-run") {
        dryRun = true;
        continue;
      }
      const v = argv[i + 1];
      // Not just `undefined`: an omitted value SWALLOWS the next option, so
      // `--reason --dry-run` sets reason='--dry-run', leaves dryRun false, and
      // proceeds to real Linear mutations under a command the operator wrote
      // as a preview.
      if (v === undefined || v.startsWith("--")) {
        return `missing value for ${a}`;
      }
      opts[name] = v;
      i++;
      continue;
    }
    positional.push(a);
  }
  if (positional.length !== 2) return "expected exactly <PR#> and <type>";
  const [pr, type] = positional;
  if (pr === undefined || type === undefined)
    return "expected exactly <PR#> and <type>";
  if (!/^[0-9]+$/.test(pr)) return `PR number must be digits, got '${pr}'`;
  if (!(BATCH_TYPES as readonly string[]).includes(type)) {
    return `<type> must be one of ${BATCH_TYPES.join("|")}, got '${type}' — the repository's declared Type taxonomy (consumer review.taxonomy.types)`;
  }
  const repoSlug = opts["repo-slug"] ?? DEFAULT_REPO_SLUG;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoSlug)) {
    return `--repo-slug must look like owner/name, got '${repoSlug}'`;
  }
  const threadUrl = opts["thread-url"] ?? "";
  const commentUrl = opts["comment-url"] ?? "";
  const fingerprint = opts.fingerprint ?? "";
  if ((threadUrl === "") === (commentUrl === "")) {
    return "provide exactly one source: --thread-url, or --comment-url with --fingerprint";
  }
  let sourceUrl: string;
  let entryKey: string;
  if (threadUrl !== "") {
    if (!threadUrlPattern(repoSlug, pr).test(threadUrl)) {
      return `--thread-url must be a GitHub review-thread URL on this PR — https://github.com/${repoSlug}/pull/${pr}#discussion_r<id> — got '${threadUrl}'`;
    }
    if (fingerprint !== "") {
      return "--fingerprint is valid only with --comment-url";
    }
    sourceUrl = threadUrl;
    entryKey = threadUrl;
  } else {
    if (!commentUrlPattern(repoSlug, pr).test(commentUrl)) {
      return `--comment-url must be a GitHub PR conversation-comment URL on this PR — https://github.com/${repoSlug}/pull/${pr}#issuecomment-<id> — got '${commentUrl}'`;
    }
    if (!FINDING_FINGERPRINT.test(fingerprint)) {
      return `--fingerprint must be the reviewer's marker-safe finding fingerprint (alphanumeric, optionally with '.', '_', '-', starting alphanumeric), got '${fingerprint}'`;
    }
    sourceUrl = commentUrl;
    entryKey = summaryEntryKey(commentUrl, fingerprint);
  }
  const reason = opts.reason ?? "";
  if (reason === "") return "--reason is required";
  // reason/fix/no-parent-reason are rendered as RAW Markdown, unlike the
  // finding body, which `renderEntry` quotes line by line. A newline in one of
  // them can therefore forge a literal `### <url>` line — the exact marker
  // `appendEntry` trusts — so a later real deferral for that thread reports
  // `alreadyPresent` and resolves with no entry behind it.
  for (const [flag, value] of [
    ["--reason", reason],
    ["--fix", opts.fix ?? ""],
    ["--no-parent-reason", opts["no-parent-reason"] ?? ""],
  ] as const) {
    if (/[\r\n]/.test(value)) {
      return `${flag} must be a single line — a line break in it can forge the '${entryHeading("<url>")}' marker that keys the idempotent append`;
    }
  }
  // REQUIRED, like --reason/--originating — the bug this closes is
  // severity being silently dropped, so an optional flag would just
  // reproduce the same failure mode with an escape hatch. Same vocabulary as
  // triage-ladder.ts's --severity, imported rather than re-pinned.
  const severity = opts.severity ?? "";
  const validSeverities = [...CANONICAL_SEVERITIES, SEVERITY_UNKNOWN];
  if (severity === "") {
    return `--severity is required (${validSeverities.join("|")}) — it sets the batch's Linear priority, and the whole point of this flag is that severity must never be silently dropped`;
  }
  if (!validSeverities.includes(severity)) {
    return `--severity must be one of ${validSeverities.join("|")}, got '${severity}'`;
  }
  // REQUIRED, like --severity — mirrors triage-ladder.ts's own --category
  // requirement : an omitted flag is indistinguishable from an
  // explicit CATEGORY_UNKNOWN, so it could silently discard a real parsed
  // value the caller already computed. Pass CATEGORY_UNKNOWN explicitly only
  // when the reviewer genuinely emitted no tag for this finding — never as a
  // stand-in for an omitted flag.
  const category = opts.category ?? "";
  const validCategories = [...REVIEW_CATEGORIES, CATEGORY_UNKNOWN];
  if (category === "") {
    return `--category is required (${validCategories.join("|")}) — an omitted flag can silently discard a real parsed value; pass '${CATEGORY_UNKNOWN}' explicitly when there is none`;
  }
  if (!validCategories.includes(category)) {
    return `--category must be one of ${validCategories.join("|")}, got '${category}' — the repository's declared category taxonomy (consumer review.taxonomy.categories)`;
  }
  const originatingRaw = opts.originating ?? "";
  if (originatingRaw === "") {
    return "--originating is required (an issue id, or the literal `none` when the PR has no ticket)";
  }
  const originating = originatingRaw === "none" ? "" : originatingRaw;
  if (originating !== "" && !/^[A-Z]+-[0-9]+$/.test(originating)) {
    return `--originating must look like TASK-1234 or be 'none', got '${originatingRaw}'`;
  }
  if (
    originating === "" &&
    (opts.team ?? consumer.deferral_team ?? "") === ""
  ) {
    return "--team <KEY> is required with --originating none";
  }
  const repoLabel = opts["repo-label"] ?? consumer.repo_label ?? "";
  if (!(BATCH_REPOS as readonly string[]).includes(repoLabel)) {
    return `--repo-label must be one of ${BATCH_REPOS.join("|")}, got '${repoLabel}' — the repository's declared Repo taxonomy (consumer review.taxonomy.repos)`;
  }
  const extraLabels = (opts.labels ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  // `--labels` carries CONTEXT labels. A single-valued one smuggled in there
  // is not merely redundant: reconciliation treats it as missing whenever the
  // batch's live value differs, so `--labels xs` against a batch on `small`
  // WRITES a second Size label and only aborts in post-write verification —
  // leaving a real issue taxonomy-invalid. Rejected here, before any network
  // call, against the same pinned taxonomies the flags themselves use.
  for (const name of extraLabels) {
    const owner = (BATCH_TYPES as readonly string[]).includes(name)
      ? "<type>"
      : (BATCH_SIZES as readonly string[]).includes(name)
        ? "--size"
        : (BATCH_REPOS as readonly string[]).includes(name)
          ? "--repo-label"
          : "";
    if (owner !== "") {
      return `--labels may not carry '${name}' — it belongs to a single-valued mandatory group, which ${owner} already sets. Passing it here adds a SECOND label to that group when the batch's live value differs.`;
    }
  }
  const size = opts.size ?? "small";
  if (!(BATCH_SIZES as readonly string[]).includes(size)) {
    return `--size must be one of ${BATCH_SIZES.join("|")}, got '${size}' — a fix sizing above 'small' gets its own issue, not a batch entry (deferral-protocol.md § Batching is the default)`;
  }
  // The domain-mismatch exception is a judgment, and the protocol requires the
  // issue to record it. Dropping the parent silently leaves a parentless
  // follow-up with no auditable reason it is parentless.
  const noParentReason = opts["no-parent-reason"] ?? "";
  if (noParent && noParentReason === "") {
    return "--no-parent requires --no-parent-reason <text> — the protocol files a parentless follow-up only with the domain mismatch stated in its description (deferral-protocol.md § Parent)";
  }
  if (!noParent && noParentReason !== "") {
    return "--no-parent-reason has no effect without --no-parent";
  }
  return {
    pr,
    type,
    sourceUrl,
    entryKey,
    reason,
    severity,
    category,
    originating,
    team: opts.team ?? consumer.deferral_team ?? "",
    fix: opts.fix ?? "",
    size,
    repoLabel,
    repoSlug,
    extraLabels,
    noParent,
    noParentReason,
    dryRun,
  };
}

/** What one call to `appendWithRetry` settled on. */
export interface AppendRetryResult {
  confirmed: boolean;
  /** Labels this run's contract claims are on the issue, valid only when `confirmed`. */
  labelsAdded: string[];
  /** What never survived, for the abort message — empty when `confirmed`. */
  unconfirmed: string;
}

/**
 * The read-then-decide rebuild shared by every site that must turn a
 * FRESHLY read `description`/`parent`/`labels` into what this run should
 * write next: rebuild the description via `descriptionForRepair` +
 * `appendEntry` (a no-op when the fresh description is not wiped), decide
 * whether that differs from what's live, and recompute the label repair set
 * against THIS read's own labels — never a caller's stale snapshot.
 *
 * Shared so the pre-attempt-1 priming below and the
 * mid-loop retry (inside `appendWithRetry`'s own loop, after a failed
 * verify) can never drift on what "read-then-decide" means: before this
 * extraction, only the mid-loop retry did this at all, and attempt 1 sent
 * a caller-supplied `seedDescription` — built from the INITIAL find, before
 * `runDeferBatch` did anything else — completely unconditionally. A
 * concurrent invocation of this same script, appending a DIFFERENT finding
 * to the SAME batch issue, could read, append ITS entry, and write in the
 * exact gap between the caller's initial read and this run's attempt-1
 * write; since attempt 1 sent the whole stale `seedDescription` (which
 * never contained that concurrent entry), its write erased it. The verify
 * that followed only checked `hasEntry(liveDescription, args.entryKey)`
 * for THIS run's OWN entry key, so the clobber passed silently — nothing
 * ever asked whether a DIFFERENT entry had gone missing.
 */
async function rebuildDescriptionAndLabels(
  linear: LinearClient,
  liveDescription: string,
  hasParent: boolean,
  liveLabels: LabelNode[],
  entry: string,
  args: Args,
  wantedForRepair: Args,
  requiredContext: string[],
  signal: AbortSignal,
): Promise<{
  description: string;
  needsDescriptionWrite: boolean;
  scaffoldWasWiped: boolean;
  missingLabels: string[];
  addLabels: LabelNode[];
}> {
  const description = appendEntry(
    descriptionForRepair(liveDescription, args.pr, args.originating, hasParent),
    entry,
    args.entryKey,
  ).description;
  const missingLabels = repairableMissingLabels(
    liveLabels,
    wantedForRepair,
    requiredContext,
    args.extraLabels,
  );
  const addLabels =
    missingLabels.length > 0
      ? await fetchLabels(linear, missingLabels, signal)
      : [];
  if (addLabels.length > 0) assertGroupMembership(addLabels, wantedForRepair);
  return {
    description,
    needsDescriptionWrite: description !== liveDescription,
    scaffoldWasWiped: liveDescription.trim() === "",
    missingLabels,
    addLabels,
  };
}

/**
 * Abort if a FRESH label read shows the batch has moved to a different
 * agent/domain owner than this finding's own — see `ownerDomainMismatches`'s
 * own doc for why disjointness, not exact-set-equality, is the test.
 *
 * Shared by the pre-attempt-1 priming below and the mid-loop verify inside
 * `appendWithRetry`'s own loop, so the message can never drift between the
 * two, and — for priming specifically — so this check runs BEFORE
 * `rebuildDescriptionAndLabels`'s own `fetchLabels` call: a batch a
 * concurrent writer has already moved to a different owner, by the time
 * priming's own fresh read lands, must abort on THAT read rather than
 * paying a wasted label lookup for a repair this run is about to refuse to
 * make anyway (folding label repair into the shared priming read, per the
 * shared-read design, without also moving this ownership guard ahead of it,
 * made priming itself the thing that fired the wasted lookup the mid-loop
 * guard existed to prevent).
 */
function abortOnOwnershipMismatch(
  liveLabelNames: string[],
  incomingOwnership: string[],
  identifier: string,
): void {
  const freshMismatches = ownerDomainMismatches(
    liveLabelNames,
    incomingOwnership,
  );
  if (freshMismatches.length > 0) {
    fail(
      1,
      `defer-batch: ${identifier}'s ownership changed mid-append to ${freshMismatches
        .map((m) => `${m.group}:(${m.batchHas.join(", ")})`)
        .join(", ")}, which shares nothing with this finding's ${freshMismatches
        .map((m) => `${m.group}:(${m.incomingHas.join(", ")})`)
        .join(
          ", ",
        )} — a concurrent writer moved this batch to a different owner. Re-adding the erased label would silently fold a differently-owned finding into it. Do NOT resolve the review thread. Re-run once the ownership change is resolved, or file this finding individually.`,
    );
  }
}

/**
 * The append path's read-modify-write retry loop: write, re-read, verify
 * BOTH effects survived (the entry heading and the batch's label contract),
 * and rebuild from the fresh read when they did not.
 *
 * Extracted from `main()` so it is testable against an injected
 * `LinearClient` mock that simulates a concurrent writer's whole-set
 * replacement — the class of defect `repairableMissingLabels` and
 * `batchContractHolds`'s `requiredContext` parameter exist to repair, and
 * which no test exercised while this loop stayed inline: every prior test
 * called those two pure functions directly on hand-built snapshots, never
 * this loop, so deleting either fix from the live path would not have failed
 * anything (a concurrent-write regression).
 *
 * This loop NEVER sends `labelIds`. That field is a whole-set replacement, so
 * every write of it re-asserts the label set this run last read — and a
 * concurrent writer's edit made since that read is erased by it. The erasure
 * defeated the mid-loop ownership check below in the one case that matters:
 * a writer swapping `agent:meta` for `agent:compliance` between this run's
 * initial read and its first write had the swap reverted BY that write, so
 * the verify read back the stale owner, found no mismatch, and confirmed an
 * append into a batch that had moved to a different owner. Labels are
 * therefore added one at a time with `issueAddLabel`, which is purely additive:
 * nothing this run writes can erase a concurrent change, so the verify below
 * always sees the real live owner. Restoring an erased label is left entirely
 * to the explicit, ownership-validated repair set (`repairableMissingLabels`)
 * rather than to a blind snapshot re-assert.
 */
export async function appendWithRetry(
  linear: LinearClient,
  target: { id: string; identifier: string },
  seedDescription: string,
  /**
   * Was `seedDescription` itself built by rebuilding a WIPED description
   * (`descriptionForRepair`'s live-description branch), rather than being an
   * ordinary batch's untouched description? See `everRebuiltScaffold` below
   * and `placementMatchesFreshParent`'s own doc.
   */
  seedWasRepaired: boolean,
  needsInitialWrite: boolean,
  seedAddLabels: LabelNode[],
  seedMissingLabels: string[],
  entry: string,
  args: Args,
  originalSize: string,
  /**
   * The batch's OWN Linear `priority` at the read this run started from —
   * `Candidate.priority`, read at the initial find, mirroring `originalSize`
   * immediately above. Seeds `livePriority` below; see that variable's own
   * doc for why this must be a SEED rather than something recomputed from
   * `args` — a batch's priority must only ever be escalated toward
   * `args.severity`, never reset to it outright, so the loop needs to know
   * what it started from.
   */
  originalPriority: number,
  incomingOwnership: string[],
  requiredContext: string[],
  signal: AbortSignal,
  sleep: Sleeper = realSleep,
  /**
   * Does `seedDescription` actually DIFFER from the batch's description as
   * read at the initial find (`appended` at the call site) — i.e. does
   * attempt 1's write need to carry a `description` field at all? No
   * default: a caller that resent `description` unconditionally, regardless
   * of why the write fired, would silently erase a concurrent writer's own
   * entry that landed in the gap between the initial read and this write,
   * since the verify below checks only that THIS run's own entry survived —
   * never that anyone else's did. An omitted argument used to fall back to
   * `needsInitialWrite`, reintroducing exactly that hazard for any caller
   * that forgot to pass it (a concurrent-write regression, on the original
   * default that mirrored `needsInitialWrite`). Kept distinct from
   * `needsInitialWrite`, which also fires for a priority-only or labels-only
   * reason that carries no description change at all.
   */
  needsInitialDescriptionWrite: boolean,
): Promise<AppendRetryResult> {
  // `args` with Size overridden to the batch's OWN value — see the
  // `originalSize` doc at the call site in `main()`. Reused everywhere this
  // function repairs labels, so a repaired Size and its group-membership
  // check cannot disagree about which value is correct.
  const wantedForRepair = { ...args, size: originalSize };
  // Every read of this is from a FRESH query — either the pre-loop priming
  // below  or the verify inside the loop, never a caller-supplied
  // snapshot. There is deliberately no seed from `target`/`Candidate`: a
  // snapshot taken before either of those reads is exactly what a
  // whole-set write used to re-assert, and nothing here may act on one.
  let liveLabels: LabelNode[] = [];
  /**
   * The batch's priority as of the last thing this loop actually knows —
   * `originalPriority` until the first fresh read lands, then whatever that
   * read reports, exactly mirroring `liveLabels`'s own seed-then-refresh
   * pattern. Read at the top of each attempt's write to decide the target
   * priority for THAT write (`priorityAfterSeverity`), and compared against
   * `args.severity` at verify time (`priorityOk`) — never reset from `args`
   * directly, so a batch already at a MORE severe priority is never
   * downgraded.
   */
  let livePriority = originalPriority;
  let description = seedDescription;
  let missingLabels = seedMissingLabels;
  let addLabels = seedAddLabels;
  let needsWrite = needsInitialWrite;
  // Whether `description` belongs in THIS attempt's mutation input at all —
  // see the parameter doc above. Recomputed on every mid-loop rebuild from
  // what is actually live, exactly mirroring `livePriority`'s own
  // seed-then-refresh pattern, so a write triggered solely by a label or
  // priority reason never resends a description this run has no fresher
  // knowledge of than the snapshot that reason has nothing to do with.
  let needsDescriptionWrite = needsInitialDescriptionWrite;
  let unconfirmed = "";
  // MONOTONIC — once this run has rebuilt the description from a wipe, it
  // stays responsible for that description's placement claim for the rest
  // of the loop, even on a later attempt whose OWN pass does not rebuild
  // again (the persisted description is non-empty precisely because this
  // run wrote it). See `placementMatchesFreshParent`'s own doc.
  let everRebuiltScaffold = seedWasRepaired;
  // Accumulated SEPARATELY from the per-attempt `missingLabels` repair set,
  // which a later attempt can reset to `[]` once the label lands while a
  // DIFFERENT part of the contract (e.g. the description) still needs
  // repair — returning that shrunk set as `labelsAdded` would under-report a
  // label this run genuinely added in an earlier attempt.
  const labelsEverAdded = new Set<string>();
  // Checked before any call an attempt would make, not only relied on to
  // cancel an in-flight `fetch` — see `RUN_DEADLINE_MS`'s own doc. A test
  // double standing in for `LinearClient` is not obliged to honor the signal
  // it is handed (only `makeClient`'s real implementation races it against
  // `fetch`), so an explicit check here is what makes the deadline's effect
  // on the LOOP verifiable without a real network call. Called BOTH at the
  // top of each attempt and right after the retry pause: `sleep` itself can
  // be where the deadline elapses, and without the second call the loop
  // would still spend one more `fetchLabels` round-trip rebuilding a repair
  // set for an attempt it is about to refuse to make.
  const checkDeadline = (attempt: number): void => {
    if (signal.aborted) {
      fail(
        1,
        `defer-batch: aborted — the run-wide deadline elapsed before ${target.identifier} could be confirmed (attempt ${attempt}/${APPEND_ATTEMPTS}). Do NOT resolve the review thread: this run cannot show the finding is tracked. Re-run once Linear is responsive.`,
      );
    }
  };
  checkDeadline(1);
  // `originalPriority` is a snapshot from the INITIAL candidate lookup —
  // taken before label resolution and everything else `runDeferBatch` does
  // ahead of this call, so it can already be well behind live by the time
  // attempt 1 writes. Left as-is, attempt 1 computes its priority write
  // straight from that stale snapshot: read 0 (None), a concurrent writer
  // escalates to 1 (Urgent), this run computes 2 (High) from the STALE 0 and
  // writes it — silently downgrading the live Urgent — and the verify below
  // only checks that priority now reflects THIS run's own severity, never
  // that it didn't just erase a stronger concurrent one. Only worth the
  // extra round-trip when a write is actually going to happen AND the stale
  // snapshot itself looks like it needs a bump — a batch already at/above
  // `args.severity` per `originalPriority` cannot be under-escalated by staying
  // stale, since this loop never lowers a priority it reads. One fresh read
  // here, taken as close to the first write as this function gets, shrinks that
  // window down to the same network-round-trip-sized gap every later attempt's
  // own verify-then-retry already accepts.
  //
  // That narrowing is NOT closure — see this function's own doc comment
  // above (`Closing it needs compare-and-swap or a lock, and Linear's API
  // offers neither`). A concurrent writer landing inside this shrunk window
  // is the documented, accepted residual, not a gap this priming claims to
  // eliminate (concurrent-write regression,
  // re-raising that same documented residual against this priming
  // specifically — answered `wont-fix` for that reason).
  //
  // This same priming also applies to `description` (and, since the
  // read is free once made, to `labels`): attempt 1 used to write
  // `seedDescription` — the caller's INITIAL find/read — unconditionally
  // whenever `needsInitialDescriptionWrite` was true, with no fresher check
  // first. See `rebuildDescriptionAndLabels`'s own doc for the clobber this
  // closes. Folded into ONE query (never one per field, per this file's own
  // additive-write discipline) and rebuilt through the exact same
  // read-then-decide path (`rebuildDescriptionAndLabels`) the mid-loop retry
  // already uses, so priming and the mid-loop retry cannot drift on what
  // "read-then-decide" means. Gated the same way as the priority-only
  // priming it replaces — `needsWrite` first, so a pure no-op run pays
  // nothing — plus `needsInitialDescriptionWrite`: a labels- or
  // priority-only write never sends `description` at all (see that
  // parameter's own doc), so it carries none of THIS race's clobber risk
  // and gets none of this extra round-trip.
  //
  // Same residual as the priority-only priming above, for the same reason:
  // this narrows the window from "the caller's entire initial read plus
  // every step `runDeferBatch` does before this call" down to "the gap
  // between this one fresh read and attempt 1's write" (which still spans
  // `rebuildDescriptionAndLabels`'s own `fetchLabels` round-trip whenever
  // this read shows a label to repair) — it does not close it. A concurrent
  // writer's entry landing inside THAT shrunk window is erased by attempt
  // 1's whole-field `description` write and is NOT caught by this run's
  // verify below, which checks only THIS run's own entry
  // (`hasEntry(…, args.entryKey)`) and never a stranger's it never read;
  // only the OTHER writer's own verify-then-retry can restore it, and only
  // when that verify reads after this run's write — the A-write → A-verify
  // → B-write(stale) → B-verify interleaving in this file's own doc comment
  // passes on both sides. That is the documented, accepted residual, and it
  // applies to this priming for the same reason.
  if (
    needsWrite &&
    (needsInitialDescriptionWrite ||
      !priorityReflectsSeverity(originalPriority, args.severity))
  ) {
    const primed = await linear(
      `query($id: String!) { issue(id: $id) {
         description
         parent { id }
         priority
         labels(first: 50) { pageInfo { hasNextPage } nodes { id name parent { name } } }
       } }`,
      { id: target.id },
      signal,
    );
    const primedIssue = primed.issue as {
      description: string | null;
      parent: { id: string } | null;
      priority: number;
      labels: Connection<LabelNode>;
    } | null;
    if (!primedIssue) {
      fail(1, `defer-batch: ${target.identifier} disappeared mid-append`);
    }
    assertComplete(
      primedIssue.labels.pageInfo,
      `the labels on ${target.identifier} before the first append attempt`,
    );
    livePriority = primedIssue.priority;
    liveLabels = primedIssue.labels.nodes;
    // BEFORE the rebuild, not after — see `abortOnOwnershipMismatch`'s own
    // doc for why this ordering is itself part of the placement repair.
    abortOnOwnershipMismatch(
      liveLabels.map((l) => l.name),
      incomingOwnership,
      target.identifier,
    );
    const rebuilt = await rebuildDescriptionAndLabels(
      linear,
      primedIssue.description ?? "",
      primedIssue.parent != null,
      liveLabels,
      entry,
      args,
      wantedForRepair,
      requiredContext,
      signal,
    );
    description = rebuilt.description;
    needsDescriptionWrite = rebuilt.needsDescriptionWrite;
    // REPLACE, not OR. Unlike the mid-loop's own accumulation just below
    // (which must stay MONOTONIC once this run has taken responsibility for
    // a rebuilt scaffold — see that variable's doc), this priming is the
    // very first read this run has done: `seedWasRepaired` is the CALLER's
    // computation from before this priming ever ran, against a snapshot
    // this read has just superseded. Trusting it here over what this fresh
    // read actually found would defeat the point of unifying on it for
    // exactly the placement-claim responsibility this repair is
    // about.
    everRebuiltScaffold = rebuilt.scaffoldWasWiped;
    missingLabels = rebuilt.missingLabels;
    addLabels = rebuilt.addLabels;
  }
  for (let attempt = 1; attempt <= APPEND_ATTEMPTS; attempt++) {
    checkDeadline(attempt);
    if (needsWrite) {
      // Computed from `livePriority` as it stands AT THIS ATTEMPT — primed
      // fresh above ahead of attempt 1, or whatever the previous attempt's
      // fresh read reported on a retry. Included in the mutation ONLY when
      // it actually differs, mirroring the additive-only discipline the
      // label writes below follow for the same reason: a no-op `priority`
      // field on every write is needless traffic, and — unlike labels —
      // priority is a single scalar field, so sending it unconditionally
      // would also make every write look like a priority change in Linear's
      // own audit trail.
      const targetPriority = priorityAfterSeverity(livePriority, args.severity);
      const priorityChanged = targetPriority !== livePriority;
      // `description` is likewise included ONLY when `needsDescriptionWrite`
      // says this run's OWN knowledge of it actually differs from live — see
      // that variable's doc. A write triggered solely by a missing label or a
      // priority bump has no description change to make, and resending the
      // snapshot anyway is exactly the stale whole-field overwrite that can
      // erase a concurrent writer's own entry (a concurrent-write regression).
      // When neither field applies, skip the mutation entirely — the label loop
      // below is what this attempt is actually for.
      if (needsDescriptionWrite || priorityChanged) {
        const updateData = await linear(
          `mutation($id: String!, $input: IssueUpdateInput!) {
             issueUpdate(id: $id, input: $input) { success }
           }`,
          {
            id: target.id,
            input: {
              ...(needsDescriptionWrite ? { description } : {}),
              ...(priorityChanged ? { priority: targetPriority } : {}),
            },
          },
          signal,
        );
        assertMutationOk(
          updateData.issueUpdate,
          `the update to ${target.identifier}`,
        );
      }
      // ADDITIVE, one label at a time — see this function's doc for why a
      // whole-set `labelIds` write may never appear here. Recorded as added
      // only once Linear has confirmed each one, so an aborted run cannot
      // claim a label it never landed.
      for (const l of addLabels) {
        const addData = await linear(
          `mutation($id: String!, $labelId: String!) {
             issueAddLabel(id: $id, labelId: $labelId) { success }
           }`,
          { id: target.id, labelId: l.id },
          signal,
        );
        assertMutationOk(
          addData.issueAddLabel,
          `adding '${l.name}' to ${target.identifier}`,
        );
        labelsEverAdded.add(l.name);
      }
    }

    // Verify BOTH effects, not just the description. `labelIds` is a
    // whole-set replacement too, so a concurrent run's first write can
    // erase the labels this one added while both then find their own
    // description entry and report a reconciliation that did not persist.
    const fresh = await linear(
      `query($id: String!) { issue(id: $id) {
         description
         parent { id }
         priority
         labels(first: 50) { pageInfo { hasNextPage } nodes { id name parent { name } } }
       } }`,
      { id: target.id },
      signal,
    );
    const issue = fresh.issue as {
      description: string | null;
      parent: { id: string } | null;
      priority: number;
      labels: Connection<LabelNode>;
    } | null;
    if (!issue) {
      fail(1, `defer-batch: ${target.identifier} disappeared mid-append`);
    }
    assertComplete(
      issue.labels.pageInfo,
      `the labels on ${target.identifier} after the append`,
    );
    liveLabels = issue.labels.nodes;
    livePriority = issue.priority;
    const liveDescription = issue.description ?? "";
    const liveNames = new Set(liveLabels.map((l) => l.name));
    // UNCONDITIONAL, not `!appended || …`. An entry that was already
    // present at read time can be erased by a concurrent stale
    // replacement after it, and treating "I did not need to append" as
    // "the entry is there" approves exactly that case.
    const entryOk = hasEntry(liveDescription, args.entryKey);
    // The whole CONTRACT, not just this run's additions — a concurrent
    // replacement can drop a mandatory label that predates this run, which
    // a `missingLabels`-only check never asks about.
    const stillMissing = missingLabels.filter((n) => !liveNames.has(n));
    const contractProblems = batchContractHolds(
      liveLabels,
      args,
      requiredContext,
      args.extraLabels,
    );
    // Whether the LIVE priority — after whatever this attempt just wrote,
    // or after a concurrent writer's own change — already implies a
    // severity at least as severe as `args.severity`. A concurrent whole-set
    // replacement cannot erase a scalar field the way it erases labels, but
    // a concurrent DOWNGRADE (a different writer setting priority back down)
    // is exactly the case this check exists to catch and repair on retry.
    const priorityOk = priorityReflectsSeverity(livePriority, args.severity);
    if (
      entryOk &&
      stillMissing.length === 0 &&
      contractProblems.length === 0 &&
      priorityOk
    ) {
      // Only checked once the entry and every label are otherwise
      // confirmed — NOT ahead of that gate. A concurrent writer can WIPE
      // the description again (a fresh `''`) between this run's write and
      // this verify; that state must fall through to the ordinary
      // mid-loop rebuild below, exactly like any other wipe, not be
      // mistaken for a placement mismatch and aborted — `''` never
      // contains `**No epic parent**`, so checking placement against it
      // unconditionally reads as "claims a parent" and blames a reparent
      // that never happened (gating ahead of `entryOk` once made the identical
      // wipe-and-reconcile scenario this function's retry loop exists to handle
      // abort instead of repairing itself). Scoping the check to the
      // confirmed-otherwise state means it fires ONLY on the genuine race this
      // exists for: entry and labels landed fine, but the persisted
      // description's placement claim disagrees with the freshly read parent —
      // see `everRebuiltScaffold`'s own doc for when this run is responsible
      // for that claim at all.
      //
      // A blank-description repair can race a reparent/unparent between the
      // initial candidate lookup and this run's first write, so the scaffold
      // this run wrote was built from a `hasParent` that was already stale.
      // Aborting rather than rebuilding in place, deliberately: an AUTOMATED
      // text-surgery patch of just the placement block risks corrupting entries
      // a concurrent writer has appended since this run's own write, and this
      // function's only SAFE full rebuild path is the wipe branch above — which
      // does not apply here, because the description is not wiped, only wrongly
      // placed. The write already landed by this point, so a bare "re-run"
      // would NOT self-heal it: a later run's own `seedWasRepaired` reads
      // `false` against this now-non-empty description, so
      // `descriptionForRepair` returns it unchanged and nothing ever revisits
      // the placement claim again.
      //
      // The message below sends a HUMAN to do the surgery an automated
      // repair here may not: edit ONLY the scaffold's placement line,
      // above `## Entries`, and leave every entry below it untouched.
      // The earlier wording told the operator to blank the WHOLE description,
      // which is exactly the corruption this function itself declines to risk
      // automating — a concurrent writer's entry, appended after this run's own
      // write, lives only in that live description, and blanking it destroys
      // that entry (including its review-source URL) with no record left
      // anywhere to rebuild it from.
      if (
        everRebuiltScaffold &&
        !placementMatchesFreshParent(liveDescription, issue.parent != null)
      ) {
        const claimsNoParent =
          scaffoldPortion(liveDescription).includes("**No epic parent**");
        const surgery = claimsNoParent
          ? 'remove the "**No epic parent**: …" line (and the blank line directly above it)'
          : 'add a "**No epic parent**: …" line directly above the "## Entries" heading';
        fail(
          1,
          `defer-batch: ${target.identifier}'s description claims ${claimsNoParent ? "no epic parent" : "a parent"}, but the freshly read issue ${issue.parent != null ? "HAS" : "has NO"} parent — a reparent or unparent raced this run's rebuild of a wiped description between the initial lookup and the write, and that write already landed. Do NOT resolve the review thread. Re-running will NOT self-heal this: the persisted description is no longer empty, so the next run will not rebuild it. Manually edit ${target.identifier}'s description in Linear: ${surgery}. Edit ONLY that scaffold line, above "## Entries" — do NOT blank the whole description, which would also delete every tracked entry below it (including any a concurrent writer appended since this run's own write). Then re-run.`,
        );
      }
      return {
        confirmed: true,
        labelsAdded: [...labelsEverAdded],
        unconfirmed: "",
      };
    }
    unconfirmed = [
      entryOk ? "" : "the entry",
      stillMissing.length === 0 ? "" : `label(s) ${stillMissing.join(", ")}`,
      contractProblems.length === 0
        ? ""
        : `the batch contract (${contractProblems.join("; ")})`,
      priorityOk
        ? ""
        : // Named by SEVERITY, not by the raw Linear priority number — Linear's
          // scale runs LOWER-is-more-urgent (except 0/None, the exception to
          // that too), so "requires priority 2 or higher" reads as satisfied by
          // 3/4 to a human, which is backwards. This is the one message an
          // operator sees when the retry loop gives up on this clause.
          `the priority (finding severity '${args.severity}' needs the batch's Linear priority to reflect AT LEAST that severity; live priority is ${livePriority} — '${PRIORITY_TO_SEVERITY[livePriority] ?? SEVERITY_UNKNOWN}', which is less severe)`,
    ]
      .filter((x) => x !== "")
      .join(" and ");
    // Re-check ownership against THIS fresh read, not only the snapshot the
    // pre-loop guard validated. A concurrent writer can swap the batch's
    // owner labels between the initial read and this verify — erasing
    // `agent:meta` while adding `agent:compliance`, say — and that erasure
    // is exactly what `stillMissing`/`contractProblems` above just flagged
    // as something to repair. Repairing it blindly would re-fold this run's
    // finding into a batch a concurrent writer has moved to a different
    // owner — silently violating the same different-owner-gets-its-own-issue
    // rule the pre-loop guard exists to enforce (deferral-protocol.md §
    // Batching is the default). Abort rather than repair.
    abortOnOwnershipMismatch(
      [...liveNames],
      incomingOwnership,
      target.identifier,
    );
    // On the LAST attempt, there is no next iteration to use a rebuilt
    // description or a freshly fetched repair set — computing them is pure
    // waste, and a `fetchLabels` failure on this dead path would replace the
    // useful "concurrent writer keeps overwriting" result below with an
    // unrelated lookup error. Stop here and let the loop end.
    if (attempt === APPEND_ATTEMPTS) break;
    // Pace the next attempt BEFORE the label resolution below, not just
    // before the write: `fetchLabels` is itself a remote call, so pausing
    // any later would leave the lookup in the same burst as the verify that
    // just failed. See `retryBackoffMs` for the bound and the jitter, and
    // `sleepUnlessAborted`'s own doc for why this races the pause (rather
    // than awaiting it alone) and why that race cleans up after itself.
    await sleepUnlessAborted(retryBackoffMs(attempt), signal, sleep);
    checkDeadline(attempt);
    // Someone else's write landed on top of ours. Rebuild both effects
    // from what is actually there now and try again — including the
    // description, which a no-write pass may now need to restore. Shared
    // with the pre-loop priming above via `rebuildDescriptionAndLabels`
    //  — see that function's own doc — so this file has exactly
    // ONE read-then-decide path, not two that can drift.
    //
    // The no-parent block, like the priming's own rebuild above, is derived
    // from `issue.parent` — this FRESH read's own placement — never from
    // this or any invocation's own rationale. `!= null`, not `!== null`: a
    // response missing the field entirely (`undefined`) must read the same
    // as an explicit `null` — treating it as "has a parent" would drop the
    // no-parent block from a genuinely parentless batch, the opposite
    // corruption. See `descriptionForRepair` / `noParentRationaleForRepair`.
    const rebuilt = await rebuildDescriptionAndLabels(
      linear,
      liveDescription,
      issue.parent != null,
      liveLabels,
      entry,
      args,
      wantedForRepair,
      requiredContext,
      signal,
    );
    // Compared against THIS attempt's own fresh `liveDescription`, not the
    // pre-loop seed — mirrors `livePriority`'s refresh-from-the-latest-read
    // discipline above. `entryOk`/`stillMissing`/`priorityOk` above already
    // narrowed down WHY this attempt failed; a rebuild whose result equals
    // what is already live (entry present, no wipe to repair) means the
    // description was never the problem, and the next write must not resend
    // it — see `needsDescriptionWrite`'s own doc.
    description = rebuilt.description;
    needsDescriptionWrite = rebuilt.needsDescriptionWrite;
    // `descriptionForRepair` rebuilds only when `liveDescription` is itself
    // wiped — see its own doc. Once true, stays true (never reset to
    // false, hence `||=` rather than `=`): a later pass whose OWN
    // `liveDescription` is non-empty does not rebuild again, but that
    // non-empty description is non-empty PRECISELY because an earlier pass
    // of this same run (or the pre-loop priming) wrote it, so this run
    // stays responsible for its placement claim regardless. Contrast the
    // priming block above, which REPLACES rather than ORs — it runs before
    // this run has done anything, so there is nothing yet to accumulate.
    everRebuiltScaffold = everRebuiltScaffold || rebuilt.scaffoldWasWiped;
    // Recompute from what is LIVE now, not the snapshot taken before the
    // loop started. `stillMissing`/`batchContractHolds` above just
    // detected an erasure against the frozen `missingLabels` — without
    // this, `addLabels` at the top of the next attempt is still built
    // from names computed before any concurrent writer touched the
    // issue, so an erased label that was never "missing" in that
    // snapshot can never be restored and every remaining attempt fails
    // the same way. `requiredContext`, not `inherited`/`extraLabels` alone —
    // see `repairableMissingLabels`'s own doc: a context label the batch
    // already carried before this run started is required by the contract
    // but invisible to `inherited ∪ extraLabels`. `args.extraLabels` passed
    // again as `requiredExtras`, so a non-context `--labels` flag erased
    // mid-loop is repaired too, not just context labels. `wantedForRepair`,
    // not `args` — see its doc: an erased Size must be restored to what the
    // BATCH had, not this run's own value, and its resolved label must pass
    // group-membership against that SAME expectation or `assertGroupMembership`
    // rejects its own repair as a Size conflict.
    missingLabels = rebuilt.missingLabels;
    addLabels = rebuilt.addLabels;
    needsWrite = true;
  }
  return {
    confirmed: false,
    labelsAdded: [...labelsEverAdded],
    unconfirmed,
  };
}

async function main(): Promise<number> {
  if (consumerError !== undefined) fail(2, `defer-batch: ${consumerError}`);
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") fail(2, `defer-batch: ${parsed}`, "", USAGE);
  const args = parsed;

  const finding = (await readStdinAll()).trim();
  if (finding === "") {
    fail(2, "defer-batch: the finding body on stdin was empty", "", USAGE);
  }

  // UNSET and EMPTY both fall through — the same `${VAR:-…}` semantics
  // lib/cli.ts's envOrDefault documents (an empty export from optional
  // templating must not shadow the fallback name).
  const token =
    [process.env.LINEAR_API_TOKEN, process.env.LINEAR_API_KEY].find(
      (v) => v !== undefined && v !== "",
    ) ?? "";
  if (token === "") {
    fail(
      1,
      "defer-batch: LINEAR_API_TOKEN (or LINEAR_API_KEY) is required — the batch issue lives in Linear.",
    );
  }
  const linear = makeClient(token);
  return runDeferBatch(linear, args, finding);
}

/**
 * Everything `main()` does once it has a live `LinearClient`: find-or-create
 * the batch, append the entry, reconcile labels, link the originating issue.
 *
 * Extracted so this is testable against an injected `LinearClient` mock —
 * mirroring `appendWithRetry`'s own seam — rather than only through
 * `spawnSync` CLI-refusal probes, which exit before any network call and so
 * exercise none of this. Before this extraction, `main()`'s own
 * wiped-description rebuild call site (the `descriptionForRepair` call
 * below) was reachable by NO test at all: reverting it to
 * `initialDescription(args.pr, args.originating, noParentRationale)` — the
 * exact bug this file's history fixes — would not have turned any test red.
 * `descriptionForRepair` being independently pure-tested proved the HELPER was
 * correct; it proved nothing about whether this call site actually calls it.
 *
 * `signal` defaults to a fresh `RUN_DEADLINE_MS` deadline — see that
 * constant's doc — and is a parameter (not hardcoded) so a test can inject a
 * short or already-aborted one rather than waiting out the real deadline,
 * mirroring how `appendWithRetry` injects `sleep`.
 */
export async function runDeferBatch(
  linear: LinearClient,
  args: Args,
  finding: string,
  signal: AbortSignal = AbortSignal.timeout(RUN_DEADLINE_MS),
): Promise<number> {
  // `appendWithRetry`'s own `checkDeadline` is the guarantee for the
  // unbounded RETRY loop this deadline exists to bound — everything BEFORE
  // that loop is single-shot, not part of a retry, so this is not the
  // "pins the drive loop forever" risk `RUN_DEADLINE_MS` targets. But
  // dispatching a call whose result this run has already decided not to
  // trust is still worse than failing fast, so every pre-loop dispatch
  // below (this one included) is guarded by `assertNotAborted` — see its
  // own doc.
  assertNotAborted(signal, "this run's first call");
  // A deferred `blocker` is a contradiction: it should have been fixed or
  // escalated, not deferred (references/deferral-protocol.md § When to
  // defer). Warn loudly rather than abort — the finding still needs to be
  // tracked, and the priority mapping below still files it at Urgent
  // regardless of this warning.
  if (args.severity === "blocker") {
    console.error(
      "defer-batch: WARNING — deferring a 'blocker' severity finding. A deferred blocker is a contradiction (references/deferral-protocol.md § When to defer): it should have been fixed in the PR or escalated to a human, not batched. Filing it anyway so it is tracked, at Urgent priority.",
    );
  }
  // Originating issue: team, parent-one-level-up, inherited context labels,
  // and — for the parentless rows of the protocol's table — its planning
  // context, which the follow-up must stay inside.
  let teamId = "";
  let parentId: string | undefined;
  let projectId: string | undefined;
  let projectMilestoneId: string | undefined;
  let originatingUuid = "";
  let rejectedEpic = "";
  let inherited: string[] = [];
  if (args.originating !== "") {
    const data = await linear(
      `query($id: String!) { issue(id: $id) {
         id team { id } parent { id identifier }
         project { id } projectMilestone { id }
         labels(first: 50) { pageInfo { hasNextPage } nodes { name } }
       } }`,
      { id: args.originating },
      signal,
    );
    const issue = data.issue as {
      id: string;
      team: { id: string };
      parent: { id: string; identifier: string } | null;
      project: { id: string } | null;
      projectMilestone: { id: string } | null;
      labels: Connection<{ name: string }>;
    } | null;
    if (!issue) {
      fail(1, `defer-batch: originating issue ${args.originating} not found`);
    }
    assertComplete(
      issue.labels.pageInfo,
      `the labels on originating issue ${args.originating}`,
    );
    originatingUuid = issue.id;
    teamId = issue.team.id;
    rejectedEpic = issue.parent?.identifier ?? "";
    // "Is itself an epic → no parent" is a row of the protocol's table in its
    // own right, and reading only `parent` collapsed it into the ordinary
    // child case: a NESTED epic has a parent, so its batch was parented to the
    // grandparent-level epic instead of being filed parentless.
    //
    // The discriminator is the workspace's `epic` FLAG LABEL and nothing else.
    // An earlier revision also treated a non-empty `children` connection as
    // proof, reading the protocol table's "(has children)" as a test; it is a
    // gloss, and child-bearing is far weaker evidence than it looks — most
    // issues with children are mid-tree groupings that have a genuine epic
    // parent of their own, and misreading one as an epic files its batch
    // PARENTLESS, discarding the real parent the table asks for. The epic label
    // (`issue_tracker.labels.epic`) exists for exactly this question, so ask
    // it.
    const originatingIsEpic = issue.labels.nodes.some(
      (n) => n.name === EPIC_LABEL,
    );
    if (!args.noParent && !originatingIsEpic && issue.parent) {
      parentId = issue.parent.id;
    }
    // "No parent — same project and milestone" (deferral-protocol.md § Parent).
    // Only on the parentless rows: where an epic IS the parent, the protocol
    // says nothing about planning fields and this must not invent a placement.
    if (parentId === undefined) {
      projectId = issue.project?.id;
      projectMilestoneId = issue.projectMilestone?.id;
    }
    inherited = inheritedContextLabels(issue.labels.nodes.map((n) => n.name));
  } else {
    assertNotAborted(signal, "the team lookup");
    const data = await linear(
      `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }`,
      { key: args.team },
      signal,
    );
    const nodes = (data.teams as { nodes: Array<{ id: string }> }).nodes;
    if (nodes.length !== 1) {
      fail(
        1,
        `defer-batch: team key '${args.team}' did not resolve to one team`,
      );
    }
    const team = nodes[0];
    if (team === undefined) throw new Error("Team lookup returned no result");
    teamId = team.id;
  }

  // Computed ONCE and reused everywhere a fresh scaffold is built (create,
  // and both repair paths below) — the domain-mismatch audit trail the
  // protocol requires of every parentless follow-up must survive whichever
  // path actually builds the scaffold, not just the create path.
  const noParentRationale: NoParentRationale | undefined = args.noParent
    ? { reason: args.noParentReason, rejectedEpic }
    : undefined;

  // FIND — a failure here THROWS (runMain → exit 1); it is never "not found",
  // and neither is a truncated page (`assertComplete` below). The needle is
  // the WHOLE batch title rather than `PR #<N> `: `isBatchTitle` demands exact
  // equality anyway, so nothing that could match is lost, and the narrower
  // server-side filter keeps the page from being where a same-key batch hides.
  assertNotAborted(signal, "the FIND_BATCHES lookup");
  const found = await linear(
    FIND_BATCHES,
    { search: batchTitle(args.pr, args.type) },
    signal,
  );
  const foundConn = found.issues as Connection<Candidate>;
  assertComplete(
    foundConn.pageInfo,
    `the open \`pr-followup\` issues matching '${batchTitle(args.pr, args.type)}'`,
  );
  const titleMatches = (foundConn.nodes ?? []).filter((c) =>
    isBatchTitle(c.title, args.pr, args.type),
  );
  for (const c of titleMatches) {
    assertComplete(c.labels.pageInfo, `the labels on ${c.identifier}`);
  }
  // The key carries no repository, so another repo's PR of the same number and
  // Type produces an identically titled batch. Excluding it here is what keeps
  // a deferral from being filed into someone else's backlog.
  const candidates: Candidate[] = [];
  for (const c of titleMatches) {
    const verdict = repoVerdict(c.labels.nodes, args.repoLabel);
    if (verdict === "this-repo") {
      candidates.push(c);
    } else if (verdict === "other-repo") {
      console.error(
        `defer-batch: ignoring ${c.identifier} — same title, different Repo label than '${args.repoLabel}'.`,
      );
    } else if (verdict === "ambiguous") {
      fail(
        1,
        `defer-batch: ${c.identifier} matches the batch key '${batchTitle(args.pr, args.type)}' but carries MORE THAN ONE Repo label, so which repository it belongs to is undecidable even though '${args.repoLabel}' is among them. Fix ${c.identifier}'s Repo group in Linear, then re-run.`,
      );
    } else {
      fail(
        1,
        `defer-batch: ${c.identifier} matches the batch key '${batchTitle(args.pr, args.type)}' but carries no Repo label, so there is no way to tell whether it is this repository's batch or another's. Refusing to append: claiming it would file this finding into someone else's backlog AND stamp that issue '${args.repoLabel}'. Label ${c.identifier} with its Repo group in Linear, then re-run.`,
      );
    }
  }

  const entry = renderEntry({
    sourceUrl: args.sourceUrl,
    entryKey: args.entryKey,
    finding,
    reason: args.reason,
    severity: args.severity,
    category: args.category,
    fix: args.fix === "" ? undefined : args.fix,
  });

  let identifier: string;
  let url: string;
  let created = false;
  let appended = false;
  let alreadyPresent = false;
  let labelsAdded: string[] = [];
  let relatedLinked = false;

  if (candidates.length > 0) {
    const target = pickBatch(candidates);
    for (const c of candidates) {
      if (c !== target) {
        console.error(
          `defer-batch: WARNING — duplicate open batch issue ${c.identifier} under the same key; appending to the oldest (${target.identifier}). Merge the duplicates.`,
        );
      }
    }
    assertComplete(
      target.relations.pageInfo,
      `the relations on ${target.identifier}`,
    );
    assertComplete(
      target.inverseRelations.pageInfo,
      `the inverse relations on ${target.identifier}`,
    );
    identifier = target.identifier;
    url = target.url;
    // A hand-filed or partially-created batch can have a null/empty
    // description — reachable since the lookup became title-keyed and started
    // finding batches it previously skipped. Appending the bare entry to it
    // would leave the description never recording the PR or the originating
    // issue, which the protocol requires of every follow-up.
    //
    // The no-parent block in the rebuilt scaffold is derived from the
    // batch's OWN `parent` field (`target.parent`), not from this
    // invocation's own `noParentRationale` — see `descriptionForRepair` /
    // `noParentRationaleForRepair`. An append neither changes nor reads a
    // batch's `parentId`, so using this run's own flag here could describe a
    // genuinely parented batch as parentless (or the reverse), corrupting
    // the placement audit trail. `!= null`, not `!== null` — see the sibling
    // call site's own comment in `appendWithRetry`.
    const existingDescription = target.description ?? "";
    // Whether `baseDescription` below is a rebuild from a wipe, using
    // `target.parent` — read at the INITIAL find, not a later query — as its
    // `hasParent`. That staleness is exactly what `appendWithRetry`'s
    // `everRebuiltScaffold`/placement check exists to catch: a reparent or
    // unparent racing between this read and the write below leaves the
    // scaffold's placement claim wrong the moment it is written.
    const seedWasRepaired = existingDescription.trim() === "";
    const baseDescription = descriptionForRepair(
      existingDescription,
      args.pr,
      args.originating,
      target.parent != null,
    );
    const next = appendEntry(baseDescription, entry, args.entryKey);
    appended = next.appended || baseDescription !== existingDescription;
    alreadyPresent = !next.appended;

    // The ownership judgment the protocol requires BEFORE batching
    // (deferral-protocol.md lines 105-108): a finding owned by a different
    // agent/domain than the rest of this batch must be filed as its own
    // issue, not folded in here. `codearea:*` is exempt — see
    // `ownerDomainMismatches`.
    //
    // `inherited` UNIONED WITH `args.extraLabels`, not `inherited` alone —
    // `--labels` is allowed to carry `agent:`/`domain:` labels (only
    // Type/Size/Repo extras are rejected, in `parseArgs`), so an originating
    // issue with no owner label plus an explicit `--labels agent:compliance`
    // would otherwise present an EMPTY incoming set here, which this
    // function's own contract reads as "nothing to disagree with" (the
    // batch's first-entry case) — silently bypassing the guard on an
    // ordinary append. Computed once and reused by `appendWithRetry` below,
    // which re-checks this same disjointness against every FRESH read
    // inside the retry loop — a concurrent writer can change the batch's
    // ownership mid-append, not just at this initial read.
    const incomingOwnership = [...new Set([...inherited, ...args.extraLabels])];
    const ownerMismatches = ownerDomainMismatches(
      target.labels.nodes.map((n) => n.name),
      incomingOwnership,
    );
    if (ownerMismatches.length > 0) {
      fail(
        1,
        `defer-batch: ${identifier} is owned by ${ownerMismatches
          .map((m) => `${m.group}:(${m.batchHas.join(", ")})`)
          .join(
            ", ",
          )}, but this finding's originating issue carries ${ownerMismatches
          .map((m) => `${m.group}:(${m.incomingHas.join(", ")})`)
          .join(
            ", ",
          )} — a finding owned by a different agent/domain than the rest of the batch gets its own issue, not a fold into this one (deferral-protocol.md § Filing the follow-up issue, lines 105-108). Drop --batch and file it individually.`,
      );
    }

    // The batch's OWN Size at the read this run started from — not
    // `args.size`. A differing Size is deliberately TOLERATED (both values
    // are legitimate batch sizes, see `missingSingleValued`), so if a
    // concurrent writer erases the Size label entirely mid-loop, repairing
    // it with `args.size` would silently resize the batch to THIS run's
    // value even when the batch was legitimately sized differently (e.g. an
    // `xs` batch appended to by a `small`-default invocation) —
    // `batchContractHolds` would then accept the drift, since it tolerates
    // either batchable size (a concurrent-write regression). Falls back to
    // `args.size` only when the batch genuinely has no Size label at read time
    // — nothing to preserve, same as the create path.
    const originalSize =
      target.labels.nodes.find((l) => groupOf(l) === SIZE_GROUP)?.name ??
      args.size;
    // The batch's OWN Linear priority at the read this run started from —
    // `Candidate.priority`, mirroring `originalSize` immediately above. Seeds
    // `appendWithRetry`'s escalate-never-downgrade tracking (see that
    // function's `originalPriority` parameter doc).
    const originalPriority = target.priority;

    // Bring the existing batch back to the contract — see RECONCILE in the
    // header. All of it is a no-op on the ordinary path where every entry
    // shares one originating issue; it is what makes a partially-applied
    // earlier run recoverable at all.
    const singleValued = missingSingleValued(target.labels.nodes, args);
    for (const c of singleValued.conflicts) {
      if (c.duplicate) {
        fail(
          1,
          `defer-batch: ${identifier} carries more than one ${c.group} label (${c.has}) — that group admits exactly one, so the batch is taxonomy-invalid and which value governs is undecidable. Fix ${identifier}'s ${c.group} group in Linear, then re-run.`,
        );
      }
      if (c.group === SIZE_GROUP && !isBatchableSize(c.has)) {
        // Reconciliation cannot fix this: a differing Size is deliberately
        // KEPT, so the batch stays unbatchable however many labels we add.
        // Checked here — before the dry-run return and before any mutation —
        // rather than only in the post-write verification, so the preview and
        // the real run reach the same verdict from the same gate, and the
        // real run stops before writing to a batch it is going to refuse.
        fail(
          1,
          `defer-batch: ${identifier} carries ${SIZE_GROUP} '${c.has}', which is not batchable (${BATCH_SIZES.join("|")}) — the protocol sends anything above 'small' to its own issue, so this batch must not collect further entries. File this finding individually instead.`,
        );
      }
      if (c.group === TYPE_GROUP) {
        // Type is not a judgment like Size — it IS the batch key. A batch
        // titled `… chore review follow-ups` carrying `bug` is not this key's
        // batch, so appending a chore finding to it and telling the caller to
        // resolve against it misfiles the finding under a Type that decides
        // which findings may share the batch at all.
        fail(
          1,
          `defer-batch: ${identifier} matches the key '${batchTitle(args.pr, args.type)}' but carries ${TYPE_GROUP} '${c.has}'. Type is the lookup key, so a batch whose Type disagrees with its title is mislabelled — appending here would file a '${args.type}' finding into a '${c.has}' batch. Fix ${identifier}'s Type in Linear, then re-run.`,
        );
      }
      console.error(
        `defer-batch: NOTE — ${identifier} already carries ${c.group} '${c.has}'; keeping it. The group is satisfied, and this run's value is not authoritative over the batch's first entry.`,
      );
    }
    // Computed BEFORE `missingLabels`: `repairableMissingLabels` needs the
    // full required-context set, not just `inherited`/`extraLabels` — a
    // context label the batch already carried before this run started is
    // required by the contract but invisible to `inherited ∪ extraLabels`
    // alone (concurrent-write regression).
    //
    // FAIL CLOSED, exactly as the create path does. An earlier revision warned
    // and appended, on the reasoning that refusing would lose the finding —
    // which is wrong: the operator can re-run with `--labels`, so the refusal
    // is retryable, while the warning shipped a ready `**deferred**` reply for
    // a batch still violating the mandatory Context group and falsified this
    // file's own claim that every append reconciles back to the contract.
    const contextAfter = contextAfterReconcile(
      target.labels.nodes.map((n) => n.name),
      inherited,
      args.extraLabels,
    );
    if (contextAfter.length === 0) {
      fail(
        1,
        `defer-batch: ${identifier} carries no agent:/domain:/codearea: label and this run supplies none to add — the Context group is mandatory on every issue (deferral-protocol.md § Filing the follow-up issue). Re-run with --labels domain:...,codearea:... .`,
      );
    }
    // `args` with Size overridden to the batch's OWN value — see
    // `originalSize` above. Reused for both this repair computation and its
    // group-membership check below, so a repaired Size and its validation
    // cannot disagree about which value is correct.
    const wantedForRepair = { ...args, size: originalSize };
    // The seed for `appendWithRetry`'s OWN `missingLabels`, which it
    // recomputes from a fresh read on every retry attempt via this same
    // function — see `appendWithRetry` and `repairableMissingLabels`.
    const missingLabels = repairableMissingLabels(
      target.labels.nodes,
      wantedForRepair,
      contextAfter,
      args.extraLabels,
    );
    const needsRelation =
      originatingUuid !== "" &&
      !hasRelationTo(
        [...target.relations.nodes, ...target.inverseRelations.nodes],
        originatingUuid,
      );

    // Read-only, and BEFORE the dry-run return — the create path's sibling of
    // this same check. An earlier fix covered the create path only, so
    // `--dry-run --labels nonexistent-label` still previewed "would add" for a
    // label the real run cannot resolve, contradicting this file's own claim
    // that a dry run validates every label.
    let addLabels: LabelNode[] = [];
    if (missingLabels.length > 0) {
      addLabels = await fetchLabels(linear, missingLabels, signal);
      assertGroupMembership(addLabels, wantedForRepair);
    }

    if (args.dryRun) {
      const priorityBump = !priorityReflectsSeverity(
        originalPriority,
        args.severity,
      );
      console.error(
        `defer-batch: dry-run — would ${appended ? "append to" : "skip (entry already present in)"} ${identifier}` +
          (missingLabels.length > 0
            ? `, add label(s) ${missingLabels.join(", ")}`
            : "") +
          (priorityBump
            ? `, and bump priority to ${SEVERITY_TO_PRIORITY[args.severity]} (severity '${args.severity}', currently ${originalPriority})`
            : "") +
          (needsRelation
            ? `, and add the missing related link to ${args.originating}`
            : ""),
      );
      // Return here rather than falling through: the normal output reports
      // `appended` and prints a ready `**deferred**` reply, which a caller
      // acts on by resolving a thread whose finding this run never persisted.
      process.stdout.write(
        `${JSON.stringify({
          identifier,
          url,
          title: batchTitle(args.pr, args.type),
          created: false,
          appended: false,
          alreadyPresent: false,
          labelsAdded: [],
          relatedLinked: false,
          dryRun: true,
        })}\n`,
      );
      return 0;
    }
    {
      const retryResult = await appendWithRetry(
        linear,
        { id: target.id, identifier },
        next.description,
        seedWasRepaired,
        // A priority bump is a THIRD reason this run must write, alongside
        // a fresh entry and a missing label — see `priorityReflectsSeverity`.
        appended ||
          addLabels.length > 0 ||
          !priorityReflectsSeverity(originalPriority, args.severity),
        addLabels,
        missingLabels,
        entry,
        args,
        originalSize,
        originalPriority,
        incomingOwnership,
        contextAfter,
        signal,
        undefined, // sleep — default real timer
        // `appended` alone, not the wider `needsInitialWrite` above — a
        // labels- or priority-only write has no description change to make.
        // See `needsInitialDescriptionWrite`'s own doc.
        appended,
      );
      if (!retryResult.confirmed) {
        fail(
          1,
          `defer-batch: updated ${identifier} ${APPEND_ATTEMPTS} times and ${retryResult.unconfirmed} did not survive — a concurrent writer keeps overwriting it. Do NOT resolve the review thread: this run cannot show the finding is tracked. Re-run once the other agent has finished.`,
        );
      }
      labelsAdded = retryResult.labelsAdded;
    }
    if (needsRelation) {
      await createRelated(linear, target.id, originatingUuid, signal);
      relatedLinked = true;
    }
  } else {
    // The Context group is mandatory too, and `--originating none --team X`
    // reaches here with `inherited` empty — every named label then resolves
    // and the create succeeds with no agent:/domain:/codearea: label at all.
    //
    // The predicate is the PREFIX filter, not "are there any labels to apply":
    // `--labels manual-ops` supplies a label without supplying a CONTEXT one,
    // so counting the extras satisfied this guard while leaving the group
    // empty (a regression from an earlier fix).
    const context = contextAfterReconcile([], inherited, args.extraLabels);
    if (context.length === 0) {
      fail(
        1,
        `defer-batch: no agent:/domain:/codearea: label to apply — the Context group is mandatory on every issue (deferral-protocol.md § Filing the follow-up issue). ${
          args.originating === ""
            ? "With --originating none there is nothing to inherit: pass --labels domain:...,codearea:... ."
            : `Originating issue ${args.originating} carries none either: pass --labels domain:...,codearea:... .`
        }`,
      );
    }
    // Resolve every label id up front; a missing REQUIRED one aborts the
    // create — the mandatory groups are the contract, not decoration.
    const wanted = [
      ...new Set([
        PROVENANCE_LABEL,
        args.type,
        args.size,
        args.repoLabel,
        ...inherited,
        ...args.extraLabels,
      ]),
    ];
    // Read-only, so the DRY RUN does it too: a preview that skipped this
    // printed "would create" for a typoed label, a missing required one, or an
    // extra from a conflicting single-valued group — every one of which aborts
    // the identical real command. A preview that disagrees with the run is
    // worse than no preview.
    const labels = await fetchLabels(linear, wanted, signal);
    assertGroupMembership(labels, args);
    const labelIds = labels.map((l) => l.id);

    if (args.dryRun) {
      console.error(
        `defer-batch: dry-run — would create '${batchTitle(args.pr, args.type)}' and append the entry`,
      );
      process.stdout.write(
        `${JSON.stringify({
          identifier: null,
          url: null,
          title: batchTitle(args.pr, args.type),
          created: false,
          appended: false,
          alreadyPresent: false,
          labelsAdded: [],
          relatedLinked: false,
          dryRun: true,
        })}\n`,
      );
      return 0;
    }
    const desc = appendEntry(
      initialDescription(args.pr, args.originating, noParentRationale),
      entry,
      args.entryKey,
    ).description;
    assertNotAborted(signal, "the batch-issue creation");
    const createData = await linear(
      `mutation($input: IssueCreateInput!) {
         issueCreate(input: $input) { success issue { id identifier url } }
       }`,
      {
        input: {
          teamId,
          title: batchTitle(args.pr, args.type),
          description: desc,
          labelIds,
          priority: SEVERITY_TO_PRIORITY[args.severity],
          ...(parentId !== undefined ? { parentId } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
          ...(projectMilestoneId !== undefined ? { projectMilestoneId } : {}),
        },
      },
      signal,
    );
    const createPayload = createData.issueCreate as {
      success: boolean;
      issue: { id: string; identifier: string; url: string } | null;
    } | null;
    assertMutationOk(createPayload, "the batch-issue creation");
    const createdIssue = createPayload?.issue;
    if (!createdIssue) {
      fail(
        1,
        "defer-batch: issueCreate reported success but returned no issue",
      );
    }
    identifier = createdIssue.identifier;
    url = createdIssue.url;
    created = true;
    appended = true;
    labelsAdded = wanted;
    // Find-then-create is not atomic and Linear has no unique-title
    // constraint, so two runs that both saw no candidate both create. That
    // cannot be prevented here (see the header's concurrency note), but it CAN
    // be noticed: re-query the key now and name the duplicate loudly, so the
    // run that made the mess reports it instead of leaving it for whoever
    // reads the tracker later.
    //
    // Deliberately NOT guarded by `assertNotAborted`, unlike every call
    // above this point: `created` is already `true` here — the mutation
    // already landed. Aborting now would discard a successful create and
    // print "do NOT resolve the review thread" about a thread whose
    // finding this run DID persist, the exact false-failure `assertNotAborted`
    // exists to prevent elsewhere, turned inside out. A deadline firing here
    // just skips the duplicate-notice best-effort re-query, which is safe.
    const after = await linear(
      FIND_BATCHES,
      { search: batchTitle(args.pr, args.type) },
      signal,
    );
    const afterConn = after.issues as Connection<Candidate>;
    // Same completeness guards the initial lookup applies — a truncated page
    // here means a concurrent duplicate could sit past it, or a candidate's
    // Repo label be omitted, and the run would print success without the
    // warning this re-query exists to emit.
    assertComplete(
      afterConn.pageInfo,
      `the post-create re-query for '${batchTitle(args.pr, args.type)}'`,
    );
    const sameKey = (afterConn.nodes ?? []).filter(
      (c) =>
        isBatchTitle(c.title, args.pr, args.type) && c.id !== createdIssue.id,
    );
    for (const c of sameKey) {
      assertComplete(c.labels.pageInfo, `the labels on ${c.identifier}`);
    }
    const others: Candidate[] = [];
    for (const c of sameKey) {
      const verdict = repoVerdict(c.labels.nodes, args.repoLabel);
      if (verdict === "this-repo") {
        others.push(c);
      } else if (verdict !== "other-repo") {
        // The initial lookup aborts on `unlabelled`/`ambiguous` because
        // ownership cannot be determined, and that matters MORE here: a
        // same-key issue of undecidable ownership appearing right after a
        // concurrent create is the case most likely to be a duplicate.
        // Dropping it silently would let this run report success over exactly
        // that. The created issue stands — re-run once the ambiguity is
        // resolved and the append is idempotent.
        fail(
          1,
          `defer-batch: created ${identifier}, then found ${c.identifier} under the same batch key '${batchTitle(args.pr, args.type)}' whose Repo group is ${verdict} — ownership is undecidable, so this run cannot say whether it just made a duplicate. ${identifier} exists and carries the entry; do NOT resolve the review thread yet. Fix ${c.identifier}'s Repo group (and merge if it is a duplicate), then re-run.`,
        );
      }
    }
    for (const c of others) {
      console.error(
        `defer-batch: WARNING — ${c.identifier} carries the same batch key '${batchTitle(args.pr, args.type)}' as the ${identifier} just created; a concurrent run created one too. Both are open: merge them, keeping the oldest.`,
      );
    }
    if (originatingUuid !== "") {
      await createRelated(linear, createdIssue.id, originatingUuid, signal);
      relatedLinked = true;
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      identifier,
      url,
      title: batchTitle(args.pr, args.type),
      created,
      appended,
      alreadyPresent,
      labelsAdded,
      relatedLinked,
    })}\n`,
  );
  console.error(
    `defer-batch: ${created ? "created" : alreadyPresent ? "entry already present in" : "appended to"} ${identifier} — reply with:`,
  );
  console.error(
    `  **deferred** — ${args.reason}; batched in ${identifier}: ${url}`,
  );
  return 0;
}

if (import.meta.main) runMain("defer-batch", main);
