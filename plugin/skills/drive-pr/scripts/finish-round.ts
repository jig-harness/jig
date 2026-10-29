#!/usr/bin/env bun
import { retryAttempts } from "../../../shared/retry.ts";
/**
 * Finish one drive-pr round: take a validated commit that exists locally all
 * the way to "the held batch is drained, or every refusal is named".
 *
 * A round's finish is separate commands in one exact order, with a per-kind
 * branch inside the last one. Every step of it is load-bearing and none of it
 * is discoverable from the scripts themselves:
 *
 *   ci-hold.ts ensure                   own the CI hold label (when the repository
 *                                       has one) before an intermediate push
 *   guarded-push.ts                     the push, liveness-rechecked
 *   drive-state.ts stamp-held           per-hold push provenance
 *   drive-status.ts --json --no-count   head-sync wait; the flag is what keeps
 *                                       the round counter still
 *   drive-state.ts held                 a FRESH read, never memory
 *   per item, one at a time             thread → resolve-held-thread.ts
 *                                       finding → claim → answer → release
 *
 * An agent following that ordering by hand can get it wrong, and prose cannot
 * be the mechanism for an ordering whose failures are silent — so this script
 * is, and SKILL.md § 6 names it instead.
 *
 * WHAT THIS DOES NOT DO is change any of the semantics it sequences. Every
 * check that decides whether a held item may be dispatched still lives in
 * `drive-state.ts claim-held`, `resolve-held-thread.ts` and
 * `answer-summary-finding.ts`, and is reached here through exactly the calls
 * SKILL.md documents — no predicate is re-implemented, re-derived or
 * pre-filtered on this side, with ONE narrow exception: `answerFindingItem`
 * below refuses a held finding with a blank `reason` before ever calling
 * `claim-held`, to avoid a claim/unclaim pair over a record that was never
 * dispatchable (see that function's own comment). It refuses on exactly the
 * same condition and exit code `answer-summary-finding.ts` itself would —
 * both trigger on `reason.trim === ''`, both exit 2 — so no case reaches a
 * different verdict than the delegated call would have reached. A refusal
 * from any of the three scripts themselves is REPORTED, never interpreted.
 * Those scripts stay individually invocable: recovery from a refusal is
 * still a hand-driven § 3 reconciliation followed by a re-run.
 *
 * Usage: finish-round.ts [PR] [--json] [--bots-only]
 *
 *   --json       emit the structured report on stdout instead of prose. Every
 *                per-item outcome is in it, so a caller never parses the log.
 *   --bots-only  scope the untriaged-thread refusal to bot-started
 *                threads only, forwarded verbatim to
 *                `list-unresolved-threads.ts`. Pass this whenever the round
 *                itself is being driven `--bots-only` — without it, an
 *                untouched HUMAN thread on a file the round's bot-only fix
 *                touches refuses the push, even though bots-only mode is
 *                explicitly scoped to never act on human threads (SKILL.md §
 *                "the identical mistake" caveat is about NON-bots-only mode; it
 *                does not license this guard to ignore its own caller's scope).
 *
 * Re-running after an interruption is the designed recovery, and it is safe
 * because every step is either idempotent or already guarded:
 *
 *   - the push re-runs as a no-op once the head is already there;
 *   - `stamp-held` rewrites the same SHA, and deliberately does NOT advance
 *     a stamped finding that still carries a claim (drive-state.ts's own
 *     comment says why);
 *   - the head-sync wait counts no round;
 *   - a thread whose resolve already ran is gone from `held`, so it is not
 *     re-dispatched; one whose claim succeeded but whose mutation never ran is
 *     also gone, and § 3's ordinary reconciliation re-holds it next round;
 *   - a finding claimed-but-not-released refuses at `claim-held` (exit 1),
 *     which is precisely what stops a second, non-idempotent answer comment.
 *
 * NOTHING here carries an outer deadline. Each step already bounds its own
 * network calls ($GH_CALL_TIMEOUT, $DRIVE_PR_HELPER_TIMEOUT,
 * $DRIVE_PR_PUSH_TIMEOUT, drive-status.ts's own --timeout), and a second
 * deadline stacked on top would kill a dispatch mid-POST — the one moment
 * where an interruption leaves a claim held over an answer that may or may not
 * have landed. A push through the pre-push hook is measured in tens of
 * minutes and is supposed to be.
 *
 * THE UNTRIAGED-THREAD REFUSAL. One more pre-push check sits alongside the
 * dirty-worktree / unconcluded-git-op refusals: `checkUntriagedThreads` refuses
 * when at least one unresolved review thread anchors a file this round's own
 * non-merge commits touch, is not currently PARKED, and its OWN triage state is
 * not complete and current — never triaged, a current reply with the OTHER half
 * of its dispatch missing (a hold, or a resolve), or an existing hold gone
 * stale. That conjunction is what catches the measured driver mistake — every
 * finding fixed in code, `triage-thread.ts` never invoked, this script pushing
 * and reporting "0 held item(s) drained" with no complaint, indistinguishable
 * from a round that genuinely rejected/wont-fixed everything — without flagging
 * a round that legitimately left a triaged thread open (`triage-thread.ts
 * --leave-open`) or a thread a human already parked. It does NOT retroactively
 * fix an already-pushed round; it only stops THIS round's push when it can
 * prove, from data it can read, that this round's own file changes left a live,
 * untriaged, unparked thread behind. And it fails CLOSED — refuses, never
 * silently proceeds — whenever it cannot read its own inputs (an unusable round
 * base, an unparsable `held` batch, an unreadable `parked-keys` set, a
 * `list-unresolved-threads.ts` call that fails or emits a line it cannot read),
 * the same posture `BATCH_UNREADABLE` already takes for the drain step below.
 *
 * The full case breakdown, its own remedies, and why they are not
 * interchangeable are NOT restated here a fifth time (this exact paragraph had
 * drifted stale, independently, in SKILL.md, references/round-finish.md,
 * `checkUntriagedThreads`'s own header, and here — twice). Read
 * `checkUntriagedThreads`, `isThreadTriaged` and `remedyFor`'s own headers,
 * which are the code and cannot drift from themselves.
 *
 * Exit codes:
 *   0  the round is finished: pushed, stamped, head-synced, batch drained
 *   1  a step failed (push failed, state unreadable, head never synced) —
 *      also the untriaged-thread check's own infra-read failures
 *      (TRIAGE_CHECK_FAILED: an unusable round base, an unreadable/unparsable
 *      held batch, an unreadable parked-keys set, or a
 *      failed/unparsable list-unresolved-threads.ts call)
 *   2  usage error
 *   3  refused BEFORE pushing: dirty worktree, unconcluded git operation, or a
 *      working tree that could not be read at all
 *   4  refused BEFORE pushing: the initial required checks have not
 *      completed, the head moved, or an externally-owned CI hold label is
 *      present
 *   5  the PR is no longer open — nothing was pushed (guarded-push.ts's own 5,
 *      same code and meaning; drive-status.ts uses it identically). Also
 *      returned by the untriaged-thread check itself when it finds
 *      offending threads but the PR has since closed
 *      or merged — a closed PR has nothing left to triage-and-retry against,
 *      so it is reported the same way guarded-push.ts would have reported it
 *      a few lines later
 *   6  pushed and stamped, but the batch did not fully drain: at least one
 *      held item was refused. Each refusal is named, with the exit code and
 *      the refusing script's own diagnostic. Reconcile via SKILL.md § 3 and
 *      re-run
 *   7  refused BEFORE pushing (REFUSED_UNTRIAGED): at least one
 *      unresolved, unparked thread anchors a file this round's own non-merge
 *      commits touch, and its triage state is incomplete or stale (never
 *      triaged, a reply with the other half of its dispatch missing, or a
 *      stale hold — `isThreadTriaged`'s own header has the full case list;
 *      the batch need not be empty for this to fire). Each offending thread
 *      is named (id, path, url) in the reason WITH its own remedy — the
 *      cases are not interchangeable, see `remedyFor`. Follow the printed
 *      remedy, or park it (SKILL.md § 4) if triage-thread.ts itself
 *      refuses, then re-run
 *  11  another live SESSION in this working tree holds the drive lease
 *  13  another live WORKING TREE is driving this PR
 *
 * `11` and `13` are propagated rather than flattened, for the reason
 * drive-status.ts propagates them: the remedies differ, and a driver told
 * "some session" goes looking in its own tree for one that is not there.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTransparentFollowUp } from "./lib/bot-confirmation.ts";
import { fail, isDigits, isGitSha, runMain, short } from "./lib/cli.ts";
import { hasLeaveOpenMarker, qualifyingOutcome } from "./lib/outcome.ts";
import {
  ciHoldTimeoutSeconds,
  ghCall,
  git,
  gitCallTimeoutSeconds,
  helperTimeoutSeconds,
  resolvePr,
  run,
  tsArgv,
  unconcludedGitOpMarker,
} from "./lib/proc.ts";
import {
  changedFilesSinceExcludingMerges,
  roundBase,
} from "./lib/round-delta.ts";
// The code itself, not hand-written `11`/`13` literals: this script's exit
// means what `drive-state.ts`'s means, and two literals are exactly how that
// stops being true. `11` now has an exported constant too
// (`SESSION_LEASE_HELD_EXIT`) — this file used to name it locally
// (`SESSION_LEASE_EXIT = 11`) because none existed yet.
import {
  DRIVE_HELD_ELSEWHERE_EXIT,
  SESSION_LEASE_HELD_EXIT,
} from "./lib/state/lease.ts";
import { TRUSTED_ASSOCIATIONS } from "./summary-findings.ts";

const here = dirname(fileURLToPath(import.meta.url));
const driveState = join(here, "drive-state.ts");
const driveStatus = join(here, "drive-status.ts");
const ciHold = join(here, "ci-hold.ts");
const guardedPush = join(here, "guarded-push.ts");
const resolveHeldThread = join(here, "resolve-held-thread.ts");
const answerSummaryFinding = join(here, "answer-summary-finding.ts");
// Same script, same resolution `drive-status.ts` uses for its own thread
// enumeration (`ctx.listThreadsScript`): the ONE canonical implementation
// lives in /resolve-review-comments, not a copy under this skill.
const listUnresolvedThreads = join(
  here,
  "..",
  "..",
  "resolve-review-comments",
  "scripts",
  "list-unresolved-threads.ts",
);

/**
 * How many times the drain may re-read `held` before giving up on the batch.
 *
 * `claim-held` exit 4 means the snapshot being iterated is stale, and SKILL.md
 * § 6's answer to that is to re-read rather than to assume the key finished.
 * A bound is what keeps that from becoming a loop: a key that keeps coming
 * back stale is a state problem, not a retry problem, and the report says so.
 */
const MAX_BATCH_READS = 5;

/** How many times ONE key may be attempted across those re-reads. */
const MAX_ATTEMPTS_PER_KEY = 2;

interface HeldRecord {
  key: string;
  kind: "thread" | "finding";
  outcome: string;
  round: number;
  reason?: string;
  actor: string;
  verifiedSha?: string;
  commentUrl?: string;
}

type ItemAction = "resolved" | "answered" | "refused";

interface ItemResult {
  key: string;
  kind: string;
  action: ItemAction;
  /** The refusing script's exit code; 0 on success. */
  code: number;
  /**
   * That script's own stderr, verbatim — never re-worded here. The one
   * exception: an item that exhausted the retry/read bounds without ever
   * being dispatched has no script's stderr to carry, so its diagnostic is
   * synthesized instead (see the post-drain verification block).
   */
  diagnostic?: string;
}

interface Report {
  pr: number;
  head: string;
  state:
    | "FINISHED"
    | "REFUSED_UNCLEAN"
    | "REFUSED_UNTRIAGED"
    | "TRIAGE_CHECK_FAILED"
    | "PR_NOT_OPEN"
    | "PUSH_FAILED"
    | "CI_HOLD_WAIT"
    | "CI_HOLD_FAILED"
    | "STAMP_FAILED"
    | "HEAD_NOT_SYNCED"
    | "BATCH_UNREADABLE"
    | "PARTIAL"
    | "LEASE_HELD";
  reason: string;
  pushed: boolean;
  stamped: boolean;
  headSynced: boolean;
  items: ItemResult[];
}

function emit(report: Report, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  process.stdout.write(`${report.state}: ${report.reason}\n`);
  for (const i of report.items) {
    process.stdout.write(
      `  ${i.action === "refused" ? `refused(${i.code})` : i.action} ${i.kind} ${i.key}\n`,
    );
  }
}

function prefixLines(prefix: string, text: string): string {
  return text
    .split("\n")
    .filter((l, i, all) => !(l === "" && i === all.length - 1))
    .map((l) => `${prefix}${l}`)
    .join("\n");
}

/**
 * Re-print a helper's captured stderr so a human watching the run sees the
 * refusal as it happens, not only in the final report. Captured rather than
 * inherited because the report carries it too — and a diagnostic that exists
 * only in a scrollback is one an unattended pass cannot act on.
 */
function echoDiagnostic(label: string, stderr: string): void {
  if (stderr.trim() === "") return;
  console.error(prefixLines(`  ${label}: `, stderr));
}

/**
 * Parse a `drive-state.ts held` payload, element-checked rather than merely
 * syntax-checked — the same posture `resolve-held-thread.ts`'s own precheck
 * takes, and for the same reason: `[null]` passes `Array.isArray` and then
 * throws a TypeError on the first field read, which surfaces as an opaque
 * crash instead of the refusal this function exists to produce.
 *
 * Returns `null` when the payload is not a usable batch at all. An entry that
 * fails the shape check is DROPPED rather than silently coerced, and the count
 * of dropped entries is reported by the caller, because a batch this script
 * cannot describe is not one it may claim to have drained.
 */
function parseHeld(
  stdout: string,
): { items: HeldRecord[]; dropped: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const items: HeldRecord[] = [];
  let dropped = 0;
  for (const h of parsed) {
    if (
      typeof h === "object" &&
      h !== null &&
      typeof (h as { key?: unknown }).key === "string" &&
      ((h as { kind?: unknown }).kind === "thread" ||
        (h as { kind?: unknown }).kind === "finding") &&
      typeof (h as { outcome?: unknown }).outcome === "string" &&
      typeof (h as { round?: unknown }).round === "number" &&
      typeof (h as { actor?: unknown }).actor === "string" &&
      // `reason` is optional but, when present, must be a string: it reaches
      // `(item.reason ?? '').trim()` unguarded in answerFindingItem, where a
      // non-nullish non-string (an object, array, or number surviving a
      // syntactically-valid-but-malformed payload) throws past this parser's
      // whole reason for element-checking rather than merely syntax-checking.
      ((h as { reason?: unknown }).reason === undefined ||
        typeof (h as { reason?: unknown }).reason === "string") &&
      // `commentUrl` is optional the same way: required by every writer for
      // `kind: 'thread'` (`schema.ts`'s own `HeldItem.commentUrl` doc), absent
      // for `kind: 'finding'`. Element-checked rather than assumed present,
      // same reasoning as `reason` above.
      ((h as { commentUrl?: unknown }).commentUrl === undefined ||
        typeof (h as { commentUrl?: unknown }).commentUrl === "string")
    ) {
      items.push(h as HeldRecord);
    } else {
      dropped++;
    }
  }
  return { items, dropped };
}

/** A lease refusal from any step ends the run under its own code. */
function isLeaseExit(code: number): boolean {
  return code === SESSION_LEASE_HELD_EXIT || code === DRIVE_HELD_ELSEWHERE_EXIT;
}

interface UntriagedThreadLine {
  threadId: string;
  confirmedHumanStarted: boolean;
  path: string | null;
  url: string | null;
  commentsTruncated: boolean;
  comments: Array<{
    // `author` (login, or `null` for a deleted account) — captured for
    // the bot-confirmation tolerance in `isThreadHoldCurrent` below.
    // `list-unresolved-threads.ts` already emits it on every comment; this
    // parser previously dropped it, matching every OTHER caller of that
    // NDJSON that never needed bot identity pre-push.
    author: string | null;
    authorAssociation: string | null;
    body: string | null;
    url: string | null;
  }>;
}

/**
 * The comment url of this thread's MOST RECENT comment, from anyone — not
 * merely the most recent qualifying reply. Same function, same reasoning, as
 * `lib/status/evaluate.ts`'s own `latestCommentUrl`: comparing against the
 * literal last comment (qualifying or not) is what catches a NEW, non- outcome
 * comment landing on an already-held thread — the case `isThreadHold Current`
 * below exists for. `null` on a truncated thread or an empty/unreadable comment
 * array — every one of those is NOT MEASURED, and the caller must treat that
 * the same as "not current" (fail toward re-checking the thread, never toward
 * silently trusting a stale hold).
 */
function latestCommentUrl(t: UntriagedThreadLine): string | null {
  if (t.commentsTruncated) return null;
  const last = t.comments[t.comments.length - 1];
  if (last === undefined) return null;
  return last.url;
}

/**
 * Parse one line of `list-unresolved-threads.ts`'s NDJSON stream,
 * ELEMENT-checked rather than merely syntax-checked — the same posture
 * `parseHeld` takes on `drive-state.ts held`'s payload, and for the identical
 * reason: a line this function cannot fully describe must not silently read as
 * "no evidence of prior triage". `null` on anything this cannot describe; the
 * caller refuses the whole check rather than skipping the one bad line, because
 * a dropped line is a thread this refusal might have needed.
 *
 * `threadId` must be a real string — never `null`: `list-unresolved-threads.ts`
 * only ever emits a null `threadId` for a REDACTED human-history entry, and
 * only under `--include-resolved` (its own header, and the `historyOnly &&
 * !includeResolved` skip in its emit loop) — a flag this guard's own call never
 * passes. A null `threadId` reaching this parser therefore cannot be a
 * legitimate line for THIS caller; treating it as parseable let it flow through
 * as `'(redacted id)'` with a printed remedy ("triage it via triage-thread.ts")
 * that cannot actually be executed — there is no key to pass. Refusing it here
 * instead surfaces `TRIAGE_CHECK_FAILED`, an honest "cannot confirm" for shaped
 * input this caller never expected, rather than a remedy that reads as
 * actionable but is not.
 */
function parseThreadLine(line: string): UntriagedThreadLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.threadId !== "string" ||
    typeof p.confirmedHumanStarted !== "boolean" ||
    !(typeof p.path === "string" || p.path === null) ||
    !(typeof p.url === "string" || p.url === null) ||
    typeof p.commentsTruncated !== "boolean" ||
    !Array.isArray(p.comments)
  ) {
    return null;
  }
  const comments: UntriagedThreadLine["comments"] = [];
  for (const c of p.comments) {
    if (typeof c !== "object" || c === null) return null;
    const cc = c as Record<string, unknown>;
    if (
      !(typeof cc.author === "string" || cc.author === null) ||
      !(
        typeof cc.authorAssociation === "string" ||
        cc.authorAssociation === null
      ) ||
      !(typeof cc.body === "string" || cc.body === null) ||
      !(typeof cc.url === "string" || cc.url === null)
    ) {
      return null;
    }
    comments.push({
      author: (cc.author as string | null) ?? null,
      authorAssociation: (cc.authorAssociation as string | null) ?? null,
      body: (cc.body as string | null) ?? null,
      url: (cc.url as string | null) ?? null,
    });
  }
  return {
    threadId: p.threadId,
    confirmedHumanStarted: p.confirmedHumanStarted,
    path: p.path as string | null,
    url: p.url as string | null,
    commentsTruncated: p.commentsTruncated,
    comments,
  };
}

/**
 * Requires the qualifying reply to be the thread's own LATEST comment — not
 * merely present somewhere in its history. `triage-thread.ts`'s own
 * `existingOutcome` scan (its "last qualifying reply" search) walks backward
 * and accepts the first trusted-author qualifying reply it finds, which is
 * right for THAT script's purpose (deciding what outcome a *reconciling* call
 * should report) but wrong for THIS guard's purpose (deciding whether a thread
 * is safe to push past): a reply from an earlier round stays "found" by that
 * backward scan even after a NEW, unaddressed comment lands on the same thread
 * afterward — silently exempting a thread whose fresh feedback was never
 * triaged. This is the identical staleness this guard's own
 * `isThreadHoldCurrent` already fixed for its state-file hold, via the exact
 * same reasoning: "comparing against the literal last comment (qualifying or
 * not) is what catches a NEW, non-outcome comment landing on an
 * already-[qualified] thread." The two functions are therefore deliberately NOT
 * the same predicate `triage-thread.ts` uses — this guard's stricter
 * requirement (latest comment only) is its own, matching
 * `isThreadHoldCurrent`'s.
 *
 * A `commentsTruncated` thread returns `false` unless the one VISIBLE latest
 * comment itself qualifies — never `true` on the strength of "maybe one exists
 * past the cap" or "maybe the true latest comment, hidden past the cap, is
 * unrelated". A reply past the 100-comment cap could supersede what is visible
 * (the same rule `triage-thread.ts` itself applies), so "cannot confirm the
 * latest comment" fails CLOSED to "treat as untriaged" rather than being
 * silently excluded.
 */
/**
 * The outcome the thread's own latest comment currently carries, or `null` when
 * there is none — truncated (the visible tail is not confirmed to be the real
 * latest), no comments, an untrusted author, or a body that doesn't parse as a
 * qualifying reply. The sole primitive for "is there a current qualifying
 * reply" — every caller that only needs the boolean compares the result to
 * `null` rather than re-deriving it a second way.
 */
function currentReplyOutcome(t: UntriagedThreadLine): string | null {
  // Requires a REPLY, not merely a latest comment: a thread's own OPENING
  // comment is the finding, not an answer to it, even when its author is
  // trusted (OWNER/MEMBER/COLLABORATOR) and its body happens to parse as the
  // outcome grammar — a human can open a brand-new thread with a note that
  // reads "**wont-fix** — pre-existing, not part of this diff" as its very
  // first word. With only that one comment on the thread, nobody has actually
  // REPLIED to it yet, so treating comments[0] as if it were the answer would
  // let this guard wave a genuinely untriaged thread through. `comments.length
  // < 2` therefore always reads as "no reply exists", regardless of what the
  // sole comment says.
  if (t.commentsTruncated || t.comments.length < 2) return null;
  const last = t.comments[t.comments.length - 1];
  if (
    last === undefined ||
    last.authorAssociation === null ||
    !TRUSTED_ASSOCIATIONS.has(last.authorAssociation)
  ) {
    return null;
  }
  return qualifyingOutcome(last.body ?? "")?.outcome ?? null;
}

/**
 * Diagnostic-only counterpart to `currentReplyOutcome`: true when a trusted
 * qualifying reply exists ANYWHERE in the thread's history, not only as its
 * literal latest comment — the OLD, looser definition of "already triaged".
 * Never used to decide whether to refuse (that is `currentReplyOutcome`'s job
 * alone); used only to pick which remedy this refusal's own message names.
 *
 * The distinction matters because the two remedies are NOT interchangeable:
 * `triage-thread.ts`'s own reconciliation rule (its header's step 5) treats ANY
 * qualifying reply, wherever it sits in history, as "the answer" — so
 * re-running it on a thread with a STALE qualifying reply does not post
 * anything new; it silently re-confirms the stale reply and this guard refuses
 * again on the next round, a non-converging loop. The documented escape hatch
 * for that case is `reply-to-thread.ts` directly (a genuinely new reply, which
 * becomes the new latest comment) followed by `triage-thread.ts` to complete
 * the disposition — never `triage-thread.ts` alone.
 */
function hasStaleQualifyingReply(t: UntriagedThreadLine): boolean {
  if (t.commentsTruncated) return false;
  // Skips comments[0] for the identical reason `currentReplyOutcome` does: the
  // opening comment is the finding, never a reply to it, so a trusted author's
  // qualifying-shaped OPENING comment must not be reported as a stale reply
  // either — that would send `remedyFor` down the "post a fresh reply first"
  // path for a thread `triage-thread.ts` can already answer directly from its
  // own backward scan (which legitimately does include comments[0] — see its
  // header).
  for (let i = 1; i < t.comments.length; i++) {
    const c = t.comments[i];
    if (
      c !== undefined &&
      c.authorAssociation !== null &&
      TRUSTED_ASSOCIATIONS.has(c.authorAssociation) &&
      qualifyingOutcome(c.body ?? "") !== null
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Refuse a round-finish that would push fixes for which no
 * `triage-thread.ts` reply was ever posted — the driver mistake measured
 * across multiple PRs (FB-170, FB-203, and the occurrences that
 * filed this issue). SKILL.md's documented loop is gate → enumerate →
 * triage EACH thread via `triage-thread.ts` → validate → commit →
 * `finish-round.ts`; the measured failure collapses "triage" into
 * "finish" — every finding's
 * underlying code gets fixed, `triage-thread.ts` is never invoked, and this
 * script used to push and report "0 held item(s) drained" with no complaint
 * — a report INDISTINGUISHABLE from a round that genuinely rejected/
 * wont-fixed everything, which also drains 0 held items.
 *
 * Refuses only when ALL of:
 *   (a) that thread's own key carries no held triage decision — a hold is
 *       keyed per-thread (`HeldItem.key`, the threadId for `kind: 'thread'`),
 *       so a held item recorded against a DIFFERENT thread is not evidence that
 *       THIS one was triaged (an earlier cut treated the mere presence of any
 *       held item, anywhere in the batch, as sufficient — an accepted-and-held
 *       thread on file A silently excused a never-triaged thread on file B);
 *   (b) at least one UNRESOLVED review thread — bot or human BY DEFAULT
 *       (no `--bots-only` filter, since a human thread left untriaged is the
 *       identical mistake), scoped to bot-started threads only when THIS
 *       script's own `--bots-only` flag is passed — is anchored (`path`) to a
 *       file THIS round's own local NON-MERGE commits touch (`roundBase` +
 *       `changedFilesSinceExcludingMerges`, `lib/round-delta.ts` — the same
 *       base `round-plan.ts` uses to decide what to validate, but the
 *       merge-exclusion variant: a base-sync merge's own imported files do not
 *       count as "this round touched"). A thread with `path === null` (a
 *       PR-level, non-file-anchored comment) can never satisfy this — the guard
 *       only ever reasons about threads anchored to a file;
 *   (c) that thread's triage state is incomplete or stale — not only "no
 *       qualifying reply at all", but also an accepted/moot reply with no hold
 *       recorded, an unmarked merit reply (rejected/wont-fix/deferred) on a
 *       thread that was never actually resolved, or an existing hold whose
 *       current reply has been edited to a different qualifying outcome — see
 *       `isThreadTriaged` and `remedyFor`'s own headers for the full case
 *       breakdown;
 *   (d) that thread is NOT currently PARKED (`drive-state.ts park` /
 *       `parked-keys`). A parked thread is a recorded human decision, often
 *       precisely BECAUSE `triage-thread.ts` itself refused to post a
 *       qualifying reply for it (e.g. a `commentsTruncated` thread, which
 *       `triage-thread.ts` itself tells the operator to park instead) — so
 *       treating it as evidence of skipped triage would refuse a round with
 *       no available remedy: `triage-thread.ts` refuses the exact thread this
 *       guard would otherwise demand it triage.
 *
 * That conjunction is what separates the mistake from a legitimate
 * all-merit round: a round that genuinely rejected/wont-fixed/deferred
 * everything already posted qualifying replies, and an ordinary
 * rejected/wont-fixed/deferred reply also RESOLVES the thread — dropping it
 * out of the unresolved set (b) reads — so the case where (b) can still be
 * true for a legitimate round is narrow: `triage-thread.ts --leave-open`
 * (SKILL.md's human-thread exception), which posts the qualifying reply but
 * deliberately leaves the thread open, or a thread a human explicitly parked.
 * That is exactly why (c) and (d) are each checked independently rather than
 * folded into (b): the reply exists, so (c) is false for the left-open
 * thread; the park record exists, so (d) is false for the parked one; and
 * this guard does not fire for either.
 *
 * WHAT THIS DOES NOT DO: it cannot retroactively fix an already-pushed round
 * (recovering one costs a retroactive `triage-thread.ts` run against a head
 * that has already moved on);
 * it only stops THIS round's push when it can PROVE, from data it can read,
 * that this round's own file changes left a live, untriaged, unparked thread
 * behind. And it fails CLOSED whenever it cannot read its own inputs — an
 * unusable round base, a `held` read this script cannot parse, an unreadable
 * `parked-keys` set, a `list-unresolved-threads.ts` call that fails or emits an
 * unparsable line — refusing rather than silently proceeding, the same posture
 * `BATCH_UNREADABLE` already takes for the drain step below.
 */
async function checkUntriagedThreads(
  pr: string,
  gitTimeoutSec: number,
  botsOnly: boolean,
): Promise<{ code: number; state: Report["state"]; reason: string } | null> {
  const rootRes = await git(["rev-parse", "--show-toplevel"], {
    stderr: "pipe",
    timeoutSec: gitTimeoutSec,
  });
  if (rootRes.code !== 0 || rootRes.stdout.trim() === "") {
    echoDiagnostic("git", rootRes.stderr);
    return {
      code: 1,
      state: "TRIAGE_CHECK_FAILED",
      reason:
        "cannot resolve the repository root ('git rev-parse --show-toplevel') — refusing to check for untriaged threads against a base this script cannot establish",
    };
  }
  const root = rootRes.stdout.trim();

  const rb = await roundBase(root, pr, driveState, gitTimeoutSec);
  if (rb.base === "") {
    return {
      code: 1,
      state: "TRIAGE_CHECK_FAILED",
      reason: `cannot resolve a base to diff this round's own commits against — ${rb.note}`,
    };
  }

  // `changedFilesSinceExcludingMerges`, NOT `changedFilesSince` — this guard
  // must reason about what THIS ROUND's own commits touched, not the cumulative
  // diff a base-sync merge (SKILL.md § 5) can inflate with the base branch's
  // own unrelated churn (see that function's own header for the measured case).
  const touchedFiles = await changedFilesSinceExcludingMerges(
    root,
    pr,
    rb.base,
    gitTimeoutSec,
  );
  if (touchedFiles === null) {
    return {
      code: 1,
      state: "TRIAGE_CHECK_FAILED",
      reason: `cannot list the files this round's own non-merge commits touch since ${short(rb.base)} ('git log'/'git ls-files' failed) — refusing to check for untriaged threads`,
    };
  }

  // The parked set — read BEFORE `held`, the same
  // order `lib/status/evaluate.ts` already reads it in (its own `parkedRes`
  // precedes its `heldRes`). A park record is written by a human (or by an
  // operator following `triage-thread.ts`'s own instruction to park a thread
  // it refuses to reply to, e.g. `commentsTruncated` — SKILL.md § 4), and an
  // unreadable parked set must not silently read as "nothing is parked" — the
  // identical fail-closed posture `evaluate.ts`'s own comment states ("an
  // unreadable parked set would re-arm work a human parked"). Left unhandled,
  // a parked thread would refuse every round from here on with no available
  // remedy: this guard's own printed remedy ("triage it via triage-thread.ts")
  // is refused BY `triage-thread.ts` for exactly the case SKILL.md § 4 says to
  // park instead.
  //
  // Both this call and the `held` read below are local, lock-guarded reads of
  // this skill's own state file — not a `gh` network call — but they can still
  // stall on lock contention, so they carry the same `helperTimeoutSeconds()`
  // deadline as the `list-unresolved-threads.ts` spawn a few lines down, in
  // this same function (an unbounded `run()` here can hang this check, and
  // therefore the whole round-finish, indefinitely instead of returning
  // `TRIAGE_CHECK_FAILED`).
  const parkedRes = await run(tsArgv(driveState, ["parked-keys", pr]), {
    stderr: "pipe",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (parkedRes.code !== 0) {
    echoDiagnostic("drive-state.ts parked-keys", parkedRes.stderr);
    return {
      code: 1,
      state: "TRIAGE_CHECK_FAILED",
      reason: `drive-state.ts parked-keys exited ${parkedRes.code} — refusing to check for untriaged threads against a parked set this script cannot read`,
    };
  }
  const parkedKeys = new Set(
    parkedRes.stdout.split("\n").filter((k) => k !== ""),
  );

  // Read the held batch EARLY (before the push) — a SEPARATE read from the
  // drain step's own fresh re-read after the push, which stays the
  // authoritative one for dispatch. Parsed with the SAME `parseHeld` the
  // drain uses, so the two reads can never disagree about what a held entry
  // IS.
  const heldRes = await run(tsArgv(driveState, ["held", pr]), {
    stderr: "pipe",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (heldRes.code !== 0) {
    echoDiagnostic("drive-state.ts held", heldRes.stderr);
    return {
      code: 1,
      state: "TRIAGE_CHECK_FAILED",
      reason: `drive-state.ts held exited ${heldRes.code} — refusing to check for untriaged threads against a batch this script cannot read`,
    };
  }
  const batch = parseHeld(heldRes.stdout);
  if (batch === null || batch.dropped > 0) {
    return {
      code: 1,
      state: "TRIAGE_CHECK_FAILED",
      reason:
        "drive-state.ts held printed a payload this script cannot read as a batch — inspect 'drive-state.ts get' rather than pushing against it",
    };
  }
  // A `thread`-kind hold's own key IS the threadId `triage-thread.ts` held it
  // under — the same identity `resolve-held-thread.ts` claims by later
  // (SKILL.md § 6). Correlated against below, per offending thread, rather than
  // treated as a blanket "some thread somewhere was triaged" signal: an
  // UNRELATED held item must not excuse a DIFFERENT, untriaged thread that also
  // anchors a file this round touched (the existential check this replaced let
  // one accepted-and-held thread on file A stand in for triage never done on
  // file B).
  //
  // Keyed to `commentUrl`, not just presence in the batch: a reviewer or human
  // can post a NEW comment on a thread AFTER it was held but BEFORE this
  // round's push completes. The key alone would still exempt it —
  // `resolve-held-thread.ts` then resolves the thread unconditionally, silently
  // closing the fresh comment with no outcome reply ever posted to it.
  // `lib/status/evaluate.ts` already carries the identical fix for its own
  // `structuralEscalationDue` recurrence evidence
  // (`isThreadHoldCurrent`/`latestCommentUrl`); this mirrors it rather than
  // inventing a second copy of the same reasoning.
  const heldThreadByKey = new Map<string, string | undefined>(
    batch.items
      .filter((i) => i.kind === "thread")
      .map((i) => [i.key, i.commentUrl] as const),
  );
  // The outcome each hold was RECORDED for — needed because a URL match alone
  // is not enough: GitHub preserves a comment's permalink when it is EDITED, so
  // a hold made for `accepted` whose comment is later edited to `**rejected** —
  // ...` (or any other valid outcome token) still matches on url. This is the
  // identical gap `resolve-held-thread.ts`'s own drain-time recheck already
  // closes for the push AFTER it lands; this closes it for the PRE-PUSH guard
  // too, which is where an operator actually needs the refusal.
  const heldOutcomeByKey = new Map<string, string>(
    batch.items
      .filter((i) => i.kind === "thread")
      .map((i) => [i.key, i.outcome] as const),
  );
  // `commentUrl` is REQUIRED by every writer for `kind: 'thread'` — `held`
  // above is already filtered to that kind, and `schema.ts`'s own
  // `isUsableState` (lines 416-425) refuses the WHOLE state file at read time
  // if any thread hold lacks one. So `undefined` here cannot be a legitimate
  // record this clone's own writers produced; it is corrupt or hand-edited
  // state (or a malformed `drive-state.ts held` response this parser cannot
  // otherwise validate) that the shared store's own gate should have already
  // rejected. Since undecodable input fails closed, and there is no tolerance
  // path for data this shape was never meant to have, NOT granting the
  // exemption is correct here even though `evaluate.ts`'s identically-named
  // fallback returns `true` for its own `undefined` case — that function's
  // `heldByKey` is unfiltered by kind, so its `undefined` routinely means "this
  // key belongs to a `finding` hold", a legitimate and expected case that
  // ID-space collision makes vanishingly rare in practice. This function's map
  // is already thread-only, so `undefined` here has no equivalent innocent
  // explanation. Any OTHER mismatch — including `latestCommentUrl` returning
  // `null` on a truncated or unreadable comment list — fails toward NOT
  // granting the exemption for the same reason. A comment landing AFTER the
  // held reply is still compatible with the hold when it is a reviewer bot's
  // own automated confirmation — the identical tolerance
  // `resolve-held-thread.ts` applies post-push, via the SAME shared predicate
  // (`./lib/bot-confirmation.ts`). Before this, a CodeRabbit confirmation
  // landing on a held thread BEFORE the push (the common case — it reacts
  // within seconds of the reply, well inside a round's own triage-to-push
  // window) made `latestCommentUrl(t) !== heldUrl`, so this guard refused the
  // round on the exact comment that exception exists to tolerate — that
  // exception was therefore unreachable in the documented finish-round path
  // whenever the race resolved before the push rather than during
  // `resolve-held-thread.ts`'s own post-push wait.
  const isThreadHoldCurrent = (t: UntriagedThreadLine): boolean => {
    const key = t.threadId;
    if (!heldThreadByKey.has(key)) return false;
    const heldUrl = heldThreadByKey.get(key);
    if (heldUrl === undefined) return false;
    if (latestCommentUrl(t) === heldUrl) return true;
    // A truncated thread already made `latestCommentUrl` return `null`
    // above, which cannot equal a real `heldUrl` — this second check is not
    // reachable through that path today, but stays explicit so this
    // function's own fail-closed posture does not depend on that
    // indirection continuing to hold.
    if (t.commentsTruncated) return false;
    const heldIdx = t.comments.findIndex((c) => c.url === heldUrl);
    if (heldIdx === -1) return false;
    const later = t.comments.slice(heldIdx + 1);
    // A later comment with no readable url must refuse here, not merely
    // pass through to `resolve-held-thread.ts`'s own post-push check
    // (`lib/bot-confirmation.ts`'s doc comment) — that check independently
    // requires every later node's url to be a string and refuses otherwise.
    // Without this, this pre-push guard could tolerate a later comment this
    // predicate is willing to accept, push, and then have the post-push
    // check refuse and restore the hold on the very comment this guard just
    // let through.
    return later.every(
      (c) =>
        typeof c.url === "string" &&
        isTransparentFollowUp(
          { authorLogin: c.author, body: c.body },
          qualifyingOutcome,
        ),
    );
  };

  /**
   * The outcome the HELD comment itself currently carries — found by its
   * recorded url, not necessarily the thread's literal latest comment now
   * that `isThreadHoldCurrent` above can tolerate a trailing bot
   * confirmation. `currentReplyOutcome` cannot be reused here:
   * once a confirmation follows the held reply, the literal latest comment
   * IS that confirmation, which carries no outcome token by construction
   * (`isTransparentFollowUp` requires exactly that) — comparing THAT
   * against the held outcome would always read `null`, defeating the
   * tolerance above at the very next check. This performs the identical
   * "edited in place" catch `currentReplyOutcome` performs for the
   * literal-latest case, aimed at
   * whichever comment the hold actually names.
   */
  function heldReplyOutcome(
    t: UntriagedThreadLine,
    heldUrl: string,
  ): string | null {
    if (t.commentsTruncated) return null;
    const held = t.comments.find((c) => c.url === heldUrl);
    if (held === undefined) return null;
    if (
      held.authorAssociation === null ||
      !TRUSTED_ASSOCIATIONS.has(held.authorAssociation)
    )
      return null;
    return qualifyingOutcome(held.body ?? "")?.outcome ?? null;
  }

  const threadsRes = await run(
    tsArgv(listUnresolvedThreads, botsOnly ? [pr, "--bots-only"] : [pr]),
    {
      stderr: "pipe",
      // A whole subprocess making its OWN internal (paginated) `gh` calls, not
      // one bounded network call — the same class `drive-status.ts` spawns
      // this identical script as (`ctx.helperTimeoutSec`, evaluate.ts), and
      // the same accessor for the identical reason (`helperTimeoutSeconds`'s
      // own header: "a helper reaches the network through its OWN `gh`
      // chokepoint, so it is already deadlined per call — this bounds the
      // WHOLE INVOCATION").
      timeoutSec: helperTimeoutSeconds(),
    },
  );
  if (threadsRes.code !== 0) {
    echoDiagnostic("list-unresolved-threads.ts", threadsRes.stderr);
    return {
      code: 1,
      state: "TRIAGE_CHECK_FAILED",
      reason: `list-unresolved-threads.ts exited ${threadsRes.code} — refusing to push without confirming no untriaged thread anchors this round's own file changes`,
    };
  }
  const lines = threadsRes.stdout.split("\n").filter((l) => l !== "");
  const threads: UntriagedThreadLine[] = [];
  for (const line of lines) {
    const t = parseThreadLine(line);
    if (t === null) {
      return {
        code: 1,
        state: "TRIAGE_CHECK_FAILED",
        reason:
          "list-unresolved-threads.ts printed a line this script cannot read as a thread — refusing to push without confirming no untriaged thread anchors this round's own file changes",
      };
    }
    threads.push(t);
  }

  // A qualifying reply alone is not always enough: `triage-thread.ts` is
  // SELF-RECONCILING, not atomic (its own header, lines 20-29) — a kill between
  // posting the reply and recording its durable disposition leaves a valid,
  // current, trusted reply on GitHub with the OTHER half of the dispatch never
  // having happened. The documented recovery is re-invoking `triage-thread.ts`
  // on that thread, which completes the missing half — but an operator who
  // instead commits a fix and skips straight to `finish-round.ts` would
  // otherwise sail through: `currentReplyOutcome` sees a valid reply and
  // exempts the thread, the round pushes, and the promised disposition never
  // actually lands.
  //
  // What "the other half" is differs by outcome, so the check below is NOT
  // simply "accepted/moot need a hold" (checking only that left THIS half of
  // the identical bug open): `rejected`, `wont-fix` and `deferred` never create
  // a hold, but `triage-thread.ts`'s normal completion for them calls
  // `resolve-thread.ts` and RESOLVES the thread. This function only ever sees
  // threads `list-unresolved- threads.ts` reports as UNRESOLVED, so a merit
  // reply sitting here with NO `--leave-open` marker cannot be a
  // legitimately-finished dispatch — a finished one would have resolved the
  // thread and it would not be in this list at all. It can only be
  // triage-thread.ts crashing between posting the reply and calling
  // `resolve-thread.ts`. The one way a merit reply (or an unmarked moot)
  // legitimately stays unresolved forever is the LEAVE_OPEN marker —
  // `triage-thread.ts --leave-open` works identically across every non-hold
  // outcome (its own header), so this check does too rather than
  // special-casing `moot`.
  function isThreadTriaged(t: UntriagedThreadLine): boolean {
    const key = t.threadId;
    const outcome = currentReplyOutcome(t);
    if (heldThreadByKey.has(key)) {
      // A hold exists for this key. It counts as a completed triage decision
      // only if its recorded `commentUrl` still points at a comment
      // `isThreadHoldCurrent` accepts as current — the thread's literal latest,
      // or the held reply followed only by a trusted bot's own confirmation —
      // AND that HELD comment's own outcome still matches what was held: a
      // comment keeps its permalink when edited, so url-match alone is not
      // enough — an accepted reply edited to a different outcome, or to remove
      // the outcome token entirely (`null`, which can never equal a real held
      // outcome), still matches on url. Either mismatch means the held record
      // no longer describes reality, so this thread needs an explicit re-triage
      // before push rather than being silently exempted on the strength of a
      // stale record — regardless of whether the NEW outcome would, on its own,
      // need a hold at all.
      //
      // `heldReplyOutcome`, not `outcome` (`currentReplyOutcome`, computed
      // above from the literal latest comment): once a trailing bot
      // confirmation is what `isThreadHoldCurrent` tolerated, the literal
      // latest IS that confirmation, which never carries an outcome token —
      // comparing `outcome` here would read `null` against every held
      // outcome and refuse the round on the very case just tolerated.
      const heldUrl = heldThreadByKey.get(key);
      return (
        heldUrl !== undefined &&
        isThreadHoldCurrent(t) &&
        heldReplyOutcome(t, heldUrl) === heldOutcomeByKey.get(key)
      );
    }
    if (outcome === null) return false; // never triaged at all
    const latest = t.comments[t.comments.length - 1];
    // Marked leave-open: a deliberate choice to leave THIS thread unresolved,
    // valid for any non-hold outcome (not only moot) per triage-thread.ts's own
    // `--leave-open` gating — but ONLY on a HUMAN-started thread: SKILL.md's
    // "Leaving a human thread open" exception, and `triage-thread.ts
    // --leave-open`'s own documented prohibition, are both scoped to
    // human-started threads — a bot finding must always eventually resolve.
    // `triage-thread.ts` does not enforce that prohibition in code, so an
    // operator (or agent) mistakenly passing `--leave-open` while triaging a
    // BOT thread is a reachable operator error, not a hypothetical — this guard
    // must not compound that mistake by trusting the marker on exactly the one
    // thread class it was never meant to exempt. `t.confirmedHumanStarted`
    // names who opened the thread, not who wrote the marker (only a trusted
    // author can ever produce one, per LEAVE_OPEN_MARKER's own header — that
    // authorship residual is separately accepted and unaffected by this check).
    //
    // AND `outcome !== 'accepted'`: `accepted` is ALWAYS a fix-dependent hold
    // outcome — `--leave-open` on it is not a real posting path at all (triage-
    // thread.ts's own gating only ever appends the marker for a non-hold
    // outcome). But a trusted author can EDIT an existing marked reply's
    // outcome word in place on GitHub — `**wont-fix** ... <MARKER>` to
    // `**accepted** ... <MARKER>` — which no posting-time validation ever sees,
    // since it happens after the fact. Without this exclusion,
    // `currentReplyOutcome` reads `accepted`, there is still no hold, and this
    // branch would return `true` anyway on the strength of the leftover marker
    // — recreating the exact crash-before-hold gap this guard exists to refuse.
    // `lib/status/evaluate.ts`'s parallel derivation already excludes
    // `accepted` from its own leave-open recognition (`candidate.outcome !==
    // 'accepted'`); this was the one place that contract went unmirrored.
    if (
      outcome !== "accepted" &&
      t.confirmedHumanStarted &&
      hasLeaveOpenMarker(latest?.body ?? "")
    )
      return true;
    // Unmarked, or marked on a thread that isn't CONFIRMED human-started —
    // bot-started, or an opening comment this guard's own producer could not
    // read (an unreadable opening comment must fail closed toward "not exempt",
    // never toward "assume human"). `accepted`/ `moot` are fix-dependent hold
    // outcomes — this branch runs only when no hold exists (checked above), so
    // both are offending regardless. A wrongly-marked-leave-open thread is
    // exactly as offending as an unmarked one: the resolve half of the dispatch
    // never legitimately happens for it.
    return false;
  }

  const touched = new Set(touchedFiles);
  const offending = threads.filter(
    (t) =>
      t.path !== null &&
      touched.has(t.path) &&
      // A parked thread is a recorded human decision, not evidence of
      // skipped triage — see the `parkedRes`
      // read above.
      !parkedKeys.has(t.threadId) &&
      !isThreadTriaged(t),
  );
  if (offending.length === 0) return null;

  // Only reached when this guard is ABOUT to refuse, so the extra `gh` round
  // trip is paid for exactly the case that needs it: a PR that closed or merged
  // in the window between the last round's push and this one still has
  // offending threads sitting on GitHub, and telling the operator to "triage
  // and retry" against a PR that can no longer receive a push is actively
  // misleading — `guarded-push.ts` would report `PR_NOT_OPEN` a few lines later
  // regardless, so this refusal should say the same thing rather than getting
  // there first with the wrong reason.
  //
  // A FAILED or unusable read is `TRIAGE_CHECK_FAILED`, not a silent
  // fall-through to `REFUSED_UNTRIAGED`: a failed external read must produce a
  // gate failure, not a derived verdict — the same posture every OTHER read in
  // this function already takes (a failed `list-unresolved-threads.ts`,
  // `parked-keys`, or verified-SHA read all return `TRIAGE_CHECK_FAILED`, never
  // a best-guess REFUSED_UNTRIAGED). This check is not exempt merely because
  // both of its two possible verdicts happen to refuse the push either way —
  // `REFUSED_UNTRIAGED`'s specific wording tells the operator to triage and
  // retry, which is actively wrong advice when the underlying liveness could
  // not be established at all.
  const liveness = await ghCall(["pr", "view", pr, "--json", "state"], {
    timeoutSec: helperTimeoutSeconds(),
  });
  if (liveness.code !== 0) {
    echoDiagnostic("gh pr view", liveness.stderr);
    return {
      code: 1,
      state: "TRIAGE_CHECK_FAILED",
      reason: `gh pr view --json state exited ${liveness.code} — refusing to report REFUSED_UNTRIAGED without confirming the PR is still open`,
    };
  }
  let livenessState: unknown;
  try {
    livenessState = (JSON.parse(liveness.stdout) as { state?: unknown }).state;
  } catch {
    return {
      code: 1,
      state: "TRIAGE_CHECK_FAILED",
      reason:
        "gh pr view --json state printed a payload this script cannot read — refusing to report REFUSED_UNTRIAGED without confirming the PR is still open",
    };
  }
  if (typeof livenessState !== "string" || livenessState === "") {
    return {
      code: 1,
      state: "TRIAGE_CHECK_FAILED",
      reason:
        "gh pr view --json state returned no usable state field — refusing to report REFUSED_UNTRIAGED without confirming the PR is still open",
    };
  }
  if (livenessState !== "OPEN") {
    return {
      code: 5,
      state: "PR_NOT_OPEN",
      reason: `PR is ${livenessState}, not OPEN — the untriaged thread(s) this round found no longer matter, since there is nothing left to push to`,
    };
  }

  // Never-triaged, crash-before-hold, edited-in-place, and stale-hold threads
  // all need DIFFERENT remedies: `triage-thread.ts`'s own reconciliation rule
  // treats any qualifying reply anywhere in a thread's history as "the answer",
  // so running it on a thread with a STALE qualifying reply or a stale hold on
  // its own key does not post anything new — it silently re-confirms the stale
  // state and this guard refuses again next round, a loop that never converges.
  // Naming the wrong remedy per-thread would send an operator straight into
  // that loop, so each offending thread gets the remedy that actually applies
  // to it — computed with explicit branches, one per case `isThreadTriaged`
  // itself distinguishes, rather than a chain of derived booleans whose
  // interaction is easy to get wrong (an earlier `currentReplyNeedsOnlyAHold`
  // derived boolean read true for ANY qualifying outcome, not only
  // accepted/moot, so an edited-to-`rejected` thread was told it "carries an
  // accepted/moot reply" when it did not).
  function remedyFor(t: UntriagedThreadLine): string {
    if (t.commentsTruncated) {
      // `triage-thread.ts` refuses a truncated thread UNCONDITIONALLY (its own
      // comments(first:100) cap means the visible tail is never confirmed
      // current), so every OTHER remedy below — which routes through
      // `triage-thread.ts` — is just as broken for a truncated thread as plain
      // `triage-thread.ts` is. The one remedy that actually works is the
      // documented one.
      return "this thread is comment-truncated (>100 comments) — triage-thread.ts refuses it unconditionally, so the only working remedy is drive-state.ts park [PR] --key <id> --kind thread --class human-thread with its decision record on stdin (SKILL.md § 4)";
    }
    const key = t.threadId;
    const outcome = currentReplyOutcome(t);
    if (heldThreadByKey.has(key)) {
      // `isThreadTriaged` already ruled out "url current AND outcome
      // matches" for every thread reaching this function, so exactly one of
      // the two must be failing.
      if (!isThreadHoldCurrent(t)) {
        // The URL itself no longer matches — a NEWER comment landed after
        // the hold, superseding it.
        return 'a NEWER comment has moved past its existing reply/hold — post a fresh reply via reply-to-thread.ts directly, then triage-thread.ts to complete the disposition (SKILL.md § 3 "Leaving a human thread open" / the deliberate-supersession path — triage-thread.ts ALONE will silently reconcile to the stale reply and refuse again)';
      }
      // The URL still matches, so the SAME comment was EDITED in place to a
      // different outcome (or to remove the outcome token entirely). Re-running
      // triage-thread.ts reconciles to whatever the comment currently says —
      // completing a new hold, or resolving-and-releasing the stale one if the
      // new text is a merit outcome — no new post is needed or safe.
      const heldOutcome = heldOutcomeByKey.get(key);
      return `its held '${heldOutcome}' outcome no longer matches the thread's current reply (now reads as '${outcome ?? "no qualifying outcome at all"}') — the comment was EDITED in place after being held. Re-run triage-thread.ts on this thread with ANY valid outcome body on stdin (triage-thread.ts refuses empty stdin outright, before it ever reconciles): its self-reconciliation will find the existing reply and win over whatever this invocation's own body said, completing the correct disposition — do NOT post via reply-to-thread.ts again, that would double-post`;
    }
    if (outcome === "accepted" || outcome === "moot") {
      // No hold at all, but a current reply exists whose outcome NEEDS one
      // (`isThreadTriaged` already confirmed this, else the thread would not be
      // offending) — the crash-before-hold window: `triage-thread.ts` posted
      // the reply but was killed before recording the hold.
      return `its latest comment already carries a valid, current '${outcome}' reply, but no hold was recorded for it — a crash between reply-to-thread.ts and drive-state.ts hold (triage-thread.ts is SELF-RECONCILING, not atomic). Re-run triage-thread.ts on this thread: it will detect the existing reply and complete the missing hold — do NOT post via reply-to-thread.ts again, that would double-post`;
    }
    if (outcome !== null) {
      const latest = t.comments[t.comments.length - 1];
      if (!t.confirmedHumanStarted && hasLeaveOpenMarker(latest?.body ?? "")) {
        // A thread NOT confirmed human-started (bot-started, or an opening
        // comment this guard's own producer could not read) carrying the
        // leave-open marker — never a legitimate crash: `--leave-open` is
        // documented as human-thread-only, and `triage-thread.ts` itself will
        // not fix this by re-running — its own reconciliation recovers
        // `effectiveLeaveOpen` from the marker's mere PRESENCE regardless of
        // this invocation's own `--leave-open` flag (its own comment: "a
        // retrying agent has no reason to have set it"), so a plain re-run
        // continues honoring the same misapplied marker forever. Call
        // resolve-thread.ts DIRECTLY instead — the reply already carries a
        // valid, current merit outcome, so nothing further needs posting; only
        // the resolve itself was skipped.
        return `its latest comment already carries a valid, current '${outcome}' reply with a LEAVE_OPEN marker, but this thread is not confirmed human-started (bot-started, or its opening comment could not be read) — that marker is documented as human-thread-only and triage-thread.ts's own reconciliation will keep honoring it on any re-run regardless of flags. Call resolve-thread.ts ${key} directly instead — do NOT post via reply-to-thread.ts again, that would double-post`;
      }
      // A merit outcome (rejected/wont-fix/deferred), unmarked, sitting on a
      // thread THIS SCRIPT ONLY EVER SEES AS UNRESOLVED — a legitimately
      // finished dispatch for one of these would have called resolve-thread.ts
      // and the thread would not be in this list at all. The other half of the
      // SELF-RECONCILING dispatch is the resolve, not a hold, so the remedy
      // names that instead.
      return `its latest comment already carries a valid, current '${outcome}' reply, but the thread was never resolved — a crash between reply-to-thread.ts and resolve-thread.ts (triage-thread.ts is SELF-RECONCILING, not atomic). Re-run triage-thread.ts on this thread: it will detect the existing reply and complete the resolve — do NOT post via reply-to-thread.ts again, that would double-post`;
    }
    if (hasStaleQualifyingReply(t)) {
      // No CURRENT hold and no current qualifying reply, but a qualifying
      // reply exists somewhere earlier in history with no live record
      // tracking it (e.g. a hold that was consumed by a resolve attempt that
      // itself never actually landed) — the same supersession remedy as the
      // newer-comment case above applies.
      return "a qualifying reply exists earlier in this thread's history with no live record of it — post a fresh reply via reply-to-thread.ts directly, then triage-thread.ts to complete the disposition";
    }
    return "triage it via triage-thread.ts (SKILL.md § 3, or park it if triage-thread.ts itself refuses)";
  }

  const named = offending
    .map(
      (t) =>
        `${t.threadId} on ${t.path} (${t.url ?? "no url"}): ${remedyFor(t)}`,
    )
    .join("; ");
  return {
    code: 7,
    state: "REFUSED_UNTRIAGED",
    reason:
      // Not "no qualifying reply AND no held decision" — `isThreadTriaged` also
      // catches a CURRENT accepted/fix-dependent-moot reply with no hold
      // recorded (crash before hold) and an existing hold whose url or outcome
      // has gone stale, neither of which is "no record at all". "Incomplete or
      // stale triage state" covers every case `remedyFor` actually names.
      `${offending.length} unresolved thread(s) anchor file(s) this round's own commits touch with incomplete or stale triage state and no park record: ${named}` +
      " — then re-run",
  };
}

async function main(): Promise<number> {
  let pr = "";
  let asJson = false;
  let botsOnly = false;
  const argv = process.argv.slice(2);
  for (const a of argv) {
    switch (a) {
      case "--json":
        asJson = true;
        break;
      case "--bots-only":
        botsOnly = true;
        break;
      default:
        if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
        if (pr !== "") fail(2, `unexpected extra argument: ${a}`);
        pr = a;
    }
  }

  pr = await resolvePr(pr);
  if (!isDigits(pr)) {
    fail(
      2,
      "finish-round.ts: could not resolve a PR number.",
      "Pass it explicitly: finish-round.ts 1234",
    );
  }
  const prNum = Number(pr);

  const report: Report = {
    pr: prNum,
    head: "",
    state: "FINISHED",
    reason: "",
    pushed: false,
    stamped: false,
    headSynced: false,
    items: [],
  };
  const done = (
    code: number,
    state: Report["state"],
    reason: string,
  ): number => {
    report.state = state;
    report.reason = reason;
    emit(report, asJson);
    return code;
  };

  // ── The pre-push refusals ────────────────────────────────────────────────
  //
  // These run FIRST, and their whole value is that they run before the one
  // irreversible act in the sequence. Everything downstream — the stamp, the
  // provenance checks, the held batch — treats a successful push as evidence
  // that the validated tree is now on the PR. An uncommitted edit or an
  // unconcluded merge makes that false while every check still passes, so the
  // refusal has to be here rather than inside a later step that could only
  // report it after the fact.
  const gitTimeoutSec = gitCallTimeoutSeconds();
  const headRes = await git(["rev-parse", "HEAD"], {
    stderr: "pipe",
    timeoutSec: gitTimeoutSec,
  });
  if (headRes.code !== 0 || !isGitSha(headRes.stdout.trim())) {
    echoDiagnostic("git", headRes.stderr);
    return done(
      3,
      "REFUSED_UNCLEAN",
      "cannot read local HEAD — refusing to push a tree this script cannot describe",
    );
  }
  report.head = headRes.stdout.trim();

  // A `git status --porcelain` predicate answers "is anything uncommitted",
  // not "is a git operation still open": resolving a conflict back to a tree
  // that matches what was already committed leaves MERGE_HEAD behind while
  // porcelain status reports empty. Checked first, the same order and for the
  // same reason as drive.ts's convergence certification.
  const op = await unconcludedGitOpMarker(gitTimeoutSec);
  if (!op.ok) {
    return done(
      3,
      "REFUSED_UNCLEAN",
      "the working tree is UNREADABLE — cannot establish that no git operation is open",
    );
  }
  if (op.marker !== null) {
    return done(
      3,
      "REFUSED_UNCLEAN",
      `an unconcluded git operation is present (${op.marker}) — resolve or abort it (git merge/cherry-pick/revert --abort), then re-run`,
    );
  }

  // `--untracked-files=normal` and `--ignore-submodules=none` are explicit,
  // not decorative: `--porcelain` alone inherits `status.showUntrackedFiles`
  // and the per-submodule `ignore` setting from config, either of which can
  // report a tree with real leftovers as clean.
  const dirtyRes = await git(
    [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    { stderr: "pipe", timeoutSec: gitTimeoutSec },
  );
  if (dirtyRes.code !== 0) {
    echoDiagnostic("git", dirtyRes.stderr);
    return done(
      3,
      "REFUSED_UNCLEAN",
      "cannot read the working tree — refusing to push without confirming the fix is committed",
    );
  }
  if (dirtyRes.stdout !== "") {
    console.error(
      "finish-round.ts: the working tree is dirty, so the validated tree is not the commit:",
    );
    process.stderr.write(dirtyRes.stdout);
    return done(
      3,
      "REFUSED_UNCLEAN",
      "the working tree is dirty — commit (or discard) the leftovers, then re-run",
    );
  }

  // The untriaged-thread refusal — see `checkUntriagedThreads`'s
  // own header for the full argument. Run here, AFTER every prior refusal in
  // this section (so local HEAD is a clean, stable commit to diff from) and
  // BEFORE `guardedPush` — the whole value of a pre-push refusal is that it
  // runs before the one irreversible act.
  const untriaged = await checkUntriagedThreads(pr, gitTimeoutSec, botsOnly);
  if (untriaged !== null) {
    return done(untriaged.code, untriaged.state, untriaged.reason);
  }

  const holdRes = await run(
    tsArgv(ciHold, ["ensure", pr, "--expect-head", report.head]),
    { stderr: "inherit", timeoutSec: ciHoldTimeoutSeconds() },
  );
  if (holdRes.code === 5) {
    return done(
      5,
      "PR_NOT_OPEN",
      `PR #${pr} is no longer open — nothing was pushed`,
    );
  }
  if (holdRes.code === 4) {
    return done(
      4,
      "CI_HOLD_WAIT",
      `the CI hold label is not safely owned on the current PR head; wait for initial CI or reconcile the external label, then re-run`,
    );
  }
  if (holdRes.code !== 0) {
    return done(
      1,
      "CI_HOLD_FAILED",
      `ci-hold.ts ensure exited ${holdRes.code}`,
    );
  }

  // ── The push ─────────────────────────────────────────────────────────────
  //
  // Undeadlined on purpose: $DRIVE_PR_PUSH_TIMEOUT is guarded-push.ts's own
  // bound and it covers the pre-push hook, so it is measured in tens of
  // minutes. Its stderr is INHERITED so its refusals reach the operator as
  // they happen; its stdout is captured and re-emitted on stderr, because this
  // script's own stdout is a single-value channel (the report) and a child
  // writing into it would make `--json` unparseable for the caller that most
  // needs it.
  const pushRes = await run(
    tsArgv(guardedPush, [pr, "--expect-head", report.head]),
    {
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  if (pushRes.stdout !== "") process.stderr.write(pushRes.stdout);
  if (pushRes.code !== 0) {
    const rollback = await run(
      tsArgv(ciHold, ["rollback", pr, "--expect-head", report.head]),
      { stderr: "inherit", timeoutSec: ciHoldTimeoutSeconds() },
    );
    if (rollback.code === 0) {
      if (rollback.stdout.trim() !== "disabled")
        console.error(
          "finish-round.ts: the push provably did not land; released the CI hold label acquired for it",
        );
    } else if (rollback.code !== 5) {
      console.error(
        `finish-round.ts: retained the CI hold label after the failed push because rollback could not prove the ref stayed unchanged (exit ${rollback.code})`,
      );
    }
  }
  if (pushRes.code === 5) {
    return done(
      5,
      "PR_NOT_OPEN",
      `PR #${pr} is no longer open — nothing was pushed, and this round has nothing left to land`,
    );
  }
  if (isLeaseExit(pushRes.code)) {
    return done(
      pushRes.code,
      "LEASE_HELD",
      `guarded-push.ts refused with exit ${pushRes.code} — another holder is driving this tree or PR`,
    );
  }
  if (pushRes.code !== 0) {
    return done(
      1,
      "PUSH_FAILED",
      `guarded-push.ts exited ${pushRes.code} — see its diagnostic above`,
    );
  }
  report.pushed = true;

  // HEAD is re-read rather than trusted, because the push just spent real time
  // in the pre-push hook and this tree is shared: a concurrent commit here
  // would leave every `--pushed-sha` below naming a commit the PR does not
  // have. Cheap, and the alternative is a whole batch refused one key at a
  // time with a misleading reason.
  const afterRes = await git(["rev-parse", "HEAD"], {
    stderr: "pipe",
    timeoutSec: gitTimeoutSec,
  });
  if (afterRes.code !== 0 || afterRes.stdout.trim() !== report.head) {
    echoDiagnostic("git", afterRes.stderr);
    return done(
      1,
      "PUSH_FAILED",
      `local HEAD moved during the push (${report.head} → ${afterRes.stdout.trim() || "unreadable"}) — re-run against a settled tree`,
    );
  }

  // ── The stamp ────────────────────────────────────────────────────────────
  //
  // AFTER the push, and after the holds it vouches for. This is the marker
  // `claim-held` reads as "the push that carries THIS hold's fix" — nothing
  // else writes it, which is what makes an intervening push that bypassed
  // this sequence fail the comparison instead of passing it.
  const verifyRes = await run(
    tsArgv(driveState, ["stamp-held", pr, "--sha", report.head]),
    { stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
  );
  if (isLeaseExit(verifyRes.code)) {
    return done(
      verifyRes.code,
      "LEASE_HELD",
      `drive-state.ts stamp-held refused with exit ${verifyRes.code}`,
    );
  }
  if (verifyRes.code !== 0) {
    return done(
      1,
      "STAMP_FAILED",
      `drive-state.ts stamp-held exited ${verifyRes.code} — the push landed but nothing is stamped, so no held item can be dispatched; re-run once the state is readable`,
    );
  }
  report.stamped = true;

  // ── The head-sync wait ───────────────────────────────────────────────────
  //
  // `--no-count` is load-bearing, not cosmetic. The held threads
  // are still open on GitHub at this instant — nothing below has resolved them
  // yet — so a COUNTING call here returns ROUND_READY and bumps the durable
  // round for the head just pushed, inside the very step about to drain the
  // batch. Every hold's recorded round would then be stale before
  // `claim-held` ever reads it back. The head is still counted exactly once:
  // by § 1's gate at the top of the next round.
  //
  // Undeadlined for the same reason as the push: this script's whole job here
  // is to WAIT, and drive-status.ts owns `--timeout`.
  const statusRes = await run(
    tsArgv(driveStatus, [pr, "--json", "--no-count"]),
    { stderr: "inherit" },
  );
  if (isLeaseExit(statusRes.code)) {
    return done(
      statusRes.code,
      "LEASE_HELD",
      `drive-status.ts refused with exit ${statusRes.code}`,
    );
  }
  if (statusRes.code === 5) {
    return done(
      5,
      "PR_NOT_OPEN",
      `PR #${pr} closed or merged between the push and the head-sync wait — stop, and do not resolve anything against it`,
    );
  }
  // The exit code is NOT what proves the head synced — several of them are
  // reached with a synced head and several with the wait still pending — so
  // the report's own measurement decides. `head.api` is what GitHub says the
  // PR head is; `head.local` is what drive-status.ts measured in the tree being
  // driven. Both must equal the SHA just pushed, or nothing below may run:
  // a HEAD_LAG that never cleared can also mean the push never happened at
  // all, and a batch drained against that resolves threads whose fix is not
  // on the PR.
  let apiHead = "";
  let localHead = "";
  let statusState = "";
  try {
    const parsed: unknown = JSON.parse(statusRes.stdout);
    if (typeof parsed === "object" && parsed !== null) {
      const p = parsed as { head?: unknown; state?: unknown };
      if (typeof p.head === "object" && p.head !== null) {
        const h = p.head as { api?: unknown; local?: unknown };
        if (typeof h.api === "string") apiHead = h.api;
        if (typeof h.local === "string") localHead = h.local;
      }
      if (typeof p.state === "string") statusState = p.state;
    }
  } catch {
    // Falls through to the mismatch refusal below — an unreadable report is
    // not evidence of a synced head, and guessing here would be the one guess
    // this whole step exists to remove.
  }
  if (apiHead !== report.head || localHead !== report.head) {
    return done(
      1,
      "HEAD_NOT_SYNCED",
      `the PR head is not ${report.head} yet (api ${apiHead || "unreadable"}, local ${localHead || "unreadable"}${statusState === "" ? "" : `, state ${statusState}`}) — the batch stays held; re-run once drive-status.ts stops reporting a lagging head`,
    );
  }
  report.headSynced = true;

  // ── The drain ────────────────────────────────────────────────────────────
  const attempts = new Map<string, number>();
  // Keyed by item key, not appended — a key's LATEST non-stale outcome is what
  // belongs in the report, not every attempt along the way. A plain counter of
  // refusals double-counted a key that failed once and then succeeded on a
  // later attempt (the outer loop retries a NON-stale-capped key too, whenever
  // a DIFFERENT key's staleness forces a fresh read): the counter incremented
  // on the first attempt and was never given back on the second attempt's
  // success, so a batch that fully drained still reported PARTIAL over a
  // refusal that no longer existed. Deriving `report.items` and `refused` from
  // this map's final contents, rather than accumulating either as the loop
  // runs, means there is nothing to give back — the map only ever holds each
  // key's current truth.
  const resultsByKey = new Map<string, ItemResult>();
  for await (const attempt of retryAttempts({
    attempts: MAX_BATCH_READS,
    baseMs: 250,
    maxMs: 2_000,
    random: () => 1,
  })) {
    void attempt;
    const heldRes = await run(tsArgv(driveState, ["held", pr]), {
      stderr: "inherit",
    });
    if (isLeaseExit(heldRes.code)) {
      return done(
        heldRes.code,
        "LEASE_HELD",
        `drive-state.ts held refused with exit ${heldRes.code}`,
      );
    }
    if (heldRes.code !== 0) {
      return done(
        1,
        "BATCH_UNREADABLE",
        report.items.length === 0
          ? `drive-state.ts held exited ${heldRes.code} — the push and the stamp stand; nothing was dispatched`
          : `drive-state.ts held exited ${heldRes.code} on a re-read after a stale batch — the push and the stamp stand; ${report.items.length} item(s) from the prior read were already dispatched (see items above) before this re-read failed`,
      );
    }
    const batch = parseHeld(heldRes.stdout);
    if (batch === null) {
      return done(
        1,
        "BATCH_UNREADABLE",
        "drive-state.ts held printed a payload this script cannot read as a batch — inspect 'drive-state.ts get' rather than dispatching against it",
      );
    }
    if (batch.dropped > 0) {
      return done(
        1,
        "BATCH_UNREADABLE",
        `${batch.dropped} held entr${batch.dropped === 1 ? "y is" : "ies are"} not a usable record — refusing to report a batch drained when part of it could not be described`,
      );
    }

    // Only keys not yet at their attempt cap. A key already attempted twice
    // has been refused twice for the same reason, and a third pass over it
    // would just be the same refusal with a fresh read in front of it.
    const pending = batch.items.filter(
      (h) => (attempts.get(h.key) ?? 0) < MAX_ATTEMPTS_PER_KEY,
    );
    if (pending.length === 0) break;

    // `stale` is set by a `claim-held` exit 4 — the snapshot being iterated is
    // no longer current, so SKILL.md § 6 says re-read before trusting anything
    // else in it. Breaking out here rather than continuing the inner loop is
    // that instruction, mechanised.
    let stale = false;
    for (const item of pending) {
      attempts.set(item.key, (attempts.get(item.key) ?? 0) + 1);
      const outcome =
        item.kind === "thread"
          ? await resolveThreadItem(pr, item, report.head)
          : await answerFindingItem(pr, item, report.head);
      if (outcome.abort !== undefined) {
        resultsByKey.set(item.key, outcome.result);
        report.items = Array.from(resultsByKey.values());
        return done(outcome.abort.code, outcome.abort.state, outcome.abort.why);
      }
      // A stale outcome (claim-held exit 4: "not in the held batch") is not
      // recorded at all — it means a fresh `held` read is needed, and the key
      // is either already handled elsewhere (gone from the next read, nothing
      // left to reconcile) or still there (re-attempted, and THAT attempt's own
      // outcome — success or a genuine refusal — is what overwrites this key's
      // entry). Recording it unconditionally made one logical key appear TWICE
      // in a FINISHED report whenever a transient stale retry was followed by a
      // real success, and the SAME map is what fixes the sibling bug: a key's
      // non-stale REFUSAL that later succeeds (a DIFFERENT key going stale
      // forces a fresh read that retries this one too) now overwrites its own
      // earlier refused entry, instead of a separate counter remembering a
      // refusal that no longer exists. `echoDiagnostic` already surfaced the
      // stale event live at the call site above, so nothing here is silently
      // lost — only the misleading permanent record is.
      if (!outcome.stale) {
        resultsByKey.set(item.key, outcome.result);
        report.items = Array.from(resultsByKey.values());
      }
      if (outcome.stale) {
        stale = true;
        break;
      }
    }
    if (!stale) break;
  }

  const refused = report.items.filter((i) => i.action === "refused").length;
  if (refused > 0) {
    return done(
      6,
      "PARTIAL",
      `${refused} held item(s) refused — each is named above with the refusing script's exit code. Reconcile via SKILL.md § 3 (re-hold if the reply still stands, resolve under whatever outcome applies if it does not), then re-run`,
    );
  }

  // Neither exhaustion path above — `pending.length === 0` (every remaining key
  // already at its attempt cap) nor the `for` loop's own MAX_BATCH_READS bound
  // running out — is itself a counted refusal: a stale (exit 4) outcome is
  // never recorded in `resultsByKey` (that is what keeps a batch that fully
  // drains on a refreshed snapshot from a false PARTIAL, see above), so a key
  // that stays stale on every attempt can exhaust either bound with `refused`
  // still at 0. Verify the batch is ACTUALLY empty before reporting FINISHED,
  // rather than trusting that a loop which stopped iterating means nothing is
  // left held.
  const postDrainRes = await run(tsArgv(driveState, ["held", pr]), {
    stderr: "inherit",
  });
  if (isLeaseExit(postDrainRes.code)) {
    return done(
      postDrainRes.code,
      "LEASE_HELD",
      `drive-state.ts held refused with exit ${postDrainRes.code} on the post-drain verification read`,
    );
  }
  if (postDrainRes.code !== 0) {
    return done(
      1,
      "BATCH_UNREADABLE",
      `drive-state.ts held exited ${postDrainRes.code} on the post-drain verification read — the drain above may have finished cleanly, but this script cannot confirm the batch is actually empty`,
    );
  }
  const finalBatch = parseHeld(postDrainRes.stdout);
  if (finalBatch === null || finalBatch.dropped > 0) {
    return done(
      1,
      "BATCH_UNREADABLE",
      "the post-drain verification read produced a batch this script cannot fully describe — inspect 'drive-state.ts get' rather than trusting the drain is complete",
    );
  }
  if (finalBatch.items.length > 0) {
    // Exit 6's documented contract (this file's own exit table, SKILL.md, the
    // PR description) is "drained with refusals, each named in `report.items`"
    // — a caller inspecting `items` for what to reconcile must not find it
    // empty just because these items were never dispatched rather than
    // dispatched-and-refused. Synthesizing an entry per remaining key keeps
    // that contract true for this case too, rather than adding a second exit-6
    // meaning nothing downstream can distinguish.
    for (const item of finalBatch.items) {
      // `attempts` is this key's own count, not a batch-wide one: a key can
      // reach here having gone stale on every attempt it DID get (some
      // non-zero count under MAX_ATTEMPTS_PER_KEY), or having never been
      // reached at all — the inner loop breaks the INSTANT any item in
      // `pending` goes stale (this file's own "Breaking out here" comment
      // above), so a batch whose earlier keys keep going stale can exhaust
      // MAX_BATCH_READS before a later sibling is ever attempted once. A
      // thread is the concrete case: its claim path could not return exit 4
      // at all before this same fix, so a remaining thread on an unpatched
      // build could only mean the latter. Reporting a fabricated "claim-held
      // exit 4" and "never dispatched" in the SAME sentence for a key that
      // was, in fact, dispatched and refused with that exact code every time
      // is self-contradictory; reporting it for a key that was never
      // dispatched at all invents a helper call that did not happen.
      const seen = attempts.get(item.key) ?? 0;
      resultsByKey.set(item.key, {
        key: item.key,
        kind: item.kind,
        action: "refused",
        // Not a real subprocess exit code for the unattempted case — no
        // script ran, so nothing produced one. -1 is unambiguous: no POSIX
        // exit code is negative, so it cannot be mistaken for a genuine
        // claim-held answer the way reusing 4 here would be.
        code: seen > 0 ? 4 : -1,
        diagnostic:
          seen > 0
            ? `stale on every attempt (${seen} of ${MAX_ATTEMPTS_PER_KEY}, claim-held exit 4) — a concurrent operation kept invalidating this drain's own snapshot of it faster than a claim could land; exhausted MAX_ATTEMPTS_PER_KEY or MAX_BATCH_READS without ever landing a real outcome`
            : `never dispatched — the ${MAX_BATCH_READS}-read batch budget was exhausted by other keys' staleness before this key was ever reached; no claim-held call for it ran, so this is not itself a refusal — reconcile via SKILL.md § 3 or simply re-run for a fresh drain to get a turn at it`,
      });
    }
    report.items = Array.from(resultsByKey.values());
    // Mirrors the per-item split just above, at the summary level: the loop
    // stops at the FIRST stale item on each read (this file's own "Breaking
    // out here" comment), so a batch whose earlier keys keep going stale can
    // exhaust the bounds with later siblings never attempted even once. A
    // summary that unconditionally says "each stayed stale on every attempt"
    // contradicts those siblings' own honest per-item diagnostics and can
    // misdirect recovery toward reconciling a refusal that never happened.
    const neverDispatched = finalBatch.items.filter(
      (item) => (attempts.get(item.key) ?? 0) === 0,
    ).length;
    const staleEveryAttempt = finalBatch.items.length - neverDispatched;
    const parts: string[] = [];
    if (staleEveryAttempt > 0) {
      parts.push(`${staleEveryAttempt} stayed stale on every attempt`);
    }
    if (neverDispatched > 0) {
      parts.push(
        `${neverDispatched} never got a single attempt (batch-read budget exhausted first)`,
      );
    }
    return done(
      6,
      "PARTIAL",
      `${finalBatch.items.length} held item(s) remain after exhausting the retry/read bounds — ${parts.join(", ")} (see items above for which is which). Reconcile via SKILL.md § 3, then re-run`,
    );
  }

  return done(
    0,
    "FINISHED",
    `round finished on ${report.head}: pushed, stamped, head-synced, ${report.items.length} held item(s) drained`,
  );
}

interface ItemOutcome {
  result: ItemResult;
  /** A `claim-held` exit 4 — re-read the batch before continuing. */
  stale?: boolean;
  /** Set when the whole drain must stop, not just this key. */
  abort?: { code: number; state: Report["state"]; why: string };
}

/**
 * A held THREAD, resolved only through the wrapper — never `resolve-thread.ts`
 * directly, whose mutation is unconditional and has no notion of which push
 * justifies it. The wrapper's `claim-held --kind thread` is both
 * the provenance check and the thread's OWN claim, in one lock hold, so there
 * is no separate claim/release pair on this path.
 */
async function resolveThreadItem(
  pr: string,
  item: HeldRecord,
  head: string,
): Promise<ItemOutcome> {
  const res = await run(
    tsArgv(resolveHeldThread, ["--key", item.key, "--pushed-sha", head, pr]),
    { stderr: "pipe" },
  );
  if (isLeaseExit(res.code)) {
    echoDiagnostic("resolve-held-thread.ts", res.stderr);
    return {
      result: {
        key: item.key,
        kind: item.kind,
        action: "refused",
        code: res.code,
        diagnostic: res.stderr,
      },
      abort: {
        code: res.code,
        state: "LEASE_HELD",
        why: `resolve-held-thread.ts refused with exit ${res.code}`,
      },
    };
  }
  if (res.code === 3) {
    // The state file itself is unreadable — `resolve-held-thread.ts`
    // reaches this both through its own precheck `drive-state.ts held` call
    // and through `claim-held`, either of which propagates `store.ts`'s
    // `ExitError(3)` verbatim on a malformed state file. Not a per-key
    // problem — `answerFindingItem` already treats the identical exit from
    // the finding path as a batch-level abort; this mirrors it, rather than
    // iterating the rest of an untrustworthy snapshot one silently-refused
    // thread at a time.
    echoDiagnostic("resolve-held-thread.ts", res.stderr);
    return {
      result: {
        key: item.key,
        kind: item.kind,
        action: "refused",
        code: 3,
        diagnostic: res.stderr,
      },
      abort: {
        code: 1,
        state: "BATCH_UNREADABLE",
        why: "drive-state.ts could not read this PR's state — stopping the drain rather than operating on unreadable state",
      },
    };
  }
  if (res.code !== 0) {
    echoDiagnostic("resolve-held-thread.ts", res.stderr);
    return {
      result: {
        key: item.key,
        kind: item.kind,
        action: "refused",
        code: res.code,
        diagnostic: res.stderr,
      },
      // Mirrors the finding path's `claimRes.code === 4` handling above.
      // `resolve-held-thread.ts` returns exit 4 — from either its own `held`
      // precheck or the `claim-held --kind thread` call it wraps — when the
      // key is no longer in the held batch at all, which is the snapshot
      // going stale (a concurrent operation, most often this very thread's
      // own resolve, already removed it since this drain's last read), not a
      // property of this item. Recording it as a permanent refusal made the
      // drain return PARTIAL/6 over work that had already finished.
      stale: res.code === 4,
    };
  }
  return {
    result: { key: item.key, kind: item.kind, action: "resolved", code: 0 },
  };
}

/**
 * A held FINDING: claim, dispatch, release — in that order, with the release
 * fired the instant the external operation succeeds rather than accumulated
 * into an end-of-batch `--all`. A pass killed after answering three of five
 * and before a single release would re-answer all five next round, and
 * `answer-summary-finding.ts`'s none-answered path posts a NEW top-level
 * comment every call.
 *
 * The item's own `.reason` goes to the dispatch verbatim on stdin — never
 * re-composed, which is exactly the recollection the durable batch exists not
 * to depend on.
 */
async function answerFindingItem(
  pr: string,
  item: HeldRecord,
  head: string,
): Promise<ItemOutcome> {
  const refusal = (code: number, diagnostic: string): ItemOutcome => ({
    result: {
      key: item.key,
      kind: item.kind,
      action: "refused",
      code,
      diagnostic,
    },
  });

  // Checked BEFORE the claim, not after: `answer-summary-finding.ts` refuses a
  // blank reason anyway, but reaching that refusal costs a claim this script
  // would then have to give back, and a claim/unclaim pair over a record that
  // was never dispatchable is noise in the one log a successor reads. `hold
  // --kind finding` requires the body on stdin, so an entry without one did
  // not come from that path.
  if ((item.reason ?? "").trim() === "") {
    const diagnostic = `finish-round.ts: held finding '${item.key}' carries no reason body — 'drive-state.ts hold --kind finding' requires one, so this entry did not come from that path. Re-hold it via SKILL.md § 3 with the reason on stdin.\n`;
    // Locally generated, not a helper's stderr — but `emit()`'s prose mode
    // only prints action/code/key per item, never the diagnostic text, so
    // without this an operator watching an unattended (non-`--json`) run
    // sees a bare PARTIAL and has to go dig for what actually corrupted the
    // held entry.
    echoDiagnostic("finish-round.ts", diagnostic);
    return refusal(2, diagnostic);
  }

  const claimRes = await run(
    tsArgv(driveState, [
      "claim-held",
      pr,
      "--key",
      item.key,
      "--kind",
      "finding",
      "--pushed-sha",
      head,
    ]),
    { stderr: "pipe" },
  );
  if (claimRes.code !== 0) {
    echoDiagnostic("claim-held", claimRes.stderr);
    if (isLeaseExit(claimRes.code)) {
      return {
        ...refusal(claimRes.code, claimRes.stderr),
        abort: {
          code: claimRes.code,
          state: "LEASE_HELD",
          why: `drive-state.ts claim-held refused with exit ${claimRes.code}`,
        },
      };
    }
    // Exit 3 is the state file itself being unreadable — not a per-key
    // problem, so the round stops rather than iterating an entire batch one
    // silently-failing key at a time. Exit 4 is a stale snapshot: re-read.
    // Everything else (1, and the usage codes) is per-key — skip it, keep
    // going, and let the report carry the refusal.
    if (claimRes.code === 3) {
      return {
        ...refusal(3, claimRes.stderr),
        abort: {
          code: 1,
          state: "BATCH_UNREADABLE",
          why: "drive-state.ts could not read this PR's state — stopping the drain rather than operating on unreadable state",
        },
      };
    }
    return {
      ...refusal(claimRes.code, claimRes.stderr),
      stale: claimRes.code === 4,
    };
  }
  const token = claimRes.stdout.trim();
  if (token === "") {
    // A claim that printed no token cannot be released or unclaimed, so it
    // must not be dispatched against either: the key would be wedged behind a
    // claim nothing can give back. Reported, not worked around.
    const diagnostic =
      "claim-held printed no token — refusing to dispatch a claim this script could not release. Inspect 'drive-state.ts get'.\n";
    echoDiagnostic("finish-round.ts", diagnostic);
    return refusal(1, diagnostic);
  }

  const answerRes = await run(
    tsArgv(answerSummaryFinding, [
      "--outcome",
      item.outcome,
      "--fingerprint",
      item.key,
      "--pushed-sha",
      head,
      pr,
    ]),
    { stderr: "pipe", stdin: item.reason ?? "" },
  );
  if (answerRes.code !== 0) {
    echoDiagnostic("answer-summary-finding.ts", answerRes.stderr);
    // Give the claim back immediately rather than leaving it to expire, so a
    // retry — this round or the next — is not blocked behind the staleness
    // window. The retry must still start with a fresh `claim-held`: this
    // token is dead the moment `unclaim-held` accepts it.
    const unclaimRes = await run(
      tsArgv(driveState, [
        "unclaim-held",
        pr,
        "--key",
        item.key,
        "--token",
        token,
      ]),
      { stderr: "pipe" },
    );
    if (unclaimRes.code !== 0) {
      echoDiagnostic("unclaim-held", unclaimRes.stderr);
    }
    if (isLeaseExit(answerRes.code)) {
      return {
        ...refusal(answerRes.code, answerRes.stderr),
        abort: {
          code: answerRes.code,
          state: "LEASE_HELD",
          why: `answer-summary-finding.ts refused with exit ${answerRes.code}`,
        },
      };
    }
    // A lease refusal from the cleanup itself is still a lease refusal from
    // "any step" (see isLeaseExit's contract) even though the answer dispatch
    // that provoked it failed for an ordinary reason — flattening it into an
    // per-key refused/6 would leave the claim live and block recovery until
    // the staleness window expires instead of ending the run now.
    if (isLeaseExit(unclaimRes.code)) {
      return {
        ...refusal(answerRes.code, answerRes.stderr),
        abort: {
          code: unclaimRes.code,
          state: "LEASE_HELD",
          why: `unclaim-held refused with exit ${unclaimRes.code}`,
        },
      };
    }
    // A non-lease unclaim failure leaves the claim live rather than reverting
    // it to reclaimable — a fact the report must carry alongside the answer's
    // own refusal, not just echo to a scrollback an unattended pass never
    // reads.
    return refusal(
      answerRes.code,
      unclaimRes.code === 0
        ? answerRes.stderr
        : `${answerRes.stderr}\nunclaim-held also failed (exit ${unclaimRes.code}) — the claim on '${item.key}' remains live rather than reclaimable:\n${unclaimRes.stderr}`,
    );
  }

  const releaseRes = await run(
    tsArgv(driveState, [
      "release-held",
      pr,
      "--key",
      item.key,
      "--token",
      token,
    ]),
    { stderr: "pipe" },
  );
  if (releaseRes.code !== 0) {
    echoDiagnostic("release-held", releaseRes.stderr);
    const out = refusal(
      releaseRes.code,
      `finish-round.ts: the ANSWER for '${item.key}' was posted successfully; only the release failed, so the entry is still held at ${head}.\n${releaseRes.stderr}`,
    );
    // A lease refusal here means another driver has taken over since the
    // answer posted — the same "any step" contract as every other lease
    // check, and the reason this one must abort rather than fall through to
    // the ordinary reconcile-and-rerun path below: continuing would dispatch
    // the REST of this batch against a lease that is no longer this
    // process's to hold.
    if (isLeaseExit(releaseRes.code)) {
      return {
        ...out,
        abort: {
          code: releaseRes.code,
          state: "LEASE_HELD",
          why: `release-held refused with exit ${releaseRes.code}`,
        },
      };
    }
    // Exit 3 is the state file itself being unreadable — not a per-key problem,
    // the same "malformed, refuse" condition the claim step already aborts the
    // whole drain over (`claimRes.code === 3` above) and `resolveThreadItem`
    // mirrors for the thread path. Falling through to an ordinary per-item
    // refusal here left a batch-level failure looking like one bad key: if this
    // was the last item, the drain returns PARTIAL/6 naming ONE finding to
    // reconcile, when the real problem is that nothing in `held` can be trusted
    // right now.
    if (releaseRes.code === 3) {
      return {
        ...out,
        abort: {
          code: 1,
          state: "BATCH_UNREADABLE",
          why: `release-held could not read this PR's state after posting the answer for '${item.key}' — the answer stands, but stopping the drain rather than operating on unreadable state`,
        },
      };
    }
    // The ANSWER is already on the PR — that is the irreversible half, and it
    // succeeded. A failed, non-lease, non-3 release leaves the entry held at
    // the SHA it was answered under, which the next `claim-held` refuses
    // (correctly: it is what stops a duplicate comment) and whose recovery
    // that refusal itself prints. Reported as a refusal so the round does not
    // read as clean, and NOT retried here: the token is still valid, so a
    // human or a re-run can release it, and a retry loop over a state file
    // that just refused a write is not a recovery.
    return out;
  }
  return {
    result: { key: item.key, kind: item.kind, action: "answered", code: 0 },
  };
}

runMain("finish-round.ts", main);
