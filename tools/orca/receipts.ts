/**
 * Kickoff receipts: the record that a key's agent was started in a worktree,
 * kept on the machine the tool runs on, outside every worktree. A receipt is
 * taken as pending by exactly one open at a time, completed once Orca
 * answered, and set aside once its worktree is gone, so an agent is started
 * once per key and agent and a start whose outcome is unknown is never
 * repeated without a person looking first.
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
 * A name as one path segment: anything but letters, digits, `.`, `_` and
 * `-` is percent-encoded, so a name Orca or a caller chose neither escapes
 * its directory nor collides with another's.
 */
export function fileSegment(text: string): string {
  const encoded = encodeURIComponent(text).replace(
    /[!'()*~]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return /^\.{1,2}$/.test(encoded) ? encoded.replaceAll(".", "%2E") : encoded;
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
 * two agents on one key, are two starts.
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
function readReceipt(file: string): Receipt | null {
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

/** Replace the receipt this open holds, whole, with the start recorded. */
export function completeReceipt(file: string, receipt: Receipt): void {
  const temporary = `${file}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** Set a receipt aside under a dated name, keeping the record; a receipt already gone is fine. */
function retireReceipt(file: string): void {
  try {
    renameSync(file, `${file}.retired-${Date.now()}`);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

/** Refuse a receipt at this launch's path that records another launch: nothing this tool wrote lands there. */
function assertReceiptFor(file: string, found: Receipt, wanted: Receipt): void {
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
 * start stands. One for a worktree this open did not just create, or for
 * another worktree, records an agent in a checkout that no longer holds the
 * branch: it is set aside, and the start is recorded anew.
 */
function standsFor(
  ws: Workspace,
  file: string,
  earlier: Receipt,
  receipt: Receipt,
  created: boolean,
): boolean {
  const key = receipt.key;
  if (!created && earlier.worktreeId === receipt.worktreeId) {
    ws.orca.log(
      `↺ ${key}'s agent was started in ${earlier.worktreeId} on ${earlier.at}; not starting it again (delete ${file} to start it again)`,
    );
    return true;
  }
  ws.orca.log(
    `↺ ${key}'s agent was started in ${earlier.worktreeId} on ${earlier.at}, a worktree that is gone${created ? " (this open created its replacement)" : ""}; starting one in ${receipt.worktreeId}`,
  );
  retireReceipt(file);
  return false;
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
 * both start the agent. False when an earlier start stands (`standsFor`). A
 * pending receipt whose open still runs on this machine is waited for, up to
 * `CLAIM_WAIT_MS` (`awaitStart`).
 */
export function claimReceipt(
  ws: Workspace,
  file: string,
  receipt: Receipt,
  created: boolean,
): boolean {
  const deadline = Date.now() + budget(ws.orca, CLAIM_WAIT_MS);
  let waited = false;
  for (;;) {
    if (createReceipt(file, receipt)) return true;
    const earlier = readReceipt(file);
    if (earlier === null) continue;
    assertReceiptFor(file, earlier, receipt);
    if (earlier.status === "pending")
      waited = awaitStart(ws, file, earlier, deadline, waited);
    else if (standsFor(ws, file, earlier, receipt, created)) return false;
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
