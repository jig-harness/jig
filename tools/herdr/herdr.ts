/**
 * The calls the workspace tool makes to Herdr, through its command line's
 * JSON output (https://herdr.dev/docs/cli-reference/).
 *
 * Herdr answers each command with an envelope: `{ result }` on success,
 * `{ error: { code, message } }` otherwise, on stdout or stderr. Some errors
 * are states the caller expects (`agent_not_found` for an agent that is not
 * running, `agent_not_ready` for one stopped at a dialog), so a structured
 * error is returned to the caller to decide on; only a call that produced no
 * envelope at all is a failure here.
 */
import { swallow } from "../../plugin/shared/errors.ts";
import { type Context, HerdrError, output, type RunResult } from "./runner.ts";

/** How long past a `herdr agent wait`'s own timeout its process may run. */
const WAIT_SLACK_MS = 30_000;
/** Attempts to wait out an agent that is still working before reporting it. */
const WORKING_RETRIES = 3;
const WORKING_RETRY_DELAY_MS = 2_000;

export interface HerdrEnvelope<T> {
  result?: T;
  error?: { code: string; message: string };
}

/** The envelope in a command's output, or null when the output holds none. */
export function parseEnvelope<T>(text: string): HerdrEnvelope<T> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    swallow(
      error,
      "herdr output that starts like JSON but is not: no envelope",
    );
    return null;
  }
  return parsed !== null && typeof parsed === "object"
    ? (parsed as HerdrEnvelope<T>)
    : null;
}

/** The envelope a command answered with; throws only when there is none. */
export function herdrCall<T>(
  ctx: Context,
  argv: string[],
  what: string,
  timeoutMs?: number,
): HerdrEnvelope<T> {
  const result: RunResult = ctx.run(
    argv,
    timeoutMs === undefined ? undefined : { timeoutMs },
  );
  const envelope =
    parseEnvelope<T>(result.stdout) ?? parseEnvelope<T>(result.stderr);
  if (envelope?.error) return envelope;
  if (result.status !== 0)
    throw new HerdrError(
      `${what} failed (exit ${result.status}): ${output(result)}`,
    );
  if (envelope === null)
    throw new HerdrError(`${what}: unreadable output: ${output(result)}`);
  return envelope;
}

/** The result of a command that must succeed. */
export function herdrJson<T>(
  ctx: Context,
  argv: string[],
  what: string,
  timeoutMs?: number,
): T {
  const envelope = herdrCall<T>(ctx, argv, what, timeoutMs);
  if (envelope.error)
    throw new HerdrError(`${what}: ${envelope.error.message}`);
  if (envelope.result === undefined)
    throw new HerdrError(`${what}: empty result`);
  return envelope.result;
}

function isNotFound(code: string): boolean {
  return code === "agent_not_found" || code === "not_found";
}

export interface HerdrWorktreeRow {
  branch?: string;
  path: string;
  open_workspace_id?: string;
}

/**
 * Herdr's worktree for the branch in this clone, or null. `--cwd` names the
 * clone: without it Herdr asks the caller's own pane, which a script started
 * over SSH does not have.
 */
export function findHerdrWorktree(
  ctx: Context,
  repo: string,
  branch: string,
): HerdrWorktreeRow | null {
  const listed = herdrJson<{ worktrees?: HerdrWorktreeRow[] }>(
    ctx,
    ["herdr", "worktree", "list", "--cwd", repo, "--json"],
    "herdr worktree list",
  );
  return listed.worktrees?.find((row) => row.branch === branch) ?? null;
}

type AgentResult = {
  agent?: { agent_status?: unknown; agent_session?: unknown };
};

function agentObject(
  result: AgentResult | undefined,
): Record<string, unknown> | null {
  const agent = result?.agent;
  return agent !== null && typeof agent === "object" && !Array.isArray(agent)
    ? (agent as Record<string, unknown>)
    : null;
}

/**
 * Whether a live agent has this name. Only Herdr's not-found answer means no;
 * any other error, and a success without an agent in it, is thrown, since a
 * wrong "no" would start a second agent beside a running one.
 */
export function agentExists(ctx: Context, name: string): boolean {
  const envelope = herdrCall<AgentResult>(
    ctx,
    ["herdr", "agent", "get", name],
    "herdr agent get",
  );
  if (envelope.error) {
    if (isNotFound(envelope.error.code)) return false;
    throw new HerdrError(`herdr agent get: ${envelope.error.message}`);
  }
  if (agentObject(envelope.result) === null)
    throw new HerdrError(
      `herdr agent get: no agent in the result (${JSON.stringify(envelope.result ?? null)})`,
    );
  return true;
}

export type SessionProbe =
  | { ok: true; sessionId: string | null }
  | { ok: false; message: string };

/**
 * The agent's current session id, keeping "could not ask" apart from "asked,
 * and there is none". Herdr reports `agent_session` only when an integration
 * stored one, so an absent or null field is an answer (`sessionId: null`); a
 * failed call, an error, a result without an agent, or a field that is
 * present but not a non-empty string without spaces is not.
 */
export function probeAgentSession(ctx: Context, name: string): SessionProbe {
  let envelope: HerdrEnvelope<AgentResult>;
  try {
    envelope = herdrCall<AgentResult>(
      ctx,
      ["herdr", "agent", "get", name],
      "herdr agent get",
    );
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  if (envelope.error) return { ok: false, message: envelope.error.message };
  const agent = agentObject(envelope.result);
  if (agent === null)
    return {
      ok: false,
      message: `herdr agent get: no agent in the result (${JSON.stringify(envelope.result ?? null)})`,
    };
  const session = agent.agent_session;
  if (session === undefined || session === null)
    return { ok: true, sessionId: null };
  if (typeof session !== "object" || Array.isArray(session))
    return {
      ok: false,
      message: `herdr agent get: agent_session is not an object (${JSON.stringify(session)})`,
    };
  const value = (session as { value?: unknown }).value;
  if (value === undefined || value === null)
    return { ok: true, sessionId: null };
  if (typeof value !== "string" || value === "" || /\s/.test(value))
    return {
      ok: false,
      message: `herdr agent get: agent_session.value is not a session id (${JSON.stringify(value)})`,
    };
  return { ok: true, sessionId: value };
}

/** The agent's session id, or null for every uncertainty: a resume hint only. */
export function readAgentSessionId(ctx: Context, name: string): string | null {
  const probe = probeAgentSession(ctx, name);
  return probe.ok ? probe.sessionId : null;
}

/** Show a Herdr notification; throws when it was not delivered. */
export function notify(ctx: Context, title: string, body: string): void {
  const shown = ctx.run([
    "herdr",
    "notification",
    "show",
    title,
    "--body",
    body,
  ]);
  if (shown.status !== 0)
    throw new HerdrError(
      `herdr notification show failed (exit ${shown.status}): ${output(shown)}`,
    );
}

/**
 * Wait until the agent is idle, blocked or done, and return which.
 *
 * A wait that fails or times out is checked with `agent get` before anything
 * else, since the agent may have settled while the wait was failing; one
 * still working is waited for again, a bounded number of times. Anything else
 * notifies a person and throws, leaving the agent and its pane as they are.
 */
export function waitForAgentSettle(
  ctx: Context,
  name: string,
  waitTimeoutMs: number,
): string {
  for (let attempt = 0; ; attempt++) {
    let failure: string;
    try {
      const waited = herdrJson<{ agent: { agent_status: string } }>(
        ctx,
        [
          "herdr",
          "agent",
          "wait",
          name,
          "--until",
          "idle",
          "--until",
          "blocked",
          "--until",
          "done",
          "--timeout",
          String(waitTimeoutMs),
        ],
        "herdr agent wait",
        waitTimeoutMs + WAIT_SLACK_MS,
      );
      return waited.agent.agent_status;
    } catch (error) {
      failure = (error as Error).message;
    }
    const probe = herdrCall<AgentResult>(
      ctx,
      ["herdr", "agent", "get", name],
      "herdr agent get",
    );
    const status = agentObject(probe.result)?.agent_status;
    if (status === "idle" || status === "blocked" || status === "done")
      return status;
    if (status === "working" && attempt < WORKING_RETRIES) {
      ctx.log(`… ${name} is still working; waiting again`);
      ctx.sleep(WORKING_RETRY_DELAY_MS);
      continue;
    }
    const reason = `could not tell whether agent ${name} settled (${failure}; last state: ${String(status ?? probe.error?.message ?? "unknown")})`;
    try {
      notify(
        ctx,
        `${name} unresponsive`,
        "the workspace tool could not tell whether this agent settled; attach and check it. The agent and its pane are as they were.",
      );
    } catch (error) {
      throw new HerdrError(
        `${reason}; the notification also failed: ${(error as Error).message}`,
      );
    }
    throw new HerdrError(reason);
  }
}

/**
 * Report a settled agent. A blocked one (a first-run or trust dialog) is
 * notified as well as logged, and a notification that fails is thrown: the
 * caller's exit status is then the only signal left that someone must answer
 * the dialog.
 */
export function reportAgentStatus(
  ctx: Context,
  name: string,
  status: string,
): void {
  if (status !== "blocked") {
    ctx.log(`✓ agent ${name} ${status}`);
    return;
  }
  ctx.log(
    `⚠ agent ${name} is waiting at a dialog; answer it: herdr agent attach ${name}`,
  );
  try {
    notify(ctx, `${name} blocked`, "answer the agent's startup dialog");
  } catch (error) {
    throw new HerdrError(
      `agent ${name} is blocked at a dialog and the notification failed (${(error as Error).message}); attach and answer it: herdr agent attach ${name}`,
    );
  }
}

/**
 * A new tab in the workspace for an agent, and its pane. A reattached
 * workspace's existing panes may hold a shell command or a server, which
 * `agent start` refuses, so the agent gets a pane of its own.
 */
export function createAgentPane(
  ctx: Context,
  workspaceId: string,
  cwd: string,
): string {
  const created = herdrJson<{ root_pane?: { pane_id?: unknown } }>(
    ctx,
    [
      "herdr",
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      cwd,
      "--label",
      "agent",
      "--no-focus",
    ],
    "herdr tab create",
  );
  const pane = created.root_pane?.pane_id;
  if (typeof pane !== "string" || pane === "")
    throw new HerdrError(
      `herdr tab create: no pane in the result (${JSON.stringify(created)})`,
    );
  return pane;
}
