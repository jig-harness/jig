/**
 * A follow-up's outcome record, one per merged pull request, in the state
 * database's `followup_outcomes` table (keyed by the repository and the
 * pull request): written by the tick when the launch record of a follow-up
 * it started ends, done or failed, with that launch record's id. The
 * receipts' retention never removes it, so a launch record that expires
 * after a successful follow-up does not turn it into a failure. An outcome
 * counts only for the marker that names its launch record: a later
 * attempt's outcome replaces it when that attempt ends.
 *
 * Beside the outcome it keeps what the pass asked (`asked`, JSON naming the
 * launch record it is of): the question it stopped on, that question's
 * routine class (`routine-questions.ts`) and whether the attempt was itself
 * a run again. A row an earlier release wrote, or one whose record's prompt
 * offered no routine tags, has no class field (`routine` absent), which
 * `routine-reruns.ts` reads as a follow-up that failed before passes tagged
 * their questions. An `asked` column that does not read (not JSON, not a
 * mapping, or naming another launch record) is never read as an earlier
 * release's row: the row says why (`unreadable`), the failure is logged, and
 * the follow-up waits for a person.
 */
import { stateRoot } from "../receipts.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { failureFields } from "../../shared/errors.ts";
import { log } from "../../shared/log.ts";
import type { ReadRecord } from "./launches.ts";
import { routineClassOf } from "./routine-questions.ts";
import { questionOf } from "./session.ts";
import { stateDb } from "./state.ts";
import { isRerun, retryableFollowup } from "./session-startup.ts";

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
  /** The question the pass stopped on; `null` when it stated none; absent on a row that kept none. */
  question?: string | null;
  /** The routine class its question was tagged with, `null` when it carried none; absent when the record's prompt offered no tags (an earlier release's row). */
  routine?: string | null;
  /** Whether the attempt was itself a run again (its facts carry the recovery tag); absent on a row that kept none. */
  rerun?: boolean;
  /** Why the row's `asked` column does not read: it does not parse, is not a mapping, or names another record. Such a row is a person's, never read as an earlier release's. */
  unreadable?: string;
}

/** What a row keeps of the pass's question, as its `asked` column holds it. */
export type Asked = Pick<
  FollowupOutcome,
  "question" | "routine" | "rerun" | "unreadable"
>;

/** The rows this process has warned of, so a row read every tick warns once and is written at debug level after. */
const warnedRows = new Set<string>();

/** A row whose `asked` column does not read, logged with its cause. */
function unreadAsked(record: string, cause: string, error?: unknown): Asked {
  const unreadable = `its outcome record's question does not read (${cause})`;
  const write = warnedRows.has(record) ? log.debug : log.warn;
  warnedRows.add(record);
  write(`follow-up outcome of launch record ${record}: ${unreadable}`, {
    record,
    cause,
    ...(error === undefined ? {} : failureFields(error)),
  });
  return { unreadable };
}

/** The `asked` column of a row of `record`: its fields, none when it is empty (an earlier release's row), or why it does not read. */
function parseAsked(text: string | null, record: string): Asked {
  if (text === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return unreadAsked(record, "it is not JSON", error);
  }
  if (!isMapping(value)) return unreadAsked(record, "it is not a mapping");
  if (value.record !== record)
    return unreadAsked(
      record,
      `it names launch record ${String(value.record)}`,
    );
  return {
    question: typeof value.question === "string" ? value.question : null,
    ...(value.routine === undefined
      ? {}
      : { routine: typeof value.routine === "string" ? value.routine : null }),
    rerun: value.rerun === true,
  };
}

/** The outcome records of `repo`, by pull request. */
export function readOutcomes(
  repo: string,
  root = stateRoot(),
): Map<number, FollowupOutcome> {
  const rows = stateDb(root)
    .query(
      "SELECT repo, pr, record, outcome, at, created, asked FROM followup_outcomes WHERE repo = ?",
    )
    .all(repo) as (FollowupOutcome & { asked: string | null })[];
  return new Map(
    rows.map(({ asked, ...o }) => [
      o.pr,
      { ...o, ...parseAsked(asked, o.record) },
    ]),
  );
}

/** What an ended follow-up record asked: its question, its tag's class where its prompt offered tags, and whether it was a run again. */
export function askedBy(r: ReadRecord): Asked {
  const question = questionOf(r.state);
  return {
    question,
    ...(r.record.routineTags === true
      ? { routine: routineClassOf(question) }
      : {}),
    rerun: isRerun(r.record),
  };
}

/** How an ended follow-up record ended: its session's recorded result, else failed; `null` while it holds, or for a retry (a startup that never began, a first death). */
export function outcomeOf(r: ReadRecord): "done" | "failed" | null {
  if (retryableFollowup(r)) return null;
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
    `INSERT INTO followup_outcomes (repo, pr, record, outcome, at, created, asked)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo, pr) DO UPDATE SET record = excluded.record,
       outcome = excluded.outcome, at = excluded.at, created = excluded.created,
       asked = excluded.asked`,
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
    const asked = askedBy(r);
    const value: FollowupOutcome = {
      repo: record.repo,
      pr: record.pr,
      record: record.id,
      outcome,
      at: new Date().toISOString(),
      created: record.createdAt,
      ...asked,
    };
    write.run(
      value.repo,
      value.pr,
      value.record,
      value.outcome,
      value.at,
      value.created,
      JSON.stringify({ record: record.id, ...asked }),
    );
    outcomes.set(record.pr, value);
  }
}
