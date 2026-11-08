/**
 * `jig dispatch dashboard [--port <n>]`: the page over what the dispatcher
 * recorded, served while the command runs. The page (`dashboard-page/`, built
 * from `dashboard/`) reads the line
 * the newest tick wrote (`GET /state`, `lib/line-store.ts`) and the outcome log
 * (`GET /rows`, `lib/dashboard-log.ts`). Current PR state is read separately
 * through `GET /pr`, cached for a minute with bounded forge concurrency.
 * Each snapshot or log read answers with its value or a
 * coded failure; the one catch around them is the defect boundary, so a bug
 * reaches the log with its stack and the page with its code alone. The
 * database's WAL mode lets it read while a tick writes, and nothing is written
 * to disk.
 *
 * It listens on the address the machine file names (`dashboard.listen`),
 * which must lie in the private or loopback ranges (`lib/listen.ts`), so a
 * phone on the host's private network reaches it and nothing else does.
 * The URL it prints carries a token minted at start; a request without it
 * is refused, since these records name repositories, items and accounts.
 * Nothing installs it or keeps it running: a person starts it from a
 * terminal on the host and stops it with Ctrl-C.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExitError } from "../shared/cli.ts";
import { attempt, failed, type Outcome } from "../shared/outcome.ts";
import type { Answer, RowsAnswer } from "./lib/dashboard-contract.ts";
import { prReader } from "./lib/dashboard-pr.ts";
import { queryLog } from "./lib/dashboard-log.ts";
import { hostTimeZone } from "./lib/host-time.ts";
import { readLine, readLineReceipt, stateAnswer } from "./lib/line-store.ts";
import type { Listen } from "./lib/listen.ts";
import { existingStateDb } from "./lib/state.ts";
import { stateRoot } from "./receipts.ts";

/** The port the dashboard listens on when neither `--port` nor the address names one. */
export const DEFAULT_PORT = 8765;

/** Below this a body is sent as it is: compressing it saves nothing. */
const COMPRESS_FROM_BYTES = 1024;

/** The page's built files, beside this file. */
const PAGE_DIR = join(import.meta.dir, "dashboard-page");

/** The zone every time is shown in: the host's, as its newest tick recorded it, since this server may run on a copy of its database. */
function shownTimeZone(root: string): string {
  const line = readLine(root);
  return (line.ok ? line.value?.timeZone : undefined) ?? hostTimeZone();
}

/** The answer to one query over the log: `GET /rows`. A database a newer plugin wrote is a failure, as any other read's is. */
export function dashboardData(
  params: URLSearchParams,
  nowMs: number,
  root = stateRoot(),
): Outcome<RowsAnswer, "log-unreadable"> {
  return attempt("log-unreadable", "the outcome log cannot be read", () =>
    queryLog(params, nowMs, root, shownTimeZone(root)),
  );
}

function sameToken(given: string | null, token: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One built page, as the server sends it: the body, compressed once, and its policy. */
interface Page {
  body: string;
  gzip: Uint8Array<ArrayBuffer>;
  headers: Record<string, string>;
}

/**
 * The policy a built page runs under. Decision text on the page comes from pull
 * requests, and the page's address holds the token: only the page's own script
 * runs, and it can reach this server and nothing else.
 */
function contentPolicy(html: string): string {
  const script = /<script>([\s\S]*)<\/script>/i.exec(html)?.[1];
  const scripts =
    script === undefined
      ? "'none'"
      : `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    // The primitives position their popups with inline styles.
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function readPage(name: string): Page {
  const body = readFileSync(join(PAGE_DIR, name), "utf8");
  return {
    body,
    gzip: Bun.gzipSync(body),
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": contentPolicy(body),
    },
  };
}

/** Whether the request's `Accept-Encoding` allows gzip: named with a quality above zero, or allowed by `*` when it is not named. */
function acceptsGzip(request: Request): boolean {
  const header = request.headers.get("accept-encoding");
  if (header === null) return false;
  let gzip: number | undefined;
  let any: number | undefined;
  for (const part of header.split(",")) {
    const [name = "", ...params] = part.split(";").map((p) => p.trim());
    const q = params
      .map((p) => /^q=([0-9.]+)$/i.exec(p)?.[1])
      .find((v) => v !== undefined);
    const quality = q === undefined ? 1 : Number(q);
    const coding = name.toLowerCase();
    if (coding === "gzip") gzip = quality;
    else if (coding === "*") any = quality;
  }
  return (gzip ?? any ?? 0) > 0;
}

function pageResponse(page: Page, request: Request, status = 200): Response {
  return acceptsGzip(request)
    ? new Response(page.gzip, {
        status,
        headers: { ...page.headers, "content-encoding": "gzip" },
      })
    : new Response(page.body, { status, headers: page.headers });
}

function jsonResponse(
  text: string,
  request: Request,
  status: number,
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
  return Buffer.byteLength(text, "utf8") >= COMPRESS_FROM_BYTES &&
    acceptsGzip(request)
    ? new Response(Bun.gzipSync(text), {
        status,
        headers: { ...headers, "content-encoding": "gzip" },
      })
    : new Response(text, { status, headers });
}

function answered<T>(
  outcome: Answer<T> | Outcome<T>,
  request: Request,
  status: number,
): Response {
  // A failure's cause is for the log: the page gets its code and reason.
  const wire: Answer<T> = outcome.ok
    ? outcome
    : {
        ok: false,
        failure: { code: outcome.failure.code, reason: outcome.failure.reason },
      };
  return jsonResponse(JSON.stringify(wire), request, status);
}

/** A read's answer: 200 with its value, or 503 with its code and reason, which the server logs with what was thrown. */
function readAnswer<T>(outcome: Outcome<T>, request: Request): Response {
  if (outcome.ok) return answered(outcome, request, 200);
  console.error(
    `jig dispatch dashboard: ${outcome.failure.code}: ${outcome.failure.reason}`,
    outcome.failure.cause ?? "",
  );
  return answered(outcome, request, 503);
}

/** `GET /receipt`: the newest tick's receipt, or, for a page naming the run it shows, a refusal when a newer tick took its place. */
function receiptAnswer(url: URL, request: Request, root: string): Response {
  const run = url.searchParams.get("run");
  const stored = readLineReceipt(root);
  if (!stored.ok) return readAnswer(stored, request);
  if (run !== null && stored.value !== null && stored.value.runId !== run)
    return answered(
      failed(
        "receipt-superseded",
        `tick ${run} is no longer the newest; reload the page to read the newer receipt`,
      ),
      request,
      409,
    );
  return stored.value === null
    ? answered(
        failed("no-receipt", "no tick has written a receipt here yet"),
        request,
        404,
      )
    : jsonResponse(stored.value.receipt, request, 200);
}

export interface Dashboard {
  url: string;
  stop(): void;
}

/** Serve the dashboard on `listen`, reading what the dispatcher recorded under `root`, until `stop`. */
export function serveDashboard(options: {
  listen: Listen;
  port?: number;
  root?: string;
  token?: string;
  /** The clock the answers read; the real one unless a check holds it still. */
  now?: () => number;
  /** A forge reader; fixtures provide their own instead of reaching a live account. */
  readPr?: ReturnType<typeof prReader>;
}): Dashboard {
  const token = options.token ?? crypto.randomUUID().replace(/-/g, "");
  const root = options.root ?? stateRoot();
  const now = options.now ?? Date.now;
  const page = readPage("index.html");
  const refused = readPage("refused.html");

  const readPr = options.readPr ?? prReader(root);

  async function route(request: Request, url: URL): Promise<Response> {
    if (url.pathname === "/pr")
      return jsonResponse(
        JSON.stringify(
          await readPr(
            url.searchParams.get("repo") ?? "",
            url.searchParams.get("pr") ?? "",
          ),
        ),
        request,
        200,
      );
    if (url.pathname === "/") return pageResponse(page, request);
    if (url.pathname === "/state")
      return readAnswer(stateAnswer(now(), root), request);
    if (url.pathname === "/rows")
      return readAnswer(dashboardData(url.searchParams, now(), root), request);
    if (url.pathname === "/receipt") return receiptAnswer(url, request, root);
    return answered(
      failed("not-found", `this dashboard has no ${url.pathname}`),
      request,
      404,
    );
  }

  const server = Bun.serve({
    hostname: options.listen.host,
    port: options.port ?? options.listen.port ?? DEFAULT_PORT,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET")
        return answered(
          failed("not-allowed", "this dashboard only reads"),
          request,
          405,
        );
      if (!sameToken(url.searchParams.get("token"), token))
        return url.pathname === "/"
          ? pageResponse(refused, request, 403)
          : answered(
              failed(
                "token-refused",
                "this dashboard needs the token its command printed",
              ),
              request,
              403,
            );
      try {
        return await route(request, url);
      } catch (defect) {
        console.error(
          "jig dispatch dashboard: a defect while answering",
          url.pathname,
          defect,
        );
        return answered(
          failed(
            "defect",
            "the dashboard hit a bug answering this; the terminal it runs in has the details",
          ),
          request,
          500,
        );
      }
    },
  });
  const host = options.listen.host.includes(":")
    ? `[${options.listen.host}]`
    : options.listen.host;
  return {
    url: `http://${host}:${server.port}/?token=${token}`,
    stop: () => server.stop(true),
  };
}

/** `jig dispatch dashboard`: serve until the process is stopped. */
export async function dashboardMain(
  listen: Listen | null,
  port: number | undefined,
  machinePath: string,
): Promise<number> {
  if (listen === null)
    throw new ExitError(
      2,
      `jig dispatch dashboard needs dashboard.listen in ${machinePath}: an address in the private or loopback ranges the host already trusts (see CONFIGURATION.md § The machine's dispatch file)`,
    );
  // A database a newer plugin wrote is refused before the page is served.
  existingStateDb();
  const dashboard = serveDashboard({
    listen,
    ...(port === undefined ? {} : { port }),
  });
  console.log(`jig dispatch dashboard: ${dashboard.url}`);
  console.log(
    "It reads what the dispatcher recorded when the page asks; Ctrl-C stops it.",
  );
  await new Promise<void>((settle) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => settle());
  });
  dashboard.stop();
  return 0;
}
