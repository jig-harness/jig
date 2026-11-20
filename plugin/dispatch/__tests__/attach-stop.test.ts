import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
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
