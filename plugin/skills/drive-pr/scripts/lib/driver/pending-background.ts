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
 * stops it, witnessed, binding each signal to the process's creation
 * identity. It then restarts the pass in the same tree and tells it what
 * happened, within the restarts the drive has for a pass killed at its
 * deadline (`drive.pass_deadline_retries`, one count for both causes); the
 * stopped task may have been validation, so a clean tree does not excuse the
 * restart. A pass past the budget is taken as a completed pass. A scan that
 * cannot look, or cannot inspect a process of the driver's user, stops the
 * drive with its locks held. Only the program name of a task is recorded.
 *
 * The token is read from `/proc/<pid>/environ`, so the environment scan is
 * Linux's; another POSIX host finds only the pass's own process group, and a
 * Windows host finds nothing.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

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
  /**
   * Its program name only, never its arguments, which can carry credentials;
   * `''` when it could not be read.
   */
  command: string;
  /** Its process group; `null` when the scan did not read it. */
  pgrp: number | null;
  /** Its creation identity, which a signal is bound to; `''` when unread. */
  start: string;
}

/**
 * The processes a scan found, or why it could not look. A scan that found
 * some processes but could not inspect others says so in `unknown` too: a
 * process it could not inspect may still be running.
 */
export type PendingScan = { tasks: PendingTask[] } | { unknown: string };

/** How much of a program name the driver prints. */
const COMMAND_CHARS = 80;

/** A command line reduced to its program name, shortened. */
function programOf(commandLine: string): string {
  const first = commandLine.trim().split(/\s+/)[0] ?? "";
  const name = basename(first);
  return name.length > COMMAND_CHARS
    ? `${name.slice(0, COMMAND_CHARS - 1)}…`
    : name;
}

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
function statOf(
  text: string,
): { state: string; pgrp: number; start: string } | null {
  const close = text.lastIndexOf(")");
  if (close === -1) return null;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const pgrp = Number.parseInt(fields[2] ?? "", 10);
  return fields[0] === undefined || !Number.isFinite(pgrp)
    ? null
    : { state: fields[0], pgrp, start: fields[19] ?? "" };
}

/** What a look at one `/proc` entry found. */
type Carried =
  | { kind: "no" }
  | { kind: "unknown"; why: string }
  | { kind: "yes"; pgrp: number; start: string };

/** Whether the entry at `dir` belongs to the user the driver runs as. */
function ownedByUs(dir: string): boolean {
  try {
    return typeof process.getuid !== "function"
      ? true
      : statSync(dir).uid === process.getuid();
  } catch (err) {
    swallow(err, `${dir} could not be inspected`);
    return false;
  }
}

/**
 * Whether the live process at `dir` carries `entry` in its environment or
 * is in process group `pgid`; a zombie or a process of another user does not.
 * A process of this user whose environment cannot be read is `unknown`: it
 * may carry the token.
 */
function carries(dir: string, entry: string | null, pgid?: number): Carried {
  const text = procFile(dir, "stat");
  const stat = text === null ? null : statOf(text);
  if (stat === null || stat.state === "Z") return { kind: "no" };
  const yes: Carried = { kind: "yes", pgrp: stat.pgrp, start: stat.start };
  if (pgid !== undefined && stat.pgrp === pgid) return yes;
  if (entry === null) return { kind: "no" };
  const environ = environOf(dir);
  if (environ === "denied")
    return ownedByUs(dir) && startedSinceDriver(stat.start)
      ? { kind: "unknown", why: `${dir}/environ could not be read` }
      : { kind: "no" };
  if (environ === null) return { kind: "no" };
  return environ.split("\0").includes(entry) ? yes : { kind: "no" };
}

/**
 * Whether a process with creation identity `start` began after this driver
 * did, so it could descend from a pass the driver spawned; one that began
 * earlier (a long-running agent or key daemon) cannot. Unreadable or
 * incomparable identities count as later.
 */
function startedSinceDriver(start: string): boolean {
  const own = statOf(procFile(`${procRoot()}/self`, "stat") ?? "")?.start;
  const mine = Number(own);
  const theirs = Number(start);
  return !(Number.isFinite(mine) && Number.isFinite(theirs) && theirs < mine);
}

/**
 * `dir/environ`: its text, `"denied"` when the system refused it to us, or
 * `null` when it is gone or absent.
 */
function environOf(dir: string): string | "denied" | null {
  try {
    return readFileSync(`${dir}/environ`, "utf8");
  } catch (err) {
    const code = errnoCode(err);
    if (code === "EACCES" || code === "EPERM") return "denied";
    swallow(err, `${dir}/environ is not there`);
    return null;
  }
}

/** A process's program name from `/proc`. */
function procCommand(dir: string): string {
  return programOf(
    (procFile(dir, "cmdline") ?? "").split("\0").find((p) => p !== "") ?? "",
  );
}

/**
 * The live processes carrying `token` in their environment or in process
 * group `pgid`, read from `/proc`, with the reasons a process of this user
 * could not be inspected; `null` when `/proc` cannot be listed.
 */
export function pendingTasksLinux(
  token: string,
  pgid: number | undefined,
): { tasks: PendingTask[]; uninspected: string[] } | null {
  let entries: string[];
  try {
    entries = readdirSync(procRoot());
  } catch (err) {
    swallow(err, "the process list could not be read from /proc");
    return null;
  }
  const entry = token === "" ? null : `${PASS_TOKEN_VARIABLE}=${token}`;
  const tasks: PendingTask[] = [];
  const uninspected: string[] = [];
  for (const name of entries) {
    const pid = /^[0-9]+$/.test(name) ? Number.parseInt(name, 10) : null;
    if (pid === null || pid === process.pid) continue;
    const dir = `${procRoot()}/${name}`;
    const found = carries(dir, entry, pgid);
    if (found.kind === "yes")
      tasks.push({
        pid,
        command: procCommand(dir),
        pgrp: found.pgrp,
        start: found.start,
      });
    else if (found.kind === "unknown") uninspected.push(`pid ${pid}`);
  }
  return { tasks, uninspected };
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
  if (viaProc !== null)
    return viaProc.uninspected.length > 0
      ? {
          unknown: `${viaProc.uninspected.join(", ")} of this user could not be inspected and may carry the token`,
        }
      : { tasks: viaProc.tasks };
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
      command: programOf(row.args),
      pgrp: row.pgid,
      start: row.start,
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
    // An unknown answer is retried until the wait ends: a process on its way
    // out can be unreadable for a moment.
    if ("tasks" in scan && scan.tasks.length === 0) return scan;
    if (currentMs() >= until) return scan;
    await sleep(POLL_MS);
  }
}

/**
 * The tasks of `found` still the processes the scan saw: the same pid with
 * the same creation identity. A pid whose identity cannot be compared is not
 * signalled, since it may have been reused.
 */
async function stillSame(found: PendingTask[]): Promise<PendingTask[]> {
  const rows = await rowsOf();
  return found.filter((task) => {
    if (task.start === "") return false;
    if (rows === "proc") {
      const text = procFile(`${procRoot()}/${task.pid}`, "stat");
      const stat = text === null ? null : statOf(text);
      return stat !== null && stat.start === task.start && stat.state !== "Z";
    }
    return (
      rows?.some((row) => row.pid === task.pid && row.start === task.start) ??
      false
    );
  });
}

/** Which source identities are re-read from: `/proc` where it lists. */
async function rowsOf(): Promise<
  "proc" | Awaited<ReturnType<typeof processTable>>
> {
  try {
    readdirSync(procRoot());
    return "proc";
  } catch (err) {
    swallow(err, "/proc cannot be listed; re-reading identities from ps");
    return await processTable();
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
  // Only a process still the one the scan saw is signalled, and the group
  // only while one of its members is: a reused id belongs to someone else.
  const same = await stillSame(found.tasks);
  // The group itself first: it reaches a member started since the scan.
  if (pgid !== undefined && same.some((task) => task.pgrp === pgid))
    signalOf(-pgid, sig);
  for (const task of same) {
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
 * and restart the pass within the drive's restart budget (`"continue"`),
 * whatever the tree holds: the task may have been validation the pass never
 * saw finish. `null` when it left no task or when the budget is spent: the
 * drive then goes on as for any completed pass. An exit when a task could
 * not be witnessed gone or not be looked for (the locks stay held) or a
 * directive arrived while the pass ran.
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
      `could not look for processes the pass on round ${round} left running: ${scan.unknown}. NOT releasing this drive's locks: a live task under a released lock could go on writing the tree. Stop what the pass left, then re-arm.`,
    );
    context.held.length = 0;
    driverRuntime.stopLeftWork = await measureStop();
    return PERSON_STOP_EXIT;
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
  // A clean tree does not show the stopped task was irrelevant: it may have
  // been the gates of a fix the pass had already pushed. The pass runs again
  // either way, within the budget.
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
