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

/** Whether a route's target (`http://127.0.0.1:8765`, `unix:/path`, `127.0.0.1:8765`) is the dashboard's. */
function reachesDashboard(target: string, mine: DashboardTargets): boolean {
  if (target.startsWith("unix:"))
    return mine.socket !== null && target.slice(5) === mine.socket;
  if (mine.listen === null) return false;
  const port = String(mine.listen.port ?? mine.defaultPort);
  const bare = target.replace(/^[a-z+]+:\/\//i, "").replace(/\/.*$/, "");
  const at = /^(?:\[(.+)\]|([^:]+)):(\d+)$/.exec(bare);
  if (at === null) return false;
  const host = (at[1] ?? at[2] ?? "").toLowerCase();
  const own = mine.listen.host.toLowerCase();
  const loopbackNames = ["localhost", "127.0.0.1", "::1"];
  return (
    at[3] === port &&
    (host === own ||
      (loopbackNames.includes(host) && loopbackNames.includes(own)))
  );
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
  if (open === undefined || open === null) return ok([]);
  if (!isRecord(open))
    return failed(
      "funnel-unreadable",
      "the serve status lists AllowFunnel in a form this check cannot read",
    );
  const unreadable = (what: string) =>
    failed(
      "funnel-unreadable",
      `the serve status lists an enabled Funnel route whose ${what} this check cannot read`,
    );
  const absent = (value: unknown) => value === undefined || value === null;
  if (!absent(status.Web) && !isRecord(status.Web)) return unreadable("Web");
  if (!absent(status.TCP) && !isRecord(status.TCP)) return unreadable("TCP");
  const web = isRecord(status.Web) ? status.Web : {};
  const tcp = isRecord(status.TCP) ? status.TCP : {};
  const exposed: string[] = [];
  for (const [route, on] of Object.entries(open)) {
    if (on !== true) continue;
    const entry = web[route];
    if (!absent(entry) && !isRecord(entry))
      return unreadable(`Web entry ${route}`);
    if (isRecord(entry) && !absent(entry.Handlers) && !isRecord(entry.Handlers))
      return unreadable(`handlers for ${route}`);
    const handlers =
      isRecord(entry) && isRecord(entry.Handlers)
        ? Object.values(entry.Handlers)
        : [];
    if (
      handlers.some(
        (handler) =>
          !isRecord(handler) ||
          (!absent(handler.Proxy) && typeof handler.Proxy !== "string"),
      )
    )
      return unreadable(`handler entries for ${route}`);
    const slot = tcp[route.slice(route.lastIndexOf(":") + 1)];
    if (!absent(slot) && !isRecord(slot))
      return unreadable(`TCP entry for ${route}`);
    const proxied = handlers.some(
      (handler) =>
        isRecord(handler) &&
        typeof handler.Proxy === "string" &&
        reachesDashboard(handler.Proxy, mine),
    );
    const port = route.slice(route.lastIndexOf(":") + 1);
    const forward = isRecord(tcp[port]) ? tcp[port].TCPForward : undefined;
    if (!absent(forward) && typeof forward !== "string")
      return unreadable(`TCP forward for ${route}`);
    const forwarded =
      typeof forward === "string" && reachesDashboard(forward, mine);
    if (proxied || forwarded) exposed.push(route);
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
