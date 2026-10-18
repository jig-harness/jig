/**
 * The projections, byte for byte, and the default validation plan.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dump as pinnedDump } from "js-yaml";
import { type Catalog, validateCatalog } from "../scripts/lib/catalog.ts";
import {
  defaultValidation,
  foldGenerated,
  ValidationPlanError,
  foldOwnTests,
  hasUnmatchedFile,
  orderedUnion,
  selectedProfiles,
  shellQuote,
  toDornyFilter,
  toGhaOutputs,
  toJson,
  toPostDeployChecklist,
  toResolution,
  toReviewGateTable,
  trackerProjection,
} from "../scripts/lib/emit.ts";
import { fixture, resolution } from "./helpers.ts";

const catalog = fixture();
const GOLDEN_FILES = [
  "tools/gen/schema.ts",
  "docs/adr/0002-choice.md",
  "packages/core-lib/src/index.ts",
  "stray.txt",
];

/** A small catalog, written inline, for the exact-bytes formats. */
const small: Catalog = validateCatalog({
  areas: {
    lib: {
      title: "Lib",
      category: "library",
      paths: ["lib/**"],
      workspace: [],
      impliedBy: [],
      deployTier: "none",
    },
    app: {
      title: "App",
      category: "app",
      paths: ["app/**", "*.config.ts"],
      workspace: [],
      impliedBy: ["lib"],
      deployTier: "primary",
      generated: [
        {
          outputs: ["app/routes.gen.ts"],
          source: ["routes/{a,b}.yaml"],
          command: "gen",
          check: "gen --check",
        },
      ],
    },
  },
});

describe("GitHub outputs", () => {
  test("one line per area for the closure, one per area for the seed, then the composer's", () => {
    expect(toGhaOutputs(resolution(["lib/x.ts"], small), ["code=true"])).toBe(
      "app=true\nlib=true\napp-seed=false\nlib-seed=true\ncode=true",
    );
    expect(toGhaOutputs(resolution(["routes/a.yaml"], small))).toBe(
      "app=true\nlib=false\napp-seed=true\nlib-seed=false",
    );
  });

  test("a fan-in area is resolved without being a seed", () => {
    const lines = toGhaOutputs(resolution(["docs/guide.md"])).split("\n");
    expect(lines).toContain("search-index=true");
    expect(lines).toContain("search-index-seed=false");
    expect(lines).toContain("docs-seed=true");
  });
});

describe("the dorny filter", () => {
  test("folds every implier's seed globs into an area's, sorted, as js-yaml writes them", () => {
    const expected =
      "app:\n  - '*.config.ts'\n  - app/**\n  - lib/**\n  - routes/{a,b}.yaml\nlib:\n  - lib/**\n";
    expect(toDornyFilter(small)).toBe(expected);
    const filter: Record<string, string[]> = {
      app: ["*.config.ts", "app/**", "lib/**", "routes/{a,b}.yaml"],
      lib: ["lib/**"],
    };
    expect(expected).toBe(
      pinnedDump(filter, { sortKeys: true, lineWidth: -1 }),
    );
  });

  test("matches exactly the files that resolve to the area", () => {
    const filter = toDornyFilter(catalog);
    for (const file of [
      "apps/api-service/src/routes/a.ts",
      "tools/gen/schema.ts",
      "docs/guide.md",
      "package.json",
      "README.md",
    ]) {
      const resolved = resolution([file]).resolved;
      const doc = Bun.YAML.parse(filter) as Record<string, string[]>;
      for (const [area, globs] of Object.entries(doc))
        expect(
          globs.some((g) => new Bun.Glob(g).match(file)),
          `${file} -> ${area}`,
        ).toBe(resolved.has(area));
    }
  });
});

describe("JSON", () => {
  test("matches the golden resolution, key order and indentation included", () => {
    expect(`${toJson(resolution(GOLDEN_FILES))}\n`).toBe(
      readFileSync(
        join(import.meta.dir, "fixtures", "resolution.json"),
        "utf8",
      ),
    );
  });

  test("tracker labels and flags come from the seeds, in either spelling, never the closure", () => {
    // A shared-library change reaches the API service, whose flag a label
    // would then claim for a change that never touched it.
    expect(
      trackerProjection(resolution(["packages/core-lib/a.ts"]).seed, catalog),
    ).toEqual({
      labels: ["area:shared"],
      flags: ["needs-migration"],
    });
    expect(
      trackerProjection(resolution(["tools/gen/schema.ts"]).seed, catalog),
    ).toEqual({
      labels: ["area:api"],
      flags: [],
    });
  });

  test("review skills and post-deploy actions come from the closure; generators from the seeds", () => {
    const json = toResolution(resolution(["packages/core-lib/a.ts"]));
    expect(json.review.map((r) => r.area)).toEqual([
      "api-service",
      "core-lib",
      "web-app",
    ]);
    expect(json.reviewSkills).toEqual([
      "api-review",
      "lib-review",
      "ui-review",
    ]);
    expect(json.postDeploy.map((p) => p.area)).toEqual([
      "api-service",
      "search-index",
    ]);
    // api-schema is in the closure, but its generator's source did not change.
    expect(json.areas).toContain("api-schema");
    expect(json.generated).toEqual([]);
    // A hand edit to a generated output seeds the generator's area.
    expect(
      toResolution(resolution(["packages/api-schema/openapi.json"])).generated,
    ).toHaveLength(1);
  });
});

describe("the checklist and the review table", () => {
  test("the checklist lists the affected areas' actions with their notes, or nothing", () => {
    expect(toPostDeployChecklist(resolution(["apps/api-service/a.ts"]))).toBe(
      [
        "## Post-Deploy Actions Required",
        "",
        "> Run the following **after** the new image is rolled in each env. Order matters.",
        "",
        "- [ ] **[API Service]** warm the read-through cache",
        "  - _When_: after new instances are healthy",
        "  - _Envs_: staging, prod",
        "  > Runs against the deployed image.",
        "  > Safe to repeat.",
        "",
        "- [ ] **[Search Index]** rebuild the search index",
        "  - _When_: after the documents are published",
        "  - _Envs_: prod",
      ].join("\n"),
    );
    expect(toPostDeployChecklist(resolution(["tools/a.ts"]))).toBe("");
  });

  test("the review table has a row per area with review skills, every glob that affects it as trigger paths", () => {
    const withReview = validateCatalog({
      areas: {
        ...small.areas,
        app: {
          ...small.areas.app,
          review: { skills: ["ui-review"], notes: "  For\n  screens. " },
        },
      },
    });
    expect(toReviewGateTable(withReview)).toBe(
      [
        "<!-- Generated from catalog.yaml (each area's review.skills): do not edit by hand. -->",
        "",
        "# Area → Review-Skill Gate Table",
        "",
        "| Area | `catalog.yaml` key | Trigger paths | Review skills |",
        "|------|--------------------|---------------|---------------|",
        "| App | `app` | `app/**`<br>`*.config.ts`<br>`routes/{a,b}.yaml`<br>`lib/**` | `/ui-review` — For screens. |",
      ].join("\n"),
    );
  });

  test("the review table takes the repository's comment, preamble, footer and catalog name", () => {
    const table = toReviewGateTable(catalog, {
      comment: ["<!-- generated: run make review-table -->"],
      preamble: ["> One line of preamble."],
      footer: ["_Footer._"],
      catalogLabel: "areas.yaml",
    }).split("\n");
    expect(table.slice(0, 7)).toEqual([
      "<!-- generated: run make review-table -->",
      "",
      "# Area → Review-Skill Gate Table",
      "",
      "> One line of preamble.",
      "",
      "| Area | `areas.yaml` key | Trigger paths | Review skills |",
    ]);
    expect(table[7]).toBe(
      "|------|------------------|---------------|---------------|",
    );
    expect(table.slice(-2)).toEqual(["", "_Footer._"]);
  });
});

describe("the default validation plan", () => {
  test("unions the seeds' profiles in declared order, then folds in their own tests", () => {
    const plan = defaultValidation(
      resolution(["tools/build.ts", "docs/guide.md"]),
    );
    expect(plan.sourceAreas).toEqual(["docs", "tooling"]);
    expect(plan.profiles).toEqual(["shallow", "standard"]);
    expect(plan.localChecks).toEqual(["fmt", "lint", "bun test tools"]);
    expect(plan.verificationChecks).toEqual([
      "fmt --check",
      "lint",
      "bun test tools",
    ]);
    expect(plan.testbox).toEqual({
      required: false,
      command: null,
      warmupCommand: null,
      reason: null,
      requiredBy: [],
    });
    expect(plan.repositoryHooksRequired).toBe(true);
    expect(plan.githubCiRequired).toBe(true);
  });

  test("the profile comes from the seeds: a docs change that implies a service stays shallow", () => {
    const ctx = resolution(["docs/guide.md"]);
    expect(ctx.resolved.has("search-index")).toBe(true);
    expect(selectedProfiles(ctx)).toEqual(["shallow"]);
  });

  test("one unmatched file fails closed to the deepest profile, even beside narrower ones", () => {
    expect(hasUnmatchedFile(["docs/a.md"], catalog)).toBe(false);
    expect(hasUnmatchedFile(["docs/a.md", "stray.txt"], catalog)).toBe(true);
    expect(selectedProfiles(resolution(["docs/a.md", "stray.txt"]))).toEqual([
      "shallow",
      "deep",
    ]);
    expect(defaultValidation(resolution(["stray.txt"])).localChecks).toEqual([
      "fmt",
      "lint",
      "test",
      "build",
    ]);
  });

  test("an area without a validation block, or without a profile, takes the deepest", () => {
    expect(selectedProfiles(resolution(["apps/web-app/a.ts"]))).toEqual([
      "deep",
    ]);
    expect(selectedProfiles(resolution([".github/workflows/ci.yml"]))).toEqual([
      "deep",
    ]);
  });

  test("an empty diff owes nothing", () => {
    const plan = defaultValidation(resolution([]));
    expect(plan.profiles).toEqual([]);
    expect(plan.localChecks).toEqual([]);
    expect(plan.verificationChecks).toEqual([]);
  });

  test("a generator's command runs before the profile's checks, its check after them", () => {
    const plan = defaultValidation(resolution(["tools/gen/schema.ts"]));
    expect(plan.sourceAreas).toEqual(["api-schema", "tooling"]);
    expect(plan.localChecks).toEqual([
      "gen-schema",
      "fmt",
      "lint",
      "bun test tools",
    ]);
    expect(plan.verificationChecks).toEqual([
      "fmt --check",
      "lint",
      "gen-schema --check",
      "bun test tools",
    ]);
  });

  test("the folds add each command once, a generator moved ahead of the profile's checks", () => {
    const lists = {
      localChecks: ["fmt", "gen-schema", "test"],
      verificationChecks: ["gen-schema --check"],
    };
    expect(foldGenerated(lists, ["api-schema"], catalog)).toEqual({
      localChecks: ["gen-schema", "fmt", "test"],
      verificationChecks: ["gen-schema --check"],
    });
    expect(
      foldOwnTests(
        { localChecks: ["bun test tools"], verificationChecks: [] },
        ["tooling", "tooling", "docs"],
        catalog,
      ),
    ).toEqual({
      localChecks: ["bun test tools"],
      verificationChecks: ["bun test tools"],
    });
    expect(lists.localChecks).toEqual(["fmt", "gen-schema", "test"]);
  });

  test("a change that selects an undefined profile, or a catalog with no profiles, is refused, not planned empty", () => {
    const { generated: _, ...app } = small.areas
      .app as Catalog["areas"][string];
    const open = validateCatalog({
      areas: {
        a: {
          ...small.areas.lib,
          validation: { profile: "quick", ownTests: "t a" },
        },
        b: { ...app, paths: ["b/**"], impliedBy: [] },
      },
    });
    expect(() =>
      defaultValidation(resolution(["lib/x", "b/y", "stray"], open)),
    ).toThrow("the change selects profile `quick`");
    expect(() => defaultValidation(resolution(["b/y", "stray"], open))).toThrow(
      "the catalog defines no validation profiles",
    );
    expect(() => defaultValidation(resolution(["lib/x"], open))).toThrow(
      ValidationPlanError,
    );
    // Nothing changed owes nothing, profiles or not.
    expect(defaultValidation(resolution([], open)).localChecks).toEqual([]);
  });
});

test("the building blocks", () => {
  expect(orderedUnion([["a", "b"], ["b", "c"], ["a"]])).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(shellQuote("it's $HOME")).toBe(`'it'"'"'s $HOME'`);
});
