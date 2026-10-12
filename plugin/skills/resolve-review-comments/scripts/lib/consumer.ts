/**
 * Resolve the consumer repository and its configuration at run time.
 *
 * The skill is installed once per machine (as a harness plugin), so the
 * scripts run from a shared directory outside any repository. Everything that
 * differs per repository is read from the repository the agent is working in:
 * its configuration file, its triage bands and its sibling skills.
 */
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { load } from "./yaml.ts";

/** The consumer configuration file, relative to the repository root. */
export const OVERLAY_RELPATH = ".config/jig.yaml";

/** Where to read about adopting the skill, quoted in configuration errors. */
export const ADOPTION_DOC =
  "https://github.com/docomply/jig/blob/main/plugin/README.md#configure-a-repository";

export interface ReviewConfig {
  bots?: string[];
  job_pattern?: string;
  required_checks?: string[];
  deferral_team?: string;
  repo_label?: string;
  repo_slug?: string;
  taxonomy?: {
    types?: string[];
    repos?: string[];
    sizes?: string[];
    context_prefixes?: string[];
    ownership_prefixes?: string[];
    categories?: string[];
    provenance_label?: string;
    epic_label?: string;
  };
}

/**
 * The repository the agent is working in: `JIG_CONSUMER_ROOT` when
 * set, else the nearest ancestor of `cwd` holding `.git` (a directory in a
 * clone, a file in a linked worktree), else `cwd` itself.
 */
export function consumerRoot(cwd = process.cwd()): string {
  const explicit = process.env.JIG_CONSUMER_ROOT;
  if (explicit !== undefined && explicit.trim() !== "")
    return resolve(explicit);
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/**
 * Only a confirmed absence counts as absent: the path does not exist (ENOENT)
 * and its nearest existing ancestor is a directory that resolves. Any other
 * outcome is indeterminate and counts as present, so the caller's use of the
 * path fails visibly instead of quietly falling back to a standalone path:
 * an inspection error (EACCES, ENOTDIR, ...), or an ancestor that is a
 * dangling link (ENOENT below it says nothing about the intended target).
 */
export function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (code(error) !== "ENOENT") return true;
  }
  let ancestor = dirname(path);
  for (;;) {
    try {
      lstatSync(ancestor);
    } catch (error) {
      if (code(error) !== "ENOENT") return true;
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
      continue;
    }
    try {
      return !statSync(ancestor).isDirectory();
    } catch {
      return true;
    }
  }
}

/**
 * Compile the reviewer check pattern and check its declared coverage: a
 * pattern requires `required_checks`, and every required name must match it.
 * Shared by the configuration step and the wait step so a configuration the
 * wait step would refuse is refused before any work starts. Returns null when
 * no pattern is set; throws with the operator-facing message otherwise.
 */
export function reviewerSelection(
  jobPatternRaw: string,
  requiredChecks: readonly string[],
): RegExp | null {
  if (jobPatternRaw === "") return null;
  let jobPattern: RegExp;
  try {
    jobPattern = new RegExp(jobPatternRaw);
  } catch (e) {
    throw new Error(
      `--job-pattern is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (requiredChecks.length === 0)
    throw new Error(
      "an explicit --job-pattern or review.job_pattern requires review.required_checks in the consumer overlay; declare required check names and omit dormant optional arms",
    );
  for (const name of requiredChecks)
    if (!jobPattern.test(name))
      throw new Error(
        `required check '${name}' is excluded by --job-pattern '${jobPatternRaw}'`,
      );
  return jobPattern;
}

/**
 * A sibling skill's directory. The consumer's own project skill
 * (`.claude/skills/<name>`) wins, so a repository that keeps a sibling such
 * as `drive-pr` locally integrates with it; a dangling link there still
 * counts as present, so a broken integration fails visibly instead of
 * degrading. Otherwise the sibling beside this skill in the same plugin.
 */
export function siblingSkill(name: string, scriptDir: string): string {
  const project = join(consumerRoot(), ".claude", "skills", name);
  if (present(project)) return project;
  return join(dirname(dirname(scriptDir)), name);
}

/** The configuration file path: `JIG_OVERLAY`, else the repository's own. */
export function overlayPath(): string {
  const override = process.env.JIG_OVERLAY;
  if (override !== undefined && override.trim() !== "") return override;
  return join(consumerRoot(), OVERLAY_RELPATH);
}

/**
 * The whole consumer configuration, parsed. A missing file is an error, never
 * an empty configuration: an installed skill invoked in a repository that has
 * not adopted it must say so rather than run with guessed policy.
 */
export function readOverlay(): Record<string, unknown> {
  const path = overlayPath();
  if (!existsSync(path))
    throw new Error(
      `Jig configuration not found: ${path}. This repository has not configured the review skill; add ${OVERLAY_RELPATH} (see ${ADOPTION_DOC}) or point JIG_OVERLAY at a configuration file.`,
    );
  let overlay: unknown;
  try {
    overlay = load(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `Jig configuration could not be parsed: ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay))
    throw new Error(`consumer overlay must be an object: ${path}`);
  return overlay as Record<string, unknown>;
}

export function reviewConfig(): ReviewConfig {
  const path = overlayPath();
  const review = readOverlay().review;
  if (review === undefined) return {};
  if (!review || typeof review !== "object" || Array.isArray(review))
    throw new Error(`review must be an object: ${path}`);
  const entries = Object.entries(review).filter(
    // A null pattern means "not set": wait on the reviewer-name heuristic.
    ([key, value]) => !(key === "job_pattern" && value === null),
  );
  for (const [key, value] of entries) {
    if (
      key === "bots" &&
      (!Array.isArray(value) ||
        value.some((x) => typeof x !== "string" || x.trim() === ""))
    )
      throw new Error("review.bots must be a list of nonempty reviewer names");
    if (
      ["job_pattern", "deferral_team", "repo_label", "repo_slug"].includes(
        key,
      ) &&
      typeof value !== "string"
    )
      throw new Error(`review.${key} must be a string`);
    if (
      key === "required_checks" &&
      (!Array.isArray(value) ||
        value.length === 0 ||
        value.some((x) => typeof x !== "string" || !x.trim()) ||
        new Set(value).size !== value.length)
    )
      throw new Error(
        "review.required_checks must contain distinct nonempty check names",
      );
    if (key === "taxonomy") {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("review.taxonomy must be an object");
      // Context ownership controls whether two findings may share a batch.
      // Omitting the ownership set must not silently allow unrelated owners
      // to be reconciled together when a consumer declares batching labels.
      if (
        ["context_prefixes", "types", "repos"].some((field) =>
          Object.hasOwn(value, field),
        ) &&
        !Object.hasOwn(value, "ownership_prefixes")
      )
        throw new Error(
          "review.taxonomy.ownership_prefixes is required with context_prefixes, types, or repos; declare the ownership label prefixes before filing deferred findings",
        );
      for (const [field, tokens] of Object.entries(value)) {
        if (["provenance_label", "epic_label"].includes(field)) {
          if (typeof tokens !== "string" || !tokens.trim())
            throw new Error(
              `review.taxonomy.${field} must be a nonempty string`,
            );
        } else if (
          !Array.isArray(tokens) ||
          !tokens.length ||
          tokens.some((x) => typeof x !== "string" || !x.trim()) ||
          new Set(tokens).size !== tokens.length
        )
          throw new Error(
            `review.taxonomy.${field} must contain distinct nonempty strings`,
          );
      }
    }
  }
  return Object.fromEntries(entries) as ReviewConfig;
}
