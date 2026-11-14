/**
 * A pickup whose result the host could not write never raises the question
 * its pass stopped on: that question is about the dispatcher's own database
 * or host, whose health check reports the cause. While the check fails the
 * tick raises nothing for it; once it passes, a person is asked to settle or
 * release the item. Its end is logged as a stage that ended without a result.
 */
import { describe, expect, it } from "bun:test";
import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import { classifyEnded } from "../lib/log.ts";
import { planPickups } from "../lib/plan-pickups.ts";
import { parseMs } from "../../shared/time.ts";
import type { DispatchSection, WantedItem } from "../lib/types.ts";

const QUESTION = "should the dispatcher's schema be repaired?";
const ASKED = `Question: ${QUESTION}`;
const AT = "2026-11-14T11:40:00.000Z";

/** An ended pickup of #12 whose pass stopped on `ASKED` with no result; `unwritten` when the host could not write it. */
function stopped(unwritten: boolean): ReadRecord {
  const record = {
    id: "20261114T110000Z-cccccccc",
    token: "token",
    action: "pickup",
    repo: "example-org/example-repo",
    item: "#12",
    account: "a",
    createdAt: "2026-11-14T11:00:00.000Z",
    workspace: null,
    released: false,
  } as unknown as LaunchRecord;
  return {
    record,
    state: {
      kind: "ended",
      exit: { at: AT, code: 1, signal: null, said: ASKED, context: ASKED },
      process: null,
    },
    result: null,
    ...(unwritten ? { unwritten: AT } : {}),
  };
}

const ITEM: WantedItem = {
  key: "#12",
  title: "task",
  url: null,
  state: "Todo",
  assignee: "factory",
  assignedBy: "writer",
};

function plan(read: ReadRecord, rerunsHeld: string | null = null) {
  return planPickups({
    slug: "example-org/example-repo",
    section: { stalledAfterMs: 3_600_000 } as DispatchSection,
    pickups: [ITEM],
    claimed: [],
    sessions: { ok: true, source: "test", workspaces: [] },
    launches: [read],
    idleSince: new Map(),
    nowMs: parseMs("2026-11-14T12:00:00Z"),
    rerunsHeld,
  });
}

describe("a pickup whose result the host could not write", () => {
  it("never raises the question its pass stopped on, where a pass that wrote nothing on its own asks it", () => {
    expect(plan(stopped(false)).actions).toContainEqual(
      expect.objectContaining({
        stage: "notify",
        cause: "pickup-question",
        evidence: expect.objectContaining({ question: QUESTION }),
      }),
    );
    const [asked, ...rest] = plan(stopped(true)).actions.filter(
      (a) => a.stage === "notify",
    );
    expect(rest).toEqual([]);
    expect(asked?.evidence?.question).not.toBe(QUESTION);
    expect(asked?.reason).toContain("this host could not write it");
    expect(asked?.reason).toContain("settled or released");
  });

  it("raises nothing while the host's health check fails, its own need standing for it", () => {
    const held = plan(stopped(true), "the last tick exited 1");
    expect(held.actions.filter((a) => a.stage === "notify")).toEqual([]);
    expect(held.quiet).toContainEqual(
      expect.objectContaining({ target: "#12", class: "pickup-ended" }),
    );
  });

  it("is logged as a stage that ended without a result, not parked for a person", () => {
    const facts = { takenOver: false, merged: null };
    expect(classifyEnded(stopped(false), AT, facts).class).toBe(
      "parked for a person",
    );
    expect(classifyEnded(stopped(true), AT, facts)).toEqual({
      class: "died",
      reason: expect.stringContaining("this host could not write it"),
    });
  });
});
