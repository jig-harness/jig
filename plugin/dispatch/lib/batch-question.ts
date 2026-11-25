/**
 * Which members of a batch pickup its ended pass's question names. A batch
 * is one launch record for several items; the question it ended on is about
 * the members it names, or about the whole batch when it names none. Both
 * the hold (`actions/pickup-hold.ts`), which releases the members a question
 * is not about, and the plan (`plan-pickups.ts`), which attributes the
 * question, read this one policy.
 */
import { ANY_KEY_SOURCE } from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import { endedQuestion } from "./pickup-host-fault.ts";
import type { ReadRecord } from "./launches.ts";
import { reportQuestion } from "./report-needs.ts";

/**
 * The keys of the members `r`'s question names, in member order: none when
 * it is about the whole batch. `null` when `r` is not a batch of several
 * members or ended on no question.
 */
export function namedMembers(r: ReadRecord): string[] | null {
  const members = r.record.batchItems;
  if (members === undefined || members.length < 2) return null;
  const asked = endedQuestion(r);
  if (asked === null) return null;
  const question = reportQuestion(r.report, asked);
  const keys = new Set(
    question.toUpperCase().match(new RegExp(ANY_KEY_SOURCE, "gi")),
  );
  return members.map((m) => m.key).filter((key) => keys.has(key.toUpperCase()));
}

/** Whether `r` ended on a question about the whole batch, which names no member. */
export function wholeBatchQuestion(r: ReadRecord): boolean {
  return namedMembers(r)?.length === 0;
}
