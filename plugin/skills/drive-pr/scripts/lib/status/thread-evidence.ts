// `TRUSTED_ASSOCIATIONS` lives on the CLI module, not `lib/`, the same import
// `reconcile-replied-threads.ts` already makes for the identical reason: one
// set, so this reader and that one cannot disagree about who counts as
// trusted.
import { TRUSTED_ASSOCIATIONS } from "../../summary-findings.ts";
import { isTransparentFollowUp } from "../bot-confirmation.ts";
import {
  hasLeaveOpenMarker,
  hasNoOutcomeMarker,
  qualifyingOutcome,
} from "../outcome.ts";
import type { UnresolvedThread } from "./evidence.ts";

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
export function asCommentRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : null;
}

/** Only a trusted, marked clarification pauses a confirmed human thread. */
function isClarification(comment: Record<string, unknown> | null): boolean {
  if (comment === null) return false;
  const assoc = comment.authorAssociation;
  const body = typeof comment.body === "string" ? comment.body : "";
  return (
    typeof assoc === "string" &&
    TRUSTED_ASSOCIATIONS.has(assoc) &&
    hasNoOutcomeMarker(body) &&
    qualifyingOutcome(body) === null
  );
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
  if (t.confirmedHumanStarted === true && isClarification(last)) return true;
  return t.confirmedHumanStarted === true && hasLeftOpenDisposition(comments);
}

function hasLeftOpenDisposition(comments: unknown[]): boolean {
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
    return candidate.outcome !== "accepted" && hasLeaveOpenMarker(body);
  }
  return false;
}

/**
 * The url of this thread's most recent comment that is not a transparent
 * follow-up (`lib/bot-confirmation.ts`: a listed bot's confirmation or
 * finding-free chat acknowledgement), from anyone: what a thread hold's own
 * `commentUrl` is compared against below. A reviewer's new finding in the
 * same thread carries no outcome token, so comparing against the last
 * qualifying reply would miss it; any other comment after the held one moves
 * this url off the held value, so the hold no longer describes the thread.
 *
 * `null` on a truncated thread or an empty or unreadable comment array: NOT
 * MEASURED, which the caller never reads as a thread it may exclude.
 */
export function latestCommentUrl(t: UnresolvedThread): string | null {
  if ((t as { commentsTruncated?: unknown }).commentsTruncated === true)
    return null;
  const comments = (t as { comments?: unknown }).comments;
  if (!Array.isArray(comments) || comments.length === 0) return null;
  for (const raw of [...comments].reverse()) {
    const c = asCommentRecord(raw);
    if (c === null) return null;
    const author = typeof c.author === "string" ? c.author : null;
    const body = typeof c.body === "string" ? c.body : null;
    if (isTransparentFollowUp({ authorLogin: author, body }, qualifyingOutcome))
      continue;
    return typeof c.url === "string" && c.url !== "" ? c.url : null;
  }
  return null;
}

/** Latest comment identities, including replies left open on purpose. */
export function openThreadVersions(
  threads: UnresolvedThread[],
): [string, string][] | null {
  const versions: [string, string][] = [];
  for (const t of threads) {
    const comments = t.comments;
    const last = Array.isArray(comments)
      ? asCommentRecord(comments.at(-1))
      : null;
    const version = last?.url;
    if (
      t.commentsTruncated === true ||
      typeof version !== "string" ||
      version === ""
    )
      return null;
    versions.push([String(t.threadId), version]);
  }
  return versions.sort(([a], [b]) => a.localeCompare(b));
}
