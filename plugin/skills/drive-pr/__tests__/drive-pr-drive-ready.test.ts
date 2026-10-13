/**
 * drive-pr suite: mark-ready.ts, and drive.ts marking a draft Ready
 * (pull_requests.mark_ready, --keep-draft).
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "../../resolve-review-comments/scripts/lib/yaml.ts";

import {
  SCRIPTS,
  binDir,
  scratchClean,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import {
  PASS_LOUD,
  PASS_NOOP,
  runDrive,
  runDriveIn,
  state,
} from "./drive-loop-harness.ts";

useDrivePrSuite();

// The draft→Ready transition. Repo policy births every PR as a draft;
// `example-review` reviews drafts (measured 2026-08-13) and
// CodeRabbit refuses them ("Review skipped / Draft detected"), so marking the PR
// Ready is how the paid reviewer's one pass gets spent on a head the drive has
// already cleaned up. `gh pr ready` is an outward-facing, review-summoning
// event, which is why every test here is about firing it AT MOST ONCE and never
// against a human's later decision.
describe("mark-ready.ts", () => {
  async function markReady(
    dir: string,
    stateDir: string,
    args: string[] = [],
    env: Record<string, string> = {},
  ) {
    const proc = Bun.spawn([join(SCRIPTS, "mark-ready.ts"), "999", ...args], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        DRIVE_PR_FIXTURES: dir,
        DRIVE_PR_STATE_DIR: stateDir,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { outcome: stdout.trim(), stderr, exitCode };
  }

  /** Any drive-state.ts command against this describe block's state dir. */
  async function markReadyState(stateDir: string, args: string[]) {
    const proc = Bun.spawn([join(SCRIPTS, "drive-state.ts"), ...args], {
      env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  async function readyMarked(stateDir: string): Promise<string> {
    const proc = Bun.spawn(
      [join(SCRIPTS, "drive-state.ts"), "ready-marked", "999"],
      {
        env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return stdout.trim();
  }

  const calls = (dir: string): string[] =>
    existsSync(join(dir, "ready-calls"))
      ? readFileSync(join(dir, "ready-calls"), "utf8").trim().split("\n")
      : [];

  it("--round applies pull_requests.mark_ready: not due before round N, due from it", async () => {
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    const overlay = join(dir, "mark-ready-overlay.yaml");
    writeFileSync(overlay, "pull_requests:\n  mark_ready: 2\n");
    const early = await markReady(dir, stateDir, ["--round", "1"], {
      JIG_OVERLAY: overlay,
    });
    expect(early).toMatchObject({ outcome: "not-due", exitCode: 0 });
    expect(calls(dir)).toEqual([]);
    const due = await markReady(dir, stateDir, ["--round", "2"], {
      JIG_OVERLAY: overlay,
    });
    expect(due.outcome).toBe("marked");
    expect(calls(dir)).toEqual(["999"]);
    expect((await markReady(dir, stateDir, ["--round", "x"])).exitCode).toBe(2);
  });

  it("marks a draft Ready, once, and records it durably", async () => {
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    const first = await markReady(dir, stateDir);
    expect(first.exitCode).toBe(0);
    expect(first.outcome).toBe("marked");
    expect(calls(dir)).toEqual(["999"]);
    expect(await readyMarked(stateDir)).not.toBe("0");

    // The second call is the one that matters: every round makes it.
    const second = await markReady(dir, stateDir);
    expect(second.exitCode).toBe(0);
    expect(second.outcome).toBe("already-marked");
    expect(calls(dir)).toEqual(["999"]);
  });

  it("does NOT re-mark a PR a human converted back to draft", async () => {
    // The re-arm loop aimed at a person: a transition re-derived from the live
    // `isDraft` would undo a deliberate human decision on the next round, and
    // the round after that, forever. The durable claim is read BEFORE the PR is
    // looked at, so the live flag cannot re-arm it.
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    expect((await markReady(dir, stateDir)).outcome).toBe("marked");

    // The stub flipped pr-view.json to isDraft:false when it marked; put it
    // back, exactly as a human clicking "Convert to draft" would.
    const view = JSON.parse(
      readFileSync(join(dir, "pr-view.json"), "utf8"),
    ) as Record<string, unknown>;
    view.isDraft = true;
    writeFileSync(join(dir, "pr-view.json"), JSON.stringify(view));

    const again = await markReady(dir, stateDir);
    expect(again.outcome).toBe("already-marked");
    expect(calls(dir)).toEqual(["999"]);
  });

  it("an unrecognized `state` value on the already-marked liveness check is INDETERMINATE, not not-open", async () => {
    // readSnapshot() used to validate only that `state` was non-empty, so any
    // value other than the three real ones — a malformed response, or a future
    // GitHub enum value this script does not know about — passed straight
    // through as `kind: 'ok'`. The already-marked liveness check then read it
    // via `liveness.state !== 'OPEN'`, which is also true for a genuinely
    // unreadable value, and reported the PR permanently `not-open` (exit 5)
    // instead of the retriable `unreadable` failure (exit 1) an unrecognized
    // value actually is.
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    expect((await markReady(dir, stateDir)).outcome).toBe("marked");

    const view = JSON.parse(
      readFileSync(join(dir, "pr-view.json"), "utf8"),
    ) as Record<string, unknown>;
    view.state = "UNKNOWN";
    writeFileSync(join(dir, "pr-view.json"), JSON.stringify(view));

    const again = await markReady(dir, stateDir);
    expect(again.exitCode).toBe(1);
    // Nothing on stdout: `fail()` never reaches the `not-open` write, so this
    // is a stronger check than merely "not literally 'not-open'".
    expect(again.outcome).toBe("");
    expect(again.stderr).toContain("liveness could not be confirmed");
    expect(again.stderr).toContain("unrecognized 'state' value 'UNKNOWN'");
  });

  it("--record-only NEVER dispatches, even when its own live read observes a draft", async () => {
    // A caller reaching for --record-only wants a durable record BEFORE a
    // draft flip can matter — the whole point is that it must be structurally
    // incapable of firing `gh pr ready` itself, since an ordinary call
    // observing a draft here is precisely the TOCTOU window that flag exists
    // to close. isDraft: true models either a genuine draft or the race
    // landing before this read; the guarantee must hold identically either
    // way, since the code cannot tell them apart.
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    const r = await markReady(dir, stateDir, ["--record-only"]);
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("still-draft");
    // No dispatch, no lease taken, no durable record — this call achieved
    // nothing and claims nothing, leaving the transition entirely to a later,
    // ordinary call.
    expect(calls(dir)).toEqual([]);
    expect(existsSync(join(stateDir, "drive-pr-999.ready-claim"))).toBe(false);
    expect(await readyMarked(stateDir)).toBe("0");
  });

  it("--record-only still records an already-Ready observation normally", async () => {
    // The guard only gates the DRAFT dispatch path — recording "already
    // Ready" never dispatches in the first place, record-only or not, so it
    // must behave identically to the ordinary call.
    const { dir, stateDir } = writeFixture({ threads: [] });
    const r = await markReady(dir, stateDir, ["--record-only"]);
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("already-ready");
    expect(calls(dir)).toEqual([]);
    expect(await readyMarked(stateDir)).not.toBe("0");
  });

  it("checks liveness even on the durable-marker fast path — a PR that closed after being marked reports not-open, not already-marked", async () => {
    // The durable-marker branch is a fast path specifically because it skips
    // the network call in the common case — but skipping it entirely means a
    // PR that merged or closed AFTER the mark was written still reports
    // `already-marked` (exit 0). On a caller for which that exit IS the final
    // report (the converged-with-no-round-to-run path in drive.ts), that
    // falsely claims full convergence about a PR that is no longer open.
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    expect((await markReady(dir, stateDir)).outcome).toBe("marked");

    const view = JSON.parse(
      readFileSync(join(dir, "pr-view.json"), "utf8"),
    ) as Record<string, unknown>;
    view.state = "MERGED";
    writeFileSync(join(dir, "pr-view.json"), JSON.stringify(view));

    const again = await markReady(dir, stateDir);
    expect(again.outcome).toBe("not-open");
    expect(again.exitCode).toBe(5);
    // No second dispatch — the durable mark from the first call stands.
    expect(calls(dir)).toEqual(["999"]);
  });

  it("checks the AUTHORITATIVE state, not just draftness, after a failed gh pr ready", async () => {
    // A lost-response reconciliation read used to decide purely from
    // `after.draft` — so a PR that concurrently merged or closed could read
    // back non-draft (wrongly committed and reported `marked`) or still-draft
    // (wrongly released and reported an ordinary transition failure). Either
    // way the correct answer is `not-open`, since the transition cannot have
    // meaningfully applied to a PR that no longer exists as an open draft.
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    writeFileSync(join(dir, "pr-ready-fails-after-applying"), "");
    // The stub's lost-response path flips isDraft to false on pr-view.json —
    // simulate the PR ALSO having merged concurrently.
    const view = JSON.parse(
      readFileSync(join(dir, "pr-view.json"), "utf8"),
    ) as Record<string, unknown>;
    view.state = "MERGED";
    writeFileSync(join(dir, "pr-view.json"), JSON.stringify(view));

    const r = await markReady(dir, stateDir);
    expect(r.outcome).toBe("not-open");
    expect(r.exitCode).toBe(5);
    // Not recorded as marked: the PR is gone, not Ready.
    expect(await readyMarked(stateDir)).toBe("0");
  });

  it("is a no-op on a PR that is already Ready, and records that too", async () => {
    // Recorded rather than left at 0, so later rounds answer from state instead
    // of asking `gh` again on every one of them.
    const { dir, stateDir } = writeFixture({ threads: [] });
    const r = await markReady(dir, stateDir);
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("already-ready");
    expect(calls(dir)).toEqual([]);
    expect(await readyMarked(stateDir)).not.toBe("0");
  });

  it("refuses on a PR that is not open — liveness wins over draftness", async () => {
    // GitHub keeps `isDraft` TRUE on a closed draft, so an isDraft-only read
    // would cheerfully mark a closed PR Ready. The fixture is both.
    const { dir, stateDir } = writeFixture({
      threads: [],
      isDraft: true,
      prState: "CLOSED",
    });
    const r = await markReady(dir, stateDir);
    expect(r.exitCode).toBe(5);
    expect(r.outcome).toBe("not-open");
    expect(calls(dir)).toEqual([]);
    expect(await readyMarked(stateDir)).toBe("0");
  });

  it('refuses on an absent isDraft rather than reading it as "already Ready"', async () => {
    // The silent-skip shape: a partial response coerces to `false`, which is
    // the answer that means "nothing owed" — so accepting it would skip the
    // transition on the one PR that needs it, and record nothing, leaving the
    // skip invisible afterwards.
    const { dir, stateDir } = writeFixture({
      threads: [],
      isDraftAbsent: true,
    });
    const r = await markReady(dir, stateDir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("isDraft");
    expect(calls(dir)).toEqual([]);
    expect(await readyMarked(stateDir)).toBe("0");
  });

  it("PRESERVES its claim when gh pr ready fails with the PR still an open draft — ambiguous, not proof it never applied", async () => {
    // A nonzero `gh pr ready` exit plus an OPEN-draft follow-up read is NOT
    // proof the request never applied: it applied server-side, the response
    // was lost, AND a human converted the PR back to draft before this read
    // completed would look IDENTICAL. Releasing the lease here (an earlier
    // version did) makes an unconfirmed remote effect immediately retryable
    // — safe for the genuine-failure case, but a duplicate `ready_for_review`
    // (or a reversed human decision) for the applied-then-reverted case this
    // local evidence cannot rule out. So the lease is retained either way.
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    writeFileSync(join(dir, "pr-ready-fails"), "");
    const r = await markReady(dir, stateDir);
    expect(r.exitCode).toBe(1);
    expect(await readyMarked(stateDir)).toBe("0");
    expect(existsSync(join(stateDir, "drive-pr-999.ready-claim"))).toBe(true);

    // An immediate retry does NOT re-fire — this process's own still-live
    // lease blocks it, exactly as a second driver's would. `calls(dir)`
    // already has one entry from the failed attempt above; the assertion is
    // that it stays at one, not that it's empty.
    rmSync(join(dir, "pr-ready-fails"));
    const immediateRetry = await markReady(dir, stateDir);
    expect(immediateRetry.outcome).toBe("claimed-by-other");
    expect(calls(dir)).toEqual(["999"]);

    // Once the lease goes stale, a later round takes the transition over —
    // same recovery as any other abandoned lease.
    const lease = join(stateDir, "drive-pr-999.ready-claim");
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(lease, twentyMinutesAgo, twentyMinutesAgo);
    const retry = await markReady(dir, stateDir);
    expect(retry.exitCode).toBe(0);
    expect(retry.outcome).toBe("marked");
    expect(await readyMarked(stateDir)).not.toBe("0");
  });

  it("records a non-zero round even when no round has been counted yet", async () => {
    // `0` is the "never marked" sentinel, and a drive that converges on its
    // first gate claims before any round exists. A claim recorded as 0 would be
    // indistinguishable from no claim, and the next driver would mark the PR
    // Ready a second time — so the recorded value is floored at 1.
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    expect((await markReady(dir, stateDir)).outcome).toBe("marked");
    expect(await readyMarked(stateDir)).toBe("1");
  });

  // TWO CONCURRENT DRIVERS, one event. The property the exclusivity mechanism
  // exists for, and until now the one property no test could go red on: the
  // suite's own comment recorded that deleting the compare-and-set outright
  // left everything green, because every test ran ONE mark-ready.ts at a time
  // and the window between claiming and firing is microseconds wide.
  //
  // `$DRIVE_PR_MARK_READY_TEST_SIGNAL` and `..._DELAY` make that window wide
  // and observable: the winner touches the signal file the instant it holds
  // the lease, then sleeps inside it. The second driver starts only after the
  // signal appears, so it is GUARANTEED to be running while the first holds
  // the lease, rather than merely likely to be.
  it("lets exactly ONE of two concurrent drivers fire gh pr ready", async () => {
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    // No flip, so the loser cannot be stopped by the live `isDraft` flag —
    // the lease is the only thing standing between it and a second event.
    writeFileSync(join(dir, "pr-ready-no-flip"), "");
    const signal = join(dir, "lease-held");

    const winner = markReady(dir, stateDir, [], {
      DRIVE_PR_MARK_READY_TEST_SIGNAL: signal,
      DRIVE_PR_MARK_READY_TEST_DELAY: "2",
    });
    // Wait for the winner to actually hold the lease before starting the
    // second driver. Polling a file, not sleeping a guessed interval.
    const deadline = Date.now() + 10_000;
    while (!existsSync(signal)) {
      if (Date.now() > deadline) throw new Error("lease signal never appeared");
      await Bun.sleep(10);
    }
    const loser = await markReady(dir, stateDir);
    const first = await winner;

    // THE property, asserted first so a regression reports it rather than
    // whatever downstream assertion happens to trip: one event, not two.
    // Mutation-checked 2026-08-13 by removing the lease's exclusivity — this
    // line goes red with two recorded calls.
    expect(calls(dir)).toEqual(["999"]);
    expect(first.outcome).toBe("marked");
    expect(first.exitCode).toBe(0);
    // The loser is told plainly, and exits 0 — it owes nothing, and must not
    // fail a round over another driver doing the work.
    expect(loser.outcome).toBe("claimed-by-other");
    expect(loser.exitCode).toBe(0);
  });

  it("takes over a lease abandoned by a driver that DIED mid-transition", async () => {
    // The crash the old one-field design could not survive: a process killed
    // between claiming and `gh pr ready` left the durable mark non-zero
    // forever, so every later invocation answered `already-marked` without
    // asking GitHub and the PR stayed a draft nothing would ever mark
    //. The lease has no failure branch
    // to skip — it expires — and the record is written only on confirmation,
    // so the recovery needs no reconciliation against a live flag that would
    // undo a human's own re-draft.
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    // Exactly what the dead driver left behind: a lease file, no record.
    const leaseFile = join(stateDir, "drive-pr-999.ready-claim");
    writeFileSync(leaseFile, "dead-driver-token");
    expect(await readyMarked(stateDir)).toBe("0");

    // While it is still LIVE, the transition stays that driver's to make.
    const early = await markReady(dir, stateDir);
    expect(early.outcome).toBe("claimed-by-other");
    expect(calls(dir)).toEqual([]);

    // Once it goes stale, the next round takes it over and finishes the job.
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(leaseFile, twentyMinutesAgo, twentyMinutesAgo);
    const recovered = await markReady(dir, stateDir);
    expect(recovered.outcome).toBe("marked");
    expect(calls(dir)).toEqual(["999"]);
    expect(await readyMarked(stateDir)).not.toBe("0");
  });

  it("treats a FAILED gh pr ready that actually applied as marked, not as a retry", async () => {
    // A non-zero exit is not proof the transition did not happen: a request
    // that succeeded server-side and then timed out, or whose response was
    // lost, exits non-zero with the PR already Ready. Releasing the lease on
    // that reading lets a later round fire `ready_for_review` a SECOND time —
    // the paid-review re-trigger this mechanism exists to prevent, and a way
    // to undo a human who converted the PR back to draft in between.
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    // The stub records the call, flips the view to Ready, and THEN fails —
    // exactly the lost-response shape.
    writeFileSync(join(dir, "pr-ready-fails-after-applying"), "");
    const r = await markReady(dir, stateDir);
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("marked");
    expect(r.stderr).toContain("request landed and the response did not");
    // Recorded, so no later round re-fires it.
    expect(await readyMarked(stateDir)).not.toBe("0");
    expect(calls(dir)).toEqual(["999"]);

    const again = await markReady(dir, stateDir);
    expect(again.outcome).toBe("already-marked");
    expect(calls(dir)).toEqual(["999"]);
  });

  it("does not fire the event when the lease was reclaimed while this process was suspended", async () => {
    // Winning the lease and firing are two moments, and everything between
    // them is this process's own runtime — which can be suspended for
    // arbitrarily long (a laptop sleeping is the ordinary case). Past the
    // staleness window another driver legitimately reclaims the lease and
    // fires the event itself; without a check at the dispatch point this
    // process resumes and fires a SECOND `ready_for_review`.
    //
    // The suspension is modelled by the delay hook, and the reclaim by
    // replacing the lease file's token — which is exactly what a recovery
    // does: break the stale claim, write a fresh one.
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    writeFileSync(join(dir, "pr-ready-no-flip"), "");
    const signal = join(dir, "lease-held");
    const leaseFile = join(stateDir, "drive-pr-999.ready-claim");

    const running = markReady(dir, stateDir, [], {
      DRIVE_PR_MARK_READY_TEST_SIGNAL: signal,
      DRIVE_PR_MARK_READY_TEST_DELAY: "2",
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(signal)) {
      if (Date.now() > deadline) throw new Error("lease signal never appeared");
      await Bun.sleep(10);
    }
    writeFileSync(leaseFile, "a-different-drivers-token");
    const r = await running;

    // THE property: no event fired on a lease this process no longer owns.
    expect(calls(dir)).toEqual([]);
    expect(r.outcome).toBe("claimed-by-other");
    expect(r.exitCode).toBe(0);
    // And the reclaiming driver's lease is left intact — not released by the
    // process that merely used to own it.
    expect(readFileSync(leaseFile, "utf8")).toBe("a-different-drivers-token");
    expect(await readyMarked(stateDir)).toBe("0");
  });

  it("treats a renewal CONFIGURATION error as this process's own failure, not another driver", async () => {
    // `renew-ready-mark` refuses with exit 2 BEFORE ever checking the token
    // when the staleness window cannot cover one outbound call's deadline —
    // that is this process's own bad environment, not evidence of
    // contention. Reporting it as `claimed-by-other` falsely blamed a driver
    // that does not exist, and — because the config does not change with
    // time the way a genuinely stale lease does — every later round hit the
    // identical refusal and repeated the same false blame forever.
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    const leaseFile = join(stateDir, "drive-pr-999.ready-claim");
    const r = await markReady(dir, stateDir, [], {
      DRIVE_PR_CLAIM_STALE_MIN: "1",
      GH_CALL_TIMEOUT: "120",
    });

    // Not `claimed-by-other`: this drive's OWN transition failed.
    expect(r.outcome).toBe("");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("configuration error, not another driver");
    // Never fired the event on an unverified lease.
    expect(calls(dir)).toEqual([]);
    // And the lease this process itself won is released — not abandoned to
    // expire, which would report the identical false contention every round
    // until the staleness window happened to pass.
    expect(existsSync(leaseFile)).toBe(false);
    expect(await readyMarked(stateDir)).toBe("0");
  });

  it("reports claimed-by-other on the ALREADY-Ready path rather than claiming durable success", async () => {
    // `claimAndCommit` can come back `claimed-by-other`, and that is not the
    // durable record this branch's own comment promises: the other holder may
    // die without ever writing `readyMarkedRound`, and if a human converts the
    // PR back to draft before some later round records it, the drive sees zero
    // and undoes that decision.
    const { dir, stateDir } = writeFixture({ threads: [] });
    writeFileSync(
      join(stateDir, "drive-pr-999.ready-claim"),
      "another-drivers-token",
    );
    const r = await markReady(dir, stateDir);
    expect(r.outcome).toBe("claimed-by-other");
    expect(r.exitCode).toBe(0);
    expect(await readyMarked(stateDir)).toBe("0");
    expect(calls(dir)).toEqual([]);
  });

  it("fails closed when recording an ALREADY-Ready PR does not stick", async () => {
    // The branch that used to fire the record and never look at the result.
    // Leaving it at 0 is not the cost-only outcome it looks like: this drive
    // then owes no transition with no durable evidence of it, so a later round
    // — after a human converts the PR BACK to draft — reads 0, sees a draft,
    // and re-marks it, undoing that decision.
    const { dir, stateDir } = writeFixture({ threads: [] });
    // A READABLE state that cannot be WRITTEN — the shape that separates this
    // branch from the earlier unreadable-state refusal. The store writes a
    // temp file beside the target and renames it, so a read-only state
    // directory fails every write and no read.
    await markReadyState(stateDir, ["phase", "999", "--set", "probe"]);
    chmodSync(stateDir, 0o555);
    try {
      const r = await markReady(dir, stateDir);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("recording that durably failed");
      expect(calls(dir)).toEqual([]);
    } finally {
      chmodSync(stateDir, 0o755);
    }
  });
});

describe("drive.ts loop control", () => {
  it("RUNS the pass on a DRAFT PR, then marks it Ready for review", async () => {
    // The retirement and the transition in one drive, because they are one
    // decision: drafts are driven (`example-review` reviews them), and the
    // reviewers that skip drafts are summoned only once the round has cleaned
    // up what the in-house one found. Before this the identical fixture exited
    // 10 without running the pass at all.
    //
    // The fixture has findings, so round 1 is dispatched; the stub pass changes
    // nothing, so the second gate would loop — `--max-rounds 1` stops it there,
    // which is enough to observe the post-round transition.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraft: true,
    });
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--max-rounds",
      "1",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.stderr).toContain("RAN_THE_PASS");
    expect(r.stderr).toContain("marked Ready for review");
    expect(readFileSync(join(dir, "ready-calls"), "utf8").trim()).toBe("999");
    // Durably recorded, so a later round — or a later drive — does not re-fire
    // an event that re-triggers paid external review.
    expect(
      (await state(stateDir, ["ready-marked", "999"])).stdout.trim(),
    ).not.toBe("0");
  });

  it("strips CLAUDECODE from the pass env — a nested spawn must not look like a nested Claude Code session", async () => {
    // do-item's "Arm the drive" step spawns drive.ts from INSIDE a live
    // Claude Code session, so drive.ts itself inherits CLAUDECODE=1. Passed
    // through unchanged to the `claude -p` pass command, that marker makes
    // the pass refuse to start as a nested session — silently, after this
    // process already reported the round as running. Simulate that inherited
    // env on drive.ts's own process and assert the pass never sees it.
    const PASS_CLAUDECODE_PROBE = [
      "sh",
      "-c",
      'echo "pass for 999: CLAUDECODE=${CLAUDECODE:-<unset>}" >&2; exit 0',
    ];
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      ["--no-head-sync", "--max-rounds", "1", "--", ...PASS_CLAUDECODE_PROBE],
      undefined,
      { env: { CLAUDECODE: "1" } },
    );
    expect(r.stderr).toContain("CLAUDECODE=<unset>");
  });

  it("marks Ready exactly ONCE across rounds, on the DURABLE claim not the live flag", async () => {
    // `gh pr ready` fires `ready_for_review`, which is what summons CodeRabbit.
    // Re-firing it every round would re-trigger a paid review of a head that
    // already had one — the cost this ordering exists to spend deliberately.
    //
    // `pr-ready-no-flip` is what makes this test about the DURABLE claim. It
    // models GitHub's replication lag: a `pr view` inside the window still
    // answering `isDraft: true` after the transition landed. With the ordinary
    // flip in place the live flag alone stops the second call, and this test
    // passes with the once-only check deleted outright — measured, which is why
    // the knob exists.
    //
    // Once-only is then defended in DEPTH, and this test was mutation-checked
    // against both layers (2026-08-13): mark-ready.ts's early `ready-marked`
    // read, and `claim-ready-mark`'s compare-and-set. Disabling EITHER one
    // alone leaves this green, because the other still holds; disabling both
    // fires `gh pr ready` on all three rounds and turns it red. So a future
    // edit that removes one layer will not be caught here — it will be caught
    // by the human-flip test below, which the early read alone answers, and by
    // the concurrent-driver property the CAS alone answers.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraft: true,
    });
    writeFileSync(join(dir, "pr-ready-no-flip"), "");
    // Three genuinely no-op rounds are the subject here, so the stall stop —
    // which would (correctly) end this drive at its third gate — is disabled
    // for the probe. The stall behaviour has its own probes below.
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--max-rounds", "3", "--", ...PASS_NOOP],
      undefined,
      { env: { DRIVE_PR_STALL_ROUNDS: "0" } },
    );
    expect(r.exitCode).toBe(6);
    expect(
      readFileSync(join(dir, "ready-calls"), "utf8").trim().split("\n"),
    ).toHaveLength(1);
  });

  it("--keep-draft suppresses the transition entirely", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraft: true,
    });
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--keep-draft",
      "--max-rounds",
      "1",
      "--",
      ...PASS_LOUD,
    ]);
    // The round still runs — `--keep-draft` opts out of the transition, not out
    // of driving drafts.
    expect(r.stderr).toContain("RAN_THE_PASS");
    expect(existsSync(join(dir, "ready-calls"))).toBe(false);
    expect((await state(stateDir, ["ready-marked", "999"])).stdout.trim()).toBe(
      "0",
    );
  });

  /**
   * The suite's own configuration (reviewer identities, markers) plus a
   * `pull_requests` section: replacing the file would change what
   * convergence means.
   */
  function withPolicy(dir: string, pullRequests: Record<string, unknown>) {
    const path = join(dir, "policy-overlay.json");
    const suite = loadYaml(
      readFileSync(process.env.JIG_OVERLAY as string, "utf8"),
    ) as Record<string, unknown>;
    writeFileSync(
      path,
      JSON.stringify({ ...suite, pull_requests: pullRequests }),
    );
    return { env: { JIG_OVERLAY: path } };
  }

  it("pull_requests.mark_ready: N waits for round N before marking Ready", async () => {
    const early = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraft: true,
    });
    const r1 = await runDriveIn(
      early.dir,
      early.stateDir,
      ["--no-head-sync", "--max-rounds", "1", "--", ...PASS_LOUD],
      undefined,
      withPolicy(early.dir, { mark_ready: 2 }),
    );
    expect(r1.stderr).toContain("RAN_THE_PASS");
    expect(existsSync(join(early.dir, "ready-calls"))).toBe(false);
  });

  it("pull_requests.mark_ready: N marks Ready once round N completes", async () => {
    const due = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraft: true,
    });
    const r2 = await runDriveIn(
      due.dir,
      due.stateDir,
      ["--no-head-sync", "--max-rounds", "2", "--", ...PASS_NOOP],
      undefined,
      {
        env: {
          ...withPolicy(due.dir, { mark_ready: 2 }).env,
          DRIVE_PR_STALL_ROUNDS: "0",
        },
      },
    );
    expect(r2.stderr).toContain("round 2 completed");
    expect(
      readFileSync(join(due.dir, "ready-calls"), "utf8").trim().split("\n"),
    ).toHaveLength(1);
  });

  it.each(["never", "converged"])(
    "pull_requests.mark_ready: %s does not mark Ready after a round",
    async (markReady) => {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
        isDraft: true,
      });
      const r = await runDriveIn(
        dir,
        stateDir,
        ["--no-head-sync", "--max-rounds", "1", "--", ...PASS_LOUD],
        undefined,
        withPolicy(dir, { mark_ready: markReady }),
      );
      expect(r.stderr).toContain("RAN_THE_PASS");
      expect(existsSync(join(dir, "ready-calls"))).toBe(false);
    },
  );

  it("pull_requests.mark_ready: never also keeps a converged draft a draft", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
      isDraft: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--", ...PASS_NOOP],
      undefined,
      withPolicy(dir, { mark_ready: "never" }),
    );
    // Converged and stopped normally, so the absent call is the policy, not a
    // drive that died before reaching the transition.
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("converged after");
    expect(existsSync(join(dir, "ready-calls"))).toBe(false);
  });

  it("pull_requests.mark_ready: converged marks a converged draft Ready", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
      isDraft: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--", ...PASS_NOOP],
      undefined,
      withPolicy(dir, { mark_ready: "converged" }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("converged after");
    expect(readFileSync(join(dir, "ready-calls"), "utf8").trim()).toBe("999");
  });

  it("--keep-draft still records an already-Ready PR via the round-loop pre-pass call", async () => {
    // `--keep-draft` exists to suppress the outward draft→Ready DISPATCH, not
    // the harmless, side-effect-free record of an already-Ready observation.
    // Skipping the record under --keep-draft left readyMarkedRound at 0 for a
    // PR this drive observed as already Ready, so a LATER ordinary
    // (non---keep-draft) drive — after a human converts that PR to draft —
    // could not tell a deliberate Ready→draft conversion from a PR that was
    // simply never marked, and would fire gh pr ready on it.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraft: false,
    });
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--keep-draft",
      "--max-rounds",
      "1",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.stderr).toContain("RAN_THE_PASS");
    // Never dispatched — --keep-draft still suppresses that.
    expect(existsSync(join(dir, "ready-calls"))).toBe(false);
    // But the already-Ready observation IS durably recorded.
    expect(
      (await state(stateDir, ["ready-marked", "999"])).stdout.trim(),
    ).not.toBe("0");
  });

  it("converging on an UNMARKED draft marks it Ready and re-gates, rather than reporting done", async () => {
    // The path the post-round transition cannot cover: a drive that converges
    // on its first gate never runs a pass. Reporting 0 there would say "the
    // review loop is done" about a PR CodeRabbit has never seen and, by repo
    // policy, never would — a false terminal reached from the one direction the
    // round loop has no hook in.
    //
    // Two re-gates, both bounded, exercised end to end here: the FIRST
    // CONVERGED dispatches (`marked`, which always re-gates); the stub then
    // rewrites pr-view.json to isDraft:false and the durable claim is set, so
    // the SECOND CONVERGED takes the record-only path and gets
    // `already-marked` — a STABLE outcome, which is re-gated exactly once
    // more (`already-ready` / `already-marked` must not fall straight through
    // here without re-verifying the live head at all) before the THIRD
    // CONVERGED, still
    // `already-marked`, finally falls through to convergence. `ready-calls`
    // staying a single line below proves `gh pr ready` itself only fired
    // once despite the extra gate passes.
    //
    // `scratchClean.head`, not the HEAD constant, because the transition sits
    // BEHIND the converged clean-worktree gate — which refuses to
    // exit 0 unless local HEAD equals the reviewed head. A fixture naming a
    // head the scratch repo does not have exits 12 and never reaches the
    // transition at all.
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
      isDraft: true,
    });
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain("RAN_THE_PASS");
    expect(readFileSync(join(dir, "ready-calls"), "utf8").trim()).toBe("999");
    // The convergence report must SAY that the reviewers it just summoned have
    // not answered, or "converged" reads as a completeness claim it is not.
    expect(r.stderr).toContain("converged");
    expect(r.stderr).toContain("re-run");
  });
});
