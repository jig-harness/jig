/**
 * drive-pr suite: drive-status.ts: terminal states, drafts, conflicts and the measured false-convergence modes.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import {
  HEAD,
  REVIEWER_RUN,
  DORMANT_ARM,
  writeFixture,
  probeIn,
  park,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { createStatusReconcileFixtures } from "./drive-pr-status-reconcile-fixtures.ts";

useDrivePrSuite();
describe("drive-status.ts reconciles replied threads on every pass", () => {
  const statusReconcileFixtures = createStatusReconcileFixtures();
  const { repliedThread, resolvedIn, heldKeysIn, heldIn, humanRepliedThread } =
    statusReconcileFixtures;

  it("reconciles while the gate is stuck at AWAITING_REVIEWER — the measured leak", async () => {
    // The shape: nothing here becomes true with time (a CONFLICTING PR gets
    // zero `pull_request` CI; a PR past the reviewer's own round ceiling never
    // gets another check-run), so the gate returns 4 on every call forever and
    // no pass ever runs. `**rejected**` is a claim about the finding's MERIT —
    // not fix-dependent — so the sweep resolves it outright, and that has to
    // happen despite the verdict, not after it.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_stuck_gate", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual(["PRRT_stuck_gate"]);
  });

  it("reconciles on PR_CONFLICTING — the terminal state that never becomes anything with time", async () => {
    // The conflict variant of the same leak. Its findings are parked for a
    // human, so the conflict is terminal (exit 9) and no round is ever handed
    // out — while the thread itself already carries a merit reply somebody
    // posted on GitHub without clearing the park. Nothing here resolves
    // itself: the exit says so in as many words ("nothing here becomes
    // judgeable with time").
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_conflicting", "**deferred**")],
      checkRuns: [DORMANT_ARM],
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    });
    await park(stateDir, "PRRT_conflicting", "thread");
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.exitCode).toBe(9);
    expect(resolvedIn(dir)).toEqual(["PRRT_conflicting"]);
  });

  it("reconciles ahead of the EARLIEST return — UNSUPPORTED_CLI is decided before anything is enumerated", async () => {
    // The strongest available witness that the sweep runs ahead of the
    // evaluation rather than somewhere inside it: `UNSUPPORTED_CLI` is raised
    // off the very first `gh pr view`, on the missing-field path, before
    // `evaluate()` has read liveness or the head — let alone enumerated any
    // work. If the sweep still resolved the thread here, it cannot be running
    // anywhere inside the evaluation.
    //
    // A DRAFT PR would not serve: drafts are driven and marked Ready after
    // the first round, so a draft falls through to ordinary evaluation and
    // witnesses nothing the AWAITING_REVIEWER probe above does not. "Ahead of
    // the earliest return" is the property worth pinning, whichever state is
    // earliest.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_earliest", "**wont-fix**")],
      checkRuns: [DORMANT_ARM],
      mergeabilityUnreadable: true,
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("UNSUPPORTED_CLI");
    expect(r.exitCode).toBe(2);
    expect(resolvedIn(dir)).toEqual(["PRRT_earliest"]);
  });

  it("re-holds an **accepted** reply unconfirmed — the gate never resolves a fix-dependent one", async () => {
    // The sweep's semantics are the same inside the gate: an
    // `accepted`/`moot` reply promises a FIX, and only resolve-held-thread.ts
    // may resolve one, after verifying the push that carries it. The sweep has
    // no way to confirm that, so it re-holds at a round `claim-held` can never
    // match and leaves the thread open for a live pass's own step 3.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_accepted", "**accepted**")],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual([]);
    // Asserted as the WHOLE record, because each field is a separate way the
    // production path could regress into an ordinary claimable hold: `round`
    // is the -1 sentinel `claim-held` can never match (the actual mechanism
    // keeping the thread unresolved until a live pass re-holds it for real),
    // and `commentUrl` must be the QUALIFYING reply's own permalink —
    // `comment-1`, not the finding at `comment-0` — since that is what a
    // later superseding comment is compared against.
    expect(await heldIn(stateDir)).toEqual([
      {
        key: "PRRT_accepted",
        kind: "thread",
        outcome: "accepted",
        round: -1,
        commentUrl: "https://example.invalid/PRRT_accepted/comment-1",
        actor: expect.any(String),
      },
    ]);
  });

  it("under --bots-only, leaves a replied HUMAN thread open — the deliberate state, not a leak", async () => {
    // `/jig:resolve-review-comments` § Human threads makes "a human thread you replied to
    // but chose not to close on the author's behalf" the one sanctioned
    // exception to "every comment you act on ends resolved", and says that
    // exception is WHY continuous mode targets bot threads. This sweep runs
    // unattended, so it is exactly the act that rule governs: a `**rejected**`
    // reply plus a still-open thread IS the exception, and resolving it here
    // would use the author's own triage as the warrant for overriding their
    // choice.
    const { dir, stateDir } = writeFixture({
      threads: [humanRepliedThread("PRRT_human", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, ["--bots-only"], {
      reconcile: true,
    });

    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("without --bots-only, still reconciles a replied human thread — the human-attended scope", async () => {
    // The other half of the same boundary, and the reason the fix is a
    // forwarded flag rather than a blanket exclusion: an unscoped one-shot is
    // the human-attended run AGENTS.md assigns the wider scope to, so the
    // merit outcome still resolves there. Human-ATTENDED is the whole test —
    // a scheduled --all-open sweep is not, and passes --bots-only like the
    // gate does.
    const { dir, stateDir } = writeFixture({
      threads: [humanRepliedThread("PRRT_human", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual(["PRRT_human"]);
  });

  it("an UNATTENDED drive sweeps bot-only even when counting human threads", async () => {
    // `drive.ts` is the unattended runner, and it accepts `--bots-only` as
    // optional — so a drive started without it ran an UNSCOPED sweep every
    // round, resolving human threads with nobody watching. That is the act
    // `/jig:resolve-review-comments` § Human threads reserves, and it does not become
    // permissible because the operator also wanted human threads COUNTED.
    //
    // `$DRIVE_PR_TARGET` exists exactly when drive.ts spawned this gate, which
    // is the signal used. Note the two scopes now differ — human threads are
    // still counted — and only in the safe direction: the sweep is narrower
    // than the count, so an unattended drive simply cannot converge over a
    // replied human thread, which is the correct outcome.
    // The reviewer run is present (no `checkRuns` override) so the evaluation
    // reaches the thread ENUMERATION — the stuck-gate fixtures used elsewhere
    // in this block return before counting anything, which would make the
    // second assertion vacuous.
    const { dir, stateDir } = writeFixture({
      threads: [humanRepliedThread("PRRT_human_unattended", "**rejected**")],
    });
    const r = await probeIn(dir, stateDir, HEAD, [], {
      reconcile: true,
      env: { DRIVE_PR_TARGET: "999" },
    });

    expect(r.exitCode).toBe(0);
    expect(resolvedIn(dir)).toEqual([]);
    // Still COUNTED — the narrowing is of the sweep, not of convergence.
    expect((r.json.work as Record<string, unknown>).unresolvedThreads).toBe(1);
  });

  it("a FAILING sweep is reported, and changes nothing about a RE-ARMING verdict", async () => {
    // A reconciliation error means some already-answered thread is still
    // unresolved on GitHub — a thing to report, never a reason to refuse a
    // round this gate can otherwise judge. Modelled with the resolve mutation
    // itself failing, which is what the sweep exits non-zero over.
    //
    // RE-ARMING is the load-bearing half, and the boundary the next test
    // draws: `4` comes back, so the next pass sweeps again and a failure here
    // costs nothing durable. The verdicts that do NOT come back are gated.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_sweep_fails", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    writeFileSync(join(dir, "resolve-thread-fails"), "");
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("reconciliation sweep");
    // The report is still the gate's own, on stdout, uncorrupted by the
    // sweep's NDJSON — which is why that output is re-emitted on stderr.
    expect(r.json.state).toBe("AWAITING_REVIEWER");
  });

  it("a FAILING sweep BLOCKS a verdict that ends the drive", async () => {
    // The other half of the boundary, and the generalisation of the liveness
    // degrade: `drive.ts` does not re-arm on 8/9/10, so after one of those no
    // later pass is promised — and a thread the sweep failed to resolve would
    // stay open with nothing left to retry it. That is the leak
    // rebuilt one level up, and two independent reviewers found it in the same
    // round.
    //
    // Same fixture as the test above except for the verdict it reaches: the
    // reviewer run is present (so the evaluation gets past AWAITING_REVIEWER)
    // and the thread is parked, so it evaluates to HITL_PARKED. Reading 1
    // rather than 8 is therefore evidence about the gate, not about the
    // fixture being unable to reach a terminal state.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_sweep_fails_terminal", "**rejected**")],
    });
    writeFileSync(join(dir, "resolve-thread-fails"), "");
    await park(stateDir, "PRRT_sweep_fails_terminal", "thread");
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
  });

  it("a FAILING sweep blocks REVIEWER_FAILED too — the set is drive.ts’s stopping codes", async () => {
    // 7 was missed on the first cut of the guard because that cut reasoned
    // from "terminal states" rather than from `drive.ts`'s own default branch,
    // which returns 7 alongside 8/9/10. Same consequence: the drive ends, so
    // nothing retries the sweep.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_reviewer_failed", "**rejected**")],
      checkRuns: [{ ...REVIEWER_RUN, conclusion: "failure" }, DORMANT_ARM],
    });
    writeFileSync(join(dir, "resolve-thread-fails"), "");
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
  });

  it("--no-reconcile cannot certify a verdict that ends the drive", async () => {
    // Opting out suppresses the sweep; it must not also VOUCH for one. Folding
    // the flag into "reconciliation succeeded" made a drive-ending verdict
    // reachable with nothing swept — the stranding this guard exists to stop,
    // available by flag. The flag still works for
    // every other verdict: the `--no-reconcile opts out explicitly` probe
    // above reaches 4 with it, unchanged.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_optout_terminal", "**rejected**")],
    });
    await park(stateDir, "PRRT_optout_terminal", "thread");
    const r = await probeIn(dir, stateDir, HEAD, ["--no-reconcile"], {
      reconcile: true,
    });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--no-reconcile");
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("--no-count cannot certify a verdict that ends the drive either", async () => {
    // `--no-count` was exempted on the reasoning that it marks a mid-round
    // re-read, so the pass entry above it already swept. That holds only if
    // the entry swept SUCCESSFULLY — and a counting pass deliberately returns
    // ROUND_READY over a FAILED sweep, so a re-read inside exactly that round
    // would certify a drive-ending verdict for a sweep that never succeeded.
    //
    // The exemption is gone rather than narrowed: `sweepReconciled` is set by
    // one thing only, a sweep that ran and exited 0. Both flags therefore fail
    // closed here for the same reason, without either being special-cased —
    // which is the point, since this guard shipped one hole per round while it
    // was built by exempting signals one at a time.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_nocount_terminal", "**rejected**")],
    });
    await park(stateDir, "PRRT_nocount_terminal", "thread");
    const r = await probeIn(dir, stateDir, HEAD, ["--no-count"], {
      reconcile: true,
    });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--no-count");
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("--no-count still certifies CONVERGED — announce-merge-ready.ts’s own re-read depends on it", async () => {
    // CONVERGED has its own narrower gate (drive-status.ts, next to
    // UNRECONCILED_STOPPERS) rather than blanket membership in that set,
    // because a first cut of this fix DID add it blanket and broke exactly
    // this: `announce-merge-ready.ts` calls this script with `--no-count`
    // (SKILL.md §§ 3 and 6) specifically to check CONVERGED without spending
    // a round, and CONVERGED is the only verdict that caller ever acts on.
    // `--no-count` suppresses the sweep every time, so `sweepReconciled` can
    // never be true on that call — folding CONVERGED into the blanket set
    // made it permanently unreachable through the one path built to reach it
    // without a sweep. The `announce-merge-ready.ts` describe block's own
    // tests caught it: most of the block failed, each expecting a real exit
    // code and getting `1` instead. This is the regression test for that: an
    // otherwise textbook-CONVERGED fixture must still read CONVERGED under
    // `--no-count`, unaffected by this guard.
    const { dir, stateDir } = writeFixture({ threads: [], reviewedSha: HEAD });
    const r = await probeIn(dir, stateDir, HEAD, ["--no-count"], {
      reconcile: true,
    });

    expect(r.state).toBe("CONVERGED");
    expect(r.exitCode).toBe(3);
  });

  it("--no-reconcile still certifies CONVERGED too — the same exemption, the other flag", async () => {
    // The sibling of the probe above: `--no-reconcile` suppresses the sweep
    // the same way `--no-count` does (`sweepSuppressed = noCount ||
    // noReconcile`), so it must leave CONVERGED reachable for the same
    // reason, even though nothing in this skill actually calls it with
    // `--no-reconcile` today — the guard does not get to special-case one
    // suppressing flag over the other.
    const { dir, stateDir } = writeFixture({ threads: [], reviewedSha: HEAD });
    const r = await probeIn(dir, stateDir, HEAD, ["--no-reconcile"], {
      reconcile: true,
    });

    expect(r.state).toBe("CONVERGED");
    expect(r.exitCode).toBe(3);
  });

  it("a sweep that actually RUNS and FAILS degrades an otherwise-CONVERGED PR to INDETERMINATE", async () => {
    // Mutation-tests `convergedUnswept` itself, which neither probe above
    // does: both suppress the sweep via a flag, so `sweepRanAndFailed` can
    // never be true on either call and deleting the guard entirely would
    // leave both green. This fixture is the
    // other half — a COUNTING pass (no `--no-count`/`--no-reconcile`) where
    // the sweep subprocess genuinely spawns and exits nonzero, on a PR that
    // otherwise evaluates to zero unresolved threads. `evaluate()` on its
    // own would call that CONVERGED; the guard must withhold it instead.
    //
    // `sweepThreadListingFailsOnce` fails the sweep's OWN thread-listing call
    // (graphql call #1 of the whole invocation — the sweep always runs before
    // `evaluate()` does) while leaving `evaluate()`'s later, independent
    // listing (call #2) to succeed and see the `threads: []` fixture as
    // genuinely empty — exactly the "resolved on GitHub, but this pass's own
    // sweep could not certify it" shape `convergedUnswept`'s own comment
    // describes, without hand-rolling the full stale-held-cleanup scenario
    // that is only ONE of several ways the sweep can fail nonzero.
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: HEAD,
      sweepThreadListingFailsOnce: true,
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("reconciliation sweep");
    expect(r.stderr).toContain("exited");
  });

  // NOT COVERED HERE, and deliberately: a first cut of this fix's own gate
  // used `!sweepSuppressed && !sweepReconciled` for "the sweep ran and
  // failed", which is also true whenever the sweep never got a turn at all —
  // the loop-top spent-budget skip and the "liveness read just spent the
  // budget" skip both leave `sweepSuppressed` false too, since neither
  // `--no-count` nor `--no-reconcile` was passed. That produced a false
  // INDETERMINATE on a genuinely converged PR whose sweep was merely SKIPPED,
  // which is why `sweepRanAndFailed` below is a
  // dedicated flag set at exactly one call site — immediately after the
  // sweep subprocess itself exits nonzero — and nowhere else, including
  // neither skip branch. A black-box probe for the skip side of that
  // distinction needs `budgetLeftMs() <= 0` on the very first iteration, but
  // both `--timeout` and `--interval` are floored at `MIN_INTERVAL` (5s) by
  // the CLI's own validation, and the one call whose OWN kill-timeout could
  // be raced against that budget (`ghCall`'s liveness read, a few lines
  // above `sweepRanAndFailed`'s call site) clamps its `timeoutSec` to
  // `budgetLeftMs()` itself — so hanging it via `DRIVE_PR_STUB_HANG` either
  // finishes under the clamp (budget still positive, skip never fires) or
  // gets killed BY the clamp (a genuinely unreadable read, a different
  // branch entirely). There is no window to land the hang exactly on the
  // budget boundary without a wall-clock race this suite's existing hang
  // mechanism cannot avoid, so this fix's skip-path correctness rests on
  // `sweepRanAndFailed` having exactly one set site — reviewed, not
  // black-box tested.

  it("a failing sweep is re-attempted on EVERY poll, not a bounded few", async () => {
    // The docs say the sweep is re-attempted on each poll, which is what makes
    // a `4` returned after the whole `--timeout` window mean something. A
    // MAX_QUERY_ERRORS cap made that false after three attempts, leaving the
    // loop still polling but no longer trying to fix what it was waiting on —
    // so a transient helper failure that cleared mid-window was never retried.
    //
    // Counted via the sweep's OWN liveness probe (`--json state`, that field
    // alone), which is one per attempt. `4` is the verdict of every
    // evaluation, so this measures the retry rather than any degrade path.
    // The window can still end on one of the two deadline guards instead,
    // each stopping as INDETERMINATE: the post-sweep overrun guard, when the
    // deadline expires *during* a sweep, and the loop-top guard, when a
    // scheduling delay carries a permitted sleep past it. Which stop ends the
    // run is wall-clock timing, not behaviour, so all three are accepted —
    // exit 1 only with one of those guards' own diagnostics.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_retry_forever", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    writeFileSync(join(dir, "resolve-thread-fails"), "");
    const r = await probeIn(
      dir,
      stateDir,
      HEAD,
      // This probe needs strictly more than MAX_QUERY_ERRORS attempts, so the
      // window must hold at least three polls even when each iteration's
      // spawns take seconds: 1s polls (the `--interval` floor lowered through
      // its test pacing seam) in an 8s window.
      ["--timeout", "8", "--interval", "1"],
      {
        reconcile: true,
        once: false,
        env: { DRIVE_PR_STATUS_MIN_INTERVAL: "1" },
      },
    );

    if (r.exitCode === 1) {
      expect(r.stderr).toMatch(
        /budget was spent (by the replied-thread reconciliation sweep|before this iteration could reconcile and judge)/,
      );
    } else {
      expect(r.exitCode).toBe(4);
    }
    const attempts = Number.parseInt(
      readFileSync(join(dir, "live-probes"), "utf8"),
      10,
    );
    // Strictly more than the old cap — the assertion is "it did not stop at
    // three", not an exact count, which would pin poll timing rather than the
    // behaviour.
    expect(attempts).toBeGreaterThan(3);
    // Explicit per-test budget, far above the suite's 30s default: this
    // probe is the most expensive one in the file under load.
    //
    // Its logic is only ~8s (`--timeout 8`, and the run ends with the gate's
    // own "gave up after 8s"). The rest is subprocess fan-out: >
    // MAX_QUERY_ERRORS poll iterations is the irreducible floor for the
    // assertion below, and EACH iteration spawns a real sweep —
    // `reconcile-replied-threads.ts`, which spawns `list-unresolved-threads.ts`,
    // `resolve-thread.ts` and `summary-findings.ts` — on top of `evaluate()`'s
    // own helper spawns.
    //
    // Kept at that price because the property is a twice-reported defect
    // and nothing
    // cheaper distinguishes "retried on every poll" from the capped variant
    // that shipped and had to be removed. But it IS the concrete instance of
    // what lefthook.yml's own timeout comment warns about — "growth past this
    // is a signal to make the suite cheaper (the probes each spawn a real
    // drive-status.ts), not to bump again" — so it is the first thing to
    // reach for if this suite needs to get cheaper.
  }, 300_000);

  it("a REOPENED PR retracts the finished-skip and sweeps before ROUND_READY", async () => {
    // The liveness probe skips the sweep on a positively-finished PR, which is
    // correct — until the evaluation, an independent later snapshot,
    // disagrees. GitHub permits a closed PR to be reopened, and the stopper
    // guard alone did not cover it: `sweepReconciled` stayed false but exit 0
    // is not a stopper, so a reopened PR was handed a ROUND_READY that never
    // swept — contradicting this gate's own contract that reconciliation
    // happens before any verdict at all.
    //
    // Modelled with the probe's `--json state` read answering CLOSED once and
    // every later read answering OPEN, which is exactly the reopen window.
    //
    // POLLING mode, because retracting means re-running `evaluate()` and
    // `--once` is a promise to evaluate once — under it the gate defers to the
    // caller's next invocation instead (see the sibling probe below). This is
    // the mode where the retraction actually runs.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_reopened", "**rejected**")],
      checkRuns: [DORMANT_ARM],
      liveProbeSaysClosedOnce: true,
    });
    // The retraction takes one iteration: the branch `continue`s WITHOUT
    // sleeping, so the second iteration's sweep happens immediately. An
    // `--interval` as long as the whole `--timeout` never fits after that, so
    // the ordinary `case 4` afterwards gives up instead of sleeping, while the
    // 6s window still leaves the first iteration seconds to spare under load.
    const r = await probeIn(
      dir,
      stateDir,
      HEAD,
      ["--timeout", "6", "--interval", "6"],
      { reconcile: true, once: false },
    );

    // The verdict is the ordinary one for this fixture — the retraction is
    // about WHAT RAN, not about degrading the answer.
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("retracting the skip");
    // The load-bearing assertion: the thread got reconciled anyway.
    expect(resolvedIn(dir)).toEqual(["PRRT_reopened"]);
  }, 120_000);

  it("a PERSISTENT finished/open disagreement terminates INDETERMINATE, never unswept", async () => {
    // The retraction `continue`s past the verdict switch, where every budget
    // in this loop lives, and two earlier bounds for it were wrong in opposite
    // directions: a bare flag was no bound (the next iteration's read set it
    // again, looping forever, `--once` included), and a one-shot latch bounded
    // the loop but let a SECOND disagreement through unswept — reopening the
    // hole the branch exists to close.
    //
    // This fixture is the one that actually reaches the branch repeatedly: the
    // single-field probe says CLOSED on every call while the fuller snapshot
    // keeps reporting the PR open. An earlier version of this probe used an
    // UNREADABLE snapshot instead, which made `evaluate()` return 1 — and
    // production requires `code !== 1` to enter the retraction at all, so it
    // was asserting ordinary `case 1` termination and would have stayed green
    // against exactly the loop it claimed to guard.
    //
    // Both failure modes are covered by the two assertions together:
    // terminating at all rules out the loop, and INDETERMINATE rather than a
    // verdict rules out the unswept-ROUND_READY the latch permitted.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_retract_loop", "**rejected**")],
      liveProbeSaysClosedAlways: true,
    });
    // POLLING mode, not `--once`: under `--once` the first disagreement degrades
    // before the retraction counter advances, so a `--once` run passes with the
    // retraction bound deleted.
    // `--timeout 30 --interval 30` leaves no room for a second poll, so the run
    // ends without sleeping once the retractions are spent. The deadline leaves
    // enough time for the subprocess probes on a loaded test machine.
    const r = await probeIn(
      dir,
      stateDir,
      HEAD,
      ["--timeout", "30", "--interval", "30"],
      { reconcile: true, once: false },
    );

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    // Never swept, so never resolved — and, crucially, never judged either.
    expect(resolvedIn(dir)).toEqual([]);
    // The bound itself, pinned to the path that enforces it rather than to a
    // range the poll deadline could also land in: the initial probe plus
    // exactly one per permitted retraction (the retraction budget is
    // MAX_QUERY_ERRORS = 3), the three retraction notices, and the degrade
    // reason only the exhausted-budget branch emits. Were the count bound
    // removed the loop would spin until the deadline instead — many more
    // probes, and no such reason.
    const attempts = Number(readFileSync(join(dir, "live-probes"), "utf8"));
    expect(attempts).toBe(1 + 3);
    expect(r.stderr.split("retracting the skip").length - 1).toBe(3);
    expect(r.stderr).toContain("disagree persistently");
  });

  it("--once does not retract — it evaluates once and defers", async () => {
    // The retraction is the only path in this loop that re-runs `evaluate()`
    // without sleeping, so it was quietly breaking `--once`'s promise to
    // evaluate once. Under `--once` the same
    // disagreement degrades on the FIRST occurrence instead, which is the
    // answer this gate gives everywhere else in that mode: the caller comes
    // back, and its next pass entry sweeps.
    //
    // Same fixture as the polling reopen probe above; only the mode differs,
    // so the two together pin the mode-dependent behaviour rather than one
    // pinning an accident of the other's flags.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_once_no_retract", "**rejected**")],
      checkRuns: [DORMANT_ARM],
      liveProbeSaysClosedOnce: true,
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("degrade() stops at the poll DEADLINE, not only at the retry count", async () => {
    // `degrade()` bounded retries by count alone, and it is reached from paths
    // that did not exist when the loop's only deadline check was placed down
    // in `case 4` — so it overran `--timeout`: with `--timeout 5 --interval 5`
    // an unreadable liveness probe slept twice and returned after 10s+.
    //
    // Asserted by ATTEMPT COUNT rather than elapsed time, which would pin the
    // machine rather than the bound: one interval already exhausts this
    // deadline, so exactly one attempt may run. The count-only bound would
    // allow MAX_QUERY_ERRORS of them.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_deadline", "**rejected**")],
      checkRuns: [DORMANT_ARM],
      liveProbeFails: true,
    });
    const r = await probeIn(
      dir,
      stateDir,
      HEAD,
      ["--timeout", "5", "--interval", "5"],
      { reconcile: true, once: false },
    );

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(readFileSync(join(dir, "live-probes"), "utf8")).toBe("1");
  });

  it("an UNRECOGNISED state is unreadable, not a confirmed finished PR", async () => {
    // The skip used to fire on "not exactly OPEN", so a malformed `-q` result
    // or a state GitHub adds later would suppress the sweep and then license a
    // verdict that ends the drive. Only CLOSED and MERGED positively mean
    // finished; everything else takes the retry path.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_weird_state", "**rejected**")],
      prState: "UNKNOWN",
    });
    await park(stateDir, "PRRT_weird_state", "thread");
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("does not sweep on a --no-count re-read — one sweep per pass, not per status read", async () => {
    // SKILL.md §§ 3 and 6 both re-read the gate mid-round with --no-count, as
    // does announce-merge-ready.ts. Those are re-reads inside a round whose
    // entry already swept; re-sweeping on each would multiply the sweep by
    // however many times a pass consults the gate.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_reread", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, ["--no-count"], {
      reconcile: true,
    });

    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("--no-reconcile opts out explicitly", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_optout", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, ["--no-reconcile"], {
      reconcile: true,
    });

    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("leaves an ordinary unanswered thread alone — no reply, nothing to reconcile", async () => {
    // The sweep is scoped to threads that ALREADY carry a trusted outcome
    // token. Running it on every pass must not touch live work, or the gate
    // would be resolving findings nobody triaged.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_live", path: "a.ts", bot: true }],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual([]);
    expect(await heldKeysIn(stateDir)).toBe("");
  });

  it("does NOT sweep a MERGED PR — liveness is read ahead of the mutation", async () => {
    // "A merged or closed PR stops the loop before the round spends anything"
    // is SKILL.md § 1's opening contract, and the sweep is a MUTATION: it
    // resolves threads and writes unconfirmed holds. Placing it ahead of
    // `evaluate()` — which is the only thing that reads liveness — made those
    // mutations land on a finished pull request before the gate ever returned
    // PR_NOT_OPEN. The same fixture that resolves on every stuck-but-open
    // verdict above must resolve NOTHING here, which is what separates a
    // liveness guard from the sweep simply not running.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_merged", "**rejected**")],
      checkRuns: [DORMANT_ARM],
      prState: "MERGED",
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
    expect(resolvedIn(dir)).toEqual([]);
    expect(await heldKeysIn(stateDir)).toBe("");
  });
});
