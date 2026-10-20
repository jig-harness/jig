/**
 * drive-pr suite: drive-status.ts: terminal states, drafts, conflicts and the measured false-convergence modes.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { join, delimiter } from "node:path";

import {
  SCRIPTS,
  HEAD,
  binDir,
  writeFixture,
  park,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

useDrivePrSuite();

describe("drive-status.ts HITL parking", () => {
  it("HITL_PARKED — every remaining thread awaits a human", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_parked", path: "a.ts", bot: true }],
    });
    await park(stateDir, "PRRT_parked", "thread");
    const proc = Bun.spawn(
      scriptArgv(
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        "--head",
        HEAD,
      ),
      {
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const json = JSON.parse(out);
    expect(json.state).toBe("HITL_PARKED");
    expect(exitCode).toBe(8);
    expect(json.work.parkedThreads).toBe(1);
  });

  it("an UNparked thread alongside a parked one is still a live round", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [
        { id: "PRRT_parked", path: "a.ts", bot: true },
        { id: "PRRT_live", path: "b.ts", bot: true },
      ],
    });
    await park(stateDir, "PRRT_parked", "thread");
    const proc = Bun.spawn(
      scriptArgv(
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        "--head",
        HEAD,
      ),
      {
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(JSON.parse(out).state).toBe("ROUND_READY");
    expect(exitCode).toBe(0);
  });
});
