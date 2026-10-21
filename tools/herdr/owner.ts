/**
 * Who holds a claim: the host, process and process start that took it,
 * recorded as one line `<host> <pid> <start>`. A claim is taken over only
 * once its owner is shown to have ended, never by age: a process that is
 * merely slow can still act on the claim, and a dead one cannot.
 *
 * A process id alone does not name a process: once its owner ends, the
 * system gives the number to the next process, and after a restart to any
 * process at all. So the owner is the process with that id *and* that start.
 * On Linux the start is the boot's id and the process's start in clock ticks
 * since boot, read from `/proc`; elsewhere (macOS) it is the start time `ps`
 * reports, which is a wall-clock time and so differs across a restart too.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { errnoCode } from "../../plugin/shared/errors.ts";
import { budget, type Context, HerdrError } from "./runner.ts";

/** The time reading one process's start may take. */
const START_TIMEOUT_MS = 10_000;

/**
 * The start of process `pid`, as a token without spaces; null when no such
 * process exists. Throws when it cannot be read, which is never "ended".
 */
export function processStart(ctx: Context, pid: number): string | null {
  if (process.platform === "linux") return linuxStart(pid);
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: budget(ctx, START_TIMEOUT_MS),
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  const text = (result.stdout ?? "").trim();
  if (result.error === undefined && result.status === 1 && text === "")
    return null;
  if (result.error !== undefined || result.status !== 0 || text === "")
    throw new HerdrError(
      `could not read when process ${pid} started (${result.error?.message ?? `ps exit ${result.status}`})`,
    );
  return text.replace(/\s+/g, "_");
}

function linuxStart(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ESRCH")
      return null;
    throw error;
  }
  // The command name, in parentheses, may hold spaces; the start in clock
  // ticks is the 22nd field, the 20th after it.
  const ticks = stat
    .slice(stat.lastIndexOf(")") + 2)
    .split(" ")
    .at(19);
  if (ticks === undefined || !/^[0-9]+$/.test(ticks))
    throw new HerdrError(`could not read when process ${pid} started`);
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return `${boot}:${ticks}`;
}

/** This process's start, read once: it never changes. */
let ownStart: string | null = null;

/** This process as a claim's owner. */
export function ownerLine(ctx: Context): string {
  ownStart ??= processStart(ctx, process.pid);
  if (ownStart === null)
    throw new HerdrError("could not read when this process started");
  return `${hostname()} ${process.pid} ${ownStart}\n`;
}

export interface Owner {
  pid: number;
  start: string;
}

/**
 * The owner a line records when it ran on this host, where whether it still
 * runs can be checked; null for another host or a record that cannot be read
 * as one, including one without a start.
 */
export function localOwner(line: string): Owner | null {
  const [host, pidText, start, extra] = line.trim().split(" ");
  const pid = Number(pidText);
  if (host !== hostname() || start === undefined || extra !== undefined)
    return null;
  return Number.isInteger(pid) && pid > 0 && start !== ""
    ? { pid, start }
    : null;
}

/** Whether the process the owner names still runs: same id, same start. */
export function ownerAlive(ctx: Context, owner: Owner): boolean {
  return processStart(ctx, owner.pid) === owner.start;
}

/** Whether the process, or with a negative id the process group, exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}
