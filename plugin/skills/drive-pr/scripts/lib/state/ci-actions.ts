/** Optional CI telemetry stays separate from the control events older readers validate. */
import { isRecord } from "../../../../../shared/guards.ts";
import { currentIso, parseMs } from "../../../../../shared/time.ts";
import { fail } from "../cli.ts";
import type { StateStore } from "./store.ts";

export interface CiAction {
  at: string;
  round: number;
  action: "rerun" | "repair";
  detail: string;
}
const ACTION_LIMIT = 10;
const DETAIL_LIMIT = 1024;

/** Apply the shared bound after any transformation of telemetry detail. */
export function boundedCiDetail(detail: string): string {
  return detail.slice(0, DETAIL_LIMIT);
}

function isCiAction(v: unknown): v is CiAction {
  return (
    isRecord(v) &&
    typeof v.at === "string" &&
    Number.isFinite(parseMs(v.at)) &&
    Number.isSafeInteger(v.round) &&
    Number(v.round) >= 0 &&
    (v.action === "rerun" || v.action === "repair") &&
    typeof v.detail === "string" &&
    v.detail.length > 0 &&
    v.detail.length <= DETAIL_LIMIT
  );
}

export function isOptionalCiActions(v: unknown): boolean {
  return (
    v === undefined ||
    (Array.isArray(v) && v.length <= ACTION_LIMIT && v.every(isCiAction))
  );
}

/** The CLI keeps its record-event form while writing additive telemetry. */
export async function recordCiAction(
  store: StateStore,
  cause: unknown,
): Promise<number> {
  if (typeof cause !== "string")
    fail(2, "CI action needs rerun: or repair: detail");
  const match = /^(rerun|repair): (.+)$/su.exec(cause);
  if (match === null) fail(2, "CI action needs rerun: or repair: detail");
  await store.update((s) => {
    const action = {
      at: currentIso(),
      round: s.rounds,
      action: match[1],
      detail: boundedCiDetail(match[2] ?? ""),
    };
    if (!isCiAction(action)) fail(2, "CI action needs a nonempty detail");
    return {
      ...s,
      ciActions: [...(s.ciActions ?? []), action].slice(-ACTION_LIMIT),
    };
  });
  return 0;
}
