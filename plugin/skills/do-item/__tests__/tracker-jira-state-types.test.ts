import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import { jiraModel } from "../scripts/lib/tracker/jira/model.ts";
import { claimIssue, claimFromRefusal } from "../scripts/lib/claim.ts";
import {
  DEFAULT_VOCABULARY,
  reconcileParentStatus,
} from "../scripts/reconcile_parent_status.ts";
import { issue, jira, page, routes, writes } from "./jira-fixtures.ts";

const overlay = {
  issue_tracker: {
    adapter: "jira",
    states: { in_progress: "Working" },
    jira: {
      states_by_type: {
        Epic: { in_progress: "In Delivery", in_review: null },
        Story: { in_review: "Dev Complete" },
      },
    },
  },
};

it("reads each type's workflow and falls back for unknown or absent types", () => {
  const c = parseTrackerConfig(overlay);
  const m = jiraModel(c.states, c.jira);
  const input = {
    status: { id: "s1", name: "In Delivery", category: "indeterminate" },
    resolution: null,
    issueType: { name: "Epic" },
  };
  expect(m.read(input).canonical).toBe("in_progress");
  expect(m.stateName("in_progress", "Epic")).toBe("In Delivery");
  expect(m.stateName("in_progress", "Unknown")).toBe("Working");
  expect(m.stateName("in_progress", null)).toBe("Working");
  expect(m.stateName("in_review", "Epic")).toBeNull();
});

it("transitions using the issue's workflow and skips absent states without a write", async () => {
  const { t, calls } = jira(
    routes({
      "GET issue/ENG-1": issue({ key: "ENG-1", type: "Epic" }),
      "GET issue/ENG-1/transitions": {
        transitions: [{ id: "t", name: "Start", to: { name: "In Delivery" } }],
      },
      "POST issue/ENG-1/transitions": null,
    }),
    overlay,
  );
  await t.transition("ENG-1", "in_progress");
  expect(writes(calls)).toEqual(["POST issue/ENG-1/transitions"]);
  calls.length = 0;
  const reported = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await t.transition("ENG-1", "in_review");
    expect(reported).toHaveBeenCalledWith(
      expect.stringContaining("skipped in_review"),
    );
  } finally {
    reported.mockRestore();
  }
  expect(writes(calls)).toEqual([]);
  expect(calls.map((c) => c.path)).toEqual(["issue/ENG-1"]);
});

it("prints effective maps from the states command without contacting Jira", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-state-types-"));
  try {
    const file = join(dir, "overlay.json");
    writeFileSync(file, JSON.stringify(overlay));
    const result = Bun.spawnSync(
      [
        process.execPath,
        resolve("plugin/skills/do-item/scripts/tracker.ts"),
        "states",
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          HOME: dir,
          JIG_USER_CONFIG: join(dir, "none.yaml"),
          JIG_OVERLAY: file,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(result, 0);
    const out = JSON.parse(result.stdout.toString());
    expect(out.in_progress).toBe("Working");
    expect(out.states_by_type.Epic).toMatchObject({
      in_progress: "In Delivery",
      in_review: null,
      done: "Done",
    });
    expect(out.states_by_type.Story.in_review).toBe("Dev Complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("refuses blocked and absent-start workflows before assigning a claim", async () => {
  for (const [status, map, why] of [
    ["Waiting", { blocked: "Waiting" }, "blocked"],
    ["Todo", { in_progress: null }, "state"],
  ] as const) {
    const { t, calls } = jira(
      routes({
        "GET issue/ENG-1": issue({ key: "ENG-1", type: "Epic", status }),
        "POST search/jql": page(),
      }),
      { issue_tracker: { jira: { states_by_type: { Epic: map } } } },
    );
    expect(await claimIssue(t, "ENG-1")).toMatchObject({
      outcome: "refused",
      why,
    });
    expect(writes(calls)).toEqual([]);
  }
});

it("checks claim_from using the native type's map", () => {
  const { t } = jira(routes({}), {
    issue_tracker: {
      jira: { states_by_type: { Story: { todo: "Selected" } } },
    },
  });
  expect(
    claimFromRefusal(t, "ENG-1", "Selected", ["todo"], "Story"),
  ).toBeNull();
  expect(claimFromRefusal(t, "ENG-1", "Todo", ["todo"], "Story")).toMatchObject(
    { outcome: "refused", why: "state" },
  );
});

it("checks ambiguity within each effective type map", () => {
  expect(() =>
    parseTrackerConfig({
      issue_tracker: {
        adapter: "jira",
        jira: { states_by_type: { Epic: { in_progress: "In Review" } } },
      },
    }),
  ).toThrow("states_by_type.Epic");
  expect(() =>
    parseTrackerConfig({
      issue_tracker: {
        adapter: "jira",
        jira: {
          states_by_type: {
            Epic: { in_progress: "Delivery" },
            Story: { in_review: "Delivery" },
          },
        },
      },
    }),
  ).not.toThrow();
});

it("rejects invalid entries and repeated type names", () => {
  for (const states_by_type of [
    { Epic: { unknown: "Ready" } },
    { Epic: { todo: "" } },
    { Epic: 1 },
    { Epic: {}, epic: {} },
  ]) {
    expect(() =>
      parseTrackerConfig({ issue_tracker: { jira: { states_by_type } } }),
    ).toThrow("states_by_type");
  }
});

it("reconciles a parent in its own workflow and recognizes each child's parked state", () => {
  const vocabulary = {
    ...DEFAULT_VOCABULARY,
    statesByType: {
      Epic: { in_review: "Awaiting Approval" },
      Story: { in_review: "Dev Complete" },
    },
  };
  const input = {
    parentNativeType: "Epic",
    parentLabels: [],
    children: [
      { nativeType: "Story", state: { name: "Dev Complete", type: "started" } },
    ],
  };
  expect(reconcileParentStatus(input, vocabulary)).toMatchObject({
    verdict: "set_status",
    parentState: "in_review",
    parentStateName: "Awaiting Approval",
  });
  expect(
    reconcileParentStatus(input, {
      ...vocabulary,
      statesByType: { ...vocabulary.statesByType, Epic: { in_review: null } },
    }),
  ).toMatchObject({
    verdict: "skipped",
    parentState: "in_review",
    parentStateName: null,
  });
  expect(
    reconcileParentStatus({ ...input, parentNativeType: "Unknown" }, vocabulary)
      .parentStateName,
  ).toBe("In Review");
});

it("queries every type's state names and filters against that issue's workflow", async () => {
  const { t, calls } = jira(
    routes({
      "GET user/search": [{ accountId: "person", displayName: "Person" }],
      "GET user": { accountId: "person", displayName: "Person" },
      "POST search/jql": (c: { body: Record<string, unknown> }) =>
        String(c.body.jql).includes("assignee =")
          ? page(
              issue({
                key: "ENG-1",
                type: "Epic",
                status: "In Delivery",
                category: "indeterminate",
              }),
              issue({
                key: "ENG-2",
                type: "Story",
                status: "In Delivery",
                category: "indeterminate",
              }),
            )
          : page(),
    }),
    overlay,
  );
  const found = await t.assignedIssues("person", ["in_progress"]);
  expect(found.map((i) => i.identifier)).toEqual(["ENG-1"]);
  const query = calls.find((c) => String(c.body.jql).includes("assignee ="));
  expect(String(query?.body.jql)).toContain(
    'status in ("Working", "In Delivery")',
  );
});

it("keeps a done-category blocked issue open only in the type whose map names it", async () => {
  const parent = issue({ key: "ENG-1", type: "Epic" });
  const epic = issue({
    key: "ENG-2",
    type: "Epic",
    status: "Waiting",
    category: "done",
    parent: "ENG-1",
  });
  const story = issue({
    key: "ENG-3",
    type: "Story",
    status: "Waiting",
    category: "done",
    parent: "ENG-1",
  });
  const { t } = jira(
    routes({
      "GET issue/ENG-1": parent,
      "POST search/jql": (c: { body: Record<string, unknown> }) =>
        String(c.body.jql).includes("parent in")
          ? page(story)
          : page(epic, story),
    }),
    {
      issue_tracker: {
        jira: { states_by_type: { Epic: { blocked: "Waiting" } } },
      },
    },
  );
  const population = await t.openIssues({ withSomeOf: [["work"]] });
  expect(population.map((i) => i.identifier)).toEqual(["ENG-2"]);
  expect(population[0]?.hasOpenChildren).toBe(false);
  expect((await t.openChildren("ENG-1")).map((i) => i.identifier)).toEqual([
    "ENG-2",
  ]);
});
