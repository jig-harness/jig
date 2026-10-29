/**
 * `events`: the drive's recoveries, kept in the drive state and mirrored to
 * the ledger so the morning report and `loop-metrics.ts` can count them for
 * a pull request whichever clone drove it.
 *
 *   - `restart`: the driver restarted itself from a stop that needs no
 *     decision: `pass-deadline` (a pass killed at its deadline) or `stall`
 *     (the one extra round after two passes that changed nothing).
 *   - `rearm`: a stopped drive was picked up again from its durable state:
 *     `quota-account` (another account after a usage wall),
 *     `quota-reset` (the wall's reset passed), `window-reopened` (a person
 *     said the window reopened), `answered` (every parked item answered) or
 *     `provisional` (under `wide`, the unanswered parks handed on to be
 *     decided provisionally).
 *
 * Takeovers have their own record (`takeover.ts`). Optional in a stored
 * state: a file written before the field existed reads as no events.
 */
import { isRecord } from "../../../../../shared/guards.ts";
import { fail } from "../cli.ts";
import type { StateStore } from "./store.ts";

export const EVENT_CAUSES = {
  restart: ["pass-deadline", "stall"],
  rearm: [
    "quota-account",
    "quota-reset",
    "window-reopened",
    "answered",
    "provisional",
  ],
} as const;
export type EventKind = keyof typeof EVENT_CAUSES;

export interface DriveEvent {
  at: string;
  round: number;
  kind: EventKind;
  cause: string;
}

/** Whether `cause` is one of the causes of an event of `kind`. */
function isCause(kind: unknown, cause: unknown): boolean {
  if (kind !== "restart" && kind !== "rearm") return false;
  const causes: readonly unknown[] = EVENT_CAUSES[kind];
  return causes.includes(cause);
}

export function isDriveEvent(v: unknown): v is DriveEvent {
  return (
    isRecord(v) &&
    isCause(v.kind, v.cause) &&
    typeof v.at === "string" &&
    Number.isFinite(Date.parse(v.at)) &&
    Number.isSafeInteger(v.round) &&
    (v.round as number) >= 0
  );
}

export function isOptionalEvents(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every(isDriveEvent));
}

/** How many events of `kind` there are, by cause. */
export function countByCause(
  events: readonly DriveEvent[],
  kind: EventKind,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events)
    if (e.kind === kind) out[e.cause] = (out[e.cause] ?? 0) + 1;
  return out;
}

/** `record-event [PR]`: append one event, read as JSON on stdin (`{ "kind", "cause" }`). */
export async function recordEvent(
  store: StateStore,
  raw: string,
): Promise<number> {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    input = null;
  }
  if (!isRecord(input))
    fail(2, 'record-event reads one JSON object on stdin: {"kind", "cause"}');
  await store.update((s) => {
    const event = {
      at: new Date().toISOString(),
      round: s.rounds,
      kind: input.kind,
      cause: input.cause,
    };
    if (!isDriveEvent(event))
      fail(
        2,
        `record-event: kind restart (${EVENT_CAUSES.restart.join(", ")}) or rearm (${EVENT_CAUSES.rearm.join(", ")})`,
      );
    return { ...s, events: [...(s.events ?? []), event] };
  });
  return 0;
}
