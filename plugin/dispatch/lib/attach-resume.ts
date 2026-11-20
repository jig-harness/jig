/**
 * The command that resumes a taken-over run's vendor session in its
 * worktree, bound to the account's configuration directory it ran under:
 * `claude --resume <id>` for Claude Code, `codex resume <id>` for Codex.
 * The session id is a drive's last pass's (`round-sessions.ts`), else the
 * one the Codex pass printed at its start (the exit's `session`), else the
 * one the tick minted for the session. A run with no id gets a line saying
 * it cannot be resumed, naming the worktree. The command is printed, never
 * run: the session is the person's, never counted in the account's slots.
 */
import { shellQuote } from "../../shared/cli.ts";
import type { LaunchExit, LaunchRecord } from "./launches.ts";
import { isDrive } from "./launch-kind.ts";
import type { RoundSession } from "./round-sessions.ts";

/** What the resume line reads of a run. */
export interface ResumeFacts {
  record: Pick<
    LaunchRecord,
    "action" | "vendor" | "configDir" | "workspace" | "repoPath" | "sessionId"
  >;
  sessions: RoundSession[];
  exit: Pick<LaunchExit, "session"> | null;
}

/** The session id to resume, or `null` when the run recorded none. */
function resumeSession(facts: ResumeFacts): string | null {
  const { record, sessions, exit } = facts;
  const last = isDrive(record) ? sessions.at(-1)?.session : undefined;
  return last ?? exit?.session ?? record.sessionId ?? null;
}

/** The line that resumes the run's session, or says why it cannot be. */
export function resumeLine(facts: ResumeFacts): string {
  const { record } = facts;
  const tree = record.workspace?.path ?? record.repoPath;
  const session = resumeSession(facts);
  if (session === null)
    return `The ${record.vendor === "codex" ? "Codex" : "Claude Code"} session recorded no id, so it cannot be resumed; its worktree is ${tree}`;
  const cd = `cd ${shellQuote(tree)}`;
  return record.vendor === "codex"
    ? `${cd} && CODEX_HOME=${shellQuote(record.configDir)} codex resume ${shellQuote(session)}`
    : `${cd} && CLAUDE_CONFIG_DIR=${shellQuote(record.configDir)} claude --resume ${shellQuote(session)}`;
}
