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
 *   - `stop`: the driver exited, its cause the exit code (`0` converged,
 *     `8` HITL-parked, …) or `unknown` (a thrown refusal or a crash), so a
 *     report reads how the drive last ended from the state as well as from
 *     the ledger. A dry run records none. `leftWork` records, on a stall
 *     and on a pass deadline the driver did not restart from, whether the stop
 *     measured work in its tree that no push carries (uncommitted edits, an
 *     open git operation, unpushed commits), and `tree` names that tree
 *     (`<actor>@<host>`): the dispatcher re-drives such a stop that left
 *     work only in that tree, and a re-arm in that tree inherits the edits as
 *     its own. A stall's stop without `leftWork` was never measured, so it
 *     is read as possibly holding work; a deadline's, written by a driver
 *     that did not record it, is read as holding none.
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
export type EventKind = keyof typeof EVENT_CAUSES | "stop";

export interface DriveEvent {
  at: string;
  round: number;
  kind: EventKind;
  cause: string;
  /** On a `stop`: whether it measured work in its tree that no push carries; absent when it never measured. */
  leftWork?: boolean;
  /** On a `stop` that measured: the tree it ran in, `<actor>@<host>`. */
  tree?: string;
}

/** Whether `cause` is one of the causes of an event of `kind`. */
function isCause(kind: unknown, cause: unknown): boolean {
  if (kind === "stop")
    return typeof cause === "string" && /^(\d+|unknown)$/.test(cause);
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
    (v.round as number) >= 0 &&
    (v.leftWork === undefined ||
      (typeof v.leftWork === "boolean" && v.kind === "stop")) &&
    (v.tree === undefined ||
      (typeof v.tree === "string" && v.tree !== "" && v.kind === "stop"))
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

/**
 * The exit code the drive last stopped with; `null` when none is recorded,
 * or when its last stop's exit is unknown (a thrown refusal or a crash), so
 * an earlier run's exit never speaks for a later one.
 */
export function lastStop(events: readonly DriveEvent[]): number | null {
  const stop = lastStopEvent(events);
  return stop === undefined || stop.cause === "unknown"
    ? null
    : Number(stop.cause);
}

/** The drive's last `stop` event, if it recorded one. */
export function lastStopEvent(
  events: readonly DriveEvent[],
): DriveEvent | undefined {
  return events.findLast((e) => e.kind === "stop");
}

/** `record-event [PR]`: append one event, read as JSON on stdin (`{ "kind", "cause" }`, and `"leftWork"` with `"tree"` on a stop that measured its tree). */
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
      ...(input.leftWork === undefined ? {} : { leftWork: input.leftWork }),
      ...(input.tree === undefined ? {} : { tree: input.tree }),
    };
    if (!isDriveEvent(event))
      fail(
        2,
        `record-event: kind restart (${EVENT_CAUSES.restart.join(", ")}), rearm (${EVENT_CAUSES.rearm.join(", ")}) or stop (the exit code)`,
      );
    return { ...s, events: [...(s.events ?? []), event] };
  });
  return 0;
}
