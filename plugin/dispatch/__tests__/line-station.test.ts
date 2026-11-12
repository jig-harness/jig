/**
 * Every need on the line carries a framed decision: the one its pass
 * recorded with its result, else one the tick frames from the facts its
 * action holds, answered through its station; a cause the tick has no step
 * for keeps its free text.
 */
import { describe, expect, it } from "bun:test";
import { decisionDigest } from "../../shared/decisions/digest.ts";
import type { ParkedDecision } from "../../shared/decisions/park.ts";
import { buildLine } from "../lib/line.ts";
import type { Action } from "../lib/types.ts";
import type { WorkLinks } from "../lib/work-links.ts";
import { input, PATH, report } from "./line-fixtures.ts";

function need(action: Partial<Action> & Pick<Action, "cause" | "target">) {
  return {
    stage: "notify" as const,
    record: "forge" as const,
    reason: "a reason in words",
    evidence: {},
    ...action,
  };
}

function lineOf(
  actions: Action[],
  fields: { links?: WorkLinks; adapter?: string } = {},
) {
  return buildLine(
    input({
      reports: [report({ actions })],
      inputs: new Map([
        [
          PATH,
          {
            drives: [],
            known: [],
            sessions: { ok: true, source: "test", workspaces: [] },
            ...(fields.links === undefined ? {} : { links: fields.links }),
            ...(fields.adapter === undefined
              ? {}
              : { tracker: { adapter: fields.adapter } }),
          },
        ],
      ]),
    }),
  );
}

const SESSION: ParkedDecision = {
  schema: "parked-decision/v1",
  class: "scope",
  call: {
    id: "a",
    question: "Should the export keep the old column?",
    options: [
      {
        id: "keep",
        name: "Keep it",
        summary: "The column stays.",
        pay: ["A wider export."],
      },
      {
        id: "drop",
        name: "Drop it",
        summary: "The column goes.",
        pay: ["Readers of it break."],
      },
    ],
    recommended: "keep",
    why: "Readers of the column still exist.",
  },
  steps: [],
  alreadyDone: "The scouts ran.",
};

describe("a need's framed decision", () => {
  it("frames a failed follow-up the tick found, answered on its pull request through the follow-up station", () => {
    const line = lineOf([
      need({
        cause: "followup-failed",
        target: "PR #12",
        evidence: {
          marker: 41,
          record: "20261112T101301Z-33c6fa5f",
          stewardAct: "Investigate",
          stewardAsk: "Please find out why it ended.",
        },
      }),
    ]);
    const [shown] = line.needs;
    expect(shown?.act).toBe("Decide");
    expect(shown?.question).toBe("Please find out why it ended.");
    const [decision] = shown?.decisions ?? [];
    expect(decision).toMatchObject({
      key: "followup",
      kind: "finding",
      decisionClass: "followup-recovery",
      question: "How should the follow-up of PR #12 go on?",
      answer: {
        station: "followup",
        address: "followup@example-org/web#12",
        on: "pull-request",
        framedBy: "dispatcher",
      },
    });
    expect(decision?.options?.map((o) => [o.name, o.number])).toEqual([
      ["Run it again", 1],
      ["Record it done", 2],
      ["Leave it to me", 3],
    ]);
    expect(decision?.digest).toBe(
      decision?.decision === undefined
        ? "none"
        : decisionDigest(decision.decision),
    );
  });

  it("keeps the same digest from one tick to the next while the facts stand", () => {
    const action = need({
      cause: "followup-failed",
      target: "PR #12",
      evidence: { marker: 41, record: "20261112T101301Z-33c6fa5f" },
    });
    const first = lineOf([action]).needs[0]?.decisions[0]?.digest;
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(lineOf([{ ...action }]).needs[0]?.decisions[0]?.digest).toBe(first);
  });

  it("shows the decision a follow-up's pass framed in place of the tick's", () => {
    const line = lineOf([
      need({
        cause: "followup-failed",
        target: "PR #12",
        evidence: {
          marker: 41,
          record: "r",
          question: "Should the export keep the old column?",
        },
        framed: {
          decision: SESSION,
          digest: decisionDigest(SESSION),
          at: "2026-11-12T10:00:00.000Z",
        },
      }),
    ]);
    const [decision] = line.needs[0]?.decisions ?? [];
    expect(line.needs[0]?.act).toBe("Decide");
    expect(decision).toMatchObject({
      key: "followup",
      kind: "finding",
      digest: decisionDigest(SESSION),
      parkedAt: "2026-11-12T10:00:00.000Z",
      question: "Should the export keep the old column?",
      decisionClass: "scope",
      answer: { station: "followup", framedBy: "session" },
    });
  });

  it("frames a stalled pickup by whether an open pull request carries the item, answered where the items live", () => {
    const stalled = need({
      cause: "stalled",
      target: "#513",
      record: "tracker",
      evidence: { state: "In Progress" },
    });
    const links = (prs: number[]): WorkLinks => ({
      itemsOf: () => null,
      prsOf: () => prs.map((n) => ({ number: n, url: `u/${n}` })),
    });
    const free = lineOf([stalled], { links: links([]), adapter: "github" })
      .needs[0]?.decisions[0];
    expect(free?.recommendation).toStartWith("Release the claim:");
    expect(free?.answer).toMatchObject({
      station: "pickup",
      address: "pickup@example-org/web#513",
      on: "issue",
    });
    const carried = lineOf([stalled], {
      links: links([793]),
      adapter: "linear",
    }).needs[0]?.decisions[0];
    expect(carried?.recommendation).toStartWith("Leave it to me:");
    expect(carried?.answer?.on).toBe("tracker");
  });

  it("frames a checkout an unlisted tree holds by the stage that waits on it", () => {
    const line = lineOf([
      need({
        cause: "needs-person",
        target: "PR #879",
        record: "runtime",
        evidence: {
          stage: "followup",
          holder: "/srv/work/web-plan",
          branch: "docs/plan",
          busy: "processes 1, 2 have their working directory in it",
        },
      }),
    ]);
    expect(line.needs[0]?.decisions[0]).toMatchObject({
      key: "checkout",
      decisionClass: "checkout-recovery",
      answer: { station: "followup", address: "followup@example-org/web#879" },
    });
    expect(line.needs[0]?.decisions[0]?.options?.map((o) => o.name)).toEqual([
      "Detach the checkout",
      "Leave it to me",
    ]);
  });

  it("frames a drive handed to a person, and a stuck launch record, each through its own key", () => {
    const line = lineOf([
      need({
        cause: "needs-person",
        target: "PR #5376",
        evidence: { exit: 1, started: "2026-11-10T09:00:00.000Z" },
      }),
      need({
        cause: "needs-person",
        target: "#12",
        record: "runtime",
        evidence: {
          record: "20261110T151827Z-f17108e4",
          stage: "pickup",
          stuck: "both launches unanswered",
        },
      }),
    ]);
    expect(
      line.needs.map((n) => [
        n.act,
        n.decisions[0]?.key,
        n.decisions[0]?.answer?.address,
      ]),
    ).toEqual([
      ["Decide", "drive", "drive@example-org/web#5376"],
      ["Decide", "launch", "pickup@example-org/web#12"],
    ]);
  });

  it("frames a pickup's unframed question, and shows a framed one as its pass wrote it", () => {
    const asked = need({
      cause: "pickup-question",
      target: "#604",
      record: "runtime",
      evidence: {
        record: "20261112T071321Z-0c6b9be4",
        stage: "pickup",
        question: "Should #604 go in its own pull request?",
      },
    });
    const unframed = lineOf([asked]).needs[0]?.decisions[0];
    expect(unframed).toMatchObject({
      key: "pickup",
      decisionClass: "pickup-recovery",
    });
    const framed = lineOf([
      {
        ...asked,
        framed: {
          decision: SESSION,
          digest: decisionDigest(SESSION),
          at: "2026-11-12T10:00:00.000Z",
        },
      },
    ]).needs[0]?.decisions[0];
    expect(framed).toMatchObject({
      key: "pickup",
      decisionClass: "scope",
      answer: { framedBy: "session" },
    });
  });

  it("leaves a need the tick has no step for in its free text", () => {
    const line = lineOf([
      need({ cause: "double-claim", target: "#12", record: "tracker" }),
    ]);
    expect(line.needs[0]?.decisions).toEqual([]);
    expect(line.needs[0]?.act).toBe("Investigate");
  });
});
