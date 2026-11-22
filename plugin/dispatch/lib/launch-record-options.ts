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

/** Whether a value is absent or a positive whole number. */
function optionalPositiveInteger(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
      "factoryAncestor",
      "blockingFor",
      "stewardResume",
      "stewardContext",
      "relaunchOf",
      "relaunchHead",
      "relaunchFault",
      "relaunchDependency",
      "heads",
    ].every((k) => optionalText(value[k])) &&
    [value.marker, value.round].every(
      (v) => v === undefined || v === null || typeof v === "number",
    ) &&
    batchShape(value.batchItems) &&
    (value.stewardDecision === undefined ||
      Number.isSafeInteger(value.stewardDecision)) &&
    [
      value.ancestors,
      value.claimedItems,
      value.releasedItems,
      value.codexPassArgs,
    ].every(optionalStrings) &&
    optionalHostDriverReplacement(value.replacesHostDriver) &&
    [value.passTimeoutSec, value.rerunDied].every(optionalSeconds) &&
    [
      value.followupWithinMs,
      value.accountLaunchOrdinal,
      value.rearmRequestId,
      value.startupFailureThreshold,
    ].every(optionalPositiveInteger) &&
    optionalBooleans(value, [
      "rearmConsumed",
      "pooled",
      "codexBypass",
      "headless",
      "routineTags",
      "launchCalled",
      "relaunchLockWait",
    ]) &&
    (value.standing === undefined ||
      value.standing === null ||
      isStandingAnswer(value.standing)) &&
    (value.answered === undefined || isCarriedAnswer(value.answered)) &&
    [value.endedAt, value.cancelledAt, value.openedAt, value.runEndedAt].every(
      optionalTime,
    ) &&
    optionalTestLockWait(value.testLockWait) &&
    isRedrive(value.redrive)
  );
}

/** Whether a value is absent or identifies the host driver a takeover replaces. */
function optionalHostDriverReplacement(value: unknown): boolean {
  return (
    value === undefined ||
    (isMapping(value) &&
      typeof value.clone === "string" &&
      Number.isSafeInteger(value.pr) &&
      (value.pr as number) > 0 &&
      typeof value.since === "string")
  );
}

/** Whether a value is absent or a stored test-lock observation. */
function optionalTestLockWait(value: unknown): boolean {
  return (
    value === undefined ||
    (isMapping(value) &&
      Number.isSafeInteger(value.pid) &&
      (value.pid as number) > 0 &&
      typeof value.workspace === "string" &&
      typeof value.since === "string" &&
      Number.isFinite(parseMs(value.since)) &&
      typeof value.observedAt === "string" &&
      Number.isFinite(parseMs(value.observedAt)) &&
      typeof value.waiting === "boolean")
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
          optionalText(i.ancestor) &&
          optionalStrings(i.ancestors),
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
