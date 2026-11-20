/**
 * Stop a process run a person takes over. A drive is first told to stop
 * through `drives.ts --stop <pr>`, run in the repository's clone, so its
 * ledger reads stopped and its locks are released. Then the run's unit
 * (systemd's `jig-run-<id>.service`) or job (launchd's `jig-run-<id>`) is
 * stopped, which ends every process in it. A run started without a service
 * manager (the cron host's detached wrapper), or one whose processes
 * outlive the unit's stop, has its recorded process groups signalled:
 * `SIGTERM`, then `SIGKILL` after a grace, each only while the process
 * table still shows the recorded process with its recorded start.
 *
 * Every step has a deadline. A failed step is reported and the next one
 * still runs; the stop has worked only when none of the run's processes is
 * alive, which the caller checks.
 */
import { run, tsArgv } from "../../shared/proc.ts";
import {
  judge,
  thisHost,
  type ProcessIdentity,
} from "../../shared/liveness.ts";
import { processTable } from "../../shared/process-table.ts";
import { swallow } from "../../shared/errors.ts";
import { detectScheduler } from "../../runtime/scheduler.ts";
import { drives } from "../../skills/drive-pr/scripts/lib/driver/paths.ts";
import { processJobName } from "./runtime/process-service.ts";

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
  /** The run's recorded processes, whose groups are signalled when the unit's stop does not end them. */
  members: ProcessIdentity[];
}

/** One step of the stop, as the person is told it. */
export type StopStep = (target: StopTarget) => Promise<string>;

/** `drives.ts --stop <pr>` in the clone, so the drive's ledger reads stopped. */
export const stopDrive: StopStep = async (target) => {
  if (target.drivePr === null) return "not a drive";
  const done = await run(tsArgv(drives, ["--stop", String(target.drivePr)]), {
    cwd: target.repoPath,
    stderr: "pipe",
    timeoutSec: DRIVE_STOP_SEC,
  });
  if (done.timedOut)
    return "drives.ts --stop did not finish before its deadline";
  return done.code === 0
    ? "drives.ts --stop stopped the driver"
    : `drives.ts --stop exited ${done.code}: ${done.stderr.trim().split("\n").at(-1) ?? ""}`;
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
    return `stopping ${name} did not finish before its deadline`;
  return done.code === 0
    ? `stopped ${name}`
    : `stopping ${name} exited ${done.code}`;
};

/** Signal each recorded process's group (its own pid where no group was recorded) while it is still that process. */
export async function signalMembers(
  members: ProcessIdentity[],
  signal: "SIGTERM" | "SIGKILL",
): Promise<string> {
  const rows = await processTable();
  if (rows === null) return "the process table does not read";
  const here = thisHost();
  const sent: number[] = [];
  for (const member of members) {
    const live = judge(member, rows, here);
    if (!live.ok || live.value.state !== "alive") continue;
    const group = member.pgid ?? member.pid;
    try {
      process.kill(group === member.pgid ? -group : group, signal);
      sent.push(group);
    } catch (error) {
      swallow(error, "a recorded process ended before it was signalled");
    }
  }
  return sent.length === 0
    ? "no recorded process was alive to signal"
    : `sent ${signal} to ${sent.join(", ")}`;
}
