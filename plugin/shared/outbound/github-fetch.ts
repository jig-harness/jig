/**
 * GitHub's API over `fetch`: a second transport to GitHub beside the `gh`
 * command-line client (`shared/trace.ts`), for code that may run no
 * program, such as the hub's core. It keeps the obligations every
 * transport keeps ([ADR-0021](../../../docs/adr/ADR-0021-outbound-calls-are-governed.md)):
 *
 * - **Reuse an answer.** A read sent with `conditional` asks with the
 *   validator of the body it holds (`If-None-Match`, `cache.ts`); a
 *   `304 Not Modified` answers with the held body, is counted as not
 *   modified and is charged nothing.
 * - **Ask the shared budget.** Each request is admitted against the
 *   credential's record through the `BudgetGovernor` it is given, and what
 *   its answer said of the limits is read the way the `gh` path reads it
 *   (`github-answer.ts`), so a refusal either transport meets holds the
 *   other.
 * - **Bound the cost.** Every call carries the caller's `AbortSignal` and
 *   deadline, a read is sent again at most once (`retry.ts`), and a paged
 *   read stops at `MOST_PAGES` pages.
 * - **Record what it cost.** Each attempt, a refused one included, is told
 *   to the recorder it is given as one `CallRecord`, with its operation
 *   (`operations.ts`) and, where known, its repository.
 * - **Fail as a closed class.** Every failure is an `OutboundFailure` of a
 *   class in `failure.ts`; nothing throws but a `Defect`.
 *
 * The transport keeps nothing itself: the platform's `fetch`, the token,
 * the budget's store, the held bodies and the ledger are all injected.
 */
import { isRecord } from "../guards.ts";
import { Defect, ok } from "../outcome.ts";
import { currentMs } from "../time.ts";
import type { BudgetGovernor } from "./budget-governor.ts";
import {
  conditionalHeaders,
  revalidated,
  type ValidatedBody,
} from "./cache.ts";
import {
  type FailureClass,
  failureOf,
  type OutboundFailure,
  outboundFailure,
} from "./failure.ts";
import { apiRoute } from "./gh-route.ts";
import {
  admissionOf,
  type Governed,
  governedRequest,
  type GitHubLimit,
  limitsOf,
  measuredCost,
} from "./github-answer.ts";
import { linkNext } from "./paging.ts";
import { gitHubHttpFailure, graphQLErrorsClass } from "./github.ts";
import type { CallRecord } from "./ledger.ts";
import { queryOperation, restOperation } from "./operations.ts";
import { retryRead } from "./retry.ts";

/** The most pages one paged read sends. */
const MOST_PAGES = 100;

/** Held bodies of conditional reads, by key and request, as `validatorCache` keeps them. */
export interface HeldBodies {
  get(key: string, request: string): ValidatedBody | null;
  set(key: string, request: string, etag: string, body: string): void;
}

/** What the transport is given: how to send, as whom, and where its records go. */
export interface GitHubFetchOptions {
  /** Sends one HTTP request: the platform's `fetch`, or a test's. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The REST API's base: `https://api.github.com` (the default), or an Enterprise Server's `https://HOST/api/v3`. */
  baseUrl?: string;
  /** The token to send; `null` or empty when there is none, which fails the call as `unauthorized`. */
  token: (signal: AbortSignal) => Promise<string | null> | string | null;
  /** The opaque key the credential's ledger rows and held bodies are kept under, never the token. */
  credential: string;
  /** The opaque key of the quota's owner (the user or installation the forge counts spending against), which the `gh` transport's budget record is kept under too; the credential's when left out. */
  quotaOwner?: string;
  /** Tells each attempt to the cost ledger. */
  record: (call: CallRecord) => void;
  /** The shared budget; left out, requests are admitted without one. */
  governor?: BudgetGovernor;
  /** Bodies held for conditional reads; left out, nothing is reused. */
  held?: HeldBodies;
  /** The caller the ledger rows name; left out, the recorder's own. */
  caller?: string;
  /** Names an anonymous GraphQL document's digest in its operation; a short non-cryptographic hash when left out. */
  digest?: (text: string) => string;
  now?: () => number;
  /** The wait before a read is sent again; for tests. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

/** What every call carries: its cancellation, its deadline, and what the ledger names it by. */
export interface GitHubCall {
  signal: AbortSignal;
  /** When the call's time is up, epoch milliseconds. */
  deadlineAt: number;
  /** The operation the ledger records; the route's or the document's when left out. */
  operation?: string;
  /** The repository the call addresses, `owner/name`; the route's when left out, `null` for none. */
  repository?: string | null;
}

/** A REST request. */
export interface RestRequest extends GitHubCall {
  /** `GET` when left out; only a `GET` is sent again or sent conditionally. */
  method?: string;
  /** The route (`repos/o/r/pulls/1`, a query allowed), or a full URL on the API's origin. */
  path: string;
  /** Sent as JSON. */
  body?: unknown;
  /** Ask with the held body's validator, and keep the answer's. */
  conditional?: boolean;
}

/** A GraphQL request. */
export interface GraphQLRequest extends GitHubCall {
  query: string;
  variables?: Record<string, unknown>;
}

/** A REST answer that succeeded. */
export interface GitHubAnswer {
  status: number;
  headers: Headers;
  /** The answer's body, or the held body a `304` confirmed. */
  body: string;
  /** A conditional read was answered `304 Not Modified`. */
  notModified: boolean;
}

/** A call's outcome: its value, or the closed-class failure it met; an `Outcome` whose failure is an `OutboundFailure`. */
export type Called<T> =
  | { ok: true; value: T }
  | { ok: false; failure: OutboundFailure };

/** One request as the transport sends it. */
interface Sending {
  method: string;
  url: string;
  route: string;
  body: string | undefined;
  limits: readonly GitHubLimit[];
  operation: string;
  repository: string | null;
  unit: "requests" | "points";
  held: ValidatedBody | null;
  call: GitHubCall;
}

/** What one attempt received. */
interface Received {
  status: number;
  headers: Headers;
  text: string;
  tookMs: number;
}

/** What one send came to: what it received, or its failure, with the headers of an answer whose body could not be read. */
type Sent =
  | { ok: true; value: Received }
  | { ok: false; failure: OutboundFailure; headers: Headers | null };

/** The record windows the headers' `x-ratelimit-resource` names. */
const RESOURCE_WINDOWS: Readonly<Record<string, string>> = {
  core: "requests",
  graphql: "complexity",
  search: "search",
};

/** A short FNV-1a digest, twelve hex digits, for a platform with no hash at hand. */
function shortDigest(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 ^ a) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`.slice(
    0,
    12,
  );
}

/** The repository a route under `repos/<owner>/<name>` names, lowercased; `null` for any other. */
function routeRepository(route: string): string | null {
  const match = /^repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:\/|$)/.exec(
    route,
  );
  return match === null ? null : `${match[1]}/${match[2]}`.toLowerCase();
}

/** The origin (scheme, host and port) the API's base names; a base that is no https URL is a caller's defect. */
function apiOrigin(baseUrl: string): string {
  if (!URL.canParse(baseUrl) || new URL(baseUrl).protocol !== "https:")
    throw new Defect(`GitHub's API base is no https URL: ${baseUrl}`);
  return new URL(baseUrl).origin;
}

/** Whether `url` is an https URL on exactly `origin`, with no credentials in it. */
function onOrigin(url: string, origin: string): boolean {
  if (!URL.canParse(url)) return false;
  const at = new URL(url);
  return at.origin === origin && at.username === "" && at.password === "";
}

/** The next page's URL the `Link` header names, when it is on `origin`. */
function nextOn(headers: Headers | null, origin: string): string | null {
  const url = linkNext(headers);
  return url !== null && onOrigin(url, origin) ? url : null;
}

/** Where a block string starting at `i` ends. */
function afterBlockString(document: string, start: number): number {
  let i = start + 3;
  while (i < document.length && !document.startsWith('"""', i))
    i += document.startsWith('\\"""', i) ? 4 : 1;
  return i + 3;
}

/** Where a string starting at `i` ends. */
function afterString(document: string, start: number): number {
  let i = start + 1;
  while (i < document.length && document[i] !== '"' && document[i] !== "\n")
    i += document[i] === "\\" ? 2 : 1;
  return i + 1;
}

/** Where a comment starting at `i` ends. */
function afterComment(document: string, start: number): number {
  let i = start;
  while (i < document.length && document[i] !== "\n") i += 1;
  return i;
}

/** Whether a GraphQL document holds a mutation or a subscription, which are never sent again: a lexical scan that skips strings, block strings and comments, so none hides or fakes a keyword. */
function writesOrStreams(document: string): boolean {
  let code = "";
  let i = 0;
  while (i < document.length) {
    const c = document[i];
    if (document.startsWith('"""', i)) {
      i = afterBlockString(document, i);
      code += " ";
    } else if (c === '"') {
      i = afterString(document, i);
      code += " ";
    } else if (c === "#") {
      i = afterComment(document, i);
    } else {
      code += c;
      i += 1;
    }
  }
  return /\b(?:mutation|subscription)\b/.test(code);
}

/** The GraphQL endpoint beside a REST base: `/graphql` on github.com, `/api/graphql` on an Enterprise Server. */
function graphqlUrl(baseUrl: string): string {
  return /\/api\/v3$/.test(baseUrl)
    ? baseUrl.replace(/\/api\/v3$/, "/api/graphql")
    : `${baseUrl}/graphql`;
}

/** Send GitHub's API over `fetch`, under the obligations in the module comment. */
export function githubFetchTransport(options: GitHubFetchOptions) {
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  const origin = apiOrigin(baseUrl);
  const now = options.now ?? currentMs;
  const digest = options.digest ?? shortDigest;
  /** A held body's storage key: the credential and the URL, so no two endpoints share an entry. */
  const heldKey = (url: string) => `${options.credential}\n${url}`;

  /** The request's URL: a full URL is taken only on exactly the API's origin, port included. */
  function urlOf(path: string): string | null {
    if (/^https?:\/\//i.test(path)) return onOrigin(path, origin) ? path : null;
    return `${baseUrl}/${path.replace(/^\/+/, "")}`;
  }

  /** Tell the ledger what one attempt cost. */
  function recordAttempt(
    sending: Sending,
    began: number,
    outcome: {
      requests: number;
      cost: number | null;
      estimated: boolean;
      notModified: boolean;
      window: string;
      failure: FailureClass | null;
    },
  ): void {
    options.record({
      system: "github",
      credential: options.credential,
      owner: options.quotaOwner ?? options.credential,
      window: outcome.window,
      operation: sending.operation,
      ...(options.caller === undefined ? {} : { caller: options.caller }),
      repository: sending.repository,
      requests: outcome.requests,
      notModified: outcome.notModified ? 1 : 0,
      cost: outcome.cost,
      unit: sending.unit,
      estimated: outcome.estimated,
      durationMs: Math.max(0, now() - began),
      failure: outcome.failure,
      at: began,
    });
  }

  /** The window a request spent: the one its answer's headers named, else its limits'. */
  function windowOf(sending: Sending, headers: Headers | null): string {
    const resource = headers?.get("x-ratelimit-resource")?.trim().toLowerCase();
    if (resource) return RESOURCE_WINDOWS[resource] ?? resource;
    const [only] = sending.limits;
    if (only === undefined) return "none";
    return RESOURCE_WINDOWS[only] ?? only;
  }

  /** Admit the request against the budget; the governed request, or the refusal to answer with. */
  function admit(
    sending: Sending,
  ):
    | { governed: Governed | null; sentAt: number }
    | { refused: OutboundFailure } {
    const governor = options.governor;
    if (governor === undefined || sending.limits.length === 0)
      return { governed: null, sentAt: now() };
    const governed = governedRequest(
      governor,
      options.quotaOwner ?? options.credential,
      admissionOf(sending.limits, {
        conditional: sending.held !== null,
        readable: true,
      }),
    );
    const admitted = governed.admit();
    return "refused" in admitted
      ? admitted
      : { governed, sentAt: admitted.sentAt };
  }

  /** Send once: `fetch` within the call's deadline; what it received, or the failure a throw stands for. */
  async function send(sending: Sending, token: string): Promise<Sent> {
    const began = now();
    const left = Math.max(1, sending.call.deadlineAt - began);
    const signal = AbortSignal.any([
      sending.call.signal,
      AbortSignal.timeout(left),
    ]);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...conditionalHeaders(sending.held),
      ...(sending.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    };
    let answered: Headers | null = null;
    try {
      const response = await options.fetch(sending.url, {
        method: sending.method,
        headers,
        signal,
        ...(sending.body === undefined ? {} : { body: sending.body }),
      });
      // What the answer said about the budget stands even when its body
      // cannot be read.
      answered = response.headers;
      const text = await response.text();
      return ok({
        status: response.status,
        headers: response.headers,
        text,
        tookMs: now() - began,
      });
    } catch (error) {
      // A fetch that throws got no answer: the network failed, or the
      // call's signal or deadline ended it. A defect in the fetch it was
      // given is a bug, for the unit's boundary to report.
      if (error instanceof Defect) throw error;
      const said = failureOf(error);
      return {
        ok: false,
        failure: outboundFailure(
          said.code === "invalid" ? "unreachable" : said.code,
          `GitHub ${sending.method} ${sending.route} got no answer: ${said.reason}`,
          { sent: sending.method !== "GET", cause: error },
        ),
        headers: answered,
      };
    }
  }

  /** The failure an answer stands for: its status's, else a GraphQL answer's errors; `null` for a success. */
  function answerFailure(
    sending: Sending,
    received: Received,
  ): OutboundFailure | null {
    if (received.status === 304)
      return sending.held === null
        ? outboundFailure(
            "invalid",
            `GitHub answered 304 to ${sending.route}, which held nothing`,
          )
        : null;
    const http = gitHubHttpFailure(
      received.status,
      received.headers,
      received.text,
      received.tookMs,
      now,
    );
    if (http !== null || sending.route !== "graphql") return http;
    let value: unknown;
    try {
      value = JSON.parse(received.text);
    } catch (error) {
      return outboundFailure("invalid", "GitHub's GraphQL answer is not JSON", {
        cause: error,
      });
    }
    const errors = (
      isRecord(value) && Array.isArray(value.errors) ? value.errors : []
    ).map((e: unknown) => (isRecord(e) ? e : {}));
    if (errors.length === 0) return null;
    const first = errors[0]?.message;
    return outboundFailure(
      graphQLErrorsClass(
        errors.map((e) => (typeof e?.type === "string" ? e.type : "")),
      ),
      `GitHub GraphQL: ${typeof first === "string" ? first : "the answer carries errors"}`,
    );
  }

  /** What a received answer cost: a 304 nothing, a GraphQL answer the points it reports, a REST request one. */
  function costOf(
    sending: Sending,
    received: Received,
  ): { cost: number | null; estimated: boolean } {
    if (received.status === 304) return { cost: 0, estimated: false };
    if (sending.route === "rate_limit") return { cost: 0, estimated: false };
    if (sending.route === "graphql") {
      const points = measuredCost(received.text);
      return points === null
        ? { cost: 1, estimated: true }
        : { cost: points, estimated: false };
    }
    return {
      cost: 1,
      estimated: !received.headers.has("x-ratelimit-remaining"),
    };
  }

  /** The token, within the call's deadline and cancellation: the provider is handed the signal, and an acquisition that outlasts either gives no token (the caller then finds the call spent). */
  async function acquireToken(call: GitHubCall): Promise<string | null> {
    const signal = AbortSignal.any([
      call.signal,
      AbortSignal.timeout(Math.max(1, call.deadlineAt - now())),
    ]);
    if (signal.aborted) return null;
    // Listening starts before the provider runs, so an abort it causes
    // itself is seen; the listener is removed once the race is decided.
    let onAbort: () => void = () => undefined;
    const ended = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const asked = Promise.resolve(options.token(signal));
      // A provider that settles after the race ended has nobody to tell.
      asked.catch(() => undefined);
      return await Promise.race([asked, ended]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** The refusal when the call was cancelled or its time is up: nothing was sent. */
  function spent(sending: Sending): OutboundFailure | null {
    if (sending.call.signal.aborted)
      return outboundFailure(
        "unreachable",
        "the call was cancelled; nothing was sent",
      );
    if (now() >= sending.call.deadlineAt)
      return outboundFailure(
        "unreachable",
        "the call's deadline was spent before it was sent; nothing was sent",
      );
    return null;
  }

  /** The token the call may send with, or the failure that stops it before anything is sent. */
  async function readyToSend(
    sending: Sending,
  ): Promise<{ token: string } | { failure: OutboundFailure }> {
    const before = spent(sending);
    if (before !== null) return { failure: before };
    const acquired = await acquireToken(sending.call);
    // Acquisition takes time of its own: the call may have ended meanwhile.
    const after = spent(sending);
    if (after !== null) return { failure: after };
    const token = acquired?.trim() ?? "";
    if (token === "")
      return {
        failure: outboundFailure(
          "unauthorized",
          "no GitHub token is configured for this transport; nothing was sent",
        ),
      };
    return { token };
  }

  /** What an answer GitHub gave comes to: observed into the budget, recorded, and kept for revalidation. */
  function settle(
    sending: Sending,
    began: number,
    received: Received,
    governed: Governed | null,
    sentAt: number,
  ): Called<GitHubAnswer> {
    let failure = answerFailure(sending, received);
    const until = governed?.observe(
      ["api", sending.route],
      received.headers,
      received.text,
      failure,
      sentAt,
    );
    if (failure?.code === "rate-limited" && until != null)
      failure = { ...failure, until: Math.max(until, failure.until ?? 0) };
    const read =
      failure === null
        ? revalidated(
            received.status,
            received.headers.get("etag") ?? "",
            received.text,
            sending.held,
          )
        : null;
    const notModified = read?.ok === true && !read.value.changed;
    recordAttempt(sending, began, {
      requests: 1,
      ...costOf(sending, received),
      notModified,
      window: windowOf(sending, received.headers),
      failure: failure?.code ?? null,
    });
    if (failure !== null) return { ok: false, failure };
    if (read === null || !read.ok)
      return {
        ok: false,
        failure: outboundFailure(
          "invalid",
          `GitHub answered ${sending.route} with HTTP ${received.status}`,
        ),
      };
    if (read.value.keep !== null && sending.method === "GET")
      options.held?.set(
        heldKey(sending.url),
        sending.url,
        read.value.keep.etag,
        read.value.keep.body,
      );
    return ok({
      status: received.status,
      headers: received.headers,
      body: read.value.body,
      notModified,
    });
  }

  /** One attempt: admitted, sent, observed into the budget and recorded. */
  async function attempt(sending: Sending): Promise<Called<GitHubAnswer>> {
    const began = now();
    const local = (failure: OutboundFailure): Called<GitHubAnswer> => {
      recordAttempt(sending, began, {
        requests: 0,
        cost: 0,
        estimated: false,
        notModified: false,
        window: windowOf(sending, null),
        failure: failure.code,
      });
      return { ok: false, failure };
    };
    const ready = await readyToSend(sending);
    if ("failure" in ready) return local(ready.failure);
    const admitted = admit(sending);
    if ("refused" in admitted) return local(admitted.refused);
    const { governed, sentAt } = admitted;
    const sent = await send(sending, ready.token);
    if (sent.ok) return settle(sending, began, sent.value, governed, sentAt);
    const failure = sent.failure;
    governed?.observe(
      ["api", sending.route],
      sent.headers,
      "",
      failure,
      sentAt,
    );
    recordAttempt(sending, began, {
      requests: 1,
      cost: null,
      estimated: false,
      notModified: false,
      window: windowOf(sending, sent.headers),
      failure: failure.code,
    });
    return { ok: false, failure };
  }

  /** Send `sending`, once more for a read whose first answer the retry policy names. */
  async function governedCall(
    sending: Sending,
    read: boolean,
  ): Promise<Called<GitHubAnswer>> {
    let last: Called<GitHubAnswer> | null = null;
    try {
      return await retryRead(
        async () => {
          last = await attempt(sending);
          return last;
        },
        {
          read,
          signal: sending.call.signal,
          failureOf: (answer) => (answer.ok ? null : answer.failure),
          deadlineAt: sending.call.deadlineAt,
          now,
          ...(options.wait === undefined ? {} : { wait: options.wait }),
          ...(options.random === undefined ? {} : { random: options.random }),
        },
      );
    } catch (error) {
      // The caller's signal ended the call: the last attempt's answer
      // stands, or nothing was sent. Anything else that throws is a
      // defect, for the unit's boundary to report.
      if (!sending.call.signal.aborted || error instanceof Defect) throw error;
      return (
        last ?? {
          ok: false,
          failure: outboundFailure(
            "unreachable",
            `GitHub ${sending.method} ${sending.route} was cancelled; nothing was sent`,
            { cause: error },
          ),
        }
      );
    }
  }

  /** A REST request: its answer, or the closed-class failure it met. */
  function rest(request: RestRequest): Promise<Called<GitHubAnswer>> {
    const method = (request.method ?? "GET").toUpperCase();
    const url = urlOf(request.path);
    if (url === null)
      return Promise.resolve({
        ok: false,
        failure: outboundFailure(
          "invalid",
          "a full URL off GitHub's API origin is not sent",
        ),
      });
    const route = apiRoute(["api", url]);
    const held =
      request.conditional === true && method === "GET"
        ? (options.held?.get(heldKey(url), url) ?? null)
        : null;
    return governedCall(
      {
        method,
        url,
        route,
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
        limits: limitsOf(["api", route]) ?? [],
        operation: request.operation ?? restOperation(method, route),
        repository:
          request.repository === undefined
            ? routeRepository(route)
            : request.repository,
        unit: "requests",
        held,
        call: request,
      },
      method === "GET",
    );
  }

  /** A GraphQL request: the answer's `data`, or the closed-class failure it met. A query is sent again as a read; a mutation never. */
  async function graphql(request: GraphQLRequest): Promise<Called<unknown>> {
    // A document that holds a mutation or a subscription is never sent
    // again; one is taken for a read only when the scan finds neither.
    const mutation = writesOrStreams(request.query);
    const answered = await governedCall(
      {
        method: "POST",
        url: graphqlUrl(baseUrl),
        route: "graphql",
        body: JSON.stringify({
          query: request.query,
          ...(request.variables === undefined
            ? {}
            : { variables: request.variables }),
        }),
        limits: ["graphql"],
        operation: request.operation ?? queryOperation(request.query, digest),
        repository: request.repository ?? null,
        unit: "points",
        held: null,
        call: request,
      },
      !mutation,
    );
    if (!answered.ok) return answered;
    try {
      const value: unknown = JSON.parse(answered.value.body);
      return ok(isRecord(value) ? (value.data ?? null) : null);
    } catch (error) {
      return {
        ok: false,
        failure: outboundFailure(
          "invalid",
          "GitHub's GraphQL answer is not JSON",
          { cause: error },
        ),
      };
    }
  }

  /**
   * Every page of a REST list, following the `Link` header's next page on
   * the API's origin: the pages' items in one array (an object page is one
   * item). A page that fails ends the read with its failure; past
   * `MOST_PAGES` pages it fails as `too-costly`.
   */
  async function pages(request: RestRequest): Promise<Called<unknown[]>> {
    const items: unknown[] = [];
    let path: string | null = request.path;
    for (let page = 0; path !== null; page += 1) {
      if (page >= MOST_PAGES)
        return {
          ok: false,
          failure: outboundFailure(
            "too-costly",
            `${request.path} has more than ${MOST_PAGES} pages`,
          ),
        };
      // A page revalidated by `304` would come back without its `Link`
      // header, which the held body does not keep: pages are read whole.
      const answered = await rest({
        ...request,
        path,
        method: "GET",
        conditional: false,
      });
      if (!answered.ok) return answered;
      let value: unknown;
      try {
        value = JSON.parse(answered.value.body);
      } catch (error) {
        return {
          ok: false,
          failure: outboundFailure(
            "invalid",
            `a page of ${request.path} is not JSON`,
            { cause: error },
          ),
        };
      }
      if (Array.isArray(value)) items.push(...value);
      else items.push(value);
      path = nextOn(answered.value.headers, origin);
    }
    return ok(items);
  }

  return { rest, graphql, pages };
}
