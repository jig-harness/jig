import { afterEach, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  newRecordId,
  readEnded,
  readRecord,
  readResult,
  writeRecord,
} from "../lib/launches.ts";
import {
  personPickupHolds,
  setPersonPickupHold,
  settlePickupHold,
} from "../lib/person-pickup-holds.ts";
import { assignedIssue, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  earlierRecord,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, withOrigin } from "./pickup-fixtures.ts";
import { emptyReport } from "../lib/tick-context.ts";
import { planConditionNeeds } from "../lib/plan-pickup-conditions.ts";
import { readPickupCondition } from "../lib/pickup-condition.ts";
import {
  readPickupConditions,
  linkPickupConditions,
} from "../lib/tick-pickup-conditions.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "0");
  current?.close();
  current = null;
});

function dependency(w: World, state: "OPEN" | "MERGED" | "CLOSED"): void {
  writeFileSync(
    join(w.dir, "pickup-pr-states.json"),
    JSON.stringify({ 42: state }),
  );
}

async function waitingPickup(): Promise<{
  w: World;
  id: string;
  path: string;
}> {
  const w = world();
  current = w;
  w.setConfig(`issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
  stalled_relaunch: never
  stalled_after: 1s
`);
  w.setIssues([assignedIssue(12, "factory-bot", [])]);
  w.setAssigner(12, "maintainer", "WRITE");
  withOrigin(w);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["pickup"]);
  const [launch] = (await applyTick(w, false)).repos[0]?.launches ?? [];
  expect(launch?.outcome).toBe("launched");
  const id = String(launch?.record);
  const root = dispatchState(w);
  const source = readRecord(id, root);
  const path = source?.workspace?.path;
  if (source === null || path === undefined)
    throw new Error("no pickup workspace");
  await waitFor("the pickup", () => claudeRuns(w).length === 1);
  w.setIssues([assignedIssue(12, "factory-bot", ["In Progress"])]);
  writeRecord({ ...source, claimedItems: ["#12"] }, root);
  dependency(w, "OPEN");
  const recorded = await w.dispatch([
    "result",
    id,
    source.token,
    "waits",
    "--until-merged",
    "#42",
  ]);
  expectSpawnExit(recorded, 0);
  writeFileSync(join(w.dir, "claude-exit"), "0");
  await waitFor("the exit", () => exitWritten(w, id));
  w.setWorkspaces([{ branch: "12-issue-12", path, agents: [] }]);
  expect(readEnded(id, root)?.waitsFor?.condition).toEqual({
    kind: "pr-merged",
    pr: 42,
  });
  return { w, id, path };
}

it("holds a claimed pickup without asking, then resumes it in its tree on the first tick after merge", async () => {
  const { w, id, path } = await waitingPickup();
  const waiting = (await applyTick(w, false)).repos[0];
  expect(waiting?.unplaced).toContainEqual(
    expect.objectContaining({
      target: "#12",
      reason: expect.stringContaining("waiting for PR #42 to merge"),
    }),
  );
  expect(waiting?.actions.filter((action) => action.target === "#12")).toEqual(
    [],
  );
  expect(waiting?.launches).toEqual([]);

  dependency(w, "MERGED");
  const resumed = (await applyTick(w, false)).repos[0];
  const [launch] = resumed?.launches ?? [];
  expect(launch).toEqual(
    expect.objectContaining({ target: "#12", outcome: "launched" }),
  );
  expect(readRecord(String(launch?.record), dispatchState(w))).toEqual(
    expect.objectContaining({
      relaunchOf: id,
      workspace: expect.objectContaining({ path }),
      claimedItems: ["#12"],
    }),
  );
  await waitFor("the resumed pickup", () => claudeRuns(w).length === 2);
  expect(claudeRuns(w)[1]?.argv.join(" ")).toContain("make no second claim");
}, 30_000);

it("raises one need when the dependency closes unmerged and keeps it held", async () => {
  const { w } = await waitingPickup();
  dependency(w, "CLOSED");
  const first = (await applyTick(w, false)).repos[0];
  const needs =
    first?.actions.filter((action) => action.target === "#12") ?? [];
  expect(needs).toEqual([
    expect.objectContaining({
      stage: "notify",
      reason: expect.stringContaining("PR #42 closed without merging"),
    }),
  ]);
  expect(first?.launches).toEqual([]);

  dependency(w, "MERGED");
  const next = (await applyTick(w, false)).repos[0];
  expect(
    next?.actions
      .filter((action) => action.target === "#12")
      .map((action) => action.notice?.key),
  ).toEqual(needs.map((action) => action.notice?.key));
  expect(next?.launches).toEqual([]);
}, 30_000);

it("atomically refuses a conditional result that would replace a person's hold", async () => {
  const w = world();
  current = w;
  const root = dispatchState(w);
  const id = newRecordId();
  const record = earlierRecord(w, {
    id,
    account: "a",
    item: "#12",
    action: "pickup",
    pr: null,
  });
  const placed = setPersonPickupHold(
    SLUG,
    "#12",
    {
      by: "operator",
      title: "task",
      url: null,
    },
    root,
  );
  expect(placed.ok).toBe(true);
  const prior = personPickupHolds(SLUG, root);
  const attempted = await w.dispatch([
    "result",
    id,
    record.token,
    "waits",
    "--until-merged",
    "42",
  ]);
  expectSpawnExit(attempted, 2);
  expect(personPickupHolds(SLUG, root)).toEqual(prior);
  expect(readResult(id, root)).toBeNull();
});

it.each(["released", "superseded", "wrong key shape"] as const)(
  "refuses a conditional result for a %s pickup",
  async (scenario) => {
    const w = world();
    current = w;
    const root = dispatchState(w);
    const id = newRecordId();
    const record = earlierRecord(w, {
      id,
      account: "a",
      action: "pickup",
      pr: null,
      item: "#12",
      released: scenario === "released",
    });
    if (scenario === "superseded")
      earlierRecord(w, {
        id: newRecordId(),
        account: "a",
        action: "pickup",
        pr: null,
        item: "#13",
        createdAt: "2026-10-31T20:00:00.000Z",
        batchItems: [
          { key: "#13", person: "other" },
          { key: "#12", person: "same" },
        ],
      });
    const result = await w.dispatch([
      "result",
      id,
      record.token,
      "waits",
      "--until-closed",
      scenario === "wrong key shape" ? "ENG-42" : "#42",
    ]);
    expectSpawnExit(result, 2);
    expect(readResult(id, root)).toBeNull();
    expect(personPickupHolds(SLUG, root)).toEqual({ ok: true, value: [] });
  },
);

it("records a native blocker only in apply, then releases the hold when the item closes", async () => {
  const w = world();
  current = w;
  const root = dispatchState(w);
  const condition = { kind: "item-closed", item: "#42" } as const;
  expect(
    setPersonPickupHold(
      SLUG,
      "#12",
      { by: "operator", title: "task", url: null, condition },
      root,
    ).ok,
  ).toBe(true);
  const calls: string[][] = [];
  let closed = false;
  const tracker = {
    async dependencyState() {
      return closed ? "closed" : "open";
    },
    async relate(key: string, type: string, target: string) {
      calls.push([key, type, target]);
    },
  } as unknown as Tracker;
  const input = {
    slug: SLUG,
    root,
    checkout: w.repo,
    apply: true,
    tracker,
    records: [],
  };
  const stored = () => {
    const holds = personPickupHolds(SLUG, root);
    if (!holds.ok) throw new Error(holds.failure.reason);
    return holds.value;
  };
  const report = emptyReport(w.repo, "");
  const first = await readPickupConditions(stored(), input, report);
  expect(first.holds).toHaveLength(1);
  expect(calls).toEqual([]);
  await linkPickupConditions(first.blockers, input, report);
  expect(calls).toEqual([["#42", "blocks", "#12"]]);
  expect(
    (await readPickupConditions(stored(), input, report)).blockers,
  ).toEqual([]);
  closed = true;
  expect(
    (await readPickupConditions(stored(), { ...input, apply: false }, report))
      .holds,
  ).toHaveLength(1);
  expect((await readPickupConditions(stored(), input, report)).holds).toEqual(
    [],
  );
  expect(stored()).toEqual([]);
});

it("reads a dependency key the tracker's queue accepts, underscores included", () => {
  expect(
    readPickupCondition({ kind: "item-closed", item: "team_one-42" }),
  ).toEqual({ kind: "item-closed", item: "TEAM_ONE-42" });
  expect(readPickupCondition({ kind: "item-closed", item: "_x-1" })).toBeNull();
});

it("raises the closed-unmerged need for a still-assigned pickup, not for an item that left the line", () => {
  const hold = (item: string) => ({
    item,
    by: "a person",
    at: "2026-01-01T00:00:00.000Z",
    title: item,
    url: null,
    condition: { kind: "pr-merged", pr: 42 } as const,
    settled: "closed-unmerged" as const,
  });
  const run = (item: string) => {
    const plan = { actions: [] as unknown[] };
    planConditionNeeds(
      {
        slug: SLUG,
        claimed: [],
        pickups: [{ key: "ENG-1", title: "t" }],
        conditionalHolds: [hold(item)],
      } as never,
      plan as never,
    );
    return plan.actions.length;
  };
  expect(run("ENG-1")).toBe(1);
  expect(run("ENG-2")).toBe(0);
});

it("lets a person's new hold replace a cleared conditional hold but not an active one", () => {
  const w = world();
  current = w;
  const root = dispatchState(w);
  const condition = { kind: "pr-merged", pr: 42 } as const;
  const hold = { by: "a person", title: "t", url: null, condition };
  expect(setPersonPickupHold(SLUG, "#12", hold, root).ok).toBe(true);
  const different = { by: "operator", title: "t", url: null };
  expect(setPersonPickupHold(SLUG, "#12", different, root).ok).toBe(false);
  const read = personPickupHolds(SLUG, root);
  if (!read.ok) throw new Error(read.failure.reason);
  const [first] = read.value;
  if (!first) throw new Error("no hold read");
  expect(settlePickupHold(SLUG, first, root, "cleared")).toBe(true);
  expect(setPersonPickupHold(SLUG, "#12", different, root).ok).toBe(true);
  const after = personPickupHolds(SLUG, root);
  if (!after.ok) throw new Error(after.failure.reason);
  expect(after.value).toHaveLength(1);
  expect(after.value[0]?.item).toBe("#12");
  expect(after.value[0]?.by).toBe("operator");
  expect(after.value[0]?.settled).toBeUndefined();
  expect(after.value[0]?.condition).toBeUndefined();
});
