import { describe, expect, it } from "bun:test";
import {
  facetInputs,
  parseTrackerConfig,
} from "../scripts/lib/tracker/config.ts";
import { resolveFacets } from "../scripts/lib/tracker/facets/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";
import type { IncompleteQuery } from "../scripts/lib/tracker/port.ts";
import {
  conn,
  gitHub,
  gitHubDefaulted,
  issueNode,
  JIG_TAXONOMY,
} from "./github-fixtures.ts";
import { jira, routes } from "./jira-fixtures.ts";

const QUERY: IncompleteQuery = {
  missing: ["priority"],
  retired: [],
  limit: 10,
};

const stopped = () => {
  const c = new AbortController();
  c.abort();
  return c.signal;
};

/** Issue `n` of an open pool, as the GitHub adapter reads it. */
const open = (n: number) =>
  issueNode({ number: n, labels: ["area:x"], extra: { subIssues: conn([]) } });

/** Every `l_<facet>_<n>` count the query asks for, answered as the facet's first. */
function labelCounts(
  query: string,
  first: Record<string, { totalCount: number }>,
): Record<string, { totalCount: number }> {
  const out: Record<string, { totalCount: number }> = {};
  for (const m of query.matchAll(/(l_(\w+?)_\d+):/g))
    out[m[1] as string] = first[`l_${m[2]}_0`] ?? { totalCount: 0 };
  return out;
}

describe("facet reads within their caller's bounds", () => {
  it("starts no request once the signal has aborted or the deadline has passed", async () => {
    const { t, calls } = gitHub(() => ({}), { taxonomy: JIG_TAXONOMY });
    await expect(t.facetStores({ signal: stopped() })).rejects.toThrow(
      "the facet read was stopped",
    );
    await expect(
      t.incompleteIssues(QUERY, { deadline: Date.now() - 1 }),
    ).rejects.toThrow("the facet read's deadline has passed");
    const defaulted = gitHubDefaulted(() => ({}), { taxonomy: JIG_TAXONOMY });
    await expect(
      defaulted.t.facetStores({ signal: stopped() }),
    ).rejects.toThrow("stopped");
    await expect(
      defaulted.t.incompleteIssues(QUERY, { signal: stopped() }),
    ).rejects.toThrow();
    expect([...calls, ...defaulted.calls]).toEqual([]);
  });

  it("reads no further page of the population once the signal aborts", async () => {
    const stop = new AbortController();
    const { t, calls } = gitHub(
      () => {
        stop.abort();
        return { repository: { issues: conn([open(1)], "c1") } };
      },
      { issue_tracker: { facets: { priority: { store: "label" } } } },
    );
    await expect(
      t.incompleteIssues(QUERY, { signal: stop.signal }),
    ).rejects.toThrow("cancelled");
    expect(calls.map((c) => c.op)).toEqual(["TrackerIssues"]);
  });

  it("makes no further detection or discovery read once the signal aborts", async () => {
    const stop = new AbortController();
    const { t, calls } = gitHub(
      (c) => {
        stop.abort();
        if (c.op !== "TrackerFacetEvidence") throw new Error(`read ${c.op}`);
        // An issue type to look for: detection's second read is still owed.
        return {
          repository: {
            issueTypes: conn([{ id: "IT_Bug", name: "Bug" }]),
            issueFields: conn([]),
            ...labelCounts(c.query, {}),
          },
        };
      },
      { taxonomy: JIG_TAXONOMY },
    );
    const stores = await t.facetStores({ signal: stop.signal });
    expect(calls.map((c) => c.op)).toEqual(["TrackerFacetEvidence"]);
    expect(stores.facets[0]?.detection).toMatchObject({ status: "failed" });
    expect(stores.discovery.status).toBe("unavailable");
  });

  it("forwards the signal through Linear's and Jira's population reads", async () => {
    const calls: string[] = [];
    const stop = new AbortController();
    const transport: LinearTransport = async (query, _variables, signal) => {
      if (signal?.aborted === true) throw new Error("cancelled");
      calls.push(/(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "?");
      stop.abort();
      return {
        issues: {
          pageInfo: { hasNextPage: true, endCursor: "c1" },
          nodes: [
            {
              identifier: "ENG-1",
              title: "t",
              url: null,
              priority: 0,
              createdAt: "2026-09-01T00:00:00.000Z",
              state: { id: "s", name: "Backlog", type: "backlog" },
              assignee: null,
              labels: { pageInfo: { hasNextPage: false }, nodes: [] },
              children: { pageInfo: { hasNextPage: false }, nodes: [] },
            },
          ],
        },
      };
    };
    const config = parseTrackerConfig({
      issue_tracker: { adapter: "linear", team: "ENG" },
    });
    const linear = linearTracker({
      team: "ENG",
      states: config.states,
      transport,
      facets: resolveFacets(facetInputs(config), null),
    });
    await expect(
      linear.incompleteIssues(QUERY, { signal: stopped() }),
    ).rejects.toThrow("stopped");
    expect(calls).toEqual([]);
    await expect(
      linear.incompleteIssues(QUERY, { signal: stop.signal }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);

    const j = jira(routes({}));
    await expect(
      j.t.incompleteIssues(QUERY, { deadline: Date.now() - 1 }),
    ).rejects.toThrow("deadline");
    expect(j.calls).toEqual([]);
  });
});

describe("a bounded wait on a detection another caller started", () => {
  it("ends at its own deadline while the shared detection is unbounded", async () => {
    const { t } = gitHubDefaulted(() => new Promise(() => undefined), {
      taxonomy: JIG_TAXONOMY,
    });
    // The first caller bounds nothing and keeps the detection running.
    void t.getIssue("#1").catch(() => undefined);
    const started = Date.now();
    await expect(
      t.incompleteIssues(QUERY, { deadline: Date.now() + 50 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
