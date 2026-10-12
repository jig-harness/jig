/**
 * The consumer repository's own values for `/decide` and `/explain`, read at
 * run time from its Jig configuration (`.config/jig.yaml` and the other
 * layers).
 *
 * Every field these skills read has a default, so a repository that has not
 * written the file still gets a working skill: the defaults follow
 * Jig's own conventions (ADRs under `docs/adr/` as module M5 lays
 * them out, policy in `AGENTS.md`). A file that exists but cannot be read or
 * holds a field of the wrong type is an error, never a silent default.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  layeredConfig,
  withSource,
} from "../../../resolve-review-comments/scripts/lib/consumer.ts";
import { CANDIDATE_DIRS } from "../../../adr/scripts/locate.ts";

/** Where the ADRs live when `adr.directory` is not set and none is detected (Jig module M5). */
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
 * The merged configuration of the repository at `repoRoot` (every layer, see
 * `config-layers.ts`), or `{}` when no layer exists. A `JIG_OVERLAY` that
 * names a missing file is an error.
 */
export function readOptionalOverlay(repoRoot: string): Record<string, unknown> {
  const config = layeredConfig(repoRoot);
  if (!config.hasRepository && process.env.JIG_OVERLAY?.trim())
    throw new Error(
      `JIG_OVERLAY names a missing file: ${config.repositoryPath}`,
    );
  return config.values;
}

function sectionOf(
  overlay: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const value = overlay[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be a mapping`);
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
  try {
    return detectedAdrDirectory(overlay, repoRoot);
  } catch (err) {
    throw withSource(overlay, "adr", err);
  }
}

function detectedAdrDirectory(
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
  const adr = adrDirectory(overlay, repoRoot);
  try {
    return { adrDirectory: adr, ...decideSources(overlay) };
  } catch (err) {
    throw withSource(overlay, "decide", err);
  }
}

function decideSources(
  overlay: Record<string, unknown>,
): Omit<PrecedentSources, "adrDirectory"> {
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
  try {
    const value = sectionOf(overlay, "explain").figure_build_command;
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "")
      throw new Error("explain.figure_build_command must be a nonempty string");
    return value.trim();
  } catch (err) {
    throw withSource(overlay, "explain", err);
  }
}
