/**
 * `events`: the drive's recoveries, kept in the drive state and mirrored to
 * the ledger so the morning report and `loop-metrics.ts` can count them for
 * a pull request whichever clone drove it.
 *
 *   - `restart`: the driver restarted itself from a stop that needs no
 *     decision: `pass-deadline` (a pass killed at its deadline),
 *     `background-pending` (a pass that ended with a background task still
 *     running) or `stall` (the one extra round after two passes that changed
 *     nothing).
 *   - `rearm`: a stopped drive was picked up again from its durable state:
 *     `quota-account` (another account after a usage wall),
 *     `quota-reset` (the wall's reset passed), `window-reopened` (a person
 *     said the window reopened), `answered` (every parked item answered) or
 *     `provisional` (under `wide`, the unanswered parks handed on to be
 *     decided provisionally).
 *   - `stop`: the driver exited, its cause the exit code (`0` converged,
 *     `8` HITL-parked, …) or `unknown` (a thrown refusal or a crash), so a
 *     report reads how the drive last ended from the state as well as from
 *     the ledger. A dry run records none. `leftWork` records, on a stall,
 *     check-runs listing stop and pass deadline the driver did not restart
 *     from, whether the stop
 *     measured work in its tree that no push carries (uncommitted edits, an
 *     open git operation, unpushed commits), and `tree` names that tree
 *     (`<actor>@<host>`): the dispatcher re-drives such a stop that left
 *     work only in that tree, and a re-arm in that tree inherits the edits as
 *     its own. A stall or listing stop without `leftWork` was never measured,
 *     so it is read as possibly holding work; a deadline's, written by a
 *     driver that did not record it, is read as holding none. `listingPages`
 *     records, on a `CHECK_RUNS_UNREADABLE` stop, how many pages of the
 *     head's check-runs listing were read. `until` records, on
 *     a stop on the forge's spent rate limit, when the limit resets: the
 *     dispatcher re-drives it from then. `finish` records, on a stall
 *     whose passes all ended `finish-round.ts` on the same state, that state
 *     and the last pass's reason (`round-finish.ts`): the dispatcher hands a
 *     stall held by a failed push to a person rather than re-driving it onto
 *     the same refusal, and the ledger's summary names it.
 *
 * Takeovers have their own record (`takeover.ts`). Optional in a stored
 * state: a file written before the field existed reads as no events.
 */
import { isRecord } from "../../../../../shared/guards.ts";
import { redactReportText } from "../../../../../shared/closing-report.ts";
import { fail } from "../cli.ts";
import type { StateStore } from "./store.ts";
import { currentIso, parseMs } from "../../../../../shared/time.ts";
import { probeStopOf } from "../status/probe-stop.ts";
import { recordCiAction } from "./ci-actions.ts";

import { EVENT_CAUSES } from "./ledger-values.ts";
export { EVENT_CAUSES } from "./ledger-values.ts";
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
  /** Commit whose reviewer failed, witnessed by the status probe. */
  reviewerHead?: string;
  /** GitHub App that owns the reviewer check, when configured. */
  reviewerApp?: string;
  /** On a `stop` for a check-runs listing cut short: the pages it read. */
  listingPages?: number;
  /** On a `stop` on the forge's spent rate limit: when the limit resets, an instant. The ledger's shape leaves the field open, so a reader takes it only when it is an instant (`stopInstant`) and a malformed value never makes the ledger unreadable. */
  until?: unknown;
  /** A status probe report on a stop whose exit was passed through. */
  probe?: unknown;
  /** On a stall's `stop`: the `finish-round.ts` state every stalled pass ended on, with the last reason. The ledger's shape leaves it open, so a reader takes it only when it is one (`stopFinish`) and a malformed value never makes the ledger unreadable. */
  finish?: unknown;
}

/** The finish a stall's passes shared (`round-finish.ts`'s `sharedFinish`). */
export interface StopFinish {
  state: string;
  reason: string;
}

/** The longest finish reason a stop event keeps. */
export const STOP_FINISH_REASON_MAX = 1000;

/** Whether `v` is a finish a stop event may carry. */
export function isStopFinish(v: unknown): v is StopFinish {
  return (
    isRecord(v) &&
    typeof v.state === "string" &&
    /^[A-Z][A-Z_]*$/.test(v.state) &&
    typeof v.reason === "string" &&
    v.reason.length <= STOP_FINISH_REASON_MAX
  );
}

/** The finish a stop event records, cut to the kept length; `undefined` for none. */
export function stopFinishOf(
  finish: { state: string; reason: string } | null | undefined,
): StopFinish | undefined {
  if (finish === null || finish === undefined) return undefined;
  const kept = {
    state: finish.state,
    reason:
      finish.reason.length > STOP_FINISH_REASON_MAX
        ? `${finish.reason.slice(0, STOP_FINISH_REASON_MAX - 1)}…`
        : finish.reason,
  };
  return isStopFinish(kept) ? kept : undefined;
}

/** The finish the drive's last stop recorded, when that stop is the one with `exit` and the finish reads as one; `null` otherwise. */
export function stopFinish(
  events: readonly DriveEvent[] | undefined,
  exit: number | null | undefined,
): StopFinish | null {
  const stop = lastStopEvent(events ?? []);
  if (exit === null || exit === undefined || stop?.cause !== String(exit))
    return null;
  return isStopFinish(stop.finish) ? stop.finish : null;
}

/**
 * The ledger summary's line for a stopped drive whose last stop recorded a
 * finish, a `@` in its reason kept from mentioning anyone where the forge
 * renders it; `null` when there is none.
 */
export function stopFinishSummary(
  events: readonly DriveEvent[] | undefined,
  driver: { state: string; exit?: number | null },
): string | null {
  const finish =
    driver.state === "stopped" ? stopFinish(events, driver.exit) : null;
  if (finish === null) return null;
  return `Every stalled pass ended \`${finish.state}\`: ${withoutMentions(finish.reason)}`;
}

/** `text` with each `@` that would mention a forge login or team broken by a zero-width space. */
export function withoutMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9])/g, "@\u200B");
}

/** `event` with its stall finish's reason redacted as a report's is, and cut back to the kept length; a finish that does not read as one is dropped. */
export function redactedFinish(event: DriveEvent): DriveEvent {
  if (event.finish === undefined) return event;
  const { finish, ...rest } = event;
  const kept = isStopFinish(finish)
    ? stopFinishOf({ ...finish, reason: redactReportText(finish.reason) })
    : undefined;
  return kept === undefined ? rest : { ...rest, finish: kept };
}

/** What a ledger's `cut` names when its older stops' finish details were dropped. */
export const OLDER_FINISH_DETAILS_CUT = "the older finish details";

/**
 * `ledger` with every finish but the newest stop's dropped, or `ledger` itself
 * when there is none to drop. The newest finish explains the current state;
 * older finish prose is history that can grow until the forge refuses the
 * whole ledger.
 */
export function withOlderFinishesCut<
  L extends { events?: readonly DriveEvent[]; cut: readonly string[] },
>(ledger: L): L {
  const events = ledger.events ?? [];
  const latest = events.findLastIndex(
    (event) => event.kind === "stop" && event.finish !== undefined,
  );
  if (!events.some((e, i) => i !== latest && e.finish !== undefined))
    return ledger;
  return {
    ...ledger,
    events: events.map((event, index) => {
      if (index === latest || event.finish === undefined) return event;
      const { finish: _finish, ...withoutFinish } = event;
      return withoutFinish;
    }),
    cut: [...ledger.cut, OLDER_FINISH_DETAILS_CUT],
  };
}

/** Whether `cause` is one of the causes of an event of `kind`. */
function isCause(kind: unknown, cause: unknown): boolean {
  if (kind === "stop")
    return typeof cause === "string" && /^(\d+|unknown)$/.test(cause);
  if (kind !== "restart" && kind !== "rearm") return false;
  const causes: readonly unknown[] = EVENT_CAUSES[kind];
  return causes.includes(cause);
}

/** Whether the optional field `value` of an event of `kind` is absent, or valid and on a `stop`. */
function stopOnly(kind: unknown, value: unknown, valid: boolean): boolean {
  return value === undefined || (valid && kind === "stop");
}

export function isDriveEvent(v: unknown): v is DriveEvent {
  return (
    isRecord(v) &&
    isCause(v.kind, v.cause) &&
    typeof v.at === "string" &&
    Number.isFinite(parseMs(v.at)) &&
    Number.isSafeInteger(v.round) &&
    (v.round as number) >= 0 &&
    stopOnly(
      v.kind,
      v.listingPages,
      Number.isSafeInteger(v.listingPages) && (v.listingPages as number) >= 0,
    ) &&
    stopOnly(v.kind, v.leftWork, typeof v.leftWork === "boolean") &&
    stopOnly(v.kind, v.tree, typeof v.tree === "string" && v.tree !== "") &&
    stopOnly(v.kind, v.finish, true)
  );
}

/** The reset a stop recorded, when it is an instant; `undefined` for any other value. */
export function stopInstant(stop: DriveEvent | undefined): string | undefined {
  const until = stop?.until;
  return typeof until === "string" && Number.isFinite(parseMs(until))
    ? until
    : undefined;
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

/** `record-event [PR]`: append one event, read as JSON on stdin (`{ "kind", "cause" }`, optional `"leftWork"` with `"tree"` on a measured stop, `"listingPages"` on a listing stop, `"until"` on a forge-rate-limit stop, and `"finish"` on a stall's stop). */
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
  if (input.kind === "ci") return recordCiAction(store, input.cause);
  const hasReviewerHead =
    typeof input.reviewerHead === "string" &&
    /^[0-9a-f]{40}$/.test(input.reviewerHead);
  if (
    (input.reviewerHead !== undefined &&
      (input.kind !== "stop" || !hasReviewerHead)) ||
    (input.reviewerApp !== undefined &&
      (!hasReviewerHead ||
        typeof input.reviewerApp !== "string" ||
        !/^[a-z0-9-]+$/i.test(input.reviewerApp)))
  )
    fail(
      2,
      "record-event: reviewer evidence requires a stop with its full head commit and optional app slug",
    );
  await store.update((s) => {
    const event = {
      at: currentIso(),
      round: s.rounds,
      kind: input.kind,
      cause: input.cause,
      ...(input.leftWork === undefined ? {} : { leftWork: input.leftWork }),
      ...(input.tree === undefined ? {} : { tree: input.tree }),
      ...(input.reviewerHead === undefined
        ? {}
        : { reviewerHead: input.reviewerHead }),
      ...(input.reviewerApp === undefined
        ? {}
        : { reviewerApp: input.reviewerApp }),
      ...(input.listingPages === undefined
        ? {}
        : { listingPages: input.listingPages }),
      ...(input.until === undefined ? {} : { until: input.until }),
      ...(input.probe === undefined ? {} : { probe: input.probe }),
      ...(input.finish === undefined ? {} : { finish: input.finish }),
    };
    if (
      !isDriveEvent(event) ||
      !stopOnly(
        event.kind,
        event.probe,
        probeStopOf(event.probe)?.code === Number(event.cause),
      )
    )
      fail(
        2,
        `record-event: kind restart (${EVENT_CAUSES.restart.join(", ")}), rearm (${EVENT_CAUSES.rearm.join(", ")}), ci (rerun: or repair: detail) or stop (the exit code)`,
      );
    return { ...s, events: [...(s.events ?? []), cleanStopEvent(event)] };
  });
  return 0;
}

/** Keep a probe report's reason safe when the event comes from another writer. */
export function cleanStopEvent(event: DriveEvent): DriveEvent {
  if (event.probe === undefined) return event;
  const { probe, ...rest } = event;
  const clean = probeStopOf(probe);
  return clean === null ||
    event.kind !== "stop" ||
    String(clean.code) !== event.cause
    ? rest
    : { ...rest, probe: clean };
}
