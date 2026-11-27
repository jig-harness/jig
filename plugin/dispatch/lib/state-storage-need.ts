import {
  admissionTokenCheck,
  fixtureRegistryCheck,
  stateInodeCheck,
} from "../../shared/fixture-health.ts";
import type { DoctorCheck } from "../../runtime/component.ts";
import type { LineNeed } from "./dashboard-contract.ts";

/** Keep one dashboard need per failing state-storage check while it persists. */
export function stateStorageNeeds(
  checks: readonly DoctorCheck[],
  previous: readonly LineNeed[],
  now: string,
): LineNeed[] {
  return checks.flatMap((check): LineNeed[] => {
    const known = previous.find(
      (need) => need.cause === "state-storage" && need.target === check.id,
    );
    if (check.status !== "fail") return [];
    return [
      {
        cause: "state-storage",
        act: "Investigate",
        stage: "steer",
        repo: "host",
        target: check.id,
        title: "Jig state storage needs attention",
        reason:
          check.fix === undefined
            ? `${check.detail}.`
            : `${check.detail}. ${check.fix}.`,
        since: known?.since ?? now,
        question: null,
        pr: null,
        item: null,
        url: null,
        workspace: null,
        workspaces: [],
        decisions: [],
        notified: null,
      },
    ];
  });
}

export function readStateStorage(): DoctorCheck[] {
  return [stateInodeCheck(), fixtureRegistryCheck(), admissionTokenCheck()];
}
