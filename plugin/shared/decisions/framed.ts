/**
 * The check a decision a pass frames for a person passes, wherever the pass
 * records it (`jig dispatch result … failed --decision`, a closing report's
 * `decision`): a `parked-decision/v1` record under a registry class it
 * names, never a class the dispatcher keeps for its own framings, checked by
 * the park's own checker.
 */
import { checkParkedDecision } from "./park.ts";
import { STATION_CLASSES } from "./station.ts";

/** Every problem with `value` as a pass's framed decision, each with its JSON path; none when it passes. */
export function framedDecisionProblems(value: unknown): string[] {
  const declared =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { class?: unknown }).class === "string"
      ? (value as { class: string }).class
      : "";
  if (declared.trim() === "")
    return [
      "$.class: name the registry class the decision falls in (scope, human-decision, release, destructive, …)",
    ];
  if (Object.values(STATION_CLASSES).includes(declared))
    return [
      `$.class: ${declared} is the dispatcher's own framing; use the registry class the decision falls in (scope, human-decision, release, destructive, …)`,
    ];
  return checkParkedDecision(value, declared);
}
