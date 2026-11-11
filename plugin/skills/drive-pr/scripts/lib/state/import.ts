/**
 * The one-time import of a clone's state directory into the drive's database.
 *
 * A release before the database kept the drive's machine state as files in
 * `<root>/<clone key>/`: a `drive-pr-<PR>.json` per pull request, the session
 * and tree leases, the driver locks' claims, the held-item and Ready-mark
 * claims, the driver record. The first open of the database for a clone that
 * has no `imports` row reads those files into rows, records the import (when,
 * how many records, and the files it could not read), and leaves every file
 * where it is: nothing is moved or rewritten, so the earlier release's files
 * stay as they were for a person to inspect, and the reaper
 * (`reap-state.ts`) removes them once the import is older than its retention.
 *
 * What is read, and how:
 *
 * - a state file, as its text: the store reads it as it read the file, so a
 *   file that was unusable stays unusable and is refused the same way. A
 *   state file the import cannot read at all stops the import, which records
 *   nothing and is tried again at the next open;
 * - a lease or tree lease that parses, under a new generation, since the
 *   earlier release's generations were random nonces; one that does not
 *   parse is skipped and named;
 * - a driver lock's claim, with its last refresh as the lock's heartbeat, so
 *   a driver still running the earlier release keeps its lock until that
 *   heartbeat ages out;
 * - a held item's claim, whose key is recovered from the held items of the
 *   imported state (the file name carries only a digest of it), and the
 *   Ready-mark claim;
 * - the driver record.
 *
 * Locks that guarded one read-modify-write, their tombstones, stop requests
 * and completions are not read: each lived seconds, and nothing waits on one
 * across an upgrade.
 *
 * A drive still running the earlier release when this one first opens the
 * database keeps writing files the database no longer reads. Its ledger on
 * the pull request stays the cross-clone truth: a later drive in this clone
 * seeds from a ledger newer than the imported state.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { errnoCode, swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { SESSION_LEASE_MIN } from "../../../../../shared/liveness.ts";
import type { DriveDb } from "./db.ts";

/** The files an earlier release kept in a clone's state directory, which the database replaces. */
const FORMER = {
  state: /^drive-pr-([0-9]+)\.json$/,
  lease: /^pr-drive-lease-([0-9]+)-(wt-[0-9a-f]{16})\.json$/,
  treeLease: /^drive-tree-lease-(wt-[0-9a-f]{16})\.json$/,
  driverLock: /^(pr-drive-[0-9]+|pr-drive-worktree-[0-9a-f]{16})\.lock$/,
  heldClaim: /^drive-pr-([0-9]+)\.held-claim\.(.+\.[0-9a-f]{16})$/,
  readyClaim: /^drive-pr-([0-9]+)\.ready-claim$/,
  driverRecord: /^ledger-driver-([0-9]+)\.json$/,
} as const;

/** The names an earlier release put a `.lock` mutex beside: a name the release never wrote is not one of its leftovers. */
const LOCK_ANCHOR =
  "(?:\\.reap-state-delete|drive-pr-[0-9]+\\.json|drive-tree-lease-wt-[0-9a-f]{16}(?:\\.json)?|pr-drive-lease-[0-9]+-wt-[0-9a-f]{16}\\.json|drive-pr-remote-lock-[0-9]+|pr-drive-[0-9]+|pr-drive-worktree-[0-9a-f]{16}|ledger-driver-[0-9]+\\.json)";

/** A displaced legacy lock or recovery gate, never read by the database. */
export const FORMER_QUARANTINE = new RegExp(
  `^${LOCK_ANCHOR}\\.lock(?:\\.recovering)?\\.stale\\..+$`,
);

/** Presence alone protects legacy holders whose identity may be unreadable. */
const FORMER_LOCK = new RegExp(`^${LOCK_ANCHOR}\\.lock(?:\\.recovering)?$`);

export function isFormerLock(name: string): boolean {
  return FORMER_LOCK.test(name);
}

/**
 * Whether `name` is a file a running earlier release rewrites for as long as it
 * drives: its state, leases, driver record and claims. Nothing of this release
 * writes one, so a recent write means a legacy driver is still alive here.
 */
export function isFormerWriterFile(name: string): boolean {
  return Object.values(FORMER).some((re) => re.test(name));
}

/**
 * Every other name an earlier release wrote there and nothing reads now: the
 * mutex directories and their tombstones, staging and compaction leftovers,
 * stop completions, temporary files, markers and the reaper's own files.
 */
const FORMER_LEFTOVERS: readonly RegExp[] = [
  new RegExp(`^${LOCK_ANCHOR}\\.lock(?:\\.recovering)?(?:\\.stale\\..+)?$`),
  new RegExp(`^${LOCK_ANCHOR}\\.lock\\.[0-9]+\\..+\\.staging$`),
  /^\.compacting\./,
  /^drive-pr-remote-lock-[0-9]+$/,
  /^drive-pr-[0-9]+\.stop-complete\.[0-9a-f]{24}\.json(?:\.[0-9]+\.tmp)?$/,
  /^drive-pr-[0-9]+\.(?:held-claim\..+|ready-claim)\.released\.[0-9]+$/,
  /^(?:drive-pr-[0-9]+|pr-drive-lease-[0-9]+-wt-[0-9a-f]{16}|drive-tree-lease-wt-[0-9a-f]{16})\.json\.[0-9a-f]{6}$/,
  /^\.drive-pr-[0-9]+\.orphan-warned(?:\.abandoned\.[0-9]+)?$/,
  /^\.migrated-from-legacy$/,
  /^\.reap-state-snapshot\.json(?:\.[0-9a-f]{6})?$/,
  /^\.reap-state-delete\.lock/,
];

/** Whether `name`, in a clone's state directory, is a file an earlier release kept there that the database replaces. */
export function isFormerFile(name: string): boolean {
  return (
    Object.values(FORMER).some((re) => re.test(name)) ||
    FORMER_LEFTOVERS.some((re) => re.test(name))
  );
}

/** The held-claim file name an earlier release gave a held item's key. */
function formerClaimName(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, "_");
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `${safe}.${digest}`;
}

/** A row's columns, as `bun:sqlite` binds them. */
type Row = Record<string, string | number | null>;

/** The tables an import writes, each named as the rows it gets. */
const TABLES = [
  "drive_state",
  "leases",
  "tree_leases",
  "locks",
  "claims",
  "driver_records",
] as const;

/** What a clone's state directory holds, as the rows of each table. */
type Rows = Record<(typeof TABLES)[number], Row[]> & {
  /** The files with a former name that could not be read. */
  skipped: string[];
  /** Each imported state's held keys, by PR: a held claim's file name carries only a digest of its key. */
  heldKeys: Map<string, string[]>;
};

function text(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    swallow(err, "a former state file could not be read");
    return null;
  }
}

function mtimeIso(path: string): string {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch (err) {
    swallow(err, "a former state file's time could not be read");
    return new Date().toISOString();
  }
}

function json(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return isRecord(v) ? v : null;
  } catch (err) {
    swallow(err, "a former state file is not JSON");
    return null;
  }
}

const str = (v: unknown): v is string => typeof v === "string";

/** The PR a former file name carries, canonical. */
const prOf = (m: RegExpExecArray): string => BigInt(m[1] as string).toString();

/** Whether `v` is a lease the earlier release wrote, every field present. */
function validLease(v: Record<string, unknown>, tree: boolean): boolean {
  const session = v.holder === "session";
  if (!session && v.holder !== "worktree") return false;
  if (typeof v.pid !== "number" || !Number.isSafeInteger(v.pid)) return false;
  if (session ? v.pid <= 0 : v.pid !== 0) return false;
  const fields = [
    v.host,
    v.platform,
    v.actor,
    v.worktree,
    v.startedAt,
    v.lastSeen,
    v.command,
    v.sessionStarted,
  ];
  if (!fields.every(str) || !Number.isFinite(Date.parse(v.lastSeen as string)))
    return false;
  return !tree || (str(v.pr) && /^[0-9]+$/.test(v.pr) && str(v.revision));
}

/** A lease the earlier release wrote, as the columns of a row; `null` when it is not one. */
function formerLease(
  v: Record<string, unknown> | null,
  tree: boolean,
): Row | null {
  if (v === null || !validLease(v, tree)) return null;
  const field = (k: string): string => v[k] as string;
  return {
    holder: field("holder"),
    pid: v.pid as number,
    host: field("host"),
    platform: field("platform"),
    worktree: field("worktree"),
    command: field("command"),
    session_started: field("sessionStarted"),
    started_at: field("startedAt"),
    renewed_at: field("lastSeen"),
    ...(tree
      ? { pr: BigInt(field("pr")).toString(), revision: field("revision") }
      : {}),
  };
}

/** A driver lock's claim, as the columns of a lock row; `null` when the lock holds no single readable claim. */
function formerClaim(dir: string, name: string): Row | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith("claim."));
  } catch (err) {
    swallow(err, "a former driver lock could not be listed");
    return null;
  }
  if (names.length !== 1) return null;
  const file = join(dir, names[0] as string);
  const raw = text(file);
  if (raw === null) return null;
  const nl = raw.indexOf("\n");
  const [pid = "", host = "", platform = "", hostId = ""] = (
    nl === -1 ? raw : raw.slice(0, nl)
  )
    .trim()
    .split(/\s+/);
  if (!/^[0-9]+$/.test(pid) || Number(pid) < 1) return null;
  const detail = nl === -1 ? "" : raw.slice(nl + 1).trim();
  const diag = json(detail === "" ? null : detail);
  const renewed = mtimeIso(file);
  return {
    name,
    token: (names[0] as string).slice("claim.".length),
    pid: Number(pid),
    host,
    host_id: hostId,
    platform: platform === "" ? process.platform : platform,
    detail: diag === null ? null : JSON.stringify(diag),
    acquired_at: str(diag?.started) ? diag.started : renewed,
    renewed_at: renewed,
  };
}

/** Read one former file, whose name `m` matched, into `rows`. */
type Reader = (rows: Rows, path: string, m: RegExpExecArray) => void;

const readState: Reader = (rows, path, m) => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // A state that vanished since the listing has nothing to import. One that
    // exists and cannot be read must not become a fresh state with the import
    // recorded: refuse, so the next open reads the directory again.
    if (errnoCode(err) === "ENOENT") return;
    throw new Error(
      `${basename(path)} in the earlier release's state directory cannot be read (${err instanceof Error ? err.message : String(err)}); fix its permissions or move it aside, then run the command again`,
      { cause: err },
    );
  }
  rows.drive_state.push({
    pr: prOf(m),
    v: 1,
    state: raw,
    updated_at: mtimeIso(path),
  });
  const held = json(raw)?.held;
  rows.heldKeys.set(
    prOf(m),
    Array.isArray(held)
      ? held.flatMap((h) => (isRecord(h) && str(h.key) ? [h.key] : []))
      : [],
  );
};

const readLease: Reader = (rows, path, m) => {
  const row = formerLease(json(text(path)), false);
  if (row === null) rows.skipped.push(basename(path));
  else rows.leases.push({ ...row, pr: prOf(m), actor: m[2] as string });
};

const readTreeLease: Reader = (rows, path, m) => {
  const row = formerLease(json(text(path)), true);
  if (row === null) rows.skipped.push(basename(path));
  else rows.tree_leases.push({ ...row, actor: m[1] as string });
};

const readDriverLock: Reader = (rows, path, m) => {
  const row = formerClaim(path, m[1] as string);
  if (row !== null) rows.locks.push(row);
};

const readReadyClaim: Reader = (rows, path, m) => {
  const token = text(path);
  if (token !== null && token !== "")
    rows.claims.push({
      pr: prOf(m),
      kind: "ready",
      key: "",
      token,
      at: mtimeIso(path),
    });
};

const readDriverRecord: Reader = (rows, path, m) => {
  const v = json(text(path));
  if (
    v !== null &&
    str(v.worktree) &&
    str(v.started) &&
    typeof v.pid === "number" &&
    str(v.host)
  )
    rows.driver_records.push({
      pr: prOf(m),
      worktree: v.worktree,
      started: v.started,
      pid: v.pid,
      host: v.host,
      released: v.released === true ? 1 : 0,
    });
  else rows.skipped.push(basename(path));
};

/** A held item's claim: its key is the one of the imported state's held items whose digest the file name carries. */
const readHeldClaim: Reader = (rows, path, m) => {
  const key = (rows.heldKeys.get(prOf(m)) ?? []).find(
    (k) => formerClaimName(k) === m[2],
  );
  const token = text(path);
  if (key === undefined || token === null || token === "")
    rows.skipped.push(basename(path));
  else
    rows.claims.push({
      pr: prOf(m),
      kind: "held",
      key,
      token,
      at: mtimeIso(path),
    });
};

/** The readers of each pass: held claims go last, once every state's held keys are known. */
const PASSES: readonly (readonly [RegExp, Reader])[][] = [
  [
    [FORMER.state, readState],
    [FORMER.lease, readLease],
    [FORMER.treeLease, readTreeLease],
    [FORMER.driverLock, readDriverLock],
    [FORMER.readyClaim, readReadyClaim],
    [FORMER.driverRecord, readDriverRecord],
  ],
  [[FORMER.heldClaim, readHeldClaim]],
];

/** What the clone's state directory holds, read before the import's transaction so a large directory does not hold the database's write lock. */
function readFormer(dir: string): Rows | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
  const rows: Rows = {
    drive_state: [],
    leases: [],
    tree_leases: [],
    locks: [],
    claims: [],
    driver_records: [],
    skipped: [],
    heldKeys: new Map(),
  };
  for (const readers of PASSES)
    for (const name of names) {
      const match = readers.find(([re]) => re.test(name));
      if (match !== undefined)
        match[1](rows, join(dir, name), match[0].exec(name) as RegExpExecArray);
    }
  return rows;
}

function imported(drive: DriveDb): boolean {
  return (
    drive.db.query("SELECT 1 FROM imports WHERE clone = ?").get(drive.clone) !==
    null
  );
}

/** Insert `row` into `table` unless a row with its key is already there. */
function insertRow(db: Database, table: string, row: Row): void {
  const columns = Object.keys(row);
  db.run(
    `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    Object.values(row),
  );
}

/** The next lease generation, from the counter `db.ts`'s `nextCount` keeps, inside the import's transaction. */
function nextGeneration(db: Database): number {
  const row = db
    .query(
      "INSERT INTO counters (name, value) VALUES ('lease-generation', 1) ON CONFLICT (name) DO UPDATE SET value = value + 1 RETURNING value",
    )
    .get() as { value: number };
  return row.value;
}

/**
 * A former lease's row as the table keeps it: a new generation (the earlier
 * release's were random nonces), no process identity beyond the pid and host
 * it recorded, and an expiry one lease window after its last renewal.
 */
function leaseRow(db: Database, lease: Row): Row {
  return {
    ...lease,
    host_id: "",
    boot_id: "",
    start: "",
    generation: nextGeneration(db),
    expires_at: new Date(
      Date.parse(String(lease.renewed_at)) + SESSION_LEASE_MIN * 60_000,
    ).toISOString(),
  };
}

/** The rows of `table` as the import writes them. */
function rowsFor(
  drive: DriveDb,
  table: (typeof TABLES)[number],
  rows: Rows,
): Row[] {
  if (table === "leases" || table === "tree_leases")
    return rows[table].map((l) => leaseRow(drive.db, l));
  if (table === "locks")
    return rows.locks.map((k) => ({
      label: "drive.ts",
      boot_id: "",
      start: "",
      ...k,
    }));
  return rows[table];
}

/** Write what was read, unless another process imported the clone first. */
function writeRows(drive: DriveDb, dir: string, rows: Rows | null): void {
  const { db, clone } = drive;
  db.transaction(() => {
    if (imported(drive)) return;
    let count = 0;
    for (const table of TABLES)
      for (const row of rows === null ? [] : rowsFor(drive, table, rows)) {
        insertRow(db, table, { clone, ...row });
        count++;
      }
    insertRow(db, "imports", {
      clone,
      dir,
      at: new Date().toISOString(),
      imported: count,
      skipped: JSON.stringify(rows?.skipped ?? []),
    });
  }).immediate();
}

/**
 * Read `dir`, the clone's state directory, into the database once: a no-op
 * when the clone already has an `imports` row, in this process or any other.
 */
export function importStateDir(drive: DriveDb, dir: string): void {
  if (!imported(drive)) writeRows(drive, dir, readFormer(dir));
}

/** When the clone's state directory was imported, or `null` before it was. */
export function importedAt(drive: DriveDb): string | null {
  const row = drive.db
    .query("SELECT at FROM imports WHERE clone = ?")
    .get(drive.clone) as { at: string } | null;
  return row?.at ?? null;
}
