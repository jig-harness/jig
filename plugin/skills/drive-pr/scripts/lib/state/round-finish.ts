/**
 * How each pass's `finish-round.ts` ended, kept in the drive's state
 * directory as `drive-pr-<PR>.round-finish.json` for the driver's stall stop
 * (`driver/round-budget.ts`): a stall whose passes all ended on the same
 * state names that state and its reason, so whoever reads the stop starts
 * from what held the rounds. Only a drive's pass records one (the driver
 * hands it `DRIVE_PR_ROUND`); the newest few are kept.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ReportCause } from "../../../../../shared/closing-report.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { parseMs } from "../../../../../shared/time.ts";
import { atomicWrite } from "./fsutil.ts";

export const ROUND_FINISH_SCHEMA = "drive-round-finish/v1";

/** How many finishes the file keeps, newest last. */
const KEPT = 16;

/** The longest reason kept. */
const REASON_MAX = 2000;

/** One `finish-round.ts` outcome. */
export interface RoundFinish {
  round: number;
  /** Its report's state (`CI_HOLD_WAIT`, `FINISHED`, …). */
  state: string;
  reason: string;
  head: string;
  /** When it was recorded. */
  at: string;
}

/** Where a pull request's finishes are kept. */
export function roundFinishFile(stateDir: string, pr: string): string {
  return join(stateDir, `drive-pr-${pr}.round-finish.json`);
}

function isRoundFinish(value: unknown): value is RoundFinish {
  return (
    isRecord(value) &&
    typeof value.round === "number" &&
    typeof value.state === "string" &&
    typeof value.reason === "string" &&
    typeof value.head === "string" &&
    typeof value.at === "string" &&
    Number.isFinite(parseMs(value.at))
  );
}

/** The finishes kept for `pr`, oldest first; none when the file is absent or does not read. */
export function readRoundFinishes(stateDir: string, pr: string): RoundFinish[] {
  const file = roundFinishFile(stateDir, pr);
  if (!existsSync(file)) return [];
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      !isRecord(value) ||
      value.schema !== ROUND_FINISH_SCHEMA ||
      String(value.pr) !== pr ||
      !Array.isArray(value.finishes)
    )
      return [];
    return value.finishes.filter(isRoundFinish);
  } catch (error) {
    swallow(error, "the round finishes do not read");
    return [];
  }
}

/** Keep `finish` as `pr`'s newest, dropping the oldest beyond the kept count. */
export function recordRoundFinish(
  stateDir: string,
  pr: string,
  finish: RoundFinish,
): void {
  const finishes = [
    ...readRoundFinishes(stateDir, pr),
    { ...finish, reason: finish.reason.slice(0, REASON_MAX) },
  ].slice(-KEPT);
  atomicWrite(
    roundFinishFile(stateDir, pr),
    `${JSON.stringify({ schema: ROUND_FINISH_SCHEMA, pr: Number(pr), finishes })}\n`,
  );
}

/** The newest finish recorded no earlier than `since`, when one was. */
export function finishSince(
  finishes: readonly RoundFinish[],
  since: string,
): RoundFinish | null {
  const floor = parseMs(since);
  if (!Number.isFinite(floor)) return null;
  return finishes.filter((f) => parseMs(f.at) >= floor).at(-1) ?? null;
}

/**
 * The state every stalled pass's finish ended on, with the last one's
 * reason: `null` when a pass recorded none, when they differ, or when they
 * all finished the round, which names nothing that held it.
 */
export function sharedFinish(
  finishes: readonly (RoundFinish | null)[],
): { state: string; reason: string } | null {
  const first = finishes[0];
  if (first === undefined || first === null || first.state === "FINISHED")
    return null;
  if (!finishes.every((f) => f !== null && f.state === first.state))
    return null;
  const last = finishes.at(-1) as RoundFinish;
  return { state: last.state, reason: last.reason };
}

/** The `finish-round.ts` states each cause class takes; any other is `unknown`. */
const FINISH_CAUSES: Readonly<Record<string, ReportCause>> = {
  CI_HOLD_WAIT: "environment",
  HEAD_NOT_SYNCED: "environment",
  LEASE_HELD: "environment",
  REFUSED_UNCLEAN: "refused",
  REFUSED_UNTRIAGED: "refused",
  REFUSED_COMMIT_PREFIX: "refused",
  TRIAGE_CHECK_FAILED: "tool-failed",
  CI_HOLD_FAILED: "tool-failed",
  PUSH_FAILED: "tool-failed",
  STAMP_FAILED: "tool-failed",
  BATCH_UNREADABLE: "tool-failed",
  PARTIAL: "tool-failed",
  HITL_PARKED: "needs-person",
  PR_NOT_OPEN: "scope",
};

/** The closing report's cause for a stall held by `state`. */
export function finishCause(state: string): ReportCause {
  return FINISH_CAUSES[state] ?? "unknown";
}
