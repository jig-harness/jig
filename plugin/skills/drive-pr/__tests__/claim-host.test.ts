/**
 * A driver lock's row names its holder's host by the shared host id
 * (`shared/liveness.ts`) beside its name, so a lock this machine took under
 * an earlier host name is judged by its pid, and one from another machine
 * stays unanswerable whatever name it carries.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { thisHost } from "../../../shared/liveness.ts";
import { claimLive, samePidNamespace } from "../scripts/lib/claim.ts";
import {
  acquire,
  claimAlive,
  type DriveLock,
  inspectLock,
  prLockName,
  release,
} from "../scripts/lib/driver/locks.ts";
import { putLock } from "./state-rows.ts";

/** A pid that has exited: a child run to completion. */
function deadPid(): number {
  const child = Bun.spawnSync([process.execPath, "-e", "0"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(child, 0);
  return child.pid;
}

let root = "";
let stateDir = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jig-claim-host-"));
  stateDir = join(root, "clone");
  mkdirSync(stateDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function inspected(name: string) {
  const claim = inspectLock(stateDir, name);
  if (claim === null) throw new Error(`lock ${name} has no holder`);
  return claim;
}

describe("a driver lock's host", () => {
  it("records this machine's host id beside its name and platform, and reads it back", () => {
    const lock: DriveLock = { stateDir, name: prLockName("7"), what: "PR" };
    acquire(lock, "7");
    try {
      expect(inspected(lock.name)).toMatchObject({
        nonce: lock.nonce,
        pid: process.pid,
        host: hostname(),
        platform: process.platform,
        hostId: thisHost().hostId,
      });
    } finally {
      release(lock);
    }
    expect(inspectLock(stateDir, lock.name)).toBeNull();
  });

  it("judges a claim written under this host's earlier name by its pid", () => {
    const renamed = {
      pid: deadPid(),
      host: "an-earlier-name.local",
      hostId: thisHost().hostId,
      platform: process.platform,
      ageMs: 0,
    };
    expect(samePidNamespace(renamed)).toBe(true);
    expect(claimLive(renamed)).toBe(false);
    expect(claimLive({ ...renamed, pid: process.pid })).toBe(true);
  });

  it("judges a lock taken under this host's earlier name by its pid", () => {
    const name = prLockName("8");
    const earlier = {
      host: "an-earlier-name.local",
      hostId: thisHost().hostId,
      bootId: thisHost().bootId,
    };
    putLock(stateDir, name, { ...earlier, pid: deadPid() });
    expect(claimAlive(inspected(name))).toBe(false);
    putLock(stateDir, name, earlier);
    expect(claimAlive(inspected(name))).toBe(true);
  });

  it("leaves a lock from another host id unanswerable, even under this host's name", () => {
    const name = prLockName("9");
    putLock(stateDir, name, {
      pid: deadPid(),
      host: hostname(),
      hostId: "f".repeat(32),
    });
    const elsewhere = inspected(name);
    expect(samePidNamespace(elsewhere)).toBe(false);
    expect(claimLive({ ...elsewhere, ageMs: 0 })).toBe(true);
    expect(claimAlive(elsewhere)).toBe(true);
  });
});
