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
//     tested areas reach through `impliedBy`, every shard of the whole suite
//     when the plan is the deepest, and none when nothing changed is tested;
//   - an area marked `validation.separateSuite` has its suites run in a CI
//     job of their own, so the gate set leaves those directories out.
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

/** One test directory as `./dir/`, inside the repository: no `.` or `..` step. */
const DIR = String.raw`\./(?:(?!\.{1,2}/)[A-Za-z0-9._-]+/)+`;

/** A test directory as a command line or the gate set's environment names it. */
export const TEST_DIR = new RegExp(`^${DIR}$`);

/** The one shape an own-tests command takes: `bun run test ./dir/ …`. */
export const OWN_TESTS = new RegExp(`^bun run test(?: ${DIR})+$`);

/** How many parallel test legs CI splits a run into at most. */
export const MAX_SHARDS = 4;

/** About how many test files one CI leg takes before another leg pays off. */
export const FILES_PER_SHARD = 80;

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

/** One leg of the gate-set job: its part, its shard and its test directories. */
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
 * A file's broad areas (those without own tests) seed nothing here, so a
 * change inside one skill does not reach what the broad `plugin` area does.
 */
export function ciTestDirs(files: string[], catalog: SharedCatalog): string[] {
  const tested = new Set<string>();
  for (const file of files)
    for (const id of areasOf(file, catalog))
      if (ownTestDirs(catalog.areas[id]).length > 0) tested.add(id);
  const reached = applyImpliedClosure(tested, catalog);
  const dirs: string[] = [];
  for (const id of Object.keys(catalog.areas)) {
    const area = catalog.areas[id];
    if (!reached.has(id) || area?.validation?.separateSuite === true) continue;
    dirs.push(...ownTestDirs(area));
  }
  return outermost(dirs);
}

/**
 * The gate-set job's matrix for one change: every shard when its plan
 * selects the deepest profile, legs for the reached areas' own tests
 * otherwise (as many as their test files call for, up to `MAX_SHARDS`), and
 * the checks leg alone when no test directory is reached or none holds a
 * test. `countTests` counts the test files under the directories.
 */
export function ciMatrix(
  plan: ValidationPlan,
  files: string[],
  catalog: SharedCatalog,
  countTests: (dirs: string[]) => number,
): Matrix {
  const deepest = deepestProfile(catalog);
  if (deepest === undefined || plan.profiles.includes(deepest))
    return fullMatrix();
  const dirs = ciTestDirs(files, catalog);
  const count = dirs.length ? countTests(dirs) : 0;
  if (count === 0) return { include: [CHECKS] };
  const shards = Math.min(MAX_SHARDS, Math.ceil(count / FILES_PER_SHARD));
  const paths = dirs.map((dir) => `./${dir}`).join(" ");
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

/** The test files among `files` under `dirs`: the count CI's legs split. */
export function countTestFiles(files: string[], dirs: string[]): number {
  return files.filter(
    (file) =>
      /\.test\.tsx?$/.test(file) && dirs.some((dir) => file.startsWith(dir)),
  ).length;
}
