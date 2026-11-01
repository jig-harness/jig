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
 * - `<id>.exit`, the wrapper's again: the stage's exit, once it ended;
 * - `<id>.result`, an interactive session's own answer (`done` or
 *   `failed`), written once by `jig dispatch result` under the record's
 *   token.
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
 * holds them until a person removes its files. An interactive session's
 * record is also read beside its agent (`actions/pickup-hold.ts`): while
 * its wrapper is alive, the record ends when the runtime reports the agent
 * finished.
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

/** What a launch starts: a re-arm of a stopped drive, a takeover of a wedged one, a pickup's `do-item` session, or a merge's follow-up session. */
export type LaunchAction = "rearm" | "takeover" | "pickup" | "followup";

/** Whether a record starts a drive's headless pass, whose exit is its answer. */
export function isDrive(record: Pick<LaunchRecord, "action">): boolean {
  return record.action === "rearm" || record.action === "takeover";
}

/** Whether a record starts an interactive session (a pickup's, a follow-up's), whose agent ends it. */
export function isInteractive(record: Pick<LaunchRecord, "action">): boolean {
  return !isDrive(record);
}

/** An interactive session's own answer, recorded through `jig dispatch result`. */
export type SessionResult = "done" | "failed";

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
  /** The pull request a drive or a follow-up acts on; `null` for a pickup. */
  pr: number | null;
  /** The item a pickup starts; `null` for a drive or a follow-up. */
  item: string | null;
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
  /** An interactive session's agent, by the id the runtime reports it under, from the launch's receipt. */
  agentId: string | null;
  /** The model and effort a pickup was launched with; `null` when the route named none. */
  model: string | null;
  effort: string | null;
  /** A pickup's ended record no longer holds its item: the item left the dispatch states since. */
  released: boolean;
  /** The command a follow-up's session starts (the repository's `dispatch.followup_command`); `null` for any other record. */
  command: string | null;
  /** The id of the follow-up marker comment the tick posted for it; `null` until posted, and for any other record. */
  marker: number | null;
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
  /** Set when the stage ended on the account's wall and the wrapper could not record that wall. */
  wallUnrecorded?: true;
}

export type LaunchState =
  | { kind: "pending" }
  | { kind: "alive"; process: ProcessIdentity }
  | {
      kind: "unknown";
      reason: string;
      process: ProcessIdentity;
      /** It ended on its account's wall, which was never written: the whole account stays closed. */
      wallUnrecorded?: true;
    }
  | { kind: "died"; process: ProcessIdentity }
  | {
      kind: "ended";
      exit: LaunchExit;
      process: ProcessIdentity | null;
      /** An interactive session whose wrapper still runs: the state its agent finished in. */
      agent?: string;
    };

export interface ReadRecord {
  record: LaunchRecord;
  state: LaunchState;
  /** An interactive session's recorded answer; `null` when none. */
  result: SessionResult | null;
}

function launchesRoot(root = stateRoot()): string {
  return join(root, "launches");
}

const ID = /^\d{8}T\d{6}Z-[a-f\d]{8}$/;

/** Whether `id` has a launch record id's shape, and so names no other path. */
export function isRecordId(id: string): boolean {
  return ID.test(id);
}

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

type RecordFile = "json" | "claim" | "exit" | "result";
const RECORD_FILES: readonly RecordFile[] = ["json", "claim", "exit", "result"];

function file(id: string, kind: RecordFile, root: string) {
  return join(launchesRoot(root), `${id}.${kind}`);
}

/** Write `text` to `path` whole: a reader sees the old file or the new one. */
export function writeWhole(path: string, text: string): void {
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

function isWorkspace(value: unknown): boolean {
  return (
    value === null ||
    (isMapping(value) &&
      typeof value.id === "string" &&
      typeof value.path === "string")
  );
}

function hasStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((k) => typeof value[k] === "string");
}

function optionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/** What a record names: a pull request for a drive or a follow-up, an item for a pickup. */
function namesTarget(value: Record<string, unknown>): boolean {
  if (value.action === "pickup")
    return typeof value.item === "string" && value.item !== "";
  return (
    (value.action === "rearm" ||
      value.action === "takeover" ||
      value.action === "followup") &&
    typeof value.pr === "number"
  );
}

function isLaunchRecord(value: unknown): value is LaunchRecord {
  return (
    isMapping(value) &&
    value.version === 1 &&
    hasStrings(value, [
      "id",
      "token",
      "account",
      "repo",
      "repoPath",
      "configDir",
      "facts",
      "createdAt",
    ]) &&
    namesTarget(value) &&
    (value.vendor === "claude" || value.vendor === "codex") &&
    typeof value.wallBackoffMs === "number" &&
    (value.replaces === null || typeof value.replaces === "string") &&
    Number.isFinite(Date.parse(value.createdAt as string)) &&
    isWorkspace(value.workspace) &&
    Array.isArray(value.attempts) &&
    value.attempts.every(isAttempt) &&
    optionalFields(value)
  );
}

/** The fields a later version added, each absent or of its type. */
function optionalFields(value: Record<string, unknown>): boolean {
  return (
    ["agentId", "model", "effort", "command"].every((k) =>
      optionalText(value[k]),
    ) &&
    (value.marker === undefined ||
      value.marker === null ||
      typeof value.marker === "number")
  );
}

/** A record as this version reads it: the fields an earlier version did not write, at their defaults. */
function normalized(value: LaunchRecord): LaunchRecord {
  const pickup = value.action === "pickup";
  return {
    ...value,
    pr: pickup ? null : value.pr,
    item: pickup ? value.item : null,
    agentId: value.agentId ?? null,
    model: value.model ?? null,
    effort: value.effort ?? null,
    released: value.released === true,
    ...followupFields(value),
  };
}

/** A follow-up's command and marker; `null` for any other record. */
function followupFields(
  value: LaunchRecord,
): Pick<LaunchRecord, "command" | "marker"> {
  if (value.action !== "followup") return { command: null, marker: null };
  return { command: value.command ?? null, marker: value.marker ?? null };
}

/** What a record acts on, as the plan names it: the item, else `PR #<n>`. */
export function targetOf(record: Pick<LaunchRecord, "item" | "pr">): string {
  return record.item ?? `PR #${String(record.pr)}`;
}

function isAttempt(value: unknown): value is LaunchAttempt {
  return (
    isMapping(value) &&
    typeof value.at === "string" &&
    (value.outcome === "sent" ||
      value.outcome === "failed" ||
      value.outcome === "lost") &&
    typeof value.detail === "string"
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
  // A record whose embedded id names another file would read that file's claim and exit.
  return isLaunchRecord(value) && value.id === id ? normalized(value) : null;
}

/**
 * Record an interactive session's answer: true when this call wrote it,
 * false when the record already had one, which stands.
 */
export function recordResult(
  id: string,
  result: SessionResult,
  root = stateRoot(),
): boolean {
  mkdirSync(launchesRoot(root), { recursive: true, mode: 0o700 });
  return publishOnce(
    file(id, "result", root),
    `${JSON.stringify({ at: new Date().toISOString(), result }, null, 2)}\n`,
  );
}

/** A record's recorded answer; `null` when none, or when it does not read. */
export function readResult(
  id: string,
  root = stateRoot(),
): SessionResult | null {
  const value = readJson(file(id, "result", root));
  if (!isMapping(value)) return null;
  return value.result === "done" || value.result === "failed"
    ? value.result
    : null;
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

/** The ids among `ids` whose exit says the account's wall could not be recorded. */
export function unrecordedWalls(ids: string[], root = stateRoot()): string[] {
  return ids.filter((id) => {
    const exit = readJson(file(id, "exit", root));
    return isExit(exit) && exit.wallUnrecorded === true;
  });
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
  if (isExit(exit) && exit.wallUnrecorded === true)
    // The wall was never written: the account stays held until a person removes the files.
    return {
      kind: "unknown",
      reason: "it ended on its account's wall, which could not be recorded",
      wallUnrecorded: true,
      process: claim ?? {
        host: "",
        bootId: "",
        pid: 0,
        start: "",
        claimedAt: "",
      },
    };
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
    records.push({
      record,
      state: stateOf(record, rows, root, boot),
      result: readResult(id, root),
    });
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

/**
 * The ids of each pull request's latest record when it ended on a refusal of
 * a second driver: the stage's answer for as long as the ledger facts hold.
 */
function latestRefusals(records: ReadRecord[]): Set<string> {
  // Pull request numbers repeat across repositories: key by both.
  const latest = new Map<string, ReadRecord>();
  for (const r of records) {
    if (!isDrive(r.record)) continue;
    const key = `${r.record.repo}#${String(r.record.pr)}`;
    const seen = latest.get(key);
    if (seen === undefined || r.record.createdAt >= seen.record.createdAt)
      latest.set(key, r);
  }
  const ids = new Set<string>();
  for (const { record, state } of latest.values())
    if (
      state.kind === "ended" &&
      state.exit.code !== null &&
      DRIVER_REFUSALS.has(state.exit.code)
    )
      ids.add(record.id);
  return ids;
}

/**
 * The ids of each item's latest pickup record: while it is unreleased it is
 * the only thing that keeps the item from being picked up again, so it stays
 * until `releaseEnded` has seen the item leave the dispatch states.
 */
function latestPickups(records: ReadRecord[]): Set<string> {
  const latest = new Map<string, ReadRecord>();
  for (const r of records) {
    if (r.record.action !== "pickup") continue;
    const key = `${r.record.repo}\0${String(r.record.item)}`;
    const seen = latest.get(key);
    if (seen === undefined || r.record.createdAt >= seen.record.createdAt)
      latest.set(key, r);
  }
  const ids = new Set<string>();
  for (const { record } of latest.values())
    if (!record.released) ids.add(record.id);
  return ids;
}

/** When an ended or died record finished; `null` for one still holding its stage. */
function finishedAt(record: LaunchRecord, state: LaunchState): number | null {
  if (state.kind === "ended") return Date.parse(state.exit.at);
  return state.kind === "died" ? Date.parse(record.createdAt) : null;
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
  const kept = latestRefusals(records);
  for (const id of latestPickups(records)) kept.add(id);
  for (const { record, state } of records) {
    const at = kept.has(record.id) ? null : finishedAt(record, state);
    if (at === null || !Number.isFinite(at) || at > cutoff) continue;
    for (const kind of RECORD_FILES)
      rmSync(file(record.id, kind, root), { force: true });
    removed.push(record.id);
  }
  return removed;
}

/** Remove a record the runtime answered it started nothing for. */
export function removeRecord(id: string, root = stateRoot()): void {
  for (const kind of RECORD_FILES)
    rmSync(file(id, kind, root), { force: true });
}
