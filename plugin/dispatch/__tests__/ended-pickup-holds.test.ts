/**
 * What an ended pickup record still holds: a batch pass that claimed some of
 * its members holds only those, whatever its result, so the members it never
 * claimed are wanted again; an item an ended record holds with no rule to
 * release it is a framed need; and a slot of an epic's width is never given
 * to a child an ended record keeps from starting.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  endedPassOver,
  pickupHold,
  recordsWanted,
  releaseEnded,
} from "../lib/actions/pickup-hold.ts";
import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import { leftBehindWorkspaces } from "../lib/actions/pickup-hold.ts";
import { planPickups } from "../lib/plan-pickups.ts";
import { stationContextOf, stationDecision } from "../lib/line-station.ts";
import type { Workspace } from "../lib/runtime/port.ts";
import { closeStateDb } from "../lib/state.ts";
import type { DispatchSection, WantedItem } from "../lib/types.ts";

const SLUG = "example-org/example-repo";
it("names a validation wait when a pickup ended without moving its item", () => {
  const launch = endedBatch(["#7"], "failed", []);
  launch.record.testLockWait = {
    pid: 12,
    workspace: "/work/w",
    since: "2026-11-12T17:00:00.000Z",
    observedAt: "2026-11-12T17:21:00.000Z",
    waiting: true,
  };
  const result = plan(["#7"], [launch]);
  expect(
    result.actions.find((a) => a.cause === "pickup-ended")?.reason,
  ).toContain("last seen waiting for the test lock for 21m");
});
const NOW = Date.parse("2026-11-14T12:00:00Z");

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-ended-holds-"));
  roots.push(dir);
  return dir;
}

/** An ended pickup of `members` (a batch when there are several) that recorded `result` and claimed `claimed`. */
function endedBatch(
  members: string[],
  result: "done" | "failed" | null,
  claimed: string[],
): ReadRecord {
  const record = {
    id: "2026-11-12T16-40-41-000Z-batch",
    account: "a",
    action: "pickup",
    repo: SLUG,
    item: members[0],
    pr: null,
    workspace: null,
    ...(members.length === 1
      ? {}
      : { batchItems: members.map((key) => ({ key })) }),
    createdAt: "2026-11-12T16:40:41.000Z",
    released: false,
    ...(claimed.length === 0 ? {} : { claimedItems: claimed }),
  } as unknown as LaunchRecord;
  return {
    record,
    state: {
      kind: "ended",
      exit: { at: "2026-11-12T17:22:00Z", code: 0, signal: null },
      process: null,
    },
    result,
  };
}

function wanted(key: string): WantedItem {
  return {
    key,
    title: `task ${key}`,
    url: null,
    state: "Backlog",
    assignee: "alex",
    assignedBy: "writer",
  };
}

/** One tick's pickup plan over `pickups`. */
function plan(
  pickups: string[],
  launches: ReadRecord[],
  workspaces: Workspace[] = [],
  claimed: string[] = [],
) {
  return planPickups({
    slug: SLUG,
    section: { stalledAfterMs: 3_600_000 } as DispatchSection,
    pickups: pickups.map(wanted),
    claimed: claimed.map((key) => ({ ...wanted(key), state: "In Progress" })),
    sessions: { ok: true, source: "test", workspaces },
    launches,
    idleSince: new Map(),
    nowMs: NOW,
  });
}

/** One tick's release, as the tick runs it after its plan, with `claimed` in progress. */
function release(
  records: ReadRecord[],
  pickups: string[],
  claimed: string[],
  dir: string,
) {
  releaseEnded(
    records,
    SLUG,
    recordsWanted(
      pickups.map((key) => ({ key })),
      [],
      records,
    ),
    new Set(claimed),
    new Set(pickups),
    dir,
  );
}

describe("a batch pickup that ended after claiming one member", () => {
  for (const result of ["done", "failed"] as const) {
    it(`leaves the members it never claimed wanted on the next tick when it recorded ${result}`, () => {
      const dir = root();
      const records = [endedBatch(["#923", "#924", "#925"], result, ["#923"])];
      const first = plan(["#924", "#925"], records);
      expect(
        first.actions.filter((a) => a.stage === "pickup").map((a) => a.target),
      ).toEqual(["#924", "#925"]);
      expect(first.actions.some((a) => a.stage === "notify")).toBe(false);
      // The claimed member is still in progress.
      release(records, ["#924", "#925"], ["#923"], dir);
      expect(records[0]?.record.releasedItems).toEqual(["#924", "#925"]);
      expect(records[0]?.record.released).toBe(false);
      // The claimed member keeps today's rule: its record still holds it.
      expect(pickupHold("#923", records).kind).toBe("ended");
      const next = plan(["#924", "#925"], records);
      expect(
        next.actions.filter((a) => a.stage === "pickup").map((a) => a.target),
      ).toEqual(["#924", "#925"]);
    });
  }

  for (const result of ["done", "failed"] as const) {
    it(`wants the anchor it left out for its own pickup when it recorded ${result}`, () => {
      const dir = root();
      const records = [
        endedBatch(["#464", "#713", "#715"], result, ["#713", "#715"]),
      ];
      const next = plan(["#464"], records);
      expect(
        next.actions.filter((a) => a.stage === "pickup").map((a) => a.target),
      ).toEqual(["#464"]);
      expect(next.actions.some((a) => a.stage === "notify")).toBe(false);
      release(records, ["#464"], ["#713", "#715"], dir);
      expect(records[0]?.record.releasedItems).toEqual(["#464"]);
    });
  }

  it("does not read the batch's workspace, still joined to the anchor it left out, as the anchor's session", () => {
    const records = [
      endedBatch(["#464", "#713", "#715"], "done", ["#713", "#715"]),
    ];
    const [read] = records;
    if (read !== undefined)
      read.record.workspace = { id: "w1", path: "/tree/batch" };
    const drive = {
      id: "w1",
      path: "/tree/batch",
      items: ["#464"],
      agents: [{ id: "a1", state: "working" }],
    } as unknown as Workspace;
    const next = plan(["#464"], records, [drive]);
    expect(
      next.actions.filter((a) => a.stage === "pickup").map((a) => a.target),
    ).toEqual(["#464"]);
    expect(next.running).toEqual([]);
  });

  it("gives the workspace back to the anchor once its own pickup ran there", () => {
    const [batch] = [endedBatch(["#464", "#713"], "done", ["#713"])];
    const [own] = [endedBatch(["#464"], "done", [])];
    if (batch === undefined || own === undefined) throw new Error("no record");
    batch.record.workspace = { id: "w1", path: "/tree/batch" };
    expect([...leftBehindWorkspaces("#464", [batch])]).toEqual(["/tree/batch"]);
    own.record.id = "2026-11-12T18-00-00-000Z-own";
    own.record.createdAt = "2026-11-12T18:00:00.000Z";
    own.record.workspace = { id: "w1", path: "/tree/batch" };
    expect([...leftBehindWorkspaces("#464", [batch, own])]).toEqual([]);
  });

  function questionedBatch(question: string): ReadRecord {
    const read = endedBatch(["#923", "#924", "#925"], "failed", ["#923"]);
    if (read.state.kind === "ended")
      read.state.exit.said = `Question: ${question}\n`;
    return read;
  }

  function questionTargets(keys: string[], records: ReadRecord[]): string[] {
    return plan(keys, records)
      .actions.filter((a) => a.cause === "pickup-question")
      .map((a) => a.target);
  }

  it("shows a batch question only on the member it names", () => {
    const read = questionedBatch("Should #924 follow the shared approach?");
    expect(questionTargets(["#923", "#924", "#925"], [read])).toEqual(["#924"]);
  });

  it("uses the report's affected member when it supersedes the trailing question", () => {
    const read = questionedBatch("Should #923 change its scope?");
    read.report = {
      at: "2026-11-12T17:23:00.000Z",
      by: "agent",
      report: {
        schema: "closing-report/v1",
        concluded: "A scope decision remains.",
        question: "Should #924 change its scope?",
        suggested_next: {
          step: "Decide the scope.",
          owner: "person",
          act: "Decide",
        },
      },
    };
    expect(questionTargets(["#923", "#924", "#925"], [read])).toEqual(["#924"]);
  });

  it("shows an unnamed batch question once on its anchor", () => {
    const read = questionedBatch(
      "Should the batch follow the shared approach?",
    );
    expect(questionTargets(["#925", "#924", "#923"], [read])).toEqual(["#923"]);
    read.record.releasedItems = ["#923"];
    expect(questionTargets(["#925", "#924", "#923"], [read])).toEqual([]);
  });

  it("does not move an old question to siblings when its owner parks on its own", () => {
    const batch = questionedBatch("Should #924 follow the shared approach?");
    const own = endedBatch(["#924"], "failed", ["#924"]);
    own.record.id = "2026-11-13T16-40-41-000Z-own";
    own.record.createdAt = "2026-11-13T16:40:41.000Z";
    if (own.state.kind === "ended")
      own.state.exit.said = "Question: Should this item change its scope?\n";
    expect(questionTargets(["#923", "#925"], [batch])).toEqual([]);
    const next = plan(["#923", "#924", "#925"], [batch, own]);
    expect(next.actions.filter((a) => a.cause === "pickup-question")).toEqual([
      expect.objectContaining({
        target: "#924",
        evidence: expect.objectContaining({
          record: own.record.id,
        }),
      }),
    ]);
    own.record.released = true;
    const claimed = plan(["#923", "#925"], [batch, own], [], ["#924"]);
    expect(
      claimed.actions.filter((a) => a.cause === "pickup-question"),
    ).toEqual([]);
  });

  it("offers a sibling a release for its own hold without reusing the question", () => {
    const read = questionedBatch("Should #924 change its scope?");
    const sibling = plan(["#925"], [read]).actions[0];
    expect(sibling).toMatchObject({
      target: "#925",
      cause: "pickup-ended",
      evidence: { record: read.record.id },
    });
    expect(sibling?.evidence.question).toBeUndefined();
    expect(sibling?.notice).toBeUndefined();
    expect(sibling?.framed).toBeUndefined();
    const decision = stationDecision(
      sibling as Parameters<typeof stationDecision>[0],
      stationContextOf(SLUG, { tracker: { adapter: "github" } }),
    );
    expect(decision).not.toBeNull();
    if (decision === null) return;
    expect(decision.answer).toMatchObject({
      station: "pickup",
      address: "pickup@example-org/example-repo#925",
    });
    expect(decision.decision).toBeDefined();
    if (decision.decision === undefined) return;
    expect(decision.decision.call.options.map((option) => option.id)).toContain(
      "release",
    );
  });

  it("does not recognize an HTML entity as a GitHub member key", () => {
    const read = questionedBatch("Should &#924; follow the shared approach?");
    expect(questionTargets(["#923", "#924", "#925"], [read])).toEqual(["#923"]);
  });

  it("keeps every member of a batch that claimed none, each a need for a person", () => {
    const records = [endedBatch(["#1043", "#1047"], "failed", [])];
    const next = plan(["#1043", "#1047"], records);
    expect(next.actions.filter((a) => a.stage === "pickup")).toEqual([]);
    expect(
      next.actions
        .filter((a) => a.cause === "pickup-ended")
        .map((a) => a.target),
    ).toEqual(["#1043", "#1047"]);
  });
});

describe("an item an ended pickup record holds", () => {
  it("raises one framed need naming the record, with the same notice key each tick", () => {
    const records = [endedBatch(["#493"], null, [])];
    const needs = [plan(["#493"], records), plan(["#493"], records)].map((p) =>
      p.actions.filter((a) => a.cause === "pickup-ended"),
    );
    for (const need of needs) expect(need).toHaveLength(1);
    expect(needs[0]?.[0]).toMatchObject({
      stage: "notify",
      target: "#493",
      evidence: {
        record: "2026-11-12T16-40-41-000Z-batch",
        stage: "pickup",
        ended: "its session exited, failed (no result recorded)",
      },
    });
    expect(needs[1]?.[0]?.notice?.key).toBe(needs[0]?.[0]?.notice?.key);
    expect(plan(["#493"], records).quiet).toEqual([]);
  });
});

describe("an epic's slot", () => {
  it("is passed over for a child an ended record holds, never for one free to start", () => {
    const records = [endedBatch(["#493"], null, [])];
    const passOver = endedPassOver(records, SLUG, NOW);
    expect(passOver({ identifier: "#493" })).toContain(
      "launch record 2026-11-12T16-40-41-000Z-batch ended",
    );
    expect(passOver({ identifier: "#373" })).toBeNull();
    // Another repository's record of the same key holds nothing here.
    expect(
      endedPassOver(records, "example-org/other", NOW)({ identifier: "#493" }),
    ).toBeNull();
  });
});
