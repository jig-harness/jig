/** Generation-addressed cooperative stop channel. A successor's claim has a
 * different nonce, so an old request can never stop a replacement driver. */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
