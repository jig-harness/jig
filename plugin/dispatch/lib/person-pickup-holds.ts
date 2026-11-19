/** A person's hold on one tracker item, stored on the host that dispatches it. */
import { attempt, failed, ok } from "../../shared/outcome.ts";
import { currentIso } from "../../shared/time.ts";
import type { LaunchRecord } from "./launches.ts";
import { readOnlyStateDb, stateDb, statePath } from "./state.ts";

export interface PersonPickupHold {
  item: string;
  by: string;
  at: string;
  title: string;
  url: string | null;
}

export function pickupHoldReason(hold: PersonPickupHold): string {
  return `held by ${hold.by} at ${hold.at}`;
}

/** Read the current holds without migrating an older database or creating one. */
export function personPickupHolds(repo: string, root?: string) {
  const read = readOnlyStateDb(root);
  if (!read.ok) return failed("unreadable", read.failure.reason);
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
      return db
        .query(
          "SELECT item, held_by AS by, held_at AS at, title, url FROM pickup_holds WHERE repo = ? ORDER BY item",
        )
        .all(repo.toLowerCase()) as PersonPickupHold[];
    } finally {
      db.close();
    }
  });
}

/** Keep the first holder and time on a repeated hold. A repeated release succeeds. */
export function setPersonPickupHold(
  repo: string,
  item: string,
  hold: Omit<PersonPickupHold, "item" | "at"> | null,
  root?: string,
) {
  return attempt("refused", "the pickup hold could not be written", () => {
    const db = stateDb(root);
    const slug = repo.toLowerCase();
    if (hold === null)
      db.query("DELETE FROM pickup_holds WHERE repo = ? AND item = ?").run(
        slug,
        item,
      );
    else
      db.query(`INSERT INTO pickup_holds (repo, item, held_by, held_at, title, url)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (repo, item) DO NOTHING`).run(
        slug,
        item,
        hold.by,
        currentIso(),
        hold.title,
        hold.url,
      );
    return statePath(root);
  });
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
    record.blockingFor,
    ...(record.batchItems ?? []).flatMap((item) => [item.key, item.ancestor]),
  ]);
  const hold = holds.value.find((row) => keys.has(row.item));
  return hold === undefined
    ? null
    : `${hold.item} is ${pickupHoldReason(hold)}`;
}
