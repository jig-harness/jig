import type { LaunchRecord } from "./launches.ts";

/** Whether a record starts a drive's headless pass, whose exit is its answer. */
export function isDrive(record: Pick<LaunchRecord, "action">): boolean {
  return record.action === "rearm" || record.action === "takeover";
}

/** Whether a record starts an interactive pickup session rather than a headless pass. */
export function isInteractive(
  record: Pick<LaunchRecord, "action" | "headless">,
): boolean {
  return record.action === "pickup" && record.headless !== true;
}
