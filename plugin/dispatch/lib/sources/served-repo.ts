import { resolve } from "node:path";
import {
  environmentLayer,
  isMapping,
  mergeLayers,
  readConfigFile,
  refuseRepositoryOnly,
  userConfigPath,
  userLayerEnabled,
} from "../../../shared/config-layers.ts";
import { failureText } from "../text.ts";
import type { Unplaced } from "../types.ts";

/**
 * Whose repository a served item is. A served person's assignments are read
 * from the tracker team, which every repository of an organization may share,
 * so each repository's tick sees the same list: an item that carries another
 * repository's label belongs to that repository's checkout, not this one's.
 * The scope comes from the checkout's own `review.repo_label` and
 * `review.taxonomy.repos`; without both there is no scope and nothing is
 * left out.
 */
export interface RepoScope {
  /** This repository's label, as the checkout's configuration spells it. */
  own: string;
  /** Every other repository label the taxonomy lists. */
  others: readonly string[];
  /** Why a supplied scope cannot be trusted; set, the checkout starts no served item. */
  invalid?: string;
}

/** A scope that was supplied but cannot be validated: served pickups are refused, never widened. */
function refusedScope(why: string): RepoScope {
  return { own: "", others: [], invalid: why };
}

/** A label compared by its name alone: case folded, a group's `repo:` prefix dropped. */
function named(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/^repo:/, "");
}

/** The scope the merged configuration declares, or none where it names no repository label. */
export function repoScopeOf(
  values: Record<string, unknown>,
): RepoScope | undefined {
  const review = values.review;
  if (review === undefined || review === null) return undefined;
  if (!isMapping(review)) return refusedScope("review is not a mapping");
  const own = review.repo_label;
  if (own === undefined || own === null) return undefined;
  if (typeof own !== "string" || own.trim() === "")
    return refusedScope("review.repo_label is not a non-empty text");
  const taxonomy = review.taxonomy;
  if (taxonomy === undefined || taxonomy === null) return undefined;
  if (!isMapping(taxonomy))
    return refusedScope("review.taxonomy is not a mapping");
  const repos = taxonomy.repos;
  if (repos === undefined || repos === null) return undefined;
  if (
    !Array.isArray(repos) ||
    repos.length === 0 ||
    repos.some((v) => typeof v !== "string" || v.trim() === "")
  )
    return refusedScope(
      "review.taxonomy.repos is not a non-empty list of non-empty text",
    );
  const mine = named(own);
  const others = (repos as string[]).filter((label) => named(label) !== mine);
  return others.length === 0 ? undefined : { own, others };
}

/**
 * The other repository's label an item carries, when it carries one and not
 * this repository's own: an item labelled for two repositories, this one
 * among them, stays this repository's to start.
 */
export function otherRepoLabel(
  labels: readonly string[],
  scope: RepoScope | undefined,
): string | null {
  if (scope === undefined || scope.invalid !== undefined) return null;
  const carried = labels.map(named);
  if (carried.includes(named(scope.own))) return null;
  const other = scope.others.find((label) => carried.includes(named(label)));
  return other ?? null;
}

/** Whether the item carries a repository label of the taxonomy, this repository's own or another's. */
function carriesRepoLabel(
  labels: readonly string[],
  scope: RepoScope,
): boolean {
  const carried = labels.map(named);
  return [scope.own, ...scope.others].some((label) =>
    carried.includes(named(label)),
  );
}

/**
 * What this checkout does with a served item that no repository label places:
 * `start` it, leave it to the repository that is its team's default
 * (`leave`), or report that it needs a repository label (`hold`).
 */
export type UnlabeledMode = "start" | "leave" | "hold";

/**
 * The mode of this checkout, from the machine file's default repository of
 * each tracker team (`serve_defaults`). Only a tracker shared by several
 * repositories has unlabelled items that are not this checkout's already, so
 * a GitHub repository's own issues, and a checkout without a repository
 * scope, always `start`.
 */
export function unlabeledModeOf(input: {
  scope: RepoScope | undefined;
  adapter: string;
  team: string;
  /** The Jira site distinguishes projects with the same team key on different sites. */
  site?: string | null;
  defaults: Readonly<Record<string, string>> | undefined;
  repoPath: string;
}): UnlabeledMode {
  const { scope, adapter, team, site, defaults, repoPath } = input;
  if (scope === undefined || scope.invalid !== undefined) return "start";
  if (adapter === "github") return "start";
  const key = trackerDefaultKey(adapter, team, site);
  const chosen =
    defaults !== undefined && Object.hasOwn(defaults, key)
      ? defaults[key]
      : undefined;
  if (chosen === undefined) return "hold";
  return chosen === resolve(repoPath) ? "start" : "leave";
}

/** A served tracker namespace, rather than just an issue-key team. */
export function trackerDefaultKey(
  adapter: string,
  team: string,
  site?: string | null,
): string {
  return adapter === "jira" && site !== null && site !== undefined
    ? `${adapter}:${site.toLowerCase()}:${team.toLowerCase()}`
    : `${adapter}:${team.toLowerCase()}`;
}

/** The mode that applies to an item: only an item no repository label places is held back. */
export function unlabeledOutcome(
  labels: readonly string[],
  scope: RepoScope | undefined,
  mode: UnlabeledMode | undefined,
): UnlabeledMode {
  if (scope === undefined || scope.invalid !== undefined) return "start";
  return carriesRepoLabel(labels, scope) ? "start" : (mode ?? "start");
}

/** What a person does about an unplaced item: it names the repository, so the next tick places it. */
export const NEEDS_REPOSITORY_LABEL =
  "no repository label places it and no default repository is stated for its team: add one of the repository labels, or name a default in the machine file's serve_defaults";

/**
 * The scope the repository's default-branch values declare under the permitted
 * layers: the user file below them, the environment above. The pull request's
 * checkout is never read. A layer that cannot be read leaves the scope
 * unvalidatable, which refuses served pickups.
 */
export function scopeOf(
  values: Record<string, unknown>,
): RepoScope | undefined {
  try {
    const userPath = userConfigPath();
    const user = userLayerEnabled() ? readConfigFile(userPath) : null;
    if (user !== null) refuseRepositoryOnly(user, userPath);
    const env = environmentLayer();
    return repoScopeOf(
      mergeLayers(mergeLayers(user ?? {}, values), env?.values ?? {}),
    );
  } catch (error) {
    return {
      own: "",
      others: [],
      invalid: `a configuration layer could not be read: ${failureText(error)}`,
    };
  }
}

/**
 * Keeps one report of each item that needs a repository label: repositories
 * sharing a tracker team all read the same unplaced item, and the first
 * report of it (in the order given) is the one a person sees.
 */
export function dropRepeatedLabelNeeds(
  reports: readonly { unplaced: Unplaced[] }[],
): void {
  const seen = new Set<string>();
  for (const report of reports)
    report.unplaced = report.unplaced.filter((u) => {
      if (u.cause !== "needs-repository-label") return true;
      const key = `${u.source ?? ""}:${u.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
