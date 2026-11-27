/**
 * A person's request for one steward pass, kept on the host that owns the
 * repository: `jig send steward@owner/name start` writes it, and that
 * host's tick reads it. A request starts a pass whatever the judgment
 * backlog holds, under the rules a pass the backlog starts is held to: one
 * pass holding the repository at a time, and the host's budget of passes in
 * a rolling hour. The tick takes the request once it started the pass or a
 * rule refused it, writing an outcome-log row that names which; a request
 * the tick could not act on yet (a read that failed, no account free) stays
 * for the next tick.
 */
import type { Database } from "bun:sqlite";
import { attempt, type Outcome } from "../../shared/outcome.ts";
import { currentIso } from "../../shared/time.ts";
import { holds, type ReadRecord } from "./launches.ts";
import { insertRow, type LogRow } from "./log.ts";
import { stateDb, statePath } from "./state.ts";
import { inTransaction } from "../../shared/records/db.ts";
import { stewardBudgetSpent, type StewardRun } from "./steward.ts";

/** One request: the repository, who sent it and when. */
export interface StewardRequest {
  /** `owner/name`, lower-cased as it is kept. */
  repo: string;
  by: string;
  at: string;
}

/** A rule that refuses a steward pass: a pass already holds the repository, or the host's hourly budget is spent. */
export type StewardRule = "held" | "budget";

/** What each rule says when it refuses a pass, on a receipt, the dashboard and a send. */
export const STEWARD_RULES: Readonly<Record<StewardRule, string>> = {
  held: "a steward pass already holds this repository",
  budget: "the host's hourly steward budget is spent",
};

/** The rule that refuses a pass, with its words. */
export interface StewardRefusal {
  rule: StewardRule;
  reason: string;
}

/** Whether a steward pass of `repo` holds its stage now. */
export function stewardHeld(
  records: readonly ReadRecord[],
  repo: string,
): boolean {
  return records.some(
    (r) =>
      r.record.repo.toLowerCase() === repo.toLowerCase() &&
      r.record.action === "steward" &&
      holds(r.state),
  );
}

/**
 * The runs the hourly budget counts: a pass that ended on a sign-in failure
 * or the startup breaker never ran, so it gives its place back.
 */
export function countedRuns(
  records: readonly ReadRecord[],
  runs: readonly StewardRun[],
): StewardRun[] {
  const released = new Set(
    records
      .filter(
        (r) =>
          r.record.action === "steward" &&
          r.state.kind === "ended" &&
          (r.state.exit.startup === "sign-in" ||
            r.state.exit.startup === "breaker"),
      )
      .map((r) => r.record.id),
  );
  return runs.filter((run) => !released.has(run.id));
}

/** The first rule that refuses a pass of `repo` at `now`, or `null` when none does. */
export function stewardRefusal(
  records: readonly ReadRecord[],
  runs: readonly StewardRun[],
  repo: string,
  now: number,
): StewardRefusal | null {
  if (stewardHeld(records, repo))
    return { rule: "held", reason: STEWARD_RULES.held };
  if (stewardBudgetSpent(countedRuns(records, runs), now))
    return { rule: "budget", reason: STEWARD_RULES.budget };
  return null;
}

interface RequestRow {
  repo: string;
  requested_by: string;
  requested_at: string;
}

const requestOf = (row: RequestRow): StewardRequest => ({
  repo: row.repo,
  by: row.requested_by,
  at: row.requested_at,
});

/** The request pending for `repo` in `db`, or `null`; a database from before requests were kept holds none. */
export function pendingStewardRequest(
  db: Database,
  repo: string,
): StewardRequest | null {
  const table = db
    .query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steward_requests'",
    )
    .get();
  if (table === null) return null;
  const row = db
    .query(
      "SELECT repo, requested_by, requested_at FROM steward_requests WHERE repo = ?",
    )
    .get(repo.toLowerCase()) as RequestRow | null;
  return row === null ? null : requestOf(row);
}

/**
 * Keep `by`'s request for a pass of `repo`. A request already pending stands
 * as it is, with its first sender and time: the pass it asks for is one.
 */
export function keepStewardRequest(
  repo: string,
  by: string,
  root?: string,
): Outcome<StewardRequest, "refused"> {
  return attempt(
    "refused",
    `the steward request could not be written to ${statePath(root)}`,
    () => {
      const db = stateDb(root);
      db.query(
        "INSERT INTO steward_requests (repo, requested_by, requested_at) VALUES (?, ?, ?) ON CONFLICT (repo) DO NOTHING",
      ).run(repo.toLowerCase(), by, currentIso());
      return (
        pendingStewardRequest(db, repo) ?? {
          repo: repo.toLowerCase(),
          by,
          at: currentIso(),
        }
      );
    },
  );
}

/**
 * Take `request` and write `row` with it, in one transaction: only the
 * request the tick read is taken, so one sent since stays for the next tick.
 */
export function takeStewardRequest(
  request: StewardRequest,
  row: LogRow,
  root?: string,
): void {
  const db = stateDb(root);
  inTransaction(db, () => {
    db.query(
      "DELETE FROM steward_requests WHERE repo = ? AND requested_at = ?",
    ).run(request.repo, request.at);
    insertRow(db, row);
  });
}

/** The outcome-log row of a request the tick acted on: the pass it started, or the rule that refused it. */
export function requestRow(
  request: StewardRequest,
  slug: string,
  acted: { started: string } | StewardRefusal,
): LogRow {
  const at = currentIso();
  const started = "started" in acted;
  return {
    kind: "event",
    key: `steward-request ${slug} ${request.at}`,
    at,
    repo: slug,
    stage: "steward",
    target: "the steward",
    event: started ? "steward-requested" : "steward-request-refused",
    account: null,
    class: started ? null : "refused",
    reason: started
      ? `started steward pass ${acted.started}, requested by ${request.by} at ${request.at}`
      : `the steward pass ${request.by} requested at ${request.at} was refused: ${acted.reason}`,
  };
}
