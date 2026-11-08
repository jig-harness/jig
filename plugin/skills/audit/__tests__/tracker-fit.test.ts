import { describe, expect, test } from "bun:test";
import type {
  FacetReadOptions,
  FacetStoreReport,
  Tracker,
} from "../../do-item/scripts/lib/tracker/port.ts";
import { facetFindings } from "../scripts/lib/tracker-fit.ts";

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

  test("reports a detection it could not read as unchecked, and asks no other adapter", async () => {
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
    const jira = tracker([], "jira");
    expect(await facetFindings(jira.t)).toEqual([]);
    expect(jira.asked).toEqual([]);
  });
});
