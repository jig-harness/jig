/**
 * The catalog schema: what loads, what is refused and how it is named, the
 * vocabularies and profiles, and the fields a composer adds.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Defect } from "../../../shared/errors.ts";
import {
  CatalogError,
  catalogProblems,
  deepestProfile,
  type FieldExtensions,
  loadCatalog,
  profileOf,
  readCatalogFile,
  validateCatalog,
} from "../scripts/lib/catalog.ts";
import { FIXTURE, fixture } from "./helpers.ts";

const area = (extra: Record<string, unknown> = {}) => ({
  title: "An area",
  category: "library",
  paths: ["lib/**"],
  workspace: [],
  impliedBy: [],
  deployTier: "none",
  ...extra,
});

const problems = (
  areas: Record<string, unknown>,
  top: Record<string, unknown> = {},
  fields?: FieldExtensions,
) => catalogProblems({ ...top, areas }, fields);

test("the fixture and M3's worked example and template load without problems", () => {
  const m3 = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "modules",
    "M3-change-area-catalog",
  );
  for (const path of [
    FIXTURE,
    join(m3, "reference", "catalog", "catalog.example.yaml"),
    join(m3, "templates", "catalog.yaml"),
  ])
    expect(catalogProblems(readCatalogFile(path)), path).toEqual([]);
  expect(Object.keys(fixture().areas)).toHaveLength(9);
});

describe("the areas", () => {
  test("a minimal area loads; the catalog needs an areas map", () => {
    expect(problems({ a: area() })).toEqual([]);
    expect(catalogProblems({})).toEqual(["the catalog has no `areas` map"]);
    expect(catalogProblems(null)).toEqual(["the catalog has no `areas` map"]);
    expect(problems({ a: area() }, { owners: [] })).toEqual([
      "unknown top-level field `owners`",
    ]);
  });

  test("a missing required field, an unknown one and a non-kebab id are each named", () => {
    const { title: _, ...untitled } = area();
    expect(problems({ a: untitled })).toEqual(["a: `title` is missing"]);
    expect(problems({ a: area({ reviewers: [] }) })).toEqual([
      "a: unknown field `reviewers`",
    ]);
    // Membership is an own-property check: an inherited name is unknown.
    expect(problems({ a: area({ constructor: "x" }) })).toEqual([
      "a: unknown field `constructor`",
    ]);
    expect(problems({ Bad_Id: area() })).toEqual([
      "Bad_Id: the id is not kebab-case",
    ]);
    expect(problems({ a: "text" })).toEqual(["a: not a mapping"]);
  });

  test("paths must list globs that compile", () => {
    expect(problems({ a: area({ paths: [] }) })).toEqual([
      "a: `paths` must list at least one glob",
    ]);
    expect(problems({ a: area({ paths: ["lib/**", "src/{a,b"] }) })).toEqual([
      'a: paths[1]: "src/{a,b" is not a valid glob: unclosed {',
    ]);
  });

  test("impliedBy holds area ids; the graph itself is check.ts's", () => {
    expect(problems({ a: area({ impliedBy: ["Not An Id"] }) })).toEqual([
      "a: `impliedBy` must be a list of area ids",
    ]);
    expect(problems({ a: area({ impliedBy: ["ghost"] }) })).toEqual([]);
  });

  test("the nested blocks are checked field by field", () => {
    expect(
      problems({
        a: area({
          validation: { profile: "", depth: 2 },
          review: { skills: [] },
          postDeploy: [{ action: "warm", envs: [] }],
          tracker: { labels: "area:a" },
          labels: [1],
        }),
      }),
    ).toEqual([
      "a: unknown field `validation.depth`",
      'a: validation.profile `""` is not text',
      "a: `review.skills` must list at least one skill",
      "a: `postDeploy[0].when` is missing",
      "a: `postDeploy[0].envs` must list at least one value",
      "a: `tracker.labels` must be a list of non-empty text",
      "a: `labels` must be a list of non-empty text",
    ]);
  });

  test("tracker and its older spelling linear are one block: not both", () => {
    expect(problems({ a: area({ linear: { labels: ["x"] } }) })).toEqual([]);
    expect(
      problems({
        a: area({ tracker: { labels: ["x"] }, linear: { flags: ["y"] } }),
      }),
    ).toEqual([
      "a: declare `tracker` or its older spelling `linear`, not both",
    ]);
  });

  test("a generated entry is M2's shape, with literal outputs and compiling sources", () => {
    const gen = {
      outputs: ["out/a.json"],
      source: ["src/**"],
      command: "gen",
      check: "gen --check",
    };
    expect(
      problems({ a: area({ generated: [{ ...gen, notes: "why" }] }) }),
    ).toEqual([]);
    expect(problems({ a: area({ generated: {} }) })).toEqual([
      "a: generated: must be a list of entries",
    ]);
    expect(problems({ a: area({ generated: [] }) })).toEqual([
      "a: generated: must list at least one entry",
    ]);
    expect(
      problems({
        a: area({
          generated: [
            {
              ...gen,
              outputs: ["out/*.json", "../up.txt", "ok.txt"],
              source: ["src/[z-a]"],
              check: "  ",
              extra: 1,
            },
          ],
        }),
      }),
    ).toEqual([
      "a: generated[0]: unknown field `extra`",
      "a: generated[0].outputs[0]: `out/*.json` is not a literal repository-relative file path",
      "a: generated[0].outputs[1]: `../up.txt` is not a literal repository-relative file path",
      expect.stringMatching(
        /^a: generated\[0\]\.source\[0\]: "src\/\[z-a\]" is not a valid glob/,
      ),
      "a: generated[0].check: must be a command",
    ]);
  });

  test("the reserved projection fields take any shape", () => {
    expect(
      problems({
        a: area({
          ci: { jobs: [1] },
          deploy: 2,
          scaffolding: null,
          owner: "x",
        }),
      }),
    ).toEqual([]);
  });
});

describe("vocabularies", () => {
  const vocabularies = {
    category: ["library", "docs"],
    deployTier: ["none"],
    agent: ["backend"],
    flags: ["api-change"],
    envs: ["prod"],
  };

  test("an open field takes any text until the catalog closes it", () => {
    expect(
      problems({ a: area({ category: "anything", agent: "anyone" }) }),
    ).toEqual([]);
    expect(problems({ a: area({ category: ["docs"] }) })).toEqual([
      'a: category `["docs"]` is not text',
    ]);
    const closed = (extra: Record<string, unknown>) =>
      problems({ a: area(extra) }, { vocabularies });
    expect(closed({})).toEqual([]);
    expect(closed({ category: "app" })).toEqual([
      'a: category `"app"` is not one of library, docs',
    ]);
    expect(closed({ deployTier: "prod", agent: "frontend" })).toEqual([
      'a: deployTier `"prod"` is not one of none',
      'a: agent `"frontend"` is not one of backend',
    ]);
    expect(closed({ tracker: { flags: ["api-change", "other"] } })).toEqual([
      'a: tracker.flags `"other"` is not one of api-change',
    ]);
    expect(
      closed({ postDeploy: [{ action: "a", when: "w", envs: ["staging"] }] }),
    ).toEqual(['a: postDeploy[0].envs `"staging"` is not one of prod']);
  });

  test("a vocabulary is a non-empty list of a known key", () => {
    expect(
      problems(
        { a: area() },
        { vocabularies: { category: [], colour: ["red"] } },
      ),
    ).toEqual([
      "vocabularies.category: must list at least one value",
      "vocabularies: unknown vocabulary `colour` (known: category, deployTier, agent, flags, envs, profile)",
    ]);
    expect(problems({ a: area() }, { vocabularies: ["x"] })).toEqual([
      "`vocabularies` is not a mapping",
    ]);
  });
});

describe("profiles", () => {
  const profiles = {
    quick: { localChecks: ["fmt"], verificationChecks: ["fmt --check"] },
    full: {
      localChecks: ["fmt", "test"],
      verificationChecks: ["test"],
      notes: "all",
    },
  };

  test("a validation profile names a declared profile; none means the deepest", () => {
    const catalog = validateCatalog({
      profiles,
      areas: {
        a: area({ validation: { profile: "quick" } }),
        b: area(),
        c: area({ validation: {} }),
      },
    });
    expect(deepestProfile(catalog)).toBe("full");
    expect(catalog.areas.a && profileOf(catalog.areas.a, catalog)).toBe(
      "quick",
    );
    expect(catalog.areas.b && profileOf(catalog.areas.b, catalog)).toBe("full");
    expect(catalog.areas.c && profileOf(catalog.areas.c, catalog)).toBe("full");
    expect(
      problems({ a: area({ validation: { profile: "slow" } }) }, { profiles }),
    ).toEqual(['a: validation.profile `"slow"` is not one of quick, full']);
  });

  test("vocabularies.profile orders the names when the catalog declares no checks", () => {
    const catalog = validateCatalog({
      vocabularies: { profile: ["light", "heavy"] },
      areas: { a: area() },
    });
    expect(deepestProfile(catalog)).toBe("heavy");
    expect(
      deepestProfile(validateCatalog({ areas: { a: area() } })),
    ).toBeUndefined();
  });

  test("a profile has both check lists, a letter-led kebab name, and one declaration", () => {
    expect(
      problems(
        { a: area() },
        {
          profiles: {
            "1": { localChecks: [] },
            ok: { localChecks: [""], verificationChecks: [] },
          },
        },
      ),
    ).toEqual([
      "profiles.1: the name is not kebab-case starting with a letter",
      "`profiles.1.verificationChecks` is missing",
      "`profiles.ok.localChecks` must be a list of commands",
    ]);
    expect(problems({ a: area() }, { profiles: {} })).toEqual([
      "`profiles` must map at least one profile name to its checks",
    ]);
    // The deepest is the fail-closed fallback, so it lists a check; a
    // shallower profile may list none.
    expect(
      problems(
        { a: area() },
        {
          profiles: {
            none: { localChecks: [], verificationChecks: [] },
            full: { localChecks: [], verificationChecks: [] },
          },
        },
      ),
    ).toEqual([
      "profiles.full: the deepest profile is the fail-closed fallback and lists no check; give it at least one local or verification check",
    ]);
    expect(
      problems(
        { a: area() },
        {
          profiles: {
            none: { localChecks: [], verificationChecks: [] },
            full: { localChecks: [], verificationChecks: ["bun test"] },
          },
        },
      ),
    ).toEqual([]);
    expect(
      problems(
        { a: area() },
        { profiles, vocabularies: { profile: ["quick", "full"] } },
      ),
    ).toEqual([
      "vocabularies.profile: `profiles` already names the profiles; declare one of the two",
    ]);
  });
});

describe("composer fields", () => {
  const fields: FieldExtensions = {
    area: { reviewRisk: ["high"], owners: "string[]" },
    validation: { frontmatter: "boolean", runner: "string" },
  };

  test("extend the area and validation fields, typed, and keep their values", () => {
    const doc = {
      areas: {
        a: area({
          reviewRisk: "high",
          owners: ["team-a"],
          validation: { frontmatter: true, runner: "remote" },
        }),
      },
    };
    expect(catalogProblems(doc)).toEqual([
      "a: unknown field `reviewRisk`",
      "a: unknown field `owners`",
      "a: unknown field `validation.frontmatter`",
      "a: unknown field `validation.runner`",
    ]);
    const catalog = validateCatalog(doc, fields);
    expect(catalog.areas.a?.reviewRisk).toBe("high");
    expect(catalog.areas.a?.validation?.frontmatter).toBe(true);
  });

  test("a value of the wrong type is named", () => {
    expect(
      problems(
        {
          a: area({
            reviewRisk: "low",
            owners: "team-a",
            validation: { frontmatter: "yes", runner: 1 },
          }),
        },
        {},
        fields,
      ),
    ).toEqual([
      // Built-in fields first, the validation block among them, then the
      // composer's.
      "a: `validation.frontmatter` must be true or false",
      "a: `validation.runner` is not text",
      'a: reviewRisk `"low"` is not one of high',
      "a: `owners` must be a list of non-empty text",
    ]);
  });

  test("redeclaring a built-in field is a defect in the composer", () => {
    expect(() =>
      problems({ a: area() }, {}, { area: { paths: "string" } }),
    ).toThrow(Defect);
    expect(() =>
      problems({ a: area() }, {}, { validation: { profile: "string" } }),
    ).toThrow(Defect);
  });
});

test("loading throws a CatalogError that lists every problem, naming the file", () => {
  expect(() =>
    validateCatalog({ areas: { a: area({ x: 1, y: 2 }) } }, {}, "c.yaml"),
  ).toThrow(
    "c.yaml is not a valid change-area catalog:\n  - a: unknown field `x`\n  - a: unknown field `y`",
  );
  try {
    validateCatalog({ areas: { a: area({ x: 1 }) } });
  } catch (err) {
    expect(err).toBeInstanceOf(CatalogError);
    expect((err as CatalogError).problems).toEqual(["a: unknown field `x`"]);
  }
  expect(() => loadCatalog(join(import.meta.dir, "no-such.yaml"))).toThrow(
    /ENOENT/,
  );
});
