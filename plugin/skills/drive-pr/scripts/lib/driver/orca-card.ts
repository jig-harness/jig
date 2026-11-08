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
import { TERMINAL_STATES } from "../status/terminal-states.ts";
import { readDriveState } from "./rearm.ts";

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

/** The failure stops a person settles, by state, with what each says. */
const FAILURE_STOPS: readonly (readonly [string, string])[] = [
  ["INDETERMINATE", "stopped on a failure; the drive's log says what failed"],
  [
    "UNSUPPORTED_CLI",
    "stopped: a usage error, or a gh that cannot report the pull request",
  ],
  ["MAX_ROUNDS", "used its round budget without converging"],
  ["REVIEWER_FAILED", "stopped: the posting reviewer's check did not pass"],
  [
    "REVIEW_SKIPPED",
    "stopped: the reviewer skipped its head and will not review it",
  ],
  [
    "PR_CONFLICTING",
    "stopped: it conflicts with its base and has nothing left to work",
  ],
  [
    "WORKTREE_UNCLEAN",
    "converged, but its worktree holds changes no round shipped",
  ],
  ["STALLED", "stalled: its passes changed nothing"],
  [
    "CI_REPAIR_SPENT",
    "stopped: CI still fails with its CI-repair passes spent",
  ],
  ["PASS_DEADLINE", "stopped: its passes kept running out of time"],
];

function exitOf(state: string): number | undefined {
  return TERMINAL_STATES[state]?.exitCode;
}

/** One line: newlines and runs of space collapsed. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

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
  if (code === exitOf("HITL_PARKED")) {
    const parked = state?.parked ?? [];
    const first = parked[0];
    if (first === undefined)
      return `PR #${pr} parked: a decision waits for a person (exit ${code})`;
    const more =
      parked.length > 1 ? ` (and ${parked.length - 1} more decisions)` : "";
    return `PR #${pr} parked: ${oneLine(first.reason)}${more}`;
  }
  if (code === exitOf("QUOTA_PARKED")) {
    const park = state?.quotaPark ?? null;
    const wall =
      park === null
        ? "a usage limit"
        : `a ${oneLine(park.vendor)} ${oneLine(park.window)}-window usage limit`;
    const reset = park?.resetAt == null ? "at an unknown time" : park.resetAt;
    return `PR #${pr} stopped on ${wall}, which resets ${reset} (exit ${code})`;
  }
  const failure = FAILURE_STOPS.find(([name]) => exitOf(name) === code);
  return failure === undefined
    ? null
    : `PR #${pr}'s drive ${failure[1]} (exit ${code})`;
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
