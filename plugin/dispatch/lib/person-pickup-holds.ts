/** A person's hold on one tracker item, stored on the host that dispatches it. */
import { attempt, failed, ok } from "../../shared/outcome.ts";
import { swallow } from "../../shared/errors.ts";
import { currentIso } from "../../shared/time.ts";
import type { LineQueued } from "./dashboard-contract.ts";
import type { LaunchRecord } from "./launches.ts";
import {
  type PickupCondition,
  pickupConditionWords,
  readPickupCondition,
} from "./pickup-condition.ts";
import { readOnlyStateDb, stateDb, statePath } from "./state.ts";

export interface PersonPickupHold {
  item: string;
  by: string;
  at: string;
  title: string;
  url: string | null;
  condition?: PickupCondition;
  unreadableCondition?: true;
  resumeRecord?: string;
  settled?: "cleared" | "closed-unmerged";
  relationSettled?: true;
}

/** What a queue entry is built from. */
export type QueuedFields = Pick<
  LineQueued,
  "source" | "group" | "target" | "why"
> &
  Partial<
    Pick<LineQueued, "stale" | "assignedBy" | "hold" | "pickupHold" | "launch">
  >;

/** Where the line places a tracker item the tick left unplaced: held when a person's hold did it, else refused. */
export function unplacedQueueFields(u: {
  target: string;
  reason: string;
  pickupHold?: LineQueued["pickupHold"];
}): QueuedFields {
  const placed: QueuedFields =
    u.pickupHold === undefined
      ? { source: "assigned", group: "never", target: u.target, why: u.reason }
      : { source: "held", group: "held", target: u.target, why: u.reason };
  return u.pickupHold === undefined
    ? placed
    : { ...placed, pickupHold: u.pickupHold };
}

export function pickupHoldReason(hold: PersonPickupHold): string {
  if (hold.unreadableCondition)
    return "held because its stored dependency could not be read";
  if (
    hold.settled === "closed-unmerged" &&
    hold.condition?.kind === "pr-merged"
  )
    return `held: PR #${hold.condition.pr} closed without merging`;
  return hold.condition === undefined
    ? `held by ${hold.by} at ${hold.at}`
    : `held by ${hold.by} at ${hold.at}: waiting for ${pickupConditionWords(hold.condition)}`;
}

/** Read the current holds without migrating an older database or creating one. */
export function personPickupHolds(repo: string, root?: string) {
  const read = readOnlyStateDb(root);
  if (!read.ok)
    return failed("unreadable", read.failure.reason, read.failure.cause);
  if (read.value === null) return ok([] as PersonPickupHold[]);
  const { db } = read.value;
  return attempt("unreadable", "pickup holds could not be read", () => {
    try {
      const table = db
        .query(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pickup_holds'",
        )
        .get();
      if (table === null) return [];
      const rows = db
        .query("SELECT * FROM pickup_holds WHERE repo = ? ORDER BY item")
        .all(repo.toLowerCase()) as PickupHoldRow[];
      return rows.map(holdOf);
    } finally {
      db.close();
    }
  });
}

interface PickupHoldRow {
  item: string;
  held_by: string;
  held_at: string;
  title: string;
  url: string | null;
  wait_condition?: string | null;
  resume_record?: string | null;
  wait_cleared?: number;
  wait_linked?: number;
}

/** What a readable stored wait says it settled as, if anything. */
function settledOf(
  cleared: number | undefined,
): Pick<PersonPickupHold, "settled"> {
  if (cleared === 1) return { settled: "cleared" };
  if (cleared === 2) return { settled: "closed-unmerged" };
  return {};
}

/** The stored wait's fields: its condition, or that it could not be read, and how it settled. */
function waitFieldsOf(
  row: PickupHoldRow,
): Pick<PersonPickupHold, "condition" | "unreadableCondition" | "settled"> {
  const condition = storedCondition(row.item, row.wait_condition);
  if (row.wait_condition != null && condition === null)
    return { unreadableCondition: true };
  return {
    ...(condition === null ? {} : { condition }),
    ...settledOf(row.wait_cleared),
  };
}

function holdOf(row: PickupHoldRow): PersonPickupHold {
  return {
    item: row.item,
    by: row.held_by,
    at: row.held_at,
    title: row.title,
    url: row.url,
    ...waitFieldsOf(row),
    ...(row.resume_record == null ? {} : { resumeRecord: row.resume_record }),
    ...(row.wait_linked === 1 ? { relationSettled: true as const } : {}),
  };
}

function storedCondition(
  item: string,
  value?: string | null,
): PickupCondition | null {
  if (value == null) return null;
  const reading = attempt(
    "unreadable",
    "stored dependency JSON",
    () => JSON.parse(value) as unknown,
  );
  if (reading.ok) return readPickupCondition(reading.value);
  swallow(
    reading.failure.cause,
    `could not read ${item}'s stored pickup dependency`,
  );
  return null;
}

export function insertPickupHold(
  db: ReturnType<typeof stateDb>,
  repo: string,
  item: string,
  hold: Omit<PersonPickupHold, "item" | "at">,
): boolean {
  const condition =
    hold.condition === undefined ? null : JSON.stringify(hold.condition);
  const inserted =
    db
      .query(
        `INSERT INTO pickup_holds
    (repo, item, held_by, held_at, title, url, wait_condition, resume_record)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (repo, item) DO NOTHING`,
      )
      .run(
        repo.toLowerCase(),
        item,
        hold.by,
        currentIso(),
        hold.title,
        hold.url,
        condition,
        hold.resumeRecord ?? null,
      ).changes === 1;
  if (inserted) return true;
  const prior = db
    .query(
      "SELECT wait_condition, resume_record, wait_cleared FROM pickup_holds WHERE repo = ? AND item = ?",
    )
    .get(repo.toLowerCase(), item) as PickupHoldRow | null;
  return (
    prior?.wait_condition === condition &&
    prior.resume_record === (hold.resumeRecord ?? null) &&
    prior.wait_cleared === 0
  );
}

/** A pass started after a cleared hold may record its next dependency. */
export function dropClearedPickupHold(
  db: ReturnType<typeof stateDb>,
  repo: string,
  item: string,
  launchCreatedAt: string,
): void {
  db.query(
    "DELETE FROM pickup_holds WHERE repo = ? AND item = ? AND held_at < ? AND wait_cleared = 1",
  ).run(repo.toLowerCase(), item, launchCreatedAt);
}

/** Settle only the hold the tick actually read, in case a person replaced it. */
export function settlePickupHold(
  repo: string,
  hold: PersonPickupHold,
  root: string,
  outcome: "remove" | "cleared" | "closed-unmerged" | "relation-settled",
): boolean {
  const operation = {
    remove: "DELETE FROM pickup_holds",
    cleared: "UPDATE pickup_holds SET wait_cleared = 1",
    "closed-unmerged": "UPDATE pickup_holds SET wait_cleared = 2",
    "relation-settled": "UPDATE pickup_holds SET wait_linked = 1",
  }[outcome];
  return (
    stateDb(root)
      .query(
        `${operation} WHERE repo = ? AND item = ? AND held_at = ? AND wait_condition = ?`,
      )
      .run(
        repo.toLowerCase(),
        hold.item,
        hold.at,
        JSON.stringify(hold.condition),
      ).changes === 1
  );
}

/** Keep the first holder and time on a repeated hold. A repeated release succeeds. */
export function setPersonPickupHold(
  repo: string,
  item: string,
  hold: Omit<PersonPickupHold, "item" | "at"> | null,
  root?: string,
) {
  const write = attempt(
    "refused",
    "the pickup hold could not be written",
    () => {
      const db = stateDb(root);
      const slug = repo.toLowerCase();
      if (hold !== null)
        return db.transaction(() => {
          // A cleared row no longer blocks a launch, so a person's new hold replaces it.
          db.query(
            "DELETE FROM pickup_holds WHERE repo = ? AND item = ? AND wait_cleared = 1",
          ).run(slug, item);
          return insertPickupHold(db, slug, item, hold);
        })();
      // A released conditional hold that names the record to resume keeps its
      // row as cleared, so the pickup resumes whatever result it ended with.
      // A hold whose dependency closed unmerged (2) is released the same way.
      db.query(
        "UPDATE pickup_holds SET wait_cleared = 1 WHERE repo = ? AND item = ? AND wait_cleared IN (0, 2) AND wait_condition IS NOT NULL AND resume_record IS NOT NULL",
      ).run(slug, item);
      db.query(
        "DELETE FROM pickup_holds WHERE repo = ? AND item = ? AND wait_cleared IN (0, 2)",
      ).run(slug, item);
      return true;
    },
  );
  if (!write.ok) return write;
  return write.value
    ? ok(statePath(root))
    : failed(
        "refused",
        `${item} already has a different pickup hold; its original hold stands`,
      );
}

/** Last check before starting or replaying any pickup, including recovery. */
export function personPickupBlock(
  record: LaunchRecord,
  root?: string,
): string | null {
  if (record.action !== "pickup") return null;
  const holds = personPickupHolds(record.repo, root);
  if (!holds.ok) return holds.failure.reason;
  const keys = new Set([
    record.item,
    record.ancestorEpic,
    record.factoryAncestor,
    ...(record.ancestors ?? []),
    record.blockingFor,
    ...(record.batchItems ?? []).flatMap((item) => [
      item.key,
      item.ancestor,
      ...(item.ancestors ?? []),
    ]),
  ]);
  const hold = holds.value.find(
    (row) => row.settled !== "cleared" && keys.has(row.item),
  );
  return hold === undefined
    ? null
    : `${hold.item} is ${pickupHoldReason(hold)}`;
}
