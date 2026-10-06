/** Resolve consumer files independently of the release cache or adapter path. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ReviewConfig {
  bots?: string[];
  job_pattern?: string;
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

/** Walk the invoking worktree, including linked worktrees whose .git is a file. */
export function consumerRoot(cwd = process.cwd()): string {
  let current = resolve(cwd);
  let gitRoot: string | undefined;
  for (;;) {
    if (existsSync(join(current, ".groundwork", "install.lock.json")))
      return current;
    if (!gitRoot && existsSync(join(current, ".git"))) gitRoot = current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return gitRoot ?? resolve(cwd);
}

/** Standalone source probes retain their adjacent optional sibling seam. */
export function siblingSkill(name: string, scriptDir: string): string {
  const adjacent = join(dirname(dirname(scriptDir)), name);
  // Copied standalone skills have no installer adapter and own their siblings.
  if (!existsSync(join(consumerRoot(), ".groundwork", "install.lock.json")))
    return adjacent;
  return join(consumerRoot(), ".claude", "skills", name);
}

export function reviewConfig(): ReviewConfig {
  const override = process.env.GROUNDWORK_OVERLAY;
  const path = override || join(consumerRoot(), ".groundwork", "overlay.json");
  if (!existsSync(path)) {
    if (override) throw new Error(`consumer overlay is missing: ${path}`);
    return {};
  }
  const overlay: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay))
    throw new Error(`consumer overlay must be an object: ${path}`);
  const review = (overlay as { review?: unknown }).review;
  if (review === undefined) return {};
  if (!review || typeof review !== "object" || Array.isArray(review))
    throw new Error(`review must be an object: ${path}`);
  for (const [key, value] of Object.entries(review)) {
    if (
      key === "bots" &&
      (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
    )
      throw new Error("review.bots must be a list of strings");
    if (
      ["job_pattern", "deferral_team", "repo_label", "repo_slug"].includes(
        key,
      ) &&
      typeof value !== "string"
    )
      throw new Error(`review.${key} must be a string`);
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
  return review as ReviewConfig;
}
