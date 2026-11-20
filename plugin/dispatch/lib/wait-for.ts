/**
 * What a `waits` result waits for (`jig dispatch result … waits --reason`):
 * a rate limit's reset, or a follow-up's arm still pending, such as a
 * release run still going or a deploy not started. The launch row keeps it
 * in `result_wait` as JSON; a wait written before it was kept, or whose
 * value does not read, is a rate limit's, the one wait there was then.
 */
import {
  readPickupCondition,
  type PickupCondition,
} from "./pickup-condition.ts";
import { isMapping } from "../../shared/config-layers.ts";

/** What a `waits` result waits for. */
export type WaitReason = "rate-limit" | "pending";

/** The reasons `jig dispatch result … waits --reason` takes. */
export const WAIT_REASONS: readonly WaitReason[] = ["rate-limit", "pending"];

/** The longest arm name a pending wait keeps, in characters. */
export const ARM_MAX = 200;

/** What a `waits` result waits for, and, for a pending arm, the pass's words for it when it named one. */
export interface WaitFor {
  reason: WaitReason | "pickup-condition";
  arm?: string;
  condition?: PickupCondition;
}

/** A rate limit's reset. */
export const RATE_LIMIT_WAIT: WaitFor = { reason: "rate-limit" };

/** A row's `result_wait` as a wait; a rate limit's for one that is absent or does not read. */
export function readWaitFor(text: string | null | undefined): WaitFor {
  if (text === null || text === undefined) return RATE_LIMIT_WAIT;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return RATE_LIMIT_WAIT;
  }
  if (!isMapping(value)) return RATE_LIMIT_WAIT;
  const condition = readPickupCondition(value.condition);
  if (value.reason === "pickup-condition" && condition !== null)
    return { reason: value.reason, condition };
  if (value.reason !== "pending") return RATE_LIMIT_WAIT;
  return typeof value.arm === "string" && value.arm !== ""
    ? { reason: "pending", arm: value.arm }
    : { reason: "pending" };
}

/** The arm a pending wait names, in words: `the arm <name>`, or `an arm` when it named none. */
export function armWords(wait: WaitFor): string {
  return wait.arm === undefined ? "an arm" : `the arm ${wait.arm}`;
}
