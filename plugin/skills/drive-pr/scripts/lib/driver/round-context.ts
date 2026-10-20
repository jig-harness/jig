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
}
