import { describe, expect, it } from "bun:test";
import { GitHubApiError } from "../scripts/lib/tracker/github/transport.ts";
import {
  type Call,
  conn,
  gitHub,
  issueNode,
  ON_BOARD,
  oneIssue,
  repoLabels,
} from "./github-fixtures.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-03-01T00:00:00Z");
const WINDOW = { sinceMs: T0, untilMs: T0 + 7 * DAY };
const at = (days: number) => new Date(T0 + days * DAY).toISOString();

/** An answer to `TrackerIssues` with one page of nodes. */
const listed = (nodes: unknown[]) => ({ repository: { issues: conn(nodes) } });

/**
 * A parent chain `depth` deep above an issue node. GraphQL merges the
 * `parent` of `issueFields` with the one of `ancestorFields`, so the nearest
 * ancestor carries both selections.
 */
function chain(depth: number, labels: string[] = []): unknown {
  let p: unknown = null;
  for (let i = depth; i >= 1; i--)
    p = {
      number: 100 + i,
      title: `Issue ${100 + i}`,
      repository: { nameWithOwner: "acme/app" },
      labels: conn(labels.map((name) => ({ name }))),
      parent: p,
    };
  return p;
}

describe("GitHub adapter: fleet metrics", () => {
  it("reads issues by key in batches, leaving out numbers that are no issue", async () => {
    const { t, calls } = gitHub(() => {
      throw new GitHubApiError("one is missing", {
        notFound: true,
        data: {
          repository: {
            i1: issueNode({
              number: 1,
              labels: ["follow-up"],
              extra: { parent: chain(1, ["epic"]) },
            }),
            i2: null,
          },
        },
      });
    });
    const facts = await t.issuesByKeys(["#1", "#2", "ENG-3"]);
    expect([...facts.keys()]).toEqual(["#1"]);
    expect(facts.get("#1")).toMatchObject({
      id: "#1",
      labels: ["follow-up"],
      stateType: "unstarted",
      completedAt: null,
      ancestors: [{ id: "#101", labels: ["epic"] }],
    });
    expect(calls[0]?.query).toContain("i1: issue(number: 1)");
    expect(calls[0]?.query).toContain("i2: issue(number: 2)");
  });

  it("refuses a parent chain deeper than the attribution walk", async () => {
    const { t } = gitHub(() => ({
      repository: { i1: issueNode({ number: 1, extra: { parent: chain(6) } }) },
    }));
    await expect(t.issuesByKeys(["#1"])).rejects.toThrow(
      "more than 5 ancestors",
    );
  });

  it("narrows a window read by last update and filters it exactly", async () => {
    const { t, calls } = gitHub(() =>
      listed([
        issueNode({
          number: 1,
          state: "CLOSED",
          stateReason: "COMPLETED",
          closedAt: at(2),
        }),
        issueNode({
          number: 2,
          state: "CLOSED",
          stateReason: "NOT_PLANNED",
          closedAt: at(3),
        }),
        issueNode({
          number: 3,
          state: "CLOSED",
          stateReason: "COMPLETED",
          closedAt: at(8),
        }),
      ]),
    );
    const done = await t.issuesInWindow({
      label: "follow-up",
      completedIn: WINDOW,
    });
    expect(done.map((f) => f.id)).toEqual(["#1"]);
    expect(calls[0]?.variables).toMatchObject({
      states: ["CLOSED"],
      filterBy: { labels: ["follow-up"], since: at(0) },
    });
  });

  it("counts a started epic's children from its start, read off its state label", async () => {
    const { t } = gitHub((c) => {
      if (c.op === "TrackerIssues")
        return listed([
          issueNode({
            number: 1,
            labels: ["epic", "In Progress"],
            assignee: "dana",
            extra: {
              timelineItems: {
                nodes: [
                  { createdAt: at(1), label: { name: "epic" } },
                  { createdAt: at(2), label: { name: "In Progress" } },
                ],
              },
            },
          }),
          issueNode({
            number: 2,
            labels: ["epic"],
            extra: { timelineItems: { nodes: [] } },
          }),
        ]);
      if (c.op === "TrackerChildren")
        return {
          repository: {
            issue: {
              subIssues: conn([
                issueNode({
                  number: 3,
                  updatedAt: at(4),
                  state: "CLOSED",
                  stateReason: "COMPLETED",
                }),
              ]),
            },
          },
        };
      throw new Error(`unexpected ${c.op}`);
    });
    expect(await t.startedIssueActivity("epic")).toEqual([
      {
        epic: "#1",
        startedAt: at(2),
        project: null,
        assignee: "dana",
        labels: ["epic"],
        children: [{ issue: "#3", updatedAt: at(4), stateType: "completed" }],
      },
    ]);
  });

  it("dates a started epic from its board item in project mode", async () => {
    const { t } = gitHub((c) => {
      if (c.op === "TrackerIssues")
        return listed([
          issueNode({ number: 1, labels: ["epic"], status: "In Progress" }),
        ]);
      return { repository: { issue: { subIssues: conn([]) } } };
    }, ON_BOARD);
    const [epic] = await t.startedIssueActivity("epic");
    expect(epic?.startedAt).toBe("2026-01-03T00:00:00Z");
  });

  it("finds comments containing a text on labelled issues, inside the window", async () => {
    const { t } = gitHub((c) => {
      if (c.op === "TrackerIssues")
        return listed([issueNode({ number: 1, labels: ["epic"] })]);
      return {
        repository: {
          issue: {
            id: "I_1",
            comments: conn([
              {
                id: "C1",
                body: "marker: yes",
                createdAt: at(1),
                authorAssociation: "OWNER",
              },
              {
                id: "C2",
                body: "marker: late",
                createdAt: at(9),
                authorAssociation: "OWNER",
              },
              {
                id: "C3",
                body: "other",
                createdAt: at(1),
                authorAssociation: "OWNER",
              },
            ]),
          },
        },
      };
    });
    expect(
      await t.commentsContaining({
        text: "marker:",
        issueLabel: "epic",
        createdIn: WINDOW,
      }),
    ).toEqual([
      { issue: "#1", body: "marker: yes", createdAt: at(1), trusted: true },
    ]);
  });

  it("reads a ledger as the union of a label and a milestone, refusing an unknown label", async () => {
    const answer = (labels: string[]) => (c: Call) => {
      if (c.op === "TrackerLabels") return repoLabels(...labels);
      if (c.op === "TrackerMilestones")
        return {
          repository: {
            milestones: conn([{ id: "MI_1", number: 4, title: "Debt" }]),
          },
        };
      const byMilestone =
        (c.variables.filterBy as Record<string, unknown>).milestoneNumber ===
        "4";
      return listed(
        byMilestone
          ? [
              issueNode({ number: 2, milestone: "Debt" }),
              issueNode({ number: 3, milestone: "Debt" }),
            ]
          : [
              issueNode({ number: 1, labels: ["debt", "priority: high"] }),
              issueNode({
                number: 2,
                labels: ["debt"],
                milestone: "Debt",
                state: "CLOSED",
                stateReason: "DUPLICATE",
                closedAt: at(1),
              }),
            ],
      );
    };
    const { t } = gitHub(answer(["debt"]));
    const ledger = await t.ledger({ label: "debt", project: "Debt" });
    expect(
      ledger.map((i) => [i.identifier, i.priority, i.stateType, i.canceledAt]),
    ).toEqual([
      ["#1", 2, "unstarted", null],
      ["#2", 0, "duplicate", at(1)],
      ["#3", 0, "unstarted", null],
    ]);
    const missing = gitHub(answer(["bug"]));
    await expect(missing.t.ledger({ label: "debt" })).rejects.toThrow(
      "silently shrinks",
    );
  });
});

describe("GitHub adapter: candidate pools", () => {
  const kids = (...states: string[]) =>
    conn(states.map((state) => ({ state })));

  it("filters open issues by every label list and the excluded labels", async () => {
    const { t, calls } = gitHub(() =>
      listed([
        issueNode({
          number: 1,
          labels: ["xs", "repo:web", "priority: urgent"],
          assignee: "dana",
          extra: { subIssues: kids("CLOSED") },
        }),
        issueNode({
          number: 2,
          labels: ["small"],
          extra: { subIssues: kids() },
        }),
        issueNode({
          number: 3,
          labels: ["xs", "repo:web", "hitl"],
          extra: { subIssues: kids() },
        }),
        issueNode({
          number: 4,
          labels: ["xs", "repo:web", "In Progress"],
          extra: { subIssues: kids("OPEN") },
        }),
      ]),
    );
    const pool = await t.openIssues({
      withSomeOf: [["xs", "small"], ["repo:web"]],
      withNoneOf: ["hitl"],
    });
    expect(calls[0]?.variables).toMatchObject({
      states: ["OPEN"],
      filterBy: { labels: ["xs", "small"] },
    });
    expect(pool.map((p) => p.identifier)).toEqual(["#1", "#4"]);
    expect(pool[0]).toMatchObject({
      priority: 1,
      state: { id: "todo", name: "Todo", type: "unstarted" },
      assignee: { id: "U_dana", name: "dana" },
      labels: ["xs", "repo:web"],
      hasOpenChildren: false,
    });
    expect(pool[1]).toMatchObject({
      state: { id: "in_progress" },
      hasOpenChildren: true,
    });
    await expect(t.openIssues({ withSomeOf: [] })).rejects.toThrow(
      "non-empty label list",
    );
  });

  it("reads open children of this repository only, and one issue in pool form", async () => {
    const { t } = gitHub((c) => {
      if (c.op === "TrackerChildren")
        return {
          repository: {
            issue: {
              subIssues: conn([
                issueNode({ number: 2, extra: { subIssues: kids() } }),
                issueNode({
                  number: 3,
                  state: "CLOSED",
                  extra: { subIssues: kids() },
                }),
                issueNode({
                  number: 9,
                  repo: "other/lib",
                  extra: { subIssues: kids() },
                }),
              ]),
            },
          },
        };
      if (c.variables.number === 404)
        return new GitHubApiError("gone", {
          notFound: true,
          data: { repository: { issue: null } },
        });
      return oneIssue(issueNode({ number: 5, extra: { subIssues: kids() } }));
    });
    expect((await t.openChildren("#1")).map((p) => p.identifier)).toEqual([
      "#2",
    ]);
    expect((await t.poolIssue("#5"))?.identifier).toBe("#5");
    expect(await t.poolIssue("#404")).toBeNull();
  });

  it("reads a labelled population with descriptions when asked", async () => {
    const { t } = gitHub(() =>
      listed([
        issueNode({
          number: 1,
          body: "owner: x",
          state: "CLOSED",
          stateReason: "COMPLETED",
          closedAt: at(1),
        }),
      ]),
    );
    expect(await t.labelledIssues("pattern:x", undefined, true)).toEqual([
      {
        identifier: "#1",
        stateType: "completed",
        completedAt: at(1),
        description: "owner: x",
      },
    ]);
  });
});
