/**
 * Step 5a's parent-status reconciliation fed the tracker port's answers: one
 * situation (an epic whose children are one done and one in review) read
 * through each built adapter's fake transport gives one verdict, and every
 * gap in the answers fails the listing closed.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import { linearTracker } from "../scripts/lib/tracker/linear.ts";
import type { Tracker } from "../scripts/lib/tracker/port.ts";
import {
  type AnswersInput,
  isAnswersInput,
  listingFromAnswers,
} from "../scripts/lib/reconcile-answers.ts";
import {
  type ReconcileVocabulary,
  reconcileParentStatus,
} from "../scripts/reconcile_parent_status.ts";
import { conn, gitHub, issueNode, oneIssue } from "./github-fixtures.ts";
import { issue, jira, jqlOf, page, routes } from "./jira-fixtures.ts";

// ── The same situation on each adapter ─────────────────────────────────────

const linearLabels = (...names: string[]) => ({
  pageInfo: { hasNextPage: false },
  nodes: names.map((name) => ({ name })),
});
const linearPage = (nodes: unknown[]) => ({
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes,
});

function linearNode(
  key: string,
  state: { name: string; type: string },
  labelNames: string[],
  children: unknown[] = [],
) {
  return {
    id: `uuid-${key}`,
    identifier: key,
    title: `Issue ${key}`,
    description: null,
    url: `https://tracker.example/${key}`,
    updatedAt: "2026-10-01T00:00:00.000Z",
    state,
    labels: linearLabels(...labelNames),
    priority: 0,
    parent: null,
    children: linearPage(children),
    assignee: null,
    project: null,
  };
}

const LINEAR_DONE = { name: "Done", type: "completed" };
const LINEAR_REVIEW = { name: "In Review", type: "started" };

function linearSituation(): Tracker {
  const nodes: Record<string, unknown> = {
    "ENG-2": linearNode("ENG-2", LINEAR_DONE, []),
    "ENG-3": linearNode("ENG-3", LINEAR_REVIEW, []),
  };
  nodes["ENG-1"] = linearNode(
    "ENG-1",
    { name: "In Progress", type: "started" },
    ["epic"],
    [
      { identifier: "ENG-2", title: "Issue ENG-2", state: LINEAR_DONE },
      { identifier: "ENG-3", title: "Issue ENG-3", state: LINEAR_REVIEW },
    ],
  );
  return linearTracker({
    team: "ENG",
    states: parseTrackerConfig({}).states,
    transport: async (_query, variables) => ({
      issue: nodes[String(variables.id)] ?? null,
    }),
  });
}

function gitHubSituation(): Tracker {
  const nodes: Record<number, Record<string, unknown>> = {
    2: issueNode({ number: 2, state: "CLOSED", stateReason: "COMPLETED" }),
    3: issueNode({ number: 3, labels: ["In Review"] }),
  };
  nodes[1] = issueNode({
    number: 1,
    labels: ["epic", "In Progress"],
    extra: { subIssues: conn([nodes[2], nodes[3]]) },
  });
  for (const n of [2, 3])
    (nodes[n] as Record<string, unknown>).subIssues = conn([]);
  return gitHub((call) =>
    call.op === "TrackerIssue"
      ? oneIssue(nodes[Number(call.variables.number)] ?? null)
      : new Error(`unexpected ${call.op}`),
  ).t;
}

function jiraSituation(): Tracker {
  const done = issue({ key: "ENG-2", status: "Done", category: "done" });
  const review = issue({
    key: "ENG-3",
    status: "In Review",
    category: "indeterminate",
  });
  return jira(
    routes({
      "GET issue/ENG-1": issue({
        key: "ENG-1",
        status: "In Progress",
        category: "indeterminate",
        labels: ["epic"],
        type: "Epic",
        typeLevel: 1,
      }),
      "GET issue/ENG-2": done,
      "GET issue/ENG-3": review,
      "POST search/jql": (c: Parameters<typeof jqlOf>[0]) =>
        jqlOf(c).startsWith("parent = ENG-1 ") ? page(done, review) : page(),
    }),
    { issue_tracker: { jira: { site: "https://example.atlassian.net" } } },
  ).t;
}

const VOCABULARY = (adapter: string): ReconcileVocabulary => {
  const config = parseTrackerConfig({
    issue_tracker:
      adapter === "github"
        ? { adapter, github: { repository: "acme/app" } }
        : adapter === "jira"
          ? {
              adapter,
              team: "ENG",
              jira: { site: "https://example.atlassian.net" },
            }
          : { adapter, team: "ENG" },
  });
  return { labels: config.labels, states: config.states };
};

/** What Step 5a hands the reconciler: the parent and each child, read through the port. */
async function answersOf(t: Tracker, key: string): Promise<AnswersInput> {
  const parent = await t.getIssue(key);
  const children: AnswersInput["children"] = {};
  for (const c of parent?.children ?? [])
    children[c.identifier] = await t.getIssue(c.identifier);
  return { issue: key, parent, children, complete: true };
}

describe("parent-status reconciliation from the port's answers", () => {
  const situations: Array<[string, () => Tracker, string]> = [
    ["linear", linearSituation, "ENG-1"],
    ["github", gitHubSituation, "#1"],
    ["jira", jiraSituation, "ENG-1"],
  ];

  it.each(situations)(
    "%s answers give the one verdict",
    async (adapter, make, key) => {
      const answers = await answersOf(make(), key);
      expect(Object.keys(answers.children)).toHaveLength(2);
      const decision = reconcileParentStatus(
        listingFromAnswers(answers),
        VOCABULARY(adapter),
      );
      expect({
        verdict: decision.verdict,
        state: decision.parentState,
      }).toEqual({
        verdict: "set_status",
        state: "in_review",
      });
    },
  );
});

// ── Gaps fail closed ───────────────────────────────────────────────────────

describe("listingFromAnswers", () => {
  const answer = (identifier: string, name: string, type: string) => ({
    found: true,
    identifier,
    state: { name, type },
    labels: [] as string[],
    nativeType: null,
  });
  const whole = (): AnswersInput => ({
    issue: "ENG-1",
    parent: { ...answer("ENG-1", "In Progress", "started"), labels: ["epic"] },
    children: { "ENG-2": answer("ENG-2", "Done", "completed") },
    complete: true,
  });

  it("is told apart from a ReconcileInput", () => {
    expect(isAnswersInput(whole())).toBe(true);
    expect(isAnswersInput({ parentLabels: [], children: [] })).toBe(false);
  });

  it("reads a whole set of answers", () => {
    expect(listingFromAnswers(whole())).toEqual({
      found: true,
      parentLabels: ["epic"],
      parentNativeType: null,
      children: [
        {
          state: { name: "Done", type: "completed" },
          labels: [],
          nativeType: null,
        },
      ],
    });
  });

  const gaps: Array<
    [string, (i: AnswersInput) => void, boolean | "truncated"]
  > = [
    ["no parent", (i) => (i.parent = null), false],
    [
      "a parent answer for another issue",
      (i) => ((i.parent as { identifier: string }).identifier = "ENG-9"),
      false,
    ],
    [
      "a child listing not read to its end",
      (i) => (i.complete = false),
      "truncated",
    ],
    [
      "a parent without labels",
      (i) => delete (i.parent as { labels?: unknown }).labels,
      "truncated",
    ],
    [
      "a child that could not be read",
      (i) => (i.children["ENG-2"] = null),
      "truncated",
    ],
    [
      "a child answer for another key",
      (i) => (i.children["ENG-2"] = answer("ENG-7", "Done", "completed")),
      "truncated",
    ],
    [
      "a child with an unreadable state",
      (i) => (i.children["ENG-2"] = answer("ENG-2", "Unknown", "unknown")),
      "truncated",
    ],
    [
      "a child with no state at all",
      (i) => (i.children["ENG-2"] = answer("ENG-2", "", "")),
      "truncated",
    ],
  ];

  it.each(gaps)("%s fails the listing closed", (_name, spoil, outcome) => {
    const input = whole();
    spoil(input);
    const listing = listingFromAnswers(input);
    if (outcome === false) expect(listing.found).toBe(false);
    else expect(listing.truncated).toBe(true);
    expect(reconcileParentStatus(listing).verdict).toBe("listing_failed");
  });

  it("is what the reconciler script reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-reconcile-answers-"));
    try {
      const input = join(dir, "reconcile-input.json");
      writeFileSync(input, JSON.stringify(whole()));
      const result = spawnSync(
        process.execPath,
        [
          join(import.meta.dir, "../scripts/reconcile_parent_status.ts"),
          "--input",
          input,
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            JIG_OVERLAY: join(import.meta.dir, "fixtures/overlay.yaml"),
          },
        },
      );
      expectSpawnExit(
        {
          exitCode: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        0,
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        verdict: "set_status",
        parentState: "done",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
