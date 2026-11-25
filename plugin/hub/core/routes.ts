/**
 * The hub's three listeners and what each serves
 * ([design/control-plane.md § Reaching the hub: only the webhook path is public](../../../design/control-plane.md#reaching-the-hub-only-the-webhook-path-is-public)).
 *
 * - **host**: the host protocol under `/v1/`, for enrolled hosts;
 * - **webhook**: `/webhooks/<source>` and nothing else, the one path a
 *   tunnel publishes;
 * - **feed**: the page and the source feed, behind the private-network
 *   front.
 *
 * Each listener answers from its own route table, so a path one listener
 * serves is never reached through another: the webhook listener answers
 * 404 to every path outside `/webhooks/`, whatever the other tables hold.
 * The tables start empty; the host protocol's calls, webhook intake and
 * the feed each add their handlers to theirs (`HubRoutes`), and a path
 * with no handler answers a coded 404.
 */
import { ok } from "../../shared/outcome.ts";
import type {
  HubResponse,
  ListenerHandlers,
  ListenerName,
  RequestHandler,
} from "./serving.ts";

export type { ListenerName };

/** Where each listener's paths start. */
const HOST_PREFIX = "/v1/";
const WEBHOOK_PREFIX = "/webhooks/";

/** The handlers each listener serves; empty tables serve only coded 404s. */
export interface HubRoutes {
  /** The host protocol's calls, by their path under `/v1/` (`join`, `offers`). */
  readonly host: ReadonlyMap<string, RequestHandler>;
  /** Webhook intake, by source (`github`, `linear`), the path's one segment after `/webhooks/`. */
  readonly webhooks: ReadonlyMap<string, RequestHandler>;
  /** The feed's and the page's paths, by their full path. */
  readonly feed: ReadonlyMap<string, RequestHandler>;
}

/** Route tables with no handlers yet. */
export function emptyRoutes(): HubRoutes {
  return { host: new Map(), webhooks: new Map(), feed: new Map() };
}

/** A JSON response with a stable code, as every refusal of the router is. */
export function codedResponse(
  status: number,
  code: string,
  reason: string,
): HubResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: { code, reason } }),
  };
}

const notFound = (code: string, reason: string) =>
  Promise.resolve(ok(codedResponse(404, code, reason)));

/** The host listener: `/v1/<call>` to its handler; anything else 404. */
function hostHandler(routes: HubRoutes): RequestHandler {
  return (context, request) => {
    if (!request.path.startsWith(HOST_PREFIX))
      return notFound("not-found", "the host listener serves /v1/ only");
    const handler = routes.host.get(request.path.slice(HOST_PREFIX.length));
    if (handler === undefined)
      return notFound("no-such-call", `no host call at ${request.path}`);
    return handler(context, request);
  };
}

/**
 * The webhook listener: `/webhooks/<source>` to that source's intake;
 * every other path, `/webhooks/` itself and a deeper path included, 404.
 */
function webhookHandler(routes: HubRoutes): RequestHandler {
  return (context, request) => {
    const source = request.path.startsWith(WEBHOOK_PREFIX)
      ? request.path.slice(WEBHOOK_PREFIX.length)
      : "";
    if (source === "" || source.includes("/"))
      return notFound(
        "not-found",
        "the webhook listener serves /webhooks/<source> only",
      );
    const handler = routes.webhooks.get(source);
    if (handler === undefined)
      return notFound("unknown-source", `no webhook intake for ${source}`);
    return handler(context, request);
  };
}

/** The feed listener: its paths to their handlers; anything else 404. */
function feedHandler(routes: HubRoutes): RequestHandler {
  return (context, request) => {
    const handler = routes.feed.get(request.path);
    if (handler === undefined)
      return notFound("not-found", `nothing is served at ${request.path}`);
    return handler(context, request);
  };
}

/** The handler a listener runs for each request, over its own table only. */
function listenerHandler(
  listener: ListenerName,
  routes: HubRoutes,
): RequestHandler {
  switch (listener) {
    case "host":
      return hostHandler(routes);
    case "webhook":
      return webhookHandler(routes);
    case "feed":
      return feedHandler(routes);
  }
}

/** Every listener's handler, each over its own table. */
export function listenerHandlers(routes: HubRoutes): ListenerHandlers {
  return {
    host: listenerHandler("host", routes),
    webhook: listenerHandler("webhook", routes),
    feed: listenerHandler("feed", routes),
  };
}
