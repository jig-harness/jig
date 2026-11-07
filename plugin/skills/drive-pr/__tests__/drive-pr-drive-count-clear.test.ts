/**
 * drive-pr suite: the pass-deadline restart count is cleared when the drive
 * ends because the PR closed, and only then. A pass that exits 5 says the PR
 * is not open; the count is cleared on that claim once a read confirms it.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { useDrivePrSuite, writeFixture } from "./drive-pr-harness.ts";
import { runDriveIn, state } from "./drive-loop-harness.ts";
import { ownTree } from "./drive-pr-pickup-fixtures.ts";

useDrivePrSuite();

/** Seeds one taken restart, then drives with a pass that exits 5. */
async function driveWithExit5Pass(name: string, prState: string | undefined) {
  const tree = ownTree(name);
  const { dir, stateDir } = writeFixture(
    {
      ...(prState === undefined ? {} : { prState }),
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    },
    tree,
  );
  const bumped = await state(
    stateDir,
    ["deadline-retries", "999", "--set", "bump"],
    tree,
  );
  expectSpawnExit(bumped, 0, "drive-state.ts deadline-retries");
  const r = await runDriveIn(
    dir,
    stateDir,
    ["--no-head-sync", "--", "sh", "-c", ": pass for 999; exit 5"],
    tree,
  );
  const after = await state(stateDir, ["get", "999"], tree);
  return { r, count: JSON.parse(after.stdout).deadlineRetries ?? 0 };
}

describe("drive.ts ending a drive with the restart count", () => {
  it("keeps the count when a pass exits 5 but the PR is still open", async () => {
    const { r, count } = await driveWithExit5Pass("count-kept-open", undefined);
    expectSpawnExit({ ...r, stdout: null }, 5);
    expect(r.stderr).toContain("restart count stays");
    // The next drive of this PR still has the budget this one spent.
    expect(count).toBe(1);
  }, 120_000);

  it("clears the count once the PR reads closed", async () => {
    const { r, count } = await driveWithExit5Pass("count-cleared", "MERGED");
    expectSpawnExit({ ...r, stdout: null }, 5);
    expect(count).toBe(0);
  }, 120_000);
});
