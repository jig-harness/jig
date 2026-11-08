/**
 * drive-pr suite: `parkRefusal` while the base branch's policy cannot be
 * read, when every decision parks under `human-decision`.
 */
import { describe, expect, it } from "bun:test";
import type { DriveState } from "../scripts/lib/state/schema.ts";
import { parkRefusal } from "../scripts/lib/state/rulings.ts";

const KEPT = ["escalated", "human-decision", "human-thread"];

function stateWith(ruling: Record<string, unknown>): DriveState {
  return {
    rulings: [{ key: "T1", round: 1, at: "2026-01-01T00:00:00Z", ...ruling }],
  } as unknown as DriveState;
}

describe("parkRefusal under an unreadable policy", () => {
  it("lets a surviving class or a non-escalate ruling park under human-decision", () => {
    for (const ruling of [
      { verdict: "escalate", class: "escalated" },
      { verdict: "escalate", class: "human-thread" },
      { verdict: "fix-now" },
    ])
      expect(
        parkRefusal(
          stateWith(ruling),
          "T1",
          "thread",
          "human-decision",
          KEPT,
          true,
        ),
      ).toBeNull();
  });

  it("still refuses them while the policy reads", () => {
    for (const ruling of [
      { verdict: "escalate", class: "escalated" },
      { verdict: "fix-now" },
    ])
      expect(
        parkRefusal(stateWith(ruling), "T1", "thread", "human-decision", KEPT),
      ).not.toBeNull();
  });
});
