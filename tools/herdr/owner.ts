/**
 * Who holds a claim: the host and process that took it, recorded as one line
 * `<host> <pid>`. A claim is taken over only once its owner is shown to have
 * ended, never by age: a process that is merely slow can still act on the
 * claim, and a dead one cannot.
 */
import { hostname } from "node:os";
import { errnoCode } from "../../plugin/shared/errors.ts";

/** This process as a claim's owner. */
export function ownerLine(): string {
  return `${hostname()} ${process.pid}\n`;
}

/**
 * The owner's process id when it ran on this host, where its liveness can be
 * checked; null for another host or a record that cannot be read as one.
 */
export function localOwner(line: string): number | null {
  const [host, pidText, extra] = line.trim().split(" ");
  const pid = Number(pidText);
  if (host !== hostname() || extra !== undefined) return null;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
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
