/**
 * Stop a process run a person takes over. A drive is first told to stop
 * through `drives.ts --stop <pr>`, run in the repository's clone, so its
 * ledger reads stopped and its locks are released. Then the run's unit
 * (systemd's `jig-run-<id>.service`) or job (launchd's `jig-run-<id>`) is
 * stopped, which ends every process in it. A run started without a service
 * manager (the cron host's detached wrapper), or one whose processes
 * outlive the unit's stop, has its processes signalled: `SIGTERM`, then
 * `SIGKILL` after a grace. The processes are the recorded ones and their
 * descendants, captured before the first step, each signalled only while
 * the process table still shows it with its captured start.
 *
 * Every step has a deadline. A failed step is reported and the next one
 * still runs; the stop has worked only when none of those processes is
 * alive, which the caller checks.
 */
import { run, tsArgv } from "../../shared/proc.ts";
import {
  judge,
  thisHost,
  type ProcessIdentity,
} from "../../shared/liveness.ts";
import { processTable, type ProcessRow } from "../../shared/process-table.ts";
import { swallow } from "../../shared/errors.ts";
import { detectScheduler } from "../../runtime/scheduler.ts";
import { drives } from "../../skills/drive-pr/scripts/lib/driver/paths.ts";
import { processJobName } from "./runtime/process-service.ts";
import { descendants } from "./runtime/process.ts";

/** How long `drives.ts --stop` may take: its own grace is 30 seconds. */
const DRIVE_STOP_SEC = 90;
/** How long the service manager may take to stop the unit or job. */
const SERVICE_STOP_SEC = 60;

/** What the stop needs of the run. */
export interface StopTarget {
  id: string;
  /** The drive's pull request, for a drive; `null` for any other run. */
  drivePr: number | null;
  repoPath: string;
  /** The run's live recorded processes and their descendants, captured before the first step. */
  members: ProcessIdentity[];
}

/** One step of the stop, as the person is told it. */
export type StopStep = (target: StopTarget) => Promise<string>;

/** The last line a failed command wrote to its standard error, after a colon; empty when none. */
function lastError(stderr: string): string {
  const line = stderr.trim().split("\n").at(-1)?.trim() ?? "";
  return line === "" ? "" : `: ${line}`;
}

/** `drives.ts --stop <pr>` in the clone, so the drive's ledger reads stopped. */
export const stopDrive: StopStep = async (target) => {
  if (target.drivePr === null) return "not a drive";
  const done = await run(tsArgv(drives, ["--stop", String(target.drivePr)]), {
    cwd: target.repoPath,
    stderr: "pipe",
    timeoutSec: DRIVE_STOP_SEC,
  });
  if (done.timedOut)
    return `drives.ts --stop did not finish before its deadline${lastError(done.stderr)}`;
  return done.code === 0
    ? "drives.ts --stop stopped the driver"
    : `drives.ts --stop exited ${done.code}${lastError(done.stderr)}`;
};

/** Stop the run's systemd unit or launchd job; on a host with neither there is none. */
export const stopService: StopStep = async (target) => {
  const scheduler = detectScheduler();
  const name = processJobName(target.id);
  const command =
    scheduler.ok && scheduler.value === "systemd"
      ? ["systemctl", "--user", "stop", `${name}.service`]
      : scheduler.ok && scheduler.value === "launchd"
        ? ["/bin/launchctl", "bootout", `gui/${process.getuid?.()}/${name}`]
        : null;
  if (command === null) return "no service manager runs it";
  const done = await run(command, {
    stderr: "pipe",
    timeoutSec: SERVICE_STOP_SEC,
  });
  if (done.timedOut)
    return `stopping ${name} did not finish before its deadline${lastError(done.stderr)}`;
  return done.code === 0
    ? `stopped ${name}`
    : `stopping ${name} exited ${done.code}${lastError(done.stderr)}`;
};

/**
 * The live recorded processes and every live descendant of theirs, each as
 * the process table shows it now (with its group), so a process the stop
 * reparents is still known and still signalled; `null` when the table does
 * not read.
 */
export async function processTree(
  members: ProcessIdentity[],
): Promise<ProcessIdentity[] | null> {
  const rows = await processTable();
  if (rows === null) return null;
  const here = thisHost();
  const live = members.filter((m) => {
    const verdict = judge(m, rows, here);
    return verdict.ok && verdict.value.state === "alive";
  });
  const pids = descendants(rows, new Set(live.map((m) => m.pid)));
  const recorded = new Map(live.map((m) => [m.pid, m]));
  return rows
    .filter((row) => pids.has(row.pid) && row.start !== "")
    .map(
      (row) =>
        recorded.get(row.pid) ?? {
          hostId: here.hostId,
          host: here.host,
          bootId: here.bootId,
          pid: row.pid,
          start: row.start,
          ...(row.pgid > 0 ? { pgid: row.pgid } : {}),
        },
    );
}

/** Whether any of `members` is still alive, or cannot be judged. */
export async function anyAlive(members: ProcessIdentity[]): Promise<boolean> {
  if (members.length === 0) return false;
  const rows = await processTable();
  if (rows === null) return true;
  const here = thisHost();
  return members.some((m) => {
    const verdict = judge(m, rows, here);
    return !verdict.ok || verdict.value.state === "alive";
  });
}

/**
 * What to signal for `member`: its group, when the live row's group is the
 * recorded one, above 1 and not this process's own; its pid alone when no
 * group was recorded or the group is this process's; `null` when the live
 * row's group is another than the recorded one.
 */
function signalTarget(
  member: ProcessIdentity,
  row: ProcessRow,
  ownGroup: number | null,
): number | null {
  if (member.pgid === undefined) return member.pid;
  if (row.pgid !== member.pgid) return null;
  if (member.pgid <= 1 || member.pgid === ownGroup) return member.pid;
  return -member.pgid;
}

/** Signal each process (its group where `signalTarget` allows) while it is still that process; what was sent, skipped and refused. */
export async function signalMembers(
  members: ProcessIdentity[],
  signal: "SIGTERM" | "SIGKILL",
): Promise<string> {
  const rows = await processTable();
  if (rows === null) return "the process table does not read";
  const here = thisHost();
  const ownGroup = rows.find((r) => r.pid === process.pid)?.pgid ?? null;
  const sent = new Set<number>();
  const notes: string[] = [];
  for (const member of members) {
    const live = judge(member, rows, here);
    if (!live.ok || live.value.state !== "alive") continue;
    const row = rows.find((r) => r.pid === member.pid);
    if (row === undefined) continue;
    const target = signalTarget(member, row, ownGroup);
    if (target === null) {
      notes.push(
        `skipped ${member.pid}: its group is ${row.pgid}, not the recorded ${String(member.pgid)}`,
      );
      continue;
    }
    if (sent.has(target)) continue;
    try {
      process.kill(target, signal);
      sent.add(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH")
        swallow(error, "a process ended before it was signalled");
      else notes.push(`could not signal ${target}: ${code ?? String(error)}`);
    }
  }
  const head =
    sent.size === 0
      ? "no process was signalled"
      : `sent ${signal} to ${[...sent].join(", ")}`;
  return [head, ...notes].join("; ");
}
