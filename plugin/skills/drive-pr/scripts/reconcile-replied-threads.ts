#!/usr/bin/env bun
/**
 * Reconcile review threads that already carry a trusted outcome-token reply but
 * are still unresolved on GitHub — the standalone-sweep counterpart to
 * `triage-thread.ts`'s own inline self-reconciliation (SKILL.md § 3),
 * extracted so it can run WITHOUT ever passing drive-status.ts's round-readiness
 * gate (step 1), and without a live pass to invoke it at all — a PR nobody is
 * currently driving, or a `triage-thread.ts` interrupted before its own
 * self-reconciliation could run on a LATER round, both leave a thread in
 * exactly this state.
 *
 * That gate exists to answer "is there a NEW round of reviewer work", which is
 * a different question from "does an EXISTING reply already answer this
 * thread". Coupling the second question to the first is what let a reply
 * survive unresolved indefinitely on one measured PR: the PR was CONFLICTING,
 * GitHub runs zero `pull_request` CI on a CONFLICTING PR, the posting
 * reviewer's check-run therefore never appeared, drive-status.ts sat in
 * AWAITING_REVIEWER forever, and `drive.ts` never invoked a pass to run this
 * reconciliation at all — not because the reconciliation itself needed anything
 * the PR didn't have, but because it was only ever reachable through a gate
 * that was answering an unrelated question. This script answers the
 * reconciliation question directly, from GitHub's own state, independent of
 * whatever `drive-status.ts` would currently say.
 *
 * Usage: reconcile-replied-threads.ts [PR...] [--all-open] [--dry-run]
 *                                     [--bots-only]
 *
 *   PR...       one or more PR numbers. Defaults to the current branch's PR.
 *   --all-open  sweep every OPEN pull request in this repository instead of
 *               naming one — the operational answer to "these leaks shouldn't
 *               require a human noticing them in Conductor".
 *   --dry-run   report only; resolve and hold nothing.
 *   --bots-only restrict the sweep to bot-STARTED threads, forwarded verbatim
 *               to the `list-unresolved-threads.ts` enumeration below.
 *
 *               Not a performance knob — it is the social boundary
 *               `/jig:resolve-review-comments` § Human threads draws, and this script
 *               resolves threads unattended, which is exactly the act that
 *               boundary governs: "a **human** thread you replied to but
 *               chose not to close on the author's behalf" is a DELIBERATE
 *               open state, and "that exception is why continuous mode
 *               targets bot threads (`--bots-only`)". A human thread bearing
 *               a trusted `rejected`/`wont-fix`/`deferred` reply is precisely
 *               that state — the reply is the "replied to", the still-open
 *               thread is the "chose not to close" — so sweeping it closed
 *               would use the author's own triage as the warrant for
 *               overriding their decision not to act on it. `drive-status.ts`
 *               forwards its own `--bots-only` here for that reason, and a SCHEDULED
 *               `--all-open` sweep passes it for the same one: the rule is
 *               about running unattended, which a schedule is regardless of
 *               how wide its scope. Only an
 *               unscoped, human-attended one-shot keeps the wider scope.
 *
 * For each unresolved, non-truncated thread whose LAST QUALIFYING comment from
 * a trusted author opens with a bold outcome token — not necessarily the
 * literal last comment; a later trusted comment that doesn't open with the
 * grammar doesn't supersede an earlier qualifying one — (`lib/outcome.ts`'s
 * `qualifyingOutcome`, the ONE implementation of this predicate `triage-
 * thread.ts`'s own inline check shares — the two can never disagree about
 * what counts as a qualifying reply):
 *
 *   rejected / wont-fix / deferred  -> resolved now, except a code-scanning
 *                                      alert must first be confirmed dismissed.
 *                                      These are claims about the
 *                                      finding's MERIT, not fix-dependent — per
 *                                      SKILL.md § 3, "nothing else ever will
 *                                      resolve it" once replied. EXCEPT when the
 *                                      qualifying reply carries
 *                                      `lib/outcome.ts`'s `LEAVE_OPEN_MARKER`
 *                                      (`triage-thread.ts --leave-open`,
 *                                      usually a human thread deliberately left
 *                                      open, see resolve-review-comments
 *                                      § Human threads): skipped instead, action
 *                                      `left-open` — this sweep is the OTHER
 *                                      reader of that same durable choice, and
 *                                      resolving it here would reverse what the
 *                                      marker's own writer deliberately chose
 *                                      not to do.
 *   accepted / moot                 -> re-held via `drive-state.ts hold
 *                                      --unconfirmed --comment-url <url>`
 *                                      (insert-if-absent by (key, outcome,
 *                                      commentUrl) — never overwrites an
 *                                      existing hold that represents the SAME
 *                                      qualifying comment), so a real
 *                                      /drive-pr round's step 3 can find it,
 *                                      CONFIRM the promised fix is actually in
 *                                      the tree, and re-hold it for real. This
 *                                      script never resolves those itself, and
 *                                      — unlike a live pass's own step-3
 *                                      re-hold — must NOT grant round-currency
 *                                      either: it has no more ability than a
 *                                      fresh pass would to verify the promised
 *                                      fix landed. The round is PR-global and
 *                                      says nothing about which hold's fix a
 *                                      given push contains; the push stamp IS
 *                                      per-hold now, but a fresh
 *                                      unconfirmed entry carries none — so
 *                                      granting round-currency would still be
 *                                      vouching for a fix nothing here read.
 *                                      An unconditional upsert here let a
 *                                      stale, never-verified reply ride an
 *                                      UNRELATED later push to a false resolve;
 *                                      keying only on outcome, and then
 *                                      tolerating an absent commentUrl on the
 *                                      ordinary (live-pass-confirmed) path,
 *                                      still let a SUPERSEDING reply — same
 *                                      outcome word or not — inherit an earlier
 *                                      hold's round, confirmed or not. Both
 *                                      `hold` paths now require and record
 *                                      `--comment-url`, compared exactly, which
 *                                      closes it.
 *
 * A thread whose qualifying reply is PROVISIONAL (`lib/outcome.ts`'s
 * `isProvisionalReply`, posted by `provisional-reply.ts` under the `wide`
 * autonomy level) is skipped, action `provisional`: a person reverses it by
 * commenting, which the next round reads, and an unresolve alone is left as
 * the person left it.
 *
 * A truncated thread (over the 100-comment cap) is reported, never acted on —
 * per SKILL.md § 3, a reply past the cap could supersede what's visible, so a
 * qualifying comment found in the visible prefix is not trustworthy evidence
 * either.
 *
 * Emits one JSON line per thread inspected that carries a qualifying reply (or
 * is truncated) to stdout; a one-line human summary per PR to stderr.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, isDigits, runMain } from "./lib/cli.ts";
import {
  hasLeaveOpenMarker,
  isProvisionalReply,
  qualifyingOutcome as sharedQualifyingOutcome,
} from "./lib/outcome.ts";
import { ghCall, readTimeoutEnv, resolvePr, run, tsArgv } from "./lib/proc.ts";
import { sweepVerdict } from "./lib/scanner-sweep-guard.ts";
import { TRUSTED_ASSOCIATIONS } from "./summary-findings.ts";

const here = dirname(fileURLToPath(import.meta.url));
const driveState = join(here, "drive-state.ts");
const rrcScripts = join(here, "..", "..", "resolve-review-comments", "scripts");
const listUnresolvedThreads = join(rrcScripts, "list-unresolved-threads.ts");
const resolveThread = join(rrcScripts, "resolve-thread.ts");

/** The merit outcomes: replied AND resolved in the same step, never held. */
const MERIT_OUTCOMES = new Set(["rejected", "wont-fix", "deferred"]);

interface ThreadComment {
  author: string | null;
  authorAssociation: string | null;
  body: string | null;
  url: string | null;
}

interface Thread {
  threadId: string;
  path: string | null;
  codeScanning: unknown;
  commentsTruncated: boolean;
  comments: ThreadComment[];
}

/**
 * The outcome word this body qualifies as, '' otherwise.
 *
 * A thin adapter over `lib/outcome.ts`, which owns the grammar. This script
 * used to carry its own copy "per this skill's established convention of
 * self-contained scripts" — a convention `lib/cli.ts`, `lib/proc.ts` and
 * `lib/state/` had already superseded, and which `outcome.ts`'s own header
 * says so.
 *
 * The copies had ALREADY diverged, which is why this is not a tidiness edit: on
 * a body whose first line ends `\r` (a reply composed from a CRLF file), the
 * shared parser strips the terminator and returns `accepted` while the private
 * copy returned '' — `.` and `$` both stop at `\r`. So the same reply read as
 * answered by the metric samplers and as unanswered here, and this is the
 * script that decides whether to re-hold a thread. Divergence in this direction
 * means re-triaging a thread that already carries an outcome token, putting a
 * SECOND one on it and corrupting the reviewer-scoring sample the vocabulary
 * exists to feed.
 */
function qualifyingOutcome(body: string): string {
  return sharedQualifyingOutcome(body)?.outcome ?? "";
}

/**
 * A reply carrying `LEAVE_OPEN_MARKER` with an outcome the marker can mean
 * something for: a merit outcome, or `moot` (see the call site).
 */
function markedLeftOpen(body: string, outcome: string): boolean {
  return (
    hasLeaveOpenMarker(body) &&
    (MERIT_OUTCOMES.has(outcome) || outcome === "moot")
  );
}

/** Shape-check one NDJSON line from list-unresolved-threads.ts. */
function parseThread(line: string): Thread | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const t = v as Record<string, unknown>;
  if (typeof t.threadId !== "string" || t.threadId === "") return null;
  // A missing or non-array `comments` is NOT "zero comments" — that reading
  // would let a truncated/malformed NDJSON line silently pass as "no
  // qualifying reply on this thread" and fall through to ordinary triage,
  // the exact fail-open this record-level check exists to close. Reject the
  // whole record instead, same as an unparseable line.
  if (!Array.isArray(t.comments)) return null;
  const comments = t.comments;
  return {
    threadId: t.threadId,
    path: typeof t.path === "string" ? t.path : null,
    codeScanning: t.codeScanning,
    // Fail CLOSED, not open: a missing field, `null`, or a malformed string
    // must not read as "not truncated" — that would let the caller trust the
    // visible comments and resolve/hold a merit outcome from a record that
    // might have a later, superseding reply past the 100-comment cap it never
    // saw. Only an explicit `false` clears the truncation flag; anything else
    // — including an explicit `true` — takes the same needs-human path below.
    commentsTruncated: t.commentsTruncated !== false,
    comments: comments.map((c) => {
      const e = (typeof c === "object" && c !== null ? c : {}) as Record<
        string,
        unknown
      >;
      return {
        author: typeof e.author === "string" ? e.author : null,
        authorAssociation:
          typeof e.authorAssociation === "string" ? e.authorAssociation : null,
        body: typeof e.body === "string" ? e.body : null,
        url: typeof e.url === "string" ? e.url : null,
      };
    }),
  };
}

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/**
 * Release a STALE `accepted`/`moot` hold on `threadId`, whose `commentUrl` is
 * one of this thread's OWN comments (`seenUrls`) — mirroring `triage-
 * thread.ts`'s `releaseStaleHold` exactly, extracted here rather than a
 * second copy so both call sites — a genuine RESOLVE and the new
 * `left-open` skip — can't drift on the identity check or the
 * failure-propagation contract.
 *
 * Needed by `left-open` for the identical reason it was already needed by
 * `resolved`: a trusted author's merit reply can supersede an earlier
 * accepted/moot hold on the same key REGARDLESS of whether this invocation
 * goes on to resolve the thread or leave it open per `--leave-open` — leaving
 * a thread open is orthogonal to whether an EARLIER hold on this same key is
 * now stale (`triage-thread.ts`'s own `attemptStaleHoldCleanup` call site
 * makes the identical point). Skipping this for `left-open` left that stale
 * hold sitting in `held`, where step 6's `resolve-held-thread.ts` would later
 * resolve the very thread the marker deliberately left open — especially
 * reachable after a crash between `triage-thread.ts` posting the marked
 * reply and completing its own cleanup, followed by this standalone sweep.
 *
 * Returns `false` only on a genuine read/write failure — `true` covers both
 * "nothing to clean up" and "cleaned up successfully", same convention
 * `releaseStaleHold` uses.
 */
async function releaseStaleHoldIfSeen(
  pr: string,
  thread: Thread,
): Promise<boolean> {
  const seenUrls = new Set(
    thread.comments.map((c) => c.url).filter((u): u is string => u !== null),
  );
  const heldNow = await run(tsArgv(driveState, ["held", pr]), {
    stderr: "ignore",
  });
  let staleCommentUrl: string | null = null;
  if (heldNow.code !== 0) {
    console.error(
      `reconcile-replied-threads.ts: could not read held state for #${pr} thread ${thread.threadId} — stale hold (if any) may remain, continuing`,
    );
    return false;
  }
  try {
    const held = JSON.parse(heldNow.stdout) as Array<{
      key?: unknown;
      commentUrl?: unknown;
    }>;
    const entry = held.find((h) => h.key === thread.threadId);
    if (
      entry &&
      typeof entry.commentUrl === "string" &&
      seenUrls.has(entry.commentUrl)
    ) {
      staleCommentUrl = entry.commentUrl;
    }
  } catch {
    console.error(
      `reconcile-replied-threads.ts: held state for #${pr} is not readable JSON while cleaning up thread ${thread.threadId} — stale hold (if any) may remain, continuing`,
    );
    return false;
  }
  if (staleCommentUrl === null) return true;
  const cleanup = await run(
    tsArgv(driveState, [
      "release-held",
      pr,
      "--key",
      thread.threadId,
      "--if-present",
      "--if-comment-url",
      staleCommentUrl,
    ]),
    { stdout: "ignore", stderr: "pipe" },
  );
  if (cleanup.code !== 0) {
    console.error(
      `reconcile-replied-threads.ts: release-held --if-present failed for #${pr} thread ${thread.threadId} — stale hold (if any) may remain, continuing`,
    );
    return false;
  }
  return true;
}

async function main(): Promise<number> {
  // Bound every network call — mode 13 in references/terminal-states.md.
  // list-unresolved-threads.ts and resolve-thread.ts reach the network through
  // their OWN gh chokepoint, so each gets the same deadline wrapped around the
  // whole spawned invocation, mirroring drive-status.ts's helper calls and
  // resolve-held-thread.ts's own resolve-thread.ts call. Without it, a stalled
  // connection on any one PR hangs the whole --all-open sweep indefinitely.
  // `drive-state.ts` is deliberately NOT deadlined here: it is a local
  // file-lock mutation with its own stale-lock recovery, not a network call —
  // resolve-held-thread.ts's drive-state.ts calls go unwrapped for the same
  // reason.
  const helper = readTimeoutEnv("DRIVE_PR_HELPER_TIMEOUT", 120);
  if (!helper.ok) {
    return fail(
      2,
      `reconcile-replied-threads.ts: $DRIVE_PR_HELPER_TIMEOUT must be a positive whole number of seconds (got '${helper.raw}').`,
    );
  }
  const helperTimeoutSec = helper.seconds;

  let dryRun = false;
  let allOpen = false;
  let botsOnly = false;
  let prs: string[] = [];
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--all-open") allOpen = true;
    else if (a === "--bots-only") botsOnly = true;
    else if (a.startsWith("--"))
      return fail(2, `reconcile-replied-threads.ts: unknown flag: ${a}`);
    else prs.push(a);
  }

  if (allOpen && prs.length > 0) {
    return fail(
      2,
      "reconcile-replied-threads.ts: --all-open and explicit PR numbers are mutually exclusive",
    );
  }

  // A known-incomplete sweep (a truncated --all-open listing, a per-PR
  // enumeration failure) must not read as exit 0 — an --all-open sweep is meant
  // to run unattended (a scheduler, or a human re-running it by hand), and the
  // whole point of this script is closing the "requires a human to notice" gap.
  let hadErrors = 0;

  if (allOpen) {
    const listed = await ghCall(
      ["pr", "list", "--state", "open", "--limit", "1000", "--json", "number"],
      { stderr: "pipe" },
    );
    if (listed.code !== 0) {
      return fail(
        1,
        "reconcile-replied-threads.ts: could not list open PRs for --all-open",
      );
    }
    let numbers: unknown;
    try {
      numbers = JSON.parse(listed.stdout);
    } catch {
      numbers = undefined;
    }
    if (!Array.isArray(numbers)) {
      return fail(
        1,
        "reconcile-replied-threads.ts: could not read the --all-open listing as a JSON array — refusing to report a sweep of zero PRs",
      );
    }
    // Validate every member as an integer PR number rather than silently
    // dropping a malformed one (missing `number`, a string-valued number,
    // `null`, …) — a schema-drifted `gh pr list` response must not skip open
    // PRs while `hadErrors` stays zero, contradicting this sweep's own
    // fail-loud contract for incomplete coverage.
    prs = [];
    for (const n of numbers) {
      const num = (n as { number?: unknown })?.number;
      if (typeof num === "number" && Number.isInteger(num)) {
        prs.push(String(num));
      } else {
        console.error(
          "reconcile-replied-threads.ts: --all-open listing contained a malformed PR number entry — skipping it and exiting nonzero to flag the partial population",
        );
        hadErrors = 1;
      }
    }
    // `--limit 1000` still truncates a repo with more than 1000 OPEN PRs at
    // once — an exact count of 1000 is indistinguishable from "there were
    // more". Do NOT exit here: refusing to run at all would throw away real
    // reconciliation work for the (up to) 1000 PRs this call DID enumerate,
    // over a case this repo has never come close to. Instead mark the sweep
    // incomplete — `hadErrors` still makes the exit code nonzero, so an
    // unattended caller's own alerting sees a partial sweep instead of a silent
    // success — and still process every PR this call returned.
    if (prs.length === 1000) {
      console.error(
        "reconcile-replied-threads.ts: --all-open received exactly 1000 open PRs from the --limit-1000 listing, which may be truncated — sweeping those 1000 anyway and exiting nonzero to flag the partial population",
      );
      hadErrors = 1;
    }
  } else if (prs.length === 0) {
    const pr = await resolvePr("");
    if (pr === "") {
      return fail(
        1,
        "reconcile-replied-threads.ts: could not resolve the current branch's PR — name one explicitly, or use --all-open",
      );
    }
    prs = [pr];
  }

  for (const pr of prs) {
    if (!isDigits(pr)) {
      console.error(
        `reconcile-replied-threads.ts: '${pr}' is not a PR number — skipping`,
      );
      hadErrors = 1;
      continue;
    }

    const listing = await run(
      tsArgv(listUnresolvedThreads, botsOnly ? [pr, "--bots-only"] : [pr]),
      {
        timeoutSec: helperTimeoutSec,
        stderr: "ignore",
      },
    );
    if (listing.code !== 0) {
      console.error(
        `reconcile-replied-threads.ts: could not enumerate unresolved threads for #${pr} (failed or timed out) — skipping`,
      );
      hadErrors = 1;
      continue;
    }

    let resolved = 0;
    let held = 0;
    // Dry-run counts tracked separately from the real ones — a shared counter
    // would let --dry-run's summary line claim "resolved N, held N" when
    // nothing was actually mutated, which is exactly the false-completion
    // report --dry-run exists to avoid.
    let wouldResolve = 0;
    let wouldHold = 0;
    let truncated = 0;
    // Not dry-run-scoped like the pair above: skipping IS the mutation (or
    // lack of one) in both modes alike, so one counter covers both.
    let leftOpen = 0;

    const lines = listing.stdout.split("\n").filter((l) => l !== "");
    if (lines.length === 0) {
      console.error(`#${pr}: 0 unresolved threads`);
      continue;
    }

    for (const line of lines) {
      const thread = parseThread(line);
      if (thread === null) {
        console.error(
          `reconcile-replied-threads.ts: unreadable thread record for #${pr} — skipping it, continuing`,
        );
        hadErrors = 1;
        continue;
      }

      if (thread.commentsTruncated) {
        truncated += 1;
        emit({
          pr: Number.parseInt(pr, 10),
          threadId: thread.threadId,
          path: thread.path,
          action: "needs-human",
          reason:
            "commentsTruncated — a reply past the 100-comment cap could supersede what is visible",
        });
        continue;
      }

      // Trusted comments only, most recent first — the last one that ALSO
      // matches the grammar is the answer (SKILL.md § 3: a qualifying reply is
      // never superseded by a LATER comment that doesn't itself qualify).
      const reply = thread.comments.findLast(
        (c) =>
          c.authorAssociation !== null &&
          TRUSTED_ASSOCIATIONS.has(c.authorAssociation) &&
          qualifyingOutcome(c.body ?? "") !== "",
      );
      if (reply === undefined) continue;
      const qualifyingBody = reply.body ?? "";
      const outcome = qualifyingOutcome(qualifyingBody);
      const author = reply.author;
      const assoc = reply.authorAssociation;
      const commentUrl = reply.url;
      const verdict = sweepVerdict(
        outcome,
        thread.comments[0],
        thread.codeScanning,
      );

      let action: string;
      // `triage-thread.ts --leave-open` embeds LEAVE_OPEN_MARKER on a
      // deliberate choice not to resolve — usually a human thread, per
      // `/jig:resolve-review-comments` § Human threads. This sweep is the OTHER reader of
      // that same durable text (this file's own header: "the standalone-sweep
      // COUNTERPART... free to process the identical unresolved thread
      // later"), so without this check it would resolve a thread the other
      // reader had just deliberately left open, on its very next run —
      // reversing that choice regardless of `--bots-only` scope, since the
      // marker can appear on a bot thread too.
      //
      // Checked on the marker PLUS an outcome the marker can actually mean
      // something for — `MERIT_OUTCOMES.has(outcome) || outcome === 'moot'`
      // — never the marker alone. `moot` needs its own explicit clause,
      // outside `MERIT_OUTCOMES`, because this file has no
      // `--moot-pending-push` equivalent: a `moot` reply's own outcome word
      // never tells this sweep whether it was a held moot or a left-open
      // plain one, and the producer side closes THAT gap instead —
      // `triage-thread.ts` only ever appends the marker to a reply whose
      // outcome is genuinely non-hold at post time (its own comment on
      // `postBody`), so the marker's presence on a `moot` reply already
      // proves "this was a merit reply left open" (a gate restricted to merit
      // outcomes alone re-held a plain-moot-left-open reply instead of
      // leaving it, since it never reached this branch for `moot` at all).
      //
      // But `accepted` gets NO such benefit of the doubt, and dropping the
      // restriction entirely overshoots: the producer's "non-hold at post time"
      // guarantee says nothing about a reply this script never produced. The
      // documented supersession path lets a trusted author post ANY reply
      // directly via `reply-to-thread.ts`, bypassing `triage-thread.ts`
      // entirely — an `**accepted**` reply that happens to contain this exact
      // marker text (typo, confusion, a quoted example) would otherwise be
      // treated as `left-open` and its stale-hold cleanup could then DELETE the
      // accepted hold for an unverified fix, the exact false-convergence class
      // the `confirmedMeritSupersession` gate exists to prevent.
      // A provisional reply (`provisional-reply.ts`) stands until a person
      // comments, and the round, not this sweep, reads that comment: a thread
      // a person unresolved without a word is left as they left it, so the
      // sweep never undoes a reversal.
      if (isProvisionalReply(qualifyingBody)) action = "provisional";
      else if (markedLeftOpen(qualifyingBody, outcome)) {
        action = "left-open";
        leftOpen += 1;
        if (!dryRun) {
          const cleanedUp = await releaseStaleHoldIfSeen(pr, thread);
          if (!cleanedUp) hadErrors = 1;
        }
      } else if (verdict !== null) {
        // A merit outcome, or a code-scanning `moot`, which is never held:
        // its alert's state, not a push, is its proof (`sweepVerdict`).
        if (verdict.leftOpen !== undefined) {
          action = "left-open";
          leftOpen += 1;
          console.error(
            `reconcile-replied-threads.ts: #${pr} thread ${thread.threadId} has an alert that is not confirmed ${verdict.leftOpen} — left open`,
          );
          if (!dryRun && !(await releaseStaleHoldIfSeen(pr, thread)))
            hadErrors = 1;
        } else if (dryRun) {
          action = "would-resolve";
          wouldResolve += 1;
        } else {
          const mutation = await run(tsArgv(resolveThread, [thread.threadId]), {
            timeoutSec: helperTimeoutSec,
            stdout: "ignore",
            stderr: "inherit",
          });
          if (mutation.code === 0) {
            action = "resolved";
            resolved += 1;
            // A trusted author can supersede their own earlier accepted/moot
            // reply with a merit outcome (e.g. "actually a false positive,
            // rejected"). The thread is genuinely resolved now, but a PRIOR
            // confirmed hold for this same key — created before the superseding
            // reply — would otherwise sit in state forever: step 6 would later
            // try to resolve-held-thread.ts an already-resolved thread.
            // The compare-and-delete
            // below is ONE atomic locked call rather than a separate
            // held-keys check followed by release-held — two calls would
            // leave a window for a concurrent driver to create or replace
            // the key in between — and
            // exits 0 either way, present or not.
            //
            // Whether it is safe to delete a held entry found here is decided
            // by IDENTITY, not by WHEN it was read — three straight rounds
            // (16-18) tried timing a snapshot relative to the comment listing
            // and each attempt only moved the race to the other side of that
            // timing boundary: reading
            // late let a hold this pass never saw "match itself" and get
            // deleted; reading early left a hold this pass's OWN listing DID
            // account for (because the reply that created it is right there
            // in `thread.comments`) wrongly treated as unaccounted-for, so a
            // now-resolved thread's hold was never cleaned up at all. Neither
            // read time can settle "did this pass's merit decision already
            // account for this hold" — only the reply's IDENTITY can: a hold
            // is safe to delete iff its commentUrl is one of the comments
            // THIS thread's own listing actually read (`thread.comments`),
            // regardless of when the hold happened to be created relative to
            // any snapshot. A hold for a reply outside that set was not part
            // of what this pass's outcome decision considered, full stop.
            const cleanedUp = await releaseStaleHoldIfSeen(pr, thread);
            if (!cleanedUp) hadErrors = 1;
          } else {
            console.error(
              `reconcile-replied-threads.ts: resolve-thread.ts failed for #${pr} thread ${thread.threadId} — left unresolved, continuing`,
            );
            hadErrors = 1;
            action = "failed-resolve";
          }
        }
      } else if (commentUrl === null || commentUrl === "") {
        // `hold --kind thread` REQUIRES the qualifying comment's permalink, and
        // this is the only place it can come from. A record without one cannot
        // be re-held without recreating exactly the provenance-free entry the
        // permalink requirement closes, so it is reported for a human rather
        // than held on a guess. Checked BEFORE the dry-run branch below: a
        // proposed hold that cannot execute must report the same `failed-hold`
        // either way, not a false `would-hold` success that the real run then
        // contradicts.
        console.error(
          `reconcile-replied-threads.ts: #${pr} thread ${thread.threadId} has a qualifying '${outcome}' reply with no comment url — cannot re-hold it without one, continuing`,
        );
        hadErrors = 1;
        action = "failed-hold";
      } else if (dryRun) {
        action = "would-hold";
        wouldHold += 1;
      } else {
        const holdRes = await run(
          tsArgv(driveState, [
            "hold",
            pr,
            "--key",
            thread.threadId,
            "--kind",
            "thread",
            "--outcome",
            outcome,
            "--unconfirmed",
            "--comment-url",
            commentUrl,
          ]),
          { stdout: "ignore", stderr: "inherit" },
        );
        if (holdRes.code === 0) {
          action = "held";
          held += 1;
        } else {
          console.error(
            `reconcile-replied-threads.ts: drive-state.ts hold failed for #${pr} thread ${thread.threadId} — not held, continuing`,
          );
          hadErrors = 1;
          action = "failed-hold";
        }
      }

      emit({
        pr: Number.parseInt(pr, 10),
        threadId: thread.threadId,
        path: thread.path,
        outcome,
        author,
        authorAssociation: assoc,
        action,
      });
    }

    if (dryRun) {
      console.error(
        `#${pr}: would-resolve ${wouldResolve}, would-hold ${wouldHold}, left-open ${leftOpen}, needs-human (truncated) ${truncated}`,
      );
    } else {
      console.error(
        `#${pr}: resolved ${resolved}, held ${held}, left-open ${leftOpen}, needs-human (truncated) ${truncated}`,
      );
    }
  }

  return hadErrors;
}

runMain("reconcile-replied-threads.ts", main);
