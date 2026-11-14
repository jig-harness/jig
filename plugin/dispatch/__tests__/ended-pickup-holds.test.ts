/**
 * What an ended pickup record still holds: a batch pass that claimed some of
 * its members holds only those, whatever its result, so the members it never
 * claimed are wanted again; an item an ended record holds with no rule to
 * release it is a framed need; and an epic's one-child slot is never given
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
import { planPickups } from "../lib/plan-pickups.ts";
import { closeStateDb } from "../lib/state.ts";
import type { DispatchSection, WantedItem } from "../lib/types.ts";

const SLUG = "example-org/example-repo";
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
function plan(pickups: string[], launches: ReadRecord[]) {
  return planPickups({
    slug: SLUG,
    section: { stalledAfterMs: 3_600_000 } as DispatchSection,
    pickups: pickups.map(wanted),
    claimed: [],
    sessions: { ok: true, source: "test", workspaces: [] },
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

  it("keeps every member of a batch that ended on a question, so the person answers it first", () => {
    const records = [endedBatch(["#923", "#924"], "failed", ["#923"])];
    const [read] = records;
    expect(read?.state.kind).toBe("ended");
    if (read?.state.kind === "ended")
      read.state.exit.said = "Question: should #924 follow #923's approach?\n";
    const next = plan(["#924"], records);
    expect(next.actions.filter((a) => a.stage === "pickup")).toEqual([]);
    expect(next.actions).toContainEqual(
      expect.objectContaining({ target: "#924", cause: "pickup-question" }),
    );
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
