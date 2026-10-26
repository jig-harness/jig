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
import { errnoCode, swallow } from "../../plugin/shared/errors.ts";
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
  const text = readText(file);
  if (text === null) return null;
  const parsed = parseRecord(text);
  if (!isReceipt(parsed))
    throw new OrcaError(
      `${file} is not a kickoff receipt this tool wrote; move it away and open the workspace again`,
    );
  return parsed;
}

/** The text of `file`, or null when there is no file. */
function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** The JSON in `text`, or undefined when it is not JSON: no receipt this tool wrote. */
function parseRecord(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    swallow(
      error,
      "a kickoff receipt that is not JSON: not one this tool wrote",
    );
    return undefined;
  }
}

/**
 * Whether `file` holds `earlier`, as it was read: the same fields with the
 * same values in the same order, `launch` included. Anything else there, a
 * file that is not JSON or none, is a change, which costs the open that
 * asked no more than reading the file again.
 */
function holdsReceipt(file: string, earlier: Receipt): boolean {
  const text = readText(file);
  return (
    text !== null &&
    JSON.stringify(parseRecord(text)) === JSON.stringify(earlier)
  );
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
 * How replacing a stale receipt ended: this open replaced it; another open
 * set it aside first, and replaces it; or the file is no longer the receipt
 * that was read, so it is read again.
 */
type Replacement = "replaced" | "taken" | "changed";

/**
 * Set the stale receipt, completed or left pending by an open that has
 * ended, aside and take its place with this open's pending receipt, for
 * exactly one open: the stale receipt is linked under its retired name,
 * which succeeds for the first open to do it, and read again there
 * (`setAside`), and the pending receipt then replaces it in place, so the
 * file is never absent and no other open creates one in between.
 */
export function replaceStale(
  ws: Workspace,
  file: string,
  earlier: Receipt,
  receipt: Receipt,
): Replacement {
  const aside = setAside(file, earlier);
  if (aside !== "set-aside") return aside;
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
  return "replaced";
}

/**
 * Link the receipt at `file` under `earlier`'s retired name, which succeeds
 * for the first open to do it and fails for every other (`taken`): the one
 * thing that makes setting a receipt aside the act of exactly one open. The
 * receipt read before the link is a hint, and the link names whatever is at
 * `file` when it is made: the receipt read may have been cleared since, and
 * another created there. So the linked copy, the file as it was at the
 * link, which no open changes afterwards (a receipt is replaced by renaming
 * over its name, never written in place), is read again under the name, and
 * must be `earlier`: the name is `earlier`'s alone, and a receipt of another
 * start set aside under it is set aside again by the first open to read it.
 * When it is not, the link is removed and `changed` says to read the file
 * again; so does a receipt that is gone.
 */
function setAside(
  file: string,
  earlier: Receipt,
): "set-aside" | Exclude<Replacement, "replaced"> {
  const retired = retiredName(file, earlier);
  try {
    linkSync(file, retired);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "EEXIST") return "taken";
    if (code === "ENOENT") return "changed";
    throw error;
  }
  if (holdsReceipt(retired, earlier)) return "set-aside";
  rmSync(retired, { force: true });
  return "changed";
}

/** The waits an open has announced in the log, each said once. */
interface Waits {
  start: boolean;
  replacement: boolean;
}

/**
 * Take the stale receipt's place with this open's pending receipt
 * (`replaceStale`), or wait one poll for the open that set it aside first to
 * do so. True when this open holds the pending receipt; false to read the
 * file again, another open replacing the receipt or the file no longer
 * holding the one that was read.
 */
function replaceOrAwait(
  ws: Workspace,
  file: string,
  earlier: Receipt,
  receipt: Receipt,
  deadline: number,
  waits: Waits,
): boolean {
  const replaced = replaceStale(ws, file, earlier, receipt);
  if (replaced === "taken")
    awaitReplacement(ws, file, earlier, deadline, waits);
  return replaced === "replaced";
}

/**
 * Wait one poll for the open that set the stale receipt aside to replace it,
 * while the deadline has not passed. A stale receipt still in place past it
 * was set aside by an open that did not finish: the message names the copy
 * to remove.
 */
function awaitReplacement(
  ws: Workspace,
  file: string,
  earlier: Receipt,
  deadline: number,
  waits: Waits,
): void {
  const retired = retiredName(file, earlier);
  if (Date.now() >= deadline)
    throw new OrcaError(
      `another open set aside the record of ${earlier.key}'s agent (${retired}) and did not replace ${file} within ${Math.round(CLAIM_WAIT_MS / 1000)}s; if no open is running, remove ${retired} and open the workspace again`,
    );
  if (!waits.replacement)
    ws.orca.log(
      `… waiting for another open that is setting aside the record of ${earlier.key}'s agent`,
    );
  waits.replacement = true;
  ws.orca.sleep(WAIT_POLL_MS);
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
 * the deadline has not passed.
 */
function awaitStart(
  ws: Workspace,
  holder: Owner,
  earlier: Receipt,
  deadline: number,
  waits: Waits,
): void {
  const key = earlier.key;
  if (Date.now() >= deadline)
    throw new OrcaError(
      `another open (process ${holder.pid}) is starting ${key}'s agent and did not finish within ${Math.round(CLAIM_WAIT_MS / 1000)}s; let it finish and open the workspace again`,
    );
  if (!waits.start)
    ws.orca.log(
      `… waiting for another open (process ${holder.pid}) that is starting ${key}'s agent`,
    );
  waits.start = true;
  ws.orca.sleep(WAIT_POLL_MS);
}

/**
 * Take the key's receipt for this open, written as pending, which succeeds
 * for exactly one open at a time: two opens that both find no receipt cannot
 * both start the agent, two that both find a stale one cannot both replace
 * it, and one that read a receipt since cleared, and created anew, replaces
 * nothing before reading the file again (`replaceOrAwait`). False when an
 * earlier start stands (`standsFor`). A pending receipt whose open still
 * runs on this machine is waited for, up to `CLAIM_WAIT_MS` (`awaitStart`),
 * and so is another open's replacement of a stale receipt
 * (`awaitReplacement`). A pending receipt whose open has ended is judged by
 * its token like a completed one (`runningStarter`): stale when it names
 * another worktree, a person's to look at when it names this one.
 */
export function claimReceipt(
  ws: Workspace,
  file: string,
  receipt: Receipt,
): boolean {
  const deadline = Date.now() + budget(ws.orca, CLAIM_WAIT_MS);
  const waits: Waits = { start: false, replacement: false };
  for (;;) {
    if (createReceipt(file, receipt)) return true;
    const earlier = readReceipt(file);
    if (earlier === null) continue;
    assertReceiptFor(file, earlier, receipt);
    if (earlier.status === "sent" && standsFor(earlier, receipt)) {
      ws.orca.log(
        `↺ ${receipt.key}'s agent was started in ${earlier.worktreeId} on ${earlier.at}; not starting it again (delete ${file} to start it again)`,
      );
      return false;
    }
    const starter =
      earlier.status === "pending"
        ? runningStarter(ws, file, earlier, receipt)
        : null;
    if (starter !== null) awaitStart(ws, starter, earlier, deadline, waits);
    else if (replaceOrAwait(ws, file, earlier, receipt, deadline, waits))
      return true;
  }
}

/** Remove the receipt this open holds: Orca answered that nothing was started. */
export function clearReceipt(file: string): void {
  rmSync(file, { force: true });
}
