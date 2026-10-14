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
 * A `generated` entry also overrides the built-in table for a path it matches.
 */
import { posix } from "node:path";
import {
  globProblem,
  matchesGlob,
} from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";
import { fail } from "../../../resolve-review-comments/scripts/lib/cli.ts";
import { fieldInMessage } from "../../../resolve-review-comments/scripts/lib/config-layers.ts";
import {
  readConfig,
  sourceIn,
} from "../../../resolve-review-comments/scripts/lib/consumer.ts";

export type PathClass = "lockfile" | "generated" | "binary" | "text";

export interface Regenerate {
  command: string;
  /** Directory to run the command in, relative to the repository root. */
  cwd: string;
  source: "built-in" | "configuration";
}

export interface GeneratedEntry {
  paths: string[];
  command: string;
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
    overlay = readConfig();
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
    if (key !== "generated")
      bad(`${SECTION}.${key} is not a known key (known: generated)`);
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
    return { paths: paths as string[], command: record.command as string };
  });
}

/** The command that regenerates `path`, or null when it is not a derived file. */
export function regenerateFor(
  path: string,
  entries: readonly GeneratedEntry[],
): (Regenerate & { class: "lockfile" | "generated" }) | null {
  for (const entry of entries)
    if (entry.paths.some((glob) => matchesGlob(path, glob)))
      return {
        class: "generated",
        command: entry.command,
        cwd: ".",
        source: "configuration",
      };
  const name = posix.basename(path);
  if (!Object.hasOwn(LOCKFILES, name)) return null;
  const command = LOCKFILES[name] as string;
  return {
    class: "lockfile",
    command,
    cwd: posix.dirname(path),
    source: "built-in",
  };
}
