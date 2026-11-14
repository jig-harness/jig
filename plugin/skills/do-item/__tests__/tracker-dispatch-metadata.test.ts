import { describe, expect, it } from "bun:test";
import {
  conn,
  gitHub,
  gitHubDefaulted,
  issueNode,
  oneIssue,
} from "./github-fixtures.ts";
import { issue, jira, jqlOf, MEMBER, page, routes } from "./jira-fixtures.ts";

describe("dispatch metadata readings", () => {
  it("sends no metadata request when the shared scope is already offline", async () => {
    const github = gitHubDefaulted(() => {
      throw new Error("must not read");
    });
    const atlassian = jira(() => {
      throw new Error("must not read");
    });
    const reads = new Map<string, Promise<unknown>>([
      [
        "dispatch scope failure",
        Promise.resolve(new Error("scope is offline")),
      ],
    ]);
    const ghSource = github.t.dispatchSource;
    const jiraSource = atlassian.t.dispatchSource;
    if (ghSource === undefined || jiraSource?.projectRelations === undefined)
      throw new Error("missing native source");
    ghSource.shareReads?.(reads);
    jiraSource.shareReads?.(reads);
    await expect(
      ghSource.project({ identifier: "#1", value: issueNode({ number: 1 }) }),
    ).rejects.toThrow("offline");
    await expect(
      jiraSource.projectRelations({
        identifier: "ENG-1",
        value: { issue: issue({ key: "ENG-1" }), children: [] },
      }),
    ).rejects.toThrow("offline");
    expect(github.calls).toHaveLength(0);
    expect(atlassian.calls).toHaveLength(0);
  });

  it("projects the same Jira queue links with each checkout's direction mapping", async () => {
    const answer = routes({
      "GET user": MEMBER,
      "POST search/jql": (call: Parameters<typeof jqlOf>[0]) =>
        jqlOf(call).includes("parent in")
          ? page()
          : page(
              issue({
                key: "ENG-1",
                links: [{ type: "Blocks", outward: "ENG-2" }],
              }),
            ),
      "GET issueLinkType": {
        issueLinkTypes: [
          { name: "Blocks", inward: "is blocked by", outward: "blocks" },
          { name: "Relates", inward: "relates to", outward: "relates to" },
          {
            name: "Duplicate",
            inward: "is duplicated by",
            outward: "duplicates",
          },
        ],
      },
    });
    const first = jira(answer);
    const second = jira(answer, {
      issue_tracker: {
        jira: { link_types: { blocks: { name: "Blocks", inverted: true } } },
      },
    });
    const reads = new Map<string, Promise<unknown>>();
    const a = first.t.dispatchSource;
    const b = second.t.dispatchSource;
    if (a === undefined || b === undefined) throw new Error("missing source");
    a.shareReads?.(reads);
    b.shareReads?.(reads);
    const raw = (await a.queue(MEMBER.accountId))[0];
    if (raw === undefined) throw new Error("missing issue");
    expect(await a.projectRelations?.(raw)).toEqual([
      { type: "blocks", issue: "ENG-2" },
    ]);
    expect(await b.projectRelations?.(raw)).toEqual([
      { type: "blocked_by", issue: "ENG-2" },
    ]);
    const calls = [...first.calls, ...second.calls];
    expect(
      calls.filter((call) => call.route === "GET issueLinkType"),
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.route.startsWith("GET issue/")),
    ).toHaveLength(0);
    expect(
      second.calls.filter((call) => call.route === "POST search/jql"),
    ).toHaveLength(0);
  });

  it("keeps launch-time issue reads fresh after metadata sharing is installed", async () => {
    const github = gitHub(() =>
      oneIssue(issueNode({ number: 1, extra: { subIssues: conn([]) } })),
    );
    const atlassian = jira(
      routes({
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
        "POST search/jql": page(),
      }),
    );
    for (const { t } of [github, atlassian]) {
      const source = t.dispatchSource;
      if (source === undefined) throw new Error("missing source");
      source.shareReads?.(new Map());
      const key = t.adapter === "github" ? "#1" : "ENG-1";
      await source.issue(key);
      await source.issue(key);
    }
    expect(
      github.calls.filter((call) => call.op === "TrackerDispatchIssue"),
    ).toHaveLength(2);
    expect(
      atlassian.calls.filter((call) => call.route === "GET issue/ENG-1"),
    ).toHaveLength(2);
  });

  it("resolves Jira fields and issue types once for different checkout mappings", async () => {
    const reads = new Map<string, Promise<unknown>>();
    const answer = routes({
      "GET field": [
        { id: "customfield_10050", name: "Size", schema: { type: "option" } },
      ],
      "GET issue/createmeta/ENG/issuetypes": {
        issueTypes: [
          { id: "t1", name: "Task", subtask: false, hierarchyLevel: 0 },
        ],
        startAt: 0,
        maxResults: 100,
        total: 1,
      },
    });
    const trackers = ["small", "medium", "large"].map((size) =>
      jira(answer, {
        issue_tracker: {
          jira: { pool_issue_types: ["Task"] },
          facets: {
            size: { store: "field", field: "Size", values: { [size]: "S" } },
          },
        },
        taxonomy: { types: ["feature"], sizes: [size] },
      }),
    );
    const raw = {
      identifier: "ENG-1",
      value: {
        issue: issue({
          key: "ENG-1",
          fields: { customfield_10050: { value: "S" } },
        }),
        children: [],
      },
    };
    const sizes: Array<string | null> = [];
    for (const { t } of trackers) {
      const source = t.dispatchSource;
      if (source === undefined) throw new Error("missing native source");
      source.shareReads?.(reads);
      expect(await source.includes?.(raw)).toBe(true);
      sizes.push((await source.project(raw)).size);
    }
    expect(sizes).toEqual(["small", "medium", "large"]);
    const calls = trackers.flatMap((tracker) => tracker.calls);
    expect(calls.filter((call) => call.route === "GET field")).toHaveLength(1);
    expect(
      calls.filter(
        (call) => call.route === "GET issue/createmeta/ENG/issuetypes",
      ),
    ).toHaveLength(1);
    expect(calls.filter((call) => call.route === "GET myself")).toHaveLength(1);
  });

  it("shares GitHub's default-store evidence without sharing checkout interpretations", async () => {
    const reads = new Map<string, Promise<unknown>>();
    const trackers = ["feature", "bug", "task"].map((type, index) =>
      gitHubDefaulted(
        (call) => {
          if (call.op !== "TrackerFacetEvidence")
            throw new Error(`unexpected ${call.op}`);
          const counts = Object.fromEntries(
            [...call.query.matchAll(/(l_\w+_\d+):/g)].map((match) => [
              match[1],
              { totalCount: 0 },
            ]),
          );
          return {
            repository: {
              issueTypes: conn([]),
              issueFields: conn([]),
              ...counts,
            },
          };
        },
        {
          issue_tracker: {
            states: { todo: `Queued${index}` },
            facets: { type: { store: "label" }, size: { store: "label" } },
          },
          taxonomy: { types: [type], sizes: ["small"] },
        },
      ),
    );
    for (const { t } of trackers) t.dispatchSource?.shareReads?.(reads);
    const reports = await Promise.all(
      trackers.map(({ t }) => t.facetStores({ discovery: false })),
    );
    expect(
      reports.map(
        (report) =>
          report.facets.find((facet) => facet.facet === "priority")?.store,
      ),
    ).toEqual(["label", "label", "label"]);
    expect(
      trackers.flatMap((tracker) => tracker.calls).map((call) => call.op),
    ).toEqual(["TrackerFacetEvidence"]);
  });
});
