import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { repoFiles } from "../lib/files.ts";
import type { Catalog as SharedCatalog } from "../plugin/skills/change-areas/scripts/lib/catalog.ts";
import {
  ciAreas,
  ciMatrix,
  ciTestDirs,
  emptyOwnTestDirs,
  FILES_PER_SHARD,
  fullMatrix,
  jigValidation,
  MAX_SHARDS,
  MAX_TEST_PATHS_LENGTH,
  ownTestsProblems,
  separateSuites,
  TEST_PATH,
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
import { fileReader, NO_REACH, type TestReach } from "./test-reach.ts";

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
    bare: area(["bare/**"]),
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
  // An area with no validation block runs at the deepest profile.
  for (const files of [["misc/x.ts"], ["app/x.ts", "stray.txt"], ["bare/x.ts"]])
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

test("CI follows an edge out of an area without own tests only for a file no tested area holds", () => {
  const edged: SharedCatalog = {
    ...fixture,
    areas: {
      ...fixture.areas,
      guide: area(
        ["guide/**"],
        { profile: "area", ownTests: "bun run test ./guide/" },
        ["docs", "broad"],
      ),
    },
  };
  // README.md belongs only to docs, which has no own tests: its edge counts.
  expect(ciTestDirs(["README.md"], edged)).toEqual(["guide/"]);
  // app/x.ts is in app, which has own tests, so its broad area seeds nothing.
  expect(ciTestDirs(["app/x.ts"], edged)).toEqual(["app/"]);
  // misc/x.ts belongs only to broad, which has no own tests.
  expect(ciTestDirs(["misc/x.ts"], edged)).toEqual(["guide/"]);
});

test("CI's matrix: every shard for the deepest plan, legs for the reached tests by their count, the checks leg alone otherwise", () => {
  const count = (n: number) => () => n;
  const matrix = (files: string[], n: number) =>
    ciMatrix(plan(files), files, fixture, count(n), NO_REACH);
  expect(matrix(["misc/x.ts"], 5)).toEqual(fullMatrix());
  expect(matrix(["README.md"], 5)).toEqual({ include: [{ part: "checks" }] });
  // A reached directory with no test file runs no leg.
  expect(matrix(["app/x.ts"], 0)).toEqual({ include: [{ part: "checks" }] });
  expect(matrix(["app/x.ts"], 3)).toEqual({
    include: [
      { part: "checks" },
      { part: "tests", shard: "1/1", paths: "./app/" },
    ],
  });
  const legs = (n: number) =>
    matrix(["lib/x.ts"], n).include.filter((leg) => leg.part === "tests");
  expect(legs(FILES_PER_SHARD + 1).map((leg) => leg.shard)).toEqual([
    "1/2",
    "2/2",
  ]);
  expect(legs(FILES_PER_SHARD * 100)).toHaveLength(MAX_SHARDS);
  expect(legs(1)[0]?.paths).toBe("./app/ ./lib/");
});

const reachOf = (...tests: string[]): TestReach => ({ tests, everyRun: [] });
const testsOf = (matrix: ReturnType<typeof fullMatrix>) =>
  matrix.include.filter((leg) => leg.part === "tests");

test("the test legs add the dependent test files the reached directories do not hold, and count them", () => {
  const files = ["app/x.ts"];
  const reach = reachOf("app/in.test.ts", "other/a.test.ts", "z/b.test.tsx");
  expect(ciMatrix(plan(files), files, fixture, () => 3, reach)).toEqual({
    include: [
      { part: "checks" },
      {
        part: "tests",
        shard: "1/1",
        paths: "./app/ ./other/a.test.ts ./z/b.test.tsx",
      },
    ],
  });
  // The legs split the directories' tests and the added files together.
  const legs = testsOf(
    ciMatrix(plan(files), files, fixture, () => FILES_PER_SHARD - 1, reach),
  );
  expect(legs.map((leg) => leg.shard)).toEqual(["1/2", "2/2"]);
  // A change whose areas declare no test leg still runs what depends on it.
  expect(
    testsOf(
      ciMatrix(
        plan(["README.md"]),
        ["README.md"],
        fixture,
        () => 0,
        reachOf("other/a.test.ts"),
      ),
    ),
  ).toEqual([{ part: "tests", shard: "1/1", paths: "./other/a.test.ts" }]);
});

test("a dependent test in a separate suite selects that suite's job instead of a leg", () => {
  const files = ["app/x.ts"];
  const reach = reachOf("long/a.test.ts");
  expect(ciMatrix(plan(files), files, fixture, () => 3, reach)).toEqual({
    include: [
      { part: "checks" },
      { part: "tests", shard: "1/1", paths: "./app/" },
    ],
  });
  const areas = (r: TestReach) =>
    ciAreas(
      ["app"],
      plan(files),
      fixture,
      r,
      ciMatrix(plan(files), files, fixture, () => 3, r),
    );
  expect(areas(reach)).toEqual(["app", "long"]);
  expect(areas(NO_REACH)).toEqual(["app"]);
});

test("the deepest plan, or a change every test run loads, runs the whole suite and every separate suite", () => {
  const everyRun: TestReach = { tests: [], everyRun: ["app/x.ts"] };
  expect(
    ciMatrix(plan(["app/x.ts"]), ["app/x.ts"], fixture, () => 3, everyRun),
  ).toEqual(fullMatrix());
  expect(
    ciAreas(["app"], plan(["app/x.ts"]), fixture, everyRun, fullMatrix()),
  ).toEqual(["app", "long"]);
  expect(
    ciAreas([], plan(["stray.txt"]), fixture, NO_REACH, fullMatrix()),
  ).toEqual(["long"]);
});

test("a list of test paths a leg cannot carry, or could not pass on, runs the whole suite", () => {
  const files = ["app/x.ts"];
  const matrix = (reach: TestReach) =>
    ciMatrix(plan(files), files, fixture, () => 3, reach);
  const name = "d".repeat(100);
  const many = Array.from(
    { length: Math.ceil(MAX_TEST_PATHS_LENGTH / 100) },
    (_, i) => `${name}/${i}.test.ts`,
  );
  expect(matrix(reachOf(...many))).toEqual(fullMatrix());
  expect(matrix(reachOf("odd dir/a.test.ts"))).toEqual(fullMatrix());
  // The fallback owes the separate suites too, as the whole suite does.
  const fallback = reachOf("odd dir/a.test.ts");
  expect(
    ciAreas(["app"], plan(files), fixture, fallback, matrix(fallback)),
  ).toEqual(["app", "long"]);
});

test("a test path is a directory or a test file inside the repository", () => {
  for (const good of [
    "./scripts/",
    "./plugin/send/__tests__/a.test.ts",
    "./dashboard/src/b.test.tsx",
    "./root.test.ts",
  ])
    expect(TEST_PATH.test(good)).toBe(true);
  for (const bad of [
    "scripts/",
    "./scripts",
    "./a/b.ts",
    "./../a.test.ts",
    "./a/../b.test.ts",
    "./a/./b.test.ts",
    "./.test.ts",
    "../a.test.ts",
    "a.test.ts",
    "./a;b.test.ts",
    "./a b.test.ts",
    "./$(x).test.ts",
  ])
    expect(TEST_PATH.test(bad)).toBe(false);
});

test("an own-test directory with no test file is reported, one beside a live directory included", () => {
  const catalog: SharedCatalog = {
    areas: {
      live: area(["a/**"], { ownTests: "bun run test ./a/" }),
      stale: area(["b/**"], { ownTests: "bun run test ./b/ ./gone/" }),
      typo: area(["c/**"], { ownTests: "bun run test ./cc/" }),
      bare: area(["d/**"]),
    },
  };
  expect(
    emptyOwnTestDirs(catalog, ["a/x.test.ts", "b/y.test.ts", "c/z.test.ts"]),
  ).toEqual([
    "stale: validation.ownTests names ./gone/, which holds no test file",
    "typo: validation.ownTests names ./cc/, which holds no test file",
  ]);
});

// The acceptance cases, on Jig's own catalog and files.
const jig = validDocument(root);
const tracked = repoFiles(root);
const planOf = (...files: string[]) =>
  planChange(files, jig, tracked, fileReader(root));
const testLegs = (...files: string[]) => testsOf(planOf(...files).matrix);
const wholeSuite = testsOf(fullMatrix());

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

test("on Jig's catalog a change to a file only its own skill uses runs that skill's tests and the tests naming its files bare, not the whole suite", () => {
  // Built in parts: a test that spelled the file's name would depend on it.
  const leaf = `plugin/skills/audit/scripts/lib/${"feedback"}.ts`;
  const legs = testLegs(leaf);
  // The skill's tests and the shared tests are one leg, sharded; every shard
  // carries the same paths.
  const paths = (legs[0]?.paths ?? "").split(" ");
  expect(new Set(legs.map((leg) => leg.paths)).size).toBe(1);
  // Another skill's test that spells a shared file name bare is kept, as the
  // name could mean the file of that name in any skill.
  expect(paths).toContain("./plugin/skills/audit/");
  expect(paths).toContain("./plugin/shared/__tests__/");
  expect(paths.length).toBeLessThan(40);
  expect(paths).not.toContain("./website/");
});

test("on Jig's catalog a change runs the tests that depend on it outside its areas", () => {
  const { areas, seedAreas, matrix } = planOf(
    "plugin/dispatch/lib/station-answers.ts",
  );
  const [leg] = testsOf(matrix);
  const paths = leg?.paths?.split(" ") ?? [];
  expect(paths).toContain("./plugin/dispatch/");
  expect(paths).toContain(
    "./plugin/send/__tests__/send-tracker-answer.test.ts",
  );
  // Nothing already under a listed directory is listed again.
  expect(paths.filter((p) => p.startsWith("./plugin/dispatch/"))).toEqual([
    "./plugin/dispatch/",
  ]);
  // A dependent test in the drive-pr suite selects its job, not a leg.
  expect(paths.some((p) => p.startsWith("./plugin/skills/drive-pr/"))).toBe(
    false,
  );
  expect(areas).toContain("drive-pr");
  expect(seedAreas).not.toContain("drive-pr");
});

test("on Jig's catalog an unmatched file, or code no own tests cover, runs every shard and every separate suite", () => {
  expect(
    testLegs("plugin/skills/explain/scripts/sheet.ts", "stray-file.xyz"),
  ).toEqual(wholeSuite);
  expect(testLegs("plugin/jig.ts")).toEqual(wholeSuite);
  expect(testLegs("package.json")).toEqual(wholeSuite);
  const unmatched = planOf("stray-file.xyz");
  expect(unmatched).toMatchObject({
    seedAreas: [],
    unmatched: ["stray-file.xyz"],
  });
  for (const change of [unmatched, planOf("plugin/runtime/upgrade-record.ts")])
    expect(change.areas).toEqual(
      expect.arrayContaining(["drive-pr", "website"]),
    );
});

test("on Jig's catalog a test preload runs every shard and every separate suite", () => {
  const { matrix, areas } = planOf(
    "plugin/skills/resolve-review-comments/__tests__/preload.ts",
  );
  expect(testsOf(matrix)).toEqual(wholeSuite);
  expect(areas).toEqual(expect.arrayContaining(["drive-pr", "website"]));
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
