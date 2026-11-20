import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  captureIdentity,
  type ProcessIdentity,
} from "../../shared/liveness.ts";
import { signalMembers } from "../lib/attach-stop.ts";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
});

/** A `sleep` started in a process group of its own, or in this one. */
function sleeper(ownGroup: boolean): ChildProcess {
  const child = spawn("sleep", ["60"], {
    detached: ownGroup,
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

async function identity(child: ChildProcess): Promise<ProcessIdentity> {
  const until = Date.now() + 10_000;
  for (;;) {
    const read = await captureIdentity(child.pid, true);
    if (read.ok) return read.value;
    if (Date.now() > until) throw new Error(read.failure.reason);
    await Bun.sleep(20);
  }
}

/** Whether the child ended on `signal` within the deadline. */
async function endedOn(
  child: ChildProcess,
  signal: string,
  ms = 10_000,
): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.signalCode === signal) return true;
    await Bun.sleep(20);
  }
  return child.signalCode === signal;
}

describe("signalMembers", () => {
  it("signals nothing for a process whose group is not the recorded one", async () => {
    const child = sleeper(true);
    const own = await identity(child);
    expect(own.pgid).toBe(child.pid);
    const said = await signalMembers(
      [{ ...own, pgid: (own.pgid ?? 0) + 1 }],
      "SIGTERM",
    );
    expect(said).toContain(`skipped ${child.pid}`);
    expect(said).toContain("no process was signalled");
    expect(child.signalCode).toBeNull();
    expect(() => process.kill(child.pid as number, 0)).not.toThrow();
  });

  it("signals the group when it is the recorded one", async () => {
    const child = sleeper(true);
    const own = await identity(child);
    const said = await signalMembers([own], "SIGTERM");
    expect(said).toBe(`sent SIGTERM to -${child.pid}`);
    expect(await endedOn(child, "SIGTERM")).toBe(true);
  });

  it("signals only the process when its group is this process's own", async () => {
    const child = sleeper(false);
    const own = await identity(child);
    const said = await signalMembers([own], "SIGTERM");
    expect(said).toBe(`sent SIGTERM to ${child.pid}`);
    expect(await endedOn(child, "SIGTERM")).toBe(true);
  });
});

describe("stopDrive", () => {
  it("reads a drive with no live driver as already stopped, not as a failed stop", async () => {
    const state = mkdtempSync(join(tmpdir(), "jig-stop-drive-"));
    const repo = mkdtempSync(join(tmpdir(), "jig-stop-repo-"));
    try {
      for (const args of [
        ["init", "-q"],
        ["commit", "-q", "--allow-empty", "-m", "x"],
      ])
        spawnSync(
          "git",
          ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
          { cwd: repo },
        );
      const script = `import { stopDrive } from ${JSON.stringify(join(import.meta.dir, "../lib/attach-stop.ts"))};
console.log(JSON.stringify(await stopDrive({ id: "x", drivePr: 999999, repoPath: ${JSON.stringify(repo)}, members: [] })));`;
      const done = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, DRIVE_PR_STATE_DIR: state },
      });
      expectSpawnExit(done, 0);
      const out = JSON.parse(
        done.stdout.toString().trim().split("\n").at(-1) ?? "null",
      );
      expect(typeof out).toBe("string");
      expect(out).toContain("no live driver");
    } finally {
      rmSync(state, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
