import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultStateName,
  parseTrackerConfig,
  requireTeamKey,
  teamKeyOrNull,
} from "../scripts/lib/tracker/config.ts";
import { knownAdapters, openTracker } from "../scripts/lib/tracker/index.ts";
import {
  cliTransport,
  httpTransport,
  LinearApiError,
  type LinearTransport,
  linearTracker,
  parseIssueFact,
  unwrapResponse,
} from "../scripts/lib/tracker/linear.ts";
import { CANONICAL_STATES } from "../scripts/lib/tracker/port.ts";

const STATES = parseTrackerConfig({}).states;

type Call = { query: string; variables: Record<string, unknown> };

/** A fake transport answering each request with the next scripted response. */
function fake(answer: (call: Call, n: number) => unknown): {
  transport: LinearTransport;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    transport: async (query, variables) => {
      const call = { query, variables };
      calls.push(call);
      const out = answer(call, calls.length - 1);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

function tracker(answer: (call: Call, n: number) => unknown) {
  const f = fake(answer);
  return {
    t: linearTracker({ team: "ENG", states: STATES, transport: f.transport }),
    calls: f.calls,
  };
}

const labels = (...names: string[]) => ({
  pageInfo: { hasNextPage: false },
  nodes: names.map((name) => ({ name })),
});
const page = (nodes: unknown[], next: string | null = null) => ({
  pageInfo: { hasNextPage: next !== null, endCursor: next },
  nodes,
});

describe("tracker configuration", () => {
  it("defaults the adapter and every canonical state name", () => {
    const c = parseTrackerConfig({});
    expect(c.adapter).toBe("linear");
    expect(c.team).toBeNull();
    expect(c.states.in_progress).toBe("In Progress");
    expect(c.states.ops_pending).toBe("Ops Pending");
    for (const s of CANONICAL_STATES)
      expect(c.states[s]).toBe(defaultStateName(s));
  });

  it("reads the team and maps states by canonical key", () => {
    const c = parseTrackerConfig({
      issue_tracker: {
        adapter: "linear",
        team: "ENG",
        file_command: "/file-issue",
        states: { in_review: "Code Review", done: "Shipped" },
      },
    });
    expect(c.team).toBe("ENG");
    expect(c.states.in_review).toBe("Code Review");
    expect(c.states.done).toBe("Shipped");
    expect(c.states.todo).toBe("Todo");
  });

  it("refuses a non-canonical state key, a bad team key and an empty adapter", () => {
    expect(() =>
      parseTrackerConfig({ issue_tracker: { states: { shipped: "Done" } } }),
    ).toThrow("not a canonical state");
    expect(() =>
      parseTrackerConfig({ issue_tracker: { team: "eng" } }),
    ).toThrow("issue key prefix");
    expect(() =>
      parseTrackerConfig({ issue_tracker: { adapter: "" } }),
    ).toThrow("adapter");
  });

  it("refuses two states named alike, outside an aliasable group", () => {
    expect(() =>
      parseTrackerConfig({
        issue_tracker: { states: { in_review: "In Progress" } },
      }),
    ).toThrow(
      "issue_tracker.states.in_progress and issue_tracker.states.in_review both name 'In Progress'",
    );
    expect(() =>
      parseTrackerConfig({
        issue_tracker: { states: { done: "in review" } },
      }),
    ).toThrow("both name");
    const aliased = parseTrackerConfig({
      issue_tracker: {
        states: {
          triage: "Backlog",
          duplicate: "Canceled",
          ops_pending: "In Review",
        },
      },
    });
    expect(aliased.states.triage).toBe("Backlog");
    expect(aliased.states.duplicate).toBe("Canceled");
    expect(aliased.states.ops_pending).toBe("In Review");
  });

  it("names the missing field when a team is required", () => {
    expect(() => requireTeamKey(parseTrackerConfig({}))).toThrow(
      "issue_tracker.team",
    );
  });

  it("refuses an unknown adapter at open time", () => {
    expect(knownAdapters()).toEqual(["linear"]);
    expect(() =>
      openTracker(
        parseTrackerConfig({ issue_tracker: { adapter: "jira", team: "ENG" } }),
      ),
    ).toThrow("not supported");
  });

  describe("teamKeyOrNull", () => {
    const saved = process.env.JIG_OVERLAY;
    let dir: string | null = null;
    afterEach(() => {
      if (saved === undefined) delete process.env.JIG_OVERLAY;
      else process.env.JIG_OVERLAY = saved;
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
      dir = null;
    });
    it("is null without an overlay and the team with one", () => {
      dir = mkdtempSync(join(tmpdir(), "tracker-config-"));
      process.env.JIG_OVERLAY = join(dir, "missing.yaml");
      expect(teamKeyOrNull()).toBeNull();
      const path = join(dir, "overlay.yaml");
      writeFileSync(path, "issue_tracker:\n  team: ENG\n");
      process.env.JIG_OVERLAY = path;
      expect(teamKeyOrNull()).toBe("ENG");
    });
    it("opening the tracker refuses the pre-rename do_issue section", () => {
      dir = mkdtempSync(join(tmpdir(), "tracker-config-"));
      const path = join(dir, "overlay.yaml");
      writeFileSync(
        path,
        "issue_tracker:\n  team: ENG\ndo_issue:\n  gates: []\n",
      );
      process.env.JIG_OVERLAY = path;
      expect(() => openTracker()).toThrow("now called do_item");
    });
  });
});

describe("Linear transport", () => {
  it("marks an entity-not-found answer as not found", () => {
    try {
      unwrapResponse(
        { errors: [{ message: "Entity not found: Issue" }], data: null },
        200,
      );
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LinearApiError);
      expect((err as LinearApiError).notFound).toBe(true);
    }
    expect(() =>
      unwrapResponse({ errors: [{ message: "boom" }] }, 200),
    ).toThrow("boom");
  });

  it("sends the key as Authorization and returns data", async () => {
    let seen: RequestInit | undefined;
    const t = httpTransport("lin_api_x", (async (
      _url: string,
      init: RequestInit,
    ) => {
      seen = init;
      return new Response(JSON.stringify({ data: { ok: 1 } }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(await t("query { ok }", {})).toEqual({ ok: 1 });
    const headers = (seen?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("lin_api_x");
  });

  it("reports an HTTP error status", async () => {
    const t = httpTransport(
      "k",
      (async () =>
        new Response("nope", { status: 500 })) as unknown as typeof fetch,
    );
    await expect(t("query { ok }", {})).rejects.toThrow("HTTP 500");
  });

  describe("command-line client", () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });
    /** A stand-in `linear` printing `out` and exiting with `code`. */
    function client(out: string, code: number): string {
      dir = mkdtempSync(join(tmpdir(), "linear-cli-"));
      const bin = join(dir, "linear");
      writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${out}'\nexit ${code}\n`, {
        mode: 0o755,
      });
      return bin;
    }

    it("returns the data of a successful invocation", async () => {
      const t = cliTransport(client('{"data":{"ok":1}}', 0));
      expect(await t("query { ok }", {})).toEqual({ ok: 1 });
    });

    it("rejects a failed invocation whose output parses as data", async () => {
      const t = cliTransport(client('{"data":{"ok":1}}', 1));
      await expect(t("query { ok }", {})).rejects.toThrow("exited 1");
    });

    it("reports the errors a failed invocation carries", async () => {
      const t = cliTransport(
        client('{"errors":[{"message":"Entity not found: Issue"}]}', 1),
      );
      try {
        await t("query { ok }", {});
        throw new Error("expected a throw");
      } catch (err) {
        expect(err).toBeInstanceOf(LinearApiError);
        expect((err as LinearApiError).notFound).toBe(true);
      }
    });
  });
});

describe("Linear adapter: issue pickup", () => {
  const issueNode = {
    id: "uuid-1",
    identifier: "ENG-1",
    title: "Parent",
    description: null,
    url: "https://tracker.example/ENG-1",
    updatedAt: "2026-10-01T00:00:00.000Z",
    state: { name: "In Progress", type: "started" },
    labels: labels("epic"),
    parent: null,
    children: page([
      {
        identifier: "ENG-2",
        title: "Child",
        state: { name: "Done", type: "completed" },
        labels: labels("manual-ops"),
      },
    ]),
    assignee: { name: "Dev" },
    project: null,
  };

  it("reads an issue with its children", async () => {
    const { t } = tracker(() => ({ issue: issueNode }));
    const issue = await t.getIssue("ENG-1");
    expect(issue?.identifier).toBe("ENG-1");
    expect(issue?.description).toBe("");
    expect(issue?.labels).toEqual(["epic"]);
    expect(issue?.children[0]?.labels).toEqual(["manual-ops"]);
    expect(issue?.assignee).toBe("Dev");
  });

  it("returns null for an issue the tracker does not have", async () => {
    const { t } = tracker(
      () => new LinearApiError("Entity not found", 200, true),
    );
    expect(await t.getIssue("ENG-404")).toBeNull();
  });

  it("returns null for an explicit null issue and fails an omitted one", async () => {
    const empty = tracker(() => ({ issue: null }));
    expect(await empty.t.getIssue("ENG-404")).toBeNull();
    const omitted = tracker(() => ({}));
    await expect(omitted.t.getIssue("ENG-1")).rejects.toThrow(
      "expected an object",
    );
  });

  it("refuses a truncated child list rather than reporting it complete", async () => {
    const { t } = tracker(() => ({
      issue: { ...issueNode, children: page([], "c1") },
    }));
    await expect(t.getIssue("ENG-1")).rejects.toThrow("children");
  });

  it("pages every comment, oldest first", async () => {
    const { t, calls } = tracker((_c, n) =>
      n === 0
        ? {
            issue: {
              id: "u",
              comments: page(
                [
                  {
                    id: "c2",
                    body: "second",
                    createdAt: "2026-01-02T00:00:00Z",
                  },
                ],
                "cur",
              ),
            },
          }
        : {
            issue: {
              id: "u",
              comments: page([
                { id: "c1", body: "first", createdAt: "2026-01-01T00:00:00Z" },
              ]),
            },
          },
    );
    const comments = await t.listComments("ENG-1");
    expect(comments.map((c) => c.body)).toEqual(["first", "second"]);
    expect(calls[1]?.variables.after).toBe("cur");
  });

  it("transitions by the configured state name", async () => {
    const f = fake((call) => {
      if (call.query.includes("TrackerIssueId"))
        return { issue: { id: "uuid-1", team: { id: "team-1", key: "ENG" } } };
      if (call.query.includes("TrackerStates"))
        return {
          team: {
            states: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { id: "s-1", name: "Code Review", type: "started" },
                { id: "s-2", name: "Done", type: "completed" },
              ],
            },
          },
        };
      return { issueUpdate: { success: true } };
    });
    const t = linearTracker({
      team: "ENG",
      states: { ...STATES, in_review: "Code Review" },
      transport: f.transport,
    });
    await t.transition("ENG-1", "in_review");
    expect(f.calls.at(-1)?.variables).toEqual({
      id: "uuid-1",
      input: { stateId: "s-1" },
    });
    await expect(t.transition("ENG-1", "ops_pending")).rejects.toThrow(
      "matches 0 workflow states",
    );
  });

  it("refuses a comment the tracker did not accept", async () => {
    const { t, calls } = tracker((call) =>
      call.query.includes("TrackerIssueId")
        ? { issue: { id: "uuid-9", team: { id: "t" } } }
        : { commentCreate: { success: false } },
    );
    await expect(t.postComment("ENG-9", "hi")).rejects.toThrow(
      "did not succeed",
    );
    expect(calls.at(-1)?.variables).toEqual({ issueId: "uuid-9", body: "hi" });
  });
});

describe("Linear adapter: fleet metrics", () => {
  const fact = (identifier: string, extra: Record<string, unknown> = {}) => ({
    identifier,
    title: `t ${identifier}`,
    createdAt: "2026-09-01T00:00:00.000Z",
    completedAt: null,
    description: "",
    state: { type: "started" },
    labels: labels(),
    parent: null,
    ...extra,
  });

  it("reads issues by key for the configured team only", async () => {
    const { t, calls } = tracker(() => ({ issues: page([fact("ENG-7")]) }));
    const got = await t.issuesByKeys(["ENG-7", "OPS-3", "ENG-7"]);
    expect([...got.keys()]).toEqual(["ENG-7"]);
    expect(calls[0]?.variables.numbers).toEqual([7]);
    expect(calls[0]?.variables.teamKey).toBe("ENG");
  });

  it("walks the parent chain and refuses one deeper than the walk", () => {
    const chain = (depth: number): unknown =>
      depth === 0
        ? null
        : {
            identifier: `ENG-${depth}`,
            labels: labels(),
            parent: chain(depth - 1),
          };
    expect(
      parseIssueFact(fact("ENG-99", { parent: chain(2) })).ancestors,
    ).toHaveLength(2);
    expect(() => parseIssueFact(fact("ENG-99", { parent: chain(6) }))).toThrow(
      "ancestors",
    );
  });

  it("filters a window read by label and range", async () => {
    const { t, calls } = tracker(() => ({ issues: page([]) }));
    await t.issuesInWindow({
      label: "follow-up",
      createdIn: { sinceMs: 0, untilMs: 86_400_000 },
    });
    expect(calls[0]?.variables.filter).toEqual({
      team: { key: { eq: "ENG" } },
      labels: { name: { eq: "follow-up" } },
      createdAt: {
        gte: "1970-01-01T00:00:00.000Z",
        lt: "1970-01-02T00:00:00.000Z",
      },
    });
  });

  it("refuses a repeated cursor", async () => {
    const { t } = tracker(() => ({ issues: page([], "same") }));
    await expect(t.issuesInWindow({})).rejects.toThrow("cursor");
  });

  it("marks comment authors trusted only when they are non-guest users", async () => {
    const { t } = tracker(() => ({
      comments: page([
        {
          id: "a",
          body: "x",
          createdAt: "2026-09-02T00:00:00Z",
          issue: { identifier: "ENG-1" },
          user: { id: "u1", guest: false },
        },
        {
          id: "b",
          body: "y",
          createdAt: "2026-09-02T00:00:00Z",
          issue: { identifier: "ENG-1" },
          user: { id: "u2", guest: true },
        },
        {
          id: "c",
          body: "z",
          createdAt: "2026-09-02T00:00:00Z",
          issue: { identifier: "ENG-1" },
          user: null,
        },
      ]),
    }));
    const found = await t.commentsContaining({
      text: "marker",
      issueLabel: "epic",
      createdIn: { sinceMs: 0, untilMs: 1 },
    });
    expect(found.map((c) => c.trusted)).toEqual([true, false, false]);
  });

  it("reads a ledger as one union and refuses an unresolved name", async () => {
    const ledgerNode = {
      identifier: "ENG-5",
      createdAt: "2026-09-01T00:00:00Z",
      completedAt: null,
      canceledAt: null,
      priority: 0,
      state: { type: "backlog" },
      labels: {
        pageInfo: { hasNextPage: true },
        nodes: [{ name: "follow-up" }],
      },
      parent: { identifier: "ENG-1" },
      project: null,
    };
    const resources = (projects: number) => ({
      issueLabels: page([{ id: "l", name: "follow-up" }]),
      projects: page(
        Array.from({ length: projects }, (_, i) => ({
          id: `p${i}`,
          name: "Debt",
        })),
      ),
    });
    const ok = tracker((call) =>
      call.query.includes("TrackerLedgerResources")
        ? resources(1)
        : { issues: page([ledgerNode]) },
    );
    const pages: number[] = [];
    const got = await ok.t.ledger(
      { label: "follow-up", project: "Debt" },
      (n) => pages.push(n),
    );
    expect(got[0]).toMatchObject({
      identifier: "ENG-5",
      parent: "ENG-1",
      truncated: ["labels"],
    });
    expect(pages).toEqual([1]);
    expect(ok.calls[1]?.query).toContain("or:");

    const missing = tracker(() => resources(0));
    await expect(
      missing.t.ledger({ label: "follow-up", project: "Debt" }),
    ).rejects.toThrow("matched 0");

    const labelOnly = tracker((call) =>
      call.query.includes("TrackerLedgerResources")
        ? { issueLabels: page([{ id: "l", name: "follow-up" }]) }
        : { issues: page([]) },
    );
    expect(await labelOnly.t.ledger({ label: "follow-up" })).toEqual([]);
    expect(labelOnly.calls[1]?.query).not.toContain("or:");
  });

  it("refuses a completed labelled issue without a completion time", async () => {
    const { t } = tracker(() => ({
      issues: page([
        {
          identifier: "ENG-1",
          completedAt: null,
          state: { type: "completed" },
        },
      ]),
    }));
    await expect(t.labelledIssues("epic")).rejects.toThrow("completedAt");
  });
});

describe("Linear adapter: candidate pools", () => {
  const poolNode = (
    identifier: string,
    extra: Record<string, unknown> = {},
  ) => ({
    identifier,
    title: `t ${identifier}`,
    url: `https://tracker.example/${identifier}`,
    priority: 3,
    createdAt: "2026-09-01T00:00:00.000Z",
    state: { id: "s-backlog", name: "Backlog", type: "backlog" },
    assignee: null,
    labels: labels("small", "area:docs"),
    children: { pageInfo: { hasNextPage: false }, nodes: [] },
    ...extra,
  });

  it("filters an open pool by team, open state and each label clause", async () => {
    const { t, calls } = tracker(() => ({ issues: page([poolNode("ENG-4")]) }));
    const got = await t.openIssues({
      withSomeOf: [["area:docs"], ["xs", "small"]],
    });
    expect(got.map((i) => i.identifier)).toEqual(["ENG-4"]);
    expect(calls[0]?.variables.filter).toEqual({
      and: [
        { team: { key: { eq: "ENG" } } },
        { state: { type: { nin: ["completed", "canceled", "duplicate"] } } },
        { labels: { name: { in: ["area:docs"] } } },
        { labels: { name: { in: ["xs", "small"] } } },
      ],
    });
  });

  it("excludes labels with every-not-in, not some-not-in", async () => {
    const { t, calls } = tracker(() => ({ issues: page([]) }));
    await t.openIssues({
      withSomeOf: [["area:docs"]],
      withNoneOf: ["xs", "small", "large"],
    });
    const filter = calls[0]?.variables.filter as { and: unknown[] } | undefined;
    expect(filter?.and.at(-1)).toEqual({
      labels: { every: { name: { nin: ["xs", "small", "large"] } } },
    });
  });

  it("refuses a pool query that would read every open issue", async () => {
    const { t, calls } = tracker(() => ({ issues: page([]) }));
    await expect(t.openIssues({ withSomeOf: [] })).rejects.toThrow(
      "every open issue",
    );
    await expect(t.openIssues({ withSomeOf: [["a"], []] })).rejects.toThrow(
      "every open issue",
    );
    expect(calls).toHaveLength(0);
  });

  it("reads ids beside names, open children, and a truncated label page", async () => {
    const { t } = tracker(() => ({
      issues: page([
        poolNode("ENG-1", {
          assignee: { id: "u-1", name: "Sam" },
          labels: { pageInfo: { hasNextPage: true }, nodes: [{ name: "xs" }] },
          children: { pageInfo: { hasNextPage: false }, nodes: [{ id: "c" }] },
        }),
        poolNode("ENG-2"),
      ]),
    }));
    const [first, second] = await t.openIssues({ withSomeOf: [["xs"]] });
    expect(first).toMatchObject({
      state: { id: "s-backlog", name: "Backlog", type: "backlog" },
      assignee: { id: "u-1", name: "Sam" },
      hasOpenChildren: true,
      truncated: ["labels"],
    });
    expect(second).toMatchObject({
      assignee: null,
      hasOpenChildren: false,
      truncated: [],
      labels: ["small", "area:docs"],
    });
  });

  it("refuses a pool node it cannot read", async () => {
    const { t } = tracker(() => ({
      issues: page([
        poolNode("ENG-1", { state: { name: "Backlog", type: "backlog" } }),
      ]),
    }));
    await expect(t.openIssues({ withSomeOf: [["xs"]] })).rejects.toThrow(
      "state.id",
    );
  });

  it("reads an issue's open children across pages", async () => {
    const { t, calls } = tracker((_call, n) => ({
      issue: {
        children:
          n === 0 ? page([poolNode("ENG-2")], "c1") : page([poolNode("ENG-3")]),
      },
    }));
    const got = await t.openChildren("ENG-1");
    expect(got.map((i) => i.identifier)).toEqual(["ENG-2", "ENG-3"]);
    expect(calls[0]?.variables.filter).toEqual({
      and: [
        { team: { key: { eq: "ENG" } } },
        { state: { type: { nin: ["completed", "canceled", "duplicate"] } } },
      ],
    });
    expect(calls[1]?.variables.after).toBe("c1");
  });

  it("refuses the children of another team's issue", async () => {
    const { t, calls } = tracker(() => ({ issue: { children: page([]) } }));
    await expect(t.openChildren("OPS-1")).rejects.toThrow("not a ENG issue");
    expect(calls).toHaveLength(0);
  });

  it("refuses an unreadable children page or an out-of-range priority", async () => {
    for (const extra of [
      { children: { pageInfo: {}, nodes: [] } },
      { priority: -1 },
      { priority: 1.5 },
      { priority: 5 },
    ]) {
      const { t } = tracker(() => ({
        issues: page([poolNode("ENG-1", extra)]),
      }));
      await expect(t.openIssues({ withSomeOf: [["xs"]] })).rejects.toThrow(
        "pool issue ENG-1",
      );
    }
  });

  it("reads one issue in pool form and reports a missing one as null", async () => {
    const found = tracker(() => ({
      issue: poolNode("ENG-9", {
        state: { id: "s-d", name: "Done", type: "completed" },
      }),
    }));
    expect((await found.t.poolIssue("ENG-9"))?.state.type).toBe("completed");
    const missing = tracker(
      () => new LinearApiError("Entity not found", 200, true),
    );
    expect(await missing.t.poolIssue("ENG-404")).toBeNull();
    const empty = tracker(() => ({ issue: null }));
    expect(await empty.t.poolIssue("ENG-404")).toBeNull();
    const omitted = tracker(() => ({}));
    await expect(omitted.t.poolIssue("ENG-9")).rejects.toThrow(
      "expected an object",
    );
  });
});
