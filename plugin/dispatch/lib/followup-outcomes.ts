/**
 * A follow-up's outcome record, one per merged pull request, in the state
 * database's `followup_outcomes` table (keyed by the repository and the
 * pull request): written by the tick when the launch record of a follow-up
 * it started ends, done or failed, with that launch record's id. The
 * receipts' retention never removes it, so a launch record that expires
 * after a successful follow-up does not turn it into a failure. An outcome
 * counts only for the marker that names its launch record: a later
 * attempt's outcome replaces it when that attempt ends.
 */
import { stateRoot } from "../receipts.ts";
import type { ReadRecord } from "./launches.ts";
import { stateDb } from "./state.ts";

export interface FollowupOutcome {
  /** The repository's `owner/name`. */
  repo: string;
  pr: number;
  /** The launch record of the follow-up that ended. */
  record: string;
  outcome: "done" | "failed";
  at: string;
  /** When that launch record was created. */
  created: string;
}

/** The outcome records of `repo`, by pull request. */
export function readOutcomes(
  repo: string,
  root = stateRoot(),
): Map<number, FollowupOutcome> {
  const rows = stateDb(root)
    .query(
      "SELECT repo, pr, record, outcome, at, created FROM followup_outcomes WHERE repo = ?",
    )
    .all(repo) as FollowupOutcome[];
  return new Map(rows.map((o) => [o.pr, o]));
}

/** How an ended follow-up record ended: its session's recorded result, else failed. */
export function outcomeOf(r: ReadRecord): "done" | "failed" | null {
  if (r.state.kind !== "ended" && r.state.kind !== "died") return null;
  return r.result === "done" ? "done" : "failed";
}

/** Whether the written outcome belongs to an attempt later than `record`. */
function supersedes(
  written: FollowupOutcome,
  record: { id: string; createdAt: string },
): boolean {
  const a = Date.parse(written.created);
  const b = Date.parse(record.createdAt);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b;
  return written.record > record.id;
}

/**
 * Write the outcome of every follow-up record among `records` that ended
 * and whose outcome is not yet written, so it outlives the record.
 */
export function settleFollowups(
  records: readonly ReadRecord[],
  root = stateRoot(),
): void {
  const known = new Map<string, Map<number, FollowupOutcome>>();
  const write = stateDb(root).query(
    `INSERT INTO followup_outcomes (repo, pr, record, outcome, at, created)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo, pr) DO UPDATE SET record = excluded.record,
       outcome = excluded.outcome, at = excluded.at, created = excluded.created`,
  );
  for (const r of records) {
    const { record } = r;
    if (record.action !== "followup" || record.pr === null) continue;
    const outcome = outcomeOf(r);
    if (outcome === null) continue;
    let outcomes = known.get(record.repo);
    if (outcomes === undefined) {
      outcomes = readOutcomes(record.repo, root);
      known.set(record.repo, outcomes);
    }
    const written = outcomes.get(record.pr);
    if (written?.record === record.id && written.outcome === outcome) continue;
    // A later attempt's outcome stands over an earlier record that ends after it: ordered by when the record was created, the ids only break a tie (their suffix is random within a second).
    if (written !== undefined && supersedes(written, record)) continue;
    const value: FollowupOutcome = {
      repo: record.repo,
      pr: record.pr,
      record: record.id,
      outcome,
      at: new Date().toISOString(),
      created: record.createdAt,
    };
    write.run(
      value.repo,
      value.pr,
      value.record,
      value.outcome,
      value.at,
      value.created,
    );
    outcomes.set(record.pr, value);
  }
}
