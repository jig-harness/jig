/**
 * How each pass's `finish-round.ts` ended, kept in the drive's state
 * directory as `drive-pr-<PR>.round-finish.json` for the driver's stall stop
 * (`driver/round-budget.ts`): a stall whose passes all ended on the same
 * state names that state and its reason, so whoever reads the stop starts
 * from what held the rounds. Only a drive's pass records one (the driver
 * hands it `DRIVE_PR_ROUND`); the newest few are kept.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ReportCause } from "../../../../../shared/closing-report.ts";
import { readBoundedText } from "../../../../../shared/driver-report.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { currentIso, parseMs } from "../../../../../shared/time.ts";
import type { Report } from "../finish-round-report.ts";
import { atomicWrite } from "./fsutil.ts";
import { resolveStateDir } from "./store.ts";

export const ROUND_FINISH_SCHEMA = "drive-round-finish/v1";

/** How many finishes the file keeps, newest last. */
const KEPT = 16;

/** The most bytes of the file read: the kept finishes at their longest, with room to spare. */
const FILE_BYTE_LIMIT = 128 * 1024;

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
    const text = readBoundedText(file, FILE_BYTE_LIMIT);
    if (text === null) {
      swallow(new Error("too large"), "the round finishes are too large");
      return [];
    }
    const value: unknown = JSON.parse(text);
    if (
      !isRecord(value) ||
      value.schema !== ROUND_FINISH_SCHEMA ||
      String(value.pr) !== pr ||
      !Array.isArray(value.finishes)
    ) {
      swallow(
        new Error(`${file} is not ${ROUND_FINISH_SCHEMA} for PR #${pr}`),
        "the round finishes do not read",
      );
      return [];
    }
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

/** The cause class each `finish-round.ts` state other than `FINISHED` takes. */
const FINISH_CAUSES: Readonly<
  Record<Exclude<Report["state"], "FINISHED">, ReportCause>
> = {
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

/** The closing report's cause for a stall held by `state`; `unknown` for a state this release does not know. */
export function finishCause(state: string): ReportCause {
  return Object.hasOwn(FINISH_CAUSES, state)
    ? FINISH_CAUSES[state as keyof typeof FINISH_CAUSES]
    : "unknown";
}

/** The recorder of a finish that is not a drive pass's, or whose directory is unresolved. */
function noRecord(): void {
  // Nothing is kept for the stall stop.
}

/**
 * What `finish-round.ts` calls as it ends: records the finish for the stall
 * stop when this is a drive's pass for `pr`, and does nothing otherwise or
 * when the state directory cannot be resolved or written.
 */
export async function roundFinishRecorder(
  pr: string,
): Promise<(finish: Pick<RoundFinish, "state" | "reason" | "head">) => void> {
  const round = process.env.DRIVE_PR_ROUND ?? "";
  if (!/^\d+$/.test(round) || process.env.DRIVE_PR_TARGET !== pr)
    return noRecord;
  let stateDir: string;
  try {
    stateDir = process.env.DRIVE_PR_STATE_DIR || (await resolveStateDir());
  } catch (error) {
    swallow(error, "the state directory for the round's finish is unresolved");
    return noRecord;
  }
  return (finish) => {
    try {
      recordRoundFinish(stateDir, pr, {
        ...finish,
        round: Number(round),
        at: currentIso(),
      });
    } catch (error) {
      swallow(error, "the round's finish was not recorded for the stall stop");
    }
  };
}
