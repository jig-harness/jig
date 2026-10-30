/** State shared by the round coordinator and its phases. Mutations remain visible at the next gate. */
import type { FinalCiWait } from "./../final-ci-wait.ts";

import type { DriveLock } from "./locks.ts";

import type { AccountIdentity } from "./../identity.ts";

export interface DriveRoundContext {
  passes: number;
  prevFingerprint: string | null;
  noopRounds: number;
  readyMarkFailures: number;
  conflictRepairs: number;
  pr: string;
  keepDraft: boolean;
  markedReadyThisRun: boolean;
  reGatedForStableMarkReadyOutcome: boolean;
  readyLeftToOtherDriver: boolean;
  readyFlippedToDraftBeforeRecord: boolean;
  finalCiWait: FinalCiWait;
  witnessWaits: number;
  ciRepairs: number;
  ciRepairBudget: number;
  dryRun: boolean;
  agent: string[];
  /**
   * The account the last review pass billed, resolved as it was spawned: a
   * wall that pass meets is that account's, whatever the credentials read
   * after it exits. `null` before the first spawn.
   */
  passIdentity: AccountIdentity | null;
  /**
   * The mailbox directives, at a checkpoint. `beforePass` is the last await
   * before a pass (review or repair) is spawned: a clear mailbox is then
   * followed by the ledger's claim check, so no pass replies beside a
   * successor however long the waits before it were.
   */
  mailboxCheckpoint: (opts?: {
    beforePass?: boolean;
  }) => Promise<number | "resumed" | "clear">;
  held: DriveLock[];
  witnessWaitHead: string;
  witnessWaitLimit: number;
  maxRoundsN: number;
  /** `drive.pass_deadline_retries`, read once at the start of the drive. */
  deadlineRetryBudget: number;
  /** The stall stop already granted its one extra round in this streak. */
  stallExtraRound: boolean;
  /**
   * What the next review pass is told about the stop the driver recovered
   * from (`$DRIVE_PR_PASS_NOTICE`): a killed pass, a stall. Cleared once a
   * pass is spawned with it.
   */
  passNotice: string;
  /**
   * What every pass is told until one completes: a takeover's reopened holds,
   * a re-arm's human answers. A pass killed before it acted must not lose
   * them, so it is cleared only when a pass exits 0.
   */
  carriedNotice: string;
  /**
   * The local HEAD a pass left work on that the PR head lacks: witnessed after
   * a pass killed at its deadline, and measured afresh before every gate
   * (`unpushed.ts`); `''` when there is none. Every gate is told it
   * (`drive-status.ts --inherited-head`).
   */
  inheritedHead: string;
  /**
   * What the next review pass is told about the work the last gate measured;
   * `''` when there was none. Recomputed before every gate.
   */
  unpushedNotice: string;
  /**
   * The tree's edits by content (`PassLeftovers.edits`) as the last gate
   * measured them, and as they stood before the last completed review pass
   * ran (the first gate's, until one completes): only edits that differ from
   * the latter were left by a pass and owe a round. `null` when unread.
   */
  uncommittedMeasured: string | null;
  uncommittedBeforePass: string | null;
}
