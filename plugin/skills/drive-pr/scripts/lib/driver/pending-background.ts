/**
 * A pass that ended its turn with a background task still running.
 *
 * A headless pass has no next turn, so a task it started in the background
 * (the gates, most often) reports to nobody: the pass exits `0` with its
 * promised fixes unshipped, and the drive used to stop over them
 * (`WORKTREE_UNCLEAN`, exit `12`) although the pass only needed to wait. The
 * driver gives every review pass a token in its environment
 * (`PASS_TOKEN_VARIABLE`), which every process the pass starts inherits, a
 * shell that left the pass's process group or session included. When the pass
 * exits `0`, a live process still carrying the token, or still in the pass's
 * process group, is such a task. The driver stops it, witnessed, and restarts
 * the pass in the same tree, telling it what happened, within the restarts the
 * drive already has for a pass killed at its deadline
 * (`drive.pass_deadline_retries`, one count for both causes).
 *
 * The token is read from `/proc/<pid>/environ`, so the environment scan is
 * Linux's; another POSIX host finds only the pass's own process group, and a
 * Windows host finds nothing and drives on as before.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { swallow } from "../../../../../shared/errors.ts";
import { processTable } from "../../../../../shared/process-table.ts";
import { KILL_ESCALATE_MS, parseProcStat, procRoot } from "./../proc.ts";
import type { DriveRoundContext } from "./round-context.ts";
import {
  admitPassRestart,
  describeLeftovers,
  inheritedHeadOf,
  type PassLeftovers,
  passLeftovers,
} from "./restart.ts";
import { WORKTREE_UNCLEAN_EXIT } from "./settings.ts";
import { measureStop } from "./stop-measure.ts";
import { driverRuntime } from "./runtime.ts";

/** The variable that carries a review pass's token to everything it starts. */
export const PASS_TOKEN_VARIABLE = "DRIVE_PR_PASS_TOKEN";

/** A fresh token for one review pass. */
export function newPassToken(): string {
  return randomUUID();
}

/** A process a pass left running. */
export interface PendingTask {
  pid: number;
  /** Its command line, shortened; `''` when it could not be read. */
  command: string;
}

/** How much of a task's command line the driver prints. */
const COMMAND_CHARS = 160;

/** A process's command line from `/proc`, shortened; `''` when unreadable. */
function procCommand(dir: string): string {
  try {
    const text = readFileSync(`${dir}/cmdline`, "utf8")
      .split("\0")
      .filter((part) => part !== "")
      .join(" ");
    return text.length > COMMAND_CHARS
      ? `${text.slice(0, COMMAND_CHARS - 1)}…`
      : text;
  } catch (err) {
    swallow(err, "a pending task's command line could not be read");
    return "";
  }
}

/** A file under `/proc/<pid>/`; `null` when it cannot be read. */
function procFile(dir: string, file: string): string | null {
  try {
    return readFileSync(`${dir}/${file}`, "utf8");
  } catch (err) {
    // The process ended since the listing, or belongs to another user, whose
    // processes cannot have inherited this user's pass.
    swallow(err, `/proc entry ${dir}/${file} could not be read`);
    return null;
  }
}

/**
 * Whether the live process at `dir` carries `entry` in its environment or
 * is in process group `pgid`; a zombie or an unreadable process does not.
 */
function carries(dir: string, entry: string | null, pgid?: number): boolean {
  const text = procFile(dir, "stat");
  const stat = text === null ? null : parseProcStat(text);
  if (stat === null || stat.state === "Z") return false;
  if (pgid !== undefined && stat.pgrp === pgid) return true;
  if (entry === null) return false;
  return (procFile(dir, "environ") ?? "").split("\0").includes(entry);
}

/**
 * The live processes carrying `token` in their environment or in process
 * group `pgid`, read from `/proc`; `null` when `/proc` cannot be listed.
 */
export function pendingTasksLinux(
  token: string,
  pgid: number | undefined,
): PendingTask[] | null {
  let entries: string[];
  try {
    entries = readdirSync(procRoot());
  } catch (err) {
    swallow(err, "the process list could not be read from /proc");
    return null;
  }
  const entry = token === "" ? null : `${PASS_TOKEN_VARIABLE}=${token}`;
  const tasks: PendingTask[] = [];
  for (const name of entries) {
    const pid = /^[0-9]+$/.test(name) ? Number.parseInt(name, 10) : null;
    if (pid === null || pid === process.pid) continue;
    const dir = `${procRoot()}/${name}`;
    if (carries(dir, entry, pgid))
      tasks.push({ pid, command: procCommand(dir) });
  }
  return tasks;
}

/**
 * The live processes a pass left running: by token and process group where
 * `/proc` answers, by process group alone on another POSIX host; `null` where
 * neither can be told (Windows, or a process listing that failed).
 */
export async function pendingTasks(
  token: string,
  pgid: number | undefined,
): Promise<PendingTask[] | null> {
  if (process.platform === "win32") return null;
  const viaProc = pendingTasksLinux(token, pgid);
  if (viaProc !== null) return viaProc;
  if (pgid === undefined) return null;
  const rows = await processTable();
  if (rows === null) return null;
  return rows
    .filter(
      (row) =>
        row.pgid === pgid &&
        row.pid !== process.pid &&
        !row.stat.startsWith("Z"),
    )
    .map((row) => ({
      pid: row.pid,
      command: row.args.slice(0, COMMAND_CHARS),
    }));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** How long the driver waits for the tasks to be gone after its SIGKILL. */
const KILL_WITNESS_MS = 10_000;
const POLL_MS = 100;

/**
 * Stop what the pass left running: SIGTERM, then SIGKILL after the driver's
 * usual grace, each to every process found carrying the token or in the
 * group at that moment, and to the group itself. Resolves `true` only once a
 * scan finds none left; `false` when one outlived the wait or a scan could
 * not answer, which the caller treats as still running.
 */
export async function stopPendingTasks(
  token: string,
  pgid: number | undefined,
): Promise<boolean> {
  const signal = (tasks: PendingTask[], sig: NodeJS.Signals): void => {
    if (pgid !== undefined)
      try {
        process.kill(-pgid, sig);
      } catch {
        // The group is gone, or was never one: the scan answers either way.
      }
    for (const task of tasks)
      try {
        process.kill(task.pid, sig);
      } catch {
        // Gone since the scan.
      }
  };
  for (const [sig, waitMs] of [
    ["SIGTERM", KILL_ESCALATE_MS],
    ["SIGKILL", KILL_WITNESS_MS],
  ] as const) {
    const found = await pendingTasks(token, pgid);
    if (found === null) return false;
    if (found.length === 0) return true;
    signal(found, sig);
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await sleep(POLL_MS);
      const left = await pendingTasks(token, pgid);
      if (left === null) return false;
      if (left.length === 0) return true;
    }
  }
  return (await pendingTasks(token, pgid))?.length === 0;
}

/** The tasks as lines for the driver log and the pass notice. */
export function describeTasks(tasks: PendingTask[]): string[] {
  return tasks.map(
    (task) =>
      `  pid ${task.pid}: ${task.command === "" ? "(command unreadable)" : task.command}`,
  );
}

/** The notice the pass restarted after one that left a task running reads. */
export function backgroundNotice(
  round: number,
  tasks: PendingTask[],
  leftovers: PassLeftovers,
): string {
  const inherited = inheritedHeadOf(leftovers);
  return [
    `RESTARTED AFTER A PASS LEFT A BACKGROUND TASK: the pass on round ${round} ended its turn with ${tasks.length} process(es) it started still running. A headless pass has no next turn, so nothing would have reported their result; the driver stopped them:`,
    ...describeTasks(tasks),
    "Nothing the pass did was rolled back. What it left in this tree:",
    ...describeLeftovers(leftovers),
    "Run every step the round depends on in the foreground and wait for it within this turn, the gates above all (SKILL.md § Driver pass). Finish, validate and push what is sound, discard what is not on purpose, then triage as usual.",
    ...(inherited === ""
      ? []
      : [
          `This pass inherits the earlier pass's work at local HEAD ${inherited}. Run the § 1 gate with \`--inherited-head ${inherited}\`: without it the gate reads unpushed commits as HEAD_LAG, and can read a tree with only uncommitted edits as converged. Push what is sound through finish-round like any fix of this round.`,
        ]),
  ].join("\n");
}

/**
 * After a pass that exited `0` with `passEnv`: when it left a task running, stop the task
 * and restart the pass within the drive's restart budget (`"continue"`).
 * `null` when it left none, when none can be told, or when the budget is
 * spent: the drive then goes on as for any completed pass. An exit when the
 * task could not be witnessed gone (the locks stay held) or a directive
 * arrived while the pass ran.
 */
export async function restartAfterPendingTasks(
  context: DriveRoundContext,
  round: number,
  passEnv: NodeJS.ProcessEnv,
  pgid: number | undefined,
): Promise<number | "continue" | null> {
  const token = passEnv[PASS_TOKEN_VARIABLE] ?? "";
  const tasks = await pendingTasks(token, pgid);
  if (tasks === null || tasks.length === 0) return null;
  console.error(
    `pass on round ${round} exited 0 with ${tasks.length} process(es) it started still running in the background; a headless pass has no next turn to receive their result:`,
  );
  for (const line of describeTasks(tasks)) console.error(line);
  if (!(await stopPendingTasks(token, pgid))) {
    console.error(
      "  They could NOT be witnessed gone. NOT releasing this drive's locks: a live task under a released lock could go on writing the tree. Stop them, then re-arm.",
    );
    context.held.length = 0;
    driverRuntime.stopLeftWork = await measureStop();
    return WORKTREE_UNCLEAN_EXIT;
  }
  console.error("  Stopped them.");
  const mailbox = await context.mailboxCheckpoint();
  if (typeof mailbox === "number") return mailbox;
  const leftovers = await passLeftovers();
  for (const line of describeLeftovers(leftovers)) console.error(`  ${line}`);
  const restart = await admitPassRestart(
    context.pr,
    context.deadlineRetryBudget,
    "background-pending",
  );
  if (restart === null) {
    console.error(
      "  Could not record a restart in the drive state, so the restart budget cannot be enforced: not restarting the pass.",
    );
    return null;
  }
  if (!restart.admitted) {
    console.error(
      `  The pass restart budget is spent (${context.deadlineRetryBudget}, drive.pass_deadline_retries; ${restart.taken} restart(s) already taken by this drive): not restarting the pass.`,
    );
    return null;
  }
  console.error(
    `  Restarting: pass restart ${restart.taken} of ${context.deadlineRetryBudget} for this drive (drive.pass_deadline_retries). What the pass left stays in the tree for the next pass.`,
  );
  context.passNotice = backgroundNotice(round, tasks, leftovers);
  context.inheritedHead = inheritedHeadOf(leftovers);
  context.inheritsOperation =
    leftovers.operation !== null || !leftovers.operationProbed;
  // The pass did not complete its round: it must not count toward the stall
  // streak, which compares the gates around completed passes.
  context.prevFingerprint = null;
  context.noopRounds = 0;
  return "continue";
}
