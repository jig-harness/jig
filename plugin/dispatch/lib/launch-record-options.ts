/** Backward-compatible validation of optional launch-record fields. */
import { isMapping } from "../../shared/config-layers.ts";
import { isStandingAnswer } from "./routine-questions.ts";
import { isCarriedAnswer } from "./station-answer-store.ts";
import { HARNESS_VENDOR, type Harness } from "./provider-environment.ts";
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
    optionalProvider(value) &&
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
    [undefined, "hold", "start"].includes(value.missingPriority as string) &&
    (value.stewardDecision === undefined ||
      Number.isSafeInteger(value.stewardDecision)) &&
    [
      value.ancestors,
      value.claimedItems,
      value.releasedItems,
      value.codexPassArgs,
      value.routineClasses,
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

/** Whether `provider` is absent, or a complete record whose harness is the record's vendor's own. */
function optionalProvider(value: Record<string, unknown>): boolean {
  const p = value.provider;
  if (p === undefined) return true;
  if (!isMapping(p)) return false;
  const harness = p.harness;
  return (
    typeof harness === "string" &&
    Object.hasOwn(HARNESS_VENDOR, harness) &&
    HARNESS_VENDOR[harness as Harness] === value.vendor &&
    typeof p.provider === "string" &&
    typeof p.identity === "string" &&
    (p.baseUrl === null || typeof p.baseUrl === "string")
  );
}

export function isWorkspace(value: unknown): boolean {
  return (
    value === null ||
    (isMapping(value) &&
      typeof value.id === "string" &&
      typeof value.path === "string" &&
      (value.branch === undefined || typeof value.branch === "string"))
  );
}

export function hasStrings(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  return keys.every((k) => typeof value[k] === "string");
}

export function isAttempt(value: unknown): boolean {
  return (
    isMapping(value) &&
    typeof value.at === "string" &&
    ["sent", "failed", "lost"].includes(value.outcome as string) &&
    typeof value.detail === "string"
  );
}

/** What a record names: a pull request for a drive or a follow-up, an item for a pickup. */
export function namesTarget(value: Record<string, unknown>): boolean {
  if (value.action === "steward")
    return value.pr === null && value.item === null;
  if (value.action === "pickup")
    return typeof value.item === "string" && value.item !== "";
  return (
    (value.action === "rearm" ||
      value.action === "takeover" ||
      value.action === "followup") &&
    typeof value.pr === "number"
  );
}
