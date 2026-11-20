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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { runDriveIn, state } from "./drive-loop-harness.ts";
import {
  SCRIPTS,
  scratchClean,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { lastStopEvent } from "../scripts/lib/state/events.ts";
import type { DriveState } from "../scripts/lib/state/schema.ts";
import { DRIVE_EXIT } from "../scripts/lib/status/terminal-states.ts";

useDrivePrSuite();

const LAUNCH = "20261120T080000Z-abcdef05";
const PAGES = 3;

/**
 * A pass that leaves the finish record finish-round.ts writes on a listing
 * stop, through its own writer, then exits 1 as an agent wrapper may.
 * `launch` names the launch the record is bound to: the pass's own
 * (`JIG_LAUNCH`) unless a test names another.
 */
function listingStopPass(dir: string, launch?: string): string[] {
  const writer = join(dir, "write-pass-finish.ts");
  writeFileSync(
    writer,
    [
      `import { writePassFinish } from ${JSON.stringify(join(SCRIPTS, "lib", "state", "pass-finish.ts"))};`,
      "const env = process.env;",
      "writePassFinish(",
      "  env.DRIVE_PR_STATE_DIR ?? '',",
      "  Number(env.DRIVE_PR_TARGET),",
      `  ${launch === undefined ? "env.JIG_LAUNCH ?? ''" : JSON.stringify(launch)},`,
      "  Number(env.DRIVE_PR_ROUND),",
      "  {",
      "    state: 'CHECK_RUNS_UNREADABLE',",
      "    reason: 'the check-runs listing was cut short',",
      "    pushed: true,",
      "    stamped: false,",
      "    headSynced: false,",
      "    items: [],",
      `    listingPagesRead: ${PAGES},`,
      "  },",
      ");",
    ].join("\n"),
  );
  return [
    "sh",
    "-c",
    [
      ": pass for 999",
      `'${process.execPath}' '${writer}' || exit 70`,
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
    [
      "--no-head-sync",
      "--max-rounds",
      "1",
      "--",
      ...listingStopPass(dir, launch),
    ],
    undefined,
    {
      env: {
        JIG_LAUNCH: LAUNCH,
        DRIVE_PR_STALL_ROUNDS: "0",
        DRIVE_PR_PASS_RETRIES: "0",
      },
    },
  );
  const stored = await state(stateDir, ["get", "999"]);
  expectSpawnExit(stored, 0);
  const saved = JSON.parse(stored.stdout) as DriveState;
  return { ...r, stop: lastStopEvent(saved.events ?? []) };
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
  }, 120_000);

  it("ignores a finish record another launch left, and exits 1 as before", async () => {
    const r = await drive("20261119T080000Z-abcdef06");
    expectSpawnExit({ ...r, stdout: null }, 1);
    expect(r.stderr).toContain("LEFT_A_FINISH_RECORD");
    expect(r.stderr).not.toContain("pass reported CHECK_RUNS_UNREADABLE");
    expect(r.stop?.cause).toBe("1");
    expect(r.stop?.listingPages).toBeUndefined();
  }, 120_000);
});
