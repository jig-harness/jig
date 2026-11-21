import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changed,
  leftBehindBusy,
  pendingBatchBlock,
  servedAuthorization,
} from "../lib/actions/pickup.ts";
import { releaseEnded, pickupHold } from "../lib/actions/pickup-hold.ts";
import type { ApplyState } from "../lib/actions/launch.ts";
import type { PickupContext } from "../lib/actions/pickup.ts";
import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import { world, SLUG } from "./fixtures.ts";
import { earlierRecord, dispatchState } from "./launch-fixtures.ts";
const repo = { path: "/repo", slug: SLUG, defaultBranch: "main" };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function guards() {
  const root = mkdtempSync(join(tmpdir(), "batch-guards-"));
  roots.push(root);
  const issue = {
    identifier: "#2",
    title: "task",
    url: null,
    priority: 2,
    type: "task",
    size: "small",
    createdAt: "2026-01-01",
    updatedAt: "v1",
    state: { id: "s", name: "Todo", type: "unstarted" },
    assignee: { id: "alex", name: "alex" },
    labels: [],
    hasOpenChildren: false,
    truncated: [],
  };
  const ctx = {
    tracker: {
      adapter: "github",
      stateName: () => null,
      poolIssue: async () => issue,
      getIssue: async () => ({ ...issue, parent: null, description: "" }),
      listRelations: async () => [],
      user: async () => ({ id: "alex", name: "alex" }),
      assignedBy: async () => ({ trusted: true }),
    },
    sessions: async () => ({
      ok: true,
      workspaces: [
        {
          id: "rival",
          path: "/rival",
          items: ["#2"],
          agents: [{ id: "agent", state: "working" }],
        },
      ],
    }),
  } as unknown as PickupContext;
  const state = {
    root,
    records: [],
    machine: {
      serve: [{ name: "Alex", forge: ["alex"], tracker: { github: "alex" } }],
    },
  } as unknown as ApplyState;
  const record = {
    id: "own",
    item: "#1",
    servedPerson: "alex",
    batchItems: [
      { key: "#1", person: "alex" },
      { key: "#2", person: "alex" },
    ],
    workspace: { id: "own", path: "/own" },
  } as unknown as LaunchRecord;
  return { ctx, state, record };
}
it("holds a secondary item when another session appears before the batch launch", async () => {
  const { state, ctx } = guards();
  const result = await changed(state, repo, ctx, "#2", {
    servedPerson: "alex",
  });
  expect("why" in result).toBe(true);
});
it("starts a member the ended batch left out, though an agent runs in the workspace still joined to it", async () => {
  const { state, ctx } = guards();
  state.records = [
    {
      record: {
        id: "2026-11-09T00-00-00-000Z-batch",
        action: "pickup",
        repo: SLUG,
        item: "#2",
        released: false,
        createdAt: "2026-11-09T00:00:00.000Z",
        workspace: { id: "rival", path: "/rival" },
        batchItems: [{ key: "#2" }, { key: "#3" }, { key: "#4" }],
        claimedItems: ["#3", "#4"],
      } as unknown as LaunchRecord,
      state: {
        kind: "ended",
        exit: { at: "2026-11-09T01:00:00Z", code: 0, signal: null },
        process: null,
      },
      result: "done",
    } as ReadRecord,
  ];
  const result = await changed(state, repo, ctx, "#2", {
    servedPerson: "alex",
  });
  expect("why" in result ? result.why : null).toBeNull();
  // Its branch may still be checked out there: it then waits for that agent.
  expect(await leftBehindBusy(state, repo, ctx, "#2", "/rival")).toContain(
    "an agent is running",
  );
  expect(await leftBehindBusy(state, repo, ctx, "#2", "/fresh")).toBeNull();
});
it("refuses replay on a secondary competing session or a removed served person", async () => {
  const { state, ctx, record } = guards();
  expect(await pendingBatchBlock(state, repo, ctx, record)).toContain(
    "elsewhere",
  );
  expect(servedAuthorization(state, ctx, record, "#1")).toBeNull();
  state.machine.serve = [];
  expect(servedAuthorization(state, ctx, record, "#1")).toContain(
    "no longer served",
  );
});
it("releases an ended batch when its returned member is ready to retry", () => {
  const w = world();
  try {
    const record = earlierRecord(w, {
      id: "2026-11-09T00-00-00-000Z-test",
      account: "a",
      action: "pickup",
      pr: null,
      item: "#1",
      claimedSeen: true,
      batchItems: [
        { key: "#1", person: "alex" },
        { key: "#2", person: "alex" },
      ],
    });
    const read: ReadRecord = {
      record,
      state: {
        kind: "ended",
        exit: { at: "2026-11-09T00:00:00Z", code: 0, signal: null },
        process: null,
      },
      result: "failed",
    };
    releaseEnded(
      [read],
      SLUG,
      new Set(["#2"]),
      new Set(),
      new Set(["#2"]),
      dispatchState(w),
    );
    expect(record.released).toBe(true);
    expect(pickupHold("#2", [read]).kind).toBe("none");
  } finally {
    w.close();
  }
});

it("releases an unclaimed batch member once a sibling was claimed, and keeps the claimed one", () => {
  const w = world();
  try {
    const record = earlierRecord(w, {
      id: "2026-11-09T00-00-00-000Z-unclaimed-member",
      account: "a",
      action: "pickup",
      pr: null,
      item: "#1",
      batchItems: [
        { key: "#1", person: "alex" },
        { key: "#2", person: "alex" },
      ],
    });
    const read: ReadRecord = {
      record,
      state: {
        kind: "ended",
        exit: { at: "2026-11-09T00:00:00Z", code: 0, signal: null },
        process: null,
      },
      result: "failed",
    };
    for (let tick = 0; tick < 2; tick++)
      releaseEnded(
        [read],
        SLUG,
        new Set(["#2"]),
        new Set(["#1"]),
        new Set(["#2"]),
        dispatchState(w),
      );
    expect(record.claimedItems).toEqual(["#1"]);
    expect(record.releasedItems).toEqual(["#2"]);
    expect(record.released).toBe(false);
    expect(pickupHold("#2", [read]).kind).toBe("none");
    expect(pickupHold("#1", [read]).kind).toBe("ended");
  } finally {
    w.close();
  }
});
it("holds the unanswered members of a batch when one member is released alone", () => {
  const w = world();
  try {
    const record = earlierRecord(w, {
      id: "2026-11-09T00-00-01-000Z-test",
      account: "a",
      action: "pickup",
      pr: null,
      item: "#1",
      batchItems: [
        { key: "#1", person: "alex" },
        { key: "#2", person: "alex" },
      ],
    });
    const read: ReadRecord = {
      record,
      state: {
        kind: "ended",
        exit: { at: "2026-11-09T00:00:00Z", code: 0, signal: null },
        process: null,
      },
      result: "failed",
    };
    record.releasedItems = ["#1"];
    expect(pickupHold("#1", [read]).kind).toBe("none");
    expect(pickupHold("#2", [read]).kind).toBe("ended");
  } finally {
    w.close();
  }
});
