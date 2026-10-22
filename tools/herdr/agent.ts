/**
 * Naming, starting and resuming the agent in a workspace.
 *
 * Herdr looks agents up by name alone, across every workspace and clone on
 * the server, so the name must be unique per clone and branch: two workspaces
 * sharing one would have a reattach wait on, report or prompt the other's
 * agent.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errnoCode, swallow } from "../../plugin/shared/errors.ts";
import {
  herdrCall,
  probeAgentSession,
  reportAgentStatus,
  waitForAgentSettle,
} from "./herdr.ts";
import { type Context, HerdrError } from "./runner.ts";

/** Herdr's agent-name rule. */
export const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const AGENT_NAME_MAX = 32;

/**
 * A Herdr agent name for the seed (the branch), scoped by the clone.
 *
 * The readable part is the seed folded to Herdr's alphabet; a hash of the
 * scope and the seed always follows it, since folding is lossy for any input
 * ("Review One" and "review-one" fold alike) and two clones may share a
 * branch name. The scope and seed are joined by a NUL, which neither a path
 * nor a branch name can hold, so no other pair hashes the same.
 */
export function normalizeAgentName(seed: string, scope?: string): string {
  const lowered = seed.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const leading = /^[a-z]/.test(lowered) ? lowered : `a-${lowered}`;
  const collapsed = leading.replace(/-{2,}/g, "-").replace(/-+$/, "") || "a";
  const hash = createHash("sha256")
    .update(scope === undefined ? seed : `${scope}\0${seed}`)
    .digest("hex")
    .slice(0, 8);
  const suffix = `-${hash}`;
  const prefix = collapsed
    .slice(0, AGENT_NAME_MAX - suffix.length)
    .replace(/-+$/, "");
  return `${prefix}${suffix}`;
}

/**
 * Where an agent's session receipt lives: the session it last ran, which a
 * later start resumes. Kept outside the worktree, so removing the worktree
 * never removes it.
 */
export function sessionReceiptPath(ctx: Context, agentName: string): string {
  if (!AGENT_NAME.test(agentName))
    throw new HerdrError(`"${agentName}" is not a Herdr agent name`);
  return join(ctx.stateDir, "sessions", agentName);
}

/** Best effort: a receipt not written costs a later resume, never this start. */
function writeSessionReceipt(
  ctx: Context,
  agentName: string,
  sessionId: string,
): void {
  try {
    const path = sessionReceiptPath(ctx, agentName);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${sessionId}\n`, { mode: 0o600 });
  } catch (error) {
    ctx.log(
      `⚠ could not keep the session of ${agentName} (${(error as Error).message}); a later start begins a new conversation`,
    );
  }
}

function readSessionReceipt(ctx: Context, agentName: string): string | null {
  let value: string;
  try {
    value = readFileSync(sessionReceiptPath(ctx, agentName), "utf8").trim();
  } catch (error) {
    if (errnoCode(error) !== "ENOENT")
      swallow(error, "an unreadable session receipt: start without resuming");
    return null;
  }
  return value === "" ? null : value;
}

function clearSessionReceipt(ctx: Context, agentName: string): void {
  rmSync(sessionReceiptPath(ctx, agentName), { force: true });
}

/**
 * The agent kinds whose command takes `--resume <session>`; any other kind
 * would refuse the argument and fail a start that only meant to resume.
 */
const RESUMABLE_KINDS = new Set(["claude"]);

export interface StartedAgent {
  status: string;
  sessionId: string | null;
  /** Why the session could not be read; null when it was (or there is none). */
  sessionError: string | null;
  /** The start resumed an earlier session, which may hold earlier prompts. */
  resumed: boolean;
}

/**
 * Start the agent in the pane, wait until it settles, and report it.
 *
 * With a session receipt, the start first asks to resume that session; a
 * session can have rotated away since, so a resume Herdr refuses falls back
 * to a plain start rather than failing. `agent_not_ready` is the expected
 * answer for an agent stopped at a startup dialog, and the wait then reports
 * it blocked. After the agent settles its current session is read back and
 * kept, so the receipt follows a session that rotates; a read that fails is
 * reported, not taken as "no session".
 */
export function startAgent(
  ctx: Context,
  agentName: string,
  paneId: string,
  kind: string,
  waitTimeoutMs: number,
): StartedAgent {
  const base = [
    "herdr",
    "agent",
    "start",
    agentName,
    "--kind",
    kind,
    "--pane",
    paneId,
  ];
  const resumeId = RESUMABLE_KINDS.has(kind)
    ? readSessionReceipt(ctx, agentName)
    : null;
  let started =
    resumeId === null
      ? null
      : herdrCall<unknown>(
          ctx,
          [...base, "--", "--resume", resumeId],
          "herdr agent start",
        );
  if (
    resumeId !== null &&
    started?.error &&
    started.error.code !== "agent_not_ready"
  ) {
    ctx.log(
      `⚠ could not resume session ${resumeId} of ${agentName} (${started.error.message}); starting a new conversation`,
    );
    clearSessionReceipt(ctx, agentName);
    started = null;
  } else if (resumeId !== null) {
    ctx.log(`↩ resuming session ${resumeId} of ${agentName}`);
  }
  const resumed = started !== null;
  started ??= herdrCall<unknown>(ctx, base, "herdr agent start");
  if (started.error) {
    if (started.error.code === "agent_pane_busy")
      throw new HerdrError(
        `pane ${paneId} is busy; free it or start the agent in another pane: herdr agent start ${agentName} --kind ${kind} --pane <pane>`,
      );
    if (started.error.code !== "agent_not_ready")
      throw new HerdrError(`herdr agent start: ${started.error.message}`);
  }
  const status = waitForAgentSettle(ctx, agentName, waitTimeoutMs);
  const probe = probeAgentSession(ctx, agentName);
  if (probe.ok && probe.sessionId !== null)
    writeSessionReceipt(ctx, agentName, probe.sessionId);
  reportAgentStatus(ctx, agentName, status);
  return {
    status,
    sessionId: probe.ok ? probe.sessionId : null,
    sessionError: probe.ok ? null : probe.message,
    resumed,
  };
}
