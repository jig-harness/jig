/**
 * How the weekly sweep and the move write to the tracker
 * (design/tracker-facets.md, "The weekly sweep"): at most 30 writes a minute,
 * a refusal that carries `Retry-After` waited out and the write tried again,
 * up to 3 times a run, and any other refusal (or the fourth that asks to
 * wait) stopping the run, which then reports what it wrote and what remains.
 * A tracker's `Retry-After` reaches the run only where its transport reads
 * the header: on GitHub, the HTTPS transport (`JIG_GITHUB_GRAPHQL_URL`); a
 * rate limit `gh` reports carries none, and stops the run at once.
 *
 * A failure is printed as one line of at most 300 characters: what was
 * written, the issue key, and the tracker's status and error code, never a
 * response body, a header or a credential.
 */

import { setTimeout as sleepMs } from "node:timers/promises";
import { readSignal } from "../../../do-item/scripts/lib/tracker/facets/bounds.ts";
import type { FacetReadOptions } from "../../../do-item/scripts/lib/tracker/port.ts";
import { TrackerConfigError } from "../../../do-item/scripts/lib/tracker/config-error.ts";
import { TrackerRequestError } from "../../../do-item/scripts/lib/tracker/port.ts";

/** What pacing reads the time from, and how it waits; tests pass their own. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    sleepMs(ms, undefined, signal === undefined ? {} : { signal }),
};

/** The bounds every write of the sweep and the move keeps to. */
export const WRITE_LIMITS = {
  perMinute: 30,
  /** A `Retry-After` honoured this many times a run; the next refusal stops it. */
  retries: 3,
  /** A `Retry-After` longer than this stops the run rather than wait. */
  maxWaitSec: 600,
} as const;

/** A write the tracker refused, as the one line the run reports. */
export class WriteRefused extends Error {}

/** The seconds a failure's `Retry-After` asked for, or `null`. */
function retryAfterOf(err: unknown): number | null {
  const v = (err as { retryAfterSec?: unknown } | null)?.retryAfterSec;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * A failure as one line of at most 300 characters: `what` (the operation
 * and the issue key), the tracker's status and its error codes. A refusal
 * Jig itself raised (a request it would not send, a configuration it would
 * not read) keeps its own message, which holds no tracker content.
 */
export function failureLine(what: string, err: unknown): string {
  if (err instanceof TrackerRequestError || err instanceof TrackerConfigError)
    return `${what}: ${err.message.replace(/\s+/g, " ")}`.slice(0, 300);
  const message = err instanceof Error ? err.message : String(err);
  const status = statusOf(err, message);
  const detail = detailOf(err, message);
  return `${what}: ${status}${detail === "" ? "" : ` (${detail})`}`.slice(
    0,
    300,
  );
}

/** What a failure says of the request: not found, unavailable (and for how long), refused, or failed. */
function statusOf(err: unknown, message: string): string {
  const e = (err ?? {}) as { notFound?: unknown; unavailable?: unknown };
  if (e.notFound === true) return "not found, or not visible to the credential";
  if (e.unavailable === true) {
    const retry = retryAfterOf(err);
    return `unavailable${retry === null ? "" : `, retry after ${retry}s`}`;
  }
  return /FORBIDDEN|HTTP 403|not accessible|permission/i.test(message)
    ? "refused"
    : "failed";
}

/** A failure's HTTP status and the tracker's error codes, never the body around them. */
function detailOf(err: unknown, message: string): string {
  const status = (err as { status?: unknown } | null)?.status;
  const http =
    typeof status === "number"
      ? String(status)
      : /HTTP (\d{3})/.exec(message)?.[1];
  const codes = new Set(
    [...message.matchAll(/"(?:type|code)"\s*:\s*"([A-Z_]+)"/g)].map(
      (m) => m[1] as string,
    ),
  );
  return [...(http === undefined ? [] : [`HTTP ${http}`]), ...codes].join(", ");
}

/** Paced writes, each refusal handled as the run's bounds say. */
export interface Writer {
  /** Run one write; throws `WriteRefused` when the run must stop. */
  write<T>(what: string, run: (signal?: AbortSignal) => Promise<T>): Promise<T>;
  /** Writes attempted so far, retries included. */
  readonly attempts: number;
  readonly signal?: AbortSignal;
}

/** A writer that keeps to `limits`, timed by `clock`. */
export function pacedWriter(
  clock: Clock = SYSTEM_CLOCK,
  limits: {
    perMinute: number;
    retries: number;
    maxWaitSec: number;
  } = WRITE_LIMITS,
  bounds?: FacetReadOptions,
): Writer {
  const signal = readSignal(bounds ?? { deadline: Date.now() + 3_600_000 });
  const recent: number[] = [];
  let attempts = 0;
  /** The `Retry-After` waits this run has honoured. */
  let waited = 0;

  async function bounded<T>(task: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (signal === undefined) return task();
    // Keep ownership until a started effect settles. Cancellation is forwarded
    // to the effect; racing it would let a write outlive its record lock.
    const result = await task();
    signal.throwIfAborted();
    return result;
  }

  /** Wait until fewer than `perMinute` writes fall in the last minute. */
  async function pace(): Promise<void> {
    for (;;) {
      const now = clock.now();
      while (recent.length > 0 && now - (recent[0] as number) >= 60_000)
        recent.shift();
      if (recent.length < limits.perMinute) {
        recent.push(now);
        return;
      }
      await bounded(() =>
        clock.sleep(60_000 - (now - (recent[0] as number)), signal),
      );
    }
  }

  return {
    ...(signal === undefined ? {} : { signal }),
    get attempts() {
      return attempts;
    },
    async write(what, run) {
      for (;;) {
        await pace();
        attempts++;
        try {
          signal?.throwIfAborted();
          return await run(signal);
        } catch (err) {
          const wait = retryAfterOf(err);
          if (wait === null || wait > limits.maxWaitSec)
            throw new WriteRefused(failureLine(what, err), { cause: err });
          if (waited >= limits.retries)
            throw new WriteRefused(
              `${failureLine(what, err)} (after ${waited} waits this run)`.slice(
                0,
                300,
              ),
              { cause: err },
            );
          waited++;
          await bounded(() => clock.sleep(wait * 1000, signal));
        }
      }
    },
  };
}
