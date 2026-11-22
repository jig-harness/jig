/**
 * drive-pr suite: a re-arm of a drive stopped on MAX_ROUNDS (`--rearm-budget`)
 * grants one more round budget on both durable counters, keeps it across a
 * restart, and stays bounded by it.
 */

import { describe, expect, it } from "bun:test";
import { rearmGrant } from "../scripts/lib/state/round-grant";
import { TERMINAL_STATES } from "../scripts/lib/status/terminal-states";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  HEAD,
  PREV,
  scratchClean,
  writeFixture as rawFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import {
  PASS_LOUD,
  skipLongDriveFixture,
  spawnDriveIn,
} from "./drive-loop-harness.ts";
import { readState, writeState } from "./state-rows.ts";

const writeFixture = (f: Parameters<typeof rawFixture>[0]) =>
  rawFixture(f, scratchClean.dir);

const MULTI_ROUND_TIMEOUT_MS = 60_000;

useDrivePrSuite();

/** Seed the durable state, to model a drive stopped at its bound. */
function seedRounds(stateDir: string, rounds: number, head = HEAD) {
  writeState(stateDir, "999", {
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
  });
}

function fixture() {
  return writeFixture({ threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] });
}

/** One drive of the fixture at `max`, with or without the re-arm flag. */
async function driveAt(
  f: { dir: string; stateDir: string },
  max: string,
  rearm: boolean,
) {
  const p = spawnDriveIn(
    f.dir,
    f.stateDir,
    [
      "--no-head-sync",
      "--max-rounds",
      max,
      ...(rearm ? ["--rearm-budget"] : []),
      "--",
      ...PASS_LOUD,
    ],
    undefined,
    // Durable budget accounting is the subject: the stall stop would end
    // the no-op passes one gate early.
    { env: { DRIVE_PR_STALL_ROUNDS: "0" } },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const passes = stderr.match(/RAN_THE_PASS/g)?.length ?? 0;
  return { stdout, stderr, exitCode, passes };
}

/** The grant the drive state holds. */
function storedGrant(stateDir: string): unknown {
  return (readState(stateDir, "999") as { roundsGranted?: unknown } | null)
    ?.roundsGranted;
}

describe("rearmGrant", () => {
  it("leaves the grant alone while the counters fit the budget", () => {
    expect(rearmGrant({ rounds: 3, attempts: 2, granted: 0 }, 10)).toBe(0);
    expect(rearmGrant({ rounds: 12, attempts: 4, granted: 5 }, 10)).toBe(5);
  });

  it("grants the rounds spent when the distinct heads passed the budget", () => {
    // 11 of 10: the 11th head was counted, then refused, so 10 were spent.
    expect(rearmGrant({ rounds: 11, attempts: 1, granted: 0 }, 10)).toBe(10);
  });

  it("grants the rounds spent when the passes on one head reached it", () => {
    expect(rearmGrant({ rounds: 4, attempts: 10, granted: 0 }, 10)).toBe(10);
  });

  it("extends an earlier grant once that is spent too", () => {
    expect(rearmGrant({ rounds: 21, attempts: 1, granted: 10 }, 10)).toBe(20);
  });
});

describe("the MAX_ROUNDS report", () => {
  it("tells the person a re-arm grants one more round budget", () => {
    const entry = TERMINAL_STATES.MAX_ROUNDS;
    if (entry === undefined) throw new Error("MAX_ROUNDS has no entry");
    expect(entry.meaning).toContain("grants one more round budget");
    expect(entry.report?.next.step).toContain("one more round budget");
    expect(entry.report?.next.step).toContain("rearm");
  });
});

describe("drive.ts --rearm-budget", () => {
  it.skipIf(skipLongDriveFixture)(
    "runs passes after a stop whose distinct-head count passed the budget, then stops on it again",
    async () => {
      const f = fixture();
      // One head counted, and the head about to be reviewed is another: the
      // round script counts it (1 → 2) and the budget of 1 refuses it.
      seedRounds(f.stateDir, 1, PREV);
      const stopped = await driveAt(f, "1", false);
      expectSpawnExit(stopped, 6);
      expect(stopped.passes).toBe(0);

      // A plain re-arm is refused at once on the same spent budget.
      const plain = await driveAt(f, "1", false);
      expectSpawnExit(plain, 6);
      expect(plain.passes).toBe(0);

      const rearmed = await driveAt(f, "1", true);
      expectSpawnExit(rearmed, 6);
      expect(rearmed.stderr).toContain("granted 1 more rounds");
      expect(rearmed.stderr).toContain("--- round 2/2 on PR #999 ---");
      expect(rearmed.passes).toBeGreaterThan(0);
      expect(rearmed.stderr).toContain("hit --max-rounds (2)");
      expect(storedGrant(f.stateDir)).toBe(1);

      // The grant is durable but not renewed: a restart without the flag
      // keeps the extended budget and, having spent it, runs no pass.
      const restarted = await driveAt(f, "1", false);
      expectSpawnExit(restarted, 6);
      expect(restarted.passes).toBe(0);
      expect(restarted.stderr).toContain("of 2 (from durable state)");
      expect(storedGrant(f.stateDir)).toBe(1);
    },
    MULTI_ROUND_TIMEOUT_MS,
  );

  it.skipIf(skipLongDriveFixture)(
    "runs a pass after a stop whose passes on an unchanged head reached the budget, bounded by the grant",
    async () => {
      const f = fixture();
      const first = await driveAt(f, "1", false);
      expectSpawnExit(first, 6);
      expect(first.passes).toBe(1);

      // The head never moved, so the per-head attempts are what refuse it.
      const plain = await driveAt(f, "1", false);
      expectSpawnExit(plain, 6);
      expect(plain.passes).toBe(0);

      const rearmed = await driveAt(f, "1", true);
      expectSpawnExit(rearmed, 6);
      expect(rearmed.stderr).toContain("granted 1 more rounds");
      expect(rearmed.passes).toBe(1);
      expect(rearmed.stderr).toContain("hit --max-rounds (2)");
      expect(rearmed.stderr).not.toContain("round 3/");
    },
    MULTI_ROUND_TIMEOUT_MS,
  );

  it("grants nothing to a drive that has budget left", async () => {
    const f = fixture();
    const r = await driveAt(f, "1", true);
    expectSpawnExit(r, 6);
    expect(r.stderr).not.toContain("granted");
    expect(r.passes).toBe(1);
  });
});
