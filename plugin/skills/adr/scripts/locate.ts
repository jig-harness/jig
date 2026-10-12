#!/usr/bin/env bun
/**
 * Find the repository's decision records and decision-rules file, and the
 * next free record number.
 *
 * Usage: bun locate.ts
 *   Run from inside the repository. Prints JSON:
 *   { directory, naming, width, highest, next, nextFile, rulesFile }
 *
 * - `directory`: `adr.directory` from `.config/jig.yaml` when
 *   set (it must exist), else the first existing candidate in
 *   CANDIDATE_DIRS, else null (no records yet; the caller proposes
 *   `docs/adr`).
 * - `naming`: `ADR-NNNN-<slug>.md` or `NNNN-<slug>.md`, read from the files
 *   already there (default the former). `width` is the zero-padding the
 *   records of that naming already use (four when there are none).
 * - `highest` / `next`: the highest number in use under either naming, and
 *   the next one.
 *   Picking "highest plus one" races with other branches; the numbering gate
 *   is what catches a collision.
 * - `rulesFile`: `adr.rules_file` when set (it must exist), else the one
 *   tracked file named like a decision-rules catalog (outside test fixtures
 *   and templates), else null.
 *
 * Exit codes: 0 printed; 2 the configuration names a path that does not exist,
 * several rules files match and none is configured, or `git ls-files` fails
 * (the search for a rules file would be inconclusive).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix } from "node:path";
import {
  consumerRoot,
  overlayPath,
} from "../../resolve-review-comments/scripts/lib/consumer.ts";
import { load } from "../../resolve-review-comments/scripts/lib/yaml.ts";

export const CANDIDATE_DIRS = [
  "docs/adr",
  "docs/adrs",
  "doc/adr",
  "docs/decisions",
  "docs/architecture/decisions",
  "doc/architecture/decisions",
  "adr",
  "decisions",
];

const RULES_NAMES = new Set([
  "adr-rules.yaml",
  ".adr-rules.yaml",
  "adr-rules.yml",
]);

export interface AdrConfig {
  directory?: string;
  rules_file?: string;
}

export interface Location {
  directory: string | null;
  naming: "ADR-NNNN-<slug>.md" | "NNNN-<slug>.md";
  width: number;
  highest: number | null;
  next: string;
  nextFile: string;
  rulesFile: string | null;
}

export class LocateError extends Error {}

/** The `adr` section of the overlay; {} when the file or section is absent. */
export function adrConfig(path = overlayPath()): AdrConfig {
  if (!existsSync(path)) return {};
  const overlay = load(readFileSync(path, "utf8")) as Record<string, unknown>;
  const section = overlay?.adr;
  if (section === undefined || section === null) return {};
  if (typeof section !== "object" || Array.isArray(section))
    throw new LocateError(`adr must be an object: ${path}`);
  const config: AdrConfig = {};
  for (const key of ["directory", "rules_file"] as const) {
    const value = (section as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.trim() === "")
      throw new LocateError(`adr.${key} must be a nonempty string: ${path}`);
    config[key] = value;
  }
  return config;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A file named like a decision-rules catalog. Test fixtures and copyable
 * templates are not the repository's live catalog, so they never count.
 */
export function isRulesFile(path: string): boolean {
  if (/(^|\/)(fixtures?|templates?)\//.test(path)) return false;
  return (
    RULES_NAMES.has(basename(path)) ||
    /(^|\/)adr-rules\/rules\.ya?ml$/.test(path)
  );
}

/**
 * The repository's tracked files. A failed listing throws: reading it as "no
 * files" would report no rules file and quietly drop rule enforcement. `-z`
 * lists each path verbatim, NUL-terminated: without it git quotes and escapes
 * any path with a non-ASCII byte (`core.quotePath`), so a catalog under such a
 * directory would never match a rules-file name.
 */
export function trackedFiles(root: string, env = process.env): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new LocateError(
      `git ls-files failed in ${root}, so the rules file cannot be located: ${
        result.error?.message ??
        (result.stderr.trim() || `exit ${result.status}`)
      }`,
    );
  return result.stdout.split("\0").filter(Boolean);
}

export function locate(
  root: string,
  config: AdrConfig,
  tracked: string[] = trackedFiles(root),
): Location {
  let directory: string | null = null;
  if (config.directory !== undefined) {
    if (!isDir(join(root, config.directory)))
      throw new LocateError(
        `adr.directory is ${config.directory}, which is not a directory`,
      );
    directory = config.directory;
  } else
    directory = CANDIDATE_DIRS.find((dir) => isDir(join(root, dir))) ?? null;

  const files = directory ? readdirSync(join(root, directory)) : [];
  const prefixed = files
    .map((name) => name.match(/^ADR-(\d+)-.*\.md$/i)?.[1])
    .filter((n): n is string => n !== undefined);
  const bare = files
    .map((name) => name.match(/^(\d{3,})-.*\.md$/)?.[1])
    .filter((n): n is string => n !== undefined);
  // The style decides how the next file is named; numbering counts records of
  // both styles, so a directory that mixes them never reuses a number.
  const prefixedStyle = prefixed.length > 0 || bare.length === 0;
  const styled = prefixedStyle ? prefixed : bare;
  const width = styled.length ? Math.max(...styled.map((n) => n.length)) : 4;
  const numbers = [...prefixed, ...bare];
  const highest = numbers.length
    ? Math.max(...numbers.map((n) => Number.parseInt(n, 10)))
    : null;
  const next = String((highest ?? 0) + 1).padStart(width, "0");
  const naming = prefixedStyle ? "ADR-NNNN-<slug>.md" : "NNNN-<slug>.md";
  const nextName = prefixedStyle
    ? `ADR-${next}-<slug>.md`
    : `${next}-<slug>.md`;

  let rulesFile: string | null = null;
  if (config.rules_file !== undefined) {
    if (!existsSync(join(root, config.rules_file)))
      throw new LocateError(
        `adr.rules_file is ${config.rules_file}, which does not exist`,
      );
    rulesFile = config.rules_file;
  } else {
    const found = tracked.filter(isRulesFile);
    if (found.length > 1)
      throw new LocateError(
        `several decision-rules files found (${found.join(", ")}); set adr.rules_file in the overlay`,
      );
    rulesFile = found[0] ?? null;
  }

  return {
    directory,
    naming,
    width,
    highest,
    next,
    // A repository-relative path, written with forward slashes on every system.
    nextFile: posix.join(directory ?? "docs/adr", nextName),
    rulesFile,
  };
}

if (import.meta.main) {
  try {
    const root = consumerRoot();
    console.log(JSON.stringify(locate(root, adrConfig()), null, 2));
  } catch (error) {
    console.error(`locate: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
