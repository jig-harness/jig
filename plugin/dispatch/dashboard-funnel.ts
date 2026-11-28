/**
 * Whether Tailscale Funnel publishes the dashboard to the open internet.
 * `tailscale serve status --json` lists each published route and, in
 * `AllowFunnel`, the ones Funnel opens to anyone; the dashboard's reads are
 * for the owner, so a Funnel route that reaches its socket or its TCP port
 * fails `jig dispatch dashboard --status`. A Funnel for another service on
 * the host is that service's own decision and is not named here.
 */
import { isRecord } from "../shared/guards.ts";
import { run } from "../shared/proc.ts";
import { failed, ok, type Outcome } from "../shared/outcome.ts";
import type { Listen } from "./lib/listen.ts";

/** What the dashboard listens on: the targets a published route may name. */
export interface DashboardTargets {
  listen: Listen | null;
  defaultPort: number;
  socket: string | null;
}

const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "::1"];

/** The host (lower case) and port a `host:port` target, with or without a scheme or path, names. */
function hostAndPort(target: string): { host: string; port: string } | null {
  const scheme = target.indexOf("://");
  const afterScheme =
    scheme > 0 && /^[a-z+]+$/i.test(target.slice(0, scheme))
      ? target.slice(scheme + 3)
      : target;
  const slash = afterScheme.indexOf("/");
  const bare = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
  const at = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(bare);
  if (at === null) return null;
  return { host: (at[1] ?? at[2] ?? "").toLowerCase(), port: at[3] as string };
}

/** Whether two host names are the same, the names for this machine counting as one. */
function sameHost(a: string, b: string): boolean {
  return a === b || (LOOPBACK_NAMES.includes(a) && LOOPBACK_NAMES.includes(b));
}

/** Whether a route's target (`http://127.0.0.1:8765`, `unix:/path`, `127.0.0.1:8765`) is the dashboard's. */
function reachesDashboard(target: string, mine: DashboardTargets): boolean {
  if (target.startsWith("unix:"))
    return mine.socket !== null && target.slice(5) === mine.socket;
  const at = hostAndPort(target);
  if (at === null || mine.listen === null) return false;
  const port = String(mine.listen.port ?? mine.defaultPort);
  return at.port === port && sameHost(at.host, mine.listen.host.toLowerCase());
}

type Targets = Outcome<string[], "funnel-unreadable">;

const absent = (value: unknown) => value === undefined || value === null;
const readable = (value: unknown) => absent(value) || isRecord(value);

const unreadable = (what: string): Targets =>
  failed(
    "funnel-unreadable",
    `the serve status lists an enabled Funnel route whose ${what} this check cannot read`,
  );

/** One web handler's proxy target: `null` when it proxies nothing, `false` when it cannot be read. */
function handlerProxy(handler: unknown): string | null | false {
  if (!isRecord(handler)) return false;
  if (absent(handler.Proxy)) return null;
  return typeof handler.Proxy === "string" ? handler.Proxy : false;
}

/** The proxy targets of a route's web handlers, or why they cannot be read. */
function proxyTargets(entry: unknown, route: string): Targets {
  const handlers = isRecord(entry) ? entry.Handlers : undefined;
  if (!readable(entry)) return unreadable(`Web entry ${route}`);
  if (!readable(handlers)) return unreadable(`handlers for ${route}`);
  const proxies = Object.values(isRecord(handlers) ? handlers : {}).map(
    handlerProxy,
  );
  if (proxies.includes(false))
    return unreadable(`handler entries for ${route}`);
  return ok(
    proxies.filter(
      (proxy): proxy is string => proxy !== null && proxy !== false,
    ),
  );
}

/** The raw TCP forward target of a route's port, or why it cannot be read. */
function forwardTargets(slot: unknown, route: string): Targets {
  if (!readable(slot)) return unreadable(`TCP entry for ${route}`);
  const forward = isRecord(slot) ? slot.TCPForward : undefined;
  if (absent(forward)) return ok([]);
  return typeof forward === "string"
    ? ok([forward])
    : unreadable(`TCP forward for ${route}`);
}

/** The targets one enabled Funnel route publishes. */
function routeTargets(status: Record<string, unknown>, route: string): Targets {
  const web = isRecord(status.Web) ? status.Web : {};
  const tcp = isRecord(status.TCP) ? status.TCP : {};
  const proxies = proxyTargets(web[route], route);
  const forwards = forwardTargets(
    tcp[route.slice(route.lastIndexOf(":") + 1)],
    route,
  );
  if (!proxies.ok) return proxies;
  return forwards.ok ? ok([...proxies.value, ...forwards.value]) : forwards;
}

/**
 * The Funnel routes that reach the dashboard, each as `host:port`, read from
 * the JSON `tailscale serve status --json` prints. A document it cannot read
 * as a map is a failure, never "no Funnel".
 */
export function funnelExposure(
  status: unknown,
  mine: DashboardTargets,
): Outcome<string[], "funnel-unreadable"> {
  if (!isRecord(status))
    return failed("funnel-unreadable", "the serve status is not a JSON object");
  const open = status.AllowFunnel;
  if (absent(open)) return ok([]);
  if (!isRecord(open))
    return failed(
      "funnel-unreadable",
      "the serve status lists AllowFunnel in a form this check cannot read",
    );
  if (!readable(status.Web)) return unreadable("Web");
  if (!readable(status.TCP)) return unreadable("TCP");
  const exposed: string[] = [];
  for (const [route, on] of Object.entries(open)) {
    if (on !== true) continue;
    const targets = routeTargets(status, route);
    if (!targets.ok) return targets;
    if (targets.value.some((target) => reachesDashboard(target, mine)))
      exposed.push(route);
  }
  return ok(exposed);
}

/** What the check found on this host. */
export type FunnelFinding =
  | { state: "exposed"; routes: string[] }
  | { state: "clear" }
  | { state: "no-tailscale" }
  | { state: "unknown"; reason: string };

/**
 * Ask Tailscale what it publishes. No `tailscale` command publishes nothing and
 * is not a finding; a command that ran but timed out, failed or answered
 * with something this check cannot read is `unknown`, which `--status` reports as a failure.
 */
export async function funnelFinding(
  mine: DashboardTargets,
): Promise<FunnelFinding> {
  const result = await run(["tailscale", "serve", "status", "--json"], {
    timeoutSec: 10,
  });
  if (result.spawnFailed === true) return { state: "no-tailscale" };
  if (result.timedOut === true || result.code !== 0)
    return {
      state: "unknown",
      reason:
        result.timedOut === true
          ? "tailscale serve status timed out"
          : `tailscale serve status exited ${result.code}`,
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() === "" ? "{}" : result.stdout);
  } catch {
    return { state: "unknown", reason: "the serve status is not JSON" };
  }
  const exposure = funnelExposure(parsed, mine);
  if (!exposure.ok)
    return { state: "unknown", reason: exposure.failure.reason };
  return exposure.value.length > 0
    ? { state: "exposed", routes: exposure.value }
    : { state: "clear" };
}
