/** Convert one sheet call to the smaller decision a drive can park. */
import {
  checkParkedDecision,
  type ParkedDecision,
  type ParkedOption,
} from "../../../../shared/decisions/park.ts";
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import { plainSource, plainText } from "./refs.ts";
import type { DecisionSource, Option } from "./source.ts";

export interface ParkContext {
  class?: string;
  steps?: string[];
  alreadyDone?: string;
  sheet?: string;
}

/** A sheet's scenario outcomes belong on the sheet, not in the park. */
function parkedOption(option: Option): ParkedOption {
  return {
    id: option.id,
    name: option.name,
    summary: option.summary,
    pay: option.pay,
    keep: option.keep,
    rightWhen: option.rightWhen,
    ...(option.tag === undefined ? {} : { tag: option.tag }),
    ...(option.obligation === undefined
      ? {}
      : { obligation: option.obligation }),
  };
}

/**
 * The call's question wins; a sheet-wide description becomes one line ending
 * with a question mark. The park carries the sheet URL for its wider context.
 */
export function parkFromSheet(
  source: DecisionSource,
  callId: string,
  context: ParkContext = {},
): Outcome<
  ParkedDecision,
  "invalid-call" | "no-recommendation" | "invalid-decision"
> {
  const sheet = plainSource(source);
  const call = sheet.calls.find((candidate) => candidate.id === callId);
  if (call === undefined)
    return failed("invalid-call", `the sheet has no call '${callId}'`);
  if (call.recommended === undefined)
    return failed(
      "no-recommendation",
      `call '${callId}' has no recommendation to park`,
    );
  let question = (call.question ?? sheet.question ?? sheet.title)
    .trim()
    .split(/\s/)
    .filter((part) => part !== "")
    .join(" ");
  while (question.endsWith(".") || question.endsWith("!"))
    question = question.slice(0, -1);
  const decision: ParkedDecision = {
    schema: "parked-decision/v1",
    class: context.class ?? "escalated",
    call: {
      id: "a",
      question: question.endsWith("?") ? question : `${question}?`,
      options: call.options.map(parkedOption),
      recommended: call.recommended,
      why: call.why ?? "",
    },
    steps: (context.steps ?? []).map(plainText),
    alreadyDone: plainText(
      context.alreadyDone ??
        `Prepared decision sheet ${sheet.id}, with facts verified at ${sheet.verifiedAt.date} (${sheet.verifiedAt.commit}).`,
    ),
    sheet: context.sheet ?? sheet.url,
    ...(call.facts === undefined ? {} : { facts: call.facts }),
    ...(sheet.interplay === undefined ? {} : { interplay: sheet.interplay }),
  };
  const problems = checkParkedDecision(decision, decision.class);
  return problems.length === 0
    ? ok(decision)
    : failed(
        "invalid-decision",
        `call '${callId}' cannot be parked:\n${problems.join("\n")}`,
      );
}
