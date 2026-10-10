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

/**
 * Marks a merit-outcome reply posted with `triage-thread.ts --leave-open` —
 * a deliberate choice not to resolve, usually a human thread per AGENTS.md §
 * Addressing PR Comments — so ANY later reader of this reply's durable text
 * can recover that choice instead of needing it supplied again. Readers
 * exist today in `triage-thread.ts`'s own inline reconciliation, and in
 * `reconcile-replied-threads.ts`'s standalone sweep — its own header
 * describes itself as "the standalone-sweep COUNTERPART" to the former, free
 * to process the identical unresolved thread later (a scheduled `--all-open`
 * run, or a human-attended one-shot outside `--bots-only`'s scope). Before
 * this constant moved here, only the first reader knew about it: the second
 * resolved a marked thread on its very next sweep, silently reversing the
 * leave-open choice the first reader had just honoured (docomply-review, PR
 * #4129 round 10). One constant, one predicate — shared for the identical
 * reason `qualifyingOutcome` itself lives here rather than duplicated: two
 * readers of the same durable text must not be able to disagree about what
 * it means.
 *
 * On the body's own trailing line, appended after posting — never parsed by
 * `qualifyingOutcome` (scoped to the first line only), so it cannot affect
 * outcome classification. An HTML comment, invisible in GitHub's rendered
 * markdown, matching `ai-review`'s own machine-readable marker convention.
 *
 * **Accepted residual: this marker records a choice, it does not
 * authenticate one.** A later reader cannot prove a given occurrence was
 * appended by `triage-thread.ts`'s own `--leave-open` path rather than
 * written into a reply posted straight through `reply-to-thread.ts` (the
 * deliberate-supersession path). No mechanism can: the two paths are the SAME
 * GitHub principal holding the SAME credential — `triage-thread.ts` posts by
 * spawning `reply-to-thread.ts`, so any credential the marker's writer could
 * be authenticated against is one the direct caller already holds. Reactions,
 * `minimizeComment`, a bot-owned side-channel comment and a dedicated GitHub
 * App all fail for that one reason, not for lack of an API. A local
 * `drive-state.ts` record (or a per-invocation token cross-checked against
 * one) fails differently and just as hard: not synced to GitHub, so it does
 * not survive a fresh clone or another worktree picking up the drive — the
 * exact durability this in-body marker was chosen for.
 *
 * So this is an ACCIDENT risk, not a forgery risk, and it is bounded:
 * {@link hasLeaveOpenMarker} requires the marker to be the body's last
 * NON-BLANK line (quoting or discussing it never trips it);
 * `triage-thread.ts`'s fresh-post branch REFUSES a body that already ends
 * with it without `--leave-open`; and `reply-to-thread.ts` refuses it
 * outright without {@link LEAVE_OPEN_MARKER_PRODUCER_ENV}, which only
 * `triage-thread.ts` sets. What remains is a trusted author deliberately
 * hand-writing the marker's exact trailing-line form into a direct post — and
 * `TRUSTED_ASSOCIATIONS` already grants that author unrestricted authority
 * over every disposition on this PR, so it is the same class as the
 * concurrent-post window arbitrated `wont-fix` at `triage-thread.ts`'s
 * fresh-post call site. Accepted, not fixed (Architect Agent review,
 * 2026-08-21, closing PRRT_kwDOO7knac6a05qK/07oD/a_Yyr and finding
 * 04a4eb90c63c0512 on PR #4129). Do not re-litigate this without a NEW
 * privilege boundary between the two posting paths; without one there is
 * nothing to authenticate against.
 */
export const LEAVE_OPEN_MARKER = "<!-- triage-thread:leave-open -->";

/**
 * The env var `reply-to-thread.ts` requires (set to `'1'`) before it will
 * post a body ending in {@link LEAVE_OPEN_MARKER}'s trailing-line form —
 * `triage-thread.ts` is the only script that sets it, on its own single
 * `reply-to-thread.ts` call site, unconditionally (every guard governing
 * whether that body should legitimately carry the marker already ran inside
 * `triage-thread.ts` itself before that call). This is NOT authentication —
 * an agent invoking `reply-to-thread.ts` directly can set the same env var —
 * it converts the residual documented on {@link LEAVE_OPEN_MARKER} from "an
 * accidental marker-shaped trailing line" to "a deliberate act by whoever set
 * this flag," which is the correct closure for an accident-class risk, not a
 * forgery-class one.
 */
export const LEAVE_OPEN_MARKER_PRODUCER_ENV =
  "DRIVE_PR_INTERNAL_LEAVE_OPEN_MARKER";

/**
 * Does this reply body carry {@link LEAVE_OPEN_MARKER} as its own dedicated
 * TRAILING line — never a plain substring search. The producer contract
 * (this constant's own header) is specific: the marker is the body's last
 * line, appended after a blank line. A substring check accepts it ANYWHERE,
 * including inside a trusted author's own prose that happens to quote or
 * discuss the marker text — a real risk on a PR whose own diff and commit
 * messages contain this exact string, and the deliberate-supersession path
 * explicitly posts arbitrary trusted-author text this predicate then reads
 * (docomply-review + chatgpt-codex-connector, a reference-implementation pull request round 13, both
 * independently on the same gap). Scoped to the last NON-BLANK line — never
 * the literal last line — because the producer's own `postBody` always
 * leaves a blank line before the marker, and `\r` is stripped as a line
 * terminator, mirroring `qualifyingOutcome`'s identical CRLF handling.
 *
 * The candidate line's `\r` is stripped and NOTHING ELSE — never `.trim()`.
 * `postBody` appends the marker with no leading or trailing whitespace, so an
 * exact match is the producer contract; `.trim()` also matches an INDENTED or
 * padded line, which admits an illustrative example (a markdown blockquote, a
 * doc snippet showing the marker's own syntax — this PR's own SKILL.md has
 * several) as though it were the durable marker itself (chatgpt-codex-
 * connector, PR #4129 round 23).
 */
export function hasLeaveOpenMarker(body: string): boolean {
  const lines = body.split("\n");
  let i = lines.length - 1;
  // Skipping BLANK (whitespace-only) lines here is safe either way — it only
  // decides which line becomes the CANDIDATE, never whether that candidate
  // counts as the marker. `.trim()` stays here.
  while (i >= 0 && lines[i]?.replace(/\r$/, "").trim() === "") i--;
  if (i < 0) return false;
  // The candidate itself gets no such tolerance — see this function's own
  // header for why an indented/padded near-match must not count.
  return lines[i]?.replace(/\r$/, "") === LEAVE_OPEN_MARKER;
}

/**
 * Marks a reply posted with `reply-to-thread.ts --no-outcome` — a deliberate
 * clarifying question, not a triage decision. `isLeftOpenThread` in
 * `lib/status/evaluate.ts` reads a trusted author's outcome-less reply as
 * "ask-and-wait" evidence toward `structuralEscalationDue`, and before this
 * marker existed it inferred that solely from `qualifyingOutcome(body) ===
 * null` — true of `--no-outcome`, but equally true of an OWNER/MEMBER/
 * COLLABORATOR posting arbitrary prose straight on GitHub ("I agree, please
 * fix this"), which never goes through `reply-to-thread.ts` at all. That
 * false positive silently dropped a live finding recurrence from the
 * advisory signal (chatgpt-codex-connector, a reference-implementation pull request). Requiring this marker
 * instead ties the classification to the one path that can actually produce
 * it — `reply-to-thread.ts` appends it itself whenever `--no-outcome` is
 * passed (see that script) — so a direct GitHub reply, having no way to
 * carry it, now falls through to "live finding" by default: the same
 * fail-toward-counting-as-live-work direction `isLeftOpenThread` already
 * takes for a truncated thread.
 *
 * Same trailing-line contract as {@link LEAVE_OPEN_MARKER}, and read by
 * {@link hasNoOutcomeMarker} the same way — see that pair's own comments for
 * why an exact, last-non-blank-line match (never a substring search) is the
 * right shape.
 */
export const NO_OUTCOME_MARKER = "<!-- reply-to-thread:no-outcome -->";

/**
 * Does this reply body carry {@link NO_OUTCOME_MARKER} as its own dedicated
 * trailing line — identical contract to {@link hasLeaveOpenMarker}.
 */
export function hasNoOutcomeMarker(body: string): boolean {
  const lines = body.split("\n");
  let i = lines.length - 1;
  while (i >= 0 && lines[i]?.replace(/\r$/, "").trim() === "") i--;
  if (i < 0) return false;
  return lines[i]?.replace(/\r$/, "") === NO_OUTCOME_MARKER;
}
