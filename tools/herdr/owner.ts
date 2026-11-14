/**
 * Who holds a claim: the host, process and process start that took it,
 * recorded as one line `<host> <pid> <start>`. A claim is taken over only
 * once its owner is shown to have ended, never by age: a process that is
 * merely slow can still act on the claim, and a dead one cannot.
 *
 * A process id alone does not name a process, so the owner is the process
 * with that id *and* that start
 * (`plugin/shared/orca-workspace/process-start.ts`).
 */
import { hostname } from "node:os";
import { processStart } from "../../plugin/shared/orca-workspace/process-start.ts";
import { type Context, HerdrError } from "./runner.ts";

export {
  processAlive,
  processStart,
} from "../../plugin/shared/orca-workspace/process-start.ts";

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
