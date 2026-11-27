/**
 * The needs an item's latest ended pickup raises: the question it stopped
 * on, notified once per launch record, and the need that asks whether to
 * pick it up again when it ended with none. A batch's question belongs on
 * the member it names, or on the anchor when it names none.
 */
import { pickupNotice } from "./notices.ts";
import {
  reportEvidence,
  reportFramed,
  reportQuestion,
} from "./report-needs.ts";
import { endedHow } from "./actions/pickup-hold.ts";
import { endedQuestion } from "./pickup-host-fault.ts";
import { namedMembers } from "./batch-question.ts";
import { unwrittenResult } from "./session-startup.ts";
import type { ReadRecord } from "./launches.ts";
import type { PickupInput } from "./plan-pickups.ts";
import type { Action, WantedItem } from "./types.ts";

/**
 * The need an item raises when its latest pickup ended without a question
 * and no rule starts it again: notified once per launch record, framed with
 * the step a person may take (release the record, or leave it).
 */
export function endedNeed(
  slug: string,
  item: Pick<WantedItem, "key" | "title" | "state">,
  latest: ReadRecord,
  why: string,
): Action {
  const { record } = latest;
  const sibling = batchQuestionForSibling(latest, item.key);
  const reason = sibling
    ? "the ended batch pickup still holds this member; it can be released from the batch"
    : `the pickup ended without moving it on, and no rule starts it again: ${why}`;
  return {
    stage: "notify",
    target: item.key,
    record: "runtime",
    reason,
    evidence: {
      record: record.id,
      stage: "pickup",
      title: item.title,
      state: item.state,
      account: record.account,
      ...(sibling
        ? {}
        : { ended: endedHow(latest), ...reportEvidence(latest.report) }),
    },
    cause: "pickup-ended",
    ...(sibling
      ? {}
      : {
          notice: pickupNotice(
            slug,
            `${item.key} pickup ended, record ${record.id}`,
            `${item.key} (${item.title}): ${reason}; a person picks it up again or leaves it`,
          ),
        }),
    ...(record.workspace === null ? {} : { workspace: record.workspace.path }),
    // The pass's ended row in the outcome log already holds how it ended.
    launched: true,
  };
}

/**
 * Whether a batch question belongs elsewhere. With no named member, its
 * anchor carries the batch's question. The anchor stays fixed after release
 * so an answered question cannot reappear on a sibling.
 */
export function batchQuestionForSibling(
  latest: ReadRecord,
  item: string,
): boolean {
  const named = namedMembers(latest);
  if (named === null) return false;
  return named.length > 0 ? !named.includes(item) : latest.record.item !== item;
}

/**
 * The question a pickup's latest record asks. Where the host could not write
 * the result, one the pass managed to frame or report is kept, and otherwise
 * a person is asked to settle or release the item.
 */
function resultQuestion(
  latest: ReadRecord,
  key: string,
  unwritten: boolean,
  hasDecision: boolean,
): string | null {
  if (!unwritten) return endedQuestion(latest);
  if (!hasDecision)
    return `Should ${key} be settled or released, whose pickup ended without a result this host could write?`;
  return (
    latest.report?.report.question ??
    latest.framed?.decision.call.question ??
    endedQuestion(latest)
  );
}

/**
 * The need an item's latest pickup raises when its pass ended on a
 * question without recording `done`: the question, notified once per
 * launch record; `null` otherwise. A pass whose result or exit the host
 * could not write (`unwritten-result.ts`) asks nothing of its own: it is a
 * host fault (`hostFaultStop`), and only where the relaunch rule does not
 * take it (`dispatch.stalled_relaunch: never`, a batch's or an interactive
 * pickup) is a person asked to settle or release the item once the host's
 * health check passes.
 */
export function questionAsked(
  input: Pick<PickupInput, "slug" | "rerunsHeld">,
  item: { key: string; title: string; state: string },
  latest: ReadRecord,
  /** The anchor cannot show a whole-batch question, so this sibling carries it. */
  forSibling = false,
): Action | null {
  const { slug } = input;
  const unwritten = unwrittenResult(latest);
  if (unwritten && (input.rerunsHeld ?? null) !== null) return null;
  const hasDecision =
    latest.framed !== undefined || latest.report?.report.decision !== undefined;
  // Without a decision the pass framed, an unwritten result gets the generic prompt.
  const generic = unwritten && !hasDecision;
  const asked = resultQuestion(latest, item.key, unwritten, hasDecision);
  if (
    asked === null ||
    (!generic && !forSibling && batchQuestionForSibling(latest, item.key))
  )
    return null;
  const report = generic ? null : latest.report;
  const question = reportQuestion(report, asked);
  const framed = generic ? undefined : reportFramed(latest.framed, report);
  const { record } = latest;
  const reason = generic
    ? `the pickup ended without a result: this host could not write it (since ${latest.unwritten}), and its health check passes again, but the relaunch rule did not take it: ${question}`
    : `the pickup stopped on a question for a person: ${question}`;
  return {
    stage: "notify",
    target: item.key,
    record: "runtime",
    reason,
    evidence: {
      record: record.id,
      stage: "pickup",
      title: item.title,
      state: item.state,
      account: record.account,
      question,
      ...reportEvidence(report),
    },
    cause: "pickup-question",
    ...(framed === undefined ? {} : { framed }),
    notice: pickupNotice(
      slug,
      `${item.key} question, record ${record.id}`,
      `${item.key} (${item.title}): ${reason}; nothing starts for it until the item leaves the dispatch states and comes back`,
    ),
    ...(record.workspace === null ? {} : { workspace: record.workspace.path }),
    // The pass's ended row in the outcome log already holds how it ended.
    launched: true,
  };
}
