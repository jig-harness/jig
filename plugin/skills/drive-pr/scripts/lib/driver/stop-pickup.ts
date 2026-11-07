/**
 * A drive armed after a stop whose next step is the drive's own: a stall
 * (`STALLED`, exit `14`) or CI still red with its repair passes spent
 * (`CI_REPAIR_SPENT`, exit `21`). The dispatcher re-drives both once per head
 * commit, and a person may re-arm either. The stop is the drive state's last
 * `stop` event, which the ledger carries to another clone, so the new drive
 * reads it wherever it runs.
 *
 * Its first pass is told the stop and, for a stall, what the stalled passes
 * recorded last, until one pass completes (`carriedNotice`). A stall that
 * left work in its tree (the stop event's `leftWork`) hands that work on:
 * the tree's edits at arm count as the drive's to settle (`unpushed.ts`),
 * where edits found at arm are otherwise taken as a person's and left alone.
 */
import { lastStopEvent } from "./../state/events.ts";
import type { DriveState } from "./../state/schema.ts";
import { recordedDecisions } from "./restart.ts";
import { CI_REPAIR_SPENT_EXIT, STALLED_EXIT } from "./settings.ts";

export interface StopPickup {
  /** What the first pass is told; `''` when the last stop was neither. */
  notice: string;
  /** The tree's edits at arm are the stalled drive's, to finish. */
  inheritsEdits: boolean;
}

/** What a drive armed after `state`'s last stop hands its first pass. */
export async function stopPickup(
  pr: string,
  state: DriveState,
): Promise<StopPickup> {
  const stop = lastStopEvent(state.events ?? []);
  const code = stop === undefined ? null : Number(stop.cause);
  if (code === CI_REPAIR_SPENT_EXIT)
    return {
      notice: [
        `RE-ARMED AFTER THE CI-REPAIR BUDGET WAS SPENT: the drive before this one stopped with exit ${CI_REPAIR_SPENT_EXIT} (CI_REPAIR_SPENT) at round ${stop?.round ?? "?"}: the review had converged, and CI on its head still failed after its CI-repair passes.`,
        "This drive has its own CI-repair passes: work the round as usual, and the driver dispatches the repair once the review converges again.",
      ].join("\n"),
      inheritsEdits: false,
    };
  if (code !== STALLED_EXIT) return { notice: "", inheritsEdits: false };
  const decided = await recordedDecisions(pr);
  const leftWork = stop?.leftWork === true;
  return {
    notice: [
      `RE-ARMED AFTER A STALL: the drive before this one stopped with exit ${STALLED_EXIT} (STALLED) at round ${stop?.round ?? "?"}: its passes changed nothing the driver could observe, for the stall threshold and one extra round.`,
      ...(decided.length === 0
        ? ["Its passes recorded nothing in the handoff narrative."]
        : [
            "What its passes recorded last (the end of the handoff narrative):",
            ...decided.map((line) => `  ${line}`),
          ]),
      ...(leftWork
        ? [
            "It left work in this tree: it is this round's to finish first (SKILL.md § 5, A tree the round inherits).",
          ]
        : []),
      "Find why those passes did not act, act on it, and if a step refuses and you stop, end the handoff narrative naming the step that refused and what would unblock it.",
    ].join("\n"),
    inheritsEdits: leftWork,
  };
}
