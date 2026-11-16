/**
 * Where the resource lock lives and its portable wait announcements, free of
 * the lock's signal handling so a reader can import them without taking on
 * the lock's process-wide handlers. Older lock readers still read the identity.
 */
import { closeSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
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

/** An announcement is a few hundred bytes; a larger file is not one and is never read whole. */
const MAX_ANNOUNCEMENT_BYTES = 4096;

/** The file's text when it is a regular file within the announcement bound; `null` otherwise. */
function readAnnouncement(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ANNOUNCEMENT_BYTES) return null;
    const buffer = Buffer.alloc(MAX_ANNOUNCEMENT_BYTES);
    const read = readSync(fd, buffer, 0, MAX_ANNOUNCEMENT_BYTES, 0);
    return buffer.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
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

/** One entry's wait when its file is a live announcement of the pid its name gives; `null` otherwise. */
function readWait(
  root: string,
  entry: string,
  pid: string,
  deadline?: number,
): LockWait | null {
  if (!/^[1-9][0-9]{0,9}$/.test(pid)) return null;
  const text = readAnnouncement(join(root, entry));
  if (text === null) return null;
  const identity = decodeIdentity(text);
  if (identity === null || String(identity.pid) !== pid) return null;
  const data: unknown = JSON.parse(text);
  if (
    !isMapping(data) ||
    typeof data.workspace !== "string" ||
    typeof data.since !== "string" ||
    !Number.isFinite(parseMs(data.since))
  )
    return null;
  const live = isAliveSync(identity, undefined, deadline);
  if (!live.ok) {
    swallow(
      live.failure,
      "a waiter's identity could not be checked, so its wait is not attributed",
    );
    return null;
  }
  if (live.value.state !== "alive") return null;
  return { pid: identity.pid, workspace: data.workspace, since: data.since };
}

/** Read only live, attributable announcements; an older announcement has no workspace. `deadline` (`performance.now()` milliseconds) stops the scan and bounds each liveness probe. */
export function readLockWaits(
  root: string,
  lockPath: string,
  deadline?: number,
): LockWait[] {
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
    // Out of time: the announcements still unread are not attributed.
    if (deadline !== undefined && performance.now() >= deadline) return [];
    try {
      const wait = readWait(root, entry, entry.slice(prefix.length), deadline);
      return wait === null ? [] : [wait];
    } catch (error) {
      swallow(error, "an unreadable or ended waiter is not attributed");
      return [];
    }
  });
}
