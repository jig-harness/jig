/**
 * Kickoff receipts: the record that a key's agent was started in a worktree,
 * kept on the machine the tool runs on, outside every worktree. A receipt is
 * taken as pending by exactly one open at a time, completed once Orca
 * answered, and set aside, by exactly one open, once its worktree is gone,
 * so an agent is started once per key and agent and a start whose outcome
 * is unknown is never repeated without a person looking first. Every change
 * to the file is made under something only one open can do (a hard link into
 * a name that must not exist); what an open read before that is a hint, and
 * the file is read again under it. What an open learns about a receipt's
 * worktree is acted on where it is learned, never carried to a later step:
 * an open that finds the branch in no worktree sets the receipt aside
 * before it creates one (`retireBeforeCreate`), so no step after the
 * creation, this process ending included, can leave it for the next open to
 * read as the new worktree's own.
 */
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../../lib/record.ts";
import { errnoCode } from "../../plugin/shared/errors.ts";
import { CLAIM_WAIT_MS } from "../herdr/kickoff.ts";
import { localOwner, ownerAlive } from "../herdr/owner.ts";
import { budget } from "../herdr/runner.ts";
import { OrcaError, WAIT_POLL_MS, type Workspace } from "./runner.ts";

export interface Receipt {
  key: string;
  status: "pending" | "sent";
  /** The repository in Orca whose worktree the agent runs in. */
  repoId: string;
  worktreeId: string;
  agent: string;
  /** The paired server, or null for Orca on this machine. */
  environment: string | null;
  at: string;
  /**
   * While pending: the process starting the agent, as `<host> <pid> <start>`,
   * so a later open can tell a start still in progress from one cut short.
   */
  owner?: string;
  /** Orca's answer to the launch, once it answered. */
  launch?: unknown;
}

/**
 * A name as one path segment: anything but letters, digits, `_` and `-` is
 * percent-encoded, `.` included, so a name Orca or a caller chose neither
 * escapes its directory nor collides with another's, and a `.` in a file
 * name is only ever the one between its segments: `ENG-1.a` with agent `b`
 * and `ENG-1` with agent `a.b` are two files, not one (`receiptPath`).
 */
export function fileSegment(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*~.]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The directory of the receipts for a repository's worktrees in one Orca: this machine's, or a server's. */
function receiptDir(ws: Workspace, repoId: string): string {
  return join(
    ws.orca.stateDir,
    "kickoff",
    ...(ws.target.environment === undefined
      ? ["local"]
      : ["server", fileSegment(ws.target.environment)]),
    fileSegment(repoId),
  );
}

/**
 * Where the start of `key`'s agent is recorded: per Orca, repository and
 * agent, outside every worktree, so the same key in two repositories, or
 * two agents on one key, are two starts. The key and the agent are each one
 * segment with no `.` of its own (`fileSegment`), so the name reads back as
 * exactly one pair.
 */
export function receiptPath(
  ws: Workspace,
  repoId: string,
  key: string,
  agent: string,
): string {
  return join(
    receiptDir(ws, repoId),
    `${fileSegment(key)}.${fileSegment(agent)}.json`,
  );
}

const isText = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

/** What each field of a receipt must hold for the file to be one this tool wrote. */
const RECEIPT_FIELDS: Record<string, (value: unknown) => boolean> = {
  key: isText,
  status: (value) => value === "pending" || value === "sent",
  repoId: isText,
  worktreeId: isText,
  agent: isText,
  environment: (value) => value === null || isText(value),
  at: isText,
  owner: (value) => value === undefined || typeof value === "string",
};

function isReceipt(value: unknown): value is Receipt {
  return (
    isRecord(value) &&
    Object.entries(RECEIPT_FIELDS).every(([field, holds]) =>
      holds(value[field]),
    )
  );
}

/**
 * The receipt in `file`, or null when there is none. A file that is not a
 * whole receipt this tool writes is refused rather than read as any
 * outcome: damaged evidence of a start is not evidence of none.
 */
export function readReceipt(file: string): Receipt | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isReceipt(parsed))
    throw new OrcaError(
      `${file} is not a kickoff receipt this tool wrote; move it away and open the workspace again`,
    );
  return parsed;
}

/**
 * Create the receipt, whole, for exactly one open: the content is written
 * under a temporary name and linked into place, which fails when the file
 * exists. False when it does.
 */
function createReceipt(file: string, receipt: Receipt): boolean {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  try {
    linkSync(temporary, file);
    return true;
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Write the receipt whole in place of what is at `file`: the start this open
 * holds as pending, completed, or a pending start over a stale record this
 * open alone set aside (`replaceStale`).
 */
export function writeReceipt(file: string, receipt: Receipt): void {
  const temporary = `${file}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** Set the receipt of a removed worktree aside under a dated name, keeping the record; a receipt already gone is fine. */
function retireReceipt(file: string): void {
  try {
    renameSync(file, `${file}.retired-${Date.now()}`);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

/** The start a receipt records, as a path is chosen for it: the key, the repository, the agent and the Orca. */
export type Launch = Pick<Receipt, "key" | "repoId" | "agent" | "environment">;

/** Refuse a receipt at this launch's path that records another launch: nothing this tool wrote lands there. */
function assertReceiptFor(file: string, found: Receipt, wanted: Launch): void {
  if (
    found.key !== wanted.key ||
    found.repoId !== wanted.repoId ||
    found.agent !== wanted.agent ||
    found.environment !== wanted.environment
  )
    throw new OrcaError(
      `${file} records the start of ${found.key}'s ${found.agent} in repository ${found.repoId}${found.environment === null ? "" : ` on ${found.environment}`}, not this open's; move it away and open the workspace again`,
    );
}

/**
 * Whether a sent receipt is the record of this worktree's own agent, so the
 * start stands. One naming another worktree records an agent in a checkout
 * that no longer holds the branch. One naming a worktree that stood at this
 * path before, which Orca gives the same path-derived id, never reaches
 * this question: the open that created the worktree set it aside first
 * (`retireBeforeCreate`), so a receipt naming this worktree's id was written
 * for this worktree.
 */
function standsFor(earlier: Receipt, receipt: Receipt): boolean {
  return earlier.worktreeId === receipt.worktreeId;
}

/** Where a stale receipt is set aside: beside it, under the start it records. */
function retiredName(file: string, earlier: Receipt): string {
  return `${file}.retired-${fileSegment(earlier.at)}`;
}

/**
 * Set the stale receipt aside and take its place with this open's pending
 * receipt, for exactly one open: the stale receipt is linked under its
 * retired name, which succeeds for the first open to do it, and the pending
 * receipt then replaces it in place, so the file is never absent and no other
 * open creates one in between. False when another open set it aside first,
 * or it is gone.
 */
function replaceStale(
  ws: Workspace,
  file: string,
  earlier: Receipt,
  receipt: Receipt,
): boolean {
  if (!setAside(file, earlier)) return false;
  writeReceipt(file, receipt);
  ws.orca.log(
    `↺ ${receipt.key}'s agent was started in ${earlier.worktreeId} on ${earlier.at}, a worktree that is gone; starting one in ${receipt.worktreeId}`,
  );
  return true;
}

/**
 * Link the stale receipt under its retired name, which succeeds for the first
 * open to do it and fails for every other: the one thing that makes setting a
 * receipt aside the act of exactly one open. False when another open did it
 * first, or the receipt is gone.
 */
function setAside(file: string, earlier: Receipt): boolean {
  try {
    linkSync(file, retiredName(file, earlier));
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "EEXIST" || code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Set aside the sent receipt at `file` before this open creates the
 * worktree, when no worktree holds the branch: the start it records was in
 * a worktree that is gone, or that no longer holds the branch, and the one
 * created next, which Orca may give the same path-derived id, must not read
 * it as its own. It is set aside now, and not once the worktree exists, so
 * that nothing a creation runs afterwards (a check, the create hook, this
 * process ending) can leave it in place for a reattaching open to accept:
 * what this open knows about the receipt's worktree does not have to
 * survive the creation. The record is kept under the retired name
 * (`setAside`, so exactly one open does it; one another open set aside, or
 * that is gone, is fine), and the file removed, so the open that reaches the
 * agent's start first, this one or one that reattached meanwhile, takes a
 * fresh receipt. A pending receipt is left for `claimReceipt` to judge, and
 * a receipt of another launch is refused as it is there.
 */
export function retireBeforeCreate(
  ws: Workspace,
  file: string,
  launch: Launch,
): void {
  const earlier = readReceipt(file);
  if (earlier === null) return;
  assertReceiptFor(file, earlier, launch);
  if (earlier.status === "pending" || !setAside(file, earlier)) return;
  rmSync(file, { force: true });
  ws.orca.log(
    `↺ ${earlier.key}'s agent was started in ${earlier.worktreeId} on ${earlier.at}, a worktree that no longer holds the branch; the record is set aside, and the agent is started in the worktree created next`,
  );
}

/**
 * Wait one poll for the open that set the stale receipt aside to replace it,
 * while the deadline has not passed. A stale receipt still in place past it
 * was set aside by an open that did not finish: the message names the copy
 * to remove. Returns true, for the caller's record that it waited.
 */
function awaitReplacement(
  ws: Workspace,
  file: string,
  earlier: Receipt,
  deadline: number,
  waited: boolean,
): true {
  const retired = retiredName(file, earlier);
  if (Date.now() >= deadline)
    throw new OrcaError(
      `another open set aside the record of ${earlier.key}'s agent (${retired}) and did not replace ${file} within ${Math.round(CLAIM_WAIT_MS / 1000)}s; if no open is running, remove ${retired} and open the workspace again`,
    );
  if (!waited)
    ws.orca.log(
      `… waiting for another open that is setting aside the record of ${earlier.key}'s agent`,
    );
  ws.orca.sleep(WAIT_POLL_MS);
  return true;
}

/**
 * Wait one poll for the open whose pending receipt this is, while it still
 * runs on this machine and the deadline has not passed. A pending receipt
 * whose open has ended, or that cannot be told, stops this open: a person
 * looks first. Returns true, for the caller's record that it waited.
 */
function awaitStart(
  ws: Workspace,
  file: string,
  earlier: Receipt,
  deadline: number,
  waited: boolean,
): true {
  const key = earlier.key;
  const holder = earlier.owner === undefined ? null : localOwner(earlier.owner);
  if (holder === null || !ownerAlive(ws.orca, holder))
    throw new OrcaError(
      `an earlier open's start of ${key}'s agent has no outcome recorded (${file}): check the worktree in Orca, then delete the file if the agent never started`,
    );
  if (Date.now() >= deadline)
    throw new OrcaError(
      `another open (process ${holder.pid}) is starting ${key}'s agent and did not finish within ${Math.round(CLAIM_WAIT_MS / 1000)}s; let it finish and open the workspace again`,
    );
  if (!waited)
    ws.orca.log(
      `… waiting for another open (process ${holder.pid}) that is starting ${key}'s agent`,
    );
  ws.orca.sleep(WAIT_POLL_MS);
  return true;
}

/**
 * Take the key's receipt for this open, written as pending, which succeeds
 * for exactly one open at a time: two opens that both find no receipt cannot
 * both start the agent, and two that both find a stale one cannot both
 * replace it (`replaceStale`). False when an earlier start stands
 * (`standsFor`). A pending receipt whose open still runs on this machine is
 * waited for, up to `CLAIM_WAIT_MS` (`awaitStart`), and so is another open's
 * replacement of a stale receipt (`awaitReplacement`).
 */
export function claimReceipt(
  ws: Workspace,
  file: string,
  receipt: Receipt,
): boolean {
  const deadline = Date.now() + budget(ws.orca, CLAIM_WAIT_MS);
  let waitedStart = false;
  let waitedReplacement = false;
  for (;;) {
    if (createReceipt(file, receipt)) return true;
    const earlier = readReceipt(file);
    if (earlier === null) continue;
    assertReceiptFor(file, earlier, receipt);
    if (earlier.status === "pending") {
      waitedStart = awaitStart(ws, file, earlier, deadline, waitedStart);
      continue;
    }
    if (standsFor(earlier, receipt)) {
      ws.orca.log(
        `↺ ${receipt.key}'s agent was started in ${earlier.worktreeId} on ${earlier.at}; not starting it again (delete ${file} to start it again)`,
      );
      return false;
    }
    if (replaceStale(ws, file, earlier, receipt)) return true;
    waitedReplacement = awaitReplacement(
      ws,
      file,
      earlier,
      deadline,
      waitedReplacement,
    );
  }
}

/**
 * Set aside the receipts of agents started in a worktree that is gone, so
 * the next open of their keys starts an agent in the worktree that replaces
 * it. A file in the directory that is not a receipt is left alone.
 */
export function retireReceiptsOf(
  ws: Workspace,
  repoId: string,
  worktreeId: string,
): void {
  const dir = receiptDir(ws, repoId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let receipt: Receipt | null;
    try {
      receipt = readReceipt(file);
    } catch (error) {
      ws.orca.log(
        `⚠ ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (receipt === null || receipt.worktreeId !== worktreeId) continue;
    retireReceipt(file);
    ws.orca.log(
      `✓ set aside the record that ${receipt.key}'s ${receipt.agent} was started in ${worktreeId}; the next open of ${receipt.key} starts it again`,
    );
  }
}

/** Remove the receipt this open holds: Orca answered that nothing was started. */
export function clearReceipt(file: string): void {
  rmSync(file, { force: true });
}
