/**
 * A workspace whose terminals the runtime cannot report: it holds nothing
 * an agent it does report already holds, it names itself so a launch can
 * become a person's need, and a stopped pickup's need still reaches a
 * person through it while no fresh pickup starts beside it.
 */
import { describe, expect, it } from "bun:test";
import { holding } from "../lib/holding.ts";
import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import { planPickups } from "../lib/plan-pickups.ts";
import type { SessionsReport, Workspace } from "../lib/runtime/port.ts";
import type { DispatchSection, WantedItem } from "../lib/types.ts";

const SLUG = "example-org/example-repo";
const NOW = Date.parse("2026-11-14T12:00:00Z");
const REASON =
  "workspace /work/w-7 has 1 terminal(s) whose agents the runtime cannot report";

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "w-7",
    path: "/work/w-7",
    branch: "7-task",
    items: ["#7"],
    prs: [31],
    agents: [],
    unverifiableTerminals: 0,
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

const joined = (w: Workspace) => w.prs.includes(31);

describe("holding", () => {
  it("names the workspace whose terminals the runtime cannot report", () => {
    expect(
      holding(listed(workspace({ unverifiableTerminals: 1 })), joined),
    ).toEqual({ kind: "unknown", reason: REASON, workspace: "/work/w-7" });
  });

  it("names no workspace when the listing itself does not read", () => {
    expect(
      holding(
        { ok: false, source: "test", reason: "orca is not running" },
        joined,
      ),
    ).toEqual({ kind: "unknown", reason: "orca is not running" });
  });

  it("reads an agent the runtime reports working as running, beside a terminal it cannot report", () => {
    const busy = workspace({
      agents: [{ id: "a", agentType: "claude", state: "working", since: 0 }],
    });
    const held = holding(
      listed(busy, workspace({ id: "w-8", unverifiableTerminals: 2 })),
      joined,
    );
    expect(held).toEqual({ kind: "running", workspaces: [busy] });
  });
});

/** The ended single-item pickup of `key`, which claimed nothing and recorded `failed`. */
function endedPickup(key: string): ReadRecord {
  return {
    record: {
      id: "2026-11-12T16-40-41-000Z-pickup",
      account: "a",
      action: "pickup",
      repo: SLUG,
      item: key,
      pr: null,
      workspace: null,
      createdAt: "2026-11-12T16:40:41.000Z",
      released: false,
    } as unknown as LaunchRecord,
    state: {
      kind: "ended",
      exit: { at: "2026-11-12T17:22:00Z", code: 0, signal: null },
      process: null,
    },
    result: "failed",
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

function plan(launches: ReadRecord[], workspaces: Workspace[]) {
  return planPickups({
    slug: SLUG,
    section: { stalledAfterMs: 3_600_000 } as DispatchSection,
    pickups: [wanted("#7")],
    claimed: [],
    sessions: listed(...workspaces),
    launches,
    idleSince: new Map(),
    nowMs: NOW,
  });
}

describe("a pickup whose workspace the runtime cannot vouch for", () => {
  it("still raises the need of a pickup that stopped", () => {
    const result = plan(
      [endedPickup("#7")],
      [workspace({ unverifiableTerminals: 1 })],
    );
    expect(result.unplaced).toEqual([]);
    expect(
      result.actions.map((a) => [a.stage, a.target, a.cause ?? null]),
    ).toEqual([["notify", "#7", "pickup-ended"]]);
  });

  it("starts no fresh pickup, and says why", () => {
    const result = plan([], [workspace({ unverifiableTerminals: 1 })]);
    expect(result.actions).toEqual([]);
    expect(result.unplaced).toEqual([
      { target: "#7", record: "runtime", reason: REASON },
    ]);
  });
});
