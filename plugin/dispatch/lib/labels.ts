/**
 * The pull request state labels as the dispatcher uses them: the shared
 * projection (`shared/pr-labels/projection.ts`), which the drive and the
 * follow-up write through too, with its exit codes bound to drive-pr's
 * terminal-state registry. The tick reads the commands and corrects every
 * state label that disagrees with its pull request's ledger; it alone
 * writes `stale` and `held`.
 *
 * Beside the set, the tick keeps marker labels that carry no prefix
 * (`pr-markers.ts`): the repository's manual-operations label on a pull
 * request that owes steps outside its code, and `automation` on a bot's.
 * They are not in the set: neither puts a pull request in scope.
 *
 * `actions/labels.ts` writes the changes.
 */
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import {
  type DoneExits,
  ledgerState,
  type Projected,
} from "../../shared/pr-labels/projection.ts";
import type { DrivenPr } from "./types.ts";

export {
  COMMANDS,
  type CommandName,
  carriesSet,
  commandLabel,
  DEFAULT_LABELS,
  hasCommand,
  type LabelChange,
  type LabelConfig,
  labelChange,
  labelSet,
  type LabelSpec,
  LONGEST_NAME,
  MAX_LABEL,
  PROJECTED_STATES,
  type Projected,
  type StateName,
} from "../../shared/pr-labels/projection.ts";

/** The exits a `done` ledger is read by, from the registry. */
export const DONE_EXITS: DoneExits = {
  converged: DRIVE_EXIT.CONVERGED,
  takenOver: DRIVE_EXIT.TAKEN_OVER,
};

/**
 * The state an open pull request's ledger maps to; `undefined` is a pull
 * request read for a ledger that carries none. A `done` ledger is
 * converged when it stopped `CONVERGED` (`0`) and driven by another clone
 * when it stopped `TAKEN_OVER` (`20`); one that stopped `PR_NOT_OPEN` (`5`)
 * on a pull request open again is left as it is.
 */
export function stateOf(drive: DrivenPr | undefined): Projected {
  return ledgerState(
    drive === undefined
      ? undefined
      : { class: drive.class, exit: drive.evidence.exit },
    DONE_EXITS,
  );
}
