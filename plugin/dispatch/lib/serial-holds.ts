/**
 * How long contended work waited: each pull request held behind another in
 * a serialized area (`contention.ts`) is a row of the state database's
 * `holds` table from the tick that first holds it, and the outcome log
 * gets an event row when the hold begins and one when it ends, the end
 * carrying how long it lasted. Each row is written in the transaction that
 * writes or removes its hold, so a tick that stops between them leaves
 * nothing to repair.
 *
 * A hold ends only on a tick that decided serialization: one whose forge or
 * catalog did not read leaves every hold as it is, and so does a pull
 * request whose place this tick cannot tell. A hold that moves to another
 * area or leader goes on, under its first start.
 */
import { stateRoot } from "../receipts.ts";
import type { Contention } from "./contention.ts";
import { insertRow } from "./log.ts";
import { inTransaction, stateDb } from "./state.ts";
import { failureText, minutesBetween } from "./text.ts";
import { parseMs } from "../../shared/time.ts";

interface HoldRow {
  pr: number;
  area: string;
  leader: number;
  since: string;
}

/** Why a hold ended, from what this tick saw of the pull request. */
function endedWhy(contention: Contention, pr: number): string {
  if (contention.grouped.has(pr)) return "it leads its serialized area now";
  return contention.considered.has(pr)
    ? "it touches no serialized area now"
    : "it is no longer an open pull request the dispatcher drives";
}

/**
 * Bring the repository's holds in line with this tick's: a new hold begins,
 * a hold no longer held ends, each with its event row. Returns why the
 * holds could not be recorded, if they could not; the next tick records
 * them.
 */
export function settleHolds(
  slug: string,
  contention: Contention,
  nowIso: string,
  root = stateRoot(),
): string[] {
  if (!contention.decided) return [];
  try {
    const db = stateDb(root);
    inTransaction(db, () => {
      const rows = db
        .query("SELECT pr, area, leader, since FROM holds WHERE repo = ?")
        .all(slug) as HoldRow[];
      const stored = new Map(rows.map((r) => [r.pr, r]));
      for (const [pr, hold] of contention.held) {
        const was = stored.get(pr);
        if (was !== undefined) {
          db.query(
            "UPDATE holds SET area = ?, leader = ? WHERE repo = ? AND pr = ?",
          ).run(hold.area, hold.leader, slug, pr);
          continue;
        }
        db.query(
          "INSERT INTO holds (repo, pr, area, leader, since) VALUES (?, ?, ?, ?, ?)",
        ).run(slug, pr, hold.area, hold.leader, nowIso);
        insertRow(db, {
          kind: "event",
          key: `held ${slug} PR #${pr} ${nowIso}`,
          at: nowIso,
          repo: slug,
          stage: "rearm",
          target: `PR #${pr}`,
          event: "held",
          account: null,
          class: null,
          reason: `serialized behind #${hold.leader} in ${hold.area}: no re-arm, takeover or re-drive until it leads`,
        });
      }
      for (const row of rows) {
        if (contention.held.has(row.pr) || contention.unplaced.has(row.pr))
          continue;
        db.query("DELETE FROM holds WHERE repo = ? AND pr = ?").run(
          slug,
          row.pr,
        );
        const waited = Math.max(0, parseMs(nowIso) - parseMs(row.since));
        insertRow(db, {
          kind: "event",
          key: `hold-ended ${slug} PR #${row.pr} ${row.since}`,
          at: nowIso,
          repo: slug,
          stage: "rearm",
          target: `PR #${row.pr}`,
          event: "hold-ended",
          account: null,
          class: null,
          reason: `held ${minutesBetween(parseMs(row.since), parseMs(nowIso))} min since ${row.since}, last behind #${row.leader} in ${row.area}; ${endedWhy(contention, row.pr)}`,
          ...(Number.isFinite(waited) ? { durationMs: waited } : {}),
        });
      }
    });
    return [];
  } catch (error) {
    return [
      `the holds of serialized pull requests were not recorded, and the next tick records them: ${failureText(error)}`,
    ];
  }
}
