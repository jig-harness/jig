/**
 * Jira Cloud's REST API (version 3), for the Jira tracker adapter.
 *
 * Every request goes to `<site>/rest/api/3/<path>` over HTTPS with Basic
 * authentication from an Atlassian account's email and API token
 * (`JIRA_EMAIL`, `JIRA_API_TOKEN`), and is bounded by `JIRA_TIMEOUT_MS`.
 * Tests of the adapter pass a fake transport.
 *
 * Two pagers read a listing to its end: Jira's offset pages (`startAt`,
 * `maxResults`, then `isLast` or `total`) and the token pages of the JQL
 * search (`nextPageToken`, `isLast`). An item repeated across pages, or a
 * page that says nothing about whether it is the last, fails the read: the
 * list moved under it, and a shorter population is never presented as whole.
 */

import { swallow } from "../../../../../../shared/errors.ts";
import { isRecord } from "../../../../../../shared/guards.ts";

export const JIRA_TIMEOUT_MS = 30_000;

/** The page size every listing asks for. */
export const PAGE = 100;

export interface JiraRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Under `/rest/api/3/`, without a leading slash: `issue/ENG-1`. */
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
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
 * Jira answered with an error, or could not be asked. `notFound` is a 404;
 * `unavailable` a request that could not be made or answered (no
 * credential, the network, an expired token, a rate limit, a server error),
 * which a caller may report as "try later". `errorMessages` and `errors`
 * are Jira's own error body, also carried in the message.
 */
export class JiraApiError extends Error {
  // Declared fields, not parameter properties: the repository's TypeScript
  // settings allow erasable syntax only.
  readonly status: number | null;
  readonly notFound: boolean;
  readonly unavailable: boolean;
  readonly retryAfterSec: number | null;
  readonly errorMessages: string[];
  readonly errors: Record<string, string>;
  constructor(
    message: string,
    opts: {
      status?: number | null;
      notFound?: boolean;
      unavailable?: boolean;
      retryAfterSec?: number | null;
      errorMessages?: string[];
      errors?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.status = opts.status ?? null;
    this.notFound = opts.notFound ?? false;
    this.unavailable = opts.unavailable ?? false;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.errorMessages = opts.errorMessages ?? [];
    this.errors = opts.errors ?? {};
  }
}

/**
 * Has the caller cancelled? A function, not an inline test, so a check after
 * an `await` is not narrowed away by the one before it.
 */
function cancelled(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true;
}

function abortedError(signal: AbortSignal): JiraApiError {
  const reason: unknown = signal.reason;
  return new JiraApiError(
    `Jira request cancelled: ${reason instanceof Error ? reason.message : String(reason)}`,
  );
}

/** The address of a request, its query encoded. */
export function requestUrl(site: string, request: JiraRequest): string {
  const url = new URL(`${site}/rest/api/3/${request.path}`);
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

/** The seconds a `Retry-After` header asks to wait, or `null`. */
function retryAfterOf(headers: Headers): number | null {
  const seconds = Number(headers.get("retry-after") ?? Number.NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** What an error status means, with Jira's own words. */
export function httpFailure(
  status: number,
  headers: Headers,
  text: string,
  what: string,
): JiraApiError {
  const { errorMessages, errors } = errorBody(parsedOrNull(text));
  const said = [
    ...errorMessages,
    ...Object.entries(errors).map(([k, v]) => `${k}: ${v}`),
  ].join("; ");
  return new JiraApiError(
    `Jira API HTTP ${status} on ${what}: ${said === "" ? text.slice(0, 300) : said}`,
    {
      status,
      notFound: status === 404,
      unavailable: status === 401 || status === 429 || status >= 500,
      retryAfterSec: retryAfterOf(headers),
      errorMessages,
      errors,
    },
  );
}

/** The credential from the environment, or `null` when either half is missing. */
export function resolveJiraCredential(
  env = process.env,
): { email: string; token: string } | null {
  const email = env.JIRA_EMAIL?.trim();
  const token = env.JIRA_API_TOKEN?.trim();
  return email && token ? { email, token } : null;
}

/** The `fetch` options of a request. */
function requestInit(
  request: JiraRequest,
  authorization: string,
  signal: AbortSignal | undefined,
): RequestInit {
  const timeout = AbortSignal.timeout(JIRA_TIMEOUT_MS);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: authorization,
  };
  const init: RequestInit = {
    method: request.method,
    headers,
    // A redirect would carry the credential to another host.
    redirect: "manual",
    signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
  };
  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(request.body);
  }
  return init;
}

/** A successful answer's body: its JSON, `null` when empty. */
function answerBody(text: string, status: number, what: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new JiraApiError(`Jira returned no JSON on ${what}`, { status });
  }
}

/** The answer's body; one lost while reading fails a success, and is empty on a failure. */
async function bodyText(
  res: Response,
  signal: AbortSignal | undefined,
  what: string,
): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    if (cancelled(signal)) throw abortedError(signal);
    if (!res.ok) return "";
    throw new JiraApiError(
      `Jira answer lost while reading the body on ${what}: ${err instanceof Error ? err.message : String(err)}`,
      { unavailable: true, status: res.status },
    );
  }
}

/** HTTPS transport to `site`; each call bounded by `JIRA_TIMEOUT_MS`. */
export function httpTransport(
  site: string,
  credential: { email: string; token: string },
  fetchImpl: typeof fetch = fetch,
): JiraTransport {
  const basic = Buffer.from(`${credential.email}:${credential.token}`);
  const authorization = `Basic ${basic.toString("base64")}`;
  return async (request, signal) => {
    if (cancelled(signal)) throw abortedError(signal);
    const what = `${request.method} ${request.path}`;
    let res: Response;
    try {
      res = await fetchImpl(
        requestUrl(site, request),
        requestInit(request, authorization, signal),
      );
    } catch (err) {
      if (cancelled(signal)) throw abortedError(signal);
      throw new JiraApiError(
        `Jira API unreachable on ${what}: ${err instanceof Error ? err.message : String(err)}`,
        { unavailable: true },
      );
    }
    const text = await bodyText(res, signal, what);
    if (!res.ok) throw httpFailure(res.status, res.headers, text, what);
    return answerBody(text, res.status, what);
  };
}

/**
 * The transport the environment supports. A missing credential fails the
 * first request rather than the opening, so reading keys works offline.
 */
export function defaultTransport(
  site: string,
  env = process.env,
): JiraTransport {
  const credential = resolveJiraCredential(env);
  if (credential === null)
    return async () => {
      throw new JiraApiError(
        "JIRA_EMAIL and JIRA_API_TOKEN must hold an Atlassian account's email and API token",
        { unavailable: true },
      );
    };
  return httpTransport(site, credential);
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
      { method: "POST", path: "search/jql", body },
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
