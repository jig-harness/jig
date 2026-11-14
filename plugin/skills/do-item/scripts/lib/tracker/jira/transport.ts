/**
 * Jira Cloud's REST API (version 3), for the Jira tracker adapter.
 *
 * Every request goes to `<base>/rest/api/3/<path>` over HTTPS, where the
 * base is the site, or the Atlassian API gateway's address for it
 * (`issue_tracker.jira.api_base`); it carries the header the credential in
 * the environment gives (`credential.ts`), never follows a redirect, and is
 * bounded by `JIRA_TIMEOUT_MS`. A 401 is answered by sending the request
 * once more, with a renewed header, when the credential can be renewed.
 * Tests of the adapter pass a fake transport.
 *
 * Two pagers read a listing to its end: Jira's offset pages (`startAt`,
 * `maxResults`, then `isLast` or `total`) and the token pages of the JQL
 * search (`nextPageToken`, `isLast`). An item repeated across pages, or a
 * page that says nothing about whether it is the last, fails the read: the
 * list moved under it, and a shorter population is never presented as whole.
 *
 * A failure is a `JiraApiError` whose code is its failure class
 * (`shared/outbound/failure.ts`), read here from the answer's status: a
 * refused credential is `unauthorized`, a 404 `not-found`, a 429
 * `rate-limited` until its `Retry-After`, a 5xx `server-fault`, no answer
 * `unreachable` (with `sent` when the request left), anything else Jira
 * refused `invalid`. A read (a GET, or a POST its builder marks
 * idempotent) that met `unreachable` or `server-fault` is sent once more
 * inside the call's deadline (`shared/outbound/retry.ts`); a write never is.
 */

import {
  answerClass,
  type FailureClass,
  type OutboundFailure,
  OutboundError,
  outboundFailure,
  retryAfterMs,
  statusClass,
} from "../../../../../../shared/outbound/failure.ts";
import { guarded } from "../../../../../../shared/outbound/hold.ts";
import { restOperation } from "../../../../../../shared/outbound/gh-ledger.ts";
import {
  recordAttempt,
  type Attempt,
} from "../../../../../../shared/outbound/record-attempt.ts";
import {
  discardBody,
  retryRead,
} from "../../../../../../shared/outbound/retry.ts";
import {
  type BudgetGovernor,
  credentialKey,
  defaultGovernor,
  FALLBACK_LIMIT_MS,
  TrackerRateLimited,
} from "../../../../../../shared/outbound/budget.ts";
import { swallow } from "../../../../../../shared/errors.ts";
import { isRecord } from "../../../../../../shared/guards.ts";
import type { Outcome } from "../../../../../../shared/outcome.ts";
import {
  type CredentialCode,
  type JiraAuthorization,
  type JiraLease,
  type JiraCredential,
  jiraAuthorization,
  resolveJiraCredential,
} from "./credential.ts";
import { currentMs } from "../../../../../../shared/time.ts";

/** How to repair an absent or refused Jira credential. */
export const JIRA_CREDENTIAL_HELP =
  "Check JIRA_BEARER_TOKEN or JIRA_TOKEN_COMMAND, or JIRA_EMAIL and JIRA_API_TOKEN. Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens and ensure the account or token has access to the Jira site.";

/**
 * The scopes a scoped or OAuth token needs to read the account it acts as
 * (`myself`), which the adapter does before any issue or search read.
 */
export const JIRA_ACCOUNT_SCOPE_HELP =
  "A scoped API token or an OAuth access token also needs the classic read:jira-user scope, or all of the granular read:application-role:jira, read:group:jira, read:user:jira and read:avatar:jira scopes, to read the account it acts as.";

export const JIRA_TIMEOUT_MS = 30_000;

/** The page size every listing asks for. */
export const PAGE = 100;

export interface JiraRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Under `/rest/api/3/`, without a leading slash: `issue/ENG-1`. */
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  /** A read-only POST, such as search/jql; GETs are reads by definition. */
  idempotent?: boolean;
  /** A multipart form sent instead of `body`: a file upload, which Jira takes only with its no-check header. */
  form?: FormData;
  /** Resolve to the answer's body as bytes rather than JSON: a file's content. */
  bytes?: boolean;
}

/**
 * One REST request; resolves to the response's JSON body, `null` when it has
 * none. An aborted `signal` ends the request in flight and refuses to start
 * one.
 */
export type JiraTransport = (
  request: JiraRequest,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * Jira answered with an error, or could not be asked. Its `code` is the
 * failure class, read from `status` when none is given (`invalid` with
 * neither). `notFound` is a `not-found` answer; `unavailable` a class that
 * clears by waiting (no answer, a rate limit, a server fault), which a
 * caller may report as "try later". `errorMessages` and `errors` are Jira's
 * own error body, also carried in the message.
 */
export class JiraApiError extends OutboundError {
  override name = "JiraApiError";
  // Declared fields, not parameter properties: the repository's TypeScript
  // settings allow erasable syntax only.
  readonly status: number | null;
  readonly errorMessages: string[];
  readonly errors: Record<string, string>;
  constructor(
    message: string,
    opts: {
      status?: number | null;
      code?: FailureClass;
      /** The request left and no usable answer came back, so a write may have landed. */
      sent?: boolean;
      until?: number | null;
      retryAfterMs?: number | null;
      errorMessages?: string[];
      errors?: Record<string, string>;
    } = {},
  ) {
    const status = opts.status ?? null;
    super(
      opts.code ?? (status === null ? null : statusClass(status)) ?? "invalid",
      message,
      opts,
    );
    this.status = status;
    this.errorMessages = opts.errorMessages ?? [];
    this.errors = opts.errors ?? {};
  }
  get notFound(): boolean {
    return this.code === "not-found";
  }
  get unavailable(): boolean {
    return this.clearsByWaiting;
  }
  /** The request left and no usable answer came back, so a write may have landed. */
  get answerLost(): boolean {
    return this.sent;
  }
  get retryAfterSec(): number | null {
    return this.retryAfterMs === null ? null : this.retryAfterMs / 1000;
  }
}

/**
 * Has the caller cancelled? A function, not an inline test, so a check after
 * an `await` is not narrowed away by the one before it.
 */
function cancelled(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true;
}

/** `sent`: the request had been dispatched, so a write may have landed. */
export function abortedError(signal: AbortSignal, sent = false): JiraApiError {
  const reason: unknown = signal.reason;
  return new JiraApiError(
    `Jira request cancelled: ${reason instanceof Error ? reason.message : String(reason)}`,
    { code: "unreachable", ...(sent ? { sent: true } : {}) },
  );
}

/** The address of a request, its query encoded. */
export function requestUrl(base: string, request: JiraRequest): string {
  const url = new URL(`${base}/rest/api/3/${request.path}`);
  for (const [k, v] of Object.entries(request.query ?? {}))
    url.searchParams.set(k, String(v));
  return url.toString();
}

/** Jira's error body: `{errorMessages: string[], errors: {field: message}}`. */
function errorBody(body: unknown): {
  errorMessages: string[];
  errors: Record<string, string>;
} {
  if (!isRecord(body)) return { errorMessages: [], errors: {} };
  const errorMessages = Array.isArray(body.errorMessages)
    ? body.errorMessages.filter((m): m is string => typeof m === "string")
    : [];
  const errors: Record<string, string> = {};
  if (isRecord(body.errors))
    for (const [k, v] of Object.entries(body.errors))
      if (typeof v === "string") errors[k] = v;
  return { errorMessages, errors };
}

function parsedOrNull(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    swallow(err, "an error response's body is not JSON; its status says why");
    return null;
  }
}

/** The longest a `Retry-After` may limit a credential; a larger ask is not believed. */
const MAX_LIMIT_MS = 24 * 3_600_000;

/** When a 429 limits the credential until: the header's wait, bounded, else the fallback. */
function limitedUntil(now: number, headers: Headers): number {
  const wait = retryAfterMs(headers, () => now);
  const ms = wait === null ? FALLBACK_LIMIT_MS : wait;
  return now + (ms > MAX_LIMIT_MS ? FALLBACK_LIMIT_MS : ms);
}

/** What an error status means, with Jira's own words and credential recovery guidance when refused. */
export function httpFailure(
  status: number,
  headers: Headers,
  text: string,
  what: string,
  tookMs = 0,
): JiraApiError {
  const { errorMessages, errors } = errorBody(parsedOrNull(text));
  const said = [
    ...errorMessages,
    ...Object.entries(errors).map(([k, v]) => `${k}: ${v}`),
  ].join("; ");
  const message = `Jira API HTTP ${status} on ${what}: ${said === "" ? text.slice(0, 300) : said}`;
  const refused = status === 401 || status === 403;
  // Atlassian's gateway says only "scope does not match" when a token lacks
  // a scope; a dead or invalid token is refused without those words, even on
  // the profile read every client sends first. The account scopes are the
  // ones that read answers for: another request refused this way lacks a
  // scope of its own, which this hint would misname.
  const scopes =
    refused &&
    what === "GET myself" &&
    /scope does not match/i.test(`${said} ${text}`);
  return new JiraApiError(
    refused
      ? `${message}; ${JIRA_CREDENTIAL_HELP}${scopes ? ` ${JIRA_ACCOUNT_SCOPE_HELP}` : ""}`
      : message,
    {
      status,
      code: answerClass(status, tookMs) ?? "invalid",
      ...(status === 429 ? { until: limitedUntil(currentMs(), headers) } : {}),
      retryAfterMs: retryAfterMs(headers),
      errorMessages,
      errors,
    },
  );
}

/** The `fetch` options of a request, bounded by `bound`, the call's deadline. */
function requestInit(
  request: JiraRequest,
  authorization: string,
  bound: AbortSignal,
): RequestInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: authorization,
  };
  const init: RequestInit = {
    method: request.method,
    headers,
    // A redirect would carry the credential to another host.
    redirect: "manual",
    signal: bound,
  };
  if (request.form !== undefined) {
    headers["X-Atlassian-Token"] = "no-check";
    init.body = request.form;
  } else if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(request.body);
  }
  if (request.bytes === true) headers.Accept = "*/*";
  return init;
}

/** A successful answer's body: its JSON, `null` when empty. */
function answerBody(text: string, status: number, what: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new JiraApiError(`Jira returned no JSON on ${what}`, {
      status,
      code: "unreachable",
      sent: true,
    });
  }
}

/** How long a failure's body is waited for: it only words the error, so a stalled one is let go. */
const FAILURE_BODY_WAIT_MS = 1_000;

/** Cancels a reader, never waiting past the wait bound or `signal`: a cancel that never settles is let go. */
async function releaseReader(
  reader: { cancel(): Promise<void> },
  signal: AbortSignal | undefined,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: () => void = () => undefined;
  const letGo = new Promise<void>((resolve) => {
    release = resolve;
    timer = setTimeout(resolve, FAILURE_BODY_WAIT_MS);
    if (signal?.aborted === true) resolve();
    else signal?.addEventListener("abort", release, { once: true });
  });
  try {
    await Promise.race([reader.cancel().catch(() => undefined), letGo]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", release);
  }
}

/** A failure's body, read through a reader this owns: a stalled one is cancelled through it, which releases the stream. */
async function failureBodyText(
  res: Response,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveStalled: (v: "stalled") => void = () => undefined;
  const stop = () => resolveStalled("stalled");
  const stalled = new Promise<"stalled">((resolve) => {
    resolveStalled = resolve;
    timer = setTimeout(stop, FAILURE_BODY_WAIT_MS);
    if (signal?.aborted === true) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });
  const drain = async (): Promise<"done"> => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return "done";
      text += decoder.decode(chunk.value, { stream: true });
    }
  };
  const settled = drain();
  try {
    const outcome = await Promise.race([settled, stalled]);
    if (outcome === "stalled") {
      settled.catch(() => undefined);
      await releaseReader(reader, signal);
      return "";
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/** The answer's body; one lost while reading fails a success, and is empty on a failure. */
async function bodyText(
  res: Response,
  signal: AbortSignal | undefined,
  what: string,
): Promise<string> {
  try {
    if (res.ok) return await res.text();
    return await failureBodyText(res, signal);
  } catch (err) {
    if (cancelled(signal)) throw abortedError(signal, true);
    if (!res.ok) return "";
    throw new JiraApiError(
      `Jira answer lost while reading the body on ${what}: ${err instanceof Error ? err.message : String(err)}`,
      { code: "unreachable", sent: true, status: res.status },
    );
  }
}

/** A successful answer's body as bytes; one lost while reading fails the read. */
async function fileBytes(
  res: Response,
  signal: AbortSignal | undefined,
  what: string,
): Promise<Uint8Array> {
  try {
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    if (cancelled(signal)) throw abortedError(signal, true);
    throw new JiraApiError(
      `Jira answer lost while reading the file on ${what}: ${err instanceof Error ? err.message : String(err)}`,
      { code: "unreachable", sent: true, status: res.status },
    );
  }
}

/** The header to send, or the credential's failure as the adapter's error. */
function headerOf(
  header: Outcome<string, CredentialCode>,
  signal: AbortSignal | undefined,
): string {
  if (!header.ok && header.failure.code === "token-command-unavailable")
    throw new JiraApiError(header.failure.reason, { code: "unreachable" });
  if (cancelled(signal)) throw abortedError(signal);
  if (!header.ok)
    throw new JiraApiError(header.failure.reason, { code: "unauthorized" });
  return header.value;
}

/** Sends one request; a request that could not be made fails as unreachable. */
async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  what: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    if (cancelled(signal)) throw abortedError(signal, true);
    throw new JiraApiError(
      `Jira API unreachable on ${what}: ${err instanceof Error ? err.message : String(err)}`,
      { code: "unreachable", sent: true },
    );
  }
}

/** A 429 limits the credential in the budget until its reset, and ends the call: nothing is sent before then. */
function observeLimit(
  response: Response,
  key: string,
  what: string,
  governor: BudgetGovernor | undefined,
): TrackerRateLimited | null {
  if (response.status !== 429 || governor === undefined) return null;
  const until = limitedUntil(currentMs(), response.headers);
  const why = `Jira refused ${what} (HTTP 429)`;
  governor.observe(key, { limitedUntil: until, why });
  return new TrackerRateLimited("jira", until, why);
}

/** The failure a response that took `tookMs` stands for, `null` for a success: what decides whether a read is sent again. */
function responseFailure(
  res: Response,
  tookMs: number,
): OutboundFailure | null {
  const code = answerClass(res.status, tookMs);
  return code === null
    ? null
    : outboundFailure(code, `Jira API HTTP ${res.status}`, {
        retryAfterMs: retryAfterMs(res.headers),
      });
}

/** One attempt's answer with its body, read inside the attempt. */
interface Read {
  res: Response;
  text?: string;
  bytes?: Uint8Array;
  /** A successful answer's decoded body, read inside the attempt. */
  data?: unknown;
}

/** Keep one call's leased credential and renewal separate from its read retries. */
function leasedSender(
  base: string,
  request: JiraRequest,
  lease: JiraLease,
  bound: AbortSignal,
  fetchImpl: typeof fetch,
  governor: BudgetGovernor | undefined,
): () => Promise<Read> {
  const what = `${request.method} ${request.path}`;
  const url = requestUrl(base, request);
  const keyOf = (header: string) => credentialKey("jira", `${base} ${header}`);
  let header = headerOf(lease.header, bound);
  const once = (): Promise<Read> => {
    const key = keyOf(header);
    const observation: Attempt = {
      system: "jira",
      credential: key,
      operation: restOperation(request.method, request.path),
      requests: 0,
      cost: null,
      unit: "requests",
      estimated: false,
    };
    const began = Date.now();
    return recordAttempt(
      observation,
      async () => {
        governor?.admit("jira", key);
        observation.requests = 1;
        observation.cost = 1;
        const res = await send(
          fetchImpl,
          url,
          requestInit(request, header, bound),
          bound,
          what,
        );
        const refused = observeLimit(res, key, what, governor);
        if (refused !== null) {
          void discardBody(res, bound);
          throw refused;
        }
        if (request.bytes === true && res.ok)
          return { res, bytes: await fileBytes(res, bound, what) };
        const text = await bodyText(res, bound, what);
        return res.ok
          ? { res, text, data: answerBody(text, res.status, what) }
          : { res, text };
      },
      (answer) => responseFailure(answer.res, Date.now() - began)?.code ?? null,
    );
  };
  return async () => {
    let answer = await once();
    if (answer.res.status === 401) {
      const renewed = await lease.renew(bound);
      if (renewed !== null) {
        try {
          header = headerOf(renewed, bound);
          answer = await once();
          if (answer.res.status === 401) lease.refuseRenewal();
        } finally {
          lease.settleRenewal();
        }
      }
    }
    return answer;
  };
}

/**
 * HTTPS transport to `base`, the site or its API gateway address; each call
 * bounded as a whole by `JIRA_TIMEOUT_MS`. A read that met `unreachable` or
 * `server-fault` is sent once more within that deadline, rechecking credential
 * holds before it is sent; a 429 is never sent again before its reset.
 * A 401 renews the header once, when the
 * credential can be renewed, and sends the request again with it: a 401 is
 * refused before the request is acted on, so a write is not doubled. With
 * `governor` (the machine's request budget), a call is refused locally while
 * the credential is rate limited, and an HTTP 429 limits it until its
 * `Retry-After`. The budget names the credential by the header it resolves to,
 * however it was supplied; it is hashed, never stored.
 */
export function httpTransport(
  base: string,
  authorization: JiraAuthorization,
  fetchImpl: typeof fetch = fetch,
  governor?: BudgetGovernor,
  firstRefusal?: string,
): JiraTransport {
  // Until one request succeeds, a 403 carries `firstRefusal`: a credential
  // the host does not take is refused on the first request.
  let answered = false;
  const system = `jira:${new URL(base).host}`;
  return async (request, signal) => {
    if (cancelled(signal)) throw abortedError(signal);
    const what = `${request.method} ${request.path}`;
    // One deadline for the whole call: the token command, the request, a
    // renewal and the request sent again all spend the same budget.
    const deadlineAt = currentMs() + JIRA_TIMEOUT_MS;
    const deadline = AbortSignal.timeout(JIRA_TIMEOUT_MS);
    const bound =
      signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
    const lease = await authorization.lease(bound);
    if (cancelled(signal)) throw abortedError(signal);
    const sender = leasedSender(
      base,
      request,
      lease,
      bound,
      fetchImpl,
      governor,
    );
    let tookMs = 0;
    // Once an attempt has begun, a cancellation may have cut a request that
    // landed: `retryRead` throws the bare reason, which carries no marker.
    let dispatched = false;
    // The attempt reads and decodes the body too: a peer that drops the
    // connection after its headers, or answers with no JSON, is `unreachable`
    // inside the retry and the hold.
    const timed = async (): Promise<Read> => {
      const began = currentMs();
      dispatched = true;
      const answer = await sender();
      tookMs = currentMs() - began;
      return answer;
    };
    const failureOf = (answer: Read) => responseFailure(answer.res, tookMs);
    const read = await guarded(
      system,
      () =>
        retryRead(timed, {
          read: request.method === "GET" || request.idempotent === true,
          signal: bound,
          deadlineAt,
          failureOf,
        }),
      failureOf,
      (failure) => {
        throw new JiraApiError(failure.reason, { code: failure.code });
      },
      bound,
    ).catch((err: unknown) => {
      // A call cancelled once its request was dispatched keeps that fact: a
      // write may have landed.
      const sent = dispatched || (err instanceof JiraApiError && err.sent);
      if (cancelled(signal)) throw abortedError(signal, sent);
      if (cancelled(bound)) throw abortedError(bound, sent);
      throw err;
    });
    const res = read.res;
    if (read.bytes !== undefined) {
      answered = true;
      return read.bytes;
    }
    const text = read.text ?? "";
    if (!res.ok) {
      const failure = httpFailure(res.status, res.headers, text, what, tookMs);
      if (res.status !== 403 || answered || firstRefusal === undefined)
        throw failure;
      throw new JiraApiError(`${failure.message} (${firstRefusal})`, {
        status: failure.status,
        code: failure.code,
        retryAfterMs: failure.retryAfterMs,
        errorMessages: failure.errorMessages,
        errors: failure.errors,
      });
    }
    answered = true;
    return read.data;
  };
}

/**
 * The transport the environment's credential supports, to `base`. A missing
 * or unreadable credential fails the first request rather than the opening,
 * so reading keys works offline.
 */
export function defaultTransport(
  base: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): JiraTransport {
  const credential = resolveJiraCredential(env);
  if (!credential.ok) {
    const { reason } = credential.failure;
    return async () => {
      throw new JiraApiError(`${reason}; ${JIRA_CREDENTIAL_HELP}`, {
        code: "unauthorized",
      });
    };
  }
  const refusal = bearerOnSite(credential.value, base);
  if (refusal !== null)
    return async () => {
      throw new JiraApiError(refusal, { code: "unauthorized" });
    };
  const variable = bearerVariable(credential.value);
  return httpTransport(
    base,
    jiraAuthorization(credential.value),
    fetchImpl,
    defaultGovernor(),
    variable === null || new URL(base).hostname === "api.atlassian.com"
      ? undefined
      : `the Bearer token from ${variable} was refused by ${new URL(base).hostname}; check that this host accepts a Bearer token at its own address`,
  );
}

/** The variable that supplies a Bearer token, `null` for any other credential. */
function bearerVariable(credential: JiraCredential): string | null {
  if (credential.kind === "bearer") return "JIRA_BEARER_TOKEN";
  if (credential.kind === "command") return "JIRA_TOKEN_COMMAND";
  return null;
}

/**
 * Why a Bearer credential cannot go to `base`, `null` when it can. An
 * Atlassian Cloud site answers a Bearer token with a 403 that names no
 * cause: those tokens belong to the API gateway (`issue_tracker.jira.api_base`).
 * A site another host serves, allowed through `JIRA_ALLOWED_HOSTS`, may take
 * a personal access token at its own address and is left alone.
 */
function bearerOnSite(credential: JiraCredential, base: string): string | null {
  const variable = bearerVariable(credential);
  if (variable === null) return null;
  if (!new URL(base).hostname.toLowerCase().endsWith(".atlassian.net"))
    return null;
  return `${variable} gives a Bearer token, which Atlassian Cloud accepts only through its API gateway, not at ${new URL(base).hostname}: set issue_tracker.jira.api_base to https://api.atlassian.com/ex/jira/<cloud id>`;
}

// ── Pagers ─────────────────────────────────────────────────────────────────

function shape(where: string, what: string): JiraApiError {
  return new JiraApiError(`${where}: ${what}`);
}

export interface OffsetOptions {
  /** The array in each page: `values`, `comments`, … */
  items: string;
  /** What tells items apart. */
  idOf: (item: Record<string, unknown>) => unknown;
  where: string;
  signal?: AbortSignal;
  /** The items are strings (label names), each read as `{name}`. */
  strings?: boolean;
}

/** Remembers the ids a read has seen, refusing one seen before. */
function idGuard(where: string): (id: unknown) => void {
  const seen = new Set<string>();
  return (id) => {
    const key = typeof id === "number" ? String(id) : id;
    if (typeof key !== "string") return;
    if (seen.has(key)) throw shape(where, `${key} repeated across pages`);
    seen.add(key);
  };
}

/** The items of one offset page, as records. */
function offsetItems(
  page: unknown,
  opts: OffsetOptions,
): Record<string, unknown>[] {
  if (!isRecord(page)) throw shape(opts.where, "a page is not an object");
  const items = page[opts.items];
  if (!Array.isArray(items))
    throw shape(opts.where, `a page has no ${opts.items} list`);
  return items.map((item, i) => {
    const wrapped =
      opts.strings === true && typeof item === "string" ? { name: item } : item;
    if (!isRecord(wrapped))
      throw shape(opts.where, `item ${i} is not an object`);
    return wrapped;
  });
}

/** Whether an offset page is the last, given where the next one would start. */
function lastOffsetPage(
  page: Record<string, unknown>,
  next: number,
  where: string,
): boolean {
  if (page.isLast === true) return true;
  if (typeof page.total === "number") return next >= page.total;
  if (page.isLast !== false)
    throw shape(where, "a page says neither isLast nor total");
  return false;
}

/**
 * Every item of an offset-paged listing. The end is `isLast: true`, else
 * `startAt + items.length >= total`; a page with neither, an item seen on
 * an earlier page, or an empty page before the end fails the read.
 */
export async function offsetPages(
  transport: JiraTransport,
  request: JiraRequest,
  opts: OffsetOptions,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const guard = idGuard(opts.where);
  for (let startAt = 0; ; ) {
    const query = { ...request.query, startAt, maxResults: PAGE };
    const page = await transport({ ...request, query }, opts.signal);
    const items = offsetItems(page, opts);
    for (const item of items) {
      guard(opts.strings === true ? item.name : opts.idOf(item));
      out.push(item);
    }
    const next = startAt + items.length;
    if (lastOffsetPage(page as Record<string, unknown>, next, opts.where))
      return out;
    if (items.length === 0)
      throw shape(opts.where, "an empty page before the end of the list");
    startAt = next;
  }
}

/** The issues of one search page, each with a key. */
function searchIssues(page: unknown, where: string): Record<string, unknown>[] {
  if (!isRecord(page) || !Array.isArray(page.issues))
    throw shape(where, "a search page has no issues list");
  return page.issues.map((issue) => {
    if (!isRecord(issue) || typeof issue.key !== "string")
      throw shape(where, "a search result has no key");
    return issue;
  });
}

/** The token of the page after `page`, `null` at the end. */
function nextToken(
  page: Record<string, unknown>,
  seen: Set<string>,
  where: string,
): string | null {
  if (typeof page.isLast !== "boolean")
    throw shape(where, "a search page does not say whether it is the last");
  if (page.isLast) return null;
  const token = page.nextPageToken;
  if (typeof token !== "string" || seen.has(token))
    throw shape(where, "the next page token is missing or repeated");
  seen.add(token);
  return token;
}

/**
 * Every issue a JQL query selects, through `POST search/jql`. Pages follow
 * `nextPageToken` until `isLast`; a page without `isLast`, a token seen
 * twice, or a key repeated across pages fails the read.
 */
export async function searchPages(
  transport: JiraTransport,
  jql: string,
  fields: ReadonlyArray<string>,
  where: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const guard = idGuard(where);
  const tokens = new Set<string>();
  let token: string | null = null;
  do {
    const body = {
      jql,
      fields,
      maxResults: PAGE,
      ...(token === null ? {} : { nextPageToken: token }),
    };
    const page = await transport(
      { method: "POST", path: "search/jql", body, idempotent: true },
      signal,
    );
    for (const issue of searchIssues(page, where)) {
      guard(issue.key);
      out.push(issue);
    }
    token = nextToken(page as Record<string, unknown>, tokens, where);
  } while (token !== null);
  return out;
}
