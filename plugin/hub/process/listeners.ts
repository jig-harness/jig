/**
 * The process adapter's serving: one Bun HTTP server per listener, each
 * answering from its own route table (`core/routes.ts`) and running every
 * request as one unit (`runUnit`) with a deadline
 * ([design/control-plane.md § Reaching the hub: only the webhook path is public](../../../design/control-plane.md#reaching-the-hub-only-the-webhook-path-is-public)).
 *
 * A listener runs on the process's main thread and only answers: a long
 * unit, a job's run, goes to the worker thread (`scheduling.ts`), so a
 * webhook's acknowledgement never waits behind one. The webhook listener
 * refuses a body over 25 MiB, GitHub's own cap on a payload. A feed on a
 * Unix socket is created mode 0600, or 0666 when the settings name the
 * front's group: then the socket's directory, which the host side gives
 * that group and mode 0710 (`host-paths.ts`), decides who reaches it. A
 * feed on loopback answers 401 to a request that does not carry the
 * front's secret.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import type { HubPorts } from "../core/ports.ts";
import { codedResponse, type ListenerName } from "../core/routes.ts";
import type {
  HubRequest,
  HubResponse,
  RequestHandler,
} from "../core/serving.ts";
import { runUnit } from "../core/unit.ts";

/** The largest body the webhook listener reads: GitHub's cap on a payload. */
const WEBHOOK_BODY_LIMIT = 25 * 1024 * 1024;
/** The largest body the host and feed listeners read. */
const REQUEST_BODY_LIMIT = 1024 * 1024;
/** How long one request's unit may run before it answers 503. */
const REQUEST_TIMEOUT_MS = 10_000;
/** The header the front adds to a feed request on a port. */
export const FRONT_SECRET_HEADER = "x-jig-front-secret";

/** Where a listener binds: an address and port, or a Unix socket. */
export type Bind =
  | { readonly hostname: string; readonly port: number }
  | {
      readonly unix: string;
      /** Whether its directory guards the socket (mode 0666); else the socket is 0600. */
      readonly open: boolean;
    };

export interface ListenerSpec {
  readonly name: ListenerName;
  readonly bind: Bind;
  readonly handler: RequestHandler;
  /** For a feed on a port: the secret every request must carry. */
  readonly secret?: string;
  readonly timeoutMs?: number;
}

/** A listener that is up: what it bound, and how to stop it. */
export interface BoundListener {
  readonly name: ListenerName;
  /** `http://host:port` or `unix:<path>`. */
  readonly address: string;
  stop(): Promise<void>;
}

/** The headers a webhook's sender signs or names its delivery by, lower case. */
function signatureHeaders(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of headers)
    if (
      name.startsWith("x-") ||
      name.includes("signature") ||
      name.includes("delivery")
    )
      kept[name] = value;
  return kept;
}

/** A request as the core reads it. */
async function hubRequest(
  request: Request,
  listener: ListenerName,
  receivedAt: number,
): Promise<HubRequest> {
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
  return {
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    credential: bearer?.[1] ?? null,
    signatureHeaders:
      listener === "webhook" ? signatureHeaders(request.headers) : {},
    body: new Uint8Array(await request.arrayBuffer()),
    receivedAt,
  };
}

const respond = (response: HubResponse) =>
  new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });

/** Whether `given` is `secret`, compared in constant time. */
function secretMatches(given: string | null, secret: string): boolean {
  if (given === null) return false;
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(secret));
}

/** The fetch handler for one listener: each request one unit, its failure a coded answer. */
function fetchHandler(
  ports: Pick<HubPorts, "clock" | "observability">,
  spec: ListenerSpec,
  stop: AbortSignal,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (
      spec.secret !== undefined &&
      !secretMatches(request.headers.get(FRONT_SECRET_HEADER), spec.secret)
    )
      return respond(
        codedResponse(401, "front-secret", "the front's secret is missing"),
      );
    const received = await hubRequest(request, spec.name, ports.clock.now());
    const answered = await runUnit(
      ports,
      {
        name: `${spec.name}:${received.path}`,
        timeoutMs: spec.timeoutMs ?? REQUEST_TIMEOUT_MS,
        stop,
      },
      (context) => spec.handler(context, received),
    );
    if (answered.ok) return respond(answered.value);
    const late = answered.failure.code === "deadline-passed";
    return respond(
      codedResponse(
        late ? 503 : 500,
        late ? "deadline-passed" : "failed",
        late ? "the request did not finish in time" : "the request failed",
      ),
    );
  };
}

/** Removes a socket a stopped hub left behind; anything else at the path stays, and binding then fails. */
function clearStaleSocket(path: string): void {
  const found = attempt("absent", "", () => lstatSync(path));
  if (found.ok && found.value.isSocket()) rmSync(path, { force: true });
}

/**
 * An open socket's directory is what keeps other users out, so it must be
 * this user's own and grant others nothing; anything else refuses the bind.
 */
function guardingDirectory(directory: string): Outcome<void, "unavailable"> {
  const found = attempt(
    "unavailable",
    `cannot read the feed socket's directory ${directory}`,
    () => statSync(directory),
  );
  if (!found.ok) return found;
  const uid = process.getuid?.();
  if (uid !== undefined && found.value.uid !== uid)
    return failed(
      "unavailable",
      `the feed socket's directory ${directory} belongs to another user; with feed.group set it must be the hub user's own`,
    );
  if ((found.value.mode & 0o007) !== 0)
    return failed(
      "unavailable",
      `the feed socket's directory ${directory} is open to every user (mode ${(found.value.mode & 0o777).toString(8)}); with feed.group set it must grant others nothing (0710)`,
    );
  return ok(undefined);
}

/** Binds a Unix socket created 0600, or 0666 for its directory to guard; stops it again when its mode cannot be set. */
function serveSocket(
  bind: Extract<Bind, { unix: string }>,
  fetch: (request: Request) => Promise<Response>,
): Outcome<ReturnType<typeof Bun.serve>, "unavailable"> {
  const where = `the feed socket ${bind.unix}`;
  const made = attempt(
    "unavailable",
    `cannot make the directory of ${where}`,
    () => mkdirSync(dirname(bind.unix), { recursive: true, mode: 0o700 }),
  );
  if (!made.ok) return made;
  if (bind.open) {
    const guarded = guardingDirectory(dirname(bind.unix));
    if (!guarded.ok) return guarded;
  }
  clearStaleSocket(bind.unix);
  const before = process.umask(0o177);
  const started = attempt("unavailable", `cannot bind ${where}`, () =>
    Bun.serve({
      unix: bind.unix,
      fetch,
      maxRequestBodySize: REQUEST_BODY_LIMIT,
    }),
  );
  process.umask(before);
  if (!started.ok) return started;
  const mode = bind.open ? 0o666 : 0o600;
  const moded = attempt(
    "unavailable",
    `cannot set ${where} to mode ${mode.toString(8).padStart(4, "0")}`,
    () => chmodSync(bind.unix, mode),
  );
  if (moded.ok) return ok(started.value);
  void started.value.stop(true);
  rmSync(bind.unix, { force: true });
  return failed(moded.failure.code, moded.failure.reason);
}

/** Starts one listener; `unavailable` when it cannot bind. */
export function startListener(
  ports: Pick<HubPorts, "clock" | "observability">,
  spec: ListenerSpec,
  stop: AbortSignal,
): Outcome<BoundListener, "unavailable"> {
  const fetch = fetchHandler(ports, spec, stop);
  const { bind } = spec;
  const where = "unix" in bind ? bind.unix : `${bind.hostname}:${bind.port}`;
  const started =
    "unix" in bind
      ? serveSocket(bind, fetch)
      : attempt(
          "unavailable",
          `the ${spec.name} listener cannot bind ${where}`,
          () =>
            Bun.serve({
              hostname: bind.hostname,
              port: bind.port,
              fetch,
              maxRequestBodySize:
                spec.name === "webhook"
                  ? WEBHOOK_BODY_LIMIT
                  : REQUEST_BODY_LIMIT,
            }),
        );
  if (!started.ok)
    return failed(
      "unavailable",
      "unix" in bind
        ? `the ${spec.name} listener: ${started.failure.reason}`
        : started.failure.reason,
    );
  const server = started.value;
  const host = bind && "hostname" in bind ? bind.hostname : "";
  const address =
    "unix" in bind
      ? `unix:${bind.unix}`
      : `http://${host.includes(":") ? `[${host}]` : host}:${server.port}`;
  return ok({
    name: spec.name,
    address,
    stop: async () => {
      await server.stop(true);
      if ("unix" in bind) rmSync(bind.unix, { force: true });
    },
  });
}
