/**
 * The framed decision a dispatched follow-up's or pickup's pass records with
 * its `failed` result when it stops for a person (`jig dispatch result …
 * failed --decision`): the same `parked-decision/v1` record a drive's park
 * holds, checked by the same checker, with the digest computed once, when it
 * is recorded, and the time. It is kept in the launch record's
 * `result_decision` column, written by the same update as the result, and
 * read back by the tick, which shows it as the need's decision.
 */
import { decisionDigest } from "../../shared/decisions/digest.ts";
import {
  checkParkedDecision,
  DECISION_BYTE_LIMIT,
  isParkedDecision,
  type ParkedDecision,
} from "../../shared/decisions/park.ts";
import { STATION_CLASSES } from "../../shared/decisions/station.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";

/** A session's framed decision as the launch record keeps it. */
export interface FramedResult {
  decision: ParkedDecision;
  /** The first 12 hexadecimal characters of its canonical SHA-256 (`decisionDigest`). */
  digest: string;
  /** When it was recorded: an answer counts only when it is later. */
  at: string;
}

/**
 * The decision `text` holds, checked as a park's is, or why it is refused:
 * not JSON, over the size a decision may have, no class or a class the
 * dispatcher keeps for its own framings, or anything `checkParkedDecision`
 * names.
 */
export function framedResultOf(
  text: string,
  at: string,
): Outcome<FramedResult, "invalid"> {
  if (new TextEncoder().encode(text).length > DECISION_BYTE_LIMIT)
    return failed(
      "invalid",
      `the decision is over ${DECISION_BYTE_LIMIT} bytes; shorten its text`,
    );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return failed(
      "invalid",
      `the decision is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const declared =
    isMapping(value) && typeof value.class === "string" ? value.class : "";
  if (declared.trim() === "")
    return failed(
      "invalid",
      "$.class: name the registry class the decision falls in (scope, human-decision, release, destructive, …)",
    );
  if (Object.values(STATION_CLASSES).includes(declared))
    return failed(
      "invalid",
      `$.class: ${declared} is the dispatcher's own framing; use the registry class the decision falls in (scope, human-decision, release, destructive, …)`,
    );
  const problems = checkParkedDecision(value, declared);
  if (problems.length > 0 || !isParkedDecision(value))
    return failed("invalid", problems.join("; "));
  return ok({ decision: value, digest: decisionDigest(value), at });
}

/** A kept decision as a reader takes it; `null` for none, or one that does not read. */
function readFramedResult(
  json: string | null | undefined,
): FramedResult | null {
  if (json == null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    swallow(
      err,
      "a framed decision kept with a launch record does not read as JSON",
    );
    return null;
  }
  return isMapping(value) &&
    isParkedDecision(value.decision) &&
    typeof value.digest === "string" &&
    typeof value.at === "string"
    ? { decision: value.decision, digest: value.digest, at: value.at }
    : null;
}

/** A launch row's kept decision, as a read record carries it: absent when it has none. */
export function framedOf(json: string | null | undefined): {
  framed?: FramedResult;
} {
  const framed = readFramedResult(json);
  return framed === null ? {} : { framed };
}
