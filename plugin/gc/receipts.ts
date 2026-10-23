import { GcError } from "../shared/gc-error.ts";
import { isMapping } from "../shared/config-layers.ts";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  rmSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Receipt } from "./types.ts";

export function stateRoot(): string {
  return join(homedir(), ".local", "state", "jig", "gc");
}
function receiptPath(receipt: Receipt, root: string): string {
  const dir = join(root, receipt.startedAt.slice(0, 10));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${receipt.runId}.json`);
}
/**
 * A file's fsync does not persist the directory entry that names it. Windows
 * refuses to fsync a directory (EPERM), and Node offers no other flush of a
 * directory entry there, so on Windows the entry is left to the file system:
 * NTFS keeps it consistent across a crash, but a power loss just after
 * publication can lose the newest receipt or its latest update.
 */
function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function publish(receipt: Receipt, path: string, replace: boolean): void {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (replace) renameSync(temporary, path);
    else linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  // Removal follows publication, so the day directory's own entry and the
  // receipt's name must both survive a crash first.
  syncDirectory(dirname(path));
  syncDirectory(dirname(dirname(path)));
}
export function writeReceipt(receipt: Receipt, root = stateRoot()): string {
  const path = receiptPath(receipt, root);
  publish(receipt, path, false);
  return path;
}
/**
 * One file per run, atomically updated; intent is durable before removal,
 * except for the directory entry on Windows (see syncDirectory).
 */
export function openReceipt(
  receipt: Receipt,
  root = stateRoot(),
): { path: string; update(): void } {
  const path = writeReceipt(receipt, root);
  return { path, update: () => publish(receipt, path, true) };
}
export function receiptPaths(root = stateRoot()): string[] {
  let days: string[];
  try {
    days = readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return days
    .filter(
      (day) =>
        /^\d{4}-\d{2}-\d{2}$/.test(day) &&
        lstatSync(join(root, day)).isDirectory(),
    )
    .sort()
    .flatMap((day) =>
      readdirSync(join(root, day), { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            /^[\dTZ.-]+-\d+-[a-f\d-]+\.json$/.test(entry.name),
        )
        .map((entry) => join(root, day, entry.name))
        .sort(),
    );
}
const KIND_NAMES = ["scratch", "worktrees", "tool-state", "receipts"];
/** Retention orders these as text, which is chronological only in this form. */
function isDate(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function isKnownKind(value: unknown): boolean {
  return typeof value === "string" && KIND_NAMES.includes(value);
}
function isReceiptHeader(value: Record<string, unknown>): boolean {
  return (
    value.version === 1 &&
    typeof value.runId === "string" &&
    isDate(value.startedAt) &&
    isDate(value.finishedAt) &&
    typeof value.collect === "boolean" &&
    typeof value.completed === "boolean" &&
    [0, 1, 2].includes(Number(value.exitStatus))
  );
}
function isKindRecord(value: unknown): boolean {
  return (
    isMapping(value) &&
    isKnownKind(value.name) &&
    typeof value.declaration === "string" &&
    (value.repository === undefined || typeof value.repository === "string")
  );
}
function isResourceRecord(value: unknown): boolean {
  return (
    isMapping(value) &&
    isKnownKind(value.kind) &&
    typeof value.resource === "string" &&
    typeof value.reason === "string" &&
    typeof value.outcome === "string" &&
    [
      "collected",
      "would-collect",
      "refused",
      "finding",
      "unverified",
      "failed",
    ].includes(value.outcome)
  );
}
function isReceipt(value: unknown): value is Receipt {
  return (
    isMapping(value) &&
    isReceiptHeader(value) &&
    Array.isArray(value.kinds) &&
    Array.isArray(value.resources) &&
    value.kinds.every(isKindRecord) &&
    value.resources.every(isResourceRecord)
  );
}
export function readReceipt(path: string): Receipt {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isReceipt(value))
    throw new GcError(`Invalid collection receipt: ${path}`);
  return value;
}
