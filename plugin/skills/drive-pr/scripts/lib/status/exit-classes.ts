/**
 * How a stopped drive ledger reads by its exit: the one table both the
 * dispatcher's ledger classifier (`dispatch/lib/sources/ledgers.ts`) and the
 * drive's own state label (`lib/driver/state-labels.ts`) read, so the two
 * never disagree on what a stop means.
 *
 * Each exit has the class its ledger takes when nothing about the pull
 * request changes it, and whether the dispatcher reads the pull request to
 * decide (`readsPr`): a converged stop is stale once the head moved or the
 * pull request conflicts, a park is re-armable once every item is answered,
 * a stop the dispatcher re-drives is placed by its head. An exit this table
 * does not name is a stop only a person settles (`needs-person`), and a
 * recorded person's stop (`drives.ts --stop`, a mailbox stop) reads as
 * `stopped-by-person` whatever its exit.
 *
 * The drive writes its state from the same class, except that it never
 * writes `stale`: where the dispatcher would re-drive a stop, the drive
 * labels it `parked`, since without a dispatcher a person is the one who
 * acts, and a dispatcher's tick replaces it with `stale` where one runs.
 */
import type { LedgerClass } from "../../../../../shared/pr-labels/projection.ts";
import { DRIVE_EXIT, type DriveExitName } from "./terminal-states.ts";

/** A stopped ledger's class by its exit, and whether the dispatcher reads the pull request to place it. */
export interface ExitClass {
  class: LedgerClass;
  readsPr: boolean;
}

const fixed = (c: LedgerClass): ExitClass => ({ class: c, readsPr: false });
const readsPr = (c: LedgerClass): ExitClass => ({ class: c, readsPr: true });

/** Every exit `drive.ts` ends with, by its registry name. */
const BY_NAME: Record<DriveExitName, ExitClass> = {
  CONVERGED: readsPr("done"),
  INDETERMINATE: readsPr("needs-person"),
  UNSUPPORTED_CLI: fixed("needs-person"),
  NOT_SETTLED: fixed("re-armable"),
  PR_NOT_OPEN: fixed("done"),
  MAX_ROUNDS: fixed("needs-person"),
  REVIEWER_FAILED: fixed("needs-person"),
  HITL_PARKED: readsPr("parked"),
  PR_CONFLICTING: readsPr("stale"),
  REVIEW_SKIPPED: fixed("needs-person"),
  SINGLE_INSTANCE_LOCK: fixed("refused"),
  WORKTREE_UNCLEAN: readsPr("stale"),
  DRIVE_HELD_BY_OTHER_WORKTREE: fixed("refused"),
  STALLED: readsPr("stale"),
  PASS_DEADLINE: readsPr("stale"),
  QUOTA_PARKED: fixed("re-armable"),
  MAILBOX_STOPPED: fixed("stopped-by-person"),
  MAILBOX_PAUSE_TIMEOUT: fixed("stopped-by-person"),
  TAKEN_OVER: fixed("done"),
  CI_REPAIR_SPENT: readsPr("stale"),
  CI_INFRA_PERSISTED: readsPr("stale"),
};

const BY_CODE: ReadonlyMap<number, ExitClass> = new Map(
  (Object.keys(BY_NAME) as DriveExitName[]).map((name) => [
    DRIVE_EXIT[name],
    BY_NAME[name],
  ]),
);

const PERSON: ExitClass = fixed("needs-person");

/** How a ledger that stopped with `exit` reads; an exit the registry does not name is a person's. */
export function exitClass(exit: number): ExitClass {
  return BY_CODE.get(exit) ?? PERSON;
}

/**
 * The class the drive labels its stop by: the table's, a recorded person's
 * stop as `stopped-by-person`, and a stop the dispatcher would re-drive
 * (`stale`) as `needs-person`.
 */
export function driveStopClass(
  exit: number,
  byPerson: boolean,
): { class: LedgerClass; exit: number } {
  if (byPerson) return { class: "stopped-by-person", exit };
  const read = exitClass(exit).class;
  return { class: read === "stale" ? "needs-person" : read, exit };
}
