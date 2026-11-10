import { expect, test } from "bun:test";
import { buildLine } from "../lib/line.ts";
import { input, PATH, report } from "./line-fixtures.ts";
import type { Action, DrivenPr } from "../lib/types.ts";

const framed: Action = {
  stage: "notify",
  target: "PR #12",
  record: "forge",
  cause: "needs-person",
  reason: "Choose a file name.",
  evidence: { stewardAct: "Reply", stewardAsk: "Which file name?" },
};

test("the line shows the steward's act and ask", () => {
  const line = buildLine(input({ reports: [report({ actions: [framed] })] }));
  expect(line.needs[0]).toMatchObject({
    act: "Reply",
    question: "Which file name?",
  });
});

test("a parked registry decision retains its act and options", () => {
  const drive: DrivenPr = {
    number: 12,
    title: "Report",
    url: "https://forge.example/o/r/pull/12",
    head: "report",
    class: "parked",
    why: "legal decision",
    evidence: {},
    waiting: [
      {
        key: "legal",
        kind: "finding",
        lines: [
          "[finding] legal · class legal · parked at round 1",
          "  ## Question",
          "",
          "  Which license?",
          "  ## Options",
          "",
          "  - **A** Changes: use A. Costs: review.",
          "  - **B** Changes: use B. Costs: review.",
        ],
      },
    ],
  };
  const line = buildLine(
    input({
      reports: [report({ actions: [{ ...framed, cause: "parked" }] })],
      inputs: new Map([
        [
          PATH,
          {
            drives: [drive],
            known: [],
            sessions: { ok: true, source: "test", workspaces: [] },
          },
        ],
      ]),
    }),
  );
  expect(line.needs[0]?.act).toBe("Authorize");
  expect(line.needs[0]?.decisions[0]?.question).toBe("Which license?");
  expect(line.needs[0]?.decisions[0]?.options).toHaveLength(2);
});
