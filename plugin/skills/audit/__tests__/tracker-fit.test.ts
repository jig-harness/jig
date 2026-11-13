import { describe, expect, test } from "bun:test";
import type {
  FacetReadOptions,
  FacetStoreReport,
  Tracker,
} from "../../do-item/scripts/lib/tracker/port.ts";
import { JIRA_TIMEOUT_MS } from "../../do-item/scripts/lib/tracker/jira/transport.ts";
import {
  ANSWER_MS,
  facetFindings,
  poolScopeFindings,
} from "../scripts/lib/tracker-fit.ts";

/** A tracker of `adapter` whose `facetStores` reports `facets`, recording what it was asked. */
function tracker(
  facets: FacetStoreReport[] | Error,
  adapter = "github",
): { t: Tracker; asked: FacetReadOptions[] } {
  const asked: FacetReadOptions[] = [];
  const t = {
    adapter,
    async facetStores(options: FacetReadOptions = {}) {
      asked.push(options);
      if (facets instanceof Error) throw facets;
      return { facets, discovery: { status: "none", reason: "not read" } };
    },
  } as unknown as Tracker;
  return { t, asked };
}

describe("where the audited tracker keeps each facet", () => {
  test("offers the line that names a store in force, and fails a conflict", async () => {
    const { t, asked } = tracker([
      { facet: "type", store: "label", why: "configured" },
      {
        facet: "priority",
        store: "native",
        why: "detected",
        field: "Priority",
        pin: "issue_tracker.facets.priority: { store: native }",
      },
      {
        facet: "size",
        store: null,
        why: "conflict",
        problem: "size is in conflict: name one",
      },
    ]);
    expect(await facetFindings(t)).toEqual([
      {
        id: "suggestion:issue_tracker.facets.priority",
        severity: "suggestion",
        message:
          "priority is kept in the Priority field (detected), which no setting names, so every read and write of an issue waits on detecting it first; commit it: issue_tracker.facets.priority: { store: native }",
      },
      {
        id: "derivation:issue_tracker.facets.size",
        severity: "error",
        message:
          "size is in conflict: name one; until then every read and write of an issue fails",
      },
    ]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.discovery).toBe(false);
    expect(asked[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("reports a detection it could not read as unchecked", async () => {
    const { t } = tracker([
      {
        facet: "type",
        store: "label",
        why: "default",
        detection: { status: "failed", error: "timed out", unavailable: true },
      },
    ]);
    expect((await facetFindings(t)).map((f) => [f.id, f.severity])).toEqual([
      ["unchecked:issue_tracker.facets.type", "warning"],
    ]);
    const failed = tracker(new Error("no answer"));
    expect(await facetFindings(failed.t)).toEqual([
      {
        id: "unchecked:issue_tracker.facets",
        severity: "warning",
        message:
          "where type, priority and size are kept is unchecked: no answer",
      },
    ]);
  });

  test.each([
    ["jira", "type", "native", "issue type does not exist"],
    ["jira", "size", "field", "field does not exist"],
    ["linear", "size", "native", "team estimates are disabled"],
    ["github", "priority", "native", "Priority field does not exist"],
  ] as const)(
    "reports a failed %s %s store",
    async (adapter, facet, store, error) => {
      const { t, asked } = tracker(
        [
          {
            facet,
            store,
            why: "configured",
            health: { status: "failed", error },
          },
        ],
        adapter,
      );
      expect(await facetFindings(t)).toEqual([
        {
          id: `derivation:issue_tracker.facets.${facet}`,
          severity: "error",
          message: `${facet}'s configured store cannot be used: ${error}; its reads and writes fail`,
        },
      ]);
      expect(asked).toHaveLength(1);
      expect(asked[0]?.discovery).toBe(false);
      expect(asked[0]?.signal).toBeInstanceOf(AbortSignal);
    },
  );

  test.each(["jira", "linear"])(
    "does not offer GitHub detection advice for %s",
    async (adapter) => {
      const { t, asked } = tracker(
        [
          {
            facet: "size",
            store: "native",
            why: "configured",
            health: { status: "ok" },
          },
          { facet: "priority", store: "native", why: "default" },
          { facet: "type", store: null, why: "no facet" },
        ],
        adapter,
      );
      expect(await facetFindings(t)).toEqual([]);
      expect(asked).toHaveLength(1);
    },
  );

  test("reports a store probe the tracker could not answer as unchecked", async () => {
    const { t } = tracker(
      [
        {
          facet: "size",
          store: "native",
          why: "configured",
          health: { status: "failed", error: "timed out", unavailable: true },
        },
      ],
      "jira",
    );
    expect(await facetFindings(t)).toEqual([
      {
        id: "unchecked:issue_tracker.facets.size",
        severity: "warning",
        message:
          "whether size's configured store can be used is unchecked: timed out",
      },
    ]);
  });

  test.each(["jira", "linear"])(
    "reports an unreadable %s probe as unchecked",
    async (adapter) => {
      const { t } = tracker(new Error("no answer"), adapter);
      expect(await facetFindings(t)).toEqual([
        {
          id: "unchecked:issue_tracker.facets",
          severity: "warning",
          message:
            "where type, priority and size are kept is unchecked: no answer",
        },
      ]);
    },
  );
});

describe("the audit's deadline for one question to the tracker", () => {
  test("outlasts a Jira request's own, which names a stalled token command", () => {
    expect(ANSWER_MS).toBeGreaterThan(JIRA_TIMEOUT_MS);
  });
});

describe("the audit's open population scope counts", () => {
  test("reports estimates of the project and configured pool without reading issues", async () => {
    let seen: AbortSignal | undefined;
    const t = {
      poolScopeCounts: async (signal?: AbortSignal) => {
        seen = signal;
        return { project: 80, pool: 12, scoped: true, approximate: true };
      },
    } as unknown as Tracker;
    expect(await poolScopeFindings(t)).toEqual([
      {
        id: "info:issue_tracker.pool_scope",
        severity: "info",
        message:
          "open population (approximate): 80 issues in the project; 12 within the configured pool issue-type scope",
      },
    ]);
    expect(seen).toBeInstanceOf(AbortSignal);
  });
  test("reports an unscoped project and a failed count without assuming zero", async () => {
    const t = {
      poolScopeCounts: async () => ({
        project: 0,
        pool: 0,
        scoped: false,
        approximate: true,
      }),
    } as unknown as Tracker;
    expect((await poolScopeFindings(t))[0]?.message).toBe(
      "open population (approximate): 0 issues in the project; no pool issue-type scope is configured",
    );
    t.poolScopeCounts = async () => {
      throw new Error("unavailable");
    };
    expect(await poolScopeFindings(t)).toEqual([
      {
        id: "unchecked:issue_tracker.pool_scope",
        severity: "warning",
        message: "open population counts are unchecked: unavailable",
      },
    ]);
    expect(await poolScopeFindings({} as Tracker)).toEqual([]);
  });
});
