#!/usr/bin/env bun
/**
 * Reply to a review thread AND record its durable disposition, as ONE
 * invocation.
 *
 * SKILL.md § 3 used to require separate commands per thread: `reply-to-thread.ts`
 * to post the sanctioned outcome reply, then either `drive-state.ts hold`
 * (accepted/moot) or `resolve-thread.ts` (rejected/wont-fix/deferred) to
 * record the disposition. A pass killed between the two leaves a reply on
 * GitHub with no durable record of it — exactly the crash class § 3's
 * qualifying-comment crash-recovery protocol exists to patch, and that
 * protocol is a page of ordering-sensitive prose (trusted-author check,
 * grammar predicate, last-qualifying-comment rule, truncation guard)
 * compensating for a window the tooling itself created. This script folds
 * both halves into one process and, on re-invocation for the same thread,
 * detects an already-posted qualifying reply and completes only the missing
 * half — so the crash window is bounded by this script's own execution, not
 * by agent turn boundaries.
 *
 * This is SELF-RECONCILING, not transactionally atomic — a kill between the
 * post and its dispatch still leaves the reply briefly without a durable
 * record, exactly as before, just no longer exposed to a full agent turn
 * boundary. Closing that window outright would need a primitive GitHub's
 * comment API does not expose (no conditional write, no idempotency key — the
 * same limitation the concurrent-post residual noted at the fresh-post call
 * site below runs into, arbitrated `wont-fix` for the identical reason). What
 * this script actually guarantees is that the NEXT invocation — the retry a
 * crash always forces anyway — completes the missing half instead of
 * duplicating the reply; see the reconciliation rule (step 5) for the
 * mechanism.
 *
 * Usage:
 *   triage-thread.ts <THREAD_NODE_ID> [PR] [--moot-pending-push] [--leave-open] <<'EOF'
 *   **accepted** — fixed the missing guard; not yet pushed.
 *   EOF
 *   triage-thread.ts <THREAD_NODE_ID> [PR] --cleanup-only
 *
 *   THREAD_NODE_ID     the `threadId` field from list-unresolved-threads.ts.
 *   PR                 needed only when the outcome this call will end up
 *                       dispatching turns out to be accepted/moot (recorded
 *                       via `drive-state.ts hold [PR] ...`); defaults to the
 *                       current branch's PR when omitted, resolved BEFORE any
 *                       posting — see step 5's ordering note. A
 *                       rejected/wont-fix/deferred outcome never needs one to
 *                       record its own disposition — `resolve-thread.ts`
 *                       doesn't either — but IS still resolved, best-effort,
 *                       to clean up a stale prior hold on the same key (see
 *                       step 7 below); that lookup never blocks the resolve
 *                       itself.
 *   --moot-pending-push per SKILL.md § 3, `moot`
 *                       defaults to resolving immediately (the anchored code
 *                       is simply gone) and is held ONLY when its premise is
 *                       specifically an unpushed accepted fix from this same
 *                       round. The reply grammar can't distinguish the two —
 *                       both are the identical `**moot**` token — so state it
 *                       explicitly here; omit it for the default (resolve
 *                       now). Has no effect on any other outcome, and NONE
 *                       on a RECONCILED `moot` either (step 5) — reconciling
 *                       always treats `moot` as held, whatever this flag
 *                       says, since the reply may have been posted by an
 *                       earlier invocation whose own flag this one has no
 *                       way to see (`isHoldOutcome`'s own header).
 *   --leave-open        skip the resolve for a MERIT outcome (`rejected`/
 *                       `wont-fix`/`deferred`/plain `moot`) — the reply still
 *                       posts (or reconciles), but the thread stays open.
 *                       Preserves the human-thread exception (SKILL.md's
 *                       "Leaving a human thread open"): a human thread you
 *                       replied to but chose not to close on the author's
 *                       behalf — the old two-command flow honored it simply by
 *                       never calling `resolve-thread.ts`, a choice point this
 *                       one-call command otherwise removes. No effect on
 *                       `accepted` or a HELD `moot` (`--moot-pending-push` on a
 *                       fresh post, or reconciled — always held) — neither is
 *                       ever resolved by this script regardless (released by
 *                       `resolve-held-thread.ts` in step 6 instead). A fresh
 *                       PLAIN `moot` (no `--moot-pending-push`) IS a merit
 *                       outcome per `isHoldOutcome`, so `--leave-open` DOES
 *                       apply to it, same as any other merit outcome. A FRESH,
 *                       non-hold post with this flag also appends
 *                       `LEAVE_OPEN_MARKER` to the reply body (invisible on
 *                       GitHub), so a LATER invocation that reconciles this
 *                       same reply — a later round re-enumerating a thread left
 *                       deliberately open, not only a crash — recovers the
 *                       choice from the marker even when its OWN `--leave-open`
 *                       is omitted; see `effectiveLeaveOpen`'s own comment. An
 *                       explicit `--leave-open` on a RECONCILING call whose
 *                       existing reply ALREADY has the marker is a no-op (the
 *                       marker alone already covers it) — but on one with NO
 *                       marker (the deliberate-supersession path, which reaches
 *                       reconciliation on its first call, is the common way to
 *                       hit this), the flag REFUSES instead of silently
 *                       honouring an unpersistable promise: reconciliation
 *                       posts nothing, so there is no comment to append a
 *                       marker to, and the choice would evaporate the moment
 *                       this process exits — a later retry or `reconcile-
 *                       replied-threads.ts` sweep would resolve the thread
 *                       anyway. For that case, the durable equivalent is the
 *                       old two-command flow's own answer: stop after
 *                       `reply-to-thread.ts`'s own post and never invoke this
 *                       script's resolve step at all — durable against every
 *                       UNATTENDED sweep specifically (SKILL.md's own "Leaving
 *                       a human thread open" section has the full argument and
 *                       the one human-attended exception; not repeated here to
 *                       avoid a second copy that can drift). Never use this
 *                       path — or `--leave-open` itself — on a BOT-started
 *                       thread: see `LEAVE_OPEN_MARKER`'s own header in
 *                       `lib/outcome.ts` for the accepted provenance residual
 *                       this flag lives inside of. That fallback still owes ONE
 *                       follow-up call — `--cleanup-only` below — since
 *                       stopping after the post means this script's own
 *                       reconciliation branch (the only caller of the
 *                       stale-hold cleanup) never runs.
 *   --cleanup-only       release a stale `accepted`/`moot` hold on this key
 *                        WITHOUT posting or resolving anything — the answer to
 *                        `--leave-open`'s own "durable equivalent" above: a
 *                        direct-post supersession that deliberately never
 *                        invokes this script's post/resolve branch also never
 *                        reaches `attemptStaleHoldCleanup`, so a hold the
 *                        direct post superseded is stranded with no other path
 *                        back (the RECONCILING variant of this same gap is
 *                        closed separately). Reads no stdin, requires no
 *                        outcome grammar, and refuses (exit 2) combined with
 *                        `--moot-pending-push`/`--leave-open` — those govern
 *                        how a reply is posted, and this posts nothing.
 *   BODY                read from stdin, exactly as `reply-to-thread.ts`
 *                       requires it — the first line opens with a bold,
 *                       lowercase outcome token (`**accepted**`,
 *                       `**rejected**`, `**wont-fix**`, `**deferred**`,
 *                       `**moot**`), a space/tab, then a reason. Only used
 *                       when NOTHING qualifying already exists on the thread
 *                       (step 5) — see the reconciliation rule below.
 *                       `--no-outcome` is deliberately NOT supported here: a
 *                       reply that is not a triage decision (a clarifying
 *                       question) has nothing to hold or resolve, so it stays
 *                       on `reply-to-thread.ts` directly.
 *
 * What "one invocation" actually does:
 *
 *   1. Read the thread's CURRENT state from GitHub (never from a stale
 *      caller-supplied snapshot) — `isResolved`, `commentsTruncated`, and
 *      every comment's `author`, `authorAssociation`, `body`, `url`.
 *   2. `commentsTruncated` refuses the reconciliation scan outright (exit 3
 *      unless already resolved — see step 4), never attempting step 3's scan
 *      — SKILL.md § 3's own rule: a reply past the 100-comment cap could
 *      supersede what is visible, so a qualifying comment found in the
 *      visible prefix is not trustworthy evidence either. Park the thread
 *      instead (`drive-state.ts park`).
 *   3. Scan the comments, most recent first, for the LAST one from a TRUSTED
 *      author (`summary-findings.ts --trusted-associations`, the same set
 *      `reconcile-replied-threads.ts` and `announce-merge-ready.ts` already
 *      use) whose body opens with the outcome grammar
 *      (`lib/outcome.ts#qualifyingOutcome` — the ONE implementation this
 *      script shares with `reconcile-replied-threads.ts`, so the two can
 *      never disagree about what counts as a qualifying reply). Done
 *      unconditionally here, BEFORE step 4's `isResolved` check, so both that
 *      check and step 5's reconciliation share one read.
 *   4. Already `isResolved`: exit 0, nothing further to POST — resolving does
 *      not delete comments, so a thread closed by a concurrent driver, a
 *      human, or this same command's own earlier dispatch would otherwise
 *      still be posted into. `isResolved` is a top-level thread field, not
 *      derived from the comment-window truncation limits, so it answers this
 *      question reliably even when step 2 refused the scan — a
 *      truncated-AND-resolved thread returns 1, not exit 0 (see 'Exit codes'
 *      below) — the stale-hold check needs the same unreliable scan
 *      truncation already ruled out, so it can neither run nor be skipped
 *      silently.
 *      Still worth a stale-hold check when NOT truncated: an interruption
 *      between a PRIOR merit dispatch's `resolve-thread.ts` succeeding and
 *      its OWN cleanup completing leaves exactly this state on retry, and
 *      nothing else ever revisits a resolved thread (`list-unresolved-
 *      threads.ts` stops enumerating it the moment it resolves). But this
 *      cleanup is gated on a CONFIRMED merit supersession — the last
 *      qualifying trusted reply (step 3's scan) is itself an unambiguous
 *      `rejected`/`wont-fix`/`deferred`. `isResolved` alone proves nothing
 *      about WHY: GitHub's UI lets anyone resolve a thread directly, with no
 *      relationship to whether a promised accepted/moot fix ever passed
 *      gates or got pushed, so blindly releasing on any `isResolved` sighting
 *      could delete the only durable record of a genuinely unverified
 *      obligation. A last qualifying
 *      reply that is `null`, `accepted`, or plain `moot` (the SAME fail-safe
 *      exclusion `isHoldOutcome` applies to reconciliation, and for the
 *      identical reason) leaves a stale hold untouched for the normal
 *      verified-push release path instead.
 *   5. **The reconciliation rule: if a qualifying reply is found at all, its
 *      outcome is THE ANSWER — regardless of what this invocation's own body
 *      says.** This mirrors the ORIGINAL SKILL.md § 3 crash-recovery rule
 *      exactly ("the outcome the qualifying reply already committed to decides
 *      which") rather than comparing it against this call's intent: a retrying
 *      agent has no memory of what an earlier, interrupted pass decided, so it
 *      can easily land on a genuinely different outcome word for the SAME
 *      finding on retry — and posting THAT would put a second outcome token on
 *      one triage decision, exactly what this script exists to prevent. Do NOT
 *      post again in this case; skip straight to step 7, using the found
 *      comment's own outcome and url. A comment that qualifies but carries no
 *      readable `url` fails closed (exit 1) ONLY when step 7 will need it —
 *      i.e. when the outcome is a HOLD one — since a `--comment-url`-less hold
 *      cannot be recorded and guessing here would either drop the disposition
 *      silently or double-post. A merit outcome needs no url at all
 *      (`resolve-thread.ts` takes only the threadId), so an unreadable one
 *      there does not block the resolve — matching
 *      `reconcile-replied-threads.ts`'s own precedent of checking it only in
 *      its hold branch (an earlier, unconditional version of this check left a
 *      trusted merit reply with an unreadable url permanently unresolved). A
 *      DELIBERATE supersession (a trusted author overriding their own earlier
 *      verdict with new information) still works exactly as before — post the
 *      new reply with `reply-to-thread.ts` directly, then invoke THIS script to
 *      complete the disposition (never optional: neither the resolve nor the
 *      stale-hold release happens on its own — `reply-to-thread.ts` only
 *      posts). It will find that AS the qualifying reply and act on it. Left
 *      un-invoked, the thread stays unresolved and picks up the SAME
 *      reconciliation the next time step 2/3's ordinary loop reaches it — not
 *      stuck, but a needless extra round for a dispatch this call could have
 *      completed immediately.
 *
 *      Whichever way this resolves — reconciliation or (in step 6) a fresh
 *      post — decides ONE outcome word, the "prospective" one. If that word
 *      is accepted/moot, the PR is resolved HERE, before step 6 can post
 *      anything: this is what stops an accepted/moot reply from landing
 *      irreversibly on GitHub only to then discover there is no PR to hold
 *      it against.
 *   6. Otherwise (nothing qualifying found): post the reply for real via
 *      `reply-to-thread.ts` (which enforces the grammar, fences the post
 *      behind the drive lease, and performs the actual GraphQL
 *      mutation) and take the comment url it prints.
 *   7. Dispatch on the outcome (`moot` follows the `rejected`/`wont-fix`/
 *      `deferred` row UNLESS this is a FRESH post AND `--moot-pending-push`
 *      was given — a RECONCILED `moot` (step 5) always follows the
 *      `accepted` row instead, whatever this invocation's own flag says; see
 *      `isHoldOutcome`'s own header for why):
 *        rejected / wont-fix / deferred (/ moot, by default) ->
 *          `resolve-thread.ts` now. These are merit claims with nothing to
 *          wait on. Afterwards, best-effort:
 *          release a STALE prior `accepted`/`moot` hold for this same key —
 *          mirroring `reconcile-replied-threads.ts`'s own post-resolve
 *          cleanup exactly — since a
 *          merit reply found in step 5 can be a deliberate supersession of an
 *          earlier accepted/moot verdict this script itself (or a prior
 *          round) once held, and `resolve-thread.ts` has no notion of
 *          `held` at all. Scoped to a hold whose `commentUrl` is among the
 *          comments THIS pass's own read of the thread returned — never a
 *          hold this pass never saw — same identity-based reasoning as the
 *          sibling script. Skipped (loudly, on stderr) when no PR can be
 *          resolved: the resolve itself still succeeds either way, since the
 *          thread's own outcome does not depend on `held` state.
 *        accepted (/ moot, WITH `--moot-pending-push` on a fresh post, or
 *        ALWAYS when reconciled) -> `drive-state.ts hold [PR] --key <id>
 *          --kind thread --outcome <o> --comment-url <url>`, requiring a PR
 *          number.
 *          The reply-carrying pass that just posted fresh (step 6) IS the
 *          live triage decision for the current round, so this uses the
 *          ordinary (confirmed) `hold` — the same ordering the two-command
 *          flow always used. A hold sourced from RECONCILIATION (step 5)
 *          instead uses `--unconfirmed`: this invocation did not just
 *          confirm the promised fix is in the tree (it never reads the tree
 *          at all, only GitHub's comment text), which is exactly
 *          `reconcile-replied-threads.ts`'s own reasoning for using
 *          `--unconfirmed` on the identical situation — so a live pass's own
 *          step 3, which CAN read the tree, is what re-holds it for real.
 *
 * Exit codes:
 *   0   done — replied (or reconciled) and resolved/held, or nothing to do
 *       (already resolved, with no stranded stale hold — see exit 1).
 *   1   a read this script needed came back unusable: the thread's current
 *       state could not be fetched, the trusted-association set could not be
 *       read, `reply-to-thread.ts` printed no comment url, a HOLD outcome
 *       (accepted, or a held moot) was found with no readable url — never a
 *       merit outcome, which needs none — a hold outcome could not resolve a PR
 *       number, a merit dispatch (fresh or reconciled, or the already-resolved
 *       path) resolved/confirmed the thread but then FAILED to clean up a stale
 *       prior accepted/moot hold on the same key, the thread is BOTH already
 *       resolved AND `commentsTruncated` — the stale- hold check cannot run
 *       (truncation makes the last qualifying reply unreliable) and cannot be
 *       skipped silently either — or an explicit `--leave-open` on a
 *       RECONCILING call whose existing reply carries no LEAVE_OPEN_MARKER:
 *       reconciliation posts nothing, so the choice cannot be made durable and
 *       this refuses rather than silently proceeding on a promise the next
 *       invocation will not see (see `--leave-open`'s own usage entry).
 *       Reported this way rather than as a silent stderr-only warning because
 *       nothing else will ever revisit a RESOLVED thread to retry it
 *       (`releaseStaleHold`'s own header). Fail-closed — an unreadable
 *       precondition in front of an irreversible post is a refusal, not a
 *       guess.
 *   2   usage error, or the stdin body does not open with the outcome
 *       grammar.
 *   3   the thread is `commentsTruncated` — needs a human look
 *       (`/resolve-review-comments` § 2), not an automatic decision.
 *   4   a merit reply stands, but its code scanning alert is undismissed: open.
 *   *   whatever `reply-to-thread.ts`, `resolve-thread.ts`, or `drive-state.ts
 *       hold` themselves returned, propagated verbatim — including 11
 *       (another live session holds this tree's drive lease) and 13 (another
 *       working tree is driving this PR). Remapping those would hide exactly
 *       the refusal a caller has to act on.
 *
 * On Windows, invoke through the runtime (`bun triage-thread.ts …`) — a
 * shebang only carries the POSIX direct-execution path.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, isDigits, readStdinAll, runMain } from "./lib/cli.ts";
import {
  hasLeaveOpenMarker,
  LEAVE_OPEN_MARKER,
  LEAVE_OPEN_MARKER_PRODUCER_ENV,
  type Outcome,
  qualifyingOutcome,
} from "./lib/outcome.ts";
import { ghCall, readTimeoutEnv, resolvePr, run, tsArgv } from "./lib/proc.ts";
import {
  confirmedMeritSupersession,
  mootHeld,
  resolveDeclinedThread,
} from "./lib/scanner-sweep-guard.ts";
import { TRUSTED_ASSOCIATIONS } from "./summary-findings.ts";

const here = dirname(fileURLToPath(import.meta.url));
const driveState = join(here, "drive-state.ts");
const rrcScripts = join(here, "..", "..", "resolve-review-comments", "scripts");
const replyToThread = join(rrcScripts, "reply-to-thread.ts");

/**
 * Is this outcome fix-dependent (held, never resolved on the spot)?
 *
 * `accepted` always is. `moot` is NOT by default — per SKILL.md § 3, a moot
 * finding defaults to resolving immediately (the anchored code is simply gone)
 * and is held ONLY when its premise is specifically an unpushed accepted fix
 * from this same round (holding it with the accepted batch, since its premise
 * fails if that fix's own gates do). This script cannot tell those two `moot`
 * cases apart from the reply grammar alone — both use the identical `**moot**`
 * token — so the caller states it via `treatMootAsHold`. `rejected`/`wont-fix`/
 * `deferred` are never held under any value of it — `drive-state.ts hold`
 * hard-refuses them too, for the same reason.
 *
 * `treatMootAsHold` is NOT simply "was `--moot-pending-push` given" — see the
 * call site, which resolves it once per invocation: a `moot` RECONCILED from
 * an existing reply always passes `true` here regardless of this
 * invocation's own flag, because the flag is this invocation's belief and a
 * reconciled reply may have been posted by an earlier, now-gone one whose
 * belief this call cannot see.
 */
function isHoldOutcome(outcome: Outcome, treatMootAsHold: boolean): boolean {
  if (outcome === "accepted") return true;
  if (outcome === "moot") return treatMootAsHold;
  return false;
}

const OUTCOME_HELP = `triage-thread.ts: body must begin with an outcome token.

  **accepted**  the finding is real and you fixed it
  **rejected**  the finding is wrong, already handled, or intended
  **wont-fix**  valid but deliberately declined (triage rubric); no follow-up
  **deferred**  real and obligatory but out of scope; a follow-up issue is filed
  **moot**      no longer applies; the anchored code is gone

Write it as the FIRST token of the first line, bold and lowercase, followed by
whitespace and a concrete reason, e.g.

  **accepted** — added the missing guard; not yet pushed.

A reply that is genuinely not an outcome (a clarifying question) has nothing
for this script to hold or resolve — use reply-to-thread.ts --no-outcome
directly instead.`;

interface ThreadComment {
  author: string | null;
  authorAssociation: string | null;
  body: string | null;
  url: string | null;
}

interface ThreadState {
  isResolved: boolean;
  commentsTruncated: boolean;
  comments: ThreadComment[];
}

/**
 * Read a single thread's live state straight from its GraphQL node id — no
 * `pullRequest(number:...)` traversal needed, so this needs no PR number at
 * all. Deliberately re-fetched here rather than trusting a caller-supplied
 * snapshot (e.g. from `list-unresolved-threads.ts`, run some turns ago): the
 * whole point of the reconciliation check below is to answer "what does
 * GitHub say RIGHT NOW", and a stale snapshot could not tell a fresh
 * qualifying reply from one posted moments ago.
 */
async function fetchThread(
  threadId: string,
  timeoutSec: number,
): Promise<ThreadState | null> {
  const r = await ghCall(
    [
      "api",
      "graphql",
      "-f",
      `query=
query($id:ID!){
  node(id:$id){
    ... on PullRequestReviewThread{
      isResolved
      comments(first:100){ pageInfo{ hasNextPage } nodes{ url author{ login __typename } authorAssociation body } }
    }
  }
}`,
      "-f",
      `id=${threadId}`,
    ],
    { timeoutSec, stderr: "inherit" },
  );
  if (r.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const node = (parsed as { data?: { node?: unknown } })?.data?.node;
  if (typeof node !== "object" || node === null) return null;
  const n = node as { isResolved?: unknown; comments?: unknown };
  if (typeof n.isResolved !== "boolean") return null;
  const c = n.comments as
    | { pageInfo?: { hasNextPage?: unknown }; nodes?: unknown }
    | undefined;
  if (typeof c !== "object" || c === null || !Array.isArray(c.nodes))
    return null;
  return {
    isResolved: n.isResolved,
    // Fail CLOSED, not open, same as list-unresolved-threads.ts's own
    // `commentsTruncated` field: only an explicit `false` clears it.
    commentsTruncated: c.pageInfo?.hasNextPage !== false,
    comments: c.nodes.map((raw) => {
      const e = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
        string,
        unknown
      >;
      const author = e.author as { login?: unknown } | undefined;
      return {
        author: typeof author?.login === "string" ? author.login : null,
        authorAssociation:
          typeof e.authorAssociation === "string" ? e.authorAssociation : null,
        body: typeof e.body === "string" ? e.body : null,
        // An empty string is treated the same as a missing url — `hold
        // --kind thread` refuses one either way, matching
        // reconcile-replied-threads.ts's own `commentUrl === null ||
        // commentUrl === ''` check on the identical field.
        url: typeof e.url === "string" && e.url !== "" ? e.url : null,
      };
    }),
  };
}

/**
 * Post-resolve cleanup: release a STALE `accepted`/`moot` hold for
 * `threadId`, mirroring `reconcile-replied-threads.ts`'s own logic exactly
 * — see that script's header for why this is scoped to a hold whose
 * `commentUrl` is one of
 * `seenUrls` (a hold this pass's OWN read of the thread accounted for)
 * rather than deleted unconditionally by key.
 *
 * Never fails the THREAD's own disposition: it resolved successfully regardless
 * of whether this cleanup runs. But a failure here is not swallowed either —
 * returns `false`, reported loudly on stderr, and the CALLER propagates that
 * into a nonzero process exit: nothing else ever revisits a RESOLVED thread
 * to retry a stranded stale hold, since `list-unresolved-threads.ts` stops
 * enumerating it the moment it resolves. A nonzero exit is the one signal a
 * caller — an agent processing a batch, or a future automated sweep — cannot
 * silently miss the way an easily-lost stderr line can be. `true` covers BOTH
 * "nothing to clean up" and "cleaned up successfully" — only a genuine failure
 * to read or write state returns `false`.
 */
async function releaseStaleHold(
  pr: string,
  threadId: string,
  seenUrls: ReadonlySet<string>,
): Promise<boolean> {
  const heldNow = await run(tsArgv(driveState, ["held", pr]), {
    stderr: "inherit",
  });
  if (heldNow.code !== 0) {
    console.error(
      `triage-thread.ts: could not read held state for #${pr} to check for a stale hold on thread ${threadId} — if one exists, it is now STRANDED (nothing else revisits a resolved thread). Run 'drive-state.ts held ${pr}' and 'release-held' by hand.`,
    );
    return false;
  }
  let staleCommentUrl: string | null = null;
  try {
    const held = JSON.parse(heldNow.stdout) as Array<{
      key?: unknown;
      commentUrl?: unknown;
    }>;
    const entry = held.find((h) => h.key === threadId);
    if (
      entry &&
      typeof entry.commentUrl === "string" &&
      seenUrls.has(entry.commentUrl)
    ) {
      staleCommentUrl = entry.commentUrl;
    }
  } catch {
    console.error(
      `triage-thread.ts: held state for #${pr} is not readable JSON — a stale hold on thread ${threadId}, if any, is now STRANDED. Run 'drive-state.ts held ${pr}' and 'release-held' by hand.`,
    );
    return false;
  }
  if (staleCommentUrl === null) return true;
  const cleanup = await run(
    tsArgv(driveState, [
      "release-held",
      pr,
      "--key",
      threadId,
      "--if-present",
      "--if-comment-url",
      staleCommentUrl,
    ]),
    { stdout: "ignore", stderr: "inherit" },
  );
  if (cleanup.code !== 0) {
    console.error(
      `triage-thread.ts: release-held failed for thread ${threadId} on #${pr} — the stale hold is now STRANDED. Run 'drive-state.ts release-held ${pr} --key ${threadId} --if-present' by hand.`,
    );
    return false;
  }
  return true;
}

/**
 * `resolvePr` + `releaseStaleHold`, wrapped once so the call sites that
 * need this exact sequence — the `isResolved` early return and the merit
 * dispatch below — can't drift on the "could not resolve a PR, cleanup
 * skipped" message or the failure-propagation contract.
 *
 * PR resolution failing here now propagates (`false`), same as a
 * `releaseStaleHold` failure once a PR IS known: `resolvePr('')` conflates two
 * different facts behind one empty string — "this thread's context genuinely
 * has no associated PR" and "the branch has a PR but `gh pr view` failed
 * transiently" — and this function has no way to tell them apart. Treating the
 * empty result as "nothing to strand" assumed the first case; the second case
 * has a PR-keyed held state that this call is silently failing to check, and an
 * external command that failed must not be read as "found nothing". Since the
 * ambiguity cannot be resolved from here, the safe assumption is the one where
 * a stranded hold is possible: propagate failure. The thread's own
 * reply/resolve still happens regardless (see both call sites) — this only
 * affects whether the PROCESS reports success, so a caller that truly has no PR
 * context still gets its primary disposition done, just with a nonzero exit
 * flagging "the stale-hold check could not be confirmed, look by hand".
 */
async function attemptStaleHoldCleanup(
  pr: string,
  threadId: string,
  seenUrls: ReadonlySet<string>,
): Promise<boolean> {
  const prForCleanup = await resolvePr(pr);
  if (prForCleanup === "") {
    console.error(
      `triage-thread.ts: could not resolve a PR number to check thread ${threadId} for a stale hold — if one exists, it is now STRANDED. Name one explicitly next time, or run 'drive-state.ts held <PR>' and 'release-held' by hand.`,
    );
    return false;
  }
  return releaseStaleHold(prForCleanup, threadId, seenUrls);
}

async function main(): Promise<number> {
  // Bound every network call — mode 13 in drive-pr/references/terminal-states.md.
  const helper = readTimeoutEnv("DRIVE_PR_HELPER_TIMEOUT", 120);
  if (!helper.ok) {
    fail(
      2,
      `triage-thread.ts: $DRIVE_PR_HELPER_TIMEOUT must be a positive whole number of seconds (got '${helper.raw}').`,
    );
  }
  const helperTimeoutSec = helper.seconds;

  let mootPendingPush = false;
  let leaveOpen = false;
  let cleanupOnly = false;
  const positional: string[] = [];
  for (const a of process.argv.slice(2)) {
    if (a === "--moot-pending-push") mootPendingPush = true;
    else if (a === "--leave-open") leaveOpen = true;
    else if (a === "--cleanup-only") cleanupOnly = true;
    else if (a.startsWith("--"))
      fail(2, `triage-thread.ts: unknown flag: ${a}`);
    else positional.push(a);
  }
  const threadId = positional[0] ?? "";
  let pr = positional[1] ?? "";
  if (threadId === "") {
    fail(
      2,
      "usage: triage-thread.ts <thread-node-id> [PR] [--moot-pending-push] [--leave-open] [--cleanup-only] <<'EOF' ... EOF",
    );
  }
  if (positional.length > 2) {
    fail(
      2,
      "usage: triage-thread.ts <thread-node-id> [PR] [--moot-pending-push] [--leave-open] [--cleanup-only] <<'EOF' ... EOF",
    );
  }
  if (pr !== "" && !isDigits(pr)) {
    fail(2, `triage-thread.ts: PR must be a number (got '${pr}')`);
  }
  if (cleanupOnly && (mootPendingPush || leaveOpen)) {
    fail(
      2,
      "triage-thread.ts: --cleanup-only is exclusive — it posts and resolves nothing, so --moot-pending-push and --leave-open (which govern how a reply is posted) do not apply.",
    );
  }

  // --cleanup-only reads no stdin and posts nothing, so the outcome grammar
  // this block enforces for every other invocation simply does not apply.
  // Both stay `null` in that mode; narrowed back to non-null right after the
  // `cleanupOnly` dispatch below returns, since everything past that point
  // only runs once `cleanupOnly` is known false.
  let body: string | null = null;
  let intendedOutcome: Outcome | null = null;
  if (!cleanupOnly) {
    body = await readStdinAll();
    if (body === "") {
      fail(
        2,
        "usage: triage-thread.ts <thread-node-id> [PR] <<'EOF' ... EOF (stdin body was empty)",
      );
    }
    const own = qualifyingOutcome(body);
    if (own === null) {
      fail(2, OUTCOME_HELP);
    }
    intendedOutcome = own.outcome;
  }

  const thread = await fetchThread(threadId, helperTimeoutSec);
  if (thread === null) {
    fail(
      1,
      cleanupOnly
        ? `triage-thread.ts: could not read thread ${threadId}'s current state — refusing to guess at a stale hold without it.`
        : `triage-thread.ts: could not read thread ${threadId}'s current state — refusing to post without confirming no qualifying reply already exists.`,
    );
  }

  // `commentsTruncated` refuses the reconciliation scan outright — SKILL.md §
  // 3's own rule: a reply past the 100-comment cap could supersede what is
  // visible. `isResolved` is a top-level thread field, unaffected by the
  // comment-window cap, so it is still trustworthy under truncation — but
  // whether a stale hold is safe to release (below) is NOT, since that depends
  // on reading the LAST qualifying reply, which truncation makes unreliable. So
  // a truncated-and-resolved thread SKIPS the cleanup rather than guessing at
  // it from a partial view — but does not report success over that skip either
  // (`return 1`, not `0`): a merit dispatch interrupted between resolving the
  // thread and releasing its prior hold, retried once the thread has passed the
  // truncation cap, would otherwise exit 0 having never even checked whether
  // that hold remains — and a resolved thread is never re-enumerated, so the
  // stale hold would be permanently stranded with no other path back to this
  // script. `--cleanup-only` needs the identical caution regardless of
  // `isResolved` — it has no OTHER outcome to fall back on posting/resolving,
  // so a truncated thread always refuses (exit 1) rather than guessing.
  if (thread.commentsTruncated) {
    if (cleanupOnly || thread.isResolved) {
      console.error(
        `triage-thread.ts: thread ${threadId} is already resolved, but commentsTruncated — cannot confirm whether a stale hold on this key needs releasing without guessing from a partial view. Run 'drive-state.ts held <PR>' and 'release-held' by hand if one exists.`,
      );
      return 1;
    }
    fail(
      3,
      `triage-thread.ts: thread ${threadId} has more than 100 comments (commentsTruncated).`,
      "Per /resolve-review-comments § 2 and SKILL.md § 3, a reply past the cap could",
      "supersede what is visible, so this is never handled automatically. Park it",
      "under the class the cap protects, with its decision record on stdin (SKILL.md § 4):",
      `  drive-state.ts park [PR] --key ${threadId} --kind thread --class human-thread < record.md`,
    );
  }

  // The SAME predicate reconcile-replied-threads.ts uses for its own
  // standalone sweep (lib/outcome.ts#qualifyingOutcome + this trusted set) —
  // one implementation, so the inline check here and that sweep can never
  // disagree about what counts as a qualifying reply. Needed
  // by BOTH the isResolved stale-hold decision below and the ordinary
  // reconciliation path. A plain imported constant rather than a
  // subprocess call, so there is no failure mode here to refuse on.

  let existingOutcome: Outcome | null = null;
  let existingUrl: string | null = null;
  let existingAuthor: string | null = null;
  let existingBody: string | null = null;
  for (let i = thread.comments.length - 1; i >= 0; i--) {
    const c = thread.comments[i];
    if (
      c === undefined ||
      c.authorAssociation === null ||
      !TRUSTED_ASSOCIATIONS.has(c.authorAssociation)
    )
      continue;
    const q = qualifyingOutcome(c.body ?? "");
    if (q === null) continue;
    existingOutcome = q.outcome;
    existingUrl = c.url;
    existingAuthor = c.author;
    existingBody = c.body ?? "";
    break;
  }

  // --cleanup-only: for the documented direct-post-supersession fallback ("stop
  // after reply-to-thread.ts and never invoke this script's resolve step" — the
  // answer for a human thread meant to stay open). That fallback means this
  // script's own reconciliation branches below — the only callers of
  // `attemptStaleHoldCleanup` — never run, so a stale accepted/moot hold this
  // direct post superseded is stranded with no path back (the
  // reconciling-refusal variant of the identical gap is closed separately). No
  // stdin, no outcome grammar, no post, no resolve.
  //
  // Runs REGARDLESS of `thread.isResolved` — the fallback this exists for
  // leaves the thread OPEN by design, so gating only on the resolved branch
  // below would miss the common case entirely. Gated on the identical
  // CONFIRMED-merit-supersession check the resolved branch uses: a first cut of
  // this flag instead vouched for every comment URL unconditionally, so calling
  // it on a thread whose ONLY reply is the original accepted/moot post (nothing
  // has superseded it — no reachable, concrete case, just an operator running
  // it too early or on the wrong thread) matched that reply's own URL and
  // deleted a live, unconfirmed hold. Only a CONFIRMED supersession vouches for
  // the thread's comment URLs; otherwise `seenUrls` stays empty, so
  // `releaseStaleHold` can only ever find nothing to release — never mistake an
  // active hold for a stale one.
  if (cleanupOnly) {
    const confirmedMerit = confirmedMeritSupersession(
      thread.comments[0],
      existingOutcome,
      existingBody,
    );
    if (!confirmedMerit) {
      console.error(
        `triage-thread.ts: thread ${threadId} has no confirmed merit supersession (last qualifying reply: ${existingOutcome ?? "none"}) — nothing released; a hold on this key, if any, is still a live, unconfirmed obligation.`,
      );
    }
    const seenUrls = confirmedMerit
      ? new Set(
          thread.comments
            .map((c) => c.url)
            .filter((u): u is string => u !== null),
        )
      : new Set<string>();
    const cleanedUp = await attemptStaleHoldCleanup(pr, threadId, seenUrls);
    return cleanedUp ? 0 : 1;
  }

  // `cleanupOnly` is always false past this point (its own branch above
  // always returns), so `body`/`intendedOutcome` were always assigned —
  // narrows both from `T | null` back to `T` for everything below, which
  // reads them as their non-null type throughout.
  if (body === null || intendedOutcome === null) {
    fail(
      1,
      "triage-thread.ts: internal error — missing body/outcome after argument parsing.",
    );
  }

  if (thread.isResolved) {
    // Already closed out — by a concurrent driver, a human, or an earlier
    // dispatch of this same key. `isResolved` alone is NOT evidence of why:
    // GitHub's own UI lets anyone resolve a thread directly, with no
    // relationship to whether a promised accepted/moot fix ever passed gates
    // or got pushed. Blindly releasing a stale hold on any isResolved sighting
    // could delete the ONLY durable
    // record of a genuinely unverified obligation — the drive would then
    // believe it converged over a fix that was never confirmed.
    //
    // Cleanup is therefore gated on a CONFIRMED merit supersession: the last
    // qualifying trusted reply (scanned above) is itself an unambiguous merit
    // outcome (`rejected`/`wont-fix`/`deferred`) — a trusted author
    // deliberately overriding an earlier accepted/moot verdict, exactly the
    // scenario `releaseStaleHold` exists for. A plain `moot` with NO marker
    // is EXCLUDED here too, for the identical fail-safe reasoning
    // `isHoldOutcome`'s own default already applies to reconciliation: absent
    // positive proof, this script cannot tell a genuine merit-moot from a
    // moot that was itself meant to be held, so treating it as confirmed
    // merit here would risk the same false convergence. `null` (no
    // qualifying reply at all, e.g. resolved by a bare click with no reply)
    // and `accepted` are excluded for the same reason — neither is evidence
    // of a merit supersession.
    //
    // A moot `mootHeld` never holds IS included: a MARKED one (the marker is
    // only appended to a genuinely non-hold post) or a code-scanning one
    // (resolved only over a settled alert). Reachable sequence: an accepted
    // reply creates a hold, such a moot supersedes it, the thread resolves
    // before this script's own cleanup runs, and a retry lands here —
    // excluding the moot would strand that stale accepted hold, since a
    // resolved thread is never re-enumerated.
    const confirmedMerit = confirmedMeritSupersession(
      thread.comments[0],
      existingOutcome,
      existingBody,
    );
    console.error(
      `triage-thread.ts: thread ${threadId} is already resolved — nothing to do.`,
    );
    if (confirmedMerit) {
      const seenUrls = new Set(
        thread.comments
          .map((c) => c.url)
          .filter((u): u is string => u !== null),
      );
      const cleanedUp = await attemptStaleHoldCleanup(pr, threadId, seenUrls);
      // A stranded hold on a now-resolved thread has no other path back to
      // this script — propagate the failure rather than reporting success.
      if (!cleanedUp) return 1;
    } else {
      console.error(
        `triage-thread.ts: no confirmed merit supersession found (last qualifying reply: ${existingOutcome ?? "none"}) — a stale hold on this key, if any, is left untouched for the normal verified-push release path.`,
      );
    }
    return 0;
  }

  // Whether `moot` is treated as fix-dependent — resolved ONCE, here, and
  // reused by both call sites below so the same call never disagrees with
  // itself about it. It is NOT simply
  // `mootPendingPush`: that flag names only THIS invocation's own belief,
  // but a moot RECONCILED from an existing reply may have been posted by an
  // earlier, now-gone invocation whose own flag this one cannot see — the
  // outcome token carries no such bit, and the header already establishes
  // that a retrying agent has no memory of what an interrupted attempt
  // decided. A crash between a `--moot-pending-push` post and its `hold`
  // must not let a flagless retry treat that same reply as ordinary moot and
  // resolve it prematurely: resolving a thread whose fix is not actually in
  // yet is the unrecoverable failure (the GitHub thread is closed), where
  // holding a moot that never needed it is merely recoverable (the next
  // push's `resolve-held-thread.ts` releases it same as any other hold, or a
  // live pass upgrades/resolves it directly once it reads the tree). So
  // reconciling a `moot` reply DEFAULTS to fix-dependent; only a FRESH
  // post — this invocation's own live, authoritative decision — is governed
  // by the flag it was actually given.
  //
  // EXCEPT when the existing reply carries LEAVE_OPEN_MARKER, which is only
  // ever added when the post-time outcome was genuinely non-hold (`postBody`'s
  // own comment): positive proof of a plain, left-open moot. Without it, every
  // retry on a `**moot** --leave-open` reply would force an `--unconfirmed`
  // hold at round -1 that nothing ever advances. "Assume held" stays the
  // default for every OTHER reconciled moot, where it is the safe guess — and
  // a code-scanning moot is never held: its alert is its proof (`mootHeld`).
  const treatMootAsHold = mootHeld(
    thread.comments[0],
    mootPendingPush,
    existingOutcome,
    existingBody,
  );

  // What this call will end up dispatching, KNOWABLE before any posting
  // happens: reconciliation (existingOutcome found) never posts, and a fresh
  // post — if one happens — posts exactly `intendedOutcome`. Resolving the PR
  // requirement now, before the post branch below, is what stops an
  // accepted/moot reply from landing irreversibly on GitHub only to then
  // discover there is no PR to hold it against.
  const prospectiveOutcome = existingOutcome ?? intendedOutcome;
  if (isHoldOutcome(prospectiveOutcome, treatMootAsHold)) {
    pr = await resolvePr(pr);
    if (pr === "") {
      fail(
        1,
        `triage-thread.ts: could not resolve a PR number, needed to hold a '${prospectiveOutcome}' outcome ('drive-state.ts hold [PR] ...'). Name one explicitly: triage-thread.ts <thread-id> <PR>`,
      );
    }
  }

  let effectiveOutcome: Outcome;
  let commentUrl: string;
  let sourcedFromReconciliation: boolean;

  if (existingOutcome !== null) {
    // The reconciliation rule (see the header): a qualifying reply, from
    // WHOEVER posted it and WHATEVER outcome it carries, is the answer —
    // never posted over, regardless of what this invocation's own body says.
    console.error(
      `triage-thread.ts: thread ${threadId} already carries a qualifying '${existingOutcome}' reply from ${existingAuthor ?? "an unknown author"}${existingUrl !== null ? ` (${existingUrl})` : ""} — not posting; completing the durable record for that outcome.`,
    );
    if (existingOutcome !== intendedOutcome) {
      console.error(
        `triage-thread.ts: note — this invocation's own body intended '${intendedOutcome}'; the existing reply's outcome wins per SKILL.md § 3.`,
      );
    }
    effectiveOutcome = existingOutcome;
    sourcedFromReconciliation = true;
    if (isHoldOutcome(effectiveOutcome, treatMootAsHold)) {
      // A permalink is required only to CREATE a hold (`drive-state.ts hold
      // --comment-url`) — the merit dispatch below (`resolve-thread.ts`) needs
      // nothing but the threadId, so an unreadable url must refuse ONLY the
      // hold path, not every reconciled outcome uniformly (an earlier,
      // unconditional check left a trusted merit reply with an unreadable url
      // permanently unresolved, against `reconcile-replied-threads.ts`'s own
      // precedent of checking `commentUrl` only in its hold branch).
      if (existingUrl === null) {
        fail(
          1,
          `triage-thread.ts: thread ${threadId} already carries a qualifying '${existingOutcome}' reply from ${existingAuthor ?? "an unknown author"}, but its url could not be read.`,
          "A --comment-url-less hold can't be recorded, and posting another reply",
          "would put a second outcome token on one triage decision — reconcile by",
          "hand instead.",
        );
      }
      commentUrl = existingUrl;
    } else {
      // Unused by the merit dispatch below (resolve-thread.ts takes no url),
      // so a missing one is harmless here — never read except to seed
      // seenUrls, where an empty string simply never matches a real one.
      commentUrl = existingUrl ?? "";
    }
  } else {
    // LAST local act before the irreversible one. reply-to-thread.ts owns the
    // grammar re-check, the drive-lease fence, and the actual
    // mutation — nothing here duplicates any of that.
    //
    // The scan above and this post are a non-atomic read-then-write — GitHub
    // exposes no conditional-write primitive on a review-thread comment, and a
    // local mutex spanning the outbound call would prove nothing about the
    // moment GitHub actually accepts it (lib/state/lease.ts's own "THE CHECK
    // AND THE POST ARE TWO MOMENTS" residual makes the identical argument for
    // the drive-lease fence). Accepted as a residual, not fixed here: the
    // posting fence already refuses every cross-session and cross-worktree case
    // before the POST, and the remaining same-process case needs two concurrent
    // triage calls on ONE threadId, which SKILL.md § 6's one-item-at-a-time
    // loop never issues. This scan STRICTLY NARROWS the pre-existing
    // duplicate-outcome-token window rather than widening it — the two-command
    // flow it replaces posted with no live-state check at all, so the
    // crash-retry duplicate (the measured failure mode) is exactly what the
    // scan above closes. `--leave-open` gets its marker appended here, not
    // composed by the caller — LEAVE_OPEN_MARKER's own header explains why a
    // durable record of this choice is needed at all. Gated on the outcome
    // actually being non-hold (merit): `--leave-open` already "has no effect"
    // on a HELD outcome (line 788 below only consults it inside the non-hold
    // branch), but marking the reply anyway let the marker survive onto a held
    // moot-pending-push reply too — and reconcile-replied-threads.ts's own
    // standalone sweep has no `--moot-pending-push` equivalent, so it cannot
    // tell a HELD moot from a plain one from the outcome word alone. Scoping
    // injection to the case the marker actually MEANS something for makes
    // "carries the marker" imply "was a merit reply left open" unconditionally
    // — which is what lets that sweep trust the marker for `moot` too, not only
    // for the three outcomes it already classifies as merit.
    //
    // A caller-composed body ending in the marker's own exact trailing-line
    // form (e.g. prose that quotes or discusses this mechanism, plausible on
    // exactly this PR) is otherwise posted unchanged — indistinguishable on the
    // next read from a genuine `--leave-open` post, since `hasLeaveOpenMarker`
    // cannot see who produced the line. Refuse rather than post ambiguous
    // content: only THIS branch's own append may legitimately put the marker on
    // a reply.
    //
    // Gated on HOLD outcomes too, not just merit ones — `--leave-open` "has no
    // effect" on accepted/held-moot, but that only describes what THIS script
    // does with it; a marker-bearing body still reaches GitHub, and
    // `reconcile-replied-threads.ts`'s standalone sweep trusts the marker as
    // proof of a merit left-open reply independent of what outcome word
    // accompanies it. A held moot whose caller-supplied body happened to end in
    // the marker would be misread by that sweep as deliberately left open,
    // releasing its own not-yet-verified hold before the promised push ever
    // landed — THIS script never consults the marker for hold outcomes, but
    // that is not the whole system. The one exemption: a caller who explicitly
    // passed `--leave-open` on a genuinely non-hold outcome already gets the
    // marker appended below anyway, so refusing their own pre-supplied copy of
    // it would serve no one.
    const sanctionedSelfMarked =
      leaveOpen && !isHoldOutcome(intendedOutcome, treatMootAsHold);
    if (hasLeaveOpenMarker(body) && !sanctionedSelfMarked) {
      fail(
        2,
        `triage-thread.ts: the reply body's own trailing line already matches LEAVE_OPEN_MARKER ('${LEAVE_OPEN_MARKER}') — posting it unchanged would be indistinguishable from a deliberate leave-open and could be misread by reconcile-replied-threads.ts's standalone sweep regardless of this call's own outcome. Remove that trailing line from the body, or pass --leave-open on a genuinely non-hold outcome if that is what you intend.`,
      );
    }
    const postBody =
      leaveOpen &&
      !isHoldOutcome(intendedOutcome, treatMootAsHold) &&
      !hasLeaveOpenMarker(body)
        ? `${body}\n\n${LEAVE_OPEN_MARKER}`
        : body;
    const posted = await run(tsArgv(replyToThread, [threadId]), {
      stdin: postBody,
      timeoutSec: helperTimeoutSec,
      stderr: "inherit",
      // This is triage-thread.ts's own single reply-to-thread.ts call site —
      // every guard governing whether postBody may legitimately carry
      // LEAVE_OPEN_MARKER already ran above (the `!leaveOpen` refusal, the
      // doubling-avoidance check), so this call is always the sanctioned
      // producer regardless of whether postBody ends in the marker this time.
      // Set unconditionally rather than only when the marker was actually
      // appended: a caller-composed body that already ends in the marker under
      // `--leave-open` is equally sanctioned.
      env: { ...process.env, [LEAVE_OPEN_MARKER_PRODUCER_ENV]: "1" },
    });
    if (posted.code !== 0) return posted.code;
    const postedUrl = posted.stdout.trim();
    if (postedUrl === "") {
      fail(
        1,
        "triage-thread.ts: reply-to-thread.ts exited 0 but printed no comment url — refusing to hold/resolve on an unknown reply.",
      );
    }
    effectiveOutcome = intendedOutcome;
    commentUrl = postedUrl;
    sourcedFromReconciliation = false;
  }

  // On RECONCILIATION, a MISSING `--leave-open` is not evidence of anything —
  // a retrying agent has no reason to have set it, since it has no memory of
  // an earlier interrupted (or simply prior-round) invocation's choice — so
  // the marker recovers that case, per LEAVE_OPEN_MARKER's own header.
  const effectiveLeaveOpen =
    leaveOpen ||
    (sourcedFromReconciliation && hasLeaveOpenMarker(existingBody ?? ""));

  // But a PRESENT `--leave-open` on a RECONCILING call whose existing reply
  // carries NO marker cannot be made durable at all: this call posts nothing
  // (the whole point of reconciliation), so there is no comment to append a
  // marker to, and the existing one was written by whatever posted it directly
  // — an OR-combine that honors the flag anyway skips the resolve THIS
  // invocation, but the choice evaporates the moment this process exits: the
  // next `triage-thread.ts` retry, or `reconcile-replied-threads.ts`'s
  // standalone sweep, sees an unmarked merit reply and resolves it anyway —
  // reversing a choice that read as honored. Fail closed instead of silently
  // proceeding on an unpersistable promise: the documented alternative for a
  // directly-posted reply meant to stay open is the one the old two-command
  // flow always had — stop after `reply-to-thread.ts`'s own post and never
  // invoke this script's resolve step at all.
  if (
    sourcedFromReconciliation &&
    leaveOpen &&
    !hasLeaveOpenMarker(existingBody ?? "") &&
    !isHoldOutcome(effectiveOutcome, treatMootAsHold)
  ) {
    // Still runs the stale-hold cleanup before refusing — this refusal means
    // "the thread's own disposition cannot be made durable," never "skip the
    // cleanup too." Those are orthogonal per the identical invariant the merit
    // branch below states explicitly; this branch used to exit via `fail()`
    // before reaching it, silently stranding a hold on the SAME key this reply
    // just superseded.
    const seenUrls = new Set(
      thread.comments.map((c) => c.url).filter((u): u is string => u !== null),
    );
    if (existingUrl !== null) seenUrls.add(existingUrl);
    const cleanedUp = await attemptStaleHoldCleanup(pr, threadId, seenUrls);
    fail(
      1,
      `triage-thread.ts: --leave-open on thread ${threadId} cannot be made durable here — this call is RECONCILING an existing reply that carries no LEAVE_OPEN_MARKER, and reconciliation posts nothing, so there is no comment to persist the choice onto.`,
      "A later retry or reconcile-replied-threads.ts sweep would see an unmarked merit",
      "reply and resolve it anyway, reversing a choice that looked honored. For a",
      "directly-posted reply you want left open, stop after reply-to-thread.ts and never",
      "invoke this script to resolve it — the same choice the old two-command flow always",
      "had.",
      cleanedUp
        ? "(stale-hold cleanup on this key ran and found nothing stranded.)"
        : "(stale-hold cleanup on this key could not be confirmed — see the line above.)",
    );
  }

  if (!isHoldOutcome(effectiveOutcome, treatMootAsHold)) {
    let exit = 0;
    if (effectiveLeaveOpen) {
      // SKILL.md's "Leaving a human thread open": a human thread you replied to
      // but chose not to close on the author's behalf is a deliberate open
      // state, not a leak — the old two-command flow let a caller stop after
      // reply-to-thread.ts and never call resolve-thread.ts at all to honor it.
      // This is that same choice point, explicit rather than implicit (an
      // omitted call an atomic command has no equivalent of). Still runs the
      // stale-hold cleanup below — leaving a thread open is orthogonal to
      // whether an EARLIER hold on this same key is now stale.
      console.error(
        sourcedFromReconciliation
          ? `triage-thread.ts: thread ${threadId} carries a prior --leave-open marker — not resolving, recovered from the existing reply rather than this invocation's own flag.`
          : `triage-thread.ts: --leave-open — thread ${threadId} replied but not resolved.`,
      );
    } else {
      // A code-scanning thread stays open over an unsettled alert (exit 4).
      const resolved = await resolveDeclinedThread(
        threadId,
        thread.comments[0],
        helperTimeoutSec,
        effectiveOutcome,
      );
      if (resolved.code !== 0) return resolved.code;
      exit = resolved.exit;
    }
    // A merit reply can be a deliberate supersession of an earlier
    // accepted/moot hold on this same key, and resolve-thread.ts has no
    // notion of `held` at all — see releaseStaleHold's own header for why a
    // failure here is reported through the exit code, not just stderr.
    const seenUrls = new Set(
      thread.comments.map((c) => c.url).filter((u): u is string => u !== null),
    );
    // This call's own reply postdates `thread.comments`; count it as seen.
    seenUrls.add(commentUrl);
    const cleanedUp = await attemptStaleHoldCleanup(pr, threadId, seenUrls);
    // Same reasoning as the isResolved branch above: a stranded hold on a now-
    // resolved thread has no other path back to this script.
    return cleanedUp ? exit : 1;
  }

  // `pr` was already resolved above (before any posting), guarded by the same
  // `isHoldOutcome(prospectiveOutcome)` predicate this branch is reached
  // under — `effectiveOutcome` can only be a hold outcome here if
  // `prospectiveOutcome` was too (they're equal on both paths: reconciliation
  // sets `effectiveOutcome = existingOutcome = prospectiveOutcome` directly;
  // a fresh post sets it to `intendedOutcome`, which — the ONLY way this
  // branch reaches a hold outcome without `existingOutcome` — is exactly
  // `prospectiveOutcome` too).
  const holdArgs = [
    "hold",
    pr,
    "--key",
    threadId,
    "--kind",
    "thread",
    "--outcome",
    effectiveOutcome,
    "--comment-url",
    commentUrl,
  ];
  // A hold sourced from RECONCILIATION never had its promised fix confirmed
  // by THIS invocation (it only read GitHub's comment text, never the tree) —
  // the same situation reconcile-replied-threads.ts uses --unconfirmed for,
  // and for the same reason (see the header). A hold from a FRESH post is
  // this pass's own live triage decision for the current round, so it uses
  // the ordinary confirmed path, exactly as the two-command flow always did.
  if (sourcedFromReconciliation) holdArgs.push("--unconfirmed");
  // Undeadlined, matching reconcile-replied-threads.ts's and
  // resolve-held-thread.ts's own drive-state.ts calls: a local file-lock
  // mutation with its own stale-lock recovery, not a network call.
  const held = await run(tsArgv(driveState, holdArgs), {
    stdout: "inherit",
    stderr: "inherit",
  });
  return held.code;
}

runMain("triage-thread.ts", main);
