// Scope: Jig's change-area catalog (.config/change-areas.yaml, module M3),
// read through the plugin's change-areas skill, which ships the schema, the
// resolver and the invariants; this script adds Jig's own policy on top.
// `--check` validates the catalog and that every repository file belongs to
// an area: exit 1 on a violation, 2 when the catalog cannot be read.
// `--base <ref>` resolves the files changed since the merge base with <ref>
// to areas and prints the resolution as JSON; under GitHub Actions it also
// writes the `areas` and `code` step outputs the CI workflow selects jobs by.
// `--all` resolves to every area.
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
import { generatedListProblems } from "../modules/M2-generated-artifact-freshness/reference/inventory/run-generated-checks.ts";

export const CATALOG = ".config/change-areas.yaml";

/** The field Jig's catalog adds to the shipped schema. */
const FIELDS: FieldExtensions = { area: { reviewRisk: ["high"] } };

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
  /** Changed files no area matches; they count as code. */
  unmatched: string[];
  /** Whether anything outside the `docs` category changed. */
  code: boolean;
}

const shared = (catalog: Catalog): SharedCatalog => ({ areas: catalog });
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
 * and form no cycle. Both schemas check the derived-file entries; a problem
 * both report is listed once.
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
    problems.push(...graphProblems(doc as SharedCatalog));
  return [...new Set(problems)];
}

/** The files no area matches. */
export function uncoveredFiles(files: string[], catalog: Catalog): string[] {
  const normal = slashes(files);
  const uncovered = new Set(sharedUncovered(normal, shared(catalog)));
  return files.filter((_, i) => uncovered.has(normal[i] as string));
}

/**
 * Resolve changed files to areas: every area a file matches, then every area
 * whose `impliedBy` lists an area already in the set, until it stops growing.
 */
export function resolveAreas(files: string[], catalog: Catalog): Resolution {
  const whole = shared(catalog);
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
    code:
      unmatched.length > 0 ||
      [...resolved].some((id) => catalog[id]?.category !== "docs"),
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

/** The repository's catalog; throws when it cannot be read or is invalid. */
export function validCatalog(root: string): Catalog {
  const doc = readCatalog(join(root, CATALOG));
  const problems = catalogProblems(doc);
  if (problems.length) throw new Error(`${CATALOG}: ${problems.join("; ")}`);
  return (doc as { areas: Catalog }).areas;
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

function writeOutputs(resolution: Resolution): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(
    output,
    `areas=${JSON.stringify(resolution.areas)}\ncode=${resolution.code}\n`,
  );
}

if (import.meta.main)
  cli(() => {
    const root = join(import.meta.dir, "..");
    const [flag, ref] = process.argv.slice(2);
    if (flag === "--check") return checkChangeAreas(root);
    const catalog = validCatalog(root);
    let resolution: Resolution;
    if (flag === "--all")
      resolution = {
        changedFiles: [],
        seedAreas: [],
        areas: Object.keys(catalog),
        unmatched: [],
        code: true,
      };
    else if (flag === "--base" && ref)
      resolution = resolveAreas(changedFiles(root, ref), catalog);
    else {
      console.error("usage: change-areas.ts --check | --base <ref> | --all");
      return 2;
    }
    console.log(JSON.stringify(resolution, null, 2));
    writeOutputs(resolution);
    return 0;
  });
