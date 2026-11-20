/**
 * The resource lock's occupancy, as another mechanism reads it: the runs
 * holding a slot, and the runs announcing they wait for one, each counted
 * only while its pid answers.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { readResourceLockSamples } from "../resource-lock-samples.ts";
import { lockOccupancy, resourceLockRuns } from "../resource-lock.ts";

const LOCK = resolve(import.meta.dir, "../resource-lock.ts");
/** The lock run as a command: its `main` over `-- true`. */
const RUN = `const { main } = await import(${JSON.stringify(LOCK)}); process.exitCode = await main(["--", "true"]);`;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function root(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jig-lock-occupancy-")));
  dirs.push(dir);
  return dir;
}

/** A pid no process holds: one a finished child had. */
function deadPid(): number {
  const child = Bun.spawnSync(["true"]);
  return child.pid;
}

describe("the lock's occupancy", () => {
  it("counts an unverifiable live waiter without attributing its workspace", () => {
    const dir = root();
    writeFileSync(
      join(dir, `jig-lock.heavy.waiting.${process.pid}`),
      JSON.stringify({ pid: process.pid, host: "", start: "", workspace: dir }),
    );
    expect(resourceLockRuns(dir, "heavy")).toEqual({
      holders: 0,
      waiters: 1,
      runs: [{ workspace: null }],
    });
  });

  it.if(process.platform !== "win32")(
    "unreadable holder and waiter metadata never blocks the occupancy read",
    () => {
      const dir = root();
      const lock = join(dir, "jig-lock.heavy");
      symlinkSync(String(process.pid), lock);
      expectSpawnExit(
        Bun.spawnSync([
          "mkfifo",
          `${lock}.holder`,
          `${lock}.waiting.${process.pid}`,
        ]),
        0,
      );
      const program = `const { resourceLockRuns } = await import(${JSON.stringify(LOCK)});
        console.log(JSON.stringify(resourceLockRuns(${JSON.stringify(dir)}, "heavy")));`;
      const child = Bun.spawnSync([process.execPath, "-e", program], {
        timeout: 5000,
      });
      expectSpawnExit(child, 0);
      expect(JSON.parse(child.stdout.toString())).toEqual({
        holders: 1,
        waiters: 1,
        runs: [{ workspace: null }],
      });
    },
  );

  it.if(process.platform !== "win32")(
    "counts the live holders across its slots and the live waiters' announcements",
    () => {
      const dir = root();
      symlinkSync(String(process.pid), join(dir, "jig-lock.heavy"));
      symlinkSync(String(process.pid), join(dir, "jig-lock.heavy-slot-2"));
      writeFileSync(join(dir, `jig-lock.heavy.waiting.${process.pid}`), "");
      writeFileSync(join(dir, `jig-lock.heavy.waiting.${deadPid()}`), "");
      writeFileSync(join(dir, `jig-lock.other.waiting.${process.pid}`), "");
      expect(lockOccupancy(dir, "heavy")).toEqual({ holders: 2, waiters: 1 });
      expect(resourceLockRuns(dir, "heavy")).toEqual({
        holders: 2,
        waiters: 1,
        runs: [{ workspace: null }],
      });
      writeFileSync(
        join(dir, "jig-lock.heavy.holder"),
        JSON.stringify({
          pid: process.pid,
          host: "",
          start: "",
          workspace: dir,
        }),
      );
      expect(resourceLockRuns(dir, "heavy").runs).toEqual([{ workspace: dir }]);
      expect(lockOccupancy(join(dir, "missing"), "heavy")).toEqual({
        holders: 0,
        waiters: 0,
      });
    },
  );

  it.if(process.platform !== "win32")(
    "a run announces its wait while the lock is held, and withdraws it once it holds a slot",
    async () => {
      const dir = root();
      const held = join(dir, "jig-lock.heavy");
      symlinkSync(String(process.pid), held);
      // A CI runner sets CI, which makes the lock run its command unlocked.
      const { CI: _ci, RESOURCE_LOCK_BYPASS: _bypass, ...env } = process.env;
      const lockEnv = {
        ...env,
        HOME: dir,
        USERPROFILE: dir,
        LOCK_ROOT: dir,
        LOCK_NAME: "heavy",
        LOCK_SLOTS: "1",
        LOCK_TIMEOUT: "30",
        LOCK_POLL: "0.05",
      };
      const child = Bun.spawn([process.execPath, "-e", RUN], {
        cwd: dir,
        env: lockEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const deadline = Date.now() + 20_000;
      while (lockOccupancy(dir, "heavy").waiters === 0 && Date.now() < deadline)
        await Bun.sleep(25);
      expect(lockOccupancy(dir, "heavy")).toEqual({ holders: 1, waiters: 1 });
      expect(resourceLockRuns(dir, "heavy")).toEqual({
        holders: 1,
        waiters: 1,
        runs: [{ workspace: dir }, { workspace: null }],
      });
      rmSync(held);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expectSpawnExit({ stdout, stderr, exitCode }, 0);
      expect(readdirSync(dir).filter((f) => f.includes(".waiting."))).toEqual(
        [],
      );
      expect(existsSync(held)).toBe(false);
      const [sample] = readResourceLockSamples("heavy", undefined, lockEnv);
      expect(sample?.waitMs).toBeGreaterThan(0);
    },
    30_000,
  );
});
