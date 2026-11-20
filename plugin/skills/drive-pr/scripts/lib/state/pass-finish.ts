/** A finish-round result bound to the drive pass that produced it. */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { readBoundedText } from "../../../../../shared/driver-report.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { atomicWrite } from "./fsutil.ts";
import type { Report } from "../finish-round-report.ts";

const SCHEMA = "drive-pass-finish/v1";
const LIMIT = 32 * 1024;

interface PassFinish {
  schema: typeof SCHEMA;
  pr: number;
  launch: string;
  round: number;
  report: Report;
}

function isPassFinish(value: unknown): value is PassFinish {
  return (
    isRecord(value) &&
    value.schema === SCHEMA &&
    typeof value.pr === "number" &&
    typeof value.launch === "string" &&
    typeof value.round === "number" &&
    isRecord(value.report)
  );
}

function file(stateDir: string, pr: string): string {
  return join(stateDir, `drive-pr-${pr}.pass-finish.json`);
}

export function writePassFinish(
  stateDir: string,
  pr: number,
  launch: string,
  round: number,
  report: Report,
): void {
  atomicWrite(
    file(stateDir, String(pr)),
    `${JSON.stringify({ schema: SCHEMA, pr, launch, round, report })}\n`,
  );
}

/** Retire the previous pass's record, so a retried pass that never reaches
 * finish-round cannot inherit what its predecessor wrote. */
export function clearPassFinish(stateDir: string, pr: string): void {
  rmSync(file(stateDir, pr), { force: true });
}

export function readPassFinish(
  stateDir: string,
  pr: string,
  launch: string,
  round: number,
): Report | null {
  try {
    const text = existsSync(file(stateDir, pr))
      ? readBoundedText(file(stateDir, pr), LIMIT)
      : null;
    if (text === null) return null;
    const value: unknown = JSON.parse(text);
    if (
      !isPassFinish(value) ||
      value.pr !== Number(pr) ||
      value.launch !== launch ||
      value.round !== round
    )
      return null;
    return value.report as unknown as Report;
  } catch (err) {
    swallow(err, "an unreadable or malformed finish record reads as absent");
    return null;
  }
}
