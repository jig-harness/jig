#!/usr/bin/env bun
/**
 * Mark a draft PR Ready for review — once per PR, durably, and never against a
 * human's later decision.
 *
 * WHY THIS EXISTS. Reviewer populations behave differently on a draft, and
 * the difference is the whole design:
 *
 *   `docomply-review` REVIEWS DRAFTS. Measured 2026-08-13: PRs #4053 and #4041
 *       were created as drafts, never marked Ready, and it posted findings on
 *       both roughly a minute later. The deployed majordomo daemon carries
 *       `AI_REVIEW_REVIEW_DRAFTS=true` — an operator dial whose in-code default
 *       is `false` (ai-review `service/service.ts`), turned on here because the
 *       CI arm's draft skip was an API-billing lever and this arm
 *       runs on subscription quota instead.
 *   CodeRabbit REFUSES A DRAFT outright — "Review skipped / Draft detected",
 *       measured on the same PRs — as does the dormant CI arm
 *       (`!github.event.pull_request.draft`).
 *
 * So repo policy births every PR as a draft, and the in-house reviewer works it
 * anyway while the paid external one waits. That ordering is worth spending
 * deliberately rather than by accident: let the drive clear the in-house
 * reviewer's obvious findings first, THEN mark the PR Ready, so CodeRabbit's
 * one pass lands on a head that has already been cleaned up instead of on the
 * first draft of it.
 *
 * Usage: mark-ready.ts [PR] [--reason TEXT]
 *
 * Exit codes:
 *   0  the call itself did not fail — this covers `marked`, `already-ready`,
 *      `already-marked`, AND `claimed-by-other`, so it is NOT "the PR is
 *      Ready": `claimed-by-other` exits 0 while the PR may still be a draft,
 *      because the transition is someone else's to finish, not a failure of
 *      THIS call. Callers that care whether the PR ended up Ready must
 *      inspect the STDOUT outcome word below, not the exit code alone —
 *      this is what makes exit 0 alone safe to call at the end of every
 *      round without also checking stdout for a caller that does not care.
 *   1  the transition was owed but failed. Split behavior, not one contract:
 *      a CONFIRMED failure (state that could not be read or written, a durable
 *      record that failed after the transition demonstrably applied) releases
 *      the lease on the way out, so the next round retries rather than
 *      believing it done — and a release that itself fails is no longer
 *      permanent either, since the lease expires on its own. An AMBIGUOUS
 *      outcome (`gh pr ready` itself exited nonzero and the follow-up read
 *      could not positively rule out that it applied anyway) instead PRESERVES
 *      the lease rather than releasing it — an unconfirmed remote effect must
 *      not become immediately retryable, since retrying could duplicate
 *      `ready_for_review` or reverse a human's later re-draft. See the
 *      "AMBIGUOUS, NOT DID NOT APPLY" comment at that branch, and an earlier change for
 *      the residual gap once that lease itself goes stale.
 *   5  the PR is not open — nothing to mark, and the caller's loop is over
 *   2  usage error
 *
 * STDOUT is a single outcome word, because exit 0 alone does not say which of
 * the cases above happened, and one of them — `marked` — is the only one that
 * changes what a caller should do next (a drive that has just summoned
 * CodeRabbit must say so, and must not report the review loop finished).
 * Human prose goes to stderr; this channel stays machine-readable:
 *
 *   marked          this call fired `gh pr ready`
 *   already-ready   the PR was not a draft (a human marked it, or it never was)
 *   already-marked  this drive marked it before; a later flip back to draft is
 *                   a human's decision and is deliberately not undone
 *   claimed-by-other  another driver holds the lease and will do it — and if
 *                   it dies instead, the lease expires and a later round takes
 *                   the transition over, so this is safe to leave rather than
 *                   wait on
 *   not-open        the PR is merged or closed (exit 5)
 *   still-draft     `--record-only` only: the PR is genuinely a draft as of
 *                   this read — nothing recorded, nothing dispatched, and the
 *                   transition is left to a later, ordinary call
 *
 * THE LEASE AND THE RECORD ARE SEPARATE, and that split is the design rather
 * than plumbing. `readyMarkedRound` is written only after `gh pr ready` is
 * CONFIRMED, so a non-zero value there means the event genuinely fired; the
 * in-flight claim lives in a filesystem lease that expires by itself. The
 * collapsed version — one field, set before the call, cleared by the failure
 * branch — was permanent in the one case that runs no failure branch at all: a
 * process killed mid-transition left the field non-zero forever, every later
 * invocation answered `already-marked` without asking GitHub, and the PR stayed
 * a draft nothing would ever mark (docomply-review rounds 1-3, PR #4057).
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, isDigits, runMain, sleep, testDelaySeconds } from "./lib/cli.ts";
import {
  ghCall,
  helperTimeoutSeconds,
  resolvePr,
  run,
  tsArgv,
} from "./lib/proc.ts";

const here = dirname(fileURLToPath(import.meta.url));
const driveState = join(here, "drive-state.ts");

function usage(): void {
  console.error(`usage: mark-ready.ts [PR] [--reason TEXT]

  Marks a DRAFT pull request Ready for review, at most once per PR.
  With PR omitted, resolves the current branch's PR.

  --reason TEXT   what earned the transition, for the stderr line only.
  --record-only   never fire 'gh pr ready' — only record an already-Ready
                   observation (or confirm the durable state), and return
                   'still-draft' with no side effect if the PR is genuinely a
                   draft. For a caller that wants the DURABLE RECORD before a
                   draft flip can matter, not the transition itself.`);
}

interface Args {
  pr: string;
  reason: string;
  recordOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { pr: "", reason: "", recordOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--record-only") {
      a.recordOnly = true;
      continue;
    }
    if (arg === "--reason") {
      const value = argv[++i];
      if (value === undefined) fail(2, "--reason requires a value");
      a.reason = value;
      continue;
    }
    if (arg.startsWith("-")) {
      usage();
      fail(2, `unknown flag: ${arg}`);
    }
    a.pr = arg;
  }
  return a;
}

type Snapshot =
  | { kind: "ok"; state: string; draft: boolean }
  | { kind: "unreadable"; why: string };

/**
 * Liveness and draftness in ONE read, for the reason `evaluate()` reads its own
 * snapshot in one: two calls are two instants, and this decides an
 * outward-facing, reviewer-summoning act.
 *
 * Every field is validated rather than coerced. An absent or null `isDraft`
 * coerces to `false` — "already Ready, nothing owed" — which is the answer that
 * silently SKIPS the transition on the one PR that needs it, and records
 * nothing, so the skip is invisible afterwards. Same rule, and same direction
 * of failure, as the `isDraft` read in `evaluate()`.
 */
async function readSnapshot(pr: string): Promise<Snapshot> {
  const view = await ghCall(["pr", "view", pr, "--json", "state,isDraft"], {
    stderr: "ignore",
  });
  if (view.code !== 0) return { kind: "unreadable", why: "the read failed" };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(view.stdout) as Record<string, unknown>;
  } catch {
    return { kind: "unreadable", why: "the response was not JSON" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "unreadable", why: "the response was not an object" };
  }
  const state = parsed.state == null ? "" : String(parsed.state);
  // Every recognized value, not merely non-empty (docomply-review round 19,
  // a reference-implementation pull request) — callers treat anything other than `OPEN` as definitively
  // MERGED/CLOSED and return `not-open`/exit 5, the terminal "stop, nothing
  // left to do" answer. A malformed response or a future GitHub enum value
  // this script does not know about would otherwise pass this check and be
  // read as that same certainty, permanently stopping the drive instead of
  // producing the indeterminate retry an unrecognized value actually is —
  // the same discipline the sibling announce-merge-ready.ts code already
  // applies to this exact field.
  if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") {
    return { kind: "unreadable", why: `unrecognized 'state' value '${state}'` };
  }
  const draft = parsed.isDraft;
  if (typeof draft !== "boolean") {
    return {
      kind: "unreadable",
      why: `no boolean 'isDraft' (got '${draft === undefined ? "<absent>" : String(draft)}')`,
    };
  }
  return { kind: "ok", state, draft };
}

/**
 * Win the transition's lease, or learn that someone else holds it. The token
 * comes back because every later write against the lease has to prove it is
 * the holder — `commit-ready-mark` refuses without it.
 */
async function takeLease(
  pr: string,
): Promise<{ kind: "won"; token: string } | "taken" | "error"> {
  const claim = await run(tsArgv(driveState, ["claim-ready-mark", pr]), {
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (claim.code !== 0) return "error";
  const out = claim.stdout.trim();
  if (out === "already") return "taken";
  const m = /^claimed (\S+)$/.exec(out);
  if (m === null) {
    console.error(
      `mark-ready.ts: claim-ready-mark answered '${out}', which is neither 'already' nor 'claimed <token>'.`,
    );
    return "error";
  }
  return { kind: "won", token: m[1] ?? "" };
}

/** Record a CONFIRMED transition and give the lease back. */
async function commitLease(pr: string, token: string): Promise<number> {
  const rc = await run(
    tsArgv(driveState, ["commit-ready-mark", pr, "--token", token]),
    { stdout: "ignore", stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
  );
  return rc.code;
}

/**
 * Lease + commit for a transition that needs no `gh pr ready` at all — the PR
 * is already Ready, and what is owed is only the durable record of owing
 * nothing. `taken` is not a failure here: whoever holds the lease is about to
 * write the same record.
 */
async function claimAndCommit(
  pr: string,
): Promise<"committed" | "claimed-by-other" | "failed"> {
  const lease = await takeLease(pr);
  if (lease === "error") return "failed";
  if (lease === "taken") return "claimed-by-other";
  return (await commitLease(pr, lease.token)) === 0 ? "committed" : "failed";
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  if (a.pr !== "" && !isDigits(a.pr)) {
    usage();
    fail(2, `not a PR number: ${a.pr}`);
  }
  const pr = await resolvePr(a.pr);
  if (pr === "") {
    fail(
      2,
      "mark-ready.ts: no PR given and none could be resolved for the current branch.",
    );
  }

  // The durable claim is read FIRST, before the PR is even looked at. A drive
  // that already marked this PR owes nothing regardless of what the live flag
  // now says — and "what the live flag now says" is exactly the case that must
  // not re-fire: a human who converted the PR back to draft made a deliberate
  // decision, and a transition re-derived from `isDraft` would undo it on the
  // next round, and the round after that, forever (the #3933 shape, pointed at
  // a human). Reading state first also means the common case — every round
  // after the first — costs no network call at all.
  const markedRes = await run(tsArgv(driveState, ["ready-marked", pr]), {
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (markedRes.code !== 0) {
    fail(
      1,
      `mark-ready.ts: cannot read the durable ready-mark for PR #${pr}.`,
      'Refusing to decide the transition on an unreadable claim: guessing "not yet"',
      "risks re-marking a PR a human deliberately converted back to draft.",
    );
  }
  const markedRaw = markedRes.stdout.trim();
  if (!isDigits(markedRaw)) {
    fail(
      1,
      `mark-ready.ts: the durable ready-mark for PR #${pr} is not a number ('${markedRaw}').`,
    );
  }
  if (Number.parseInt(markedRaw, 10) !== 0) {
    // LIVENESS CHECKED even on this fast path (docomply-review round 8, PR
    // #4057): without it, a PR that merged or closed AFTER the durable mark
    // was written still reports `already-marked` (exit 0) here. On the
    // post-round caller that is harmless — the next loop iteration's own
    // drive-status.ts gate independently discovers PR_NOT_OPEN — but on the
    // CONVERGED-with-no-round-to-run caller, this exit 0 IS the drive's final
    // report, so a stale `already-marked` would report full convergence about
    // a PR that is no longer open.
    //
    // An UNREADABLE liveness read now FAILS the call rather than falling
    // through to `already-marked` (docomply-review round 11, a reference-implementation pull request): the
    // converged-path caller already treats a nonzero, non-5 exit here as
    // "stop rather than falsely report convergence" (its own `rc.code !== 0`
    // branch), so failing is what actually reaches that protection — a
    // silent degrade to `already-marked` looked safe ("this branch already
    // KNOWS the PR was Ready as of an earlier, confirmed observation") but
    // that reasoning conflates "was Ready then" with "is still open now",
    // which is exactly the fact this read could not confirm. The ordinary
    // post-round caller treats this failure the same bounded, retriable way
    // it treats any other mark-ready.ts failure.
    const liveness = await readSnapshot(pr);
    if (liveness.kind !== "ok") {
      fail(
        1,
        `mark-ready.ts: PR #${pr} was recorded Ready in round ${markedRaw}, but its current`,
        `liveness could not be confirmed (${liveness.why}). Not reporting 'already-marked' on`,
        "an unconfirmed read — that could report full convergence about a PR that has",
        "since closed. Re-run once the read succeeds.",
      );
    }
    if (liveness.state !== "OPEN") {
      console.error(
        `mark-ready.ts: PR #${pr} is ${liveness.state} — nothing to mark Ready (it was recorded`,
      );
      console.error(`  Ready in round ${markedRaw}, but is no longer open).`);
      process.stdout.write("not-open\n");
      return 5;
    }
    console.error(
      `mark-ready.ts: PR #${pr} was already marked Ready by this drive (round ${markedRaw}) — not re-marking.`,
    );
    process.stdout.write("already-marked\n");
    return 0;
  }

  // Liveness is checked FIRST and wins, the same precedence every other gate in
  // this skill enforces — and it is not moot here, because GitHub keeps
  // `isDraft` true on a CLOSED draft, so an isDraft-only read would cheerfully
  // mark a closed PR Ready.
  const snap = await readSnapshot(pr);
  if (snap.kind !== "ok") {
    fail(
      1,
      `mark-ready.ts: cannot read the state and draft status of PR #${pr} (${snap.why}).`,
      "Not marking on an unreadable snapshot — an auth blip, a timeout or a partial",
      'response must not be read as "still an open draft", nor as "already Ready".',
    );
  }
  if (snap.state !== "OPEN") {
    console.error(
      `mark-ready.ts: PR #${pr} is ${snap.state} — nothing to mark Ready.`,
    );
    process.stdout.write("not-open\n");
    return 5;
  }
  if (!snap.draft) {
    // Already Ready — a human got there first, or the PR was never a draft.
    // Recorded anyway, so the state reflects "this PR needs no transition from
    // us" rather than staying at 0 and re-asking `gh` on every future round.
    //
    // The record is CHECKED, not fired and forgotten. Leaving it at 0 is not
    // the harmless cost-only outcome it looks like: this drive would then owe
    // no transition and have no durable evidence of it, so a later round —
    // after a human converts the PR BACK to draft — reads 0, sees a draft, and
    // marks it Ready again, undoing that human's decision (docomply-review
    // rounds 1-2, PR #4057). Fail closed, exactly as the draft path does, so
    // the next round retries the RECORD rather than believing it made one.
    const rc = await claimAndCommit(pr);
    if (rc === "failed") {
      fail(
        1,
        `mark-ready.ts: PR #${pr} is already Ready, but recording that durably failed.`,
        "Not reporting success on an unrecorded state: with nothing persisted, a later",
        "round would re-derive the answer from the live flag and could re-mark a PR a",
        "human had deliberately converted back to draft.",
      );
    }
    if (rc === "claimed-by-other") {
      // NOT durable success (docomply-review round 4, a reference-implementation pull request): another
      // driver holds the lease and has not yet — and may never — write the
      // record. Reporting `already-ready` here would claim the same durable
      // guarantee the comment above describes while this call achieved none
      // of it; if the other holder dies without committing and a human
      // converts the PR back to draft in the meantime, a later round would
      // see `readyMarkedRound === 0` and undo that decision. Report the
      // uncertainty instead, exactly as the draft path already does.
      console.error(
        `mark-ready.ts: PR #${pr} is already Ready for review, and another driver holds the record-keeping lease — leaving it to them.`,
      );
      process.stdout.write("claimed-by-other\n");
      return 0;
    }
    console.error(
      `mark-ready.ts: PR #${pr} is already Ready for review — nothing to do.`,
    );
    process.stdout.write("already-ready\n");
    return 0;
  }

  // `--record-only` may NEVER reach the dispatch below (docomply-review +
  // chatgpt-codex-connector, a reference-implementation pull request). A caller that wants a record BEFORE a
  // draft flip can matter is racing exactly the window between whatever
  // snapshot IT read and this script's own live re-read above — if the PR
  // turned draft in that window, this is precisely where an ordinary call
  // would take the lease and fire `gh pr ready`, undoing the flip its own
  // caller was trying to protect against. So this reports the observation and
  // stops, with no lease taken and no event fired — the caller's own later,
  // ordinary (non-record-only) call is what actually owns the transition.
  if (a.recordOnly) {
    console.error(
      `mark-ready.ts: PR #${pr} is a draft as of this read — --record-only never dispatches,`,
    );
    console.error("  leaving the transition to a later, ordinary call.");
    process.stdout.write("still-draft\n");
    return 0;
  }

  // LEASE, ACT, THEN RECORD — a claim and a record are different facts
  // (drive-state.ts's own comment on the sequence has the full reasoning):
  //
  //   lease first, because two drivers on one PR (different worktrees — the
  //     clone-wide PR lock is what they contend for) must not both fire
  //     `ready_for_review`, which is what re-triggers paid external review.
  //     Exactly one of them can hold the lease.
  //   record LAST, and only on a confirmed transition, because claim-first is
  //     the unsafe order for a crash: a durable mark written before the event
  //     and never rolled back by the failure branch a SIGKILL skips would say
  //     the PR had been handled while it stayed a draft forever (docomply-
  //     review rounds 1-3, PR #4057). The lease expires on its own instead, so
  //     a later round retries; the mark, once written, is the truth.
  const lease = await takeLease(pr);
  if (lease === "error") {
    fail(1, `mark-ready.ts: cannot claim the ready-mark for PR #${pr}.`);
  }
  if (lease === "taken") {
    // Another driver holds it. Theirs to finish — and if they die instead the
    // lease goes stale and the next round takes it over, which is why this is
    // safe to leave alone rather than wait on.
    console.error(
      `mark-ready.ts: another driver holds PR #${pr}'s ready-mark lease — leaving it to them.`,
    );
    console.error(
      "  Nothing is durably recorded until that driver confirms the transition, so a",
      "\n  driver that dies mid-flight loses the lease to staleness rather than wedging it.",
    );
    process.stdout.write("claimed-by-other\n");
    return 0;
  }

  // The concurrent-driver window, made deterministic. Between winning the lease
  // and firing the event is exactly the interval in which a second driver must
  // find itself locked out, and it is otherwise microseconds wide — far too
  // narrow for a test to land inside reliably, which is how the CAS came to be
  // load-bearing with no test that could go red on its removal (docomply-review
  // round 2, PR #4057). `$DRIVE_PR_MARK_READY_TEST_SIGNAL` is touched the
  // instant the lease is held, so a second process can wait for a guaranteed
  // window rather than a hopeful one, and the delay holds it open.
  //
  // Live in the shipped script rather than stripped for production, the same
  // trade every other hook here makes: `testDelaySeconds` owns the validation
  // and the hard cap, and validates BEFORE the signal fires, so a rejected
  // delay can never leave a waiting test believing this process is about to
  // sleep holding the lease when it is about to exit instead.
  const delaySec = testDelaySeconds(
    "DRIVE_PR_MARK_READY_TEST_DELAY",
    "mark-ready",
  );
  const signalPath = process.env.DRIVE_PR_MARK_READY_TEST_SIGNAL;
  if (signalPath) writeFileSync(signalPath, "");
  if (delaySec > 0) await sleep(delaySec);

  // PROVE THE LEASE IS STILL OURS, AND RESET ITS CLOCK, IMMEDIATELY BEFORE THE
  // EVENT (coderabbitai P2, PR #4057). Winning the lease and firing are two
  // moments, and everything between them is this process's own runtime — which
  // can be suspended for arbitrarily long; a laptop sleeping is the ordinary
  // case, not the exotic one. Past the staleness window another driver may
  // legitimately reclaim the lease and fire the event itself, and this process
  // would resume and fire a second `ready_for_review` believing it still held
  // something.
  //
  // A refusal here means exactly that happened, so the only safe move is to
  // fire NOTHING and let the driver that now owns the lease finish. Nothing is
  // released on the way out either: the lease is no longer ours to release,
  // and calling `release-ready-mark` would be the very cross-generation delete
  // its own lock exists to prevent.
  //
  // This NARROWS the suspension window to the renewed staleness interval
  // (default $DRIVE_PR_CLAIM_STALE_MIN) inside the single gap between this
  // renewal returning and `ghCall` below actually dispatching — it does not
  // close that gap to zero. Proving ownership and acting on it are two
  // separate calls, so nothing short of a non-expiring lease (rejected
  // elsewhere in this file for the wedge it reintroduces) or a server-side
  // conditional write GitHub does not offer here can make them atomic
  // (chatgpt-codex-connector, a reference-implementation pull request). The residual is an accepted one, of
  // the same kind as the unconfirmed-response window a few lines below and
  // the failed-release window further down: a second dispatch would land on a
  // PR the winner has already made non-draft, where `ready_for_review` fires
  // on the transition and not on the call, so the realistic worst case is one
  // wasted or erroring API call rather than a second summoned review.
  const renew = await run(
    tsArgv(driveState, ["renew-ready-mark", pr, "--token", lease.token]),
    {
      stdout: "ignore",
      stderr: "inherit",
      timeoutSec: helperTimeoutSeconds(),
    },
  );
  if (renew.code !== 0) {
    if (renew.code === 2) {
      // A CONFIGURATION error, not another driver (docomply-review round 7,
      // a reference-implementation pull request): `renew-ready-mark` refuses BEFORE checking the token when
      // the staleness window cannot exceed one outbound call's deadline —
      // that refusal is this process's own bad environment, not evidence of
      // contention. Reporting it as `claimed-by-other` falsely blames a
      // driver that does not exist, and every later round hits the identical
      // config and repeats the same false blame: unlike a genuinely stale
      // lease, a bad config does not resolve with time. This process still
      // holds a VALID lease — the token was never checked — so release it and
      // surface the real failure instead of abandoning it to expire.
      const released = await run(
        tsArgv(driveState, ["release-ready-mark", pr, "--token", lease.token]),
        {
          stdout: "ignore",
          stderr: "inherit",
          timeoutSec: helperTimeoutSeconds(),
        },
      );
      fail(
        1,
        `mark-ready.ts: PR #${pr}'s ready-mark lease could not be renewed — a configuration error, not another driver.`,
        ...(released.code === 0
          ? [
              "The lease has been released, so the next round retries once the configuration is fixed.",
            ]
          : [
              "The lease could NOT be released — the next round retries once it goes stale.",
              `To retry sooner, clear it by hand: drive-state.ts release-ready-mark ${pr}`,
            ]),
      );
    }
    console.error(
      `mark-ready.ts: PR #${pr}'s ready-mark lease was reclaimed before this call could use it —`,
    );
    console.error(
      "  not firing the event. The driver that reclaimed it owns the transition now.",
    );
    process.stdout.write("claimed-by-other\n");
    return 0;
  }

  const ready = await ghCall(["pr", "ready", pr]);
  if (ready.code !== 0) {
    // A NON-ZERO EXIT IS NOT PROOF THE TRANSITION DID NOT APPLY (docomply-
    // review round 3, PR #4057). A request that succeeded server-side and then
    // timed out, or whose response was lost, exits non-zero here with the PR
    // already Ready — and releasing the lease on that reading lets a later
    // round fire `ready_for_review` a second time, which is the paid-review
    // re-trigger this whole mechanism exists to prevent, and which would also
    // undo a human who converted the PR back to draft in between.
    //
    // So ask GitHub what actually happened before deciding. Only a snapshot
    // that positively shows an OPEN DRAFT justifies "it did not apply".
    const after = await readSnapshot(pr);
    // LIVENESS FIRST, before interpreting draftness at all (docomply-review
    // round 8, PR #4057) — the same contract the early snapshot at the top of
    // this script already applies. A PR that merged or closed concurrently
    // can read back non-draft (committed and wrongly reported `marked`) or
    // still-draft (released and wrongly reported an ordinary transition
    // failure); in both cases the authoritative answer is `not-open`, not a
    // guess derived from draftness. The lease is released either way: the
    // transition can never apply to a PR that is no longer open.
    if (after.kind === "ok" && after.state !== "OPEN") {
      const released = await run(
        tsArgv(driveState, ["release-ready-mark", pr, "--token", lease.token]),
        {
          stdout: "ignore",
          stderr: "inherit",
          timeoutSec: helperTimeoutSeconds(),
        },
      );
      console.error(
        `mark-ready.ts: PR #${pr} is ${after.state} — the 'gh pr ready' request cannot have`,
      );
      console.error(
        "  applied to an open draft that no longer exists. Nothing to mark.",
      );
      if (released.code !== 0) {
        console.error(
          "  The lease could NOT be released — it will age out on its own; no retry is owed",
        );
        console.error("  regardless, since the PR is no longer open.");
      }
      process.stdout.write("not-open\n");
      return 5;
    }
    if (after.kind === "ok" && !after.draft) {
      const rc = await commitLease(pr, lease.token);
      if (rc !== 0) {
        fail(
          1,
          `mark-ready.ts: 'gh pr ready ${pr}' exited ${ready.code}, but the PR is Ready — and recording that failed.`,
          "The transition DID apply; only the durable record is missing, so a later round",
          "may re-derive it from the live flag. Re-run once the state store is writable.",
        );
      }
      console.error(
        `mark-ready.ts: 'gh pr ready ${pr}' exited ${ready.code}, but the PR is Ready — the`,
      );
      console.error(
        "  request landed and the response did not. Recorded as marked rather than retried,",
      );
      console.error(
        "  so the event is not fired a second time against reviewers that already saw it.",
      );
      process.stdout.write("marked\n");
      return 0;
    }
    const detail = ready.stderr.trim();
    // AMBIGUOUS, NOT "DID NOT APPLY" (docomply-review rounds 5 and 13, PR
    // #4057) — for BOTH remaining cases, not just an unreadable read. The
    // whole point of the reconciliation read above is to distinguish a
    // request that failed from one that succeeded and merely lost its
    // response, and this point in the function is reached whenever it could
    // NOT make that distinction: either the read itself failed, or it
    // succeeded and reported an OPEN draft — which is ALSO not proof the
    // request never applied. `gh pr ready` can apply server-side and still
    // exit nonzero, and a human can convert the PR back to draft in the
    // window before this read completes; the resulting OPEN-draft snapshot
    // is then indistinguishable from "the request never landed at all" using
    // the live flag alone. Releasing the lease on either reading (as an
    // earlier version did for the readable-draft case) makes an unconfirmed
    // remote effect immediately retryable — which either duplicates
    // `ready_for_review` on a lost-response success, or reverses a human's
    // deliberate re-draft on a request that DID apply and was then reversed.
    //
    // So the lease is left exactly as it is in both cases: still held, by
    // this process, until something can actually confirm what happened. A
    // future retry — this process again, or a successor after the lease goes
    // stale — will re-read the live snapshot before ever calling
    // `gh pr ready` again (the early liveness/draftness read at the top of
    // this script), so an application that DID land is discovered as
    // "already Ready" rather than fired a second time.
    fail(
      1,
      `mark-ready.ts: 'gh pr ready ${pr}' failed (exit ${ready.code}), and the follow-up read`,
      after.kind === "ok"
        ? `shows PR #${pr} still an OPEN draft — not proof the request never applied, since a`
        : `that would confirm whether it actually applied also failed for PR #${pr}.`,
      ...(after.kind === "ok"
        ? [
            "human converting it back to draft in the window before this read would look",
            "identical.",
          ]
        : detail === ""
          ? []
          : [detail]),
      "Leaving the lease in place rather than guessing — releasing it now would make an",
      "UNCONFIRMED remote effect immediately retryable. It will be retried once this is",
      "confirmable, or once it goes stale ($DRIVE_PR_CLAIM_STALE_MIN, default 10m).",
    );
  }

  // Confirmed. NOW the durable record, which is what makes this once-only.
  const rc = await commitLease(pr, lease.token);
  if (rc !== 0) {
    fail(
      1,
      `mark-ready.ts: PR #${pr} was marked Ready, but recording that durably failed.`,
      "The event has already fired, so this exits 1 to surface the missing record — the",
      "PR is Ready, and the next round sees that through the live flag and records it",
      "from the already-Ready path rather than firing the event again.",
    );
  }

  console.error(
    `mark-ready.ts: PR #${pr} marked Ready for review${a.reason === "" ? "" : ` — ${a.reason}`}.`,
  );
  console.error(
    "  Reviewers that skip drafts (CodeRabbit) now see a head this drive has already worked.",
  );
  process.stdout.write("marked\n");
  return 0;
}

runMain("mark-ready.ts", main);
