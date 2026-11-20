/**
 * The tracker's part of a tick carries a partial pickup read to the tick's
 * plan: `readTracker` marks the repository's tracked state partial while
 * the claimed items stay known, which is what keeps the plan from releasing
 * records or reporting the tracker complete.
 */
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { pool } from "../lib/pool.ts";
import { readTracker } from "../lib/tick-tracker.ts";
import type { DispatchSection } from "../lib/types.ts";
import { REPO, PATH, report } from "./line-fixtures.ts";
import { issue } from "./served-fixtures.ts";

const people = [{ name: "Alex", forge: ["alex"], tracker: { github: "alex" } }];
const started = (key: string): PoolIssue => ({
  ...issue(key),
  state: { id: "p", name: "in_progress", type: "started" },
});

function tracker(ancestry: boolean): Tracker {
  const epic = issue("#1", ["epic"], null);
  return {
    adapter: "github",
    team: "example/repo",
    stateName: (s: string) => (s === "pr_open" ? null : s),
    assignUnassigned: async () => ({ assigned: true }),
    assignedIssues: async (_: string, states: string[]) =>
      states.includes("in_progress") ? [started("#8")] : [issue("#5")],
    assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
    openChildren: async () => [],
    listRelations: async () => [],
    poolIssue: async (k: string) =>
      k === "#1" ? epic : k === "#8" ? started("#8") : issue(k),
    getIssue: async (k: string) =>
      ancestry
        ? {
            identifier: k,
            description: "",
            parent: k === "#5" ? { identifier: "#1" } : null,
          }
        : null,
  } as unknown as Tracker;
}

async function tick(prepared: Tracker) {
  const repo = { path: PATH, slug: REPO, defaultBranch: "main" };
  const root = mkdtempSync(join(tmpdir(), "jig-served-partial-"));
  try {
    return await readTracker(
      {
        values: {},
        repo,
        section: { identity: null } as DispatchSection,
        report: report(),
        where: "test",
        people,
        serveDefaults: undefined,
        nowMs: Date.parse("2026-11-18T09:00:00Z"),
        root,
        headroom: true,
        records: [],
        preparedTracker: prepared,
      },
      undefined,
      { budget: async () => ({}) as never, pool: pool(2) },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("marks the tracked state partial when an epic's children cannot be read, and keeps the claims known", async () => {
  const tracked = await tick(tracker(true));
  expect(tracked.partial).toBe(true);
  expect(tracked.claimed?.map((c) => c.key)).toEqual(["#8"]);
});

it("marks the tracked state partial when an item's ancestry cannot be read", async () => {
  const tracked = await tick(tracker(false));
  expect(tracked.partial).toBe(true);
  expect(tracked.claimed).not.toBeNull();
});
