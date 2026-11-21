/**
 * An assigned item with no priority: never a member of a served batch, and
 * held off the pickups as a labelling gap the line lists, unless the
 * repository's `dispatch.missing_priority` says to start it unranked.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planPickups } from "../lib/plan-pickups.ts";
import { batchPickups } from "../lib/queue-batch.ts";
import { dispatchSection } from "../lib/section.ts";
import type { Action, DispatchSection, WantedItem } from "../lib/types.ts";
import { issue } from "./served-fixtures.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A checkout whose label taxonomy has the size group a configured size store needs. */
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-missing-priority-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "label-taxonomy.yaml"),
    `version: 1
types:
  - id: task
statuses:
  - id: todo
groups:
  - id: size
    required: true
    labels:
      - id: small
`,
  );
  return dir;
}

const VALUES = {
  do_item: { agents: { codearea_areas: { "area:tools": "tools" } } },
};

/** A served item of the tools area with the given priority (0 = none). */
function served(key: string, priority: number): WantedItem {
  return {
    key,
    title: key,
    url: null,
    state: "Todo",
    assignee: "alex",
    assignedBy: "writer",
    servedPerson: "alex",
    queueIssue: { ...issue(key, ["area:tools"]), priority },
  };
}

function pickupOf(item: WantedItem): Action {
  return {
    stage: "pickup",
    target: item.key,
    record: "tracker",
    reason: "ready",
    evidence: { servedPerson: "alex" },
  };
}

describe("served batches", () => {
  const root = checkout();

  it("never take a member with no priority", () => {
    const items = [served("#1", 2), served("#2", 0), served("#3", 3)];
    const result = batchPickups(items.map(pickupOf), items, VALUES, root);
    const batched = result.flatMap((a) =>
      a.evidence.batchItems === undefined
        ? []
        : (JSON.parse(String(a.evidence.batchItems)) as { key: string }[]),
    );
    expect(batched.map((m) => m.key)).toEqual(["#1", "#3"]);
    expect(result.map((a) => a.target).sort()).toEqual(["#1", "#2"]);
  });

  it("form no batch when only one member has a priority", () => {
    const items = [served("#1", 2), served("#2", 0)];
    const result = batchPickups(items.map(pickupOf), items, VALUES, root);
    expect(result.map((a) => a.target)).toEqual(["#1", "#2"]);
    expect(result.every((a) => a.evidence.batchItems === undefined)).toBe(true);
  });
});

describe("an assigned item with no priority", () => {
  function plan(pickups: WantedItem[], section: Partial<DispatchSection> = {}) {
    return planPickups({
      slug: "example/repo",
      section: { identity: null, ...section } as DispatchSection,
      pickups,
      claimed: [],
      sessions: { ok: true, source: "fake", workspaces: [] },
      launches: [],
      idleSince: new Map(),
      nowMs: 1,
    });
  }

  it("is held as a labelling gap the line lists, not launched unranked", () => {
    const result = plan([served("#1", 2), served("#2", 0)]);
    expect(result.actions.map((a) => a.target)).toEqual(["#1"]);
    expect(result.unplaced).toEqual([
      expect.objectContaining({
        target: "#2",
        record: "tracker",
        title: "#2",
        url: null,
        reason: expect.stringContaining("no priority"),
      }),
    ]);
  });

  it("is held under an explicit hold", () => {
    const result = plan([served("#2", 0)], { missingPriority: "hold" });
    expect(result.actions).toEqual([]);
    expect(result.unplaced.map((u) => u.target)).toEqual(["#2"]);
  });

  it("starts unranked where the repository says start", () => {
    const result = plan([served("#2", 0)], { missingPriority: "start" });
    expect(result.actions.map((a) => a.target)).toEqual(["#2"]);
    expect(result.unplaced).toEqual([]);
  });

  it("starts when pulled forward for the item it blocks, which carries the rank", () => {
    const blocker = { ...served("#2", 0), blockingFor: "#1" };
    const result = plan([blocker]);
    expect(result.actions.map((a) => a.target)).toEqual(["#2"]);
  });

  it("starts when the tracker holds a priority the configuration does not map", () => {
    const item = served("#2", 0);
    if (item.queueIssue) item.queueIssue.unmappedFacets = ["priority"];
    const result = plan([item]);
    expect(result.actions.map((a) => a.target)).toEqual(["#2"]);
  });

  it("starts when its priority was not read", () => {
    const { queueIssue: _, ...unread } = served("#2", 0);
    const result = plan([unread]);
    expect(result.actions.map((a) => a.target)).toEqual(["#2"]);
  });
});

describe("dispatch.missing_priority", () => {
  it("defaults to hold", () => {
    const section = dispatchSection({});
    expect(section.ok && section.value.missingPriority).toBe("hold");
  });

  it("takes hold and start", () => {
    for (const mode of ["hold", "start"] as const) {
      const section = dispatchSection({
        dispatch: { missing_priority: mode },
      });
      expect(section.ok && section.value.missingPriority).toBe(mode);
    }
  });

  it("refuses any other value, naming the setting", () => {
    const section = dispatchSection({
      dispatch: { missing_priority: "low" },
    });
    expect(section.ok).toBe(false);
    if (!section.ok)
      expect(section.failure.reason).toContain("dispatch.missing_priority");
  });
});
