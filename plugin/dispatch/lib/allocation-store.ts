/**
 * The declared-priorities allocation records in the dispatcher's state
 * database ([design](../../../design/priorities-and-overview.md#computed-ranking-proposes-a-shortlist)):
 *
 * - `allocation_charge`: one immutable row per successful pickup claim, keyed
 *   by claim id, written by the claim path in the same transaction as the
 *   claim: its lane, its allocation owner at each level, the lane weights
 *   read and the peripheral share recorded with it. A replayed claim inserts
 *   nothing. Urgent and `bug-high` charges are kept with their lane and
 *   excluded from `N`.
 * - `allocation_week`: one row per completed week, written once by the first
 *   tick of the next week and never rewritten: its `N`, `P`, `D0`, `F` and
 *   the next week's opening debt.
 * - `allocation_lane_epoch`: each weighted lane's ready and empty
 *   transitions, recorded by the tick with the snapshot hash; the latest
 *   ready transition of the week is the lane's epoch, and the table's newest
 *   sequence number is the epochs' revision the ranker hashes.
 * - `allocation_ranking`: each repository's newest ranking, replaced by each
 *   tick: the ranker's input and output, and each item's lane and owners,
 *   which the claim path charges a claimed item with.
 *
 * Charges are kept for at least two weeks (`pruneCharges` keeps three), so a
 * tick that missed a week boundary can still write the week's row.
 */
import type { Database } from "bun:sqlite";
import { isRecord } from "../../shared/guards.ts";
import type {
  LaneEpochs,
  RankerInput,
  RankerOutput,
  WeekState,
} from "../../shared/priorities/ranker.ts";
import {
  isWeightedLane,
  type Lane,
  laneShares,
  type WeightedLane,
} from "../../shared/priorities/lanes.ts";
import type { LaneWeights } from "../../shared/priorities/weights.ts";
import {
  closeWeek,
  previousWeek,
  weekOf,
  weekStartMs,
  type WeekCharge,
  type WeekRow,
} from "../../shared/priorities/week.ts";

const WEEK_MS = 7 * 86_400_000;
/** How long charges are kept: three weeks, above the two the design asks. */
const CHARGE_KEEP_MS = 3 * WEEK_MS;

/** The tables, created by the state database's migration. */
export const ALLOCATION_TABLES_SQL = `
  CREATE TABLE allocation_charge (
    claim_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    item TEXT NOT NULL,
    week TEXT NOT NULL,
    lane TEXT NOT NULL,
    owners TEXT NOT NULL,
    weights TEXT NOT NULL,
    peripheral_share REAL NOT NULL,
    ranking TEXT,
    at_ms INTEGER NOT NULL
  );
  CREATE INDEX allocation_charge_week ON allocation_charge (week, at_ms);
  CREATE TABLE allocation_week (
    week TEXT PRIMARY KEY,
    n INTEGER NOT NULL,
    p INTEGER NOT NULL,
    d0 REAL NOT NULL,
    f REAL NOT NULL,
    next_debt REAL NOT NULL,
    reason TEXT,
    written_at_ms INTEGER NOT NULL
  );
  CREATE TABLE allocation_lane_epoch (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    lane TEXT NOT NULL,
    week TEXT NOT NULL,
    ready INTEGER NOT NULL,
    start_n INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    at_ms INTEGER NOT NULL
  );
  CREATE INDEX allocation_lane_epoch_lane ON allocation_lane_epoch (lane, seq);
  CREATE TABLE allocation_ranking (
    repo TEXT PRIMARY KEY,
    at_ms INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT NOT NULL,
    classes TEXT NOT NULL
  );
`;

/** An item's lane and owners as the newest ranking classified it. */
export interface ItemClass {
  lane: Lane | "unallocated" | "excluded";
  objective: string | null;
  owners: Record<string, string>;
}

/** The claim id of `item`'s claim under launch record `launch`. */
export function claimId(launch: string, item: string): string {
  return `${launch}:${item}`;
}

/**
 * Write a claim's charge, classified by the repository's newest ranking
 * (`unallocated` when no ranking classified it). Inserted once: a replay of
 * the same claim id changes nothing. Returns whether a row was written.
 */
export function writeCharge(
  db: Database,
  claim: { claimId: string; repo: string; item: string; atMs: number },
  weights: LaneWeights,
): boolean {
  const ranking = latestRanking(db, claim.repo);
  const cls = ranking?.classes[claim.item];
  const lane: Lane | "unallocated" =
    cls === undefined || cls.lane === "excluded" ? "unallocated" : cls.lane;
  const peripheralShare = isWeightedLane(lane)
    ? laneShares(weights.weights).peripheral
    : 0;
  const result = db
    .query(
      `INSERT OR IGNORE INTO allocation_charge
        (claim_id, repo, item, week, lane, owners, weights, peripheral_share, ranking, at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      claim.claimId,
      claim.repo,
      claim.item,
      weekOf(claim.atMs),
      lane,
      JSON.stringify(cls?.owners ?? {}),
      JSON.stringify(weights.weights),
      peripheralShare,
      ranking?.inputHash ?? null,
      claim.atMs,
    );
  return result.changes > 0;
}

/** A week's charges, in claim order. */
export function weekCharges(db: Database, week: string): WeekCharge[] {
  return (
    db
      .query(
        "SELECT claim_id, lane, owners, peripheral_share, at_ms FROM allocation_charge WHERE week = ? ORDER BY at_ms, claim_id",
      )
      .all(week) as Array<{
      claim_id: string;
      lane: string;
      owners: string;
      peripheral_share: number;
      at_ms: number;
    }>
  ).map((r) => ({
    claimId: r.claim_id,
    lane: r.lane as WeekCharge["lane"],
    objective: objectiveOf(parseObject(r.owners)),
    peripheralShare: r.peripheral_share,
    atMs: r.at_ms,
  }));
}

/** The allocating level's owner id (`level:scope:id` → `id`). */
function objectiveOf(owners: Record<string, unknown>): string | null {
  const owner = owners.repository ?? Object.values(owners)[0];
  return typeof owner === "string" ? owner.split(":").slice(2).join(":") : null;
}

/** A JSON column read as an object; anything else as an empty one. */
function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return isRecord(value) ? value : {};
}

function isRankerInput(value: unknown): value is RankerInput {
  return (
    isRecord(value) &&
    isRecord(value.snapshot) &&
    Array.isArray(value.records) &&
    isRecord(value.weights) &&
    isRecord(value.week)
  );
}

function isRankerOutput(value: unknown): value is RankerOutput {
  return (
    isRecord(value) &&
    Array.isArray(value.shortlist) &&
    Array.isArray(value.lanes)
  );
}

function isClasses(value: unknown): value is Record<string, ItemClass> {
  return (
    isRecord(value) &&
    Object.values(value).every((c) => isRecord(c) && typeof c.lane === "string")
  );
}

export function weekRow(db: Database, week: string): WeekRow | null {
  const r = db
    .query("SELECT * FROM allocation_week WHERE week = ?")
    .get(week) as {
    week: string;
    n: number;
    p: number;
    d0: number;
    f: number;
    next_debt: number;
    reason: string | null;
  } | null;
  return r === null
    ? null
    : {
        week: r.week,
        n: r.n,
        p: r.p,
        d0: r.d0,
        f: r.f,
        nextDebt: r.next_debt,
        reason: r.reason,
      };
}

/**
 * This week's state, writing the completed week's row first when this is
 * the week's first tick. The row is written once (`INSERT OR IGNORE`): a
 * later tick reads it and never rewrites it. With no row for the week before
 * and no charges to derive it from, the week opens with no debt and says so.
 */
export function openWeek(db: Database, nowMs: number): WeekState {
  const week = weekOf(nowMs);
  const previous = previousWeek(week);
  let row = weekRow(db, previous);
  if (row === null) {
    const charges = weekCharges(db, previous);
    const before = weekRow(db, previousWeek(previous));
    const d0 = before?.nextDebt ?? 0;
    row =
      charges.length === 0 && before === null
        ? {
            ...closeWeek(previous, [], 0),
            reason:
              "no row for the week before and no charges to derive it from: the week opens with no debt",
          }
        : closeWeek(previous, charges, d0);
    db.query(
      `INSERT OR IGNORE INTO allocation_week (week, n, p, d0, f, next_debt, reason, written_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.week,
      row.n,
      row.p,
      row.d0,
      row.f,
      row.nextDebt,
      row.reason,
      nowMs,
    );
    row = weekRow(db, previous) ?? row;
  }
  return {
    week,
    d0: row.nextDebt,
    d0Reason: row.reason,
    charges: weekCharges(db, week),
  };
}

/** Remove charges older than `CHARGE_KEEP_MS`. */
export function pruneCharges(db: Database, nowMs: number): void {
  db.query("DELETE FROM allocation_charge WHERE at_ms < ?").run(
    weekStartMs(nowMs) - CHARGE_KEEP_MS,
  );
}

/**
 * Record each weighted lane's transition between having ready work and
 * having none, and return the epochs: per lane, the week's weighted-start
 * count at its latest ready transition this week (0 when it has been ready
 * since the week opened).
 */
export function recordEpochs(
  db: Database,
  week: WeekState,
  ready: ReadonlySet<WeightedLane>,
  snapshotHash: string,
  nowMs: number,
): LaneEpochs {
  const n = week.charges.filter((c) => isWeightedLane(c.lane)).length;
  for (const lane of ["core", "tactical", "peripheral", "bug-other"] as const) {
    const last = db
      .query(
        "SELECT ready, week FROM allocation_lane_epoch WHERE lane = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(lane) as { ready: number; week: string } | null;
    const isReady = ready.has(lane);
    if (
      last === null ||
      last.ready !== (isReady ? 1 : 0) ||
      (isReady && last.week !== week.week)
    )
      db.query(
        "INSERT INTO allocation_lane_epoch (lane, week, ready, start_n, snapshot, at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        lane,
        week.week,
        isReady ? 1 : 0,
        continuous(last, week.week, isReady) ? 0 : n,
        snapshotHash,
        nowMs,
      );
  }
  return readEpochs(db, week.week);
}

/** Whether a lane ready now has been ready since the week opened: its first row, or ready across the week boundary. */
function continuous(
  last: { ready: number; week: string } | null,
  week: string,
  isReady: boolean,
): boolean {
  return isReady && (last === null || (last.week !== week && last.ready === 1));
}

/** The epochs as the ranker reads them. */
function readEpochs(db: Database, week: string): LaneEpochs {
  const startN: LaneEpochs["startN"] = {};
  for (const lane of ["core", "tactical", "peripheral", "bug-other"] as const) {
    const r = db
      .query(
        "SELECT start_n FROM allocation_lane_epoch WHERE lane = ? AND week = ? AND ready = 1 ORDER BY seq DESC LIMIT 1",
      )
      .get(lane, week) as { start_n: number } | null;
    if (r !== null && r.start_n > 0) startN[lane] = r.start_n;
  }
  const rev = db
    .query("SELECT MAX(seq) AS seq FROM allocation_lane_epoch")
    .get() as { seq: number | null };
  return { revision: rev.seq ?? 0, startN };
}

/** Replace a repository's newest ranking. */
export function saveRanking(
  db: Database,
  repo: string,
  input: RankerInput,
  output: RankerOutput,
  classes: Record<string, ItemClass>,
  nowMs: number,
): void {
  db.query(
    `INSERT INTO allocation_ranking (repo, at_ms, input_hash, input, output, classes) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo) DO UPDATE SET at_ms = excluded.at_ms, input_hash = excluded.input_hash,
       input = excluded.input, output = excluded.output, classes = excluded.classes`,
  ).run(
    repo,
    nowMs,
    output.inputHash,
    JSON.stringify(input),
    JSON.stringify(output),
    JSON.stringify(classes),
  );
}

/** A repository's newest ranking, or `null` when no tick ranked it. */
export function latestRanking(
  db: Database,
  repo: string,
): {
  atMs: number;
  inputHash: string;
  input: RankerInput;
  output: RankerOutput;
  classes: Record<string, ItemClass>;
} | null {
  const table = db
    .query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'allocation_ranking'",
    )
    .get();
  if (table === null) return null;
  const r = db
    .query("SELECT * FROM allocation_ranking WHERE repo = ?")
    .get(repo) as {
    at_ms: number;
    input_hash: string;
    input: string;
    output: string;
    classes: string;
  } | null;
  if (r === null) return null;
  const input: unknown = JSON.parse(r.input);
  const output: unknown = JSON.parse(r.output);
  const classes: unknown = JSON.parse(r.classes);
  if (!isRankerInput(input) || !isRankerOutput(output) || !isClasses(classes))
    return null;
  return { atMs: r.at_ms, inputHash: r.input_hash, input, output, classes };
}
