// Scope: Jig's change-area catalog (.config/change-areas.yaml, module M3).
// `--check` validates the catalog's schema and implied-by graph and that every
// repository file belongs to an area: exit 1 on a violation, 2 when the
// catalog cannot be read. `--base <ref>` resolves the files changed since the
// merge base with <ref> to areas and prints the resolution as JSON; under
// GitHub Actions it also writes the `areas` and `code` step outputs the CI
// workflow selects jobs by. `--all` resolves to every area.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { repoFiles } from "../lib/files.ts";
import { isRecord } from "../lib/record.ts";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../plugin/shared/guarded-git-spawn.ts";
import { couldNotCheck } from "../lib/findings.ts";
import { load as loadYaml } from "../lib/vendor/js-yaml.mjs";

export const CATALOG = ".config/change-areas.yaml";

const AREA_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CATEGORIES = ["skill", "library", "tooling", "infra", "docs"];
const DEPLOY_TIERS = ["plugin", "none"];
const REVIEW_RISKS = ["high"];

export interface Area {
  title: string;
  category: string;
  paths: string[];
  workspace: string[];
  impliedBy: string[];
  deployTier: string;
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

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

const oneOf = (field: string, allowed: string[]) => (value: unknown) =>
  typeof value === "string" && allowed.includes(value)
    ? null
    : `${field} \`${JSON.stringify(value)}\` is not one of ${allowed.join(", ")}`;

/**
 * Each area field, whether it is required, and the problem its value has, if
 * any. A field not listed here is unknown.
 */
const FIELDS: Record<
  string,
  { required: boolean; check: (value: unknown) => string | null }
> = {
  title: {
    required: true,
    check: (v) => (typeof v === "string" ? null : "`title` is not text"),
  },
  category: { required: true, check: oneOf("category", CATEGORIES) },
  paths: {
    required: true,
    check: (v) =>
      isStringList(v) && v.length > 0 && !v.includes("")
        ? null
        : "`paths` must list at least one glob",
  },
  workspace: {
    required: true,
    check: (v) => (isStringList(v) ? null : "`workspace` must be a list"),
  },
  impliedBy: {
    required: true,
    check: (v) =>
      isStringList(v) ? null : "`impliedBy` must be a list of area ids",
  },
  deployTier: { required: true, check: oneOf("deployTier", DEPLOY_TIERS) },
  notes: {
    required: false,
    check: (v) => (typeof v === "string" ? null : "`notes` is not text"),
  },
  reviewRisk: { required: false, check: oneOf("reviewRisk", REVIEW_RISKS) },
};

/**
 * Read the catalog file; throws when it cannot be read or parsed, or repeats
 * a key (js-yaml rejects one, where a parser keeping the last would silently
 * drop an area).
 */
export function readCatalog(path: string): unknown {
  return loadYaml(readFileSync(path, "utf8"));
}

/**
 * Schema and graph problems of a parsed catalog, in a stable order. Empty
 * means the catalog is valid: kebab-case ids, known fields only, closed
 * categories and deploy tiers, at least one path per area, and an
 * implied-by relation whose references exist, never point at their own area
 * and form no cycle.
 */
export function catalogProblems(doc: unknown): string[] {
  if (!isRecord(doc) || !isRecord(doc.areas))
    return ["the catalog has no `areas` map"];
  const areas = doc.areas;
  const problems = Object.keys(doc)
    .filter((key) => key !== "areas")
    .map((key) => `unknown top-level field \`${key}\``);
  for (const [id, area] of Object.entries(areas))
    problems.push(...areaProblems(id, area, areas).map((p) => `${id}: ${p}`));
  if (problems.length === 0) {
    const cycle = findCycle(areas as Catalog);
    if (cycle) problems.push(`impliedBy cycle: ${cycle.join(" -> ")}`);
  }
  return problems;
}

function areaProblems(
  id: string,
  area: unknown,
  areas: Record<string, unknown>,
): string[] {
  const problems = AREA_ID.test(id) ? [] : ["the id is not kebab-case"];
  if (!isRecord(area)) return [...problems, "not a map"];
  return [
    ...problems,
    ...fieldProblems(area),
    ...referenceProblems(id, area.impliedBy, areas),
  ];
}

function fieldProblems(area: Record<string, unknown>): string[] {
  const problems = Object.keys(area)
    .filter((field) => !Object.hasOwn(FIELDS, field))
    .map((field) => `unknown field \`${field}\``);
  for (const [field, { required, check }] of Object.entries(FIELDS)) {
    const problem = Object.hasOwn(area, field)
      ? check(area[field])
      : required
        ? `\`${field}\` is missing`
        : null;
    if (problem) problems.push(problem);
  }
  return problems;
}

function referenceProblems(
  id: string,
  impliedBy: unknown,
  areas: Record<string, unknown>,
): string[] {
  if (!isStringList(impliedBy)) return [];
  return impliedBy.flatMap((ref) =>
    ref === id
      ? ["implies itself"]
      : Object.hasOwn(areas, ref)
        ? []
        : [`impliedBy names unknown area \`${ref}\``],
  );
}

/** One cycle of the implied-by relation, or null when there is none. */
function findCycle(catalog: Catalog): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  function visit(id: string): string[] | null {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "visiting")
      return [...path.slice(path.indexOf(id)), id];
    state.set(id, "visiting");
    path.push(id);
    for (const ref of catalog[id]?.impliedBy ?? []) {
      const cycle = visit(ref);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, "done");
    return null;
  }
  for (const id of Object.keys(catalog)) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function matcher(catalog: Catalog): (file: string) => string[] {
  const globs = Object.entries(catalog).map(
    ([id, area]) => [id, area.paths.map((p) => new Bun.Glob(p))] as const,
  );
  return (file) => {
    const path = file.replaceAll("\\", "/");
    return globs
      .filter(([, gs]) => gs.some((g) => g.match(path)))
      .map(([id]) => id);
  };
}

/** The files no area's paths match. */
export function uncoveredFiles(files: string[], catalog: Catalog): string[] {
  const areasOf = matcher(catalog);
  return files.filter((file) => areasOf(file).length === 0);
}

/**
 * Resolve changed files to areas: every area a file matches, then every area
 * whose `impliedBy` lists an area already in the set, until it stops growing.
 */
export function resolveAreas(files: string[], catalog: Catalog): Resolution {
  const areasOf = matcher(catalog);
  const seed = new Set<string>();
  const unmatched: string[] = [];
  for (const file of files) {
    const matched = areasOf(file);
    if (matched.length === 0) unmatched.push(file);
    for (const id of matched) seed.add(id);
  }
  const resolved = new Set(seed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, area] of Object.entries(catalog))
      if (!resolved.has(id) && area.impliedBy.some((r) => resolved.has(r))) {
        resolved.add(id);
        grew = true;
      }
  }
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

function git(root: string, args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
    ),
  );
  const result = spawnSync("git", ["-C", root, ...args], { env });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString();
}

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
    const catalog = (doc as { areas: Catalog }).areas;
    for (const file of uncoveredFiles(files, catalog))
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
