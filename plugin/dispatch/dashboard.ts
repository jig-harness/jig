/**
 * `jig dispatch dashboard [--port <n>]`: the page over what the dispatcher
 * recorded, served while the command runs. The page (`dashboard-page/`, built
 * from `dashboard/`) reads the line
 * the newest tick wrote (`GET /state`, `lib/line-store.ts`) and the outcome log
 * (`GET /rows`, `lib/dashboard-log.ts`), a scoreboard by release over that
 * log (`GET /scoreboard`, `lib/scoreboard.ts`) and the live checks
 * (`GET /checks`). Current PR state is read separately
 * through `GET /pr`, cached for a minute with bounded forge concurrency.
 * Each snapshot or log read answers with its value or a
 * coded failure; the one catch around them is the defect boundary, so a bug
 * reaches the log with its stack and the page with its code alone. The
 * database's WAL mode lets it read while a tick writes, and nothing is written
 * to disk. It has no route that writes: a card's Send posts a person's answer
 * from their browser to GitHub with their own token, which never reaches this
 * server.
 *
 * It listens on the address the machine file names (`dashboard.listen`),
 * which must lie in the private or loopback ranges (`lib/listen.ts`), so a
 * phone on the host's private network reaches it and nothing else does.
 * The URL it prints carries a token minted at start; a request without it
 * is refused, since these records name repositories, items and accounts.
 * A machine file that sets `dashboard.require_token: false` on a loopback
 * address serves without one, for a front on the host (Tailscale Serve, a
 * reverse proxy) that authenticates each person before the request arrives.
 * With `dashboard.socket` it also listens on a Unix socket created mode 0600
 * (`dashboard-socket.ts`), which a private-network front targets: the same
 * routes and the same refusals, with no token and no `Host` check, since
 * only its owner and root can open the socket and no browser can.
 * The page names a web app manifest and its icons (`GET /manifest.webmanifest`,
 * `GET /icons/*`), which a phone's browser reads to offer the page as an app.
 * They are static, and answer under the same checks as the rest: an installed
 * app starts at `/`, which only a server without a token can open, so one
 * that asks for a token is not offered for install.
 * The foreground command prints its URL and stops with Ctrl-C. The optional
 * retry timer (`dashboard-install.ts`) serves through the same reader, with
 * its URL in an owner-only access record rather than scheduler output.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExitError } from "../shared/cli.ts";
import { USAGE_EXIT } from "../shared/command-line.ts";
import { attempt, failed, type Outcome } from "../shared/outcome.ts";
import type { Answer, RowsAnswer } from "./lib/dashboard-contract.ts";
import { prReader } from "./lib/dashboard-pr.ts";
import { queryLog } from "./lib/dashboard-log.ts";
import { type ScoreboardAnswer, readScoreboard } from "./lib/scoreboard.ts";
import { hostTimeZone } from "./lib/host-time.ts";
import { currentMs } from "../shared/time.ts";
import { readLine, readLineReceipt, stateAnswer } from "./lib/line-store.ts";
import { authorityAllowed, isLoopback, type Listen } from "./lib/listen.ts";
import { existingStateDb } from "./lib/state.ts";
import { bindSocket } from "./dashboard-socket.ts";
import { stateRoot } from "./receipts.ts";

/** The port the dashboard listens on when neither `--port` nor the address names one. */
export const DEFAULT_PORT = 8765;

/** Below this a body is sent as it is: compressing it saves nothing. */
const COMPRESS_FROM_BYTES = 1024;

/** The one other origin the page may call: GitHub's API, for Send. */
const GITHUB_API = "https://api.github.com";

/** The page's built files, beside this file. */
const PAGE_DIR = join(import.meta.dir, "dashboard-page");

/** The files that make the page installable, by the path each is served at. */
const APP_FILES: Record<string, { file: string; type: string }> = {
  "/manifest.webmanifest": {
    file: "manifest.webmanifest",
    type: "application/manifest+json; charset=utf-8",
  },
  "/icons/icon-192.png": { file: "icons/icon-192.png", type: "image/png" },
  "/icons/icon-512.png": { file: "icons/icon-512.png", type: "image/png" },
  "/icons/icon-maskable-512.png": {
    file: "icons/icon-maskable-512.png",
    type: "image/png",
  },
};

/** The zone every time is shown in: the host's, as its newest tick recorded it, since this server may run on a copy of its database. */
function shownTimeZone(root: string): string {
  const line = readLine(root);
  return (line.ok ? line.value?.timeZone : undefined) ?? hostTimeZone();
}

/** `GET /scoreboard`: six numbers per release over the log, and the causes new under a release. */
function scoreboardData(
  params: URLSearchParams,
  nowMs: number,
  root = stateRoot(),
): Outcome<ScoreboardAnswer, "log-unreadable"> {
  // A line that does not read leaves the slots unknown, not the scoreboard unread.
  const line = readLine(root);
  return attempt("log-unreadable", "the outcome log cannot be read", () =>
    readScoreboard(params, nowMs, root, line.ok ? line.value : null),
  );
}

/** What `GET /checks` answers with: the live-check report, as the Records lane's reader returns it. */
export type ChecksReader = () => Outcome<unknown, string>;

/** The reader until the live-check report is on the main branch. */
const NO_CHECKS: ChecksReader = () =>
  failed(
    "checks-unavailable",
    "this release has no live-check report to serve",
  );

/** The reads that take no more than the request's query, by path. */
function readsOf(
  root: string,
  now: () => number,
  readChecks: ChecksReader = NO_CHECKS,
): Record<string, (url: URL) => Outcome<unknown, string>> {
  return {
    "/state": () => stateAnswer(now(), root),
    "/rows": (url) => dashboardData(url.searchParams, now(), root),
    "/scoreboard": (url) => scoreboardData(url.searchParams, now(), root),
    "/checks": () => readChecks(),
  };
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
 * requests, and the page's address and its storage hold tokens: only the
 * page's own script runs, and it can reach this server and GitHub's API, where
 * a card's Send posts a person's answer with the GitHub token they pasted into
 * that browser (`design/dispatch-dashboard.md` § When the dashboard writes).
 * A page that runs no script reaches this server alone.
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
    script === undefined
      ? "connect-src 'self'"
      : `connect-src 'self' ${GITHUB_API}`,
    "manifest-src 'self'",
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

/** The installable app's files, read once at start, by the path each is served at. */
function readAppFiles(): Map<
  string,
  { body: Uint8Array<ArrayBuffer>; headers: Record<string, string> }
> {
  return new Map(
    Object.entries(APP_FILES).map(([path, { file, type }]) => [
      path,
      {
        body: new Uint8Array(readFileSync(join(PAGE_DIR, file))),
        headers: {
          "content-type": type,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      },
    ]),
  );
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
  /** The token a request needs; `null` serves without one, which only a loopback address may. */
  token?: string | null;
  /** Host names a front forwards under, besides the loopback names; only read when no token is asked for. */
  allowedHosts?: readonly string[];
  /** The private Unix socket to listen on as well, mode 0600; an absolute path. */
  socket?: string;
  /** The clock the answers read; the real one unless a check holds it still. */
  now?: () => number;
  /** A forge reader; fixtures provide their own instead of reaching a live account. */
  readPr?: ReturnType<typeof prReader>;
  /** The live-check report; until one is supplied `GET /checks` answers `checks-unavailable`. */
  readChecks?: ChecksReader;
}): Dashboard {
  const token =
    options.token === undefined
      ? crypto.randomUUID().replace(/-/g, "")
      : options.token;
  if (token === null && !isLoopback(options.listen))
    throw new ExitError(
      USAGE_EXIT,
      `the dashboard serves without a token only on a loopback address, not ${options.listen.host}`,
    );
  const fronts = (options.allowedHosts ?? []).map((name) => name.toLowerCase());
  const root = options.root ?? stateRoot();
  const now = options.now ?? currentMs;
  const page = readPage("index.html");
  const refused = readPage("refused.html");
  const appFiles = readAppFiles();

  const readPr = options.readPr ?? prReader(root);
  const reads = readsOf(root, now, options.readChecks);

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
    const read = reads[url.pathname];
    if (read !== undefined) return readAnswer(read(url), request);
    if (url.pathname === "/receipt") return receiptAnswer(url, request, root);
    const appFile = appFiles.get(url.pathname);
    if (appFile !== undefined)
      return new Response(appFile.body, { headers: appFile.headers });
    return answered(
      failed("not-found", `this dashboard has no ${url.pathname}`),
      request,
      404,
    );
  }

  /** The refusal a request on the address earns before it is routed; `null` when it may go on. */
  function turnedAway(request: Request, url: URL): Response | null {
    // Without a token the request's own authority is the only check: a page
    // an attacker's name rebinds to this address must not read it.
    if (token === null)
      return authorityAllowed(request.headers.get("host"), fronts)
        ? null
        : answered(
            failed(
              "host-refused",
              "this dashboard answers only to its loopback names and the front hosts the machine file lists",
            ),
            request,
            403,
          );
    if (sameToken(url.searchParams.get("token"), token)) return null;
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
  }

  /** Answer one request; `onSocket` is the private socket, whose mode is its own check. */
  async function answer(
    request: Request,
    onSocket: boolean,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET")
      return answered(
        failed("not-allowed", "this dashboard only reads"),
        request,
        405,
      );
    const turned = onSocket ? null : turnedAway(request, url);
    if (turned !== null) return turned;
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
  }

  const server = Bun.serve({
    hostname: options.listen.host,
    port: options.port ?? options.listen.port ?? DEFAULT_PORT,
    fetch: (request) => answer(request, false),
  });
  // Bound after the address, so a second reader on this configuration fails
  // on the address before it can touch a live reader's socket.
  const socket =
    options.socket === undefined
      ? null
      : bindSocket(options.socket, (request) => answer(request, true));
  if (socket !== null && !socket.ok) {
    server.stop(true);
    throw new ExitError(USAGE_EXIT, socket.failure.reason, {
      cause: socket.failure.cause,
    });
  }
  const host = options.listen.host.includes(":")
    ? `[${options.listen.host}]`
    : options.listen.host;
  return {
    url: `http://${host}:${server.port}/${token === null ? "" : `?token=${token}`}`,
    stop: () => {
      server.stop(true);
      if (socket?.ok) socket.value.stop();
    },
  };
}

/** `jig dispatch dashboard`: serve until the process is stopped. */
export async function dashboardMain(
  listen: Listen | null,
  port: number | undefined,
  machinePath: string,
  requireToken = true,
  allowedHosts: readonly string[] = [],
  socket: string | null = null,
): Promise<number> {
  if (listen === null)
    throw new ExitError(
      USAGE_EXIT,
      `jig dispatch dashboard needs dashboard.listen in ${machinePath}: an address in the private or loopback ranges the host already trusts (see CONFIGURATION.md § The machine's dispatch file)`,
    );
  // A database a newer plugin wrote is refused before the page is served.
  existingStateDb();
  const dashboard = serveDashboard({
    listen,
    ...(socket === null ? {} : { socket }),
    ...(port === undefined ? {} : { port }),
    ...(requireToken ? {} : { token: null, allowedHosts }),
  });
  console.log(`jig dispatch dashboard: ${dashboard.url}`);
  if (socket !== null)
    console.log(`Also listening on the private socket ${socket} (mode 0600).`);
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
