/**
 * The consumer repository's own values for `/decide` and `/explain`, read at
 * run time from `.config/groundwork-overlay.yaml`.
 *
 * Every field these skills read has a default, so a repository that has not
 * written the file still gets a working skill: the defaults follow
 * Groundwork's own conventions (ADRs under `docs/adr/` as module M5 lays
 * them out, policy in `AGENTS.md`). A file that exists but cannot be read or
 * holds a field of the wrong type is an error, never a silent default.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { load } from "../../../resolve-review-comments/scripts/lib/yaml.ts";
import { CANDIDATE_DIRS } from "../../../adr/scripts/locate.ts";

/** The consumer configuration file, relative to the repository root. */
export const OVERLAY_RELPATH = ".config/groundwork-overlay.yaml";

/** Where the ADRs live when `adr.directory` is not set and none is detected (Groundwork module M5). */
export const DEFAULT_ADR_DIRECTORY = "docs/adr";

/** The precedent sources `/decide` searches, as repository-relative paths. */
export interface PrecedentSources {
  /** The directory holding `ADR-NNNN-<slug>.md` records (`adr.directory`). */
  adrDirectory: string;
  /** Instruction files whose `##` sections are standing policy (`decide.policy_files`). */
  policyFiles: string[];
  /** A directory of conditional rule files, one rule per `.md` file (`decide.rules_directory`). */
  rulesDirectory: string;
  /** The canonical-vocabulary file with `**Term**:` and `_Avoid_:` lines (`decide.glossary_file`). */
  glossaryFile: string;
}

export const DEFAULT_PRECEDENT_SOURCES: PrecedentSources = {
  adrDirectory: DEFAULT_ADR_DIRECTORY,
  policyFiles: ["AGENTS.md"],
  rulesDirectory: ".claude/rules",
  glossaryFile: "CONTEXT.md",
};

/**
 * The parsed configuration of the repository at `repoRoot`, or `{}` when it
 * has none. `GROUNDWORK_OVERLAY` names another file; that file must exist.
 */
export function readOptionalOverlay(repoRoot: string): Record<string, unknown> {
  const override = process.env.GROUNDWORK_OVERLAY;
  const explicit = override !== undefined && override.trim() !== "";
  const path = explicit ? override : join(repoRoot, OVERLAY_RELPATH);
  if (!existsSync(path)) {
    if (explicit)
      throw new Error(`GROUNDWORK_OVERLAY names a missing file: ${path}`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = load(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `Groundwork configuration could not be parsed: ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`Groundwork configuration must be a mapping: ${path}`);
  return parsed as Record<string, unknown>;
}

function sectionOf(
  overlay: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const value = overlay[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} in ${OVERLAY_RELPATH} must be a mapping`);
  return value as Record<string, unknown>;
}

/** A repository-relative path: no absolute path, no `..` segment. */
function relativePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${field} must be a nonempty string`);
  const path = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^(?:[A-Za-z]:)?\//.test(path) || path.split("/").includes(".."))
    throw new Error(`${field} must be a path inside the repository: ${value}`);
  return path;
}

function optionalPath(
  section: Record<string, unknown>,
  key: string,
  field: string,
  fallback: string,
): string {
  return section[key] === undefined
    ? fallback
    : relativePath(section[key], field);
}

/**
 * The ADR directory: `adr.directory`, else the first of the `/adr` skill's
 * candidate directories that exists under `repoRoot`, else `docs/adr`. The
 * same detection as `/adr`, so the two skills never disagree on where the
 * records are.
 */
export function adrDirectory(
  overlay: Record<string, unknown>,
  repoRoot?: string,
): string {
  const detected =
    repoRoot === undefined
      ? undefined
      : CANDIDATE_DIRS.find((dir) => {
          try {
            return statSync(join(repoRoot, dir)).isDirectory();
          } catch {
            return false;
          }
        });
  return optionalPath(
    sectionOf(overlay, "adr"),
    "directory",
    "adr.directory",
    detected ?? DEFAULT_ADR_DIRECTORY,
  );
}

/** Every precedent source, each from its overlay field or its default. */
export function precedentSources(
  overlay: Record<string, unknown>,
  repoRoot?: string,
): PrecedentSources {
  const decide = sectionOf(overlay, "decide");
  const d = DEFAULT_PRECEDENT_SOURCES;
  let policyFiles = d.policyFiles;
  if (decide.policy_files !== undefined) {
    if (!Array.isArray(decide.policy_files))
      throw new Error("decide.policy_files must be a list of paths");
    policyFiles = decide.policy_files.map((p, i) =>
      relativePath(p, `decide.policy_files[${i}]`),
    );
  }
  return {
    adrDirectory: adrDirectory(overlay, repoRoot),
    policyFiles,
    rulesDirectory: optionalPath(
      decide,
      "rules_directory",
      "decide.rules_directory",
      d.rulesDirectory,
    ),
    glossaryFile: optionalPath(
      decide,
      "glossary_file",
      "decide.glossary_file",
      d.glossaryFile,
    ),
  };
}

/** The command that builds one explainer figure (`explain.figure_build_command`), or undefined. */
export function figureBuildCommand(
  overlay: Record<string, unknown>,
): string | undefined {
  const value = sectionOf(overlay, "explain").figure_build_command;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    throw new Error("explain.figure_build_command must be a nonempty string");
  return value.trim();
}
