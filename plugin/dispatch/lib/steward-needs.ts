/** A continuing need keeps its steward framing while its cause is unchanged. */
import type { NeedAct } from "../../shared/acts.ts";
import type { Action } from "./types.ts";

interface NeedRecord {
  kind: "need";
  target: string;
  act: NeedAct;
  ask: string;
  reason: string;
}

/** Match the original cause and question; a new question requires new judgement. */
export function projectStewardNeed(
  actions: readonly Action[],
  record: NeedRecord,
  source: readonly Action[],
): void {
  const original = source.find(
    (a) => a.stage === "notify" && a.target === record.target,
  );
  if (!original) return;
  for (const action of actions) {
    if (action.stage !== "notify" || identity(action) !== identity(original))
      continue;
    action.evidence.stewardAsk = record.ask;
    action.evidence.stewardAct = record.act;
    action.reason = `${record.ask} ${record.reason}`;
  }
}

function identity(action: Action): string {
  return JSON.stringify([
    action.target,
    action.cause,
    action.evidence.question ?? null,
    action.evidence.record ?? null,
    action.evidence.stuck ?? null,
    action.evidence.class ?? null,
    action.evidence.head ?? null,
    action.evidence.exit ?? null,
  ]);
}
