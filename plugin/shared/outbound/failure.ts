/**
 * The closed set of ways a call to an outside system fails, and the policy
 * each one takes ([ADR-0020](../../../docs/adr/ADR-0020-outbound-calls-are-governed.md),
 * [design/outbound-calls.md](../../../design/outbound-calls.md)).
 *
 * Every transport (the tracker adapters' transports, the forge client's
 * `ghCall` wrappers) reports a failed call as an `OutboundFailure`: an
 * `Outcome` failure ([ADR-0012](../../../docs/adr/ADR-0012-failures-as-values.md))
 * whose `code` is one of `FAILURE_CLASSES`. The transport is the one place
 * that reads a status, a header or a message to choose the class; a caller
 * branches on the class alone. A transport that still reports a failure as
 * a throw throws an `OutboundError`, which carries the same failure.
 *
 * | Class | What it means | Retried inside the call | A person is told |
 * | --- | --- | --- | --- |
 * | `rate-limited` | the system refused the credential, or the budget record says the caller's share is spent; `until` says when it clears | no | never for the wait itself |
 * | `unreachable` | no answer: the name did not resolve, the connection failed, or the deadline passed with nothing received | a read, once | after the failure ledger's count in a row |
 * | `too-costly` | the system ran out of time on the request, or priced it above what one request may cost | a paged read, at half the page | when the smallest request fails |
 * | `server-fault` | the system answered at once with a 5xx status | a read, once | after the failure ledger's count in a row |
 * | `unauthorized` | the credential is missing, expired or refused | no | at once |
 * | `not-found` | what was asked for does not exist or is not visible | no | no: an absence is an answer |
 * | `invalid` | the system refused the request as malformed, or answered in a form that does not read | no | yes, a defect: the failure fails its run at once, and the failure ledger tells a person at its count |
 *
 * A write whose answer was lost is `unreachable` with `sent` set: the
 * caller reads the item again before it writes again.
 */
import { type Failure, JigError } from "../outcome.ts";

export const FAILURE_CLASSES = [
  "rate-limited",
  "unreachable",
  "too-costly",
  "server-fault",
  "unauthorized",
  "not-found",
  "invalid",
] as const;

/** One way a call to an outside system failed. */
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** A call's failure: its class as the code, a sentence for a person, and what the class carries. */
export interface OutboundFailure extends Failure<FailureClass> {
  /** `rate-limited`: when the system lets the credential send again, epoch milliseconds. */
  until?: number;
  /** The request left before the answer was lost: a write may have landed. */
  sent?: boolean;
  /** How long the system asked the caller to wait (`Retry-After`), milliseconds. */
  retryAfterMs?: number;
}

/** What a class's policy says. */
export interface FailurePolicy {
  /** What the transport does inside the call: nothing, send a read once more, or ask a paged read again at half the page. */
  retried: "never" | "read-once" | "half-page";
  /** Whether waiting clears it: a reader keeps its last reading, and a tick does not fail for it under its threshold. */
  clearsByWaiting: boolean;
  /** When a person hears of it: never, through the failure ledger once it counts enough failures in a row, when the smallest request fails, or at once. */
  told: "never" | "after-count" | "smallest-request" | "at-once";
}

/** Each class's one policy. */
export const POLICIES: Readonly<Record<FailureClass, FailurePolicy>> = {
  "rate-limited": { retried: "never", clearsByWaiting: true, told: "never" },
  unreachable: {
    retried: "read-once",
    clearsByWaiting: true,
    told: "after-count",
  },
  "too-costly": {
    retried: "half-page",
    clearsByWaiting: true,
    told: "smallest-request",
  },
  "server-fault": {
    retried: "read-once",
    clearsByWaiting: true,
    told: "after-count",
  },
  unauthorized: { retried: "never", clearsByWaiting: false, told: "at-once" },
  "not-found": { retried: "never", clearsByWaiting: false, told: "never" },
  invalid: { retried: "never", clearsByWaiting: false, told: "after-count" },
};

/** Whether `code` names a failure class. */
function isFailureClass(code: unknown): code is FailureClass {
  return (
    typeof code === "string" &&
    (FAILURE_CLASSES as readonly string[]).includes(code)
  );
}

/** Whether waiting clears a failure of this class. */
export function clearsByWaiting(code: FailureClass): boolean {
  return POLICIES[code].clearsByWaiting;
}

/** Whether a read that failed this way is sent once more inside the call. */
export function retriedOnce(code: FailureClass): boolean {
  return POLICIES[code].retried === "read-once";
}

/** Whether the system gave no answer this run should wait out: it is not asked again in the same run. */
export function unanswered(code: FailureClass): boolean {
  return code === "unreachable" || code === "server-fault";
}

/** A failure of class `code`, with only the fields given. */
export function outboundFailure(
  code: FailureClass,
  reason: string,
  extra: {
    until?: number | null;
    sent?: boolean;
    retryAfterMs?: number | null;
    cause?: unknown;
  } = {},
): OutboundFailure {
  const failure: OutboundFailure = { code, reason };
  if (extra.until !== undefined && extra.until !== null)
    failure.until = extra.until;
  if (extra.sent === true) failure.sent = true;
  if (extra.retryAfterMs !== undefined && extra.retryAfterMs !== null)
    failure.retryAfterMs = extra.retryAfterMs;
  if (extra.cause !== undefined) failure.cause = extra.cause;
  return failure;
}

/**
 * A failure of a caller's own code (`unreadable`, `refused`) that a failed
 * call caused: it carries that call's failure, so a reader of the caller's
 * outcome still branches on the class.
 */
export interface CausedFailure<Code extends string> extends Failure<Code> {
  outbound?: OutboundFailure;
}

/** The failure `code` a failed call caused, its reason that call's unless `reason` is given. */
export function failedBy<Code extends string>(
  code: Code,
  outbound: OutboundFailure,
  reason: string = outbound.reason,
): { ok: false; failure: CausedFailure<Code> } {
  return { ok: false, failure: { code, reason, outbound } };
}

/** The call's failure a failure carries: itself when its code is a class, else the one it was caused by; `null` for none. */
export function outboundOf(
  failure: Failure | null | undefined,
): OutboundFailure | null {
  if (failure === null || failure === undefined) return null;
  const carried = (failure as CausedFailure<string>).outbound;
  if (carried !== undefined) return carried;
  return isFailureClass(failure.code) ? (failure as OutboundFailure) : null;
}

/**
 * A call's failure that still travels as a throw, to a catch in an adapter:
 * its `code` is the class, and `failure` is the same failure as a value.
 */
export class OutboundError extends JigError<FailureClass> {
  override name = "OutboundError";
  readonly until: number | null;
  readonly sent: boolean;
  readonly retryAfterMs: number | null;
  constructor(
    code: FailureClass,
    reason: string,
    extra: {
      until?: number | null;
      sent?: boolean;
      retryAfterMs?: number | null;
      cause?: unknown;
    } = {},
  ) {
    super(
      code,
      reason,
      extra.cause === undefined ? undefined : { cause: extra.cause },
    );
    this.until = extra.until ?? null;
    this.sent = extra.sent ?? false;
    this.retryAfterMs = extra.retryAfterMs ?? null;
  }
  /** The failure as an `Outcome`'s. */
  get failure(): OutboundFailure {
    return outboundFailure(this.code, this.message, {
      until: this.until,
      sent: this.sent,
      retryAfterMs: this.retryAfterMs,
    });
  }
  /** Whether waiting clears it. */
  get clearsByWaiting(): boolean {
    return clearsByWaiting(this.code);
  }
}

/**
 * The class of what a call threw. An `OutboundError` says its own; the
 * budget's refusal (`TrackerRateLimited`, from this module's copy or another
 * release's) is `rate-limited` until its reset; an abort or a timeout the
 * platform raised is `unreachable`. Anything else is `invalid`: a call that
 * failed in a way no transport classified is a defect for a person.
 */
export function failureOf(error: unknown): OutboundFailure {
  if (error instanceof OutboundError) return error.failure;
  const said = error instanceof Error ? error.message : String(error);
  if (error instanceof Error) {
    const fields = error as { code?: unknown; resetAt?: unknown };
    if (
      fields.code === "tracker-rate-limited" &&
      typeof fields.resetAt === "number"
    )
      return outboundFailure("rate-limited", said, { until: fields.resetAt });
    if (isFailureClass(fields.code) && error.name === "OutboundError")
      return outboundFailure(fields.code, said);
    if (error.name === "AbortError" || error.name === "TimeoutError")
      return outboundFailure("unreachable", said);
  }
  return outboundFailure("invalid", said, { cause: error });
}

/**
 * The class an HTTP status stands for when the answer says nothing more:
 * `null` for a success or a redirect. A system whose refusal of a spent
 * credential or whose missing item looks different (a 403 that says
 * "rate limit", a 200 with an error body) reads its own signs first.
 */
export function statusClass(status: number): FailureClass | null {
  if (status < 400) return null;
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404 || status === 410) return "not-found";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server-fault";
  return "invalid";
}

/**
 * A failed answer that came sooner than this is no timeout: a system works
 * on a request for some seconds (GitHub about ten) before it gives up, and
 * answers at once when it is itself unavailable.
 */
export const TIMEOUT_FLOOR_MS = 5_000;

/**
 * `statusClass`, where a 502 or 504 that came after the system worked on the
 * request for `TIMEOUT_FLOOR_MS` or longer is the system running out of
 * time on it (`too-costly`), not a fault of its own.
 */
export function answerClass(
  status: number,
  tookMs: number,
): FailureClass | null {
  if ((status === 502 || status === 504) && tookMs >= TIMEOUT_FLOOR_MS)
    return "too-costly";
  return statusClass(status);
}

/** The wait a `Retry-After` header asks for, seconds or an HTTP date, in milliseconds; `null` when it names none. */
export function retryAfterMs(
  headers: Headers,
  now: () => number = Date.now,
): number | null {
  const header = headers.get("retry-after");
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now()) : null;
}
