/**
 * The late pickup-hold check reads every epic above an item: a hold placed
 * on a nested epic after the tick read its holds still stops the leaf, alone
 * or as a batch member, and a record an earlier release wrote with one
 * ancestor is still checked against it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { applyPickups, servedEvidence } from "../lib/actions/pickup.ts";
import {
  isLaunchRecord,
  type LaunchRecord,
  readRecord,
  writeRecord,
} from "../lib/launches.ts";
import {
  personPickupBlock,
  setPersonPickupHold,
} from "../lib/person-pickup-holds.ts";
import type { PickupReads } from "../lib/pickup-reads.ts";
import { planPickups } from "../lib/plan-pickups.ts";
import { ancestorsOf, batchItemsOf } from "../lib/queue-batch.ts";
import { readServedPickups } from "../lib/sources/served.ts";
import { closeStateDb } from "../lib/state.ts";
import type { ApplyState } from "../lib/actions/launch.ts";
import type { PickupContext } from "../lib/actions/pickup.ts";
import type { Action, DispatchSection } from "../lib/types.ts";
import { issue } from "./served-fixtures.ts";

const REPO = "example/repo";
const people = [{ name: "Alex", forge: ["alex"], tracker: { github: "alex" } }];
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-hold-ancestry-"));
  dirs.push(dir);
  return dir;
}

/** Root epic #1 → nested epic #2 → the leaves under it; `direct` are assigned leaves outside the epic. */
function nested(
  leaves: PoolIssue[],
  direct: PoolIssue[] = [],
  readsParents = true,
  waits: Record<string, string[]> = {},
  extra: { parents?: Record<string, string>; pool?: PoolIssue[] } = {},
) {
  const roots = [issue("#1", ["epic"]), ...direct];
  const children: Record<string, PoolIssue[]> = {
    "#1": [issue("#2", ["epic"], null)],
    "#2": leaves,
  };
  const parents: Record<string, string> = Object.fromEntries([
    ["#2", "#1"],
    ...leaves.map((l) => [l.identifier, "#2"]),
    ...Object.entries(extra.parents ?? {}),
  ]);
  const all = [
    ...roots,
    ...Object.values(children).flat(),
    ...(extra.pool ?? []),
  ];
  const store = new Map<string, unknown>();
  const cache: PickupReads = {
    get: <T>(k: string) => (store.get(k) as T) ?? null,
    set: (k, v) => {
      store.set(k, v);
    },
  };
  const tracker = {
    adapter: "github",
    team: REPO,
    stateName: (s: string) => (s === "pr_open" ? null : s),
    assignUnassigned: async () => ({ assigned: true }),
    assignedIssues: async (_: string, s: string[]) =>
      s.includes("in_progress") ? [] : roots,
    assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
    openChildren: async (k: string) => children[k] ?? [],
    listRelations: async (k: string) =>
      (waits[k] ?? []).map((i) => ({ type: "blocked_by", issue: i })),
    poolIssue: async (k: string) => all.find((i) => i.identifier === k) ?? null,
    getIssue: async (k: string) => ({
      identifier: k,
      description: "",
      parent:
        !readsParents || parents[k] === undefined
          ? null
          : { identifier: parents[k] },
    }),
  } as unknown as Tracker;
  return { tracker, cache };
}

/** What the tick plans for the walk's wanted items: the pickup actions, batched where the configuration allows. */
async function tick(
  world: ReturnType<typeof nested>,
  batch?: { values: Record<string, unknown>; root: string },
): Promise<Action[]> {
  // The tick's own hold read finds nothing: the hold comes after it.
  const read = await readServedPickups(world.tracker, people, {
    cache: world.cache,
    nowMs: 1,
    headroom: true,
    personHold: () => null,
  });
  return planPickups({
    slug: REPO,
    section: { identity: null } as DispatchSection,
    pickups: read.wanted,
    claimed: [],
    sessions: { ok: true, source: "fake", workspaces: [] },
    launches: [],
    idleSince: new Map(),
    nowMs: 1,
    ...(batch === undefined ? {} : batch),
  }).actions;
}

/** The launch record a pickup writes from its planned action, as `launchOne` does. */
function recordOf(action: Action): LaunchRecord {
  const batch = batchItemsOf(action.evidence.batchItems);
  expect(batch.ok).toBe(true);
  const members = batch.ok ? batch.value : undefined;
  const chain = ancestorsOf(action.evidence.ancestors);
  expect(chain.ok).toBe(true);
  return {
    version: 1,
    id: "20261120T090000Z-aaaaaaaa",
    token: "t",
    action: "pickup",
    repo: REPO,
    repoPath: "/r",
    pr: null,
    item: action.target,
    account: "a",
    vendor: "claude",
    configDir: "/c",
    wallBackoffMs: 1,
    replaces: null,
    facts: "",
    createdAt: "2026-11-20T09:00:00.000Z",
    workspace: null,
    attempts: [],
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
    ...servedEvidence(action, chain.ok ? chain.value : undefined),
    ...(members === undefined ? {} : { batchItems: members }),
  };
}

function hold(item: string, root: string): void {
  const set = setPersonPickupHold(
    REPO,
    item,
    { by: "operator", title: item, url: null },
    root,
  );
  expect(set.ok).toBe(true);
}

describe("the late pickup-hold check", () => {
  it("refuses a leaf whose nested epic was held after the tick read its holds", async () => {
    const actions = await tick(nested([issue("#3", [], null)]));
    const action = actions.find((a) => a.target === "#3");
    expect(action).toBeDefined();
    const record = recordOf(action as Action);
    expect(record.ancestorEpic).toBe("#1");
    expect(record.ancestors).toEqual(["#1", "#2"]);
    const root = scratch();
    expect(personPickupBlock(record, root)).toBeNull();
    hold("#2", root);
    expect(personPickupBlock(record, root)).toStartWith(
      "#2 is held by operator",
    );
  });

  it("carries the chain the walk passed through when the tracker reads no parent", async () => {
    const actions = await tick(nested([issue("#3", [], null)], [], false));
    const record = recordOf(actions.find((a) => a.target === "#3") as Action);
    expect(record.ancestors).toEqual(["#1", "#2"]);
    const root = scratch();
    hold("#2", root);
    expect(personPickupBlock(record, root)).toStartWith(
      "#2 is held by operator",
    );
  });

  it("carries the tracker epics of the blocked item to the blocker pulled for it", async () => {
    // The assigned #3 sits under #2 under #1 in the tracker and waits on the unrelated #4.
    const world = nested(
      [],
      [issue("#3")],
      true,
      { "#3": ["#4"] },
      {
        parents: { "#3": "#2" },
        pool: [issue("#4", [], null)],
      },
    );
    const actions = await tick(world);
    const action = actions.find((a) => a.target === "#4");
    expect(action).toBeDefined();
    const record = recordOf(action as Action);
    expect(record.ancestors).toEqual(expect.arrayContaining(["#1", "#2"]));
    const root = scratch();
    hold("#2", root);
    expect(personPickupBlock(record, root)).toStartWith(
      "#2 is held by operator",
    );
  });

  it("waits before launching when the planned ancestor chain does not read", async () => {
    const actions = await tick(nested([issue("#3", [], null)]));
    const planned = actions.find((a) => a.target === "#3") as Action;
    const action: Action = {
      ...planned,
      evidence: { ...planned.evidence, ancestors: "not json" },
    };
    const report = { actions: [action], launches: [] };
    const state = {
      records: [],
      machine: { serve: people },
    } as unknown as ApplyState;
    const ctx = {
      tracker: { adapter: "github" },
      section: { pickupDeadlineMs: 60_000 },
      sessions: async () => ({ ok: true, workspaces: [] }),
    } as unknown as PickupContext;
    await applyPickups(
      state,
      { path: "/r", slug: REPO, defaultBranch: "main" },
      report as never,
      ctx,
    );
    expect(report.launches).toHaveLength(1);
    expect(JSON.stringify(report.launches[0])).toContain("ancestor evidence");
  });

  it("refuses a batch whose member sits under a nested epic held after the tick", async () => {
    const root = scratch();
    writeFileSync(
      join(root, "label-taxonomy.yaml"),
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
    const values = {
      issue_tracker: {
        adapter: "github",
        facets: { size: { store: "label" } },
      },
      do_item: { agents: { codearea_areas: { "area:tools": "tools" } } },
    };
    const actions = await tick(
      nested(
        [issue("#3", ["area:tools"], null)],
        [issue("#5", ["area:tools"])],
      ),
      { values, root },
    );
    expect(actions).toHaveLength(1);
    const record = recordOf(actions[0] as Action);
    expect(record.batchItems).toEqual(
      expect.arrayContaining([
        { key: "#5", person: "alex" },
        {
          key: "#3",
          person: "alex",
          ancestor: "#1",
          ancestors: ["#1", "#2"],
        },
      ]),
    );
    // The check reads the member's chain, whatever the anchor carries.
    const { ancestorEpic: _epic, ancestors: _chain, ...anchorless } = record;
    const member: LaunchRecord = { ...anchorless, item: "#5" };
    expect(personPickupBlock(member, root)).toBeNull();
    hold("#2", root);
    expect(personPickupBlock(member, root)).toStartWith(
      "#2 is held by operator",
    );
  });

  it("reads a record with only the single-ancestor fields and checks that ancestor", async () => {
    const actions = await tick(nested([issue("#3", [], null)]));
    const { ancestors: _chain, ...legacy }: LaunchRecord = recordOf(
      actions.find((a) => a.target === "#3") as Action,
    );
    const root = scratch();
    writeRecord(legacy, root);
    const read = readRecord(legacy.id, root);
    expect(read).not.toBeNull();
    expect(read?.ancestors).toBeUndefined();
    expect(read?.ancestorEpic).toBe("#1");
    hold("#2", root);
    expect(personPickupBlock(read as LaunchRecord, root)).toBeNull();
    hold("#1", root);
    expect(personPickupBlock(read as LaunchRecord, root)).toStartWith(
      "#1 is held by operator",
    );
  });

  it("reads a planned chain as data and refuses one that is not a list of keys", () => {
    expect(ancestorsOf(undefined)).toEqual({ ok: true, value: undefined });
    expect(ancestorsOf('["#1","#2"]')).toEqual({
      ok: true,
      value: ["#1", "#2"],
    });
    for (const bad of ["#1", '"#1"', "[1]", 7])
      expect(ancestorsOf(bad).ok).toBe(false);
  });

  it("refuses to read a record whose ancestor chain is not a list of keys", () => {
    const record = recordOf({
      stage: "pickup",
      target: "#3",
      record: "tracker",
      reason: "ready",
      evidence: { servedPerson: "alex" },
    });
    expect(isLaunchRecord({ ...record, ancestors: ["#1", "#2"] })).toBe(true);
    expect(isLaunchRecord({ ...record, ancestors: "#1" })).toBe(false);
    expect(isLaunchRecord({ ...record, ancestors: ["#1", 2] })).toBe(false);
  });
});
