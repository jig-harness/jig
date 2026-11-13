/** Standalone Ready completion releases only its own session leases. */
import { describe, expect, it } from "bun:test";
import { join, delimiter } from "node:path";
import {
  SCRIPTS,
  binDir,
  scratchClean,
  writeFixture as rawFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { PASS_NOOP, runDriveIn } from "./drive-loop-harness.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { worktreePathKey } from "../scripts/lib/state/actor.ts";
import { leaseRef, treeLeaseRef } from "../scripts/lib/state/lease.ts";
import { claimRow, putClaim, readLease, readTreeLease } from "./state-rows.ts";

useDrivePrSuite();
const writeFixture = (f: Parameters<typeof rawFixture>[0]) =>
  rawFixture(f, scratchClean.dir);

async function markReady(
  dir: string,
  stateDir: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  const proc = Bun.spawn(
    scriptArgv(join(SCRIPTS, "mark-ready.ts"), "999", ...args),
    {
      cwd: scratchClean.dir,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        DRIVE_PR_FIXTURES: dir,
        DRIVE_PR_STATE_DIR: stateDir,
        DRIVE_PR_HANDOFF_DIR: join(stateDir, "handoff"),
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { outcome: stdout.trim(), stderr, exitCode };
}
const readyClaim = (stateDir: string) => claimRow(stateDir, "999", "ready");

describe("standalone mark-ready session leases", () => {
  it("releases standalone success leases so another session can start immediately", async () => {
    for (const isDraft of [true, false]) {
      const { dir, stateDir } = writeFixture({
        threads: [],
        isDraft,
        head: scratchClean.head,
      });
      const result = await markReady(dir, stateDir, [], {
        CLAUDE_PID: String(process.pid),
        DRIVE_PR_SESSION: "",
        DRIVE_PR_SESSION_STARTED: "",
      });
      expectSpawnExit({ ...result, stdout: result.outcome }, 0);
      expect(result.outcome).toBe(isDraft ? "marked" : "already-ready");
      expect(
        readLease(
          leaseRef(stateDir, "999", `wt-${worktreePathKey(scratchClean.dir)}`),
        ),
      ).toBeNull();
      expect(
        readTreeLease(
          treeLeaseRef(stateDir, `wt-${worktreePathKey(scratchClean.dir)}`),
        ),
      ).toBeNull();
      const next = await markReady(dir, stateDir);
      expectSpawnExit({ ...next, stdout: next.outcome }, 0);
      expect(next.outcome).toBe("already-marked");
      expect(
        readLease(
          leaseRef(stateDir, "999", `wt-${worktreePathKey(scratchClean.dir)}`),
        ),
      ).toBeNull();
      expect(
        readTreeLease(
          treeLeaseRef(stateDir, `wt-${worktreePathKey(scratchClean.dir)}`),
        ),
      ).toBeNull();
      const drive = await runDriveIn(dir, stateDir, [
        "--no-head-sync",
        "--dry-run",
        "--",
        ...PASS_NOOP,
      ]);
      expectSpawnExit({ ...drive, stdout: null }, 0);
    }
  });

  it("leaves session leases intact when another Ready claimant owns the transition", async () => {
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    putClaim(stateDir, "999", "ready", "", "other-ready-token");
    const result = await markReady(dir, stateDir, [], {
      CLAUDE_PID: String(process.pid),
      DRIVE_PR_SESSION: "",
    });
    expectSpawnExit({ ...result, stdout: result.outcome }, 0);
    expect(result.outcome).toBe("claimed-by-other");
    const actor = `wt-${worktreePathKey(scratchClean.dir)}`;
    expect(readLease(leaseRef(stateDir, "999", actor))?.pid).toBe(process.pid);
    expect(readTreeLease(treeLeaseRef(stateDir, actor))?.pid).toBe(process.pid);
    expect(readyClaim(stateDir)?.token).toBe("other-ready-token");
  });

  it("keeps the running driver's leases after a successful Ready transition", async () => {
    const { dir, stateDir } = writeFixture({ threads: [], isDraft: true });
    const result = await markReady(dir, stateDir, [], {
      DRIVE_PR_SESSION: String(process.pid),
      DRIVE_PR_SESSION_STARTED: "ready-test-driver",
    });
    expectSpawnExit({ ...result, stdout: result.outcome }, 0);
    expect(result.outcome).toBe("marked");
    expect(
      readLease(
        leaseRef(stateDir, "999", `wt-${worktreePathKey(scratchClean.dir)}`),
      )?.pid,
    ).toBe(process.pid);
    expect(
      readTreeLease(
        treeLeaseRef(stateDir, `wt-${worktreePathKey(scratchClean.dir)}`),
      )?.pid,
    ).toBe(process.pid);
  });
});
