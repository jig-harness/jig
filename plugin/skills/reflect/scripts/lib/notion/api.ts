/**
 * The Notion store's client for Notion's public REST API: the integration's
 * token from `NOTION_TOKEN`, the one API version the store is tested
 * against, requests paced to the rate limit, `Retry-After` honoured, and
 * every cursor-paged listing read to its end.
 *
 * Failures carry the store contract's exit codes: 3 (unavailable) for a
 * missing or refused token, a network failure, a rate limit or server
 * error that outlasts the retries, or a write Notion answered with a server
 * error; 1 for anything Notion refused.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { isMapping } from "../../../../resolve-review-comments/scripts/lib/config-layers.ts";

/** The API version every request names, and the tests run against. */
export const NOTION_VERSION = "2026-03-11";

export const DEFAULT_API = "https://api.notion.com";

/**
 * Notion allows an average of three requests a second on most plans, so
 * requests start at least this far apart within one run.
 */
export const DEFAULT_INTERVAL_MS = 340;

const MAX_ATTEMPTS = 6;
const MAX_RETRY_WAIT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

export class NotionError extends Error {
  /** The store contract's exit code: 1 failed, 3 unavailable. */
  readonly code: 1 | 3;
  /** The HTTP status, when Notion answered. */
  readonly status: number | null;
  constructor(code: 1 | 3, message: string, status: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Statuses worth another attempt: rate limit, conflict, server trouble. */
const RETRIED = new Set([409, 429, 500, 502, 503, 504, 529]);

/**
 * Statuses that mean Notion did nothing: a write is retried only on these.
 * After a server error a write may have been committed, so it is not sent
 * again; the caller's retry reads the store first and skips what is there.
 */
const NOT_APPLIED = new Set([409, 429, 529]);

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface ApiOptions {
  token: string;
  base?: string;
  intervalMs?: number;
}

export interface NotionList {
  results: unknown[];
  has_more: boolean;
  next_cursor: string | null;
  request_status?: unknown;
}

/** One run's connection to Notion. */
export class NotionApi {
  readonly base: string;
  private readonly token: string;
  private readonly intervalMs: number;
  private lastStart = 0;
  /** Requests sent, for the tests that count them. */
  requests = 0;

  constructor(options: ApiOptions) {
    this.token = options.token;
    this.base = (options.base ?? DEFAULT_API).replace(/\/+$/, "");
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * The client the environment describes: `NOTION_TOKEN`, and for a local
   * fake or a proxy `JIG_NOTION_API_URL` and `JIG_NOTION_INTERVAL_MS`.
   * Null when there is no token.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): NotionApi | null {
    const token = env.NOTION_TOKEN?.trim();
    if (token === undefined || token === "") return null;
    const interval = env.JIG_NOTION_INTERVAL_MS?.trim();
    if (interval !== undefined && interval !== "" && !/^\d+$/.test(interval))
      throw new NotionError(
        1,
        "JIG_NOTION_INTERVAL_MS must be a whole number of milliseconds",
      );
    const base = env.JIG_NOTION_API_URL?.trim();
    if (base !== undefined && base !== "") checkEndpoint(base);
    return new NotionApi({
      token,
      ...(base === undefined || base === "" ? {} : { base }),
      ...(interval === undefined || interval === ""
        ? {}
        : { intervalMs: Number(interval) }),
    });
  }

  private async pace(): Promise<void> {
    const wait = this.lastStart + this.intervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastStart = Date.now();
  }

  /**
   * One request, retried while Notion asks to wait or has trouble. A read
   * (every GET, and a POST that only queries, marked `read`) is retried on
   * server trouble too; a write only on statuses that mean nothing was done.
   */
  async request(
    method: Method,
    path: string,
    body?: unknown,
    { read = method === "GET" }: { read?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    let failure = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await this.send(method, path, body);
      const text = await response.text();
      if (response.ok) return jsonObject(text, `${method} ${path}`);
      failure = refusal(response.status, errorMessage(text), method, path);
      if (!read && !NOT_APPLIED.has(response.status))
        throw new NotionError(
          3,
          `Notion answered ${method} ${path} with ${failure}; it may have been applied, so it is not sent again`,
          response.status,
        );
      if (attempt < MAX_ATTEMPTS) {
        const wait = retryWait(response.headers.get("retry-after"), attempt);
        if (wait === null)
          throw new NotionError(
            3,
            `Notion asked to wait longer than ${MAX_RETRY_WAIT_MS / 1000}s before ${method} ${path} (${failure})`,
            response.status,
          );
        await sleep(wait);
      }
    }
    throw new NotionError(
      3,
      `Notion kept failing ${method} ${path} after ${MAX_ATTEMPTS} attempts (${failure})`,
    );
  }

  /** Send one request, paced; a request that reaches nobody is unavailable. */
  private async send(
    method: Method,
    path: string,
    body: unknown,
  ): Promise<Response> {
    await this.pace();
    this.requests++;
    const json = body === undefined ? null : JSON.stringify(body);
    try {
      return await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          ...(json === null ? {} : { "Content-Type": "application/json" }),
        },
        ...(json === null ? {} : { body: json }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new NotionError(
        3,
        `Notion could not be reached (${method} ${path}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** One page of a listing, from `cursor` on. */
  private listingPage(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown>,
    cursor: string | null,
  ): Promise<Record<string, unknown>> {
    if (method === "POST")
      return this.request(
        "POST",
        path,
        {
          ...body,
          page_size: 100,
          ...(cursor === null ? {} : { start_cursor: cursor }),
        },
        { read: true },
      );
    const separator = path.includes("?") ? "&" : "?";
    const from =
      cursor === null ? "" : `&start_cursor=${encodeURIComponent(cursor)}`;
    return this.request("GET", `${path}${separator}page_size=100${from}`);
  }

  /**
   * Every result of a cursor-paged listing. A query Notion reports as
   * incomplete is an error: the store never works from part of a listing.
   */
  async all(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await this.listingPage(method, path, body, cursor);
      results.push(...listingResults(page, path));
      cursor = nextCursor(page, path);
      if (cursor === null) return results;
    }
  }
}

/** A listing page's results; a partial or malformed listing is an error. */
function listingResults(
  page: Record<string, unknown>,
  path: string,
): unknown[] {
  if (!Array.isArray(page.results))
    throw new NotionError(1, `Notion's listing of ${path} has no results`);
  const status = page.request_status;
  if (isMapping(status) && status.type === "incomplete")
    throw new NotionError(
      1,
      `Notion returned only part of ${path} (${String(status.incomplete_reason)}), so it cannot be read whole`,
    );
  return page.results;
}

/** The cursor of the next page, or null after the last. */
function nextCursor(
  page: Record<string, unknown>,
  path: string,
): string | null {
  if (page.has_more !== true) return null;
  if (typeof page.next_cursor !== "string" || page.next_cursor === "")
    throw new NotionError(
      1,
      `Notion's listing of ${path} has more results but no cursor`,
    );
  return page.next_cursor;
}

/** A successful response's body, which must be a JSON object. */
function jsonObject(text: string, request: string): Record<string, unknown> {
  const parsed = parseJson(text);
  if (parsed.ok && isMapping(parsed.value)) return parsed.value;
  throw new NotionError(
    1,
    `Notion answered ${request} with something other than a JSON object${parsed.ok ? "" : `: ${parsed.error}`}`,
  );
}

/**
 * Throw for a refusal no retry can change; return the failure to report
 * when one might.
 */
function refusal(
  status: number,
  message: string,
  method: Method,
  path: string,
): string {
  if (status === 401)
    throw new NotionError(
      3,
      `Notion refused the token in NOTION_TOKEN: ${message}`,
      401,
    );
  if (!RETRIED.has(status))
    throw new NotionError(
      1,
      `Notion refused ${method} ${path} (${status}): ${message}`,
      status,
    );
  return `${status}: ${message}`;
}

/** The JSON in a response, or why it is not JSON. */
function parseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Notion's error code and message, else the start of the response. */
function errorMessage(text: string): string {
  const parsed = parseJson(text);
  if (parsed.ok && isMapping(parsed.value)) {
    const { code, message } = parsed.value;
    if (typeof message === "string")
      return typeof code === "string" ? `${code}: ${message}` : message;
  }
  return text.trim().slice(0, 300) || "no message";
}

/**
 * `Retry-After` in seconds when given, else a doubling backoff. Null when
 * Notion asks for a longer wait than one run takes: retrying earlier would
 * only be refused again.
 */
function retryWait(header: string | null, attempt: number): number | null {
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0)
    return seconds * 1000 > MAX_RETRY_WAIT_MS ? null : seconds * 1000;
  return Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The token goes to whatever `JIG_NOTION_API_URL` names, so it must be
 * HTTPS, or plain HTTP only to this machine (a local fake).
 */
function checkEndpoint(base: string): void {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new NotionError(1, `JIG_NOTION_API_URL is not a URL: ${base}`);
  }
  if (
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK.has(url.hostname))
  )
    return;
  throw new NotionError(
    1,
    `JIG_NOTION_API_URL must be an https URL, or http to localhost, since NOTION_TOKEN is sent to it: ${base}`,
  );
}
