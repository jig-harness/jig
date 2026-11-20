/**
 * drive-pr suite: a review pass that ends on an unreadable check-runs
 * listing. finish-round.ts leaves a finish record bound to the pass's launch
 * and round (`lib/state/pass-finish.ts`); the driver reads it after the pass
 * and stops with its own listing exit, naming the class and the pages read
 * on standard error and in its ledger stop event, whatever the pass process
 * itself exited. A record another launch left is not this pass's, and the
 * pass's exit is read as it always is.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { runDriveIn, state } from "./drive-loop-harness.ts";
import {
  scratchClean,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { LISTING_PAGES as PAGES } from "./drive-pr-pass-listing-finish-fixtures.ts";
import { lastStopEvent } from "../scripts/lib/state/events.ts";
import { narrativeOf } from "../scripts/lib/state/handoff.ts";
import type { DriveState } from "../scripts/lib/state/schema.ts";
import { readProbeStop } from "../scripts/lib/status/probe-stop.ts";
import { DRIVE_EXIT } from "../scripts/lib/status/terminal-states.ts";

useDrivePrSuite();

const LAUNCH = "20261120T080000Z-abcdef05";

/**
 * A pass that leaves the finish record finish-round.ts writes on a listing
 * stop, then exits 1 as an agent wrapper may. `launch` names the launch the
 * record is bound to: the pass's own (`JIG_LAUNCH`) unless a test names
 * another.
 */
function listingStopPass(launch?: string): string[] {
  const writer = join(
    import.meta.dir,
    "drive-pr-pass-listing-finish-fixtures.ts",
  );
  const args = launch === undefined ? "" : ` '${launch}'`;
  return [
    "sh",
    "-c",
    [
      ": pass for 999",
      `'${process.execPath}' '${writer}'${args} || exit 70`,
      'echo "pass for 999: LEFT_A_FINISH_RECORD" >&2',
      "exit 1",
    ].join("\n"),
  ];
}

async function drive(launch?: string) {
  const { dir, stateDir } = writeFixture(
    { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
    scratchClean.dir,
  );
  const r = await runDriveIn(
    dir,
    stateDir,
    ["--no-head-sync", "--max-rounds", "1", "--", ...listingStopPass(launch)],
    undefined,
    {
      env: {
        JIG_LAUNCH: LAUNCH,
        DRIVE_PR_STALL_ROUNDS: "0",
      },
    },
  );
  const stored = await state(stateDir, ["get", "999"]);
  expectSpawnExit(stored, 0);
  const saved = JSON.parse(stored.stdout) as DriveState;
  return {
    ...r,
    stop: lastStopEvent(saved.events ?? []),
    narrative: narrativeOf(join(dir, "handoff", "pr-drive-999.md")).join("\n"),
  };
}

describe("a pass that stops on an unreadable check-runs listing", () => {
  it("stops the drive with its listing exit, naming the class and the pages read", async () => {
    const r = await drive();
    expectSpawnExit({ ...r, stdout: null }, DRIVE_EXIT.CHECK_RUNS_UNREADABLE);
    expect(r.stderr).toContain("LEFT_A_FINISH_RECORD");
    expect(r.stderr).toContain(
      `pass reported CHECK_RUNS_UNREADABLE after ${PAGES} page(s) on round 1; stopping`,
    );
    expect(r.stop).toMatchObject({
      kind: "stop",
      cause: String(DRIVE_EXIT.CHECK_RUNS_UNREADABLE),
      listingPages: PAGES,
    });
    expect(r.stop?.probe).toMatchObject({
      code: DRIVE_EXIT.CHECK_RUNS_UNREADABLE,
      state: "CHECK_RUNS_UNREADABLE",
    });
    expect(r.stop?.probe?.reason).toContain(`after ${PAGES} page(s)`);
    expect(readProbeStop(r.stderr)).toEqual(r.stop?.probe ?? null);
    expect(r.narrative).toContain("CHECK_RUNS_UNREADABLE");
    expect(r.narrative).toContain(`after ${PAGES} page(s)`);
  }, 120_000);

  it("ignores a finish record another launch left, and exits 1 as before", async () => {
    const r = await drive("20261119T080000Z-abcdef06");
    expectSpawnExit({ ...r, stdout: null }, 1);
    expect(r.stderr).toContain("LEFT_A_FINISH_RECORD");
    expect(r.stderr).not.toContain("pass reported CHECK_RUNS_UNREADABLE");
    expect(r.stop?.cause).toBe("1");
    expect(r.stop?.listingPages).toBeUndefined();
    expect(r.stop?.probe).toBeUndefined();
    expect(r.narrative).not.toContain("CHECK_RUNS_UNREADABLE");
  }, 120_000);
});
