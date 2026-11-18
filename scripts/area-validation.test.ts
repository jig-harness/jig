import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { repoFiles } from "../lib/files.ts";
import type { Catalog as SharedCatalog } from "../plugin/skills/change-areas/scripts/lib/catalog.ts";
import {
  ciMatrix,
  ciTestDirs,
  FILES_PER_SHARD,
  fullMatrix,
  jigValidation,
  MAX_SHARDS,
  ownTestsProblems,
  separateSuites,
  untestedFiles,
} from "./area-validation.ts";
import {
  CATALOG,
  catalogProblems,
  type Document,
  planChange,
  readCatalog,
  validDocument,
} from "./change-areas.ts";

const root = resolve(import.meta.dir, "..");

function area(
  paths: string[],
  validation?: Record<string, unknown>,
  impliedBy: string[] = [],
) {
  return {
    title: "An area",
    category: "skill",
    paths,
    workspace: [],
    impliedBy,
    deployTier: "none",
    ...(validation ? { validation } : {}),
  };
}

const fixture: SharedCatalog = {
  profiles: {
    docs: { localChecks: ["quick"], verificationChecks: ["quick"] },
    area: { localChecks: ["quick"], verificationChecks: ["quick", "slow"] },
    deep: { localChecks: ["all"], verificationChecks: ["all"] },
  },
  areas: {
    lib: area(["lib/**"], { profile: "area", ownTests: "bun run test ./lib/" }),
    app: area(
      ["app/**"],
      { profile: "area", ownTests: "bun run test ./app/ ./app/sub/" },
      ["lib"],
    ),
    long: area(
      ["long/**"],
      {
        profile: "area",
        ownTests: "bun run test ./long/",
        separateSuite: true,
      },
      ["lib"],
    ),
    broad: area(["app/**", "lib/**", "misc/**"], { profile: "area" }),
    docs: area(["*.md"], { profile: "docs" }),
  },
};

function plan(files: string[], catalog = fixture) {
  return jigValidation({
    changedFiles: files,
    catalog,
    seed: new Set(
      Object.keys(catalog.areas).filter((id) =>
        files.some((f) =>
          catalog.areas[id]?.paths.some((g) => new Bun.Glob(g).match(f)),
        ),
      ),
    ),
    resolved: new Set(),
  });
}

test("own tests take one shape CI can route, and a separate suite names its tests", () => {
  expect(ownTestsProblems(fixture)).toEqual([]);
  for (const ownTests of [
    "bun test ./lib/",
    "bun run test lib/",
    "bun run test ./lib",
    "bun run test ./lib/ && rm -rf /",
    "bun run test ./../lib/",
  ])
    expect(
      ownTestsProblems({ areas: { lib: area(["lib/**"], { ownTests }) } }),
    ).toHaveLength(1);
  expect(
    ownTestsProblems({
      areas: { lib: area(["lib/**"], { separateSuite: true }) },
    })[0],
  ).toContain("names no suite");
});

test("the separate suites are the own tests of the areas the catalog marks, and follow an edit to it", () => {
  expect(separateSuites(fixture)).toEqual(["long/**"]);
  const edited = structuredClone(fixture);
  (edited.areas.app?.validation as Record<string, unknown>).separateSuite =
    true;
  expect(separateSuites(edited)).toEqual(["app/**", "app/sub/**", "long/**"]);
  // Jig's own: the drive-pr suite and the website's.
  expect(separateSuites(validDocument(root))).toEqual([
    "plugin/skills/drive-pr/**",
    "website/**",
  ]);
});

test("a file only an area without own tests holds is untested, and deepens the plan", () => {
  expect(
    untestedFiles(["misc/x.ts", "app/x.ts", "README.md"], fixture),
  ).toEqual(["misc/x.ts"]);
  expect(plan(["app/x.ts"])).toMatchObject({
    profiles: ["area"],
    localChecks: ["quick", "bun run test ./app/ ./app/sub/"],
  });
  expect(plan(["README.md"])).toMatchObject({
    profiles: ["docs"],
    localChecks: ["quick"],
  });
  for (const files of [["misc/x.ts"], ["app/x.ts", "stray.txt"]])
    expect(plan(files)).toMatchObject({
      profiles: expect.arrayContaining(["deep"]),
      localChecks: ["all"],
      verificationChecks: ["all"],
    });
});

test("CI tests what the changed files' tested areas reach, never the separate suites, and outermost directories once", () => {
  // lib is implied by app and long; long runs in a job of its own.
  expect(ciTestDirs(["lib/x.ts"], fixture)).toEqual(["app/", "lib/"]);
  // The broad area holds app/x.ts too, but has no own tests to reach with.
  expect(ciTestDirs(["app/x.ts"], fixture)).toEqual(["app/"]);
  expect(ciTestDirs(["long/x.ts"], fixture)).toEqual([]);
  expect(ciTestDirs(["README.md"], fixture)).toEqual([]);
});

test("CI's matrix: every shard for the deepest plan, legs for the reached tests by their count, the checks leg alone otherwise", () => {
  const count = (n: number) => () => n;
  expect(
    ciMatrix(plan(["misc/x.ts"]), ["misc/x.ts"], fixture, count(5)),
  ).toEqual(fullMatrix());
  expect(
    ciMatrix(plan(["README.md"]), ["README.md"], fixture, count(5)),
  ).toEqual({
    include: [{ part: "checks" }],
  });
  // A reached directory with no test file runs no leg.
  expect(ciMatrix(plan(["app/x.ts"]), ["app/x.ts"], fixture, count(0))).toEqual(
    {
      include: [{ part: "checks" }],
    },
  );
  expect(ciMatrix(plan(["app/x.ts"]), ["app/x.ts"], fixture, count(3))).toEqual(
    {
      include: [
        { part: "checks" },
        { part: "tests", shard: "1/1", paths: "./app/" },
      ],
    },
  );
  const legs = (n: number) =>
    ciMatrix(
      plan(["lib/x.ts"]),
      ["lib/x.ts"],
      fixture,
      count(n),
    ).include.filter((leg) => leg.part === "tests");
  expect(legs(FILES_PER_SHARD + 1).map((leg) => leg.shard)).toEqual([
    "1/2",
    "2/2",
  ]);
  expect(legs(FILES_PER_SHARD * 100)).toHaveLength(MAX_SHARDS);
  expect(legs(1)[0]?.paths).toBe("./app/ ./lib/");
});

// The acceptance cases, on Jig's own catalog and files.
const jig = validDocument(root);
const tracked = repoFiles(root);
const testLegs = (...files: string[]) =>
  planChange(files, jig, tracked).matrix.include.filter(
    (leg) => leg.part === "tests",
  );

test("on Jig's catalog a documentation-only change runs no test leg", () => {
  expect(
    testLegs(
      "changes/a-note.md",
      "docs/LIFECYCLE.md",
      "design/plan.md",
      "README.md",
    ),
  ).toEqual([]);
});

test("on Jig's catalog a change to one skill runs that skill's tests only", () => {
  expect(testLegs("plugin/skills/explain/scripts/sheet.ts")).toEqual([
    { part: "tests", shard: "1/1", paths: "./plugin/skills/explain/" },
  ]);
});

test("on Jig's catalog an unmatched file, or code no own tests cover, runs every shard", () => {
  const full = fullMatrix().include.filter((leg) => leg.part === "tests");
  expect(
    testLegs("plugin/skills/explain/scripts/sheet.ts", "stray-file.xyz"),
  ).toEqual(full);
  expect(testLegs("plugin/jig.ts")).toEqual(full);
  expect(testLegs("package.json")).toEqual(full);
});

test("Jig's catalog is refused when an own-tests command takes another shape", () => {
  const doc = readCatalog(join(root, CATALOG)) as Document;
  const edited = structuredClone(doc);
  const gc = edited.areas.gc;
  if (gc?.validation === undefined) throw new Error("no gc validation");
  gc.validation.ownTests = "bun test plugin/gc";
  expect(catalogProblems(edited).join("\n")).toContain(
    "gc: validation.ownTests must be",
  );
});
