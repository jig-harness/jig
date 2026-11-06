/**
 * `lib/state/lock.ts`: a named lock is a row of the drive's database. Taking
 * it inserts the row or replaces one whose holder is gone; releasing it
 * deletes the row only while it carries this acquisition's token, so nothing
 * is left behind and a holder whose lock was broken never releases its
 * successor's.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  createLock,
  LockAcquireTimeoutError,
} from "../scripts/lib/state/lock.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
import { lockNames, lockRow, putLock } from "./state-rows.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "drive-lock-"));
  roots.push(root);
  return scopedStateDir(root);
}

/** A pid that is definitively gone. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
  return p.pid;
}

describe("lock.ts named lock", () => {
  it("acquire then release round-trips, leaving no row and no file", async () => {
    const dir = stateDir();
    const lock = createLock(dir, "drive-pr-999", "probe", "999");
    await lock.acquire();
    expect(lockRow(dir, "drive-pr-999")?.pid).toBe(process.pid);
    lock.release();
    expect(lockNames(dir)).toEqual([]);
    expect(
      readdirSync(dirname(dir)).filter((n) => n.includes(".lock")),
    ).toEqual([]);
    lock.dispose();
  });

  it("a contender waits for a live holder and takes the lock once it is released", async () => {
    const dir = stateDir();
    const first = createLock(dir, "drive-pr-999", "probe", "999");
    await first.acquire();
    const second = createLock(dir, "drive-pr-999", "probe", "999");
    let taken = false;
    const waiting = second.acquire().then(() => {
      taken = true;
    });
    await Bun.sleep(150);
    expect(taken).toBe(false);
    first.release();
    await waiting;
    expect(taken).toBe(true);
    second.dispose();
    first.dispose();
  });

  it("breaks a lock whose holder is dead at once", async () => {
    const dir = stateDir();
    putLock(dir, "drive-pr-999", { pid: await deadPid(), token: "gone" });
    const lock = createLock(dir, "drive-pr-999", "probe", "999");
    const started = performance.now();
    await lock.acquire(5);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(lockRow(dir, "drive-pr-999")?.pid).toBe(process.pid);
    lock.dispose();
  });

  it("repeated dead-holder recovery leaves one row while held and no residue after release", async () => {
    const dir = stateDir();
    const pid = await deadPid();
    let files: string[] | undefined;
    for (let i = 0; i < 100; i++) {
      putLock(dir, "drive-pr-999", { pid, token: `gone-${i}` });
      const lock = createLock(dir, "drive-pr-999", "probe", "999");
      try {
        await lock.acquire(5);
        expect(lockNames(dir)).toEqual(["drive-pr-999"]);
        const current = readdirSync(dir);
        files ??= current;
        expect(current).toEqual(files);
      } finally {
        lock.dispose();
      }
      expect(lockNames(dir)).toEqual([]);
    }
    expect(readdirSync(dir)).toEqual(files ?? []);
  });

  it("breaks a live holder's lock once it has not been renewed within the window", async () => {
    const dir = stateDir();
    putLock(dir, "drive-pr-999", {
      pid: process.pid,
      token: "hung",
      renewedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const lock = createLock(dir, "drive-pr-999", "probe", "999");
    await lock.acquire(5);
    expect(lockRow(dir, "drive-pr-999")?.token).not.toBe("hung");
    lock.dispose();
  });

  it("keeps a lock held on another host until its window passes", async () => {
    const dir = stateDir();
    putLock(dir, "drive-pr-999", {
      pid: 1,
      host: `not-${hostname()}`,
      hostId: "another-host",
      token: "elsewhere",
    });
    const lock = createLock(dir, "drive-pr-999", "probe", "999");
    await expect(lock.acquire(0)).rejects.toBeInstanceOf(
      LockAcquireTimeoutError,
    );
    expect(lockRow(dir, "drive-pr-999")?.token).toBe("elsewhere");
    lock.dispose();
  });

  it("release never removes a successor that broke and replaced this holder's lock", async () => {
    const dir = stateDir();
    const lock = createLock(dir, "drive-pr-999", "probe", "999");
    await lock.acquire();
    putLock(dir, "drive-pr-999", { token: "successor" });
    lock.release();
    expect(lockRow(dir, "drive-pr-999")?.token).toBe("successor");
    lock.dispose();
  });

  it("touch renews the holder's heartbeat, and never a successor's", async () => {
    const dir = stateDir();
    const lock = createLock(dir, "drive-pr-999", "probe", "999");
    await lock.acquire();
    const before = lockRow(dir, "drive-pr-999")?.renewed_at ?? "";
    await Bun.sleep(5);
    lock.touch();
    const after = lockRow(dir, "drive-pr-999")?.renewed_at ?? "";
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    const old = new Date(Date.now() - 60_000).toISOString();
    putLock(dir, "drive-pr-999", { token: "successor", renewedAt: old });
    lock.touch();
    expect(lockRow(dir, "drive-pr-999")?.renewed_at).toBe(old);
    lock.dispose();
  });

  it("touch is a no-op when this process does not hold the lock", () => {
    const dir = stateDir();
    const lock = createLock(dir, "drive-pr-999", "probe", "999");
    lock.touch();
    expect(lockNames(dir)).toEqual([]);
    lock.dispose();
  });

  it("DRIVE_PR_LOCK_TIMEOUT=0 makes one immediate attempt: it takes a free lock and refuses a held one", async () => {
    const dir = stateDir();
    const script = `
      import { createLock } from ${JSON.stringify(join(import.meta.dir, "..", "scripts", "lib", "state", "lock.ts"))};
      const lock = createLock(process.argv[1], "drive-pr-999", "probe", "999");
      try { await lock.acquire(); console.log("held"); lock.dispose(); }
      catch { console.log("refused"); process.exitCode = 1; }
    `;
    const attempt = () =>
      Bun.spawnSync([process.execPath, "-e", script, dir], {
        env: { ...process.env, DRIVE_PR_LOCK_TIMEOUT: "0" },
        stdout: "pipe",
        stderr: "pipe",
      });
    const free = attempt();
    expectSpawnExit(free, 0);
    expect(free.stdout.toString().trim()).toBe("held");
    const holder = createLock(dir, "drive-pr-999", "probe", "999");
    await holder.acquire();
    const started = performance.now();
    const held = attempt();
    expectSpawnExit(held, 1);
    expect(held.stdout.toString().trim()).toBe("refused");
    expect(performance.now() - started).toBeLessThan(5_000);
    holder.dispose();
  });
});
