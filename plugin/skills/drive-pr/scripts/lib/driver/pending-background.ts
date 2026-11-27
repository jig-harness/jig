/**
 * A pass that ended its turn with a background task still running.
 *
 * A headless pass has no next turn, so a task it started in the background
 * (the gates, most often) reports to nobody, and the pass exits `0` with its
 * promised fixes unshipped although it only needed to wait. The driver gives
 * every review pass a token in its environment (`PASS_TOKEN_VARIABLE`), which
 * every process the pass starts inherits, a shell that left the pass's
 * process group or session included. When the pass exits `0`, a live process
 * still carrying the token, or still in the pass's process group, after a
 * short grace for one already on its way out, is such a task. The driver
 * stops it, witnessed. When the pass left work in the tree (uncommitted
 * edits, unpushed commits, an open git operation), the driver restarts the
 * pass in the same tree and tells it what happened, within the restarts the
 * drive has for a pass killed at its deadline (`drive.pass_deadline_retries`,
 * one count for both causes). A pass that left nothing to finish, or one past
 * the budget, is taken as a completed pass.
 *
 * The token is read from `/proc/<pid>/environ`, so the environment scan is
 * Linux's; another POSIX host finds only the pass's own process group, and a
 * Windows host finds nothing.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { errnoCode, swallow } from "../../../../../shared/errors.ts";
import { processTable } from "../../../../../shared/process-table.ts";
import { currentMs } from "../../../../../shared/time.ts";
import { KILL_ESCALATE_MS } from "./../proc.ts";
import type { DriveRoundContext } from "./round-context.ts";
import {
  admitPassRestart,
  describeLeftovers,
  inheritedHeadOf,
  type PassLeftovers,
  passLeftovers,
} from "./restart.ts";
import { measureStop } from "./stop-measure.ts";
import { driverRuntime } from "./runtime.ts";

/**
 * The variable that carries a review pass's token to everything it starts.
 * It stands outside the `DRIVE_PR_` prefix, which a pass strips from the
 * environment of the tests it runs.
 */
export const PASS_TOKEN_VARIABLE = "JIG_DRIVE_PASS_TOKEN";

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

/** The processes a scan found, or why it could not look. */
export type PendingScan = { tasks: PendingTask[] } | { unknown: string };

/** How much of a task's command line the driver prints. */
const COMMAND_CHARS = 160;

/** `/proc`, or the fixture tree a test points `DRIVE_PR_PROC_ROOT` at. */
const procRoot = (): string => process.env.DRIVE_PR_PROC_ROOT ?? "/proc";

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
 * `/proc/<pid>/stat`'s state and process group. The command name in
 * parentheses may hold spaces and parentheses, so fields are read after the
 * last `)`.
 */
function statOf(text: string): { state: string; pgrp: number } | null {
  const close = text.lastIndexOf(")");
  if (close === -1) return null;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const pgrp = Number.parseInt(fields[2] ?? "", 10);
  return fields[0] === undefined || !Number.isFinite(pgrp)
    ? null
    : { state: fields[0], pgrp };
}

/**
 * Whether the live process at `dir` carries `entry` in its environment or
 * is in process group `pgid`; a zombie or an unreadable process does not.
 */
function carries(dir: string, entry: string | null, pgid?: number): boolean {
  const text = procFile(dir, "stat");
  const stat = text === null ? null : statOf(text);
  if (stat === null || stat.state === "Z") return false;
  if (pgid !== undefined && stat.pgrp === pgid) return true;
  if (entry === null) return false;
  return (procFile(dir, "environ") ?? "").split("\0").includes(entry);
}

/** A process's command line from `/proc`, shortened. */
function procCommand(dir: string): string {
  const text = (procFile(dir, "cmdline") ?? "")
    .split("\0")
    .filter((part) => part !== "")
    .join(" ");
  return text.length > COMMAND_CHARS
    ? `${text.slice(0, COMMAND_CHARS - 1)}…`
    : text;
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
 * `/proc` answers, by process group alone on another POSIX host.
 */
export async function pendingTasks(
  token: string,
  pgid: number | undefined,
): Promise<PendingScan> {
  const viaProc = pendingTasksLinux(token, pgid);
  if (viaProc !== null) return { tasks: viaProc };
  if (pgid === undefined)
    return {
      unknown: "/proc cannot be read and the pass had no process group",
    };
  const rows = await processTable();
  if (rows === null) return { unknown: "the process listing (ps) failed" };
  const tasks = rows
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
  return { tasks };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** How long the driver waits for the tasks to be gone after its SIGKILL. */
const KILL_WITNESS_MS = 10_000;
const POLL_MS = 100;

/**
 * Scan until none is left or `waitMs` passes: the tasks still running at the
 * end, or why a scan could not look.
 */
async function waitForTasks(
  token: string,
  pgid: number | undefined,
  waitMs: number,
): Promise<PendingScan> {
  const until = currentMs() + waitMs;
  for (;;) {
    const scan = await pendingTasks(token, pgid);
    if ("unknown" in scan || scan.tasks.length === 0) return scan;
    if (currentMs() >= until) return scan;
    await sleep(POLL_MS);
  }
}

/** Send `sig` to `pid`; the reason when it was refused, `null` when sent or gone. */
function signalOf(pid: number, sig: NodeJS.Signals): string | null {
  try {
    process.kill(pid, sig);
    return null;
  } catch (err) {
    const code = errnoCode(err);
    return code === "ESRCH"
      ? null
      : `${sig} to ${pid} was refused (${code ?? String(err)})`;
  }
}

/**
 * Stop what the pass left running: SIGTERM, then SIGKILL after the driver's
 * usual grace, each to every process found carrying the token or in the
 * group at that moment, and to the group itself. `null` once a scan finds
 * none left; otherwise why they could not be witnessed gone, which the caller
 * treats as still running.
 */
export async function stopPendingTasks(
  token: string,
  pgid: number | undefined,
): Promise<string | null> {
  const refused: string[] = [];
  for (const [sig, waitMs] of STOP_STEPS) {
    const left = await signalAndWait(token, pgid, sig, waitMs, refused);
    if (left !== RUNNING) return left;
  }
  return refused.length > 0
    ? refused.join("; ")
    : "they outlived SIGKILL and the wait after it";
}

/** The signals a stop sends, each with how long it waits after it. */
const STOP_STEPS = [
  ["SIGTERM", KILL_ESCALATE_MS],
  ["SIGKILL", KILL_WITNESS_MS],
] as const;

/** `signalAndWait`'s answer while a task still runs. */
const RUNNING = Symbol("running");

/**
 * Send `sig` to the group and to every task a scan finds, adding any refusal
 * to `refused`, then wait `waitMs` for them to go: `null` when none is left,
 * `RUNNING` when one is, or why a scan could not look.
 */
async function signalAndWait(
  token: string,
  pgid: number | undefined,
  sig: NodeJS.Signals,
  waitMs: number,
  refused: string[],
): Promise<string | null | typeof RUNNING> {
  const found = await pendingTasks(token, pgid);
  if ("unknown" in found) return found.unknown;
  if (found.tasks.length === 0) return null;
  // The group itself first: it reaches a member started since the scan.
  if (pgid !== undefined) signalOf(-pgid, sig);
  for (const task of found.tasks) {
    const why = signalOf(task.pid, sig);
    if (why !== null) refused.push(why);
  }
  const left = await waitForTasks(token, pgid, waitMs);
  if ("unknown" in left) return left.unknown;
  return left.tasks.length === 0 ? null : RUNNING;
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

/** The exit for a stop a person settles (`INDETERMINATE`). */
const PERSON_STOP_EXIT = 1;

/**
 * After a pass that exited `0` with `passEnv`: stop any task it left running
 * and, when it left work in the tree, restart the pass within the drive's
 * restart budget (`"continue"`). `null` when it left no task, when none can
 * be told, when it left no work, or when the budget is spent: the drive then
 * goes on as for any completed pass. An exit when a task could not be
 * witnessed gone (the locks stay held) or a directive arrived while the pass
 * ran.
 */
export async function restartAfterPendingTasks(
  context: DriveRoundContext,
  round: number,
  passEnv: NodeJS.ProcessEnv,
  pgid: number | undefined,
): Promise<number | "continue" | null> {
  if (process.platform === "win32") return null;
  const token = passEnv[PASS_TOKEN_VARIABLE] ?? "";
  // A process on its way out (a helper closing after its input ended) is
  // given the driver's kill grace before it counts as left running.
  const scan = await waitForTasks(token, pgid, KILL_ESCALATE_MS);
  if ("unknown" in scan) {
    console.error(
      `could not look for processes the pass on round ${round} left running: ${scan.unknown}.`,
    );
    return null;
  }
  const { tasks } = scan;
  if (tasks.length === 0) return null;
  console.error(
    `pass on round ${round} exited 0 with ${tasks.length} process(es) it started still running in the background; a headless pass has no next turn to receive their result:`,
  );
  for (const line of describeTasks(tasks)) console.error(line);
  const unstopped = await stopPendingTasks(token, pgid);
  if (unstopped !== null) {
    console.error(
      `  They could NOT be witnessed gone (${unstopped}). NOT releasing this drive's locks: a live task under a released lock could go on writing the tree. Stop them, then re-arm.`,
    );
    context.held.length = 0;
    driverRuntime.stopLeftWork = await measureStop();
    return PERSON_STOP_EXIT;
  }
  console.error("  Stopped them.");
  const mailbox = await context.mailboxCheckpoint();
  if (typeof mailbox === "number") return mailbox;
  const leftovers = await passLeftovers();
  for (const line of describeLeftovers(leftovers)) console.error(`  ${line}`);
  if (inheritedHeadOf(leftovers) === "") {
    console.error(
      "  The pass left no work in the tree: taking it as a completed pass.",
    );
    return null;
  }
  return await admitRestart(context, round, tasks, leftovers);
}

/** Restart the pass within the budget, or `null` when it cannot be. */
async function admitRestart(
  context: DriveRoundContext,
  round: number,
  tasks: PendingTask[],
  leftovers: PassLeftovers,
): Promise<"continue" | null> {
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
