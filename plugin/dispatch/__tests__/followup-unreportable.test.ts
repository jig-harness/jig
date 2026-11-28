/**
 * A merged pull request's follow-up beside a workspace whose terminals the
 * runtime cannot report: a person's need on the line naming the workspace
 * and what clears it, never a pull request left only under `unplaced`. A
 * follow-up beside an agent the runtime reports working still waits, and
 * one whose listing did not read at all stays unplaced.
 */
import { describe, expect, it } from "bun:test";
import { buildLine } from "../lib/line.ts";
import { type PlanInput, planTick } from "../lib/plan.ts";
import type { SessionsReport, Workspace } from "../lib/runtime/port.ts";
import type { MarkedPr } from "../lib/types.ts";
import { SLUG } from "./fixtures.ts";
import { input as lineInput, PATH, report } from "./line-fixtures.ts";
import { planInput } from "./plan-input-fixtures.ts";

const NOW = Date.parse("2026-11-23T13:37:00Z");
const WORKSPACE = "/work/merged-5";
const REASON = `workspace ${WORKSPACE} has 2 terminal(s) whose agents the runtime cannot report`;

const merged: MarkedPr = {
  number: 5,
  url: `https://github.com/${SLUG}/pull/5`,
  title: "Pull request 5",
  head: "feature/5",
  mergedAt: "2026-11-22T09:00:00Z",
  markers: [],
};

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "w-5",
    path: WORKSPACE,
    branch: "feature/5",
    items: [],
    prs: [5],
    agents: [],
    unverifiableTerminals: 2,
    comment: "",
    unread: null,
    name: "",
    ...over,
  };
}

const listed = (...workspaces: Workspace[]): SessionsReport => ({
  ok: true,
  source: "test",
  workspaces,
});

const plan = (sessions: SessionsReport) =>
  planTick(
    planInput(NOW, { merged: [merged], sessions } satisfies Partial<PlanInput>),
  );

describe("a merged pull request's follow-up beside unreportable terminals", () => {
  it("is a person's need naming the workspace and how to clear it, not an unplaced row", () => {
    const result = plan(listed(workspace()));
    expect(result.unplaced).toEqual([]);
    expect(result.actions.filter((a) => a.stage === "followup")).toEqual([]);
    const [need, ...rest] = result.actions.filter((a) => a.target === "PR #5");
    expect(rest).toEqual([]);
    expect(need).toMatchObject({
      stage: "notify",
      cause: "needs-person",
      evidence: { workspace: WORKSPACE, unreportedSessions: REASON },
    });
    expect(need?.reason).toContain("no follow-up marker");
    expect(need?.reason).toContain(REASON);
    expect(need?.notice?.key).toContain(WORKSPACE);
    expect(need?.notice?.text).toContain(
      `Close the terminals in ${WORKSPACE} that run no agent`,
    );
    expect(need?.notice?.text).toContain("/followup 5");
  });

  it("reaches the line's needs", () => {
    const { actions } = plan(listed(workspace()));
    const line = buildLine(
      lineInput({
        inputs: new Map([
          [PATH, { drives: [], known: [], sessions: listed(workspace()) }],
        ]),
        reports: [report({ actions })],
      }),
    );
    expect(line.needs).toEqual([
      expect.objectContaining({
        cause: "needs-person",
        stage: "followup",
        target: "PR #5",
        workspace: WORKSPACE,
        reason: expect.stringContaining(REASON),
      }),
    ]);
    // No drive's decision: re-arming a merged pull request's drive settles nothing here.
    expect(line.needs[0]?.decisions).toEqual([]);
    expect(JSON.stringify(line.needs[0])).not.toContain("stopped drive");
  });

  it("still does not start beside an agent the runtime reports working", () => {
    const busy = workspace({
      id: "w-6",
      path: "/work/merged-5-agent",
      unverifiableTerminals: 0,
      agents: [{ id: "a", agentType: "claude", state: "working", since: 0 }],
    });
    const result = plan(listed(busy, workspace()));
    expect(result.actions.filter((a) => a.target === "PR #5")).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ target: "PR #5", stage: "followup" }),
    ]);
  });

  it("stays unplaced while the listing itself does not read", () => {
    const result = plan({
      ok: false,
      source: "test",
      reason: "orca is not running",
    });
    expect(result.actions.filter((a) => a.target === "PR #5")).toEqual([]);
    expect(result.unplaced).toEqual([
      expect.objectContaining({
        target: "PR #5",
        record: "runtime",
        reason: "orca is not running",
      }),
    ]);
  });

  it("starts the follow-up once no terminal it cannot report is left", () => {
    const result = plan(listed(workspace({ unverifiableTerminals: 0 })));
    expect(result.actions).toEqual([
      expect.objectContaining({ stage: "followup", target: "PR #5" }),
    ]);
  });
});
