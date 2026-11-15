/**
 * Where the resource lock lives and its portable wait announcements, free of
 * the lock's signal handling so a reader can import them without taking on
 * the lock's process-wide handlers. Older lock readers still read the identity.
 */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { decodeIdentity, isAliveSync, ownIdentity } from "./liveness.ts";
import { currentIso, parseMs } from "./time.ts";
import { swallow } from "./errors.ts";
import { isMapping } from "./config-layers.ts";

/** The lock's root and name as `env` sets them for a run: `LOCK_ROOT`, else the temporary directory; `LOCK_NAME`, else `heavy`. */
export function lockPlace(env: NodeJS.ProcessEnv = process.env): {
  root: string;
  name: string;
} {
  return {
    root: env.LOCK_ROOT || env.TMPDIR || tmpdir(),
    name: env.LOCK_NAME || "heavy",
  };
}

/** The lock file of the lock `name` under `root`, its name made safe for a file name. */
export function resourceLockPath(root: string, name: string): string {
  const safe = Array.from(new TextEncoder().encode(name), (b) =>
    /[A-Za-z0-9._-]/.test(String.fromCharCode(b))
      ? String.fromCharCode(b)
      : "_",
  ).join("");
  return join(root, `jig-lock.${safe}`);
}

export interface LockWait {
  pid: number;
  workspace: string;
  since: string;
}

/** The process identity and working directory are captured before waiting. */
export function encodeLockWait(): string {
  return JSON.stringify({
    ...ownIdentity(),
    workspace: process.cwd(),
    since: currentIso(),
  });
}

/** Read only live, attributable announcements; an older announcement has no workspace. */
export function readLockWaits(root: string, lockPath: string): LockWait[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (error) {
    swallow(error, "the test lock's wait announcements could not be read");
    return [];
  }
  const prefix = `${basename(lockPath)}.waiting.`;
  return entries.flatMap((entry): LockWait[] => {
    if (!entry.startsWith(prefix)) return [];
    try {
      const path = join(root, entry);
      if (!lstatSync(path).isFile()) return [];
      const text = readFileSync(path, "utf8");
      const identity = decodeIdentity(text);
      if (
        identity === null ||
        String(identity.pid) !== entry.slice(prefix.length)
      )
        return [];
      const data: unknown = JSON.parse(text);
      if (
        !isMapping(data) ||
        typeof data.workspace !== "string" ||
        typeof data.since !== "string" ||
        !Number.isFinite(parseMs(data.since))
      )
        return [];
      const live = isAliveSync(identity);
      if (!live.ok) {
        swallow(
          live.failure,
          "a waiter's identity could not be checked, so its wait is not attributed",
        );
        return [];
      }
      if (live.value.state !== "alive") return [];
      return [
        { pid: identity.pid, workspace: data.workspace, since: data.since },
      ];
    } catch (error) {
      swallow(error, "an unreadable or ended waiter is not attributed");
      return [];
    }
  });
}
