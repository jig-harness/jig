/**
 * drive-pr suite: drive.ts stops — a CI-repair pass past its deadline,
 * failed transitions on the converged path, --max-rounds, and the stall streak.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advanceStallStreak } from "../scripts/drive";

import {
  SCRIPTS,
  HEAD,
  type CheckRunFixture,
  REVIEWER_RUN,
  DORMANT_ARM,
  scratchClean,
  makeScratchRepo,
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
  it("a CI-repair pass that hits its own deadline still stops cleanly, not crashing on the new witness check", async () => {
    // Regression guard for the WITNESSED branch:
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
    // PR_NOT_OPEN, so it wins over the gate's.
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
    // nothing about why.
    //
    // Round 1's `gh pr ready` failure is genuinely AMBIGUOUS (a nonzero exit
    // plus an observed OPEN draft is not proof it never applied), so
    // mark-ready.ts now PRESERVES the lease
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
    // leaves nothing measured and produces no fingerprint at all.
    const r = await runDrive(
      {
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
      },
      ["--max-rounds", "10", "--", ...PASS_NOOP],
    );
    expect(r.exitCode).toBe(14);
    // Names what did NOT happen — the distinguishing evidence a log holds
    // but no error would surface.
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

  it("has no --head to forward: a frozen head is not a measurement", async () => {
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
  // still let the real driver stop on a false repeated fingerprint.
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
});
