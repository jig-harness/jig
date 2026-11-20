// Scope: Jig's change-area catalog (.config/change-areas.yaml, module M3),
// read through the plugin's change-areas skill, which ships the schema, the
// resolver and the invariants; this script adds Jig's own policy on top.
// `--check` validates the catalog and that every repository file belongs to
// an area: exit 1 on a violation, 2 when the catalog cannot be read.
// `--base <ref>` resolves the files changed since the merge base with <ref>
// to areas and prints the resolution as JSON, with the validation plan and
// CI's gate-set matrix (scripts/area-validation.ts), which holds the tests that
// depend on those files (scripts/test-reach.ts); under GitHub Actions it also
// writes the `areas` and `matrix` step outputs the CI workflow selects jobs and
// test legs by. `--all` resolves to every area and every shard.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { repoFiles } from "../lib/files.ts";
import { isRecord } from "../lib/record.ts";
import { couldNotCheck } from "../lib/findings.ts";
import {
  type Area as SharedArea,
  type Catalog as SharedCatalog,
  catalogProblems as schemaProblems,
  type FieldExtensions,
  readCatalogFile,
} from "../plugin/skills/change-areas/scripts/lib/catalog.ts";
import {
  generatedProblems,
  graphProblems,
  uncoveredFiles as sharedUncovered,
  workspaceProblems,
} from "../plugin/skills/change-areas/scripts/lib/check.ts";
import {
  applyImpliedClosure,
  defaultGitRunner,
  matchSeedAreas,
} from "../plugin/skills/change-areas/scripts/lib/resolve.ts";
import {
  ciAreas,
  ciMatrix,
  countTestFiles,
  emptyOwnTestDirs,
  fullMatrix,
  jigValidation,
  type Matrix,
  ownTestsProblems,
  selectsDeepest,
} from "./area-validation.ts";
import {
  fileReader,
  NO_REACH,
  type ReadFile,
  runnableTests,
  testReach,
} from "./test-reach.ts";
import { generatedListProblems } from "../modules/M2-generated-artifact-freshness/reference/inventory/run-generated-checks.ts";

export const CATALOG = ".config/change-areas.yaml";

/** The fields Jig's catalog adds to the shipped schema. */
const FIELDS: FieldExtensions = {
  area: { reviewRisk: ["high"] },
  validation: { separateSuite: "boolean" },
};

export interface Area extends SharedArea {
  /** `high` puts the area's paths in the AI reviewer's high-risk list. */
  reviewRisk?: string;
}
export type Catalog = Record<string, Area>;

export interface Resolution {
  changedFiles: string[];
  /** Areas a changed file matches directly. */
  seedAreas: string[];
  /** The seed areas and every area that implies-by closure adds. */
  areas: string[];
  /** Changed files no area matches. */
  unmatched: string[];
}

/** The whole catalog: its profiles beside the areas. */
export type Document = SharedCatalog & { areas: Catalog };
const slashes = (files: string[]) => files.map((f) => f.replaceAll("\\", "/"));

/**
 * Read the catalog file; throws when it cannot be read or parsed, or repeats
 * a key (js-yaml rejects one, where a parser keeping the last would silently
 * drop an area).
 */
export function readCatalog(path: string): unknown {
  return readCatalogFile(path);
}

/**
 * Schema and graph problems of a parsed catalog, in a stable order. Empty
 * means the catalog is valid: the shipped schema with Jig's `reviewRisk`
 * field and its own vocabularies, each derived-file entry in the shape M2's
 * runner reads (scripts/check-generated-files.ts runs them), and an
 * implied-by relation whose references exist, never point at their own area
 * and form no cycle, and every own-tests command in the one shape CI routes
 * (scripts/area-validation.ts). Both schemas check the derived-file entries;
 * a problem both report is listed once.
 */
export function catalogProblems(doc: unknown): string[] {
  const problems = schemaProblems(doc, FIELDS);
  if (isRecord(doc) && isRecord(doc.areas))
    for (const [id, area] of Object.entries(doc.areas))
      if (isRecord(area) && area.generated !== undefined)
        problems.push(
          ...generatedListProblems(area.generated, "generated").map(
            (p) => `${id}: ${p}`,
          ),
        );
  if (problems.length === 0)
    problems.push(
      ...graphProblems(doc as SharedCatalog),
      ...ownTestsProblems(doc as SharedCatalog),
    );
  return [...new Set(problems)];
}

/** The files no area matches. */
export function uncoveredFiles(files: string[], catalog: Catalog): string[] {
  const normal = slashes(files);
  const uncovered = new Set(sharedUncovered(normal, { areas: catalog }));
  return files.filter((_, i) => uncovered.has(normal[i] as string));
}

/**
 * Resolve changed files to areas: every area a file matches, then every area
 * whose `impliedBy` lists an area already in the set, until it stops growing.
 */
export function resolveAreas(files: string[], catalog: Catalog): Resolution {
  const whole: SharedCatalog = { areas: catalog };
  const normal = slashes(files);
  const seed = matchSeedAreas(normal, whole);
  const resolved = applyImpliedClosure(seed, whole);
  const unmatched = files.filter(
    (_, i) => matchSeedAreas([normal[i] as string], whole).size === 0,
  );
  const order = Object.keys(catalog);
  const sorted = (set: Set<string>) => order.filter((id) => set.has(id));
  return {
    changedFiles: files,
    seedAreas: sorted(seed),
    areas: sorted(resolved),
    unmatched,
  };
}

const git = (root: string, args: string[]) =>
  defaultGitRunner(["-C", root, ...args]);

/** Files changed between the merge base with `base` and the working tree. */
export function changedFiles(root: string, base: string): string[] {
  const mergeBase = git(root, ["merge-base", "HEAD", base]).trim();
  return git(root, ["diff", "--name-only", "--no-renames", "-z", mergeBase])
    .split("\0")
    .filter(Boolean);
}

/** The repository's catalog document; throws when it cannot be read or is invalid. */
export function validDocument(root: string): Document {
  const doc = readCatalog(join(root, CATALOG));
  const problems = catalogProblems(doc);
  if (problems.length) throw new Error(`${CATALOG}: ${problems.join("; ")}`);
  return doc as Document;
}

/** The repository's areas; throws when the catalog cannot be read or is invalid. */
export function validCatalog(root: string): Catalog {
  return validDocument(root).areas;
}

/**
 * The resolution of `files` with Jig's validation plan and the gate-set
 * matrix CI runs for it. `tracked` lists the repository's files and `read`
 * returns their text: the tests that depend on the change are derived from
 * them. `areas` also holds the separate suites the change owes a run, since
 * CI selects their jobs by it; `seedAreas` and `unmatched` stay what the
 * files themselves match.
 */
export function planChange(
  files: string[],
  doc: Document,
  tracked: string[],
  read: ReadFile,
): Resolution & { validation: unknown; matrix: Matrix } {
  const resolution = resolveAreas(files, doc.areas);
  const ctx = {
    changedFiles: slashes(files),
    catalog: doc,
    seed: new Set(resolution.seedAreas),
    resolved: new Set(resolution.areas),
  };
  const validation = jigValidation(ctx);
  const repoPaths = slashes(tracked);
  // The deepest profile runs everything, so nothing needs walking.
  const reach = selectsDeepest(validation, doc)
    ? NO_REACH
    : testReach(ctx.changedFiles, repoPaths, read);
  const matrix = ciMatrix(
    validation,
    ctx.changedFiles,
    doc,
    (dirs) => countTestFiles(repoPaths, dirs),
    reach,
  );
  const areas = ciAreas(resolution.areas, validation, doc, reach, matrix);
  return { ...resolution, areas, validation, matrix };
}

/** The gate: a valid catalog that every repository file belongs to. */
export function checkChangeAreas(root = "."): number {
  let doc: unknown;
  try {
    doc = readCatalog(join(root, CATALOG));
  } catch (error) {
    console.error(
      `${CATALOG}: cannot read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  const problems = catalogProblems(doc);
  const files = problems.length ? [] : repoFiles(root);
  if (problems.length === 0) {
    if (!files.length)
      return couldNotCheck("change-areas", `no file under ${root}`);
    const catalog = doc as SharedCatalog;
    problems.push(
      ...workspaceProblems(catalog, { root, trackedFiles: files }),
      ...generatedProblems(catalog, { root, trackedFiles: files }),
      ...emptyOwnTestDirs(
        catalog,
        runnableTests(slashes(files), fileReader(root)),
      ),
    );
    for (const file of uncoveredFiles(files, catalog.areas))
      problems.push(`${file}: belongs to no area`);
  }
  for (const problem of problems) console.error(`${CATALOG}: ${problem}`);
  if (problems.length) return 1;
  console.log(
    `change-areas: OK — ${CATALOG} is valid and each of ${files.length} files belongs to an area (whether an area's paths are the right ones is review's question)`,
  );
  return 0;
}

function writeOutputs(areas: string[], matrix: Matrix): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(
    output,
    `areas=${JSON.stringify(areas)}\nmatrix=${JSON.stringify(matrix)}\n`,
  );
}

if (import.meta.main)
  cli(() => {
    const root = join(import.meta.dir, "..");
    const [flag, ref] = process.argv.slice(2);
    if (flag === "--check") return checkChangeAreas(root);
    const doc = validDocument(root);
    let resolution: Resolution & { matrix: Matrix };
    if (flag === "--all")
      resolution = {
        changedFiles: [],
        seedAreas: [],
        areas: Object.keys(doc.areas),
        unmatched: [],
        matrix: fullMatrix(),
      };
    else if (flag === "--base" && ref)
      resolution = planChange(
        changedFiles(root, ref),
        doc,
        repoFiles(root),
        fileReader(root),
      );
    else {
      console.error("usage: change-areas.ts --check | --base <ref> | --all");
      return 2;
    }
    console.log(JSON.stringify(resolution, null, 2));
    writeOutputs(resolution.areas, resolution.matrix);
    return 0;
  });
