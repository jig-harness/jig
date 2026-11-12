/**
 * An issue of a native type `issue_tracker.labels.epic_types` lists is an
 * epic on every adapter with issue types, without the epic label: the
 * tracker interface's `isEpic` says so, a read by the epic label takes it,
 * and `get_issue.ts` reports it.
 */

import { describe, expect, it } from "bun:test";
import { getIssue } from "../scripts/get_issue.ts";
import {
  facetInputs,
  parseTrackerConfig,
} from "../scripts/lib/tracker/config.ts";
import { incompleteness } from "../scripts/lib/tracker/facets/complete.ts";
import { resolveFacets } from "../scripts/lib/tracker/facets/config.ts";
import { numberKeys, teamKeys } from "../scripts/lib/tracker/keys.ts";
import {
  conn,
  gitHub,
  issueNode,
  oneIssue,
  repoLabels,
} from "./github-fixtures.ts";
import { issue, jira, jqlOf, page, routes } from "./jira-fixtures.ts";

const EPIC_TYPES = { labels: { epic_types: ["Epic"] } };

/** A GitHub issue read alone or in pool form carries its sub-issues. */
const NO_CHILDREN = { subIssues: conn([]) };

describe("Jira: an epic by its issue type", () => {
  const read = (type: string, labels: string[] = []) =>
    jira(
      routes({
        "GET issue/ENG-5": issue({ key: "ENG-5", type, labels }),
        "POST search/jql": page(),
      }),
      { issue_tracker: EPIC_TYPES },
    ).t;

  it("reads an issue of a listed type with no labels as an epic", async () => {
    expect((await read("Epic").getIssue("ENG-5"))?.isEpic).toBe(true);
    // Matched ignoring case, as Jira names a type.
    expect((await read("epic").getIssue("ENG-5"))?.isEpic).toBe(true);
  });

  it("reads an unlisted type as no epic, and the label on any type as one", async () => {
    expect((await read("Story").getIssue("ENG-5"))?.isEpic).toBe(false);
    expect((await read("Task", ["epic"]).getIssue("ENG-5"))?.isEpic).toBe(true);
  });

  it("reads the type alone as no epic where no epic_types is set", async () => {
    const { t } = jira(
      routes({
        "GET issue/ENG-5": issue({ key: "ENG-5", type: "Epic" }),
        "POST search/jql": page(),
      }),
    );
    expect((await t.getIssue("ENG-5"))?.isEpic).toBe(false);
  });

  it("marks a pool issue of a listed type as an epic", async () => {
    const { t } = jira(
      routes({
        "POST search/jql": (call: { body: Record<string, unknown> }) =>
          String(call.body.jql).startsWith("parent in")
            ? page()
            : page(
                issue({ key: "ENG-1", type: "Epic", labels: ["a"] }),
                issue({ key: "ENG-2", type: "Story", labels: ["a"] }),
              ),
      }),
      { issue_tracker: EPIC_TYPES },
    );
    const pool = await t.openIssues({ withSomeOf: [["a"]] });
    expect(pool.map((i) => [i.identifier, i.isEpic])).toEqual([
      ["ENG-1", true],
      ["ENG-2", false],
    ]);
  });

  it("reads the epic label's issues by label or by type, and never asks the site for the label", async () => {
    const { t, calls } = jira(
      routes({
        "POST search/jql": page(issue({ key: "ENG-9", type: "Epic" })),
      }),
      { issue_tracker: EPIC_TYPES },
    );
    const found = await t.labelledIssues("epic");
    expect(found.map((i) => i.identifier)).toEqual(["ENG-9"]);
    expect(calls.map((c) => c.route)).toEqual([
      "GET myself",
      "POST search/jql",
    ]);
    expect(jqlOf(calls[1] as never)).toBe(
      'project = ENG AND (labels = "epic" OR issuetype in ("Epic")) ORDER BY created ASC',
    );
  });

  it("reads another label, and the epic label without epic_types, by the label alone", async () => {
    const typed = jira(routes({ "POST search/jql": page() }), {
      issue_tracker: EPIC_TYPES,
    });
    await typed.t.labelledIssues("pr-followup");
    const plain = jira(routes({ "POST search/jql": page() }));
    await plain.t.labelledIssues("epic");
    expect(
      [typed.calls, plain.calls].map((c) => jqlOf(c.at(-1) as never)),
    ).toEqual([
      'project = ENG AND labels = "pr-followup" ORDER BY created ASC',
      'project = ENG AND labels = "epic" ORDER BY created ASC',
    ]);
  });

  it("reads a ledger of the epic label by type too, needing no such label on the site", async () => {
    const { t, calls } = jira(
      routes({
        "POST search/jql": page(issue({ key: "ENG-9", type: "Epic" })),
      }),
      { issue_tracker: EPIC_TYPES },
    );
    const ledger = await t.ledger({ label: "epic" });
    expect(ledger.map((l) => l.identifier)).toEqual(["ENG-9"]);
    expect(calls.map((c) => c.route)).not.toContain("GET label");
    expect(jqlOf(calls.at(-1) as never)).toContain(
      '(labels = "epic" OR issuetype in ("Epic"))',
    );
  });

  it("reports an Epic-type issue with no labels as an epic through get_issue", async () => {
    const result = await getIssue("ENG-5", read("Epic"), teamKeys("ENG"));
    expect(result).toMatchObject({
      found: true,
      labels: [],
      nativeType: "Epic",
      isEpic: true,
    });
  });
});

describe("GitHub: an epic by its issue type", () => {
  const one = (issueType: string | null, labels: string[] = []) =>
    gitHub(
      () =>
        oneIssue(
          issueNode({ number: 5, issueType, labels, extra: NO_CHILDREN }),
        ),
      {
        issue_tracker: EPIC_TYPES,
      },
    ).t;

  it("reads an issue of a listed type with no labels as an epic", async () => {
    expect((await one("Epic").getIssue("#5"))?.isEpic).toBe(true);
    expect((await one("Feature").getIssue("#5"))?.isEpic).toBe(false);
    expect((await one(null, ["epic"]).getIssue("#5"))?.isEpic).toBe(true);
  });

  it("reads the issue type in a pool read and marks the epic", async () => {
    const { t, calls } = gitHub(
      () =>
        oneIssue(
          issueNode({ number: 5, issueType: "Epic", extra: NO_CHILDREN }),
        ),
      { issue_tracker: EPIC_TYPES },
    );
    const pool = await t.poolIssue("#5");
    expect(pool?.isEpic).toBe(true);
    expect(calls[0]?.query).toContain("issueType { name }");
  });

  it("reads the epic label's issues by label, then by each listed type, each issue once", async () => {
    const { t, calls } = gitHub(
      (call) => {
        if (call.op === "TrackerLabels") return repoLabels("epic");
        const filter = call.variables.filterBy as Record<string, unknown>;
        const nodes =
          filter.type === "Epic"
            ? [
                issueNode({ number: 1, labels: ["epic"], issueType: "Epic" }),
                issueNode({ number: 2, issueType: "Epic" }),
              ]
            : [issueNode({ number: 1, labels: ["epic"], issueType: "Epic" })];
        return { repository: { issues: conn(nodes) } };
      },
      { issue_tracker: EPIC_TYPES },
    );
    const found = await t.labelledIssues("epic");
    expect(found.map((i) => i.identifier)).toEqual(["#1", "#2"]);
    expect(calls.map((c) => c.variables.filterBy)).toEqual([
      { labels: ["epic"] },
      { type: "Epic" },
    ]);
  });

  it("reads a ledger of the epic label by type too, refusing a type the repository lacks", async () => {
    const answer = (types: string[]) => (call: { op: string }) =>
      call.op === "TrackerFacetStores"
        ? {
            repository: {
              issueTypes: conn(types.map((name) => ({ id: name, name }))),
              issueFields: conn([]),
            },
          }
        : { repository: { issues: conn([issueNode({ number: 2 })]) } };
    const { t, calls } = gitHub(answer(["Bug", "Epic"]), {
      issue_tracker: EPIC_TYPES,
    });
    const ledger = await t.ledger({ label: "epic" });
    expect(ledger.map((l) => l.identifier)).toEqual(["#2"]);
    expect(calls.map((c) => c.op)).not.toContain("TrackerLabels");
    const typo = gitHub(answer(["Bug"]), { issue_tracker: EPIC_TYPES });
    await expect(typo.t.ledger({ label: "epic" })).rejects.toThrow(
      "names 'Epic', which is no issue type",
    );
  });

  it("reads the epic label alone where no epic_types is set", async () => {
    const { t, calls } = gitHub(() => ({ repository: { issues: conn([]) } }));
    await t.labelledIssues("epic");
    expect(calls.map((c) => c.variables.filterBy)).toEqual([
      { labels: ["epic"] },
    ]);
  });

  it("reports an Epic-type issue with no labels as an epic through get_issue", async () => {
    const result = await getIssue("#5", one("Epic"), numberKeys(null));
    expect(result).toMatchObject({ labels: [], isEpic: true });
  });
});

describe("the filing check", () => {
  it("asks no size of a new issue filed as a listed issue type", () => {
    const config = parseTrackerConfig({
      issue_tracker: {
        adapter: "jira",
        team: "ENG",
        jira: { site: "https://example.atlassian.net" },
        labels: { epic_types: ["Epic"] },
        facets: { type: { store: "native", values: { epic: "Epic" } } },
      },
    });
    const facets = resolveFacets(facetInputs(config), {
      path: "label-taxonomy.yaml",
      types: ["epic", "feature"],
      sizes: ["small", "large"],
    });
    const filed = (type: string) =>
      incompleteness(
        { title: "t", description: "", labels: [], type, priority: 2 },
        facets,
        null,
      );
    expect(filed("epic")).toEqual([]);
    expect(filed("feature")).toEqual(["size"]);
  });
});
