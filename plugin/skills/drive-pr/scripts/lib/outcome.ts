/**
 * The thread-reply outcome vocabulary, and the predicate that reads it back.
 *
 * `reply-to-thread.ts` ENFORCES this grammar at the write side, because replies
 * are harvested to score the review bot. Everything on the read side —
 * `reconcile-replied-threads.ts` re-holding a thread it already answered,
 * `loop-metrics.ts` counting the outcome mix, `defect-escape.ts` sampling the
 * declined findings — has to ask the same question of the same bodies, and each
 * one used to carry its own copy of the regex.
 *
 * Three copies of a machine-read contract is three chances for the harvested
 * dataset to disagree with the enforcer about what a sample IS. The copies also
 * carried a comment claiming they were duplicated "per this skill's established
 * convention of self-contained scripts" — a convention `lib/cli.ts`,
 * `lib/proc.ts` and `lib/state/` already superseded. One home, here.
 *
 * NOT merged with `summary-findings.ts`'s `outcomeOf`, which looks the same and
 * is not: that one requires the `—` separator because `answer-summary-finding.ts`
 * is the sole sanctioned producer of a summary answer and emits exactly
 * `**outcome** — reason`. A THREAD reply is written by hand through
 * `reply-to-thread.ts`, whose enforced grammar is the looser "token, ASCII
 * space/tab, then a reason" below. Collapsing them would either reject real
 * thread replies or admit summary answers nobody composed through the script.
 */

export const OUTCOMES = [
  "accepted",
  "rejected",
  "wont-fix",
  "deferred",
  "moot",
] as const;

export type Outcome = (typeof OUTCOMES)[number];

/**
 * Outcomes that DECLINE a finding on merit rather than acting on it — the
 * population a defect-escape sample is drawn from. `rejected` is deliberately
 * not here: it asserts the finding was wrong, so there is nothing that could
 * have escaped. Every member below asserts the finding was RIGHT and shipped
 * anyway.
 */
export const DECLINED_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>([
  "wont-fix",
  "deferred",
]);

/**
 * Derived from `OUTCOMES`, not restated alongside it.
 *
 * This module exists so the harvested dataset cannot disagree with the enforcer
 * about what a sample IS, and a hand-written second copy of the same tokens is
 * that disagreement waiting to happen: add a token to `OUTCOMES` and every
 * consumer type-checks while the reader silently stops recognising it.
 *
 * The tokens carry no regex metacharacters, so a plain join is exact — and that
 * is a property of the current vocabulary rather than a guarantee, which is why
 * a test asserts it rather than a comment claiming it.
 */
const FIRST_LINE = new RegExp(
  `^\\*\\*(${OUTCOMES.join("|")})\\*\\*[ \\t]+(.*)$`,
);

export interface QualifyingReply {
  outcome: Outcome;
  /**
   * The concrete reason the grammar requires, with the conventional separator
   * removed.
   *
   * `answer-summary-finding.ts` composes `**outcome** — reason` and the skill's
   * prose prescribes the same shape for a hand-written thread reply, so almost
   * every reason in the wild opens with an em dash that is punctuation between
   * two fields rather than part of either. Leaving it in makes every rendered
   * line read `by coderabbitai — — valid observation`. Stripped AFTER the
   * has-a-reason test below, so `**wont-fix** —` still fails to qualify.
   */
  reason: string;
}

/**
 * The outcome this body qualifies as, or `null` if it is not an answer at all.
 *
 * Mirrors `reply-to-thread.ts`'s enforced grammar exactly: bold lowercase
 * token, an ASCII space/tab boundary (deliberately not `\s`, which matches
 * Unicode spaces the token boundary must not accept), then a reason carrying at
 * least one ASCII letter or digit — so a bare `—` is not a reason.
 *
 * Scoped to the body's FIRST line, and to its literal opening. An outcome token
 * quoted further down (a worked example, a reviewer summarising a prior round)
 * is not an answer to this thread, and a leading-whitespace tolerance would
 * admit an indented example as one.
 *
 * A terminal `\r` is a line TERMINATOR, not content — a reply composed from a
 * CRLF file leaves one on `firstLine`, and `(.*)` does not match it, so a valid
 * reply would read as unanswered.
 */
export function qualifyingOutcome(body: string): QualifyingReply | null {
  const firstLine = (body.split("\n")[0] ?? "").replace(/\r$/, "");
  const m = FIRST_LINE.exec(firstLine);
  if (!m) return null;
  const reason = m[2] as string;
  if (!/[A-Za-z0-9]/.test(reason)) return null;
  return {
    outcome: m[1] as Outcome,
    reason: reason.replace(/^[—–-]+[ \t]*/, "").trim(),
  };
}

export {
  hasLeaveOpenMarker,
  hasNoOutcomeMarker,
  LEAVE_OPEN_MARKER,
  LEAVE_OPEN_MARKER_PRODUCER_ENV,
  NO_OUTCOME_MARKER,
} from "../../../../shared/reply-markers.ts";
