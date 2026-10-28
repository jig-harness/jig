/**
 * Resolve the consumer repository and its configuration at run time.
 *
 * The skill is installed once per machine (as a harness plugin), so the
 * scripts run from a shared directory outside any repository. Everything that
 * differs per repository is read from the repository the agent is working in:
 * its configuration file, its triage bands and its sibling skills.
 */
import { existsSync, lstatSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  fieldInMessage,
  type LayeredConfig,
  loadLayeredConfig,
  OVERLAY_RELPATH,
  repositoryConfigPath,
  sourceOf,
} from "./config-layers.ts";

export { OVERLAY_RELPATH };

/** Where to read about adopting the skill, quoted in configuration errors. */
const ADOPTION_DOC =
  "https://github.com/jig-harness/jig/blob/main/plugin/README.md#configure-a-repository";

export interface ReviewConfig {
  bots?: string[];
  job_pattern?: string;
  required_checks?: string[];
  scanner_apps?: string[];
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
function present(path: string): boolean {
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

/** The repository's configuration file: `JIG_OVERLAY`, else its own. */
export function overlayPath(root = consumerRoot()): string {
  return repositoryConfigPath(root);
}

/** The read each merged value came from, so a validator can name its source. */
const loaded = new WeakMap<object, LayeredConfig>();

/**
 * Every configuration layer of the repository at `root`, merged (see
 * `config-layers.ts`), with the variables `env` sets. The only place a skill
 * reads the layers. `repositoryText` supplies the repository layer's content
 * instead of its file (see `loadLayeredConfig`).
 */
export function layeredConfig(
  root = consumerRoot(),
  env: Record<string, string | undefined> = process.env,
  repositoryText?: string | null,
): LayeredConfig {
  const config = loadLayeredConfig(root, env, repositoryText);
  loaded.set(config.values, config);
  return config;
}

/**
 * Where `field` (dotted) came from in the merged `values` this reader
 * returned: the file or environment variable that set it. Values from
 * anywhere else (a test's literal) name the repository's file.
 */
export function sourceIn(
  values: Record<string, unknown>,
  field: string,
): string {
  const config = loaded.get(values);
  return config === undefined ? OVERLAY_RELPATH : sourceOf(config, field);
}

/**
 * A validation error inside `sections` of the merged `values`, with the
 * source of the field the message opens with appended (see
 * `fieldInMessage`).
 */
export function withSource(
  values: Record<string, unknown>,
  sections: string | readonly string[],
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${message}: ${sourceIn(values, fieldInMessage(message, sections))}`,
  );
}

/**
 * The merged configuration, which may be empty: for skills that run on
 * their defaults in a repository without its own file.
 */
export function readConfig(): Record<string, unknown> {
  return layeredConfig().values;
}

/** Whether the repository has its own configuration file. */
export function hasRepositoryConfig(): boolean {
  return layeredConfig().hasRepository;
}

/**
 * The merged configuration of a repository that has adopted Jig. A
 * missing repository file is an error, never an empty configuration, even
 * when the user layer exists: an installed skill invoked in a repository that
 * has not adopted it must say so rather than run with guessed policy.
 */
export function readOverlay(): Record<string, unknown> {
  const config = layeredConfig();
  if (!config.hasRepository)
    throw new Error(
      `Jig configuration not found: ${config.repositoryPath}. This repository has not configured the review skill; add ${OVERLAY_RELPATH} (see ${ADOPTION_DOC}) or point JIG_OVERLAY at a configuration file.`,
    );
  return config.values;
}

/**
 * Where a field's value came from (dotted, such as `drive.reviews_drafts`),
 * for an error message: the file or environment variable that set it.
 */
export function configSource(field: string): string {
  return sourceOf(layeredConfig(), field);
}

/** The git remote a clone is assumed to have when `repository.remote` is unset. */
export const DEFAULT_REMOTE = "origin";

/**
 * A git remote name the skills can pass as one argument and print in a
 * command a person may paste: ASCII letters, digits, `.`, `_`, `-` and `/`
 * only, so no shell metacharacter can reach a suggested command; no leading
 * `-` (git would read it as an option); and no sequence a ref name refuses,
 * since the remote prefixes every remote-tracking ref
 * (`refs/remotes/<remote>/<branch>`): no `..`, no empty component (`//`, a
 * leading or trailing `/`), no component starting with `.` or ending in
 * `.lock`, no trailing `.`.
 */
const REMOTE_NAME =
  /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.$)(?!(?:.*\/)?\.)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]+$/;

/**
 * The git remote the delivery skills push to and fetch from:
 * `repository.remote` in the configuration layers of the repository at
 * `root`, else `origin`. A value that is not a usable remote name is an
 * error naming where it was set, never a silent fallback to `origin`, which
 * could be another repository's remote; so is an explicit `null`, which a
 * higher layer (`JIG__REPOSITORY__REMOTE=null`) would otherwise use to turn
 * a lower layer's remote back into `origin` unnoticed.
 */
export function remoteName(
  root = consumerRoot(),
  env: Record<string, string | undefined> = process.env,
): string {
  const config = layeredConfig(root, env);
  const repository = config.values.repository;
  if (repository === undefined || repository === null) return DEFAULT_REMOTE;
  if (typeof repository !== "object" || Array.isArray(repository))
    throw new RemoteSettingError(
      `repository must be an object: ${sourceOf(config, "repository")}`,
    );
  const value = (repository as Record<string, unknown>).remote;
  if (value === undefined) return DEFAULT_REMOTE;
  if (typeof value !== "string" || !REMOTE_NAME.test(value))
    throw new RemoteSettingError(
      `repository.remote must be a git remote name (letters, digits, '.', '_', '-', '/'; no leading '-', no '..', '//', '.lock' or leading '.' component), got ${JSON.stringify(value)}: ${sourceOf(config, "repository.remote")}`,
    );
  return value;
}

/** A `repository` section or `repository.remote` the skills cannot use. */
class RemoteSettingError extends Error {
  override readonly name = "RemoteSettingError";
}

/**
 * `remoteName`, or why it cannot be read (the setting, or a configuration
 * file that does not parse), for a caller that reports instead of throwing.
 */
export function readRemoteName(
  root = consumerRoot(),
): { remote: string } | { error: string } {
  try {
    return { remote: remoteName(root) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function reviewConfig(): ReviewConfig {
  const overlay = readOverlay();
  try {
    return parseReviewConfig(overlay.review);
  } catch (err) {
    throw withSource(overlay, "review", err);
  }
}

function checkTaxonomy(value: unknown): void {
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
        throw new Error(`review.taxonomy.${field} must be a nonempty string`);
    } else if (!isDistinctNonEmptyList(tokens))
      throw new Error(
        `review.taxonomy.${field} must contain distinct nonempty strings`,
      );
  }
}

/** The shape every `review.taxonomy` list field must have; one rule for every reader. */
export function isDistinctNonEmptyList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((x) => typeof x === "string" && x.trim() !== "") &&
    new Set(value).size === value.length
  );
}

/** The `review` fields that are lists of distinct names, and what they name. */
const DISTINCT_LISTS: Record<string, string> = {
  required_checks: "check names",
  scanner_apps: "GitHub App slugs",
};

function checkReviewField(key: string, value: unknown): void {
  if (
    key === "bots" &&
    (!Array.isArray(value) ||
      value.some((x) => typeof x !== "string" || x.trim() === ""))
  )
    throw new Error("review.bots must be a list of nonempty reviewer names");
  if (
    ["job_pattern", "deferral_team", "repo_label", "repo_slug"].includes(key) &&
    typeof value !== "string"
  )
    throw new Error(`review.${key} must be a string`);
  if (Object.hasOwn(DISTINCT_LISTS, key) && !isDistinctNonEmptyList(value))
    throw new Error(
      `review.${key} must contain distinct nonempty ${DISTINCT_LISTS[key]}`,
    );
  if (key === "taxonomy") checkTaxonomy(value);
}

export function parseReviewConfig(review: unknown): ReviewConfig {
  if (review === undefined) return {};
  if (!review || typeof review !== "object" || Array.isArray(review))
    throw new Error("review must be an object");
  const entries = Object.entries(review).filter(
    // A null pattern means "not set": wait on the reviewer-name heuristic.
    ([key, value]) => !(key === "job_pattern" && value === null),
  );
  for (const [key, value] of entries) checkReviewField(key, value);
  return Object.fromEntries(entries) as ReviewConfig;
}
