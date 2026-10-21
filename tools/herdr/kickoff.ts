/**
 * Send a workspace's first prompt (its kickoff) once: not twice to an agent
 * already working on it, and not zero times to one that never received it.
 *
 * Three records make that hold across retries, lost connections and
 * concurrent launches of the same work:
 *
 * - A **claim** marks a kickoff in flight, so a second launch waits instead
 *   of deciding while the first has started an agent but not yet prompted it.
 * - A **receipt** records a kickoff Herdr accepted, under a correlation id
 *   `<key>:<agent>[:<session>]`. The session id tells a restarted agent with
 *   the same name apart from the process that received the prompt. An older
 *   receipt is removed before the prompt is sent, so a receipt that fails to
 *   be written leaves none rather than a stale one.
 * - The agent's **transcript** answers when there is no receipt (the prompt
 *   was accepted but the receipt never written).
 *
 * Whenever the records cannot settle it, the kickoff is refused, saying what
 * to check, rather than guessed: an extra prompt to a working agent and
 * an unstarted piece of work are both worse than asking a person.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { errnoCode } from "../../plugin/shared/errors.ts";
import { parseEnvelope, probeAgentSession } from "./herdr.ts";
import { type Context, HerdrError, output, type RunResult } from "./runner.ts";
import type { Spawned } from "./spawn.ts";

/** What a kickoff key may look like: it names files. */
export const KICKOFF_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The bound on submitting the prompt. */
export const PROMPT_TIMEOUT_MS = 45_000;
/** Lines of the agent's output searched for an earlier kickoff. */
const TRANSCRIPT_LINES = 4_000;
/** Marks a claim generation given back; a superseded one is already gone. */
const RELEASED = "released";

export interface KickoffOptions {
  /** Names the work, e.g. the tracker issue key; one kickoff per key. */
  key: string;
  prompt: string;
  /** How long to wait for another launch's claim on this key. */
  claimWaitMs: number;
  /** Age after which a claim is taken as abandoned. */
  claimStaleMs: number;
}

export type KickoffOutcome = "sent" | "already-delivered";

function kickoffDir(ctx: Context): string {
  return join(ctx.stateDir, "kickoff");
}

/** Receipts and claims live in separate directories, so no key names the other's. */
export function receiptPath(ctx: Context, key: string): string {
  if (!KICKOFF_KEY.test(key))
    throw new HerdrError(`"${key}" cannot be a kickoff key`);
  return join(kickoffDir(ctx), "receipts", key);
}

function claimDir(ctx: Context, key: string): string {
  receiptPath(ctx, key);
  return join(kickoffDir(ctx), "claims", key);
}

/** The prompt's first line: what an earlier kickoff shows in the transcript. */
export function promptToken(prompt: string): string {
  return prompt.split("\n")[0]?.trim() ?? "";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether the transcript holds the token as itself, not as the start of a
 * longer one: `/do ABC-1` must not match a transcript that only ever had
 * `/do ABC-10`. An empty token matches nothing.
 */
export function transcriptHasToken(transcript: string, token: string): boolean {
  if (token === "") return false;
  return new RegExp(`${escapeRegExp(token)}(?![\\w-])`).test(transcript);
}

/**
 * Take the claim for a key, waiting for a live one, and return the
 * generation taken.
 *
 * A claim is the highest-numbered directory under `claims/<key>/`; taking one
 * over means creating the next number, never removing the old one first.
 * `mkdir` of a given name succeeds for exactly one process, so two launches
 * that both find the same claim abandoned race for the same next number and
 * only one wins. Removing a claim to take it over would let both win: each
 * could remove what the other had just created. Superseded generations are
 * removed by the winner, and a holder releases only the generation it owns,
 * by marking it released rather than removing it: the highest number always
 * stays on disk, so numbers never repeat, and a launch that read an old
 * generation and paused cannot later create a number another launch holds.
 */
export function acquireClaim(
  ctx: Context,
  key: string,
  waitMs: number,
  staleMs: number,
): string {
  const dir = claimDir(ctx, key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const generations = generationsIn(dir);
    const step = nextStep(dir, generations, staleMs);
    if ("create" in step && take(dir, step.create, generations))
      return String(step.create);
    if ("held" in step && Date.now() >= deadline)
      throw new HerdrError(
        `another launch is kicking off ${key} (claim ${step.held}) and did not finish within ${Math.round(waitMs / 1000)}s; let it finish and run again. An abandoned claim is taken over after ${Math.round(staleMs / 1000)}s`,
      );
    if ("held" in step) ctx.sleep(1_000);
  }
}

function generationsIn(dir: string): number[] {
  return readdirSync(dir)
    .filter((name) => /^[0-9]+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * What to do next: create the first generation, create the one after an
 * abandoned claim, wait for a live one, or look again when the claim went
 * away while it was being read.
 */
function nextStep(
  dir: string,
  generations: number[],
  staleMs: number,
): { create: number } | { held: number } | { rescan: true } {
  const top = generations.at(-1);
  if (top === undefined) return { create: 1 };
  if (existsSync(join(dir, String(top), RELEASED))) return { create: top + 1 };
  let heldSince: number;
  try {
    heldSince = statSync(join(dir, String(top))).mtimeMs;
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
    return { rescan: true };
  }
  return Date.now() - heldSince >= staleMs
    ? { create: top + 1 }
    : { held: top };
}

/**
 * Create the generation; false when another launch created it first. The
 * winner removes the generations it superseded.
 */
function take(dir: string, next: number, generations: number[]): boolean {
  try {
    mkdirSync(join(dir, String(next)), { mode: 0o700 });
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
    return false;
  }
  for (const old of generations)
    if (old < next)
      rmSync(join(dir, String(old)), { recursive: true, force: true });
  return true;
}

export function releaseClaim(
  ctx: Context,
  key: string,
  generation: string,
): void {
  try {
    writeFileSync(join(claimDir(ctx, key), generation, RELEASED), "");
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

/**
 * Throw unless the generation is still the live claim: an abandoned claim is
 * taken over by age, and a holder that was slow past that age must not send.
 */
function assertClaimHeld(ctx: Context, key: string, generation: string): void {
  const dir = claimDir(ctx, key);
  const top = generationsIn(dir).at(-1);
  if (String(top) !== generation || existsSync(join(dir, generation, RELEASED)))
    throw new HerdrError(
      `another launch took over the kickoff claim on ${key} (now ${top ?? "none"}); check with herdr agent read before running this again`,
    );
}

/**
 * Whether a live agent already received this kickoff.
 *
 * A receipt equal to the current correlation id says yes. A well-formed
 * receipt for this agent that names another session says no without reading
 * the transcript: the transcript is the pane's output, which outlives a
 * restart, so it would show the old process's prompt as if the new one had
 * it. Without a receipt the transcript decides. The session is read again
 * last and must not have changed, so an agent replaced during the check
 * cannot be answered for. Anything that cannot be read is an error, never
 * "no": only a missing receipt file counts as "no receipt".
 */
export function reconcileKickoff(
  ctx: Context,
  agentName: string,
  key: string,
  prompt: string,
): "delivered" | "undelivered" {
  const probe = probeAgentSession(ctx, agentName);
  if (!probe.ok)
    throw new HerdrError(
      `could not read the session of ${agentName}: ${probe.message}`,
    );
  const verdict =
    receiptVerdict(ctx, key, agentName, probe.sessionId) ??
    transcriptVerdict(ctx, agentName, prompt);
  const recheck = probeAgentSession(ctx, agentName);
  if (!recheck.ok)
    throw new HerdrError(
      `could not read the session of ${agentName} again: ${recheck.message}`,
    );
  if (recheck.sessionId !== probe.sessionId)
    throw new HerdrError(
      `the session of ${agentName} changed from ${probe.sessionId ?? "none"} to ${recheck.sessionId ?? "none"} during the check; it was restarted, so the check cannot answer`,
    );
  return verdict;
}

/** What the receipt says, or null when there is none for this agent to go by. */
function receiptVerdict(
  ctx: Context,
  key: string,
  agentName: string,
  sessionId: string | null,
): "delivered" | "undelivered" | null {
  let receipt: string | undefined;
  try {
    receipt = readFileSync(receiptPath(ctx, key), "utf8")
      .split("\n")
      .find((line) => line !== "");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw new HerdrError(
      `could not read the kickoff receipt of ${key}: ${(error as Error).message}`,
    );
  }
  if (receipt === correlation(key, agentName, sessionId)) return "delivered";
  const forAgent = `${key}:${agentName}`;
  const wellFormed =
    receipt === forAgent ||
    (receipt !== undefined &&
      new RegExp(`^${escapeRegExp(forAgent)}:\\S+$`).test(receipt));
  return wellFormed ? "undelivered" : null;
}

/** Whether the prompt's first line is in the agent's recent output. */
function transcriptVerdict(
  ctx: Context,
  agentName: string,
  prompt: string,
): "delivered" | "undelivered" {
  const read = ctx.run([
    "herdr",
    "agent",
    "read",
    agentName,
    "--source",
    "recent",
    "--lines",
    String(TRANSCRIPT_LINES),
  ]);
  if (read.status !== 0)
    throw new HerdrError(
      `herdr agent read failed (exit ${read.status}): ${output(read)}`,
    );
  return transcriptHasToken(read.stdout, promptToken(prompt))
    ? "delivered"
    : "undelivered";
}

/** The message of a structured error Herdr answered with, or null. */
function parseError(result: RunResult): string | null {
  for (const text of [result.stdout, result.stderr]) {
    const message = parseEnvelope<unknown>(text)?.error?.message;
    if (typeof message === "string") return message;
  }
  return null;
}

function correlation(
  key: string,
  agent: string,
  session: string | null,
): string {
  return session === null ? `${key}:${agent}` : `${key}:${agent}:${session}`;
}

/**
 * Remove an earlier receipt before a send. Throws when it cannot: a send whose
 * own receipt then failed to be written would leave the old one standing, and
 * it would answer "undelivered" for the agent that did get the prompt.
 */
function clearReceipt(ctx: Context, key: string): void {
  const path = receiptPath(ctx, key);
  try {
    rmSync(path, { force: true });
  } catch (error) {
    throw new HerdrError(
      `could not remove the earlier kickoff receipt ${path} (${(error as Error).message}); remove it, then run this again`,
    );
  }
}

/** Written whole under a temporary name, so a reader sees a receipt or none. */
function writeReceipt(ctx: Context, key: string, line: string): void {
  const path = receiptPath(ctx, key);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${line}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    ctx.log(
      `⚠ the kickoff was sent but its receipt was not written (${(error as Error).message}); a later launch reads the transcript instead`,
    );
  }
}

/**
 * Send the kickoff to the workspace's agent unless it already has it.
 * Throws, saying what to check, whenever that cannot be settled.
 */
export function kickoff(
  ctx: Context,
  spawned: Spawned,
  options: KickoffOptions,
): KickoffOutcome {
  const { agentName } = spawned;
  if (promptToken(options.prompt) === "")
    throw new HerdrError(
      "the kickoff prompt's first line is empty; it is what a later launch looks for in the transcript",
    );
  if (spawned.agentStatus === null)
    throw new HerdrError(
      `no agent is running in ${spawned.path}; nothing to kick off`,
    );
  if (spawned.agentStatus === "blocked")
    throw new HerdrError(
      `agent ${agentName} is waiting at a dialog; answer it (herdr agent attach ${agentName}), then run this again to send the kickoff`,
    );
  if (spawned.agentSessionError !== null)
    throw new HerdrError(
      `could not read the session of ${agentName} (${spawned.agentSessionError}); a kickoff recorded without it could be sent again later, so run this again`,
    );
  if (spawned.agentSessionId === null)
    ctx.log(
      `⚠ Herdr reports no session id for ${agentName}; a restart under the same name cannot be told apart from it`,
    );
  const generation = acquireClaim(
    ctx,
    options.key,
    options.claimWaitMs,
    options.claimStaleMs,
  );
  let release = true;
  try {
    // A resumed conversation may already hold the kickoff, like a running agent.
    if (spawned.agentExisted || spawned.agentResumed) {
      const verdict = reconcileKickoff(
        ctx,
        agentName,
        options.key,
        options.prompt,
      );
      if (verdict === "delivered") {
        ctx.log(`↺ ${agentName} already has the kickoff; not sending it again`);
        return "already-delivered";
      }
      ctx.log(`⚠ ${agentName} has no record of the kickoff; sending it`);
    }
    clearReceipt(ctx, options.key);
    assertClaimHeld(ctx, options.key, generation);
    // Without `--wait` Herdr acknowledges the writes, which is what a
    // kickoff needs; the process deadline bounds the call.
    const sent = ctx.run(
      ["herdr", "agent", "prompt", agentName, options.prompt],
      { timeoutMs: PROMPT_TIMEOUT_MS },
    );
    const answer = parseError(sent);
    if (answer !== null || sent.status === 2)
      throw new HerdrError(
        `${agentName} did not take the kickoff (${answer ?? output(sent)}); run this again once it is ready`,
      );
    if (sent.status !== 0) {
      // Herdr may or may not have taken the prompt. Keeping the claim stops
      // an immediate retry from sending it again; it lapses on its own.
      release = false;
      throw new HerdrError(
        `could not tell whether ${agentName} received the kickoff (exit ${sent.status}: ${output(sent)}); check with herdr agent read ${agentName} --source recent before running this again`,
      );
    }
    writeReceipt(
      ctx,
      options.key,
      correlation(options.key, agentName, spawned.agentSessionId),
    );
    ctx.log(`✓ kickoff sent to ${agentName}`);
    return "sent";
  } finally {
    if (release) releaseClaim(ctx, options.key, generation);
  }
}
