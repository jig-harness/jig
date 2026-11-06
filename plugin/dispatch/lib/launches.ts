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
 *   random token, the workspace, the dispatched mark its workspace carries
 *   and the runtime's answer to each launch;
 * - `claim`, the wrapper's (`run.ts`): the process identity it ran under
 *   (`shared/liveness.ts`: host id and name, boot id, process id and the
 *   process's start time), set by an update that only fills an empty column,
 *   so exactly one wrapper ever claims a record;
 * - `exit`, the wrapper's again: the stage's exit, once it ended; the first
 *   one written stands;
 * - `result`, a pickup's session's or a follow-up pass's own answer
 *   (`done` or `failed`), written once by `jig dispatch result` under the
 *   record's token.
 *
 * A record's state is read from those columns and the process table, the
 * claim judged by the shared rules (`shared/liveness.ts`):
 *
 * | Columns | State |
 * | --- | --- |
 * | an exit | ended, with the stage's exit |
 * | a claim whose process is alive under the same identity | alive |
 * | a claim from another host, or an unreadable process table | unknown |
 * | a claim whose process is gone, or from before this host last restarted, and no exit | died, with why |
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
import type { Database } from "bun:sqlite";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import {
  decodeIdentity,
  type HostIdentity,
  judge,
  type ProcessIdentity,
  thisHost,
} from "../../shared/liveness.ts";
import { type ProcessRow, processTable } from "../../shared/process-table.ts";
import { LAUNCH_RECORD_ID } from "../../shared/records/launch-claims.ts";
import { DRIVER_REFUSAL_EXITS } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { stateRoot } from "../receipts.ts";
import { existingStateDb, inTransaction, stateDb, statePath } from "./state.ts";
import type { StaleCause } from "./types.ts";

/** What a launch starts: a re-arm of a stopped drive, a takeover of a wedged one, a pickup's `do-item` session, or a merge's follow-up pass. */
export type LaunchAction = "rearm" | "takeover" | "pickup" | "followup";

/** Whether a record starts a drive's headless pass, whose exit is its answer. */
export function isDrive(record: Pick<LaunchRecord, "action">): boolean {
  return record.action === "rearm" || record.action === "takeover";
}

/** Whether a record starts an interactive session (a pickup's), whose agent ends it. A follow-up is a headless pass, which its exit ends. */
export function isInteractive(record: Pick<LaunchRecord, "action">): boolean {
  return record.action === "pickup";
}

/** A pickup's session's or a follow-up pass's own answer, recorded through `jig dispatch result`. */
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
  /** For a drive or a follow-up pass: the pass deadline, in seconds (`0` for none), it was admitted under and runs under (`drive.ts --pass-timeout`, or the wrapper's own deadline on a follow-up pass); absent on a record written before it was kept. */
  passTimeoutSec?: number | null;
  /** For a drive or a follow-up pass: whether the tick admitted it on a host opted in to Codex's bypass. A Codex pass carries the bypass only when this is `true`; the wrapper does not read the setting itself, since it can read another user layer from the tick's. */
  codexBypass?: boolean;
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
  /** The command a follow-up pass runs (the repository's `dispatch.followup_command`); `null` for any other record. */
  command: string | null;
  /** The id of the follow-up marker comment the tick posted for it; `null` until posted, and for any other record. */
  marker: number | null;
  /** A drive's ledger round when it was launched, which its outcome row's rounds count from; `null` when unknown. */
  round?: number | null;
  /** For a re-drive: why it was launched, for its outcome row, and the change it re-drove, which is never re-driven twice; `null` for any other record. */
  redrive?: StaleCause | null;
  /** The vendor session id the tick minted for a Claude Code session or follow-up pass and passed to its agent; `null` when none was. */
  sessionId?: string | null;
  /**
   * The dispatched mark the launch's workspace was named and marked with
   * (`dispatchedMark` in `runtime/port.ts`): the stage, the key and this
   * record's id. It joins a workspace a skill renamed to its launch.
   * `null` on a record written before the mark was kept.
   */
  mark?: string | null;
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

/** The wrapper's process identity (`shared/liveness.ts`), and when it claimed the record. */
export interface LaunchClaim extends ProcessIdentity {
  claimedAt: string;
}

export interface LaunchExit {
  at: string;
  /** The stage's exit code; `null` when it ended on a signal. */
  code: number | null;
  signal: string | null;
  /** Set when the stage ended on the account's wall and the wrapper could not record that wall. */
  wallUnrecorded?: true;
  /** For a follow-up pass that ended without recording done: the last `Question:` line of its output, the question it stopped on. */
  said?: string;
}

export type LaunchState =
  | { kind: "pending" }
  | { kind: "alive"; process: LaunchClaim }
  | {
      kind: "unknown";
      reason: string;
      process: LaunchClaim;
      /** It ended on its account's wall, which was never written: the whole account stays closed. */
      wallUnrecorded?: true;
    }
  | { kind: "died"; reason: string; process: LaunchClaim }
  | {
      kind: "ended";
      exit: LaunchExit;
      process: LaunchClaim | null;
      /** An interactive session whose wrapper still runs: the state its agent finished in. */
      agent?: string;
    };

export interface ReadRecord {
  record: LaunchRecord;
  state: LaunchState;
  /** A pickup's session's or a follow-up pass's recorded answer; `null` when none. */
  result: SessionResult | null;
}

/** A launch record id: the time it was made, and a random suffix. */
const ID = LAUNCH_RECORD_ID;

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

/** Whether a value is absent, `null`, or a whole number of seconds. */
function optionalSeconds(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The fields a later version added, each absent or of its type. */
function optionalFields(value: Record<string, unknown>): boolean {
  return (
    ["agentId", "model", "effort", "command", "sessionId", "mark"].every((k) =>
      optionalText(value[k]),
    ) &&
    [value.marker, value.round].every(
      (v) => v === undefined || v === null || typeof v === "number",
    ) &&
    optionalSeconds(value.passTimeoutSec) &&
    (value.codexBypass === undefined ||
      typeof value.codexBypass === "boolean") &&
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
      typeof value.change === "string" &&
      (value.earlier === undefined ||
        (Array.isArray(value.earlier) &&
          value.earlier.every((c) => typeof c === "string"))))
  );
}

/** Every change a re-drive record counts as acted on: the one it names now and the ones a replay moved on from. */
export function redrivenChanges(redrive: StaleCause): string[] {
  return [redrive.change, ...(redrive.earlier ?? [])];
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
): Pick<LaunchRecord, "round" | "sessionId" | "mark"> {
  return {
    round: value.round ?? null,
    sessionId: value.sessionId ?? null,
    mark: value.mark ?? null,
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

/** A claim as written, one from before host ids included; `null` when it is not one. */
function asClaim(value: unknown): LaunchClaim | null {
  const identity = decodeIdentity(value);
  return identity === null ||
    !isMapping(value) ||
    typeof value.claimedAt !== "string"
    ? null
    : { ...identity, claimedAt: value.claimedAt };
}

function isExit(value: unknown): value is LaunchExit {
  return (
    isMapping(value) &&
    typeof value.at === "string" &&
    (value.code === null || typeof value.code === "number")
  );
}

/** One record's row as the table holds it. */
export interface LaunchRow {
  id: string;
  record: string;
  claim: string | null;
  exit: string | null;
  result: string | null;
}

/** The tick's part of a row, with its samples and episodes; `null` when it does not read as a record. */
export function recordOf(
  row: LaunchRow,
  root: string,
  control?: Map<string, ControlRows>,
): LaunchRecord | null {
  const value = parseJson(row.record, `launch record ${row.id}`);
  // A record whose embedded id names another row would read that row's claim and exit.
  if (!isLaunchRecord(value) || value.id !== row.id) return null;
  // A supplied map is authoritative: a launch it lacks has no samples or episodes.
  const rows =
    control === undefined
      ? controlRows(root, row.id).get(row.id)
      : control.get(row.id);
  return { ...normalized(value), ...(rows ?? EMPTY) };
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
function controlRows(
  root: string,
  id?: string,
  db: Database = stateDb(root),
): Map<string, ControlRows> {
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
 * A record whose stage's exit is written, with its state and its answer as a
 * tick reads them; `null` when there is none, it does not read, or no exit is
 * written yet.
 */
export function readEnded(id: string, root = stateRoot()): ReadRecord | null {
  const row = launchRow(id, root);
  const record = row === null ? null : recordOf(row, root);
  if (row === null || record === null || exitOf(row) === null) return null;
  return {
    record,
    state: stateOf(row, null, thisHost()),
    result: asResult(row.result),
  };
}

/**
 * Record a session's or a follow-up pass's answer: true when this call wrote it,
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
export function claimOf(row: LaunchRow): LaunchClaim | null | undefined {
  const value = parseJson(row.claim, `the claim of launch record ${row.id}`);
  if (value === undefined) return undefined;
  return asClaim(value);
}

/**
 * Claim a record for this wrapper: true when this call wrote the claim,
 * false when another wrapper had claimed it first or the record is gone.
 */
export function claimRecord(
  id: string,
  identity: LaunchClaim,
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

/** Whether a claimed process is the one running now under its pid, by the shared rules. */
function claimState(
  claim: LaunchClaim,
  rows: ProcessRow[] | null,
  here: HostIdentity,
): LaunchState {
  const verdict = judge(claim, rows, here);
  if (!verdict.ok)
    return { kind: "unknown", reason: verdict.failure.reason, process: claim };
  return verdict.value.state === "alive"
    ? { kind: "alive", process: claim }
    : { kind: "died", reason: verdict.value.reason, process: claim };
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

const NO_PROCESS: LaunchClaim = {
  hostId: "",
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
  here: HostIdentity,
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
  return claimState(claim, rows, here);
}

/**
 * Every record with its state as judged from `here`, oldest first; a row
 * that does not read is left out and named. A reader that must not migrate
 * the database passes its own read-only connection as `db`.
 */
export async function readLaunches(
  root = stateRoot(),
  here: HostIdentity = thisHost(),
  db: Database = stateDb(root),
): Promise<{
  records: ReadRecord[];
  unreadable: string[];
}> {
  const all = db
    .query("SELECT id, record, claim, exit, result FROM launches ORDER BY id")
    .all() as LaunchRow[];
  const rows = all.length === 0 ? [] : await processTable();
  const control = controlRows(root, undefined, db);
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
      state: stateOf(row, rows, here),
      result: asResult(row.result),
    });
  }
  return { records, unreadable };
}

/** The states that hold their stage and their account's slot. */
export function holds(state: LaunchState): boolean {
  return (
    state.kind === "pending" ||
    state.kind === "alive" ||
    state.kind === "unknown"
  );
}

/** The newest record per key among those `keep` accepts. */
function latestBy(
  records: ReadRecord[],
  keep: (record: LaunchRecord) => boolean,
  keyOf: (record: LaunchRecord) => string,
): Map<string, ReadRecord> {
  const latest = new Map<string, ReadRecord>();
  for (const r of records) {
    if (!keep(r.record)) continue;
    const key = keyOf(r.record);
    const seen = latest.get(key);
    if (seen === undefined || r.record.createdAt >= seen.record.createdAt)
      latest.set(key, r);
  }
  return latest;
}

/**
 * The ids of each pull request's latest record when it ended on a refusal of
 * a second driver: the stage's answer for as long as the ledger facts hold.
 */
function latestRefusals(records: ReadRecord[]): Set<string> {
  // Pull request numbers repeat across repositories: key by both.
  const latest = latestBy(
    records,
    (r) => isDrive(r),
    (r) => `${r.repo}#${String(r.pr)}`,
  );
  const ids = new Set<string>();
  for (const { record, state } of latest.values())
    if (
      state.kind === "ended" &&
      state.exit.code !== null &&
      DRIVER_REFUSAL_EXITS.has(state.exit.code)
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
  // One pass: the newest record naming each change, over its whole history.
  const latest = new Map<string, ReadRecord>();
  for (const r of records) {
    if (!isDrive(r.record) || !r.record.redrive) continue;
    const prefix = `${r.record.repo}#${String(r.record.pr)}\0`;
    for (const c of redrivenChanges(r.record.redrive)) {
      const key = prefix + c;
      const seen = latest.get(key);
      if (seen === undefined || r.record.createdAt >= seen.record.createdAt)
        latest.set(key, r);
    }
  }
  return new Set([...latest.values()].map((r) => r.record.id));
}

/** The ids of the latest record under each key `keyOf` gives; a record it gives `null` is not kept. */
function latestIdsBy(
  records: ReadRecord[],
  keyOf: (r: ReadRecord) => string | null,
): Set<string> {
  const latest = new Map<string, ReadRecord>();
  for (const r of records) {
    const key = keyOf(r);
    if (key === null) continue;
    const seen = latest.get(key);
    if (seen === undefined || r.record.createdAt >= seen.record.createdAt)
      latest.set(key, r);
  }
  return new Set([...latest.values()].map((r) => r.record.id));
}

/** The facts a launch carries when it armed a pull request that had no drive ledger. */
export const UNARMED_FACTS = "no ledger, head ";

/**
 * The ids of each pull request's latest arm record per head commit: an arm
 * is not repeated at the same head, and the record is the only evidence of
 * that when the arm left no ledger, so it outlives the retention.
 */
function latestArms(records: ReadRecord[]): Set<string> {
  return latestIdsBy(records, (r) =>
    isDrive(r.record) && r.record.facts?.startsWith(UNARMED_FACTS)
      ? `${r.record.repo}#${String(r.record.pr)}\0${r.record.facts}`
      : null,
  );
}

/**
 * The ids of each item's latest pickup record: while it is unreleased it is
 * the only thing that keeps the item from being picked up again, so it stays
 * until `releaseEnded` has seen the item leave the dispatch states.
 */
function latestPickups(records: ReadRecord[]): Set<string> {
  const latest = latestBy(
    records,
    (r) => r.action === "pickup",
    (r) => `${r.repo}\0${String(r.item)}`,
  );
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
  for (const id of latestArms(records)) kept.add(id);
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
  const removeSettled = db.query("DELETE FROM settled_ends WHERE record = ?");
  inTransaction(db, () => {
    for (const id of removed) {
      remove.run(id);
      removeNudges.run(id);
      removeSettled.run(id);
    }
  });
  return removed;
}

/** The launch records whose claim ends are all written on the forge, so their pull requests need no read to be ended. */
export function settledEnds(root = stateRoot()): Set<string> {
  const rows = stateDb(root).query("SELECT record FROM settled_ends").all() as {
    record: string;
  }[];
  return new Set(rows.map((r) => r.record));
}

/** Record that these launch records owe no claim end any more. */
export function settleEnds(
  ids: readonly string[],
  at: string,
  root = stateRoot(),
): void {
  if (ids.length === 0) return;
  const db = stateDb(root);
  const insert = db.query(
    "INSERT OR IGNORE INTO settled_ends (record, at) VALUES (?, ?)",
  );
  inTransaction(db, () => {
    for (const id of ids) insert.run(id, at);
  });
}

/** Remove a record: one the runtime answered it started nothing for, or one a person cleared. */
export function removeRecord(id: string, root = stateRoot()): void {
  const db = stateDb(root);
  inTransaction(db, () => {
    db.query("DELETE FROM launches WHERE id = ?").run(id);
    db.query("DELETE FROM settled_ends WHERE record = ?").run(id);
  });
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
    state: stateOf(row, rows, thisHost()),
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
