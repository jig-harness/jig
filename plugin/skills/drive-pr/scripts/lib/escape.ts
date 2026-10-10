/**
 * The recurrence rule behind the defect-escape metric.
 *
 * Separated from `defect-escape.ts`'s CLI for the same reason `metrics.ts` is
 * separated from `loop-metrics.ts`'s: this is the one part of the escape sample
 * worth pinning in a test, and it must be pinnable without a network.
 *
 * ── Why merge order cannot decide a recurrence ─────────────────────────────
 *
 * `defect-escape.ts` walks the window oldest-merged-first, so "a later PR" is
 * one it has already read. But merge order does not establish FINDING order. A
 * long-running PR can receive its `accepted` finding days BEFORE a decline was
 * ever posted and still merge after it, and counting that as a recurrence of the
 * decline inverts cause and effect on the one number the whole recall trade rests
 * on — it would report an escape rate built partly from findings raised before
 * there was anything to escape (docomply-review round 1, a reference-implementation pull request).
 *
 * So proximity is necessary and NOT sufficient. A recurrence must also have been
 * RAISED after the decline was settled, and a candidate whose timestamps cannot
 * be read is reported but never counted — the same direction every weak signal
 * in this sample fails in.
 */

import type { PrSample, ThreadSample } from "./sample.ts";

/**
 * How close a later `accepted` thread has to be to count as the SAME finding
 * raised again.
 *
 * Not a tuned constant — a deliberately generous one. A file edited between the
 * two reviews shifts line numbers, so an exact match would miss real re-finds,
 * while the whole file admits every unrelated finding on a busy module. Twenty
 * lines is about one function body: near enough to be plausibly the same code,
 * far enough to survive ordinary drift. Both anchors must be known — see
 * `anchorLine`, which is what "known" means here; a thread with neither a
 * current nor an original line can only ever be a same-file match.
 */
export const PROXIMITY_LINES = 20;

/**
 * The line a thread is about, surviving the moment GitHub stops reporting one.
 *
 * A thread goes outdated — `line: null` — as soon as a later commit rewrites the
 * hunk it points at, which is to say precisely when somebody ACTED on it. So
 * `line` alone is blind to the threads most likely to be real fixes, and it is
 * blind to a large fraction of the population rather than a negligible one
 * (docomply-review round 2, a reference-implementation pull request).
 *
 * The measured proportions live in `review-loop-baseline.md` and deliberately
 * not here. They are a published RESULT — they move whenever the sample window
 * or the matcher changes — so a copy in this file is a second home that goes
 * stale silently, which is the same reasoning `defect-escape.ts`'s header
 * already states for its own totals (docomply-review round 9, a reference-implementation pull request). A
 * one-off diagnostic about a specific commit is different and is kept inline;
 * a baseline result is not.
 *
 * The two anchors are not on the same diff, so pairing them is an approximation
 * — which is exactly what `PROXIMITY_LINES` already absorbs, and the error is
 * smaller than the alternative of not matching at all.
 */
export function anchorLine(t: ThreadSample): number | null {
  return t.line ?? t.originalLine;
}

export interface Refind {
  pr: number;
  url: string | null;
  /**
   * The candidate thread's own path. Equal to the decline's path on an exact
   * match; different when `samePath` matched it through a rename
   * — carried so a caller can disclose that rather than presenting a renamed
   * match identically to a same-name one.
   */
  path: string | null;
  /** The candidate's `anchorLine()` — its current line, or its original one. */
  line: number | null;
  /** Within `PROXIMITY_LINES` of the decline's own anchor. */
  proximate: boolean;
  /** When this candidate thread was opened — `null` when unreadable. */
  raisedAt: string | null;
  /**
   * Raised strictly after the decline was settled. A recurrence needs BOTH this
   * and `proximate` — see the header.
   */
  after: boolean;
}

/** A recurrence: the same place, raised again after we declined it. */
export function isRecurrence(r: Refind): boolean {
  return r.proximate && r.after;
}

/**
 * The moment a decline was DECIDED, falling back to when it was raised.
 *
 * Both absent means nothing can be counted against this decline at all, which is
 * the correct answer rather than a licence to fall back to merge order.
 */
export function declinedAtOf(decline: ThreadSample): string | null {
  return decline.settledAt ?? decline.createdAt;
}

/**
 * Every `accepted` thread in `later` that could be this decline re-raised, each
 * carrying the two independent axes the caller counts on: line proximity, and
 * whether it was raised after the decline was settled.
 *
 * `later` is the samples merged after the decline's own PR. Reported in full —
 * a candidate that fails either axis is still visible in the output, because
 * suppressing it entirely would hide the very coincidences the proximity and
 * ordering rules exist to explain.
 *
 * A candidate's path only has to be the SAME FILE as the decline's, not the
 * same STRING. A file renamed between the declining PR and the PR that
 * re-raises the same defect used to fail an exact `path` comparison even when
 * anchor and ordering both agreed, discarding a real recurrence — and always
 * in the direction that makes the recall trade look safer than it is
 *. `samePath` is MANDATORY — see its own parameter doc below. A
 * caller wanting plain equality passes `(path) => path === decline.path`; a
 * caller that has traced renames locally (`defect-escape.ts`, via git)
 * passes a wider one.
 */
/**
 * Might this decline have been overtaken by a fix in its OWN pull request?
 *
 * A reviewer can re-raise a declined finding in a later round of the same PR
 * under a fresh thread, and that one gets `accepted` and fixed. The finding then
 * never shipped, so it is not a member of the "real, and shipped anyway"
 * population — which is why this is worth REPORTING.
 *
 * ── Why this only reports, and never drops ─────────────────────────────────
 *
 * It used to drop: a `true` here removed the decline from the sample outright,
 * taking the baseline denominator from 155 to 125. That was
 * wrong, and the evidence against it was already sitting in the same document.
 * The baseline records that five of nine proximate cross-PR matches were
 * coincidences and concludes that proximity plus ordering is a FILTER and not a
 * decision — and this predicate is the identical heuristic, used as a definitive
 * identity check, silently (chatgpt-codex-connector round 4, a reference-implementation pull request).
 *
 * Measured rather than argued, on the 30 candidates this flags over the baseline
 * week: of a random sample of the pairs, the decline and the "superseding"
 * acceptance were DIFFERENT findings almost every time — breaker-generation
 * tracking against constructor validation, BIO2 control A.7.10 against A.8.16, a
 * Windows rename race against a backoff placement. Within one PR the same file
 * is edited round after round, so an accepted thread within 20 lines of a
 * decline is if anything MORE common by chance than it is across PRs.
 *
 * So the consequence is the opposite of what it was: across PRs a proximate
 * match is reported for a human to adjudicate, and within one PR it is reported
 * for a human to adjudicate. The rule is the same because the evidence is the
 * same; what changed is that neither one gets to move a published number on its
 * own.
 *
 * `ownThreads` is the decline's own PR's thread list; the decline itself cannot
 * match, since a thread is never `accepted` and declined at once.
 */
export function supersededCandidateInOwnPr(
  decline: ThreadSample,
  ownThreads: ReadonlyArray<ThreadSample>,
): boolean {
  if (decline.path === null) return false;
  const declinedAt = declinedAtOf(decline);
  const declineAnchor = anchorLine(decline);
  if (declinedAt === null || declineAnchor === null) return false;
  return ownThreads.some((t) => {
    if (t.outcome !== "accepted" || t.path !== decline.path) return false;
    const anchor = anchorLine(t);
    return (
      anchor !== null &&
      Math.abs(anchor - declineAnchor) <= PROXIMITY_LINES &&
      t.createdAt !== null &&
      t.createdAt.localeCompare(declinedAt) > 0
    );
  });
}

export function refindsFor(
  decline: ThreadSample,
  later: ReadonlyArray<PrSample>,
  /**
   * Is `candidate` the same file `decline` is anchored to? See the header.
   *
   * Takes the whole candidate THREAD, not just its `path` string: two
   * threads can share a literal pathname while referring to different
   * incarnations of it (the string was reused after a rename), and a
   * resolver that only ever sees the bare string cannot tell them apart —
   * whatever answer it computes for one occurrence would be applied to
   * every other occurrence of that string too, silently collapsing distinct
   * identities (chatgpt-codex-connector round 4, a reference-implementation pull request). A caller that
   * has traced renames locally (`defect-escape.ts`) can bound its git walk
   * to THIS specific candidate's own `createdAt` because the full thread is
   * available here.
   *
   * Mandatory rather than defaulting to exact string equality: a default here
   * is a pre-GA compatibility path that silently reproduces the known rename
   * false-negative for any caller that has not been updated to supply real
   * path-identity — and BWC concerns are explicitly deferred pre-GA (no
   * standing data this call must stay compatible with), so the corrected
   * contract requires every caller to state its own answer rather than
   * inherit one it may not have considered (docomply-review, a reference-implementation pull request). Pass
   * `(candidate) => candidate.path === decline.path` explicitly for plain
   * equality.
   */
  samePath: (candidate: ThreadSample) => boolean,
): Refind[] {
  if (decline.path === null) return [];
  const declinedAt = declinedAtOf(decline);
  const declineAnchor = anchorLine(decline);
  const out: Refind[] = [];
  for (const s of later) {
    for (const t of s.threads) {
      if (t.outcome !== "accepted" || t.path === null || !samePath(t)) continue;
      const anchor = anchorLine(t);
      out.push({
        pr: s.pr,
        url: t.url,
        path: t.path,
        line: anchor,
        proximate:
          declineAnchor !== null &&
          anchor !== null &&
          Math.abs(anchor - declineAnchor) <= PROXIMITY_LINES,
        raisedAt: t.createdAt,
        // GitHub's timestamps are ISO-8601 UTC, so they order
        // lexicographically. STRICTLY later: a finding and a decline sharing a
        // timestamp to the second is not evidence of a recurrence.
        after:
          declinedAt !== null &&
          t.createdAt !== null &&
          t.createdAt.localeCompare(declinedAt) > 0,
      });
    }
  }
  return out;
}
