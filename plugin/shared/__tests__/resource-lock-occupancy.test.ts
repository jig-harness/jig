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
import { lockOccupancy } from "../resource-lock.ts";

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
      const child = Bun.spawn([process.execPath, "-e", RUN], {
        env: {
          ...env,
          LOCK_ROOT: dir,
          LOCK_SLOTS: "1",
          LOCK_TIMEOUT: "30",
          LOCK_POLL: "0.05",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const deadline = Date.now() + 20_000;
      while (lockOccupancy(dir, "heavy").waiters === 0 && Date.now() < deadline)
        await Bun.sleep(25);
      expect(lockOccupancy(dir, "heavy")).toEqual({ holders: 1, waiters: 1 });
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
    },
    30_000,
  );
});
