/**
 * A served queue whose items in progress were read keeps its claims known
 * when an item below it cannot be read: a started pickup's question still
 * reaches the line, its record is released or kept by the usual rule, and
 * its idle clock runs. Only a queue whose items in progress were not read
 * leaves the claims unknown, with a row naming what goes unchecked.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { ParkedDecision } from "../../shared/decisions/park.ts";
import { decisionDigest } from "../../shared/decisions/digest.ts";
import { recordsWanted, releaseEnded } from "../lib/actions/pickup-hold.ts";
import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import { buildLine } from "../lib/line.ts";
import type { PickupReads } from "../lib/pickup-reads.ts";
import { planPickups } from "../lib/plan-pickups.ts";
import { readPickups } from "../lib/sources/tracker.ts";
import { closeStateDb } from "../lib/state.ts";
import type { ClaimedItem, DispatchSection } from "../lib/types.ts";
import { input, PATH, REPO, report } from "./line-fixtures.ts";
import { issue } from "./served-fixtures.ts";

const people = [{ name: "Alex", forge: ["alex"], tracker: { github: "alex" } }];
const NOW = Date.parse("2026-11-18T09:00:00Z");
const HOUR = 3_600_000;
const QUESTION = "Should #8 target the launch cost now, or wait?";

const DECISION: ParkedDecision = {
  schema: "parked-decision/v1",
  class: "scope",
  call: {
    id: "a",
    question: QUESTION,
    options: [
      { id: "now", name: "Now", summary: "Target it now.", pay: [] },
      { id: "wait", name: "Wait", summary: "Wait and remeasure.", pay: [] },
    ],
    recommended: "wait",
    why: "The budget moves first.",
  },
  steps: [],
  alreadyDone: "The cost was measured.",
};

const started = (key: string): PoolIssue => ({
  ...issue(key),
  state: { id: "p", name: "in_progress", type: "started" },
});

/**
 * Alex's queue: #8 in progress, and #5 to start under the epic #1, which
 * reports open children whose listing comes back empty.
 */
function queue() {
  const store = new Map<string, unknown>();
  const cache: PickupReads = {
    get: <T>(k: string) => (store.get(k) as T) ?? null,
    set: (k, v) => {
      store.set(k, v);
    },
  };
  const epic = issue("#1", ["epic"], null);
  const task = issue("#5");
  const tracker = {
    adapter: "github",
    team: "example/repo",
    stateName: (s: string) => (s === "pr_open" ? null : s),
    assignUnassigned: async () => ({ assigned: true }),
    assignedIssues: async (_: string, states: string[]) =>
      states.includes("in_progress") ? [started("#8")] : [task],
    assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
    openChildren: async () => [],
    listRelations: async () => [],
    poolIssue: async (k: string) =>
      k === "#1" ? epic : k === "#8" ? started("#8") : issue(k),
    getIssue: async (k: string) => ({
      identifier: k,
      description: "",
      parent: k === "#5" ? { identifier: "#1" } : null,
    }),
  } as unknown as Tracker;
  return { tracker, cache };
}

function read(tracker: Tracker, cache: PickupReads) {
  return readPickups(
    () => tracker,
    { identity: null } as DispatchSection,
    undefined,
    { people, cache, nowMs: NOW, headroom: true },
  );
}

/** A pickup of `item` that claimed it and ended, on `question` when given. */
function ended(item: string, question: boolean): ReadRecord {
  return {
    record: {
      id: `20261118T074500Z-${item.slice(1)}`,
      account: "a",
      action: "pickup",
      repo: REPO,
      item,
      pr: null,
      workspace: null,
      createdAt: "2026-11-18T07:45:00.000Z",
      released: false,
      claimedItems: [item],
    } as unknown as LaunchRecord,
    state: {
      kind: "ended",
      exit: { at: "2026-11-18T08:45:00Z", code: 0, signal: null },
      process: null,
    },
    result: "failed",
    ...(question
      ? {
          framed: {
            decision: DECISION,
            digest: decisionDigest(DECISION),
            at: "2026-11-18T08:45:00.000Z",
          },
        }
      : {}),
  } as ReadRecord;
}

function plan(claimed: ClaimedItem[], launches: ReadRecord[]) {
  return planPickups({
    slug: REPO,
    section: {
      stalledAfterMs: HOUR / 2,
      blockedAfterMs: HOUR,
    } as DispatchSection,
    pickups: [],
    claimed,
    sessions: { ok: true, source: "test", workspaces: [] },
    launches,
    idleSince: new Map(claimed.map((c) => [c.key, NOW - 2 * HOUR])),
    nowMs: NOW,
  });
}

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-partial-claims-"));
  roots.push(dir);
  return dir;
}

describe("a served queue with an epic whose children cannot be read", () => {
  it("keeps the started item claimed, so its pickup's question is a need on the pickup station", async () => {
    const { tracker, cache } = queue();
    const reading = await read(tracker, cache);
    expect(reading.read.ok).toBe(true);
    expect(reading.unplaced).toContainEqual(
      expect.objectContaining({
        target: "#5",
        reason:
          "the parent reports open children but its children cannot be read",
      }),
    );
    expect(reading.partial).toBe(true);
    expect(reading.claimed?.map((c) => [c.key, c.served])).toEqual([
      ["#8", true],
    ]);

    const planned = plan(reading.claimed ?? [], [ended("#8", true)]);
    const asked = planned.actions.find((a) => a.cause === "pickup-question");
    expect(asked).toMatchObject({ target: "#8" });

    const line = buildLine(
      input({
        reports: [report({ actions: planned.actions })],
        inputs: new Map([
          [
            PATH,
            {
              drives: [],
              known: [],
              sessions: { ok: true, source: "test", workspaces: [] },
            },
          ],
        ]),
      }),
    );
    const need = line.needs.find((n) => n.target === "#8");
    expect(need?.decisions[0]).toMatchObject({
      key: "pickup",
      question: QUESTION,
      answer: { station: "pickup", address: `pickup@${REPO}#8` },
    });
  });

  it("runs the idle clock of a started item no session holds, and reports its stall", async () => {
    const { tracker, cache } = queue();
    const reading = await read(tracker, cache);
    const planned = plan(reading.claimed ?? [], [ended("#8", false)]);
    expect(planned.idleNow).toEqual(["#8"]);
    expect(planned.actions).toContainEqual(
      expect.objectContaining({ target: "#8", cause: "stalled" }),
    );
  });

  it("keeps a claimed item's record while it is claimed and releases it once it is back in the dispatch states", () => {
    const dir = stateDir();
    const record = ended("#8", true);
    releaseEnded(
      [record],
      REPO,
      new Set(),
      new Set(["#8"]),
      new Set(),
      dir,
      new Set(["#8"]),
      true,
    );
    expect(record.record.released).toBe(false);
    // A person moved it back to Todo: it is among the pickups again.
    releaseEnded(
      [record],
      REPO,
      new Set(["#8"]),
      new Set(),
      new Set(["#8"]),
      dir,
      new Set(),
      true,
    );
    expect(record.record.released).toBe(true);
  });

  it("keeps the record of an item the partial read left out, which a whole read releases", () => {
    const dir = stateDir();
    const unread = ended("#6", true);
    // A pickup that ended before it claimed its item.
    const unclaimed = { ...ended("#3", false), result: null };
    delete unclaimed.record.claimedItems;
    const records = [unread, unclaimed];
    const wanted = recordsWanted([], [], records);
    releaseEnded(
      records,
      REPO,
      wanted,
      new Set(),
      new Set(),
      dir,
      new Set(),
      true,
    );
    expect(records.map((r) => r.record.released)).toEqual([false, false]);
    releaseEnded(records, REPO, wanted, new Set(), new Set(), dir);
    expect(records.map((r) => r.record.released)).toEqual([true, true]);
  });
});

describe("a served queue whose items in progress were not read", () => {
  it("leaves the claims unknown and names the identity and what goes unchecked", async () => {
    const { tracker, cache } = queue();
    tracker.assignedIssues = async () => {
      throw new Error("queue timed out");
    };
    const reading = await read(tracker, cache);
    expect(reading.claimed).toBeNull();
    expect(reading.unplaced).toContainEqual({
      target: "the items alex claimed",
      record: "tracker",
      reason:
        "the items alex claimed could not be read, so stalls, double claims and the questions of started pickups are not checked: queue timed out",
    });
  });
});

describe("an item whose epic ancestry did not read", () => {
  it("makes the reading partial through readPickups, and keeps the claims known", async () => {
    const { tracker, cache } = queue();
    tracker.getIssue = (async () => null) as unknown as Tracker["getIssue"];
    const reading = await read(tracker, cache);
    expect(reading.partial).toBe(true);
    expect(reading.claimed).not.toBeNull();
  });
});
