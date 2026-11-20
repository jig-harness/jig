/** The checks a launch makes on this host alone, before any tracker read. */
import { refreshWalls } from "../accounts.ts";
import { holdsBefore } from "../load.ts";
import type { Action, LaunchOutcome } from "../types.ts";
import { currentMs } from "../../../shared/time.ts";
import { admission } from "./admission.ts";
import { type ApplyState, loadKindOf, waits } from "./launch.ts";

/**
 * Why a launch waits on what this host can tell without asking anyone: no
 * account with a free slot for it, or a host load that holds it under
 * enforcement. Asked before a launch's fresh tracker reads, so a launch
 * these would hold spends none; it reserves nothing, and `admitAccount`
 * still judges a launch that passes. `null` when neither holds it.
 */
export function localHold(
  state: ApplyState,
  repo: string,
  action: Action,
  pickupDeadlineSec = 0,
): LaunchOutcome | null {
  refreshWalls(state.table, state.records, currentMs(), state.root);
  const admitted = admission(state, action, new Set(), pickupDeadlineSec);
  if ("waits" in admitted) return waits(action, admitted.waits);
  if (state.load === undefined) return null;
  const held = holdsBefore(
    state.load,
    loadKindOf(action),
    repo,
    action.target,
    pickupDeadlineSec * 1000,
  );
  return held === null
    ? null
    : waits(action, held, admitted.admitted.account.name);
}
