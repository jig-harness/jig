/**
 * The catalog's invariants beyond its schema: the `impliedBy` graph, and
 * the facts about the repository the catalog states (workspaces, generated
 * files). Each check returns problems rather than throwing, so a composer
 * adds its own and reports them all together.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { globMatchesUnder } from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";
import type { Area, Catalog } from "./catalog.ts";
import { defaultGitRunner, matchesGlob, matchSeedAreas } from "./resolve.ts";

/** What the repository-facing checks read: its root and its files. */
export interface CheckContext {
  /** The repository root that workspace and output paths are relative to. */
  root: string;
  /** Repository-relative paths of the repository's files. */
  trackedFiles: string[];
}

/**
 * The `impliedBy` graph's problems: a reference to no area, an area implying
 * itself, and one cycle. A cycle is a modelling error: the relation is a
 * direction, and the closure would silently merge the cycle's areas into one.
 */
export function graphProblems(catalog: Catalog): string[] {
  const { areas } = catalog;
  const problems: string[] = [];
  for (const [id, area] of Object.entries(areas))
    for (const ref of area.impliedBy) {
      if (ref === id) problems.push(`${id}: implies itself`);
      else if (!Object.hasOwn(areas, ref))
        problems.push(`${id}: impliedBy names unknown area \`${ref}\``);
    }
  const cycle = findCycle(catalog);
  if (cycle) problems.push(`impliedBy cycle: ${cycle.join(" -> ")}`);
  return problems;
}

/**
 * GitHub output names two areas share: an area `app` writes `app-seed` as
 * its seed output, so an area keyed `app-seed` would write the same name
 * for its closure, and the later line would hide the earlier one.
 */
export function outputNameProblems(catalog: Catalog): string[] {
  return Object.keys(catalog.areas)
    .filter((id) => id.endsWith("-seed"))
    .filter((id) => Object.hasOwn(catalog.areas, id.slice(0, -"-seed".length)))
    .map(
      (id) =>
        `${id}: its GitHub output collides with the seed output of \`${id.slice(0, -"-seed".length)}\`; rename one of them`,
    );
}

/** One cycle of the relation, over known areas other than the area itself. */
function findCycle(catalog: Catalog): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "visiting")
      return [...path.slice(path.indexOf(id)), id];
    state.set(id, "visiting");
    path.push(id);
    for (const ref of catalog.areas[id]?.impliedBy ?? []) {
      if (ref === id || !Object.hasOwn(catalog.areas, ref)) continue;
      const cycle = visit(ref);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, "done");
    return null;
  };
  for (const id of Object.keys(catalog.areas)) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Each declared workspace is a directory, and the area's own paths cover
 * every repository file under it: a workspace file only another area
 * matches changes without seeding the area that owns the workspace, so its
 * checks and reviews never run. Coverage is read through the globs, so
 * `apps/**` covers the workspace `apps/web`, and `apps/web/docs/**` alone
 * does not.
 */
export function workspaceProblems(
  catalog: Catalog,
  { root, trackedFiles }: CheckContext,
): string[] {
  return Object.entries(catalog.areas).flatMap(([id, area]) =>
    area.workspace.flatMap((ws) =>
      oneWorkspaceProblems(id, area, ws, { root, trackedFiles }),
    ),
  );
}

/** One declared workspace's problems. */
function oneWorkspaceProblems(
  id: string,
  area: Area,
  ws: string,
  { root, trackedFiles }: CheckContext,
): string[] {
  // Git's paths are canonical, so a workspace spelt any other way
  // (`./apps/web`, `apps/web/`) would be compared against no file.
  if (!isCanonical(ws))
    return [
      `${id}: workspace \`${ws}\` is not a repository-relative path in canonical form; write it as git lists paths, such as \`apps/web\``,
    ];
  const dir = join(root, ws);
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    return [`${id}: workspace \`${ws}\` is not a directory`];
  const inside = trackedFiles.filter((f) => f.startsWith(`${ws}/`));
  const owns = (file: string) => area.paths.some((p) => matchesGlob(file, p));
  const unowned = inside.filter((f) => !owns(f));
  // A workspace with no files yet has none to match: ask whether a glob
  // could match a plainly named one.
  const reached = inside.length
    ? unowned.length < inside.length
    : area.paths.some((p) => globMatchesUnder(p, ws));
  if (!reached)
    return [
      `${id}: workspace \`${ws}\` is matched by none of the area's paths; add one that covers \`${ws}/**\``,
    ];
  if (unowned.length === 0) return [];
  return [
    `${id}: workspace \`${ws}\` holds ${unowned.length} file(s) the area's own paths do not match, such as \`${unowned[0]}\`; widen the area's paths to cover \`${ws}/**\``,
  ];
}

/** Relative, without empty, `.` or `..` segments: the form git lists. */
function isCanonical(path: string): boolean {
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

/** Each output's problems; `owners` records who declared each output first. */
function outputProblems(
  id: string,
  area: Area,
  outputs: string[],
  root: string,
  owners: Map<string, string>,
): string[] {
  return outputs.flatMap((output) => {
    const problems: string[] = [];
    if (!isFile(join(root, output)))
      problems.push(`${id}: generated output \`${output}\` is not a file`);
    if (!area.paths.some((p) => matchesGlob(output, p)))
      problems.push(
        `${id}: generated output \`${output}\` is not matched by the area's own paths; add it to them`,
      );
    const owner = owners.get(output);
    if (owner === undefined) owners.set(output, id);
    else if (owner === id)
      problems.push(
        `${id}: generated output \`${output}\` is declared by two of the area's generators; each output has one`,
      );
    else
      problems.push(
        `generated output \`${output}\` is declared by both \`${owner}\` and \`${id}\`; each output has one owning area`,
      );
    return problems;
  });
}

/** Each source's problems against the repository's files. */
function sourceProblems(
  id: string,
  sources: string[],
  catalog: Catalog,
  trackedFiles: string[],
): string[] {
  const claimed = (file: string) =>
    Object.values(catalog.areas).some((a) =>
      a.paths.some((p) => matchesGlob(file, p)),
    );
  return sources.flatMap((source) => {
    const matched = trackedFiles.filter((f) => matchesGlob(f, source));
    if (matched.length === 0)
      return [
        `${id}: generated source \`${source}\` matches no file of the repository; fix the path or drop the entry`,
      ];
    const homeless = matched.find((f) => !claimed(f));
    return homeless === undefined
      ? []
      : [
          `${id}: generated source \`${source}\` matches \`${homeless}\`, which no area's paths match; add it to the owning area's paths`,
        ];
  });
}

/**
 * Each generated output is a file, declared once in the whole catalog, and
 * matched by its own area's paths, so a hand edit to it seeds the area that
 * owns its check. Each source matches a file of the repository (a renamed or
 * misspelt generator would otherwise stop seeding its area without a word),
 * and every file it matches belongs to some area.
 */
export function generatedProblems(
  catalog: Catalog,
  { root, trackedFiles }: CheckContext,
): string[] {
  const owners = new Map<string, string>();
  return Object.entries(catalog.areas).flatMap(([id, area]) =>
    (area.generated ?? []).flatMap((gen) => [
      ...outputProblems(id, area, gen.outputs, root, owners),
      ...sourceProblems(id, gen.source, catalog, trackedFiles),
    ]),
  );
}

/** Every generic invariant: the graph, the workspaces, the generated files. */
export function checkCatalog(catalog: Catalog, ctx: CheckContext): string[] {
  return [
    ...graphProblems(catalog),
    ...outputNameProblems(catalog),
    ...workspaceProblems(catalog, ctx),
    ...generatedProblems(catalog, ctx),
  ];
}

/**
 * The files no area claims, for a repository whose policy is that every file
 * belongs to an area. A file claimed only by a generator's source counts as
 * claimed: it seeds that generator's area.
 */
export function uncoveredFiles(files: string[], catalog: Catalog): string[] {
  return files.filter((file) => matchSeedAreas([file], catalog).size === 0);
}

/** The repository's files, tracked and untracked but not ignored. */
export function repositoryFiles(root: string): string[] {
  const listed = defaultGitRunner([
    "-C",
    root,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  return [...new Set(listed.split("\0").filter(Boolean))];
}
