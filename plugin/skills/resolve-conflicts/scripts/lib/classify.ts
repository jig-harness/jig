/**
 * Classify a conflicted path: a lockfile, a generated file, a binary file,
 * or plain text. The class decides how the path is resolved: derived files
 * (lockfiles and generated files) are regenerated, never merged by hand.
 *
 * Lockfiles are recognised by file name from a small built-in table.
 * Generated files are declared by the repository in
 * `.config/jig.yaml`:
 *
 *   resolve_conflicts:
 *     generated:
 *       - paths: ["docs/index.md", "src/generated/**"]
 *         command: bun run generate
 *
 * A repository that keeps a change-area catalog (`drive.change_areas_catalog`)
 * has already declared its generated files there, with `outputs` and
 * `command` in each area's `generated:` list; those are read too, so the same
 * fact is not stated twice.
 *
 * Precedence, first match wins: `resolve_conflicts.generated`, then the
 * catalog's `generated[].outputs`, then the built-in lockfile table.
 */
import { posix } from "node:path";
import {
  globProblem,
  matchesGlob,
} from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";
import { OUTPUT_PATH_RE } from "../../../change-areas/scripts/lib/catalog.ts";
import { catalogPathFromOverlay } from "../../../do-item/scripts/determine_agent.ts";
import { fail } from "../../../../shared/cli.ts";
import { fieldInMessage } from "../../../../shared/config-layers.ts";
import { sourceIn } from "../../../../shared/consumer.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { stagedCatalog, stagedConfig } from "./staged-config.ts";

export type PathClass = "lockfile" | "generated" | "binary" | "text";

export interface Regenerate {
  command: string;
  /** Directory to run the command in, relative to the repository root. */
  cwd: string;
  source: "built-in" | "configuration" | "catalog";
}

export interface GeneratedEntry {
  /** Globs from the configuration; literal file paths from the catalog. */
  paths: string[];
  /** `null` for a catalog entry that declares outputs but no command. */
  command: string | null;
  source: "configuration" | "catalog";
}

/**
 * Lockfile name → the command that rebuilds it from its manifest. Kept to the
 * common package managers; a repository adds or replaces entries through
 * `resolve_conflicts.generated`.
 */
export const LOCKFILES: Readonly<Record<string, string>> = {
  "bun.lock": "bun install",
  "bun.lockb": "bun install",
  "package-lock.json": "npm install --package-lock-only",
  "npm-shrinkwrap.json": "npm install --package-lock-only",
  "pnpm-lock.yaml": "pnpm install --lockfile-only",
  "yarn.lock": "yarn install",
  "Cargo.lock": "cargo update --workspace",
  "go.sum": "go mod tidy",
  "uv.lock": "uv lock",
  "poetry.lock": "poetry lock",
  "Gemfile.lock": "bundle lock",
  "composer.lock": "composer update --lock",
};

/** `[<index>]: <reason>` for the first glob that cannot compile, or `null`. */
function firstInvalidGlob(paths: readonly string[]): string | null {
  for (const [j, glob] of paths.entries()) {
    const problem = globProblem(glob);
    if (problem !== null) return `[${j}]: ${problem}`;
  }
  return null;
}

const SECTION = "resolve_conflicts";

/**
 * The `resolve_conflicts.generated` entries, validated. A repository without
 * the configuration file or the section gets an empty list; a malformed
 * section stops the script with exit 2 and the exact field at fault.
 */
export function generatedEntries(): GeneratedEntry[] {
  let overlay: Record<string, unknown>;
  try {
    overlay = stagedConfig();
  } catch (err) {
    fail(2, `resolve-conflicts: ${err instanceof Error ? err.message : err}`);
  }
  const section = overlay[SECTION];
  if (section === undefined || section === null) return [];
  const bad = (what: string): never =>
    fail(
      2,
      `resolve-conflicts: ${what} in ${sourceIn(overlay, fieldInMessage(what, SECTION))}`,
    );
  if (typeof section !== "object" || Array.isArray(section))
    bad(`${SECTION} must be a mapping`);
  for (const key of Object.keys(section as object))
    if (key !== "generated" && key !== "obligations")
      bad(
        `${SECTION}.${key} is not a known key (known: generated, obligations)`,
      );
  const generated = (section as Record<string, unknown>).generated;
  if (generated === undefined || generated === null) return [];
  if (!Array.isArray(generated)) bad(`${SECTION}.generated must be a list`);
  return (generated as unknown[]).map((entry, i) => {
    const at = `${SECTION}.generated[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      bad(`${at} must be a mapping with paths and command`);
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record))
      if (key !== "paths" && key !== "command")
        bad(`${at}.${key} is not a known key (known: paths, command)`);
    const paths = record.paths;
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.some((p) => typeof p !== "string" || p.trim() === "")
    )
      bad(`${at}.paths must be a nonempty list of path globs`);
    const invalid = firstInvalidGlob(paths as string[]);
    if (invalid !== null) bad(`${at}.paths${invalid}`);
    if (typeof record.command !== "string" || record.command.trim() === "")
      bad(`${at}.command must be a nonempty string`);
    return {
      paths: paths as string[],
      command: record.command as string,
      source: "configuration",
    };
  });
}

/** The catalog's generated entries, and what was wrong with the catalog or an entry. */
export interface CatalogGenerated {
  entries: GeneratedEntry[];
  /** One line per problem, for the map to print: nothing here is skipped silently. */
  problems: string[];
  /**
   * Why the catalog's generated declarations could not all be honoured (the
   * catalog cannot be read, or an entry's `outputs` are malformed), or `null`.
   * Set, the map is incomplete: a file the catalog means to declare generated
   * was classified by the other rules, so the check refuses until a map that
   * honours every declaration clears it.
   */
  incomplete: string | null;
}

/** The catalog path `drive.change_areas_catalog` names, or `null` when unset. */
function configuredCatalogPath(): string | null {
  let overlay: Record<string, unknown>;
  try {
    overlay = stagedConfig();
  } catch (err) {
    fail(2, `resolve-conflicts: ${err instanceof Error ? err.message : err}`);
  }
  try {
    return catalogPathFromOverlay(overlay);
  } catch (err) {
    const what = err instanceof Error ? err.message : String(err);
    return fail(
      2,
      `resolve-conflicts: ${what} in ${sourceIn(overlay, fieldInMessage(what, "drive"))}`,
    );
  }
}

/** One catalog `generated[]` entry as a derived-file entry, or why it is not one. */
function catalogEntry(
  entry: Record<string, unknown>,
  at: string,
): { entry?: GeneratedEntry; problems: string[]; malformed?: string } {
  const outputs = entry.outputs;
  if (
    !Array.isArray(outputs) ||
    outputs.length === 0 ||
    outputs.some((p) => typeof p !== "string" || p.trim() === "")
  ) {
    const malformed = `${at}.outputs is not a nonempty list of paths`;
    return { problems: [malformed], malformed };
  }
  const paths = outputs as string[];
  // The catalog declares literal output files, never globs: `**` would claim
  // every conflicted path as generated.
  const invalid = paths.find((p) => !OUTPUT_PATH_RE.test(p));
  if (invalid !== undefined) {
    const malformed = `${at}.outputs: "${invalid}" is not a literal repository-relative file path`;
    return { problems: [malformed], malformed };
  }
  const command =
    typeof entry.command === "string" && entry.command.trim() !== ""
      ? entry.command
      : null;
  return {
    entry: { paths, command, source: "catalog" },
    problems:
      command === null
        ? [
            `${at} declares outputs (${paths.join(", ")}) but no command: they are generated files, so take the integration side and pass --command to record.ts when you record them regenerated`,
          ]
        : [],
  };
}

/**
 * The generated entries of the change-area catalog the repository declares in
 * `drive.change_areas_catalog`: each area's `generated[].outputs` with that
 * entry's `command`. No catalog configured gives an empty result. A catalog
 * that cannot be read, or an entry whose `outputs` are malformed, is reported
 * and marks the map incomplete, not fatal: the catalog may be among the
 * conflicted paths, and the map must still run so it can be resolved first.
 * An entry without a `command` still claims its outputs, so a derived file is
 * never hand-merged, and is reported.
 */
export function catalogGeneratedEntries(): CatalogGenerated {
  const result: CatalogGenerated = {
    entries: [],
    problems: [],
    incomplete: null,
  };
  const path = configuredCatalogPath();
  if (path === null) return result;
  let areas: ReturnType<typeof stagedCatalog>;
  try {
    areas = stagedCatalog(path);
  } catch (err) {
    result.incomplete = err instanceof Error ? err.message : String(err);
    result.problems.push(
      `${result.incomplete}. Files that only the catalog declares as generated are classified by the other rules until it can be read; resolve the catalog first if it is itself conflicted, then run conflict-map.ts again (check-resolution.ts refuses until then).`,
    );
    return result;
  }
  const malformed: string[] = [];
  for (const [key, area] of areas) {
    const generated = area.fields.generated;
    // loadCatalogFile has checked that `generated` is a list of mappings.
    if (!Array.isArray(generated)) continue;
    generated.forEach((entry: unknown, i) => {
      if (!isRecord(entry)) return;
      const found = catalogEntry(entry, `catalog area ${key}.generated[${i}]`);
      if (found.entry) result.entries.push(found.entry);
      if (found.malformed) malformed.push(found.malformed);
      result.problems.push(...found.problems);
    });
  }
  if (malformed.length > 0) {
    result.incomplete = malformed.join("; ");
    result.problems.push(
      "The outputs of an entry reported above are classified by the other rules until it is corrected; correct the catalog, then run conflict-map.ts again (check-resolution.ts refuses until then).",
    );
  }
  return result;
}

/** How a path is derived: its class and, when known, the command that rebuilds it. */
export interface Derived {
  class: "lockfile" | "generated";
  regenerate: Regenerate | null;
}

/**
 * Is `path` a derived file, and how is it rebuilt? `entries` are tried in the
 * order given (callers pass the configuration's, then the catalog's), then the
 * built-in lockfile table; `null` when it is none of these.
 */
export function regenerateFor(
  path: string,
  entries: readonly GeneratedEntry[],
): Derived | null {
  for (const entry of entries)
    if (
      entry.paths.some((p) =>
        entry.source === "catalog" ? p === path : matchesGlob(path, p),
      )
    )
      return {
        class: "generated",
        regenerate:
          entry.command === null
            ? null
            : { command: entry.command, cwd: ".", source: entry.source },
      };
  const name = posix.basename(path);
  if (!Object.hasOwn(LOCKFILES, name)) return null;
  return {
    class: "lockfile",
    regenerate: {
      command: LOCKFILES[name] as string,
      cwd: posix.dirname(path),
      source: "built-in",
    },
  };
}
