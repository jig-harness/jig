import { isOptionalDrivenBranch } from "./driven-branch.ts";
import { isOptionalTakeovers } from "./takeover.ts";
import { isOptionalDecisions } from "./decisions.ts";
import { isOptionalEvents } from "./events.ts";
import { isOptionalRulings } from "./rulings.ts";
import { isOptionalRetryCount } from "./deadline-retries.ts";
import { isOptionalLadderVerdicts } from "./ladder-verdict-model.ts";
import { isOptionalResolvedParks } from "./resolution-receipt.ts";

/** The fields a stored state may lack: absent, or well-formed. */
export function hasUsableOptionalFields(s: Record<string, unknown>): boolean {
  return [
    isOptionalDrivenBranch(s.drivenBranch),
    isOptionalTakeovers(s.takeovers),
    isOptionalRetryCount(s.deadlineRetries),
    isOptionalDecisions(s.decisions),
    isOptionalEvents(s.events),
    isOptionalRulings(s.rulings),
    isOptionalLadderVerdicts(s.ladderVerdicts),
    isOptionalResolvedParks(s.resolvedParks),
    s.resolvedParksLost === undefined ||
      typeof s.resolvedParksLost === "boolean",
    s.ledgerGeneration === undefined ||
      (typeof s.ledgerGeneration === "number" &&
        Number.isInteger(s.ledgerGeneration) &&
        s.ledgerGeneration >= 0),
  ].every(Boolean);
}
