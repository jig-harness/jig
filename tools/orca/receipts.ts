/**
 * Kickoff receipts: the record that a key's agent was started in a worktree,
 * kept on the machine the tool runs on, outside every worktree. A receipt is
 * taken as pending by exactly one open at a time, completed once Orca
 * answered, and set aside, by exactly one open, once the worktree it names
 * is not the one the branch is in, so an agent is started once per key and
 * agent, and a start whose outcome is unknown is never repeated in the
 * worktree it was made in without a person looking first; one made in a
 * worktree that is gone, or no longer holds the branch, by an open that has
 * since ended is set aside like a completed receipt of such a worktree.
 * Every change to the file is made under something
 * only one open can do (a hard link into a name that must not exist); what
 * an open read before that is a hint, and the file is read again under it.
 * Which worktree a receipt stands for is read from the worktree itself: the
 * receipt carries the token the worktree's git directory holds
 * (worktree-token.ts), and a worktree created later at the same path, which
 * Orca gives the same id, has none or another, so no receipt of an earlier
 * one is read as its own, for any key or agent, and nothing has to be set
 * aside before a worktree is created or after one is removed, or carried
 * from one step to the next.
 */
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../../lib/record.ts";
import { errnoCode } from "../../plugin/shared/errors.ts";
import { CLAIM_WAIT_MS } from "../herdr/kickoff.ts";
import { localOwner, type Owner, ownerAlive } from "../herdr/owner.ts";
import { budget } from "../herdr/runner.ts";
import { OrcaError, WAIT_POLL_MS, type Workspace } from "./runner.ts";

export interface Receipt {
  key: string;
  status: "pending" | "sent";
  /** The repository in Orca whose worktree the agent runs in. */
  repoId: string;
  /** What Orca calls the worktree, kept for the record and the log. */
  worktreeId: string;
  /**
   * The token the worktree's git directory held when the agent was started
   * (worktree-token.ts): what tells the worktree from one that stood at its
   * path before, or stands there after it.
   */
  worktreeToken: string;
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
  worktreeToken: isText,
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
 * start stands: it carries this worktree's token, read from its git
 * directory. One carrying another token records an agent in a worktree that
 * no longer holds the branch, or in one that stood at this path before and
 * is gone, which Orca gives the same path-derived id; the id is not what
 * tells them apart, so it is not compared.
 */
function standsFor(earlier: Receipt, receipt: Receipt): boolean {
  return earlier.worktreeToken === receipt.worktreeToken;
}

/** Where a stale receipt is set aside: beside it, under the start it records. */
function retiredName(file: string, earlier: Receipt): string {
  return `${file}.retired-${fileSegment(earlier.at)}`;
}

/**
 * Set the stale receipt, completed or left pending by an open that has
 * ended, aside and take its place with this open's pending receipt, for
 * exactly one open: the stale receipt is linked under its
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
  const where =
    earlier.worktreeId === receipt.worktreeId
      ? `a worktree that stood at ${receipt.worktreeId} before this one`
      : `${earlier.worktreeId}, a worktree that no longer holds the branch`;
  const start =
    earlier.status === "sent"
      ? `${receipt.key}'s agent was started on ${earlier.at} in ${where}`
      : `an open that has since ended was starting ${receipt.key}'s agent on ${earlier.at} in ${where}, with no outcome recorded`;
  ws.orca.log(`↺ ${start}; starting one in ${receipt.worktreeId}`);
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

/** A start whose outcome was never learned, and that a person must look at first. */
function noOutcome(file: string, earlier: Receipt): OrcaError {
  return new OrcaError(
    `an earlier open's start of ${earlier.key}'s agent has no outcome recorded (${file}): check the worktree in Orca, then delete the file if the agent never started`,
  );
}

/**
 * The open still starting the agent a pending receipt records, while it
 * runs on this machine, for the caller to wait for. Null once that open has
 * ended and the receipt carries another worktree's token (`standsFor`): the
 * worktree the agent was being started in is gone, or no longer holds the
 * branch, so the receipt is stale, like a completed one of such a worktree.
 * An open that ended in this worktree, or one that cannot be told (another
 * host's, or none recorded), stops this open: the agent may have started
 * here, and a person looks first.
 */
function runningStarter(
  ws: Workspace,
  file: string,
  earlier: Receipt,
  receipt: Receipt,
): Owner | null {
  const holder = earlier.owner === undefined ? null : localOwner(earlier.owner);
  if (holder !== null && ownerAlive(ws.orca, holder)) return holder;
  if (holder === null || standsFor(earlier, receipt))
    throw noOutcome(file, earlier);
  return null;
}

/**
 * Wait one poll for `holder`, the open whose pending receipt this is, while
 * the deadline has not passed. Returns true, for the caller's record that
 * it waited.
 */
function awaitStart(
  ws: Workspace,
  holder: Owner,
  earlier: Receipt,
  deadline: number,
  waited: boolean,
): true {
  const key = earlier.key;
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
 * replacement of a stale receipt (`awaitReplacement`). A pending receipt
 * whose open has ended is judged by its token like a completed one
 * (`runningStarter`): stale when it names another worktree, a person's to
 * look at when it names this one.
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
    const starter =
      earlier.status === "pending"
        ? runningStarter(ws, file, earlier, receipt)
        : null;
    if (starter !== null) {
      waitedStart = awaitStart(ws, starter, earlier, deadline, waitedStart);
      continue;
    }
    if (earlier.status === "sent" && standsFor(earlier, receipt)) {
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

/** Remove the receipt this open holds: Orca answered that nothing was started. */
export function clearReceipt(file: string): void {
  rmSync(file, { force: true });
}
