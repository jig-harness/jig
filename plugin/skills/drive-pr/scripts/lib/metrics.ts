/**
 * Turn one `PrSample` into the loop-economy numbers a drive reports, and render
 * them.
 *
 * Without these numbers every recall-reducing dial in review triage is tuned
 * blind: an 87.7% accepted share reads as "the materiality bar is not biting",
 * and the same number is equally consistent with "the reviewers were precise
 * and the fixes were needed". Neither reading can be preferred without a per-PR
 * baseline, and a baseline nobody can produce without manual archaeology is not
 * one.
 *
 * Pure over the sample, and separated from `loop-metrics.ts`'s CLI on purpose —
 * the attribution rule below is the one part of this worth pinning in a test,
 * and it must be pinnable without a network.
 *
 * ── Why growth is split at the moment review STARTED ───────────────────────
 *
 * The obvious measure — first commit's additions versus the merged diff's — is
 * the one this module explicitly rejects, and the evidence for rejecting it is
 * measured: one PR opened with a 17-line commit and merged at 2,777 additions.
 * Read naively that is 99% growth caused by review. But a driver often pushes a
 * deliberately minimal first commit and then the real body of the work BEFORE
 * any reviewer has looked, and every one of those pre-review additions lands in
 * the post-review bucket under a first-commit baseline. The measure would then
 * indict review for work review never asked for.
 *
 * The line that separates the two populations is the moment review STARTED: the
 * head the earliest initiating bot review was submitted against. It is
 * derivable from the PR alone — no durable state, no commit-message convention
 * to enforce, and correct retroactively over PRs driven before this script
 * existed.
 *
 * ── What the split does NOT establish ──────────────────────────────────────
 *
 * It is a TEMPORAL split, and nothing here makes it more than that. A commit
 * after the first reviewed head happened after review started; it is not
 * thereby a commit review demanded. Planned implementation continues after the
 * first round, CI gets repaired, the author finds their own bugs, the base gets
 * merged in. All of it lands in the same bucket, and this sample carries no
 * signal that separates "a round asked for this" from "this happened later".
 *
 * So the quantity is named and rendered as POST-REVIEW churn, not as
 * review-induced work. The distinction is not pedantry: these numbers exist to
 * stop the triage dials being tuned blind, and a causal label on a
 * correlational measure would replace one blind tuning with a confidently-wrong
 * one — the same error the first-commit baseline was rejected for, moved to a
 * later cutoff. It is also the standard this skill already holds
 * `defect-escape.ts` to: the mechanical half is computed, the causal verdict
 * stays a human's.
 *
 * Attributing to actual round transitions — matching commits to the findings
 * they answered — is the measurement that WOULD support the causal reading. The
 * sample does have the two other mechanisms a sound measure needs (merge
 * ancestry, so a sibling-branch merge's imports are not counted as this
 * branch's churn; rename-following, so `defect-escape.ts` does not lose a
 * recurrence to a renamed file), but deliberately not this one: round/finding
 * provenance needs commits matched to the findings they answered, which is a
 * different, considerably larger measurement — nothing here derives it
 * retroactively, unlike the other two. The non-licence above stays the honest
 * answer until it exists, and no triage dial may treat
 * `postReviewShare` as a cost-of-review figure in the meantime.
 */

import type { Outcome } from "./outcome.ts";
import { OUTCOMES } from "./outcome.ts";
import type { CommitSample, PrSample, ReviewSample } from "./sample.ts";

export interface SizeBlock {
  /** Non-merge, non-sibling commits — the ones that authored something HERE. */
  commits: number;
  additions: number;
  deletions: number;
  /** Merge commits skipped in this range. See `sizeOf`. */
  merges: number;
  /**
   * Of `merges`, the ones with 3+ parents.
   *
   * `classifySiblingCommits` only tests the merge's first TWO parents —
   * `CommitSample.parentOids` is itself capped there by the GraphQL query —
   * so a third-or-later parent's own imported commits never enter
   * `siblingOids` and fall through into `commits`/`additions`/`deletions`
   * below as ordinary authored churn, even though they were authored on that
   * parent's branch, not here. Reported rather than silently absorbed: a
   * nonzero count here means the totals above may be incomplete for those
   * specific commits, the same "report, never guess" posture the `sibling`
   * block below already takes for the two-parent case. Generalizing
   * classification itself to N parents needs the GraphQL query and
   * `CommitSample.parentOids` widened beyond two, which is a larger change
   * than this metric warrants for a merge shape this repo's own workflow does
   * not produce (no merge strategy here creates an octopus merge
   * automatically) — see `CommitSample.parentOids`.
   */
  octopusMerges: number;
  /**
   * One-parent commits imported by a sibling-branch merge —
   * excluded from `commits`/`additions`/`deletions` above because they were
   * authored on that other branch, not here, and reported separately rather
   * than silently dropped. See `classifySiblingCommits`.
   */
  sibling: { commits: number; additions: number; deletions: number };
}

/**
 * How the commit list was split into pre-review and post-review.
 *
 * `commit` — the first reviewed head is one of the PR's current commits, so the
 *   split is exact.
 * `time` — it is NOT, which means history was rewritten after that review (a
 *   force-push, a rebase onto a moved base). The split falls back to commit
 *   timestamps, which is an approximation and is labelled as one rather than
 *   presented as the same measurement.
 * `none` — no bot has reviewed this PR yet, so there is no post-review
 *   population to speak of and everything is opening work.
 */
export type Attribution = "commit" | "time" | "none";

export interface LoopMetrics {
  pr: number;
  state: string;
  head: string;
  rounds: {
    /** Distinct heads a BOT reviewer submitted a review against. */
    reviewedHeads: number;
    /** The drive's own durable count, when this clone still holds it. */
    durable: number | null;
  };
  threads: {
    total: number;
    resolved: number;
    unresolved: number;
    bot: number;
    human: number;
    /** Threads whose comment list hit the per-thread cap — see `ThreadSample`. */
    truncated: number;
  };
  outcomes: Record<Outcome, number>;
  /**
   * The same outcome mix, cut by the raising comment's `🏷️ category:` tag
   * (`ThreadSample.category`) — `unknown` for every thread predating the tag
   * or carrying no readable tag. Keyed dynamically rather
   * than over a fixed enum: the category vocabulary lives in
   * `.config/review-triage.yaml` and may gain entries, so a hardcoded key set
   * here would silently omit a newly-added category's bucket instead of
   * reporting it. Only categories that actually occurred among ANSWERED
   * threads get a key — an unanswered thread contributes to neither `outcomes`
   * nor this breakdown, matching the top-level histogram's own scope.
   */
  outcomesByCategory: Record<string, Record<Outcome, number>>;
  /**
   * How often `severityOf` could not read a severity, per thread AUTHOR.
   *
   * INLINE THREADS ONLY — a reviewer's summary-only findings (its sticky
   * comment's own bullets, sampled separately by `summary-findings.ts` and
   * never folded into `PrSample.threads`) carry no severity signal here at
   * all, readable or not. A format
   * change that breaks only a reviewer's summary-bullet severity tag is
   * therefore invisible to this metric and can report a flattering 0%
   * while that reviewer's summary-only ladder entries are silently
   * `unknown` — the same outage this metric exists to catch, just outside
   * the population it counts. Folding summary findings in would need their
   * own attribution (the sticky comment has one severity per bullet, not
   * one per reviewer identity the way an inline thread's `startedBy`
   * gives), and is deliberately not attempted here rather than bolted on as
   * a fourth special case in this same block. Read this as an inline-thread
   * measurement, not a whole-reviewer one — `renderLoopMetrics` says so on
   * every run, not only in this comment.
   *
   * `severity` feeds `fail_open.inert_when_unknown` in
   * `.config/review-triage.yaml`, so an `unknown` leaves the decline ladder
   * inert for that finding. That is the correct fail-open direction — the
   * matcher is deliberately narrow and must stay so — but it means
   * a reviewer switching its severity glyph is a one-line change on their side
   * and a SILENT, TOTAL ladder outage on ours: every one of that reviewer's
   * findings reads `unknown`, in every round, and nothing said so.
   *
   * Per author, not merely in aggregate, because that is the cut that
   * diagnoses it: an aggregate share drifts up when one noisy reviewer posts
   * more, whereas one author jumping from ~0 to ~100% is the outage. Keyed on
   * `startedBy` — `(unknown author)` for a thread GitHub reported no login
   * for, so a bucket of unattributable threads cannot masquerade as a named
   * reviewer's rate.
   *
   * BOT-authored threads ONLY (`startedByBot`). A human reviewer emits no
   * severity token and never had a format to lose, so `severityOf` reads
   * `unknown` for every human thread BY CONSTRUCTION — counting them would
   * park every human at a permanent 100% and inflate the aggregate with a
   * population that has no glyph to switch, defeating the one diagnostic this
   * metric exists to give ("~0 → ~100% is the outage"). Worse, it would make
   * the rendered warning below — "this reviewer's format is no longer
   * recognized" — a claim that is false of every human it named.
   *
   * Scoped to every BOT thread, answered or not — unlike `outcomesByCategory`,
   * which measures the outcome mix and so can only count answered ones. The
   * question here is whether the finding's severity was READABLE, which is
   * settled the moment it is posted and does not wait on a reply.
   *
   * `total`/`unknown`/`unknownShare` are LIFETIME figures — every bot thread
   * this author ever raised on this PR. On a long-running driven PR that is
   * exactly the population most likely to dilute the outage this metric exists
   * to catch: a reviewer readable for the first N rounds and then broken for
   * the rest reports a share dragged toward 0% by its own history, never the
   * ~100% the live outage actually is.
   * `recentTotal`/`recentUnknown`/`recentUnknownShare` answer the question the
   * lifetime figure cannot: scoped to this author's own most recent INITIATING
   * review head (`latestReviewHeadByAuthor` below) — i.e. THEIR current round,
   * not the PR's.
   *
   * `recentRoundKnown` is the discriminator `recentUnknownShare === null` used
   * to be overloaded to carry alone, and the overload was itself a bug:
   * "no initiating review
   * recorded for this author" (truly unattributable — fall back to the
   * lifetime figure) and "their latest round is known and it raised zero
   * findings" (measured, and clean) both collapsed onto `recentTotal === 0`,
   * so a lifetime-unreadable finding from an EARLIER round could resurface as
   * a fabricated "every finding this round" outage on a round that in fact had
   * none. `recentRoundKnown` is true iff `latestReviewHeadByAuthor` has an
   * entry for this author, independent of whether that known round produced
   * any threads. `recentUnknownShare` is `null` ONLY when `recentRoundKnown`
   * is false; when the round is known but empty it is `0` — a real measured
   * value, not a flattering default, and never read back into an outage
   * because `renderLoopMetrics` also gates the outage on `recentTotal > 0`.
   */
  severityByAuthor: Record<
    string,
    {
      total: number;
      unknown: number;
      unknownShare: number;
      recentRoundKnown: boolean;
      recentTotal: number;
      recentUnknown: number;
      recentUnknownShare: number | null;
    }
  >;
  /**
   * The same `unknown` count over every BOT thread, and its share — `null`
   * when there were no bot threads at all, which is "not measured", not 0%.
   * `total` is therefore the bot-thread count, NOT `threads.total`: reading
   * the share against the latter would dilute it by however many humans
   * commented. Inline threads only — see `severityByAuthor`'s own doc
   * comment for why a reviewer's summary-only findings are outside this
   * count entirely, not merely folded into whichever bucket they'd land in.
   */
  unknownSeverity: { count: number; total: number; share: number | null };
  unanswered: number;
  answered: number;
  /** `accepted / answered`, or `null` when nothing was answered. */
  acceptedShare: number | null;
  attribution: Attribution;
  firstReviewedHead: string | null;
  firstReviewedAt: string | null;
  /** Authored churn at or before the first reviewed head. */
  opening: SizeBlock;
  /**
   * Authored churn in the commits AFTER the first reviewed head.
   *
   * Temporal, not causal — see "What the split does NOT establish" above. This
   * is every commit that landed after review started, whatever prompted it.
   */
  postReview: SizeBlock;
  /** The PR's own NET diff — not churn, and not comparable to the two above. */
  merged: { additions: number; deletions: number; changedFiles: number };
  /**
   * `postReview.additions / (opening.additions + postReview.additions)`.
   * Churn over churn, so the ratio is coherent; `null` when nothing was added.
   */
  postReviewShare: number | null;
}

/**
 * Churn over a commit range, EXCLUDING merge commits and sibling-branch
 * imports.
 *
 * A merge commit's line stats are its diff against its first parent, so a
 * routine `git merge origin/develop` reports the whole base-branch delta as if
 * this branch had authored it. Measured on the first baseline week: one such
 * commit on one PR contributed +52,015 of that PR's 52,442 post-review
 * additions, on a PR whose entire net diff is 222 lines. Left in, the metric
 * says a round demanded fifty thousand lines nobody wrote — and since merging
 * the base in is exactly what a long-running driven PR does, the error is
 * biggest on the PRs the dials are aimed at.
 *
 * `parents >= 2` proves "merge commit", NOT "base-sync merge", and the gap was
 * real: a PR that merges a sibling FEATURE branch has that merge NODE's diff
 * excluded too, same as a base sync. But a
 * sibling branch's own one-parent commits are NOT in the base, so GitHub lists
 * them among this PR's commits — and unlike a base sync's imports, they were
 * authored on that OTHER branch, not here.
 * `siblingOids` is exactly that set, pre-resolved by `classifySiblingCommits`
 * before this function ever sees the commit list, so those commits are pulled
 * out of `commits`/`additions`/`deletions` into `sibling` instead of being
 * counted as work authored on this branch.
 */
function sizeOf(
  commits: ReadonlyArray<{
    oid: string;
    additions: number;
    deletions: number;
    parents: number;
  }>,
  siblingOids: ReadonlySet<string>,
): SizeBlock {
  let additions = 0;
  let deletions = 0;
  let merges = 0;
  let octopusMerges = 0;
  let authored = 0;
  let sibCommits = 0;
  let sibAdditions = 0;
  let sibDeletions = 0;
  for (const c of commits) {
    if (c.parents >= 2) {
      merges += 1;
      if (c.parents > 2) octopusMerges += 1;
      continue;
    }
    if (siblingOids.has(c.oid)) {
      sibCommits += 1;
      sibAdditions += c.additions;
      sibDeletions += c.deletions;
      continue;
    }
    authored += 1;
    additions += c.additions;
    deletions += c.deletions;
  }
  return {
    commits: authored,
    additions,
    deletions,
    merges,
    octopusMerges,
    sibling: {
      commits: sibCommits,
      additions: sibAdditions,
      deletions: sibDeletions,
    },
  };
}

/**
 * Which commits in a PR's list were authored on a sibling branch and only
 * arrived here via a merge, rather than authored on this branch.
 *
 * A merge commit's SECOND parent is the tip of whatever got merged in. When
 * that tip is an ancestor of the base ref, the merge is an ordinary base sync
 * — `git merge origin/develop` — and the commits it imported are themselves
 * already ancestors of the base, which is why GitHub does not list them among
 * this PR's own commits in the first place; nothing extra needs excluding.
 * When it is NOT an ancestor, the merge imported a sibling feature branch, and
 * every commit reachable from that second parent but not from the merge's
 * OWN first parent is that sibling branch's work, not this one's.
 *
 * `isAncestorOfBase` and `siblingCommitsOf` are both injected — the ancestry
 * test and the commit-set walk are local `git` operations, and `lib/metrics.ts`
 * has to stay pinnable without a network or a repository, exactly as
 * `lib/escape.ts` does for its own recurrence rule. The CLI (`loop-metrics.ts`)
 * supplies the real ones; a test supplies fakes.
 *
 * `isAncestorOfBase` returning `null` means the ancestry could not be
 * established locally — a base ref this clone has not fetched, most likely —
 * and a merge in that state is left alone rather than guessed either way,
 * matching `laterFixCommits`'s "no local evidence, never asserted absence"
 * rule for the same kind of best-effort local check.
 */
export function classifySiblingCommits(
  commits: ReadonlyArray<Pick<CommitSample, "oid" | "parents" | "parentOids">>,
  isAncestorOfBase: (oid: string) => boolean | null,
  siblingCommitsOf: (
    firstParentOid: string,
    secondParentOid: string,
  ) => ReadonlySet<string>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const c of commits) {
    if (c.parents < 2) continue;
    const [first, second] = c.parentOids;
    if (first === undefined || second === undefined) continue;
    if (isAncestorOfBase(second) !== false) continue;
    for (const oid of siblingCommitsOf(first, second)) out.add(oid);
  }
  return out;
}

/**
 * The reviews that mark a ROUND: initiating bot reviews with a readable head
 * and timestamp, oldest first. Exported so `fractal.ts` indexes a thread's
 * round against the identical population `rounds.reviewedHeads` counts — two
 * private copies of this filter would let "round 4" and "4 reviewed heads"
 * drift apart.
 */
export function initiatingBotReviews(
  reviews: ReadonlyArray<ReviewSample>,
): ReviewSample[] {
  return reviews
    .filter(
      (r) => r.isBot && r.initiating && r.oid !== "" && r.submittedAt !== "",
    )
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

export function computeLoopMetrics(
  sample: PrSample,
  durableRounds: number | null,
  /**
   * Commits authored on a sibling branch and imported by a merge — see
   * `classifySiblingCommits`.
   *
   * Mandatory rather than defaulting to an empty `Set`: a default here is a
   * pre-GA compatibility path that silently reproduces the known-wrong "sibling
   * commits count as authored churn" behaviour for any caller that has not
   * resolved the ancestry — and BWC concerns are explicitly deferred pre-GA,
   * so the corrected contract requires every caller to state its own answer.
   * A caller with genuinely nothing to exclude
   * passes `new Set()` explicitly, same as it always did — the only change is
   * that omitting the argument is no longer possible.
   */
  siblingCommitOids: ReadonlySet<string>,
): LoopMetrics {
  // Only INITIATING bot reviews mark a round. A thread reply is recorded as a
  // review, for bots exactly as for humans — the driver's own outcome replies
  // on one measured PR showed up as 63 of its 120 reviews — so counting every
  // review reports the loop's own answers back to it as rounds. The bot half of
  // that is not hypothetical: a measured share of the baseline week's bot
  // reviews are reply-only (all `coderabbitai`), and they made heads read as
  // reviewed when nothing had reviewed them. Figures in
  // `review-loop-baseline.md`, which owns them. See `ReviewSample.initiating`.
  const botReviews = initiatingBotReviews(sample.reviews);
  const reviewedHeads = new Set(botReviews.map((r) => r.oid)).size;
  const first = botReviews[0] ?? null;

  // Each bot author's own most recent initiating-review head — their current
  // round, for `severityByAuthor`'s `recent*` windowing below. `botReviews` is
  // sorted ascending by `submittedAt`, so the last write per author wins.
  const latestReviewHeadByAuthor: Record<string, string> = Object.create(
    null,
  ) as Record<string, string>;
  for (const r of botReviews) latestReviewHeadByAuthor[r.author] = r.oid;

  let attribution: Attribution = "none";
  let opening = sample.commits;
  let induced: typeof sample.commits = [];
  if (first !== null) {
    const idx = sample.commits.findIndex((c) => c.oid === first.oid);
    if (idx >= 0) {
      attribution = "commit";
      opening = sample.commits.slice(0, idx + 1);
      induced = sample.commits.slice(idx + 1);
    } else {
      // The reviewed head is gone from the branch — history was rewritten after
      // it. Timestamps are what is left; say so rather than quietly presenting
      // an approximation as the exact split.
      attribution = "time";
      opening = sample.commits.filter(
        (c) => c.committedDate !== "" && c.committedDate <= first.submittedAt,
      );
      induced = sample.commits.filter(
        (c) => c.committedDate === "" || c.committedDate > first.submittedAt,
      );
    }
  }

  const emptyOutcomeCounts = (): Record<Outcome, number> =>
    Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  const outcomes = emptyOutcomeCounts();
  const outcomesByCategory: Record<
    string,
    Record<Outcome, number>
  > = Object.create(null) as Record<string, Record<Outcome, number>>;
  type SeverityBucket = {
    total: number;
    unknown: number;
    unknownShare: number;
    recentRoundKnown: boolean;
    recentTotal: number;
    recentUnknown: number;
    recentUnknownShare: number | null;
  };
  const severityByAuthor: Record<string, SeverityBucket> = Object.create(
    null,
  ) as Record<string, SeverityBucket>;
  let unknownSeverityCount = 0;
  let unanswered = 0;
  let resolved = 0;
  let bot = 0;
  let truncated = 0;
  let botSeverityTotal = 0;
  for (const t of sample.threads) {
    // Before the answered/unanswered split below: readability of the severity
    // is a property of the finding as posted, not of whether anyone replied.
    // Bots only — see `severityByAuthor`'s own doc.
    if (t.startedByBot) {
      const author = t.startedBy ?? "(unknown author)";
      severityByAuthor[author] ??= {
        total: 0,
        unknown: 0,
        unknownShare: 0,
        recentRoundKnown: author in latestReviewHeadByAuthor,
        recentTotal: 0,
        recentUnknown: 0,
        recentUnknownShare: null,
      };
      const bucket = severityByAuthor[author];
      bucket.total += 1;
      botSeverityTotal += 1;
      const inCurrentRound =
        t.reviewedHeadOid !== null &&
        t.reviewedHeadOid === latestReviewHeadByAuthor[author];
      if (inCurrentRound) bucket.recentTotal += 1;
      if (t.severity === "unknown") {
        bucket.unknown += 1;
        unknownSeverityCount += 1;
        if (inCurrentRound) bucket.recentUnknown += 1;
      }
    }
    if (t.outcome === null) unanswered += 1;
    else {
      outcomes[t.outcome] += 1;
      const categoryCounts =
        outcomesByCategory[t.category] ?? emptyOutcomeCounts();
      outcomesByCategory[t.category] = categoryCounts;
      categoryCounts[t.outcome] += 1;
    }
    if (t.isResolved) resolved += 1;
    if (t.startedByBot) bot += 1;
    if (t.commentsTruncated) truncated += 1;
  }
  const total = sample.threads.length;
  const answered = total - unanswered;
  // Computed once, after every thread is counted — a per-thread running share
  // would publish a partial denominator for every author but the last.
  for (const bucket of Object.values(severityByAuthor)) {
    bucket.unknownShare = bucket.unknown / bucket.total;
    // `null` only when the round itself is unattributable. A known round with
    // zero matching threads is a measured, clean 0 — not the same fact as "no
    // round could be scoped at all" — see the field's own doc comment above.
    bucket.recentUnknownShare = bucket.recentRoundKnown
      ? bucket.recentTotal > 0
        ? bucket.recentUnknown / bucket.recentTotal
        : 0
      : null;
  }

  const openingSize = sizeOf(opening, siblingCommitOids);
  const inducedSize = sizeOf(induced, siblingCommitOids);
  const authored = openingSize.additions + inducedSize.additions;

  return {
    pr: sample.pr,
    state: sample.state,
    head: sample.headRefOid,
    rounds: { reviewedHeads, durable: durableRounds },
    threads: {
      total,
      resolved,
      unresolved: total - resolved,
      bot,
      human: total - bot,
      truncated,
    },
    outcomes,
    outcomesByCategory,
    severityByAuthor,
    unknownSeverity: {
      count: unknownSeverityCount,
      total: botSeverityTotal,
      // No BOT threads is NOT MEASURED, never 0% — a 0% "everything parsed"
      // claim over an empty sample is the flattering direction, and this
      // metric exists to catch a silent outage.
      share:
        botSeverityTotal === 0 ? null : unknownSeverityCount / botSeverityTotal,
    },
    unanswered,
    answered,
    acceptedShare: answered === 0 ? null : outcomes.accepted / answered,
    attribution,
    firstReviewedHead: first?.oid ?? null,
    firstReviewedAt: first?.submittedAt ?? null,
    opening: openingSize,
    postReview: inducedSize,
    merged: {
      additions: sample.additions,
      deletions: sample.deletions,
      changedFiles: sample.changedFiles,
    },
    postReviewShare: authored === 0 ? null : inducedSize.additions / authored,
  };
}

function pct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

type SeverityBucket = LoopMetrics["severityByAuthor"][string];

/**
 * Whether a reviewer's unreadable severities describe a total outage in the
 * latest round we can attribute to that reviewer. When no round is
 * attributable, retain the loop report's lifetime fallback rather than
 * pretending that a missing measurement is clean.
 */
export function isSeverityOutage(bucket: SeverityBucket): boolean {
  return !bucket.recentRoundKnown
    ? bucket.unknownShare === 1
    : bucket.recentTotal > 0 && bucket.recentUnknownShare === 1;
}

/**
 * The high-signal subset of the severity metric for a round about to be
 * triaged. This deliberately reuses the same outage predicate as the terminal
 * loop-economy report: bot inline threads only, current round when known, and
 * a lifetime fallback only when that round cannot be attributed.
 */
export function renderSeverityOutageWarnings(m: LoopMetrics): string {
  const flagged = Object.entries(m.severityByAuthor)
    .filter(([, bucket]) => isSeverityOutage(bucket))
    .sort(([a], [b]) => a.localeCompare(b));

  return flagged
    .map(([author, bucket]) => {
      const scope = bucket.recentRoundKnown
        ? `${bucket.recentUnknown}/${bucket.recentTotal} this round (${pct(bucket.recentUnknownShare)})`
        : `${bucket.unknown}/${bucket.total} lifetime (${pct(bucket.unknownShare)}) — no review round could be attributed`;
      const span = bucket.recentRoundKnown
        ? "EVERY finding this round"
        : "EVERY attributable finding over the PR lifetime";
      return `  ⚠ ${span} — ${author}: ${scope} has an unreadable severity; this reviewer's format is no longer recognized, and its ladder is fully inert`;
    })
    .join("\n");
}

/**
 * The block a drive prints when it stops. Written to be read at the bottom of a
 * long unattended run, so every line is self-describing: a reader who has never
 * seen this output must not have to know that "opening" means churn and
 * "merged" means net diff.
 */
export function renderLoopMetrics(m: LoopMetrics): string {
  const lines: string[] = [];
  lines.push(`── loop economy — PR #${m.pr} (${m.state}) ──`);

  const durable =
    m.rounds.durable === null
      ? ""
      : ` (this clone's durable drive count: ${m.rounds.durable})`;
  lines.push(
    `  rounds     ${plural(m.rounds.reviewedHeads, "distinct head")} reviewed by a bot${durable}`,
  );

  const t = m.threads;
  lines.push(
    `  threads    ${t.total} total — ${t.bot} bot, ${t.human} human — ${t.resolved} resolved, ${t.unresolved} unresolved`,
  );
  if (t.truncated > 0) {
    lines.push(
      `             ⚠ ${plural(t.truncated, "thread")} could not be read in full; outcome WITHHELD, so it counts as unanswered rather than as a guess`,
    );
  }

  const mix = OUTCOMES.map((o) => `${o} ${m.outcomes[o]}`).join(" · ");
  lines.push(`  outcomes   ${mix} · unanswered ${m.unanswered}`);
  lines.push(
    `             accepted share ${pct(m.acceptedShare)} of the ${m.answered} answered`,
  );

  // `unknown` last, everything else alphabetical — the read-order the sticky
  // comment itself is heading toward: named categories are the signal, and
  // `unknown` (every finding predating the category tag, or one whose reviewer
  // never tagged it) is the residual bucket, not the lead line.
  const categories = Object.entries(m.outcomesByCategory).sort(([a], [b]) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return a.localeCompare(b);
  });
  categories.forEach(([cat, bucket], i) => {
    const catMix = OUTCOMES.filter((o) => bucket[o] > 0)
      .map((o) => `${o} ${bucket[o]}`)
      .join(" · ");
    const label = i === 0 ? "  by category" : "             ";
    lines.push(`${label} ${cat}: ${catMix}`);
  });

  // The ladder's fail-open input, made visible. Printed for every
  // PR rather than only above a threshold: a share is only a signal against
  // the reader's memory of the previous runs, and a line that appears only
  // when things are already bad teaches nobody what normal looks like.
  //
  // Authors sorted worst first by their CURRENT-round share when it is
  // measurable, falling back to the lifetime share otherwise — ranking on the
  // lifetime figure alone would bury a live outage behind its own diluted
  // history, exactly the failure this ranking exists to avoid.
  const sev = m.unknownSeverity;
  lines.push(
    `  severity   ${sev.count}/${sev.total} bot findings unreadable (${pct(sev.share)}) — an unreadable severity leaves the decline ladder INERT for that finding`,
  );
  lines.push(
    "             (inline threads only — a reviewer's summary-only findings carry no severity signal here)",
  );
  const rank = (b: SeverityBucket): number =>
    b.recentUnknownShare ?? b.unknownShare;
  const authors = Object.entries(m.severityByAuthor).sort(
    ([a, aBucket], [b, bBucket]) =>
      rank(bBucket) - rank(aBucket) || a.localeCompare(b),
  );
  for (const [a, b] of authors) {
    // A per-author line only for an author that actually has unreadable
    // findings: listing every healthy reviewer at 0.0% turns the one line
    // that matters into a needle.
    if (b.unknown === 0) continue;
    // Three states, not two — collapsing "unattributable" and "known but
    // empty" onto one `null` is exactly the bug this split fixes (see
    // `recentRoundKnown`'s own doc comment): an author whose ONLY lifetime
    // finding predates their latest round must read as a clean round, not as
    // a fabricated outage borrowed from stale history.
    const recent = !b.recentRoundKnown
      ? ""
      : b.recentTotal === 0
        ? " · 0 findings this round"
        : ` · ${b.recentUnknown}/${b.recentTotal} this round (${pct(b.recentUnknownShare)})`;
    // The outage is a CURRENT-round call when one is measurable — a reviewer
    // readable for most of a long PR and broken only in its latest round
    // must still trip this, which the lifetime share alone cannot do. Falls
    // back to the lifetime share only when this round could not be scoped at
    // all (unchanged behavior for a sample with no review data); a known but
    // EMPTY round is never an outage, however bad the author's earlier,
    // unrelated history reads.
    const outage = isSeverityOutage(b);
    const outageSpan = b.recentRoundKnown
      ? "EVERY finding this round"
      : "EVERY attributable finding over the PR lifetime";
    lines.push(
      `             ${a}: ${b.unknown}/${b.total} lifetime (${pct(b.unknownShare)})${recent}${outage ? ` ⚠ ${outageSpan} — this reviewer's format is no longer recognized, and its ladder is fully inert` : ""}`,
    );
  }

  // Merge commits are dropped from the churn on EVERY path, so the disclosure
  // belongs on every path too — the `none` branch prints a commit count that
  // already excludes them, and a reader comparing it against the PR's commit
  // list is owed the reason it disagrees. The wording says "merge", not
  // "base-merge": `sizeOf` cannot tell a base sync from a sibling-branch merge,
  // and claiming the lines came from the base is a claim it has not checked.
  const disclose = (block: SizeBlock, merges = block.merges): void => {
    if (merges > 0) {
      lines.push(
        `             (${plural(merges, "merge commit")} excluded from the churn — those lines were authored on another branch, not in a round on this one)`,
      );
    }
  };

  // A merge classified as a sibling-branch import: its own commits
  // ARE in the flat commit list (unlike a base sync's, which GitHub never
  // lists here in the first place), and `sizeOf` pulls them out of the
  // authored totals. Disclosed the same way `disclose` already is: a reader
  // whose count disagrees with the PR's commit list is owed the reason.
  const discloseSibling = (
    opening: SizeBlock["sibling"],
    postReview: SizeBlock["sibling"] = {
      commits: 0,
      additions: 0,
      deletions: 0,
    },
  ): void => {
    const commits = opening.commits + postReview.commits;
    if (commits === 0) return;
    const additions = opening.additions + postReview.additions;
    const deletions = opening.deletions + postReview.deletions;
    lines.push(
      `             (${plural(commits, "commit")}, ${additions}+/${deletions}-, imported by a sibling-branch merge — also excluded, authored on that branch)`,
    );
  };

  // An octopus merge (3+ parents): `classifySiblingCommits` only
  // tests the first two, so a third-or-later parent's own imports may be
  // sitting uncaught inside `authored` above rather than `sibling`. Disclosed
  // rather than silently trusted, the same "report, never guess" posture as
  // the two disclosures above.
  const discloseOctopus = (octopusMerges: number): void => {
    if (octopusMerges === 0) return;
    lines.push(
      `             ⚠ ${plural(octopusMerges, "octopus merge")} (3+ parents) among the merges above — sibling-branch classification only tests the first two parents, so authored/sibling totals may be incomplete for these`,
    );
  };

  if (m.attribution === "none") {
    lines.push(
      `  size       no bot review yet, so no growth is attributable to review`,
    );
    lines.push(
      `             authored ${m.opening.additions}+/${m.opening.deletions}- over ${plural(m.opening.commits, "commit")}`,
    );
    disclose(m.opening);
    discloseSibling(m.opening.sibling);
    discloseOctopus(m.opening.octopusMerges);
  } else {
    lines.push(
      `  size       opening ${m.opening.additions}+/${m.opening.deletions}- over ${plural(m.opening.commits, "commit")}, up to the first reviewed head ${(m.firstReviewedHead ?? "").slice(0, 12)}`,
    );
    lines.push(
      `             post-review ${m.postReview.additions}+/${m.postReview.deletions}- over ${plural(m.postReview.commits, "commit")} after review started`,
    );
    lines.push(
      `             post-review share of authored additions: ${pct(m.postReviewShare)} (temporal, not causal)`,
    );
    disclose(m.opening, m.opening.merges + m.postReview.merges);
    discloseSibling(m.opening.sibling, m.postReview.sibling);
    discloseOctopus(m.opening.octopusMerges + m.postReview.octopusMerges);
    if (m.attribution === "time") {
      lines.push(
        "             ⚠ approximate: the first reviewed head is no longer on the branch",
      );
      lines.push(
        "               (history was rewritten), so the split falls back to commit dates",
      );
    }
  }
  lines.push(
    `  merged     net diff ${m.merged.additions}+/${m.merged.deletions}- across ${plural(m.merged.changedFiles, "file")} (net, not churn — not comparable to the churn figures above)`,
  );
  return `${lines.join("\n")}\n`;
}
