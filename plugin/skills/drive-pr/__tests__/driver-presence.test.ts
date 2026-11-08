/**
 * driver-presence: what this host shows of the driver run a ledger names,
 * read without writing, and called gone only on the evidence recovery
 * accepts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { driverPresence, recordedRun } from "../scripts/lib/driver-presence.ts";
import { writeDriverRecord } from "../scripts/lib/ledger-stop.ts";
import { putLock } from "./state-rows.ts";

const STARTED = "2026-11-07T12:00:00.000Z";
const CLONE = "0123456789abcdef";
const RUN = { pr: "7", clone: CLONE, started: STARTED };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A clone's state directory under a fresh root, its database not yet created. */
function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "jig-driver-presence-"));
  roots.push(root);
  const dir = join(root, "state", CLONE);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A pid no process holds any more. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", ""], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  return child.pid;
}

describe("recordedRun", () => {
  it("reads a pull request, a clone key and an acquisition time, and nothing else", () => {
    expect(recordedRun(["7", CLONE, STARTED])).toEqual(RUN);
    for (const argv of [
      ["7", CLONE],
      ["07", CLONE, STARTED],
      ["7", "..", STARTED],
      ["7", "a/b", STARTED],
      ["7", CLONE, ""],
      ["7", CLONE, STARTED, "extra"],
    ])
      expect(recordedRun(argv)).toBeNull();
  });
});

describe("driverPresence", () => {
  it("knows nothing of a run this host's database does not record", async () => {
    const dir = stateDir();
    expect(await driverPresence(RUN, dir)).toMatchObject({
      verdict: "unknown",
      why: expect.stringContaining("has no drive database"),
    });
    writeDriverRecord(dir, "7", {
      worktree: dir,
      started: "2026-11-07T11:00:00.000Z",
      pid: process.pid,
      host: hostname(),
    });
    expect(await driverPresence(RUN, dir)).toMatchObject({
      verdict: "unknown",
      why: expect.stringContaining("holds no record of the driver's run"),
    });
  });

  it("reads a released driver as gone once its pid no longer runs", async () => {
    const dir = stateDir();
    const record = { worktree: dir, started: STARTED, host: hostname() };
    writeDriverRecord(dir, "7", {
      ...record,
      pid: await deadPid(),
      released: true,
    });
    expect((await driverPresence(RUN, dir)).verdict).toBe("gone");
    writeDriverRecord(dir, "7", {
      ...record,
      pid: process.pid,
      released: true,
    });
    expect((await driverPresence(RUN, dir)).verdict).toBe("present");
  });

  it("reads a driver still holding its lock as present, and one with no observation as unknown", async () => {
    const dir = stateDir();
    writeDriverRecord(dir, "7", {
      worktree: dir,
      started: STARTED,
      pid: await deadPid(),
      host: hostname(),
    });
    expect(await driverPresence(RUN, dir)).toMatchObject({
      verdict: "unknown",
      why: expect.stringContaining("left no complete observation"),
    });
    putLock(dir, "pr-drive-7", {
      diag: { pr: "7", worktree: dir, log: "", started: STARTED },
    });
    expect(await driverPresence(RUN, dir)).toMatchObject({
      verdict: "present",
      why: expect.stringContaining("still holds the pull request's lock"),
    });
  });
});
