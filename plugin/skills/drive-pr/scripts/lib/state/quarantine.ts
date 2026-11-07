/** Retirement of displaced locks from the file-based state layout. */
import {
  accessSync,
  constants,
  lstatSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { swallow } from "../../../../../shared/errors.ts";
import { FORMER_QUARANTINE, isFormerLock } from "./import.ts";

/** A full day without a write, independent of the clone's import date. */
export const QUARANTINE_RETENTION_DAYS = 1;

interface Measurement {
  bytes: number;
  newest: number;
}

interface Snapshot {
  metadata: string;
  children: string[] | null;
}

function metadata(stat: Stats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ].join(":");
}

/** Count bytes and newest writes without following a link outside this family. */
function measure(
  path: string,
  snapshots: Map<string, Snapshot>,
): Measurement | null {
  const stat = lstatSync(path);
  if (!stat.isFile() && !stat.isDirectory()) return null;
  accessSync(path, constants.R_OK);
  if (stat.isFile() && (Number(stat.mode) & 0o444) === 0) return null;
  const children = stat.isDirectory() ? readdirSync(path).sort() : null;
  snapshots.set(path, { metadata: metadata(stat), children });
  let bytes = stat.size;
  let newest = stat.mtimeMs;
  if (children)
    for (const name of children) {
      const child = measure(join(path, name), snapshots);
      if (child === null) return null;
      bytes += child.bytes;
      newest = Math.max(newest, child.newest);
    }
  return { bytes, newest };
}

/**
 * Fail closed for every old lock, even an empty or unreadable one: its holder
 * may still resume. Re-read names under the reaper's delete lock rather than
 * relying on the enumeration that happened before acquisition.
 */
export function judgeQuarantine(
  stateDir: string,
  names: readonly string[],
): {
  action: "retire" | "keep";
  reason: string;
  bytes: number | null;
} {
  let bytes = 0;
  let newest = 0;
  try {
    const snapshots = new Map<string, Snapshot>();
    for (const name of names) {
      const entry = measure(join(stateDir, name), snapshots);
      if (entry === null)
        return {
          action: "keep",
          bytes: null,
          reason: "quarantine contains an unreadable or unsupported entry",
        };
      bytes += entry.bytes;
      newest = Math.max(newest, entry.newest);
    }
    for (const [path, snapshot] of snapshots) {
      if (
        metadata(lstatSync(path)) !== snapshot.metadata ||
        (snapshot.children !== null &&
          JSON.stringify(readdirSync(path).sort()) !==
            JSON.stringify(snapshot.children))
      )
        return {
          action: "keep",
          bytes,
          reason: "quarantine descendants changed during the sweep",
        };
    }
    const current = readdirSync(stateDir);
    if (current.some(isFormerLock))
      return {
        action: "keep",
        bytes,
        reason: "a legacy lock or recovery gate is present",
      };
    const members = current.filter((name) => FORMER_QUARANTINE.test(name));
    const expected = new Set(names);
    if (
      members.length !== expected.size ||
      members.some((name) => !expected.has(name))
    )
      return {
        action: "keep",
        bytes,
        reason: "quarantine membership changed during the sweep",
      };
  } catch (error) {
    swallow(error, "unreadable quarantine is kept");
    return {
      action: "keep",
      bytes: null,
      reason: "quarantine or the clone directory could not be read safely",
    };
  }
  if (
    !Number.isFinite(newest) ||
    Date.now() - newest < QUARANTINE_RETENTION_DAYS * 86_400_000
  )
    return {
      action: "keep",
      bytes,
      reason: "quarantine touched within the last 24 hours",
    };
  return {
    action: "retire",
    bytes,
    reason: "quarantine is older than 24 hours and no legacy lock is present",
  };
}
