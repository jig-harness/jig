/**
 * The answers to a need's station decision the tick acted on, in the state
 * database's `station_answers` table, one row per answer and framing: the
 * repository, the target, the decision's key and digest, and the answer
 * itself (its comment and the time the reader counted it from). The row is
 * claimed before the step runs (`claimAnswer`), so a step runs once for an
 * answer whatever happens after; its outcome is written when the step ends.
 * A person who answers again writes a new comment, or edits theirs, which
 * makes a new row.
 *
 * A step that starts a session (a follow-up run again, a pickup released)
 * keeps the answer that session is handed (`carry`); the next launch of
 * that target takes it, once (`takeCarried`), and its prompt quotes it.
 */
import { stateRoot } from "../receipts.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { inTransaction, stateDb } from "./state.ts";

/** What a session started on a person's answer is handed: the decision's question, the option chosen and what it states, and the person's note. */
export interface CarriedAnswer {
  question: string;
  option: string;
  recommended: boolean;
  changes: string;
  costs: string;
  note?: string;
  by: string;
  url: string;
}

/** One answer the tick acted on, as its row reads. */
export interface ActedAnswer {
  option: string;
  author: string;
  answer: string;
  /** `null` while the step that claimed it has not written how it ended. */
  outcome: "done" | "refused" | "held" | null;
  detail: string | null;
}

/** An answer's identity: the decision it answers and the comment that gives it. */
export interface AnswerRow {
  repo: string;
  target: string;
  key: string;
  digest: string;
  /** The answer's comment link and the time it was counted from. */
  answer: string;
  author: string;
  option: string;
}

/** Claim `row` for its step: `true` when this call claimed it, `false` when a tick already had. */
export function claimAnswer(row: AnswerRow, root = stateRoot()): boolean {
  const done = stateDb(root)
    .query(
      `INSERT OR IGNORE INTO station_answers
       (repo, target, key, digest, answer, author, option, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.repo,
      row.target,
      row.key,
      row.digest,
      row.answer,
      row.author,
      row.option,
      new Date().toISOString(),
    );
  return done.changes === 1;
}

/** Write how the step on `row` ended, with the answer a session it starts is handed. */
export function finishAnswer(
  row: AnswerRow,
  outcome: "done" | "refused" | "held",
  detail: string,
  carry: CarriedAnswer | null,
  root = stateRoot(),
): void {
  stateDb(root)
    .query(
      `UPDATE station_answers SET outcome = ?, detail = ?, carry = ?
       WHERE repo = ? AND target = ? AND key = ? AND digest = ? AND answer = ?`,
    )
    .run(
      outcome,
      detail,
      carry === null ? null : JSON.stringify(carry),
      row.repo,
      row.target,
      row.key,
      row.digest,
      row.answer,
    );
}

/** The row of an answer the tick already claimed; `null` when it has none. */
export function actedAnswer(
  row: Omit<AnswerRow, "author" | "option">,
  root = stateRoot(),
): ActedAnswer | null {
  const found = stateDb(root)
    .query(
      `SELECT option, author, answer, outcome, detail FROM station_answers
       WHERE repo = ? AND target = ? AND key = ? AND digest = ? AND answer = ?`,
    )
    .get(row.repo, row.target, row.key, row.digest, row.answer) as {
    option: string;
    author: string;
    answer: string;
    outcome: string | null;
    detail: string | null;
  } | null;
  if (found === null) return null;
  const outcome =
    found.outcome === "done" ||
    found.outcome === "refused" ||
    found.outcome === "held"
      ? found.outcome
      : null;
  return { ...found, outcome };
}

function carriedOf(json: string | null): CarriedAnswer | null {
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    swallow(
      err,
      "a carried answer kept with a station answer does not read as JSON",
    );
    return null;
  }
  return isCarriedAnswer(value) ? value : null;
}

/** Whether a value is a carried answer, as a launch record reads it back. */
export function isCarriedAnswer(value: unknown): value is CarriedAnswer {
  return (
    isMapping(value) &&
    ["question", "option", "changes", "costs", "by", "url"].every(
      (k) => typeof value[k] === "string",
    ) &&
    typeof value.recommended === "boolean" &&
    (value.note === undefined || typeof value.note === "string")
  );
}

/**
 * The answer the next session of `target` is handed, taken for the launch
 * record `record`: the newest carried answer no launch has taken. `null`
 * when there is none.
 */
export function takeCarried(
  repo: string,
  target: string,
  record: string,
  root = stateRoot(),
): CarriedAnswer | null {
  const db = stateDb(root);
  return inTransaction(db, () => {
    const found = db
      .query(
        `SELECT rowid, carry FROM station_answers
         WHERE repo = ? AND target = ? AND carry IS NOT NULL AND consumed_by IS NULL
         ORDER BY claimed_at DESC, rowid DESC LIMIT 1`,
      )
      .get(repo, target) as { rowid: number; carry: string } | null;
    if (found === null) return null;
    db.query("UPDATE station_answers SET consumed_by = ? WHERE rowid = ?").run(
      record,
      found.rowid,
    );
    return carriedOf(found.carry);
  });
}

/** The answer a person gave the decision this target's earlier session stopped on, taken for launch record `id`, as the record carries it; nothing when there is none. */
export function carried(
  repo: string,
  target: string,
  id: string,
  root = stateRoot(),
): { answered?: CarriedAnswer } {
  const answered = takeCarried(repo, target, id, root);
  return answered === null ? {} : { answered };
}
