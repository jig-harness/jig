/**
 * A drive armed after a stop whose next step is the drive's own: a stall
 * (`STALLED`, exit `14`), CI still red with its repair passes spent
 * (`CI_REPAIR_SPENT`, exit `21`), checks still failing on the infrastructure
 * after their re-runs (`CI_INFRA_PERSISTED`, exit `23`) or a pass deadline the driver did not
 * restart from (`PASS_DEADLINE`, exit `15`). The dispatcher re-drives each once per head
 * commit (the infrastructure stop once per stop, after a backoff), and a person
 * may re-arm any. The stop is the drive state's last
 * `stop` event, which the ledger carries to another clone, so the new drive
 * reads it wherever it runs.
 *
 * Its first pass is told the stop and, for a stall, what the stalled passes
 * recorded last, until one pass completes (`carriedNotice`). A stall or a
 * deadline that left work in the tree this drive is armed in (the stop
 * event's `leftWork` and `tree`, `stop-measure.ts`) hands that work on: the
 * tree's edits at arm count as the drive's to settle (`unpushed.ts`), where
 * edits found at arm are otherwise taken as a person's and left alone. A stop
 * that measured nothing, or one from another tree or host, hands on nothing:
 * the edits here are not its.
 */
import { resolveActor } from "./../state/actor.ts";
import { lastStopEvent } from "./../state/events.ts";
import { hostLabel } from "./../state/ledger-mirror.ts";
import type { DriveState } from "./../state/schema.ts";
import { recordedDecisions } from "./restart.ts";
import {
  CI_INFRA_PERSISTED_EXIT,
  CI_REPAIR_SPENT_EXIT,
  PASS_DEADLINE_EXIT,
  STALLED_EXIT,
} from "./settings.ts";

export interface StopPickup {
  /** What the first pass is told; `''` when the last stop was neither. */
  notice: string;
  /** The tree's edits at arm are the stopped drive's, to finish. */
  inheritsEdits: boolean;
}

/** The notices of a stop on a converged head's CI, by exit, given its round: the CI is the driver's to settle again, and the tree hands on nothing. */
const CI_STOPS: ReadonlyMap<number, (round: string) => string[]> = new Map([
  [
    CI_REPAIR_SPENT_EXIT,
    (round: string) => [
      `RE-ARMED AFTER THE CI-REPAIR BUDGET WAS SPENT: the drive before this one stopped with exit ${CI_REPAIR_SPENT_EXIT} (CI_REPAIR_SPENT) at round ${round}: the review had converged, and CI on its head still failed after its CI-repair passes.`,
      "This drive has its own CI-repair passes: work the round as usual, and the driver dispatches the repair once the review converges again.",
    ],
  ],
  [
    CI_INFRA_PERSISTED_EXIT,
    (round: string) => [
      `RE-ARMED AFTER AN INFRASTRUCTURE FAILURE PERSISTED: the drive before this one stopped with exit ${CI_INFRA_PERSISTED_EXIT} (CI_INFRA_PERSISTED) at round ${round}: the review had converged, and every failing check had failed on the infrastructure through its re-runs and head moves.`,
      "Nothing in the code needs repair for it: work the round as usual, and the driver re-runs the checks once the review converges again.",
    ],
  ],
]);

/** What a drive armed after `state`'s last stop hands its first pass. */
export async function stopPickup(
  pr: string,
  state: DriveState,
): Promise<StopPickup> {
  const stop = lastStopEvent(state.events ?? []);
  const code = stop === undefined ? null : Number(stop.cause);
  const ciStop = code === null ? undefined : CI_STOPS.get(code);
  if (ciStop !== undefined)
    return {
      notice: ciStop(String(stop?.round ?? "?")).join("\n"),
      inheritsEdits: false,
    };
  if (code !== STALLED_EXIT && code !== PASS_DEADLINE_EXIT)
    return { notice: "", inheritsEdits: false };
  const leftWork = stop?.leftWork === true;
  const here = stop?.tree === `${await resolveActor()}@${hostLabel()}`;
  const inherits = leftWork && here;
  if (code === PASS_DEADLINE_EXIT)
    return {
      notice: [
        `RE-ARMED AFTER A PASS DEADLINE: the drive before this one stopped with exit ${PASS_DEADLINE_EXIT} (PASS_DEADLINE) at round ${stop?.round ?? "?"}: its passes reached their deadline and the driver did not restart them again (drive.pass_deadline_retries).`,
        ...leftWorkLines(inherits, leftWork, stop?.tree),
        "Finish the round in smaller steps than the killed passes tried, so it ends inside the deadline.",
      ].join("\n"),
      inheritsEdits: inherits,
    };
  const decided = await recordedDecisions(pr);
  return {
    notice: [
      `RE-ARMED AFTER A STALL: the drive before this one stopped with exit ${STALLED_EXIT} (STALLED) at round ${stop?.round ?? "?"}: its passes changed nothing the driver could observe, for the stall threshold and one extra round.`,
      ...(decided.length === 0
        ? ["Its passes recorded nothing in the handoff narrative."]
        : [
            "What its passes recorded last (the end of the handoff narrative):",
            ...decided.map((line) => `  ${line}`),
          ]),
      ...leftWorkLines(inherits, leftWork, stop?.tree),
      "Find why those passes did not act, act on it, and if a step refuses and you stop, end the handoff narrative naming the step that refused and what would unblock it.",
    ].join("\n"),
    inheritsEdits: inherits,
  };
}

/** What the first pass is told of the work the stop left: this round's to finish here, another tree's to leave alone, or nothing. */
function leftWorkLines(
  inherits: boolean,
  leftWork: boolean,
  tree: string | undefined,
): string[] {
  if (inherits)
    return [
      "It left work in this tree: it is this round's to finish first (SKILL.md § 5, A tree the round inherits).",
    ];
  return leftWork
    ? [
        `It left work in another tree (${tree}), not this one: edits here are not its, so leave them alone.`,
      ]
    : [];
}
