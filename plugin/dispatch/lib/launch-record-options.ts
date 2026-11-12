/** Backward-compatible validation of optional launch-record fields. */
import { isMapping } from "../../shared/config-layers.ts";
import { isStandingAnswer } from "./routine-questions.ts";
import { isCarriedAnswer } from "./station-answer-store.ts";
import { parseMs } from "../../shared/time.ts";

function optionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/** Whether a value is absent or a time. */
function optionalTime(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && Number.isFinite(parseMs(value)))
  );
}

/** Whether a value is absent, `null`, or a whole number of seconds. */
function optionalSeconds(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Whether a value is absent or an array whose members are strings. */
function optionalStrings(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((v) => typeof v === "string"))
  );
}

/** The fields a later version added, each absent or of its type. */
export function optionalLaunchFields(value: Record<string, unknown>): boolean {
  return (
    [
      "agentId",
      "model",
      "effort",
      "command",
      "sessionId",
      "mark",
      "rearmLabel",
      "noReplay",
      "servedPerson",
      "ancestorEpic",
      "blockingFor",
      "stewardResume",
      "stewardContext",
      "heads",
    ].every((k) => optionalText(value[k])) &&
    [value.marker, value.round].every(
      (v) => v === undefined || v === null || typeof v === "number",
    ) &&
    batchShape(value.batchItems) &&
    (value.stewardDecision === undefined ||
      Number.isSafeInteger(value.stewardDecision)) &&
    optionalStrings(value.claimedItems) &&
    optionalStrings(value.releasedItems) &&
    optionalSeconds(value.passTimeoutSec) &&
    optionalBooleans(value, [
      "rearmConsumed",
      "pooled",
      "codexBypass",
      "headless",
      "routineTags",
      "launchCalled",
    ]) &&
    (value.standing === undefined ||
      value.standing === null ||
      isStandingAnswer(value.standing)) &&
    (value.answered === undefined || isCarriedAnswer(value.answered)) &&
    optionalTime(value.endedAt) &&
    optionalTime(value.cancelledAt) &&
    optionalTime(value.openedAt) &&
    isRedrive(value.redrive)
  );
}

/** Whether a value is absent, `null`, or a stale cause. */
function isRedrive(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (isMapping(value) &&
      typeof value.cause === "string" &&
      typeof value.change === "string" &&
      (value.earlier === undefined ||
        (Array.isArray(value.earlier) &&
          value.earlier.every((c) => typeof c === "string"))))
  );
}

function batchShape(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (i) =>
          isMapping(i) &&
          typeof i.key === "string" &&
          typeof i.person === "string" &&
          optionalText(i.ancestor),
      ))
  );
}

function optionalBooleans(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  return keys.every(
    (key) => value[key] === undefined || typeof value[key] === "boolean",
  );
}
