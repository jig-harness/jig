/**
 * One governed HTTP request to a system that reports no rate limit of its
 * own: an incoming webhook (ntfy, Slack, Discord), whose address is the
 * credential ([ADR-0021](../../../docs/adr/ADR-0021-outbound-calls-are-governed.md),
 * [design/outbound-calls.md](../../../design/outbound-calls.md)).
 *
 * - **A deadline.** Every request is bounded by `timeoutMs` and by the
 *   caller's `signal`; a request past either ends as `unreachable`, marked
 *   `sent`, since it may have arrived.
 * - **The closed failure classes.** A status, a network error or an abort is
 *   read here alone and answered as one of `failure.ts`'s classes; a 429 is
 *   `rate-limited` until its `Retry-After`, and a redirect is `invalid`,
 *   since a webhook that moved is not followed with its credential.
 * - **The ledger.** Each request that left the machine adds to the outbound
 *   cost ledger: one request under `system`, the operation, and a hash of
 *   the credential, never the credential.
 * - **The hold.** In a run that holds systems that do not answer (the
 *   dispatcher's tick, `hold.ts`), a destination that met `unreachable` or
 *   `server-fault` is not asked again in the run, and the next run probes it
 *   once first.
 *
 * No budget record is kept: these systems report no balance in their
 * answers, and a caller sends at most one request for each thing it has to
 * say, so a refusal (`rate-limited`) is the only limit the caller meets, and
 * it backs off in its own records. The answer's body is not read.
 *
 * The address is the credential: it never appears in a reason, a ledger row
 * or a hold. A reason names the destination by `destination`, a label the
 * caller chooses that holds no secret. Only `https:` addresses are sent,
 * and `http:` to the loopback host (`localhost`, `127.0.0.1`, `[::1]`),
 * which a test or a relay on the same machine listens on.
 */
import { failed, ok, type Outcome } from "../outcome.ts";
import { currentMs } from "../time.ts";
import { credentialKey } from "./budget.ts";
import {
  answerClass,
  type FailureClass,
  type OutboundFailure,
  outboundFailure,
  retryAfterMs,
} from "./failure.ts";
import { guarded } from "./hold.ts";
import { recordCall } from "./ledger.ts";

/** One request. */
export interface HttpRequest {
  /** The system, as the ledger names it (`webhook`). */
  system: string;
  /** The operation, as the ledger names it. */
  operation: string;
  /** Where it goes: an address `httpAddress` accepts. It is the credential. */
  url: string;
  /** A name for the destination that holds no secret, for reasons and the hold. */
  destination: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  body: string;
  /** The longest the request may take. */
  timeoutMs: number;
  /** Ends the request when it aborts. */
  signal?: AbortSignal;
  /** The platform's `fetch`, unless a test hands another. */
  fetchImpl?: typeof fetch;
}

/** What answered a request that succeeded. */
export interface HttpAnswer {
  status: number;
  tookMs: number;
}

export type HttpOutcome =
  | { ok: true; value: HttpAnswer }
  | { ok: false; failure: OutboundFailure };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The answers of requests that never left the machine: they say nothing of the destination, so they neither hold it nor release a hold. */
const UNSENT = new WeakSet<HttpOutcome>();

/** A failure of a request that was not sent. */
function unsent(failure: OutboundFailure): HttpOutcome {
  const answer: HttpOutcome = { ok: false, failure };
  UNSENT.add(answer);
  return answer;
}

/** The address `raw` names when it is one this transport sends to; why not, without the address, when it is not. */
export function httpAddress(raw: string): Outcome<URL, "invalid"> {
  if (!URL.canParse(raw))
    return failed("invalid", "it is not an absolute address");
  const url = new URL(raw);
  if (url.protocol === "https:") return ok(url);
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return ok(url);
  return failed(
    "invalid",
    "it is neither an https: address nor an http: address on the loopback host",
  );
}

/** The platform error's own short name (`ConnectionRefused`, `TypeError`), never its message, which may hold the address. */
function errorName(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z_]{1,40}$/.test(code)) return code;
  return error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name)
    ? error.name
    : "an unknown error";
}

/** Cancel the answer's body, unread; a cancel that fails changes nothing. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/** The class and reason of an answer that is not a success. */
function answerFailure(
  request: HttpRequest,
  response: Response,
  tookMs: number,
): OutboundFailure | null {
  const { status } = response;
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400)
    return outboundFailure(
      "invalid",
      `${request.destination} answered HTTP ${status}, a redirect, which is not followed`,
    );
  const code: FailureClass = answerClass(status, tookMs) ?? "invalid";
  if (code === "rate-limited") {
    const wait = retryAfterMs(response.headers);
    return outboundFailure(
      "rate-limited",
      `${request.destination} answered HTTP ${status}: it asks to wait${wait === null ? "" : ` ${Math.ceil(wait / 1000)}s`}`,
      { retryAfterMs: wait, until: wait === null ? null : currentMs() + wait },
    );
  }
  return outboundFailure(
    code,
    `${request.destination} answered HTTP ${status}`,
  );
}

/** Send once, never throwing: the answer, or the failure's class. */
async function sendOnce(request: HttpRequest): Promise<HttpOutcome> {
  const address = httpAddress(request.url);
  if (!address.ok)
    return unsent(
      outboundFailure(
        "invalid",
        `${request.destination} was not sent: its address ${address.failure.reason}`,
      ),
    );
  if (request.signal?.aborted === true) return unsent(stoppedFirst(request));
  const timeoutMs = Math.max(1, request.timeoutMs);
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal =
    request.signal === undefined
      ? deadline
      : AbortSignal.any([deadline, request.signal]);
  const began = currentMs();
  let failure: OutboundFailure | null = null;
  try {
    const response = await (request.fetchImpl ?? fetch)(address.value, {
      method: request.method ?? "POST",
      headers: request.headers ?? {},
      body: request.body,
      redirect: "manual",
      signal,
    });
    const tookMs = currentMs() - began;
    discard(response);
    failure = answerFailure(request, response, tookMs);
    return failure === null
      ? { ok: true, value: { status: response.status, tookMs } }
      : { ok: false, failure };
  } catch (error) {
    failure = signal.aborted
      ? outboundFailure(
          "unreachable",
          deadline.aborted
            ? `${request.destination} gave no answer within ${timeoutMs}ms; it may have arrived`
            : `${request.destination} was stopped before it answered; it may have arrived`,
          { sent: true },
        )
      : outboundFailure(
          "unreachable",
          `${request.destination} could not be reached (${errorName(error)})`,
        );
    return { ok: false, failure };
  } finally {
    recordCall({
      system: request.system,
      credential: credentialKey(request.system, request.url),
      operation: request.operation,
      cost: 1,
      unit: "requests",
      durationMs: currentMs() - began,
      failure: failure?.code ?? null,
    });
  }
}

/**
 * Send `request` once, within its deadline, recorded in the ledger and
 * subject to the run's hold. Never throws: every failure is one of the
 * closed classes, its reason naming `destination` and never the address.
 */
export async function sendHttp(request: HttpRequest): Promise<HttpOutcome> {
  try {
    return await guarded<HttpOutcome>(
      `${request.system} ${request.destination}`,
      () => sendOnce(request),
      (answer) => (answer.ok ? null : answer.failure),
      (held) => ({ ok: false, failure: held }),
      request.signal,
      (answer) => UNSENT.has(answer),
    );
  } catch {
    // The hold's wait for another request's probe ends with the signal's reason.
    return unsent(stoppedFirst(request));
  }
}

/** The failure of a request stopped before it was sent. */
function stoppedFirst(request: HttpRequest): OutboundFailure {
  return outboundFailure(
    "unreachable",
    `${request.destination} was not sent: the request was stopped first`,
  );
}
