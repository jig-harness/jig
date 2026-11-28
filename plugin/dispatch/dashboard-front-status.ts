/**
 * The private socket's and Funnel's lines of `jig dispatch dashboard
 * --status`, and whether both are as installed.
 */
import { funnelFinding, type FunnelFinding } from "./dashboard-funnel.ts";
import {
  readSocketFacts,
  socketAnswers,
  socketProblem,
} from "./dashboard-socket.ts";
import type { MachineConfig } from "./lib/machine-config.ts";

interface Status {
  lines: string[];
  ok: boolean;
}

/** The socket's line: why it is not as installed, or that it answers. */
async function socketStatus(socket: string): Promise<Status> {
  const facts = readSocketFacts(socket);
  const problem = facts.ok
    ? socketProblem(facts.value, process.getuid?.())
    : facts.failure.reason;
  const answering = problem === null && (await socketAnswers(socket));
  const said =
    problem ??
    (answering ? "healthy (mode 0600, the reader's own)" : "not answering");
  return { lines: [`socket: ${said}`], ok: answering };
}

/** Funnel's line; only an exposed route or a status this check cannot read fails. */
function funnelStatus(found: FunnelFinding): Status {
  if (found.state === "exposed")
    return {
      lines: [
        `funnel: ON for ${found.routes.join(", ")}, which publishes the dashboard to the open internet; turn it off with tailscale funnel`,
      ],
      ok: false,
    };
  if (found.state === "unknown")
    return { lines: [`funnel: cannot tell (${found.reason})`], ok: false };
  return {
    lines: found.state === "clear" ? ["funnel: off for the dashboard"] : [],
    ok: true,
  };
}

/** The lines and verdict for the machine file's dashboard; nothing when it names no address. */
export async function frontStatus(
  machine: { ok: true; value: MachineConfig | null } | { ok: false },
  defaultPort: number,
): Promise<Status> {
  const config = machine.ok ? machine.value : null;
  if (config?.dashboardListen == null) return { lines: [], ok: true };
  const socket =
    config.dashboardSocket === null
      ? { lines: [], ok: true }
      : await socketStatus(config.dashboardSocket);
  const funnel = funnelStatus(
    await funnelFinding({
      listen: config.dashboardListen,
      defaultPort,
      socket: config.dashboardSocket,
    }),
  );
  return {
    lines: [...socket.lines, ...funnel.lines],
    ok: socket.ok && funnel.ok,
  };
}
