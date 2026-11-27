/**
 * The machine file's `not_settled:` section: how the tick paces re-arms of a
 * drive that keeps stopping `NOT_SETTLED` (exit `4`, not judgeable yet) on
 * one pull request head (`repeated-ends.ts`).
 *
 * ```yaml
 * not_settled:
 *   backoff: 15m      # the wait after the first such end on a head, doubled after each one
 *   notify_after: 3   # such ends on one head at which the drive is a person's
 * ```
 */
import { isMapping } from "../../shared/config-layers.ts";
import { ok } from "../../shared/outcome.ts";
import { duration } from "./duration.ts";
import { type Checked, count, invalid, only } from "./machine-values.ts";
import {
  NOT_SETTLED_ENDS_KEPT,
  NOT_SETTLED_REARMS,
} from "./repeated-end-caps.ts";

export interface NotSettledSettings {
  /** The wait after the first re-arm that stopped `NOT_SETTLED` on a head, doubling with each one after it. */
  backoffMs: number;
  /** The re-arms in a row that may stop `NOT_SETTLED` on one head before the drive is a person's. */
  notifyAfter: number;
}

export const NOT_SETTLED_DEFAULTS: NotSettledSettings = {
  backoffMs: 15 * 60_000,
  notifyAfter: NOT_SETTLED_REARMS,
};

const KEYS = ["backoff", "notify_after"];

/** The `not_settled` settings, each defaulted; a count past what launch-record retention keeps is refused. */
export function notSettledSettings(
  value: unknown,
): Checked<NotSettledSettings> {
  if (value === undefined || value === null)
    return ok({ ...NOT_SETTLED_DEFAULTS });
  if (!isMapping(value)) return invalid("not_settled must be a mapping");
  const known = only(value, KEYS, "not_settled");
  if (!known.ok) return known;
  const backoff =
    value.backoff === undefined || value.backoff === null
      ? ok(NOT_SETTLED_DEFAULTS.backoffMs)
      : duration(value.backoff, "not_settled.backoff");
  if (!backoff.ok) return backoff;
  const notifyAfter = count(
    value.notify_after,
    "not_settled.notify_after",
    NOT_SETTLED_DEFAULTS.notifyAfter,
  );
  if (!notifyAfter.ok) return notifyAfter;
  if (notifyAfter.value > NOT_SETTLED_ENDS_KEPT)
    return invalid(
      `not_settled.notify_after must be at most ${NOT_SETTLED_ENDS_KEPT}, the re-arms each pull request's launch records keep`,
    );
  return ok({ backoffMs: backoff.value, notifyAfter: notifyAfter.value });
}
