/**
 * Whether a running session holds a target, from the workspaces the
 * runtime joins to it: running when an agent in one of them is working or
 * waiting (even beside a terminal the runtime cannot report), free when none is (its finished agents kept as evidence), and
 * unknown when the runtime's answer cannot be trusted for it. An unknown
 * names the workspace when the listing read but one of its terminals runs
 * an agent the runtime cannot report (an idle shell, an editor, a leftover
 * terminal look the same as an agent it cannot see): a notification still
 * goes out there, and a launch becomes a person's need (`plan.ts`).
 */
import {
  RUNNING_STATES,
  type SessionsReport,
  type Workspace,
} from "./runtime/port.ts";
import { failureText } from "./text.ts";

export type Holding =
  | { kind: "free"; evidence: string | null }
  | { kind: "running"; workspaces: Workspace[] }
  | {
      kind: "unknown";
      reason: string;
      /** The workspace whose unreportable terminals made it unknown; absent when the listing itself did not read. */
      workspace?: string;
    };

export function holding(
  sessions: SessionsReport,
  joined: (w: Workspace) => boolean,
): Holding {
  if (!sessions.ok) return { kind: "unknown", reason: sessions.reason };
  const mine = sessions.workspaces.filter(joined);
  // An agent the runtime reports working holds the target, whatever else
  // shares its workspaces.
  const live = mine.filter((w) =>
    w.agents.some((a) => RUNNING_STATES.has(a.state)),
  );
  if (live.length > 0) return { kind: "running", workspaces: live };
  const unreadable = mine.find((w) => w.unverifiableTerminals > 0);
  if (unreadable !== undefined)
    return {
      kind: "unknown",
      reason: `workspace ${unreadable.path} has ${unreadable.unverifiableTerminals} terminal(s) whose agents the runtime cannot report`,
      workspace: unreadable.path,
    };
  const finished = mine.flatMap((w) =>
    w.agents.map((a) => `${w.branch || w.path}: ${a.state}`),
  );
  return {
    kind: "free",
    evidence: finished.length > 0 ? finished.join("; ") : null,
  };
}

/**
 * Reads the runtime again, just before an action, and whether a running
 * session holds the target: unknown, with the reason, when the read throws or
 * the runtime cannot answer. `sessions` is the answer the read gave, `null`
 * when it threw.
 */
export async function holdingAgain(
  read: () => Promise<SessionsReport>,
  joined: (w: Workspace) => boolean,
): Promise<{ sessions: SessionsReport | null; held: Holding }> {
  try {
    const sessions = await read();
    return { sessions, held: holding(sessions, joined) };
  } catch (error) {
    return {
      sessions: null,
      held: {
        kind: "unknown",
        reason: `the runtime cannot be read again: ${failureText(error)}`,
      },
    };
  }
}

/** The running agents of each workspace, for a report. */
export function liveAgents(workspaces: Workspace[]): string {
  return workspaces
    .map(
      (w) =>
        `${w.branch || w.path} (${w.agents
          .filter((a) => RUNNING_STATES.has(a.state))
          .map((a) => a.state)
          .join(", ")})`,
    )
    .join("; ");
}
