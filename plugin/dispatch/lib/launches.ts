/**
 * Launch records, under `~/.local/state/jig/dispatch/launches/`: one per
 * session the dispatcher started, written by the tick before it calls the
 * runtime's `launch`, so a launch whose answer is lost still holds its
 * stage and its account's slot.
 *
 * A record is three files, each written by one writer, so no write ever
 * races another:
 *
 * - `<id>.json`, the tick's: the action, the pull request, the account, the
 *   random token, the workspace and the runtime's answer to each launch;
 * - `<id>.claim`, the wrapper's (`run.ts`): the process identity it ran
 *   under (host, boot id, process id and the process's start time),
 *   published whole by a hard link, so exactly one wrapper ever claims a
 *   record;
 * - `<id>.exit`, the wrapper's again: the stage's exit, once it ended.
 *
 * A record's state is read from those files and the process table:
 *
 * | Files | State |
 * | --- | --- |
 * | an exit | ended, with the stage's exit |
 * | a claim whose process is alive under the same identity | alive |
 * | a claim from another host or boot, or an unreadable process table | unknown |
 * | a claim whose process is gone, and no exit | died |
 * | no claim | pending |
 *
 * Pending, alive and unknown records hold their stage and their account's
 * slot; an unknown or a pending record whose launch cannot be retried
 * holds them until a person removes its files.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { type ProcessRow, processTable } from "../../shared/process-table.ts";
import { publishOnce, stateRoot } from "../receipts.ts";

/** What a launch starts: a re-arm of a stopped drive, or a takeover of a wedged one. */
export type LaunchAction = "rearm" | "takeover";

/** The runtime's answer to one `launch` call for the record. */
export interface LaunchAttempt {
  at: string;
  /** `sent`: the runtime answered that it started the session; `failed`: it answered that it did not; `lost`: no answer in time. */
  outcome: "sent" | "failed" | "lost";
  detail: string;
}

/** The tick's part of a record. */
export interface LaunchRecord {
  version: 1;
  id: string;
  token: string;
  action: LaunchAction;
  /** The repository's `owner/name` and its local checkout. */
  repo: string;
  repoPath: string;
  pr: number;
  account: string;
  vendor: "claude" | "codex";
  configDir: string;
  /** The machine file's `wall_backoff` when the record was written, for a wall with no known reset. */
  wallBackoffMs: number;
  /** For a takeover: the record whose driver it replaces, whose slot it takes. */
  replaces: string | null;
  /** The ledger facts the launch acted on: the same facts after a refusal are never launched again. */
  facts: string;
  createdAt: string;
  workspace: { id: string; path: string } | null;
  attempts: LaunchAttempt[];
}

/** The wrapper's process identity, as `drives.ts` captures a driver's. */
export interface ProcessIdentity {
  host: string;
  bootId: string;
  pid: number;
  /** The process's start time as the process table reports it. */
  start: string;
  claimedAt: string;
}

export interface LaunchExit {
  at: string;
  /** The stage's exit code; `null` when it ended on a signal. */
  code: number | null;
  signal: string | null;
}

export type LaunchState =
  | { kind: "pending" }
  | { kind: "alive"; process: ProcessIdentity }
  | { kind: "unknown"; reason: string; process: ProcessIdentity }
  | { kind: "died"; process: ProcessIdentity }
  | { kind: "ended"; exit: LaunchExit; process: ProcessIdentity | null };

export interface ReadRecord {
  record: LaunchRecord;
  state: LaunchState;
}

function launchesRoot(root = stateRoot()): string {
  return join(root, "launches");
}

const ID = /^\d{8}T\d{6}Z-[a-f\d]{8}$/;

export function newRecordId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

export function newToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function file(id: string, kind: "json" | "claim" | "exit", root: string) {
  return join(launchesRoot(root), `${id}.${kind}`);
}

/** Write `text` to `path` whole: a reader sees the old file or the new one. */
function writeWhole(path: string, text: string): void {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

/** Write (or rewrite) the tick's part of a record. */
export function writeRecord(record: LaunchRecord, root = stateRoot()): void {
  mkdirSync(launchesRoot(root), { recursive: true, mode: 0o700 });
  writeWhole(
    file(record.id, "json", root),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    swallow(error, `${path} does not read`);
    return null;
  }
}

function isLaunchRecord(value: unknown): value is LaunchRecord {
  return (
    isMapping(value) &&
    value.version === 1 &&
    typeof value.id === "string" &&
    typeof value.token === "string" &&
    (value.action === "rearm" || value.action === "takeover") &&
    typeof value.pr === "number" &&
    typeof value.account === "string" &&
    typeof value.repo === "string" &&
    typeof value.facts === "string" &&
    Array.isArray(value.attempts)
  );
}

function isIdentity(value: unknown): value is ProcessIdentity {
  return (
    isMapping(value) &&
    typeof value.host === "string" &&
    typeof value.bootId === "string" &&
    typeof value.pid === "number" &&
    typeof value.start === "string" &&
    typeof value.claimedAt === "string"
  );
}

function isExit(value: unknown): value is LaunchExit {
  return (
    isMapping(value) &&
    typeof value.at === "string" &&
    (value.code === null || typeof value.code === "number")
  );
}

export function readRecordFile(
  id: string,
  root = stateRoot(),
): LaunchRecord | null {
  const value = readJson(file(id, "json", root));
  return isLaunchRecord(value) ? value : null;
}

/** The claim a wrapper published for a record: `undefined` when none, `null` when it does not read. */
function readClaim(
  id: string,
  root = stateRoot(),
): ProcessIdentity | null | undefined {
  const value = readJson(file(id, "claim", root));
  if (value === undefined) return undefined;
  return isIdentity(value) ? value : null;
}

/** This boot's id: Linux's `boot_id`; elsewhere, empty (the start time still tells a reused pid apart). */
export function bootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch (error) {
    swallow(error, "no boot id on this platform");
    return "";
  }
}

/** This process's identity, from the process table; `null` when the table cannot be read. */
export async function ownIdentity(): Promise<ProcessIdentity | null> {
  const rows = await processTable();
  const row = rows?.find((r) => r.pid === process.pid);
  if (row === undefined || row.start === "") return null;
  return {
    host: hostname(),
    bootId: bootId(),
    pid: process.pid,
    start: row.start,
    claimedAt: new Date().toISOString(),
  };
}

/**
 * Claim a record for this wrapper: true when this call published the
 * claim, false when another wrapper had claimed it first.
 */
export function claimRecord(
  id: string,
  identity: ProcessIdentity,
  root = stateRoot(),
): boolean {
  mkdirSync(launchesRoot(root), { recursive: true, mode: 0o700 });
  return publishOnce(
    file(id, "claim", root),
    `${JSON.stringify(identity, null, 2)}\n`,
  );
}

/** Record the stage's exit; the first one written stands. */
export function recordExit(
  id: string,
  exit: LaunchExit,
  root = stateRoot(),
): void {
  publishOnce(file(id, "exit", root), `${JSON.stringify(exit, null, 2)}\n`);
}

/** Whether a claimed process is the one running now under its pid. */
function claimState(
  identity: ProcessIdentity,
  rows: ProcessRow[] | null,
  boot: string,
): LaunchState {
  if (identity.host !== hostname())
    return {
      kind: "unknown",
      reason: `claimed on host ${identity.host}, not this one`,
      process: identity,
    };
  if (identity.bootId !== boot)
    return {
      kind: "unknown",
      reason: "claimed before this host's last boot",
      process: identity,
    };
  if (rows === null)
    return {
      kind: "unknown",
      reason: "the process table cannot be read",
      process: identity,
    };
  const row = rows.find((r) => r.pid === identity.pid);
  const alive =
    row !== undefined && row.start === identity.start && !/^Z/.test(row.stat);
  return alive
    ? { kind: "alive", process: identity }
    : { kind: "died", process: identity };
}

/** One record's state, read from its files and `rows` (one process-table read per tick). */
function stateOf(
  record: LaunchRecord,
  rows: ProcessRow[] | null,
  root = stateRoot(),
  boot = bootId(),
): LaunchState {
  const exit = readJson(file(record.id, "exit", root));
  const claim = readClaim(record.id, root);
  if (isExit(exit))
    return {
      kind: "ended",
      exit: { ...exit, signal: exit.signal ?? null },
      process: claim ?? null,
    };
  if (claim === undefined) return { kind: "pending" };
  if (claim === null)
    return {
      kind: "unknown",
      reason: "its claim does not read",
      process: { host: "", bootId: "", pid: 0, start: "", claimedAt: "" },
    };
  return claimState(claim, rows, boot);
}

/** Every record with its state, oldest first; a file that does not read is left out and named. */
export async function readLaunches(root = stateRoot()): Promise<{
  records: ReadRecord[];
  unreadable: string[];
}> {
  let names: string[];
  try {
    names = readdirSync(launchesRoot(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { records: [], unreadable: [] };
    throw error;
  }
  const ids = names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .filter((id) => ID.test(id))
    .sort();
  const rows = ids.length === 0 ? [] : await processTable();
  const boot = bootId();
  const records: ReadRecord[] = [];
  const unreadable: string[] = [];
  for (const id of ids) {
    const record = readRecordFile(id, root);
    if (record === null) {
      unreadable.push(file(id, "json", root));
      continue;
    }
    records.push({ record, state: stateOf(record, rows, root, boot) });
  }
  return { records, unreadable };
}

/** `drive.ts`'s refusals of a second driver, which end a record without a wall. */
export const DRIVER_REFUSALS: ReadonlySet<number> = new Set([11, 13, 20]);

/** The states that hold their stage and their account's slot. */
export function holds(state: LaunchState): boolean {
  return (
    state.kind === "pending" ||
    state.kind === "alive" ||
    state.kind === "unknown"
  );
}

/** Remove an ended or died record's files once older than the retention. */
export function pruneLaunches(
  records: ReadRecord[],
  nowMs: number,
  days: number,
  root = stateRoot(),
): string[] {
  const cutoff = nowMs - days * 86_400_000;
  const removed: string[] = [];
  const kept = new Set<string>();
  // The latest record of a pull request that ended on a refusal of a second
  // driver is the stage's answer for as long as the ledger facts hold.
  const latest = new Map<number, ReadRecord>();
  for (const r of records) {
    const seen = latest.get(r.record.pr);
    if (seen === undefined || r.record.createdAt >= seen.record.createdAt)
      latest.set(r.record.pr, r);
  }
  for (const entry of latest.values()) {
    const { state } = entry;
    if (
      state.kind === "ended" &&
      state.exit.code !== null &&
      DRIVER_REFUSALS.has(state.exit.code)
    )
      kept.add(entry.record.id);
  }
  for (const { record, state } of records) {
    if (kept.has(record.id)) continue;
    if (state.kind !== "ended" && state.kind !== "died") continue;
    const at =
      state.kind === "ended"
        ? Date.parse(state.exit.at)
        : Date.parse(record.createdAt);
    if (!Number.isFinite(at) || at > cutoff) continue;
    for (const kind of ["json", "claim", "exit"] as const)
      rmSync(file(record.id, kind, root), { force: true });
    removed.push(record.id);
  }
  return removed;
}

/** Remove a record the runtime answered it started nothing for. */
export function removeRecord(id: string, root = stateRoot()): void {
  for (const kind of ["json", "claim", "exit"] as const)
    rmSync(file(id, kind, root), { force: true });
}
