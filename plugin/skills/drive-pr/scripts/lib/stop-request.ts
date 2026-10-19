/** Generation-addressed cooperative stop channel. A successor's claim has a
 * different nonce, so an old request can never stop a replacement driver. */
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { errnoCode, swallow } from "../../../../shared/errors.ts";

export function stopRequestPath(dir: string, nonce: string): string {
  return join(dir, `stop.${nonce}`);
}

export function requestDriverStop(dir: string, nonce: string): void {
  try {
    writeFileSync(stopRequestPath(dir, nonce), "stop\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function driverStopRequested(dir: string, nonce: string): boolean {
  return existsSync(stopRequestPath(dir, nonce));
}

/** Completion outlives lock removal and is bound to one verified PR acquisition. */
export function stopCompletionPath(dir: string, nonce: string): string | null {
  const pr = /^pr-drive-([0-9]+)\.lock$/.exec(basename(dir))?.[1];
  return pr
    ? join(dirname(dir), `drive-pr-${pr}.stop-complete.${nonce}.json`)
    : null;
}

export function publishDriverStopCompletion(
  dir: string,
  nonce: string,
  pid: number,
): void {
  const path = stopCompletionPath(dir, nonce);
  if (path === null) return;
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ nonce, pid, confirmed: true }), {
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function driverStopCompleted(
  dir: string,
  nonce: string,
  pid: number,
): boolean {
  const path = stopCompletionPath(dir, nonce);
  if (path === null) return false;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return (
      typeof value === "object" &&
      value !== null &&
      "nonce" in value &&
      value.nonce === nonce &&
      "pid" in value &&
      value.pid === pid &&
      "confirmed" in value &&
      value.confirmed === true
    );
  } catch (error) {
    if (errnoCode(error) !== "ENOENT")
      swallow(
        error,
        "unreadable stop completion receipt cannot confirm shutdown",
      );
    return false;
  }
}

export function consumeDriverStopCompletion(dir: string, nonce: string): void {
  const path = stopCompletionPath(dir, nonce);
  if (path !== null) rmSync(path, { force: true });
}
