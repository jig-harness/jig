/**
 * What a tick does with a read a failed call to an outside system stopped
 * ([design/outbound-calls.md](../../../design/outbound-calls.md), "What a
 * reader does without an answer"):
 *
 * - The read carries the call's failure class (`ReadFailure`), read from
 *   the failure itself (`readFailureOf`), never from its message.
 * - A repository whose every failed read is of a class that clears by
 *   waiting (`rate-limited`, `unreachable`, `server-fault`, `too-costly`)
 *   waits (`waitingFailures`): it does not fail the tick while it is under
 *   its threshold. A `rate-limited` read is under it until its reset and is
 *   not counted in the failure ledger; any other is counted in a row, and
 *   at `failures.notify_after` failures in a row it fails the tick and a
 *   person is told (`waitsOut`).
 * - A refused credential is told at once: its row
 *   counts as `failures.notify_after` failures (`toldAtOnce`).
 * - The forge's reading of a repository is kept with its time
 *   (`keepForgeReading`), so a tick whose forge read waits shows the last
 *   one with its age (`lastForgeReading`).
 */
import {
  clearsByWaiting,
  failureOf,
  outboundOf,
  type OutboundFailure,
  POLICIES,
} from "../../shared/outbound/failure.ts";
import type { Failure } from "../../shared/outcome.ts";
import type { FailureSettings } from "./failures.ts";
import { type PickupReads, pickupReads } from "./pickup-reads.ts";
import type { ReadFailure, RepoReport } from "./types.ts";

/** A call's failure as a read keeps it. */
function readFailure(outbound: OutboundFailure): ReadFailure {
  return {
    class: outbound.code,
    ...(outbound.until === undefined
      ? {}
      : { until: new Date(outbound.until).toISOString() }),
  };
}

/**
 * The failure class of a read's failure: the call's it carries, else what
 * its cause or a thrown error says; `undefined` when no call failed it.
 */
export function readFailureOf(failure: Failure): ReadFailure | undefined {
  const outbound = outboundOf(failure);
  if (outbound !== null) return readFailure(outbound);
  if (failure.cause === undefined) return undefined;
  const thrown = failureOf(failure.cause);
  return thrown.code === "invalid" ? undefined : readFailure(thrown);
}

/**
 * The failed reads of a repository's turn when every one of them waits: a
 * refusal or a record a failed call of a class that clears by waiting
 * caused. `null` when the turn did not fail, or something in it failed
 * that waiting does not clear (a defect, an unreadable record, a refusal
 * no call caused).
 */
export function waitingFailures(report: RepoReport): ReadFailure[] | null {
  if ((report.stageDefects?.length ?? 0) > 0) return null;
  if (
    report.unplaced.some(
      (u) => u.readFailed === true || u.target === "the outcome log",
    )
  )
    return null;
  const failed: (ReadFailure | undefined)[] = [
    ...(report.refused === null ? [] : [report.refusedBy]),
    ...report.records.filter((r) => !r.ok).map((r) => r.failure),
  ];
  if (failed.length === 0) return null;
  const waiting = failed.filter(
    (f): f is ReadFailure => f !== undefined && clearsByWaiting(f.class),
  );
  return waiting.length === failed.length ? waiting : null;
}

/** Whether a failed read of the turn is of a class a person is told of at once: a refused credential. */
export function toldAtOnce(report: RepoReport): boolean {
  return [
    report.refusedBy,
    ...report.records.filter((r) => !r.ok).map((r) => r.failure),
  ].some((f) => f !== undefined && POLICIES[f.class].told === "at-once");
}

/** Whether every waiting failure is a rate limit before its reset: nothing to count. */
export function onlyRateLimited(
  waiting: readonly ReadFailure[],
  nowMs: number,
): boolean {
  return waiting.every(
    (f) =>
      f.class === "rate-limited" &&
      (f.until === undefined || Date.parse(f.until) > nowMs),
  );
}

/**
 * Whether a repository's turn waits out its failure this tick rather than
 * failing it: every failed read waits, and either all are rate limits
 * before their reset or the failures in a row, this one counted
 * (`priorCount + 1`), are fewer than `failures.notify_after`.
 */
export function waitsOut(
  report: RepoReport,
  priorCount: number,
  settings: Pick<FailureSettings, "notifyAfter">,
  nowMs: number,
): boolean {
  const waiting = waitingFailures(report);
  if (waiting === null) return false;
  return (
    onlyRateLimited(waiting, nowMs) || priorCount + 1 < settings.notifyAfter
  );
}

/** One repository's forge reading as a tick last took it. */
interface KeptReading {
  atMs: number;
  detail: string;
}

const readingKey = (path: string) => `forge:reading:${path}`;

/** Keep the forge's reading of the repository at `path`, read whole at `nowMs`. */
export function keepForgeReading(
  path: string,
  detail: string,
  nowMs: number,
  store: PickupReads = pickupReads,
): void {
  store.set(readingKey(path), { atMs: nowMs, detail });
}

/** How long ago `atMs` was, in a few words. */
function ageOf(atMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - atMs) / 60_000));
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** The last forge reading of the repository at `path`, with its time and age, as a clause; empty when none is kept. */
export function lastForgeReading(
  path: string,
  nowMs: number,
  store: PickupReads = pickupReads,
): string {
  const kept = store.get<KeptReading>(readingKey(path));
  if (
    kept === null ||
    typeof kept.atMs !== "number" ||
    typeof kept.detail !== "string"
  )
    return "";
  return `; the last reading, of ${new Date(kept.atMs).toISOString()} (${ageOf(kept.atMs, nowMs)} old): ${kept.detail}`;
}
