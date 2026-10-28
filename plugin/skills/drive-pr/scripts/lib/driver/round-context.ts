/** State shared by the round coordinator and its phases. Mutations remain visible at the next gate. */
import type { FinalCiWait } from "./../final-ci-wait.ts";

import type { DriveLock } from "./locks.ts";

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
  mailboxCheckpoint: () => Promise<number | "resumed" | "clear">;
  held: DriveLock[];
  witnessWaitHead: string;
  witnessWaitLimit: number;
  maxRoundsN: number;
  /** Passes killed at their deadline this drive restarted from. */
  deadlineRetries: number;
  /** `drive.pass_deadline_retries`, read once at the start of the drive. */
  deadlineRetryBudget: number;
  /** The stall stop already granted its one extra round in this streak. */
  stallExtraRound: boolean;
  /**
   * What the next review pass is told about the stop the driver recovered
   * from (`$DRIVE_PR_PASS_NOTICE`), cleared once a pass is spawned with it.
   */
  passNotice: string;
}
