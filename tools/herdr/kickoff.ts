/**
 * Send a workspace's first prompt (its kickoff) once: not twice to an agent
 * already working on it, and not zero times to one that never received it.
 *
 * Three records make that hold across retries, lost connections and
 * concurrent launches of the same work:
 *
 * - A **claim** marks a kickoff in flight, so a second launch waits instead
 *   of deciding while the first has started an agent but not yet prompted it.
 *   It names the process that holds it, and is taken over only once that
 *   process has ended: a holder that is merely slow may still be about to
 *   send, so no age makes its claim abandoned.
 * - A **receipt**, one per key and agent, records a kickoff under a
 *   correlation id `<key>:<agent>[:<session>]`. The session id tells a restarted agent with
 *   the same name apart from the process that received the prompt. Before
 *   the prompt is sent the receipt is written as **pending**
 *   (`pending <correlation>`), and only a send Herdr accepted turns it into
 *   the plain correlation id. So every send this tool ever attempted leaves
 *   a record, and a send whose outcome is unknown, or whose final receipt
 *   failed to be written, stays pending. Each launch writes only a file of
 *   its own, named by its claim generation, and the highest-numbered file is
 *   the receipt: a launch that lost its claim and resumes late writes below
 *   the launch that took over, so no check-then-write race lets it replace
 *   that launch's record.
 * - The agent's **transcript** is positive evidence only: a pending receipt
 *   whose prompt shows in it counts as delivered. Its absence proves nothing,
 *   since the read covers recent rows only, so a pending receipt the
 *   transcript does not confirm is refused. With no receipt at all this tool
 *   never sent the kickoff, and the transcript only spots one sent otherwise.
 *
 * Every change to these records moves toward "unknown", never toward "not
 * delivered": a launch whose claim was removed by hand writes under the
 * record of the launch that took over, never over it, and a receipt this
 * tool cannot read as one of its own is refused rather than taken as none. Whenever the records cannot settle
 * it, the kickoff is refused, saying what to check, rather than guessed: an
 * extra prompt to a working agent and an unstarted piece of work are both
 * worse than asking a person.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { errnoCode, swallow } from "../../plugin/shared/errors.ts";
import { AGENT_NAME } from "./agent.ts";
import { parseEnvelope, probeAgentSession } from "./herdr.ts";
import { localOwner, ownerAlive, ownerLine } from "./owner.ts";
import {
  budget,
  type Context,
  HerdrError,
  output,
  type RunResult,
} from "./runner.ts";
import type { Spawned } from "./spawn.ts";

/** What a kickoff key may look like: it names files. */
export const KICKOFF_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** How long a kickoff waits for another launch of the same key. */
export const CLAIM_WAIT_MS = 120_000;
/** The bound on submitting the prompt. */
export const PROMPT_TIMEOUT_MS = 45_000;
/** Lines of the agent's output searched for an earlier kickoff. */
const TRANSCRIPT_LINES = 4_000;
/** Marks a claim generation given back; a superseded one is already gone. */
const RELEASED = "released";
/** Names the host and process holding a claim generation. */
const OWNER = "owner";
/** Marks a receipt written before the send it records. */
const PENDING = "pending";
/**
 * Herdr's errors that answer a prompt without writing it: the agent is at a
 * dialog, or there is no such agent. Any other error, a timeout above all,
 * does not establish that the prompt was not delivered.
 */
const REFUSED = new Set(["agent_blocked", "agent_not_found", "not_found"]);

export interface KickoffOptions {
  /** Names the work, e.g. the tracker issue key; one kickoff per key. */
  key: string;
  prompt: string;
  /** How long to wait for another launch's claim on this key. */
  claimWaitMs: number;
}

export type KickoffOutcome = "sent" | "already-delivered";

function kickoffDir(ctx: Context): string {
  return join(ctx.stateDir, "kickoff");
}

function assertKey(key: string): void {
  if (!KICKOFF_KEY.test(key))
    throw new HerdrError(`"${key}" cannot be a kickoff key`);
}

/**
 * The directory of a key's receipts for one agent: one file per launch, named
 * by its claim generation. Each agent the key's work was opened in (another
 * clone's worktree has another agent) keeps its own, so opening the key in
 * one never overwrites the record of another. Receipts and claims live in
 * separate directories, so no key names the other's.
 */
export function receiptDir(
  ctx: Context,
  key: string,
  agentName: string,
): string {
  assertKey(key);
  if (!AGENT_NAME.test(agentName))
    throw new HerdrError(`"${agentName}" is not a Herdr agent name`);
  return join(kickoffDir(ctx), "receipts", key, agentName);
}

/** The generations a receipt directory holds, lowest first; [] for none. */
function receiptGenerations(dir: string): number[] {
  try {
    return generationsIn(dir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

function claimDir(ctx: Context, key: string): string {
  assertKey(key);
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
 * `/do ABC-10`, `/do ABC-1-x` or `/do ABC-1.2`. Anything a kickoff key may
 * continue with (`KICKOFF_KEY`) ends the match, dots included; trailing dots
 * alone, as at the end of a sentence, do not. An empty token matches nothing.
 */
export function transcriptHasToken(transcript: string, token: string): boolean {
  if (token === "") return false;
  return new RegExp(`${escapeRegExp(token)}(?!\\.*[\\w-])`).test(transcript);
}

/**
 * Take the claim for a key, waiting for a live one, and return the
 * generation taken.
 *
 * A claim is the highest-numbered directory under `claims/<key>/`, holding
 * its owner's host and process; taking one over means creating the next
 * number, never removing the old one first. Each number is created whole, its
 * owner inside, by renaming a directory into place, which succeeds for exactly
 * one process, so two launches that both find the same claim abandoned race
 * for the same next number and only one wins. Removing a claim to take it
 * over would let both win: each could remove what the other had just
 * created. Superseded generations are removed by the winner, and a holder
 * releases only the generation it owns, by marking it released rather than
 * removing it: the highest number always stays on disk, so numbers never
 * repeat, and a launch that read an old generation and paused cannot later
 * create a number another launch holds. The next number is above every
 * receipt of the key as well, so a claim removed by hand never leaves a new
 * launch below the receipt the removed one wrote.
 *
 * A claim is abandoned only once its owner, on this host, has ended. A claim
 * owned on another host, or with no owner to read, is waited for and then
 * refused, naming the file a person creates to give it back once no launch
 * holds it. Giving a claim back, rather than removing it, keeps its number.
 */
export function acquireClaim(
  ctx: Context,
  key: string,
  waitMs: number,
): string {
  const dir = claimDir(ctx, key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const generations = generationsIn(dir);
    const step = nextStep(ctx, key, dir, generations);
    if ("create" in step && take(ctx, dir, step.create, generations))
      return String(step.create);
    if ("held" in step && Date.now() >= deadline)
      throw new HerdrError(
        `another launch is kicking off ${key} (claim ${step.held}) and did not finish within ${Math.round(waitMs / 1000)}s; let it finish and run again. Its claim is taken over once the launch holding it has ended; if no launch is running and it stays, give it back with touch ${join(dir, String(step.held), RELEASED)}`,
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
 * What to do next: create the first generation, create the one after a
 * released or abandoned claim, wait for a held one, or look again when the
 * claim went away while it was being read.
 */
function nextStep(
  ctx: Context,
  key: string,
  dir: string,
  generations: number[],
): { create: number } | { held: number } | { rescan: true } {
  const top = generations.at(-1);
  const next = Math.max(top ?? 0, highestReceipt(ctx, key)) + 1;
  if (top === undefined) return { create: next };
  const claim = join(dir, String(top));
  if (existsSync(join(claim, RELEASED))) return { create: next };
  let owner: string;
  try {
    owner = readFileSync(join(claim, OWNER), "utf8");
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
    return existsSync(claim) ? { held: top } : { rescan: true };
  }
  const holder = localOwner(owner);
  return holder === null || ownerAlive(ctx, holder)
    ? { held: top }
    : { create: next };
}

/**
 * The highest claim generation any receipt of the key was written under; 0
 * for none. A claim removed by hand takes its number with it, and the next
 * one must still be above every receipt, or a new launch would be refused as
 * superseded by the record of the claim it replaced.
 */
function highestReceipt(ctx: Context, key: string): number {
  const dir = join(kickoffDir(ctx), "receipts", key);
  let agents: string[];
  try {
    agents = readdirSync(dir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return 0;
    throw error;
  }
  let highest = 0;
  for (const agent of agents)
    if (AGENT_NAME.test(agent))
      highest = Math.max(
        highest,
        receiptGenerations(join(dir, agent)).at(-1) ?? 0,
      );
  return highest;
}

/**
 * Create the generation, its owner inside; false when another launch created
 * it first. The winner removes the generations it superseded.
 */
function take(
  ctx: Context,
  dir: string,
  next: number,
  generations: number[],
): boolean {
  const temp = join(dir, `.${next}.${process.pid}.tmp`);
  try {
    rmSync(temp, { recursive: true, force: true });
    mkdirSync(temp, { mode: 0o700 });
    writeFileSync(join(temp, OWNER), ownerLine(ctx), { mode: 0o600 });
    renameSync(temp, join(dir, String(next)));
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    const code = errnoCode(error);
    if (code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw error;
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

/** Whether `generation` is still the claim's live generation. */
function claimHeld(ctx: Context, key: string, generation: string): boolean {
  const dir = claimDir(ctx, key);
  return (
    String(generationsIn(dir).at(-1)) === generation &&
    !existsSync(join(dir, generation, RELEASED))
  );
}

/**
 * Throw unless the generation is still the live claim: one removed by hand
 * may have been taken by another launch, and this one must not send then.
 */
function assertClaimHeld(ctx: Context, key: string, generation: string): void {
  if (!claimHeld(ctx, key, generation)) {
    const top = generationsIn(claimDir(ctx, key)).at(-1);
    throw new HerdrError(
      `another launch took over the kickoff claim on ${key} (now ${top ?? "none"}); check with herdr agent read before running this again`,
    );
  }
}

/**
 * Whether a live agent already received this kickoff, and the session the
 * answer is for.
 *
 * A receipt equal to the current correlation id says yes. A pending one says
 * yes only when the transcript shows the prompt, and is refused otherwise. A
 * well-formed receipt, sent or pending, for this agent that names another
 * session says no without reading the transcript: the transcript is the
 * pane's output, which outlives a restart, so it would show the old process's
 * prompt as if the new one had it. Without a receipt the transcript decides.
 * The session is read again last and must not have changed, so an agent
 * replaced during the check cannot be answered for. Anything that cannot be
 * read is an error, never "no": only a missing receipt file counts as "no
 * receipt".
 */
export function reconcileKickoff(
  ctx: Context,
  agentName: string,
  key: string,
  prompt: string,
): Reconciled {
  const sessionId = readSession(ctx, agentName);
  const verdict =
    receiptVerdict(ctx, key, agentName, sessionId, prompt) ??
    (transcriptHasPrompt(ctx, agentName, prompt) ? "delivered" : "undelivered");
  assertSameSession(ctx, agentName, sessionId, "during the check");
  return { verdict, sessionId };
}

export interface Reconciled {
  verdict: "delivered" | "undelivered";
  sessionId: string | null;
}

function readSession(ctx: Context, agentName: string): string | null {
  const probe = probeAgentSession(ctx, agentName);
  if (!probe.ok)
    throw new HerdrError(
      `could not read the session of ${agentName}: ${probe.message}`,
    );
  return probe.sessionId;
}

/** Throw unless the agent still runs the session `expected`. */
function assertSameSession(
  ctx: Context,
  agentName: string,
  expected: string | null,
  when: string,
): void {
  const recheck = probeAgentSession(ctx, agentName);
  if (!recheck.ok)
    throw new HerdrError(
      `could not read the session of ${agentName} again: ${recheck.message}`,
    );
  if (recheck.sessionId !== expected)
    throw new HerdrError(
      `the session of ${agentName} changed from ${expected ?? "none"} to ${recheck.sessionId ?? "none"} ${when}; it was restarted, so the kickoff cannot be answered for. Run this again`,
    );
}

/**
 * The receipt's first line, from its highest-numbered file; null when there
 * is none. A file removed while it is read was superseded, so the files are
 * listed again.
 */
function readReceipt(
  ctx: Context,
  key: string,
  agentName: string,
): string | null {
  const dir = receiptDir(ctx, key, agentName);
  try {
    for (;;) {
      const top = receiptGenerations(dir).at(-1);
      if (top === undefined) return null;
      try {
        return (
          readFileSync(join(dir, String(top)), "utf8")
            .split("\n")
            .find((line) => line !== "") ?? ""
        );
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    throw new HerdrError(
      `could not read the kickoff receipt of ${key}: ${(error as Error).message}`,
    );
  }
}

/**
 * What the agent's receipt says, or null when it has none. A receipt that is
 * not one this tool writes (empty, cut short, or anything else) is refused:
 * damaged evidence of a send is not evidence of none.
 */
function receiptVerdict(
  ctx: Context,
  key: string,
  agentName: string,
  sessionId: string | null,
  prompt: string,
): "delivered" | "undelivered" | null {
  const receipt = readReceipt(ctx, key, agentName);
  if (receipt === null) return null;
  const current = correlation(key, agentName, sessionId);
  if (receipt === current) return "delivered";
  if (receipt === `${PENDING} ${current}`) {
    if (transcriptHasPrompt(ctx, agentName, prompt)) return "delivered";
    throw new HerdrError(
      `an earlier kickoff of ${key} to ${agentName} may have landed, and its prompt is not in the agent's recent output; check with herdr agent read ${agentName} --source recent, and if the agent never got it remove the directory ${receiptDir(ctx, key, agentName)} and run this again`,
    );
  }
  const forAgent = escapeRegExp(`${key}:${agentName}`);
  if (new RegExp(`^(?:${PENDING} )?${forAgent}(?::\\S+)?$`).test(receipt))
    return "undelivered";
  throw new HerdrError(
    `the kickoff receipt of ${key} for ${agentName} is not one this tool writes (${JSON.stringify(receipt)}), so it cannot show that the kickoff was never sent; check with herdr agent read ${agentName} --source recent, and if the agent never got it remove the directory ${receiptDir(ctx, key, agentName)} and run this again`,
  );
}

/** Whether the prompt's first line is in the agent's recent output. */
function transcriptHasPrompt(
  ctx: Context,
  agentName: string,
  prompt: string,
): boolean {
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
  return transcriptHasToken(read.stdout, promptToken(prompt));
}

/** The structured error Herdr answered with, or null. */
function parseError(
  result: RunResult,
): { code: string; message: string } | null {
  for (const text of [result.stdout, result.stderr]) {
    const error = parseEnvelope<unknown>(text)?.error;
    if (typeof error?.message === "string")
      return { code: String(error.code), message: error.message };
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
 * Write this launch's receipt file whole under a temporary name, so a reader
 * sees it or none; `null` removes it. Throws when it cannot.
 */
function setReceipt(
  ctx: Context,
  key: string,
  agentName: string,
  generation: string,
  line: string | null,
): void {
  const dir = receiptDir(ctx, key, agentName);
  const path = join(dir, generation);
  const temp = join(dir, `.${generation}.${process.pid}.tmp`);
  try {
    if (line === null) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${line}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch (cleanup) {
      swallow(cleanup, "the receipt's temporary file could not be removed");
    }
    throw new HerdrError(
      `could not write the kickoff receipt ${path} (${(error as Error).message})`,
    );
  }
}

/** Refuse, before anything is claimed, a kickoff that cannot be answered for. */
function assertKickoffable(
  ctx: Context,
  spawned: Spawned,
  prompt: string,
): void {
  const { agentName } = spawned;
  if (promptToken(prompt) === "")
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
}

/**
 * The session to send to, read again under the claim, which may have taken
 * minutes to get; null as the answer when the agent already has the
 * kickoff. An agent restarted since it started is not answered for.
 */
function sessionToSend(
  ctx: Context,
  spawned: Spawned,
  options: KickoffOptions,
): { sessionId: string | null } | null {
  const { agentName } = spawned;
  let sessionId: string | null;
  // A resumed conversation may already hold the kickoff, like a running agent.
  if (spawned.agentExisted || spawned.agentResumed) {
    const reconciled = reconcileKickoff(
      ctx,
      agentName,
      options.key,
      options.prompt,
    );
    if (reconciled.verdict === "delivered") return null;
    sessionId = reconciled.sessionId;
    ctx.log(`⚠ ${agentName} has no record of the kickoff; sending it`);
  } else sessionId = readSession(ctx, agentName);
  if (sessionId !== spawned.agentSessionId)
    throw new HerdrError(
      `the session of ${agentName} changed from ${spawned.agentSessionId ?? "none"} to ${sessionId ?? "none"} since it started; it was restarted, so the kickoff cannot be answered for. Run this again`,
    );
  return { sessionId };
}

/**
 * Send the prompt under a pending receipt `sent` in this launch's own file,
 * and complete it once Herdr accepts it. Throws `UnknownDelivery`, with the
 * pending receipt kept, when whether Herdr took it is unknown, and a plain
 * error when it refused, with this launch's file removed so the earlier
 * receipt stands again.
 */
function sendUnderReceipt(
  ctx: Context,
  agentName: string,
  options: KickoffOptions,
  generation: string,
  sent: string,
): void {
  // A send cut short by the run's limit would leave its outcome unknown;
  // refuse it before anything is recorded instead.
  if (budget(ctx, PROMPT_TIMEOUT_MS) < PROMPT_TIMEOUT_MS)
    throw new HerdrError(
      `too little of the run's time limit is left to send the kickoff to ${agentName}; run this again`,
    );
  const dir = receiptDir(ctx, options.key, agentName);
  const later = receiptGenerations(dir).at(-1);
  if (later !== undefined && later > Number(generation))
    throw new HerdrError(
      `a launch with a later kickoff claim on ${options.key} (${later}) has a receipt for ${agentName}; this launch was superseded, so check with herdr agent read ${agentName} --source recent before running this again`,
    );
  setReceipt(ctx, options.key, agentName, generation, `${PENDING} ${sent}`);
  // Without `--wait` Herdr acknowledges the writes, which is what a
  // kickoff needs; the process deadline bounds the call.
  const answer = ctx.run(
    ["herdr", "agent", "prompt", agentName, options.prompt],
    { timeoutMs: PROMPT_TIMEOUT_MS },
  );
  const error = parseError(answer);
  if (answer.status === 2 || (error !== null && REFUSED.has(error.code))) {
    // Herdr refused before writing anything: removing this launch's own
    // file lets the earlier record stand. It touches no other launch's
    // file, so a launch that took over meanwhile keeps its record.
    setReceipt(ctx, options.key, agentName, generation, null);
    throw new HerdrError(
      `${agentName} did not take the kickoff (${error?.message ?? output(answer)}); run this again once it is ready`,
    );
  }
  if (error !== null || answer.status !== 0)
    throw new UnknownDelivery(
      `could not tell whether ${agentName} received the kickoff (${error === null ? `exit ${answer.status}: ${output(answer)}` : `${error.code}: ${error.message}`}); check with herdr agent read ${agentName} --source recent before running this again`,
    );
  try {
    setReceipt(ctx, options.key, agentName, generation, sent);
  } catch (failure) {
    ctx.log(
      `⚠ the kickoff was sent but its receipt stays pending (${(failure as Error).message}); a later launch confirms it from the transcript or refuses`,
    );
    return;
  }
  pruneReceipts(dir, Number(generation));
}

/**
 * Remove the files of launches before `generation`, which its completed
 * receipt supersedes. A superseded launch that writes afterwards writes
 * below it, so a file left or rewritten here is never read.
 */
function pruneReceipts(dir: string, generation: number): void {
  for (const old of receiptGenerations(dir))
    if (old < generation)
      try {
        rmSync(join(dir, String(old)), { force: true });
      } catch (error) {
        swallow(error, "a superseded kickoff receipt could not be removed");
      }
}

/** Herdr may or may not have taken the prompt. */
class UnknownDelivery extends HerdrError {}

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
  assertKickoffable(ctx, spawned, options.prompt);
  const generation = acquireClaim(ctx, options.key, options.claimWaitMs);
  let release = true;
  try {
    const target = sessionToSend(ctx, spawned, options);
    if (target === null) {
      ctx.log(`↺ ${agentName} already has the kickoff; not sending it again`);
      return "already-delivered";
    }
    // Ownership is checked before any record is touched. The claim is not
    // taken over while this process runs; one removed by hand after this
    // check leaves this launch writing only its own receipt file, below the
    // one of the launch that took it.
    assertClaimHeld(ctx, options.key, generation);
    sendUnderReceipt(
      ctx,
      agentName,
      options,
      generation,
      correlation(options.key, agentName, target.sessionId),
    );
    ctx.log(`✓ kickoff sent to ${agentName}`);
    return "sent";
  } catch (error) {
    // The pending receipt stops a later launch from sending it again without
    // confirming it from the transcript, once this launch has ended and its
    // claim can be taken over.
    if (error instanceof UnknownDelivery) release = false;
    throw error;
  } finally {
    if (release) releaseClaim(ctx, options.key, generation);
  }
}
