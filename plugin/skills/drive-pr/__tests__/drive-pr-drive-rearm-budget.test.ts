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
import { readState, seedRounds as seedRoundsAt } from "./state-rows.ts";

const writeFixture = (f: Parameters<typeof rawFixture>[0]) =>
  rawFixture(f, scratchClean.dir);

const MULTI_ROUND_TIMEOUT_MS = 60_000;

useDrivePrSuite();

const seedRounds = (stateDir: string, rounds: number, head = HEAD) =>
  seedRoundsAt(stateDir, rounds, head);

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
    { env: { DRIVE_PR_STALL_ROUNDS: "0", DRIVE_PR_LEDGER: "off" } },
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
  const spent = (
    rounds: number,
    attempts: number,
    granted = 0,
    headCounted = true,
  ) => ({ rounds, attempts, granted, headCounted });

  it("leaves the grant alone and the passes counted while the counters fit the budget", () => {
    expect(rearmGrant(spent(3, 2), 10)).toEqual({
      granted: 0,
      resetAttempts: false,
    });
    expect(rearmGrant(spent(12, 4, 5), 10)).toEqual({
      granted: 5,
      resetAttempts: false,
    });
  });

  it("grants the heads spent before the one it resumes on when the budget refused it", () => {
    // 11 of 10: the 11th head was counted, then refused: it is the first of the new budget.
    expect(rearmGrant(spent(11, 1), 10)).toEqual({
      granted: 10,
      resetAttempts: true,
    });
  });

  it("counts the heads spent in full when a new head was pushed before the re-arm", () => {
    expect(rearmGrant(spent(11, 0, 0, false), 10).granted).toBe(11);
  });

  it("treats a head count equal to the budget as spent (a quota stop on the last head)", () => {
    expect(rearmGrant(spent(10, 3), 10)).toEqual({
      granted: 9,
      resetAttempts: true,
    });
  });

  it("grants both counters when only the passes on one head were spent", () => {
    expect(rearmGrant(spent(4, 10), 10)).toEqual({
      granted: 3,
      resetAttempts: true,
    });
  });

  it("extends an earlier grant once that is spent too, and never lowers it", () => {
    expect(rearmGrant(spent(21, 1, 10), 10).granted).toBe(20);
    expect(rearmGrant(spent(2, 1, 10), 10).granted).toBe(10);
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
      expect(rearmed.stderr).toContain("the budget is now 2 heads");
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
      expect(rearmed.stderr).toContain("passes on a head");
      // Exactly the base budget of passes, not the heads' allowance on top.
      expect(rearmed.passes).toBe(1);
      expect(rearmed.stderr).toContain("hit --max-rounds (1)");
      expect(storedGrant(f.stateDir)).toBe(0);
    },
    MULTI_ROUND_TIMEOUT_MS,
  );

  it(
    "grants nothing to a drive that has budget left",
    async () => {
      const f = fixture();
      const r = await driveAt(f, "1", true);
      expectSpawnExit(r, 6);
      expect(r.stderr).not.toContain("granted");
      expect(r.passes).toBe(1);
    },
    MULTI_ROUND_TIMEOUT_MS,
  );
});
