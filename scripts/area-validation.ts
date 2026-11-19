// Scope: what Jig's change-area catalog (.config/change-areas.yaml) says a
// change must run, locally and in CI. The plugin's change-areas skill ships
// the generic validation plan; this module adds Jig's policy on top:
//
//   - every area's own tests are `bun run test` and the directories its
//     suites live in, so CI can split and route them;
//   - a generator is owed only when the change touches its sources or its
//     outputs, not whenever its area is seeded;
//   - a changed file outside the shallowest profile whose areas declare no
//     own tests selects the deepest profile, as an unmatched file does:
//     nothing narrower tests it (a file only the broad `plugin` area holds);
//   - CI's test legs run the own tests of the areas the changed files'
//     tested areas reach through `impliedBy` and the test files that depend
//     on the change (scripts/test-reach.ts), every shard of the whole suite
//     when the plan is the deepest or the change is loaded by every test run,
//     and none when nothing changed is tested;
//   - an area marked `validation.separateSuite` has its suites run in a CI
//     job of their own, so the gate set leaves those directories out and the
//     job runs whenever the whole suite does or a test in it depends on the
//     change.
import type { Catalog as SharedCatalog } from "../plugin/skills/change-areas/scripts/lib/catalog.ts";
import {
  deepestProfile,
  profileOf,
  profileOrder,
} from "../plugin/skills/change-areas/scripts/lib/catalog.ts";
import {
  type CheckLists,
  defaultValidation,
  foldGenerated,
  type ResolutionContext,
  type ValidationPlan,
} from "../plugin/skills/change-areas/scripts/lib/emit.ts";
import {
  applyImpliedClosure,
  matchesGlob,
} from "../plugin/skills/change-areas/scripts/lib/resolve.ts";
import type { TestReach } from "./test-reach.ts";

/** One directory step of a path inside the repository: never `.` or `..`. */
const STEP = String.raw`(?!\.{1,2}/)[A-Za-z0-9._-]+/`;

/** One test directory as `./dir/`. */
const DIR = String.raw`\./(?:${STEP})+`;

/** One test file as `./dir/name.test.ts`. */
const FILE = String.raw`\./(?:${STEP})*(?!\.)[A-Za-z0-9._-]+\.test\.tsx?`;

/** What the gate set's environment confines a test run to: a directory or a test file. */
export const TEST_PATH = new RegExp(`^(?:${DIR}|${FILE})$`);

/** The one shape an own-tests command takes: `bun run test ./dir/ …`. */
export const OWN_TESTS = new RegExp(`^bun run test(?: ${DIR})+$`);

/** How many parallel test legs CI splits a run into at most. */
export const MAX_SHARDS = 4;

/** About how many test files one CI leg takes before another leg pays off. */
export const FILES_PER_SHARD = 80;

/**
 * The longest list of test paths a leg carries. It reaches the gate set as an
 * environment variable, which Linux caps at 128 KiB, and each leg repeats it
 * in the job output; a longer list runs the whole suite instead.
 */
export const MAX_TEST_PATHS_LENGTH = 64 * 1024;

type Area = SharedCatalog["areas"][string];

/** The directories an area's own tests run, without the leading `./`. */
export function ownTestDirs(area: Area | undefined): string[] {
  const command = area?.validation?.ownTests;
  if (typeof command !== "string") return [];
  return command
    .split(" ")
    .slice(3)
    .map((dir) => dir.slice(2));
}

/** Jig's own rule for `validation.ownTests`: the one shape CI can route. */
export function ownTestsProblems(catalog: SharedCatalog): string[] {
  const problems: string[] = [];
  for (const [id, area] of Object.entries(catalog.areas)) {
    const command = area.validation?.ownTests;
    if (command !== undefined && !OWN_TESTS.test(command))
      problems.push(
        `${id}: validation.ownTests must be \`bun run test\` followed by the directories its suites live in, each as ./dir/, not ${JSON.stringify(command)}`,
      );
    if (area.validation?.separateSuite === true && command === undefined)
      problems.push(
        `${id}: validation.separateSuite names no suite: declare validation.ownTests`,
      );
  }
  return problems;
}

/**
 * The own-test directories that hold no test file, so that a mistyped or stale
 * one cannot silently drop its area's tests. `testFiles` are the files
 * `bun test` runs.
 */
export function emptyOwnTestDirs(
  catalog: SharedCatalog,
  testFiles: string[],
): string[] {
  const problems: string[] = [];
  for (const [id, area] of Object.entries(catalog.areas))
    for (const dir of ownTestDirs(area))
      if (!testFiles.some((file) => file.startsWith(dir)))
        problems.push(
          `${id}: validation.ownTests names ./${dir}, which holds no test file`,
        );
  return problems;
}

/**
 * The suites the gate set leaves to a CI job of their own, as `bun test`
 * ignore patterns: the own-test directories of every area marked
 * `validation.separateSuite`, in catalog order, each once.
 */
export function separateSuites(catalog: SharedCatalog): string[] {
  const suites = new Set<string>();
  for (const area of Object.values(catalog.areas))
    if (area.validation?.separateSuite === true)
      for (const dir of ownTestDirs(area)) suites.add(`${dir}**`);
  return [...suites];
}

/**
 * The areas whose `paths` hold `file`. A generator's source seeds its area
 * for the generator's sake, and the generator's check covers it, so it does
 * not make the file the area's to test.
 */
function areasOf(file: string, catalog: SharedCatalog): string[] {
  return Object.keys(catalog.areas).filter((id) =>
    catalog.areas[id]?.paths.some((glob) => matchesGlob(file, glob)),
  );
}

/**
 * The context with each area's generators narrowed to those whose source or
 * outputs a changed file matches: the generators the change owes a run.
 */
export function touchedGenerators(ctx: ResolutionContext): ResolutionContext {
  const touched = (globs: string[]) =>
    ctx.changedFiles.some((file) =>
      globs.some((glob) => matchesGlob(file, glob)),
    );
  const areas = Object.fromEntries(
    Object.entries(ctx.catalog.areas).map(([id, area]) => [
      id,
      area.generated === undefined
        ? area
        : {
            ...area,
            generated: area.generated.filter((g) =>
              touched([...g.source, ...g.outputs]),
            ),
          },
    ]),
  );
  return { ...ctx, catalog: { ...ctx.catalog, areas } };
}

/**
 * The changed files no own test covers: each belongs to an area, none of
 * its areas declares own tests, and one of them runs above the shallowest
 * profile. A file no area matches is the generic plan's to fail closed on.
 */
export function untestedFiles(
  files: string[],
  catalog: SharedCatalog,
): string[] {
  const shallowest = profileOrder(catalog)[0];
  return files.filter((file) => {
    const areas = areasOf(file, catalog).map((id) => catalog.areas[id]);
    if (areas.length === 0) return false;
    if (areas.some((area) => ownTestDirs(area).length > 0)) return false;
    return areas.some(
      (area) => area !== undefined && profileOf(area, catalog) !== shallowest,
    );
  });
}

/**
 * Jig's validation plan: the generic plan, deepened when a changed file no
 * own test covers, with only the generators the change touches. A plan that selects the deepest profile runs that
 * profile's checks alone, since they hold every narrower check and every
 * suite; the seed areas' generators still come first.
 */
export function jigValidation(whole: ResolutionContext): ValidationPlan {
  const ctx = touchedGenerators(whole);
  const plan = defaultValidation(ctx);
  const deepest = deepestProfile(ctx.catalog);
  if (deepest === undefined) return plan;
  const profiles = new Set(plan.profiles);
  if (untestedFiles(ctx.changedFiles, ctx.catalog).length > 0)
    profiles.add(deepest);
  if (!profiles.has(deepest)) return plan;
  const definition = ctx.catalog.profiles?.[deepest];
  const lists: CheckLists = foldGenerated(
    {
      localChecks: [...(definition?.localChecks ?? [])],
      verificationChecks: [...(definition?.verificationChecks ?? [])],
    },
    plan.sourceAreas,
    ctx.catalog,
  );
  return {
    ...plan,
    profiles: profileOrder(ctx.catalog).filter((p) => profiles.has(p)),
    ...lists,
  };
}

/** One leg of the gate-set job: its part, its shard and the test paths it runs. */
export interface Leg {
  part: "checks" | "tests";
  shard?: string;
  paths?: string;
}

/** The gate-set job's matrix, as `strategy.matrix` reads it. */
export interface Matrix {
  include: Leg[];
}

/** The checks leg alone: it runs every stage but the tests. */
const CHECKS: Leg = { part: "checks" };

/** The checks leg and every shard of the whole suite. */
export function fullMatrix(): Matrix {
  return {
    include: [
      CHECKS,
      ...Array.from({ length: MAX_SHARDS }, (_, i) => ({
        part: "tests" as const,
        shard: `${i + 1}/${MAX_SHARDS}`,
      })),
    ],
  };
}

/** Directories without the ones another listed directory already holds. */
function outermost(dirs: string[]): string[] {
  const unique = [...new Set(dirs)].sort();
  return unique.filter(
    (dir) => !unique.some((other) => other !== dir && dir.startsWith(other)),
  );
}

/**
 * The test directories CI runs for a change whose plan is not the deepest:
 * the own tests of every area a changed file's tested areas reach through
 * `impliedBy`, except the separate suites, which run in jobs of their own.
 * A file's broad areas (those without own tests) seed nothing when one of its
 * areas has own tests, so a change inside one skill does not reach what the
 * broad `plugin` area does; a file with no tested area seeds every area it
 * belongs to, so an edge out of a docs area still reaches its tests.
 */
export function ciTestDirs(files: string[], catalog: SharedCatalog): string[] {
  const seeds = new Set<string>();
  for (const file of files) {
    const areas = areasOf(file, catalog);
    const tested = areas.filter(
      (id) => ownTestDirs(catalog.areas[id]).length > 0,
    );
    for (const id of tested.length > 0 ? tested : areas) seeds.add(id);
  }
  const reached = applyImpliedClosure(seeds, catalog);
  const dirs: string[] = [];
  for (const id of Object.keys(catalog.areas)) {
    const area = catalog.areas[id];
    if (!reached.has(id) || area?.validation?.separateSuite === true) continue;
    dirs.push(...ownTestDirs(area));
  }
  return outermost(dirs);
}

const isUnder = (file: string, dirs: string[]) =>
  dirs.some((dir) => file.startsWith(dir));

/** Whether the plan selects the deepest profile, which runs every suite. */
export function selectsDeepest(
  plan: ValidationPlan,
  catalog: SharedCatalog,
): boolean {
  const deepest = deepestProfile(catalog);
  return deepest === undefined || plan.profiles.includes(deepest);
}

/** Whether no selection of tests can stand in for the whole suite. */
function owesWholeSuite(
  plan: ValidationPlan,
  catalog: SharedCatalog,
  reach: TestReach,
): boolean {
  return selectsDeepest(plan, catalog) || reach.everyRun.length > 0;
}

/**
 * The gate-set job's matrix for one change: every shard when the whole suite
 * is owed, otherwise legs for the reached areas' own tests and the dependent
 * test files outside them (as many legs as those files call for, up to
 * `MAX_SHARDS`), and the checks leg alone when no test is selected. A
 * dependent test in a separate suite runs in that suite's job
 * (`ciAreas`). A list of paths a leg cannot carry runs every shard.
 * `countTests` counts the test files under the directories.
 */
export function ciMatrix(
  plan: ValidationPlan,
  files: string[],
  catalog: SharedCatalog,
  countTests: (dirs: string[]) => number,
  reach: TestReach,
): Matrix {
  if (owesWholeSuite(plan, catalog, reach)) return fullMatrix();
  const dirs = ciTestDirs(files, catalog);
  const separate = Object.values(catalog.areas)
    .filter((area) => area.validation?.separateSuite === true)
    .flatMap(ownTestDirs);
  const dependents = reach.tests.filter(
    (file) => !isUnder(file, dirs) && !isUnder(file, separate),
  );
  const count = (dirs.length ? countTests(dirs) : 0) + dependents.length;
  if (count === 0) return { include: [CHECKS] };
  const listed = [...dirs, ...dependents].map((path) => `./${path}`);
  const paths = listed.join(" ");
  if (
    paths.length > MAX_TEST_PATHS_LENGTH ||
    !listed.every((path) => TEST_PATH.test(path))
  )
    return fullMatrix();
  const shards = Math.min(MAX_SHARDS, Math.ceil(count / FILES_PER_SHARD));
  return {
    include: [
      CHECKS,
      ...Array.from({ length: shards }, (_, i) => ({
        part: "tests" as const,
        shard: `${i + 1}/${shards}`,
        paths,
      })),
    ],
  };
}

/**
 * The areas whose CI jobs a change selects: the `resolved` ones and each
 * separate suite that is owed, all of them when the whole suite is and
 * otherwise those holding a test that depends on the change.
 */
export function ciAreas(
  resolved: string[],
  plan: ValidationPlan,
  catalog: SharedCatalog,
  reach: TestReach,
): string[] {
  const whole = owesWholeSuite(plan, catalog, reach);
  const owed = new Set(resolved);
  for (const [id, area] of Object.entries(catalog.areas)) {
    if (area.validation?.separateSuite !== true) continue;
    const dirs = ownTestDirs(area);
    if (whole || reach.tests.some((file) => isUnder(file, dirs))) owed.add(id);
  }
  return Object.keys(catalog.areas).filter((id) => owed.has(id));
}

/** The test files among `files` under `dirs`: the count CI's legs split. */
export function countTestFiles(files: string[], dirs: string[]): number {
  return files.filter(
    (file) =>
      /\.test\.tsx?$/.test(file) && dirs.some((dir) => file.startsWith(dir)),
  ).length;
}
