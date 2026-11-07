/** Retain a termination witness while saved state or an unreleased CI hold needs it. */
import { swallow } from "../../../../shared/errors.ts";
import { readStateRow } from "./state/store.ts";
import { isUsableState } from "./state/schema.ts";

export function retainDriverWitness(stateDir: string, pr: string): boolean {
  // Keep the termination witness until a retained CI hold no longer needs it.
  const stored = readStateRow(stateDir, pr);
  if (stored !== null) {
    let state: unknown;
    try {
      state = JSON.parse(stored.text);
    } catch (err) {
      swallow(err, "unreadable state retains the driver termination witness");
      console.error(
        `ledger: PR #${pr}'s driver record is retained: saved state is unreadable.`,
      );
      return true;
    }
    if (!isUsableState(state, Number(pr))) {
      console.error(
        `ledger: PR #${pr}'s driver record is retained: saved state is unreadable.`,
      );
      return true;
    }
    return state.ciHold !== null && state.ciHold.phase !== "released";
  }
  return false;
}
