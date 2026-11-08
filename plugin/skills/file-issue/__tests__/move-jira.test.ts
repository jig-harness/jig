import { describe, expect, it } from "bun:test";
import {
  facetInputs,
  parseTrackerConfig,
} from "../../do-item/scripts/lib/tracker/config.ts";
import { resolveFacets } from "../../do-item/scripts/lib/tracker/facets/config.ts";
import type { Tracker } from "../../do-item/scripts/lib/tracker/port.ts";
import { moveProblem } from "../scripts/lib/move-safety.ts";

const TAXONOMY = {
  path: "label-taxonomy.yaml",
  types: ["bug", "feature", "docs"],
  sizes: ["small", "large"],
};

/** A Jira repository's facets with `facets` as its section. */
const jira = (facets: Record<string, unknown> = {}) =>
  resolveFacets(
    facetInputs(
      parseTrackerConfig({
        issue_tracker: {
          adapter: "jira",
          team: "ENG",
          jira: { site: "https://x.atlassian.net" },
          facets,
        },
      }),
    ),
    TAXONOMY,
  );

const sides = (
  source: Record<string, unknown>,
  target: Record<string, unknown>,
) => ({
  source: { adapter: "jira" } as Tracker,
  target: { adapter: "jira" } as Tracker,
  sourceFacets: jira(source),
  targetFacets: jira(target),
});

describe("a move on Jira", () => {
  it("refuses to retire type labels into the issue types, which keep a fallback type in them", () => {
    expect(
      moveProblem(sides({}, { type: { store: "native" } }), ["type"]),
    ).toContain(
      "Jira's issue type keeps a sub-task's type, and a type with no issue type of its own, in the type labels",
    );
  });

  it("refuses to move a type out of the issue types, which every issue keeps", () => {
    expect(
      moveProblem(sides({ type: { store: "native" } }, {}), ["type"]),
    ).toBe(
      "type: every Jira issue keeps its native issue type; moving it cannot retire the source",
    );
  });

  it("moves size from its labels into a custom field", () => {
    expect(
      moveProblem(sides({}, { size: { store: "field", field: "Size" } }), [
        "size",
      ]),
    ).toBeNull();
  });
});
