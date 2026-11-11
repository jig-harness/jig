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
import {
  FORMER_QUARANTINE,
  isFormerLock,
  isFormerWriterFile,
} from "./import.ts";

/**
 * A full day in which no earlier-release writer touched the clone's files,
 * independent of the clone's import date. A legacy driver renews its lease at
 * least every `SESSION_LEASE_MIN` (6 hours), so a day of silence makes a live
 * one unlikely; a driver suspended for longer is an accepted, undetected limit. An entry's age is its last write.
 */
export const QUARANTINE_RETENTION_DAYS = 1;

const DAY_MS = 86_400_000;

// Code-unit order: a total order over distinct names, independent of locale.
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

/**
 * Metadata of the earlier release's writer files, or null when one cannot be
 * read as a regular file: such a file might hide a live writer, so it keeps
 * the family. Also reports whether any was written within the retention.
 */
function writerFiles(
  stateDir: string,
  current: readonly string[],
  now: number,
): { fingerprint: string; active: boolean } | null {
  const parts: string[] = [];
  let active = false;
  for (const name of current.filter(isFormerWriterFile).sort(byName)) {
    const path = join(stateDir, name);
    const stat = lstatSync(path);
    if (!stat.isFile()) return null;
    accessSync(path, constants.R_OK);
    if ((Number(stat.mode) & 0o444) === 0) return null;
    parts.push(`${name}=${metadata(stat)}`);
    if (
      !Number.isFinite(stat.mtimeMs) ||
      now - stat.mtimeMs < QUARANTINE_RETENTION_DAYS * DAY_MS
    )
      active = true;
  }
  return { fingerprint: parts.join("|"), active };
}

/**
 * Retire the family only when nothing shows an earlier-release writer alive
 * in this clone: no lock or recovery gate of the earlier layout is present,
 * none of its state, lease, driver or claim files was written within the
 * retention, and no entry of the family (nor anything under one) is younger
 * than that. This is an idle-retention policy, not proof that no writer
 * exists: a process of the earlier release keeps its files fresh, so a day
 * without any write makes one unlikely, but a driver suspended longer and
 * resumed afterwards is not detected. Anything unreadable or changing during
 * the sweep keeps the whole family, including the clone listing and the
 * writer files' metadata. Names are re-read under the reaper's delete lock
 * rather than relying on the enumeration that happened before acquisition.
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
    const writers = writerFiles(stateDir, current, now);
    if (writers === null)
      return {
        action: "keep",
        bytes,
        reason: "a file of the earlier release could not be read safely",
      };
    if (writers.active)
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
    // landed behind the first pass's check of its path. It covers the clone
    // listing and the writer files too, so a lease renewed or a legacy lock
    // created during the sweep keeps the family.
    const after = readdirSync(stateDir);
    const writersAfter = writerFiles(stateDir, after, Date.now());
    if (
      !unchanged(snapshots) ||
      writersAfter === null ||
      writersAfter.fingerprint !== writers.fingerprint ||
      after.some(isFormerLock) ||
      JSON.stringify([...after].sort(byName)) !==
        JSON.stringify([...current].sort(byName))
    )
      return {
        action: "keep",
        bytes,
        reason: "the clone's files changed during the sweep",
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
      reason: `no earlier-release writer has written for ${QUARANTINE_RETENTION_DAYS * 24} hours (an idle-retention policy; a driver suspended longer is not detected)`,
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
