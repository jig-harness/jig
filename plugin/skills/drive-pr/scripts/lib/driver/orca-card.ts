/**
 * The drive's moves of its Orca workspace card: to the in-review column, with
 * the pull request linked, when the drive marks the pull request Ready; and,
 * when the drive stops where a person must look (a park, a usage-limit stop,
 * a failure stop), the card marked unread with the stop's one-line reason as
 * its comment, which Orca's phone app shows. A converged drive, a merged or
 * closed pull request, a stop a person asked for and a drive another driver
 * holds or took over move nothing.
 *
 * The drive runs in the tree that holds the pull request, so the card is that
 * tree's (`shared/orca-board.ts` reads `orca worktree current`). Outside Orca
 * nothing is read or called, and every Orca failure only warns: the board is
 * a convenience and never changes the drive's exit.
 */
import { orcaCommand } from "../../../../../shared/orca.ts";
import {
  type BoardUpdate,
  updateBoard,
} from "../../../../../shared/orca-board.ts";
import type { DriveState } from "../state/schema.ts";
import { readDriveState } from "./rearm.ts";
import { exitOf, stopText } from "./stop-text.ts";

/** What a card move calls; tests replace both. */
export interface CardDeps {
  env: Record<string, string | undefined>;
  update: (update: BoardUpdate) => Promise<string>;
  readState: (pr: string) => Promise<DriveState | null>;
}

const liveDeps: CardDeps = {
  env: process.env,
  update: (update) => updateBoard(update),
  readState: readDriveState,
};

/** The failure stops a person settles, by state: each says what the registry's `report.stop` says. */
const FAILURE_STOPS: readonly string[] = [
  "INDETERMINATE",
  "UNSUPPORTED_CLI",
  "MAX_ROUNDS",
  "REVIEWER_FAILED",
  "REVIEW_SKIPPED",
  "PR_CONFLICTING",
  "WORKTREE_UNCLEAN",
  "STALLED",
  "CI_REPAIR_SPENT",
  "PASS_DEADLINE",
  "CHECK_RUNS_UNREADABLE",
];

/**
 * The comment a stop with exit `code` leaves on the card, or null when the
 * stop needs no person. `state` is the drive state, read for a park's
 * question and a usage limit's reset; null when it could not be read.
 */
export function stopComment(
  pr: string,
  code: number,
  state: DriveState | null,
): string | null {
  const settled =
    code === exitOf("HITL_PARKED") ||
    code === exitOf("QUOTA_PARKED") ||
    FAILURE_STOPS.some((name) => exitOf(name) === code);
  return settled ? stopText(pr, code, state) : null;
}

/** Report a card move's line; a failure is a warning, never a throw. */
async function move(deps: CardDeps, update: BoardUpdate): Promise<void> {
  try {
    console.error(await deps.update(update));
  } catch (error) {
    console.error(
      `orca-board: ⚠ the card was not updated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The drive marked `pr` Ready: the card moves to in-review, the pull request linked. */
export async function cardOnReady(
  pr: string,
  deps: CardDeps = liveDeps,
): Promise<void> {
  if (orcaCommand(deps.env) === null) return;
  await move(deps, { stage: "in-review", pr });
}

/** The drive stopped with exit `code`: a stop a person settles marks the card unread with its reason. */
export async function cardOnStop(
  pr: string,
  code: number,
  deps: CardDeps = liveDeps,
): Promise<void> {
  if (orcaCommand(deps.env) === null) return;
  const needsState =
    code === exitOf("HITL_PARKED") || code === exitOf("QUOTA_PARKED");
  let state: DriveState | null = null;
  if (needsState) {
    try {
      state = await deps.readState(pr);
    } catch (error) {
      console.error(
        `orca-board: the drive state could not be read for the card's comment (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  const comment = stopComment(pr, code, state);
  if (comment === null) return;
  await move(deps, { unread: true, comment });
}

/** The drive ended with exit `code`; a dry run, which drove nothing, moves no card. */
export async function cardAfterDrive(
  pr: string,
  code: number,
  dryRun: boolean,
): Promise<void> {
  if (!dryRun) await cardOnStop(pr, code);
}
