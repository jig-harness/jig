/**
 * drive-pr suite: mark-ready.ts and drive.ts loop control.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  advanceStallStreak,
  MAILBOX_PAUSE_TIMEOUT_EXIT,
  MAILBOX_STOPPED_EXIT,
  PASS_DEADLINE_EXIT,
  passExitDisposition,
  passTimeoutSeconds,
  QUOTA_PARKED_EXIT,
  resolveHandoffAt,
} from "../scripts/drive";
import { load as loadYaml } from "../../resolve-review-comments/scripts/lib/yaml.ts";
import { claudeAdapter } from "../scripts/lib/quota/claude.ts";
import { cloneKey } from "../scripts/lib/state/clone-key";
import { appendDirective } from "../scripts/lib/state/mailbox";
import type {
  CheckRun as EvidenceCheckRun,
  CommitStatus as EvidenceCommitStatus,
} from "../scripts/lib/status/evidence";
import {
  failingNames,
  failingStatusNames,
} from "../scripts/lib/status/evidence";

import {
  SCRIPTS,
  WORKTREE_LOCK,
  HEAD,
  PREV,
  type Fixture,
  type CheckRunFixture,
  REVIEWER_RUN,
  DORMANT_ARM,
  binDir,
  suiteHome,
  scratchClean,
  gitCleanEnv,
  makeScratchRepo,
  makeUnresolvedMergeRepo,
  makeRebasePausedRepo,
  writeFixture,
  probeIn,
  park,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

useDrivePrSuite();

// The draft→Ready transition. Repo policy births every PR as a draft;
// `example-review` reviews drafts (measured on #4053/#4041, 2026-08-13) and
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
      GROUNDWORK_OVERLAY: overlay,
    });
    expect(early).toMatchObject({ outcome: "not-due", exitCode: 0 });
    expect(calls(dir)).toEqual([]);
    const due = await markReady(dir, stateDir, ["--round", "2"], {
      GROUNDWORK_OVERLAY: overlay,
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
    // The #3933 shape aimed at a person: a transition re-derived from the live
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

  it("an unrecognized `state` value on the already-marked liveness check is INDETERMINATE, not not-open (docomply-review round 19, a reference-implementation pull request)", async () => {
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

  it("--record-only NEVER dispatches, even when its own live read observes a draft (docomply-review + chatgpt-codex-connector, a reference-implementation pull request)", async () => {
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

  it("checks liveness even on the durable-marker fast path — a PR that closed after being marked reports not-open, not already-marked (docomply-review round 8, a reference-implementation pull request)", async () => {
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

  it("checks the AUTHORITATIVE state, not just draftness, after a failed gh pr ready (docomply-review round 8, a reference-implementation pull request)", async () => {
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

  it("PRESERVES its claim when gh pr ready fails with the PR still an open draft — ambiguous, not proof it never applied (docomply-review round 13, a reference-implementation pull request)", async () => {
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
  // and the window between claiming and firing is microseconds wide
  // (docomply-review round 2, a reference-implementation pull request).
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
    // (docomply-review rounds 1-3, PR #4057). The lease has no failure branch
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
    // to undo a human who converted the PR back to draft in between
    // (docomply-review round 3, a reference-implementation pull request).
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
    // process resumes and fires a SECOND `ready_for_review` (coderabbitai P2).
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

  it("treats a renewal CONFIGURATION error as this process's own failure, not another driver (docomply-review round 7, a reference-implementation pull request)", async () => {
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
    // and undoes that decision (docomply-review round 4).
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
    // and re-marks it, undoing that decision (docomply-review rounds 1-2, PR
    // #4057).
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
  /**
   * Drive an ALREADY-WRITTEN fixture, so a probe can inspect the fixture
   * directory afterwards — `ready-calls`, which the stub appends to on every
   * `gh pr ready`, is only reachable this way. `runDrive` builds a fixture and
   * throws the paths away.
   *
   * Spawned in a scratch repo, never the real checkout: the converged exit
   * certifies a clean working tree, and the real checkout is dirty whenever
   * anyone is editing it. `cwd` is overridable so the dirty-tree probe can
   * point at a deliberately dirty repo.
   */
  async function runDriveIn(
    dir: string,
    stateDir: string,
    args: string[],
    cwd?: string,
    opts: {
      env?: Record<string, string>;
      /** Prepended ahead of `binDir` in PATH — for a probe's own `git` stub. */
      extraBinDir?: string;
    } = {},
  ) {
    const proc = Bun.spawn([join(SCRIPTS, "drive.ts"), "999", ...args], {
      cwd: cwd ?? scratchClean.dir,
      // gitCleanEnv, not process.env: a git hook exports GIT_DIR and
      // GIT_INDEX_FILE, and inheriting them makes every git call inside the
      // spawned script — including the converged clean-tree check — operate
      // on the REAL repository instead of the scratch cwd.
      env: {
        ...gitCleanEnv(),
        PATH: `${opts.extraBinDir ? `${opts.extraBinDir}:` : ""}${binDir}:${process.env.PATH}`,
        DRIVE_PR_FIXTURES: dir,
        DRIVE_PR_STATE_DIR: stateDir,
        DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
        ...(opts.env ?? {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stderr, exitCode };
  }

  async function runDrive(
    f: Fixture,
    args: string[],
    cwd?: string,
    opts: {
      env?: Record<string, string>;
      extraBinDir?: string;
    } = {},
  ) {
    const { dir, stateDir } = writeFixture(f);
    return runDriveIn(dir, stateDir, args, cwd, opts);
  }

  /** Read one field back out of the durable state a drive just wrote. */
  async function state(stateDir: string, args: string[], cwd?: string) {
    const proc = Bun.spawn([join(SCRIPTS, "drive-state.ts"), ...args], {
      cwd,
      env: {
        // gitCleanEnv(), not process.env: this suite runs inside a live
        // drive-pr pass as often as not (this very file's `runDriveIn` doc
        // comment says so), and `drive-state.ts`'s `resolveWorktreeRoot()`
        // anchors to an inherited `DRIVE_PR_WORKTREE` when one is set. Raw
        // `process.env` let that REAL worktree identity leak into a
        // `set-ci-hold` call against this test's own ISOLATED state dir,
        // writing a lease keyed to the real worktree — which the `drive.ts`
        // spawned moments later (via `runDriveIn`, already on
        // `gitCleanEnv()`) then reads back and refuses as "already driven by
        // another working tree", even though nothing but this same test is
        // actually running. A no-op everywhere `DRIVE_PR_WORKTREE` was never
        // set to begin with — i.e. every non-contaminated run, CI included.
        ...gitCleanEnv(),
        DRIVE_PR_STATE_DIR: stateDir,
        // set-ci-hold is test-only fixture seeding (PR #4681 round 4) —
        // harmless to set unconditionally here since no other command
        // reads this variable.
        DRIVE_PR_ALLOW_TEST_CI_HOLD_SEED: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { stdout, exitCode };
  }

  // Every pass command must name PR 999 or drive.ts's mis-targeting guard
  // rejects it — which the last test in this block asserts directly.
  const PASS_NOOP = ["sh", "-c", ": pass for 999; exit 0"];
  const PASS_LOUD = [
    "sh",
    "-c",
    'echo "pass for 999: RAN_THE_PASS" >&2; exit 0',
  ];
  // Echoes the repair-task channel back. Both variables are always
  // printed, including when unset, so a test can assert their ABSENCE on an
  // ordinary review round as positively as their presence on a repair one.
  const PASS_TASK = [
    "sh",
    "-c",
    'echo "pass for 999: TASK=$DRIVE_PR_ROUND_TASK DETAIL=$DRIVE_PR_ROUND_TASK_DETAIL" >&2; exit 0',
  ];

  it('hands the pass $DRIVE_PR_TARGET — the signal SKILL.md § Entry mode keys "driver pass, do not arm" on', async () => {
    // `/drive-pr` from a session ARMS a driver; from a drive.ts-spawned pass it
    // works one round. The only thing telling them apart is this variable, so a
    // driver that stopped exporting it would have every pass arm another driver
    // (unbounded recursion). Echoed unconditionally so the test could equally
    // read an empty value.
    const r = await runDrive(
      {
        threads: [
          {
            id: "PRRT_target_probe",
            path: "a.ts",
            bot: true,
            comments: [{ author: "example-review[bot]", bot: true, body: "x" }],
          },
        ],
      },
      [
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        "sh",
        "-c",
        'echo "pass for 999: TARGET=[$DRIVE_PR_TARGET]" >&2; exit 0',
      ],
    );
    expect(r.stderr).toContain("TARGET=[999]");
  });

  it("SKILL.md decides the entry mode before § 0 and the gate, on $DRIVE_PR_TARGET and --interactive", () => {
    // Prose contract pinned mechanically (references/consistency.md): the mode
    // decision must precede anything that takes the session lease, and must
    // key on the variable the test above proves the driver exports.
    const skill = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8");
    const entry = skill.indexOf("## Entry mode");
    const oneRound = skill.indexOf("## One round");
    expect(entry).toBeGreaterThan(-1);
    expect(entry).toBeLessThan(oneRound);
    const section = skill.slice(entry, oneRound);
    expect(section).toContain("$DRIVE_PR_TARGET");
    expect(section).toContain("--interactive");
    // Each table row must bind its signal to its behaviour — mentioning the
    // variable and flag somewhere in the section is not enough.
    const row = (signal: string) =>
      section.split("\n").find((l) => l.startsWith(`| ${signal}`)) ?? "";
    // The row must send a pass to § Driver pass (which carries the
    // never-background prohibition) — the old "Skip the rest of this section"
    // wording skipped exactly that.
    expect(row("`$DRIVE_PR_TARGET` set")).toMatch(
      /Driver pass.*Read § Driver pass below first.*never-background.*work one round/,
    );
    expect(row("`$DRIVE_PR_TARGET` set")).not.toMatch(/Skip the rest/);
    expect(row("`$DRIVE_PR_TARGET` unset, no `--interactive`")).toMatch(
      /\*\*Arm\*\*.*Do \*\*not\*\* work a round yourself/,
    );
    expect(row("`$DRIVE_PR_TARGET` unset, `--interactive`")).toMatch(
      /One in-session round.*Work exactly one round/,
    );
    // A driver pass must not be told to background the step that pushes
    //: § 6 used to say "background that commit from the start", and
    // a pass that obeyed it exited with finish-round.ts dead and the commit
    // unpushed. Pin the prohibition, the foreground wait it points to, and
    // that § 6 no longer prescribes the backgrounding.
    const driverPass = skill.slice(skill.indexOf("### Driver pass"), oneRound);
    expect(driverPass).toMatch(/Never use the Bash tool's `run_in_background`/);
    expect(driverPass).toContain("foreground wait");
    // Launch-once / repeated-wait contract, and that the launch stays in the
    // pass's process group (no setsid/perl escape from drive.ts's witness).
    expect(driverPass).toMatch(/foreground-wait\.ts launch --/);
    expect(driverPass).toMatch(/foreground-wait\.ts wait/);
    expect(driverPass).toMatch(/Never call `launch` to resume a wait/);
    expect(driverPass).toMatch(/exit `21`/);
    expect(driverPass).toContain("--bots-only");
    expect(driverPass).not.toMatch(/setsid\(|perl -MPOSIX/);
    const step6 = skill.slice(
      skill.indexOf("### 6. Commit, then finish the round"),
      skill.indexOf("That is the whole of step 6."),
    );
    expect(step6).toContain("never background either one");
    expect(step6).not.toContain("background that commit from the start");
    // The decision table must precede the FIRST gate invocation anywhere in
    // the skill — the gate's --bump-attempt takes the session lease — and no
    // gate command may sit between the section heading and that table.
    const gateCmd = "drive-status.ts [PR] --json --once --bump-attempt";
    const table = skill.indexOf("| Signal | Mode |");
    const gate = skill.indexOf(gateCmd);
    expect(table).toBeGreaterThan(entry);
    expect(gate).toBeGreaterThan(-1);
    expect(table).toBeLessThan(gate);
    expect(skill.slice(entry, table)).not.toContain("drive-status.ts");
    // The arm command keeps the portable one-line `bun` form and --bots-only.
    expect(section).toContain(
      'bun ${CLAUDE_SKILL_DIR}/scripts/drive.ts <PR> --bots-only -- claude -p "/groundwork:drive-pr --bots-only <PR>"',
    );
  });

  it("stops on a merged PR WITHOUT running the pass", async () => {
    // The pass would push onto an orphaned branch. The marker in the pass's
    // own stderr is what proves it never ran.
    const r = await runDrive({ prState: "MERGED", threads: [] }, [
      "--no-head-sync",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("warns about a 100%-unreadable bot reviewer before the round pass starts", async () => {
    const r = await runDrive(
      {
        threads: [
          {
            id: "PRRT_unreadable_severity",
            path: "a.ts",
            bot: true,
            comments: [
              {
                author: "format-switcher[bot]",
                bot: true,
                body: "formatter output no longer has a recognized severity",
              },
            ],
          },
        ],
      },
      ["--no-head-sync", "--max-rounds", "1", "--", ...PASS_LOUD],
    );
    expect(r.stderr).toContain("⚠ EVERY finding this round");
    expect(r.stderr).toContain("format-switcher[bot]");
    expect(r.stderr.indexOf("⚠ EVERY finding this round")).toBeLessThan(
      r.stderr.indexOf("RAN_THE_PASS"),
    );
  });

  it("stamps progress once round 1s pass has actually spawned — the signal that keeps a legitimately long round off the WEDGED threshold", async () => {
    // `PASS_NOOP` calls no `drive-state.ts` verb of its own (unlike
    // `bump-round`, which the PASS is responsible for per SKILL.md, not
    // drive.ts's own loop — see `grep -n bump-round drive.ts`, which has no
    // hits) — so `lastProgressAt` ending up set here can only be the
    // `progress --phase pass-spawned` stamp `drive.ts` itself issues from
    // `onSpawn`, once `run(agent, …)` has actually produced a child process.
    // A mutation deleting that call would leave `lastProgressAt` at
    // `freshState`'s own `''` forever, with nothing else in this minimal
    // fixture able to cover for it.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    const before = Date.now();
    await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--max-rounds",
      "1",
      "--",
      ...PASS_NOOP,
    ]);
    const s = JSON.parse((await state(stateDir, ["get", "999"])).stdout) as {
      lastProgressAt: string;
      phase: string;
    };
    expect(s.lastProgressAt).not.toBe("");
    expect(Date.parse(s.lastProgressAt)).toBeGreaterThanOrEqual(before);
    expect(s.phase).toBe("pass-spawned");
  });

  it("does NOT stamp pass-spawned progress when the pass executable never spawns at all", async () => {
    // A missing/invalid pass command usually does NOT fail inside `run()`'s
    // synchronous `spawn()` try/catch — Node reports the common ENOENT case
    // asynchronously via the child's 'error' event, and never assigns a
    // `pid` for it either (confirmed empirically), with the synchronous
    // `spawn()` call itself returning normally. `onSpawn` fires in the SAME
    // TICK `run()` is called in (never deferred to Node's async 'spawn'
    // event), gated on `child.pid !== undefined` checked immediately after
    // `spawn()` returns (`lib/proc.ts`, review finding: it used to fire
    // unconditionally the moment `spawn()` returned without throwing, which
    // is not the same fact as the child actually having started), so it
    // still never fires here — but a claim that this depends on a
    // synchronous throw would be wrong for the case this test actually
    // exercises. Asserting the negative closes the gap a reviewer named: the
    // sibling test above only exercised the ordinary, successful-spawn path.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--max-rounds",
      "1",
      "--",
      // Contains the `999` token: `explicitPr` is `999` here (a PR was
      // named), so drive.ts's own mis-targeting guard requires it to appear
      // in the pass argv — a path with no digits at all fails that guard and
      // refuses at exit 2 BEFORE the round loop or `run(agent, …)` are ever
      // reached, which made `lastProgressAt === ''` true for the wrong
      // reason (never attempted, not "attempted and correctly not stamped")
      // and left this test unable to catch a stamp fired unconditionally
      // ahead of the spawn — the exact regression it exists to close
      // (review finding).
      "/nonexistent/drive-pr-test-pass-999-xyz",
    ]);
    // Proves the mis-targeting guard did NOT short-circuit this run.
    expect(r.exitCode).not.toBe(2);
    expect(r.stderr).toContain("--- round 1/1 on PR #999 ---");
    // NOT asserting `lastProgressAt === ''` — round-advancement stamps it
    // (phase 'round-advanced') as soon as this head is first counted, well
    // before the pass is ever spawned, regardless of whether the spawn goes
    // on to succeed. That is what let the ORIGINAL fixture (no `999` token)
    // pass for the wrong reason too, just earlier: its mis-targeting refusal
    // pre-empts the counting gate entirely, so `lastProgressAt` stayed ''
    // for a reason that had nothing to do with `onSpawn`. The assertion this
    // test actually needs is on `phase`: only `onSpawn` firing would move it
    // to 'pass-spawned', so asserting it is still whatever round-advancement
    // left it at proves `onSpawn` never fired for this failed spawn.
    const s = JSON.parse((await state(stateDir, ["get", "999"])).stdout) as {
      phase: string;
    };
    expect(s.phase).not.toBe("pass-spawned");
  });

  /**
   * The worktree-lock name for the SCRATCH tree, resolved through the same
   * function drive.ts calls — from a subprocess standing in that tree,
   * because this process's own derivation is memoised on the suite's cwd
   * (see WORKTREE_LOCK's comment for why no hash is recomputed here).
   */
  async function scratchLockName(): Promise<string> {
    const probe = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import(${JSON.stringify(join(SCRIPTS, "lib", "state", "store.ts"))}).then(async (m) => console.log(await m.worktreeLockName()))`,
      ],
      {
        cwd: scratchClean.dir,
        env: gitCleanEnv(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, code] = await Promise.all([
      new Response(probe.stdout).text(),
      probe.exited,
    ]);
    expect(code).toBe(0);
    const name = out.trim();
    expect(name.startsWith("pr-drive-worktree-")).toBe(true);
    return name;
  }

  it("appends the driver narrative to the durable per-PR log", async () => {
    // A drive is routinely a background child of a session that ends before
    // the drive does, so a console-only narrative dies with the session. The
    // MERGED stop is the cheapest full path through main(): tee installed,
    // path announced, drive stopped.
    const { dir, stateDir } = writeFixture({ prState: "MERGED", threads: [] });
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_NOOP,
    ]);
    expect(r.exitCode).toBe(5);
    const logPath = join(stateDir, "drive-pr-999.log");
    const log = readFileSync(logPath, "utf8");
    // The header names the writer; the announcement proves the tee was
    // installed BEFORE the first console line. The console stays
    // authoritative: the same announcement must still reach stderr.
    expect(log).toContain("driver narrative");
    expect(log).toContain(`drive.ts: driver log → ${logPath}`);
    expect(r.stderr).toContain(`drive.ts: driver log → ${logPath}`);
  });

  it("enriches the exit-11 refusal with the holder claim’s diagnostics", async () => {
    const { dir, stateDir } = writeFixture({ threads: [] });
    // The claim is planted as LITERAL bytes, not through formatClaim: the
    // refusal must read the wire format a real driver writes, and a
    // round-trip through the serializer would keep passing if both sides
    // drifted together.
    const lockDir = join(stateDir, await scratchLockName());
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "claim.feedfacefeedface"),
      `${process.pid} ${hostname()}\n${JSON.stringify({
        pr: "123",
        worktree: "/elsewhere/tree",
        log: "/elsewhere/drive-pr-123.log",
        started: "2026-08-15T00:00:00.000Z",
        account: {
          account: "dev@example.com",
          vendor: "claude",
          provenance: "oauthAccount",
          reason: null,
        },
      })}\n`,
    );
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.exitCode).toBe(11);
    expect(r.stderr).toContain(
      "another driver already holds the worktree lock",
    );
    expect(r.stderr).toContain("working PR #123 from /elsewhere/tree");
    expect(r.stderr).toContain("/elsewhere/drive-pr-123.log");
    // The holder's billing account rides along with the rest of
    // the diagnostics on the same refusal.
    expect(r.stderr).toContain(
      "Account: dev@example.com (claude, from oauthAccount)",
    );
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("a older claim (pid/host only) still refuses, degraded to its owner", async () => {
    const { dir, stateDir } = writeFixture({ threads: [] });
    const lockDir = join(stateDir, await scratchLockName());
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "claim.cafecafecafecafe"),
      `${process.pid} ${hostname()}\n`,
    );
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_NOOP,
    ]);
    expect(r.exitCode).toBe(11);
    expect(r.stderr).toContain(
      "another driver already holds the worktree lock",
    );
    expect(r.stderr).not.toContain("working PR #");
  });

  it("a older claim (diagnostics with no account key) still shows PR/worktree/log — only the account degrades, not the whole diagnostics line", async () => {
    // Same shape an earlier change always wrote, before an earlier change added `account` to
    // it. Unlike a claim with no diagnostics at all (the pid/host-only case
    // above), this is NOT flattened to "nothing to show": `lib/claim.ts`'s
    // `parseDiag` degrades only the missing `account` key, precisely
    // because an already-running, pre-upgrade driver's claim must stay
    // readable for `drives.ts --stop` and for its own pass's `ownParentDriver`
    // self-check (docomply-review finding: an earlier revision of this file
    // nulled the WHOLE diag here, which would have made `--stop` refuse a
    // live in-flight driver and reproduced the stand-down
    // bug for its own pass).
    const { dir, stateDir } = writeFixture({ threads: [] });
    const lockDir = join(stateDir, await scratchLockName());
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "claim.deadbeefdeadbeef"),
      `${process.pid} ${hostname()}\n${JSON.stringify({
        pr: "123",
        worktree: "/elsewhere/tree",
        log: "/elsewhere/drive-pr-123.log",
        started: "2026-08-15T00:00:00.000Z",
      })}\n`,
    );
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_NOOP,
    ]);
    expect(r.exitCode).toBe(11);
    expect(r.stderr).toContain(
      "another driver already holds the worktree lock",
    );
    expect(r.stderr).toContain("working PR #123 from /elsewhere/tree");
    expect(r.stderr).toContain("/elsewhere/drive-pr-123.log");
    expect(r.stderr).toContain(
      "Account: unknown (claim written before the billing account was stamped)",
    );
  });

  it("runs a conflict-resolution pass before treating a CONFLICTING PR as terminal", async () => {
    // The older reasoning for stopping here was that an empty work
    // enumeration leaves "nothing for a triage pass to do". True of triage,
    // false of the pass: merging the base in is exactly what a conflict WITH
    // findings already gets, inside its own round.
    const r = await runDrive(
      {
        threads: [],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--no-head-sync", "--", ...PASS_TASK],
      undefined,
      { env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: "1" } },
    );
    expect(r.stderr).toContain("TASK=conflict-resolve");
    // The base ref, so the pass merges the PR's OWN base rather than guessing
    // develop — the same failure the sibling test below pins for the message.
    expect(r.stderr).toContain("DETAIL=develop");
    expect(r.stderr).toContain("Running conflict-resolution pass 1/1");
    // The pass changed nothing, so the drive re-gates onto the same conflict
    // with the budget gone and takes the original terminal state.
    expect(r.exitCode).toBe(9);
    expect(r.stderr).toContain("git merge origin/develop");
  });

  it("preserves PR_NOT_OPEN from a repair pass instead of reporting a generic repair failure", async () => {
    // `guarded-push.ts` exits 5 inside a repair pass exactly like it does
    // inside the ordinary-pass ROUND_READY push — `passExitDisposition`
    // exists to route that to PR_NOT_OPEN for the ordinary path, and
    // `runRepairPass` used to collapse every non-zero repair-pass exit
    // (including 5) into a plain boolean, so this call site reported a
    // generic "conflict-resolution pass failed" and printed a `git merge`
    // fix for a PR that had already merged or closed underneath it.
    const r = await runDrive(
      {
        threads: [],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--no-head-sync", "--", "sh", "-c", ": pass for 999; exit 5"],
      undefined,
      { env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: "1" } },
    );
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain(
      "stopped being open during the conflict-resolution pass",
    );
    expect(r.stderr).not.toContain(
      "the conflict-resolution pass failed; stopping with the manual fix below",
    );
    expect(r.stderr).not.toContain("git merge origin/develop");
  });

  it("--dry-run against a CONFLICTING PR with nothing to work reports FAST, not after minutes of internal polling", async () => {
    // The sibling CI-repair branch prints a `(dry-run) would run a CI-repair
    // pass for: …` line instead of silently taking the plain stop, and this
    // path used to fall straight through to the ordinary "conflicts …
    // stopping" message with no sign the automated repair was ever in the
    // running. drive-status.ts's own gate can never CERTIFY code 9 under a
    // dry run — `--no-count` (part of every dry-run probe's `probeFlags`,
    // unconditionally) suppresses the replied-thread reconciliation sweep
    // `UNRECONCILED_STOPPERS` requires before certifying a code in that set,
    // so the probe degrades to INDETERMINATE (1) instead, REGARDLESS of
    // `--once` (review finding, an earlier change — the previous revision of
    // this test asserted exactly that degraded exit as the intended
    // behaviour, which silently made the preview below dead code and
    // contradicted using-drive-pr.md's own "`--dry-run` reports what each
    // round would do"). The fix reads the SAME condition `evaluate()` uses to
    // decide PR_CONFLICTING — mergeable === 'CONFLICTING' and nothing LIVE
    // left to work — directly off the already-fetched, non-mutating report,
    // rather than waiting on a sweep dry-run deliberately never runs.
    //
    // What this ALSO still pins is the earlier real bug found while testing
    // this message: without `--once`, drive-status.ts took its own internal
    // polling path for a code it can never certify under suppression — up to
    // its full `--timeout` (1800s / 30 minutes by default) — before finally
    // giving up. `--once` (added alongside `--no-count` at this call site)
    // makes the honest "cannot certify" answer arrive immediately instead —
    // which is what the fast preview below builds on.
    const start = Date.now();
    const r = await runDrive(
      {
        threads: [],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--dry-run", "--no-head-sync", "--", ...PASS_TASK],
      undefined,
      { env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: "1" } },
    );
    // Generous relative to the near-instant true cost (a couple of stubbed
    // `gh` calls), but far short of even one of drive-status.ts's own
    // internal `--interval` sleeps (30s default) — so this fails loudly if
    // `--once` is ever dropped from the dry-run probe flags rather than
    // silently costing the suite tens of seconds per run.
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(r.exitCode).toBe(9);
    expect(r.stderr).toContain(
      "(dry-run) would run a conflict-resolution pass against origin/develop",
    );
    expect(r.stderr).not.toContain("RAN_THE_PASS");
    expect(r.stderr).not.toContain("TASK=conflict-resolve");
  });

  it("does NOT print the conflict-resolve preview under --dry-run when the conflicting head still has live findings", async () => {
    // The new preview recognises PR_CONFLICTING's OWN condition —
    // mergeable === 'CONFLICTING' and nothing LIVE left to work — directly
    // off the report. A conflicting head with a real unresolved thread is
    // the OTHER, non-terminal case (`ROUND_READY`, since the live reviewer
    // is a poller with no mergeability term and reviews conflicting heads
    // too): the preview must not misfire there just because mergeable is
    // CONFLICTING, since there is genuine review work still to hand out.
    const r = await runDrive(
      {
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--dry-run", "--no-head-sync", "--", ...PASS_TASK],
      undefined,
      { env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: "1" } },
    );
    expect(r.stderr).not.toContain(
      "(dry-run) would run a conflict-resolution pass",
    );
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("--dry-run does NOT preview a conflict-resolution pass when the repair budget is disabled (review finding, round 7)", async () => {
    // The early --dry-run shortcut above recognises PR_CONFLICTING directly
    // off the status report, bypassing the real code-9 switch branch that
    // consults `conflictRepairRounds()` before deciding whether to preview a
    // repair pass or the manual stop. Before this fix the shortcut always
    // printed "would run a conflict-resolution pass", even with
    // DRIVE_PR_CONFLICT_REPAIR_ROUNDS=0 — where the real, non-dry-run path
    // takes the manual exit-9 stop instead, never dispatching a pass. Pin
    // that the preview now matches the real decision.
    const r = await runDrive(
      {
        threads: [],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--dry-run", "--no-head-sync", "--", ...PASS_TASK],
      undefined,
      { env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: "0" } },
    );
    expect(r.exitCode).toBe(9);
    expect(r.stderr).not.toContain(
      "(dry-run) would run a conflict-resolution pass",
    );
    expect(r.stderr).toContain("conflicts with its base");
    expect(r.stderr).toContain("git merge origin/develop");
    expect(r.stderr).toContain("DRIVE_PR_CONFLICT_REPAIR_ROUNDS=0");
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("stops on a CONFLICTING PR WITHOUT running the pass, and names the fix", async () => {
    // THIS fixture has no findings, so handing the round over would spend it
    // reading an empty review — and the operator has to be told to merge, not
    // that a reviewer is slow (#3952). The emptiness is a property of the
    // fixture, NOT of conflicting heads: the live reviewer is a poller with no
    // mergeability term in its eligibility predicate, so it can and does
    // publish findings on a conflicting head. The sibling test below pins that
    // case as ROUND_READY.
    const r = await runDrive(
      {
        threads: [],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--no-head-sync", "--", ...PASS_LOUD],
      undefined,
      // `0` restores the pre-repair behaviour this test is about —
      // terminal on arrival, pass never spawned.
      { env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: "0" } },
    );
    expect(r.exitCode).toBe(9);
    expect(r.stderr).not.toContain("RAN_THE_PASS");
    expect(r.stderr).toContain("conflicts with its base");
    expect(r.stderr).toContain("git merge origin/develop");
  });

  it("reports the base as unavailable rather than guessing develop (#3995 review)", async () => {
    // Review found the previous implementation defaulted an unreadable base
    // name to `develop` (`${base:-develop}`) — a concrete, WRONG command for
    // any release-branch or stacked PR. It also made a second, ungated `gh pr
    // view` call to fetch it, which this fix removes entirely by reading the
    // base name out of the status JSON drive-status.ts already produced.
    //
    // an earlier change gave this test a second job, which is why it runs with the
    // conflict-repair budget at its DEFAULT rather than disabled: an
    // unreadable base name must not spend a repair round either. Dispatching
    // a pass with an empty base makes the same `develop` guess one level
    // further away, where the operator cannot see it being made — so
    // `RAN_THE_PASS` below now also pins that the repair was declined.
    const r = await runDrive(
      {
        threads: [],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        baseRefNameMissing: true,
      },
      ["--no-head-sync", "--", ...PASS_LOUD],
    );
    expect(r.exitCode).toBe(9);
    expect(r.stderr).not.toContain("RAN_THE_PASS");
    expect(r.stderr).not.toContain("git merge origin/develop");
    expect(r.stderr).toContain("base branch name unavailable");
  });

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

  it("strips CLAUDECODE from the pass env — a nested spawn must not look like a nested Claude Code session (docomply-review round 7, a reference-implementation pull request)", async () => {
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
      readFileSync(process.env.GROUNDWORK_OVERLAY as string, "utf8"),
    ) as Record<string, unknown>;
    writeFileSync(
      path,
      JSON.stringify({ ...suite, pull_requests: pullRequests }),
    );
    return { env: { GROUNDWORK_OVERLAY: path } };
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

  it("--keep-draft still records an already-Ready PR via the round-loop pre-pass call (docomply-review round 14, a reference-implementation pull request)", async () => {
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
    // `already-marked` — a STABLE outcome, which round 22's fix re-gates
    // exactly once more (docomply-review round 22, a reference-implementation pull request: `already-ready`
    // / `already-marked` used to fall straight through here without
    // re-verifying the live head at all) before the THIRD CONVERGED, still
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

  // Drive.ts keeps an existing PR pin at arm, through
  // capture-intent-chain.ts. The capture is best-effort by contract — a refusal
  // (exit 3) or a failure must never stop or change the outcome of the drive —
  // and --dry-run must not write a pin at all.
  it("runs the intent-chain capture at arm, and a refused capture (exit 3) does not change the drive outcome", async () => {
    // The scratch repo is not on the fixture PR's head branch
    // (`feature/an earlier change-probe`), so the capture's own verification refuses.
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
      isDraft: false,
    });
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.stderr).toContain("intent chain: not pinned for PR #999");
    expect(r.stderr).toContain("not PR #999's head branch");
    expect(r.exitCode).toBe(0);
  });

  it("refuses a new pin without a pickup token even on the PR head branch", async () => {
    // A matching branch and mutable item file cannot identify the original
    // pickup. The driver's tokenless re-arm must refuse instead of guessing.
    const repo = makeScratchRepo("scratch-capture");
    const co = Bun.spawnSync(
      ["git", "checkout", "-q", "-b", "feature/ENG-9999-probe"],
      { cwd: repo.dir, env: gitCleanEnv() },
    );
    expect(co.exitCode).toBe(0);
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: repo.head,
      head: repo.head,
      isDraft: false,
    });
    const contextDir = join(dir, "context");
    const chains = join(contextDir, "intent-chain");
    mkdirSync(chains, { recursive: true });
    const snapshot =
      "<!-- refocus-arm: on -->\n<intent_chain>ENG-9999 probe chain</intent_chain>\n";
    writeFileSync(join(chains, "ENG-9999.md"), snapshot);
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--", ...PASS_LOUD],
      repo.dir,
      {
        env: {
          DRIVE_PR_INTENT_CHAIN_DIR: contextDir,
        },
      },
    );
    expect(r.stderr).toContain("intent chain: not pinned for PR #999");
    expect(r.stderr).toContain("a new pin requires --pickup");
    expect(existsSync(join(chains, "pr.999.md"))).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it("keeps the driven checkout pin when the driver inherits GIT_DIR/GIT_WORK_TREE for another one", async () => {
    // `runDriveIn` starts from `gitCleanEnv()`, so the success test above
    // cannot see a missing scrub. Here the driver INHERITS a location naming
    // a decoy checkout on a non-PR branch: if any git call deriving the
    // capture spawn's tree honoured it, the branch check would read the decoy
    // and refuse to pin.
    const repo = makeScratchRepo("scratch-capture-real");
    const decoy = makeScratchRepo("scratch-capture-decoy");
    const co = Bun.spawnSync(
      ["git", "checkout", "-q", "-b", "feature/ENG-9999-probe"],
      { cwd: repo.dir, env: gitCleanEnv() },
    );
    expect(co.exitCode).toBe(0);
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: repo.head,
      head: repo.head,
      isDraft: false,
    });
    const contextDir = join(dir, "context");
    const chains = join(contextDir, "intent-chain");
    mkdirSync(chains, { recursive: true });
    writeFileSync(
      join(chains, "pr.999.md"),
      "<!-- refocus-arm: on -->\n<intent_chain>ENG-9999 probe chain</intent_chain>\n",
    );
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--", ...PASS_LOUD],
      repo.dir,
      {
        env: {
          DRIVE_PR_INTENT_CHAIN_DIR: contextDir,
          GIT_DIR: join(decoy.dir, ".git"),
          GIT_WORK_TREE: decoy.dir,
        },
      },
    );
    expect(r.stderr).toContain("intent chain: pinned for PR #999");
    expect(r.stderr).toContain("kept");
    expect(readFileSync(join(chains, "pr.999.md"), "utf8")).toContain(
      "ENG-9999 probe chain",
    );
  });

  it("does not run the intent-chain capture under --dry-run", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
      isDraft: false,
    });
    const r = await runDriveIn(dir, stateDir, [
      "--dry-run",
      "--no-head-sync",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.stderr).not.toContain("intent chain:");
  });

  // A red final verdict is a REPAIR round before it is a stop, so
  // every pre-existing "stops for /fix-ci" expectation below now pins the
  // budget-exhausted fallback explicitly (`DRIVE_PR_CI_REPAIR_ROUNDS=0`)
  // rather than relying on a default that no longer stops on the first red.
  // The repair path itself is covered by the block that follows them.
  const NO_REPAIR = { DRIVE_PR_CI_REPAIR_ROUNDS: "0" };

  /** A completed, failed, non-reviewer required check on the current head. */
  const FAILING_RUN: CheckRunFixture = {
    name: "code-quality-and-build",
    status: "completed",
    conclusion: "failure",
    app: "github-actions",
    started: "2026-09-10T10:01:00Z",
  };

  it("stops for /fix-ci when the PR-open full-CI witness completed red", async () => {
    const r = await runDrive(
      {
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
      },
      ["--keep-draft", "--no-head-sync", "--", ...PASS_LOUD],
      undefined,
      { env: NO_REPAIR },
    );
    expect(r.stderr).toContain("stopping for /fix-ci");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("runs a CI-repair pass on a red final verdict instead of stopping", async () => {
    const r = await runDrive(
      {
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
      },
      [
        "--keep-draft",
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        ...PASS_TASK,
      ],
      undefined,
      { env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" } },
    );
    // The pass ran, and it ran as a REPAIR: the task and the failing check
    // names both reached it. Without the detail a /fix-ci pass has no idea
    // which checks to chase.
    expect(r.stderr).toContain("TASK=ci-repair");
    expect(r.stderr).toContain("DETAIL=code-quality-and-build");
    expect(r.stderr).toContain("Running CI-repair pass 1/1");
  });

  it("falls back to the /fix-ci stop once the CI-repair budget is spent", async () => {
    // The pass exits 0 but changes nothing, so the drive re-gates onto the
    // identical red verdict. Budget 1 means exactly one repair, then the stop.
    const r = await runDrive(
      {
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
      },
      ["--keep-draft", "--no-head-sync", "--", ...PASS_TASK],
      undefined,
      { env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" } },
    );
    expect(r.stderr).toContain("Running CI-repair pass 1/1");
    expect(r.stderr).toContain("stopping for /fix-ci");
    expect(r.stderr).toContain("the budget is spent");
    expect(r.exitCode).toBe(1);
  });

  it("--dry-run against a converged PR with a red final verdict previews the CI-repair pass", async () => {
    // Unlike case 9 (PR_CONFLICTING), this preview lives inside CONVERGED
    // (code 3) handling. `UNRECONCILED_STOPPERS` (drive-status.ts) only
    // withholds certification for codes {2,7,8,9,10} under `--no-count` —
    // code 3 is explicitly exempted (see its own `convergedUnswept` guard,
    // a narrower and different condition) — so a `--dry-run` probe's
    // `--no-count --once` flags never stood between this branch and a real
    // CONVERGED verdict the way they did for case 9's. an earlier change found this
    // preview had never actually been pinned by a test, unlike its sibling
    // (the CONFLICTING dry-run test above) — this closes that gap rather
    // than fixing a reachability bug, because there wasn't one here.
    const r = await runDrive(
      {
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
      },
      [
        "--dry-run",
        "--keep-draft",
        "--no-head-sync",
        "--",
        "sh",
        "-c",
        // `PASS_TASK` alone never echoes an unconditional marker, so
        // `not.toContain('RAN_THE_PASS')` against it can't fail either way —
        // it'd read the same whether the pass ran or not. This adds one
        // (`RAN_THE_PASS`) while keeping the task echo, so the assertion
        // below actually pins that the pass was never invoked.
        'echo "pass for 999: RAN_THE_PASS TASK=$DRIVE_PR_ROUND_TASK DETAIL=$DRIVE_PR_ROUND_TASK_DETAIL" >&2; exit 0',
      ],
      undefined,
      { env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" } },
    );
    expect(r.stderr).toContain(
      "(dry-run) would run a CI-repair pass for: code-quality-and-build",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain("RAN_THE_PASS");
    expect(r.stderr).not.toContain("TASK=ci-repair");
  });

  it("does not spend CI-repair budget on a verdict that names no failing check", async () => {
    // `unknown:`/unreadable is an absence of evidence, not evidence of
    // failure — a /fix-ci pass handed no run and no check name has nothing to
    // work from, so this must take the stop directly even with budget left.
    const r = await runDrive(
      {
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM],
        statusesUnreadable: true,
      },
      ["--keep-draft", "--no-head-sync", "--", ...PASS_TASK],
      undefined,
      { env: { DRIVE_PR_CI_REPAIR_ROUNDS: "2" } },
    );
    expect(r.stderr).toContain("stopping for /fix-ci");
    expect(r.stderr).not.toContain("TASK=ci-repair");
    expect(r.exitCode).toBe(1);
  });

  it("never leaks a repair task into an ordinary review round", async () => {
    // An operator (or an outer driver) with the variable exported must not
    // turn a round that has live findings into a repair round — the pass
    // would skip triage entirely and leave those findings unanswered.
    const r = await runDrive(
      {
        threads: [{ id: "PRRT_leak", path: "a.ts", bot: true }],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
      },
      [
        "--keep-draft",
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        ...PASS_TASK,
      ],
      undefined,
      {
        env: {
          DRIVE_PR_ROUND_TASK: "ci-repair",
          DRIVE_PR_ROUND_TASK_DETAIL: "inherited noise",
        },
      },
    );
    // The complete echoed line, not merely `toContain('TASK=')` (review
    // finding): that substring also matches `TASK=ci-repair`, so it cannot
    // tell a genuinely CLEARED pair from one the driver merely replaced with
    // some other non-empty noise — only pinning both variables empty proves
    // the leak is closed, not just that these two particular values didn't
    // survive.
    expect(r.stderr).toContain("pass for 999: TASK= DETAIL=");
    expect(r.stderr).not.toContain("TASK=ci-repair");
    expect(r.stderr).not.toContain("DETAIL=inherited noise");
  });

  it("stops for /fix-ci when the unlabel-triggered full-CI witness completed red", async () => {
    const failing: CheckRunFixture = {
      name: "code-quality-and-build",
      status: "completed",
      conclusion: "failure",
      app: "github-actions",
      started: "2026-09-10T10:01:00Z",
    };
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [REVIEWER_RUN, DORMANT_ARM, failing],
    });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([
        {
          node_id: "LE_1",
          event: "labeled",
          label: { name: "ci:hold" },
          actor: { login: "drive-user" },
          created_at: "2026-09-10T09:59:00Z",
        },
      ]),
    );
    const seeded = await state(
      stateDir,
      [
        "set-ci-hold",
        "999",
        "--set",
        "held",
        "--event-id",
        "LE_1",
        "--head",
        scratchClean.head,
        "--actor-name",
        "drive-user",
        "--created-at",
        "2026-09-10T09:59:00Z",
        "--check-run-watermark",
        "10000",
      ],
      scratchClean.dir,
    );
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--keep-draft", "--no-head-sync", "--", ...PASS_LOUD],
      undefined,
      { env: NO_REPAIR },
    );
    expect(r.stderr).toContain("stopping for /fix-ci");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("does not retry forever when a post-unlabel cascade leaves required jobs skipped and something else red", async () => {
    // The exact shape an earlier change named: `detect-changes` fails after the
    // unlabel, cascading the required `code-quality-and-build`/`tests` into
    // `skipped`. `completedRequiredCi` correctly refuses a skipped run as a
    // witness, so `final-ready` returns 4 — and the OLD code took that as
    // "still pending" and slept, forever, because the branch that would have
    // decided it correctly sat BEHIND the shortcut, reading a pre-unlabel
    // `status.ci` snapshot its own neighbouring comment already declared
    // unusable.
    //
    // `skipped` is deliberately PASSING to the aggregate verdict, so the red
    // here has to come from the job that actually failed — which is precisely
    // why deciding on the fresh aggregate, rather than on exit 4, is the fix.
    const cascade: CheckRunFixture[] = [
      {
        name: "detect-changes",
        status: "completed",
        conclusion: "failure",
        app: "github-actions",
        started: "2026-09-10T10:01:00Z",
      },
      {
        name: "code-quality-and-build",
        status: "completed",
        conclusion: "skipped",
        app: "github-actions",
        started: "2026-09-10T10:01:00Z",
      },
      {
        name: "tests",
        status: "completed",
        conclusion: "skipped",
        app: "github-actions",
        started: "2026-09-10T10:01:00Z",
      },
    ];
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [REVIEWER_RUN, DORMANT_ARM, ...cascade],
    });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([
        {
          node_id: "LE_1",
          event: "labeled",
          label: { name: "ci:hold" },
          actor: { login: "drive-user" },
          created_at: "2026-09-10T09:59:00Z",
        },
      ]),
    );
    const seeded = await state(
      stateDir,
      [
        "set-ci-hold",
        "999",
        "--set",
        "held",
        "--event-id",
        "LE_1",
        "--head",
        scratchClean.head,
        "--actor-name",
        "drive-user",
        "--created-at",
        "2026-09-10T09:59:00Z",
        "--check-run-watermark",
        "10000",
      ],
      scratchClean.dir,
    );
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--keep-draft", "--no-head-sync", "--", ...PASS_LOUD],
      undefined,
      // Repair disabled so this pins the DECISION (stop vs retry forever)
      // rather than the repair layered on top of it.
      { env: NO_REPAIR },
    );
    // The point of the test: it TERMINATES, with the red named. Against the
    // unfixed code this run never returns at all.
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("stopping for /fix-ci");
    expect(r.stderr).toContain("detect-changes");
  });

  it("gives up with exit 4 when a fresh required-check witness can never arrive", async () => {
    // The residual half of an earlier change's shape, and the one no fall-through can
    // decide: every required check's fresh run completed `skipped`. That is
    // PASSING to the aggregate verdict (`PASSING_CONCLUSIONS` includes
    // `skipped` — a skipped job is not a failure) and NO WITNESS to
    // `completedRequiredCi`, which wants a success. Nothing red, nothing
    // pending, and nothing that will ever become a witness — so the wait
    // cannot resolve by waiting, however long.
    //
    // The bound is set to 1 poll so the test observes the give-up rather than
    // the 30-minute default.
    const skipped = (name: string): CheckRunFixture => ({
      name,
      status: "completed",
      conclusion: "skipped",
      app: "github-actions",
      started: "2026-09-10T10:01:00Z",
    });
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        skipped("code-quality-and-build"),
        skipped("tests"),
        skipped("Schema gate"),
      ],
    });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([
        {
          node_id: "LE_1",
          event: "labeled",
          label: { name: "ci:hold" },
          actor: { login: "drive-user" },
          created_at: "2026-09-10T09:59:00Z",
        },
      ]),
    );
    const seeded = await state(
      stateDir,
      [
        "set-ci-hold",
        "999",
        "--set",
        "held",
        "--event-id",
        "LE_1",
        "--head",
        scratchClean.head,
        "--actor-name",
        "drive-user",
        "--created-at",
        "2026-09-10T09:59:00Z",
        "--check-run-watermark",
        "10000",
      ],
      scratchClean.dir,
    );
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--keep-draft", "--no-head-sync", "--", ...PASS_LOUD],
      undefined,
      { env: { DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1" } },
    );
    // Exit 4, not a terminal code: retry-safe, and a rerun genuinely can
    // produce the witness this drive could not find.
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("no fresh exact-head required-check witness");
    // It must NOT read as a CI failure — nothing here is red, and pointing at
    // /fix-ci would send an operator to fix code that is fine.
    expect(r.stderr).not.toContain("stopping for /fix-ci");
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("bounds a required check stuck queued/in-progress forever, not just skipped", async () => {
    // A THIRD shape reaching the same unwitnessed state as the two an earlier change
    // tests above, and the one the early `pending:` short-circuit used to
    // intercept before it ever reached the witness-wait accounting: a
    // required check that never leaves queued/in-progress. `ciVerdictOf()`
    // reports this as `pending: tests` (never `failing:`), so the OLD code
    // took the unconditional `await sleep(10); continue;` branch at the very
    // top of this decision chain — regardless of `finalCi.code` — and looped
    // there forever, never once touching `witnessWaits`. Fixed, a `pending:`
    // verdict under `finalCi.code === 4` (final-ready could not confirm
    // freshness — true here, since 'tests' has no completed run at all) falls
    // through to the SAME bounded wait a `skipped` required check hits.
    const inProgress = (name: string): CheckRunFixture => ({
      name,
      status: "in_progress",
      conclusion: null,
      app: "github-actions",
      started: "2026-09-10T10:01:00Z",
    });
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        inProgress("tests"),
        {
          name: "code-quality-and-build",
          status: "completed",
          conclusion: "success",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
        {
          name: "Schema gate",
          status: "completed",
          conclusion: "success",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
      ],
    });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([
        {
          node_id: "LE_1",
          event: "labeled",
          label: { name: "ci:hold" },
          actor: { login: "drive-user" },
          created_at: "2026-09-10T09:59:00Z",
        },
      ]),
    );
    const seeded = await state(
      stateDir,
      [
        "set-ci-hold",
        "999",
        "--set",
        "held",
        "--event-id",
        "LE_1",
        "--head",
        scratchClean.head,
        "--actor-name",
        "drive-user",
        "--created-at",
        "2026-09-10T09:59:00Z",
        "--check-run-watermark",
        "10000",
      ],
      scratchClean.dir,
    );
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--keep-draft", "--no-head-sync", "--", ...PASS_LOUD],
      undefined,
      { env: { DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1" } },
    );
    // Against the OLD code this hangs (the test would time out on the
    // unbounded `sleep(10)` loop) rather than exiting 4 — bounding it is the
    // whole fix.
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("no fresh exact-head required-check witness");
    expect(r.stderr).toContain("verdict has stayed 'pending: tests'");
    expect(r.stderr).not.toContain("stopping for /fix-ci");
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("failingNames returns the individual failing check-run and commit-status names, unparsed", () => {
    // The structured counterpart to `ciVerdictOf`'s rendered string. Added
    // because a caller testing exact membership (`REQUIRED_FULL_CI_CHECKS`)
    // against that string's `; `/`, `-joined output cannot round-trip a
    // check name that itself contains either delimiter: a non-required
    // check literally named "Schema gate, shard 1" would split into
    // ['Schema gate', 'shard 1'] and falsely satisfy an exact-match test
    // against the required 'Schema gate'. This function sidesteps the whole
    // class by never joining and re-splitting in the first place.
    const run = (
      name: string,
      conclusion: string | null,
    ): EvidenceCheckRun => ({
      name,
      status: conclusion === null ? "in_progress" : "completed",
      conclusion,
      app: "github-actions",
      title: "",
      id: 1,
      started: "2026-09-10T10:00:00Z",
    });
    const status = (context: string, state: string): EvidenceCommitStatus => ({
      context,
      state,
      description: null,
    });

    expect(failingNames([run("Schema gate", "failure")], [], false)).toEqual([
      "Schema gate",
    ]);
    // The exact adversarial shape the review finding named: a check whose
    // OWN name contains the delimiter `ciVerdictOf` joins on. Returned
    // intact, never split.
    expect(
      failingNames([run("Schema gate, shard 1", "failure")], [], false),
    ).toEqual(["Schema gate, shard 1"]);
    // Both groups — check-runs and legacy commit statuses — contribute,
    // each name exact and unsplit.
    expect(
      failingNames(
        [run("code-quality-and-build", "failure")],
        [status("ctx1", "failure")],
        false,
      ),
    ).toEqual(["code-quality-and-build", "ctx1"]);
    // Passing conclusions never appear.
    expect(failingNames([run("tests", "success")], [], false)).toEqual([]);
    // Unreadable evidence is `null`, never a guessed empty array — the same
    // "absence of evidence is not evidence of a clean set" rule `ciVerdictOf`
    // itself follows for its `unknown:` cases.
    expect(failingNames([], null, false)).toBeNull();
    expect(failingNames([], [], true)).toBeNull();
  });

  it("failingStatusNames returns the commit-status-only complement of failingCheckRunNames", () => {
    const status = (context: string, state: string): EvidenceCommitStatus => ({
      context,
      state,
      description: null,
    });
    expect(failingStatusNames([status("Schema gate", "failure")])).toEqual([
      "Schema gate",
    ]);
    // A name shared with a failing check-run still appears here — this
    // function knows nothing about check-runs at all, which is the whole
    // point: it is the independent, check-run-blind witness `drive.ts` needs
    // to tell a purely check-run-sourced required failure from one that ALSO
    // has a fresh, unambiguous status occurrence under the same name.
    expect(
      failingStatusNames([
        status("Schema gate", "failure"),
        status("other-context", "error"),
      ]),
    ).toEqual(["Schema gate", "other-context"]);
    // Passing/pending states never appear.
    expect(
      failingStatusNames([
        status("ok", "success"),
        status("still-running", "pending"),
      ]),
    ).toEqual([]);
    // Unreadable evidence is `null`, never a guessed empty array.
    expect(failingStatusNames(null)).toBeNull();
  });

  it("treats a mixed verdict as actionable when only one failing name is a stale required check", async () => {
    // The general form of the cascade above, but with the required
    // check ALSO failing rather than skipped — the exact shape the review
    // finding named: `failing: Schema gate, detect-changes` with
    // `finalCi.code === 4`. The old `.some()` predicate read ANY required
    // name in the verdict as proof the WHOLE verdict was unreliable,
    // deferring `detect-changes` — a definitively fresh, non-required
    // failure — to the witness wait right alongside the ambiguous `Schema
    // gate` one, contradicting the neighbouring comment's own stated intent
    // that a non-required failure "is trusted immediately". Fixed, the
    // verdict is stale only when EVERY failing name is required, so this
    // mixed case is dispatched as an ordinary CI-repair instead.
    const mixed: CheckRunFixture[] = [
      {
        name: "Schema gate",
        status: "completed",
        conclusion: "failure",
        app: "github-actions",
        started: "2026-09-10T10:01:00Z",
      },
      {
        name: "detect-changes",
        status: "completed",
        conclusion: "failure",
        app: "github-actions",
        started: "2026-09-10T10:01:00Z",
      },
    ];
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [REVIEWER_RUN, DORMANT_ARM, ...mixed],
    });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([
        {
          node_id: "LE_1",
          event: "labeled",
          label: { name: "ci:hold" },
          actor: { login: "drive-user" },
          created_at: "2026-09-10T09:59:00Z",
        },
      ]),
    );
    const seeded = await state(
      stateDir,
      [
        "set-ci-hold",
        "999",
        "--set",
        "held",
        "--event-id",
        "LE_1",
        "--head",
        scratchClean.head,
        "--actor-name",
        "drive-user",
        "--created-at",
        "2026-09-10T09:59:00Z",
        "--check-run-watermark",
        "10000",
      ],
      scratchClean.dir,
    );
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      [
        "--keep-draft",
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        ...PASS_TASK,
      ],
      undefined,
      {
        env: {
          DRIVE_PR_CI_REPAIR_ROUNDS: "1",
          // Bounds a hypothetical regression to a fast failure instead of a
          // 30-minute hang: against the OLD `.some()` predicate this fixture
          // falls into the witness wait instead of dispatching a repair.
          DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1",
        },
      },
    );
    expect(r.stderr).toContain("TASK=ci-repair");
    expect(r.stderr).toContain("DETAIL=Schema gate, detect-changes");
    expect(r.stderr).not.toContain(
      "no fresh exact-head required-check witness",
    );
  });

  it("drive-status.ts's --json output actually carries failingCheckNames/failingCheckRunNames/failingStatusNames", async () => {
    // `evaluate()` has computed both fields on its internal report object
    // since round 2, but the CLI's own `emit()` never included either in the
    // hand-built JSON payload — so every consumer reading
    // `finalStatus.failingCheckNames`/`failingCheckRunNames` (drive.ts) saw
    // `undefined` in production, no matter how carefully the predicate that
    // reads them was tuned. Pinned directly against the real subprocess
    // output rather than only through drive.ts's own end-to-end behavior, so
    // a future refactor of emit()'s payload cannot silently drop the field
    // again without this failing. `failingStatusNames` (round 5) gets the
    // identical pin for the same reason — the provenance fix in drive.ts is
    // only real if this field actually reaches the CLI boundary.
    const { dir, stateDir } = writeFixture({
      threads: [],
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        {
          name: "Schema gate",
          status: "completed",
          conclusion: "failure",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
      ],
      statuses: [{ context: "legacy-ctx", state: "failure", description: "" }],
    });
    const r = await probeIn(dir, stateDir);
    expect(r.json.failingCheckNames).toEqual(["Schema gate", "legacy-ctx"]);
    expect(r.json.failingCheckRunNames).toEqual(["Schema gate"]);
    expect(r.json.failingStatusNames).toEqual(["legacy-ctx"]);
  });

  it("defers a PURELY check-run required-check failure to the witness wait rather than dispatching CI-repair immediately", async () => {
    // The scenario `staleRequiredFailure` exists to protect: EVERY failing
    // name is both required and confirmed check-run-sourced, so the failure
    // could still be the stale, pre-unlabel snapshot rather than a fresh
    // result. Before this fix this never actually deferred — see the
    // sibling test above pinning why: the evidence never reached drive.ts at
    // all, so this predicate was unconditionally `false` in production and
    // every such case was dispatched to CI-repair immediately, spending
    // budget on a failure that might not even be real yet.
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        {
          name: "Schema gate",
          status: "completed",
          conclusion: "failure",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
        // Forces `completedRequiredCi` false (hence `finalCi.code === 4`)
        // the same reliable way the "gives up with exit 4" fixture
        // above does: a required check whose fresh run completed `skipped`
        // is never a witness, regardless of id/watermark timing. Only these
        // two are skipped — 'Schema gate' keeps its real `failure` above —
        // so the aggregate verdict is `failing: Schema gate` while freshness
        // stays unconfirmed.
        {
          name: "code-quality-and-build",
          status: "completed",
          conclusion: "skipped",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
        {
          name: "tests",
          status: "completed",
          conclusion: "skipped",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
      ],
    });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([
        {
          node_id: "LE_1",
          event: "labeled",
          label: { name: "ci:hold" },
          actor: { login: "drive-user" },
          created_at: "2026-09-10T09:59:00Z",
        },
      ]),
    );
    const seeded = await state(
      stateDir,
      [
        "set-ci-hold",
        "999",
        "--set",
        "held",
        "--event-id",
        "LE_1",
        "--head",
        scratchClean.head,
        "--actor-name",
        "drive-user",
        "--created-at",
        "2026-09-10T09:59:00Z",
        "--check-run-watermark",
        "10000",
      ],
      scratchClean.dir,
    );
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      [
        "--keep-draft",
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        ...PASS_TASK,
      ],
      undefined,
      {
        env: {
          DRIVE_PR_CI_REPAIR_ROUNDS: "1",
          DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1",
        },
      },
    );
    expect(r.stderr).not.toContain("TASK=ci-repair");
    // The `staleRequiredFailure` wording variant, not the "nothing is
    // failing" one the all-skipped fixtures above assert —
    // distinct because this scenario has a real, named failing check.
    expect(r.stderr).toContain(
      "are required checks final-ready could not confirm are fresh",
    );
  }, 30000);

  it("does NOT defer a required-named failure sourced from a legacy commit status, never a check-run", async () => {
    // `completedRequiredCi()` (ci-hold.ts) reads check-runs alone — it has no
    // notion of a commit status at all — so the freshness ambiguity
    // `finalCi.code === 4` encodes can never apply to a commit-status-sourced
    // failure, however it happens to be named. A legacy status context named
    // 'Schema gate' carries no watermark/timing uncertainty whatsoever, and
    // must be dispatched to CI-repair immediately rather than held back
    // behind the same exemption a genuine check-run gets.
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        // Same `finalCi.code === 4` forcing technique as the sibling test
        // above — 'Schema gate' itself is left to its default PASSING
        // check-run (from `REQUIRED_CI_RUNS`), so the ONLY failing evidence
        // named 'Schema gate' is the legacy commit status below.
        {
          name: "code-quality-and-build",
          status: "completed",
          conclusion: "skipped",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
        {
          name: "tests",
          status: "completed",
          conclusion: "skipped",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
      ],
      statuses: [{ context: "Schema gate", state: "failure", description: "" }],
    });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([
        {
          node_id: "LE_1",
          event: "labeled",
          label: { name: "ci:hold" },
          actor: { login: "drive-user" },
          created_at: "2026-09-10T09:59:00Z",
        },
      ]),
    );
    const seeded = await state(
      stateDir,
      [
        "set-ci-hold",
        "999",
        "--set",
        "held",
        "--event-id",
        "LE_1",
        "--head",
        scratchClean.head,
        "--actor-name",
        "drive-user",
        "--created-at",
        "2026-09-10T09:59:00Z",
        "--check-run-watermark",
        "10000",
      ],
      scratchClean.dir,
    );
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      [
        "--keep-draft",
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        ...PASS_TASK,
      ],
      undefined,
      {
        env: {
          DRIVE_PR_CI_REPAIR_ROUNDS: "1",
          DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1",
        },
      },
    );
    expect(r.stderr).toContain("TASK=ci-repair");
    expect(r.stderr).toContain("DETAIL=Schema gate");
    expect(r.stderr).not.toContain(
      "no fresh exact-head required-check witness",
    );
  }, 30000);

  it("does NOT defer a required-named failure that is BOTH an unconfirmed check-run AND a fresh legacy commit status under the same name", async () => {
    // The exact provenance gap the round-5 finding named: `failingCheckNames`
    // merges check-run and commit-status names with no per-entry provenance,
    // so `finalFailingCheckRunNames.includes('Schema gate')` was true for
    // BOTH the check-run occurrence and the status occurrence once a legacy
    // status shares the required check's exact name — the old predicate
    // could not tell them apart by name alone, and deferred the whole thing
    // to the witness wait even though the status-sourced failure carries no
    // freshness ambiguity whatsoever and is actionable right now.
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        {
          name: "Schema gate",
          status: "completed",
          conclusion: "failure",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
        // Same `finalCi.code === 4` forcing technique as the sibling tests
        // above — only these two are skipped, so freshness of the required
        // check-run set stays unconfirmed.
        {
          name: "code-quality-and-build",
          status: "completed",
          conclusion: "skipped",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
        {
          name: "tests",
          status: "completed",
          conclusion: "skipped",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
      ],
      // A SECOND, independent failure source under the IDENTICAL name — this
      // is what the old predicate could not distinguish from the check-run
      // occurrence above.
      statuses: [{ context: "Schema gate", state: "failure", description: "" }],
    });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([
        {
          node_id: "LE_1",
          event: "labeled",
          label: { name: "ci:hold" },
          actor: { login: "drive-user" },
          created_at: "2026-09-10T09:59:00Z",
        },
      ]),
    );
    const seeded = await state(
      stateDir,
      [
        "set-ci-hold",
        "999",
        "--set",
        "held",
        "--event-id",
        "LE_1",
        "--head",
        scratchClean.head,
        "--actor-name",
        "drive-user",
        "--created-at",
        "2026-09-10T09:59:00Z",
        "--check-run-watermark",
        "10000",
      ],
      scratchClean.dir,
    );
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      [
        "--keep-draft",
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        ...PASS_TASK,
      ],
      undefined,
      {
        env: {
          DRIVE_PR_CI_REPAIR_ROUNDS: "1",
          // Bounds a regression to a fast failure instead of a 30-minute
          // hang: against the unfixed predicate this fixture falls into the
          // witness wait instead of dispatching a repair.
          DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1",
        },
      },
    );
    expect(r.stderr).toContain("TASK=ci-repair");
    expect(r.stderr).toContain("DETAIL=Schema gate");
    expect(r.stderr).not.toContain(
      "no fresh exact-head required-check witness",
    );
  }, 30000);

  it("a CI-repair pass that hits its own deadline still stops cleanly, not crashing on the new witness check", async () => {
    // Regression guard for the review finding's WITNESSED branch:
    // `runRepairPass` now captures the spawn's `RunHandle` and, on
    // `res.timedOut`, re-joins its termination witness before deciding
    // anything — mirroring the ordinary-pass path's own PASS_DEADLINE
    // handling. This pins that the common (witnessed) case — the repair
    // pass's own process tree genuinely dies on the deadline kill, which is
    // what a plain `sleep` does — still falls through to the unchanged
    // "repair failed, stop for /fix-ci" outcome rather than the new code
    // mistaking a normal, witnessed kill for a surviving descendant. The
    // sibling, genuinely UNWITNESSED case (a descendant that outlives
    // SIGKILL) has no portable way to construct in this suite — same as the
    // ordinary-pass path's identical branch, which this suite does not
    // separately probe either; both rest on the shared `RunHandle.stop()`
    // machinery already being covered where IT is implemented.
    const cascade: CheckRunFixture[] = [
      {
        name: "detect-changes",
        status: "completed",
        conclusion: "failure",
        app: "github-actions",
        started: "2026-09-10T10:01:00Z",
      },
      {
        name: "code-quality-and-build",
        status: "completed",
        conclusion: "skipped",
        app: "github-actions",
        started: "2026-09-10T10:01:00Z",
      },
      {
        name: "tests",
        status: "completed",
        conclusion: "skipped",
        app: "github-actions",
        started: "2026-09-10T10:01:00Z",
      },
    ];
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [REVIEWER_RUN, DORMANT_ARM, ...cascade],
    });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([
        {
          node_id: "LE_1",
          event: "labeled",
          label: { name: "ci:hold" },
          actor: { login: "drive-user" },
          created_at: "2026-09-10T09:59:00Z",
        },
      ]),
    );
    const seeded = await state(
      stateDir,
      [
        "set-ci-hold",
        "999",
        "--set",
        "held",
        "--event-id",
        "LE_1",
        "--head",
        scratchClean.head,
        "--actor-name",
        "drive-user",
        "--created-at",
        "2026-09-10T09:59:00Z",
        "--check-run-watermark",
        "10000",
      ],
      scratchClean.dir,
    );
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      [
        "--keep-draft",
        "--no-head-sync",
        "--pass-timeout",
        "1",
        "--",
        "sh",
        "-c",
        ": pass for 999; sleep 60",
      ],
      undefined,
      { env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" } },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("the CI-repair pass failed");
    expect(r.stderr).toContain("stopping for /fix-ci by hand");
    // The unwitnessed-only branch must NOT fire here — the pass tree is a
    // plain `sleep`, which dies cleanly on the deadline's SIGKILL.
    expect(r.stderr).not.toContain("could NOT be witnessed");
  });

  it("re-certifies the worktree after final verification before exiting 0", async () => {
    const repo = makeScratchRepo("scratch-drive-final-verify-dirty");
    const r = await runDrive(
      {
        threads: [],
        head: repo.head,
        reviewedSha: repo.head,
        dirtyOnFinalVerify: true,
      },
      ["--keep-draft", "--no-head-sync", "--", ...PASS_LOUD],
      repo.dir,
    );
    expect(r.exitCode).toBe(12);
    expect(r.stderr).toContain("uncommitted state");
    expect(r.stderr).toContain("leftover-final-verify.txt");
    expect(r.stderr).not.toContain("in this run");
  });

  it("stops instead of spinning when the transition FAILS on the converged path", async () => {
    // mark-ready.ts releases its durable claim when `gh pr ready` fails, so
    // looping back would converge, fail, release and converge again forever.
    // The claim's own safety property is what makes the naive retry unbounded,
    // which is why this stop is explicit rather than incidental.
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
      isDraft: true,
    });
    writeFileSync(join(dir, "pr-ready-fails"), "");
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("gh pr ready 999");
    // Released, so a later drive retries rather than believing it done.
    expect((await state(stateDir, ["ready-marked", "999"])).stdout.trim()).toBe(
      "0",
    );
  });

  it("propagates PR_NOT_OPEN when the PR closes while the converged drive marks it Ready", async () => {
    // The converged branch used to treat mark-ready.ts's exit 5 as "nothing
    // owed" and fall through to exit 0 — reporting convergence, the signal an
    // operator merges on, about a PR that had already merged or closed. Exit 5
    // is a FRESHER observation of the same liveness fact the gate reports as
    // PR_NOT_OPEN, so it wins over the gate's (docomply-review round 2, PR
    // #4057).
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
      isDraft: true,
    });
    writeFileSync(join(dir, "pr-closes-before-mark-ready"), "");
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("stopped being open");
    // Never summoned, and nothing recorded: there was no transition to make.
    expect(existsSync(join(dir, "ready-calls"))).toBe(false);
    expect((await state(stateDir, ["ready-marked", "999"])).stdout.trim()).toBe(
      "0",
    );
  });

  it("stops after a SECOND consecutive post-round transition failure, rather than driving on silently", async () => {
    // The post-round hook ignored mark-ready.ts's exit code entirely, so a
    // permanently failing transition — an unwritable store, a revoked token —
    // ran the whole round budget out with the PR still a draft and said
    // nothing about why (docomply-review rounds 1-3, PR #4057).
    //
    // Round 1's `gh pr ready` failure is genuinely AMBIGUOUS (a nonzero exit
    // plus an observed OPEN draft is not proof it never applied — docomply-
    // review round 13, PR #4057), so mark-ready.ts now PRESERVES the lease
    // rather than releasing it. `gh pr ready` is therefore only ever called
    // ONCE here: round 2's call finds that same still-live lease and reports
    // `claimed-by-other` without dispatching again. It is still the SECOND
    // consecutive failure-class outcome that stops the drive — before
    // `--max-rounds 5` would have hidden it — just via a different mark-
    // ready.ts outcome than round 1's, not a second literal dispatch.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraft: true,
    });
    writeFileSync(join(dir, "pr-ready-fails"), "");
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--max-rounds",
      "5",
      "--",
      ...PASS_NOOP,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("2 in a row");
    expect(r.stderr).toContain("gh pr ready 999");
    // Stopped on round 2, not run out to the bound — the report must be about
    // the transition, never a quiet non-convergence.
    expect(r.stderr).not.toContain("NON-CONVERGENCE");
    // Only ONE actual dispatch — round 2 is blocked by round 1's own
    // preserved lease, not a second `gh pr ready` call.
    expect(
      readFileSync(join(dir, "ready-calls"), "utf8").trim().split("\n"),
    ).toHaveLength(1);
  });

  it("hits --max-rounds with an explicit non-convergence report, not a quiet stop", async () => {
    // The stub pass changes nothing, so every round stays ROUND_READY. The
    // stall stop would (correctly) name that first at the same gate the budget
    // trips on; it is disabled here because THIS probe's subject is the
    // explicit non-convergence report the budget exit owes — the stall
    // behaviour has its own probes below.
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      ["--no-head-sync", "--max-rounds", "2", "--", ...PASS_NOOP],
      undefined,
      { env: { DRIVE_PR_STALL_ROUNDS: "0" } },
    );
    expect(r.exitCode).toBe(6);
    expect(r.stderr).toContain("NON-CONVERGENCE");
  });

  it("stops with the stall exit (14) after two passes that change nothing, instead of looping to --max-rounds", async () => {
    // The regression the two issues measured: a pass that exits 0 without
    // acting (there: standing down against its own parent driver) ran 5 and 10
    // full rounds with every round header looking healthy. No env override
    // here — this probe pins the DEFAULT threshold of 2, so a default change
    // shows up as a red rather than a silent behaviour shift.
    //
    // `--head` because the stall verdict needs a MEASURED local head, and the
    // scratch repo's own HEAD is not the fixture's: `--no-head-sync` alone
    // leaves nothing measured and produces no fingerprint at all (PR #4106).
    const r = await runDrive(
      {
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
      },
      ["--max-rounds", "10", "--", ...PASS_NOOP],
    );
    expect(r.exitCode).toBe(14);
    // Names what did NOT happen — the distinguishing evidence an earlier change found
    // present in the log but never surfaced as an error.
    expect(r.stderr).toContain("changed NOTHING");
    expect(r.stderr).toContain("unresolved thread");
    expect(r.stderr).toContain("for a competing drive");
    // Stopped at the third gate: rounds 1 and 2 ran, round 3 never started,
    // and the budget exit never fired.
    expect(r.stderr).toContain("--- round 2/10");
    expect(r.stderr).not.toContain("--- round 3/10");
    expect(r.stderr).not.toContain("hit --max-rounds");
  });

  // ── Spawn-boundary integration floor ──────────────────────────────────────
  // The twin of the stall-exit-14 test above, changing exactly one input: this
  // one forwards `--no-head-sync`. Reusing the SAME real scratch worktree and
  // the same no-op pass means the only thing that can make it come out
  // differently is whether `drive.ts` actually forwards the flag to the
  // `drive-status.ts` child it spawns. If that forwarding regresses, the
  // child measures a real, unmoving local HEAD exactly as the test above does,
  // the fingerprint repeats, and this test would stall at exit 14 by round 3
  // — same as its twin — instead of reaching --max-rounds.
  it("forwards --no-head-sync to its drive-status.ts child, so a real unmoving HEAD never stalls the loop", async () => {
    const r = await runDrive(
      {
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
      },
      ["--no-head-sync", "--max-rounds", "3", "--", ...PASS_NOOP],
    );
    expect(r.exitCode).toBe(6);
    expect(r.stderr).not.toContain("changed NOTHING");
    expect(r.stderr).toContain("--- round 3/3");
  });

  it("has no --head to forward: a frozen head is not a measurement (all three reviewers, PR #4106)", async () => {
    // Briefly forwarded, and wrong three ways at once: frozen at startup it
    // wedges the head-sync guard in HEAD_LAG the moment a pass pushes; being an
    // assertion about one instant it cannot attest sameness for the stall stop;
    // and it left drive.ts's own convergence certification reading the driver's
    // unrelated checkout. drive.ts drives the tree it RUNS in — $DRIVE_PR_WORKTREE
    // re-measures there every gate — so the flag must be refused rather than
    // quietly ignored, or the footgun returns as a no-op flag.
    const r = await runDrive({ threads: [] }, [
      "--head",
      HEAD,
      "--",
      ...PASS_NOOP,
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown flag: --head");
  });

  // ── Spawn-boundary integration floor ──────────────────────────────────────
  // The NEGATIVE half of the stall floor. Its twin is `stops with the stall
  // exit (14) after two passes that change nothing` above: between them a real
  // `drive.ts` still witnesses both directions of the composition — gate →
  // fingerprint → streak → exit code — that the unit fold below cannot reach.
  // This one is kept rather than one of the other three negative drives because
  // its pass does REAL work through the gate (it resolves a thread per round,
  // so the fixture, the forge stub and `evaluate()`'s key arrays are all live),
  // where those manufactured their sequences from a null or a swap the
  // fingerprint probes already cover directly.
  it("does not stall-stop while rounds make observable progress", async () => {
    // Each pass drops one review thread from the fixture, so every gate reads
    // a different unresolved SET: the fingerprint moves, the streak resets,
    // and the plain --max-rounds bound is what ends the drive. This is the
    // probe that distinguishes "streak of identical gates" from "any N
    // completed passes" — an over-eager detector that ignores the fingerprint
    // turns this red with a 13.
    const PASS_RESOLVES_ONE = [
      "sh",
      "-c",
      ': pass for 999; jq \'.data.repository.pullRequest.reviewThreads.nodes |= .[1:]\' "$DRIVE_PR_FIXTURES/threads.json" > "$DRIVE_PR_FIXTURES/threads.json.tmp" && mv "$DRIVE_PR_FIXTURES/threads.json.tmp" "$DRIVE_PR_FIXTURES/threads.json"',
    ];
    const r = await runDrive(
      {
        threads: [
          { id: "PRRT_a", path: "a.ts", bot: true },
          { id: "PRRT_b", path: "b.ts", bot: true },
          { id: "PRRT_c", path: "c.ts", bot: true },
        ],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
      },
      ["--max-rounds", "2", "--", ...PASS_RESOLVES_ONE],
    );
    expect(r.exitCode).toBe(6);
    expect(r.stderr).not.toContain("changed NOTHING");
  });

  // ── Spawn-boundary integration floor ──────────────────────────────────────
  // The composition the fold's own unit probes cannot reach: real threads,
  // read through the REAL `list-unresolved-threads.ts` → `evaluate.ts` →
  // `drive-status.ts` pipeline, producing `unresolvedThreadKeys` that swap
  // identity at EQUAL cardinality — not the count-reducing resolve the
  // progress probe above exercises, and not the hand-built report `roundFingerprint
  // — what counts as evidence of sameness` asserts over directly. A
  // regression where that pipeline preserves the thread COUNT but emits
  // stale, missing or duplicated identities would pass both of those and
  // still let the real driver stop on a false repeated fingerprint
  // (docomply-review round 3, a reference-implementation pull request).
  it("does not stall-stop while a same-count set of unresolved threads keeps swapping identity", async () => {
    // Three real threads, none resolved yet at the first gate. Each pass
    // marks exactly ONE of them resolved and the other two unresolved — a
    // rotating single-resolved-thread window — so the unresolved set is
    // always cardinality 2, but which two ids they are changes every round.
    const PASS_SWAPS_ONE = [
      "sh",
      "-c",
      `: pass for 999; n=$(( $(cat "$DRIVE_PR_FIXTURES/swap-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$DRIVE_PR_FIXTURES/swap-count"; idx=$(( (n - 1) % 3 )); jq --argjson idx "$idx" '.data.repository.pullRequest.reviewThreads.nodes |= (to_entries | map(.value.isResolved = (.key == $idx)) | map(.value))' "$DRIVE_PR_FIXTURES/threads.json" > "$DRIVE_PR_FIXTURES/threads.json.tmp" && mv "$DRIVE_PR_FIXTURES/threads.json.tmp" "$DRIVE_PR_FIXTURES/threads.json"`,
    ];
    const r = await runDrive(
      {
        threads: [
          { id: "PRRT_a", path: "a.ts", bot: true },
          { id: "PRRT_b", path: "b.ts", bot: true },
          { id: "PRRT_c", path: "c.ts", bot: true },
        ],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
      },
      ["--max-rounds", "3", "--", ...PASS_SWAPS_ONE],
    );
    expect(r.exitCode).toBe(6);
    expect(r.stderr).not.toContain("changed NOTHING");
  });

  // ── Spawn-boundary integration floor ──────────────────────────────────────
  // The composition the fold's own unit probes cannot reach: a REAL
  // `drive-state.ts park` call, through the NEXT round's real
  // `drive-status.ts` report, into `roundFingerprint`'s own `parkedItemKeys`
  // read, into the streak decision — rather than a hand-built fingerprint
  // string standing in for what parking is asserted to do.
  it("does not stall-stop while rounds keep parking a different finding", async () => {
    // Each pass parks one more finding than the last, so the unresolved
    // thread set never moves but the parked set grows every round: the
    // fingerprint changes on `parkedItemKeys` alone, which is exactly what a
    // regression that dropped parked keys from the fingerprint would not
    // catch through the thread-identity-swap probe above.
    const PASS_PARKS_ONE = [
      "sh",
      "-c",
      `n=$(( $(cat "$DRIVE_PR_FIXTURES/park-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$DRIVE_PR_FIXTURES/park-count"; "${join(SCRIPTS, "drive-state.ts")}" park 999 --key "finding-$n" --kind finding --reason "round $n work"`,
    ];
    const r = await runDrive(
      {
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
      },
      ["--max-rounds", "3", "--", ...PASS_PARKS_ONE],
    );
    expect(r.exitCode).toBe(6);
    expect(r.stderr).not.toContain("changed NOTHING");
  });

  // ── Converted to unit seams ──────────────────────────────────
  // `drive.ts` drives used to live here — a pass that SUBSTITUTES one thread
  // for another, one run under `--no-head-sync`, one whose local-HEAD
  // measurement FAILED, and one whose passes PARK summary findings. Each
  // manufactured a fingerprint sequence by running two or three real rounds
  // against a stubbed forge, and each asserted the same two things about it:
  // that `roundFingerprint` moves (or refuses) on the input in question, and
  // that a streak which never repeats never stops the loop.
  //
  // The first half is asserted directly, and more sharply, in
  // `roundFingerprint — what counts as evidence of sameness`: substitution at
  // equal cardinality, a changed parked set, and every non-`git` provenance
  // including `disabled` and `unavailable` all have probes there over
  // hand-built reports. The `--no-head-sync` → `disabled` and failed-read →
  // `unavailable` values those probes assume are in turn pinned against a real
  // `drive-status.ts` in `drive-status.ts measures local HEAD in the tree being
  // driven`. So the drives were re-deriving, at ~13s each, inputs two cheaper
  // probes already establish.
  //
  // The second half — the fold itself — is what was genuinely only asserted
  // through them, and it is asserted here instead. What no unit test can show
  // is the composition reaching a real exit code, so drives are kept for that
  // and named as the floor below: one that must stop (14), and several that
  // must not (6) — thread substitution, `--no-head-sync` forwarding, and a
  // growing parked set are each a different way to move the fingerprint.
  // ~53s recovered.
  it("resets the no-op streak on anything short of a witnessed repeat", () => {
    const A = "fingerprint-a";
    const B = "fingerprint-b";
    // A REPEAT is the only thing that extends a streak.
    expect(advanceStallStreak(A, A, 0)).toBe(1);
    expect(advanceStallStreak(A, A, 1)).toBe(2);
    expect(advanceStallStreak(A, A, 7)).toBe(8);
    // Work happened: the gate observed something different.
    expect(advanceStallStreak(A, B, 3)).toBe(0);
    // This gate could not measure — a `--no-head-sync` run, a failed local-HEAD
    // read, a report missing the key arrays. Never sameness.
    expect(advanceStallStreak(A, null, 3)).toBe(0);
    // The PREVIOUS gate could not measure, so there is nothing to have
    // repeated. `null === null` must not read as a match, which is the one
    // case a naive equality check gets wrong.
    expect(advanceStallStreak(null, null, 3)).toBe(0);
    expect(advanceStallStreak(null, A, 3)).toBe(0);
    // The first round of any drive: no previous gate at all.
    expect(advanceStallStreak(null, A, 0)).toBe(0);
  });

  it("never stops a drive whose gates keep changing, however long it runs", () => {
    // The property the converted drives were each one instance of: a
    // sequence that never repeats can never reach any positive threshold,
    // whatever the fingerprints are and however many rounds pass. Folded over
    // the real function rather than reasoned about — an off-by-one that
    // extended the streak on a CHANGE would survive any single-step check that
    // happened to compare the wrong pair.
    const sequences: Array<Array<string | null>> = [
      // A pass resolves one thread per round: every gate a different set.
      ["t=[a,b,c]", "t=[b,c]", "t=[c]"],
      // A SUBSTITUTION at equal cardinality — the count never moves, the ids do.
      ["t=[a]", "t=[swap1]", "t=[swap2]"],
      // Passes park a different finding each round; nothing else moves.
      ["p=[]", "p=[b9a7]", "p=[b9a7,c773]"],
      // `--no-head-sync`, or a failed local-HEAD read: nothing fingerprints.
      [null, null, null, null],
      // A genuine no-op round in the middle, but never two in a row.
      ["x", "x", "y", "y", "z"],
    ];
    const worst = sequences.map((seq) => {
      let streak = 0;
      let peak = 0;
      let prev: string | null = null;
      for (const next of seq) {
        streak = advanceStallStreak(prev, next, streak);
        peak = Math.max(peak, streak);
        prev = next;
      }
      return peak;
    });
    // The default threshold is 2, so a peak of 1 is still short of a stop —
    // the no-op-round-in-the-middle sequence above has exactly one repeat and
    // must not stall.
    expect(worst).toEqual([0, 0, 0, 0, 1]);
  });

  it("stops after a SECOND consecutive claimed-by-other, not just a repeated hard failure (docomply-review round 6, a reference-implementation pull request)", async () => {
    // A permanently-orphaned lease (a killed helper's cleanup never ran, and
    // no live driver is actually holding it) reports `claimed-by-other` —
    // exit 0 — every round. Leaving `readyMarkFailures` merely UNCHANGED on
    // that outcome (rather than counting it) meant it could never reach the
    // `>= 2` stop condition by itself, so the drive would exhaust
    // `--max-rounds` with the PR still a draft rather than stopping and
    // naming the stuck lease.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraft: true,
    });
    writeFileSync(
      join(stateDir, "drive-pr-999.ready-claim"),
      "other-driver-token",
    );
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--max-rounds",
      "5",
      "--",
      ...PASS_NOOP,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("2 in a row");
    expect(r.stderr).toContain("Ready-mark lease is held elsewhere");
    // Stopped on round 2, not run out to the bound.
    expect(r.stderr).not.toContain("NON-CONVERGENCE");
    // Never fired `gh pr ready` — the lease was never this drive's to use.
    expect(existsSync(join(dir, "ready-calls"))).toBe(false);
  });

  it("exits 0 on a converged drive", async () => {
    const r = await runDrive(
      { threads: [], reviewedSha: scratchClean.head, head: scratchClean.head },
      ["--no-head-sync", "--", ...PASS_NOOP],
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("converged");
  });

  it("does NOT exit 0 when convergence leaves the Ready-mark lease to another driver (docomply-review round 6, a reference-implementation pull request)", async () => {
    // The reviewer converged with no round to run, so this drive tries to
    // record the already-Ready-or-draft transition — but another driver
    // already holds the lease. Exit 0 here would claim full convergence over
    // a PR that may stay a draft forever if that other driver dies holding
    // it, with nothing left to retry: the exact false terminal the
    // converged-draft handling exists to eliminate. Pre-seed a live lease
    // file, exactly what a concurrent driver's `claim-ready-mark` leaves
    // behind.
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
      isDraft: true,
    });
    writeFileSync(
      join(stateDir, "drive-pr-999.ready-claim"),
      "other-driver-token",
    );
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_NOOP,
    ]);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("another driver holds the Ready-mark lease");
    expect(r.stderr).not.toContain("converged after");
    // Never summoned, and no durable claim taken — this drive owed the
    // transition nothing it could actually deliver.
    expect(existsSync(join(dir, "ready-calls"))).toBe(false);
    expect((await state(stateDir, ["ready-marked", "999"])).stdout.trim()).toBe(
      "0",
    );
  });

  it("does NOT exit 0 when convergence hits a still-draft record either, and does NOT auto-retry it (docomply-review rounds 13 and 22, PR #4057)", async () => {
    // The reviewer converged with the PR already Ready per THIS gate's own
    // snapshot (isDraft: false), so the converged-path call now uses
    // --record-only — but the owner converts the PR to draft in the window
    // before that call's own live read, so it observes a draft and records
    // nothing (still-draft). Exit 0 here would claim full convergence over a
    // PR that is genuinely a draft again by the owner's own action.
    //
    // Exit 1, not 4 (round 22): nothing durable was written when this
    // observation was made, so an unattended wrapper's plain retry would just
    // reach this exact branch again rather than resolve anything — this needs
    // a fresh top-level look, not mechanical repetition.
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
      isDraft: false,
    });
    writeFileSync(join(dir, "draft-flip-before-record-only-read"), "");
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_NOOP,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("the owner converted it back before this drive");
    expect(r.stderr).not.toContain("converged after");
    // Never dispatched, and no durable claim taken.
    expect(existsSync(join(dir, "ready-calls"))).toBe(false);
    expect((await state(stateDir, ["ready-marked", "999"])).stdout.trim()).toBe(
      "0",
    );
  });

  it("--keep-draft still records an already-Ready PR via the converged-path call (docomply-review round 14, a reference-implementation pull request)", async () => {
    // Same fix as the round-loop pre-pass test above, at the OTHER call site
    // the reviewer named ("The same !keepDraft gating on the converged path
    // shares this root cause"): a drive that converges with no round to run
    // and finds the PR already Ready must still record that observation
    // under --keep-draft, even though it must not dispatch anything.
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
      isDraft: false,
    });
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--keep-draft",
      "--",
      ...PASS_NOOP,
    ]);
    // Converges normally: nothing left to record, no lease, no dispatch.
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(dir, "ready-calls"))).toBe(false);
    expect(
      (await state(stateDir, ["ready-marked", "999"])).stdout.trim(),
    ).not.toBe("0");
  });

  it("records an already-Ready PR BEFORE the pass runs, so a mid-pass draft flip is not undone (chatgpt-codex-connector, a reference-implementation pull request)", async () => {
    // The PR is already Ready when the round starts (isDraft: false). Without
    // a pre-pass record, `readyMarkedRound` stays 0 for the whole pass; if the
    // owner converts the PR back to draft while it runs, the post-round call
    // sees readyMarkedRound === 0 PLUS the now-draft flag and fires
    // `gh pr ready`, reversing that decision.
    //
    // The pass command itself touches `mid-pass-draft-flip` as it runs,
    // modelling the owner's conversion landing DURING the pass — a wall-clock
    // event a read-counter cannot express, since exactly one of the pre-pass
    // and post-pass mark-ready.ts calls ever issues a live `state,isDraft`
    // read in either case (the other short-circuits on the durable record),
    // and it is always that read's first-ever occurrence either way.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraft: false,
    });
    const PASS_FLIPS_TO_DRAFT = [
      "sh",
      "-c",
      ': pass for 999; touch "$DRIVE_PR_FIXTURES/mid-pass-draft-flip"; exit 0',
    ];
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--max-rounds",
      "1",
      "--",
      ...PASS_FLIPS_TO_DRAFT,
    ]);
    // The stub pass changes nothing else, so the round stays ROUND_READY and
    // the drive hits its (deliberately tight) --max-rounds bound — that is
    // not what this test is about, only the transition's own safety is.
    expect(r.exitCode).toBe(6);
    // `gh pr ready` must never fire: the PR started Ready and was recorded as
    // such before the flip could matter.
    expect(existsSync(join(dir, "ready-calls"))).toBe(false);
    // The already-Ready state IS durably recorded — proving the pre-pass call
    // ran and won, not merely that nothing happened.
    expect(
      (await state(stateDir, ["ready-marked", "999"])).stdout.trim(),
    ).not.toBe("0");
  });

  it("does NOT run the pass when the pre-pass record comes back claimed-by-other (docomply-review round 10, a reference-implementation pull request)", async () => {
    // `claimed-by-other` is a recognized, exit-0 outcome — but it means NO
    // durable record was established at all; another driver holds the lease
    // and may record it, or may die holding it. Treating it as sufficient
    // confirmation would run the pass unprotected against exactly the
    // mid-pass draft-flip race this whole mechanism exists to close. A
    // pre-seeded live lease file is exactly what a concurrent driver's
    // claim-ready-mark leaves behind.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraft: false,
    });
    writeFileSync(
      join(stateDir, "drive-pr-999.ready-claim"),
      "other-driver-token",
    );
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "could not confirm PR #999's already-Ready state",
    );
    // The pass never ran — the round stopped before dispatching it.
    expect(r.stderr).not.toContain("RAN_THE_PASS");
    expect(existsSync(join(dir, "ready-calls"))).toBe(false);
    expect((await state(stateDir, ["ready-marked", "999"])).stdout.trim()).toBe(
      "0",
    );
  });

  it("does NOT run the pass when the pre-pass record comes back still-draft either (docomply-review round 11, a reference-implementation pull request)", async () => {
    // An earlier version of this fix treated `still-draft` as sufficient
    // confirmation, on the reasoning that the race window had already
    // closed. That reasoning had a hole: the PR was Ready at drive-status.ts's
    // own read (the guard for calling --record-only at all); if the owner
    // converts it to draft in the window before --record-only's OWN read,
    // nothing is recorded — leaving no evidence this was a Ready→draft
    // conversion rather than an ordinary never-marked draft. Running the pass
    // anyway means the post-round call later sees readyMarkedRound === 0 plus
    // isDraft === true and fires gh pr ready, undoing the conversion.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraft: false,
    });
    writeFileSync(join(dir, "draft-flip-before-record-only-read"), "");
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "could not confirm PR #999's already-Ready state",
    );
    // The pass never ran — the round stopped before dispatching it.
    expect(r.stderr).not.toContain("RAN_THE_PASS");
    expect(existsSync(join(dir, "ready-calls"))).toBe(false);
    expect((await state(stateDir, ["ready-marked", "999"])).stdout.trim()).toBe(
      "0",
    );
  });

  // Exit 0 is the signal an operator merges on, so it also certifies the
  // worktree kept nothing back. Convergence is a remote fact; every per-thread
  // clean-tree guard fires only at its own moment, so an edit no round shipped
  // — a scratch probe, a regenerated artefact, a pass that died mid-edit — was
  // previously exiting 0 and dying silently with the worktree.
  it("refuses to exit 0 on a converged drive over a dirty worktree", async () => {
    const dirty = makeScratchRepo("scratch-drive-dirty");
    writeFileSync(
      join(dirty.dir, "leftover.txt"),
      "an edit no round shipped\n",
    );
    const r = await runDrive(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      ["--no-head-sync", "--", ...PASS_NOOP],
      dirty.dir,
    );
    expect(r.exitCode).toBe(12);
    // The refusal names the convergence AND the leftovers — an operator must
    // learn both that the review is done and that the tree is not.
    expect(r.stderr).toContain("review converged");
    expect(r.stderr).toContain("uncommitted state");
    expect(r.stderr).toContain("leftover.txt");
    // The plain-success line must not appear — exit 12 replaces the exit-0
    // report rather than printing both.
    expect(r.stderr).not.toContain("in this run");
  });

  it("a dirty worktree ALSO leaves a converged draft unmarked — the transition sits behind the gate", async () => {
    // The composition of two independently-correct changes (an earlier change's clean
    // worktree gate and the draft→Ready transition), and the ordering between
    // them is a real decision rather than an artefact of whichever merged
    // second. `gh pr ready` fires `ready_for_review`, which spends the external
    // reviewer's one-pass-per-push budget on whatever head is current at that
    // instant. Over a dirty worktree that head is precisely the one about to
    // change once the operator commits the leftovers — so marking first would
    // spend the pass on a head nobody intends to keep, which is the exact waste
    // the transition exists to avoid.
    //
    // Same fixture as the dirty-tree test above, only a DRAFT. Exit 12 stands,
    // and the PR is still a draft afterwards for the operator's retry to mark.
    const dirty = makeScratchRepo("scratch-drive-dirty-draft");
    writeFileSync(
      join(dirty.dir, "leftover.txt"),
      "an edit no round shipped\n",
    );
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: dirty.head,
      head: dirty.head,
      isDraft: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--", ...PASS_NOOP],
      dirty.dir,
    );
    expect(r.exitCode).toBe(12);
    expect(r.stderr).toContain("uncommitted state");
    // Never summoned, and no durable claim taken — so the retry after the
    // operator cleans up still owes the transition.
    expect(existsSync(join(dir, "ready-calls"))).toBe(false);
    expect((await state(stateDir, ["ready-marked", "999"])).stdout.trim()).toBe(
      "0",
    );
  });

  it("the converged clean-tree check refuses on a git TIMEOUT rather than hanging (chatgpt-codex-connector, #4046 round 2)", async () => {
    // Same gap as announce-merge-ready.ts's sibling check: the `git status
    // --porcelain` call here carried no deadline either. The stub hangs ONLY
    // on `status --porcelain`; every other git call this process or
    // drive-status.ts makes (`rev-parse HEAD`, etc.) still reaches the real
    // binary, or the probe would time out for an unrelated reason first.
    const dirty = makeScratchRepo("scratch-drive-git-status-hang");
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("no git on PATH to wrap for this probe");
    const gitBinDir = mkdtempSync(join(tmpdir(), "drive-pr-drive-git-stub-"));
    const gitStubPath = join(gitBinDir, "git");
    writeFileSync(
      gitStubPath,
      [
        "#!/usr/bin/env bash",
        'if [ "${1:-}" = "status" ] && [ "${2:-}" = "--porcelain" ]; then',
        "  sleep 30",
        "  exit 0",
        "fi",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(gitStubPath, 0o755);
    const started = Date.now();
    const r = await runDrive(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      ["--no-head-sync", "--", ...PASS_NOOP],
      dirty.dir,
      { extraBinDir: gitBinDir, env: { GIT_CALL_TIMEOUT: "1" } },
    );
    const elapsed = Date.now() - started;
    expect(r.exitCode).toBe(12);
    expect(r.stderr).toContain("UNREADABLE");
    expect({
      boundedWellBeforeTheStubsSleepFinished: elapsed < 15_000,
    }).toEqual({ boundedWellBeforeTheStubsSleepFinished: true });
  });

  it("the converged clean-tree check still detects an untracked leftover under status.showUntrackedFiles=no (chatgpt-codex-connector, #4046 round 2)", async () => {
    // Same gap, and same fix, as announce-merge-ready.ts's sibling check.
    const dirty = makeScratchRepo("scratch-drive-showuntracked-no");
    Bun.spawnSync(["git", "config", "status.showUntrackedFiles", "no"], {
      cwd: dirty.dir,
      env: gitCleanEnv(),
    });
    writeFileSync(
      join(dirty.dir, "leftover-untracked.txt"),
      "an edit no round shipped, never git add-ed\n",
    );
    const r = await runDrive(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      ["--no-head-sync", "--", ...PASS_NOOP],
      dirty.dir,
    );
    expect(r.exitCode).toBe(12);
    expect(r.stderr).toContain("uncommitted state");
    expect(r.stderr).toContain("leftover-untracked.txt");
  });

  it("the converged clean-tree check still detects a dirty submodule ignored via submodule.<name>.ignore=all (docomply-review, #4046 round 3)", async () => {
    // Same gap, and same fix, as announce-merge-ready.ts's sibling check.
    const src = makeScratchRepo("scratch-drive-submodule-src");
    const dirty = makeScratchRepo("scratch-drive-submodule-outer");
    Bun.spawnSync(
      [
        "git",
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        src.dir,
        "sub",
      ],
      { cwd: dirty.dir, env: gitCleanEnv() },
    );
    Bun.spawnSync(["git", "add", "-A"], { cwd: dirty.dir, env: gitCleanEnv() });
    Bun.spawnSync(["git", "commit", "-qm", "add submodule", "--no-verify"], {
      cwd: dirty.dir,
      env: gitCleanEnv(),
    });
    Bun.spawnSync(["git", "config", "submodule.sub.ignore", "all"], {
      cwd: dirty.dir,
      env: gitCleanEnv(),
    });
    writeFileSync(
      join(dirty.dir, "sub", "seed.txt"),
      "an edit no round shipped, inside the submodule\n",
    );
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: dirty.dir,
      env: gitCleanEnv(),
    })
      .stdout.toString()
      .trim();
    const r = await runDrive(
      { threads: [], reviewedSha: head, head },
      ["--no-head-sync", "--", ...PASS_NOOP],
      dirty.dir,
    );
    expect(r.exitCode).toBe(12);
    expect(r.stderr).toContain("uncommitted state");
  });

  it("the converged clean-tree check refuses over an unconcluded merge even though porcelain status is empty (chatgpt-codex-connector, #4046 round 3)", async () => {
    // Same gap, and same fix, as announce-merge-ready.ts's sibling check.
    const dirty = makeUnresolvedMergeRepo("scratch-drive-unconcluded-merge");
    const r = await runDrive(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      ["--no-head-sync", "--", ...PASS_NOOP],
      dirty.dir,
    );
    expect(r.exitCode).toBe(12);
    expect(r.stderr).toContain("unconcluded git operation");
    expect(r.stderr).toContain("MERGE_HEAD");
  });

  it("the converged clean-tree check refuses over a paused interactive rebase even though the tree is clean (docomply-review, #4046 round 4)", async () => {
    // Same gap as the merge case above, one state further: an `edit`-paused
    // rebase leaves the checked-out commit's tree fully clean (nothing
    // uncommitted) while `rebase-merge` sits in the git-dir because the
    // rebase itself was never continued or aborted.
    const dirty = makeRebasePausedRepo("scratch-drive-rebase-paused");
    const r = await runDrive(
      { threads: [], reviewedSha: dirty.head, head: dirty.head },
      ["--no-head-sync", "--", ...PASS_NOOP],
      dirty.dir,
    );
    expect(r.exitCode).toBe(12);
    expect(r.stderr).toContain("unconcluded git operation");
    expect(r.stderr).toContain("rebase-merge");
  });

  it("refuses over a local commit that landed after the reviewed head, even with an otherwise clean tree (chatgpt-codex-connector, #4046 round 4)", async () => {
    // A commit is fully committed — nothing uncommitted, no unconcluded op —
    // so every OTHER check in this function passes over it. Only comparing
    // local HEAD against the head drive-status.ts reported as reviewed
    // catches a commit that landed here but was never pushed or reviewed.
    const dirty = makeScratchRepo("scratch-drive-local-head-drift");
    const reviewedHead = dirty.head;
    writeFileSync(join(dirty.dir, "unreviewed.txt"), "landed after review\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: dirty.dir, env: gitCleanEnv() });
    Bun.spawnSync(
      ["git", "commit", "-qm", "unreviewed local commit", "--no-verify"],
      { cwd: dirty.dir, env: gitCleanEnv() },
    );
    const r = await runDrive(
      { threads: [], reviewedSha: reviewedHead, head: reviewedHead },
      ["--no-head-sync", "--", ...PASS_NOOP],
      dirty.dir,
    );
    expect(r.exitCode).toBe(12);
    expect(r.stderr).toContain("local HEAD is");
    expect(r.stderr).toContain(`while the reviewed head is ${reviewedHead}`);
  });

  // The pre-pass liveness check cannot cover the minutes a round spends
  // triaging and running gates, so `guarded-push.ts` re-checks at the instant of
  // the push and exits 5 on a PR that merged in between. Flattening that to a
  // generic pass failure tells the caller its pass is broken about a PR that is
  // simply finished — and 5 is a documented TERMINAL state.
  it("propagates a pass exit 5 as PR_NOT_OPEN, not a generic pass failure", async () => {
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      [
        "--no-head-sync",
        "--",
        "sh",
        "-c",
        'echo "pass for 999: pushed onto a merged PR" >&2; exit 5',
      ],
    );
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("no longer open");
  });

  // And ONLY 5. The pass is an arbitrary command whose exit space is its own:
  // blanket propagation would let an agent exiting 3 for its own reasons report
  // SHA-verified convergence.
  //
  // Asserted against the exported mapping rather than by spawning a `drive.ts`
  // per code. That is not only cheaper (three drives, ~10.8s of a 733s suite —
  // an earlier change <!-- measured -->); it is what makes the claim's own word ONLY
  // checkable. A probe paying a full drive per code could afford three of them,
  // so "every other code" rested on a sample chosen for its price. Here the
  // whole 0-255 process-exit-status domain is free to run, so a one-line
  // production mutation special-casing an untested code (e.g. 7, which no
  // sample covered) cannot leave this test green.
  it("flattens every OTHER pass failure to 1, including drive-status codes", () => {
    for (let c = 0; c <= 255; c++) {
      const expected: ReturnType<typeof passExitDisposition> =
        c === 5
          ? { kind: "not-open", exit: 5 }
          : c === 0
            ? { kind: "ok", exit: 0 }
            : { kind: "failed", exit: 1 };
      expect(passExitDisposition(c)).toEqual(expected);
    }
  });

  describe("mailbox round control", () => {
    const work = {
      isDraft: true,
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    };

    it("stops before the first status gate or pass and releases its locks", async () => {
      const { dir, stateDir } = writeFixture(work);
      const mailboxDir = join(dir, "mailbox");
      await appendDirective(mailboxDir, "999", "test", "pause");
      await appendDirective(mailboxDir, "999", "test", "stop");
      const r = await runDriveIn(
        dir,
        stateDir,
        ["--no-head-sync", "--", ...PASS_LOUD],
        undefined,
        { env: { DRIVE_PR_MAILBOX_DIR: mailboxDir } },
      );
      expect(r.exitCode).toBe(MAILBOX_STOPPED_EXIT);
      expect(r.stderr).not.toContain("RAN_THE_PASS");
      expect(existsSync(join(stateDir, "pr-drive-999.lock"))).toBe(false);
    });

    it("times out a pause without spending a pass", async () => {
      const { dir, stateDir } = writeFixture(work);
      const mailboxDir = join(dir, "mailbox");
      await appendDirective(mailboxDir, "999", "test", "pause");
      const r = await runDriveIn(
        dir,
        stateDir,
        ["--no-head-sync", "--", ...PASS_LOUD],
        undefined,
        {
          env: {
            DRIVE_PR_MAILBOX_DIR: mailboxDir,
            DRIVE_PR_PAUSE_MAX_SEC: "1",
          },
        },
      );
      expect(r.exitCode).toBe(MAILBOX_PAUSE_TIMEOUT_EXIT);
      expect(r.stderr).not.toContain("RAN_THE_PASS");
      expect(existsSync(join(stateDir, "pr-drive-999.lock"))).toBe(false);
    });

    it("fails closed on an unreadable directive state", async () => {
      const { dir, stateDir } = writeFixture(work);
      const mailboxDir = join(dir, "mailbox");
      mkdirSync(mailboxDir, { recursive: true });
      writeFileSync(join(mailboxDir, "inbox.jsonl"), "{broken json\n");
      const r = await runDriveIn(
        dir,
        stateDir,
        ["--no-head-sync", "--", ...PASS_LOUD],
        undefined,
        { env: { DRIVE_PR_MAILBOX_DIR: mailboxDir } },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("mailbox gate state unreadable");
      expect(r.stderr).not.toContain("RAN_THE_PASS");
    });

    it("resumes a paused drive, then accepts a stop after its active pass finishes", async () => {
      const { dir, stateDir } = writeFixture(work);
      const mailboxDir = join(dir, "mailbox");
      const passStarted = join(dir, "pass-started");
      const passFinished = join(dir, "pass-finished");
      await appendDirective(mailboxDir, "999", "test", "pause");
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          "sh",
          "-c",
          `echo start > '${passStarted}'; sleep 2; echo done > '${passFinished}'; echo 'pass for 999' >&2`,
        ],
        {
          cwd: scratchClean.dir,
          env: {
            ...gitCleanEnv(),
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_MAILBOX_DIR: mailboxDir,
            // Must outlast every synchronization wait below it, not just the
            // pass itself (review finding): the first polling loop can spend
            // up to 100 * 100ms = 10s detecting "paused by mailbox" before
            // `resume` is even sent, plus up to 2s more for the driver's own
            // pause-checkpoint poll granularity (`Math.min(2, pauseMaxSec)`)
            // to notice it. An 8s bound could time the pause out before
            // `resume` ever lands under slow process startup or log
            // observation, failing the test for a reason that has nothing to
            // do with what it is testing.
            DRIVE_PR_PAUSE_MAX_SEC: "20",
            // Fast enough to observe a renewal well inside the sleeps below,
            // same seam the sibling 'renews a held claim DURING a pass' test
            // uses.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const logPath = join(stateDir, "drive-pr-999.log");
      for (let n = 0; n < 100; n++) {
        if (
          existsSync(logPath) &&
          readFileSync(logPath, "utf8").includes("paused by mailbox")
        )
          break;
        await Bun.sleep(100);
      }
      expect(existsSync(passStarted)).toBe(false);

      // Review finding: a post-exit check that the lock is gone proves the
      // pause eventually LETS GO — it says nothing about whether the lock
      // stayed HELD and FRESH while the pause was still active. Releasing
      // it at pause entry would satisfy every assertion above and below
      // just as well, despite breaking the single-driver guarantee a pause
      // must not weaken. Assert both directly, with the pause still live:
      const prLockDir = join(stateDir, "pr-drive-999.lock");
      const claimsInPrLock = () =>
        readdirSync(prLockDir).filter((n) => n.startsWith("claim."));
      const heldClaims = claimsInPrLock();
      expect(heldClaims.length).toBe(1);
      const claimPath = join(prLockDir, heldClaims[0] as string);
      const firstBeat = statSync(claimPath).mtimeMs;

      // A competing invocation against the SAME PR must still be refused —
      // a pause holds the lock, it does not release it.
      const competitor = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          cwd: scratchClean.dir,
          env: {
            ...gitCleanEnv(),
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [competitorStderr, competitorExit] = await Promise.all([
        new Response(competitor.stderr).text(),
        competitor.exited,
      ]);
      expect(competitorExit).toBe(11);
      expect(competitorStderr).not.toContain("RAN_THE_PASS");

      // And the lease must stay FRESH across a heartbeat interval — a
      // driver that stopped renewing while paused would eventually look
      // recoverable to exactly the competitor above.
      await Bun.sleep(500);
      const secondBeat = statSync(claimPath).mtimeMs;
      expect(secondBeat).toBeGreaterThan(firstBeat);

      await appendDirective(mailboxDir, "999", "test", "resume", {
        target: "pause",
      });
      for (let n = 0; n < 100 && !existsSync(passStarted); n++)
        await Bun.sleep(100);
      expect(existsSync(passStarted)).toBe(true);
      await appendDirective(mailboxDir, "999", "test", "stop");
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(MAILBOX_STOPPED_EXIT);
      expect(existsSync(passFinished)).toBe(true);
      expect(stderr).toContain("stop requested");
      expect(existsSync(join(dir, "ready-calls"))).toBe(true);
      expect(existsSync(join(stateDir, "pr-drive-999.lock"))).toBe(false);
      // 25s, not 20s: the added competing-invocation spawn and heartbeat
      // freshness wait above cost this test a little over half a second in
      // the common case, but leave the same worst-case synchronization
      // waits (up to 10s apiece) as before with less margin under the old
      // bound.
    }, 25000);
  });

  // ── The pass deadline ────────────────────────────────────────
  // The pass was the last undeadlined thing in this skill, and the gap it left
  // is not one any other stop here can reach: `--max-rounds`, the stall streak
  // and the status poll's `--timeout` all fire BETWEEN rounds, so a pass that
  // never returns outlives every one of them while the claim heartbeat keeps
  // reporting the driver LIVE.
  describe("passTimeoutSeconds", () => {
    const saved = process.env.DRIVE_PR_PASS_TIMEOUT;
    afterEach(() => {
      if (saved === undefined) delete process.env.DRIVE_PR_PASS_TIMEOUT;
      else process.env.DRIVE_PR_PASS_TIMEOUT = saved;
    });

    it("defaults to 90 minutes", () => {
      delete process.env.DRIVE_PR_PASS_TIMEOUT;
      expect(passTimeoutSeconds()).toBe(5400);
    });

    it("takes a whole number of seconds", () => {
      process.env.DRIVE_PR_PASS_TIMEOUT = "120";
      expect(passTimeoutSeconds()).toBe(120);
    });

    it('treats 0 as "no deadline", matching every other knob in this skill', () => {
      process.env.DRIVE_PR_PASS_TIMEOUT = "0";
      expect(passTimeoutSeconds()).toBe(0);
    });

    // An unusable value in the ENVIRONMENT is inherited noise, not an
    // instruction: a drive must not refuse to start because some ancestor
    // shell exported junk. The FLAG is the front door and validates at exit 2
    // (see `--pass-timeout` in main), which is where a typo belongs.
    it.each(["", "abc", "-1", "12.5", " 120"])(
      "falls back to the default for the unusable value %p",
      (v) => {
        process.env.DRIVE_PR_PASS_TIMEOUT = v;
        expect(passTimeoutSeconds()).toBe(5400);
      },
    );

    // `run()` forwards this value to `setTimeout`, whose delay is a 32-bit
    // signed millisecond count: 2147483 is the last whole second under that
    // limit, 2147484 overflows it and fires immediately — so a caller asking
    // for a MORE generous deadline would silently get a pass killed at once
    // (docomply-review round 2, a reference-implementation pull request).
    it("accepts the largest representable timeout in whole seconds", () => {
      process.env.DRIVE_PR_PASS_TIMEOUT = "2147483";
      expect(passTimeoutSeconds()).toBe(2147483);
    });

    it("falls back to the default rather than overflowing setTimeout", () => {
      process.env.DRIVE_PR_PASS_TIMEOUT = "2147484";
      expect(passTimeoutSeconds()).toBe(5400);
    });
  });

  // The new stops must stay distinct from each other and from every
  // pre-existing code, because each one asks its reader for a different next
  // action: widen a deadline or hunt a hang (15), versus wait for a clock and
  // re-arm (16), versus read the pass output (1).
  it("keeps the deadline and quota-parked codes distinct and unclaimed", () => {
    expect(PASS_DEADLINE_EXIT).toBe(15);
    expect(QUOTA_PARKED_EXIT).toBe(16);
    const preexisting = [0, 1, 2, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14];
    expect(preexisting).not.toContain(PASS_DEADLINE_EXIT);
    expect(preexisting).not.toContain(QUOTA_PARKED_EXIT);
    expect(PASS_DEADLINE_EXIT).not.toBe(QUOTA_PARKED_EXIT);
  });

  // ── Spawn-boundary integration floor ────────────────────────────────────
  // The mapping above is pure, so nothing in it shows that a REAL pass's exit
  // status is what reaches it, or that the flattened code is what the drive
  // itself exits with. One spawn covers that edge for the flattened branch;
  // `propagates a pass exit 5 as PR_NOT_OPEN` above is the same witness for
  // the propagated one. Both branches keep a subprocess probe deliberately —
  // a floor that covered only one of them would leave the other's wiring
  // asserted nowhere.
  // The deadline's own spawn-boundary floor. `passTimeoutSeconds` is pure and
  // `run()`'s deadline is covered by proc.ts's suite, but neither shows that
  // drive.ts actually WIRES one to the other — that the flag reaches the spawn,
  // that a detached pass tree is what gets killed, and that `timedOut` (not the
  // 124) is what selects exit 15. A unit seam cannot assert any of that, so
  // this one pays for a real drive.
  it("kills a pass that outlives --pass-timeout and exits PASS_DEADLINE", async () => {
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      // The PR number has to appear: drive.ts asserts out-of-band that the
      // pass it launches names the PR it is driving. Then it hangs, which is
      // the whole point — this is the shape no other stop in the loop reaches.
      [
        "--no-head-sync",
        "--pass-timeout",
        "1",
        "--",
        "sh",
        "-c",
        ": pass for 999; sleep 60",
      ],
    );
    expect(r.exitCode).toBe(PASS_DEADLINE_EXIT);
    expect(r.stderr).toContain("deadline");
    // Not flattened to the generic failure, which is the distinction the
    // separate code exists to preserve.
    expect(r.stderr).not.toContain("not driving further");
    // And it names the recovery, because a killed pass is not rolled back.
    expect(r.stderr).toContain("git status --short");
  });

  it("refuses --pass-timeout above the setTimeout limit at exit 2, before spawning anything", async () => {
    // The env accessor `passTimeoutSeconds()` falls back to the default for
    // this value — correct for inherited noise, but a FLAG's typo must refuse
    // at the front door like every other bad flag, not silently substitute a
    // shorter deadline than the one requested (docomply-review round 3).
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      ["--no-head-sync", "--pass-timeout", "2147484", "--", ...PASS_NOOP],
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(
      "--pass-timeout must be 0 or no greater than 2147483 seconds",
    );
  });

  it("exits 1 for a REAL pass that failed, naming the code it flattened", async () => {
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      // The PR number has to appear: drive.ts asserts out-of-band that the
      // pass it launches names the PR it is driving.
      ["--no-head-sync", "--", "sh", "-c", ": pass for 999; exit 3"],
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("exit 3");
  });

  it("arms $DRIVE_PR_REFLECT_DUE past the third round, and not before", async () => {
    // AGENTS.md § Addressing PR Comments puts the /reflect obligation past
    // three rounds: repeat findings at that depth are a scaffolding gap, not
    // reviewer noise. A shell script cannot invoke a slash command, so the
    // exported flag IS the mechanism — if it never reaches the pass, the duty
    // is back in session memory, which is what this skill exists to end.
    // Unbraced `$VAR` on purpose: `${VAR:-default}` inside a plain JS string
    // reads to biome as a mistyped template literal. An unset variable echoes
    // as empty, which is the assertion below anyway.
    const PASS_ECHO_FLAG = [
      "sh",
      "-c",
      'echo "pass for 999: REFLECT=[$DRIVE_PR_REFLECT_DUE]" >&2; exit 0',
    ];
    // Five deliberate no-op rounds — the reflect duty only arms past round 3,
    // so the stall stop (which would correctly end this drive at gate 3) is
    // disabled for the probe. The stall behaviour has its own probes.
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      ["--no-head-sync", "--max-rounds", "5", "--", ...PASS_ECHO_FLAG],
      undefined,
      { env: { DRIVE_PR_STALL_ROUNDS: "0" } },
    );
    // The stub pass never advances the head, so `passes` drives the count:
    // rounds 1-3 unset, rounds 4-5 armed.
    expect(r.stderr).toContain("REFLECT=[]");
    expect(r.stderr).toContain("REFLECT=[4]");
    expect(r.stderr).toContain("REFLECT=[5]");
    expect(r.stderr).not.toContain("REFLECT=[3]");
    expect(r.stderr).toContain("/reflect is DUE");
  });

  describe("--handoff-at, the context-economy dial", () => {
    // Nothing here can read a session's context usage, so the dial is an
    // agent-side INSTRUCTION in the same shape as $DRIVE_PR_REFLECT_DUE. The
    // export is therefore the whole mechanism: if it never reaches the pass,
    // the setting does not exist.
    const PASS_ECHO_DIAL = [
      "sh",
      "-c",
      'echo "pass for 999: DIAL=[$DRIVE_PR_HANDOFF_AT]" >&2; exit 0',
    ];

    it("defaults to 50 and exports it to the pass", async () => {
      const r = await runDrive(
        { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
        ["--no-head-sync", "--max-rounds", "1", "--", ...PASS_ECHO_DIAL],
      );
      expect(r.stderr).toContain("DIAL=[50]");
    });

    it("resolves each alias to the canonical value the pass reads", () => {
      // The pass must read a number or the literal `never` — never a
      // vocabulary. An alias arriving unresolved is a second taxonomy for the
      // pass to interpret, which is what the numeric flag exists to avoid.
      //
      // Asserted against the exported resolver rather than by spawning a whole
      // `drive.ts` per alias, which is what this used to do: one drive per
      // handoff value, each taking both locks, running a stubbed gate and a
      // pass, to read one string back out of the child's environment. It
      // measured 35.9s of a 733s suite — 4.9% of the whole file for a total
      // function of one string — and carried a
      // hand-raised 120s budget to survive that. The assertion is unchanged:
      // same pairs, same canonical values. What is gone is the machinery
      // between the table and the check, none of which this test names.
      //
      // The spawn it dropped is NOT unwitnessed. `exports a resolved ALIAS to
      // the pass` below still drives one alias end to end, so the one thing a
      // subprocess could see that this cannot — that the resolved value reaches
      // the pass as $DRIVE_PR_HANDOFF_AT at all — keeps a probe of its own.
      expect(
        ["75", "careful", "eager", "never", "continuous"].map((flag) => [
          flag,
          resolveHandoffAt(flag),
        ]),
      ).toEqual([
        ["75", "75"],
        ["careful", "50"],
        ["eager", "75"],
        ["never", "never"],
        ["continuous", "never"],
      ]);
    });

    // ── Spawn-boundary integration floor ──────────────────────────────────
    // The resolver above is pure, so no assertion over it can show that its
    // answer is EXPORTED. This drive is the witness for that edge, and it uses
    // an ALIAS deliberately: `defaults to 50` above already covers the
    // no-flag path, so a floor that also spelled a literal percent would leave
    // alias-resolution-then-export — the composition, which is where a
    // regression that resolves correctly and exports the raw word would live —
    // with no end-to-end probe at all.
    it("exports a resolved ALIAS to the pass", async () => {
      const r = await runDrive(
        { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
        [
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--handoff-at",
          "eager",
          "--",
          ...PASS_ECHO_DIAL,
        ],
      );
      expect(r.stderr).toContain("DIAL=[75]");
      // The raw alias must not survive to the pass — the failure this whole
      // block exists to catch is the pass being handed a vocabulary.
      expect(r.stderr).not.toContain("DIAL=[eager]");
    });

    it("rejects a value that is neither a percent nor never", async () => {
      for (const bad of ["0", "101", "abc", "50.5", "relay", "-1"]) {
        const r = await runDrive({ threads: [] }, [
          "--no-head-sync",
          "--handoff-at",
          bad,
          "--",
          ...PASS_ECHO_DIAL,
        ]);
        expect({ bad, exit: r.exitCode }).toEqual({ bad, exit: 2 });
        expect(r.stderr).not.toContain("DIAL=");
      }
    });

    it("gates `never` on the durable held batch being available", async () => {
      // `never` is the one setting that EXPECTS a compaction mid-round, and a
      // compaction between the reply and the resolve drops the held batch
      // unless it is durable. Starting a continuous drive without the state
      // that makes it survivable is the failure, so the driver probes for it.
      // An unreadable state file models a drive-state.ts that cannot serve the
      // batch, whatever the reason.
      const { dir, stateDir } = writeFixture({ threads: [] });
      writeFileSync(join(stateDir, "drive-pr-999.json"), "not usable state");
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--handoff-at",
          "never",
          "--",
          ...PASS_ECHO_DIAL,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("refusing --handoff-at never");
      expect(stderr).not.toContain("DIAL=");
    });

    it("announces the setting, because nothing enforces it", async () => {
      const r = await runDrive(
        { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
        [
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--handoff-at",
          "75",
          "--",
          ...PASS_ECHO_DIAL,
        ],
      );
      expect(r.stderr).toContain("agent-judged, not measured");
    });
  });

  it("does NOT re-arm on HITL_PARKED", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_parked", path: "a.ts", bot: true }],
    });
    await park(stateDir, "PRRT_parked", "thread");
    const proc = Bun.spawn(
      [join(SCRIPTS, "drive.ts"), "999", "--no-head-sync", "--", ...PASS_LOUD],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(8);
    expect(stderr).not.toContain("RAN_THE_PASS");
    expect(stderr).toContain("arbiter escalated");
  });

  describe("single-instance lock", () => {
    // The three failure modes reported on PR #4031, each modelled by planting
    // the exact directory state the racing driver would have left behind.

    // Both locks live in the state dir: one keyed by PR, one by the working
    // tree. The worktree key is deliberately NOT derived from anything a
    // second driver in the same tree can be configured to compute differently
    // — $DRIVE_PR_HANDOFF_DIR used to move it, which is the bug below.
    function lockDirs(_dir: string, stateDir: string) {
      return {
        worktree: join(stateDir, WORKTREE_LOCK),
        pr: join(stateDir, "pr-drive-999.lock"),
      };
    }

    /**
     * Plant a lock INSTANCE. Its generation is the claim's NAME —
     * `claim.<nonce>` — and `<pid> <host>` is all the record holds. The name is
     * what every removal in drive.ts addresses, which is what makes a stale
     * actor's removal a no-op rather than a fence that has to be left standing
     *, so a fixture that puts the generation back inside the record
     * plants debris and tests the debris path instead of the one it means to.
     *
     * `staleMs` backdates the claim's mtime, which IS the heartbeat: a claim
     * whose pid is alive but that has stopped being refreshed is a recycled
     * pid, not a driver.
     */
    function plantClaim(
      dirPath: string,
      opts: {
        pid: number | string;
        host: string;
        nonce: string;
        staleMs?: number;
      },
    ): string {
      mkdirSync(dirPath, { recursive: true });
      const file = join(dirPath, `claim.${opts.nonce}`);
      writeFileSync(file, `${opts.pid} ${opts.host}\n`);
      if (opts.staleMs !== undefined) {
        const at = (Date.now() - opts.staleMs) / 1000;
        utimesSync(file, at, at);
      }
      return file;
    }

    /** Every claim a lock directory currently holds. */
    function claimsIn(dirPath: string): string[] {
      return readdirSync(dirPath).filter((n) => n.startsWith("claim."));
    }

    /**
     * The worktree-lock name for a driver spawned with `cwd` overridden to
     * `treeDir` — resolved through the same function drive.ts calls, from a
     * FRESH subprocess standing in that tree, because this process's own
     * derivation (`WORKTREE_LOCK` above) is memoised on the suite's own cwd
     * the moment the test file loads (`worktreeRoot()`'s own doc comment: "a
     * process cannot change which working tree it is in"). A driver spawned
     * with a different `cwd` (and no `$DRIVE_PR_WORKTREE` override of its
     * own) computes a DIFFERENT lock name than `WORKTREE_LOCK`/`lockDirs()`
     * name — not a race, a permanent path mismatch that makes every claim
     * read against `lockDirs()`'s `worktree` fail closed to "absent" for the
     * whole run. Mirrors the sibling `scratchLockName()` helper in the
     * 'handoff rendering' describe block above, which is not in scope here.
     */
    async function worktreeLockNameFor(treeDir: string): Promise<string> {
      const probe = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import(${JSON.stringify(join(SCRIPTS, "lib", "state", "store.ts"))}).then(async (m) => console.log(await m.worktreeLockName()))`,
        ],
        { cwd: treeDir, stdout: "pipe", stderr: "pipe" },
      );
      const [out, code] = await Promise.all([
        new Response(probe.stdout).text(),
        probe.exited,
      ]);
      if (code !== 0) {
        throw new Error(
          `worktreeLockNameFor(${treeDir}): probe exited ${code}`,
        );
      }
      const name = out.trim();
      if (!name.startsWith("pr-drive-worktree-")) {
        throw new Error(`worktreeLockNameFor(${treeDir}): got "${name}"`);
      }
      return name;
    }

    /**
     * Model a successor recovering this lock. Retiring the generation that was
     * there is the load-bearing half: a driver notices a takeover because its
     * OWN claim is gone, never because somebody else's arrived.
     */
    function simulateTakeover(dirPath: string, nonce: string): void {
      for (const name of claimsIn(dirPath)) rmSync(join(dirPath, name));
      plantClaim(dirPath, { pid: process.pid, host: hostname(), nonce });
    }

    it("refuses when a LIVE driver holds the worktree lock — whatever PR it drives", async () => {
      // Keyed by worktree, not by PR: two drivers in one worktree cross-ship
      // each other's uncommitted edits regardless of target (PR #4019).
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      // This process is unquestionably alive, and on this host.
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "live0001",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("worktree");
      expect(stderr).not.toContain("RAN_THE_PASS");
      // Refused WITHOUT stealing it.
      expect(readFileSync(join(worktree, "claim.live0001"), "utf8")).toContain(
        `${process.pid}`,
      );
    });

    it("treats a FOREIGN-HOST owner as alive — its pid says nothing here", async () => {
      // `process.kill(pid, 0)` on another machine's pid answers a question
      // about an unrelated local process. Fail closed.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      // pid 999999 is almost certainly dead HERE; the hostname is what must
      // stop the takeover.
      plantClaim(worktree, {
        pid: 999999,
        host: "some-other-host",
        nonce: "foreign01",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("some-other-host");
      expect(existsSync(join(worktree, "claim.foreign01"))).toBe(true);
    });

    it("a LIVE pid that stopped refreshing is a recycled pid, not a driver", async () => {
      // `process.kill(pid, 0)` answers "some process holds this pid", not "the
      // driver is still running". After a driver dies the OS can hand its pid
      // to any unrelated long-lived process, and every later start then refuses
      // forever with no way out but a manual `rm` (docomply-review and
      // chatgpt-codex-connector, a reference-implementation pull request). A real driver refreshes each round;
      // a recycled pid never does, so an unrefreshed claim is recoverable.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      // This process is unquestionably alive and on this host — exactly the
      // shape the refusal test above plants. The refresh age is what differs.
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "stale0001",
        staleMs: 20 * 60_000,
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            // 5 minutes is the floor the clamp allows; the planted claim is
            // older than that and younger than the 6-hour default, so this
            // asserts the knob AND that the default would still have refused.
            DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(stderr).not.toContain("refusing to start a second loop");
      expect(stderr).toContain("recovered a stale");
    });

    it("a FRESH heartbeat on a live pid is still honoured", async () => {
      // The other half of the knob: recovery must key on "stopped refreshing",
      // never on age alone, or a long round hands a second driver the worktree.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "fresh0001",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("refusing to start a second loop");
      expect(stderr).not.toContain("RAN_THE_PASS");
    });

    it("an OWNERLESS lock is debris, taken over without a wall-clock guess", async () => {
      // The old code called an ownerless lock "probably a starting winner" if
      // its mtime was under 2s — a guess a shared or network-backed handoff
      // dir does not honour, and the one that let a contender delete a live
      // winner's lock. Publication is atomic now, so an ownerless lock can
      // only be debris and is taken over on its emptiness, not its age.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      mkdirSync(worktree, { recursive: true });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(stderr).not.toContain("refusing to start a second loop");
      // Taken AND released: nothing debris-shaped is left for the next start.
      expect(existsSync(worktree)).toBe(false);
    });

    it("releases only the lock INSTANCE it acquired", async () => {
      // After a stale recovery the directory belongs to the NEW owner. An
      // unconditional exit-time `rmSync` deletes that live lock and hands a
      // third driver the same worktree. Modelled by letting a drive take the
      // lock, then replacing it with a foreign one before the drive exits —
      // the pass command is what does the replacing, mid-run.
      //
      // This is also the round-8 interleaving at full strength: the releasing
      // process is arbitrarily behind, its own generation long retired, and it
      // still cannot reach the successor, because the only name it removes is
      // its own claim and the `rmdir` behind it refuses a directory that is
      // not empty.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      const q = JSON.stringify;
      const swap = [
        "sh",
        "-c",
        // pid 1 is alive and is definitively not this drive. 999 in the text
        // satisfies drive.ts's pass-targeting guard.
        `: pass for 999; rm -rf ${q(worktree)} && mkdir -p ${q(worktree)} && printf '1 %s\\n' ${q(hostname())} > ${q(join(worktree, "claim.successor1"))}; exit 0`,
      ];
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          ...swap,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      // The replacement survives the original owner's exit handler — claim and
      // directory both.
      expect(claimsIn(worktree)).toEqual(["claim.successor1"]);
      expect(
        readFileSync(join(worktree, "claim.successor1"), "utf8").trim(),
      ).toStartWith("1 ");
    });

    /**
     * Plant a lock whose owner is alive but has stopped refreshing — the shape
     * every stale-recovery test needs. Returns the generation it carries.
     */
    function plantStaleLock(dirPath: string, nonce: string): string {
      plantClaim(dirPath, {
        pid: process.pid,
        host: hostname(),
        nonce,
        staleMs: 20 * 60_000,
      });
      return nonce;
    }

    /** Everything in the state dir derived from `lock` — the lock itself, and
     * any sibling a quarantine, tombstone or staging directory would occupy. */
    function lockResidue(lock: string): string[] {
      const base = basename(lock);
      return readdirSync(dirname(lock)).filter(
        (n) => n === base || n.startsWith(`${base}.`),
      );
    }

    it("recovers a stale lock and leaves NO quarantine behind", async () => {
      // The fence used to be a quarantine that had to stay permanently
      // non-empty, because a contender still holding an observation of
      // generation N aimed a `rename` at `<lock>.stale.<N>` and an empty one
      // is a destination `rename` accepts. So every recovery — and every
      // release — left a directory nothing could ever reclaim, two per drive
      // run, growing with lifetime invocations.
      //
      // Retirement names the generation it removes rather than the path it
      // sits at, so a stale actor's removal is a no-op instead of something
      // that has to be fenced, and there is nothing left to keep.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      plantStaleLock(worktree, "stale0001");

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(stderr).toContain("recovered a stale");
      // The retired generation is gone, and so is everything else the recovery
      // could have left standing.
      expect(lockResidue(worktree)).toEqual([]);
    });

    // `mkfifo` is a POSIX utility with no Windows equivalent, and the skill's
    // own runtime contract states Windows support (SKILL.md's runtime
    // section) — so this one test, which needs a FIFO to force the
    // round-7 interleaving deterministically, cannot run there without
    // failing `pnpm drive-pr:test` before it exercises anything
    // (docomply-review round 6, a reference-implementation pull request). Skipped rather than reimplemented
    // on a cross-platform primitive: every OTHER test in this file is
    // already portable, and the interleaving this one exists to force can
    // still be reasoned about from the code's own generation-naming
    // argument (see `retire`'s doc) even where it cannot be reproduced.
    (process.platform === "win32" ? it.skip : it)(
      "retires the generation it OBSERVED, never the path it sits at",
      async () => {
        // The round-7 interleaving, made deterministic. Contender A quarantined
        // a stale lock by PATH and installed a live replacement; contender B,
        // still holding its observation of the same stale generation, renamed by
        // path too — and what it moved was A's live lock, so both drove
        // (docomply-review, a reference-implementation pull request round 7). Fencing the rename's DESTINATION
        // closed that at the price of a tombstone nothing could reclaim
        //. Naming the SOURCE closes it with nothing left over, and
        // this is the property that makes it work: a retirement removes what the
        // observation listed and NOTHING else.
        //
        // Observing and retiring are normally two adjacent syscalls, which is
        // why the interleaving could not be hit from outside before. A FIFO in
        // the claim's place opens the gap arbitrarily wide: the listing is taken
        // first, then the record's read blocks until this test writes to it. A
        // successor planted while the drive is parked there is in the directory
        // and absent from the observation — exactly the asymmetry a path-keyed
        // retirement erases.
        const { dir, stateDir } = writeFixture({ threads: [] });
        const { worktree } = lockDirs(dir, stateDir);
        mkdirSync(worktree, { recursive: true });
        const fifo = join(worktree, "claim.stale0001");
        execFileSync("mkfifo", [fifo]);

        const proc = Bun.spawn(
          [
            join(SCRIPTS, "drive.ts"),
            "999",
            "--no-head-sync",
            "--",
            ...PASS_LOUD,
          ],
          {
            env: {
              ...process.env,
              PATH: `${binDir}:${process.env.PATH}`,
              DRIVE_PR_FIXTURES: dir,
              DRIVE_PR_STATE_DIR: stateDir,
              DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        // A non-blocking open for writing succeeds only once a reader holds the
        // FIFO, which is strictly after the drive listed the directory.
        let fd = -1;
        for (let i = 0; i < 400 && fd < 0; i++) {
          try {
            fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
          } catch {
            await Bun.sleep(25);
          }
        }
        expect(fd).toBeGreaterThan(0);
        writeFileSync(join(worktree, "claim.successor3"), `1 ${hostname()}\n`);
        // pid 999999 is dead on THIS host, so the observed generation reads as
        // recoverable and the drive goes on to retire it.
        writeSync(fd, `999999 ${hostname()}\n`);
        closeSync(fd);

        const [stderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        // Retiring what it observed leaves the successor's claim in place, so
        // the lock is not an empty slot and this drive loses the race rather
        // than joining it.
        expect(claimsIn(worktree)).toEqual(["claim.successor3"]);
        expect(exitCode).toBe(11);
        expect(stderr).toContain("recovered the same stale lock first");
        expect(stderr).not.toContain("RAN_THE_PASS");
      },
    );

    it("leaves no lock residue however many times it runs", async () => {
      // The bound has to be structural, not a sweep: growth used to be
      // proportional to lifetime drive invocations, two directories at a time,
      // with no reclamation. Three consecutive drives are enough to
      // show accumulation if anything accumulates at all.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree, pr } = lockDirs(dir, stateDir);
      for (let round = 0; round < 3; round++) {
        const proc = Bun.spawn(
          [
            join(SCRIPTS, "drive.ts"),
            "999",
            "--no-head-sync",
            "--",
            ...PASS_LOUD,
          ],
          {
            env: {
              ...process.env,
              PATH: `${binDir}:${process.env.PATH}`,
              DRIVE_PR_FIXTURES: dir,
              DRIVE_PR_STATE_DIR: stateDir,
              DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).not.toBe(11);
        // BOTH locks, every round: a drive holds one per worktree and one per
        // PR, and the old design left a tombstone for each.
        expect(lockResidue(worktree)).toEqual([]);
        expect(lockResidue(pr)).toEqual([]);
      }
    });

    it("reclaims a staging directory orphaned by a crash before the publishing rename (docomply-review #4048)", async () => {
      // `takeLock` publishes into `<lock>.<pid>.<host>.staging` before the
      // rename that installs it. A crash in that window used to be bounded
      // only by "that exact pid retries this exact lock" — on a long-lived
      // clone a pid is not guaranteed to be reused for the same lock ever
      // again, so the artifact was unbounded in practice, contradicting the
      // "creates no artifact it does not remove" acceptance criterion.
      // `sweepStaleStaging` closes it: ANY later acquire on this lock, by any
      // pid, reclaims a sibling staging directory once its recorded owner is
      // confirmed gone — modelled here by planting one under a pid that is
      // dead on this host, WITH its claim file written (the crash landed
      // between writeFileSync and renameSync).
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const orphanedStaging = `${worktree}.999999.${hostname()}.staging`;
      plantClaim(orphanedStaging, {
        pid: 999999,
        host: hostname(),
        nonce: "orphaned1",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      // The orphan is gone, and so is this run's own lock — nothing left
      // standing under either name.
      expect(existsSync(orphanedStaging)).toBe(false);
      expect(lockResidue(worktree)).toEqual([]);
    });

    it("reclaims a staging directory crashed BEFORE its claim was ever written (docomply-review round 2, #4048)", async () => {
      // The narrower gap `sweepStaleStaging`'s claim-file read cannot answer
      // for: a crash between `mkdirSync(staging)` and `writeFileSync` leaves
      // an EMPTY staging directory, with no claim inside to read pid/host
      // from. `stagingDirFor` encodes both into the directory's own NAME,
      // independent of whether the write inside it ever completed, which is
      // what closes this gap too.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const emptyStaging = `${worktree}.999999.${hostname()}.staging`;
      mkdirSync(emptyStaging, { recursive: true }); // no claim file inside

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(existsSync(emptyStaging)).toBe(false);
      expect(lockResidue(worktree)).toEqual([]);
    });

    it("reclaims a staging directory whose pid merely READS as alive — pid reuse cannot make it immortal (docomply-review round 4, #4048)", async () => {
      // `pidAlive` alone is not enough for staging the way it is for the main
      // lock: the main lock falls back to heartbeat staleness when a pid
      // answers but the OWNER never refreshes, closing the pid-reuse hazard
      // `HEARTBEAT_STALE_MIN_DEFAULT` documents. Staging has no heartbeat to
      // fall back to — so without an age-based fallback of its own, a
      // recycled pid makes the sweep's liveness check say "alive" forever,
      // and the directory is never reclaimed: the exact unbounded-artifact
      // failure this whole mechanism exists to close, just via pid reuse
      // instead of "no one ever retries." Modelled with this test's own
      // (unquestionably alive) pid, backdated well past `STAGING_STALE_MS`.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const recycledStaging = `${worktree}.${process.pid}.${hostname()}.staging`;
      plantClaim(recycledStaging, {
        pid: process.pid,
        host: hostname(),
        nonce: "recycled1",
      });
      const oldMs = (Date.now() - 10 * 60_000) / 1000;
      utimesSync(recycledStaging, oldMs, oldMs);

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(existsSync(recycledStaging)).toBe(false);
      expect(lockResidue(worktree)).toEqual([]);
    });

    it("leaves a FRESH staging directory alone even though its pid is unrelated to this drive", async () => {
      // The other half of the age fallback: a staging directory that is
      // merely YOUNG must not be swept just because SOME live pid happens to
      // own it — only age is what distinguishes "legitimately mid-publish"
      // from "recycled pid, actually abandoned." Modelled the same way as the
      // pid-reuse test above, minus the backdating.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const freshStaging = `${worktree}.${process.pid}.${hostname()}.staging`;
      plantClaim(freshStaging, {
        pid: process.pid,
        host: hostname(),
        nonce: "fresh02",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(existsSync(freshStaging)).toBe(true);
    });

    it("leaves a FOREIGN-HOST staging directory alone — its pid says nothing here", async () => {
      // The same fail-closed rule `claimAlive` applies to a real lock: a pid
      // from another host is unanswerable, so sweeping it on liveness alone
      // would risk destroying a live contender's in-flight publish on a
      // shared or network-backed state dir.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const foreignStaging = `${worktree}.999999.some-other-host.staging`;
      plantClaim(foreignStaging, {
        pid: 999999,
        host: "some-other-host",
        nonce: "foreign02",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(existsSync(foreignStaging)).toBe(true);
    });

    it("leaves a MERELY-OLD FOREIGN-HOST staging directory alone — clock skew must not delete it (docomply-review round 5, #4048)", async () => {
      // `pidAlive` returns `true` for a foreign host as a fail-OPEN default
      // for an unanswerable question, not as confirmed evidence the age
      // fallback may then override. An earlier cut applied the age check to
      // every entry `pidAlive` didn't positively rule dead using the SAME
      // short `STAGING_STALE_MS` window as the same-host case — so a foreign
      // publisher merely slow for a few minutes, or a shared mount with
      // ordinary clock skew, would have its live staging directory deleted.
      // Modelled with a foreign-host directory backdated past
      // `STAGING_STALE_MS` but well inside the default `heartbeatStaleMs()`
      // window the fix now uses for a foreign host instead.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const oldForeignStaging = `${worktree}.999999.some-other-host.staging`;
      plantClaim(oldForeignStaging, {
        pid: 999999,
        host: "some-other-host",
        nonce: "foreignold1",
      });
      const oldMs = (Date.now() - 10 * 60_000) / 1000;
      utimesSync(oldForeignStaging, oldMs, oldMs);

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(existsSync(oldForeignStaging)).toBe(true);
    });

    it("eventually reclaims a foreign-host staging directory — cross-host residue is bounded, not permanent (docomply-review round 6, #4048)", async () => {
      // Leaving EVERY foreign-host entry unreclaimed forever (round 5's fix)
      // closed the clock-skew guess but reopened the unboundedness this
      // whole mechanism exists to close, just scoped to cross-host residue —
      // every crashed foreign publisher would leave a permanent directory,
      // contradicting the PR's own structural-bound claim. The fix reuses
      // the SAME mechanism the main lock already relies on for the SAME
      // cross-host/clock-skew uncertainty: `heartbeatStaleMs()`, far longer
      // than `STAGING_STALE_MS` but finite. Modelled the same way the main
      // lock's own staleness test is (`DRIVE_PR_LOCK_HEARTBEAT_MIN` at the
      // 5-minute floor), backdated past it.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const oldForeignStaging = `${worktree}.999999.some-other-host.staging`;
      plantClaim(oldForeignStaging, {
        pid: 999999,
        host: "some-other-host",
        nonce: "foreignold2",
      });
      const oldMs = (Date.now() - 20 * 60_000) / 1000;
      utimesSync(oldForeignStaging, oldMs, oldMs);

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(existsSync(oldForeignStaging)).toBe(false);
    });

    it("retires a lock left behind by a drive.ts older than the claim protocol", async () => {
      // `pid` + `heartbeat` is the shape the tombstone-era lock had. It names
      // no generation, so it is debris — and debris that nothing removes would
      // wedge the slot for ever, since `rename` refuses a non-empty
      // destination. Retirement removes exactly the entries it observed, which
      // is what keeps a lock recoverable from ANY state a crash or an older
      // version can leave it in. Unconditionally: BWC is deferred pre-GA
      // (CLAUDE.md § Backward Compatibility), so this file owes the old
      // format no liveness check either — a legacy `pid`/`heartbeat` pair is
      // debris whether its recorded pid is dead (999999, planted here) or, in
      // principle, still running (docomply-review round 4, a reference-implementation pull request: a
      // liveness check for this exact shape was tried in round 3 and
      // reverted for adding a second lock-format parser BWC-deferred exists
      // to avoid).
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, "pid"), `999999 ${hostname()} legacy01\n`);
      writeFileSync(
        join(worktree, "heartbeat"),
        `999999 ${hostname()} legacy01\n`,
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(stderr).not.toContain("refusing to start a second loop");
      // Taken over AND released — the legacy entries are gone, not wedging the
      // slot as a destination `rename` would refuse.
      expect(lockResidue(worktree)).toEqual([]);
    });

    it("refuses a lock holding two claims rather than guessing which is live", async () => {
      // Unreachable by construction — an instance is installed whole, by
      // rename — but retirement removes what it observed, so a wrong guess
      // here would remove a LIVE claim and hand out the worktree twice. The
      // fail-closed direction costs a refusal a human clears in one command.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      plantStaleLock(worktree, "stale0001");
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "stale0002",
        staleMs: 20 * 60_000,
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("2 claims at once");
      expect(stderr).not.toContain("RAN_THE_PASS");
      // And it removed neither.
      expect(claimsIn(worktree).sort()).toEqual([
        "claim.stale0001",
        "claim.stale0002",
      ]);
    });

    it("a release cannot reach the generation that RECOVERED it", async () => {
      // Release used to move the lock to a private `.releasing.<nonce>` name.
      // A private destination is always free, so the rename always succeeded —
      // and a process suspended past the staleness window, its lock recovered
      // and the path now holding a SUCCESSOR's live lock, moved that successor
      // aside and left the canonical path briefly empty for a third driver
      // (chatgpt-codex-connector and docomply-review, a reference-implementation pull request rounds 7-8).
      //
      // The read-to-rename gap is two adjacent syscalls, so it cannot be hit
      // deterministically from outside the process — and it no longer has to
      // be, because there is no longer a read. Release removes one NAME, its
      // own, so what a suspended releaser can reach is decided by the state of
      // the directory rather than by how recently it ran. The pass therefore
      // plants exactly what a recovery leaves — this generation's claim gone,
      // a successor's in its place — and the release runs against that.
      //
      // `rm -rf` is deliberately NOT used: the directory itself has to survive
      // too, or the `rmdir` behind the removal empties the slot a live driver
      // is holding.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      const q = JSON.stringify;
      const plant = [
        "sh",
        "-c",
        // 999 in the text satisfies drive.ts's pass-targeting guard. pid 1 is
        // alive and is definitively not this drive.
        `: pass for 999; rm -f ${q(worktree)}/claim.*; printf '1 %s\\n' ${q(hostname())} > ${q(join(worktree, "claim.successor2"))}; exit 0`,
      ];
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          ...plant,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      // The successor still holds the canonical path. Under `.releasing.
      // <nonce>` this directory was gone — precisely the moment a third driver
      // walks in.
      expect(claimsIn(worktree)).toEqual(["claim.successor2"]);
    });

    it("keys the WORKTREE lock by the tree, not by $DRIVE_PR_HANDOFF_DIR", async () => {
      // The worktree lock hung off `dirname(handoffPath())`, which that
      // variable moves. Two drivers in ONE checkout that set it differently —
      // or one that set it and one that did not — therefore computed different
      // worktree locks, and their per-PR locks did not collide either when
      // they drove different PRs, so both ran and cross-shipped each other's
      // uncommitted edits (chatgpt-codex-connector, a reference-implementation pull request round 8).
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "live0001",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            // A DIFFERENT handoff dir from the one the live holder used. Under
            // the old derivation this drive looked for its lock in here, found
            // nothing, and started a second loop in the same tree.
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff-elsewhere"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("worktree lock");
      expect(stderr).not.toContain("RAN_THE_PASS");
    });

    it("renews a held claim DURING a pass, not only between rounds", async () => {
      // Refreshing once per round made a claim only as fresh as the round was
      // short — and a round runs an agent pass, the gates and sometimes a
      // Testbox. A pass that outlasts the window let another start quarantine
      // a demonstrably live driver (docomply-review, a reference-implementation pull request round 7).
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      // The loop still touches every lock once at the round boundary, just
      // before the pass. Sampling across THAT would pass with no timer at all
      // — measured: removing `startHeartbeat` left this test green. So the
      // pass announces itself, and the first sample is taken strictly after
      // the announcement, leaving the timer as the only thing that can move
      // the heartbeat inside the window.
      const started = join(dir, "pass-started");
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "sh",
          "-c",
          `: pass for 999; : > ${JSON.stringify(started)}; sleep 5; exit 0`,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            // The renewal period is derived from the staleness window, whose
            // floor is five minutes; this seam is what makes the mechanism
            // observable in a test rather than in five minutes' time.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        let running = false;
        for (let i = 0; i < 400 && !running; i++) {
          running = existsSync(started);
          if (!running) await Bun.sleep(25);
        }
        expect(running).toBe(true);
        // The claim IS the heartbeat: its mtime is what the renewal moves,
        // and its name is what makes the renewal unable to touch a
        // successor.
        const held = claimsIn(worktree);
        expect(held.length).toBe(1);
        const beat = join(worktree, held[0] as string);
        const first = statSync(beat).mtimeMs;
        // Well inside the pass's own sleep, so no round boundary falls here.
        await Bun.sleep(800);
        const second = statSync(beat).mtimeMs;
        expect(second).toBeGreaterThan(first);
      } finally {
        // Same discipline as the sibling test below (round 4 fix): a failed
        // poll or assertion above must not skip the kill and leave a live
        // driver running past this test (chatgpt-codex-connector, a reference-implementation pull request
        // round 8).
        proc.kill();
        await proc.exited;
      }
    });

    it("holds a FILE-BACKED account identity steady for an ACTIVE pass, never overwriting it mid-pass with the account the next pass would use (docomply-review, a reference-implementation pull request round 3)", async () => {
      // A resolved-once-at-arm-time account is correct for
      // CLAUDE_CODE_OAUTH_TOKEN (this process's own environment, fixed for
      // the drive's life) but wrong for oauthAccount/CODEX_HOME auth — LIVE
      // FILE CONTENT the pass re-reads on every fresh spawn. A login swap
      // mid-drive (Hearth, or a manual /login) must not leave the claim
      // reporting the OLD account for the rest of the drive's life — but an
      // earlier revision fixed THAT by rewriting the claim unconditionally
      // on every heartbeat tick, including while a pass was already running.
      // The already-running child inherited the OLD identity at its own
      // spawn and keeps billing to it regardless of what the file says now,
      // so that rewrite displayed the NEXT pass's account while the CURRENT
      // one was still active — wrong for that pass's entire remaining life
      // (docomply-review, a reference-implementation pull request round 3). The claim must hold the
      // identity the running pass actually has.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);

      // A stub `claude` binary on PATH — argv[0] must literally be `claude`
      // for `passVendor` to resolve the Claude branch at all, and the round
      // loop really does execve this (drive.ts spawns argv directly, never
      // through a shell), so a real binary — not a `sh -c` wrapper — has to
      // exist to be found.
      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const startedMarker = join(dir, "claude-pass-started");
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh\n: > ${JSON.stringify(startedMarker)}\nsleep 5\nexit 0\n`,
        { mode: 0o755 },
      );

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      try {
        let running = false;
        for (let i = 0; i < 400 && !running; i++) {
          running = existsSync(startedMarker);
          if (!running) await Bun.sleep(25);
        }
        expect(running).toBe(true);

        const readAccount = (): unknown => {
          const held = claimsIn(worktree);
          expect(held.length).toBe(1);
          const text = readFileSync(join(worktree, held[0] as string), "utf8");
          const secondLine = text.split("\n")[1] ?? "";
          return (JSON.parse(secondLine) as { account: unknown }).account;
        };

        // The claim's SECOND line (the diagnostics JSON) is torn/absent for a
        // moment right after `takeLock`'s own staging+rename before this
        // process appends the diag on the NEXT write in real drive.ts —
        // here, though, `formatClaim` writes pid/host and diag together in
        // one call, so by the time the pass's own marker file exists the
        // claim is already fully diagnosed.
        expect(readAccount()).toEqual({
          account: "before@example.com",
          vendor: "claude",
          provenance: "oauthAccount",
          reason: null,
        });

        // Simulate a login swap: the file changes in place, independent of
        // this driver process's own environment — but the pass is still
        // actively running (asleep, well inside its own 5s sleep) and already
        // holds the OLD identity.
        writeFileSync(
          claudeJsonPath,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );

        // Several heartbeat ticks past the 100ms refresh period above —
        // enough for the OLD, buggy code to have rewritten the claim already.
        await Bun.sleep(800);

        // Still the account the running pass actually inherited: the
        // heartbeat's account-refresh is gated on no pass being active, so a
        // file-backed change mid-pass does not touch the claim until this
        // pass exits.
        expect(readAccount()).toEqual({
          account: "before@example.com",
          vendor: "claude",
          provenance: "oauthAccount",
          reason: null,
        });
      } finally {
        // Not protected by `try/finally` before this fix: a failed poll or
        // assertion above skipped both the kill and the cleanup below,
        // leaving a live driver plus its temp dirs to contaminate later
        // suite cases (docomply-review, a reference-implementation pull request round 4).
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    });

    it("does not resurrect a recovered claim via the account-identity rewrite (docomply-review, a reference-implementation pull request round 3)", async () => {
      // An earlier revision called `refreshAccountIdentity` BEFORE
      // `touchLock` on each heartbeat tick. If a successor recovered this
      // generation's lock (deleted its claim file) in the same window a
      // file-backed identity change made `refreshAccountIdentity` want to
      // rewrite it, the rename recreated a file at THIS generation's own
      // claim path before `touchLock` ever got a chance to notice the
      // absence — republishing an obsolete claim and defeating takeover
      // detection outright: `touchLock`'s own contract is that the only
      // thing that removes `claim.<ours>` is a recovery of this generation,
      // so a claim that exists again reads as "still ours".
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);

      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const startedMarker = join(dir, "claude-pass-started");
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh\n: > ${JSON.stringify(startedMarker)}\nsleep 5\nexit 0\n`,
        { mode: 0o755 },
      );

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      try {
        let running = false;
        for (let i = 0; i < 400 && !running; i++) {
          running = existsSync(startedMarker);
          if (!running) await Bun.sleep(25);
        }
        expect(running).toBe(true);

        // Both land on disk together, with no await between them, so the very
        // next heartbeat tick sees an account change AND a missing claim in
        // the same tick — the exact race the ordering fix closes.
        writeFileSync(
          claudeJsonPath,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );
        simulateTakeover(worktree, "successor01");

        const [stderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(11);
        expect(stderr).toContain("stopping the active pass");
        expect(stderr).toContain("recovered by another driver");

        // Only the successor's claim exists — the account-identity rewrite
        // never recreated this generation's own claim path after the
        // recovery deleted it.
        expect(claimsIn(worktree)).toEqual(["claim.successor01"]);
      } finally {
        // Not protected by `try/finally` before this fix — see the sibling
        // test above (docomply-review, a reference-implementation pull request round 4).
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    });

    it("refreshes a FILE-BACKED account identity synchronously the moment a pass exits, not only on the next heartbeat tick (docomply-review, a reference-implementation pull request round 4)", async () => {
      // Clearing `activePass` reopens the exact window `refreshAccountIdentity`'s
      // own gate exists for, but an earlier revision only refreshed on the
      // heartbeat's OWN timer — so a credential file that changed mid-pass
      // stayed stale until the next tick fired, and the loop could spawn the
      // very next pass against it first if it moved fast enough. The
      // heartbeat interval below is deliberately far longer than this test's
      // own lifetime, so a refreshed claim here can only be the pass-exit
      // refresh, never the timer.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);

      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const startedMarker = join(dir, "claude-pass-started");
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh\n: > ${JSON.stringify(startedMarker)}\nsleep 1\nexit 0\n`,
        { mode: 0o755 },
      );

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            // Far longer than this test ever runs — isolates the pass-exit
            // refresh from the heartbeat's own.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "60000",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      try {
        let running = false;
        for (let i = 0; i < 400 && !running; i++) {
          running = existsSync(startedMarker);
          if (!running) await Bun.sleep(25);
        }
        expect(running).toBe(true);

        // Change the file-backed identity while the pass is still asleep —
        // the running pass keeps billing to the OLD one regardless.
        writeFileSync(
          claudeJsonPath,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );

        const readAccount = (): { account: unknown } | undefined => {
          try {
            const held = claimsIn(worktree);
            if (held.length !== 1) return undefined;
            const text = readFileSync(
              join(worktree, held[0] as string),
              "utf8",
            );
            const secondLine = text.split("\n")[1] ?? "";
            return JSON.parse(secondLine) as { account: unknown };
          } catch {
            // Unreadable, absent, or torn — including the lock directory
            // itself having been removed already (e.g. an unfixed driver
            // releasing the lock right after the pass exits, having never
            // refreshed it) — never a reason to crash the poll loop below.
            return undefined;
          }
        };

        // Poll well past the pass's own 1s sleep but far short of the 60s
        // heartbeat configured above: a refresh observed here is the
        // pass-exit path, not the timer.
        let refreshed = false;
        for (let i = 0; i < 400 && !refreshed; i++) {
          const diag = readAccount();
          refreshed =
            (diag?.account as { account?: string } | undefined)?.account ===
            "after@example.com";
          if (!refreshed) await Bun.sleep(25);
        }
        expect(refreshed).toBe(true);
      } finally {
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    });

    it("refreshes a FILE-BACKED account identity after a CI-repair pass too, not only after an ordinary one (review finding, PR #4820)", async () => {
      // `runRepairPass` used to touch only the locks once its own spawned
      // pass exited, never `refreshAccountIdentity` — the exact post-pass
      // window the sibling test above closes for the ORDINARY pass path. The
      // CI-repair budget (2 here) lets the loop re-gate and dispatch a SECOND
      // repair pass well inside one heartbeat interval, so a login swap
      // during the first repair pass could bill the second one to the stale
      // account. The heartbeat interval below is far longer than this test
      // ever runs, so a refreshed claim here can only be this fix's own
      // post-repair-pass call.
      //
      // Synchronized on the SECOND pass's own start marker rather than on
      // polling the claim file for the swapped value after the FIRST pass
      // exits: that race is exactly what an earlier revision of this test
      // hit on the remote gates host (majordomo) — `runRepairPass` returning
      // is not the same instant as the driver's own subsequent lock release
      // on exit, and polling after the fact can lose that race under load
      // without the fix being wrong. `runRepairPass` calls
      // `refreshAccountIdentity` and returns SYNCHRONOUSLY before the caller
      // ever re-gates and dispatches a second pass, so the second pass's own
      // marker appearing is proof the refresh already landed — no polling
      // race against process teardown required.
      const { dir, stateDir } = writeFixture({
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
      });
      // NOT `lockDirs(dir, stateDir).worktree`: the driver below runs with
      // `cwd: scratchClean.dir`, so its own worktree-lock name is keyed off
      // THAT tree, not the suite's own cwd `WORKTREE_LOCK` was memoised
      // against — see `worktreeLockNameFor`'s own comment.
      const worktree = join(
        stateDir,
        await worktreeLockNameFor(scratchClean.dir),
      );

      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const firstMarker = join(dir, "claude-pass-started-1");
      const secondMarker = join(dir, "claude-pass-started-2");
      // First invocation touches `firstMarker`; every invocation after that
      // touches `secondMarker` — so the SECOND marker's existence is proof a
      // second pass was actually dispatched, not merely that the script ran
      // twice for some other reason.
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh\nif [ -e ${JSON.stringify(firstMarker)} ]; then : > ${JSON.stringify(secondMarker)}; else : > ${JSON.stringify(firstMarker)}; fi\nsleep 1\nexit 0\n`,
        { mode: 0o755 },
      );

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--keep-draft",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          // The fixture's `reviewedSha`/`head` are `scratchClean.head` — a
          // real SHA in the SCRATCH repo, not this test process's own cwd.
          // `certifyFinalWorktree`'s post-convergence `git rev-parse HEAD`
          // reads whatever `cwd` the driver runs in, so without this it
          // reads the ACTUAL repo checkout the suite itself is running from
          // and refuses on a HEAD mismatch before ever reaching the
          // CI-repair branch below.
          cwd: scratchClean.dir,
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            // `worktreeLockName()`/`worktreeKey()` fall back to the ambient
            // cwd's own `git --show-toplevel` when this is unset — which
            // for this spawn is `scratchClean.dir`, NOT the real repo this
            // test file's own `WORKTREE_LOCK` constant was computed against
            // at module load. Without this, `lockDirs()`'s `worktree` path
            // names a lock the driver never creates, and every claim read
            // against it fails closed to "absent" for the whole run — not a
            // timing race, a permanent path mismatch. Every other test in
            // this file that overrides `cwd` to a scratch tree pairs it with
            // this same anchor (e.g. the `$DRIVE_PR_WORKTREE` measurement
            // tests above).
            DRIVE_PR_WORKTREE: scratchClean.dir,
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            DRIVE_PR_CI_REPAIR_ROUNDS: "2",
            // Far longer than this test ever runs — isolates the post-repair
            // refresh from the heartbeat's own, same as the sibling test above.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "60000",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      try {
        // Generous relative to local timings (a few hundred ms per gate
        // round-trip): this fixture's CONVERGED path runs several subprocess
        // round-trips (a real `certifyFinalWorktree` git call, mark-ready.ts,
        // a CI-verdict check) before EACH repair pass, remote-host load
        // included.
        let started = false;
        for (let i = 0; i < 800 && !started; i++) {
          started = existsSync(firstMarker);
          if (!started) await Bun.sleep(25);
        }
        expect(started).toBe(true);

        // Change the file-backed identity while the first repair pass is
        // still asleep — the running pass keeps billing to the OLD one
        // regardless.
        writeFileSync(
          claudeJsonPath,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );

        // Poll for the refreshed claim RIGHT AWAY, rather than waiting for
        // the second pass's own marker first: `runRepairPass` calls
        // `refreshAccountIdentity` and returns synchronously as soon as the
        // FIRST repair pass exits (~1s away, its own sleep), and the driver
        // dispatches the second repair pass only AFTER that return — so the
        // refreshed value is live, and the lock is still held, in the window
        // between the first pass exiting and the second one starting. That
        // window is real but narrow: in this fixture (stubbed `gh`/`git`,
        // no network) the whole remaining run — second pass, re-gate, budget
        // exhaustion, exit, lock release — completes in well under a
        // second, so waiting for the SECOND marker first (as an earlier
        // revision of this test did) means the read arrives after the
        // driver, and every lock it held, is already gone: the claim
        // directory itself has been rmdir'd by then, not merely mid-write.
        // Polling from here catches the value while the first pass's own
        // return is the freshest thing that happened. The claim file is
        // still rewritten by every intervening `touchLock` heartbeat tick
        // (though the 60s interval above makes that irrelevant here), so
        // the read stays retry-safe regardless.
        const readAccount = (): { account?: string } | undefined => {
          try {
            const held = claimsIn(worktree);
            if (held.length !== 1) return undefined;
            const text = readFileSync(
              join(worktree, held[0] as string),
              "utf8",
            );
            const secondLine = text.split("\n")[1] ?? "";
            const diag = JSON.parse(secondLine) as {
              account: { account?: string };
            };
            return diag.account;
          } catch {
            // Unreadable, absent, or torn — a write in flight, never a
            // reason to fail the poll loop below.
            return undefined;
          }
        };
        let refreshed = false;
        const seenValues: unknown[] = [];
        for (let i = 0; i < 400 && !refreshed; i++) {
          const v = readAccount();
          seenValues.push(v?.account);
          refreshed = v?.account === "after@example.com";
          if (!refreshed) await Bun.sleep(25);
        }
        if (!refreshed) {
          console.error("DEBUG seenValues (unique):", [...new Set(seenValues)]);
          console.error("DEBUG worktree dir exists:", existsSync(worktree));
          console.error(
            "DEBUG claimsIn now:",
            (() => {
              try {
                return claimsIn(worktree);
              } catch (e) {
                return String(e);
              }
            })(),
          );
          console.error(
            "DEBUG stderr:",
            await new Response(proc.stderr).text(),
          );
        }
        expect(refreshed).toBe(true);

        // The second repair pass's own marker is written at process start
        // and never cleaned up by the stub, so — unlike the claim file — it
        // is safe to check after the fact, however far the driver has since
        // progressed: it proves the CI-repair loop actually dispatched a
        // second pass (consuming the refreshed identity just observed)
        // rather than the fix being exercised by a path that never re-spawns.
        let secondStarted = existsSync(secondMarker);
        for (let i = 0; i < 400 && !secondStarted; i++) {
          secondStarted = existsSync(secondMarker);
          if (!secondStarted) await Bun.sleep(25);
        }
        expect(secondStarted).toBe(true);
      } finally {
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
      // Explicit, matching the CI-repair block's own convention (e.g. line
      // ~20765): two repair-pass round-trips, each with its own generous
      // poll budget, can approach the suite's default per-test budget under
      // load, and a bare `bun test` invocation elsewhere defaults to bun's
      // own 5s, not this file's `--timeout 30000`.
    }, 45000);

    it("spawns the next pass anyway once every pre-spawn identity-rewrite retry is exhausted, warning about a possibly-stale display rather than blocking on a DISPLAY value (chatgpt-codex-connector, a reference-implementation pull request round 9)", async () => {
      // Round 7 decided this deliberately (see the pre-spawn retry loop's own
      // comment in drive.ts): a filesystem stuck longer than the bounded
      // retries must not stop the drive from ever spawning another pass over
      // what is only ever a DISPLAY value. What round 7 never got was a test
      // for the fall-through that decision actually produces — every retry
      // exhausted, and the pass spawns anyway with the stale-display warning
      // on stderr. Simulate a stuck filesystem by chmod'ing both lock
      // directories read-only from INSIDE round 1's own stub pass —
      // deterministic, no timing race against a live process required — then
      // confirm round 2 still spawns.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree, pr } = lockDirs(dir, stateDir);

      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const passCountFile = join(dir, "pass-count");
      const round2Marker = join(dir, "round2-started");

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh
n=$(( $(cat ${JSON.stringify(passCountFile)} 2>/dev/null || echo 0) + 1 ))
echo "$n" > ${JSON.stringify(passCountFile)}
if [ "$n" = "1" ]; then
  printf '%s' '{"oauthAccount":{"emailAddress":"after@example.com"}}' > ${JSON.stringify(claudeJsonPath)}
  chmod 0555 ${JSON.stringify(worktree)} ${JSON.stringify(pr)}
else
  : > ${JSON.stringify(round2Marker)}
  chmod 0755 ${JSON.stringify(worktree)} ${JSON.stringify(pr)}
fi
exit 0
`,
        { mode: 0o755 },
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            // Far longer than this test ever runs — only the pre-spawn
            // retry loop and the pass-exit refresh should ever touch the
            // now-read-only lock directories, never the heartbeat timer.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "60000",
            // The single fixture thread is never resolved by either stub
            // invocation, so both rounds report an identical fingerprint —
            // disabled here because this probe's subject is the identity
            // fallback, not the (separately covered) stall-stop behavior.
            DRIVE_PR_STALL_ROUNDS: "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      try {
        const [stderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(6);
        expect(stderr).toContain(
          "the account-identity claim rewrite did not land before this spawn — proceeding with a possibly-stale display",
        );
        // The exhausted retries did not block the round loop: round 2 still
        // spawned its own pass.
        expect(existsSync(round2Marker)).toBe(true);
      } finally {
        // Best-effort: the stub itself restores write permission before its
        // round-2 exit, and a normal drive exit then retires (removes) both
        // lock directories on its way out — so neither path here is
        // guaranteed to still exist by the time a failed assertion above
        // lands here instead.
        for (const d of [worktree, pr]) {
          try {
            chmodSync(d, 0o755);
          } catch {
            // Already gone (normal release) or never existed this run.
          }
        }
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    });

    it("heals a resurrected claim at the pass-exit rewrite instead of trusting `touchLock`'s own next tick, which cannot see it (docomply-review, a reference-implementation pull request round 4)", async () => {
      // The round-3 fix narrowed the check-to-rename gap but could not close
      // it, and the round-3 comment's claim that `touchLock`'s own next tick
      // would backstop the remainder was wrong: a resurrected claim carries
      // THIS generation's own name, so `touchLock`'s exact-name `utimesSync`
      // check succeeds against it forever, permanently masking the takeover
      // instead of catching it. Reproduce the state a resurrection race would
      // leave behind directly — a second, unrelated claim already sitting in
      // the same directory — instead of racing the exact microsecond gap by
      // timing alone, and confirm the very next rewrite attempt notices and
      // heals it.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);

      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const startedMarker = join(dir, "claude-pass-started");
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh\n: > ${JSON.stringify(startedMarker)}\nsleep 1\nexit 0\n`,
        { mode: 0o755 },
      );

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            // Far longer than this test ever runs — the pass-exit rewrite is
            // what has to find and heal the ghost claim, not a timer tick.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "60000",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      try {
        let running = false;
        for (let i = 0; i < 400 && !running; i++) {
          running = existsSync(startedMarker);
          if (!running) await Bun.sleep(25);
        }
        expect(running).toBe(true);

        // Plant a SECOND claim directly, without touching the real one — the
        // same end state a resurrection race leaves behind (this
        // generation's own claim recreated ALONGSIDE a successor's), reached
        // deterministically instead of by timing a microsecond gap.
        plantClaim(worktree, {
          pid: 999999,
          host: "ghost-host",
          nonce: "ghost01",
        });

        // Trigger the rewrite the ghost claim needs to be noticed by.
        writeFileSync(
          claudeJsonPath,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );

        const [stderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(11);
        expect(stderr).toContain("recovered by another driver");

        // This generation's own (just-rewritten) claim is removed again;
        // only the other claim survives.
        expect(claimsIn(worktree)).toEqual(["claim.ghost01"]);
      } finally {
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    });

    it("retries every held lock independently, not just the first one to reach `fresh` (docomply-review, a reference-implementation pull request round 4)", async () => {
      // An earlier revision compared `fresh` against only the FIRST lock
      // with a diag (`locks.find(...)`) and returned once THAT ONE matched
      // — so once one lock's rewrite succeeded, a sibling lock's own
      // transient write failure went permanently unretried: the next
      // tick's shared check saw the first lock already agreeing with
      // `fresh` and never looked at the second lock again. Block the PR
      // lock's own directory (a permission failure stands in for any
      // transient write failure) while the worktree lock stays writable,
      // trigger a real account change, and confirm the PR lock's claim
      // still catches up once unblocked — the old code could never do that
      // once the worktree lock got there first.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree, pr } = lockDirs(dir, stateDir);

      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const startedMarker = join(dir, "claude-pass-started");
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh\n: > ${JSON.stringify(startedMarker)}\nsleep 1\nexit 0\n`,
        { mode: 0o755 },
      );

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            // Short enough that several ticks land in the window between
            // the pass exiting and this process deciding it has hit
            // --max-rounds — the retry has to survive more than one tick.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "10",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      let prBlocked = false;
      try {
        let running = false;
        for (let i = 0; i < 400 && !running; i++) {
          running = existsSync(startedMarker);
          if (!running) await Bun.sleep(25);
        }
        expect(running).toBe(true);

        // Block the PR lock directory's writes while the pass sleeps — a
        // stand-in for a transient write failure specifically on this lock.
        chmodSync(pr, 0o500);
        prBlocked = true;

        // Confirm the permission bits actually block a write in THIS
        // environment before trusting them as the failure injection below —
        // a privileged (e.g. root) test process ignores file-mode write
        // permission entirely, which would let both claims catch up
        // immediately and leave every assertion past this point vacuously
        // true regardless of whether the per-lock retry fix below is even
        // present (chatgpt-codex-connector, a reference-implementation pull request round 10).
        const writeProbe = join(pr, `write-probe.${process.pid}`);
        let probeBlocked = false;
        try {
          writeFileSync(writeProbe, "x");
          rmSync(writeProbe, { force: true });
        } catch {
          probeBlocked = true;
        }
        expect(probeBlocked).toBe(true);

        writeFileSync(
          claudeJsonPath,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );

        const readAccountEmail = (dirPath: string): string | undefined => {
          try {
            const held = claimsIn(dirPath);
            if (held.length !== 1) return undefined;
            const text = readFileSync(join(dirPath, held[0] as string), "utf8");
            const secondLine = text.split("\n")[1] ?? "";
            const parsed = JSON.parse(secondLine) as {
              account?: { account?: string };
            };
            return parsed.account?.account;
          } catch {
            return undefined;
          }
        };

        // The worktree lock is writable throughout, so it should catch up
        // even though the PR lock cannot.
        let worktreeCaughtUp = false;
        for (let i = 0; i < 400 && !worktreeCaughtUp; i++) {
          worktreeCaughtUp = readAccountEmail(worktree) === "after@example.com";
          if (!worktreeCaughtUp) await Bun.sleep(10);
        }
        expect(worktreeCaughtUp).toBe(true);

        // Unblock the PR lock and confirm it ALSO eventually catches up —
        // the fix's whole point: a lock that missed one rewrite keeps
        // retrying on every later tick rather than being masked by a
        // sibling lock that already agrees with `fresh`.
        chmodSync(pr, 0o700);
        prBlocked = false;

        let prCaughtUp = false;
        for (let i = 0; i < 400 && !prCaughtUp; i++) {
          prCaughtUp = readAccountEmail(pr) === "after@example.com";
          if (!prCaughtUp) await Bun.sleep(10);
        }
        expect(prCaughtUp).toBe(true);
      } finally {
        if (prBlocked) {
          try {
            chmodSync(pr, 0o700);
          } catch {
            // best-effort — nothing further to clean up if this itself fails
          }
        }
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    });

    it("refuses when a LIVE driver holds the clone-wide PR lock from another worktree", async () => {
      // Separate worktrees never cross-ship edits, but they race pushes to one
      // head branch and share the clone-wide durable state.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { pr, worktree } = lockDirs(dir, stateDir);
      plantClaim(pr, {
        pid: process.pid,
        host: hostname(),
        nonce: "prlock001",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            // Nobody holds the worktree lock, so it is taken and only the PR
            // lock can refuse this. (The handoff dir is deliberately a
            // different one, but that is no longer what frees the worktree
            // lock: it is keyed by the TREE and lives in the state dir.)
            DRIVE_PR_HANDOFF_DIR: join(dir, "other-worktree-handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("PR #999");
      expect(stderr).not.toContain("RAN_THE_PASS");
      // And the first lock it DID take is released on the way out, rather
      // than left behind to be recovered as stale by the next start. Asserted
      // through `lockDirs`, the same resolver drive.ts uses: a hand-written
      // path here named a lock that has not existed since the worktree lock
      // was keyed by the tree, so the check could only ever pass.
      expect(existsSync(worktree)).toBe(false);
    });

    /**
     * A pass that outlives the claim it is working under.
     *
     * Announces itself, then leaves a GRANDCHILD to write a second marker
     * later. The grandchild is what makes the assertion about the process
     * GROUP rather than about the pass process: signalling the pass alone
     * leaves it running, and it writes `late` regardless.
     */
    const passWithLateGrandchild = (dir: string) => [
      "sh",
      "-c",
      `: pass for 999; : > ${JSON.stringify(join(dir, "pass-started"))}; ` +
        `(sleep 4; : > ${JSON.stringify(join(dir, "pass-late"))}) & wait`,
    ];

    /** Poll for the pass's own announcement, so the window is not guessed. */
    async function awaitPassStart(dir: string) {
      const started = join(dir, "pass-started");
      for (let i = 0; i < 400 && !existsSync(started); i++) await Bun.sleep(25);
      expect(existsSync(started)).toBe(true);
    }

    it("stops the RUNNING pass when the lock is recovered mid-pass", async () => {
      // The loop reads `compromised` only at a round boundary, and a pass
      // already running does not pause at one — so a takeover detected mid-pass
      // let it go on editing, committing and pushing under a claim another
      // driver held (docomply-review and chatgpt-codex-connector, a reference-implementation pull request
      // round 11).
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          ...passWithLateGrandchild(dir),
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await awaitPassStart(dir);
      // A successor recovering this lock is indistinguishable, from here, from
      // the generation simply no longer being ours — which is exactly what the
      // heartbeat checks.
      simulateTakeover(worktree, "successor01");
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("stopping the active pass");
      expect(stderr).toContain("recovered by another driver");
      // Past the grandchild's own sleep: nothing in the pass tree survived.
      await Bun.sleep(4500);
      expect(existsSync(join(dir, "pass-late"))).toBe(false);
      // The internal `Bun.sleep(4500)` above already consumes 90%
      // of bun:test's 5000ms default before the spawn/IO overhead around it
      // is even counted — this reliably times out (not merely "sometimes",
      // measured against ambient sibling-worktree load on this very
      // machine) rather than reflecting a genuine hang.
    }, 15000);

    it("does not attribute a PRE-EXISTING session's wall to the pass it spawned", async () => {
      // The WIRING, not the adapter: that `drive.ts` actually takes a
      // snapshot and threads it into `detectQuotaBlock`, which no adapter
      // unit test can observe. A transcript that already exists when the
      // drive starts — a human's chat in this same worktree, the normal
      // condition while a drive runs — must not park or sleep a pass that
      // failed for its own reasons.
      //
      // What this test does NOT bind is the ORDERING (snapshot before
      // spawn): the fixture exists both before and after, so a snapshot
      // taken after `run()` returned would contain it too and this test
      // would still pass. The ordering is bound by the test below,
      // whose pass CREATES its transcript mid-pass and asserts the drive
      // sleeps on it — which only holds if the snapshot was taken before
      // that file existed.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      lockDirs(dir, stateDir);
      // Same reasoning as the test below: the spawned child's own
      // `process.cwd()` is what `belongsToWorktree` compares against, and it
      // does no symlink resolution of its own.
      const cwdDir = realpathSync(process.cwd());
      const claudeProjectsDir = join(dir, "claude-projects");
      const projDir = join(claudeProjectsDir, "proj");
      mkdirSync(projDir, { recursive: true });

      // The fixture must satisfy EVERY other clause, so the snapshot is the
      // sole decider — a record tripping the `since` floor or the cwd check
      // would pass this test whether or not the snapshot exists at all.
      // `since` is the instant of the spawn, which is necessarily LATER than
      // this write, so the record is dated slightly into the future: still
      // well inside the adapter's `MAX_CLOCK_SKEW_MS` (5 min) upper bound,
      // but above the floor the drive will apply.
      const wallAt = new Date(Date.now() + 30_000);
      const preexisting = join(projDir, "human-chat.jsonl");
      writeFileSync(
        preexisting,
        `${JSON.stringify({
          type: "assistant",
          cwd: cwdDir,
          timestamp: wallAt.toISOString(),
          error: "rate_limit",
          isApiErrorMessage: true,
          apiErrorStatus: 429,
          sessionId: "a-human-chat-session",
          message: {
            content: [
              {
                type: "text",
                text: "You've hit your session limit \u00b7 resets 11:59pm (UTC)",
              },
            ],
          },
        })}\n`,
      );

      // CONTROL, in-process: prove the fixture is genuinely detectable, so
      // the e2e assertion below cannot pass vacuously because the record was
      // malformed, mis-timed or in the wrong worktree.
      const savedProjects = process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR;
      process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR = claudeProjectsDir;
      try {
        const seen = claudeAdapter.detect({
          cwd: cwdDir,
          since: new Date(Date.now() - 60_000),
          now: new Date(),
        });
        expect(seen?.window).toBe("short");
        // ...and that the ONLY thing that changes the answer is the snapshot.
        expect(
          claudeAdapter.detect({
            cwd: cwdDir,
            since: new Date(Date.now() - 60_000),
            now: new Date(),
            preexistingSessions: new Set([preexisting]),
          }),
        ).toBeNull();
      } finally {
        if (savedProjects === undefined)
          delete process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR;
        else process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR = savedProjects;
      }

      // A pass that fails without writing any transcript of its own. The only
      // wall on disk is the pre-existing one.
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          "bun",
          "-e",
          "process.exit(1)",
          "--pr-999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      // Reported as what it is — an ordinary failed pass — rather than as
      // somebody else's quota wall.
      expect(stderr).toContain("pass failed on round 1");
      expect(stderr).not.toContain("hit a quota wall");
      expect(stderr).not.toContain("SLEEPING");
      expect(exitCode).not.toBe(QUOTA_PARKED_EXIT);
    });

    it("spawns the AMENDED argv and matches the wall on the id it injected", async () => {
      // Binds the two halves to each other. `prepareSpawn` minting an id and
      // `detect` filtering on one are unit-tested separately, but nothing
      // asserted drive.ts injects the SAME id it then filters on — and the
      // failure is silent and total: drop the amendment and Claude Code
      // picks its own session id, every record fails the correlation clause,
      // and Claude quota detection returns null forever while the suite
      // stays green.
      //
      // The pass command is a stub literally named `claude`, invoked by
      // absolute path — `isClaudeCli` compares the BASENAME, so this is
      // claimed exactly as the real CLI would be, with no PATH shimming to
      // leak into other tests. It writes its wall under whichever session id
      // it was GIVEN, or mints its own when it was given none, which is what
      // the real CLI does.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      lockDirs(dir, stateDir);
      const claudeProjectsDir = join(dir, "claude-projects");
      mkdirSync(join(claudeProjectsDir, "proj"), { recursive: true });

      const stubPath = join(dir, "claude");
      writeFileSync(
        stubPath,
        [
          "#!/usr/bin/env bun",
          "import { writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "import { randomUUID } from 'node:crypto';",
          "const argv = process.argv.slice(2);",
          "const i = argv.indexOf('--session-id');",
          // No `--session-id` reaching the stub is exactly the mutation case:
          // the real CLI would mint its own, so the stub does too.
          "const sid = i >= 0 && i + 1 < argv.length ? argv[i + 1] : randomUUID();",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: process.cwd(),",
          "  timestamp: new Date().toISOString(),",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  sessionId: sid,",
          // Deliberately NOT the session-limit wording: an unrecognised
          // phrase classifies `unknown`, which the driver treats like weekly
          // and PARKS on. That keeps this test deterministic and instant —
          // no sleeping, no clock arithmetic.
          "  message: { content: [{ type: 'text', text: 'Usage limit reached (test fixture wording).' }] },",
          "};",
          "writeFileSync(",
          "  join(process.env.DRIVE_PR_TEST_PROJ_DIR, `${sid}.jsonl`),",
          "  `${JSON.stringify(record)}\n`,",
          ");",
          "process.exit(1);",
        ].join("\n"),
      );
      chmodSync(stubPath, 0o755);

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          stubPath,
          "--pr-999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
            DRIVE_PR_TEST_PROJ_DIR: join(claudeProjectsDir, "proj"),
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      // The driver announces the rewrite it performed...
      expect(stderr).toContain("pass argv amended for quota attribution");
      // ...and then recognises the wall that rewrite made attributable.
      expect(stderr).toContain("hit a quota wall");
      expect(exitCode).toBe(QUOTA_PARKED_EXIT);
    });

    /**
     * One full attempt at the quota-wall-sleep-interrupt scenario: write a
     * fresh fixture, spawn `drive.ts` against a pass that writes a
     * recognisable quota-wall transcript record, and race a live stderr read
     * against the process's own exit to catch the "SLEEPING" marker while
     * the sleep is actually in progress. Returns what happened rather than
     * asserting on it, so the caller (below) can retry a genuine miss
     * without asserting on a not-yet-final attempt.
     */
    async function attemptQuotaWallSleepInterrupt(
      interrupt: "takeover" | "mailbox-stop" = "takeover",
    ): Promise<{
      passRan: boolean;
      takeoverFired: boolean;
      stopFired: boolean;
      exitCode: number;
      allStderr: string;
      stateDir: string;
    }> {
      // The heartbeat's takeover signal (`compromised`) had nothing to
      // interrupt during a quota-wall sleep: `stopActivePass` is a no-op
      // with no active pass, and nothing else watched `compromised` until
      // the loop's NEXT round-boundary check — up to `maxSleepMs()` (six
      // hours by default) later, all the while still refreshing the
      // compromised lock's claim. A pass command writes a recognisable
      // Claude rate-limit transcript record and exits non-zero, driving the
      // loop into its sleep-and-resume branch; a takeover fired once that
      // sleep has visibly started must end the drive almost immediately
      // instead of after the full wait.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const mailboxDir = join(dir, "mailbox");
      const { worktree } = lockDirs(dir, stateDir);
      // Deliberately NOT overridden for the spawn below: `WORKTREE_LOCK`
      // (what `lockDirs`/`simulateTakeover` address) was derived once, at
      // import time, from THIS process's own ambient cwd — the real repo
      // checkout `bun test` runs from, which is already a git worktree.
      // Pointing the child at any other `cwd` (a plain fixture tmp dir, or
      // even `scratchClean.dir`) makes it compute a DIFFERENT worktree
      // lock name than the constant this test addresses.
      // Realpath'd so the `cwd` this test writes into the transcript
      // record matches what the SPAWNED process reports as its own
      // `process.cwd()` bit for bit — `belongsToWorktree` is a
      // prefix/equality test with no symlink resolution of its own, and a
      // bare tmp dir can differ from its realpath (e.g. macOS's `/tmp` →
      // `/private/tmp`).
      const cwdDir = realpathSync(process.cwd());
      const claudeProjectsDir = join(dir, "claude-projects");
      const passDonePath = join(dir, "quota-pass-done");
      // A standalone helper FILE, not an inline `sh -c`/`bun -e` one-liner:
      // the transcript record embeds a real apostrophe and a middle-dot
      // separator, and nesting those inside a shell-quoted argument is
      // exactly the multi-layer-quoting hazard AGENTS.md's git/gh guidance
      // warns about for the identical reason — a file has no delimiter to
      // collide with.
      const helperPath = join(dir, "write-quota-transcript.mjs");
      writeFileSync(
        helperPath,
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const [, , projDir, cwdArg, doneMarker] = process.argv;",
          "mkdirSync(projDir, { recursive: true });",
          "const now = new Date();",
          // Comfortably beyond any realistic spawn/poll overhead, but small
          // enough that a REGRESSION (the sleep not interrupted) fails via
          // this test's own timeout rather than a multi-minute hang.
          "const target = new Date(now.getTime() + 20_000);",
          "const h = target.getUTCHours();",
          "const m = target.getUTCMinutes();",
          "const h12 = h % 12 === 0 ? 12 : h % 12;",
          "const ampm = h < 12 ? 'am' : 'pm';",
          "const resetClause = `resets ${h12}:${String(m).padStart(2, '0')}${ampm} (UTC)`;",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: cwdArg,",
          "  timestamp: now.toISOString(),",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  message: {",
          "    content: [",
          "      { type: 'text', text: `You've hit your session limit \\u00b7 ${resetClause}` },",
          "    ],",
          "  },",
          "};",
          "writeFileSync(join(projDir, 'session.jsonl'), `${JSON.stringify(record)}\\n`);",
          "writeFileSync(doneMarker, String(Date.now()));",
          "process.exit(1);",
        ].join("\n"),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          // >1: round 1 hitting the wall must still have a FURTHER round
          // to sleep for — at `round >= maxRoundsN` the loop short-circuits
          // straight to the non-convergence report instead of sleeping at
          // all, which is a different branch than the one this test means
          // to exercise.
          "--max-rounds",
          "2",
          "--",
          "bun",
          helperPath,
          join(claudeProjectsDir, "proj"),
          cwdDir,
          passDonePath,
          // Satisfies the mis-targeting guard: the pass argv must itself
          // name the PR the driver was given, or drive.ts refuses to run
          // it at all.
          "--pr-999",
        ],
        {
          // No `cwd` override — see the comment on `cwdDir` above.
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
            DRIVE_PR_MAILBOX_DIR: mailboxDir,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );

      try {
        for (let i = 0; i < 400 && !existsSync(passDonePath); i++) {
          await Bun.sleep(25);
        }
        const passRan = existsSync(passDonePath);

        // Read stderr live rather than waiting for the process to exit —
        // the whole point is to fire the takeover WHILE the sleep is in
        // progress, not after. The "SLEEPING" line prints synchronously
        // with no `await` before `quotaSleepAbort` is assigned, so by the
        // time it is observable here the controller this test is about to
        // abort already exists.
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        let allStderr = "";
        let takeoverFired = false;
        let stopFired = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (value) allStderr += decoder.decode(value, { stream: true });
          if (!takeoverFired && !stopFired && allStderr.includes("SLEEPING")) {
            if (interrupt === "takeover") {
              takeoverFired = true;
              simulateTakeover(worktree, "successor02");
            } else {
              stopFired = true;
              await appendDirective(mailboxDir, "999", "test", "stop");
            }
          }
          if (done) break;
        }

        const exitCode = await proc.exited;
        return {
          passRan,
          takeoverFired,
          stopFired,
          exitCode,
          allStderr,
          stateDir,
        };
      } finally {
        proc.kill();
      }
    }

    /**
     * The SAME quota-wall scenario as `attemptQuotaWallSleepInterrupt`, but
     * racing the takeover into the narrower, earlier window that sibling
     * function cannot reach at all: WHILE `recordQuotaPark`'s own subprocess
     * is still in flight, before `quotaSleepAbort` even exists (review
     * finding). `attemptQuotaWallSleepInterrupt`'s own comment records why
     * its trigger point — right as "SLEEPING" appears — lands AFTER that
     * subprocess has already resolved in practice: the controller it aborts
     * already exists by the time its takeover fires. That leaves the earlier
     * window provably untested, and it is exactly the window a takeover
     * detected there used to be silently swallowed in (`touchLock`'s own
     * `if (compromised !== '') return;` guard skips firing the abort again
     * on every later heartbeat tick, so a controller created AFTER the
     * takeover was already lost never receives one).
     *
     * `DRIVE_PR_QUOTA_PARK_TEST_DELAY` forces the overlap deterministically
     * — the same reasoning `DRIVE_PR_CLAIM_HELD_TEST_DELAY` documents for
     * its own caller: two events merely close together race real scheduling
     * jitter and, on a fast machine, may simply not overlap. Held well under
     * the 5s test cap and comfortably above the 100ms heartbeat interval, so
     * the heartbeat is guaranteed at least one tick while the subprocess is
     * still sleeping.
     */
    async function attemptQuotaWallTakeoverDuringRecordQuotaPark(): Promise<{
      passRan: boolean;
      takeoverFired: boolean;
      exitCode: number;
      elapsedMs: number;
      allStderr: string;
      stateDir: string;
    }> {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      const cwdDir = realpathSync(process.cwd());
      const claudeProjectsDir = join(dir, "claude-projects");
      const passDonePath = join(dir, "quota-pass-done");
      const helperPath = join(dir, "write-quota-transcript.mjs");
      writeFileSync(
        helperPath,
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const [, , projDir, cwdArg, doneMarker] = process.argv;",
          "mkdirSync(projDir, { recursive: true });",
          "const now = new Date();",
          // 90s, not the sibling fixtures' 20s: the transcript's reset
          // clause is minute-granular (seconds are dropped), so the
          // reparsed `plan.ms` can be up to 59s SHORTER than the nominal
          // offset depending on which second within the minute `now` lands
          // on. A 20s nominal offset can therefore reparse to
          // approximately zero, which made an earlier version of this
          // fixture unable to distinguish the fixed and unfixed code (both
          // exited near-instantly regardless). 90s keeps the worst-case
          // reparsed `plan.ms` comfortably above 10s even under maximum
          // truncation loss, which is what this test's elapsedMs bound
          // below relies on.
          "const target = new Date(now.getTime() + 90_000);",
          "const h = target.getUTCHours();",
          "const m = target.getUTCMinutes();",
          "const h12 = h % 12 === 0 ? 12 : h % 12;",
          "const ampm = h < 12 ? 'am' : 'pm';",
          "const resetClause = `resets ${h12}:${String(m).padStart(2, '0')}${ampm} (UTC)`;",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: cwdArg,",
          "  timestamp: now.toISOString(),",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  message: {",
          "    content: [",
          "      { type: 'text', text: `You've hit your session limit \\u00b7 ${resetClause}` },",
          "    ],",
          "  },",
          "};",
          "writeFileSync(join(projDir, 'session.jsonl'), `${JSON.stringify(record)}\\n`);",
          "writeFileSync(doneMarker, String(Date.now()));",
          "process.exit(1);",
        ].join("\n"),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          "bun",
          helperPath,
          join(claudeProjectsDir, "proj"),
          cwdDir,
          passDonePath,
          "--pr-999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
            DRIVE_PR_QUOTA_PARK_TEST_DELAY: "1",
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );

      const startedAt = Date.now();
      try {
        for (let i = 0; i < 400 && !existsSync(passDonePath); i++) {
          await Bun.sleep(25);
        }
        const passRan = existsSync(passDonePath);

        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        let allStderr = "";
        let takeoverFired = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (value) allStderr += decoder.decode(value, { stream: true });
          // Fired the instant "SLEEPING" appears — BEFORE `recordQuotaPark`
          // is even awaited, let alone resolved — so the injected 1s delay
          // guarantees the heartbeat observes `compromised` while that
          // subprocess is still in flight, not after.
          if (!takeoverFired && allStderr.includes("SLEEPING")) {
            takeoverFired = true;
            simulateTakeover(worktree, "successor03");
          }
          if (done) break;
        }

        const exitCode = await proc.exited;
        const elapsedMs = Date.now() - startedAt;
        return {
          passRan,
          takeoverFired,
          exitCode,
          elapsedMs,
          allStderr,
          stateDir,
        };
      } finally {
        proc.kill();
      }
    }

    /**
     * The SAME quota-wall fixture `attemptQuotaWallSleepInterrupt` builds,
     * without racing a concurrent takeover against it — for a caller that
     * wants to observe the driver's OWN write (`recordQuotaPark`) landing
     * under ordinary circumstances, not under the artificial, sub-100ms-
     * heartbeat interrupt race that sibling function exists to exercise.
     * an earlier change M7.
     */
    async function attemptQuotaWallSleepStart(): Promise<{
      passRan: boolean;
      sleeping: boolean;
      stateDir: string;
    }> {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const cwdDir = realpathSync(process.cwd());
      const claudeProjectsDir = join(dir, "claude-projects");
      const passDonePath = join(dir, "quota-pass-done");
      const helperPath = join(dir, "write-quota-transcript.mjs");
      writeFileSync(
        helperPath,
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const [, , projDir, cwdArg, doneMarker] = process.argv;",
          "mkdirSync(projDir, { recursive: true });",
          "const now = new Date();",
          "const target = new Date(now.getTime() + 20_000);",
          "const h = target.getUTCHours();",
          "const m = target.getUTCMinutes();",
          "const h12 = h % 12 === 0 ? 12 : h % 12;",
          "const ampm = h < 12 ? 'am' : 'pm';",
          "const resetClause = `resets ${h12}:${String(m).padStart(2, '0')}${ampm} (UTC)`;",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: cwdArg,",
          "  timestamp: now.toISOString(),",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  message: {",
          "    content: [",
          "      { type: 'text', text: `You've hit your session limit \\u00b7 ${resetClause}` },",
          "    ],",
          "  },",
          "};",
          "writeFileSync(join(projDir, 'session.jsonl'), `${JSON.stringify(record)}\\n`);",
          "writeFileSync(doneMarker, String(Date.now()));",
          "process.exit(1);",
        ].join("\n"),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          "bun",
          helperPath,
          join(claudeProjectsDir, "proj"),
          cwdDir,
          passDonePath,
          "--pr-999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );

      try {
        for (let i = 0; i < 400 && !existsSync(passDonePath); i++) {
          await Bun.sleep(25);
        }
        const passRan = existsSync(passDonePath);

        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        let allStderr = "";
        let sleeping = false;
        // Bounded read loop, NOT "until the stream closes" — this process
        // is deliberately left running (a 20s sleep), so waiting for `done`
        // here would wait out the whole sleep. Stop the instant "SLEEPING"
        // appears; the `finally` below kills the process either way.
        while (!sleeping) {
          const { value, done } = await reader.read();
          if (value) allStderr += decoder.decode(value, { stream: true });
          if (allStderr.includes("SLEEPING")) sleeping = true;
          if (done) break;
        }
        // The "SLEEPING" lines print BEFORE `recordQuotaPark` is awaited
        // (drive.ts: the logs, then the record, then the sleep itself) — the
        // opposite of what this comment used to claim (review finding) — so
        // the record is still IN FLIGHT when this reader observes them: a
        // spawned `bun drive-state.ts quota-park` that must claim the
        // session lease and queue for the per-PR state mutex before it
        // writes anything. Poll for the write rather than guessing a settle
        // interval a loaded CI machine can exceed.
        const stateFile = join(stateDir, "drive-pr-999.json");
        for (let i = 0; i < 200; i++) {
          try {
            const s = JSON.parse(readFileSync(stateFile, "utf8")) as {
              quotaPark: unknown;
            };
            if (s.quotaPark !== null) break;
          } catch {
            // Mid-write or not yet created — retry.
          }
          await Bun.sleep(25);
        }
        return { passRan, sleeping, stateDir };
      } finally {
        proc.kill();
      }
    }

    /**
     * The SAME sleep-eligible quota-wall fixture as
     * {@link attemptQuotaWallSleepStart}, but with `--max-rounds 1` so THIS
     * round is already the last one allowed — the branch that returns exit
     * `6` immediately instead of sleeping (review finding: that branch used
     * to return before `recordQuotaPark` ever ran). Waits for the whole
     * process to EXIT rather than stopping at "SLEEPING", since this path
     * never sleeps at all.
     */
    async function attemptQuotaWallOnFinalRound(): Promise<{
      passRan: boolean;
      exitCode: number;
      allStderr: string;
      stateDir: string;
    }> {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const cwdDir = realpathSync(process.cwd());
      const claudeProjectsDir = join(dir, "claude-projects");
      const passDonePath = join(dir, "quota-pass-done");
      const helperPath = join(dir, "write-quota-transcript.mjs");
      writeFileSync(
        helperPath,
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const [, , projDir, cwdArg, doneMarker] = process.argv;",
          "mkdirSync(projDir, { recursive: true });",
          "const now = new Date();",
          "const target = new Date(now.getTime() + 20_000);",
          "const h = target.getUTCHours();",
          "const m = target.getUTCMinutes();",
          "const h12 = h % 12 === 0 ? 12 : h % 12;",
          "const ampm = h < 12 ? 'am' : 'pm';",
          "const resetClause = `resets ${h12}:${String(m).padStart(2, '0')}${ampm} (UTC)`;",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: cwdArg,",
          "  timestamp: now.toISOString(),",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  message: {",
          "    content: [",
          "      { type: 'text', text: `You've hit your session limit \\u00b7 ${resetClause}` },",
          "    ],",
          "  },",
          "};",
          "writeFileSync(join(projDir, 'session.jsonl'), `${JSON.stringify(record)}\\n`);",
          "writeFileSync(doneMarker, String(Date.now()));",
          "process.exit(1);",
        ].join("\n"),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "bun",
          helperPath,
          join(claudeProjectsDir, "proj"),
          cwdDir,
          passDonePath,
          "--pr-999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );

      try {
        for (let i = 0; i < 400 && !existsSync(passDonePath); i++) {
          await Bun.sleep(25);
        }
        const passRan = existsSync(passDonePath);
        const [allStderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { passRan, exitCode, allStderr, stateDir };
      } finally {
        proc.kill();
      }
    }

    /**
     * The SAME last-round quota-wall scenario as {@link attemptQuotaWallOnFinalRound},
     * but with `DRIVE_PR_PROGRESS_TEST_DELAY` holding the `pass-spawned`
     * progress stamp's own write open for a couple of seconds — long enough
     * that, WITHOUT `drive.ts` joining that write before interpreting the
     * pass result, `recordQuotaPark`'s write lands first and the delayed
     * `pass-spawned` stamp then completes afterwards and clobbers
     * `quotaPark` back to `null` via `withProgress`'s own unconditional
     * clear (review finding). The pass itself exits almost instantly (it
     * only writes a transcript file and returns), so without the join there
     * is nothing else in this round to make `recordQuotaPark` wait for the
     * delayed stamp.
     */
    async function attemptQuotaWallOnFinalRoundWithDelayedProgress(): Promise<{
      passRan: boolean;
      exitCode: number;
      allStderr: string;
      stateDir: string;
    }> {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const cwdDir = realpathSync(process.cwd());
      const claudeProjectsDir = join(dir, "claude-projects");
      const passDonePath = join(dir, "quota-pass-done");
      const helperPath = join(dir, "write-quota-transcript.mjs");
      writeFileSync(
        helperPath,
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const [, , projDir, cwdArg, doneMarker] = process.argv;",
          "mkdirSync(projDir, { recursive: true });",
          "const now = new Date();",
          "const target = new Date(now.getTime() + 20_000);",
          "const h = target.getUTCHours();",
          "const m = target.getUTCMinutes();",
          "const h12 = h % 12 === 0 ? 12 : h % 12;",
          "const ampm = h < 12 ? 'am' : 'pm';",
          "const resetClause = `resets ${h12}:${String(m).padStart(2, '0')}${ampm} (UTC)`;",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: cwdArg,",
          "  timestamp: now.toISOString(),",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  message: {",
          "    content: [",
          "      { type: 'text', text: `You've hit your session limit \\u00b7 ${resetClause}` },",
          "    ],",
          "  },",
          "};",
          "writeFileSync(join(projDir, 'session.jsonl'), `${JSON.stringify(record)}\\n`);",
          "writeFileSync(doneMarker, String(Date.now()));",
          "process.exit(1);",
        ].join("\n"),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "bun",
          helperPath,
          join(claudeProjectsDir, "proj"),
          cwdDir,
          passDonePath,
          "--pr-999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
            DRIVE_PR_PROGRESS_TEST_DELAY: "2",
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );

      try {
        for (let i = 0; i < 400 && !existsSync(passDonePath); i++) {
          await Bun.sleep(25);
        }
        const passRan = existsSync(passDonePath);
        const [allStderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { passRan, exitCode, allStderr, stateDir };
      } finally {
        proc.kill();
      }
    }

    /** Read `quotaPark` back out of a completed attempt's durable state. */
    function readQuotaPark(stateDir: string): { vendor: string } | null {
      return (
        JSON.parse(
          readFileSync(join(stateDir, "drive-pr-999.json"), "utf8"),
        ) as { quotaPark: { vendor: string } | null }
      ).quotaPark;
    }

    it("interrupts a quota-wall sleep when the lock is recovered mid-sleep", async () => {
      let attempt = await attemptQuotaWallSleepInterrupt();
      if (attempt.passRan && !attempt.takeoverFired) {
        // This exact scenario has been observed to fail on GitHub
        // Actions (Blacksmith runners) — the driver's pass ran and exited as
        // expected, but the process went on to exit WITHOUT ever printing
        // "SLEEPING", so `takeoverFired` never got a chance to fire. It has
        // never reproduced locally (including under heavy artificial spawn
        // contention) or on the dedicated remote-gates host across repeated
        // runs, which is the signature of a CI-runner-only timing margin
        // rather than a logic bug in `drive.ts` — see the issue for the full
        // investigation. One retry with a COMPLETELY FRESH fixture absorbs a
        // transient environment miss without weakening what a genuine
        // regression still has to prove: a second consecutive miss still
        // fails the assertions below for real.
        attempt = await attemptQuotaWallSleepInterrupt();
      }
      expect(attempt.passRan).toBe(true);
      expect(attempt.takeoverFired).toBe(true);
      expect(attempt.exitCode).toBe(11);
      expect(attempt.allStderr).toContain("recovered by another driver");
    }, 30000);

    it("honors a mailbox stop during quota sleep without waiting for the quota window", async () => {
      let attempt = await attemptQuotaWallSleepInterrupt("mailbox-stop");
      if (attempt.passRan && !attempt.stopFired) {
        attempt = await attemptQuotaWallSleepInterrupt("mailbox-stop");
      }
      expect(attempt.passRan).toBe(true);
      expect(attempt.stopFired).toBe(true);
      expect(attempt.exitCode).toBe(MAILBOX_STOPPED_EXIT);
      expect(attempt.allStderr).toContain("stop requested");
    }, 30000);

    it("a takeover detected WHILE recordQuotaPark is still in flight ends the drive promptly, not after the full sleep (review finding)", async () => {
      // Without the fix this reproduces: `quotaSleepAbort` did not exist
      // yet when `touchLock` observed the takeover, so the abort it fired
      // was a no-op, and `touchLock`'s own `if (compromised !== '') return;`
      // guard meant it never fired again on a later heartbeat tick against
      // the FRESH controller created once `recordQuotaPark` resolved. The
      // drive would then sleep for the full ~20s the transcript's `resetAt`
      // describes before its post-sleep check ever saw `compromised`. The
      // fix re-checks immediately after that await, so a takeover landing
      // in this window ends the drive in roughly the 1s injected delay,
      // not the ~20s wall.
      let attempt = await attemptQuotaWallTakeoverDuringRecordQuotaPark();
      for (
        let retriesLeft = 2;
        attempt.passRan && !attempt.takeoverFired && retriesLeft > 0;
        retriesLeft--
      ) {
        // The same CI-runner-only timing margin documented on the
        // sibling `attemptQuotaWallSleepInterrupt` test above — the driver's
        // pass ran and exited as expected, but the process went on to exit
        // without ever printing "SLEEPING", so `takeoverFired` never got a
        // chance to fire. Never reproduced locally (5/5 local runs pass). A
        // single retry (the original an earlier change fix) itself missed twice in a
        // row on two independent, unrelated CI runs of PR #4911
        // (35567024396 and 35570932127, neither touching drive.ts's
        // quota-wall/takeover code at all) — direct measured evidence the
        // CI-runner's margin has tightened further, not a hypothesis. Two
        // retries with a COMPLETELY FRESH fixture each time absorb that
        // without weakening what a genuine regression still has to prove: a
        // THIRD consecutive miss (three independent fixtures, three
        // independent spawns) still fails the assertions below for real.
        attempt = await attemptQuotaWallTakeoverDuringRecordQuotaPark();
      }
      expect(attempt.passRan).toBe(true);
      expect(attempt.takeoverFired).toBe(true);
      expect(attempt.exitCode).toBe(11);
      expect(attempt.allStderr).toContain("recovered by another driver");
      // Comfortably above the ~1s injected delay plus spawn/heartbeat
      // overhead, comfortably below the ≥~30s full sleep a regression would
      // take (see the fixture's own comment on the 90s nominal target and
      // its minute-truncation floor) — a REGRESSION fails this bound long
      // before the test's own 30s timeout would.
      expect(attempt.elapsedMs).toBeLessThan(10_000);
    }, 30000);

    it("recordQuotaPark writes the park on the SLEEP path, observed WITHOUT racing a concurrent takeover", async () => {
      // Deliberately uses `attemptQuotaWallSleepStart`, NOT the sibling
      // `attemptQuotaWallSleepInterrupt` above — an earlier version of this
      // test reused that racier fixture and reproducibly (2/2 remote-gates
      // runs) observed `quotaPark: null` immediately after a takeover-forced
      // exit, even with a retry. Reusing the interrupt race conflated two
      // different questions: "does the write happen at all" (this test) and
      // "does an interrupt reach the driver correctly" (the sibling test,
      // which passed reliably in the SAME remote runs). This fixture asks
      // only the first question, so it has nothing to race against a fast
      // heartbeat's takeover detection.
      let attempt = await attemptQuotaWallSleepStart();
      if (attempt.passRan && !attempt.sleeping) {
        // The same CI-runner-only timing margin documented on the
        // sleep-interrupt/takeover/final-round siblings elsewhere in this
        // describe block — the pass ran and exited as expected, but the
        // stderr reader closed (`done`) without this attempt ever observing
        // "SLEEPING". Never reproduced locally. One retry with a COMPLETELY
        // FRESH fixture absorbs a transient environment miss without
        // weakening what a genuine regression still has to prove: a second
        // consecutive miss still fails the assertions below for real.
        attempt = await attemptQuotaWallSleepStart();
      }
      expect(attempt.passRan).toBe(true);
      expect(attempt.sleeping).toBe(true);
      const park = readQuotaPark(attempt.stateDir);
      expect(park).not.toBeNull();
      expect(park?.vendor).toBe("claude");
    }, 30000);

    it("recordQuotaPark ALSO writes the park when the wall lands on the LAST allowed round, which never sleeps (review finding)", async () => {
      // This branch used to `return 6` before either `recordQuotaPark` call
      // could run — a normal exit, so `process.on('exit')` rmdirs the lock
      // slot on the way out, leaving `--doctor` a state-only row with no
      // quota evidence at all (UNKNOWN instead of QUOTA_PARKED for a drive
      // that hit a genuine, real wall — see `lib/doctor.ts`'s own precedence
      // header for why that distinction matters).
      let attempt = await attemptQuotaWallOnFinalRound();
      if (attempt.passRan && attempt.exitCode !== 6) {
        // The same CI-runner-only timing margin documented on the
        // sleep-interrupt/takeover siblings above, one detection stage
        // earlier — the pass ran and wrote its transcript, but
        // `detectQuotaBlock` did not see it in time on THIS attempt (the
        // driver falls through to an ordinary `exit 1` pass failure
        // instead of the quota-park `exit 6`), so `attempt.exitCode` never
        // gets a chance to be 6. Never reproduced locally (10/10 local runs
        // pass) and passed on the immediately preceding CI run of this same
        // suite against unchanged production code — the signature of a
        // transient environment miss, not a logic regression. One retry
        // with a COMPLETELY FRESH fixture absorbs it without weakening what
        // a genuine regression still has to prove: a second consecutive
        // miss still fails the assertions below for real.
        attempt = await attemptQuotaWallOnFinalRound();
      }
      expect(attempt.passRan).toBe(true);
      expect(attempt.exitCode).toBe(6);
      expect(attempt.allStderr).toContain(
        "was already the last of --max-rounds",
      );
      const park = readQuotaPark(attempt.stateDir);
      expect(park).not.toBeNull();
      expect(park?.vendor).toBe("claude");
    }, 30000);

    it("a delayed pass-spawned progress stamp does not clobber recordQuotaPark, because drive.ts joins it first (review finding)", async () => {
      // Without the join, this reproduces: the pass exits almost instantly
      // (it only writes the quota transcript), so `recordQuotaPark`'s write
      // lands well before the artificially delayed `pass-spawned` stamp
      // does. That stamp then completes afterwards and, via `withProgress`'s
      // own unconditional `quotaPark: null`, erases the park this same
      // round just recorded — the drive exits 6 with a state file that
      // shows no quota evidence at all for a genuine wall.
      let attempt = await attemptQuotaWallOnFinalRoundWithDelayedProgress();
      if (attempt.passRan && attempt.exitCode !== 6) {
        // Same CI-runner-only detection-timing margin as the
        // sibling fixture's retry immediately above — see that comment for
        // the full diagnosis. One retry with a COMPLETELY FRESH fixture; a
        // second consecutive miss still fails for real.
        attempt = await attemptQuotaWallOnFinalRoundWithDelayedProgress();
      }
      expect(attempt.passRan).toBe(true);
      expect(attempt.exitCode).toBe(6);
      expect(attempt.allStderr).toContain(
        "was already the last of --max-rounds",
      );
      const park = readQuotaPark(attempt.stateDir);
      expect(park).not.toBeNull();
      expect(park?.vendor).toBe("claude");
    }, 30000);

    it("aborts a quota-wall sleep when refreshAccountIdentity notices a COEXISTING claim, not just the removal touchLock already catches (chatgpt-codex-connector, a reference-implementation pull request round 10)", async () => {
      // an earlier change (the sibling test above) covers `touchLock`'s own takeover
      // signal aborting a quota-wall sleep — but that signal fires only when
      // OUR claim is REMOVED (`utimesSync` on our exact filename throws
      // ENOENT). A resurrection that leaves a SECOND, coexisting claim
      // alongside ours (see "heals a resurrected claim at the pass-exit
      // rewrite" above) never removes our file at all, so `touchLock` never
      // notices it — only `refreshAccountIdentity`'s own post-rewrite
      // `claimWasTakenOver` check does, and until this fix it set
      // `compromised` without also aborting the sleep. Plant the coexisting
      // claim directly (deterministic, no timing race) during a quota-wall
      // sleep, trigger a rewrite via a file-backed identity change, and
      // confirm the sleep ends almost immediately rather than running its
      // full bound.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      // Same reasoning as the sibling an earlier change test just above: no `cwd`
      // override, since `WORKTREE_LOCK`/`lockDirs()` addresses the lock
      // name derived from this process's own ambient cwd.
      const claudeProjectsDir = join(dir, "claude-projects");
      const passDonePath = join(dir, "quota-pass-done");
      // A standalone helper FILE, not an inline stub body — same
      // multi-layer-quoting reasoning as an earlier change's own helper: the
      // transcript record embeds a real apostrophe and a middle-dot
      // separator.
      const helperPath = join(dir, "write-quota-transcript.mjs");
      writeFileSync(
        helperPath,
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const [, , projDir, doneMarker, ...passArgs] = process.argv;",
          // `prepareQuotaSpawn` injects `--session-id <uuid>` into
          // this pass's own argv, and the quota adapter discards any
          // transcript record whose `sessionId` does not match it — so the
          // record has to carry whatever value was actually injected, not a
          // fixed or absent one.
          "const sessionIdFlagIndex = passArgs.indexOf('--session-id');",
          "const sessionId =",
          "  sessionIdFlagIndex === -1 ? null : passArgs[sessionIdFlagIndex + 1];",
          "mkdirSync(projDir, { recursive: true });",
          "const now = new Date();",
          // The quota parser reads minute precision. Keep its rounded reset
          // at least 20 seconds away even when the pass runs just before a
          // minute boundary; the test timeout still catches a missed abort.
          "const target = new Date(now.getTime() + 80_000);",
          "const h = target.getUTCHours();",
          "const m = target.getUTCMinutes();",
          "const h12 = h % 12 === 0 ? 12 : h % 12;",
          "const ampm = h < 12 ? 'am' : 'pm';",
          "const resetClause = `resets ${h12}:${String(m).padStart(2, '0')}${ampm} (UTC)`;",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: process.cwd(),",
          "  timestamp: now.toISOString(),",
          "  sessionId,",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  message: {",
          "    content: [",
          "      { type: 'text', text: `You've hit your session limit \\u00b7 ${resetClause}` },",
          "    ],",
          "  },",
          "};",
          "writeFileSync(join(projDir, 'session.jsonl'), `${JSON.stringify(record)}\\n`);",
          "writeFileSync(doneMarker, String(Date.now()));",
          "process.exit(1);",
        ].join("\n"),
      );

      // A `claude`-named stub is required here (unlike an earlier change's plain
      // `bun helperPath` pass command): vendor resolution keys off argv[0]
      // literally naming `claude`/`codex`, and this test needs the
      // FILE-BACKED identity path genuinely active so a change to it makes
      // `refreshAccountIdentity` attempt a real rewrite.
      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      writeFileSync(
        join(claudeStubDir, "claude"),
        // `candidateFiles` (`lib/quota/claude.ts`) scans `root/<subdir>/*.jsonl`
        // — a `.jsonl` sitting directly in the root itself is never found —
        // so the transcript is written one level under `claudeProjectsDir`,
        // matching the sibling an earlier change test's own `join(claudeProjectsDir, 'proj')`.
        // `"$@"` forwarded so the helper sees the `--session-id <uuid>`
        // `prepareQuotaSpawn` injects into this pass's own argv —
        // without it the transcript record carries no `sessionId` at all and
        // the quota adapter discards it as unattributable to this pass.
        `#!/bin/sh\nexec bun ${JSON.stringify(helperPath)} ${JSON.stringify(join(claudeProjectsDir, "proj"))} ${JSON.stringify(passDonePath)} "$@"\n`,
        { mode: 0o755 },
      );

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          // Same reasoning as an earlier change: round 1 hits the wall, round 2 is
          // the further round the drive sleeps in order to reach.
          "--max-rounds",
          "2",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );

      try {
        for (let i = 0; i < 400 && !existsSync(passDonePath); i++) {
          await Bun.sleep(25);
        }
        expect(existsSync(passDonePath)).toBe(true);

        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        let allStderr = "";
        let sleepingSeen = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (value) allStderr += decoder.decode(value, { stream: true });
          if (!sleepingSeen && allStderr.includes("SLEEPING")) {
            sleepingSeen = true;
            // Plant the coexisting claim directly — the resurrection
            // race's end state, reached deterministically instead of by
            // timing a microsecond gap — then trigger the rewrite attempt
            // that has to notice it.
            plantClaim(worktree, {
              pid: 999999,
              host: "ghost-host",
              nonce: "ghost02",
            });
            writeFileSync(
              claudeJsonPath,
              JSON.stringify({
                oauthAccount: { emailAddress: "after@example.com" },
              }),
            );
          }
          if (done) break;
        }
        expect(sleepingSeen).toBe(true);

        const exitCode = await proc.exited;
        expect(exitCode).toBe(11);
        expect(allStderr).toContain("recovered by another driver");
      } finally {
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    }, 15000);

    it("stops the pass BEFORE releasing the locks on SIGTERM", async () => {
      // A signal delivered to the driver pid alone — a supervisor, `kill
      // <pid>`, a harness shutting a worker down — does not reach the pass. The
      // old handler released both locks and exited anyway, so the next driver
      // acquired a free lock on a tree that was still being written
      // (docomply-review, a reference-implementation pull request round 11).
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree, pr } = lockDirs(dir, stateDir);
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          ...passWithLateGrandchild(dir),
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await awaitPassStart(dir);
      // The DRIVER only. The pass runs in its own process group precisely so
      // this signal cannot reach it by accident, which is what leaves the
      // handler as the only thing that can end it.
      proc.kill("SIGTERM");
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(143);
      expect(stderr).toContain("stopping the active pass");
      expect(stderr).toContain("received SIGTERM");
      // Both locks released — the pass was provably gone first, so releasing
      // them is safe and the next driver need not recover them as stale.
      expect(existsSync(worktree)).toBe(false);
      expect(existsSync(pr)).toBe(false);
      await Bun.sleep(4500);
      expect(existsSync(join(dir, "pass-late"))).toBe(false);
      // Same margin problem as the sibling test above — the
      // internal `Bun.sleep(4500)` alone sits right at bun:test's 5000ms
      // default.
    }, 15000);

    it("kills the pass GROUP even when the leader closes first", async () => {
      // `settle` clears the stop's escalation timer, so a leader that exits on
      // the SIGTERM cancels the scheduled group SIGKILL — and a descendant that
      // IGNORES SIGTERM then survives while `exited` resolves, telling the
      // driver the pass is gone (chatgpt-codex-connector, a reference-implementation pull request round 12).
      // The leader here exits promptly; the grandchild traps TERM and would
      // write its marker four seconds later if only the timer stood behind it.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "sh",
          "-c",
          `: pass for 999; sh -c 'trap "" TERM; sleep 4; : > ${JSON.stringify(join(dir, "pass-late"))}' & ` +
            `: > ${JSON.stringify(join(dir, "pass-started"))}; wait`,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await awaitPassStart(dir);
      simulateTakeover(worktree, "successor02");
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      await Bun.sleep(4500);
      expect(existsSync(join(dir, "pass-late"))).toBe(false);
      // Same margin problem as its siblings above — the internal
      // `Bun.sleep(4500)`, on top of the grandchild's own 4-second sleep and
      // the driver's escalation timer, sits right at bun:test's 5000ms
      // default.
    }, 15000);

    it("a SECOND signal leaves the locks rather than releasing them under a live pass", async () => {
      // The forced-exit branch ran `process.exit()` with `held` still
      // populated, and Node then runs the 'exit' handler — `releaseAll` — so
      // the escape hatch released both locks under a pass it had explicitly
      // declined to wait for (chatgpt-codex-connector, a reference-implementation pull request round 12).
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree, pr } = lockDirs(dir, stateDir);
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "sh",
          "-c",
          // The leader must genuinely OUTLIVE the first signal, or the second
          // one races a stop that has already finished and released. `trap ""
          // TERM` alone does not achieve that: it protects the shell, while a
          // bare `sleep 8` is a separate process that dies on the group
          // SIGTERM — the shell's `wait` then returns and it exits anyway, in
          // milliseconds. Looping short sleeps keeps the group alive until the
          // escalation SIGKILL, which is a window wide enough to be certain.
          `: pass for 999; trap "" TERM; : > ${JSON.stringify(join(dir, "pass-started"))}; ` +
            "n=0; while [ $n -lt 100 ]; do sleep 0.1; n=$((n+1)); done",
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          // Not piped: the pass ignores SIGTERM and inherits the driver's
          // output, so a pipe stays open until the pass's own loop ends —
          // on a slow runner, past this test's timeout — although the driver
          // itself has long exited. Only the exit code and the locks matter.
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      await awaitPassStart(dir);
      proc.kill("SIGTERM");
      await Bun.sleep(50); // well inside the 2s escalation grace
      proc.kill("SIGTERM");
      const exitCode = await proc.exited;
      expect(exitCode).toBe(143);
      // Still held: the operator forced an exit rather than proving the pass
      // gone, so a lock left behind is the safe direction.
      expect(existsSync(worktree)).toBe(true);
      expect(existsSync(pr)).toBe(true);
      // The pass's own loop can spin for up to 10s (100 x 0.1s)
      // before the escalation SIGKILL lands, on top of spawn/IO overhead —
      // comfortably past bun:test's 5000ms default even without contention.
    }, 20000);
  });

  it("exports its OWN pid as the drive-state session, so a whole drive is one session", async () => {
    // The locks above keep a second DRIVER out of this tree; they do nothing
    // about a driver-by-hand, which takes no lock at all. What extends the
    // guarantee to that case is the session lease every mutating drive-state
    // command takes — and for it to cover a whole drive, this
    // driver plus every round's pass (each a separate agent process, each with
    // an agent pid of its own) must count as ONE session. Only this process's
    // pid does that: it spans every pass, and it dies exactly when the drive
    // does, so an interactive session in the same tree is refused BETWEEN
    // rounds and not merely during one.
    const marker = join(
      mkdtempSync(join(tmpdir(), "drive-session-")),
      "session",
    );
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      [
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        "sh",
        "-c",
        `: pass for 999; printf '%s %s' "$DRIVE_PR_SESSION" "$PPID" > ${JSON.stringify(marker)}`,
      ],
    );
    expect(r.exitCode).toBeDefined();
    // `$PPID` inside the pass IS the driver: the pass is spawned by this
    // process (detached into its own process group, but still its child). So
    // asserting the two are equal pins "the exported session is the DRIVER's
    // pid", not merely "something numeric was exported".
    const [session, parent] = readFileSync(marker, "utf8").split(" ");
    expect(session).toMatch(/^[0-9]+$/);
    expect(session).toBe(parent);
  });

  it("exports the resolved STATE DIR too, so a pass never re-derives it from `.git`", async () => {
    // The fence's allow-path asks "is a repository in play" from the
    // filesystem, which distinguishes a marker that is unreadable from one
    // that is confirmed absent — but a `.git` DELETED or RENAMED after a drive
    // wrote its lease is a genuine ENOENT, indistinguishable from a tree that
    // never held a repository, and the POST would be permitted with that live
    // lease unread (docomply-review high, PR #4107 round 4).
    //
    // No probe closes that; durable knowledge does. The driver already
    // resolved the directory, so it hands it down — and because
    // $DRIVE_PR_STATE_DIR short-circuits the repository probe entirely, a pass
    // that inherits it reads the real lease whatever happened to its marker.
    //
    // The harness normally SETS $DRIVE_PR_STATE_DIR for the driver, which
    // would make this vacuous: the pass would inherit the harness's value
    // whether or not drive.ts exports anything. So the override is blanked and
    // the driver has to resolve the directory itself, from a repository of
    // this probe's own — asserting the pass received exactly that repo's
    // an earlier change default (`~/.local/state/groundwork/drive-pr/<cloneKey>`, keyed off this
    // repo's own `--git-common-dir`, never that directory itself newer)
    // pins BOTH halves ("something was exported" and "it is the right
    // directory"). Exporting an unrelated path would send the fence hunting
    // leases in the wrong place, which is worse than not exporting.
    const repo = makeScratchRepo("drive-statedir-probe");
    const commonDir = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      cwd: repo.dir,
      env: gitCleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
    })
      .stdout.toString()
      .trim();
    expect(commonDir).not.toBe("");
    // `gitCleanEnv()` pins `$HOME` to `suiteHome` for every subprocess this
    // suite spawns (including the pass below), so the driver's own
    // `cloneKey(realpath(commonDir))` under that same `$HOME` is exactly what
    // `defaultStateDirFor` would compute — reproduced here via `cloneKey`
    // directly rather than `defaultStateDirFor` (which reads the REAL
    // `os.homedir()` of THIS test process, not the subprocess's `suiteHome`).
    const expected = join(
      suiteHome,
      ".local",
      "state",
      "groundwork",
      "drive-pr",
      cloneKey(resolve(repo.dir, commonDir)),
    );

    const marker = join(
      mkdtempSync(join(tmpdir(), "drive-statedir-")),
      "statedir",
    );
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      [
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        "sh",
        "-c",
        `: pass for 999; printf '%s' "$DRIVE_PR_STATE_DIR" > ${JSON.stringify(marker)}`,
      ],
      repo.dir,
      { env: { DRIVE_PR_STATE_DIR: "" } },
    );
    expect(r.exitCode).toBeDefined();
    const exported = readFileSync(marker, "utf8");
    expect(exported).not.toBe("");
    // `realpath`ed because macOS's tmpdir is a `/var` -> `/private/var`
    // symlink and both `mkdtempSync` (this test's `suiteHome`) and the
    // driver's own resolution cross it — the two spellings name one
    // directory, and comparing them literally fails on the platform this
    // suite runs on. Both sides are already absolute (an earlier change's default is
    // never printed relative to a cwd the way `--git-common-dir` could be),
    // so no `resolve(repo.dir, …)` is needed before `realpathSync`.
    expect(realpathSync(exported)).toBe(realpathSync(expected));
  });

  it("refuses a pass command that names a different PR", async () => {
    const r = await runDrive({ threads: [] }, [
      "--no-head-sync",
      "--",
      "claude",
      "-p",
      "/drive-pr 1234",
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("names no PR");
  });

  it("carries the round budget across process restarts", async () => {
    // The durable count exists so the bound survives restarts. A per-process
    // counter hands every resumed drive a fresh full budget, so a "bounded"
    // unattended loop runs forever across resumptions.
    //
    // Asserting only that each invocation eventually exits 6 does NOT pin this:
    // on an unchanged head the round count stays flat, so a restart that ran
    // another full `--max-rounds` of passes would still exit 6 at the end and
    // satisfy that assertion while doing exactly what the bound forbids. What
    // is asserted instead is that the restart runs NO pass at all — which is
    // only true if prior attempts on an unchanged head consumed durable budget.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      DRIVE_PR_FIXTURES: dir,
      DRIVE_PR_STATE_DIR: stateDir,
      DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
      // Durable-budget accounting across restarts is the subject, and it needs
      // the first invocation to genuinely exhaust --max-rounds on no-op
      // passes — which the stall stop would (correctly) end one gate early.
      // The stall behaviour has its own probes above.
      DRIVE_PR_STALL_ROUNDS: "0",
    };
    const once = async () => {
      const p = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          ...PASS_LOUD,
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { stderr, exitCode };
    };
    // First invocation burns the budget (the stub pass never changes the head,
    // so drive-state counts one round and the loop re-reads the same state).
    const first = await once();
    expect(first.exitCode).toBe(6);
    expect(first.stderr.match(/RAN_THE_PASS/g)?.length).toBe(2);
    // A restart must NOT get a fresh budget — and must not run even one pass.
    const second = await once();
    expect(second.exitCode).toBe(6);
    expect(second.stderr).not.toContain("RAN_THE_PASS");
    expect(second.stderr).toContain("resuming PR #999 at round");
  });

  /** Seed the durable state directly, to model a drive resumed at its bound. */
  function seedRounds(stateDir: string, rounds: number, head = HEAD) {
    writeFileSync(
      join(stateDir, "drive-pr-999.json"),
      JSON.stringify({
        pr: 999,
        rounds,
        lastCountedHead: head,
        attempts: 0,
        attemptsHead: "",
        lastReflectedRound: 0,
        lastReflectedAttempts: 0,
        readyMarkedRound: 0,
        ciHold: null,
        verifiedSha: "",
        phase: "",
        parked: [],
        held: [],
        lastEscalatedRound: 0,
        lastEscalatedInvariant: "",
        roundPaths: [],
        lastProgressAt: "",
        quotaPark: null,
      }),
    );
  }

  it("RAISING --max-rounds admits the round the previous bound rejected", async () => {
    // drive-status.ts persists a head before drive.ts rejects it, so the
    // over-limit head is already counted. Seeding a local counter from that
    // durable count and incrementing on top counts the head twice across the
    // resume: the operator raises 3 → 4 to admit exactly this round, and it is
    // rejected again without the pass ever running.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    // 3 heads counted, and the head about to be reviewed is not one of them —
    // so drive-status.ts will bump the durable count to 4 before drive.ts sees
    // it, exactly as it does at a real bound.
    seedRounds(stateDir, 3, PREV);
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      DRIVE_PR_FIXTURES: dir,
      DRIVE_PR_STATE_DIR: stateDir,
      DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
    };
    const at = async (max: string) => {
      const p = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          max,
          "--",
          ...PASS_LOUD,
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { stderr, exitCode };
    };
    // At the old bound the head is counted (3 → 4) and then rejected.
    const held = await at("3");
    expect(held.exitCode).toBe(6);
    expect(held.stderr).not.toContain("RAN_THE_PASS");
    // Resume with the limit raised by one — no re-seed, because the whole point
    // is that this head is ALREADY counted. It must now be worked.
    const raised = await at("4");
    expect(raised.stderr).toContain("RAN_THE_PASS");
  });
});
