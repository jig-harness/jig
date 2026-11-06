import type { RepoTarget } from "../types.ts";
import { failureText } from "../text.ts";
import type { JoinTargets, SessionRuntime, SessionsReport } from "./port.ts";

/** The runtime's answer; a rejected read is a failed report, never an escape. */
export async function readSessions(
  runtime: SessionRuntime,
  repo: RepoTarget,
  join: JoinTargets,
): Promise<SessionsReport> {
  try {
    return await runtime.sessions(repo, join);
  } catch (error) {
    return {
      ok: false,
      source: runtime.name,
      reason: `the runtime could not be read: ${failureText(error)}`,
    };
  }
}
