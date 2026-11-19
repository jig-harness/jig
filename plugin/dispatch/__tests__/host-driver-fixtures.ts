/** Live drivers written straight into a drive database under a state root, as `drive.ts` holds its pull request's lock. */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { lockIdentity, type ProcessIdentity } from "../../shared/liveness.ts";
import { prLockName } from "../../skills/drive-pr/scripts/lib/driver/locks.ts";
import { driveDb } from "../../skills/drive-pr/scripts/lib/state/db.ts";
import { takeLockRow } from "../../skills/drive-pr/scripts/lib/state/lock.ts";

/** A driver of `pr` holding its lock under `root`, working `worktree`, billing `identity`. */
export function holdLock(
  root: string,
  pr: number,
  worktree: string,
  identity: string | null,
  holder: ProcessIdentity = lockIdentity(),
): void {
  const drive = driveDb(join(root, "clone-a"));
  const taken = takeLockRow(drive, prLockName(String(pr)), null, {
    token: randomUUID(),
    label: "drive.ts",
    holder,
    detail: JSON.stringify({
      pr: String(pr),
      worktree,
      log: join(worktree, "driver.log"),
      started: "2026-11-19T10:00:00.000Z",
      account:
        identity === null
          ? {
              account: null,
              vendor: "claude",
              provenance: "oauthAccount",
              reason: "no account in the configuration",
            }
          : {
              account: identity,
              vendor: "claude",
              provenance: "oauthAccount",
              reason: null,
            },
    }),
  });
  expect(taken).toBe(true);
}

/** The pid of a process that has exited. */
export function exitedPid(): number {
  const child = Bun.spawnSync([process.execPath, "-e", ""]);
  return child.pid;
}

/** Make the holder of `pr`'s lock under `root` a process that has exited. */
export function endHolder(root: string, pr: number): void {
  const drive = driveDb(join(root, "clone-a"));
  drive.db.run("UPDATE locks SET pid = ? WHERE name = ?", [
    exitedPid(),
    prLockName(String(pr)),
  ]);
}
