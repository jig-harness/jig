/**
 * A need's notification on the line: a notice that waits or was lost carries
 * the tick's reason, which the dashboard and `jig ask --waiting` show; one
 * that went carries none.
 */
import { expect, it } from "bun:test";
import { buildLine } from "../lib/line.ts";
import type { Action, NotifyOutcome } from "../lib/types.ts";
import { input, report } from "./line-fixtures.ts";

const PARK: Action = {
  stage: "notify",
  target: "PR #456",
  record: "forge",
  reason: "drive ledger parked: a person answers",
  evidence: {},
  cause: "parked",
  notice: { key: "park-key", text: "the notice" },
};

function notifiedAs(
  outcome: NotifyOutcome["outcome"],
  detail: string,
): unknown {
  const line = buildLine(
    input({
      reports: [
        report({
          actions: [PARK],
          notifications: [
            {
              target: PARK.target,
              cause: "parked",
              key: "park-key",
              outcome,
              workspace: null,
              detail,
            },
          ],
        }),
      ],
    }),
  );
  return line.needs[0]?.notified;
}

it("carries why a notice waits or was lost, and nothing for one that went", () => {
  expect(notifiedAs("waits", "the comment is full")).toEqual({
    at: null,
    outcome: "waits",
    workspace: null,
    detail: "the comment is full",
  });
  expect(notifiedAs("lost", "the read-back did not confirm it")).toMatchObject({
    outcome: "lost",
    detail: "the read-back did not confirm it",
  });
  expect(notifiedAs("sent", "written")).toEqual({
    at: null,
    outcome: "sent",
    workspace: null,
  });
});
