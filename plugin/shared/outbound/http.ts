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
 *   `rate-limited`, and a redirect is `invalid`, since a webhook that moved
 *   is not followed with its credential.
 * - **The budget record's hold.** A 429 holds the destination in the
 *   machine's budget record (`budget.ts`, keyed by a hash of the address)
 *   until its `Retry-After`, or, naming none, for a minute doubled with each
 *   refusal in a row up to fifteen. While it holds, no request to that
 *   address leaves the machine, from this process or another: each answers
 *   `rate-limited` until the time it clears, marked `unsent`. These systems
 *   report no balance, so the record keeps no window, only the hold.
 * - **The ledger.** Each request adds to the outbound cost ledger under
 *   `system`, the operation and a hash of the address, never the address:
 *   one request when it left, none when the hold refused it.
 * - **The run's hold.** In a run that holds systems that do not answer (the
 *   dispatcher's tick, `hold.ts`), a destination that met `unreachable` or
 *   `server-fault` is not asked again in the run, and the next run probes it
 *   once first; a request that hold refuses is marked `unsent` too.
 *
 * The answer's body is not read. The address never appears in a reason, a
 * ledger row or a hold. A reason names the destination by `destination`, a
 * label the caller chooses that holds no secret. Only `https:` addresses are
 * sent, and `http:` to the loopback host (`localhost`, `127.0.0.1`,
 * `[::1]`), which a test or a relay on the same machine listens on. An
 * `https:` address on a private, loopback or internal host is refused, so an
 * address from the environment cannot aim a post at the machine's network.
 */
import { failed, ok, type Outcome } from "../outcome.ts";
import { currentMs, isoFromMs } from "../time.ts";
import {
  type BudgetGovernor,
  budgetGovernor,
  credentialKey,
  isRateLimited,
  sqliteBudgetStore,
} from "./budget.ts";
import {
  answerClass,
  type FailureClass,
  type OutboundFailure,
  outboundFailure,
  retryAfterMs,
} from "./failure.ts";
import { guarded } from "./hold.ts";
import { defaultLedgerPath, recordCall } from "./ledger.ts";

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
  /** The budget record the destination's hold is kept in; the machine's, beside the ledger, unless a test hands another. */
  governor?: BudgetGovernor;
}

/** What answered a request that succeeded. */
export interface HttpAnswer {
  status: number;
  tookMs: number;
}

/** A request's answer; a failure marked `unsent` never left the machine, so it says nothing of the destination. */
export type HttpOutcome =
  | { ok: true; value: HttpAnswer }
  | { ok: false; failure: OutboundFailure; unsent?: true };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A failure of a request that was not sent. */
function unsent(failure: OutboundFailure): HttpOutcome {
  return { ok: false, failure, unsent: true };
}

/** How long a 429 that names no wait holds the destination: a minute, doubled for each in a row, up to fifteen. */
const UNNAMED_WAIT = { floorMs: 60_000, capMs: 15 * 60_000 };

const governors = new Map<string, BudgetGovernor>();

/** The machine's budget record, in the database the ledger writes. */
function machineGovernor(): BudgetGovernor {
  const path = defaultLedgerPath();
  let governor = governors.get(path);
  if (governor === undefined) {
    governor = budgetGovernor(sqliteBudgetStore(path));
    governors.set(path, governor);
  }
  return governor;
}

/** Whether an IPv6 literal (no brackets) is the machine's own, a unique-local, a link-local or an IPv4-mapped address. */
function internalV6(host: string): boolean {
  return (
    host === "::" || host === "::1" || /^(fc|fd|fe[89ab]|::ffff:)/.test(host)
  );
}

/** The first two octets that make a private, loopback or link-local IPv4 literal, as a pattern over `a.b`. */
const PRIVATE_V4 =
  /^(0|10|127)\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/** Whether `hostname` names the machine or its network, by how it is spelled (a trailing dot is ignored); the name's resolution is not checked, since the address is the operator's own setting. A private, loopback or link-local IP literal, `localhost`, or a name with no dot or on a local-only suffix. */
function internalHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (host.includes(":")) return internalV6(host);
  return (
    PRIVATE_V4.test(host) ||
    !host.includes(".") ||
    /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host)
  );
}

/** The address `raw` names when it is one this transport sends to; why not, without the address, when it is not. */
export function httpAddress(raw: string): Outcome<URL, "invalid"> {
  if (!URL.canParse(raw))
    return failed("invalid", "it is not an absolute address");
  const url = new URL(raw);
  if (url.protocol === "https:") {
    return internalHost(url.hostname)
      ? failed("invalid", "its host is on the machine or an internal network")
      : ok(url);
  }
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

/** Why a request that never left was not sent; `null` when it may be sent. */
function notSendable(request: HttpRequest): OutboundFailure | null {
  const address = httpAddress(request.url);
  if (!address.ok)
    return outboundFailure(
      "invalid",
      `${request.destination} was not sent: its address ${address.failure.reason}`,
    );
  return request.signal?.aborted === true ? stoppedFirst(request) : null;
}

/** The failure of a request `fetch` threw for: past its deadline or stopped (it may have arrived), or never connected. */
function thrownFailure(
  request: HttpRequest,
  error: unknown,
  signal: AbortSignal,
  deadline: AbortSignal,
  timeoutMs: number,
): OutboundFailure {
  if (!signal.aborted)
    return outboundFailure(
      "unreachable",
      `${request.destination} could not be reached (${errorName(error)})`,
    );
  return outboundFailure(
    "unreachable",
    deadline.aborted
      ? `${request.destination} gave no answer within ${timeoutMs}ms; it may have arrived`
      : `${request.destination} was stopped before it answered; it may have arrived`,
    { sent: true },
  );
}

/** Whether the budget record holds the destination: the failure a request answers then, else `null` with the time it was admitted. */
function admitted(
  governor: BudgetGovernor,
  key: string,
  request: HttpRequest,
): { held: OutboundFailure } | { at: number } {
  try {
    return {
      at: governor.admit(request.system, key, { windows: [], reserve: null }),
    };
  } catch (error) {
    if (!isRateLimited(error)) return { at: currentMs() };
    return {
      held: outboundFailure(
        "rate-limited",
        `${request.destination} asked to wait until ${isoFromMs(error.resetAt)}; nothing is sent to it before then`,
        { until: error.resetAt },
      ),
    };
  }
}

/** Record what the destination's answer says of its hold: a 429 holds it, any other answer, a failure included, ends the refusals in a row. */
function observeHold(
  governor: BudgetGovernor,
  key: string,
  at: number,
  failure: OutboundFailure | null,
): OutboundFailure | null {
  if (failure?.code !== "rate-limited") {
    governor.observe(key, {}, at, null);
    return failure;
  }
  governor.observe(
    key,
    failure.until === undefined
      ? { unnamedRefusal: UNNAMED_WAIT, why: failure.reason }
      : { limitedUntil: failure.until, why: failure.reason },
    at,
    null,
  );
  const until = failure.until ?? governor.heldUntil?.(key) ?? null;
  return until === null ? failure : { ...failure, until };
}

/** Send once, never throwing: the answer, or the failure's class. */
async function sendOnce(
  request: HttpRequest,
  deadline: AbortSignal,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<HttpOutcome> {
  const refused = notSendable(request);
  if (refused !== null) return unsent(refused);
  const governor = request.governor ?? machineGovernor();
  const key = credentialKey(request.system, request.url);
  const admission = admitted(governor, key, request);
  if ("held" in admission) {
    record(request, 0, 0, admission.held);
    return unsent(admission.held);
  }
  const began = currentMs();
  let failure: OutboundFailure | null = null;
  try {
    const response = await (request.fetchImpl ?? fetch)(request.url, {
      method: request.method ?? "POST",
      headers: request.headers ?? {},
      body: request.body,
      redirect: "manual",
      signal,
    });
    const tookMs = currentMs() - began;
    discard(response);
    failure = observeHold(
      governor,
      key,
      admission.at,
      answerFailure(request, response, tookMs),
    );
    return failure === null
      ? { ok: true, value: { status: response.status, tookMs } }
      : { ok: false, failure };
  } catch (error) {
    failure = thrownFailure(request, error, signal, deadline, timeoutMs);
    return { ok: false, failure };
  } finally {
    record(request, 1, currentMs() - began, failure);
  }
}

/** One ledger row: `requests` that left (none when the hold refused it). */
function record(
  request: HttpRequest,
  requests: number,
  durationMs: number,
  failure: OutboundFailure | null,
): void {
  recordCall({
    system: request.system,
    credential: credentialKey(request.system, request.url),
    operation: request.operation,
    requests,
    cost: requests,
    unit: "requests",
    durationMs,
    failure: failure?.code ?? null,
  });
}

/**
 * Send `request` once, within its deadline, recorded in the ledger and
 * subject to the run's hold. Never throws: every failure is one of the
 * closed classes, its reason naming `destination` and never the address.
 */
export async function sendHttp(request: HttpRequest): Promise<HttpOutcome> {
  // The deadline starts before the hold's wait, so it bounds the whole call.
  const timeoutMs = Math.max(1, request.timeoutMs);
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any(
    request.signal === undefined ? [deadline] : [deadline, request.signal],
  );
  try {
    return await guarded<HttpOutcome>(
      // The hold is the destination's, whatever name a caller gives it.
      credentialKey(request.system, request.url),
      () => sendOnce(request, deadline, signal, timeoutMs),
      (answer) => (answer.ok ? null : answer.failure),
      (held) => unsent(held),
      signal,
      (answer) => !answer.ok && answer.unsent === true,
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
