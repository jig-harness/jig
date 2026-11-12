/**
 * A deferred finding filed into a repository whose label taxonomy requires a
 * group beyond the facets: `file-deferred.ts` derives that group's label from
 * the change-area catalog's areas covering the file the review thread is on,
 * and the filing check inside `createIssue` accepts it; one it cannot derive
 * stays in the `## Deferred` section for a person, naming the group.
 */
import { describe, expect, test } from "bun:test";
import {
  conn,
  gitHub,
  issueNode,
  JIG_TAXONOMY,
  oneIssue,
  repoLabels,
} from "../../do-item/__tests__/github-fixtures.ts";
import {
  facetInputs,
  parseTrackerConfig,
} from "../../do-item/scripts/lib/tracker/config.ts";
import { checkedTracker } from "../../do-item/scripts/lib/tracker/facets/complete.ts";
import { resolveFacets } from "../../do-item/scripts/lib/tracker/facets/config.ts";
import type { NewIssue } from "../../do-item/scripts/lib/tracker/port.ts";
import { parseCatalog } from "../../drive-pr/scripts/lib/change-areas-catalog.ts";
import type { Taxonomy } from "../../file-issue/scripts/lib/taxonomy.ts";
import { fileDeferred } from "../scripts/file-deferred.ts";
import {
  type CatalogSource,
  entryLabels,
} from "../scripts/lib/deferred-labels.ts";
import {
  deferredEntries,
  withDeferredEntry,
} from "../scripts/lib/deferred-section.ts";
import type { PrBody, PrBodyForge } from "../scripts/lib/pr-body.ts";

const PR_URL = "https://github.com/example/project/pull/42";
const thread = (n: number) => `${PR_URL}#discussion_r${n}`;
const REC = { type: "bug", severity: "high", category: "correctness" };

const FACETS = resolveFacets(
  facetInputs(parseTrackerConfig({ issue_tracker: { adapter: "github" } })),
  { path: "label-taxonomy.yaml", ...JIG_TAXONOMY },
);

/** A taxonomy whose `repo` group is required, beside the size group. */
function taxonomy(required = true): Taxonomy {
  return {
    types: JIG_TAXONOMY.types,
    statuses: [],
    flags: [],
    categories: [],
    groups: [
      {
        id: "size",
        required: true,
        notRequiredOn: [],
        labels: JIG_TAXONOMY.sizes,
      },
      {
        id: "repo",
        required,
        notRequiredOn: [],
        labels: ["repo:web", "repo:api"],
      },
    ],
  };
}

const CATALOG: CatalogSource = {
  catalog: parseCatalog({
    areas: {
      web: { paths: ["web/**"], tracker: { labels: ["repo:web", "area:ui"] } },
      api: { paths: ["api/**"], tracker: { labels: ["repo:api"] } },
      shared: { paths: ["api/shared/**"], tracker: { labels: ["repo:web"] } },
      docs: { paths: ["docs/**"] },
    },
  }),
};

/** A pull request body in memory, its threads each on a file. */
function fakeForge(
  body: string,
  paths: Record<string, string>,
): PrBodyForge & { state: PrBody; pathReads: number } {
  const state: PrBody = {
    body,
    updatedAt: "2026-11-12T00:00:00Z",
    url: PR_URL,
  };
  let clock = 0;
  const forge = {
    state,
    pathReads: 0,
    async read() {
      return { ...state };
    },
    async write(_pr: string, next: string) {
      state.body = next;
      state.updatedAt = `2026-11-12T00:00:0${++clock}Z`;
    },
    async answers() {
      return [];
    },
    async threadPaths() {
      forge.pathReads += 1;
      return new Map(Object.entries(paths));
    },
  };
  return forge;
}

/** The GitHub adapter over a fake transport, every filing checked against `tax`. */
function checkedGitHub(tax: Taxonomy) {
  let next = 40;
  const { t } = gitHub(
    (c) => {
      if (c.op === "TrackerSearch")
        return {
          search: {
            issueCount: 0,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        };
      if (c.op === "TrackerIssue")
        return oneIssue(
          issueNode({ number: 1, extra: { subIssues: conn([]) } }),
        );
      if (c.op === "TrackerRepository") return { repository: { id: "R_1" } };
      if (c.op === "TrackerLabels")
        return repoLabels(
          "pr-followup",
          "repo:web",
          "repo:api",
          ...JIG_TAXONOMY.types,
          ...JIG_TAXONOMY.sizes,
          ...["urgent", "high", "medium", "low"].map((p) => `priority: ${p}`),
        );
      if (c.op === "TrackerCreate") {
        next += 1;
        return {
          createIssue: {
            issue: {
              number: next,
              url: `https://github.com/acme/app/issues/${next}`,
            },
          },
        };
      }
      throw new Error(`unexpected ${c.op}`);
    },
    { taxonomy: JIG_TAXONOMY },
  );
  const asked: NewIssue[] = [];
  const checked = checkedTracker(t, FACETS, tax);
  return {
    tracker: {
      ...checked,
      createIssue: (issue: NewIssue) => {
        asked.push(issue);
        return checked.createIssue(issue);
      },
    },
    asked,
  };
}

function bodyWith(...sources: string[]): string {
  let body = "## Summary\n\nWhat changed.";
  for (const source of sources)
    body = withDeferredEntry(body, {
      ...REC,
      source,
      finding: `The finding on ${source}.`,
      reason: "r",
    }).body;
  return body;
}

describe("file-deferred.ts fills a required group from the catalog", () => {
  test("files a finding on a covered file with its area's label of the group", async () => {
    const forge = fakeForge(bodyWith(thread(1)), { [thread(1)]: "web/app.ts" });
    const { tracker, asked } = checkedGitHub(taxonomy());
    const r = await fileDeferred(forge, tracker, "42", {
      label: "pr-followup",
      facets: FACETS,
      taxonomy: taxonomy(),
      catalog: () => CATALOG,
    });
    expect(r.why).toBeNull();
    expect(r.forPerson).toEqual([]);
    expect(r.filed.map((f) => f.key)).toEqual(["#41"]);
    expect(asked.map((i) => i.labels)).toEqual([["pr-followup", "repo:web"]]);
    expect(deferredEntries(forge.state.body)[0]?.filed?.key).toBe("#41");
  });

  test("leaves a finding on a file no area covers for a person, naming the group, and files the rest", async () => {
    const forge = fakeForge(bodyWith(thread(1), thread(2)), {
      [thread(1)]: "scripts/build.ts",
      [thread(2)]: "api/server.ts",
    });
    const { tracker, asked } = checkedGitHub(taxonomy());
    const r = await fileDeferred(forge, tracker, "42", {
      label: "pr-followup",
      facets: FACETS,
      taxonomy: taxonomy(),
      catalog: () => CATALOG,
    });
    expect(r.why).toBeNull();
    expect(r.forPerson.map((p) => [p.entry.source, p.why])).toEqual([
      [
        thread(1),
        "it lacks a repo label: no area of the change-area catalog covers scripts/build.ts",
      ],
    ]);
    expect(asked.map((i) => i.labels)).toEqual([["pr-followup", "repo:api"]]);
    const [left, filed] = deferredEntries(forge.state.body);
    expect(left?.filed).toBeUndefined();
    expect(filed?.filed?.key).toBe("#41");
    expect(forge.pathReads).toBe(1);
  });

  test("a thread the pull request does not list is named as such, not as a finding on no file", async () => {
    const forge = fakeForge(bodyWith(thread(9)), {});
    const { tracker, asked } = checkedGitHub(taxonomy());
    const r = await fileDeferred(forge, tracker, "42", {
      label: "pr-followup",
      facets: FACETS,
      taxonomy: taxonomy(),
      catalog: () => CATALOG,
    });
    expect(asked).toEqual([]);
    expect(r.forPerson.map((p) => p.why)).toEqual([
      `it lacks a repo label, which is derived only from the file a review thread is on: no review thread of this pull request starts at ${thread(9)}`,
    ]);
  });

  test("files exactly as before where the taxonomy requires no other group", async () => {
    const forge = fakeForge(bodyWith(thread(1)), {});
    const { tracker, asked } = checkedGitHub(taxonomy(false));
    let catalogReads = 0;
    const r = await fileDeferred(forge, tracker, "42", {
      label: "pr-followup",
      facets: FACETS,
      taxonomy: taxonomy(false),
      catalog: () => {
        catalogReads += 1;
        return CATALOG;
      },
    });
    expect(r.why).toBeNull();
    expect(asked.map((i) => i.labels)).toEqual([["pr-followup"]]);
    expect(forge.pathReads).toBe(0);
    expect(catalogReads).toBe(0);
  });

  test("without the derived label the filing check refuses the finding", async () => {
    const { tracker } = checkedGitHub(taxonomy());
    await expect(
      tracker.createIssue({
        title: "t",
        description: "d",
        labels: ["pr-followup"],
        type: "bug",
        priority: 2,
        size: "small",
      }),
    ).rejects.toThrow("no repo label");
  });
});

describe("the labels a deferred finding is filed with", () => {
  const derive = (path: string, catalog: CatalogSource = CATALOG) =>
    entryLabels("pr-followup", { path }, taxonomy(), () => catalog);

  test("a finding on no file names why, and the group is not derived", () => {
    expect(
      entryLabels(
        "pr-followup",
        { none: "it is a summary finding" },
        taxonomy(),
        () => CATALOG,
      ),
    ).toEqual({
      why: "it lacks a repo label, which is derived only from the file a review thread is on: it is a summary finding",
    });
  });

  test("labels match ignoring case, and the taxonomy's spelling is filed", () => {
    const shouting: CatalogSource = {
      catalog: parseCatalog({
        areas: {
          web: { paths: ["web/**"], tracker: { labels: ["Repo:Web"] } },
        },
      }),
    };
    expect(derive("web/app.ts", shouting)).toEqual({
      labels: ["pr-followup", "repo:web"],
    });
  });

  test("areas that carry two labels of the group are no certainty", () => {
    expect(derive("api/shared/types.ts")).toEqual({
      why: "it lacks a repo label: the areas covering api/shared/types.ts carry more than one (repo:web and repo:api)",
    });
  });

  test("an area that carries no label of the group derives none", () => {
    expect(derive("docs/guide.md")).toEqual({
      why: "it lacks a repo label: no area covering docs/guide.md (docs) carries one",
    });
  });

  test("without a catalog the group is not derived, and why is named", () => {
    expect(
      derive("web/app.ts", { catalog: null, why: "no catalog here" }),
    ).toEqual({ why: "it lacks a repo label: no catalog here" });
  });

  test("only the group's labels are added, not the area's other tracker labels", () => {
    expect(derive("web/app.ts")).toEqual({
      labels: ["pr-followup", "repo:web"],
    });
  });

  test("with no taxonomy the follow-up label alone is filed", () => {
    expect(
      entryLabels("pr-followup", { path: "web/app.ts" }, null, () => {
        throw new Error("the catalog is not read");
      }),
    ).toEqual({ labels: ["pr-followup"] });
  });
});
