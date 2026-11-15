/** Standalone Ready completion releases only its own session leases. */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  SCRIPTS,
  scratchClean,
  writeFixture as rawFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { markReady } from "./mark-ready-harness.ts";
import { PASS_NOOP, runDriveIn } from "./drive-loop-harness.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { worktreePathKey } from "../scripts/lib/state/actor.ts";
import { leaseRef, treeLeaseRef } from "../scripts/lib/state/lease.ts";
import {
  claimRow,
  putClaim,
  putLease,
  putTreeLease,
  readLease,
  readTreeLease,
} from "./state-rows.ts";

useDrivePrSuite();
const writeFixture = (f: Parameters<typeof rawFixture>[0]) =>
  rawFixture(f, scratchClean.dir);

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

  it("does not remove a successor session that reused the same pid and host", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [],
      isDraft: false,
      head: scratchClean.head,
    });
    const first = await markReady(dir, stateDir, [], {
      CLAUDE_PID: String(process.pid),
      DRIVE_PR_SESSION: "",
      DRIVE_PR_SESSION_STARTED: "first-session",
    });
    expectSpawnExit({ ...first, stdout: first.outcome }, 0);
    const actor = `wt-${worktreePathKey(scratchClean.dir)}`;
    const prLease = leaseRef(stateDir, "999", actor);
    const treeLease = treeLeaseRef(stateDir, actor);
    putLease(prLease, { sessionStarted: "successor-session" });
    putTreeLease(treeLease, { sessionStarted: "successor-session" });

    const second = await markReady(dir, stateDir, [], {
      CLAUDE_PID: String(process.pid),
      DRIVE_PR_SESSION: "",
      DRIVE_PR_SESSION_STARTED: "first-session",
    });
    expectSpawnExit({ ...second, stdout: second.outcome }, 0);
    expect(second.outcome).toBe("already-marked");
    expect(readLease(prLease)?.sessionStarted).toBe("successor-session");
    expect(readTreeLease(treeLease)?.sessionStarted).toBe("successor-session");
  });

  it("does not remove successor leases installed after cleanup captures them", async () => {
    const { stateDir } = writeFixture({ threads: [], isDraft: false });
    const actor = `wt-${worktreePathKey(scratchClean.dir)}`;
    const prLease = leaseRef(stateDir, "999", actor);
    const treeLease = treeLeaseRef(stateDir, actor);
    const initial = { holder: "worktree" as const, actor };
    putLease(prLease, initial);
    putTreeLease(treeLease, initial);

    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
const stateDir = process.argv[1];
const actor = process.argv[2];
const { standaloneReadyCleanup } = await import(process.argv[3]);
const { leaseRef, treeLeaseRef, readLease, readTreeLease, writeLease, writeTreeLease } = await import(process.argv[4]);
const prLease = leaseRef(stateDir, "999", actor);
const treeLease = treeLeaseRef(stateDir, actor);
const cleanup = await standaloneReadyCleanup("999");
const successorLease = { ...readLease(prLease), generation: readLease(prLease).generation + 1 };
const successorTree = { ...readTreeLease(treeLease), generation: readTreeLease(treeLease).generation + 1 };
writeLease(prLease, successorLease);
writeTreeLease(treeLease, successorTree);
await cleanup();
console.log(JSON.stringify({ lease: readLease(prLease)?.generation, tree: readTreeLease(treeLease)?.generation, successorLease: successorLease.generation, successorTree: successorTree.generation }));
`,
        "--",
        stateDir,
        actor,
        join(SCRIPTS, "lib/standalone-ready-cleanup.ts"),
        join(SCRIPTS, "lib/state/lease.ts"),
      ],
      {
        cwd: scratchClean.dir,
        env: {
          ...process.env,
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_HANDOFF_DIR: join(stateDir, "handoff"),
          DRIVE_PR_SESSION: "",
          CLAUDE_PID: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    const result = JSON.parse(stdout) as Record<string, number>;
    expect(result.lease).toBe(result.successorLease);
    expect(result.tree).toBe(result.successorTree);
  });
});
