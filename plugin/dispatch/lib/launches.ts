/**
 * Launch records, in the state database's `launches` table (`state.ts`):
 * one per session the dispatcher started, written by the tick before it
 * calls the runtime's `launch`, so a launch whose answer is lost still holds
 * its stage and its account's slot.
 *
 * A record is one row, whose columns each have one writer, so no write
 * ever overwrites another's:
 *
 * - `record`, the tick's: the action, the pull request, the account, the
 *   random token, the workspace and the runtime's answer to each launch;
 * - `claim`, the wrapper's (`run.ts`): the process identity it ran under
 *   (host, boot id, process id and the process's start time), set by an
 *   update that only fills an empty column, so exactly one wrapper ever
 *   claims a record;
 * - `exit`, the wrapper's again: the stage's exit, once it ended; the first
 *   one written stands;
 * - `result`, an interactive session's own answer (`done` or `failed`),
 *   written once by `jig dispatch result` under the record's token.
 *
 * A record's state is read from those columns and the process table:
 *
 * | Columns | State |
 * | --- | --- |
 * | an exit | ended, with the stage's exit |
 * | a claim whose process is alive under the same identity | alive |
 * | a claim from another host or boot, or an unreadable process table | unknown |
 * | a claim whose process is gone, and no exit | died |
 * | no claim | pending |
 *
 * Pending, alive and unknown records hold their stage and their account's
 * slot; an unknown or a pending record whose launch cannot be retried
 * holds them until a person clears it (`jig dispatch clear`). An
 * interactive session's record is also read beside its agent
 * (`actions/pickup-hold.ts`): while its wrapper is alive, the record ends
 * when the runtime reports the agent finished.
 *
 * What Control adds while the record runs and when it ends: a drive's
 * unresolved-thread count per ledger round (`samples`, the
 * `thread_samples` table), an interactive session's vendor session id
 * (`sessionId`) and the usage-limit walls it waited on (`episodes`, the
 * `waiting_episodes` table), and, once it ended, the time its outcome row
 * carries (`endedAt`), written in the same transaction as that row.
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { type ProcessRow, processTable } from "../../shared/process-table.ts";
import { stateRoot } from "../receipts.ts";
import { existingStateDb, inTransaction, stateDb, statePath } from "./state.ts";
import type { StaleCause } from "./types.ts";

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
  /** A drive's ledger round when it was launched, which its outcome row's rounds count from; `null` when unknown. */
  round?: number | null;
  /** For a re-arm of a stale converged drive: why it was stale, for its outcome row, and the change it re-drove, which is never re-driven twice; `null` for any other record. */
  redrive?: StaleCause | null;
  /** The vendor session id the tick minted for an interactive session and passed to its agent; `null` when none was. */
  sessionId?: string | null;
  /** A drive's unresolved-thread count at each ledger round, recorded the first tick that sees the round (the `thread_samples` table). */
  samples?: ThreadSample[];
  /** When a tick first saw a pickup's workspace hold a pull request; its expectation of opening one is met for good. */
  openedAt?: string;
  /** The usage-limit walls an interactive session was seen waiting on, oldest first (the `waiting_episodes` table). */
  episodes?: WaitingEpisode[];
  /** When the record ended, as its outcome row is timed; written in the same transaction as that row, so a record with it has its row. */
  endedAt?: string;
}

/** A drive's unresolved review threads at one ledger round. */
export interface ThreadSample {
  round: number;
  threads: number;
  at: string;
}

/**
 * A usage-limit wall an interactive session met, read from the session's
 * own record by the drive's quota adapters: its observation time is the
 * episode's key, so a later wall is a new episode.
 */
export interface WaitingEpisode {
  observedAt: string;
  /** When the wall lifts; `null` when the adapter could not resolve it. */
  resetAt: string | null;
  /** The vendor's own words, trimmed to one line. */
  evidence: string;
  /** Whether the session's last record was still the wall at the latest read. */
  last: boolean;
  /** When the tick last read it. */
  readAt: string;
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

const ID = /^\d{8}T\d{6}Z-[a-f\d]{8}$/;

/** Whether `id` has a launch record id's shape. */
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

/**
 * Write (or rewrite) the tick's part of a record. The samples and episodes
 * live in their own tables, written where they are observed.
 */
export function writeRecord(record: LaunchRecord, root = stateRoot()): void {
  const { samples: _samples, episodes: _episodes, ...tick } = record;
  stateDb(root)
    .query(
      `INSERT INTO launches (id, repo, action, pr, item, created_at, record)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET record = excluded.record`,
    )
    .run(
      record.id,
      record.repo,
      record.action,
      record.pr,
      record.item,
      record.createdAt,
      JSON.stringify(tick),
    );
}

/** A column's JSON, `undefined` when the column is empty, `null` when it does not parse. */
function parseJson(text: string | null, what: string): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    swallow(error, `${what} does not read`);
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

/** Whether a value is absent or a time. */
function optionalTime(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)))
  );
}

/** The fields a later version added, each absent or of its type. */
function optionalFields(value: Record<string, unknown>): boolean {
  return (
    ["agentId", "model", "effort", "command", "sessionId"].every((k) =>
      optionalText(value[k]),
    ) &&
    [value.marker, value.round].every(
      (v) => v === undefined || v === null || typeof v === "number",
    ) &&
    optionalTime(value.endedAt) &&
    optionalTime(value.openedAt) &&
    isRedrive(value.redrive)
  );
}

/** Whether a value is absent, `null`, or a stale cause. */
function isRedrive(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (isMapping(value) &&
      typeof value.cause === "string" &&
      typeof value.change === "string")
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
    redrive: value.redrive ?? null,
    ...followupFields(value),
    ...controlFields(value),
  };
}

/** What Control keeps on a record, at its defaults where it was never written. */
function controlFields(
  value: LaunchRecord,
): Pick<LaunchRecord, "round" | "sessionId"> {
  return {
    round: value.round ?? null,
    sessionId: value.sessionId ?? null,
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

/** One record's row as the table holds it. */
interface LaunchRow {
  id: string;
  record: string;
  claim: string | null;
  exit: string | null;
  result: string | null;
}

/** The tick's part of a row, with its samples and episodes; `null` when it does not read as a record. */
function recordOf(
  row: LaunchRow,
  root: string,
  control?: Map<string, ControlRows>,
): LaunchRecord | null {
  const value = parseJson(row.record, `launch record ${row.id}`);
  // A record whose embedded id names another row would read that row's claim and exit.
  if (!isLaunchRecord(value) || value.id !== row.id) return null;
  return {
    ...normalized(value),
    ...(control?.get(row.id) ?? controlRows(root, row.id).get(row.id) ?? EMPTY),
  };
}

interface EpisodeRow {
  launch: string;
  observed_at: string;
  reset_at: string | null;
  evidence: string;
  last: number;
  read_at: string;
}

type ControlRows = Pick<LaunchRecord, "samples" | "episodes">;

const EMPTY: ControlRows = { samples: [], episodes: [] };

/** The thread samples and waiting episodes of one launch, or of every launch, in the order they were first written. */
function controlRows(root: string, id?: string): Map<string, ControlRows> {
  const db = stateDb(root);
  const where = id === undefined ? "" : "WHERE launch = ?";
  const args = id === undefined ? [] : [id];
  const out = new Map<string, ControlRows>();
  const of = (launch: string) => {
    let rows = out.get(launch);
    if (rows === undefined) {
      rows = { samples: [], episodes: [] };
      out.set(launch, rows);
    }
    return rows;
  };
  const samples = db
    .query(
      `SELECT launch, round, threads, at FROM thread_samples ${where} ORDER BY rowid`,
    )
    .all(...args) as Array<ThreadSample & { launch: string }>;
  for (const { launch, round, threads, at } of samples)
    (of(launch).samples as ThreadSample[]).push({ round, threads, at });
  const episodes = db
    .query(
      `SELECT launch, observed_at, reset_at, evidence, last, read_at
       FROM waiting_episodes ${where} ORDER BY rowid`,
    )
    .all(...args) as EpisodeRow[];
  for (const e of episodes)
    (of(e.launch).episodes as WaitingEpisode[]).push({
      observedAt: e.observed_at,
      resetAt: e.reset_at,
      evidence: e.evidence,
      last: e.last === 1,
      readAt: e.read_at,
    });
  return out;
}

function launchRow(id: string, root: string): LaunchRow | null {
  return stateDb(root)
    .query("SELECT id, record, claim, exit, result FROM launches WHERE id = ?")
    .get(id) as LaunchRow | null;
}

/** A record by its id; `null` when there is none, or it does not read. */
export function readRecord(
  id: string,
  root = stateRoot(),
): LaunchRecord | null {
  const row = launchRow(id, root);
  return row === null ? null : recordOf(row, root);
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
  const done = stateDb(root)
    .query(
      "UPDATE launches SET result = ?, result_at = ? WHERE id = ? AND result IS NULL",
    )
    .run(result, new Date().toISOString(), id);
  return done.changes === 1;
}

function asResult(value: string | null): SessionResult | null {
  return value === "done" || value === "failed" ? value : null;
}

/** A record's recorded answer; `null` when none. */
export function readResult(
  id: string,
  root = stateRoot(),
): SessionResult | null {
  return asResult(launchRow(id, root)?.result ?? null);
}

/** A row's claim: `undefined` when none, `null` when it does not read. */
function claimOf(row: LaunchRow): ProcessIdentity | null | undefined {
  const value = parseJson(row.claim, `the claim of launch record ${row.id}`);
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
 * Claim a record for this wrapper: true when this call wrote the claim,
 * false when another wrapper had claimed it first or the record is gone.
 */
export function claimRecord(
  id: string,
  identity: ProcessIdentity,
  root = stateRoot(),
): boolean {
  const done = stateDb(root)
    .query("UPDATE launches SET claim = ? WHERE id = ? AND claim IS NULL")
    .run(JSON.stringify(identity), id);
  return done.changes === 1;
}

/** Record the stage's exit; the first one written stands. */
export function recordExit(
  id: string,
  exit: LaunchExit,
  root = stateRoot(),
): void {
  stateDb(root)
    .query("UPDATE launches SET exit = ? WHERE id = ? AND exit IS NULL")
    .run(JSON.stringify(exit), id);
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

/** A row's exit, when it has one that reads. */
function exitOf(row: Pick<LaunchRow, "id" | "exit">): LaunchExit | null {
  const exit = parseJson(row.exit, `the exit of launch record ${row.id}`);
  return isExit(exit) ? exit : null;
}

/** The ids among `ids` whose exit says the account's wall could not be recorded. */
export function unrecordedWalls(ids: string[], root = stateRoot()): string[] {
  const db = existingStateDb(root);
  if (db === null || ids.length === 0) return [];
  const found: string[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db
      .query(
        `SELECT id, exit FROM launches WHERE exit IS NOT NULL AND id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk) as Array<Pick<LaunchRow, "id" | "exit">>;
    for (const r of rows)
      if (exitOf(r)?.wallUnrecorded === true) found.push(r.id);
  }
  return found;
}

const NO_PROCESS: ProcessIdentity = {
  host: "",
  bootId: "",
  pid: 0,
  start: "",
  claimedAt: "",
};

/** One record's state, read from its row and `rows` (one process-table read per tick). */
function stateOf(
  row: LaunchRow,
  rows: ProcessRow[] | null,
  boot = bootId(),
): LaunchState {
  const exit = exitOf(row);
  const claim = claimOf(row);
  if (exit?.wallUnrecorded === true)
    // The wall was never written: the account stays held until a person clears the record.
    return {
      kind: "unknown",
      reason: "it ended on its account's wall, which could not be recorded",
      wallUnrecorded: true,
      process: claim ?? NO_PROCESS,
    };
  if (exit !== null)
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
      process: NO_PROCESS,
    };
  return claimState(claim, rows, boot);
}

/** Every record with its state, oldest first; a row that does not read is left out and named. */
export async function readLaunches(root = stateRoot()): Promise<{
  records: ReadRecord[];
  unreadable: string[];
}> {
  const all = stateDb(root)
    .query("SELECT id, record, claim, exit, result FROM launches ORDER BY id")
    .all() as LaunchRow[];
  const rows = all.length === 0 ? [] : await processTable();
  const boot = bootId();
  const control = controlRows(root);
  const records: ReadRecord[] = [];
  const unreadable: string[] = [];
  for (const row of all) {
    const record = recordOf(row, root, control);
    if (record === null) {
      unreadable.push(`launch record ${row.id} in ${statePath(root)}`);
      continue;
    }
    records.push({
      record,
      state: stateOf(row, rows, boot),
      result: asResult(row.result),
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
 * The ids of each change's latest re-drive record: a change is never
 * re-driven twice, and the record is the only evidence of that, so every
 * change a pull request has been re-driven for keeps one.
 */
function latestRedrives(records: ReadRecord[]): Set<string> {
  const latest = new Map<string, ReadRecord>();
  for (const r of records) {
    if (!isDrive(r.record) || !r.record.redrive) continue;
    const key = `${r.record.repo}#${String(r.record.pr)}\0${r.record.redrive.change}`;
    const seen = latest.get(key);
    if (seen === undefined || r.record.createdAt >= seen.record.createdAt)
      latest.set(key, r);
  }
  return new Set([...latest.values()].map((r) => r.record.id));
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

/** Remove the rows of ended or died records older than the retention, in one transaction. */
export function pruneLaunches(
  records: ReadRecord[],
  nowMs: number,
  days: number,
  root = stateRoot(),
): string[] {
  const cutoff = nowMs - days * 86_400_000;
  const kept = latestRefusals(records);
  for (const id of latestPickups(records)) kept.add(id);
  for (const id of latestRedrives(records)) kept.add(id);
  const removed = records
    .filter(({ record, state }) => {
      const at = kept.has(record.id) ? null : finishedAt(record, state);
      return at !== null && Number.isFinite(at) && at <= cutoff;
    })
    .map(({ record }) => record.id);
  if (removed.length === 0) return removed;
  const db = stateDb(root);
  const remove = db.query("DELETE FROM launches WHERE id = ?");
  const removeNudges = db.query("DELETE FROM nudges WHERE record = ?");
  inTransaction(db, () => {
    for (const id of removed) {
      remove.run(id);
      removeNudges.run(id);
    }
  });
  return removed;
}

/** Remove a record: one the runtime answered it started nothing for, or one a person cleared. */
export function removeRecord(id: string, root = stateRoot()): void {
  stateDb(root).query("DELETE FROM launches WHERE id = ?").run(id);
}

/** A row as `inspectRow` read it: what a conditional removal compares against. */
export interface InspectedRow {
  /** The record, or `null` when it does not read. */
  record: LaunchRecord | null;
  /** The state the claim and exit say, which holds whether or not the record reads. */
  state: LaunchState;
  claim: string | null;
  exit: string | null;
}

/** One row's record and state, whether or not its record reads; `null` when there is no such row. */
export async function inspectRow(
  id: string,
  root = stateRoot(),
): Promise<InspectedRow | null> {
  const row = launchRow(id, root);
  if (row === null) return null;
  const rows = await processTable();
  return {
    record: recordOf(row, root),
    state: stateOf(row, rows),
    claim: row.claim,
    exit: row.exit,
  };
}

/**
 * Remove a row only while its claim and exit are still what `seen` read:
 * a wrapper that claimed it, or an exit written, since leaves it in place.
 * Returns whether the row was removed.
 */
export function removeRecordIf(
  id: string,
  seen: Pick<InspectedRow, "claim" | "exit">,
  root = stateRoot(),
): boolean {
  const db = stateDb(root);
  return inTransaction(db, () => {
    const result = db
      .query("DELETE FROM launches WHERE id = ? AND claim IS ? AND exit IS ?")
      .run(id, seen.claim, seen.exit);
    if (result.changes === 0) return false;
    db.query("DELETE FROM nudges WHERE record = ?").run(id);
    return true;
  });
}
