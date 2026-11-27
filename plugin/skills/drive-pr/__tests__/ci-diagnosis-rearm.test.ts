/**
 * `diagnosedHeadStop` on a re-arm: a head whose recorded diagnosis handed it
 * to a person through a park gets one more repair once an answer has removed
 * that park, and stops again with `CI_REPAIR_SPENT` while the park is held.
 */
import { describe, expect, it } from "bun:test";

import { diagnosedHeadStop } from "../scripts/lib/driver/ci-diagnosis.ts";
import { CI_REPAIR_SPENT_EXIT } from "../scripts/lib/driver/settings.ts";
import { diagnosisPrefix, parkTag } from "../scripts/lib/state/ci-actions.ts";
import { HUMAN_DECISION_CLASS } from "../scripts/lib/state/rulings.ts";
import { type DriveState, freshState } from "../scripts/lib/state/schema.ts";

const HEAD = "b".repeat(40);
const FILING = "ci-diagnosis-filing";
const DIAGNOSIS = `${parkTag(FILING)}no issue filed (parked for a person). The local gate ran no tests.`;

const park = {
  key: FILING,
  kind: "finding" as const,
  reason: "File the recurring CI cause as a tracker issue",
  round: 1,
  at: "2026-11-20T10:05:00.000Z",
  class: HUMAN_DECISION_CLASS,
};

/** A drive state whose recorded diagnosis of HEAD named FILING, holding `parked`. */
function diagnosed(parked: DriveState["parked"]): DriveState {
  return {
    ...freshState(999),
    ciActions: [
      {
        at: "2026-11-20T10:06:00.000Z",
        round: 1,
        action: "repair",
        detail: `${diagnosisPrefix(HEAD)}${DIAGNOSIS}`,
      },
    ],
    parked,
  };
}

/** The stop on HEAD for `state`, with every outcome it records. */
async function stopFor(state: DriveState) {
  const recorded: string[] = [];
  const stop = await diagnosedHeadStop(
    { pr: "999" },
    HEAD,
    async () => state,
    async (_pr, _head, detail) => {
      recorded.push(detail);
      return true;
    },
  );
  return { stop, recorded };
}

describe("diagnosedHeadStop after the diagnosis park", () => {
  it("admits a repair once an answer has removed the park", async () => {
    const { stop, recorded } = await stopFor(diagnosed([]));
    expect(stop).toBeNull();
    expect(recorded).toEqual([]);
  });

  it("stops with CI_REPAIR_SPENT while the park is still held", async () => {
    const { stop, recorded } = await stopFor(diagnosed([park]));
    expect(stop).toBe(CI_REPAIR_SPENT_EXIT);
    expect(recorded).toEqual([DIAGNOSIS]);
  });

  it("admits the repair past an unrelated park, and stops on the diagnosis's own", async () => {
    // Only the diagnosis's own park admits the repair: an unrelated park left
    // after an answer removed the diagnosis's park does not stop it.
    const other = { ...park, key: "another-decision" };
    expect((await stopFor(diagnosed([other]))).stop).toBeNull();
    expect((await stopFor(diagnosed([other, park]))).stop).toBe(
      CI_REPAIR_SPENT_EXIT,
    );
  });
});
