/** Backward-compatible validation of optional launch-record fields. */
import { isMapping } from "../../shared/config-layers.ts";
import { isStandingAnswer } from "./routine-questions.ts";

function optionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/** Whether a value is absent or a time. */
function optionalTime(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)))
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
    ].every((k) => optionalText(value[k])) &&
    [value.marker, value.round].every(
      (v) => v === undefined || v === null || typeof v === "number",
    ) &&
    batchShape(value.batchItems) &&
    optionalStrings(value.claimedItems) &&
    optionalSeconds(value.passTimeoutSec) &&
    (value.rearmConsumed === undefined ||
      typeof value.rearmConsumed === "boolean") &&
    (value.codexBypass === undefined ||
      typeof value.codexBypass === "boolean") &&
    (value.headless === undefined || typeof value.headless === "boolean") &&
    (value.routineTags === undefined ||
      typeof value.routineTags === "boolean") &&
    (value.standing === undefined ||
      value.standing === null ||
      isStandingAnswer(value.standing)) &&
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
