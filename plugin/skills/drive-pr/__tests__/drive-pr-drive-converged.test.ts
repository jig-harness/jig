/**
 * drive-pr suite: drive.ts on convergence — the exit-0 certification, the
 * Ready-mark record around the pass, the clean-tree check, and pass exit mapping.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { passExitDisposition } from "../scripts/drive";

import {
  scratchClean,
  gitCleanEnv,
  makeScratchRepo,
  makeUnresolvedMergeRepo,
  makeRebasePausedRepo,
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

describe("drive.ts loop control", () => {
  it("stops after a SECOND consecutive claimed-by-other, not just a repeated hard failure", async () => {
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

  it("does NOT exit 0 when convergence leaves the Ready-mark lease to another driver", async () => {
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

  it("does NOT exit 0 when convergence hits a still-draft record either, and does NOT auto-retry it", async () => {
    // The reviewer converged with the PR already Ready per THIS gate's own
    // snapshot (isDraft: false), so the converged-path call now uses
    // --record-only — but the owner converts the PR to draft in the window
    // before that call's own live read, so it observes a draft and records
    // nothing (still-draft). Exit 0 here would claim full convergence over a
    // PR that is genuinely a draft again by the owner's own action.
    //
    // Exit 1, not 4: nothing durable was written when this
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

  it("--keep-draft still records an already-Ready PR via the converged-path call", async () => {
    // Same fix as the round-loop pre-pass test above, at the OTHER call site
    // (the same !keepDraft gating on the converged path shares this root
    // cause): a drive that converges with no round to run
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

  it("records an already-Ready PR BEFORE the pass runs, so a mid-pass draft flip is not undone", async () => {
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

  it("does NOT run the pass when the pre-pass record comes back claimed-by-other", async () => {
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

  it("does NOT run the pass when the pre-pass record comes back still-draft either", async () => {
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
    // The composition of two independently-correct mechanisms (the
    // clean-worktree gate and the draft→Ready transition), and the ordering
    // between them is a real decision, not an accident. `gh pr ready` fires
    // `ready_for_review`, which spends the external reviewer's
    // one-pass-per-push budget on whatever head is current at that instant.
    // Over a dirty worktree that head is precisely the one about to change once
    // the operator commits the leftovers — so marking first would spend the
    // pass on a head nobody intends to keep, which is the exact waste the
    // transition exists to avoid.
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

  it("the converged clean-tree check refuses on a git TIMEOUT rather than hanging", async () => {
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

  it("the converged clean-tree check still detects an untracked leftover under status.showUntrackedFiles=no", async () => {
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

  it("the converged clean-tree check still detects a dirty submodule ignored via submodule.<name>.ignore=all", async () => {
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

  it("the converged clean-tree check refuses over an unconcluded merge even though porcelain status is empty", async () => {
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

  it("the converged clean-tree check refuses over a paused interactive rebase even though the tree is clean", async () => {
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

  it("refuses over a local commit that landed after the reviewed head, even with an otherwise clean tree", async () => {
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
  // per code. That is not only cheaper (three drives, ~10.8s of a 733s suite
  // <!-- measured -->); it is what makes the claim's own word ONLY checkable. A
  // probe paying a full drive per code could afford three of them, so "every
  // other code" rested on a sample chosen for its price. Here the whole 0-255
  // process-exit-status domain is free to run, so a one-line production
  // mutation special-casing an untested code (e.g. 7, which no sample covered)
  // cannot leave this test green.
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
});
