/** Retirement of displaced locks from the file-based state layout. */
import {
  accessSync,
  constants,
  lstatSync,
  readdirSync,
  statSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { swallow } from "../../../../../shared/errors.ts";
import {
  FORMER_QUARANTINE,
  isFormerLock,
  isFormerWriterFile,
} from "./import.ts";

/**
 * A full day in which no earlier-release writer touched the clone's files,
 * independent of the clone's import date. A legacy driver renews its lease at
 * least every `SESSION_LEASE_MIN` (6 hours), so a day of silence means none is
 * alive to resume into a displaced lock's name. An entry's age is its last write.
 */
export const QUARANTINE_RETENTION_DAYS = 1;

const DAY_MS = 86_400_000;

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

/** Whether every measured path still has the metadata and children it was measured with. */
function unchanged(snapshots: ReadonlyMap<string, Snapshot>): boolean {
  for (const [path, snapshot] of snapshots)
    if (
      metadata(lstatSync(path)) !== snapshot.metadata ||
      (snapshot.children !== null &&
        JSON.stringify(readdirSync(path).sort()) !==
          JSON.stringify(snapshot.children))
    )
      return false;
  return true;
}

/** Whether a file of a running earlier release was written within the retention. */
function legacyWriterActive(
  stateDir: string,
  current: readonly string[],
  now: number,
): boolean {
  return current.some((name) => {
    if (!isFormerWriterFile(name)) return false;
    const { mtimeMs } = statSync(join(stateDir, name));
    return (
      !Number.isFinite(mtimeMs) ||
      now - mtimeMs < QUARANTINE_RETENTION_DAYS * DAY_MS
    );
  });
}

/**
 * Retire the family only when nothing shows an earlier-release writer alive
 * in this clone: no lock or recovery gate of the earlier layout is present,
 * none of its state, lease, driver or claim files was written within the
 * retention, and no entry of the family (nor anything under one) is younger
 * than that. A displaced lock's name fences a process of the earlier release
 * that may resume into it; such a process keeps its files fresh, so a day
 * without any write leaves no one to fence. Anything unreadable or changing
 * during the sweep keeps the whole family. Names are re-read under the
 * reaper's delete lock rather than relying on the enumeration that happened
 * before acquisition.
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
    if (!unchanged(snapshots))
      return {
        action: "keep",
        bytes,
        reason: "quarantine descendants changed during the sweep",
      };
    const current = readdirSync(stateDir);
    const now = Date.now();
    if (current.some(isFormerLock))
      return {
        action: "keep",
        bytes,
        reason: "a legacy lock or recovery gate is present",
      };
    if (legacyWriterActive(stateDir, current, now))
      return {
        action: "keep",
        bytes,
        reason: `a file of the earlier release was written within the last ${QUARANTINE_RETENTION_DAYS * 24} hours`,
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
    // A second pass, after the clone's own listing, catches a write that
    // landed behind the first pass's check of its path.
    if (!unchanged(snapshots))
      return {
        action: "keep",
        bytes,
        reason: "quarantine descendants changed during the sweep",
      };
    if (
      !Number.isFinite(newest) ||
      now - newest < QUARANTINE_RETENTION_DAYS * DAY_MS
    )
      return {
        action: "keep",
        bytes,
        reason: `quarantine touched within the last ${QUARANTINE_RETENTION_DAYS * 24} hours`,
      };
    return {
      action: "retire",
      bytes,
      reason: `no earlier-release writer has written for ${QUARANTINE_RETENTION_DAYS * 24} hours, so no suspended holder can resume into these names`,
    };
  } catch (error) {
    swallow(error, "unreadable quarantine is kept");
    return {
      action: "keep",
      bytes: null,
      reason: "quarantine or the clone directory could not be read safely",
    };
  }
}
